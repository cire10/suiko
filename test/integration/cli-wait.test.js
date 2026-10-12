// @ts-check
// WP4 `wait` tests against a stub engine shaped like WP3's waitForFeedback (it owns the waiter file, heartbeat and
// supersede detection; it calls write(text) under the doc lock and records the delivery after it resolves):
// delivery only after stdout flushed (text and --json), option passing, exit codes for
// timeout/closed/dirty/superseded/interrupted, late writes refused, an engine that ignores its timeout.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SPECREVIEW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-wait-'));

const { makeWorkspace, packetText, runCli, samplePacket, stubEngine } = await import('./helpers/cli-harness.js');
const { memorySink } = await import('../../src/cli/io.js');

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
before(async () => {
  ws = await makeWorkspace();
});
after(() => {
  ws.cleanup();
  fs.rmSync(/** @type {string} */ (process.env.SPECREVIEW_HOME), { recursive: true, force: true });
});

/**
 * @param {Function} waitImpl
 * @param {Record<string, any>} [extra]
 */
function depsWith(waitImpl, extra = {}) {
  const engine = stubEngine(ws.store, { waitForFeedback: waitImpl });
  return { engine, d: { ops: engine.ops, createContext: engine.createContext, cwd: ws.root, env: { SPECREVIEW_HOME: process.env.SPECREVIEW_HOME, CLAUDECODE: '1' }, ...extra } };
}

