// @ts-check
// Home: every tracked doc across registered workspaces (GET /api/docs), live-updated through the event stream. The
// header has the Suiko mark, the command palette (as a search field), and the theme, Settings and keyboard shortcuts
// buttons (in a doc they are in the More menu; the two views are never mounted together, so their test ids never
// collide). Each row says, in the words of the doc's own turn pill, whose turn its threads are ("Your turn 4",
// "With Claude 3": the summary's yourTurn / withAgent), whether a review waits for the agent to connect ("Waiting for
// Claude"), whether the agent is listening, and the final version ("Final v2"); the agent's name is the summary's.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import { cycleTheme, docPath, navigate } from '../actions.js';
import { useStore } from '../state.js';
import { agentTitle } from '../model.js';
import { Chip, Icon, Logo, Spinner } from './common.js';
import { HelpButton, PaletteButton, SettingsButton } from './TopBar.js';

const STATE_LABEL = /** @type {Record<string, [string, string]>} */ ({
  in_review: ['In review', 'muted'],
  approved: ['Approved', 'ok'],
  closed: ['Closed', 'muted'],
});

export function Home() {
  const home = useStore((s) => s.home);
  const theme = useStore((s) => s.theme);
  const docs = home.docs;
  return html`<div class="home">
    <header class="home-head">
      <h1><${Logo} size=${28} /> Suiko</h1>
      <div class="home-tools">
        <${PaletteButton} wide=${true} />
        <button type="button" class="icon-btn" aria-label=${`Theme: ${theme}. Change theme`} title="Theme (t)" onClick=${cycleTheme}>
          <${Icon} name=${theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'system'} />
        </button>
        <${SettingsButton} />
        <${HelpButton} />
      </div>
    </header>
    <main class="home-main">
      <h2 class="home-sub">Documents${docs?.length ? html` <span class="home-count">${docs.length}</span>` : null}</h2>
      ${home.error ? html`<p class="error" role="alert">${home.error}</p>` : null}
      ${docs === null ? html`<p class="muted"><${Spinner} /> Loading documents…</p>` : html`
        <ul class="doc-list" data-testid=${TESTID.docList}>
          ${docs.map((d) => html`<${DocRow} key=${`${d.ws}/${d.id}`} d=${d} />`)}
        </ul>
        ${docs.length === 0 ? html`<div class="empty home-empty">
          <p><strong>No documents yet.</strong></p>
          <p>Ask your agent to run <code>suiko open path/to/doc.html</code>, or run it yourself, and the document appears here.</p>
        </div>` : null}`}
    </main>
  </div>`;
}

/** What a snapshot doc (no file on disk: store/snapshot.js) shows in place of its path. */
const ORIGIN_LABEL = /** @type {Record<string, string>} */ ({ plan: 'Claude Code plan', message: 'agent message', stdin: 'piped text', url: 'web page' });
/** The kind chip of a snapshot doc, by origin. */
const ORIGIN_CHIP = /** @type {Record<string, string>} */ ({ plan: 'plan', message: 'message', stdin: 'text', url: 'web' });

/**
 * A doc without a file of its own (docSummary kind 'snapshot' or 'code'): what it shows in place of its path (a web
 * page also names its host), and its kind chip ('code', 'plan', 'message', 'text', 'web'). Null for a spec file.
 * @param {any} d
 * @returns {{ where: string, chip: string } | null}
 */
function virtualDoc(d) {
  if (d.kind === 'code') return { where: 'code review', chip: 'code' };
  if (d.kind !== 'snapshot') return null;
  const label = ORIGIN_LABEL[d.origin] || 'snapshot';
  const chip = ORIGIN_CHIP[d.origin] || 'snapshot';
  if (d.origin !== 'url' || typeof d.source !== 'string') return { where: label, chip };
  try {
    return { where: `${label} · ${new URL(d.source).host}`, chip };
  } catch {
    return { where: label, chip };
  }
}

/** @param {{ d: any }} props */
function DocRow({ d }) {
  const href = docPath(d.ws, d.id);
  const [stateLabel, stateTone] = STATE_LABEL[d.state] || [String(d.state || ''), 'muted'];
  const virtual = virtualDoc(d);
  const agent = agentTitle(d.agent || 'claude');
  // older daemons send only openThreads: say how many are open
  const turns = d.yourTurn != null || d.withAgent != null;
  return html`<li class="doc-row">
    <a href=${href} class="doc-link" onClick=${(/** @type {MouseEvent} */ e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(href);
    }}>
      <span class="doc-title">${d.title || d.id}</span>
      <span class="doc-path" title=${d.source || undefined}>${virtual ? virtual.where : d.path}</span>
    </a>
    <span class="doc-meta">
      ${virtual ? html`<${Chip} tone="info" class="kind-chip">${virtual.chip}<//>` : null}
      <${Chip} tone="muted">v${d.head}<//>
      <${Chip} tone=${stateTone}>${stateLabel}<//>
      ${d.final ? html`<${Chip} tone="ok">Final v${d.final.version ?? d.final}<//>` : null}
      ${turns && d.yourTurn ? html`<${Chip} tone="accent" title="Threads waiting for you: answers to check, questions, comments not sent yet">Your turn ${d.yourTurn}<//>` : null}
      ${turns && d.withAgent ? html`<${Chip} tone="muted" title=${`Threads waiting for ${agent}`}>With ${agent} ${d.withAgent}<//>` : null}
      ${!turns && d.openThreads ? html`<${Chip} tone="accent">${d.openThreads} open<//>` : null}
      ${d.undelivered ? html`<${Chip} tone="warn" title=${`${d.undelivered === 1 ? 'A review you sent waits' : `${d.undelivered} reviews you sent wait`} for ${agent}: it gets ${d.undelivered === 1 ? 'it' : 'them'} when it connects`}>Waiting for ${agent}<//>` : null}
      ${d.listening ? html`<${Chip} tone="ok">${agent} is listening<//>` : null}
    </span>
  </li>`;
}
