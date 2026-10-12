// @ts-check
// The installer's file helpers (src/cli/install/files.js): marker blocks in Markdown/TOML (add, replace, remove
// byte for byte; damaged markers refused), JSON entries (structural compare, indentation kept, invalid or odd-shaped
// files refused, deleted on uninstall only when install created them), whole-file copies recognised by content,
// template or manifest hash (a replaced user file backed up every time), atomic writes that keep the file mode and
// go through symlinks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-'));

const {
  InstallRefusal, MD_MARKERS, TOML_MARKERS, blockAction, checkMarkers, copyAction, deleteEntry, detectIndent, findBlock, isOurCopy, jsonAction,
  loadManifest, removeBlock, removeBlockAction, removeCopyAction, setEntry, sha256, stringifyLike, updateManifest, upsertBlock, writeAtomic,
} = await import('../../src/cli/install/files.js');
/** @param {string[]} created @returns {import('../../src/cli/install/files.js').Manifest} */
const manifestOf = (created) => ({ schema: 1, files: {}, created });
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
const TOML_BLOCK = '# specreview:begin\n[mcp_servers.suiko]\ncommand = "node"\n# specreview:end';

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

test('blockAction / removeBlockAction: create, update with a backup, unchanged; delete a file that held only our block (if install created it)', () => {
  const fresh = file('new.md');
  const c = blockAction(fresh, MD_BLOCK, MD_MARKERS, { what: 'the block' });
  assert.equal(c.action, 'create');
  assert.equal(c.backup, undefined);
  assert.match(String(c.note), /^new file with the block \(\d+ lines\)$/);
  const empty = blockAction(file('empty.md', '\n'), MD_BLOCK, MD_MARKERS, { what: 'the block' });
  assert.equal(empty.action, 'update', 'an existing empty file is updated, not created');
  assert.match(String(empty.note), /^fills the empty file with the block \(\d+ lines\)$/);
  assert.equal(empty.backup, undefined, 'nothing to back up');
  const existing = file('AGENTS.md', '# Mine\n');
  const u = blockAction(existing, MD_BLOCK, MD_MARKERS, { what: 'the block' });
  assert.equal(u.action, 'update');
  assert.equal(u.backup, true);
  assert.equal(u.content, `# Mine\n\n${MD_BLOCK}\n`);
  fs.writeFileSync(existing, u.content);
  assert.equal(blockAction(existing, MD_BLOCK, MD_MARKERS).action, 'unchanged');
  assert.equal(removeBlockAction(existing, MD_MARKERS)?.content, '# Mine\n');
  const ours = file('ours.md', `${MD_BLOCK}\n`);
  assert.equal(removeBlockAction(ours, MD_MARKERS, { manifest: manifestOf([ours]) })?.action, 'delete');
  const kept = removeBlockAction(ours, MD_MARKERS);
  assert.equal(kept?.action, 'update', 'a file install did not create stays, emptied');
  assert.equal(kept?.content, '');
  assert.match(String(kept?.note), /it existed before Suiko, so the file stays/);
  assert.equal(removeBlockAction(file('none.md', '# x\n'), MD_MARKERS), null);
  assert.equal(removeBlockAction(file('missing.md'), MD_MARKERS), null);
});

