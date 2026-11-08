// @ts-check
// The turn pill (top bar): "whose turn is it?" in one button, instead of a presence chip, a round status and a
// progress chip. Its dot always shows where the agent is (listening: green, working on your feedback: indigo and
// pulsing, editing the file: amber and pulsing, not connected: grey); its label is the one thing that matters now
// (model.js turnInfo): "Your turn" with a count while something waits for you, else "Apply N planned" while the
// agent's planned changes wait for your Apply (accent, like your turn: the next step is yours), else "Approved v3",
// "Review closed", or the agent's state ("Claude is listening", "Claude is working…", "Claude isn't connected"). Below
// 1200 px the label is its short form ("Listening", "Apply 2"), below 1024 px only the dot (and your count) shows; the
// button's accessible name and tooltip always say it in full.
// The presence element (TESTID.presence, data-presence) and the newest review's progress (.review-progress) stay
// inside the button: as the visible label when that is what it says, else as text for assistive technology.
// Clicking it opens a popover (Menu.js, kind 'dialog') with the details and what to do next: "Show my turn" (the
// thread panel on Your turn: the same threads as the count), the planned changes ("Claude planned 2 changes. They go
// into the document when you apply them.") with "Apply 2 planned" (the primary action unless it is also your turn;
// model.js applicablePlanned, what the panel's Apply sends), and, while the agent is not connected, "Copy the prompt"
// to paste into its chat.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import { applyPlanned, copyAgentPrompt, showMyTurn } from '../actions.js';
import { agentName, agentTitle, turnInfo } from '../model.js';
import { useStore } from '../state.js';
import { Popover, usePopover } from './Menu.js';

/** What the presence means for the reviewer, in the popover. */
const PRESENCE_DETAIL = /** @type {Record<string, (agent: string) => any>} */ ({
  listening: () => 'Your feedback reaches it as soon as you send it.',
  revising: () => 'It has your feedback and is working on it. Anything you send now reaches it at its next wait.',
  editing: () => 'It is changing the file; the changes show as a new version once it records them.',
  none: (agent) => html`Your feedback waits until ${agent} runs <code>suiko wait</code>. Tell it to, or paste the prompt into its chat.`,
});

/**
 * "Claude planned 2 changes. They go into the document when you apply them." (one sentence per line of source would
 * join words: htm drops whitespace that holds a newline, so the text is built as one string.)
 * @param {string} agent
 * @param {number} n
 */
export function plannedSentence(agent, n) {
  return n === 1
    ? `${agent} planned 1 change. It goes into the document when you apply it.`
    : `${agent} planned ${n} changes. They go into the document when you apply them.`;
}

export function TurnPill() {
  const s = useStore((st) => ({ ds: st.ds, version: st.version, short: st.medium || st.narrow }));
  if (!s.ds) return null;
  const t = turnInfo(s.ds, s.version);
  const presence = t.presence;
  const progress = t.progress && t.progress.stage !== 'ready' ? t.progress : null;
  // The label is the presence itself unless the turn says something else (your turn, apply, approved, closed).
  const ownLabel = t.kind !== presence.kind;
  const yours = t.kind === 'yours';
  const name = [t.label, ownLabel ? presence.label : '', progress ? progress.label : ''].filter(Boolean).join(', ');
  // "Apply N planned" looks like your turn (turn-yours: the accent pill): the next step is the reviewer's.
  const accent = yours || t.kind === 'apply' ? ' turn-yours' : '';
  // Visible: the presence sentence (or its short form below 1200 px), else the turn's own label; "Your turn" with its
  // count. Below 1024 px the CSS keeps only the dot (and the count).
  return html`<${Popover} label="Review status" kind="dialog" align="end" triggerClass=${`turn-pill turn-${t.kind}${accent}`}
    triggerProps=${{ 'data-testid': TESTID.turnPill, 'aria-label': name, title: `${name}. Details` }}
    trigger=${html`<span class=${`presence tone-${presence.tone}`} data-testid=${TESTID.presence} data-presence=${presence.kind}>
        <span class="dot" aria-hidden="true"></span>
        <span class=${ownLabel || s.short ? 'sr-only' : 'turn-text'}>${presence.label}</span>
      </span>
      ${ownLabel ? html`<span class="turn-text" aria-hidden="true">${yours ? 'Your turn' : s.short ? t.short : t.label}</span>`
        : s.short ? html`<span class="turn-text" aria-hidden="true">${presence.short}</span>` : null}
      ${yours ? html`<span class="turn-count" aria-hidden="true">${t.mine.count}</span>` : null}
      ${progress ? html`<span class="review-progress sr-only">${progress.label}</span>` : null}`}>
    <${TurnDetails} ds=${s.ds} version=${s.version} />
  <//>`;
}

