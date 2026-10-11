// @ts-check
// The code review's main pane (doc kind 'code', code-contracts.md 12): one card per file in file-tree order.
//   Files mode    the review diff of each file at the viewed round (D/files?v=N, D/files/diff?path&v)
//   Changes mode  the interdiff of each file between the base round and the viewed round (D/files?from&to,
//                 D/files/diff?path&from&to), with thread chips on the hunks; follows s.activeHunk (n / p, "View in
//                 Changes")
//   History mode  hidden (HistoryView overlays the centre)
// Cards load their diff lazily when they come near the viewport (the first ones at once), cap long diffs at
// ROW_CAP rows behind "Show all", and reveal the unchanged lines between hunks from the new-side source.
// Line numbers select lines (click; shift-click extends on the same file and side); c / s / q and the selection bar
// open the composer with {kind:'line', file, side, startLine, endLine} (registerKindSelection). "Comment on file"
// captures {kind:'file', file}. Clicking a thread anywhere scrolls to it (registerKindFocus).
// Keys while the view is shown (single-key shortcuts on, not typing, no dialog): j / k next / previous file, n / p
// next / previous hunk in Files mode (Changes mode keeps the app's n / p over s.changes), s with an old-side
// selection explains that suggestions are new-side only, Esc clears the selection.
// The root carries data-testid="code-view", data-view="code" and data-ready once the file list and the first diffs
// are loaded.

import { html, useEffect, useLayoutEffect, useMemo, useRef } from 'preact-htm';
import { CODE_TESTID } from 'protocol';
import {
  focusItem, openComposer, registerKindFocus, registerKindSelection, setSourceLayout, toast, toggleNav,
} from '../../actions.js';
import { agentName, anchorAt, numericVersion } from '../../model.js';
import { store, useStore } from '../../state.js';
import { isEditable } from '../../util.js';
import { Chip, Icon } from '../common.js';
import {
  ROW_CAP, buildTree, diffGaps, fileStatus, hunkFile, isStub, itemsByFile, matchesFilter, nextSelection,
  selectionCapture, selectionLabel, stubText, treeOrder,
} from './code-model.js';
import {
  codeStore, expandGap, listKeyOf, loadDiff, loadList, loadSource, revealFile, setActivePath, setFilter, setSelection,
  showAllRows, sourceKeyOf, syncCodeDoc, toggleCollapsed, useCode,
} from './code-state.js';
import { DiffTable } from './DiffTable.js';
import { InlineThread } from './InlineThread.js';

/** Diffs loaded at once (the rest when they scroll near the viewport). */
const EAGER = 3;

/** @param {string|undefined|null} text */
const splitLines = (text) => {
  if (!text) return [];
  const out = String(text).split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
};

/**
 * @param {{ ds: any }} props
 */
