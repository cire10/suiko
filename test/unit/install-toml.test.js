// @ts-check
// The config.toml scanner and SpecReview's managed block in it (src/cli/install/toml.js): statement boundaries
// through strings, multi-line strings, arrays and inline tables; what counts as a definition of
// mcp_servers.specreview; and the block operations, which own only the markers and our table, never the tables Codex
// writes between the markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const { TomlScanError, definitionsOutside, findTomlBlock, removeTomlBlock, scanToml, upsertTomlBlock } = await import('../../src/cli/install/toml.js');

const OURS = ['mcp_servers', 'specreview'];
const BLOCK = '# specreview:begin (managed)\n[mcp_servers.specreview]\ncommand = "/n"\nargs = ["/b", "mcp"]\n# specreview:end';

const hasTomllib = spawnSync('python3', ['-I', '-c', 'import tomllib'], { encoding: 'utf8' }).status === 0;
/** @param {string} text */
function assertValidToml(text) {
  if (!hasTomllib) return;
  const r = spawnSync('python3', ['-I', '-c', 'import sys, tomllib; tomllib.loads(sys.stdin.read())'], { input: text, encoding: 'utf8' });
  assert.equal(r.status, 0, `${text}\n${r.stderr}`);
}

test('scanToml: statements, tables and key paths, through every kind of value', () => {
  const text = [
    'title = "a # not a comment"', // 0
    's = """', // 1
    '[mcp_servers.specreview]', // 2 (inside a string)
    '# specreview:begin', // 3 (inside a string)
    'x\\"""y"""', // 4: an escaped quote, then the closing delimiter
    "lit = '''", // 5
    "a '' b''''", // 6: quotes inside, and one quote of content right before the delimiter
    'arr = [', // 7
    '  1, # one', // 8
    '  [2, 3], { a = "]" },', // 9
    ']', // 10
    'when = 1979-05-27 07:32:00Z', // 11
    '', // 12
    '[ "a b" . c ]', // 13
    'd.e = { f = 1, g = [1, 2] }', // 14
    '[[arr2]]', // 15
    'k = true # trailing', // 16
  ].join('\n');
  const st = scanToml(`${text}\n`);
  const brief = st.map((s) => `${s.kind}:${s.start}-${s.end}:${(s.key ?? []).join('.')}@${s.table.join('.')}`);
  assert.deepEqual(brief, [
    'keyval:0-0:title@',
    'keyval:1-4:s@',
    'keyval:5-6:lit@',
    'keyval:7-10:arr@',
    'keyval:11-11:when@',
    'blank:12-12:@',
    'header:13-13:a b.c@a b.c',
    'keyval:14-14:d.e@a b.c',
    'array-header:15-15:arr2@arr2',
    'keyval:16-16:k@arr2',
  ]);
  assertValidToml(`${text}\n`);
  assert.equal(scanToml('a = 1\r\n[t]\r\nb = 2\r\n').filter((s) => s.kind !== 'blank').length, 3, 'CRLF');
  assert.deepEqual(scanToml('"spec\\u0072eview" = 1\n')[0].key, ['specreview'], 'escapes in quoted keys are decoded');
});

// The scanner finds statement boundaries; it does not validate scalar values (`a = 1 2` passes).
test('scanToml: text it cannot follow throws TomlScanError with the line', () => {
  for (const [bad, re] of /** @type {Array<[string, RegExp]>} */ ([
    ['a = "open\n', /line 1: unterminated string/],
    ['a = 1\nb = [1,\n', /line 3: unterminated array/],
    ['a = 1\njust words\n', /line 2: expected "=" after a key/],
    ['[table\n', /line 1: expected "\]" after a table header/],
    ['a = """never closed\n', /unterminated multi-line string/],
  ])) {
    assert.throws(() => scanToml(bad), (/** @type {any} */ e) => e instanceof TomlScanError && re.test(e.message), bad);
  }
});

