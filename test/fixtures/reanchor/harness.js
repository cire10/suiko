// Golden re-anchoring corpus runner (WP3a). Each test/fixtures/reanchor/*.json file describes:
//   { name, description, doc?: 'kitchen-sink.md' | 'app-spec.html' (base source from test/fixtures/docs),
//     v1?: string | string[] (inline source when no doc), format: 'markdown' | 'html', docPath,
//     assets?: { path: 'sha256:..' }          manifest assets of v1
//     threads: { tN: { capture, expect? } }    expect = checks on the anchor created on v1
//     steps: [{ edits?: [{ find, replace, all? }] | source?: string | string[], assets?, note?,
//               links?: { tN: { hunks?: ['h1'], newLines?: [a, b], linked?: true } },
//               override?: { tN: { lines?: [a, b], quote? } },
//               expect: { tN: { state? | states?: [..], lines?, text?, textIncludes?, kind?, sridTag?, generated?,
//                               assetChanged?, svgLabel?, cell?: {..}, code?: {..}, mappedBy?, hostTag?,
//                               sectionTail?, covers?, snipContainerTag? (null = none), domKind?, domSridTag? } } }] }
// (covers / snipContainerTag: a snip anchor's snip.covers / snip.container.tag; domKind / domSridTag: the kind and
// the srid's tag of its DomTarget at that version.)
// Captures use the frozen shapes of BUILD_AMENDMENTS 3.3 except that any srid may be written as a selector
// { "$srid": { tag?, text?, id?, kind?, nth? } } resolved against the v1 render (the first element of that tag
// whose collapsed rendered text includes `text`, whose id equals `id`, whose kind equals `kind`).
// Each step re-anchors every thread from the previous version (one version at a time, as the engine does) with
// the thread's original (v1) anchor as `originalAnchor`.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineHunks, offsetMapper } from '../../../src/core/diff/index.js';
import { renderSourceSync } from '../../../src/core/render/index.js';
import { createAnchor, reanchor, toDomTarget } from '../../../src/core/anchor/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, '..', 'docs');

/** Names of the golden fixtures (sorted). */
export function fixtureNames() {
  return readdirSync(HERE).filter((f) => f.endsWith('.json')).sort();
}

/** @param {string} name */
export function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(HERE, name), 'utf8'));
}

/** @param {string | string[]} s */
function joinSource(s) {
  return Array.isArray(s) ? s.join('\n') : s;
}

/**
 * Apply find/replace edits; every `find` must occur (exactly once unless `all`).
 * @param {string} source @param {{ find: string, replace: string, all?: boolean }[]} edits
 */
export function applyEdits(source, edits) {
  let out = source;
  for (const e of edits) {
    const find = joinSource(e.find);
    const replace = joinSource(e.replace);
    const first = out.indexOf(find);
    if (first < 0) throw new Error(`edit: ${JSON.stringify(find.slice(0, 60))} not found`);
    if (e.all) out = out.split(find).join(replace);
    else {
      if (out.indexOf(find, first + 1) >= 0) throw new Error(`edit: ${JSON.stringify(find.slice(0, 60))} is not unique`);
      out = out.slice(0, first) + replace + out.slice(first + find.length);
    }
  }
  return out;
}

/** @param {any} render @param {{ tag?: string, text?: string, id?: string, kind?: string, nth?: number }} sel */
export function selectSrid(render, sel) {
  const norm = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();
  const hits = render.srcmap.order.filter((srid) => {
    const n = render.srcmap.nodes[srid];
    if (sel.tag && n.t.toLowerCase() !== sel.tag.toLowerCase()) return false;
    if (sel.id && n.a?.id !== sel.id) return false;
    if (sel.kind && n.k !== sel.kind) return false;
    if (sel.text != null) {
      const span = render.text.spans[srid];
      const text = span ? norm(render.text.text.slice(span[0], span[1])) : '';
      if (!text.includes(norm(sel.text))) return false;
    }
    return true;
  });
  const srid = hits[sel.nth ?? 0];
  if (srid == null) throw new Error(`selector matched nothing: ${JSON.stringify(sel)}`);
  return srid;
}

/** Replace { $srid: selector } values (deeply) by srids of `render`. @param {any} v @param {any} render */
export function resolveSelectors(v, render) {
  if (Array.isArray(v)) return v.map((x) => resolveSelectors(x, render));
  if (v && typeof v === 'object') {
    if (v.$srid) return selectSrid(render, v.$srid);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveSelectors(x, render)]));
  }
  return v;
}

/**
 * Link of a thread to the hunks of a step: explicit hunk ids, or hunks whose new lines overlap `newLines`
 * (a pure deletion counts at its newStart line), plus `linked`.
 * @param {any} spec @param {any[]} hunks
 */
export function linkFor(spec, hunks) {
  if (!spec) return null;
  const ids = new Set(spec.hunks ?? []);
  if (spec.newLines) {
    const [a, b] = spec.newLines;
    for (const h of hunks) {
      const s = h.newStart;
      const e = h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart;
      if (s <= b && a <= e) ids.add(h.id);
    }
  }
  return { hunkIds: [...ids].sort(), linked: Boolean(spec.linked) || ids.size > 0 };
}

