// @ts-check
// One file's diff as a table (code reviews): unified (old no. | new no. | sign | code) or split (old no. | old code
// | new no. | new code). Hunk headers, expander rows for the unchanged lines between hunks, line numbers that select
// lines (click, shift-click for a range; CODE_TESTID.lineBtn with data-side and data-line), gutter markers keyed
// `${file}:${side}:${line}`, and inline thread cards under the line an item ends on (split: old-side items on the
// left, new-side items on the right). Every diff text is a text node (no innerHTML).
//
// The rows come from the DisplayHunks of D/files/diff; revealed gaps from the new-side source of the file (the
// unchanged lines are the same on both sides; old = new + gap.delta).

import { html } from 'preact-htm';
import { CODE_TESTID } from 'protocol';
import { coveredLines, gapRows, gapSize, itemsByEndLine, markerKey, splitPairs, wordSegments } from './code-model.js';

/**
 * @typedef {import('./code-model.js').Gap} Gap
 * @typedef {import('./code-model.js').PlacedItem} PlacedItem
 * @typedef {import('./code-model.js').LineSel} LineSel
 * @typedef {{ op: ' '|'-'|'+', oldNo: number|null, newNo: number|null, text: string, words?: any[], hunk?: string }} Row
 */

/**
 * @param {{
 *   path: string,
 *   hunks: any[],
 *   gaps: Gap[],
 *   gapLines: string[]|null,
 *   gapLoading: boolean,
 *   expanded: Record<string, boolean>,
 *   onExpand: (gap: Gap) => void,
 *   layout: 'unified'|'split',
 *   selectable: { old: boolean, new: boolean },
 *   sel: LineSel|null,
 *   onLine: (side: 'new'|'old', line: number, shift: boolean) => void,
 *   items: PlacedItem[],
 *   renderItems: (items: PlacedItem[]) => any,
 *   hunkChips?: (h: any) => any,
 *   activeHunk?: string|null,
 *   rowCap: number|null,
 *   onShowAll: () => void,
 * }} props
 */