test('jsonAction: structural compare, indentation and final newline kept, delete when only our entries were left (if install created it)', () => {
  const f = file('mcp.json', '{\n    "mcpServers": {\n        "other": { "command": "x" }\n    }\n}');
  const add = jsonAction(f, (v) => setEntry(v, 'mcpServers', 'suiko', { command: 'node' }));
  assert.equal(add?.action, 'update');
  assert.equal(add?.backup, true);
  assert.equal(add?.content, '{\n    "mcpServers": {\n        "other": {\n            "command": "x"\n        },\n        "suiko": {\n            "command": "node"\n        }\n    }\n}');
  fs.writeFileSync(f, /** @type {string} */ (add?.content));
  assert.equal(jsonAction(f, (v) => setEntry(v, 'mcpServers', 'suiko', { command: 'node' }))?.action, 'unchanged');
  const rm = jsonAction(f, (v) => deleteEntry(v, 'mcpServers', 'suiko'), { deleteWhenEmpty: true });
  assert.equal(rm?.action, 'update');
  assert.deepEqual(JSON.parse(/** @type {string} */ (rm?.content)), { mcpServers: { other: { command: 'x' } } });
  const onlyOurs = file('only.json', '{"mcpServers":{"suiko":{"command":"node"}}}\n');
  const del = jsonAction(onlyOurs, (v) => deleteEntry(v, 'mcpServers', 'suiko'), { deleteWhenEmpty: true, manifest: manifestOf([onlyOurs]) });
  assert.equal(del?.action, 'delete');
  assert.equal(del?.backup, undefined);
  const keep = jsonAction(onlyOurs, (v) => deleteEntry(v, 'mcpServers', 'suiko'), { deleteWhenEmpty: true });
  assert.equal(keep?.action, 'update', 'not created by install: kept as {}');
  assert.equal(keep?.content, '{}\n');
  // The pre-install backup had an empty container: it comes back.
  fs.writeFileSync(`${onlyOurs}.specreview-backup`, '{"mcpServers": {}, "x": 1}');
  assert.deepEqual(JSON.parse(/** @type {string} */ (jsonAction(onlyOurs, (v) => deleteEntry(v, 'mcpServers', 'suiko'), { deleteWhenEmpty: true })?.content)), { mcpServers: {} });
  assert.equal(jsonAction(file('absent.json'), (v) => deleteEntry(v, 'mcpServers', 'suiko'), { deleteWhenEmpty: true }), null);
  assert.equal(jsonAction(file('empty.json', ''), (v) => setEntry(v, 'mcp', 'suiko', {}))?.action, 'update');
});

test('jsonAction refuses invalid JSON, a non-object file and a non-object container', () => {
  const bad = file('bad.json', '{ broken');
  assert.throws(() => jsonAction(bad, (v) => v, { fix: 'add it by hand' }), (/** @type {any} */ e) => {
    assert.ok(e instanceof InstallRefusal);
    assert.equal(e.file, bad);
    assert.equal(e.fix, 'add it by hand');
    assert.match(e.message, /is not valid JSON .*Suiko never rewrites a file it cannot parse/);
    return true;
  });
  assert.throws(() => jsonAction(file('arr.json', '[]'), (v) => v), /does not contain a JSON object/);
  const odd = file('odd.json', '{"mcpServers": ["x"]}');
  assert.throws(() => jsonAction(odd, (v) => setEntry(v, 'mcpServers', 'suiko', {})), (/** @type {any} */ e) => {
    assert.ok(e instanceof InstallRefusal);
    assert.equal(e.file, odd);
    assert.match(e.message, /"mcpServers" is not a JSON object; Suiko does not replace it/);
    return true;
  });
  assert.deepEqual(deleteEntry({ mcp: 'x' }, 'mcp', 'suiko'), { mcp: 'x' }, 'deleteEntry leaves odd shapes alone');
});

test('detectIndent / stringifyLike', () => {
  assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
  assert.equal(detectIndent('{"a":1}'), 2);
  assert.equal(stringifyLike({ a: 1 }, null), '{\n  "a": 1\n}\n');
  assert.equal(stringifyLike({ a: 1 }, '{\n    "a": 0\n}'), '{\n    "a": 1\n}');
});

