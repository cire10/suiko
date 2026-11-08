// @ts-check
// Top bar (design 11.1, the "calm review" header): ONE row, 48 px, that never wraps. Left to right:
//   - ≡ (the outline), when the outline is not simply beside the doc: narrow, below 1600 px, or the Outline rail
//     setting (railToggleShown);
//   - the Suiko mark (back to the doc list) and the doc title (it truncates first);
//   - the version (#sr-version), a compact pill: "v3 · latest", "v2", "v3 · final", "Working copy (live)". In Changes /
//     Source the older end of the comparison (#sr-base) and an arrow come first: "[v1 · last review] → [v3 · latest]".
//     Neither shows while Changes is side by side: the two frames' headers hold them then (ComparePane);
//   - the mode switch: Read · Review · Changes (Files · Changes in a code review); the Changes tab counts the changes
//     that are new since the last review. Source and History are in the More menu (keys 3 / 4 and the palette work as
//     before) and show as a fourth tab only while one of them is open, so the switch always says where you are.
//     Below 900 px a select lists every mode (#sr-mode). Each tab's tooltip says what it shows;
//   - right-aligned: the turn pill (TurnPill: whose turn it is), the problems chip (Problems, only when something is
//     wrong), the command palette (⌘K, an icon), the thread panel toggle with the number of open threads, the More
//     menu (⋯: Source, History, Hide marks, Theme, Keyboard shortcuts, Settings, Document info, each with its key) and
//     the one primary button: "Send N" while there are drafts, else "Approve" (accent when nothing is left for either
//     side, approveReady), both opening the send dialog.
// The comment tools live in the tool dock over the doc (ToolDock); Accept all and Inline / Side by side in the Changes
// panel (ChangesView). The modes, tools and menu items follow the doc kind (model.js modesFor / kindCaps: a code review
// has no Source, no doc frame, no marks to hide). Instead of wrapping, items give way by priority (layout.css): the
// title shrinks first, the turn pill shows a short label at 900-1199 px and only its dot below 900 px.
// The primary button is its own component that reads the store itself: DocState refreshes arriving over SSE
// (presence, a delivery, a new version) re-render the top bar but must never re-create or move that button between a
// mousedown and its mouseup, or the browser drops the click. It is the row's last item and the row is right-aligned
// from the spacer on, so labels changing width to its left (the turn pill, a count) never move it.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import {
  cycleTheme, navigate, openDialog, openSubmit, railShown, railToggleShown, setBase, setMode, splitShown, switchVersion,
  toggleHidden, toggleNav, toggleSidebar,
} from '../actions.js';
import { KEYS, shortcut } from '../keys.js';
import {
  approveReady, baseTag, docKindOf, draftCount, kindCaps, modesFor, newChangesCount, openThreadCount, versionNumbers,
} from '../model.js';
import { useStore } from '../state.js';
import { Icon, Logo } from './common.js';
import { MenuItem, MenuSeparator, Popover } from './Menu.js';
import { Problems } from './Problems.js';
import { TurnPill } from './TurnPill.js';

/** The modes that are tabs; the others (Source, History) are reached from the More menu. */
const TAB_MODES = new Set(['read', 'review', 'changes']);