export function DiffTable(props) {
  const { path, hunks, gaps, layout, selectable, sel } = props;
  const split = layout === 'split';
  const cols = split ? 4 : 4;
  const byEnd = itemsByEndLine(props.items);
  const covered = coveredLines(props.items);
  let budget = props.rowCap ?? Infinity;
  let hidden = 0;
  /** @type {any[]} */
  const body = [];

  /** @param {'new'|'old'} side @param {number|null} n */
  const isSel = (side, n) => !!sel && n != null && sel.side === side && n >= sel.start && n <= sel.end;

  /** @param {'new'|'old'} side @param {number|null} n */
  const numCell = (side, n) => {
    if (n == null) return null;
    const marks = covered.get(`${side}:${n}`);
    const dot = marks?.length ? html`<span class="cd-mark" data-marker=${markerKey(path, side, n)} title=${marks.join(', ')}></span>` : null;
    if (!selectable[side]) return html`${dot}<span class="cd-num">${n}</span>`;
    return html`${dot}<button type="button" class="ln-btn" data-testid=${CODE_TESTID.lineBtn} data-side=${side} data-line=${n}
      aria-pressed=${isSel(side, n) ? 'true' : 'false'} aria-label=${`${side === 'old' ? 'Old' : 'New'} line ${n}`}
      onMouseDown=${(/** @type {MouseEvent} */ e) => { if (e.shiftKey) e.preventDefault(); }}
      onClick=${(/** @type {MouseEvent} */ e) => props.onLine(side, n, e.shiftKey)}>${n}</button>`;
  };

  /** @param {Row|null} r */
  const codeText = (r) => (r ? wordSegments(r.text, r.words).map((s) => (s.kind ? html`<span class=${`cd-w-${s.kind}`}>${s.text}</span>` : s.text)) : null);

  /** @param {Row|null} r */
  const opClass = (r) => (!r ? 'cd-empty' : r.op === '+' ? 'op-ins' : r.op === '-' ? 'op-del' : 'op-eq');

  /** @param {Row|null} r */
  const hasMark = (r) => !!r && ((r.oldNo != null && covered.has(`old:${r.oldNo}`) && r.op !== '+') || (r.newNo != null && covered.has(`new:${r.newNo}`) && r.op !== '-'));

  /** Items ending on a row, per side. @param {Row|null} r @param {'new'|'old'} side */
  const endingOn = (r, side) => {
    if (!r) return [];
    if (side === 'old') return r.op !== '+' && r.oldNo != null ? byEnd.get(`old:${r.oldNo}`) || [] : [];
    return r.op !== '-' && r.newNo != null ? byEnd.get(`new:${r.newNo}`) || [] : [];
  };

  /** @param {Row[]} rows @param {string} keyBase */
  const pushRows = (rows, keyBase) => {
    if (!split) {
      rows.forEach((r, i) => {
        if (budget <= 0) {
          hidden++;
          return;
        }
        budget--;
        const selected = (r.op !== '+' && isSel('old', r.oldNo)) || (r.op !== '-' && isSel('new', r.newNo));
        body.push(html`<tr key=${`${keyBase}:${i}`} class=${`${opClass(r)}${selected ? ' sel' : ''}${hasMark(r) ? ' has-mark' : ''}`}
          data-old=${r.oldNo ?? undefined} data-new=${r.newNo ?? undefined} data-hunk=${r.hunk || undefined}>
          <td class="ln old">${r.op === '+' ? null : numCell('old', r.oldNo)}</td>
          <td class="ln new">${r.op === '-' ? null : numCell('new', r.newNo)}</td>
          <td class="sign" aria-hidden="true">${r.op === '+' ? '+' : r.op === '-' ? '−' : ''}</td>
          <td class="code">${codeText(r)}</td>
        </tr>`);
        const items = [...endingOn(r, 'old'), ...endingOn(r, 'new')];
        if (items.length) {
          body.push(html`<tr key=${`${keyBase}:${i}:items`} class="cd-inline-row"><td colspan=${cols} class="cd-inline">${props.renderItems(items)}</td></tr>`);
        }
      });
      return;
    }
    splitPairs(rows).forEach(({ left, right }, i) => {
      if (budget <= 0) {
        hidden++;
        return;
      }
      budget--;
      const lSel = !!left && isSel('old', left.oldNo);
      const rSel = !!right && isSel('new', right.newNo);
      const lItems = endingOn(left, 'old');
      const rItems = endingOn(right, 'new');
      body.push(html`<tr key=${`${keyBase}:${i}`} class=${`cd-split-row${hasMark(left) || hasMark(right) ? ' has-mark' : ''}`}
        data-old=${left?.oldNo ?? undefined} data-new=${right?.newNo ?? undefined}>
        <td class=${`ln old ${opClass(left)}${lSel ? ' cd-sel' : ''}`}>${left ? numCell('old', left.oldNo) : null}</td>
        <td class=${`code half ${opClass(left)}${lSel ? ' cd-sel' : ''}`}>${codeText(left)}</td>
        <td class=${`ln new ${opClass(right)}${rSel ? ' cd-sel' : ''}`}>${right ? numCell('new', right.newNo) : null}</td>
        <td class=${`code half ${opClass(right)}${rSel ? ' cd-sel' : ''}`}>${codeText(right)}</td>
      </tr>`);
      if (lItems.length || rItems.length) {
        body.push(html`<tr key=${`${keyBase}:${i}:items`} class="cd-inline-row">
          <td colspan="2" class="cd-inline">${lItems.length ? props.renderItems(lItems) : null}</td>
          <td colspan="2" class="cd-inline">${rItems.length ? props.renderItems(rItems) : null}</td>
        </tr>`);
      }
    });
  };

  /** @param {Gap} gap */
  const pushGap = (gap) => {
    const total = props.gapLines ? props.gapLines.length : null;
    const n = gapSize(gap, total);
    if (n === 0) return;
    if (props.expanded[gap.id] && props.gapLines) {
      pushRows(gapRows(gap, props.gapLines), `gap-${gap.id}`);
      return;
    }
    if (budget <= 0) return;
    const busy = props.expanded[gap.id] && props.gapLoading;
    const where = gap.before === 0 ? 'above' : gap.before === hunks.length ? 'below' : 'hidden';
    const label = n == null ? 'Show the rest of the file'
      : where === 'hidden' ? `Show ${n} unchanged line${n === 1 ? '' : 's'}` : `Show ${n} line${n === 1 ? '' : 's'} ${where}`;
    body.push(html`<tr key=${`gap-${gap.id}`} class="cd-gap-row" data-gap=${gap.id}>
      <td colspan=${cols}>
        <button type="button" class="cd-gap-btn" disabled=${busy} onClick=${() => props.onExpand(gap)}
          aria-label=${`${label} (lines ${gap.newStart}${gap.newEnd != null ? `-${gap.newEnd}` : ' to the end'} of ${path})`}>
          <span class="cd-gap-icon" aria-hidden="true">⋯</span>${busy ? 'Loading…' : label}
        </button>
      </td>
    </tr>`);
  };

  for (let i = 0; i <= hunks.length; i++) {
    for (const g of gaps) if (g.before === i) pushGap(g);
    if (i === hunks.length) break;
    const h = hunks[i];
    if (budget <= 0) {
      hidden += split ? splitPairs(h.rows || []).length : (h.rows || []).length;
      continue;
    }
    const active = !!props.activeHunk && (h.id === props.activeHunk || (h.hunkIds || []).includes(props.activeHunk));
    body.push(html`<tr key=${`head-${h.id}`} class=${`cd-hunk-row${active ? ' active' : ''}`} data-hunk-id=${h.id}
      data-hunk-ids=${(h.hunkIds || [h.id]).join(' ')}>
      <td colspan=${cols}><span class="cd-hunk-head"><span class="cd-hunk-range">${h.header}</span>${props.hunkChips ? props.hunkChips(h) : null}</span></td>
    </tr>`);
    pushRows(h.rows || [], h.id);
  }

  return html`<div class="cd-table-wrap">
    <table class=${`code-table diff-table cd-table ${split ? 'split' : 'unified'}`}>
      <colgroup>
        ${split
          ? html`<col class="cd-col-ln" /><col /><col class="cd-col-ln" /><col />`
          : html`<col class="cd-col-ln" /><col class="cd-col-ln" /><col class="cd-col-sign" /><col />`}
      </colgroup>
      <tbody>${body}</tbody>
    </table>
    ${hidden ? html`<div class="cd-capped">
      <span class="small muted">${hidden} more line${hidden === 1 ? '' : 's'} not shown.</span>
      <button type="button" class="btn btn-sm" onClick=${props.onShowAll}>Show all</button>
    </div>` : null}
  </div>`;
}
