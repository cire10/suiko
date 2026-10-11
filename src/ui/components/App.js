// @ts-check
// Root component and the doc view layout (design 11.1 / 11.2, amendments 1 List layout):
//   TopBar / banners / [outline rail | doc frame or Source / History view | side panel] / status bar.
// Between 900 and 1199 px (e.g. a desktop app's browser pane) the outline rail is collapsed behind the menu button
// unless the user opened it (remembered), and the side panel is narrower, so the doc keeps most of the width.
// Below 900 px the outline rail and the side panel become drawers (left / right) over the full-width doc.
// The doc iframe stays mounted in every mode, so switching between Review / Changes and Source / History never
// reloads the document.
// The Outline rail setting (Auto / Always / Never) and the menu button's choice for the page decide whether the rail
// is beside the doc from 900 px up (railShown).
// While a screen snip (Shift+B) waits for the reviewer in the macOS picker, a floating hint says what to do; it
// blocks nothing (the picker itself is modal on the Mac).
// The command palette, Settings and the keyboard shortcuts are global dialogs (also on the doc list); Submit review
// belongs to the doc view. One dialog shows at a time.

import { html, useEffect, useRef, useState } from 'preact-htm';
import {
  goToNewHead, navigate, railShown, recordWorkingCopy, reloadFrame, startRecording, stopRecording, switchVersion, setMode,
  toggleNav, toggleSidebar,
} from '../actions.js';
import { agentName } from '../model.js';
import { store, useStore } from '../state.js';
import { ChangesView } from './ChangesView.js';
import { CommandPalette } from './CommandPalette.js';
import { Composer } from './Composer.js';
import { DocFrame } from './DocFrame.js';
import { HelpOverlay } from './HelpOverlay.js';
import { HistoryView } from './HistoryView.js';
import { Home } from './Home.js';
import { Lightbox } from './Lightbox.js';
import { Outline } from './Outline.js';
import { SettingsDialog } from './SettingsDialog.js';
import { SourceView } from './SourceView.js';
import { StatusBar } from './StatusBar.js';
import { SubmitDialog } from './SubmitDialog.js';
import { ThreadPanel } from './ThreadPanel.js';
import { Toasts } from './Toasts.js';
import { TopBar } from './TopBar.js';
import { Icon } from './common.js';

export function App() {
  const route = useStore((s) => s.route);
  const conn = useStore((s) => s.conn);
  const dialog = useStore((s) => s.dialog);
  const snipping = useStore((s) => s.screenSnip.running);
  return html`<div class="app-root">
    ${conn !== 'ok' ? html`<${ReconnectBanner} conn=${conn} />` : null}
    ${route.view === 'home' ? html`<${Home} />` : html`<${DocView} />`}
    ${snipping ? html`<${ScreenSnipHint} />` : null}
    <${Toasts} />
    ${dialog === 'help' ? html`<${HelpOverlay} />` : null}
    ${dialog === 'image' ? html`<${Lightbox} />` : null}
    ${dialog === 'palette' ? html`<${CommandPalette} />` : null}
    ${dialog === 'settings' ? html`<${SettingsDialog} />` : null}
  </div>`;
}

function ScreenSnipHint() {
  return html`<div class="snip-hint" role="status" data-screen-snip>
    <span class="spinner" aria-hidden="true"></span>
    <span><strong>Select an area anywhere on your screen…</strong> (Esc to cancel)</span>
  </div>`;
}

/** @param {{ conn: string }} props */
function ReconnectBanner({ conn }) {
  return html`<div class="banner banner-conn" role="alert">
    <span class="spinner" aria-hidden="true"></span>
    <strong>Reconnecting to SpecReview...</strong>
    ${conn === 'unauthorized'
      ? html`<span>The access token was rejected. Reopen the review link printed by <code>specreview open</code>.</span>`
      : html`<span>Your work is kept; it will continue when the daemon answers.</span>`}
  </div>`;
}

