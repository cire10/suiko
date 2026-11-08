// @ts-check
// Right panel in Review / Source / History modes (and the "Threads" tab in Changes mode): "Threads", a "+" button for
// a general comment (accessible name "General comment"; a code review takes it as a whole-review thread), a
// segmented filter that says whose turn each thread is (model.js FILTERS): Your turn N · Claude N · Done N · All, and
// the thread / draft cards in document order (List layout, amendments 1; a code review orders them by file).
// - Your turn (what waits for the reviewer: new comments not sent yet, replies not sent yet, answers to check,
//   questions, threads that lost their place; the same count as the turn pill) starts with "Accept all"
//   (AcceptAllBar): every thread the agent changed or answered at once.
// - Claude (the agent's name) lists its planned changes first (batched edits: it answered and will edit the doc
//   when the reviewer applies them), under "Planned changes · N" with "Apply N", then the threads waiting for it.
//   Planned changes are every planned thread (model.js applicablePlanned, what Apply sends, also from the turn pill
//   and the palette); one that also waits for the reviewer (a reply not sent yet, a lost anchor) is in Your turn too
//   and says "Also waits for you" here.
// - Until the reviewer picks a filter for the doc, the panel follows the default (actions.js): Your turn when
//   something waits for them, else the agent's, else All.
// - With no threads and no drafts at all, only the empty state shows (no filters).
// - A card keeps its reply box or "Record as decision…" input whatever the filter (actions.js keptThreads); a draft
//   the composer holds says "Being edited" (actions.js boundDraft).
// Focusing a card scrolls the doc to its anchor; clicking a highlight in the doc focuses its card.

import { html, useMemo } from 'preact-htm';
import { TESTID } from 'protocol';
import { acceptAll, applyPlanned, boundDraft, keptThreads, openComposer, setFilter } from '../actions.js';
import {
  acceptableThreads, agentName, agentTitle, applicablePlanned, declinedToVerify, filterCounts, filterLabel, FILTERS, kindCaps,
  normalizeFilter, panelItems, sendModeOf, showsDoc, turnReason,
} from '../model.js';
import { useStore } from '../state.js';
import { Icon } from './common.js';
import { DraftCard, ThreadCard } from './ThreadCard.js';

/**
 * "t1:hidden,t4:missing" for targets the guest could not show normally.
 * @param {any} positions
 */
function targetStates(positions) {
  const out = [];
  for (const [id, p] of Object.entries(positions?.targets || {})) {
    const st = /** @type {any} */ (p)?.state;
    if (st && st !== 'ok') out.push(`${id}:${st}`);
  }
  return out.join(',');
}

/** @param {string} states @param {string} id @returns {{ state: string }|null} */
function stateOf(states, id) {
  const hit = states.split(',').find((x) => x.slice(0, x.lastIndexOf(':')) === id);
  return hit ? { state: hit.slice(hit.lastIndexOf(':') + 1) } : null;
}

