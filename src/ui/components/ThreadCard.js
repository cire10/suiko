// @ts-check
// Thread and draft cards (design 11.5).
// Header: id, type / severity chips, status chip, anchor-state chip, target label.
// Body: the quote ("was ... / now ..." when outdated), comments as sanitised Markdown, a suggestion block, and a
// collapsible mini-diff.
// Actions depend on the state: Reply / Resolve for open threads; Accept (+ optional decision) / Reopen for
// addressed, answered or declined threads; a "claude asked you" banner with a reply box for needs_input; and
// Move here / Keep as general / View on vN for outdated or orphaned anchors. While an action request is in flight
// (busy), its buttons are disabled so a double click cannot send it twice.
// A draft made on another version than the one shown says so: it is not painted on this version (the daemon carries
// it forward when the review is submitted), and its line numbers refer to its own version.
// Screenshots attached to a thread or draft (snips, picked regions, pasted images, `specreview snip`) show as
// thumbnails served by the daemon under DocState.attachmentBase; a click shows one full size.

import { html, useEffect, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { docApi } from '../api.js';
import {
  applySuggestion, cancelReply, compareVersions, deleteDraft, editDraft, focusItem, goToHunk, moveThread, openLightbox,
  resolveThread, revealTarget, setReplyBody, startReply, submitReply, switchVersion, unresolveThread,
} from '../actions.js';
import { Markdown } from '../markdown.js';
import {
  actorLabel, anchorAt, anchorQuote, anchorStateInfo, attachmentName, attachmentUrl, clip, draftVersion, isAgent,
  isVerifiable, linesLabel, relTime, replyDraftsFor, sectionTail, statusInfo, targetLabel,
} from '../model.js';
import { store } from '../state.js';
import { contentUrl, scrollIntoViewSoft } from '../util.js';
import { Chip, WordDiff } from './common.js';

const TYPE_LABEL = /** @type {Record<string, string>} */ ({ question: 'Question', suggestion: 'Suggestion', 'agent-question': 'Agent question' });
const SUGGESTION_STATUS = /** @type {Record<string, string>} */ ({ pending: 'Pending', staged: 'Staged', applied: 'Applied', conflict: 'Conflict' });

/** Clicks on controls inside a card do not focus the card. @param {EventTarget|null} t */
function isControl(t) {
  const el = /** @type {Element|null} */ (t);
  return !!el?.closest?.('button, a, textarea, input, select, summary, label, details');
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
 * @param {{ t: any, ds: any, version: number|'live'|null, agent: string, focused: boolean, reply: any,
 *   position: { state: string }|null, busy?: boolean }} props
 */
export function ThreadCard({ t, ds, version, agent, focused, reply, position, busy = false }) {
  const ref = useFocusScroll(focused);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decision, setDecision] = useState('');
  const a = anchorAt(t, version);
  const st = statusInfo(t, agent);
  const anchorChip = anchorStateInfo(a);
  const verifiable = isVerifiable(t, ds.drafts);
  const pendingReplies = replyDraftsFor(ds.drafts, t.id);
  const original = t.anchors?.[String(t.createdIn)] || null;
  const outdated = a && (a.state === 'changed' || a.state === 'orphaned');
  const lines = a?.src && a.kind !== 'doc' ? linesLabel(a.src) : '';
  const section = sectionTail(a?.section);
  const showMini = t.status === 'addressed' || a?.state === 'edited' || a?.state === 'changed' || !!a?.assetChanged;
  const canAct = version !== 'live';
  const hiddenState = position?.state === 'hidden' || position?.state === 'missing' ? position.state : null;
  const wasNow = !!(outdated && original?.quote?.exact && a?.quote?.exact && original.quote.exact !== a.quote.exact);
  const quote = wasNow ? '' : anchorQuote(a);

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

  return html`<article ref=${ref} role="listitem" tabindex="0" data-testid=${TESTID.threadCard} data-thread-id=${t.id}
    data-status=${t.status} class=${`card status-${st.key} sev-${t.severity || 'normal'} ${focused ? 'is-focused' : ''}`}
    aria-current=${focused ? 'true' : undefined} aria-label=${`Thread ${t.id}, ${st.label}`} onClick=${onClick} onKeyDown=${onKeyDown}>
    <header class="card-head">
      <span class="tid">${t.id}</span>
      ${TYPE_LABEL[t.type] ? html`<${Chip} tone="info">${TYPE_LABEL[t.type]}<//>` : null}
      ${t.severity === 'blocking' ? html`<${Chip} tone="danger">Blocking<//>` : t.severity === 'nit' ? html`<${Chip} tone="muted">Nit<//>` : null}
      <${Chip} tone=${st.tone} class="status-chip">${st.label}<//>
      ${anchorChip ? html`<${Chip} tone=${anchorChip.tone} class="anchor-chip">${anchorChip.label}<//>` : null}
      ${hiddenState === 'hidden' ? html`<button type="button" class="chip tone-muted chip-btn" onClick=${() => revealTarget(t.id)}
        title="The anchor is inside collapsed or hidden content">Hidden: Reveal</button>` : null}
      ${hiddenState === 'missing' ? html`<${Chip} tone="warn" title="The anchor was not found in the rendered page">Not on page<//>` : null}
    </header>
    <${CardTarget} a=${a} lines=${lines} section=${section} />
    ${t.status === 'needs_input' ? html`<div class="asked-banner" role="note"><strong>${agent} asked you</strong> - reply to unblock the revision.</div>` : null}
    ${wasNow
      ? html`<div class="was-now"><div><span class="lbl">was</span> <q>${clip(original.quote.exact, 240)}</q></div>
          <div><span class="lbl">now</span> <q>${clip(a.quote.exact, 240)}</q></div></div>`
      : quote ? html`<blockquote class="quote" data-anchor-quote>“${quote}”</blockquote>` : null}
    <ol class="comments">
      ${(t.comments || []).map((/** @type {any} */ c) => html`<li key=${c.id} class=${`comment ${isAgent(c.by) ? 'by-agent' : 'by-human'}`}>
        <div class="comment-head">
          <span class="avatar" aria-hidden="true">${String(actorLabel(c.by) || '?').slice(0, 1)}</span>
          <strong>${actorLabel(c.by)}</strong>
          ${c.version ? html`<span class="vtag">v${c.version}</span>` : null}
          ${c.status ? html`<span class=${`stag stag-${c.status}`}>${c.status.replace('_', ' ')}</span>` : null}
          <time datetime=${c.at} title=${c.at}>${relTime(c.at)}</time>
        </div>
        <${Markdown} text=${c.body} class="comment-body" />
      </li>`)}
    </ol>
    <${Attachments} paths=${t.attachments} ds=${ds} />
    ${t.suggestion ? html`<${SuggestionBlock} t=${t} ds=${ds} canAct=${canAct} busy=${busy} />` : null}
    ${showMini ? html`<${MiniDiff} t=${t} ds=${ds} />` : null}
    ${t.decision ? html`<p class="decision"><${Chip} tone="ok">${t.decision.id || 'Decision'}<//> ${t.decision.text}</p>` : null}
    ${pendingReplies.map((/** @type {any} */ d) => html`<div class="pending-reply" key=${d.id}>
      <div class="pending-head"><${Chip} tone="draft">${d.reopen ? 'Reopen (draft)' : 'Reply (draft)'}<//>
        <button type="button" class="link-btn" onClick=${() => editDraft(d.id)}>Edit</button>
        <button type="button" class="link-btn danger" onClick=${() => deleteDraft(d.id)}>Delete</button></div>
      <${Markdown} text=${d.body} class="comment-body" />
    </div>`)}
    ${reply ? html`<${ReplyBox} reply=${reply} />` : null}
    ${!reply && t.status === 'needs_input' && canAct && !pendingReplies.length
      ? html`<div class="card-actions"><button type="button" class="btn btn-primary btn-sm" onClick=${() => startReply(t.id)}>Answer ${agent}</button></div>` : null}
    ${!reply && canAct ? html`<footer class="card-actions" aria-busy=${busy ? 'true' : undefined}>
      ${t.status === 'resolved'
        ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => unresolveThread(t.id)}>Reopen</button>`
        : ['addressed', 'answered', 'declined'].includes(t.status)
          ? html`
            <button type="button" class="btn btn-sm btn-ok" data-testid=${TESTID.verifyAccept} disabled=${busy} onClick=${() => resolveThread(t.id, decisionOpen ? decision : '')}
              title=${verifiable ? 'Accept and resolve (x)' : 'Accept and resolve'}>Accept${t.status === 'declined' ? ' decline' : ''}</button>
            <button type="button" class="btn btn-sm" data-testid=${TESTID.verifyReopen} onClick=${() => startReply(t.id, { reopen: true })}
              title="Reopen with a reply (o)">Reopen</button>
            <button type="button" class=${`link-btn ${decisionOpen ? 'active' : ''}`} aria-expanded=${decisionOpen}
              onClick=${() => setDecisionOpen(!decisionOpen)}>Record as decision</button>`
          : html`
            <button type="button" class="btn btn-sm" onClick=${() => startReply(t.id)} title="Reply (r)">Reply</button>
            <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => resolveThread(t.id)} title="Resolve (x)">Resolve</button>`}
      ${outdated ? html`
        <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => moveThread(t.id)} title="Re-anchor to the current selection">Move here</button>
        <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => moveThread(t.id, { kind: 'doc' })}>Keep as general</button>
        ${t.createdIn && t.createdIn !== version ? html`<button type="button" class="btn btn-sm" onClick=${() => switchVersion(Number(t.createdIn))}>View on v${t.createdIn}</button>` : null}`
        : null}
    </footer>` : null}
    ${decisionOpen && !reply ? html`<div class="decision-input">
      <label for=${`dec-${t.id}`} class="small">Decision (one line, recorded when you accept)</label>
      <input id=${`dec-${t.id}`} type="text" value=${decision} placeholder="e.g. 30 s reuse-detection grace window"
        onInput=${(/** @type {any} */ e) => setDecision(e.currentTarget.value)}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') { e.preventDefault(); resolveThread(t.id, decision); } }} />
    </div>` : null}
  </article>`;
}

/**
 * The target row of a card: what the anchor targets (omitted for text selections, whose quote follows), its source
 * lines and section.
 * @param {{ a: any, lines: string, section?: string }} props
 */
function CardTarget({ a, lines, section = '' }) {
  const textual = !!a && (a.kind === 'text' || a.kind === 'code') && !!anchorQuote(a);
  return html`<div class="card-target">
    ${textual ? null : html`<span class="target-label">${targetLabel(a)}</span>`}
    ${lines ? html`<span class="target-lines">${lines}</span>` : null}
    ${section ? html`<span class="target-section">§${section}</span>` : null}
  </div>`;
}

/**
 * Thumbnails of the screenshots of a thread or draft; a click shows one full size. Without an attachment URL (a
 * daemon that does not serve attachments) only the file names are listed.
 * @param {{ paths: unknown, ds: any }} props
 */
function Attachments({ paths, ds }) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
  if (!list.length) return null;
  const urls = list.map((p) => attachmentUrl(ds, p));
  if (!urls.some(Boolean)) {
    return html`<p class="attachments small muted">${list.length} attachment${list.length > 1 ? 's' : ''}
      (${list.map(attachmentName).join(', ')})</p>`;
  }
  return html`<ul class="card-attachments" aria-label=${`${list.length} attachment${list.length > 1 ? 's' : ''}`}>
    ${list.map((p, i) => {
      const src = urls[i];
      const name = attachmentName(p);
      return html`<li key=${p}>${src
        ? html`<button type="button" class="thumb-btn" title=${`Show ${name} full size`} onClick=${() => openLightbox(src, name)}>
            <img src=${src} alt=${`Screenshot ${name}`} loading="lazy" referrerpolicy="no-referrer" data-attachment=${p} /></button>`
        : html`<span class="small muted">${name}</span>`}</li>`;
    })}
  </ul>`;
}

