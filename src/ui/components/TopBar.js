// @ts-check
// Top bar (design 11.1): doc title, version picker (in Changes / Source preceded by the older version's picker, so
// the comparison reads "[v1 · last review] → [v3 (latest)]"), mode tabs (a dropdown below 900 px), the command palette
// button (⌘K), comment / pick / snip / screen-snip / hide / theme tools, Settings (gear) and the keyboard shortcuts;
// then presence chip, round status, the review progress chip, Changes' Inline / Side by side switch (wide layouts),
// Drafts count and Submit review. The
// modes and tools follow the doc kind (model.js modesFor / kindCaps: a code review has no Source, pick, snip, hide). The
// capture tools carry a small key hint (e, b, ⇧B) so the shortcuts are discoverable; the screen-snip button
// disappears once the daemon said it cannot capture the screen (not macOS). The menu button (outline drawer / rail)
// shows whenever the outline is not simply beside the doc (narrow or medium width, or the Outline rail setting).
// The second row keeps a fixed, keyed structure (optional items are empty slots, not inserted / removed nodes) and
// Submit review is its own component: DocState refreshes arriving over SSE (drafts count, presence, a new round)
// must never re-create or move the button between a mousedown and its mouseup, or the browser drops the click.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import {
  cycleTheme, navigate, openComposer, openDialog, openSubmit, railShown, railToggleShown, setBase, setCompareLayout, setMode,
  snipScreen, switchVersion, toggleHidden, toggleNav, togglePick, toggleSidebar, toggleSnip,
} from '../actions.js';
import { KEYS, shortcut } from '../keys.js';
import {
  agentName, draftCount, filterCounts, kindCaps, modesFor, presenceInfo, reviewProgress, roundSummary, showsDoc,
  versionNumbers,
} from '../model.js';
import { useStore } from '../state.js';
import { Chip, Icon } from './common.js';