export function TopBar() {
  const s = useStore((st) => ({
    ds: st.ds,
    version: st.version,
    mode: st.mode,
    base: st.base,
    narrow: st.narrow,
    medium: st.medium,
    rail: railShown(st),
    railToggle: railToggleShown(st),
    drawer: st.drawer,
    sidebar: st.sidebar,
    nav: st.nav,
    split: splitShown(st),
    changes: st.changes,
  }));
  const ds = s.ds;
  if (!ds) return null;
  const head = Number(ds.doc.head);
  const finalV = Number(ds.doc.final?.version) || null;
  // the doc kind's modes (model.js modesFor): a code review has no Read or Source mode
  const MODES = modesFor(ds);
  const caps = kindCaps(ds);
  const versions = versionNumbers(ds);
  const open = openThreadCount(ds);
  const showBase = s.mode === 'changes' || s.mode === 'source';
  const numericV = s.version === 'live' ? head + 1 : Number(s.version);
  // the older end of a comparison: any version before the shown one (every recorded version for the working copy)
  const olders = versions.filter((v) => v < numericV || (s.version === 'live' && v <= head)).reverse();
  const railTitle = docKindOf(ds) === 'code' ? 'Files' : 'Outline';
  const fresh = caps.frame ? newChangesCount(ds, s.version, s.changes) : 0;
  const tabs = MODES.filter((m) => TAB_MODES.has(m.key) || m.key === s.mode);

  /** @param {Event} e */
  const onVersion = (e) => {
    const el = /** @type {HTMLSelectElement} */ (e.currentTarget);
    const v = el.value === 'live' ? 'live' : Number(el.value);
    if (!switchVersion(v)) el.value = String(s.version);
  };
  // below 1200 px the pills keep only the version numbers (their tooltips, and the Changes panel, say the rest)
  const compact = s.medium || s.narrow;
  /** @param {number} v */
  const versionLabel = (v) => (compact ? `v${v}` : `v${v}${v === head ? ' · latest' : ''}${finalV === v ? ' · final' : ''}`);
  // the version shown; in Changes / Source the newer end of the comparison range
  const versionSelect = html`<label class="sr-only" for="sr-version">${showBase ? 'Compare to' : 'Version'}</label>
    <select id="sr-version" class="select version-pill" data-testid=${TESTID.versionPicker} value=${String(s.version)} onChange=${onVersion}
      title=${showBase ? 'The newer version: shown with what changed ([ and ] step through the versions)'
        : 'The version shown ([ and ] step through the versions)'}>
      ${versions.slice().reverse().map((v) => html`<option value=${String(v)}>${versionLabel(v)}</option>`)}
      ${caps.liveBanners && ((ds.working?.dirty && !ds.working?.missing) || s.version === 'live')
        ? html`<option value="live">${compact ? 'Working copy' : 'Working copy (live)'}</option>` : null}
    </select>`;

  return html`<header class="topbar">
    ${s.railToggle ? html`<button type="button" class="icon-btn nav-toggle" aria-label=${railTitle} aria-controls="sr-nav"
      aria-expanded=${s.narrow ? s.nav : s.rail} title=${`${railTitle}: show or hide it`} onClick=${toggleNav}><${Icon} name="menu" /></button>` : null}
    <a class="brand" href="/" aria-label="Suiko" title="All documents" onClick=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); navigate('/'); }}>
      <${Logo} size=${24} /></a>
    <h1 class="doc-name" title=${ds.doc.path}>${ds.doc.title || ds.doc.id}</h1>
    ${s.split ? null : showBase ? html`<span class="compare-range" role="group" aria-label="Compare versions">
      <label class="sr-only" for="sr-base">Compare from</label>
      <select id="sr-base" class="select version-pill base-pill" data-testid=${TESTID.compareFrom} value=${s.base == null ? '' : String(s.base)}
        disabled=${!olders.length} title="The older version: what changed since it is shown (d: your last review / the previous version)"
        onChange=${(/** @type {any} */ e) => setBase(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}>
        ${s.base == null ? html`<option value="">${olders.length ? 'none' : 'no earlier version'}</option>` : null}
        ${olders.map((v) => {
          const tag = baseTag(ds, v);
          return html`<option value=${String(v)}>
            v${v}${compact ? '' : tag === 'accepted' ? ' · accepted' : tag === 'review' ? ' · last review' : v === numericV - 1 ? ' · previous' : ''}</option>`;
        })}
      </select>
      <span class="compare-arrow" aria-hidden="true"><${Icon} name="arrowRight" size=${14} /></span>
      ${versionSelect}
    </span>` : html`<span class="version-slot">${versionSelect}</span>`}
    <nav class="mode-tabs" role="tablist" aria-label="Mode">
      ${tabs.map((m) => html`<button type="button" role="tab" data-testid=${TESTID.modeTab} data-mode=${m.key} key=${m.key}
        aria-selected=${s.mode === m.key} class=${`${s.mode === m.key ? 'active' : ''} ${TAB_MODES.has(m.key) ? '' : 'is-extra'}`.trim()}
        title=${`${m.label}: ${m.description} (${m.n})`} onClick=${() => setMode(m.key)}>${m.label}${m.key === 'changes' && fresh
          ? html`<span class="badge tone-accent" aria-hidden="true">${fresh}</span><span class="sr-only"> (${fresh} new)</span>` : null}</button>`)}
    </nav>
    <label class="sr-only" for="sr-mode">Mode</label>
    <select id="sr-mode" class="select mode-select" value=${s.mode}
      onChange=${(/** @type {any} */ e) => setMode(e.currentTarget.value)}>
      ${MODES.map((m) => html`<option value=${m.key}>${m.label}</option>`)}
    </select>
    <span class="spacer"></span>
    <${TurnPill} key="turn" />
    <${Problems} key="problems" />
    <${PaletteButton} key="palette" />
    <button key="threads" type="button" class="icon-btn threads-toggle" aria-controls="sr-side" aria-label=${`Threads (${open})`}
      aria-expanded=${s.narrow ? s.drawer : s.sidebar} onClick=${toggleSidebar} title="Threads: show or hide the panel (\\)">
      <${Icon} name="threads" />${open ? html`<span class="tb-count" aria-hidden="true">${open}</span>` : null}
    </button>
    <${MoreMenu} key="more" />
    <${SubmitButton} key="submit" />
  </header>`;
}

/**
 * ⋯ More: what used to be header buttons and tabs, each with its key (single-letter keys only while they are on).
 * Source and History switch the mode, Hide marks the annotations (Read mode has none), Theme cycles System / Light /
 * Dark and stays open so the next click goes on cycling, then Keyboard shortcuts, Settings and Document info.
 */
function MoreMenu() {
  const s = useStore((st) => ({ ds: st.ds, mode: st.mode, hidden: st.hidden, theme: st.theme, singleKeys: st.prefs.singleKeys }));
  if (!s.ds) return null;
  const caps = kindCaps(s.ds);
  const modes = modesFor(s.ds);
  const keyOf = (/** @type {string} */ k) => (s.singleKeys ? k : undefined);
  const theme = `${s.theme[0].toUpperCase()}${s.theme.slice(1)}`;
  const reading = s.mode === 'read';
  return html`<${Popover} label="More" kind="menu" align="end" triggerClass="icon-btn more-btn"
    triggerProps=${{ 'data-testid': TESTID.moreMenu, 'aria-label': 'More', title: 'More: Source, History, marks, theme, settings' }}
    trigger=${html`<${Icon} name="more" />`}>
    ${modes.filter((m) => !TAB_MODES.has(m.key)).map((m) => html`<${MenuItem} key=${m.key} data-menu-item=${m.key}
      icon=${m.key === 'source' ? 'source' : 'history'} label=${m.label} keys=${keyOf(String(m.n))} hint=${m.description}
      class=${s.mode === m.key ? 'is-current' : ''} aria-current=${s.mode === m.key ? 'true' : undefined} onSelect=${() => setMode(m.key)} />`)}
    <${MenuSeparator} />
    ${caps.hide ? html`<${MenuItem} data-menu-item="hide" icon=${s.hidden ? 'eye' : 'eyeOff'}
      label=${s.hidden ? 'Show marks' : 'Hide marks'} aria-label=${s.hidden ? 'Show annotations' : 'Hide annotations'}
      keys=${keyOf('h')} disabled=${reading}
      hint=${reading ? 'Read mode shows no marks' : 'Threads, changes and locks drawn over the document'} onSelect=${toggleHidden} />` : null}
    <${MenuItem} data-menu-item="theme" data-theme-toggle icon=${s.theme === 'dark' ? 'moon' : s.theme === 'light' ? 'sun' : 'system'}
      label=${`Theme: ${theme}`} aria-label=${`Theme: ${s.theme}. Change theme`} keys=${keyOf('t')} keepOpen
      hint="System, Light, Dark" onSelect=${cycleTheme} />
    <${MenuSeparator} />
    <${MenuItem} data-menu-item="help" data-testid=${TESTID.helpOpen} icon="keyboard" label="Keyboard shortcuts"
      keys=${s.singleKeys ? '?' : shortcut(KEYS.help)} aria-keyshortcuts="Meta+/ Control+/ ?" onSelect=${() => openDialog('help')} />
    <${MenuItem} data-menu-item="settings" data-testid=${TESTID.settingsOpen} icon="gear" label="Settings" keys=${shortcut(KEYS.settings)}
      aria-keyshortcuts="Meta+, Control+," onSelect=${() => openDialog('settings')} />
    <${MenuItem} data-menu-item="info" icon="info" label="Document info" hint="Path, versions, working copy, page errors"
      onSelect=${() => openDialog('info')} />
  <//>`;
}

/**
 * The command palette button. In the doc's top bar a search icon (⌘K in its tooltip); on the doc list (`wide`) a
 * search field look-alike with its key.
 * @param {{ wide?: boolean }} props
 */
export function PaletteButton({ wide = false }) {
  const title = `Command palette: run anything by name (${shortcut(KEYS.palette)})`;
  return wide
    ? html`<button type="button" class="palette-btn" data-testid=${TESTID.commandPaletteOpen} onClick=${() => openDialog('palette')}
      aria-label="Command palette" aria-keyshortcuts="Meta+K Control+K" title=${title}>
      <${Icon} name="search" size=${14} /><span class="palette-btn-text">Search or run a command</span>
      <kbd class="palette-btn-kbd" aria-hidden="true">${shortcut(KEYS.palette, { compact: true })}</kbd>
    </button>`
    : html`<button type="button" class="icon-btn palette-icon" data-testid=${TESTID.commandPaletteOpen} onClick=${() => openDialog('palette')}
      aria-label="Command palette" aria-keyshortcuts="Meta+K Control+K" title=${title}><${Icon} name="search" /></button>`;
}

/** The gear: Settings (⌘,). On the doc list; in a doc it is in the More menu. */
export function SettingsButton() {
  return html`<button type="button" class="icon-btn" data-testid=${TESTID.settingsOpen} aria-label="Settings"
    aria-keyshortcuts="Meta+, Control+," title=${`Settings (${shortcut(KEYS.settings)})`} onClick=${() => openDialog('settings')}>
    <${Icon} name="gear" /></button>`;
}

/** Keyboard shortcuts (⌘/ or ?). On the doc list; in a doc it is in the More menu. */
export function HelpButton() {
  return html`<button type="button" class="icon-btn" data-testid=${TESTID.helpOpen} aria-label="Keyboard shortcuts"
    aria-keyshortcuts="Meta+/ Control+/ ?" title=${`Keyboard shortcuts (${shortcut(KEYS.help)} or ?)`}
    onClick=${() => openDialog('help')}><${Icon} name="help" /></button>`;
}

/**
 * The primary button: "Send N" with N drafts (accent), else "Approve" (accent when approving is the obvious next
 * step, neutral otherwise). Both open the send dialog. It reads the store itself and keeps one element (see the
 * header comment); `.drafts-count` holds N.
 */
function SubmitButton() {
  // the selector keeps to references (it runs on every store update); what they mean is worked out when they change
  const s = useStore((st) => ({ ds: st.ds, version: st.version }));
  const n = draftCount(s.ds);
  const ready = !n && !!s.ds && approveReady(s.ds, s.version);
  const keys = `${shortcut(KEYS.submit)}, or ${shortcut(KEYS.sendNow)} when no comment is open`;
  return html`<button type="button" class=${`btn send-btn ${n || ready ? 'btn-primary' : ''}`} data-testid=${TESTID.submitReviewOpen}
    onClick=${openSubmit} aria-keyshortcuts="F"
    title=${n ? `Send: your ${n} comment${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} to the agent together (${keys})`
      : `Approve this version, or send feedback (${keys})`}>
    ${n ? html`Send <span class="drafts-count"><strong>${n}</strong></span>` : 'Approve'}</button>`;
}
