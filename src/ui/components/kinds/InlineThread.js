// @ts-check
// A thread or new-thread draft shown inline in a code diff, under the line its anchor ends on (or at the top of its
// file card for a whole-file comment). A compact card with the same states as the panel's (ThreadCard.js): the id,
// ONE status chip (model.js statusInfo) with the Must fix / ? / Nit flags, the messages (the agent's attachments with
// "Use in doc"; a reviewer request as one compact line), a suggestion as old / new lines, and the same actions
// (cardActions: at most two buttons and a ⋯ menu). Replies, "Not yet" / "Reopen" and "Record as decision" are written
// in the side panel's card (they focus it there; the decision input opens there even when that card is focused
// already), and this card carries no testids of the panel cards (its buttons have data-action). A thread marked done
// collapses to its head line (Show opens it). A draft the composer holds (it edits it, or its failed Send created it)
// says "Being edited" and keeps only Delete, like the panel's card.

import { html, useState } from 'preact-htm';
import { boundDraft, deleteDraft, editDraft, focusItem, sendDraft, startReply } from '../../actions.js';
import { Markdown } from '../../markdown.js';
import { actorLabel, agentName, agentTitle, isAgent, relTime, sendModeOf, statusInfo, systemLine, targetLabel } from '../../model.js';
import { useStore } from '../../state.js';
import { AgentAttachments } from '../Attachments.js';
import { CardActions, cardActions, Flags, requestDecision } from '../ThreadCard.js';
import { Chip, Icon } from '../common.js';

/**
 * @param {{ it: import('./code-model.js').PlacedItem, ds: any, agent: string, focused: boolean, canAct: boolean }} props
 */
export function InlineThread({ it, ds, agent, focused, canAct }) {
  const [open, setOpen] = useState(false);
  const version = useStore((s) => s.version);
  const busy = useStore((s) => s.busyThreads.includes(it.id));
  if (it.kind === 'draft') return html`<${InlineDraft} it=${it} focused=${focused} canAct=${canAct} busy=${busy} />`;
  const t = it.item;
  const st = statusInfo(t, agent, { drafts: ds.drafts, version });
  const resolved = t.status === 'resolved';
  const expanded = !resolved || open || focused;
  /** In the side panel's card: the reply box (reopening it, for Not yet / Reopen). @param {boolean} reopen */
  const reply = (reopen) => {
    focusItem(t.id);
    startReply(t.id, reopen ? { reopen: true } : {});
  };
  const actions = cardActions({
    t, ds, version, agent, busy, stateKey: st.key, canShowChange: false,
    onReply: () => reply(false),
    onReopen: () => reply(true),
    onDecision: () => requestDecision(t.id),
    onShowChange: () => focusItem(t.id),
  });
  return html`<div class=${`cd-thread status-${st.key}${focused ? ' is-focused' : ''}${resolved ? ' is-resolved' : ''}`}
    data-inline-id=${t.id} role="group" aria-label=${`Thread ${t.id}, ${st.label}`}>
    <div class="cd-thread-head">
      <button type="button" class="link-btn tid" onClick=${() => focusItem(t.id)} title="Show in the threads panel">${t.id}</button>
      <${Chip} tone=${st.tone} title=${st.title}>${st.label}<//>
      <${Flags} item=${t} agent=${agent} />
      <span class="cd-thread-target small muted">${targetLabel(it.anchor)}</span>
      ${resolved && !focused ? html`<button type="button" class="link-btn cd-thread-toggle" aria-expanded=${open ? 'true' : 'false'}
        onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'Show'}</button>` : null}
    </div>
    ${expanded ? html`
      <ol class="cd-comments">
        ${(t.comments || []).map((/** @type {any} */ c) => {
          const sys = systemLine(t, c, agent);
          if (sys) {
            return html`<li key=${c.id} class="cd-comment system"><p class="system-line small">
              <${Icon} name=${sys.kind === 'use' ? 'insert' : 'check'} size=${13} />${sys.text}</p>
              ${sys.body ? html`<${Markdown} text=${c.body} class="comment-body" />` : null}</li>`;
          }
          return html`<li key=${c.id} class=${`cd-comment ${isAgent(c.by) ? 'by-agent' : 'by-human'}`}>
            <div class="cd-comment-head small">
              <strong>${isAgent(c.by) ? agentTitle(actorLabel(c.by)) : actorLabel(c.by)}</strong>
              ${c.version ? html`<span class="muted">v${c.version}</span>` : null}
              <time class="muted" datetime=${c.at} title=${c.at}>${relTime(c.at)}</time>
            </div>
            <${Markdown} text=${c.body} class="comment-body" />
            ${isAgent(c.by) ? html`<${AgentAttachments} comment=${c} ds=${ds} threadId=${t.id} canUse=${canAct} busy=${busy} compact=${true} />` : null}
          </li>`;
        })}
      </ol>
      ${t.suggestion ? html`<${SuggestionLines} s=${t.suggestion} />` : null}
      ${canAct ? html`<div class="cd-thread-actions"><${CardActions} id=${t.id} actions=${actions} busy=${busy} testids=${false} /></div>` : null}` : null}
  </div>`;
}

