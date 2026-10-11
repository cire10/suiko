// @ts-check
// Table grids over the render's srcmap (design 7.2 "Cell", 7.4 "Cells").
//
// The grid lists the table's rows (`tr` elements whose nearest table is this one, thead rows included, in
// document order) and, per row, its cells (`td`/`th` children). This mirrors the guest's grid over table.rows
// except that rowspan/colspan are not expanded (the srcmap carries no span attributes), so cell indices of
// spanned tables can differ; lookups therefore go by key first:
//   row: rowKey (text of the row's first cell) exact, then fuzzy (similarity >= 0.7), then the row index;
//   col: colHeader (text of the header row's cell; header row = last thead row, else row 0) exact, then fuzzy,
//        then the column index.
// Texts are compared whitespace-collapsed and trimmed.

import { similarity } from '../text/index.js';
import { ancestorsOf, elementTextOf, nodeOf } from './util.js';

const FUZZY_KEY = 0.7;

/**
 * @typedef {import('../render/index.js').RenderResult} RenderResult
 * @typedef {{ srid: number, cells: number[] }} GridRow
 * @typedef {{ tableSrid: number, rows: GridRow[], headerRow: number }} Grid
 */

/** @param {RenderResult} render @param {number} srid */
function isTable(render, srid) {
  const n = nodeOf(render, srid);
  return !!n && (n.k === 'table' || n.t.toLowerCase() === 'table');
}

/**
 * Nearest self-or-ancestor table element.
 * @param {RenderResult} render @param {number|null|undefined} srid
 * @returns {number|null}
 */
export function tableOf(render, srid) {
  if (srid == null) return null;
  for (const x of ancestorsOf(render, srid)) if (isTable(render, x)) return x;
  return null;
}

/** @type {WeakMap<object, Map<number, Grid>>} */
const GRIDS = new WeakMap();

/**
 * Grids of every table of a render, built in one pass and cached per render object.
 * @param {RenderResult} render
 * @returns {Map<number, Grid>}
 */
function gridsOf(render) {
  const hit = GRIDS.get(render);
  if (hit) return hit;
  /** @type {Map<number, Grid>} */
  const grids = new Map();
  /** @type {Map<number, GridRow>} */
  const rowBySrid = new Map();
  for (const srid of render.srcmap.order) {
    const n = render.srcmap.nodes[srid];
    const tag = n.t.toLowerCase();
    if (tag === 'tr') {
      const t = nearestTable(render, srid);
      if (t == null) continue;
      let grid = grids.get(t);
      if (!grid) grids.set(t, (grid = { tableSrid: t, rows: [], headerRow: -1 }));
      const row = { srid, cells: [] };
      grid.rows.push(row);
      rowBySrid.set(srid, row);
      if (nodeOf(render, n.p)?.t.toLowerCase() === 'thead') grid.headerRow = grid.rows.length - 1;
    } else if (tag === 'td' || tag === 'th') {
      rowBySrid.get(n.p)?.cells.push(srid);
    }
  }
  for (const g of grids.values()) if (g.headerRow < 0) g.headerRow = 0;
  GRIDS.set(render, grids);
  return grids;
}

/**
 * The table's rows and cells (cached per render; do not mutate).
 * @param {RenderResult} render @param {number} tableSrid
 * @returns {Grid}
 */
export function tableGrid(render, tableSrid) {
  return gridsOf(render).get(tableSrid) ?? { tableSrid, rows: [], headerRow: 0 };
}

/** @param {RenderResult} render @param {number} srid */
function nearestTable(render, srid) {
  const anc = ancestorsOf(render, srid);
  for (let i = 1; i < anc.length; i++) if (isTable(render, anc[i])) return anc[i];
  return null;
}

/** @param {RenderResult} render @param {number|undefined} srid */
function cellText(render, srid) {
  return srid == null ? '' : elementTextOf(render, srid, 200);
}

/**
 * Cell coordinates and keys of a cell (or row) element.
 * @param {RenderResult} render @param {number} srid td/th (or tr: column 0)
 * @returns {{ tableSrid: number, row: number, col: number, rowKey: string, colHeader: string, text: string } | null}
 */
export function cellInfoOf(render, srid) {
  const tableSrid = tableOf(render, srid);
  if (tableSrid == null) return null;
  const grid = tableGrid(render, tableSrid);
  for (let r = 0; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    const col = row.srid === srid ? 0 : row.cells.indexOf(srid);
    if (col < 0) continue;
    return {
      tableSrid,
      row: r,
      col,
      rowKey: cellText(render, row.cells[0]),
      colHeader: cellText(render, grid.rows[grid.headerRow]?.cells[col]),
      text: cellText(render, row.cells[col]),
    };
  }
  return null;
}