/** @param {{ reply: any }} props */
function ReplyBox({ reply }) {
  const ref = useRef(/** @type {HTMLTextAreaElement|null} */ (null));
  useEffect(() => {
    ref.current?.focus();
  }, []);
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      submitReply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelReply();
    }
  };
  return html`<div class="reply-box">
    <label class="sr-only" for=${`reply-${reply.threadId}`}>${reply.reopen ? 'Reopen with a reply' : 'Reply'}</label>
    <textarea ref=${ref} id=${`reply-${reply.threadId}`} data-testid=${TESTID.replyTextarea} rows="3" value=${reply.body}
      placeholder=${reply.reopen ? 'What still needs to change? (Markdown)' : 'Reply (Markdown)'}
      onInput=${(/** @type {any} */ e) => setReplyBody(e.currentTarget.value)} onKeyDown=${onKeyDown}></textarea>
    <div class="row">
      <label class="check small"><input type="checkbox" checked=${reply.reopen}
        onChange=${(/** @type {any} */ e) => store.set({ reply: { ...reply, reopen: e.currentTarget.checked } })} /> Reopen the thread</label>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" onClick=${cancelReply}>Cancel</button>
      <button type="button" class="btn btn-sm btn-primary" data-testid=${TESTID.replyAdd} disabled=${reply.busy || !reply.body.trim()}
        onClick=${submitReply} title="Add to review (⌘↵)">${reply.reopen ? 'Reopen with reply' : 'Add reply'}</button>
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
      <span class="small muted">${sug.mode === 'source' ? 'source lines' : 'text'}${sug.startLine ? ` · ${linesLabel([sug.startLine, sug.endLine])}` : ''}</span></div>
    ${sug.mode === 'text' && oldLines.length === 1 && newLines.length === 1
      ? html`<${WordDiff} before=${sug.old} after=${sug.new} class="mono" />`
      : html`<pre class="diff-lines">${oldLines.map((l) => html`<span class="del">- ${l}\n</span>`)}${newLines.map((l) => html`<span class="ins">+ ${l}\n</span>`)}</pre>`}
    ${canAct && t.status !== 'resolved' && (sug.status === 'pending' || sug.status === 'conflict') ? html`<div class="card-actions">
      <button type="button" class="btn btn-sm" disabled=${!clean || busy} onClick=${() => applySuggestion(t.id)}
        title=${clean ? 'Apply the suggestion to the file and record a version' : 'The working copy has unrecorded changes'}>Apply now</button>
    </div>` : null}
  </div>`;
}

