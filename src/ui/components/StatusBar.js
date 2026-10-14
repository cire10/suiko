// @ts-check
// Status bar (design 11.1): version, working-copy state, page errors, external resource failures, orphans and the
// FINAL badge. Page errors and external resources are about the rendered doc frame (kindCaps: not for code reviews).

import { html } from 'preact-htm';
import { showThreads } from '../actions.js';
import { isOutdated, kindCaps, showsDoc } from '../model.js';
import { useStore } from '../state.js';

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
  const caps = kindCaps(ds);
  return html`<footer class="statusbar" aria-label="Status">
    <span>${s.version === 'live' ? 'working copy' : `v${s.version}`}</span>
    <span class=${ds.working?.dirty ? 'warn-text' : ''}>${caps.liveBanners
      ? `working copy ${ds.working?.missing ? 'missing' : ds.working?.dirty ? 'has unrecorded changes' : 'clean'}`
      : `working tree ${ds.working?.dirty ? 'changed since this round' : 'matches this round'}`}</span>
    ${caps.pageErrors && showsDoc(s.mode)
      ? html`<span class=${errs ? 'danger-text' : ''} title=${s.pageErrors?.last || ''}>page errors ${errs}</span>`
      : null}
    ${caps.pageErrors ? html`<span class=${ext || failedLocal ? 'warn-text' : ''} title=${[...(s.externals || []), ...(s.pageErrors?.resourcesFailed || [])].join('\n')}>
      ${ext || failedLocal ? `${ext + failedLocal} resource${ext + failedLocal === 1 ? '' : 's'} failed` : 'externals ok'}</span>` : null}
    <button type="button" class=${`link-btn ${orphans ? 'warn-text' : ''}`} onClick=${() => showThreads('outdated', { review: true })}>Orphans (${orphans})</button>
    <span class="spacer"></span>
    <span>FINAL: ${final ? html`<strong class="ok-text">v${final.version}</strong>` : '-'}</span>
  </footer>`;
}
