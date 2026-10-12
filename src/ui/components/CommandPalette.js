// @ts-check
// Command palette (Cmd/Ctrl+K, the top bar's "⌘K" button): run anything by name, like Notion, Linear or Databricks.
// - Everything comes from the command registry (commands.js): every keyboard action plus palette-only ones (go to a
//   thread / section / version, compare versions, filters, submit with a verdict, copy links, settings...).
// - Search is fuzzy (model.js matchRow): subsequences of the title, ranked with prefix / word-start bonuses, the
//   matched characters highlighted; keywords and descriptions find a row too. Results are grouped by category, best
//   group first; at most MAX_ROWS rows are rendered.
// - With an empty query: "Recent" (the last commands run, localStorage), then every command by category. With a
//   query, threads ("t4", or words of the comment), sections and versions are found directly.
// - Commands that cannot run now are listed dimmed with the reason ("select text in the doc first"), never run.
// - Commands with a sub-list (Go to thread…, Compare versions… in two steps, Open another document…, the close
//   confirmation) open it in place, with a breadcrumb; Backspace in the empty input goes back a level.
// - Keys: ↑ / ↓ (and Ctrl+N / Ctrl+P) move, Enter runs, Esc or Cmd/Ctrl+K closes and gives the focus back (keys.js).
//   The mouse hovers and clicks; the input keeps the focus throughout.