/** @param {() => boolean} cond */
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('wait', () => {
  test('delivers: the packet is on stdout before the engine records the delivery; options passed through', async () => {
    const stdout = memorySink();
    /** @type {string | null} */
    let seenAtRecord = null;
    const { engine, d } = depsWith(async (/** @type {any} */ ctx, /** @type {any} */ opts) => {
      opts.onStart({ docs: [{ id: 'token-service', head: 1, path: 'docs/specs/token-service.md' }], agent: ctx.agent, pid: process.pid });
      const packet = samplePacket();
      await opts.write(packetText(packet));
      seenAtRecord = stdout.text(); // what had reached stdout when the engine would mark it delivered
      return { status: 'delivered', packets: [packet], text: packetText(packet), docId: 'token-service' };
    }, { stdout, heartbeatMs: 1234 });
    const r = await runCli(['wait', 'token-service'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.match(String(seenAtRecord), /^SPECREVIEW FEEDBACK · token-service/);
    assert.equal(r.stdout, seenAtRecord, 'printed exactly once');
    assert.equal(r.stderr, 'suiko: waiting for a review of token-service v1 (as claude). Safe to interrupt; nothing is lost.\n');
    const opts = engine.calls.find((c) => c.name === 'waitForFeedback')?.args[1];
    assert.deepEqual(opts.docIds, ['token-service']);
    assert.equal(opts.timeoutMs, 0);
    assert.equal(opts.allowDirty, false);
    assert.equal(opts.agent, 'claude');
    assert.equal(opts.heartbeatMs, 1234);
    assert.ok(opts.signal instanceof AbortSignal);
    assert.equal(engine.calls.find((c) => c.name === 'createContext')?.args[0].agent, 'claude');
  });

  test('--json: the packet object (one JSON line) reaches stdout before the delivery is recorded', async () => {
    const stdout = memorySink();
    /** @type {string | null} */
    let seenAtRecord = null;
    const { d } = depsWith(async (/** @type {any} */ ctx, /** @type {any} */ opts) => {
      const packet = samplePacket();
      await opts.write(packetText(packet)); // text only, like WP3's engine
      seenAtRecord = stdout.text();
      return { status: 'delivered', packets: [packet] };
    }, { stdout });
    const r = await runCli(['wait', '--json'], d); // no <doc>: the workspace's only doc
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, seenAtRecord);
    assert.equal(r.stdout.split('\n').length, 2, 'one JSON line');
    assert.equal(JSON.parse(r.stdout).doc, 'token-service');
    assert.equal(JSON.parse(r.stdout).threads[0].id, 't1');
  });

  test('--json with an engine that cannot rebuild the packet: printed from the returned packets', async () => {
    const stdout = memorySink();
    const { engine, d } = depsWith(async (/** @type {any} */ ctx, /** @type {any} */ opts) => {
      await opts.write('some text the CLI cannot map back to a packet');
      return { status: 'delivered', packets: [samplePacket()] };
    }, { stdout });
    const r = await runCli(['wait', 'token-service', '--json'], d);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).doc, 'token-service');
    assert.ok(engine.calls.some((c) => c.name === 'buildDocPacket'));
  });

  test('timeout -> exit 2; closed -> exit 5; dirty -> exit 3', async () => {
    const t = await runCli(['wait', 'token-service', '--timeout', '90s'], depsWith(async () => ({ status: 'timeout', packets: [], text: '' })).d);
    assert.equal(t.code, 2);
    assert.match(t.stdout, /^suiko: no review yet for token-service after 1m30s\. Run `suiko wait token-service` again/);
    const tj = await runCli(['wait', 'token-service', '--timeout', '1s', '--json'], depsWith(async () => ({ status: 'timeout' })).d);
    assert.deepEqual(JSON.parse(tj.stdout), { status: 'timeout', doc: 'token-service' });
    const c = await runCli(['wait', 'token-service'], depsWith(async () => ({ status: 'closed', packets: [], text: '', docId: 'token-service' })).d);
    assert.equal(c.code, 5);
    assert.match(c.stdout, /review session for token-service was closed; stop waiting/);
    const dirty = await runCli(['wait', 'token-service'], depsWith(async () => ({ status: 'dirty', packets: [], text: '', docId: 'token-service' })).d);
    assert.equal(dirty.code, 3);
    assert.match(dirty.stderr, /^suiko: token-service has unrecorded edits \(working copy differs from v1\)\. Record them first: `suiko revise token-service --replies -`/);
  });

  test('--allow-dirty, --all and usage errors', async () => {
    const { engine, d } = depsWith(async () => ({ status: 'timeout', packets: [], text: '' }));
    const all = await runCli(['wait', '--all', '--allow-dirty', '--timeout', '1s'], d);
    assert.equal(all.code, 2);
    assert.match(all.stdout, /^suiko: no review yet for any tracked doc after 1s\. Run `suiko wait --all` again/);
    const opts = engine.calls.find((c) => c.name === 'waitForFeedback')?.args[1];
    assert.equal(opts.all, true);
    assert.equal(opts.allowDirty, true);
    assert.equal(opts.docIds, '*');
    assert.equal((await runCli(['wait', 'token-service', '--all'], d)).code, 1);
    assert.equal((await runCli(['wait', 'token-service', '--timeout', 'later'], d)).code, 1);
    assert.equal((await runCli(['wait', 'nope'], d)).code, 4);
  });

  test('superseded by a newer wait -> exit 6 with one stderr line, nothing on stdout', async () => {
    const { d } = depsWith(async () => ({ status: 'superseded', packets: [], text: '', by: 4321 }));
    const r = await runCli(['wait', 'token-service'], d);
    assert.equal(r.code, 6);
    assert.equal(r.stderr.split('\n').filter((l) => l.includes('superseded')).length, 1);
    assert.match(r.stderr, /suiko: superseded by pid 4321 \(a newer wait is listening\); ignore this\.\n$/);
    assert.equal(r.stdout, '');
    const j = await runCli(['wait', 'token-service', '--json'], d);
    assert.deepEqual(JSON.parse(j.stdout), { status: 'superseded', by: 4321 });
  });

  test('SIGINT -> exit 130, nothing delivered, the engine is told to stop, late writes are refused', async () => {
    const signals = new EventEmitter();
    let started = false;
    /** @type {Promise<string> | null} */
    let lateWrite = null;
    let engineFinished = false;
    const { d } = depsWith(
      async (/** @type {any} */ ctx, /** @type {any} */ opts) => {
        started = true;
        await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
        lateWrite = opts.write(packetText(samplePacket())).then(
          () => 'written',
          (/** @type {Error} */ e) => e.message,
        );
        engineFinished = true;
        return { status: 'timeout', packets: [], text: '', aborted: true };
      },
      { signals },
    );
    const pending = runCli(['wait', 'token-service'], d);
    await until(() => started);
    signals.emit('SIGINT');
    const r = await pending;
    assert.equal(r.code, 130);
    assert.match(r.stderr, /wait interrupted \(SIGINT\); nothing was delivered/);
    assert.equal(r.stdout, '');
    assert.ok(engineFinished, 'the command waited for the engine to finish its cleanup');
    assert.match(String(await lateWrite), /not delivering/);
    assert.equal(signals.listenerCount('SIGINT'), 0, 'signal handlers removed');
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });

  test('an engine that throws once aborted still exits 143 on SIGTERM', async () => {
    const signals = new EventEmitter();
    let started = false;
    const { d } = depsWith(
      async (/** @type {any} */ ctx, /** @type {any} */ opts) => {
        started = true;
        await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
      { signals },
    );
    const pending = runCli(['wait', 'token-service'], d);
    await until(() => started);
    signals.emit('SIGTERM');
    const r = await pending;
    assert.equal(r.code, 143);
    assert.equal(r.stdout, '');
  });

  test('an engine that ignores the timeout still ends (timeout + 2 s grace) with exit 2', async () => {
    const { d } = depsWith(() => new Promise(() => {}));
    const t0 = Date.now();
    const r = await runCli(['wait', 'token-service', '--timeout', '100ms'], d);
    assert.equal(r.code, 2);
    assert.ok(Date.now() - t0 < 5000);
  });

  test('engine errors propagate (exit code of the error)', async () => {
    const { NotFoundError } = await import('../../src/core/store/errors.js');
    const { d } = depsWith(async () => {
      throw new NotFoundError('no tracked docs to wait for');
    });
    const r = await runCli(['wait', 'token-service'], d);
    assert.equal(r.code, 4);
    assert.equal(r.stderr.trim().split('\n').pop(), 'suiko: no tracked docs to wait for');
  });
});
