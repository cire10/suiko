// @ts-check
// Root component and the doc view layout (design 11.1 / 11.2, amendments 1 List layout):
//   TopBar / banners / [outline rail | doc frame or Source / History view | side panel] / status bar.
// A doc kind can replace the banners, the doc frame, the outline rail and the Changes list with its own components
// (components/kinds/index.js: a code review shows a file tree and diffs instead of a rendered doc).
// Between 900 and 1199 px (e.g. a desktop app's browser pane) the outline rail is collapsed behind the menu button
// unless the user opened it (remembered), and the side panel is narrower, so the doc keeps most of the width.
// Below 900 px the outline rail and the side panel become drawers (left / right) over the full-width doc.
// Read mode shows the doc alone: no thread panel (the side panel appears only for a comment being written).
// The doc iframe stays mounted in every mode, so switching between Review / Changes and Source / History never
// reloads the document. Changes side by side adds the older version's frame after it in the DOM, placed on its
// left by CSS grid, so the newer version's iframe never moves.
// The Outline rail setting (Auto / Always / Never) and the menu button's choice for the page decide whether the rail
// is beside the doc from 900 px up (railShown).
// While a screen snip (Shift+B) waits for the reviewer in the macOS picker, a floating hint says what to do; it
// blocks nothing (the picker itself is modal on the Mac).
// The command palette, Settings and the keyboard shortcuts are global dialogs (also on the doc list); Submit review
// belongs to the doc view. One dialog shows at a time.

import { html } from 'preact-htm';
import { navigate, railShown, splitShown, toggleNav, toggleSidebar } from '../actions.js';
import { docKindOf } from '../model.js';
import { store, useStore } from '../state.js';
import { Banners } from './Banners.js';
import { ChangesView } from './ChangesView.js';
import { CommandPalette } from './CommandPalette.js';
import { ComparePane } from './ComparePane.js';
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
import { KindBanners, KindMain, KindRail, KindSide } from './kinds/index.js';

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
    <strong>Reconnecting to Suiko...</strong>
    ${conn === 'unauthorized'
      ? html`<span>The access token was rejected. Reopen the review link printed by <code>suiko open</code>.</span>`
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
    composing: !!st.composer,
    split: splitShown(st),
    dialog: st.dialog,
    railTitle: docKindOf(st.ds) === 'code' ? 'Files' : 'Outline',
  }));
  if (s.loadError) {
    return html`<div class="page-message" role="alert">
      <h1>Cannot open this document</h1>
      <p>${s.loadError}</p>
      <p><a href="/" onClick=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); navigate('/'); }}>Back to all documents</a></p>
    </div>`;
  }
  if (!s.hasDs) return html`<div class="page-message"><span class="spinner"></span> Loading document…</div>`;
  // Read mode has no thread panel: the side panel (drawer) shows only while a comment is being written there
  const reading = s.mode === 'read';
  const panelShown = reading ? s.composing : s.sidebar;
  const cls = [
    'doc-view',
    `mode-${s.mode}`,
    s.narrow ? 'is-narrow' : 'is-wide',
    !s.narrow && s.medium ? 'is-medium' : '',
    !s.narrow && s.medium && s.rail ? 'rail-open' : '',
    !s.narrow && !s.medium && !s.rail ? 'rail-closed' : '',
    s.drawer && (!reading || s.composing) ? 'drawer-open' : '',
    s.nav ? 'nav-open' : '',
    panelShown ? '' : 'sidebar-hidden',
  ].filter(Boolean).join(' ');
  return html`<div class=${cls} data-mode=${s.mode}>
    <${TopBar} />
    <${BannerSlot} />
    <div class="main">
      <aside class="rail-left" aria-label="Outline and history" id="sr-nav">
        ${s.narrow ? html`<div class="drawer-head"><strong>${s.railTitle}</strong>
          <button type="button" class="icon-btn" aria-label=${`Close ${s.railTitle.toLowerCase()}`} onClick=${toggleNav}><${Icon} name="close" /></button></div>` : null}
        <${RailSlot} />
      </aside>
      <main class=${`center ${s.split ? 'is-split' : ''}`} aria-label="Document">
        <${MainSlot} />
        ${s.mode === 'source' ? html`<${SourceView} />` : null}
        ${s.mode === 'history' ? html`<${HistoryView} />` : null}
        ${s.split ? html`<${ComparePane} />` : null}
      </main>
      <aside class="rail-right" aria-label="Review panel" id="sr-side">
        <${SidePanel} narrow=${s.narrow} mode=${s.mode} />
      </aside>
      ${s.narrow && ((s.drawer && (!reading || s.composing)) || s.nav)
        ? html`<div class="scrim" onClick=${() => store.set({ drawer: false, nav: false })} aria-hidden="true"></div>` : null}
    </div>
    <${StatusBar} />
    ${s.dialog === 'submit' ? html`<${SubmitDialog} />` : null}
  </div>`;
}

// The kind seam (components/kinds/index.js): a doc kind's own banner, center view and rail replace the spec-doc ones.

/** The banner stack, or the doc kind's banner (KindBanners). */
function BannerSlot() {
  const ds = useStore((s) => s.ds);
  return KindBanners({ ds }) ?? html`<${Banners} />`;
}

/** The doc frame, or the doc kind's center view (KindMain: a code review's diffs). */
function MainSlot() {
  const ds = useStore((s) => s.ds);
  return KindMain({ ds }) ?? html`<${DocFrame} />`;
}

/** The outline, or the doc kind's rail (KindRail: a code review's file tree). */
function RailSlot() {
  const ds = useStore((s) => s.ds);
  return KindRail({ ds }) ?? html`<${Outline} />`;
}

/** @param {{ narrow: boolean, mode: string }} props */
function SidePanel({ narrow, mode }) {
  const composerOpen = useStore((s) => !!s.composer);
  const pane = useStore((s) => s.sidePane);
  const ds = useStore((s) => s.ds);
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
    ${mode === 'read' ? null : showChanges ? KindSide({ ds }) ?? html`<${ChangesView} />` : html`<${ThreadPanel} />`}
  </div>`;
}
