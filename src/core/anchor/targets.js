// @ts-check
// Anchor -> what the guest paints (BUILD_AMENDMENTS 3.4, FROZEN DomTarget), and head anchors -> the working copy
// for the 'live' view.
//
//   toDomTarget(anchor, render, { id, num?, state?, label?, severity?, type?, format? }) -> DomTarget
//     state: the caller's display state (open / addressed / resolved / needs_input / draft / lock); it becomes
//     'orphaned' for an orphaned anchor and 'outdated' for a 'changed' anchor (unless resolved, draft or lock).
//     srid / endSrid are the anchor's (dropped when the render has no such element, and always for orphans);
//     quote / prefix / suffix come from anchor.quote for text-like kinds (text, code, source); element, cell,
//     section and doc targets carry no quote (the guest outlines the element / brackets the section).
//     region / svg / cell are copied (cell gets the anchor's `scope`). label defaults to anchorLabel(anchor).
//     Snips (kind 'snip', see snip.js) are painted as the box they are: {kind: 'element', srid: the container at
//     this version, region} while the container is known; otherwise the covered blocks are outlined
//     ({kind: 'source', srid, endSrid, quote: null, region: null}). The guest never sees kind 'snip'.
//
//   mapAnchorToWorking(anchor, headSource, workingSource, hunks?, mapper?, { render?, format?, originalAnchor?,
//                      docPath?, assets?, config? }) -> Anchor
//     Re-anchors a head anchor onto the working copy (no links: the working copy has no attribution yet). When
//     the text is intact (exact/moved) the head state is kept, so a thread stays 'edited'/'changed' as recorded;
//     'changed' / 'orphaned' from the working copy win. Pass the live render to get live srids.

import { anchorLabel } from './describe.js';
import { reanchor } from './reanchor.js';
import { clone, nodeOf } from './util.js';

/**
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').DomTarget} DomTarget
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {import('../diff/hunks.js').Hunk} Hunk
 * @typedef {import('../diff/offsets.js').OffsetMapper} OffsetMapper
 */

const QUOTE_KINDS = new Set(['text', 'code', 'source']);
const KEEP_STATES = new Set(['draft', 'lock']);

/**
 * @param {Anchor} anchor
 * @param {RenderResult|null} render render of the version the anchor refers to (used to validate srids)
 * @param {{ id: string, num?: number|null, state?: DomTarget['state'], label?: string, severity?: string,
 *           type?: string, format?: string }} opts
 * @returns {DomTarget}
 */
export function toDomTarget(anchor, render, opts) {
  const orphaned = anchor.state === 'orphaned';
  const wanted = opts.state ?? 'open';
  /** @type {DomTarget['state']} */
  let state = wanted;
  if (!KEEP_STATES.has(wanted)) {
    if (orphaned) state = 'orphaned';
    else if (anchor.state === 'changed' && wanted !== 'resolved') state = 'outdated';
  }
  const valid = (/** @type {number|null|undefined} */ srid) =>
    srid != null && Number.isInteger(srid) && (!render || nodeOf(render, srid)) ? srid : null;
  let srid = orphaned ? null : valid(anchor.srid);
  let endSrid = orphaned ? null : valid(anchor.endSrid);
  if (srid == null && endSrid != null) [srid, endSrid] = [endSrid, null];
  if (endSrid === srid) endSrid = null;
  const q = !orphaned && QUOTE_KINDS.has(anchor.kind) ? anchor.quote : null;
  /** @type {DomTarget} */
  const target = {
    id: String(opts.id),
    num: opts.num ?? null,
    kind: anchor.kind,
    state,
    srid,
    endSrid,
    quote: q?.exact ? q.exact : null,
    prefix: q?.prefix ?? '',
    suffix: q?.suffix ?? '',
    region: anchor.region ? { ...anchor.region } : null,
    svg: anchor.svg ? { ...anchor.svg } : null,
    cell: anchor.cell ? { ...anchor.cell, ...(anchor.scope ? { scope: anchor.scope } : {}) } : null,
    label: opts.label ?? anchorLabel(anchor),
  };
  if (anchor.kind === /** @type {any} */ ('snip')) {
    const container = orphaned ? null : valid(/** @type {any} */ (anchor).snip?.container?.srid);
    if (container != null && anchor.region) {
      Object.assign(target, { kind: 'element', srid: container, endSrid: null, region: { ...anchor.region } });
    } else {
      Object.assign(target, { kind: 'source', region: null });
    }
  }
  if (opts.severity) target.severity = opts.severity;
  if (opts.type) target.type = opts.type;
  return target;
}

/**
 * @param {Anchor} anchor anchor on head
 * @param {string} headSource
 * @param {string} workingSource
 * @param {Hunk[]|null} [hunks] lineHunks(head, working)
 * @param {OffsetMapper|null} [mapper] offsetMapper(head, working, hunks)
 * @param {{ render?: RenderResult|null, format?: string, originalAnchor?: Anchor|null, docPath?: string,
 *           assets?: Record<string, string>|null, config?: any }} [opts]
 * @returns {Anchor}
 */
export function mapAnchorToWorking(anchor, headSource, workingSource, hunks = null, mapper = null, opts = {}) {
  if (typeof workingSource !== 'string' || workingSource === headSource || anchor.kind === 'doc') return clone(anchor);
  const out = reanchor({
    anchor,
    originalAnchor: opts.originalAnchor ?? null,
    fromSource: headSource,
    toSource: workingSource,
    hunks,
    mapper,
    toRender: opts.render ?? null,
    format: opts.format,
    link: null,
    version: anchor.v,
    docPath: opts.docPath,
    assets: opts.assets ?? null,
    config: opts.config,
  });
  if ((out.state === 'exact' || out.state === 'moved') && anchor.state !== 'orphaned') out.state = anchor.state;
  return out;
}
