// @ts-check
// The installer's file helpers (src/cli/install/files.js): marker blocks in Markdown/TOML (add, replace, remove
// byte for byte), JSON entries (structural compare, indentation kept, invalid or odd-shaped files refused), whole-file
// copies recognised by content, template or manifest hash, atomic writes that keep the file mode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-'));

const {
  InstallRefusal, MD_MARKERS, TOML_MARKERS, blockAction, copyAction, deleteEntry, detectIndent, findBlock, isOurCopy, jsonAction,
  loadManifest, removeBlock, removeBlockAction, removeCopyAction, setEntry, sha256, stringifyLike, updateManifest, upsertBlock, writeAtomic,
} = await import('../../src/cli/install/files.js');
const { withInvocationNote } = await import('../../src/cli/install.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-install-files-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (/** @type {string} */ name, /** @type {string | null} */ text = null) => {
  const f = path.join(dir, `${n++}-${name}`);
  if (text !== null) fs.writeFileSync(f, text);
  return f;
};

const MD_BLOCK = '<!-- specreview:begin (managed) -->\nnew protocol\n<!-- specreview:end -->';
const TOML_BLOCK = '# specreview:begin\n[mcp_servers.specreview]\ncommand = "node"\n# specreview:end';

test('upsertBlock / removeBlock: append, replace in place, remove back to the original text', () => {
  const original = '# Mine\n\nBe nice.\n';
  const added = upsertBlock(original, MD_BLOCK, MD_MARKERS);
  assert.equal(added, `# Mine\n\nBe nice.\n\n${MD_BLOCK}\n`);
  assert.equal(upsertBlock(added, MD_BLOCK, MD_MARKERS), added, 'idempotent');
  assert.equal(removeBlock(added, MD_MARKERS), original);
  const middle = '# Mine\n\n<!-- specreview:begin old -->\nold\n<!-- specreview:end -->\n\nTrailer.\n';
  assert.equal(upsertBlock(middle, MD_BLOCK, MD_MARKERS), `# Mine\n\n${MD_BLOCK}\n\nTrailer.\n`);
  assert.equal(removeBlock(middle, MD_MARKERS), '# Mine\n\nTrailer.\n');
  assert.equal(upsertBlock(null, MD_BLOCK, MD_MARKERS), `${MD_BLOCK}\n`);
  assert.equal(upsertBlock('  \n', MD_BLOCK, MD_MARKERS), `${MD_BLOCK}\n`);
  assert.equal(removeBlock(`${MD_BLOCK}\n`, MD_MARKERS), '');
  assert.equal(removeBlock(original, MD_MARKERS), null, 'no block: nothing to remove');
  // A begin marker without an end marker is not a block (never deletes to the end of the file).
  assert.equal(findBlock('<!-- specreview:begin\nno end\n', MD_MARKERS), null);
  const toml = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
  const t = upsertBlock(toml, TOML_BLOCK, TOML_MARKERS);
  assert.ok(t.startsWith(`${toml}\n# specreview:begin`));
  assert.equal(removeBlock(t, TOML_MARKERS), toml);
});

test('blockAction / removeBlockAction: create, update with a backup, unchanged; delete a file that held only our block', () => {
  const fresh = file('new.md');
  const c = blockAction(fresh, MD_BLOCK, MD_MARKERS, { what: 'the block' });
  assert.equal(c.action, 'create');
  assert.equal(c.backup, undefined);
  const existing = file('AGENTS.md', '# Mine\n');
  const u = blockAction(existing, MD_BLOCK, MD_MARKERS, { what: 'the block' });
  assert.equal(u.action, 'update');
  assert.equal(u.backup, true);
  assert.equal(u.content, `# Mine\n\n${MD_BLOCK}\n`);
  fs.writeFileSync(existing, u.content);
  assert.equal(blockAction(existing, MD_BLOCK, MD_MARKERS).action, 'unchanged');
  assert.equal(removeBlockAction(existing, MD_MARKERS)?.content, '# Mine\n');
  const ours = file('ours.md', `${MD_BLOCK}\n`);
  assert.equal(removeBlockAction(ours, MD_MARKERS)?.action, 'delete');
  assert.equal(removeBlockAction(file('none.md', '# x\n'), MD_MARKERS), null);
  assert.equal(removeBlockAction(file('missing.md'), MD_MARKERS), null);
});

test('jsonAction: structural compare, indentation and final newline kept, delete when only our entries were left', () => {
  const f = file('mcp.json', '{\n    "mcpServers": {\n        "other": { "command": "x" }\n    }\n}');
  const add = jsonAction(f, (v) => setEntry(v, 'mcpServers', 'specreview', { command: 'node' }));
  assert.equal(add?.action, 'update');
  assert.equal(add?.backup, true);
  assert.equal(add?.content, '{\n    "mcpServers": {\n        "other": {\n            "command": "x"\n        },\n        "specreview": {\n            "command": "node"\n        }\n    }\n}');
  fs.writeFileSync(f, /** @type {string} */ (add?.content));
  assert.equal(jsonAction(f, (v) => setEntry(v, 'mcpServers', 'specreview', { command: 'node' }))?.action, 'unchanged');
  const rm = jsonAction(f, (v) => deleteEntry(v, 'mcpServers', 'specreview'), { deleteWhenEmpty: true });
  assert.equal(rm?.action, 'update');
  assert.deepEqual(JSON.parse(/** @type {string} */ (rm?.content)), { mcpServers: { other: { command: 'x' } } });
  const onlyOurs = file('only.json', '{"mcpServers":{"specreview":{"command":"node"}}}\n');
  const del = jsonAction(onlyOurs, (v) => deleteEntry(v, 'mcpServers', 'specreview'), { deleteWhenEmpty: true });
  assert.equal(del?.action, 'delete');
  assert.equal(del?.backup, undefined);
  assert.equal(jsonAction(file('absent.json'), (v) => deleteEntry(v, 'mcpServers', 'specreview'), { deleteWhenEmpty: true }), null);
  assert.equal(jsonAction(file('empty.json', ''), (v) => setEntry(v, 'mcp', 'specreview', {}))?.action, 'update');
});