export function ThreadPanel() {
  const s = useStore((st) => ({
    ds: st.ds,
    filter: st.filter,
    version: st.version,
    focusedId: st.focusedId,
    reply: st.reply,
    decision: st.decision,
    composerDraft: boundDraft(st.composer),
    busyThreads: st.busyThreads,
    sendMode: sendModeOf(st),
    // Painted drafts and target states describe the rendered doc frame: a kind without one (a code review) has
    // neither, so its drafts all count as shown.
    draftTargets: st.targets && kindCaps(st.ds).frame ? st.targets.drafts : null,
    // Only the non-'ok' target states matter here; positions themselves change on every scroll. They describe the
    // rendered doc, so they mean something only while it is displayed (Review / Changes): in Source and History the
    // iframe is hidden and every target would read as "hidden".
    states: kindCaps(st.ds).frame && showsDoc(st.mode) ? targetStates(st.guest.positions) : '',
  }));
  const kept = keptThreads(/** @type {any} */ (s)).join(',');
  const filter = normalizeFilter(s.filter, s.ds, s.version);
  const items = useMemo(() => panelItems(s.ds, filter, s.version, kept.split(',')), [s.ds, filter, s.version, kept]);
  const counts = useMemo(() => filterCounts(s.ds, s.version), [s.ds, s.version]);
  if (!s.ds) return null;
  const agent = agentName(s.ds);
  const canComment = s.version !== 'live';
  const framed = kindCaps(s.ds).frame;
  const ctx = { drafts: s.ds.drafts, version: s.version };
  // nothing at all yet: the empty state only, without four filters reading 0
  const none = !(s.ds.threads || []).length && !(s.ds.drafts?.items || []).some((/** @type {any} */ d) => d.kind === 'thread');

  /** @param {{ kind: string, id: string, item: any }} it @param {boolean} [alsoYours] */
  const card = (it, alsoYours = false) => (it.kind === 'thread'
    ? html`<${ThreadCard} key=${it.id} t=${it.item} ds=${s.ds} version=${s.version} agent=${agent}
        focused=${s.focusedId === it.id} reply=${s.reply && s.reply.threadId === it.id ? s.reply : null}
        decision=${s.decision && s.decision.threadId === it.id ? s.decision : null} alsoYours=${alsoYours}
        position=${stateOf(s.states, it.id)} busy=${s.busyThreads.includes(it.id)} sendMode=${s.sendMode} />`
    : html`<${DraftCard} key=${it.id} d=${it.item} focused=${s.focusedId === it.id} version=${s.version} ds=${s.ds}
        busy=${s.busyThreads.includes(it.id)} sendMode=${s.sendMode} editing=${s.composerDraft === it.id}
        shown=${!s.draftTargets || s.draftTargets.some((/** @type {any} */ x) => x.id === it.id)} />`);

  // The agent's filter: its planned changes first (every one: what Apply sends), under their own heading with Apply.
  const applicable = applicablePlanned(s.ds).map((/** @type {any} */ t) => String(t.id));
  const planned = filter === 'agent' ? items.filter((it) => it.kind === 'thread' && applicable.includes(it.id)) : [];
  const rest = planned.length ? items.filter((it) => !planned.includes(it)) : items;

  return html`<section class="thread-panel" data-testid=${TESTID.threadPanel} aria-label="Threads">
    <div class="panel-head">
      <div class="panel-title-row">
        <h2 class="panel-title">Threads</h2>
        ${canComment ? html`<button type="button" class="icon-btn icon-btn-sm new-comment" aria-label="General comment"
          title=${framed ? 'General comment: about the whole document' : 'General comment: about the whole review'}
          onClick=${() => openComposer({ capture: { kind: 'doc' } })}><${Icon} name="plus" /></button>` : null}
      </div>
      ${none ? null : html`<div class="filters" role="tablist" aria-label="Filter threads">
        ${FILTERS.map((f) => html`<button type="button" role="tab" class=${`filter ${filter === f.key ? 'active' : ''}`}
          aria-selected=${filter === f.key} data-filter=${f.key} key=${f.key} onClick=${() => setFilter(f.key)}
          title=${FILTER_HINT[f.key]?.(agentTitle(agent))}>
          <span class="filter-label">${filterLabel(f.key, agent)}</span>${f.key === 'all' ? null
            : html`<span class="count" aria-label=${`${counts[f.key] || 0} threads`}>${counts[f.key] || 0}</span>`}</button>`)}
      </div>`}
    </div>
    ${filter === 'mine' ? html`<${AcceptAllBar} ds=${s.ds} busy=${s.busyThreads} live=${!canComment} />` : null}
    <div class="cards">
      ${planned.length ? html`<section class="card-group planned-group" aria-label="Planned changes">
        <div class="group-head">
          <h3 class="group-label">Planned changes <span class="muted">· ${planned.length}</span></h3>
          <button type="button" class="btn btn-sm btn-primary" data-testid=${TESTID.applyPlanned}
            disabled=${!canComment || applicable.some((id) => s.busyThreads.includes(id))}
            title=${canComment ? `${agentTitle(agent)} makes these changes in one pass and records one version`
              : 'The working copy preview is read-only'}
            onClick=${() => applyPlanned()}>Apply ${applicable.length}</button>
        </div>
        <p class="group-hint small muted">${agentTitle(agent)} answered these and will edit the document when you apply them.</p>
        <div class="card-list" role="list">${planned.map((it) => card(it, turnReason(it.item, ctx) != null))}</div>
      </section>` : null}
      ${planned.length && rest.length ? html`<h3 class="group-label group-sep">Waiting for ${agentTitle(agent)} <span class="muted">· ${rest.length}</span></h3>` : null}
      ${items.length === 0 ? html`<div class="empty" role="note">${emptyText(filter, s.ds, agent, framed, counts)}</div>`
        : rest.length ? html`<div class="card-list" role="list">${rest.map((it) => card(it))}</div>` : null}
    </div>
  </section>`;
}

