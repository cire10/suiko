// @ts-check
// The compare bar of Changes side by side (compare focus, actions.js): one slim row over both frames with what the
// reviewer does while comparing: step through the changes ("‹ 3 of 12 ›", the same as n / p: each step puts the
// change level in both frames and marks it on both sides), switch back to Inline, or Done (back to the mode before
// side by side). The versions themselves are picked in each frame's header (ComparePane).
// CompareLayoutSwitch is the Inline / Side by side switch (TESTID.compareLayout, data-layout buttons): rendered here
// while side by side is shown, and by the Changes panel otherwise (setCompareLayout routes both ways).

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import { exitCompare, navChange, setCompareLayout } from '../actions.js';
import { modesFor } from '../model.js';
import { useStore } from '../state.js';

export function CompareBar() {
  const s = useStore((st) => ({
    changes: st.changes,
    active: st.activeHunk,
    // where the newer version's guest found the active change (null: nothing of it is drawn on the page)
    shownAt: st.activeHunk ? st.guest.positions?.hunks?.[st.activeHunk] : undefined,
    from: st.compareFocus?.from ?? null,
    ds: st.ds,
  }));
  const hunks = s.changes?.hunks || [];
  const total = hunks.length;
  const i = s.active ? hunks.findIndex((/** @type {any} */ h) => h.id === s.active) : -1;
  const label = !s.changes ? 'Loading…' : !total ? 'No changes' : i >= 0 ? `${i + 1} of ${total}` : `${total} change${total === 1 ? '' : 's'}`;
  const back = s.from && s.from !== 'changes' ? modesFor(s.ds).find((m) => m.key === s.from)?.label : null;
  // a change with nothing to draw (a script, a style or hidden content changed): say so instead of showing nothing
  const offPage = i >= 0 && s.shownAt === null;
  return html`<div class="compare-bar" data-testid=${TESTID.compareBar} role="toolbar" aria-label="Comparing versions">
    <span class="compare-title">Comparing</span>
    <span class="compare-step" data-testid=${TESTID.compareStep} role="group" aria-label="Changes">
      <button type="button" class="compare-step-btn" aria-label="Previous change" aria-keyshortcuts="p"
        title="Previous change (p)" disabled=${!total || i === 0} onClick=${() => navChange(-1)}>
        <span aria-hidden="true">‹</span></button>
      <span class="compare-step-label" aria-live="polite">${label}</span>
      <button type="button" class="compare-step-btn" aria-label="Next change" aria-keyshortcuts="n"
        title="Next change (n)" disabled=${!total || i === total - 1} onClick=${() => navChange(1)}>
        <span aria-hidden="true">›</span></button>
    </span>
    ${offPage ? html`<span class="compare-offpage" title="Nothing of this change is drawn on the page: a script, a style or hidden content changed. The Changes list shows its source.">
      not on the page</span>` : null}
    <span class="spacer"></span>
    <${CompareLayoutSwitch} layout="split" />
    <button type="button" class="btn btn-sm compare-done" aria-label="Done comparing"
      title=${back ? `Done comparing: back to ${back}` : 'Done comparing: the changes inline'}
      onClick=${() => exitCompare({ done: true })}>Done</button>
  </div>`;
}

/**
 * Changes: Inline (what changed drawn over the newer version) or Side by side (the older version beside it).
 * @param {{ layout: 'inline'|'split' }} props
 */
export function CompareLayoutSwitch({ layout }) {
  return html`<span class="seg compare-layout" role="group" aria-label="Compare layout" data-testid=${TESTID.compareLayout}>
    <button type="button" data-layout="inline" aria-pressed=${layout !== 'split'} class=${layout !== 'split' ? 'active' : ''}
      title="What changed, drawn over the newer version" onClick=${() => setCompareLayout('inline')}>Inline</button>
    <button type="button" data-layout="split" aria-pressed=${layout === 'split'} class=${layout === 'split' ? 'active' : ''}
      title="The older version beside the newer one, scrolled together: removed text in red, added text in green"
      onClick=${() => setCompareLayout('split')}>Side by side</button>
  </span>`;
}
