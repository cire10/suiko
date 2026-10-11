// @ts-check
// Submit review (design 11.6): verdict (Comment / Request changes / Approve; it starts on Request changes when the
// review carries a blocking comment), a summary, the drafts going out with
// jump links, locks added this round, the Approve options (Mark vN final, Resolve N addressed threads), a warning
// about open blocking threads, and, when no agent is listening, a Copy prompt button for the chat.
// - The review is about the version on screen. When a newer version exists (it arrived while the dialog was open,
//   or an older version is shown), Approve is refused with a way to review the newer version first.
// - The summary, verdict and options live in the store (submitForm): closing the dialog keeps them.
// - An open comment or reply that is not in the review yet is pointed out, since it stays behind.

import { html, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { closeDialog, focusItem, reviewChanges, submitReview, toast, updateSubmitForm } from '../actions.js';
import {
  addressedThreads, agentName, blockingOpen, clip, defaultVerdict, isComposerDirty, isReplyDirty, locksAddedThisRound,
  numericVersion, staleApproveText, targetLabel,
} from '../model.js';
import { useStore } from '../state.js';
import { copyText } from '../util.js';
import { Chip, Modal, Spinner } from './common.js';

const VERDICTS = /** @type {const} */ ([
  { value: 'comment', label: 'Comment', hint: 'Feedback without a decision.' },
  { value: 'changes_requested', label: 'Request changes', hint: 'The agent should revise before you approve.' },
  { value: 'approved', label: 'Approve', hint: 'The spec is good to go.' },
]);

export function SubmitDialog() {
  const ds = useStore((s) => s.ds);
  const version = useStore((s) => s.version);
  const form = useStore((s) => s.submitForm);
  const openComment = useStore((s) => (s.composer && !s.composer.draftId && isComposerDirty(s.composer) ? 'comment' : null));
  const openReply = useStore((s) => (s.reply && !s.reply.draftId && isReplyDirty(s.reply, s.ds?.drafts) ? s.reply.threadId : null));
  const [initialVerdict] = useState(() => defaultVerdict(ds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  if (!ds) return null;
  const verdict = form?.verdict ?? initialVerdict;
  const body = form?.body ?? '';
  const markFinal = form?.markFinal ?? true;
  const resolveAddressed = form?.resolveAddressed ?? true;

  const items = ds.drafts?.items || [];
  const threadDrafts = items.filter((/** @type {any} */ d) => d.kind === 'thread');
  const replyDrafts = items.filter((/** @type {any} */ d) => d.kind !== 'thread');
  const locks = locksAddedThisRound(ds);
  const blocking = blockingOpen(ds);
  const addressed = addressedThreads(ds);
  const agent = agentName(ds);
  const listening = (ds.waiters || []).length > 0;
  const head = Number(ds.doc.head);
  const reviewed = numericVersion(ds, version);
  const stale = staleApproveText(ds, reviewed);
  const blocked = verdict === 'approved' && !!stale;
  const empty = !items.length && !body.trim() && verdict === 'comment';
  const prompt = `Run \`specreview feedback ${ds.doc.id}\` and address it.`;

  const submit = async () => {
    if (busy || empty || blocked) return;
    setBusy(true);
    setError(null);
    const err = await submitReview({ verdict, body, markFinal, resolveAddressed });
    setBusy(false);
    if (err) setError(err);
  };

  return html`<${Modal} title="Submit review" testid=${TESTID.submitReviewDialog} onClose=${closeDialog} wide=${true}
    initialFocus="textarea">
    <form class="submit-form" onSubmit=${(/** @type {Event} */ e) => { e.preventDefault(); submit(); }}>
      <label for="sr-summary" class="field-label">Summary</label>
      <textarea id="sr-summary" rows="3" value=${body} placeholder="Overall feedback (Markdown, optional)"
        onInput=${(/** @type {any} */ e) => updateSubmitForm({ body: e.currentTarget.value })}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); } }}></textarea>

      <fieldset class="verdicts" data-testid=${TESTID.submitVerdict} role="radiogroup" aria-label="Verdict">
        <legend class="field-label">Verdict</legend>
        ${VERDICTS.map((v) => html`<label class=${`verdict verdict-${v.value} ${verdict === v.value ? 'on' : ''}`}>
          <input type="radio" name="verdict" value=${v.value} checked=${verdict === v.value}
            onChange=${() => updateSubmitForm({ verdict: v.value })} />
          <span><strong>${v.label}</strong><span class="small muted">${v.hint}</span></span>
        </label>`)}
      </fieldset>

      ${verdict === 'approved' ? html`<div class="approve-options">
        <label class="check"><input type="checkbox" checked=${markFinal} onChange=${(/** @type {any} */ e) => updateSubmitForm({ markFinal: e.currentTarget.checked })} />
          Mark v${reviewed} final</label>
        <label class="check"><input type="checkbox" checked=${resolveAddressed} onChange=${(/** @type {any} */ e) => updateSubmitForm({ resolveAddressed: e.currentTarget.checked })} />
          Resolve ${addressed.length} addressed thread${addressed.length === 1 ? '' : 's'}</label>
      </div>` : null}

      ${stale ? html`<div class=${blocked ? 'warning stale-warning' : 'small muted stale-note'} role=${blocked ? 'alert' : 'note'} data-stale-version=${head}>
        <span>${blocked ? stale : `v${head} is newer than the version you are viewing (v${reviewed}). Comments made on v${reviewed} are carried forward to it.`}</span>
        ${head > reviewed ? html` <button type="button" class="link-btn" onClick=${() => { closeDialog(); reviewChanges(head); }}>Review v${head}</button>` : null}
      </div>` : null}

      ${verdict === 'approved' && blocking.length ? html`<p class="warning" role="alert">
        ${blocking.length} blocking thread${blocking.length > 1 ? 's are' : ' is'} still open (${blocking.map((/** @type {any} */ t) => t.id).join(', ')}).</p>` : null}

      <section class="submit-section">
        <h3>Going out with this review</h3>
        ${!items.length && !locks.length ? html`<p class="small muted">No drafts. ${verdict === 'comment' ? 'Write a summary or add comments first.' : ''}</p>` : null}
        ${items.length ? html`<ul class="draft-list">
          ${threadDrafts.map((/** @type {any} */ d) => html`<li key=${d.id}>
            <button type="button" class="link-btn" onClick=${() => { closeDialog(); focusItem(d.id); }}>
              ${d.severity === 'blocking' ? html`<${Chip} tone="danger">Blocking<//> ` : null}${clip(targetLabel(d.anchor), 60)}</button>
            <span class="small muted">${clip(d.body || d.suggestion?.new || '', 80)}</span>
          </li>`)}
          ${replyDrafts.map((/** @type {any} */ d) => html`<li key=${d.id}>
            <button type="button" class="link-btn" onClick=${() => { closeDialog(); focusItem(d.thread); }}>
              ${d.kind === 'resolve' ? 'Resolve' : d.reopen ? 'Reopen' : 'Reply to'} ${d.thread}</button>
            <span class="small muted">${clip(d.body || d.decision || '', 80)}</span>
          </li>`)}
        </ul>` : null}
        ${locks.length ? html`<p class="small">Locks added this round: ${locks.map((/** @type {any} */ l) => l.id).join(', ')}</p>` : null}
      </section>

      ${openComment ? html`<p class="small warn-text" role="note">The comment you are writing is not in this review yet. Add it to the review first, or it stays open after you submit.</p>` : null}
      ${openReply ? html`<p class="small warn-text" role="note">Your reply on ${openReply} is not in this review yet. Add it first, or it stays open after you submit.</p>` : null}

      ${listening ? html`<p class="small ok-text">${agent} is listening and receives the review right away.</p>` : html`<div class="no-agent" role="note">
        <p><strong>No agent is listening.</strong> After submitting, tell ${agent} "review submitted".</p>
        <button type="button" class="btn btn-sm" onClick=${async () => toast(await copyText(prompt) ? 'Prompt copied.' : 'Copy failed; select the text instead.', { timeout: 2500 })}>Copy prompt</button>
        <code class="prompt">${prompt}</code>
      </div>`}

      ${error ? html`<p class="error" role="alert">${error}</p>` : null}
      <div class="dialog-actions">
        <button type="button" class="btn" onClick=${closeDialog}>Cancel</button>
        <button type="submit" class="btn btn-primary" data-testid=${TESTID.submitConfirm} disabled=${busy || empty || blocked}>
          ${busy ? html`<${Spinner} label="Submitting" /> ` : null}${verdict === 'approved' ? 'Approve' : verdict === 'changes_requested' ? 'Request changes' : 'Submit review'}
        </button>
      </div>
    </form>
  <//>`;
}
