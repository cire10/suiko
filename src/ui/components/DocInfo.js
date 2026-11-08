// @ts-check
// Document info (More menu > Document info): what the status bar used to show all the time, on demand. The file
// and its path (copy), the version shown, the latest and the final one, the working copy (clean / unrecorded
// changes / missing; a code review's working tree), script errors and resources that did not load in the rendered
// doc, threads that lost their place (Show them), and where the agent is, with the prompt to paste into its chat.

import { html } from 'preact-htm';
import { closeDialog, copyAgentPrompt, copySpecPath, showThreads } from '../actions.js';
import { agentPrompt, kindCaps, lostThreads, presenceInfo, reviewProgress } from '../model.js';
import { useStore } from '../state.js';
import { Modal } from './common.js';

export function DocInfo() {
  const s = useStore((st) => ({
    ds: st.ds,
    version: st.version,
    mode: st.mode,
    pageErrors: st.guest.pageErrors,
    externals: st.guest.externalsFailed,
  }));
  const ds = s.ds;
  if (!ds) return null;
  const caps = kindCaps(ds);
  const head = Number(ds.doc.head);
  const final = ds.doc.final ? Number(ds.doc.final.version) : null;
  const errors = Number(s.pageErrors?.count) || 0;
  const failed = [...(s.externals || []), ...(s.pageErrors?.resourcesFailed || [])];
  const lost = lostThreads(ds, s.version);
  const presence = presenceInfo(ds);
  const progress = reviewProgress(ds);
  const working = caps.liveBanners
    ? ds.working?.missing ? 'missing on disk' : ds.working?.dirty ? 'unrecorded changes on disk' : 'clean (matches the latest version)'
    : ds.working?.dirty ? 'the working tree changed since this round' : 'the working tree matches this round';
  return html`<${Modal} title="Document info" testid="doc-info" onClose=${closeDialog}>
    <dl class="about doc-info">
      <dt>Title</dt><dd>${ds.doc.title || ds.doc.id}</dd>
      <dt>File</dt><dd class="doc-info-path"><span class="mono">${ds.doc.path}</span>
        <button type="button" class="btn btn-sm" onClick=${copySpecPath}>Copy path</button></dd>
      <dt>Shown</dt><dd data-info="version">${s.version === 'live' ? 'the working copy (live preview)' : `v${s.version}`}${s.version === head ? ' (latest)' : ` · latest v${head}`}</dd>
      <dt>Final</dt><dd data-info="final">${final ? `v${final}` : 'none yet'}</dd>
      <dt>Working copy</dt><dd data-info="working" class=${ds.working?.dirty || ds.working?.missing ? 'warn-text' : ''}>${working}</dd>
      ${caps.pageErrors ? html`
        <dt>Script errors</dt><dd data-info="errors" class=${errors ? 'danger-text' : ''}>${errors
          ? html`${errors}${s.pageErrors?.last ? html` · <span class="mono" title=${s.pageErrors.last}>${s.pageErrors.last}</span>` : null}`
          : 'none'}</dd>
        <dt>Resources</dt><dd data-info="resources" class=${failed.length ? 'warn-text' : ''}>${failed.length
          ? html`${failed.length} did not load<ul class="doc-info-urls">${failed.slice(0, 8).map((u) => html`<li class="mono" title=${u} key=${u}>${u}</li>`)}</ul>`
          : 'all loaded'}</dd>` : null}
      <dt>Lost their place</dt><dd data-info="lost">${lost.length
        ? html`${lost.map((/** @type {any} */ t) => t.id).join(', ')} <button type="button" class="btn btn-sm"
            onClick=${() => { closeDialog(); showThreads('mine', { review: s.mode === 'read' }); }}>Show them</button>`
        : 'none'}</dd>
      <dt>Agent</dt><dd data-info="agent">${presence.label}${progress ? ` · last review: ${progress.label}` : ''}</dd>
    </dl>
    ${presence.kind === 'none' ? html`<div class="about-prompt doc-info-prompt">
      <code class="prompt">${agentPrompt(ds)}</code>
      <button type="button" class="btn btn-sm" onClick=${copyAgentPrompt}>Copy prompt</button>
    </div>` : null}
  <//>`;
}