export function TopBar() {
  const s = useStore((st) => ({
    ds: st.ds,
    version: st.version,
    mode: st.mode,
    base: st.base,
    baseKind: st.baseKind,
    tool: st.tool,
    hidden: st.hidden,
    theme: st.theme,
    narrow: st.narrow,
    medium: st.medium,
    rail: railShown(st),
    railToggle: railToggleShown(st),
    drawer: st.drawer,
    sidebar: st.sidebar,
    nav: st.nav,
    selection: st.guest.selection,
    screenRunning: st.screenSnip.running,
    screenSupported: st.screenSnip.supported,
    compareLayout: st.compareLayout,
  }));
  const ds = s.ds;
  if (!ds) return null;
  const head = Number(ds.doc.head);
  // the doc kind's modes and tools (model.js modesFor / kindCaps): a code review has no Source mode, no doc frame
  // (no text selection, pick, snip or hide) and no live working-copy preview
  const MODES = modesFor(ds);
  const caps = kindCaps(ds);
  const versions = versionNumbers(ds);
  const presence = presenceInfo(ds);
  const round = roundSummary(ds);
  const progress = reviewProgress(ds);
  const drafts = draftCount(ds);
  const open = filterCounts(ds, s.version).open;
  const canPick = s.version !== 'live' && showsDoc(s.mode);
  const showBase = s.mode === 'changes' || s.mode === 'source';
  const numericV = s.version === 'live' ? head + 1 : Number(s.version);
  const last = Number(ds.doc.lastReviewedVersion);
  // the older end of a comparison: any version before the shown one (every recorded version for the working copy)
  const olders = versions.filter((v) => v < numericV || (s.version === 'live' && v <= head)).reverse();

  /** @param {Event} e */
  const onVersion = (e) => {
    const el = /** @type {HTMLSelectElement} */ (e.currentTarget);
    const v = el.value === 'live' ? 'live' : Number(el.value);
    if (!switchVersion(v)) el.value = String(s.version);
  };
  // the version shown; in Changes / Source the newer end of the comparison range
  const versionSelect = html`<label class="sr-only" for="sr-version">${showBase ? 'Compare to' : 'Version'}</label>
    <select id="sr-version" class="select" data-testid=${TESTID.versionPicker} value=${String(s.version)} onChange=${onVersion}
      title=${showBase ? 'The newer version: shown with what changed' : 'The version shown'}>
      ${versions.slice().reverse().map((v) => html`<option value=${String(v)}>v${v}${v === head ? ' (latest)' : ''}${ds.doc.final?.version === v ? ' FINAL' : ''}</option>`)}
      ${caps.liveBanners && ((ds.working?.dirty && !ds.working?.missing) || s.version === 'live') ? html`<option value="live">Working copy (live)</option>` : null}
    </select>`;

  return html`<header class="topbar">
    <div class="tb-row">
      ${s.railToggle ? html`<button type="button" class="icon-btn nav-toggle" aria-label="Outline and history" aria-controls="sr-nav"
        aria-expanded=${s.narrow ? s.nav : s.rail} onClick=${toggleNav}><${Icon} name="menu" /></button>` : null}
      <a class="brand" href="/" title="All documents" onClick=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); navigate('/'); }}>
        <${Icon} name="comment" size=${16} /><span class="brand-text">Suiko</span></a>
      <h1 class="doc-name" title=${ds.doc.path}>${ds.doc.title || ds.doc.id}</h1>
      ${showBase ? html`<span class="compare-range" role="group" aria-label="Compare versions">
        <label class="sr-only" for="sr-base">Compare from</label>
        <select id="sr-base" class="select" data-testid=${TESTID.compareFrom} value=${s.base == null ? '' : String(s.base)}
          disabled=${!olders.length} title="The older version: what changed since it is shown (d: your last review / the previous version)"
          onChange=${(/** @type {any} */ e) => setBase(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}>
          ${s.base == null ? html`<option value="">${olders.length ? 'none' : 'no earlier version'}</option>` : null}
          ${olders.map((v) => html`<option value=${String(v)}>
            v${v}${v === last ? ' · last review' : v === numericV - 1 ? ' · previous' : ''}</option>`)}
        </select>
        <span class="compare-arrow" aria-hidden="true">→</span>
        ${versionSelect}
      </span>` : versionSelect}
      <nav class="mode-tabs" role="tablist" aria-label="Mode">
        ${MODES.map((m) => html`<button type="button" role="tab" data-testid=${TESTID.modeTab} data-mode=${m.key}
          aria-selected=${s.mode === m.key} class=${s.mode === m.key ? 'active' : ''} title=${`${m.label} (${m.n})`}
          onClick=${() => setMode(m.key)}>${m.label}</button>`)}
      </nav>
      <label class="sr-only" for="sr-mode">Mode</label>
      <select id="sr-mode" class="select mode-select" value=${s.mode}
        onChange=${(/** @type {any} */ e) => setMode(e.currentTarget.value)}>
        ${MODES.map((m) => html`<option value=${m.key}>${m.label}</option>`)}
      </select>
      <span class="spacer"></span>
      <${PaletteButton} />
      <span class="tools">
        ${caps.frame ? html`<button type="button" class="icon-btn" data-selection-comment disabled=${!s.selection || !canPick}
          aria-label="Comment on the selection" title="Comment on the selected text (c)"
          onClick=${() => s.selection && openComposer({ capture: s.selection })}><${Icon} name="comment" /></button>` : null}
        ${caps.pick ? html`<button type="button" class=${`icon-btn has-kbd ${s.tool === 'pick' ? 'active' : ''}`} data-testid=${TESTID.pickTool}
          aria-pressed=${s.tool === 'pick'} disabled=${!canPick} aria-keyshortcuts="e"
          aria-label="Pick an element (image, diagram, table, code)" title=${`Pick an element: image, diagram, table, code (${shortcut(KEYS.pick)})`}
          onClick=${togglePick}>
          <${Icon} name="pick" /><kbd class="kbd-hint" aria-hidden="true">e</kbd>
        </button>` : null}
        ${caps.snip ? html`<button type="button" class=${`icon-btn has-kbd ${s.tool === 'snip' ? 'active' : ''}`} data-testid=${TESTID.snipTool}
          aria-pressed=${s.tool === 'snip'} disabled=${s.version === 'live'} aria-keyshortcuts="b"
          aria-label="Snip an area of the document"
          title=${`Snip an area of the document: drag a box over text, images or diagrams, then comment (${shortcut(KEYS.snip)})`}
          onClick=${() => toggleSnip()}>
          <${Icon} name="scissors" /><kbd class="kbd-hint" aria-hidden="true">b</kbd>
        </button>` : null}
        ${s.screenSupported ? html`<button type="button" class=${`icon-btn has-kbd ${s.screenRunning ? 'active' : ''}`} data-testid=${TESTID.snipScreen}
          aria-busy=${s.screenRunning ? 'true' : undefined} disabled=${s.screenRunning || s.version === 'live'} aria-keyshortcuts="Shift+B"
          aria-label="Snip anywhere on your screen"
          title=${`Snip anywhere on your screen with the macOS picker, then comment on the screenshot (${shortcut(KEYS.snipScreen)})`}
          onClick=${snipScreen}>
          <${Icon} name="screen" /><kbd class="kbd-hint" aria-hidden="true">⇧B</kbd>
        </button>` : null}
        ${caps.hide ? html`<button type="button" class=${`icon-btn ${s.hidden ? 'active' : ''}`} aria-pressed=${s.hidden}
          disabled=${s.mode === 'read'} aria-label="Hide annotations"
          title=${s.mode === 'read' ? 'Read mode shows no annotations' : 'Hide annotations (h)'} onClick=${toggleHidden}>
          <${Icon} name=${s.hidden || s.mode === 'read' ? 'eyeOff' : 'eye'} />
        </button>` : null}
        <button type="button" class="icon-btn" data-theme-toggle aria-label=${`Theme: ${s.theme}. Change theme`}
          title=${`Theme: ${s.theme} (t)`} onClick=${cycleTheme}>
          <${Icon} name=${s.theme === 'dark' ? 'moon' : s.theme === 'light' ? 'sun' : 'system'} />
        </button>
        <${SettingsButton} />
        <${HelpButton} />
      </span>
    </div>
    <div class="tb-row tb-sub">
      <span key="presence" data-testid=${TESTID.presence} class=${`presence tone-${presence.tone}`} data-presence=${presence.kind}
        title=${presence.kind === 'none' ? `Tell ${agentName(ds)} to run suiko wait` : presence.label}>
        <span class="dot" aria-hidden="true"></span>${presence.label}
      </span>
      <span key="round" class="round-status" hidden=${!round}>${round ? round.text : ''}</span>
      <span key="progress" class="progress-slot">${progress && progress.stage !== 'ready'
        ? html`<${Chip} tone=${progress.tone} class="review-progress">${progress.label}<//>` : null}</span>
      <span key="spacer" class="spacer"></span>
      <span key="layout" class="layout-slot">${s.mode === 'changes' && caps.frame && !s.narrow ? html`<${CompareLayout} layout=${s.compareLayout} />` : null}</span>
      <button key="threads" type="button" class="btn btn-sm threads-toggle" aria-controls="sr-side"
        aria-expanded=${s.narrow ? s.drawer : s.sidebar} onClick=${toggleSidebar} title="Toggle the thread panel (\\)">
        <${Icon} name="threads" size=${14} /> Threads (${open})
      </button>
      <span key="drafts" class="drafts-count" title="Unsubmitted comments">Drafts <strong>${drafts}</strong></span>
      <${SubmitButton} key="submit" />
    </div>
  </header>`;
}

/**
 * Changes: Inline (what changed drawn over the newer version) or Side by side (the older version beside it).
 * @param {{ layout: 'inline'|'split' }} props
 */
function CompareLayout({ layout }) {
  return html`<span class="seg compare-layout" role="group" aria-label="Compare layout" data-testid=${TESTID.compareLayout}>
    <button type="button" data-layout="inline" aria-pressed=${layout !== 'split'} class=${layout !== 'split' ? 'active' : ''}
      title="What changed, drawn over the newer version" onClick=${() => setCompareLayout('inline')}>Inline</button>
    <button type="button" data-layout="split" aria-pressed=${layout === 'split'} class=${layout === 'split' ? 'active' : ''}
      title="The older version beside the newer one, scrolled together: removed text in red, added text in green"
      onClick=${() => setCompareLayout('split')}>Side by side</button>
  </span>`;
}

/** The command palette button: a search field look-alike with its key (⌘K / Ctrl K). Also on the doc list. */
export function PaletteButton() {
  return html`<button type="button" class="palette-btn" data-testid=${TESTID.commandPaletteOpen} onClick=${() => openDialog('palette')}
    aria-label="Command palette" aria-keyshortcuts="Meta+K Control+K" title=${`Command palette: run anything by name (${shortcut(KEYS.palette)})`}>
    <${Icon} name="search" size=${14} /><span class="palette-btn-text">Commands</span>
    <kbd class="palette-btn-kbd" aria-hidden="true">${shortcut(KEYS.palette, { compact: true })}</kbd>
  </button>`;
}

/** The gear: Settings (⌘,). Also on the doc list. */
export function SettingsButton() {
  return html`<button type="button" class="icon-btn" data-testid=${TESTID.settingsOpen} aria-label="Settings"
    aria-keyshortcuts="Meta+, Control+," title=${`Settings (${shortcut(KEYS.settings)})`} onClick=${() => openDialog('settings')}>
    <${Icon} name="gear" /></button>`;
}

/** Keyboard shortcuts (⌘/ or ?). Also on the doc list. */
export function HelpButton() {
  return html`<button type="button" class="icon-btn" data-testid=${TESTID.helpOpen} aria-label="Keyboard shortcuts"
    aria-keyshortcuts="Meta+/ Control+/ ?" title=${`Keyboard shortcuts (${shortcut(KEYS.help)} or ?)`}
    onClick=${() => openDialog('help')}><${Icon} name="help" /></button>`;
}

/** Submit review: no props, so a TopBar re-render never touches it (see the header). */
function SubmitButton() {
  return html`<button type="button" class="btn btn-primary" data-testid=${TESTID.submitReviewOpen} onClick=${openSubmit}
    aria-keyshortcuts="F" title=${`Submit review: everything in it goes to the agent (${shortcut(KEYS.submit)}, or ${shortcut(KEYS.sendNow)} when no comment is open)`}>Submit review</button>`;
}
