// @ts-check
// `specreview wait [<doc>] [--all] [--timeout 0|30m] [--allow-dirty] [--json]` (design 3.4/3.6/9.2, amendments 2.4).
//
// Flow
//   1. Resolve the doc (or every doc with --all; with no argument, the workspace's only doc).
//   2. engine.waitForFeedback(ctx, { docIds, timeoutMs, allowDirty, signal, onStart, write, heartbeatMs }).
//      The engine registers the waiter (`<home>/ws/<wsId>/waiters/<doc|_all>/<pid>.json`, heartbeat every 10 s,
//      supersedes older waits of the same doc + agent), watches for reviews and, under the doc lock, calls our
//      write(text): we print the packet and resolve only after stdout flushed; then it records the delivery.
//   3. Map the outcome to an exit code: delivered 0 · timeout 2 · dirty 3 · closed 5 · superseded 6 ·
//      interrupted 128+signal (SIGINT 130, SIGTERM 143; nothing was delivered).
// The command does not rely on the engine alone to honour `signal`/`timeoutMs`: it races them itself and, once it
// has given up, rejects any late write() so a delivery can never be recorded without reaching stdout. It then
// gives the engine a moment to finish (so its waiter file is removed) before returning.

import { NotFoundError, UsageError } from '../../core/store/errors.js';
import { isGated } from '../../core/store/snapshot.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals, formatDuration, parseDuration } from '../args.js';
import { createDelivery, normalizePackets, packetsJson, packetsText } from '../delivery.js';
import { shellArg } from '../format.js';
import { callOp, docContext, openContext } from '../runtime.js';

export const spec = {
  name: 'wait',
  usage: 'wait [<doc>] [--all] [--timeout 0|30m] [--allow-dirty] [--json]',
  summary: 'Block until the reviewer submits a review (or closes the session) and print the feedback packet.',
  options: {
    all: { type: 'boolean' },
    timeout: { type: 'string' },
    'allow-dirty': { type: 'boolean' },
  },
  details: [
    'Run it in the background (Claude Code: Bash with run_in_background) and end the turn; you are re-invoked when it exits.',
    '--timeout 0 (default) waits indefinitely; 30m, 90s, 2h... give up with exit 2.',
    'Exits 3 at once when the working copy has unrecorded edits (run `specreview revise` first) unless --allow-dirty.',
    'Exit codes: 0 delivered · 2 timeout · 3 dirty · 5 session closed · 6 superseded by a newer wait (ignore it).',
    '--json prints each delivered packet as one JSON line.',
  ],
};

const SIGNAL_EXIT = /** @type {Record<string, number>} */ ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });

/** Extra time granted to an engine that ignores `timeoutMs`, and to its cleanup after we gave up. */
const TIMEOUT_GRACE_MS = 2000;
const CLEANUP_GRACE_MS = 1500;

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('wait', positionals, 0, 1, spec.usage);
  if (values.all && positionals.length) throw new UsageError('wait: pass either <doc> or --all, not both');
  return {
    doc: positionals[0],
    all: Boolean(values.all),
    timeoutMs: values.timeout === undefined ? 0 : parseDuration(values.timeout),
    allowDirty: Boolean(values['allow-dirty']),
  };
}