test('jsonAction refuses invalid JSON, a non-object file and a non-object container', () => {
  const bad = file('bad.json', '{ broken');
  assert.throws(() => jsonAction(bad, (v) => v, { fix: 'add it by hand' }), (/** @type {any} */ e) => {
    assert.ok(e instanceof InstallRefusal);
    assert.equal(e.file, bad);
    assert.equal(e.fix, 'add it by hand');
    assert.match(e.message, /is not valid JSON .*SpecReview never rewrites a file it cannot parse/);
    return true;
  });
  assert.throws(() => jsonAction(file('arr.json', '[]'), (v) => v), /does not contain a JSON object/);
  const odd = file('odd.json', '{"mcpServers": ["x"]}');
  assert.throws(() => jsonAction(odd, (v) => setEntry(v, 'mcpServers', 'specreview', {})), (/** @type {any} */ e) => {
    assert.ok(e instanceof InstallRefusal);
    assert.equal(e.file, odd);
    assert.match(e.message, /"mcpServers" is not a JSON object; SpecReview does not replace it/);
    return true;
  });
  assert.deepEqual(deleteEntry({ mcp: 'x' }, 'mcp', 'specreview'), { mcp: 'x' }, 'deleteEntry leaves odd shapes alone');
});

test('detectIndent / stringifyLike', () => {
  assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
  assert.equal(detectIndent('{"a":1}'), 2);
  assert.equal(stringifyLike({ a: 1 }, null), '{\n  "a": 1\n}\n');
  assert.equal(stringifyLike({ a: 1 }, '{\n    "a": 0\n}'), '{\n    "a": 1\n}');
});

test('copies: recognised by content, template (any invocation note) or a manifest hash; others are backed up / kept', () => {
  const template = '# Skill\n\nRun `specreview open`.\n';
  const withNote = withInvocationNote(template, '"/a/node" "/a/specreview.js"');
  assert.notEqual(withNote, template);
  assert.equal(isOurCopy(file('x.md'), withInvocationNote(template, '"/old/node" "/old/specreview.js"'), withNote, { template }), true, 'a copy with another path in the note');
  const f = file('SKILL.md', template);
  assert.equal(isOurCopy(f, template, withNote, { template }), true);
  assert.equal(isOurCopy(f, 'old copy\n', template, { template, manifest: { version: 1, files: { [f]: { sha256: [sha256('old copy\n')] } } } }), true);
  assert.equal(isOurCopy(f, 'mine\n', template, { template }), false);
  fs.writeFileSync(f, 'mine\n');
  const c = copyAction(f, template, { template });
  assert.equal(c.action, 'update');
  assert.equal(c.backup, true);
  assert.match(String(c.note), /replaces a file SpecReview did not write/);
  assert.deepEqual(removeCopyAction(f, template, { template })?.kept, true);
  fs.writeFileSync(f, template);
  assert.equal(copyAction(f, template, { template }).action, 'unchanged');
  assert.equal(removeCopyAction(f, template, { template })?.action, 'delete');
  assert.equal(removeCopyAction(file('gone.md'), template, { template }), null);
});

test('manifest and writeAtomic', () => {
  const m = file('install-manifest.json');
  assert.deepEqual(loadManifest(m).files, {});
  updateManifest(m, { written: [{ path: '/x', content: 'a' }], deleted: [] });
  updateManifest(m, { written: [{ path: '/x', content: 'b' }, { path: '/y', content: 'c' }], deleted: [] });
  assert.deepEqual(loadManifest(m).files['/x'].sha256, [sha256('b'), sha256('a')]);
  updateManifest(m, { written: [], deleted: ['/y'] });
  assert.deepEqual(Object.keys(loadManifest(m).files), ['/x']);
  fs.writeFileSync(m, '{ broken');
  assert.deepEqual(loadManifest(m).files, {}, 'an unreadable manifest is ignored');
  const exe = file('run.sh', '#!/bin/sh\n');
  fs.chmodSync(exe, 0o750);
  writeAtomic(exe, '#!/bin/sh\necho hi\n');
  assert.equal(fs.statSync(exe).mode & 0o777, 0o750);
  assert.equal(fs.readFileSync(exe, 'utf8'), '#!/bin/sh\necho hi\n');
  const deep = path.join(dir, 'a', 'b', 'c.txt');
  writeAtomic(deep, 'x');
  assert.equal(fs.readFileSync(deep, 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(path.dirname(deep)), ['c.txt'], 'no temp file left');
});
