// @ts-check
// The kind adapter (design 2.9): every path of the review engine that depends on what a doc IS (a spec file, a
// snapshot, a code review) goes through `kindOf(doc)`, so code docs never reach the render / anchor / working-file
// machinery of spec docs (which would crash, or write wrong anchors into thread files).
//
//   kindOf(doc) -> KindAdapter      fileKind for file and snapshot docs (today's code, moved here unchanged);
//                                   codeKind for code docs (delegates to src/core/code/*)
//
// Whole ops that differ for code docs dispatch at the op ENTRY on `doc.kind === 'code'` (isCode), never on the
// capture kind or on whether a `file` argument is present:
//
//   revise                     ops/revise.js   -> code/round.js reviseCode(ctx, doc, input)
//   recordReviewerVersion      ops/revise.js   -> recordCodeRound(ctx, doc, { author: human, capturedBy: 'ui-record' })
//   applySuggestionAsReviewer  ops/revise.js   -> applyCodeSuggestions(..., { actor: human }) + recordCodeRound('ui-apply')
//   applySuggestions           ops/edits.js    -> code/apply.js applyCodeSuggestions(ctx, doc, tids, { dryRun, actor })
//   taggedEdit(s), revert      ops/edits.js    -> refused (exit 3): edit the files, `suiko revise` records the round
//   addLock / relock           ops/locks.js    -> refused before any render: "code reviews have no locks"
//   ask, reanchorThread        ops/threads.js  -> code/threads.js askCode, reanchorCode
//   moveThread                 ops/threads.js  -> kindOf(doc).capture + forwarder (a capture is required)
//   show (file source)         ops/threads.js  -> code/files.js codeFileSource; show (thread) -> describeThread
//   changes, sourceDiffOp,     ops/changes.js  -> code/files.js codeChanges, codeFileDiff, codeUnifiedDiff,
//   unifiedDiff, threadMiniDiff                   codeThreadMiniDiff
//   domTargets                 ops/changes.js  -> empty lists
//   docState, status           ops/docs.js     -> working from kindOf(doc).workingState; status.file is null
//   finalize (decisions file)  ops/final.js    -> the doc dir (.specreview/docs/<id>/decisions.md) unless --out
//   packet header/basis/NEXT   packet-data.js  -> code/packet.js codePacketLabel, codeLineBasis, codeNextStep
//   daemon targets fallback    daemon/api.js   -> empty; content origin (daemon/content.js) -> 404 for every route
//   daemon/watch.js                            -> no chokidar watcher and no stat poll (isVirtual)
//
// `isSnapshot` classification (store/snapshot.js: isSnapshot = snapshot docs; isVirtual = snapshot or code docs;
// isCode = code docs). Every remaining `isSnapshot(` / `kind === 'snapshot'` / `kind !== 'snapshot'` in src/ is
// listed in SNAPSHOT_SITES below, with its outcome; test/unit/kind-classification.test.js fails on an unlisted use.
//
//   stays isSnapshot (snapshot-only behaviour; code docs are dispatched before reaching it):
//     core/review/ops/revise.js      snapshot profile (--source, warn-only guards); applySuggestionAsReviewer refusal
//     core/review/ops/snapshot.js    recordSnapshot: "is not a snapshot doc" (refuses code docs too)
//     core/review/ops/common.js      refuseSnapshot (callers dispatch code docs BEFORE calling it)
//     core/review/ops/docs.js        status: the snapshot fields (kind, origin, plan file); code has its own branch
//     core/review/ops/final.js       decisions file of a snapshot in the cwd (a code doc's goes to its doc dir first)
//     core/review/packet-data.js     snapshot NEXT, plan file and lines (the code branch comes first)
//     core/review/packet.js          packet / status objects of kind 'snapshot', incl. web-page lines and protocol
//                                    (code packets have their own branch)
//     cli/hooks.js                   `hook prompt` skips plan docs
//     ui/model.js                    kindCaps: snapshot docs have no "Apply now" (ThreadCard)
//     daemon/api.js                  a web-page snapshot's source URL in the doc summary
//     daemon/content.js              the strict CSP of snapshot docs (code docs are never served there)
//     ui/components/DocFrame.js      the strict sandbox of snapshot docs (code docs have their own view)
//   became isVirtual (no working file of their own):
//     core/store/store.js (workingPath, readWorking, writeWorking, findDoc, findDocByOrigin, createDoc duplicates),
//     core/review/ops/record.js (asset skips, autoCommit docPath), core/review/ops/common.js (changedWorkingAssets),
//     daemon/content.js, daemon/watch.js, cli/commands/doctor.js, cli/hooks.js (pre-write: file docs only)
//   became kind dispatch (isCode / doc.kind):
//     common.js refuseSnapshot ordering, daemon/api.js and ops/docs.js `kind` fields ('code'), ops/final.js,
//     ui/components/Home.js (the doc list's label and kind chip: 'code' | a snapshot's origin)

