// @ts-check
// `specreview snip [<doc>] [-m <text>] [--question] [--send] [--file <png>] [--json]` (reviewer tool, README
// "Snipping"): a screen snip from any terminal or a macOS Shortcuts global hotkey, without the review UI.
//
// 1. The doc: <doc> (id or path) when given; else the only doc of the cwd's workspace (or --workspace); else the
//    MOST RECENTLY ACTIVE doc (latest event of its runtime feed, engine docsByActivity) of that workspace when it
//    tracks several, or of every registered workspace when the cwd has none (e.g. a Shortcut started from $HOME).
//    Closed docs are only chosen when nothing else is tracked. An inferred choice is named on stderr.
// 2. The picture: macOS's region picker (src/core/util/screen-capture.js: `screencapture -i`, Esc cancels; the
//    image is scaled to SNIP.maxScreenPx), or --file <png|jpg> (any OS, no picker).
// 3. ops.saveAttachment stores it (attachments/aN.png), then ops.saveDraft adds a reviewer DRAFT: a GENERAL thread
//    (capture {kind:'doc'}), type comment (--question: question), severity normal, body -m (may be empty),
//    attachments [path]. Its drafts.changed event carries {source:'snip', draft} so an open review UI toasts
//    "Screenshot added from your Mac" with [Edit].
// 4. --send submits just that draft as a one-item review (verdict comment), so a background `specreview wait`
//    wakes with a packet whose item prints the image's absolute path.
// Works without the daemon (the engine writes the store; a running daemon picks the events up).
// Exit 0 (also when the picker was cancelled: "cancelled", nothing added); 1 when screen snips are unsupported here
// (not macOS, no screencapture) or the image is unusable; 4 when the doc is unknown / nothing is tracked.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError, SpecReviewError, UsageError } from '../../core/store/errors.js';
import { captureScreenRegion, imageMime, imageSize } from '../../core/util/screen-capture.js';
import { EXIT, LIMITS } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { callOp, docContext, listDocIds, openContext, realpathOr, resolveDoc } from '../runtime.js';

export const spec = {
  name: 'snip',
  usage: 'snip [<doc>] [-m <text>] [--question] [--send] [--file <png>] [--json]',
  summary: 'Snip anywhere on screen (macOS picker) and add it to a doc as a draft comment, or send it now with --send.',
  options: {
    message: { type: 'string', short: 'm' },
    question: { type: 'boolean' },
    send: { type: 'boolean' },
    file: { type: 'string' },
  },
  details: [
    '<doc>          doc id or spec path; default: the only doc of this workspace, else the most recently active one',
    '-m <text>      the comment (default: none; add it from the review UI)',
    '--question     a question instead of a comment',
    '--send         submit it at once as a one-item review (verdict comment): a waiting agent gets it now',
    '--file <png>   attach an existing PNG/JPEG instead of opening the picker (any OS)',
    'Esc in the picker cancels (exit 0, nothing added). Screen snips need macOS (screencapture) and the',
    'Screen Recording permission for the app that runs this command.',
  ],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('snip', positionals, 0, 1, spec.usage);
  if (values.file !== undefined && !String(values.file).trim()) throw new UsageError('snip: --file needs a path to a PNG or JPEG image');
  return {
    doc: positionals[0],
    body: values.message ?? '',
    question: Boolean(values.question),
    send: Boolean(values.send),
    file: values.file !== undefined ? path.resolve(rt.cwd, expandHome(String(values.file), rt.env)) : undefined,
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc?: string, body?: string, question?: boolean, send?: boolean, file?: string }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const target = await chooseDoc(rt, input.doc);
  const { ctx, engine, docId } = target;
  /** @type {string[]} */
  const stderr = target.note ? [target.note] : [];
  const shot = input.file ? await readImageFile(input.file) : await pickRegion(rt);
  const base = { doc: docId, ws: ctx.wsId ?? ctx.store?.wsId ?? null, root: ctx.root ?? ctx.store?.root ?? null, chosen: target.how };
  if (!shot) {
    return { exit: EXIT.OK, text: 'specreview: snip cancelled; nothing was added', json: { ...base, cancelled: true }, stderr };
  }
  const mime = /** @type {string} */ (imageMime(shot.png));
  const att = await callOp(engine, 'saveAttachment', ctx, docId, { dataUrl: `data:${mime};base64,${shot.png.toString('base64')}` });
  const relPath = typeof att === 'string' ? att : att.path;
  const type = input.question ? 'question' : 'comment';
  const draft = await callOp(
    engine,
    'saveDraft',
    ctx,
    docId,
    { kind: 'thread', type, severity: 'normal', capture: { kind: 'doc' }, body: input.body ?? '', attachments: [relPath] },
    { source: 'snip' },
  );
  const json = {
    ...base,
    cancelled: false,
    draft: draft.id,
    type,
    attachment: { path: relPath, file: typeof att === 'object' ? att.abs ?? null : null, width: shot.width, height: shot.height },
    sent: false,
    review: /** @type {string | null} */ (null),
    listening: /** @type {string[]} */ ([]),
  };
  if (!input.send) {
    return {
      exit: EXIT.OK,
      text: `specreview: added a screenshot to ${docId} as draft ${draft.id} - open the review UI to comment and submit`,
      json,
      stderr,
    };
  }
  // who is waiting is read BEFORE the submit: a waiter gets the packet at once and leaves
  const listening = await listeners(ctx, docId);
  const review = await callOp(engine, 'submitReview', ctx, docId, { verdict: 'comment', draftIds: [draft.id] });
  json.sent = true;
  json.review = review.id;
  json.listening = listening;
  const to = listening.length ? listening.join(', ') : 'the agent';
  const later = listening.length ? '' : ' (nobody is waiting right now; it is delivered by the next `specreview wait`)';
  return { exit: EXIT.OK, text: `specreview: sent a screenshot to ${to} as review ${review.id} on ${docId}${later}`, json, stderr };
}

