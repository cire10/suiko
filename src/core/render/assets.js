// @ts-check
// Asset and external-resource reference collection for rendered documents (design 6.3 step 5).
//
// References come from img[src|srcset], source[src|srcset], video[src|poster], audio[src], track[src],
// link[href], script[src], object[data], embed[src], iframe[src], CSS url()/@import in style attributes and
// <style> blocks. Local references (relative or root-absolute) that resolve inside the workspace become
// workspace-relative POSIX paths (`assets`); absolute http(s) and protocol-relative URLs become `externals`.
// data:, blob:, javascript:, mailto:, fragment-only and other-scheme references are ignored, as are paths that
// escape the workspace. Both lists keep first-seen (document) order without duplicates.
// Linked local CSS is not read here (renderSource is pure); use cssRefs() on its text to expand one level.

import path from 'node:path';

/** Which attribute of which element carries a resource URL. */
export const URL_ATTRS = Object.freeze({
  img: ['src'], source: ['src'], video: ['src', 'poster'], audio: ['src'], track: ['src'], link: ['href'],
  script: ['src'], object: ['data'], embed: ['src'], iframe: ['src'], input: ['src'], image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
});
/** Elements whose srcset attribute lists candidate URLs. */
export const SRCSET_TAGS = Object.freeze(['img', 'source']);

const IGNORED_SCHEMES = /^(?:data|blob|javascript|vbscript|mailto|tel|about|cid|sms):/i;
const HTTP_RE = /^https?:\/\//i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Parse a srcset attribute into its candidate URLs.
 * @param {string} value
 * @returns {string[]}
 */
export function parseSrcset(value) {
  /** @type {string[]} */
  const out = [];
  let i = 0;
  const s = String(value || '');
  while (i < s.length) {
    while (i < s.length && (/\s/.test(s[i]) || s[i] === ',')) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    // a URL may end with ',' when no descriptor follows
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    if (url) out.push(url);
    i = j;
    // skip the descriptor up to the next comma
    while (i < s.length && s[i] !== ',') i++;
  }
  return out;
}

/**
 * URLs referenced from CSS text: url(...) values and @import strings.
 * @param {string} css
 * @returns {string[]}
 */
export function cssUrls(css) {
  /** @type {string[]} */
  const out = [];
  const text = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
  for (let m = urlRe.exec(text); m; m = urlRe.exec(text)) {
    const u = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (u) out.push(u);
  }
  const importRe = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = importRe.exec(text); m; m = importRe.exec(text)) {
    const u = (m[1] ?? m[2] ?? '').trim();
    if (u) out.push(u);
  }
  return out;
}

/**
 * Resolve one reference.
 * @param {string} ref
 * @param {{ docPath?: string, baseHref?: string|null }} [ctx]
 * @returns {{ kind: 'asset', path: string } | { kind: 'external', url: string } | null}
 */
export function classifyRef(ref, ctx = {}) {
  let r = String(ref ?? '').trim();
  if (!r || r.startsWith('#') || IGNORED_SCHEMES.test(r)) return null;
  const base = ctx.baseHref ? String(ctx.baseHref).trim() : '';
  if (r.startsWith('//')) return { kind: 'external', url: `http:${r}` };
  if (HTTP_RE.test(r)) return { kind: 'external', url: r };
  if (SCHEME_RE.test(r)) return null;
  if (base && (HTTP_RE.test(base) || base.startsWith('//'))) {
    try {
      return { kind: 'external', url: new URL(r, base.startsWith('//') ? `http:${base}` : base).href };
    } catch {
      return null;
    }
  }
  r = r.replace(/[?#].*$/s, '');
  if (!r) return null;
  try {
    r = decodeURIComponent(r);
  } catch {
    /* keep the raw path */
  }
  const docDir = ctx.docPath ? path.posix.dirname(ctx.docPath.replace(/\\/g, '/')) : '.';
  let dir = docDir;
  if (base && !SCHEME_RE.test(base)) {
    const b = base.replace(/[?#].*$/s, '');
    const baseDir = b.endsWith('/') ? b : path.posix.dirname(b);
    dir = b.startsWith('/') ? baseDir.slice(1) || '.' : path.posix.join(docDir, baseDir);
  }
  const joined = r.startsWith('/') ? r.slice(1) : path.posix.join(dir, r);
  const norm = path.posix.normalize(joined);
  if (!norm || norm === '.' || norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm)) return null;
  return { kind: 'asset', path: norm.replace(/\/+$/, '') };
}

/** Collects assets and externals in first-seen order. */
export class RefCollector {
  /** @param {string|undefined} docPath */
  constructor(docPath) {
    this.docPath = docPath;
    /** @type {string|null} */
    this.baseHref = null;
    /** @type {Set<string>} */
    this.assetSet = new Set();
    /** @type {Set<string>} */
    this.externalSet = new Set();
  }

  /** @param {string|null|undefined} ref */
  add(ref) {
    if (ref == null) return;
    const r = classifyRef(String(ref), { docPath: this.docPath, baseHref: this.baseHref });
    if (!r) return;
    if (r.kind === 'asset') this.assetSet.add(r.path);
    else this.externalSet.add(r.url);
  }

  /** @param {string|null|undefined} value */
  addSrcset(value) {
    if (value) for (const u of parseSrcset(value)) this.add(u);
  }

  /** @param {string|null|undefined} css */
  addCss(css) {
    if (css) for (const u of cssUrls(css)) this.add(u);
  }

  /**
   * Collect the references of one element.
   * @param {string} tag lower-case tag name
   * @param {(name: string) => string|undefined|null} get attribute getter
   */
  addElement(tag, get) {
    const attrs = /** @type {Record<string, readonly string[]>} */ (URL_ATTRS)[tag];
    if (attrs) {
      if (tag === 'link') {
        // only resources the page loads (stylesheets, icons, preloads, modules), not navigational links
        const rel = String(get('rel') || '').toLowerCase();
        if (/\b(?:stylesheet|icon|preload|modulepreload|prefetch|manifest|apple-touch-icon)\b/.test(rel)) this.add(get('href'));
      } else {
        for (const a of attrs) this.add(get(a));
      }
    }
    if (SRCSET_TAGS.includes(tag)) this.addSrcset(get('srcset'));
    const style = get('style');
    if (style) this.addCss(style);
  }

  get assets() {
    return [...this.assetSet];
  }

  get externals() {
    return [...this.externalSet];
  }
}

/**
 * Workspace-relative references inside a linked local stylesheet (one level), resolved against the CSS file.
 * @param {string} cssText
 * @param {string} cssPath workspace-relative path of the stylesheet
 * @returns {{ assets: string[], externals: string[] }}
 */
export function cssRefs(cssText, cssPath) {
  const c = new RefCollector(cssPath);
  c.addCss(cssText);
  return { assets: c.assets, externals: c.externals };
}
