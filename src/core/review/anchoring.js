// @ts-check
// Adapter between the review engine and the anchor library (src/core/anchor, WP3a; design 7,
// BUILD_AMENDMENTS 3.3 / 3.4 / 4.2 / 4.5 / 4.6). Every call into the anchor library goes through here, so the
// engine depends on one small surface and contract drift is absorbed in one file:
//   anchorForCapture   capture (guest) at a version                -> Anchor ('widen' = deepest block element;
//                      not for doc / section / snip captures, which already cover whole blocks)
//   anchorForLines     lines of a version                           -> Anchor (mappedBy 'lines')
//   anchorForQuote     exact text in a version                      -> Anchor | null
//   overrideAnchor     agent `reanchor` / reviewer "Move here"      -> Anchor (state 'exact', mappedBy 'override')
//   stepAnchor         one version forward (re-anchoring)           -> Anchor with state
//   forwardAnchor      several versions forward (drafts and locks made on older versions)
//   domTarget          Anchor + render                              -> DomTarget (amendments 3.4)
//   liveAnchor         head anchor mapped onto the working copy     -> Anchor (for 'live' DOM targets)
//   describe           packet presentation (working-copy lines, src> with the 4.6 caps, label, on, crops)
//   label              the target label ('text', '<img alt="...">', 'mermaid node "X"', 'GENERAL', 'snip (...)')
//   attachmentKind     what a thread's attachments show: 'region' | 'snip' | 'image'
//   sectionExtent      source extent of a heading's section
// The anchor library takes `format`, `docPath` and the version's manifest `assets` (element asset hashes) as
// context: `AnchorEnv` carries them.

import * as anchorLib from '../anchor/index.js';
import { deepestBlockAt } from '../render/index.js';
import { lineHunks, offsetMapper } from '../diff/index.js';

/**
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../../shared/types.js').Capture} Capture
 * @typedef {import('../../shared/types.js').DomTarget} DomTarget
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {import('../diff/hunks.js').Hunk} Hunk
 * @typedef {object} AnchorEnv
 * @property {'markdown' | 'html' | 'text'} format ('text': code docs, identity)
 * @property {string} docPath
 * @property {any} [config] Config or config.anchoring
 */

/**
 * @param {{ version: number, capture: Capture, source: string, render: RenderResult, env: AnchorEnv,
 *   assets?: Record<string, string> | null, widen?: boolean }} p
 * @returns {Anchor}
 */
export function anchorForCapture({ version, capture, source, render, env, assets = null, widen = false }) {
  const base = { version, source, render, format: env.format, docPath: env.docPath, assets, config: env.config };
  let anchor = anchorLib.createAnchor({ ...base, capture });
  if (widen && anchor.kind !== 'doc' && anchor.kind !== 'section' && /** @type {string} */ (anchor.kind) !== 'snip') {
    const srid = deepestBlockAt(render, anchor.src.start, Math.max(anchor.src.start, anchor.src.end));
    const node = srid != null ? render.srcmap.nodes[srid] : null;
    if (node) anchor = anchorLib.createAnchor({ ...base, capture: { kind: 'element', srid: /** @type {number} */ (srid), tag: node.t, label: '' } });
  }
  return anchor;
}

/**
 * @param {{ version: number, startLine: number, endLine: number, source: string, render: RenderResult | null, env: AnchorEnv }} p
 * @returns {Anchor}
 */
export function anchorForLines({ version, startLine, endLine, source, render, env }) {
  return anchorLib.anchorFromLines({ version, startLine, endLine, source, render, format: env.format, config: env.config });
}

/**
 * @param {{ version: number, quote: string, source: string, render: RenderResult | null, env: AnchorEnv, hint?: number | null }} p
 * @returns {Anchor | null}
 */
export function anchorForQuote({ version, quote, source, render, env, hint = null }) {
  return anchorLib.anchorFromQuote({ version, quote, source, render, format: env.format, hint, config: env.config });
}

/**
 * An override anchor (agent `reanchor`, reviewer "Move here"): lines or exact text of `version`.
 * @param {{ version: number, lines?: [number, number] | null, quote?: string | null, source: string,
 *   render: RenderResult | null, env: AnchorEnv }} p
 * @returns {Anchor | null} null when the quote is not found
 */
export function overrideAnchor({ version, lines, quote, source, render, env }) {
  let a = null;
  if (lines) a = anchorForLines({ version, startLine: lines[0], endLine: lines[1], source, render, env });
  else if (quote) a = anchorForQuote({ version, quote, source, render, env });
  return a ? { ...a, state: 'exact', mappedBy: 'override' } : null;
}

/**
 * Re-anchors one version forward (amendments 4.2).
 * @param {object} p
 * @param {Anchor} p.anchor anchor at the previous version
 * @param {Anchor | null} [p.original] the item's anchor at its creation version (fallback)
 * @param {string} p.fromSource
 * @param {string} p.toSource
 * @param {number} p.toVersion
 * @param {RenderResult | null} p.toRender
 * @param {AnchorEnv} p.env
 * @param {Hunk[]} [p.hunks] lineHunks(fromSource, toSource)
 * @param {string[]} [p.linkIds] ids of the hunks of this step linked to the thread
 * @param {boolean} [p.linked] the thread is linked to a change of this step (also through a changed asset)
 * @param {{ lines?: [number, number], quote?: string } | null} [p.override]
 * @param {Record<string, string> | null} [p.assets] manifest assets of the new version
 * @returns {Anchor}
 */