/** @param {{ ds: any, version: number|'live'|null }} props */
function TurnDetails({ ds, version }) {
  const popover = usePopover();
  const t = turnInfo(ds, version);
  const agent = agentTitle(agentName(ds));
  const m = t.mine;
  /** @type {Array<[number, string]>} */
  const waiting = [
    [m.check, `${m.check === 1 ? 'answer' : 'answers'} to check`],
    [m.answer, `${m.answer === 1 ? 'question' : 'questions'} for you`],
    [m.lost, `${m.lost === 1 ? 'thread' : 'threads'} lost ${m.lost === 1 ? 'its' : 'their'} place`],
    [m.pending, `${m.pending === 1 ? 'reply' : 'replies'} not sent yet`],
    [m.drafts, `${m.drafts === 1 ? 'comment' : 'comments'} not sent yet`],
  ].filter(([n]) => n > 0);
  /** @type {Array<[string, string]>} the newest review's way, unless the version answering it says it all */
  const facts = [];
  const planned = t.planned;
  if (t.progress && t.progress.stage !== 'ready') facts.push(['Your last review', t.progress.label]);
  else if (t.round) facts.push(['Latest', `v${t.round.version} answers your last review`]);
  if (ds.doc.final) facts.push(['Final', `v${ds.doc.final.version}`]);
  const run = (/** @type {() => void} */ fn) => () => {
    popover?.close(true);
    fn();
  };
  return html`<div class="turn-details">
    <div class="turn-head">
      <span class=${`presence tone-${t.presence.tone}`}><span class="dot" aria-hidden="true"></span></span>
      <div>
        <strong>${t.presence.label}</strong>
        <p class="small muted">${PRESENCE_DETAIL[t.presence.kind]?.(agent) ?? ''}</p>
      </div>
    </div>
    ${facts.length ? html`<dl class="turn-facts small">${facts.map(([k, v]) => html`<dt key=${`${k}-t`}>${k}</dt><dd key=${`${k}-d`}>${v}</dd>`)}</dl>` : null}
    ${waiting.length ? html`<div class="turn-mine">
      <p class="turn-sub">Waiting for you</p>
      <ul class="small">${waiting.map(([n, what]) => html`<li key=${what}><span class="badge">${n}</span> ${what}</li>`)}</ul>
    </div>` : null}
    ${planned ? html`<p class="small turn-planned">${plannedSentence(agent, planned)}</p>` : null}
    <div class="turn-actions">
      ${m.count ? html`<button type="button" class="btn btn-sm btn-primary" onClick=${run(showMyTurn)}>Show my turn</button>` : null}
      ${planned && version !== 'live' ? html`<button type="button" class=${`btn btn-sm ${m.count ? '' : 'btn-primary'}`} data-apply-planned
        onClick=${run(() => applyPlanned())} title=${`${agent} makes the planned changes in one pass and records one version`}>Apply ${planned} planned</button>` : null}
      ${t.presence.kind === 'none' ? html`<button type="button" class="btn btn-sm" onClick=${run(copyAgentPrompt)}
        title=${`Paste it into ${agent}'s chat`}>Copy the prompt for ${agent}</button>` : null}
    </div>
  </div>`;
}