import { NotFoundError } from '../store/errors.js';
import { isCode } from '../store/snapshot.js';
import { renderSource, textRender } from '../render/index.js';
import { lineIndex } from '../text/index.js';
import { anchorForCapture, describe, envOf, forwardAnchor, label as anchorLabel, quoteText } from './anchoring.js';
import { linesLabel, sectionPath, truncate } from './labels.js';
import { anchorAt } from './threadstate.js';
import { resolveCodeCapture } from '../code/capture.js';
import { codeForwarder } from '../code/forward.js';
import { codeWorkingState } from '../code/state.js';
import { describeCodeThread, loadCodeSnapshot } from '../code/packet.js';

/**
 * @typedef {import('./context.js').Ctx} Ctx
 * @typedef {import('../../shared/types.js').Doc} Doc
 * @typedef {import('../../shared/types.js').DocKind} DocKind
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').Capture} Capture
 * @typedef {import('../../shared/types.js').Thread} Thread
 * @typedef {import('../../shared/types.js').VersionManifest} VersionManifest
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {{ text: string, sha256: string | null, buf: Buffer | null, missing: boolean, dirty: boolean }} WorkingState
 * @typedef {{ v: number, manifest: VersionManifest, source: string }} HeadState
 *
 * @typedef {object} CapturePreview the composer preview ("Agent will see: ...")
 * @property {string} label
 * @property {[number, number] | null} lines
 * @property {string[]} section
 * @property {string} src
 * @property {string} text
 *
 * How a thread is presented to the agent (packet items, `show`, `threads`). File kinds: the fields of
 * anchoring.describe; code docs add `file`, `fileFromCwd`, `side`, `was`, `fileState`, `nowBetween`, `fileStatus`.
 * @typedef {object} ThreadView
 * @property {[number, number] | null} lines working-copy lines (code, old side: base lines)
 * @property {string | null} src
 * @property {boolean} [srcUnique]
 * @property {boolean} [srcWindow]
 * @property {boolean} [srcEditable]
 * @property {string | null} [on]
 * @property {string} [label]
 * @property {string[]} [crops]
 * @property {'region' | 'snip' | 'image'} [cropKind]
 * @property {any} [lastKnown]
 * @property {string | null} [file]
 * @property {string | null} [fileFromCwd]
 * @property {'new' | 'old' | null} [side]
 * @property {string[] | null} [was]
 * @property {'ok' | 'missing' | 'not-checked-out' | 'binary' | 'too-large' | null} [fileState]
 * @property {[number, number] | null} [nowBetween]
 * @property {string | null} [fileStatus]
 *
 * @typedef {object} DescribeOpts
 * @property {string} [workingText] the working text to map head anchors onto (file kinds; default: snap.working)
 * @property {(rel: string) => string} [attachmentPath] doc-relative attachment -> absolute path
 * @property {import('./anchoring.js').AnchorEnv} [env]
 * @property {any} [config]
 * @property {string | null} [cwd] the agent's cwd (code: fileFromCwd)
 * @property {string | null} [root] the workspace root
 *
 * @typedef {object} KindAdapter
 * @property {DocKind} kind
 * @property {(ctx: Ctx, doc: Doc, v: number | 'live', source?: string) => Promise<RenderResult>} render
 *   render of version v (or of `source` when given: the text about to be recorded)
 * @property {(ctx: Ctx, doc: Doc) => (anchor: Anchor, toVersion: number) => Promise<Record<string, Anchor>>} forwarder
 *   carries an anchor of an older version forward to toVersion (submit, moveThread, addLock, domTargets)
 * @property {(ctx: Ctx, doc: Doc, capture: Capture, v: number, opts?: { widen?: boolean }) => Promise<{ anchor: Anchor, preview: CapturePreview }>} capture
 *   resolves a capture at version v (resolveCapture, moveThread); `opts.widen` is a file-kind option
 * @property {(ctx: Ctx, doc: Doc, head: HeadState | null) => Promise<WorkingState>} workingState
 *   the working copy against head (common.js readWorkingState dispatches here)
 * @property {(snap: any, thread: Thread, opts: DescribeOpts) => ThreadView | null} describeThread
 *   presentation of a thread at head (null: no anchor)
 * @property {(ctx: Ctx, doc: Doc, snap: any) => Promise<void>} loadExtra add-ons of loadSnapshot (code: snap.code)
 */

