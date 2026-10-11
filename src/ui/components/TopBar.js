// @ts-check
// Top bar (design 11.1): doc title, version picker, mode tabs (a dropdown below 900 px), Changes base picker,
// comment / pick / snip / screen-snip / hide / theme / help tools, presence chip, round status, the review progress
// chip, Drafts count and Submit review. The capture tools carry a small key hint (e, b, ⇧B) so the shortcuts are
// discoverable; the screen-snip button disappears once the daemon said it cannot capture the screen (not macOS).
// The second row keeps a fixed, keyed structure (optional items are empty slots, not inserted / removed nodes) and
// Submit review is its own component: DocState refreshes arriving over SSE (drafts count, presence, a new round)
// must never re-create or move the button between a mousedown and its mouseup, or the browser drops the click.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import {
  cycleTheme, navigate, openComposer, openSubmit, setBase, setMode, snipScreen, switchVersion, toggleHidden, toggleNav,
  togglePick, toggleSidebar, toggleSnip,
} from '../actions.js';
import { KEYS, shortcut } from '../keys.js';
import {
  agentName, draftCount, filterCounts, presenceInfo, reviewProgress, roundSummary, versionNumbers,
} from '../model.js';
import { store, useStore } from '../state.js';
import { Chip, Icon } from './common.js';