import { html, useLayoutEffect, useMemo, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { closeDialog } from '../actions.js';
import {
  CATEGORIES, describe, paletteCommands, recentCommandIds, rememberCommand, unavailable,
} from '../commands.js';
import { shortcut } from '../keys.js';
import { highlightParts, isSingleKeyCombo, matchRow } from '../model.js';
import { useStore } from '../state.js';
import { Icon, useDialogFocus } from './common.js';

/** @typedef {import('../commands.js').Command} Command */
/** @typedef {import('../commands.js').PaletteItem} PaletteItem */
/** @typedef {import('../state.js').UiState} UiState */

/** Never render more rows than this (a doc with hundreds of threads or headings). */
const MAX_ROWS = 200;
const TOP_PLACEHOLDER = 'Type a command, a thread like t4, or a section…';
/** On the doc list there are no threads or sections to find. */
const HOME_PLACEHOLDER = 'Type a command…';

/**
 * A level of nested lists.
 * @typedef {{ id: string, rootId: string, title: string, placeholder?: string, items: (s: UiState) => PaletteItem[] }} Level
 */

/**
 * A rendered row.
 * @typedef {object} Row
 * @property {string} key unique in the list; also data-command-id
 * @property {string} rootId the top-level command (remembered as recent)
 * @property {string} title
 * @property {number[]} positions matched characters of the title
 * @property {string} description
 * @property {string|null} reason why it cannot run now
 * @property {string[]} keys shortcut combos
 * @property {Level|null} next the sub-list it opens
 * @property {(() => void)|null} run
 * @property {number} score
 */

/** @typedef {{ title: string, rows: Row[], best: number }} Section */

/**
 * @param {Command} c @param {UiState} s @param {string} query
 * @returns {Row|null}
 */
function commandRow(c, s, query) {
  const description = describe(c, s);
  const m = matchRow(query, { title: c.title, description, keywords: c.keywords });
  if (!m) return null;
  return {
    key: c.id,
    rootId: c.id,
    title: c.title,
    positions: m.positions,
    description,
    reason: unavailable(c, s),
    keys: (c.keys || []).filter((k) => s.prefs.singleKeys || !isSingleKeyCombo(k)).slice(0, 2),
    next: c.items ? { id: c.id, rootId: c.id, title: c.title.replace(/…$/, ''), placeholder: c.placeholder, items: c.items } : null,
    run: c.run ? () => /** @type {NonNullable<Command['run']>} */ (c.run)(s) : null,
    score: m.score,
  };
}

/**
 * @param {PaletteItem} it @param {Level} level @param {UiState} s @param {string} query
 * @returns {Row|null}
 */
function itemRow(it, level, s, query) {
  const m = matchRow(query, { title: it.title, description: it.description, keywords: it.keywords, exact: it.exact });
  if (!m) return null;
  const key = `${level.id}:${it.id}`;
  return {
    key,
    rootId: level.rootId,
    title: it.title,
    positions: m.positions,
    description: it.description || '',
    reason: unavailable(it, s),
    keys: [],
    next: it.items ? { id: key, rootId: level.rootId, title: it.title, placeholder: it.placeholder, items: it.items } : null,
    run: it.run || null,
    score: m.score,
  };
}

/**
 * Items of a level, guarded (a failing list shows as empty).
 * @param {Level} level @param {UiState} s @returns {PaletteItem[]}
 */
function levelItems(level, s) {
  try {
    return level.items(s) || [];
  } catch (err) {
    console.warn('suiko: palette list failed', level.id, err);
    return [];
  }
}

/**
 * Sorts sections by their best row and caps the rows.
 * @param {Section[]} sections @param {boolean} ranked
 */
function finish(sections, ranked) {
  let out = sections.filter((x) => x.rows.length);
  if (ranked) {
    for (const sec of out) sec.rows.sort((a, b) => b.score - a.score);
    out.sort((a, b) => b.best - a.best);
  }
  let left = MAX_ROWS;
  out = out.map((sec) => {
    const rows = sec.rows.slice(0, Math.max(0, left));
    left -= rows.length;
    return { ...sec, rows };
  }).filter((x) => x.rows.length);
  return out;
}

/** @param {Map<string, Section>} map @param {string} title @param {Row} row */
function add(map, title, row) {
  let sec = map.get(title);
  if (!sec) {
    sec = { title, rows: [], best: -Infinity };
    map.set(title, sec);
  }
  sec.rows.push(row);
  sec.best = Math.max(sec.best, row.score);
}

/**
 * The sections the palette shows.
 * @param {UiState} s @param {Level|null} level @param {string} query @param {string[]} recent
 * @returns {Section[]}
 */
function buildSections(s, level, query, recent) {
  const q = query.trim();
  /** @type {Map<string, Section>} */
  const map = new Map();
  if (level) {
    for (const it of levelItems(level, s)) {
      const row = itemRow(it, level, s, q);
      if (row) add(map, it.group || '', row);
    }
    return finish([...map.values()], !!q);
  }
  const commands = paletteCommands(s);
  if (!q) {
    const recentRows = recent.map((id) => commands.find((c) => c.id === id)).filter(Boolean)
      .map((c) => commandRow(/** @type {Command} */ (c), s, ''))
      .filter(/** @returns {r is Row} */ (r) => !!r);
    if (recentRows.length) map.set('Recent', { title: 'Recent', rows: recentRows, best: 0 });
    for (const cat of CATEGORIES) {
      for (const c of commands) {
        if (c.category !== cat || recent.includes(c.id)) continue;
        const row = commandRow(c, s, '');
        if (row) add(map, cat, row);
      }
    }
    return finish([...map.values()], false);
  }
  for (const c of commands) {
    const row = commandRow(c, s, q);
    if (row) add(map, c.category, row);
    if (c.inline && c.items && !unavailable(c, s)) {
      const lv = { id: c.id, rootId: c.id, title: c.title, items: c.items };
      for (const it of levelItems(lv, s)) {
        const r = itemRow(it, lv, s, q);
        if (r) add(map, c.inline, r);
      }
    }
  }
  return finish([...map.values()], true);
}

export function CommandPalette() {
  const s = useStore((st) => st);
  const [stack, setStack] = useState(/** @type {Level[]} */ ([]));
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState(/** @type {string|null} */ (null));
  const recent = useMemo(() => recentCommandIds(), []);
  const ref = useRef(/** @type {HTMLDivElement|null} */ (null));
  const inputRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const listRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const trapTab = useDialogFocus(ref, 'input');
  const level = stack.length ? stack[stack.length - 1] : null;
  const sections = buildSections(s, level, query, recent);
  const rows = sections.flatMap((sec) => sec.rows);
  const activeIndex = Math.max(0, rows.findIndex((r) => r.key === activeKey));
  const active = rows[activeIndex] || null;

  useLayoutEffect(() => {
    const el = active && listRef.current?.querySelector(`[data-row-key="${CSS.escape(active.key)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active?.key]);

  /** @param {Level[]} next */
  const go = (next) => {
    setStack(next);
    setQuery('');
    setActiveKey(null);
    inputRef.current?.focus();
  };

  /** @param {Row|null} row */
  const runRow = (row) => {
    if (!row || row.reason) return;
    if (row.next) {
      go([...stack, row.next]);
      return;
    }
    if (!row.run) return;
    rememberCommand(row.rootId);
    // Close first: the command may open another dialog, or move the focus (a composer).
    closeDialog();
    try {
      row.run();
    } catch (err) {
      console.error('suiko: command failed', row.key, err);
    }
  };

  /** @param {number} delta */
  const move = (delta) => {
    if (!rows.length) return;
    const n = rows.length;
    const i = Math.abs(delta) > 1
      ? Math.max(0, Math.min(n - 1, activeIndex + delta))
      : (activeIndex + delta + n) % n;
    setActiveKey(rows[i].key);
  };

  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (e.key === 'ArrowDown' || (ctrlOnly && e.key === 'n')) {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp' || (ctrlOnly && e.key === 'p')) {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      move(e.key === 'PageDown' ? 8 : -8);
    } else if (e.key === 'Enter' && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      runRow(active);
    } else if (e.key === 'Backspace' && !query && stack.length) {
      e.preventDefault();
      go(stack.slice(0, -1));
    } else {
      trapTab(e);
    }
  };

  const listId = 'sr-palette-list';
  const optionId = (/** @type {number} */ i) => `sr-palette-opt-${i}`;
  let index = -1;

  return html`<div class="modal-backdrop palette-backdrop" onMouseDown=${(/** @type {MouseEvent} */ e) => { if (e.target === e.currentTarget) closeDialog(); }}>
    <div ref=${ref} class="palette" role="dialog" aria-modal="true" aria-label="Command palette" data-testid=${TESTID.commandPalette}
      onKeyDown=${onKeyDown}>
      ${stack.length ? html`<nav class="palette-crumbs" aria-label="Command path">
        <button type="button" class="crumb" onMouseDown=${(/** @type {MouseEvent} */ e) => e.preventDefault()} onClick=${() => go([])}>Commands</button>
        ${stack.map((lv, i) => html`<span class="crumb-sep" aria-hidden="true">›</span>${i < stack.length - 1
          ? html`<button type="button" class="crumb" onMouseDown=${(/** @type {MouseEvent} */ e) => e.preventDefault()} onClick=${() => go(stack.slice(0, i + 1))}>${lv.title}</button>`
          : html`<span class="crumb crumb-current" aria-current="page">${lv.title}</span>`}`)}
      </nav>` : null}
      <div class="palette-head">
        <${Icon} name="search" size=${18} />
        <input ref=${inputRef} type="text" class="palette-input" data-testid=${TESTID.commandPaletteInput}
          role="combobox" aria-expanded="true" aria-controls=${listId} aria-autocomplete="list"
          aria-activedescendant=${active ? optionId(activeIndex) : undefined} aria-label=${level ? `${level.title}: search` : 'Search commands'}
          placeholder=${level ? level.placeholder || 'Search…' : s.route.view === 'doc' ? TOP_PLACEHOLDER : HOME_PLACEHOLDER}
          value=${query} spellcheck="false" autocomplete="off"
          onInput=${(/** @type {any} */ e) => { setQuery(e.currentTarget.value); setActiveKey(null); }} />
        <kbd class="palette-esc" aria-hidden="true">esc</kbd>
      </div>
      <div ref=${listRef} class="palette-list" id=${listId} role="listbox" aria-label=${level ? level.title : 'Commands'}>
        ${rows.length === 0 ? html`<p class="palette-empty" role="presentation">${query.trim()
          ? html`Nothing matches “${query.trim()}”.` : 'Nothing here.'}</p>` : null}
        ${sections.map((sec, si) => html`<div role="group" class="palette-section" key=${`${sec.title}-${si}`}
          aria-labelledby=${sec.title ? `sr-palette-sec-${si}` : undefined}>
          ${sec.title ? html`<div class="palette-section-title" id=${`sr-palette-sec-${si}`} role="presentation">${sec.title}</div>` : null}
          ${sec.rows.map((row) => {
            index++;
            const i = index;
            const on = i === activeIndex;
            return html`<div key=${row.key} id=${optionId(i)} role="option" aria-selected=${on ? 'true' : 'false'}
              aria-disabled=${row.reason ? 'true' : undefined} data-testid=${TESTID.commandItem} data-command-id=${row.key}
              data-row-key=${row.key} class=${`palette-item ${on ? 'is-active' : ''} ${row.reason ? 'is-disabled' : ''}`}
              title=${row.reason ? `Not now: ${row.reason}` : undefined}
              onMouseMove=${() => { if (activeKey !== row.key) setActiveKey(row.key); }}
              onMouseDown=${(/** @type {MouseEvent} */ e) => e.preventDefault()}
              onClick=${() => runRow(row)}>
              <span class="pi-main">
                <span class="pi-title">${highlightParts(row.title, row.positions).map((p) => (p.hit ? html`<mark>${p.text}</mark>` : p.text))}</span>
                ${row.reason
                  ? html`<span class="pi-desc pi-reason">${row.reason}</span>`
                  : row.description ? html`<span class="pi-desc">${row.description}</span>` : null}
              </span>
              ${row.keys.length ? html`<span class="pi-keys">${row.keys.map((k) => html`<kbd>${shortcut(k)}</kbd>`)}</span>` : null}
              ${row.next ? html`<span class="pi-more" aria-hidden="true"><${Icon} name="chevron" size=${14} /></span>` : null}
            </div>`;
          })}
        </div>`)}
      </div>
      <footer class="palette-foot small muted" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> ${active?.next ? 'open' : 'run'}</span>
        ${stack.length ? html`<span><kbd>⌫</kbd> back</span>` : null}
        <span><kbd>esc</kbd> close</span>
        <span class="spacer"></span>
        <span>Settings <kbd>${shortcut('mod+,')}</kbd></span>
      </footer>
    </div>
  </div>`;
}