/**
 * @typedef {object} WaitInput
 * @property {string} [doc]
 * @property {boolean} [all]
 * @property {number} [timeoutMs] 0 = no limit
 * @property {boolean} [allowDirty]
 * @property {AbortSignal} [signal] extra cancellation (MCP request cancel)
 */

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {WaitInput} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const target = await resolveTarget(rt, input);
  const { ctx, engine, label, noun, head } = target;
  const timeoutMs = input.timeoutMs ?? 0;

  const controller = new AbortController();
  /** @type {string | null} */
  let abortedBy = null;
  /** @param {string} why */
  const abort = (why) => {
    if (!controller.signal.aborted) {
      abortedBy = why;
      controller.abort(why);
    }
  };
  /** @type {Array<() => void>} */
  const cleanups = [];
  for (const s of [rt.signal, input.signal]) {
    if (!s) continue;
    const onAbort = () => abort(String(s.reason ?? 'aborted'));
    if (s.aborted) onAbort();
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }

  const delivery = createDelivery(rt, engine, { signal: controller.signal, packetFor: packetRebuilder(engine, ctx, target) });
  let announced = false;
  const announce = () => {
    if (announced || rt.mode !== 'cli' || controller.signal.aborted) return;
    announced = true;
    const what = input.all ? `any doc in ${ctx?.store?.root ?? ctx?.root ?? 'this workspace'}` : `${noun}${head ? ` v${head}` : ''}`;
    rt.stderr.write(`specreview: waiting for a review of ${what} (as ${rt.agent}). Safe to interrupt; nothing is lost.\n`);
  };
  // engines that never call onStart still get the note once the wait is clearly blocking
  const announceTimer = setTimeout(announce, 1500);
  announceTimer.unref?.();
  cleanups.push(() => clearTimeout(announceTimer));

  /** @type {any} */
  let outcome;
  /** @type {Promise<any> | null} */
  let opPromise = null;
  try {
    opPromise = callOp(engine, 'waitForFeedback', ctx, {
      docIds: target.docIds,
      all: Boolean(input.all),
      timeoutMs,
      allowDirty: Boolean(input.allowDirty),
      signal: controller.signal,
      onStart: announce,
      write: delivery.write,
      agent: rt.agent,
      heartbeatMs: rt.heartbeatMs,
      ...(rt.deps.pollMs ? { pollMs: rt.deps.pollMs } : {}),
    }).catch((err) => {
      // an engine that throws once we aborted it (AbortError...) just stopped waiting
      if (controller.signal.aborted) return { status: 'aborted' };
      throw err;
    });
    /** @type {Array<Promise<any>>} */
    const racers = [opPromise];
    racers.push(
      new Promise((resolve) => {
        if (controller.signal.aborted) resolve({ status: 'aborted' });
        controller.signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true });
      }),
    );
    if (timeoutMs > 0) {
      racers.push(
        new Promise((resolve) => {
          const t = setTimeout(() => {
            resolve({ status: 'timeout' });
            if (!controller.signal.aborted) controller.abort('timeout');
          }, timeoutMs + TIMEOUT_GRACE_MS);
          t.unref?.();
          cleanups.push(() => clearTimeout(t));
        }),
      );
    }
    outcome = await Promise.race(racers);
  } finally {
    delivery.close();
    await delivery.settle();
    // tell an engine that is still waiting to stop (matters in the long-lived MCP server), then let it clean up
    if (!controller.signal.aborted) controller.abort('finished');
    if (opPromise) await settleWithin(opPromise, CLEANUP_GRACE_MS);
    for (const fn of cleanups) fn();
  }

  return finish(rt, engine, { outcome, delivery, abortedBy, label, noun, head, timeoutMs, input, ctx });
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {import('../engine.js').Engine} engine
 * @param {{ outcome: any, delivery: import('../delivery.js').Delivery, abortedBy: string | null, label: string,
 *   noun: string, head: number | null, timeoutMs: number, input: WaitInput, ctx?: any }} s
 * @returns {Promise<import('../io.js').CommandResult>}
 */
async function finish(rt, engine, s) {
  const { outcome, delivery, label } = s;
  const status = outcome?.status;

  // A packet that reached stdout counts as delivered whatever happened afterwards.
  if (status === 'delivered' || delivery.packets().length || delivery.text() !== null) {
    // the engine's return value is authoritative for the structured form (a text-only write carries no object)
    const returned = Array.isArray(outcome?.packets) ? normalizePackets(outcome.packets) : outcome?.packet ? [outcome.packet] : [];
    if (!delivery.written()) await delivery.emit(returned.length ? returned : delivery.packets());
    const list = returned.length ? returned : delivery.packets();
    return {
      exit: EXIT.OK,
      text: delivery.text() ?? (typeof outcome?.text === 'string' && outcome.text ? outcome.text : packetsText(engine, list)),
      json: list.length ? packetsJson(list) : { status: 'delivered' },
      printed: rt.mode === 'cli',
    };
  }
  if (status === 'superseded' || s.abortedBy === 'superseded') {
    const by = Number(outcome?.by ?? outcome?.supersededBy) || null;
    return {
      exit: EXIT.SUPERSEDED,
      stderr: [`specreview: superseded by pid ${by ?? '?'} (a newer wait is listening); ignore this.`],
      json: { status: 'superseded', by },
    };
  }
  if (s.abortedBy && s.abortedBy !== 'timeout' && status !== 'timeout' && status !== 'closed') {
    return {
      exit: SIGNAL_EXIT[s.abortedBy] ?? EXIT.ERROR,
      stderr: [`specreview: wait interrupted (${s.abortedBy}); nothing was delivered. Run \`specreview wait ${label}\` again to keep waiting.`],
      json: { status: 'interrupted', signal: s.abortedBy },
    };
  }
  if (status === 'timeout' || s.abortedBy === 'timeout') {
    const after = s.timeoutMs ? ` after ${formatDuration(s.timeoutMs)}` : '';
    return {
      exit: EXIT.TIMEOUT,
      text: `specreview: no review yet for ${s.noun}${after}. Run \`specreview wait ${label}\` again (or ask the reviewer to click Submit review).`,
      json: { status: 'timeout', doc: s.input.all ? null : s.noun },
    };
  }
  if (status === 'closed') {
    const doc = outcome.docId ?? outcome.doc ?? (s.input.all ? label : s.noun);
    return {
      exit: EXIT.CLOSED,
      text: `specreview: the review session for ${doc} was closed; stop waiting.`,
      json: { status: 'closed', doc },
    };
  }
  if (status === 'dirty') {
    const doc = outcome.docId ?? outcome.doc ?? (s.input.all ? label : s.noun);
    const head = outcome.head ?? s.head;
    const ref = s.input.all ? doc : label; // as the agent named it (a path when the id would not resolve here)
    const code = await codeDirtyFiles(engine, s.ctx, doc);
    if (code) {
      const files = code.files.length ? ` (${code.files[0]}${code.files.length > 1 ? `, +${code.files.length - 1} more` : ''})` : '';
      return {
        exit: EXIT.REFUSED,
        stderr: [`specreview: ${doc}: files changed since v${code.head ?? head ?? '?'}${files}: run \`specreview revise ${ref}\` to record the round first, or pass --allow-dirty.`],
        json: { status: 'dirty', doc, head: code.head ?? head ?? null, changedFiles: code.files },
      };
    }
    return {
      exit: EXIT.REFUSED,
      stderr: [
        `specreview: ${doc} has unrecorded edits (working copy differs from v${head ?? '?'}). ` +
          `Record them first: \`specreview revise ${ref} --replies -\` (or pass --allow-dirty).`,
      ],
      json: { status: 'dirty', doc, head: head ?? null },
    };
  }
  throw new Error(`waitForFeedback returned an unexpected result: ${JSON.stringify(outcome)}`);
}