const MODES = /** @type {const} */ ([
  { key: 'review', label: 'Review', n: 1 },
  { key: 'changes', label: 'Changes', n: 2 },
  { key: 'source', label: 'Source', n: 3 },
  { key: 'history', label: 'History', n: 4 },
]);

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
    rail: st.rail,
    drawer: st.drawer,
    sidebar: st.sidebar,
    nav: st.nav,
    selection: st.guest.selection,
    screenRunning: st.screenSnip.running,
    screenSupported: st.screenSnip.supported,
  }));
  const ds = s.ds;
  if (!ds) return null;
  const head = Number(ds.doc.head);
  const versions = versionNumbers(ds);
  const presence = presenceInfo(ds);
  const round = roundSummary(ds);
  const progress = reviewProgress(ds);
  const drafts = draftCount(ds);
  const open = filterCounts(ds, s.version).open;
  const canPick = s.version !== 'live' && (s.mode === 'review' || s.mode === 'changes');
  const showBase = s.mode === 'changes' || s.mode === 'source';
  const numericV = s.version === 'live' ? head + 1 : Number(s.version);
  const last = Number(ds.doc.lastReviewedVersion);

  /** @param {Event} e */
  const onVersion = (e) => {
    const el = /** @type {HTMLSelectElement} */ (e.currentTarget);
    const v = el.value === 'live' ? 'live' : Number(el.value);
    if (!switchVersion(v)) el.value = String(s.version);
  };

  return html`<header class="topbar">
    <div class="tb-row">
      ${s.narrow || s.medium ? html`<button type="button" class="icon-btn nav-toggle" aria-label="Outline and history" aria-controls="sr-nav"
        aria-expanded=${s.narrow ? s.nav : s.rail} onClick=${toggleNav}><${Icon} name="menu" /></button>` : null}
      <a class="brand" href="/" title="All documents" onClick=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); navigate('/'); }}>
        <${Icon} name="comment" size=${16} /><span class="brand-text">SpecReview</span></a>
      <h1 class="doc-name" title=${ds.doc.path}>${ds.doc.title || ds.doc.id}</h1>
      <label class="sr-only" for="sr-version">Version</label>
      <select id="sr-version" class="select" data-testid=${TESTID.versionPicker} value=${String(s.version)} onChange=${onVersion}>
        ${versions.slice().reverse().map((v) => html`<option value=${String(v)}>v${v}${v === head ? ' (latest)' : ''}${ds.doc.final?.version === v ? ' FINAL' : ''}</option>`)}
        ${(ds.working?.dirty && !ds.working?.missing) || s.version === 'live' ? html`<option value="live">Working copy (live)</option>` : null}
      </select>
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
      ${showBase ? html`<span class="base-picker">
        <label for="sr-base">base</label>
        <select id="sr-base" class="select" value=${s.base == null ? '' : String(s.base)} title="Compare against (d toggles)"
          onChange=${(/** @type {any} */ e) => setBase(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}>
          <option value="">none</option>
          ${versions.filter((v) => v < numericV || (s.version === 'live' && v <= head)).reverse().map((v) => html`<option value=${String(v)}>
            v${v}${v === last ? ' (your last review)' : v === numericV - 1 ? ' (previous)' : ''}</option>`)}
        </select>
      </span>` : null}
      <span class="spacer"></span>
      <span class="tools">
        <button type="button" class="icon-btn" data-selection-comment disabled=${!s.selection || !canPick}
          aria-label="Comment on the selection" title="Comment on the selected text (c)"
          onClick=${() => s.selection && openComposer({ capture: s.selection })}><${Icon} name="comment" /></button>
        <button type="button" class=${`icon-btn has-kbd ${s.tool === 'pick' ? 'active' : ''}`} data-testid=${TESTID.pickTool}
          aria-pressed=${s.tool === 'pick'} disabled=${!canPick} aria-keyshortcuts="e"
          aria-label="Pick an element (image, diagram, table, code)" title=${`Pick an element: image, diagram, table, code (${shortcut(KEYS.pick)})`}
          onClick=${togglePick}>
          <${Icon} name="pick" /><kbd class="kbd-hint" aria-hidden="true">e</kbd>
        </button>
        <button type="button" class=${`icon-btn has-kbd ${s.tool === 'snip' ? 'active' : ''}`} data-testid=${TESTID.snipTool}
          aria-pressed=${s.tool === 'snip'} disabled=${s.version === 'live'} aria-keyshortcuts="b"
          aria-label="Snip an area of the document"
          title=${`Snip an area of the document: drag a box over text, images or diagrams, then comment (${shortcut(KEYS.snip)})`}
          onClick=${() => toggleSnip()}>
          <${Icon} name="scissors" /><kbd class="kbd-hint" aria-hidden="true">b</kbd>
        </button>
        ${s.screenSupported ? html`<button type="button" class=${`icon-btn has-kbd ${s.screenRunning ? 'active' : ''}`} data-testid=${TESTID.snipScreen}
          aria-busy=${s.screenRunning ? 'true' : undefined} disabled=${s.screenRunning || s.version === 'live'} aria-keyshortcuts="Shift+B"
          aria-label="Snip anywhere on your screen"
          title=${`Snip anywhere on your screen with the macOS picker, then comment on the screenshot (${shortcut(KEYS.snipScreen)})`}
          onClick=${snipScreen}>
          <${Icon} name="screen" /><kbd class="kbd-hint" aria-hidden="true">⇧B</kbd>
        </button>` : null}
        <button type="button" class=${`icon-btn ${s.hidden ? 'active' : ''}`} aria-pressed=${s.hidden}
          aria-label="Hide annotations" title="Hide annotations (h)" onClick=${toggleHidden}>
          <${Icon} name=${s.hidden ? 'eyeOff' : 'eye'} />
        </button>
        <button type="button" class="icon-btn" data-theme-toggle aria-label=${`Theme: ${s.theme}. Change theme`}
          title=${`Theme: ${s.theme} (t)`} onClick=${cycleTheme}>
          <${Icon} name=${s.theme === 'dark' ? 'moon' : s.theme === 'light' ? 'sun' : 'system'} />
        </button>
        <button type="button" class="icon-btn" aria-label="Keyboard shortcuts" title="Help (?)"
          onClick=${() => store.set({ dialog: 'help' })}><${Icon} name="help" /></button>
      </span>
    </div>
    <div class="tb-row tb-sub">
      <span key="presence" data-testid=${TESTID.presence} class=${`presence tone-${presence.tone}`} data-presence=${presence.kind}
        title=${presence.kind === 'none' ? `Tell ${agentName(ds)} to run specreview wait` : presence.label}>
        <span class="dot" aria-hidden="true"></span>${presence.label}
      </span>
      <span key="round" class="round-status" hidden=${!round}>${round ? round.text : ''}</span>
      <span key="progress" class="progress-slot">${progress && progress.stage !== 'ready'
        ? html`<${Chip} tone=${progress.tone} class="review-progress">${progress.label}<//>` : null}</span>
      <span key="spacer" class="spacer"></span>
      <button key="threads" type="button" class="btn btn-sm threads-toggle" aria-controls="sr-side"
        aria-expanded=${s.narrow ? s.drawer : s.sidebar} onClick=${toggleSidebar} title="Toggle the thread panel (\\)">
        <${Icon} name="threads" size=${14} /> Threads (${open})
      </button>
      <span key="drafts" class="drafts-count" title="Unsubmitted comments">Drafts <strong>${drafts}</strong></span>
      <${SubmitButton} key="submit" />
    </div>
  </header>`;
}

/** Submit review: no props, so a TopBar re-render never touches it (see the header). */
function SubmitButton() {
  return html`<button type="button" class="btn btn-primary" data-testid=${TESTID.submitReviewOpen} onClick=${openSubmit}
    aria-keyshortcuts="F" title=${`Submit review: everything in it goes to the agent (${shortcut(KEYS.submit)}, or ${shortcut(KEYS.sendNow)} when no comment is open)`}>Submit review</button>`;
}