function DocView() {
  const s = useStore((st) => ({
    hasDs: !!st.ds,
    loadError: st.loadError,
    mode: st.mode,
    narrow: st.narrow,
    medium: st.medium,
    rail: railShown(st),
    drawer: st.drawer,
    nav: st.nav,
    sidebar: st.sidebar,
    dialog: st.dialog,
  }));
  if (s.loadError) {
    return html`<div class="page-message" role="alert">
      <h1>Cannot open this document</h1>
      <p>${s.loadError}</p>
      <p><a href="/" onClick=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); navigate('/'); }}>Back to all documents</a></p>
    </div>`;
  }
  if (!s.hasDs) return html`<div class="page-message"><span class="spinner"></span> Loading document…</div>`;
  const cls = [
    'doc-view',
    `mode-${s.mode}`,
    s.narrow ? 'is-narrow' : 'is-wide',
    !s.narrow && s.medium ? 'is-medium' : '',
    !s.narrow && s.medium && s.rail ? 'rail-open' : '',
    !s.narrow && !s.medium && !s.rail ? 'rail-closed' : '',
    s.drawer ? 'drawer-open' : '',
    s.nav ? 'nav-open' : '',
    s.sidebar ? '' : 'sidebar-hidden',
  ].filter(Boolean).join(' ');
  return html`<div class=${cls} data-mode=${s.mode}>
    <${TopBar} />
    <${Banners} />
    <div class="main">
      <aside class="rail-left" aria-label="Outline and history" id="sr-nav">
        ${s.narrow ? html`<div class="drawer-head"><strong>Outline</strong>
          <button type="button" class="icon-btn" aria-label="Close outline" onClick=${toggleNav}><${Icon} name="close" /></button></div>` : null}
        <${Outline} />
      </aside>
      <main class="center" aria-label="Document">
        <${DocFrame} />
        ${s.mode === 'source' ? html`<${SourceView} />` : null}
        ${s.mode === 'history' ? html`<${HistoryView} />` : null}
      </main>
      <aside class="rail-right" aria-label="Review panel" id="sr-side">
        <${SidePanel} narrow=${s.narrow} mode=${s.mode} />
      </aside>
      ${s.narrow && (s.drawer || s.nav)
        ? html`<div class="scrim" onClick=${() => store.set({ drawer: false, nav: false })} aria-hidden="true"></div>` : null}
    </div>
    <${StatusBar} />
    ${s.dialog === 'submit' ? html`<${SubmitDialog} />` : null}
  </div>`;
}

/** @param {{ narrow: boolean, mode: string }} props */
function SidePanel({ narrow, mode }) {
  const composerOpen = useStore((s) => !!s.composer);
  const pane = useStore((s) => s.sidePane);
  const showChanges = mode === 'changes' && pane === 'changes';
  return html`<div class="side">
    ${narrow ? html`<div class="drawer-head"><strong>${showChanges ? 'Changes' : 'Threads'}</strong>
      <button type="button" class="icon-btn" aria-label="Close panel" onClick=${toggleSidebar}><${Icon} name="close" /></button></div>` : null}
    ${composerOpen ? html`<${Composer} />` : null}
    ${mode === 'changes' ? html`<div class="side-tabs" role="tablist" aria-label="Side panel">
      <button type="button" role="tab" aria-selected=${pane === 'changes'} class=${pane === 'changes' ? 'active' : ''}
        onClick=${() => store.set({ sidePane: 'changes' })}>Changes</button>
      <button type="button" role="tab" aria-selected=${pane === 'threads'} class=${pane === 'threads' ? 'active' : ''}
        onClick=${() => store.set({ sidePane: 'threads' })}>Threads</button>
    </div>` : null}
    ${showChanges ? html`<${ChangesView} />` : html`<${ThreadPanel} />`}
  </div>`;
}

