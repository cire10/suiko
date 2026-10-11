// @ts-check
// Right panel in Review / Source / History modes (and the "Threads" tab in Changes mode): filter chips with counts
// (Open, Needs me, Verify, Drafts, Resolved, Outdated, All), "General comment", and the thread / draft cards in
// document order (List layout, amendments 1). Focusing a card scrolls the doc to its anchor; clicking a
// highlight in the doc focuses its card.

import { html, useMemo } from 'preact-htm';
import { TESTID } from 'protocol';
import { openComposer, setFilter } from '../actions.js';
import { agentName, filterCounts, FILTERS, panelItems } from '../model.js';
import { useStore } from '../state.js';
import { DraftCard, ThreadCard } from './ThreadCard.js';

const EMPTY = /** @type {Record<string, string>} */ ({
  needs: 'Nothing is waiting for you.',
  verify: 'Nothing to verify. Addressed threads show up here after the agent revises.',
  drafts: 'No drafts. Comments you add go here until you submit the review.',
  resolved: 'No resolved threads yet.',
  outdated: 'No outdated or orphaned threads.',
});

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
    busyThreads: st.busyThreads,
    draftTargets: st.targets ? st.targets.drafts : null,
    // Only the non-'ok' target states matter here; positions themselves change on every scroll. They describe the
    // rendered doc, so they mean something only while it is displayed (Review / Changes): in Source and History the
    // iframe is hidden and every target would read as "hidden".
    states: st.mode === 'review' || st.mode === 'changes' ? targetStates(st.guest.positions) : '',
  }));
  const items = useMemo(() => panelItems(s.ds, s.filter, s.version), [s.ds, s.filter, s.version]);
  const counts = useMemo(() => filterCounts(s.ds, s.version), [s.ds, s.version]);
  if (!s.ds) return null;
  const agent = agentName(s.ds);
  const total = (s.ds.threads || []).length + (s.ds.drafts?.items || []).length;
  const canComment = s.version !== 'live';

  return html`<section class="thread-panel" data-testid=${TESTID.threadPanel} aria-label="Threads">
    <div class="panel-head">
      <div class="filters" role="tablist" aria-label="Filter threads">
        ${FILTERS.map((f) => html`<button type="button" role="tab" class=${`filter ${s.filter === f.key ? 'active' : ''}`}
          aria-selected=${s.filter === f.key} data-filter=${f.key} onClick=${() => setFilter(f.key)}>
          ${f.label}<span class="count">${counts[f.key] || 0}</span></button>`)}
      </div>
      ${canComment ? html`<button type="button" class="btn btn-sm" onClick=${() => openComposer({ capture: { kind: 'doc' } })}
        title="A comment about the whole document">General comment</button>` : null}
    </div>
    <div class="cards" role="list">
      ${items.length === 0
        ? html`<div class="empty" role="listitem">${total === 0 || s.filter === 'open' || s.filter === 'all'
          ? html`<p><strong>${total === 0 ? 'No threads yet.' : 'No open threads.'}</strong></p>
              <p>Select text and press <kbd>C</kbd>, or press <kbd>E</kbd> to comment on images, diagrams, tables and code.</p>`
          : html`<p>${EMPTY[s.filter] || 'Nothing here.'}</p>`}</div>`
        : items.map((it) => (it.kind === 'thread'
          ? html`<${ThreadCard} key=${it.id} t=${it.item} ds=${s.ds} version=${s.version} agent=${agent}
              focused=${s.focusedId === it.id} reply=${s.reply && s.reply.threadId === it.id ? s.reply : null}
              position=${stateOf(s.states, it.id)} busy=${s.busyThreads.includes(it.id)} />`
          : html`<${DraftCard} key=${it.id} d=${it.item} focused=${s.focusedId === it.id} version=${s.version}
              shown=${!s.draftTargets || s.draftTargets.some((/** @type {any} */ x) => x.id === it.id)} />`))}
    </div>
  </section>`;
}
