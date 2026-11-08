// @ts-check
// Thread and draft cards (design 11.5; calm review): one card per thread in the thread panel.
// - Top line: "#t3", ONE status chip that says whose turn it is (model.js statusInfo: With Claude, Will change, Claude
//   answered, Changed in v3 — check it, Claude didn't change it, Needs your answer, Lost its place, Done), a "Must
//   fix" flag for a blocking thread, a "?" for a question, "Nit" for a nit.
// - The anchor line: the quote on its own line (at most two lines; or what the anchor targets: a label for elements,
//   tables, sections, diagrams), the section muted under it, the source lines only in its tooltip; a click shows it
//   in the document. A thread that lost its place shows what the text was and is now.
// - The conversation: the messages as sanitised Markdown, with the agent's attachments (Attachments.js: pictures,
//   live HTML previews, "Use in doc"); a reviewer request shows as one compact line ("You asked Claude to make this
//   change", "You asked Claude to put chart.html in the document"). Then the reviewer's screenshots, a suggestion
//   block (Apply now), the change the agent made ("Show change", on request), a decision.
// - Actions: at most two buttons and a ⋯ menu (Menu.js), by state (cardActions):
//     With Claude: Reply · ⋯(Mark as done, Record as decision)
//     Claude answered / didn't change it / needs your answer: Reply · Done · ⋯(Reopen, Record as decision)
//     Changed in vN — check it: Looks good · Not yet · ⋯(Reply, Show change, Record as decision)
//     Will change (planned): Reply · ⋯(Apply this now, Mark as done)
//     Done: ⋯(Reopen)
//     Lost its place: Move here · Keep as general · ⋯(View on vN, Reply, Mark as done)
//   Looks good / Done carry TESTID.verifyAccept and Not yet / Reopen TESTID.verifyReopen (also as menu items).
//   While an action request is in flight (busy), its buttons are disabled so a double click cannot send it twice.
// - The reply box (TESTID.replyTextarea / replyAdd): its main button follows Settings > Send comments: "Send" (the
//   reply goes to the agent at once) or "Add to review" (a draft); the other way is the second button. A held
//   Cmd/Ctrl+Enter acts once (its auto-repeat is ignored). A Send that failed keeps the box open with the error.
//   Replies not sent yet show above it, with Edit / Delete (and Send); the one the box is editing (or a failed Send
//   created) says "Being edited below" and has no Send or Edit of its own: one copy of a reply, always.
// - "Record as decision…" opens a one-line input on the card (actions.js startDecision; kept in the store, so the card
//   stays listed while it is open, and a code review's inline card opens it here, also when this card is focused).
// - In the agent's "Planned changes" a planned thread that also waits for the reviewer (a reply not sent yet, a lost
//   anchor) says "Also waits for you".
// A new-thread draft (DraftCard): "Draft", its anchor and text; Send · Edit · ⋯(Delete) (when sending is batched:
// Edit · ⋯(Send now, Delete)); while the composer edits it (or a failed Send of the composer created it) it says
// "Being edited" and keeps only Delete. A draft made on another version than the one shown says so: it is not painted
// on this version (the daemon carries it forward when it is sent), and its line numbers refer to its own version.

