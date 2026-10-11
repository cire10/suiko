// @ts-check
// Home: every tracked doc across registered workspaces (GET /api/docs), live-updated through the event stream. The
// header has the command palette, theme, Settings and keyboard shortcuts buttons, like the doc view's top bar.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import { cycleTheme, docPath, navigate } from '../actions.js';
import { useStore } from '../state.js';
import { Chip, Icon, Spinner } from './common.js';
import { HelpButton, PaletteButton, SettingsButton } from './TopBar.js';

const STATE_LABEL = /** @type {Record<string, [string, string]>} */ ({
  in_review: ['In review', 'accent'],
  approved: ['Approved', 'ok'],
  closed: ['Closed', 'muted'],
});

export function Home() {
  const home = useStore((s) => s.home);
  const theme = useStore((s) => s.theme);
  const docs = home.docs;
  return html`<div class="home">
    <header class="home-head">
      <h1><span class="logo" aria-hidden="true"><${Icon} name="comment" size=${18} /></span> SpecReview</h1>
      <div class="home-tools">
        <${PaletteButton} />
        <button type="button" class="icon-btn" aria-label=${`Theme: ${theme}. Change theme`} title="Theme (t)" onClick=${cycleTheme}>
          <${Icon} name=${theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'system'} />
        </button>
        <${SettingsButton} />
        <${HelpButton} />
      </div>
    </header>
    <main class="home-main">
      <h2 class="home-sub">Documents</h2>
      ${home.error ? html`<p class="error" role="alert">${home.error}</p>` : null}
      ${docs === null ? html`<p class="muted"><${Spinner} /> Loading documents…</p>` : html`
        <ul class="doc-list" data-testid=${TESTID.docList}>
          ${docs.map((d) => html`<${DocRow} key=${`${d.ws}/${d.id}`} d=${d} />`)}
        </ul>
        ${docs.length === 0 ? html`<div class="empty">
          <p><strong>No documents yet.</strong></p>
          <p>Ask your agent to run <code>specreview open path/to/spec.md</code>, or run it yourself, and the spec appears here.</p>
        </div>` : null}`}
    </main>
  </div>`;
}

/** What a snapshot doc (no file on disk: store/snapshot.js) shows in place of its path. */
const ORIGIN_LABEL = /** @type {Record<string, string>} */ ({ plan: 'Claude Code plan', message: 'agent message', stdin: 'piped text', url: 'web page' });

/**
 * The path column of a doc row: the file path, or for a snapshot what it is (a web page also names its host).
 * @param {any} d
 * @returns {string}
 */
function docPlace(d) {
  if (d.kind !== 'snapshot') return d.path;
  const label = ORIGIN_LABEL[d.origin] || 'snapshot';
  if (d.origin !== 'url' || typeof d.source !== 'string') return label;
  try {
    return `${label} · ${new URL(d.source).host}`;
  } catch {
    return label;
  }
}

/** @param {{ d: any }} props */
function DocRow({ d }) {
  const href = docPath(d.ws, d.id);
  const [stateLabel, stateTone] = STATE_LABEL[d.state] || [String(d.state || ''), 'muted'];
  return html`<li class="doc-row">
    <a href=${href} class="doc-link" onClick=${(/** @type {MouseEvent} */ e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(href);
    }}>
      <span class="doc-title">${d.title || d.id}</span>
      <span class="doc-path" title=${d.source || undefined}>${docPlace(d)}</span>
    </a>
    <span class="doc-meta">
      <${Chip} tone="muted">v${d.head}<//>
      <${Chip} tone=${stateTone}>${stateLabel}<//>
      ${d.final ? html`<${Chip} tone="ok">FINAL v${d.final.version ?? d.final}<//>` : null}
      ${d.openThreads ? html`<${Chip} tone="accent">${d.openThreads} open<//>` : null}
      ${d.undelivered ? html`<${Chip} tone="warn" title="Submitted reviews the agent has not received yet">${d.undelivered} undelivered<//>` : null}
      ${d.listening ? html`<${Chip} tone="ok">listening<//>` : null}
    </span>
  </li>`;
}
