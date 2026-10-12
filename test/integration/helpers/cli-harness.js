// @ts-check
// Test harness for the WP4 CLI/MCP tests: a temp workspace with a real WP1 Store (so doc resolution, waiters and
// hooks see the real on-disk layout), a stub review engine that records its calls and returns canned results
// shaped like the design 4.4 / 9.x contracts, and runCli() which calls main() with in-memory stdio.
// SPECREVIEW_HOME must be set to a temp dir by the test file BEFORE importing this module's users run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../../src/core/store/store.js';
import { memorySink } from '../../../src/cli/io.js';
import { FALLBACK_FORMATTERS } from '../../../src/cli/format.js';
import { main } from '../../../src/cli/main.js';
import { ConflictError, NotFoundError } from '../../../src/core/store/errors.js';

export const SPEC_MD = [
  '# Token Service',
  '',
  '## 3 Tokens',
  '',
  'Refresh tokens are rotated on every use, and the previous token is',
  'invalidated immediately.',
  '',
  '## 5 Retries',
  '',
  'The client MUST retry 3 times.',
  '',
].join('\n');

/**
 * Creates a fresh temp dir (removed by the caller via cleanup()).
 * @param {string} prefix
 * @returns {string}
 */
export function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sr-${prefix}-`)));
}

/**
 * A workspace (with .git so discovery is deterministic) containing docs/specs/token-service.md tracked as v1.
 * @param {{ track?: boolean, content?: string }} [opts]
 */
export async function makeWorkspace({ track = true, content = SPEC_MD } = {}) {
  const root = tempDir('ws');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true });
  const file = path.join(root, 'docs', 'specs', 'token-service.md');
  fs.writeFileSync(file, content);
  const store = await Store.open(root, { create: true });
  /** @type {any} */
  let doc = null;
  if (track) {
    doc = await store.createDoc({ path: file, createdBy: { kind: 'agent', name: 'claude' } });
    await store.commitVersion(doc, { source: fs.readFileSync(file), manifest: { author: { kind: 'agent', name: 'claude' }, summary: 'initial draft', capturedBy: 'open' } });
    doc = await store.getDoc(doc.id);
  }
  return { root, file, store, doc, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A packet shaped like design 9.3. */
export function samplePacket(docId = 'token-service') {
  return {
    schema: 1,
    doc: docId,
    path: 'docs/specs/token-service.md',
    head: 1,
    working: 'clean',
    reviews: [{ id: 'rv1', version: 1, verdict: 'changes_requested', body: 'Good start.', by: 'Eric', at: '2026-10-10T14:02:11.000Z' }],
    verdict: 'changes_requested',
    final: null,
    threads: [
      {
        id: 't1',
        why: 'new',
        type: 'comment',
        severity: 'blocking',
        status: 'open',
        lines: [5, 6],
        section: ['Token Service', '3 Tokens'],
        target: 'text',
        label: 'text',
        on: 'rotated on every use',
        src: 'Refresh tokens are rotated on every use, and the previous token is\ninvalidated immediately.',
        srcUnique: true,
        anchorState: 'exact',
        comments: [{ by: 'Eric', kind: 'human', body: 'Use a 30 s grace window.', at: '2026-10-10T14:01:55.000Z' }],
        suggestion: null,
        attachments: [],
        apply: null,
      },
    ],
    locks: [],
    decisions: [],
    drafts: null,
    counts: { actionable: 1, new: 1, reopened: 0, reply: 0, answer: 0, awaitingReviewer: 0, resolved: 0, outdated: 0 },
    next: `targeted edits, then: suiko revise ${docId} --replies -`,
  };
}

/**
 * Text of a packet as the stub engine passes it to write(): the CLI's fallback formatter (the stub engine has no
 * packet.js), so the CLI's --json packet rebuild (buildDocPacket text === written text) works like the real one.
 * @param {any} packet
 */
export function packetText(packet) {
  return FALLBACK_FORMATTERS.formatPacket(packet);
}

/**
 * Stub engine shaped like WP3's ops (src/core/review/ops.js): every op records { name, args } in `calls`;
 * behaviour can be overridden per op. feedback/waitForFeedback call write(text) like the real engine and return
 * the packet(s); buildDocPacket returns { packet, text } for the CLI's --json rebuild.
 * @param {Store} store
 * @param {Record<string, Function>} [overrides]
 */
export function stubEngine(store, overrides = {}) {
  /** @type {Array<{ name: string, args: any[] }>} */
  const calls = [];
  /** @param {string} name @param {Function} fn */
  const rec = (name, fn) => async (/** @type {any[]} */ ...args) => {
    calls.push({ name, args });
    return (overrides[name] ?? fn)(...args);
  };
  const ops = {
    openDoc: rec('openDoc', async (/** @type {any} */ ctx, /** @type {any} */ { path: p, title }) => {
      const existing = await store.findDoc(p);
      if (existing) return { doc: existing, version: existing.head, created: false, workingDirty: false };
      const doc = await store.createDoc({ path: p, title });
      const manifest = await store.commitVersion(doc, { source: fs.readFileSync(p), manifest: { summary: 'initial', capturedBy: 'open' } });
      return { doc: await store.getDoc(doc.id), version: manifest, created: true, workingDirty: false };
    }),
    feedback: rec('feedback', async (/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {any} */ opts) => {
      const packet = samplePacket(docId);
      if (opts.write) await opts.write(packetText(packet));
      return packet;
    }),
    waitForFeedback: rec('waitForFeedback', async (/** @type {any} */ ctx, /** @type {any} */ opts) => {
      const ids = opts.docIds === '*' || opts.docIds == null ? (await store.listDocs()).map((d) => d.id) : opts.docIds;
      const packet = samplePacket(ids[0]);
      await opts.write(packetText(packet));
      return { status: 'delivered', packets: [packet], text: packetText(packet), docId: ids[0] };
    }),
    buildDocPacket: rec('buildDocPacket', async (/** @type {any} */ ctx, /** @type {any} */ doc) => {
      const packet = samplePacket(doc.id);
      return { packet, text: packetText(packet), deliver: [] };
    }),
    applySuggestions: rec('applySuggestions', async (/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {string[]} */ tids) => ({
      applied: tids.filter((t) => t !== 't9').map((id) => ({ id, lines: [10, 10], how: 'exact' })),
      conflicts: tids.filter((t) => t === 't9').map((id) => ({ id, reason: 'expected text not found near L88' })),
    })),
    taggedEdit: rec('taggedEdit', async (/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {any} */ e) => {
      if (e.oldString === 'missing') throw new ConflictError('old_string not found in the working copy');
      return { lines: [5, 6] };
    }),
    reply: rec('reply', async (/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {string} */ tid, /** @type {any} */ r) => {
      if (tid === 't404') throw new NotFoundError(`thread not found: ${tid}`);
      return { id: tid, type: 'comment', status: r.status ?? 'open', comments: [{ by: { kind: 'agent', name: 'claude' }, body: r.body }] };
    }),
    revise: rec('revise', async (/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {any} */ input) => ({
      refused: Boolean(input.summary === 'refuse-me'),
      version: input.summary === 'refuse-me' ? undefined : 2,
      hunks: [{ id: 'h1', oldRange: [5, 6], newRange: [5, 7], section: ['3 Tokens'], threads: ['t1'], linkedBy: 'overlap', other: null }],
      replies: Object.entries(input.threads).map(([thread, v]) => ({ thread, status: /** @type {any} */ (v).status })),
      guards: input.summary === 'refuse-me' ? { errors: ['lock: h1 changes L1'], warnings: [] } : { errors: [], warnings: [] },
      anchors: { exact: 1, moved: 0, edited: 0, changed: 0, orphaned: 0 },
      notified: true,
    })),
    revert: rec('revert', async () => ({ lines: [5, 6] })),
    reanchorThread: rec('reanchorThread', async (/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {string} */ tid, /** @type {any} */ o) => ({
      anchor: { v: 1, kind: 'text', state: 'exact', src: { startLine: o.lines?.[0] ?? 5, endLine: o.lines?.[1] ?? 5 } },
      staged: false,
    })),
    ask: rec('ask', async () => ({
      id: 't7',
      type: 'agent-question',
      status: 'needs_input',
      anchors: { 1: { v: 1, state: 'exact', src: { startLine: 10, endLine: 10 } } },
      comments: [{ by: { kind: 'agent', name: 'claude' }, body: 'q?' }],
    })),
    show: rec('show', async (/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {any} */ o) =>
      o.thread
        ? { id: o.thread, type: 'comment', status: 'open', comments: [{ by: { name: 'Eric' }, body: 'hello', version: 1 }] }
        : { version: o.version, startLine: o.lines?.[0] ?? 1, lines: ['# Token Service', ''] },
    ),
    changes: rec('changes', async (/** @type {any} */ ctx, /** @type {string} */ docId, /** @type {any} */ o) => ({
      from: o.from ?? 1,
      to: o.to ?? 2,
      stats: { added: 2, removed: 1, hunks: 1, blocksChanged: 1 },
      hunks: [{ id: 'h1', op: 'mod', old: { start: 5, lines: 2 }, new: { start: 5, lines: 3 }, section: ['3 Tokens'], threads: ['t1'], linkedBy: 'overlap', other: null }],
    })),
    log: rec('log', async () => [{ v: 1, author: { kind: 'agent', name: 'claude' }, createdAt: '2026-10-10T13:55:00.000Z', summary: 'initial draft' }]),
    status: rec('status', async (/** @type {any} */ ctx, /** @type {string | null} */ docId) => ({
      docs: [{ doc: { id: docId ?? 'token-service', path: 'docs/specs/token-service.md', head: 1, state: 'in_review' }, undelivered: [], working: 'clean' }],
    })),
    finalize: rec('finalize', async () => ({ final: { version: 3, review: 'rv3', by: 'Eric' }, workingMatches: true, wrote: ['docs/specs/token-service.decisions.md'] })),
    closeSession: rec('closeSession', async () => ({ ok: true })),
  };
  const createContext = async (/** @type {any} */ args) => {
    calls.push({ name: 'createContext', args: [args] });
    return { store, wsId: store.wsId, agent: args.agent };
  };
  return { ops, createContext, calls };
}

/**
 * Runs the CLI in-process.
 * @param {string[]} argv
 * @param {Record<string, any>} deps passed to main() (ops, createContext, env, cwd, stdin text via `input`...)
 * @returns {Promise<{ code: number, stdout: string, stderr: string, out: any, err: any }>}
 */
export async function runCli(argv, deps = {}) {
  const out = deps.stdout ?? memorySink();
  const err = deps.stderr ?? memorySink();
  const { input, ...rest } = deps;
  const stdin = input !== undefined ? Readable.from([Buffer.from(input)]) : Readable.from([]);
  const code = await main(argv, {
    ensureDaemon: async () => ({ pid: 4242, uiPort: 5801, contentPort: 5802, token: 'tok123', secret: 's', version: '0.1.0', startedAt: '' }),
    openBrowser: async () => {},
    env: { SPECREVIEW_HOME: process.env.SPECREVIEW_HOME },
    stdin,
    ...rest,
    stdout: out,
    stderr: err,
  });
  return { code, stdout: out.text(), stderr: err.text(), out, err };
}