/** What each filter holds, for its tooltip. */
const FILTER_HINT = /** @type {Record<string, (agent: string) => string>} */ ({
  mine: () => 'What waits for you: comments and replies not sent yet, answers to check, questions, threads that lost their place',
  agent: (agent) => `Threads waiting for ${agent}, and the changes ${agent} planned`,
  done: () => 'Threads you marked done',
  all: () => 'Every thread and draft',
});

/**
 * The empty list in plain words.
 * @param {string} filter @param {any} ds @param {string} agent @param {boolean} framed @param {Record<string, number>} counts
 */
function emptyText(filter, ds, agent, framed, counts) {
  const none = !(ds.threads || []).length && !(ds.drafts?.items || []).some((/** @type {any} */ d) => d.kind === 'thread');
  if (none || filter === 'all') {
    return html`<p><strong>No comments yet.</strong> ${framed
      ? 'Select text in the document to comment.' : 'Click a line number to comment on it.'}</p>
      ${framed ? html`<p class="small">Or press <kbd>b</kbd> to snip an area, or <kbd>e</kbd> to pick an image, diagram, table or code
        block (the tools at the bottom of the document do the same).</p>` : html`<p class="small">Shift-click for a range, or comment on a whole file from its header.</p>`}`;
  }
  if (filter === 'mine') {
    return html`<p>Nothing needs you right now.</p>${counts.agent
      ? html`<p class="small">${counts.agent} ${counts.agent === 1 ? 'thread waits' : 'threads wait'} for ${agentTitle(agent)}.</p>` : null}`;
  }
  if (filter === 'agent') return html`<p>Nothing is waiting for ${agentTitle(agent)}.</p>`;
  return html`<p>No finished threads yet.</p>`;
}

/**
 * Your turn's "Accept all": every thread the agent changed or answered, at once (Undo in the toast). Threads it did
 * not change (declined) are not included; the bar says how many are left for the reviewer to decide.
 * @param {{ ds: any, busy: string[], live: boolean }} props
 */
export function AcceptAllBar({ ds, busy, live }) {
  const ok = acceptableThreads(ds);
  const declined = declinedToVerify(ds).length;
  if (!ok.length) return null;
  const agent = agentTitle(agentName(ds));
  const pending = ok.some((/** @type {any} */ t) => busy.includes(t.id));
  return html`<div class="accept-all-bar" role="group" aria-label="Accept all">
    <span class="small accept-all-text" title=${`${ok.length} threads ${agent} changed or answered`}>${ok.length} changed or answered</span>
    <button type="button" class="btn btn-sm" data-testid=${TESTID.verifyAcceptAll} disabled=${pending || live}
      aria-keyshortcuts="Shift+X" title=${live ? 'The working copy preview is read-only'
        : `Mark every thread ${agent} changed or answered as done (⇧X). You can undo it.`}
      onClick=${() => acceptAll()}><${Icon} name="check" size=${14} />Accept all ${ok.length}</button>
    ${declined ? html`<span class="small muted accept-all-note">${`${declined} ${declined === 1 ? 'thread' : 'threads'} ${agent} didn't change: decide on ${declined === 1 ? 'it' : 'each'} below.`}</span>` : null}
  </div>`;
}