/**
 * Run a fixture: returns { versions: [{ source, render, hunks, anchors: { tN: Anchor } }], created: {tN: Anchor} }.
 * @param {any} fx
 */
export function runFixture(fx) {
  const format = fx.format ?? 'markdown';
  const docPath = fx.docPath ?? (format === 'html' ? 'docs/doc.html' : 'docs/doc.md');
  let source = fx.doc ? readFileSync(path.join(DOCS, fx.doc), 'utf8') : joinSource(fx.v1);
  if (fx.v1Edits) source = applyEdits(source, fx.v1Edits);
  let render = renderSourceSync({ format, source, docPath });
  let assets = fx.assets ?? null;
  /** @type {Record<string, any>} */
  const created = {};
  for (const [id, t] of Object.entries(fx.threads)) {
    created[id] = createAnchor({ version: 1, capture: resolveSelectors(t.capture, render), source, render, format, docPath, assets });
  }
  const versions = [{ v: 1, source, render, hunks: [], anchors: { ...created } }];
  let current = { ...created };
  (fx.steps ?? []).forEach((step, i) => {
    const v = i + 2;
    const next = step.source != null ? joinSource(step.source) : applyEdits(source, step.edits ?? []);
    const nextRender = renderSourceSync({ format, source: next, docPath });
    const hunks = lineHunks(source, next);
    const mapper = offsetMapper(source, next, hunks);
    const nextAssets = step.assets ?? assets;
    /** @type {Record<string, any>} */
    const anchors = {};
    for (const id of Object.keys(current)) {
      anchors[id] = reanchor({
        anchor: current[id],
        originalAnchor: created[id],
        fromSource: source,
        toSource: next,
        hunks,
        mapper,
        toRender: nextRender,
        format,
        link: linkFor(step.links?.[id], hunks),
        override: step.override?.[id] ?? null,
        version: v,
        docPath,
        assets: nextAssets,
      });
    }
    versions.push({ v, source: next, render: nextRender, hunks, anchors });
    source = next;
    render = nextRender;
    assets = nextAssets;
    current = anchors;
  });
  return { created, versions, format, docPath };
}

/**
 * Compare an anchor against an expectation; returns a list of mismatch messages.
 * @param {any} a anchor @param {any} exp @param {any} render render of the anchor's version
 */
export function checkExpect(a, exp, render) {
  /** @type {string[]} */
  const errs = [];
  const eq = (/** @type {string} */ what, /** @type {any} */ got, /** @type {any} */ want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) errs.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  if (exp.state) eq('state', a.state, exp.state);
  if (exp.states && !exp.states.includes(a.state)) errs.push(`state: got ${a.state}, want one of ${exp.states.join('|')}`);
  if (exp.kind) eq('kind', a.kind, exp.kind);
  if (exp.mappedBy) eq('mappedBy', a.mappedBy, exp.mappedBy);
  if (exp.lines) eq('lines', [a.src.startLine, a.src.endLine], exp.lines);
  if (exp.text != null) eq('text', a.src.text, Array.isArray(exp.text) ? exp.text.join('\n') : exp.text);
  if (exp.textIncludes != null && !a.src.text.includes(exp.textIncludes)) {
    errs.push(`text ${JSON.stringify(a.src.text.slice(0, 80))} lacks ${JSON.stringify(exp.textIncludes)}`);
  }
  if (exp.generated != null) eq('generated', a.generated, exp.generated);
  if (exp.assetChanged != null) eq('assetChanged', Boolean(a.assetChanged), exp.assetChanged);
  if (exp.svgLabel != null) eq('svg.label', a.svg?.label, exp.svgLabel);
  if (exp.code) eq('code', { fromLine: a.code?.fromLine, toLine: a.code?.toLine }, exp.code);
  if (exp.cell) for (const [k, v] of Object.entries(exp.cell)) eq(`cell.${k}`, a.cell?.[k], v);
  if (exp.hostTag) eq('host.tag', a.host?.tag, exp.hostTag);
  if (exp.sectionTail != null) eq('section tail', a.section[a.section.length - 1] ?? '', exp.sectionTail);
  if (exp.quote != null) eq('quote.exact', a.quote?.exact ?? null, exp.quote);
  if (exp.sridTag) {
    const n = a.srid != null ? render.srcmap.nodes[a.srid] : null;
    eq('srid tag', n ? n.t.toLowerCase() : null, exp.sridTag);
  }
  if (exp.covers != null) eq('snip.covers', a.snip?.covers ?? null, exp.covers);
  if (exp.snipContainerTag !== undefined) eq('snip.container.tag', a.snip?.container?.tag ?? null, exp.snipContainerTag);
  if (exp.domKind || exp.domSridTag) {
    const dt = toDomTarget(a, render, { id: 'x', num: 1, state: 'open' });
    if (exp.domKind) eq('DomTarget kind', dt.kind, exp.domKind);
    if (exp.domSridTag) {
      const n = dt.srid != null ? render.srcmap.nodes[dt.srid] : null;
      eq('DomTarget srid tag', n ? n.t.toLowerCase() : null, exp.domSridTag);
    }
  }
  return errs;
}
