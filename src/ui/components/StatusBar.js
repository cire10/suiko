// @ts-check
// Status bar (design 11.1): version, working-copy state, page errors, external resource failures, orphans and the
// FINAL badge.

import { html } from 'preact-htm';
import { setFilter, setMode } from '../actions.js';
import { isOutdated } from '../model.js';
import { store, useStore } from '../state.js';

export function StatusBar() {
  const s = useStore((st) => ({
    ds: st.ds,
    version: st.version,
    pageErrors: st.guest.pageErrors,
    externals: st.guest.externalsFailed,
    connected: st.guest.connected,
    mode: st.mode,
  }));
  const ds = s.ds;
  if (!ds) return null;
  const orphans = (ds.threads || []).filter((/** @type {any} */ t) => t.status !== 'resolved' && isOutdated(t, s.version)).length;
  const errs = s.pageErrors?.count || 0;
  const ext = s.externals?.length || 0;
  const failedLocal = s.pageErrors?.resourcesFailed?.length || 0;
  const final = ds.doc.final;
  return html`<footer class="statusbar" aria-label="Status">
    <span>${s.version === 'live' ? 'working copy' : `v${s.version}`}</span>
    <span class=${ds.working?.dirty ? 'warn-text' : ''}>working copy ${ds.working?.missing ? 'missing' : ds.working?.dirty ? 'has unrecorded changes' : 'clean'}</span>
    ${s.mode === 'review' || s.mode === 'changes'
      ? html`<span class=${errs ? 'danger-text' : ''} title=${s.pageErrors?.last || ''}>page errors ${errs}</span>`
      : null}
    <span class=${ext || failedLocal ? 'warn-text' : ''} title=${[...(s.externals || []), ...(s.pageErrors?.resourcesFailed || [])].join('\n')}>
      ${ext || failedLocal ? `${ext + failedLocal} resource${ext + failedLocal === 1 ? '' : 's'} failed` : 'externals ok'}</span>
    <button type="button" class=${`link-btn ${orphans ? 'warn-text' : ''}`} onClick=${() => {
      if (s.mode !== 'review') setMode('review');
      setFilter('outdated');
      store.set({ sidebar: true, drawer: store.get().narrow ? true : store.get().drawer, sidePane: 'threads' });
    }}>Orphans (${orphans})</button>
    <span class="spacer"></span>
    <span>FINAL: ${final ? html`<strong class="ok-text">v${final.version}</strong>` : '-'}</span>
  </footer>`;
}