/** Lazily fetched before/after of a thread (design 8.8, amendments 4.5). @param {{ t: any, ds: any }} props */
function MiniDiff({ t, ds }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(/** @type {{ loading: boolean, data: any, error: string|null, key: string }} */ ({ loading: false, data: null, error: null, key: '' }));
  const key = `${t.id}:${t.updatedAt}:${ds.doc.head}`;
  useEffect(() => {
    if (!open || state.key === key) return;
    setState({ loading: true, data: null, error: null, key });
    const r = store.get().route;
    if (r.view !== 'doc') return;
    docApi(r.ws, r.doc).miniDiff(t.id)
      .then((data) => setState({ loading: false, data, error: null, key }))
      .catch((err) => setState({ loading: false, data: null, error: String(err?.message || err), key }));
  }, [open, key]);
  const links = (t.changes || []).filter((/** @type {any} */ c) => c.hunk);
  const last = links[links.length - 1];
  const d = state.data;
  return html`<details class="minidiff" open=${open} onToggle=${(/** @type {any} */ e) => setOpen(e.currentTarget.open)}>
    <summary>Show change${last ? ` (${last.hunk} in v${last.version})` : ''}</summary>
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
  </details>`;
}

/**
 * A new-thread draft of the pending review.
 * @param {{ d: any, focused: boolean, version?: number|'live'|null, shown?: boolean, ds?: any }} props version: the
 *   version shown; shown: whether the doc paints this draft on it; ds: DocState (attachment thumbnails)
 */