export function CodeReviewView({ ds }) {
  const s = useStore((st) => ({
    mode: st.mode,
    version: st.version,
    base: st.base,
    activeHunk: st.activeHunk,
    focusedId: st.focusedId,
    layout: st.sourceLayout,
    narrow: st.narrow,
    routeKey: st.route.view === 'doc' ? `${st.route.ws}/${st.route.doc}` : '',
  }));
  const hidden = s.mode !== 'review' && s.mode !== 'changes';
  const changes = s.mode === 'changes';
  const noBase = changes && s.base == null;
  const v = numericVersion(ds, s.version);
  const base = changes && s.base != null ? Number(s.base) : null;
  const listKey = listKeyOf(v, base);
  const layout = s.narrow ? 'unified' : s.layout === 'split' ? 'split' : 'unified';
  const canAct = s.version !== 'live';
  const agent = agentName(ds);

  useLayoutEffect(() => {
    syncCodeDoc();
  }, [s.routeKey]);

  const code = useCode((c) => ({ list: c.lists[listKey], filter: c.filter, sel: c.sel, reveal: c.reveal }));
  useEffect(() => {
    if (!hidden && !noBase) loadList(v, base);
  }, [listKey, hidden, noBase]);

  const files = /** @type {any[]} */ (code.list?.status === 'ok' ? code.list.data?.files || [] : []);
  const ordered = useMemo(() => treeOrder(buildTree(files)), [files]);
  const shown = useMemo(() => ordered.filter((f) => matchesFilter(f, code.filter)), [ordered, code.filter]);
  const placed = useMemo(() => itemsByFile(ds, v), [ds.threads, ds.drafts, v]);
  const eager = useMemo(() => new Set(shown.filter((f) => !isStub(f)).slice(0, EAGER).map((f) => f.path)), [shown]);

  const ready = useCode((c) => {
    const l = c.lists[listKey];
    if (noBase) return true;
    if (!l || l.status === 'loading') return false;
    if (l.status === 'error') return true;
    return [...eager].every((p) => {
      const d = c.diffs[`${listKey}|${p}`];
      return !!d && d.status !== 'loading';
    });
  });

  // ---------------------------------------------------------------------------------------- selection and focus

  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const dsRef = useRef(ds);
  dsRef.current = ds;
  const vRef = useRef(v);
  vRef.current = v;

  useEffect(() => registerKindSelection(() => (hiddenRef.current ? null : selectionCapture(codeStore.get().sel))), []);

  useEffect(() => registerKindFocus((id) => {
    if (!id || hiddenRef.current) return;
    const d = dsRef.current;
    const t = (d.threads || []).find((/** @type {any} */ x) => x.id === id);
    const draft = t ? null : (d.drafts?.items || []).find((/** @type {any} */ x) => x.id === id && x.kind === 'thread');
    const a = t ? anchorAt(t, vRef.current) : draft?.anchor;
    if (!a?.file?.path) return;
    const whole = a.kind === 'doc' || !a.src;
    revealFile(a.file.path, { id, line: whole ? null : { side: a.file.side === 'old' ? 'old' : 'new', line: Number(a.src.endLine || a.src.startLine) } });
  }), []);

  // A selection in another mode or round does not carry over.
  useEffect(() => {
    if (codeStore.get().sel) setSelection(null);
  }, [listKey]);

  // Changes mode follows the active hunk (n / p, the side panel, "View in Changes").
  useEffect(() => {
    if (hidden || !changes || !s.activeHunk) return;
    const path = hunkFile(s.activeHunk);
    if (path) revealFile(path, { hunk: s.activeHunk });
  }, [s.activeHunk, changes, hidden]);

  // A file hidden by the filter is shown again when something asks for it.
  useEffect(() => {
    const r = code.reveal;
    if (r && code.filter && !shown.some((f) => f.path === r.path) && ordered.some((f) => f.path === r.path)) setFilter('');
  }, [code.reveal?.seq]);

  // ---------------------------------------------------------------------------------------- scrolling and keys

  const rootRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const barRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  // The sticky file headers sit under the toolbar, whatever its height (it wraps on narrow windows).
  useEffect(() => {
    const root = rootRef.current;
    const bar = barRef.current;
    if (!root || !bar || hidden || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => root.style.setProperty('--code-bar', `${Math.round(bar.getBoundingClientRect().height)}px`));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [hidden]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || hidden) return undefined;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const cards = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.code-file')]);
        let active = cards[0] || null;
        for (const c of cards) {
          if (scrollOffset(root, c) <= NEAR) active = c;
          else break;
        }
        // at the bottom the last cards cannot reach the top: keep a file the tree or a key just picked if it shows
        const current = codeStore.get().activePath;
        if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2 && current && current !== active?.dataset.path) {
          const el = cards.find((c) => c.dataset.path === current);
          if (el && el.getBoundingClientRect().top < root.getBoundingClientRect().bottom) return;
        }
        setActivePath(active?.dataset.path || null);
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hidden]);

  useEffect(() => {
    if (hidden) return undefined;
    /** @param {KeyboardEvent} ev */
    const onKey = (ev) => {
      const st = store.get();
      if (ev.defaultPrevented || ev.isComposing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (st.dialog || isEditable(ev.target) || st.route.view !== 'doc') return;
      const root = rootRef.current;
      if (!root) return;
      if (ev.key === 'Escape') {
        if (codeStore.get().sel && !st.composer && !st.reply && st.tool === 'select' && !(st.narrow && (st.drawer || st.nav))) {
          setSelection(null);
          ev.preventDefault();
        }
        return;
      }
      if (!st.prefs.singleKeys) return;
      if (ev.repeat && !['j', 'k', 'n', 'p'].includes(ev.key)) return;
      if (ev.key === 'j' || ev.key === 'k') {
        ev.preventDefault();
        const el = stepTarget(root, '.code-file', ev.key === 'j' ? 1 : -1);
        if (el) {
          el.scrollIntoView({ block: 'start' });
          setActivePath(el.dataset.path || null);
        }
        return;
      }
      if ((ev.key === 'n' || ev.key === 'p') && st.mode === 'review') {
        ev.preventDefault();
        const el = stepTarget(root, '.cd-hunk-row, .code-file:not(.is-loaded)', ev.key === 'n' ? 1 : -1);
        if (el) el.scrollIntoView({ block: 'start' });
        return;
      }
      if (ev.key === 's') {
        const sel = codeStore.get().sel;
        if (sel && sel.side === 'old') {
          ev.preventDefault();
          toast('Suggestions replace lines of the new side. Select lines on the right-hand (new) side to suggest a change.', { tone: 'warn' });
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hidden]);

  // ---------------------------------------------------------------------------------------- render

  const list = code.list;
  const data = list?.data;
  const totals = files.reduce((acc, f) => ({ added: acc.added + (Number(f.added) || 0), removed: acc.removed + (Number(f.removed) || 0) }), { added: 0, removed: 0 });
  const sel = code.sel;

  return html`<div ref=${rootRef} class="code-view" data-testid=${CODE_TESTID.view} data-view="code" data-mode=${changes ? 'changes' : 'files'}
    data-ready=${!hidden && ready ? 'true' : undefined} hidden=${hidden} aria-label="Code review">
    <div ref=${barRef} class="source-toolbar code-toolbar">
      ${s.narrow ? html`<button type="button" class="btn btn-sm" onClick=${toggleNav} aria-label="Show the file tree"><${Icon} name="menu" /> Files</button>` : null}
      <span class="code-summary small">
        ${noBase ? html`<strong>v${v}</strong> <span class="muted">is the first round</span>`
          : list?.status === 'ok' ? html`
            ${changes ? html`<strong>v${base} → v${v}</strong> ` : null}
            <strong>${files.length} file${files.length === 1 ? '' : 's'}</strong> ${changes ? 'changed between rounds' : 'changed'}
            <span class="ins-text">+${totals.added}</span> <span class="del-text">−${totals.removed}</span>
            ${code.filter ? html`<span class="muted">· showing ${shown.length}</span>
              <button type="button" class="link-btn" onClick=${() => setFilter('')}>Clear filter</button>` : null}`
          : list?.status === 'error' ? html`<span class="muted">Files not loaded</span>` : html`<span class="muted">Loading files…</span>`}
      </span>
      <span class="code-selbar sel-bar" aria-live="polite">
        ${sel ? html`<span class="mono small">${selectionLabel(sel)}</span>
          <button type="button" class="btn btn-sm btn-primary" disabled=${!canAct} onClick=${() => openComposer({ capture: selectionCapture(sel), action: 'comment' })}>Comment</button>
          <button type="button" class="btn btn-sm" disabled=${!canAct || sel.side === 'old'}
            title=${sel.side === 'old' ? 'Suggestions replace lines of the new side' : 'Suggest replacement lines (s)'}
            onClick=${() => openComposer({ capture: selectionCapture(sel), action: 'suggest' })}>Suggest</button>
          <button type="button" class="btn btn-sm" onClick=${() => setSelection(null)}>Clear</button>`
          : !noBase ? html`<span class="small muted">Click a line number to select it, shift-click to extend, then press C.</span>` : null}
      </span>
      <span class="seg" role="group" aria-label="Diff layout">
        <button type="button" class=${layout === 'unified' ? 'active' : ''} aria-pressed=${layout === 'unified' ? 'true' : 'false'}
          onClick=${() => setSourceLayout('unified')}>Unified</button>
        <button type="button" class=${layout === 'split' ? 'active' : ''} aria-pressed=${layout === 'split' ? 'true' : 'false'}
          disabled=${s.narrow} title=${s.narrow ? 'Split needs a wider window' : undefined}
          onClick=${() => setSourceLayout('split')}>Split</button>
      </span>
    </div>
    ${noBase ? html`<div class="empty code-empty"><p><strong>This is the first round.</strong></p>
      <p>After the agent records a new round, the changes between rounds show here, file by file.</p></div>` : null}
    ${list?.status === 'error' ? html`<div class="empty code-empty" role="alert">
      <p><strong>Cannot load the files of this review.</strong></p><p class="small">${list.error}</p>
      <button type="button" class="btn btn-sm" onClick=${() => loadList(v, base, { retry: true })}>Retry</button></div>` : null}
    ${list?.status === 'ok' && !files.length ? html`<div class="empty code-empty"><p>${changes ? `No files changed between v${base} and v${v}.` : 'No changed files in this round.'}</p></div>` : null}
    ${list?.status === 'ok' && files.length && !shown.length ? html`<div class="empty code-empty"><p>No file matches the filter.</p></div>` : null}
    <div class="code-files">
      ${!noBase ? shown.map((f) => html`<${FileCard} key=${`${listKey}|${f.path}`} file=${f} v=${v} base=${base} listKey=${listKey}
        eager=${eager.has(f.path)} layout=${layout} items=${placed.get(f.path) || []} ds=${ds} agent=${agent}
        focusedId=${s.focusedId} activeHunk=${changes ? s.activeHunk : null} canAct=${canAct} hidden=${hidden} />`) : null}
    </div>
    ${!changes && (data?.skipped || []).length ? html`<div class="code-skipped small muted">
      <strong>Not in the review:</strong>
      ${data.skipped.map((/** @type {any} */ k, /** @type {number} */ i) => html`${i ? ', ' : ' '}<span class="mono">${k.path}</span> (${k.reason})`)}
    </div>` : null}
  </div>`;
}

/** Pixels within which an element counts as scrolled to (the first card sits a few pixels low at the very top). */
const NEAR = 8;

/**
 * How far below its scroll position an element is: its top, less the view's top and the element's
 * scroll-margin-top (which keeps it clear of the sticky toolbar and file header). 0 when scrolled to it.
 * @param {HTMLElement} root @param {HTMLElement} el
 */
function scrollOffset(root, el) {
  return el.getBoundingClientRect().top - root.getBoundingClientRect().top - (parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
}

/**
 * The next (or previous) element matching `selector` below (or above) where scrolling to it would put it (the top
 * of the view plus the element's scroll-margin-top, which keeps it clear of the sticky toolbar and file header).
 * @param {HTMLElement} root @param {string} selector @param {1|-1} dir
 * @returns {HTMLElement|null}
 */
function stepTarget(root, selector, dir) {
  const els = /** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)]).filter((el) => el.offsetParent !== null);
  /** @param {HTMLElement} el */
  const offset = (el) => scrollOffset(root, el);
  if (dir > 0) return els.find((el) => offset(el) > NEAR) || null;
  let prev = null;
  for (const el of els) {
    if (offset(el) < -NEAR) prev = el;
    else break;
  }
  return prev;
}

/**
 * One file: header, then its diff (or a placeholder for binary / too-large files).
 * @param {{ file: any, v: number, base: number|null, listKey: string, eager: boolean, layout: 'unified'|'split',
 *   items: import('./code-model.js').PlacedItem[], ds: any, agent: string, focusedId: string|null,
 *   activeHunk: string|null, canAct: boolean, hidden: boolean }} props
 */
function FileCard(props) {
  const { file, v, base, listKey, layout, ds, agent, canAct } = props;
  const path = String(file.path);
  const changes = base != null;
  const diffKey = `${listKey}|${path}`;
  const status = changes ? fileStatus(file.change) : fileStatus(file.status);
  const listStub = !changes && isStub(file);
  const gapStatus = changes ? (file.change === 'added' ? 'A' : file.change === 'dropped' ? 'D' : 'M') : file.status;
  const hasNew = gapStatus !== 'D';
  const srcKey = sourceKeyOf(v, 'new', path);
  const c = useCode((st) => ({
    entry: st.diffs[diffKey],
    sel: st.sel && st.sel.file === path ? st.sel : null,
    collapsed: !!st.collapsed[path],
    showAll: !!st.showAll[diffKey],
    expanded: Object.keys(st.expanded).filter((k) => k.startsWith(`${diffKey}|`)).map((k) => k.slice(diffKey.length + 1)).join(' '),
    source: st.sources[srcKey],
    reveal: st.reveal && st.reveal.path === path ? st.reveal : null,
    active: st.activePath === path,
  }));
  const rootRef = useRef(/** @type {HTMLElement|null} */ (null));
  const handled = useRef(0);
  const entry = c.entry;
  const stub = listStub ? (file.binary ? 'binary' : 'too-large') : entry?.status === 'ok' ? entry.data?.stub || null : null;
  const hunks = /** @type {any[]} */ (entry?.status === 'ok' && !stub ? entry.data?.hunks || [] : []);
  const gaps = useMemo(() => (entry?.status === 'ok' && !stub ? diffGaps(hunks, { status: gapStatus }) : []), [entry, stub, gapStatus]);
  /** @type {Record<string, boolean>} */
  const expanded = useMemo(() => Object.fromEntries(c.expanded.split(' ').filter(Boolean).map((k) => [k, true])), [c.expanded]);
  const gapLines = useMemo(() => (c.source?.status === 'ok' ? splitLines(c.source.data?.text) : null), [c.source]);

  const load = () => {
    if (!listStub) loadDiff(v, base, path);
  };

  // Lazy: load when the card comes near the viewport (the first cards at once).
  useEffect(() => {
    if (listStub || entry || props.hidden) return undefined;
    if (props.eager) {
      load();
      return undefined;
    }
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      load();
      return undefined;
    }
    const io = new IntersectionObserver((records) => {
      if (records.some((r) => r.isIntersecting)) {
        io.disconnect();
        load();
      }
    }, { root: el.closest('.code-view'), rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [diffKey, !!entry, props.eager, props.hidden]);

  /** @param {import('./code-model.js').Gap} gap */
  const onExpand = (gap) => {
    expandGap(`${diffKey}|${gap.id}`);
    if (hasNew) loadSource(v, 'new', path);
  };

  /** The gap holding a line of a side, if it is not shown. @param {{ side: string, line: number }} at */
  const gapOf = (at) => gaps.find((g) => {
    const n = at.side === 'old' ? at.line - g.delta : at.line;
    return n >= g.newStart && (g.newEnd == null || n <= g.newEnd);
  }) || null;

  // Reveal requests (a thread clicked, a hunk from n / p or the side panel, a file from the tree).
  useEffect(() => {
    const r = c.reveal;
    if (!r || handled.current === r.seq) return;
    if (c.collapsed) {
      toggleCollapsed(path);
      return;
    }
    if (!entry && !listStub) {
      load();
      return;
    }
    if (entry?.status === 'loading') return;
    if (r.line && entry?.status === 'ok' && !stub) {
      const gap = gapOf(r.line);
      if (gap && !expanded[gap.id]) {
        onExpand(gap);
        return;
      }
      if (gap && !gapLines && c.source?.status !== 'error') return;
    }
    handled.current = r.seq;
    const root = rootRef.current;
    if (!root) return;
    requestAnimationFrame(() => {
      const target = (r.id && root.querySelector(`[data-inline-id="${CSS.escape(r.id)}"]`))
        || (r.hunk && root.querySelector(`[data-hunk-ids~="${CSS.escape(r.hunk)}"]`))
        || root;
      target.scrollIntoView({ block: target === root ? 'start' : 'center' });
    });
  }, [c.reveal?.seq, entry?.status, c.source?.status, c.collapsed, c.expanded]);

  /** @param {'new'|'old'} side @param {number} line @param {boolean} shift */
  const onLine = (side, line, shift) => setSelection(nextSelection(codeStore.get().sel, { file: path, side, line, shift }));

  const whole = props.items.filter((it) => it.whole);
  const lineItems = props.items.filter((it) => !it.whole && (!changes || it.side === 'new'));
  const outside = entry?.status === 'ok' && !stub ? lineItems.filter((it) => !isShown(it, hunks, gaps, expanded, gapLines)) : [];
  const commentOnFile = canAct && !(changes && file.change === 'dropped')
    ? () => openComposer({ capture: { kind: 'file', file: path }, action: 'comment' }) : null;
  const threadCount = props.items.filter((it) => it.kind === 'thread' && it.item.status !== 'resolved').length;
  /** @param {import('./code-model.js').PlacedItem[]} list */
  const renderItems = (list) => list.map((it) => html`<${InlineThread} key=${it.id} it=${it} ds=${ds} agent=${agent}
    focused=${props.focusedId === it.id} canAct=${canAct} />`);

  return html`<section ref=${rootRef} class=${`code-file${entry?.status === 'ok' || listStub ? ' is-loaded' : ''}${c.active ? ' is-active' : ''}`}
    data-testid=${CODE_TESTID.fileDiff} data-path=${path} aria-label=${`${status.label}: ${path}`}>
    <header class="code-file-head">
      <button type="button" class="cd-collapse" aria-expanded=${c.collapsed ? 'false' : 'true'} aria-label=${`${c.collapsed ? 'Expand' : 'Collapse'} ${path}`}
        onClick=${() => toggleCollapsed(path)}><${Icon} name="chevron" size=${14} /></button>
      <span class=${`cd-status tone-${status.tone}`} title=${status.label} aria-label=${status.label}>${status.letter}</span>
      <span class="cd-path mono" title=${file.oldPath ? `${file.oldPath} → ${path}` : path}>
        ${file.oldPath ? html`<span class="muted">${file.oldPath} → </span>` : null}${path}
      </span>
      ${file.binary ? html`<${Chip} tone="muted">binary<//>` : file.tooLarge ? html`<${Chip} tone="muted">too large<//>` : null}
      <span class="cd-counts small"><span class="ins-text">+${file.added ?? 0}</span> <span class="del-text">−${file.removed ?? 0}</span></span>
      ${threadCount ? html`<${Chip} tone="accent" title=${`${threadCount} unresolved thread${threadCount === 1 ? '' : 's'}`}>${threadCount} thread${threadCount === 1 ? '' : 's'}<//>` : null}
      <span class="cd-head-spacer"></span>
      ${commentOnFile ? html`<button type="button" class="btn btn-sm cd-file-comment" onClick=${commentOnFile}
        title="Comment on the whole file"><${Icon} name="comment" size=${14} /> Comment on file</button>` : null}
    </header>
    ${c.collapsed ? null : html`
      ${whole.length ? html`<div class="cd-file-items" aria-label="Comments on the whole file">${renderItems(whole)}</div>` : null}
      ${outside.length ? html`<div class="cd-file-items cd-outside">
        <p class="small muted">Comments on lines that are not shown:</p>
        ${renderItems(outside)}
      </div>` : null}
      ${stub ? html`<div class="cd-stub" data-testid=${CODE_TESTID.stub}>
        <span>${stubText(file, stub)}${commentOnFile ? ' Use "Comment on file" to comment on it.' : ''}</span>
      </div>` : !entry || entry.status === 'loading' ? html`<div class="cd-loading small muted">Loading diff…</div>`
        : entry.status === 'error' ? html`<div class="cd-error small" role="alert">Cannot load the diff: ${entry.error}
            <button type="button" class="link-btn" onClick=${() => loadDiff(v, base, path, { retry: true })}>Retry</button></div>`
          : !hunks.length && !gaps.length ? html`<div class="cd-loading small muted">${file.status === 'T' ? 'Only the file type changed.' : 'No line changes.'}</div>`
            : html`<${DiffTable} path=${path} hunks=${hunks} gaps=${gaps} gapLines=${gapLines}
              gapLoading=${c.source?.status === 'loading'} expanded=${expanded} onExpand=${onExpand} layout=${layout}
              selectable=${changes ? { old: false, new: hasNew && canAct } : { old: gapStatus !== 'A' && canAct, new: hasNew && canAct }}
              sel=${c.sel} onLine=${onLine} items=${lineItems} renderItems=${renderItems}
              hunkChips=${changes ? (/** @type {any} */ h) => hunkChips(h) : undefined} activeHunk=${props.activeHunk}
              rowCap=${c.showAll ? null : ROW_CAP} onShowAll=${() => showAllRows(diffKey)} />`}`}
  </section>`;
}

/** Thread chips on an interdiff hunk header. @param {any} h */
function hunkChips(h) {
  const ids = /** @type {string[]} */ (h.threads || []);
  if (!ids.length) return null;
  return html`<span class="cd-hunk-chips">${ids.map((t) => html`<button type="button" class="chip tone-accent chip-btn" key=${t}
    onClick=${() => { store.set({ sidePane: 'threads' }); focusItem(t); }}>${t}</button>`)}</span>`;
}

/**
 * Whether the line an item ends on is shown (in a hunk, or in a revealed gap).
 * @param {import('./code-model.js').PlacedItem} it @param {any[]} hunks @param {import('./code-model.js').Gap[]} gaps
 * @param {Record<string, boolean>} expanded @param {string[]|null} gapLines
 */
function isShown(it, hunks, gaps, expanded, gapLines) {
  const key = it.side === 'old' ? 'oldNo' : 'newNo';
  const skip = it.side === 'old' ? '+' : '-';
  if (hunks.some((h) => (h.rows || []).some((/** @type {any} */ r) => r.op !== skip && r[key] === it.end))) return true;
  if (!gapLines) return false;
  return gaps.some((g) => {
    if (!expanded[g.id]) return false;
    const n = it.side === 'old' ? Number(it.end) - g.delta : Number(it.end);
    return n >= g.newStart && n <= (g.newEnd ?? gapLines.length) && n <= gapLines.length;
  });
}