test('copies: recognised by content, template (any invocation note) or a manifest hash; others are backed up / kept', () => {
  const template = '# Skill\n\nRun `suiko open`.\n';
  const withNote = withInvocationNote(template, '"/a/node" "/a/suiko.js"');
  assert.notEqual(withNote, template);
  assert.equal(isOurCopy(file('x.md'), withInvocationNote(template, '"/old/node" "/old/suiko.js"'), withNote, { template }), true, 'a copy with another path in the note');
  const f = file('SKILL.md', template);
  assert.equal(isOurCopy(f, template, withNote, { template }), true);
  assert.equal(isOurCopy(f, 'old copy\n', template, { template, manifest: { schema: 1, created: [], files: { [f]: { sha256: [sha256('old copy\n')] } } } }), true);
  assert.equal(isOurCopy(f, 'mine\n', template, { template }), false);
  fs.writeFileSync(f, 'mine\n');
  const c = copyAction(f, template, { template });
  assert.equal(c.action, 'update');
  assert.equal(c.backupPath, `${f}.specreview-backup`);
  assert.match(String(c.note), /replaces an older or edited copy \(backed up to \d+-SKILL\.md\.specreview-backup\)/);
  // A backup with this content exists: none needed. One with other content: a timestamped one.
  fs.writeFileSync(`${f}.specreview-backup`, 'mine\n');
  assert.equal(copyAction(f, template, { template }).backupPath, undefined);
  assert.match(String(copyAction(f, template, { template }).note), /its current content is already in /);
  fs.writeFileSync(f, 'mine, edited again\n');
  assert.match(String(copyAction(f, template, { template }).backupPath), /\.specreview-backup-\d{8}T\d{6}Z$/);
  fs.writeFileSync(f, 'mine\n');
  assert.deepEqual(removeCopyAction(f, template, { template })?.kept, true);
  fs.writeFileSync(f, template);
  assert.equal(copyAction(f, template, { template }).action, 'unchanged');
  assert.equal(removeCopyAction(f, template, { template })?.action, 'delete');
  assert.equal(removeCopyAction(file('gone.md'), template, { template }), null);
});

test('checkMarkers: one well-formed pair or none; anything else is refused', () => {
  const ok = ['# x\n', `${MD_BLOCK}\n`, `# x\n\n${MD_BLOCK}\n\ntrailer\n`];
  for (const text of ok) assert.doesNotThrow(() => checkMarkers('/f', text, MD_MARKERS));
  const bad = [
    ['<!-- specreview:begin x -->\nno end\n', /has no "<!-- specreview:end -->" line after it/],
    [`${MD_BLOCK}\n${MD_BLOCK}\n`, /it has 2 "<!-- specreview:begin" lines/],
    ['<!-- specreview:end -->\n<!-- specreview:begin -->\n', /has no "<!-- specreview:end -->" line after it/],
    ['text\n<!-- specreview:end -->\n', /has a "<!-- specreview:end -->" line but no "<!-- specreview:begin" line/],
    [`${MD_BLOCK}\n<!-- specreview:end -->\n`, /it has 2 "<!-- specreview:end -->" lines/],
  ];
  for (const [text, re] of bad) {
    assert.throws(() => checkMarkers('/f', /** @type {string} */ (text), MD_MARKERS), (/** @type {any} */ e) => e instanceof InstallRefusal && /** @type {RegExp} */ (re).test(e.message) && /repair the markers/.test(e.fix));
  }
  assert.throws(() => blockAction(file('broken.md', '<!-- specreview:begin -->\nno end\nmy notes\n'), MD_BLOCK, MD_MARKERS), InstallRefusal);
});

test('manifest and writeAtomic', () => {
  const m = file('install-manifest.json');
  assert.deepEqual(loadManifest(m).files, {});
  updateManifest(m, { written: [], deleted: [], created: ['/c', '/d'] });
  updateManifest(m, { written: [], deleted: ['/d'] });
  assert.deepEqual(loadManifest(m).created, ['/c']);
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
  // Through a symlink: the link stays, the target changes; a dangling link is refused.
  const target = file('target.json', '{}\n');
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(target, link);
  writeAtomic(link, '{"a": 1}\n');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a": 1}\n');
  const dangling = path.join(dir, 'dangling.json');
  fs.symlinkSync(path.join(dir, 'nowhere', 'x.json'), dangling);
  assert.throws(() => writeAtomic(dangling, 'x'), /is a symlink to a missing file/);
  assert.ok(fs.lstatSync(dangling).isSymbolicLink());
});
