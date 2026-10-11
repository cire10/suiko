// @ts-check
// Source mode (design 8.7 / 11.3): the numbered source of the shown version, or a diff table against the base
// (unified or split, word highlights, hunk ids, thread chips). Click a line number (shift-click for a range) and
// press C, or use the bar, to comment on source lines (capture {kind:'source', startLine, endLine}).

import { html, useEffect, useMemo, useRef, useState } from 'preact-htm';
import { docApi } from '../api.js';
import { errorText, focusItem, openComposer, setSourceLayout } from '../actions.js';
import { anchorAt, linesLabel } from '../model.js';
import { store, useStore } from '../state.js';
import { scrollIntoViewSoft } from '../util.js';

/**
 * Splits a line into plain / highlighted segments.
 * @param {string} text
 * @param {Array<[number, number, string]>} words
 */
function segments(text, words) {
  if (!words?.length) return [html`${text}`];
  const out = [];
  let at = 0;
  for (const [s, e, kind] of [...words].sort((a, b) => a[0] - b[0])) {
    if (s > at) out.push(html`${text.slice(at, s)}`);
    out.push(kind === 'del' ? html`<del>${text.slice(Math.max(s, at), e)}</del>` : html`<ins>${text.slice(Math.max(s, at), e)}</ins>`);
    at = Math.max(at, e);
  }
  if (at < text.length) out.push(html`${text.slice(at)}`);
  return out;
}

export function SourceView() {
  const s = useStore((st) => ({
    ds: st.ds,
    version: st.version,
    base: st.base,
    layout: st.sourceLayout,
    showDiff: st.sourceDiff,
    sel: st.sourceSel,
    activeHunk: st.activeHunk,
    changes: st.changes,
    route: st.route,
  }));
  const r = /** @type {any} */ (s.route);
  const diffOn = s.showDiff && s.base != null;
  const key = `${r.ws}/${r.doc}|${s.version}|${diffOn ? s.base : '-'}|${s.ds?.doc?.head}|${s.version === 'live' ? s.ds?.working?.sha256 : ''}`;
  const [data, setData] = useState(/** @type {{ key: string, loading: boolean, error: string|null, source: any, diff: any }} */ ({ key: '', loading: true, error: null, source: null, diff: null }));
  const anchorLine = useRef(/** @type {number|null} */ (null));
  const rootRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  useEffect(() => {
    if (!s.ds || s.version == null) return;
    let alive = true;
    const api = docApi(r.ws, r.doc);
    setData((d) => ({ ...d, key, loading: true, error: null }));
    const jobs = [api.source(s.version)];
    if (diffOn) jobs.push(api.sourceDiff(/** @type {number} */ (s.base), s.version));
    Promise.all(jobs).then(([source, diff]) => {
      if (alive) setData({ key, loading: false, error: null, source, diff: diff || null });
    }).catch((err) => {
      if (alive) setData({ key, loading: false, error: errorText(err), source: null, diff: null });
    });
    return () => {
      alive = false;
    };
  }, [key]);

  useEffect(() => {
    if (!s.activeHunk || !rootRef.current) return;
    scrollIntoViewSoft(rootRef.current.querySelector(`[data-src-hunk="${CSS.escape(s.activeHunk)}"]`), 'start');
  }, [s.activeHunk, data.key]);

  /** startLine -> thread ids anchored there (at the shown version). */
  const markers = useMemo(() => {
    /** @type {Map<number, string[]>} */
    const m = new Map();
    for (const t of s.ds?.threads || []) {
      if (t.status === 'resolved') continue;
      const a = anchorAt(t, s.version);
      const line = a?.src?.startLine;
      if (!Number.isFinite(line)) continue;
      if (!m.has(line)) m.set(line, []);
      m.get(line)?.push(t.id);
    }
    return m;
  }, [s.ds, s.version]);

  /** hunk id -> linked thread ids, from the Changes payload of the same pair. */
  const hunkThreads = useMemo(() => {
    /** @type {Map<string, string[]>} */
    const m = new Map();
    for (const h of s.changes?.hunks || []) m.set(h.id, h.threads || []);
    return m;
  }, [s.changes]);

  if (!s.ds) return null;
  const canComment = s.version !== 'live';

  /** @param {number} line @param {MouseEvent} e */
  const pickLine = (line, e) => {
    if (!canComment) return;
    const cur = store.get().sourceSel;
    if (e.shiftKey && cur && anchorLine.current != null) {
      store.set({ sourceSel: { from: Math.min(anchorLine.current, line), to: Math.max(anchorLine.current, line) } });
    } else if (cur && cur.from === line && cur.to === line) {
      anchorLine.current = null;
      store.set({ sourceSel: null });
    } else {
      anchorLine.current = line;
      store.set({ sourceSel: { from: line, to: line } });
    }
  };
  /** @param {number|null} n */
  const isSel = (n) => n != null && !!s.sel && n >= s.sel.from && n <= s.sel.to;
  /** @param {number|null} n */
  const lineBtn = (n) => (n == null ? html`<td class="ln"></td>` : html`<td class="ln">
    <button type="button" class="ln-btn" aria-pressed=${isSel(n)} aria-label=${`Line ${n}`} disabled=${!canComment}
      onClick=${(/** @type {MouseEvent} */ e) => pickLine(n, e)}>${n}</button></td>`);
  /** @param {number|null} n */
  const marker = (n) => {
    const ids = n == null ? null : markers.get(n);
    return html`<td class="mk">${ids ? ids.map((id) => html`<button type="button" class="chip tone-accent chip-btn" onClick=${() => focusItem(id)}>${id}</button>`) : null}</td>`;
  };

  const comment = () => {
    const sel = store.get().sourceSel;
    if (sel) openComposer({ capture: { kind: 'source', startLine: sel.from, endLine: sel.to } });
  };

  return html`<div class="source-view" ref=${rootRef}>
    <div class="source-toolbar">
      <label class="check small"><input type="checkbox" checked=${s.showDiff} disabled=${s.base == null}
        onChange=${(/** @type {any} */ e) => store.set({ sourceDiff: e.currentTarget.checked })} />
        Diff against ${s.base != null ? `v${s.base}` : 'base'}</label>
      ${diffOn ? html`<span class="seg" role="group" aria-label="Diff layout">
        <button type="button" class=${s.layout === 'unified' ? 'active' : ''} aria-pressed=${s.layout === 'unified'} onClick=${() => setSourceLayout('unified')}>Unified</button>
        <button type="button" class=${s.layout === 'split' ? 'active' : ''} aria-pressed=${s.layout === 'split'} onClick=${() => setSourceLayout('split')}>Split</button>
      </span>` : null}
      <span class="spacer"></span>
      ${s.sel ? html`<span class="sel-bar"><strong>${linesLabel([s.sel.from, s.sel.to])}</strong> selected
        <button type="button" class="btn btn-sm btn-primary" onClick=${comment} title="Comment on these lines (c)">Comment</button>
        <button type="button" class="btn btn-sm" onClick=${() => store.set({ sourceSel: null })}>Clear</button></span>`
        : canComment ? html`<span class="small muted">Click a line number (shift-click for a range), then press C.</span>`
          : html`<span class="small muted">Working copy preview: read-only.</span>`}
    </div>
    ${data.loading && !data.source ? html`<p class="muted pad">Loading source…</p>` : null}
    ${data.error ? html`<p class="error pad" role="alert">${data.error}</p>` : null}
    ${data.source && !(diffOn && data.diff) ? html`<table class="code-table" aria-label="Source">
      <tbody>${(data.source.lines || []).map((/** @type {string} */ text, /** @type {number} */ i) => {
        const n = (Number(data.source.startLine) || 1) + i;
        return html`<tr class=${isSel(n) ? 'sel' : ''} key=${n}>${lineBtn(n)}${marker(n)}<td class="code">${text}</td></tr>`;
      })}</tbody>
    </table>` : null}
    ${diffOn && data.diff ? html`
      ${(data.diff.hunks || []).length === 0 ? html`<p class="muted pad">No differences between v${s.base} and ${s.version === 'live' ? 'the working copy' : `v${s.version}`}.</p>` : null}
      ${(data.diff.hunks || []).map((/** @type {any} */ h) => {
        const ids = h.hunkIds || [h.id];
        const threads = Array.isArray(h.threads) && h.threads.length
          ? h.threads
          : [...new Set(ids.flatMap((/** @type {string} */ id) => hunkThreads.get(id) || []))];
        return html`<section class="diff-hunk" key=${h.id} data-src-hunk=${h.id}>
          ${ids.map((/** @type {string} */ id) => html`<span data-src-hunk=${id} key=${id}></span>`)}
          <div class="hunk-head mono small">${h.header} <span class="muted">${ids.join(' ')}</span>
            ${threads.map((/** @type {string} */ t) => html` <button type="button" class="chip tone-accent chip-btn" onClick=${() => focusItem(t)}>${t}</button>`)}</div>
          ${s.layout === 'split' ? html`<${SplitRows} rows=${h.rows} lineBtn=${lineBtn} isSel=${isSel} />` : html`<table class="code-table diff-table" aria-label=${`Hunk ${h.id}`}>
            <tbody>${h.rows.map((/** @type {any} */ row, /** @type {number} */ i) => html`<tr key=${i}
              class=${`op-${row.op === '+' ? 'ins' : row.op === '-' ? 'del' : 'eq'} ${isSel(row.newNo) ? 'sel' : ''}`}>
              <td class="ln old">${row.oldNo ?? ''}</td>
              ${lineBtn(row.op === '-' ? null : row.newNo)}
              <td class="sign" aria-hidden="true">${row.op === ' ' ? '' : row.op}</td>
              <td class="code">${segments(String(row.text ?? ''), row.words)}</td>
            </tr>`)}</tbody>
          </table>`}
        </section>`;
      })}` : null}
  </div>`;
}