/**
 * The changed repo files of a dirty code review (design 4.13), or null for any other doc (or when unknown).
 * @param {import('../engine.js').Engine} engine
 * @param {any} ctx
 * @param {string} docId
 * @returns {Promise<{ files: string[], head: number | null } | null>}
 */
async function codeDirtyFiles(engine, ctx, docId) {
  if (!ctx || typeof engine.ops.docState !== 'function') return null;
  try {
    const st = await engine.ops.docState(ctx, docId);
    if (st?.doc?.kind !== 'code') return null;
    return { files: Array.isArray(st.working?.changedFiles) ? st.working.changedFiles : [], head: st.doc.head ?? null };
  } catch {
    return null;
  }
}

/**
 * @typedef {{ ctx: any, engine: import('../engine.js').Engine, docIds: string[] | '*', label: string, noun: string,
 *   head: number | null }} WaitTarget  label: the `wait` argument to repeat; noun: what is waited for, in messages
 */

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {WaitInput} input
 * @returns {Promise<WaitTarget>}
 */
async function resolveTarget(rt, input) {
  if (input.doc) {
    const { ctx, engine, doc } = await docContext(rt, input.doc);
    // retry hints repeat the argument that resolved (a path when the id would not resolve from the cwd)
    const label = input.doc === doc.id ? doc.id : shellArg(input.doc);
    return { ctx, engine, docIds: [doc.id], label, noun: doc.id, head: doc.head ?? null };
  }
  const { ctx, engine } = await openContext(rt);
  // plan snapshots are the plan gate's (store/snapshot.js isGated): neither --all nor the doc-less default takes them
  const docs = (ctx?.store?.listDocs ? await ctx.store.listDocs() : []).filter((/** @type {any} */ d) => !isGated(d));
  if (!docs.length) throw new NotFoundError('no tracked docs in this workspace; run `specreview open <file>` first');
  if (input.all) return { ctx, engine, docIds: '*', label: '--all', noun: 'any tracked doc', head: null };
  if (docs.length > 1) {
    throw new UsageError(`wait: several docs are tracked (${docs.map((/** @type {any} */ d) => d.id).join(', ')}); pass <doc> or --all`);
  }
  return { ctx, engine, docIds: [docs[0].id], label: docs[0].id, noun: docs[0].id, head: docs[0].head ?? null };
}

/**
 * For --json: rebuilds the packet object of a text-only write by building each candidate doc's packet (inside the
 * engine's critical section the state is unchanged, so the texts are identical). null when the engine cannot.
 * @param {import('../engine.js').Engine} engine
 * @param {any} ctx
 * @param {WaitTarget} target
 * @returns {((text: string) => Promise<any | null>) | undefined}
 */
function packetRebuilder(engine, ctx, target) {
  if (typeof engine.ops.buildDocPacket !== 'function' || !ctx?.store) return undefined;
  return async (text) => {
    const docs = target.docIds === '*' ? (await ctx.store.listDocs()).filter((/** @type {any} */ d) => !isGated(d)) : await Promise.all(target.docIds.map((id) => ctx.store.getDoc(id)));
    for (const doc of docs) {
      if (!doc) continue;
      const built = await engine.ops.buildDocPacket(ctx, doc, {});
      if (built?.text === text) return built.packet;
    }
    return null;
  };
}

/**
 * Waits for a promise to settle, at most `ms` milliseconds; never throws.
 * @param {Promise<unknown>} p
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function settleWithin(p, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  await Promise.race([
    p.then(
      () => {},
      () => {},
    ),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}