import { html, useEffect, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { docApi } from '../api.js';
import {
  applyPlanned, applySuggestion, boundDraft, cancelDecision, cancelReply, compareVersions, deleteDraft, editDraft, focusItem,
  goToHunk, moveThread, resolveThread, revealTarget, sendDraft, setDecisionText, setReplyBody, startDecision, startReply,
  submitReply, switchVersion, unresolveThread,
} from '../actions.js';
import { KEYS, shortcut } from '../keys.js';
import { Markdown } from '../markdown.js';
import {
  actorLabel, agentName, agentTitle, anchorAt, anchorQuote, clip, draftVersion, isAgent, isHuman, isVerifiable, kindCaps,
  linesLabel, relTime, replyDraftsFor, replyKeyAction, sectionTail, statusInfo, systemLine, targetLabel, threadAttachmentName,
} from '../model.js';
import { store } from '../state.js';
import { contentUrl, scrollIntoViewSoft } from '../util.js';
import { AgentAttachments, Screenshots } from './Attachments.js';
import { MarkdownTextarea } from './MarkdownTextarea.js';
import { MenuItem, MenuSeparator, Popover } from './Menu.js';
import { Chip, Icon, WordDiff } from './common.js';

const SUGGESTION_STATUS = /** @type {Record<string, string>} */ ({ pending: 'Pending', staged: 'Staged', applied: 'Applied', conflict: 'Conflict' });

/** What an agent's reply did, as a few plain words after its name. */
const REPLY_WORDS = /** @type {Record<string, string>} */ ({
  addressed: 'changed it', answered: 'answered', declined: "didn't change it", planned: 'will change it',
});

/** Clicks on controls inside a card do not focus the card. @param {EventTarget|null} t */
function isControl(t) {
  const el = /** @type {Element|null} */ (t);
  return !!el?.closest?.('button, a, textarea, input, select, summary, label, details, iframe, [role="menu"]');
}

/** Scrolls a card into view when it becomes focused. @param {boolean} focused */
function useFocusScroll(focused) {
  const ref = useRef(/** @type {HTMLElement|null} */ (null));
  useEffect(() => {
    if (focused) scrollIntoViewSoft(ref.current);
  }, [focused]);
  return ref;
}

/**
 * Focuses a thread's card in the panel with its "Record as decision" input open (InlineThread's menu): the input
 * lives in the store (actions.js startDecision), so it opens whether or not the card was focused already.
 * @param {string} id
 */
export function requestDecision(id) {
  startDecision(id);
}

/**
 * @typedef {{ id: string, label: string, run: () => void, testid?: string, title?: string, disabled?: boolean,
 *   danger?: boolean }} CardAction
 */

/**
 * The actions of a thread card by its state (see the header): at most two buttons (`buttons`) and the rest in its
 * ⋯ menu (`menu`). The handlers come from the card: the panel card opens the reply box, the decision input and the
 * mini-diff itself; a code review's inline card hands them to the panel card. A thread whose anchor lost its place
 * while something else is its state (the agent answered it, say) keeps Move here / Keep as general in its menu.
 * @param {{ t: any, ds: any, version: number|'live'|null, agent: string, busy: boolean, stateKey: string,
 *   canShowChange: boolean, onReply: () => void, onReopen: () => void, onDecision: () => void, onShowChange: () => void }} p
 * @returns {{ buttons: CardAction[], menu: CardAction[] }}
 */
export function cardActions(p) {
  const out = threadActions(p);
  const a = anchorAt(p.t, p.version);
  if (p.stateKey !== 'lost' && p.t.status !== 'resolved' && a && (a.state === 'changed' || a.state === 'orphaned')) {
    out.menu.push(...relocate(p));
  }
  return out;
}

/**
 * Move here / Keep as general / View on vN: for a thread whose anchor lost its place.
 * @param {{ t: any, version: number|'live'|null, busy: boolean }} p
 * @returns {CardAction[]}
 */
function relocate({ t, version, busy }) {
  /** @type {CardAction[]} */
  const out = [
    { id: 'move', label: 'Move here', run: () => moveThread(t.id), disabled: busy, title: 'Anchor it to what is selected in the document now' },
    { id: 'general', label: 'Keep as general', run: () => moveThread(t.id, { kind: 'doc' }), disabled: busy, title: 'Make it a comment about the whole document' },
  ];
  if (t.createdIn && t.createdIn !== version) out.push({ id: 'view-on', label: `View on v${t.createdIn}`, run: () => switchVersion(Number(t.createdIn)) });
  return out;
}

/** cardActions without the lost-anchor extras. @param {Parameters<typeof cardActions>[0]} p @returns {{ buttons: CardAction[], menu: CardAction[] }} */
function threadActions(p) {
  const { t, version, busy } = p;
  const name = agentTitle(p.agent);
  /** @type {CardAction} */
  const reply = { id: 'reply', label: 'Reply', run: p.onReply, title: `Reply on this thread; ${name} answers here (r)` };
  /** @type {CardAction} */
  const done = { id: 'done', label: 'Mark as done', run: () => resolveThread(t.id), disabled: busy, title: 'Mark this thread done (x)' };
  /** @type {CardAction} */
  const decision = { id: 'decision', label: 'Record as decision…', run: p.onDecision, disabled: busy, title: 'Mark it done and record a one-line decision' };
  /** @type {CardAction} */
  const reopen = { id: 'reopen', label: 'Reopen…', run: p.onReopen, testid: TESTID.verifyReopen, title: 'Reopen with a reply: what still needs to change (o)' };
  /** @type {CardAction|null} */
  const showChange = p.canShowChange ? { id: 'show-change', label: 'Show change', run: p.onShowChange } : null;
  if (t.status === 'resolved') {
    return { buttons: [], menu: [{ id: 'reopen', label: 'Reopen', run: () => unresolveThread(t.id), disabled: busy, title: 'Back to where it was (o)' }] };
  }
  if (p.stateKey === 'lost') {
    const [move, general, ...view] = relocate(p);
    return { buttons: [move, general], menu: [...view, reply, done] };
  }
  if (t.status === 'planned') {
    return {
      buttons: [reply],
      menu: [{ id: 'apply', label: 'Apply this now', run: () => applyPlanned([t.id]), disabled: busy || version === 'live',
        title: `${name} makes this planned change now and records a version` }, done, decision],
    };
  }
  if (t.status === 'addressed' && isVerifiable(t, p.ds.drafts)) {
    return {
      buttons: [
        { id: 'accept', label: 'Looks good', run: () => resolveThread(t.id), testid: TESTID.verifyAccept, disabled: busy, title: 'Accept the change: the thread is done (x)' },
        { id: 'not-yet', label: 'Not yet', run: p.onReopen, testid: TESTID.verifyReopen, title: 'Reopen with a reply: what still needs to change (o)' },
      ],
      menu: [reply, ...(showChange ? [showChange] : []), decision],
    };
  }
  if (['addressed', 'answered', 'declined', 'needs_input'].includes(t.status)) {
    const doneLabel = t.status === 'declined' ? `Agree: leave it as it is (y)` : t.status === 'needs_input' ? 'No answer needed: mark it done (x)'
      : 'Accept: the thread is done (x)';
    return {
      buttons: [reply, { id: 'accept', label: 'Done', run: () => resolveThread(t.id), testid: TESTID.verifyAccept, disabled: busy, title: doneLabel }],
      menu: [...(t.status === 'needs_input' ? [] : [reopen]), ...(showChange ? [showChange] : []), decision],
    };
  }
  return { buttons: [reply], menu: [done, decision] };
}

/**
 * The card footer: the buttons and the ⋯ menu (data-action on each; the test ids of the panel's cards unless
 * `testids` is false: a code review's inline card).
 * @param {{ id: string, actions: { buttons: CardAction[], menu: CardAction[] }, busy?: boolean, testids?: boolean }} props
 */
export function CardActions({ id, actions, busy = false, testids = true }) {
  const { buttons, menu } = actions;
  if (!buttons.length && !menu.length) return null;
  return html`<footer class="card-actions" aria-busy=${busy ? 'true' : undefined}>
    ${buttons.map((a) => html`<button type="button" key=${a.id} class="btn btn-sm" data-testid=${testids ? a.testid : undefined}
      data-action=${a.id} disabled=${a.disabled} title=${a.title} onClick=${a.run}>${a.label}</button>`)}
    ${menu.length ? html`<${Popover} label=${`More actions for ${id}`} kind="menu" align="end" triggerClass="icon-btn icon-btn-sm card-more"
      triggerProps=${{ 'aria-label': `More actions for ${id}`, title: 'More actions', 'data-card-menu': id }} trigger=${html`<${Icon} name="more" />`}>
      ${menu.map((a, i) => html`${a.danger && i > 0 ? html`<${MenuSeparator} />` : null}<${MenuItem} key=${a.id} label=${a.label}
        data-action=${a.id} data-testid=${testids ? a.testid : undefined} disabled=${a.disabled} hint=${a.title}
        class=${a.danger ? 'danger' : ''} onSelect=${a.run} />`)}
    <//>` : null}
  </footer>`;
}

/**
 * @param {{ t: any, ds: any, version: number|'live'|null, agent: string, focused: boolean, reply: any,
 *   position: { state: string }|null, busy?: boolean, sendMode?: string, decision?: { threadId: string, text: string }|null,
 *   alsoYours?: boolean }} props reply / decision: the reply box and the "Record as decision…" input when they are
 *   open on this card; alsoYours: a planned thread listed under Planned changes that also waits for the reviewer
 */
export function ThreadCard({ t, ds, version, agent, focused, reply, position, busy = false, sendMode = 'now', decision = null, alsoYours = false }) {
  const ref = useFocusScroll(focused);
  const [showChange, setShowChange] = useState(false);
  const decisionRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const decisionOpen = !!decision && decision.threadId === t.id;
  const decisionText = decisionOpen ? String(decision?.text ?? '') : '';
  useEffect(() => {
    if (decisionOpen) decisionRef.current?.focus({ preventScroll: true });
  }, [decisionOpen]);
  const ctx = { drafts: ds.drafts, version };
  const a = anchorAt(t, version);
  const st = statusInfo(t, agent, ctx);
  const pendingReplies = replyDraftsFor(ds.drafts, t.id);
  // the reply draft the open box edits (or its failed Send created): one copy of it on screen, the box's
  const editing = reply ? boundDraft(reply) : null;
  const original = t.anchors?.[String(t.createdIn)] || null;
  const outdated = a && (a.state === 'changed' || a.state === 'orphaned');
  const lines = a?.src && a.kind !== 'doc' ? linesLabel(a.src) : '';
  const section = sectionTail(a?.section);
  const canShowChange = t.status === 'addressed' || a?.state === 'edited' || a?.state === 'changed' || !!a?.assetChanged;
  const canAct = version !== 'live';
  const hiddenState = position?.state === 'hidden' || position?.state === 'missing' ? position.state : null;
  const wasNow = !!(outdated && original?.quote?.exact && a?.quote?.exact && original.quote.exact !== a.quote.exact);
  const quote = wasNow ? '' : anchorQuote(a);
  const name = agentTitle(agent);

  /** @param {MouseEvent} e */
  const onClick = (e) => {
    if (!isControl(e.target)) focusItem(t.id);
  };
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      focusItem(t.id);
    }
  };
  const actions = cardActions({
    t, ds, version, agent, busy, stateKey: st.key, canShowChange,
    onReply: () => startReply(t.id),
    onReopen: () => startReply(t.id, { reopen: true }),
    onDecision: () => startDecision(t.id),
    onShowChange: () => setShowChange(true),
  });

  return html`<article ref=${ref} role="listitem" tabindex="0" data-testid=${TESTID.threadCard} data-thread-id=${t.id}
    data-status=${t.status} class=${`card status-${st.key} sev-${t.severity || 'normal'} ${focused ? 'is-focused' : ''}`}
    aria-current=${focused ? 'true' : undefined} aria-label=${`Thread ${t.id}, ${st.label}`} onClick=${onClick} onKeyDown=${onKeyDown}>
    <header class="card-head">
      <span class="tid">${t.id}</span>
      <${Chip} tone=${st.tone} class="status-chip" title=${st.title}>${st.label}<//>
      <${Flags} item=${t} agent=${name} />
      ${alsoYours ? html`<span class="flag flag-yours" data-also-yours title=${`${name} will make this change when you apply it; ${st.key === 'lost'
        ? 'its text also lost its place' : 'your reply is not sent yet'}`}>Also waits for you</span>` : null}
      ${hiddenState === 'hidden' ? html`<button type="button" class="link-btn reveal-btn" onClick=${() => revealTarget(t.id)}
        title="The anchor is inside collapsed or hidden content">Hidden: Reveal</button>` : null}
      ${hiddenState === 'missing' ? html`<span class="small warn-text" title="The anchor was not found in the rendered page">Not on page</span>` : null}
    </header>
    <${CardTarget} a=${a} lines=${lines} section=${section} quote=${quote} onShow=${() => focusItem(t.id)} />
    ${wasNow
      ? html`<div class="was-now"><div><span class="lbl">was</span> <q>${clip(original.quote.exact, 240)}</q></div>
          <div><span class="lbl">now</span> <q>${clip(a.quote.exact, 240)}</q></div></div>` : null}
    ${t.status === 'needs_input' && st.banner ? html`<div class="asked-banner" role="note"><strong>${st.banner}</strong>: reply to unblock the revision.</div>` : null}
    <ol class="comments">
      ${(t.comments || []).map((/** @type {any} */ c) => html`<${Message} key=${c.id} t=${t} c=${c} ds=${ds} agent=${agent}
        canUse=${canAct} busy=${busy} />`)}
    </ol>
    <${Screenshots} paths=${t.attachments} ds=${ds} />
    ${t.suggestion ? html`<${SuggestionBlock} t=${t} ds=${ds} canAct=${canAct} busy=${busy} />` : null}
    ${showChange && canShowChange ? html`<${MiniDiff} t=${t} ds=${ds} onClose=${() => setShowChange(false)} />` : null}
    ${t.decision ? html`<p class="decision"><${Chip} tone="ok">${t.decision.id || 'Decision'}<//> ${t.decision.text}</p>` : null}
    ${pendingReplies.map((/** @type {any} */ d) => (d.id === editing
      // the reply box below holds this draft: no second Send (or Edit) for it, only Delete
      ? html`<div class="pending-reply is-editing" key=${d.id} data-draft-id=${d.id}>
          <div class="pending-head"><${Chip} tone="draft">${d.reopen ? 'Reopen (draft)' : 'Reply (draft)'}<//>
            <span class="small muted being-edited">Being edited below</span>
            <span class="spacer"></span>
            <button type="button" class="link-btn danger" onClick=${() => deleteDraft(d.id)}>Delete</button></div>
        </div>`
      : html`<div class="pending-reply" key=${d.id} data-draft-id=${d.id}>
          <div class="pending-head"><${Chip} tone="draft">${d.reopen ? 'Reopen (draft)' : 'Reply (draft)'}<//>
            <span class="spacer"></span>
            ${sendMode !== 'batch' && canAct ? html`<button type="button" class="link-btn" disabled=${busy} onClick=${() => sendDraft(d.id)}
              title=${`Send this reply to ${name} now`}>Send</button>` : null}
            <button type="button" class="link-btn" onClick=${() => editDraft(d.id)}>Edit</button>
            <button type="button" class="link-btn danger" onClick=${() => deleteDraft(d.id)}>Delete</button></div>
          ${Array.isArray(d.use) && d.use.length ? html`<p class="system-line small"><${Icon} name="insert" size=${13} />
            Put ${d.use.map((/** @type {string} */ u) => threadAttachmentName(t, u)).join(', ')} in the document</p>` : null}
          <${Markdown} text=${d.body} class="comment-body" />
        </div>`))}
    ${reply ? html`<${ReplyBox} reply=${reply} t=${t} sendMode=${sendMode} agent=${agent} />` : null}
    ${!reply && canAct ? html`<${CardActions} id=${t.id} actions=${actions} busy=${busy} />` : null}
    ${decisionOpen && !reply ? html`<div class="decision-input" data-decision-input>
      <label for=${`dec-${t.id}`} class="small">Decision (one line, recorded when the thread is done)</label>
      <input ref=${decisionRef} id=${`dec-${t.id}`} type="text" value=${decisionText} placeholder="e.g. 30 s reuse-detection grace window"
        onInput=${(/** @type {any} */ e) => setDecisionText(e.currentTarget.value)}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Enter' && !e.repeat && decisionText.trim()) { e.preventDefault(); resolveThread(t.id, decisionText); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelDecision(); }
        }} />
      <div class="row">
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" onClick=${cancelDecision}>Cancel</button>
        <button type="button" class="btn btn-sm btn-primary" disabled=${busy || !decisionText.trim()}
          onClick=${() => resolveThread(t.id, decisionText)}>Record and mark done</button>
      </div>
    </div>` : null}
  </article>`;
}

/**
 * The small flags after the status chip: "Must fix" (blocking), "?" (a question), "Nit".
 * @param {{ item: any, agent?: string }} props a thread or a draft; agent: its name ("Claude")
 */
export function Flags({ item, agent = 'Claude' }) {
  return html`${item.severity === 'blocking' ? html`<span class="flag flag-must" title="Must fix: blocking">Must fix</span>` : null}
    ${item.type === 'question' || item.type === 'agent-question'
      ? html`<span class="flag flag-question" title=${item.type === 'agent-question' ? `A question from ${agentTitle(agent)}` : 'A question'}
        aria-label="Question">?</span>` : null}
    ${item.severity === 'nit' ? html`<span class="flag flag-nit" title="Nit: minor">Nit</span>` : null}`;
}

/**
 * One message of a thread: who, the version and when, the text (sanitised Markdown) and the agent's attachments. A
 * reviewer request (an Apply, a "Use in doc") is one compact line instead.
 * @param {{ t: any, c: any, ds: any, agent: string, canUse: boolean, busy?: boolean }} props
 */
function Message({ t, c, ds, agent, canUse, busy = false }) {
  const sys = systemLine(t, c, agent);
  if (sys) {
    return html`<li class=${`comment system system-${sys.kind}`}>
      <p class="system-line small"><${Icon} name=${sys.kind === 'use' ? 'insert' : 'check'} size=${13} />${sys.text}
        <time datetime=${c.at} title=${c.at}>${relTime(c.at)}</time></p>
      ${sys.body ? html`<${Markdown} text=${c.body} class="comment-body" />` : null}
    </li>`;
  }
  const agentSaid = isAgent(c.by);
  const who = agentSaid ? agentTitle(actorLabel(c.by)) : actorLabel(c.by);
  return html`<li class=${`comment ${agentSaid ? 'by-agent' : isHuman(c.by) ? 'by-human' : ''}`}>
    <div class="comment-head">
      <span class="avatar" aria-hidden="true">${String(who || '?').slice(0, 1)}</span>
      <strong>${who}</strong>
      ${agentSaid && c.status && REPLY_WORDS[c.status] ? html`<span class="comment-did">${REPLY_WORDS[c.status]}</span>` : null}
      ${c.version ? html`<span class="vtag">v${c.version}</span>` : null}
      <time datetime=${c.at} title=${c.at}>${relTime(c.at)}</time>
    </div>
    <${Markdown} text=${c.body} class="comment-body" />
    ${agentSaid ? html`<${AgentAttachments} comment=${c} ds=${ds} threadId=${t.id} canUse=${canUse} busy=${busy} />` : null}
  </li>`;
}

/**
 * The anchor line of a card: the quote on its own line (at most two lines), or what the anchor targets (a label, for
 * anchors that are not a text selection) and its text; the section muted on a line under it; the source lines only
 * in the tooltip (data-lines). A click shows it in the document.
 * @param {{ a: any, lines: string, section?: string, quote?: string, onShow?: () => void }} props
 */
function CardTarget({ a, lines, section = '', quote = '', onShow }) {
  // a code anchor's label names its file, side and lines ('src/a.js:L3-4', 'src/a.js (whole file)')
  if (a?.file?.path) {
    return html`<button type="button" class="card-target" onClick=${onShow} title="Show it in the diff">
      <span class="target-what"><span class="target-label">${targetLabel(a)}</span></span></button>`;
  }
  if (a?.kind === 'doc') {
    return html`<div class="card-target is-general"><span class="target-what"><span class="target-label">General comment</span></span></div>`;
  }
  const textual = !!a && (a.kind === 'text' || a.kind === 'code') && !!quote;
  const where = section && a?.kind !== 'section' ? `§${section}` : '';
  return html`<button type="button" class="card-target" onClick=${onShow} data-lines=${lines || undefined}
    title=${`Show it in the document${where || lines ? ` (${[where, lines].filter(Boolean).join(' ')})` : ''}`}>
    <span class="target-what">${textual ? null : html`<span class="target-label">${targetLabel(a)}</span>`}${quote
      ? html`${textual ? null : ' '}<span class="quote" data-anchor-quote>“${quote}”</span>` : null}</span>
    ${where ? html`<span class="target-section">${where}</span>` : null}
  </button>`;
}

/**
 * The reply box: the text, "Reopen the thread" for a thread the agent handed back, Cancel, and the two ways to send
 * it (the main one per Settings > Send comments: Send now, or Add to review; Cmd/Ctrl+Enter, Cmd/Ctrl+Shift+Enter for
 * the other). With "Ask before sending" a send asks first.
 * @param {{ reply: any, t: any, sendMode: string, agent: string }} props
 */
function ReplyBox({ reply, t, sendMode, agent }) {
  const ref = useRef(/** @type {HTMLTextAreaElement|null} */ (null));
  const confirmRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    if (reply.confirmSend) confirmRef.current?.focus({ preventScroll: true });
  }, [!!reply.confirmSend]);
  const batch = sendMode === 'batch';
  const name = agentTitle(agent);
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      // a held key repeats: only its first press acts (a repeat would answer "Ask before sending", or send twice)
      if (e.repeat) return;
      submitReply(replyKeyAction(e.shiftKey, sendMode) === 'send' ? { send: true } : {});
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (reply.confirmSend) store.set({ reply: { ...reply, confirmSend: false } });
      else cancelReply();
    }
  };
  const canReopen = t.status !== 'open' && t.status !== 'resolved';
  const disabled = reply.busy || !reply.body.trim();
  const send = html`<button type="button" class=${`btn btn-sm ${batch ? '' : 'btn-primary'}`} data-testid=${batch ? undefined : TESTID.replyAdd}
    disabled=${disabled} onClick=${() => submitReply({ send: true })}
    title=${`Send this reply to ${name} now (${shortcut(batch ? KEYS.sendNow : KEYS.add)})`}>${batch ? 'Send now' : 'Send'}</button>`;
  const save = html`<button type="button" class=${`btn btn-sm ${batch ? 'btn-primary' : ''}`} data-testid=${batch ? TESTID.replyAdd : undefined}
    disabled=${disabled} onClick=${() => submitReply()}
    title=${`Keep it as a draft of your review (${shortcut(batch ? KEYS.add : KEYS.sendNow)})`}>${batch ? 'Add to review' : 'Save as draft'}</button>`;
  return html`<div class="reply-box" onKeyDown=${onKeyDown}>
    <label class="sr-only" for=${`reply-${reply.threadId}`}>${reply.reopen ? 'Reopen with a reply' : 'Reply'}</label>
    <${MarkdownTextarea} inputRef=${ref} id=${`reply-${reply.threadId}`} testid=${TESTID.replyTextarea} rows=${3} value=${reply.body}
      placeholder=${reply.reopen ? 'What still needs to change? (Markdown)' : `Reply to ${name} (Markdown)`}
      onInput=${(/** @type {any} */ e) => setReplyBody(e.currentTarget.value)} />
    ${Array.isArray(reply.use) && reply.use.length ? html`<p class="system-line small"><${Icon} name="insert" size=${13} />
      Asks ${name} to put ${reply.use.map((/** @type {string} */ u) => threadAttachmentName(t, u)).join(', ')} in the document</p>` : null}
    ${reply.error && !reply.busy ? html`<p class="error small reply-error" role="alert">${reply.error}</p>` : null}
    ${reply.confirmSend && !reply.busy ? html`<div class="confirm-send" role="alertdialog" aria-label="Send this reply now?" data-confirm-send>
      <span class="small">Send this reply to ${name} now?</span>
      <span class="row">
        <button ref=${confirmRef} type="button" class="btn btn-sm btn-primary" onClick=${() => submitReply({ send: true, confirmed: true })}>Send</button>
        <button type="button" class="btn btn-sm" onClick=${() => { store.set({ reply: { ...reply, confirmSend: false } }); ref.current?.focus(); }}>Not yet</button>
      </span>
    </div>` : null}
    <div class="row reply-actions">
      ${canReopen ? html`<label class="check small" title=${`Back to ${name}: the thread is open again`}><input type="checkbox" checked=${reply.reopen}
        onChange=${(/** @type {any} */ e) => store.set({ reply: { ...reply, reopen: e.currentTarget.checked } })} /> Reopen</label>` : null}
      <span class="reply-send">
        <button type="button" class="btn btn-sm btn-ghost" onClick=${cancelReply}>Cancel</button>
        ${batch ? html`${send}${save}` : html`${save}${send}`}
      </span>
    </div>
  </div>`;
}

/** @param {{ t: any, ds: any, canAct: boolean, busy?: boolean }} props */
function SuggestionBlock({ t, ds, canAct, busy = false }) {
  const sug = t.suggestion;
  const status = sug.status === 'applied' && sug.appliedIn ? `Applied in v${sug.appliedIn}` : SUGGESTION_STATUS[sug.status] || sug.status || 'Pending';
  const clean = !ds.working?.dirty;
  const oldLines = String(sug.old ?? '').split('\n');
  const newLines = String(sug.new ?? '').split('\n');
  return html`<div class="suggestion-block">
    <div class="suggestion-head"><strong>Suggestion</strong> <${Chip} tone=${sug.status === 'conflict' ? 'danger' : sug.status === 'applied' ? 'ok' : 'muted'}>${status}<//>
      <span class="small muted">${sug.mode === 'source' ? 'source lines' : sug.mode === 'lines' ? sug.file || 'lines' : 'text'}${sug.startLine ? ` · ${linesLabel([sug.startLine, sug.endLine])}` : ''}</span></div>
    ${sug.mode === 'text' && oldLines.length === 1 && newLines.length === 1
      ? html`<${WordDiff} before=${sug.old} after=${sug.new} class="mono" />`
      : html`<pre class="diff-lines">${oldLines.map((l) => html`<span class="del">- ${l}\n</span>`)}${newLines.map((l) => html`<span class="ins">+ ${l}\n</span>`)}</pre>`}
    ${canAct && kindCaps(ds).applyNow && t.status !== 'resolved' && (sug.status === 'pending' || sug.status === 'conflict') ? html`<div class="card-actions">
      <button type="button" class="btn btn-sm" disabled=${!clean || busy} onClick=${() => applySuggestion(t.id)}
        title=${clean ? 'Apply the suggestion to the file and record a version' : 'The working copy has unrecorded changes'}>Apply now</button>
    </div>` : null}
  </div>`;
}

/**
 * "Show change" (a card's ⋯ menu): the before / after of the thread's anchor (design 8.8, amendments 4.5), fetched
 * when it opens; "View in Changes" goes to the linked change.
 * @param {{ t: any, ds: any, onClose: () => void }} props
 */
function MiniDiff({ t, ds, onClose }) {
  const [state, setState] = useState(/** @type {{ loading: boolean, data: any, error: string|null, key: string }} */ ({ loading: false, data: null, error: null, key: '' }));
  const key = `${t.id}:${t.updatedAt}:${ds.doc.head}`;
  useEffect(() => {
    if (state.key === key) return;
    setState({ loading: true, data: null, error: null, key });
    const r = store.get().route;
    if (r.view !== 'doc') return;
    docApi(r.ws, r.doc).miniDiff(t.id)
      .then((data) => setState({ loading: false, data, error: null, key }))
      .catch((err) => setState({ loading: false, data: null, error: String(err?.message || err), key }));
  }, [key]);
  const links = (t.changes || []).filter((/** @type {any} */ c) => c.hunk);
  const last = links[links.length - 1];
  const d = state.data;
  return html`<section class="minidiff" aria-label="The change">
    <div class="minidiff-head">
      <strong class="small">The change${last ? html` <span class="muted">(${last.hunk} in v${last.version})</span>` : null}</strong>
      <span class="spacer"></span>
      <button type="button" class="icon-btn icon-btn-xs" aria-label="Hide the change" title="Hide the change" onClick=${onClose}><${Icon} name="close" size=${14} /></button>
    </div>
    ${state.loading ? html`<p class="small muted">Loading…</p>` : null}
    ${state.error ? html`<p class="small error">${state.error}</p>` : null}
    ${d && d.kind === 'image' ? html`<div class="img-pair">
      <figure>${contentUrl(ds.contentBase, d.beforeUrl)
        ? html`<img src=${contentUrl(ds.contentBase, d.beforeUrl)} alt="Before" loading="lazy" referrerpolicy="no-referrer" />`
        : html`<span class="muted small">(none)</span>`}<figcaption>Before${d.from ? ` (v${d.from})` : ''}</figcaption></figure>
      <figure>${contentUrl(ds.contentBase, d.afterUrl)
        ? html`<img src=${contentUrl(ds.contentBase, d.afterUrl)} alt="After" loading="lazy" referrerpolicy="no-referrer" />`
        : html`<span class="muted small">(removed)</span>`}<figcaption>After${d.version ? ` (v${d.version})` : ''}</figcaption></figure>
    </div>` : null}
    ${d && d.kind !== 'image' ? html`
      ${d.before === d.after
        ? html`<p class="small muted">No text change at the anchor${d.from && d.version ? ` between v${d.from} and v${d.version}` : ''}.</p>`
        : Array.isArray(d.words) && d.words.length
          ? html`<${WordDiff} parts=${d.words.map((/** @type {any} */ w) => ({ op: w.op, text: w.text }))} class="mono" />`
          : html`<${WordDiff} before=${d.before || ''} after=${d.after || ''} class="mono" />`}
      ${d.from && d.version && d.from !== d.version ? html`<p class="small muted">v${d.from} → v${d.version}</p>` : null}` : null}
    ${last ? html`<button type="button" class="link-btn" onClick=${() => {
      const to = Number(last.version);
      compareVersions(Math.max(1, to - 1), to);
      setTimeout(() => goToHunk(String(last.hunk)), 0);
    }}>View in Changes</button>` : null}
  </section>`;
}

/**
 * A new-thread draft of the pending review.
 * @param {{ d: any, focused: boolean, version?: number|'live'|null, shown?: boolean, ds?: any, busy?: boolean,
 *   sendMode?: string, editing?: boolean }} props version: the version shown; shown: whether the doc paints this draft
 *   on it; ds: DocState (attachment thumbnails); editing: the composer holds this draft (it edits it, or its failed
 *   Send created it): the card says so and keeps only Delete, so the comment can never go out twice
 */
export function DraftCard({ d, focused, version = null, shown = true, ds = null, busy = false, sendMode = 'now', editing = false }) {
  const ref = useFocusScroll(focused);
  const a = d.anchor;
  const lines = a?.src && a.kind !== 'doc' ? linesLabel(a.src) : '';
  const dv = draftVersion(d);
  // Written on another version: its line numbers are that version's.
  const elsewhere = dv != null && version != null && dv !== version && a?.kind !== 'doc';
  const where = version === 'live' ? 'the working copy' : `v${version}`;
  // A suggestion shows the replaced text in its word diff already.
  const quote = d.suggestion ? '' : anchorQuote(a);
  const canAct = version !== 'live';
  const batch = sendMode === 'batch';
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    if (!isControl(e.target)) focusItem(d.id);
  };
  /** @type {CardAction} */
  const send = { id: 'send', label: batch ? 'Send now' : 'Send', run: () => sendDraft(d.id), disabled: busy || !canAct,
    title: `Send this comment to ${agentTitle(agentName(ds))} now, on its own` };
  /** @type {CardAction} */
  const edit = { id: 'edit', label: 'Edit', run: () => editDraft(d.id), disabled: busy };
  /** @type {CardAction} */
  const del = { id: 'delete', label: 'Delete', run: () => deleteDraft(d.id), disabled: busy, danger: true };
  const actions = editing ? { buttons: [], menu: [del] }
    : batch ? { buttons: [edit], menu: [send, del] } : { buttons: [send, edit], menu: [del] };
  return html`<article ref=${ref} role="listitem" tabindex="0" data-testid=${TESTID.threadCard} data-draft-id=${d.id} data-status="draft"
    class=${`card status-draft sev-${d.severity || 'normal'} ${focused ? 'is-focused' : ''} ${editing ? 'is-editing' : ''}`}
    aria-current=${focused ? 'true' : undefined} aria-label=${`Draft ${d.id}${editing ? ', being edited' : ''}`} onClick=${onClick}>
    <header class="card-head">
      <${Chip} tone="draft" class="status-chip" title="Not sent yet">Draft<//>
      <${Flags} item=${d} agent=${agentName(ds)} />
      ${editing ? html`<span class="small muted being-edited" title="The comment box at the top of the panel holds it: send or save it there">Being edited</span>` : null}
      ${elsewhere ? html`<span class=${`flag draft-version ${shown ? '' : 'is-warn'}`}
        title=${`Written on v${dv}${shown ? '' : `; not shown on ${where}`}. It is carried forward to the latest version when you send it.`}>On v${dv}</span>` : null}
    </header>
    <${CardTarget} a=${a} lines=${elsewhere && lines ? `v${dv} ${lines}` : lines} section=${sectionTail(a?.section)} quote=${quote}
      onShow=${() => focusItem(d.id)} />
    ${d.body ? html`<${Markdown} text=${d.body} class="comment-body" />` : null}
    ${d.suggestion ? html`<${WordDiff} before=${d.suggestion.old} after=${d.suggestion.new} class="mono" />` : null}
    <${Screenshots} paths=${d.attachments} ds=${ds} />
    ${canAct ? html`<${CardActions} id=${d.id} actions=${actions} busy=${busy} />` : null}
  </article>`;
}