function Banners() {
  const s = useStore((st) => ({ ds: st.ds, version: st.version, newHead: st.newHead, mode: st.mode, lost: st.guest.lost, recording: st.recording }));
  const [summary, setSummary] = useState('');
  const recordRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  // The form opens from its button or from the command palette: its summary field takes the focus.
  useEffect(() => {
    if (s.recording) recordRef.current?.focus();
  }, [s.recording]);
  const recording = s.recording;
  const ds = s.ds;
  if (!ds) return null;
  const head = Number(ds.doc.head);
  const agent = agentName(ds);
  const out = [];
  if (s.lost && (s.mode === 'review' || s.mode === 'changes')) {
    const where = s.version === 'live' ? 'the working copy' : `v${s.version}`;
    out.push(html`<div class="banner banner-warn" role="alert" key="lost" data-frame-lost>
      <span><strong>The document navigated away</strong> from the reviewed page; comments and highlights are off until you go back.</span>
      <span class="banner-actions"><button type="button" class="btn btn-sm" onClick=${reloadFrame}>Back to ${where}</button></span>
    </div>`);
  }
  if (ds.working?.missing) {
    out.push(html`<div class="banner banner-warn" role="status" key="missing">
      <span><strong>The file is missing on disk</strong> (${ds.doc.path} was moved or deleted). Recorded versions are still available.</span>
    </div>`);
  } else if (ds.working?.dirty || s.version === 'live') {
    const live = s.version === 'live';
    out.push(html`<div class="banner banner-warn" role="status" key="working">
      <span>${live
        ? html`<strong>Previewing the unrecorded working copy</strong> (read-only, reloads as ${agent} edits).`
        : html`<strong>Unrecorded changes on disk</strong> (${agent} is editing).`}</span>
      <span class="banner-actions">
        ${live
          ? html`<button type="button" class="btn btn-sm" onClick=${() => switchVersion(head)}>Back to v${head}</button>`
          : html`<button type="button" class="btn btn-sm" onClick=${() => switchVersion('live')}>Preview live</button>`}
        ${recording
          ? html`<form class="inline-form" onSubmit=${(/** @type {Event} */ e) => { e.preventDefault(); recordWorkingCopy(summary); stopRecording(); setSummary(''); }}>
              <input ref=${recordRef} type="text" aria-label="Revision summary" placeholder="Summary of your edit" value=${summary}
                onInput=${(/** @type {any} */ e) => setSummary(e.currentTarget.value)}
                onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopRecording(); } }} />
              <button type="submit" class="btn btn-sm btn-primary">Record</button>
              <button type="button" class="btn btn-sm" onClick=${stopRecording}>Cancel</button>
            </form>`
          : html`<button type="button" class="btn btn-sm" onClick=${startRecording}>Record as my revision</button>`}
      </span>
    </div>`);
  }
  if (typeof s.version === 'number' && s.version < head) {
    out.push(html`<div class="banner banner-info" role="status" key="older">
      <span>You are viewing <strong>v${s.version}</strong> (latest is v${head}). Comments are carried forward to v${head}.</span>
      <span class="banner-actions"><button type="button" class="btn btn-sm" onClick=${() => switchVersion(head)}>Go to v${head}</button></span>
    </div>`);
  } else if (s.newHead && s.newHead !== s.version) {
    out.push(html`<div class="banner banner-info" role="status" key="newhead">
      <span><strong>v${s.newHead}</strong> is available.</span>
      <span class="banner-actions"><button type="button" class="btn btn-sm" onClick=${goToNewHead}>Switch to v${s.newHead}</button></span>
    </div>`);
  }
  if (ds.doc.state === 'approved' && ds.doc.final) {
    const fv = Number(ds.doc.final.version);
    out.push(html`<div class="banner banner-ok" role="status" key="final">
      <span><strong>Approved at v${fv}.</strong>${head > fv ? ' Newer unapproved changes exist.' : ''}</span>
      <span class="banner-actions">
        <button type="button" class="btn btn-sm" onClick=${() => { switchVersion(fv); setMode('review'); }}>View final</button>
        <button type="button" class="btn btn-sm" onClick=${() => setMode('history')}>History</button>
      </span>
    </div>`);
  } else if (ds.doc.state === 'closed') {
    out.push(html`<div class="banner banner-muted" role="status" key="closed"><span>This review session is closed.</span></div>`);
  }
  return out.length ? html`<div class="banners">${out}</div>` : null;
}