/** @type {KindAdapter} */
const fileKind = Object.freeze({
  kind: /** @type {DocKind} */ ('file'),
  async render(ctx, doc, v, source) {
    if (source !== undefined) return renderSource({ format: doc.format, source, docPath: doc.path });
    return ctx.render(doc, v);
  },
  forwarder(ctx, doc) {
    const load = versionLoader(ctx, doc);
    const env = envOf(doc, ctx.config);
    return (anchor, toVersion) => (anchor.v < toVersion ? forwardAnchor(anchor, toVersion, load, env) : Promise.resolve({ [String(anchor.v)]: anchor }));
  },
  async capture(ctx, doc, capture, v, { widen = false } = {}) {
    const { source, manifest } = await ctx.store.readVersion(doc.id, v);
    const render = await ctx.render(doc, v);
    const anchor = anchorForCapture({ version: v, capture, source, render, env: envOf(doc, ctx.config), assets: manifest.assets ?? null, widen });
    return { anchor, preview: preview(anchor, source, doc.title) };
  },
  async workingState(ctx, doc, head) {
    try {
      const w = await ctx.store.readWorking(doc);
      return { text: w.text, sha256: w.sha256, buf: w.buf, missing: false, dirty: head ? w.sha256 !== head.manifest.sha256 : true };
    } catch (err) {
      if (err instanceof NotFoundError) return { text: head?.source ?? '', sha256: null, buf: null, missing: true, dirty: true };
      throw err;
    }
  },
  describeThread(snap, thread, { workingText, attachmentPath, env, config } = {}) {
    const anchor = anchorAt(thread, snap.head.v);
    if (!anchor) return null;
    return describe(anchor, {
      headSource: snap.head.source,
      workingSource: workingText ?? (snap.working.missing ? snap.head.source : snap.working.text),
      hunks: snap.mapper.hunks,
      env: env ?? envOf(snap.doc, config),
      attachments: thread.attachments ?? [],
      absAttachmentPath: attachmentPath,
    });
  },
  async loadExtra() {},
});

/** @type {KindAdapter} */
const codeKind = Object.freeze({
  kind: /** @type {DocKind} */ ('code'),
  // code docs are never rendered: the UI's code view shows them, the content origin serves nothing
  async render() {
    return textRender();
  },
  forwarder: (ctx, doc) => codeForwarder(ctx, doc),
  capture: (ctx, doc, capture, v) => resolveCodeCapture(ctx, doc, capture, v),
  workingState: (ctx, doc, head) => codeWorkingState(ctx, doc, head),
  describeThread(snap, thread, opts) {
    return anchorAt(thread, snap.head.v) ? describeCodeThread(snap, thread, opts) : null;
  },
  loadExtra: (ctx, doc, snap) => loadCodeSnapshot(ctx, doc, snap),
});

/**
 * The kind adapter of a doc.
 * @param {Doc | { kind?: string }} doc
 * @returns {KindAdapter}
 */
export function kindOf(doc) {
  return isCode(doc) ? codeKind : fileKind;
}

/**
 * Memoised loader of version sources and renders: (v) => { source, render, manifest }.
 * @param {Ctx} ctx
 * @param {Doc} doc
 * @returns {(v: number) => Promise<{ source: string, render: RenderResult, manifest: VersionManifest }>}
 */
export function versionLoader(ctx, doc) {
  /** @type {Map<number, Promise<{ source: string, render: RenderResult, manifest: VersionManifest }>>} */
  const cache = new Map();
  return (v) => {
    let p = cache.get(v);
    if (!p) {
      p = (async () => {
        const { source, manifest } = await ctx.store.readVersion(doc.id, v);
        return { source, manifest, render: await ctx.render(doc, v) };
      })();
      cache.set(v, p);
    }
    return p;
  };
}

/**
 * The composer preview of a file-kind anchor: "Agent will see: L42-43 §3.2 'rotated on every use'".
 * @param {Anchor} anchor
 * @param {string} source
 * @param {string} title
 * @returns {CapturePreview}
 */
export function preview(anchor, source, title) {
  const lines = anchor.kind === 'doc' ? null : /** @type {[number, number]} */ ([anchor.src.startLine, anchor.src.endLine]);
  let src = '';
  if (lines) {
    const li = lineIndex(source);
    const all = source.slice(li.startOf(lines[0]), li.endOf(lines[1])).split('\n');
    src = all.length > 3 ? [...all.slice(0, 3), `...(${all.length - 3} more lines)`].join('\n') : all.join('\n');
  }
  const label = anchorLabel(anchor);
  const sec = sectionPath(anchor.section, title);
  const what = anchor.quote?.exact && anchor.kind !== 'section' ? `"${truncate(quoteText(anchor).replace(/\s+/g, ' ').trim(), 60)}"` : label;
  const text = anchor.kind === 'doc' ? 'Agent will see: GENERAL' : `Agent will see: ${[lines ? linesLabel(lines) : '', sec ? `§${sec}` : '', what].filter(Boolean).join(' ')}`;
  return { label, lines, section: anchor.section ?? [], src, text };
}

/**
 * Every remaining snapshot check in src/ (path relative to src/ -> number of matches of
 * /isSnapshot\(|kind [!=]== 'snapshot'/), each classified in the header comment. Keep in sync: the classification
 * test compares this with the source tree.
 */
export const SNAPSHOT_SITES = Object.freeze({
  'core/review/ops/revise.js': 2,
  'core/review/ops/snapshot.js': 1,
  'core/review/ops/common.js': 1,
  'core/review/ops/docs.js': 1,
  'core/review/ops/final.js': 1,
  'core/review/packet-data.js': 1,
  'core/review/packet.js': 8,
  'cli/hooks.js': 1,
  'daemon/api.js': 1,
  'daemon/content.js': 1,
  'ui/components/DocFrame.js': 1,
  'ui/components/Home.js': 1,
  'ui/model.js': 1,
});