/** @param {{ it: import('./code-model.js').PlacedItem, focused: boolean, canAct: boolean, busy?: boolean }} props */
function InlineDraft({ it, focused, canAct, busy = false }) {
  const d = it.item;
  const batch = useStore((s) => sendModeOf(s) === 'batch');
  const agent = useStore((s) => agentTitle(agentName(s.ds)));
  // the composer holds this draft: one copy of the comment, so no Send or Edit of its own here
  const editing = useStore((s) => boundDraft(s.composer) === d.id);
  const send = { id: 'send', label: batch ? 'Send now' : 'Send', run: () => sendDraft(d.id), disabled: busy, title: `Send this comment to ${agent} now, on its own` };
  const edit = { id: 'edit', label: 'Edit', run: () => editDraft(d.id), disabled: busy };
  const del = { id: 'delete', label: 'Delete', run: () => deleteDraft(d.id), disabled: busy, danger: true };
  const actions = editing ? { buttons: [], menu: [del] } : batch ? { buttons: [edit], menu: [send, del] } : { buttons: [send, edit], menu: [del] };
  return html`<div class=${`cd-thread is-draft${focused ? ' is-focused' : ''}`} data-inline-id=${d.id} role="group" aria-label=${`Draft ${d.id}`}>
    <div class="cd-thread-head">
      <button type="button" class="link-btn tid" onClick=${() => focusItem(d.id)} title="Show in the threads panel">${d.id}</button>
      <${Chip} tone="draft" title="Not sent yet">Draft<//>
      <${Flags} item=${d} agent=${agent} />
      ${editing ? html`<span class="small muted being-edited">Being edited</span>` : null}
      <span class="cd-thread-target small muted">${targetLabel(it.anchor)}</span>
    </div>
    ${d.body ? html`<${Markdown} text=${d.body} class="comment-body" />` : null}
    ${d.suggestion ? html`<${SuggestionLines} s=${d.suggestion} />` : null}
    ${canAct ? html`<div class="cd-thread-actions">
      <${CardActions} id=${d.id} actions=${actions} busy=${busy} testids=${false} />
    </div>` : null}
  </div>`;
}

/** A suggestion as the lines it replaces and the lines it suggests. @param {{ s: any }} props */
function SuggestionLines({ s }) {
  const old = String(s.old ?? '').split('\n');
  const next = String(s.new ?? '').split('\n');
  return html`<div class="cd-suggestion">
    <div class="cd-suggestion-head small muted">Suggested change${s.status && s.status !== 'pending' ? ` (${s.status})` : ''}</div>
    <pre class="cd-suggestion-body">${old.map((l, i) => html`<div class="cd-sug-del" key=${`d${i}`}><span aria-hidden="true">− </span>${l}</div>`)}${next.map((l, i) => html`<div class="cd-sug-ins" key=${`i${i}`}><span aria-hidden="true">+ </span>${l}</div>`)}</pre>
  </div>`;
}