export function stepAnchor({ anchor, original = null, fromSource, toSource, toVersion, toRender, env, hunks, linkIds = [], linked = false, override = null, assets = null }) {
  const hs = hunks ?? lineHunks(fromSource, toSource);
  return anchorLib.reanchor({
    anchor,
    originalAnchor: original,
    fromSource,
    toSource,
    hunks: hs,
    mapper: offsetMapper(fromSource, toSource, hs),
    toRender,
    format: env.format,
    link: linkIds.length || linked ? { hunkIds: linkIds, linked: linked || linkIds.length > 0 } : null,
    override,
    config: env.config,
    version: toVersion,
    docPath: env.docPath,
    assets,
  });
}

/**
 * Re-anchors through every version from `anchor.v` to `toVersion` (no links: drafts and locks created on older
 * versions). `load(v)` returns the source, render and manifest of version v.
 * @param {Anchor} anchor
 * @param {number} toVersion
 * @param {(v: number) => Promise<{ source: string, render: RenderResult, manifest?: { assets?: Record<string, string> } }>} load
 * @param {AnchorEnv} env
 * @returns {Promise<Record<string, Anchor>>} anchors keyed by version, including the starting one
 */
export async function forwardAnchor(anchor, toVersion, load, env) {
  /** @type {Record<string, Anchor>} */
  const out = { [String(anchor.v)]: anchor };
  let cur = anchor;
  let from = await load(anchor.v);
  for (let v = anchor.v + 1; v <= toVersion; v++) {
    const to = await load(v);
    cur = stepAnchor({ anchor: cur, original: anchor, fromSource: from.source, toSource: to.source, toVersion: v, toRender: to.render, env, assets: to.manifest?.assets ?? null });
    out[String(v)] = cur;
    from = to;
  }
  return out;
}

/**
 * @param {Anchor} anchor
 * @param {RenderResult | null} render render of the version the anchor refers to
 * @param {{ id: string, num: number, state: DomTarget['state'], label?: string, severity?: string, type?: string, env: AnchorEnv }} opts
 * @returns {DomTarget}
 */
export function domTarget(anchor, render, { env, ...opts }) {
  return anchorLib.toDomTarget(anchor, render, { ...opts, format: env.format });
}

/**
 * A head anchor re-anchored onto the working copy (live view); srids come from the live render.
 * @param {Anchor} anchor
 * @param {{ headSource: string, workingSource: string, hunks: Hunk[], render: RenderResult | null, env: AnchorEnv,
 *   original?: Anchor | null }} p
 * @returns {Anchor}
 */
export function liveAnchor(anchor, { headSource, workingSource, hunks, render, env, original = null }) {
  return anchorLib.mapAnchorToWorking(anchor, headSource, workingSource, hunks, offsetMapper(headSource, workingSource, hunks), {
    render,
    format: env.format,
    originalAnchor: original,
    docPath: env.docPath,
    config: env.config,
  });
}

/**
 * Packet presentation of a head anchor against the working copy (amendments 4.6).
 * @param {Anchor} anchor
 * @param {{ headSource: string, workingSource: string, hunks: Hunk[], env: AnchorEnv, attachments?: string[],
 *   absAttachmentPath?: (rel: string) => string, absAssetPath?: (rel: string) => string }} p
 */
export function describe(anchor, { headSource, workingSource, hunks, env, attachments = [], absAttachmentPath, absAssetPath }) {
  return anchorLib.describeAnchor(anchor, {
    source: headSource,
    workingSource,
    workingMapper: workingSource === headSource ? null : offsetMapper(headSource, workingSource, hunks),
    format: env.format,
    docPath: env.docPath,
    attachments,
    absAttachmentPath,
    absAssetPath,
  });
}

/**
 * Target label of an anchor ('text' for plain text anchors).
 * @param {Anchor | null | undefined} anchor
 * @returns {string}
 */
export function label(anchor) {
  return anchor ? anchorLib.anchorLabel(anchor) : '';
}

/**
 * The anchor's rendered quote for display, widened to whole words where the selection cut a word ('' without one).
 * @param {Anchor | null | undefined} anchor
 * @returns {string}
 */
export function quoteText(anchor) {
  return anchor?.quote?.exact ? anchorLib.quoteText(anchor) : '';
}

/**
 * What the attachments of a thread / draft with this anchor show ('region' crop, 'snip' picture, other 'image').
 * @param {Anchor | null | undefined} anchor
 * @returns {'region' | 'snip' | 'image'}
 */
export function attachmentKind(anchor) {
  return anchorLib.attachmentKindOf(anchor);
}

/**
 * Source extent of the section a heading element opens (as a section capture of it would anchor).
 * @param {RenderResult} render
 * @param {string} source
 * @param {number} headingSrid
 * @returns {{ start: number, end: number }}
 */
export function sectionExtent(render, source, headingSrid) {
  return anchorLib.sectionRange(render, source, headingSrid);
}

/**
 * The anchor environment of a doc.
 * @param {{ format: string, path: string }} doc
 * @param {any} config
 * @returns {AnchorEnv}
 */
export function envOf(doc, config) {
  return { format: doc.format === 'html' ? 'html' : doc.format === 'text' ? 'text' : 'markdown', docPath: doc.path, config };
}
