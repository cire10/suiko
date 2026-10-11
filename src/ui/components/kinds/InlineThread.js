// @ts-check
// A thread or new-thread draft shown inline in a code diff, under the line its anchor ends on (or at the top of its
// file card for a whole-file comment). A compact card: id, type / severity / status, the comments, a suggestion as
// old / new lines, and the main actions. Replies are written in the side panel's card (Reply focuses it there), so
// this card carries no testids of the panel cards.

import { html, useState } from 'preact-htm';
import { deleteDraft, editDraft, focusItem, resolveThread, startReply, unresolveThread } from '../../actions.js';
import { Markdown } from '../../markdown.js';
import { actorLabel, isAgent, isVerifiable, relTime, statusInfo, targetLabel } from '../../model.js';
import { Chip } from '../common.js';

const TYPE_LABEL = /** @type {Record<string, string>} */ ({ question: 'Question', suggestion: 'Suggestion', 'agent-question': 'Agent question' });

/**
 * @param {{ it: import('./code-model.js').PlacedItem, ds: any, agent: string, focused: boolean, canAct: boolean }} props
 */
export function InlineThread({ it, ds, agent, focused, canAct }) {
  const [open, setOpen] = useState(false);
  if (it.kind === 'draft') return html`<${InlineDraft} it=${it} focused=${focused} canAct=${canAct} />`;
  const t = it.item;
  const st = statusInfo(t, agent);
  const resolved = t.status === 'resolved';
  const expanded = !resolved || open || focused;
  const verifiable = isVerifiable(t, ds.drafts);
  const reply = () => {
    focusItem(t.id);
    startReply(t.id);
  };
  return html`<div class=${`cd-thread status-${st.key}${focused ? ' is-focused' : ''}${resolved ? ' is-resolved' : ''}`}
    data-inline-id=${t.id} role="group" aria-label=${`Thread ${t.id}, ${st.label}`}>
    <div class="cd-thread-head">
      <button type="button" class="link-btn tid" onClick=${() => focusItem(t.id)} title="Show in the threads panel">${t.id}</button>
      ${TYPE_LABEL[t.type] ? html`<${Chip} tone="info">${TYPE_LABEL[t.type]}<//>` : null}
      ${t.severity === 'blocking' ? html`<${Chip} tone="danger">Blocking<//>` : t.severity === 'nit' ? html`<${Chip} tone="muted">Nit<//>` : null}
      <${Chip} tone=${st.tone}>${st.label}<//>
      ${it.anchor?.state === 'changed' || it.anchor?.state === 'orphaned' ? html`<${Chip} tone="warn">${it.anchor.state === 'orphaned' ? 'Orphaned' : 'Outdated'}<//>` : null}
      <span class="cd-thread-target small muted">${targetLabel(it.anchor)}</span>
      ${resolved && !focused ? html`<button type="button" class="link-btn cd-thread-toggle" aria-expanded=${open ? 'true' : 'false'}
        onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'Show'}</button>` : null}
    </div>
    ${expanded ? html`
      <ol class="cd-comments">
        ${(t.comments || []).map((/** @type {any} */ c) => html`<li key=${c.id} class=${`cd-comment ${isAgent(c.by) ? 'by-agent' : 'by-human'}`}>
          <div class="cd-comment-head small">
            <strong>${actorLabel(c.by)}</strong>
            ${c.version ? html`<span class="muted">v${c.version}</span>` : null}
            ${c.status ? html`<span class="muted">${String(c.status).replace('_', ' ')}</span>` : null}
            <time class="muted" datetime=${c.at} title=${c.at}>${relTime(c.at)}</time>
          </div>
          <${Markdown} text=${c.body} class="comment-body" />
        </li>`)}
      </ol>
      ${t.suggestion ? html`<${SuggestionLines} s=${t.suggestion} />` : null}
      ${canAct ? html`<div class="cd-thread-actions">
        ${resolved
          ? html`<button type="button" class="btn btn-sm" onClick=${() => unresolveThread(t.id)}>Reopen</button>`
          : verifiable
            ? html`<button type="button" class="btn btn-sm btn-ok" onClick=${() => resolveThread(t.id)}>Accept</button>
              <button type="button" class="btn btn-sm" onClick=${() => { focusItem(t.id); startReply(t.id, { reopen: true }); }}>Reopen</button>`
            : html`<button type="button" class="btn btn-sm" onClick=${reply}>${t.status === 'needs_input' ? `Answer ${agent}` : 'Reply'}</button>
              <button type="button" class="btn btn-sm" onClick=${() => resolveThread(t.id)}>Resolve</button>`}
      </div>` : null}` : null}
  </div>`;
}

/** @param {{ it: import('./code-model.js').PlacedItem, focused: boolean, canAct: boolean }} props */
function InlineDraft({ it, focused, canAct }) {
  const d = it.item;
  return html`<div class=${`cd-thread is-draft${focused ? ' is-focused' : ''}`} data-inline-id=${d.id} role="group" aria-label=${`Draft ${d.id}`}>
    <div class="cd-thread-head">
      <button type="button" class="link-btn tid" onClick=${() => focusItem(d.id)} title="Show in the threads panel">${d.id}</button>
      <${Chip} tone="draft">Draft<//>
      ${TYPE_LABEL[d.type] ? html`<${Chip} tone="info">${TYPE_LABEL[d.type]}<//>` : null}
      ${d.severity === 'blocking' ? html`<${Chip} tone="danger">Blocking<//>` : d.severity === 'nit' ? html`<${Chip} tone="muted">Nit<//>` : null}
      <span class="cd-thread-target small muted">${targetLabel(it.anchor)}</span>
    </div>
    ${d.body ? html`<${Markdown} text=${d.body} class="comment-body" />` : null}
    ${d.suggestion ? html`<${SuggestionLines} s=${d.suggestion} />` : null}
    ${canAct ? html`<div class="cd-thread-actions">
      <button type="button" class="btn btn-sm" onClick=${() => editDraft(d.id)}>Edit</button>
      <button type="button" class="btn btn-sm" onClick=${() => deleteDraft(d.id)}>Delete</button>
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
