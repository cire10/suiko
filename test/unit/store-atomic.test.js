// @ts-check
// Unit tests for src/core/store/atomic.js (atomic writes, canonical JSON) and src/core/store/jsonl.js.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-atomic-')));
process.env.SPECREVIEW_HOME = path.join(TMP, 'home');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { writeFileAtomic, writeJson, readJson, stringifyJson, parseTmpName, tmpPathFor, exists } = await import(
  '../../src/core/store/atomic.js'
);
const { appendJsonLine, readJsonLines, readLastJsonLine } = await import('../../src/core/store/jsonl.js');

test('writeFileAtomic creates parents, replaces content and leaves no temp files', async () => {
  const file = path.join(TMP, 'a', 'b', 'f.txt');
  await writeFileAtomic(file, 'one');
  await writeFileAtomic(file, Buffer.from('two'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['f.txt']);
});

test('writeFileAtomic applies an exact mode regardless of umask', async () => {
  const file = path.join(TMP, 'secret.json');
  await writeFileAtomic(file, '{}', { mode: 0o600 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await writeFileAtomic(file, '{}', { mode: 0o644 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test('beforeRename can abort the write; the target is untouched and the temp file removed', async () => {
  const file = path.join(TMP, 'cas.txt');
  fs.writeFileSync(file, 'original');
  await assert.rejects(
    writeFileAtomic(file, 'new', {
      beforeRename: () => {
        throw new Error('changed');
      },
    }),
    /changed/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(TMP).filter((n) => n.includes('.tmp-')), []);
});

test('mkdir:false fails when the directory is missing', async () => {
  await assert.rejects(writeFileAtomic(path.join(TMP, 'no-such-dir', 'x'), 'x', { mkdir: false }), { code: 'ENOENT' });
});

test('canonical JSON: sorted top-level keys, 2-space indent, LF, trailing newline', async () => {
  const file = path.join(TMP, 'doc.json');
  await writeJson(file, { schema: 1, id: 't1', b: { z: 1, a: 2 }, a: [1, 2] });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "z": 1,\n    "a": 2\n  },\n  "id": "t1",\n  "schema": 1\n}\n');
  assert.ok(!text.includes('\r'));
  assert.deepEqual(await readJson(file), { schema: 1, id: 't1', b: { z: 1, a: 2 }, a: [1, 2] });
  assert.equal(stringifyJson([3, 1]), '[\n  3,\n  1\n]\n');
});

test('readJson: null when missing, descriptive error when corrupt, BOM tolerated', async () => {
  assert.equal(await readJson(path.join(TMP, 'missing.json')), null);
  assert.equal(await readJson(path.join(TMP, 'doc.json', 'below-a-file.json')), null);
  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, '{"a":');
  await assert.rejects(readJson(bad), (err) => /** @type {any} */ (err).code === 'EJSON' && /bad\.json/.test(String(err)));
  const bom = path.join(TMP, 'bom.json');
  fs.writeFileSync(bom, '﻿{"a":1}');
  assert.deepEqual(await readJson(bom), { a: 1 });
});

test('temp names are recognisable and carry the pid', () => {
  const tmp = tmpPathFor('/x/y/0001.json');
  assert.match(tmp, /^\/x\/y\/0001\.json\.tmp-\d+-[0-9a-f]+$/);
  assert.deepEqual(parseTmpName(path.basename(tmp)), { pid: process.pid });
  assert.equal(parseTmpName('0001.json'), null);
});

test('concurrent atomic writers never produce a torn file', async () => {
  const file = path.join(TMP, 'race.json');
  const payloads = Array.from({ length: 20 }, (_, i) => ({ i, pad: 'x'.repeat(10000 + i) }));
  await Promise.all(payloads.map((p) => writeJson(file, p)));
  const final = await readJson(file);
  assert.ok(payloads.some((p) => p.i === final.i && p.pad === final.pad));
  assert.equal(await exists(file), true);
});

test('jsonl: append, read, skip torn lines, last line', async () => {
  const file = path.join(TMP, 'events', 'd.jsonl');
  assert.deepEqual(await readJsonLines(file), []);
  assert.equal(await readLastJsonLine(file), null);
  await appendJsonLine(file, { seq: 1 });
  await appendJsonLine(file, { seq: 2, text: 'ünïcode' });
  fs.appendFileSync(file, '{"seq":3,"torn'); // crash mid-write
  await appendJsonLine(file, { seq: 4 });
  assert.deepEqual((await readJsonLines(file)).map((e) => e.seq), [1, 2, 4]);
  assert.deepEqual(await readLastJsonLine(file), { seq: 4 });
  fs.appendFileSync(file, '{"seq":5,"torn');
  assert.deepEqual(await readLastJsonLine(file), { seq: 4 });
});

test('jsonl: readLastJsonLine across chunk boundaries with multi-byte text', async () => {
  const file = path.join(TMP, 'big.jsonl');
  for (let i = 1; i <= 50; i += 1) await appendJsonLine(file, { seq: i, body: 'é🚀'.repeat(300 + i) });
  assert.equal((await readLastJsonLine(file)).seq, 50);
  const long = path.join(TMP, 'long.jsonl');
  await appendJsonLine(long, { seq: 1, body: 'é'.repeat(20000) });
  assert.equal((await readLastJsonLine(long)).body.length, 20000);
});