/**
 * Locate a cell by its keys inside a table.
 * @param {RenderResult} render
 * @param {number} tableSrid
 * @param {{ row?: number, col?: number, rowKey?: string, colHeader?: string }} cell
 * @param {{ allowIndex?: boolean | 'empty', fuzzy?: boolean, rowOptional?: boolean, colOptional?: boolean }} [opts]
 *   allowIndex: true (default) falls back to the row / column index; 'empty' only when the stored key is empty;
 *   false never. fuzzy=false: exact keys only. rowOptional / colOptional: that coordinate does not matter (a
 *   column / row anchor): when its key is not found the stored index (clamped) is used.
 * @returns {{ row: number, col: number, rowSrid: number, cellSrid: number|null, rowKey: string, colHeader: string,
 *             text: string, rowBy: 'key'|'fuzzy'|'index', colBy: 'key'|'fuzzy'|'index' } | null}
 */
export function findCell(render, tableSrid, cell, opts = {}) {
  const allowIndex = opts.allowIndex ?? true;
  const fuzzy = opts.fuzzy !== false;
  const grid = tableGrid(render, tableSrid);
  if (!grid.rows.length) return null;
  const norm = (/** @type {any} */ s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const rowKeys = grid.rows.map((r) => cellText(render, r.cells[0]));
  const header = grid.rows[grid.headerRow]?.cells ?? [];
  const headers = header.map((c) => cellText(render, c));
  const rowKey = norm(cell.rowKey);
  const colHeader = norm(cell.colHeader);
  const row = pick(rowKeys, rowKey, cell.row, allowIndex === true || (allowIndex === 'empty' && !rowKey), fuzzy) ??
    (opts.rowOptional ? clampIndex(cell.row, rowKeys.length) : null);
  if (!row) return null;
  const width = Math.max(headers.length, grid.rows[row.index].cells.length);
  const cols = headers.length ? headers : Array.from({ length: width }, () => '');
  const col = pick(cols, colHeader, cell.col, allowIndex === true || (allowIndex === 'empty' && !colHeader), fuzzy) ??
    (opts.colOptional ? clampIndex(cell.col, cols.length) : null);
  if (!col) return null;
  const r = grid.rows[row.index];
  const cellSrid = r.cells[col.index] ?? null;
  return {
    row: row.index,
    col: col.index,
    rowSrid: r.srid,
    cellSrid,
    rowKey: rowKeys[row.index],
    colHeader: headers[col.index] ?? '',
    text: cellText(render, cellSrid ?? undefined),
    rowBy: row.by,
    colBy: col.by,
  };
}

/**
 * @param {string[]} keys @param {string} key @param {number|undefined} index @param {boolean} allowIndex
 * @param {boolean} fuzzy
 * @returns {{ index: number, by: 'key'|'fuzzy'|'index' } | null}
 */
function pick(keys, key, index, allowIndex, fuzzy) {
  const want = Number.isInteger(index) ? /** @type {number} */ (index) : -1;
  if (key) {
    const exact = keys.map((k, i) => (k === key ? i : -1)).filter((i) => i >= 0);
    if (exact.length) return { index: closest(exact, want), by: 'key' };
  }
  if (key && fuzzy) {
    let best = -1;
    let bestSim = -1;
    keys.forEach((k, i) => {
      const s = k ? similarity(k, key) : 0;
      if (s < FUZZY_KEY) return;
      if (s > bestSim || (s === bestSim && Math.abs(i - want) < Math.abs(best - want))) {
        best = i;
        bestSim = s;
      }
    });
    if (best >= 0) return { index: best, by: 'fuzzy' };
  }
  if (allowIndex && want >= 0 && want < keys.length) return { index: want, by: 'index' };
  return null;
}

/**
 * @param {number|undefined} index @param {number} length
 * @returns {{ index: number, by: 'index' } | null}
 */
function clampIndex(index, length) {
  if (length <= 0) return null;
  const i = Number.isInteger(index) ? /** @type {number} */ (index) : 0;
  return { index: Math.max(0, Math.min(length - 1, i)), by: 'index' };
}

/** @param {number[]} list @param {number} want */
function closest(list, want) {
  if (want < 0) return list[0];
  return list.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}