/** Side-by-side rows: '-' rows on the left paired with '+' rows on the right. @param {{ rows: any[], lineBtn: (n: number|null) => any, isSel: (n: number|null) => boolean }} props */
function SplitRows({ rows, lineBtn, isSel }) {
  /** @type {Array<{ l: any, r: any }>} */
  const pairs = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].op === ' ') {
      pairs.push({ l: rows[i], r: rows[i] });
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].op === '-') dels.push(rows[i++]);
    while (i < rows.length && rows[i].op === '+') adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) pairs.push({ l: dels[k] || null, r: adds[k] || null });
  }
  return html`<table class="code-table diff-table split"><tbody>
    ${pairs.map((p, i) => html`<tr key=${i} class=${isSel(p.r?.newNo ?? null) ? 'sel' : ''}>
      <td class="ln old">${p.l?.oldNo ?? ''}</td>
      <td class=${`code half ${p.l && p.l.op === '-' ? 'op-del' : ''}`}>${p.l ? segments(String(p.l.text ?? ''), p.l.op === '-' ? p.l.words : []) : ''}</td>
      ${lineBtn(p.r ? p.r.newNo : null)}
      <td class=${`code half ${p.r && p.r.op === '+' ? 'op-ins' : ''}`}>${p.r ? segments(String(p.r.text ?? ''), p.r.op === '+' ? p.r.words : []) : ''}</td>
    </tr>`)}
  </tbody></table>`;
}