test('definitionsOutside: every way to define mcp_servers.specreview, and parents that cannot take a table', () => {
  const defined = [
    '[mcp_servers.specreview]\ncommand = "x"\n',
    '[mcp_servers."specreview"]\n',
    '[mcp_servers.specreview.env]\nA = "1"\n',
    '[mcp_servers]\nspecreview = { command = "x" }\n',
    '[mcp_servers]\nspecreview.command = "x"\n',
    "[mcp_servers]\n'specreview' = {}\n",
    'mcp_servers.specreview.command = "x"\n',
  ];
  for (const t of defined) assert.deepEqual(definitionsOutside(findTomlBlock(t, OURS), OURS), { defined: true, container: false }, t);
  for (const t of ['mcp_servers = {}\n', '[[mcp_servers]]\nname = "x"\n']) assert.equal(definitionsOutside(findTomlBlock(t, OURS), OURS).container, true, t);
  for (const t of ['[mcp_servers.other]\nspecreview = 1\n', 's = "[mcp_servers.specreview]"\n', '[mcp_servers]\nother = {}\n', 'x.mcp_servers.specreview = 1\n']) {
    assert.deepEqual(definitionsOutside(findTomlBlock(t, OURS), OURS), { defined: false, container: false }, t);
  }
});

test('the managed block: only the markers and our table are ours; foreign tables inside are kept', () => {
  const original = 'model = "o3"\n';
  const added = upsertTomlBlock(original, findTomlBlock(original, OURS), BLOCK);
  assert.equal(added, `model = "o3"\n\n${BLOCK}\n`);
  assert.equal(upsertTomlBlock(added, findTomlBlock(added, OURS), BLOCK), added, 'idempotent');
  assert.equal(removeTomlBlock(added, findTomlBlock(added, OURS)), original, 'removal restores the text byte for byte');

  // Codex (toml_edit) put two tables before our trailing end marker, with a comment on one of them.
  const codex = added.replace('# specreview:end', '\n# trust\n[projects."/a"]\ntrust_level = "trusted"\n\n[mcp_servers.foo]\ncommand = "f"\n# specreview:end');
  assertValidToml(codex);
  const blk = findTomlBlock(codex, OURS);
  assert.deepEqual(blk.foreignTables, ['[projects."/a"]', '[mcp_servers.foo]']);
  const replaced = upsertTomlBlock(codex, blk, BLOCK.replace('/n', '/new'));
  assert.equal(replaced, `model = "o3"\n\n${BLOCK.replace('/n', '/new')}\n\n# trust\n[projects."/a"]\ntrust_level = "trusted"\n\n[mcp_servers.foo]\ncommand = "f"\n`);
  assertValidToml(replaced);
  assert.equal(removeTomlBlock(codex, blk), 'model = "o3"\n\n# trust\n[projects."/a"]\ntrust_level = "trusted"\n\n[mcp_servers.foo]\ncommand = "f"\n');

  // Key lines inside the block before any header belong to the table above it: kept attached to it.
  const keys = '[tui]\na = 1\n# specreview:begin\nb = 2\n[mcp_servers.specreview]\ncommand = "x"\n# specreview:end\n';
  assert.equal(removeTomlBlock(keys, findTomlBlock(keys, OURS)), '[tui]\na = 1\nb = 2\n');
  assert.equal(upsertTomlBlock(keys, findTomlBlock(keys, OURS), BLOCK), `[tui]\na = 1\nb = 2\n${BLOCK}\n`);

  // No end marker: the block is the begin line and our table, up to the next table (and the comments above it).
  const noEnd = 'a = 1\n\n# specreview:begin\n[mcp_servers.specreview]\ncommand = "x"\n\n# mine\n[t]\nk = 1\n';
  assert.equal(removeTomlBlock(noEnd, findTomlBlock(noEnd, OURS)), 'a = 1\n\n# mine\n[t]\nk = 1\n');

  // Codex re-serialised our table without the begin marker: the stray end marker is ours to drop, the table is not.
  const stray = 'model = "o3"\n\n[mcp_servers.specreview]\ncommand = "x"\n# specreview:end\n';
  const sb = findTomlBlock(stray, OURS);
  assert.equal(sb.region, null);
  assert.deepEqual(sb.strayEnds, [4]);
  assert.equal(definitionsOutside(sb, OURS).defined, true);
  assert.equal(removeTomlBlock(stray, sb), 'model = "o3"\n\n[mcp_servers.specreview]\ncommand = "x"\n');
  assert.equal(removeTomlBlock(original, findTomlBlock(original, OURS)), null, 'nothing of ours');

  assert.throws(() => findTomlBlock(`${BLOCK}\n${BLOCK}\n`, OURS), /it has 2 "# specreview:begin" lines/);
});
