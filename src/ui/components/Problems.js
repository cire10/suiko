// @ts-check
// The problems chip (top bar): mounted only when something is wrong (model.js problemList), "⚠ N" for N kinds of
// problem. It replaces the status bar's always-on "page errors 0 · externals ok · Orphans (0)". Its popover lists
// them: script errors in the page (the last message, Reload the document), resources that did not load (their URLs)
// and a file missing on disk. A thread that lost its place is not a problem (the agent removed or rewrote its text):
// Your turn counts it, and its card offers Move here / Keep as general.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import { reloadFrame } from '../actions.js';
import { problemList } from '../model.js';
import { useStore } from '../state.js';
import { Icon } from './common.js';
import { Popover, usePopover } from './Menu.js';

/** URLs listed per problem before "and N more". */
const MAX_ITEMS = 5;

export function Problems() {
  const s = useStore((st) => ({
    ds: st.ds,
    version: st.version,
    pageErrors: st.guest.pageErrors,
    externalsFailed: st.guest.externalsFailed,
  }));
  if (!s.ds) return null;
  const list = problemList(s.ds, s);
  if (!list.length) return null;
  const n = list.length;
  const summary = list.map((p) => p.label).join('; ');
  return html`<${Popover} label="Problems" kind="dialog" align="end" triggerClass="problems-chip"
    triggerProps=${{ 'data-testid': TESTID.problems, 'aria-label': `${n} problem${n === 1 ? '' : 's'}: ${summary}`, title: summary }}
    trigger=${html`<${Icon} name="warning" size=${15} /><span class="problems-count">${n}</span>`}>
    <${ProblemList} list=${list} />
  <//>`;
}

/** @param {{ list: ReturnType<typeof problemList> }} props */
function ProblemList({ list }) {
  const popover = usePopover();
  /** @param {() => void} fn */
  const run = (fn) => () => {
    popover?.close(true);
    fn();
  };
  return html`<div class="problem-list">
    <p class="turn-sub">Problems</p>
    <ul>
      ${list.map((p) => html`<li key=${p.key} data-problem=${p.key}>
        <span class="problem-label">${p.label}</span>
        ${p.detail ? html`<span class="problem-detail mono" title=${p.detail}>${p.detail}</span>` : null}
        ${p.key === 'resources' && p.items ? html`<ul class="problem-items">
          ${p.items.slice(0, MAX_ITEMS).map((u) => html`<li class="mono" title=${u} key=${u}>${u}</li>`)}
          ${p.items.length > MAX_ITEMS ? html`<li class="muted">and ${p.items.length - MAX_ITEMS} more</li>` : null}
        </ul>` : null}
        ${p.key === 'errors' ? html`<span class="problem-actions">
          <button type="button" class="btn btn-sm" onClick=${run(reloadFrame)} title="Render the version shown again">Reload the document</button>
        </span>` : null}
      </li>`)}
    </ul>
  </div>`;
}