export function DraftCard({ d, focused, version = null, shown = true, ds = null }) {
  const ref = useFocusScroll(focused);
  const a = d.anchor;
  const lines = a?.src && a.kind !== 'doc' ? linesLabel(a.src) : '';
  const dv = draftVersion(d);
  // Written on another version: its line numbers are that version's.
  const elsewhere = dv != null && version != null && dv !== version && a?.kind !== 'doc';
  const where = version === 'live' ? 'the working copy' : `v${version}`;
  // A suggestion shows the replaced text in its word diff already.
  const quote = d.suggestion ? '' : anchorQuote(a);
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    if (!isControl(e.target)) focusItem(d.id);
  };
  return html`<article ref=${ref} role="listitem" tabindex="0" data-testid=${TESTID.threadCard} data-draft-id=${d.id} data-status="draft"
    class=${`card status-draft sev-${d.severity || 'normal'} ${focused ? 'is-focused' : ''}`} aria-current=${focused ? 'true' : undefined}
    aria-label=${`Draft ${d.id}`} onClick=${onClick}>
    <header class="card-head">
      <${Chip} tone="draft">Draft<//>
      ${TYPE_LABEL[d.type] ? html`<${Chip} tone="info">${TYPE_LABEL[d.type]}<//>` : null}
      ${d.severity === 'blocking' ? html`<${Chip} tone="danger">Blocking<//>` : d.severity === 'nit' ? html`<${Chip} tone="muted">Nit<//>` : null}
      ${elsewhere ? html`<${Chip} tone=${shown ? 'muted' : 'warn'} class="draft-version"
        title=${`Written on v${dv}${shown ? '' : `; not shown on ${where}`}. It is carried forward to the latest version when you submit.`}>On v${dv}<//>` : null}
    </header>
    <${CardTarget} a=${a} lines=${elsewhere && lines ? `v${dv} ${lines}` : lines} section=${sectionTail(a?.section)} />
    ${quote ? html`<blockquote class="quote" data-anchor-quote>“${quote}”</blockquote>` : null}
    ${d.body ? html`<${Markdown} text=${d.body} class="comment-body" />` : null}
    ${d.suggestion ? html`<${WordDiff} before=${d.suggestion.old} after=${d.suggestion.new} class="mono" />` : null}
    <${Attachments} paths=${d.attachments} ds=${ds} />
    <footer class="card-actions">
      <button type="button" class="btn btn-sm" onClick=${() => editDraft(d.id)}>Edit</button>
      <button type="button" class="btn btn-sm danger" onClick=${() => deleteDraft(d.id)}>Delete</button>
    </footer>
  </article>`;
}
