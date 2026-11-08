// @ts-check
// The Send dialog (design 11.6; the top bar's "Send N" / "Approve"), titled after its verdict ("Send", or "Approve"
// for an approval): a summary, what happens next in plain words (Send feedback / Needs changes / Approve vN, each with
// a line saying what it means; values comment / changes_requested / approved), the drafts going out with jump links,
// locks added this round, the Approve options (Mark vN final, Mark N answered threads done), and, when the agent is
// not connected, the prompt to paste into its chat (Copy prompt; the text shown is the text copied). It starts on
// Needs changes when the review carries a Must fix comment, else on the "When I send drafts, start on" setting, on
// Approve when there is nothing to send, or on the verdict a palette command picked.
// - Approve: "Mark vN final" is ticked only when approving is the obvious next step (model.js approveReady), and what
//   the approval would leave pending shows as warning rows, each with its way out (model.js approveWarnings): planned
//   changes not in vN yet (Apply N), threads that still wait for the reviewer (Show), threads still with the agent,
//   and open Must fix threads. While a warning shows, Enter never approves: the focus starts on the first warning's
//   button (or Cancel), and only the Approve button itself sends the approval.
// - The review is about the version on screen. When a newer version exists (it arrived while the dialog was open,
//   or an older version is shown), Approve is refused with a way to review the newer version first.
// - The summary, verdict and options live in the store (submitForm): closing the dialog keeps them.
// - An open comment or reply that is not in the review yet is pointed out, since it stays behind.
// - A held Cmd/Ctrl+Enter in the summary acts once (its auto-repeat is ignored).

