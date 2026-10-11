// @ts-check
// Local assets of a doc as change-tracked content (design 8.1, BUILD_AMENDMENTS 4.5):
// - versions record `manifest.assets = { 'docs/img/arch.png': 'sha256:<hex>' | 'live' }`;
// - the working copy's assets are hashed on demand (same refs, so they compare with a manifest directly);
// - a changed asset is mapped to the srids of the elements that reference it (src / srcset / poster / data), and
//   to the threads anchored on such an element, which then count as linked to the change.

import fsp from 'node:fs/promises';
import { classifyRef, parseSrcset } from '../render/index.js';
import { sha256 } from '../util/hash.js';
import { realpathWithin } from '../util/paths.js';

/**
 * @typedef {import('../../shared/types.js').Anchor} Anchor
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 */

/**
 * Content refs of the working copy's assets, comparable with a manifest's `assets`: 'sha256:<hex>', 'live' (over
 * maxBytes) or null (missing / outside the workspace).
 * @param {string} root workspace root
 * @param {string[]} rels workspace-relative POSIX paths
 * @param {number} maxBytes
 * @returns {Promise<Record<string, string | null>>}
 */
export async function hashWorkingAssets(root, rels, maxBytes) {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const rel of [...new Set(rels)].sort()) {
    const abs = realpathWithin(root, rel);
    if (!abs) {
      out[rel] = null;
      continue;
    }
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) out[rel] = null;
      else if (st.size > maxBytes) out[rel] = 'live';
      else out[rel] = `sha256:${sha256(await fsp.readFile(abs))}`;
    } catch {
      out[rel] = null;
    }
  }
  return out;
}

/**
 * Paths whose content ref differs between two asset maps (added, removed or changed), sorted. 'live' refs are
 * never reported as changed (their bytes were not recorded).
 * @param {Record<string, string | null> | undefined} from
 * @param {Record<string, string | null> | undefined} to
 * @returns {string[]}
 */
export function changedAssets(from, to) {
  const a = from ?? {};
  const b = to ?? {};
  const out = [];
  for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[p] ?? null;
    const y = b[p] ?? null;
    if (x === y || x === 'live' || y === 'live') continue;
    if (x === null && y === null) continue;
    out.push(p);
  }
  return out;
}

/**
 * Workspace-relative paths an element of the source map references (src, srcset, poster, data).
 * @param {import('../render/index.js').SrcNode} node
 * @param {string} docPath
 * @returns {string[]}
 */
export function nodeAssetPaths(node, docPath) {
  const a = node?.a;
  if (!a) return [];
  const refs = [a.src, a.poster, a.data].filter(Boolean).map(String);
  const srcset = /** @type {any} */ (a).srcset;
  if (srcset) refs.push(...parseSrcset(String(srcset)));
  /** @type {string[]} */
  const out = [];
  for (const ref of refs) {
    const r = classifyRef(ref, { docPath });
    if (r?.kind === 'asset' && !out.includes(r.path)) out.push(r.path);
  }
  return out;
}

/**
 * srids of the elements of `render` that reference `assetPath`.
 * @param {RenderResult} render
 * @param {string} docPath
 * @param {string} assetPath
 * @returns {number[]}
 */
export function sridsReferencing(render, docPath, assetPath) {
  const out = [];
  for (const srid of render?.srcmap?.order ?? []) {
    if (nodeAssetPaths(render.srcmap.nodes[srid], docPath).includes(assetPath)) out.push(srid);
  }
  return out;
}

/**
 * The asset an element anchor points at (its image / video / object), if any.
 * @param {Anchor | null | undefined} anchor
 * @param {string} docPath
 * @returns {string | null}
 */
export function anchorAssetPath(anchor, docPath) {
  const attrs = /** @type {any} */ (anchor?.element)?.attrs;
  if (!attrs) return null;
  for (const ref of [attrs.src, attrs.poster, attrs.data]) {
    if (!ref) continue;
    const r = classifyRef(String(ref), { docPath });
    if (r?.kind === 'asset') return r.path;
  }
  return null;
}

/**
 * Threads anchored on an element whose asset changed: thread id -> changed paths.
 * @param {Array<{ id: string, anchor: Anchor | null }>} threads
 * @param {string[]} changed
 * @param {string} docPath
 * @returns {Record<string, string[]>}
 */
export function assetLinks(threads, changed, docPath) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (!changed.length) return out;
  for (const t of threads) {
    const p = anchorAssetPath(t.anchor, docPath);
    if (p && changed.includes(p)) (out[t.id] ??= []).push(p);
  }
  return out;
}