// ------------------------------------------------------------------------------------------------- the doc

/**
 * @typedef {{ ctx: any, engine: import('../engine.js').Engine, doc: any, docId: string,
 *   how: 'explicit' | 'workspace' | 'recent', note: string | null }} Target
 */

/**
 * The doc a snip goes to (see the header).
 * @param {import('../runtime.js').Runtime} rt
 * @param {string | undefined} docArg
 * @returns {Promise<Target>}
 */
async function chooseDoc(rt, docArg) {
  if (docArg) return { ...(await docContext(rt, docArg)), how: 'explicit', note: null };
  const engine = await rt.engine();
  /** @type {string[] | null} null = every registered workspace */
  let roots = null;
  try {
    // the cwd's workspace (or --workspace, or the single registered workspace related to the cwd)
    const { ctx } = await openContext(rt);
    const ids = await listDocIds(ctx);
    if (ids.length === 1) {
      const doc = await resolveDoc(engine, ctx, ids[0]);
      return { ctx, engine, doc, docId: doc.id, how: 'workspace', note: null };
    }
    if (ids.length > 1 || rt.workspace) roots = [ctx.root ?? ctx.store?.root];
  } catch (err) {
    if (err instanceof UsageError && Array.isArray(err.details?.workspaces)) {
      roots = /** @type {string[]} */ (err.details.workspaces); // several workspaces related to the cwd
    } else if (!(err instanceof NotFoundError) || rt.workspace) {
      throw err;
    }
  }
  /** @param {string[] | null} r */
  const rank = async (r) => /** @type {Array<{ root: string, id: string, state: string, activeAt: string }>} */ (
    await callOp(engine, 'docsByActivity', null, { roots: r })
  );
  let ranked = await rank(roots);
  if (!ranked.length && roots && !rt.workspace) ranked = await rank(null);
  const pick = ranked.find((d) => d.state !== 'closed') ?? ranked[0];
  if (!pick) {
    throw new NotFoundError(
      rt.workspace
        ? `no tracked docs in ${rt.workspace} (run \`specreview open <file>\` first, or pass the doc)`
        : 'no tracked docs (run `specreview open <file>` first, or pass the doc: specreview snip <doc>)',
    );
  }
  const ctx = await engine.createContext({ cwd: rt.cwd, agent: rt.agent, root: pick.root });
  const doc = await resolveDoc(engine, ctx, pick.id);
  const where = realpathOr(rt.cwd) === pick.root ? '' : ` in ${pick.root}`;
  const others = ranked.length - 1;
  const note = `specreview: no doc given; snipping to ${doc.id}${where}, the most recently active of ${others + 1} tracked doc${others ? 's' : ''} (pass the doc to choose)`;
  return { ctx, engine, doc, docId: doc.id, how: 'recent', note };
}

/**
 * Agents waiting on a doc (or on every doc of its workspace) right now.
 * @param {any} ctx
 * @param {string} docId
 * @returns {Promise<string[]>}
 */
async function listeners(ctx, docId) {
  try {
    const waiters = [...(await ctx.store.listWaiters(docId)), ...(await ctx.store.listWaiters('_all'))];
    return [...new Set(waiters.map((/** @type {any} */ w) => String(w.agent)))].sort();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------------------------------------- the picture

/**
 * Runs the macOS region picker; null when cancelled. 'unsupported' errors get a hint about --file.
 * @param {import('../runtime.js').Runtime} rt
 * @returns {Promise<{ png: Buffer, width: number, height: number } | null>}
 */
async function pickRegion(rt) {
  try {
    return await captureScreenRegion({ env: rt.env, signal: rt.signal });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === 'unsupported') {
      throw new SpecReviewError(`${e.message}. Attach an existing image with --file <png>, or snip inside the doc with b in the review UI`, {
        code: 'unsupported',
        exit: EXIT.ERROR,
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * An image file given with --file: a PNG or JPEG of at most LIMITS.maxAttachmentBytes.
 * @param {string} file absolute path
 * @returns {Promise<{ png: Buffer, width: number, height: number }>}
 */
async function readImageFile(file) {
  /** @type {Buffer} */
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new NotFoundError(`snip --file: no such file: ${file}`, { details: { path: file } });
    throw new UsageError(`snip --file: cannot read ${file}: ${/** @type {Error} */ (err).message}`);
  }
  const size = imageSize(buf);
  if (!imageMime(buf) || !size) throw new UsageError(`snip --file: ${file} is not a PNG or JPEG image`);
  if (buf.length > LIMITS.maxAttachmentBytes) {
    throw new UsageError(`snip --file: ${file} is ${(buf.length / (1024 * 1024)).toFixed(1)} MB; images are limited to ${LIMITS.maxAttachmentBytes / (1024 * 1024)} MB`);
  }
  return { png: buf, width: size.width, height: size.height };
}

/**
 * '~/x.png' -> '$HOME/x.png' (a Shortcut's "Run Shell Script" passes ~ unexpanded when quoted).
 * @param {string} p
 * @param {Record<string, string | undefined>} env
 */
function expandHome(p, env) {
  if (p !== '~' && !p.startsWith('~/')) return p;
  const home = env.HOME || process.env.HOME || '';
  return home ? path.join(home, p.slice(1)) : p;
}