import { html, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { applyPlanned, boundDraft, closeDialog, focusItem, reviewChanges, showMyTurn, submitReview, toast, updateSubmitForm } from '../actions.js';
import {
  addressedThreads, agentName, agentPrompt, agentTitle, approveReady, approveWarnings, blockingOpen, clip, defaultVerdict,
  isComposerDirty, isReplyDirty, locksAddedThisRound, numericVersion, plainBody, staleApproveText, targetLabel,
} from '../model.js';
import { useStore } from '../state.js';
import { copyText } from '../util.js';
import { MarkdownTextarea } from './MarkdownTextarea.js';
import { Modal, Spinner } from './common.js';

/** The verdicts in plain words; `label` and `hint` get the version and the agent's name. */
const VERDICTS = /** @type {const} */ ([
  { value: 'comment', label: () => 'Send feedback', hint: (/** @type {string} */ agent) => `Your comments go to ${agent}; no decision yet.` },
  { value: 'changes_requested', label: () => 'Needs changes', hint: (/** @type {string} */ agent) => `${agent} should revise before you approve.` },
  { value: 'approved', label: (/** @type {number} */ v) => `Approve v${v}`, hint: () => 'This version is good to go.' },
]);

export function SubmitDialog() {
  const ds = useStore((s) => s.ds);
  const version = useStore((s) => s.version);
  const form = useStore((s) => s.submitForm);
  // a comment or reply being written that is not a draft of the review (one bound to a draft goes out with it)
  const openComment = useStore((s) => (s.composer && !boundDraft(s.composer) && isComposerDirty(s.composer) ? 'comment' : null));
  const openReply = useStore((s) => (s.reply && !boundDraft(s.reply) && isReplyDirty(s.reply, s.ds?.drafts) ? s.reply.threadId : null));
  const preferred = useStore((s) => s.prefs.defaultVerdict);
  // Nothing to send: the dialog is the top bar's Approve.
  const [initialVerdict] = useState(() => ((ds?.drafts?.items || []).length ? defaultVerdict(ds, preferred) : 'approved'));
  // Opening on an approval that would leave something pending: the focus starts on the first warning's button (else
  // Cancel), never where Enter would approve.
  const [initialFocus] = useState(() => ((form?.verdict ?? initialVerdict) === 'approved' && ds
    && (approveWarnings(ds, version).length || blockingOpen(ds).length) ? '[data-warning-action], [data-dialog-cancel]' : 'textarea'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  if (!ds) return null;
  const verdict = form?.verdict ?? initialVerdict;
  const body = form?.body ?? '';
  const markFinal = form?.markFinal ?? approveReady(ds, version);
  const resolveAddressed = form?.resolveAddressed ?? true;

  const items = ds.drafts?.items || [];
  const threadDrafts = items.filter((/** @type {any} */ d) => d.kind === 'thread');
  const replyDrafts = items.filter((/** @type {any} */ d) => d.kind !== 'thread');
  const locks = locksAddedThisRound(ds);
  const blocking = blockingOpen(ds);
  const addressed = addressedThreads(ds);
  const agent = agentTitle(agentName(ds));
  const listening = (ds.waiters || []).length > 0;
  const head = Number(ds.doc.head);
  const reviewed = numericVersion(ds, version);
  const stale = staleApproveText(ds, reviewed);
  const blocked = verdict === 'approved' && !!stale;
  const empty = !items.length && !body.trim() && verdict === 'comment';
  const prompt = agentPrompt(ds);
  const warnings = verdict === 'approved' ? approveWarnings(ds, version, { resolveAddressed }) : [];
  // something an approval would leave pending: only the Approve button itself approves
  const warned = verdict === 'approved' && (warnings.length > 0 || blocking.length > 0);

  const submit = async () => {
    if (busy || empty || blocked) return;
    setBusy(true);
    setError(null);
    const err = await submitReview({ verdict, body, markFinal, resolveAddressed });
    setBusy(false);
    if (err) setError(err);
  };
  /** @param {() => void} fn closes the dialog first (its summary and options are kept) */
  const leave = (fn) => () => {
    closeDialog();
    fn();
  };

  return html`<${Modal} title=${verdict === 'approved' ? 'Approve' : 'Send'} testid=${TESTID.submitReviewDialog} onClose=${closeDialog} wide=${true}
    initialFocus=${initialFocus}>
    <form class="submit-form" onSubmit=${(/** @type {Event} */ e) => { e.preventDefault(); submit(); }}
      onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
        // Enter in a field (a radio, a checkbox) submits the form by itself; past a warning only the Approve button does
        const el = /** @type {HTMLElement} */ (e.target);
        if (e.key === 'Enter' && warned && el.localName === 'input') e.preventDefault();
      }}>
      <label for="sr-summary" class="field-label">Summary</label>
      <${MarkdownTextarea} id="sr-summary" rows=${4} value=${body} placeholder="Overall feedback (Markdown, optional)"
        onInput=${(/** @type {any} */ e) => updateSubmitForm({ body: e.currentTarget.value })}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
          if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
          e.preventDefault();
          // a held key acts once; past a warning the keys never approve
          if (e.repeat) {
            e.stopPropagation();
            return;
          }
          if (!warned) submit();
        }} />

      <fieldset class="verdicts" data-testid=${TESTID.submitVerdict} role="radiogroup" aria-label="What happens next">
        <legend class="field-label">What happens next</legend>
        ${VERDICTS.map((v) => html`<label class=${`verdict verdict-${v.value} ${verdict === v.value ? 'on' : ''}`}>
          <input type="radio" name="verdict" value=${v.value} checked=${verdict === v.value}
            onChange=${() => updateSubmitForm({ verdict: v.value })} />
          <span><strong>${v.label(reviewed)}</strong><span class="small muted">${v.hint(agent)}</span></span>
        </label>`)}
      </fieldset>

      ${verdict === 'approved' ? html`<div class="approve-options">
        <label class="check"><input type="checkbox" checked=${markFinal} onChange=${(/** @type {any} */ e) => updateSubmitForm({ markFinal: e.currentTarget.checked })} />
          Mark v${reviewed} final</label>
        ${addressed.length ? html`<label class="check"><input type="checkbox" checked=${resolveAddressed}
          onChange=${(/** @type {any} */ e) => updateSubmitForm({ resolveAddressed: e.currentTarget.checked })} />
          Mark ${addressed.length} answered thread${addressed.length === 1 ? '' : 's'} done</label>` : null}
      </div>` : null}

      ${stale ? html`<div class=${blocked ? 'warning stale-warning' : 'small muted stale-note'} role=${blocked ? 'alert' : 'note'} data-stale-version=${head}>
        <span>${blocked ? stale : `v${head} is newer than the version you are viewing (v${reviewed}). Comments made on v${reviewed} are carried forward to it.`}</span>
        ${head > reviewed ? html` <button type="button" class="link-btn" onClick=${() => { closeDialog(); reviewChanges(head); }}>Review v${head}</button>` : null}
      </div>` : null}

      ${warnings.map((w) => html`<div class="warning approve-warning" role="note" data-warning=${w.key} key=${w.key}>
        <span>${w.label}</span>
        ${w.key === 'planned' && version !== 'live' ? html` <button type="button" class="btn btn-sm" data-warning-action
          title=${`${agent} makes the planned changes in one pass and records a new version`}
          onClick=${leave(() => applyPlanned())}>Apply ${w.count}</button>` : null}
        ${w.key === 'yours' ? html` <button type="button" class="btn btn-sm" data-warning-action title="The threads in Your turn"
          onClick=${leave(showMyTurn)}>Show</button>` : null}
      </div>`)}
      ${verdict === 'approved' && blocking.length ? html`<p class="warning" role="alert" data-warning="must-fix">
        ${blocking.length} Must fix thread${blocking.length > 1 ? 's are' : ' is'} still open (${blocking.map((/** @type {any} */ t) => t.id).join(', ')}).</p>` : null}

      ${items.length || locks.length || verdict !== 'approved' ? html`<section class="submit-section">
        <h3>Going out with it</h3>
        ${!items.length && !locks.length ? html`<p class="small muted">No drafts. ${verdict === 'comment' ? 'Write a summary or add comments first.' : ''}</p>` : null}
        ${items.length ? html`<ul class="draft-list">
          ${threadDrafts.map((/** @type {any} */ d) => html`<li key=${d.id}>
            <button type="button" class="link-btn" onClick=${() => { closeDialog(); focusItem(d.id); }}>
              ${d.severity === 'blocking' ? html`<span class="flag flag-must">Must fix</span> ` : null}${clip(targetLabel(d.anchor), 60)}</button>
            <span class="small muted">${clip(plainBody(d.body) || d.suggestion?.new || '', 80)}</span>
          </li>`)}
          ${replyDrafts.map((/** @type {any} */ d) => html`<li key=${d.id}>
            <button type="button" class="link-btn" onClick=${() => { closeDialog(); focusItem(d.thread); }}>
              ${d.kind === 'resolve' ? 'Mark done' : d.reopen ? 'Reopen' : 'Reply to'} ${d.thread}</button>
            <span class="small muted">${clip(plainBody(d.body) || d.decision || '', 80)}</span>
          </li>`)}
        </ul>` : null}
        ${locks.length ? html`<p class="small">Locks added this round: ${locks.map((/** @type {any} */ l) => l.id).join(', ')}</p>` : null}
      </section>` : null}

      ${openComment ? html`<p class="small warn-text" role="note">The comment you are writing is not in this review yet. Save it as a draft first, or it stays open after you send.</p>` : null}
      ${openReply ? html`<p class="small warn-text" role="note">Your reply on ${openReply} is not in this review yet. Save it first, or it stays open after you send.</p>` : null}

      ${listening ? html`<p class="small ok-text">${agent} is listening and gets it right away.</p>` : html`<div class="no-agent" role="note">
        <p><strong>${agent} isn't connected.</strong> Your feedback waits until ${agent} asks for it. After you send, paste this into ${agent}'s chat:</p>
        <code class="prompt">${prompt}</code>
        <button type="button" class="btn btn-sm" onClick=${async () => toast(await copyText(prompt) ? 'Prompt copied.' : 'Copy failed; select the text instead.', { timeout: 2500 })}>Copy prompt</button>
      </div>`}

      ${error ? html`<p class="error" role="alert">${error}</p>` : null}
      <div class="dialog-actions">
        <button type="button" class="btn" data-dialog-cancel onClick=${closeDialog}>Cancel</button>
        <button type="submit" class="btn btn-primary" data-testid=${TESTID.submitConfirm} disabled=${busy || empty || blocked}>
          ${busy ? html`<${Spinner} label="Sending" /> ` : null}${verdict === 'approved' ? `Approve v${reviewed}` : 'Send'}
        </button>
      </div>
    </form>
  <//>`;
}
