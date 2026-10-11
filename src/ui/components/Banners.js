// @ts-check
// The doc view's banner stack (design 11.1): the lost-frame banner, the working copy (missing / unrecorded changes,
// "Record as my revision", the live preview), an older version or a new head, approved / closed. A doc kind with a
// banner of its own (components/kinds/index.js KindBanners) replaces the stack; it can render <Banners /> under its
// own banner. The working-copy and lost-frame banners follow kindCaps(ds).liveBanners (a code review has neither:
// no doc frame, no single working file).

import { html, useEffect, useRef, useState } from 'preact-htm';
import { goToNewHead, recordWorkingCopy, reloadFrame, setMode, startRecording, stopRecording, switchVersion } from '../actions.js';
import { agentName, kindCaps } from '../model.js';
import { useStore } from '../state.js';

export function Banners() {
  const s = useStore((st) => ({ ds: st.ds, version: st.version, newHead: st.newHead, mode: st.mode, lost: st.guest.lost, recording: st.recording }));
  const [summary, setSummary] = useState('');
  const recordRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  // The form opens from its button or from the command palette: its summary field takes the focus.
  useEffect(() => {
    if (s.recording) recordRef.current?.focus();
  }, [s.recording]);
  const recording = s.recording;
  const ds = s.ds;
  if (!ds) return null;
  const head = Number(ds.doc.head);
  const agent = agentName(ds);
  const live = kindCaps(ds).liveBanners;
  const out = [];
  if (live && s.lost && (s.mode === 'review' || s.mode === 'changes')) {
    const where = s.version === 'live' ? 'the working copy' : `v${s.version}`;
    out.push(html`<div class="banner banner-warn" role="alert" key="lost" data-frame-lost>
      <span><strong>The document navigated away</strong> from the reviewed page; comments and highlights are off until you go back.</span>
      <span class="banner-actions"><button type="button" class="btn btn-sm" onClick=${reloadFrame}>Back to ${where}</button></span>
    </div>`);
  }
  if (!live) {
    // no working-copy banners for this kind (its own banner says what changed on disk)
  } else if (ds.working?.missing) {
    out.push(html`<div class="banner banner-warn" role="status" key="missing">
      <span><strong>The file is missing on disk</strong> (${ds.doc.path} was moved or deleted). Recorded versions are still available.</span>
    </div>`);
  } else if (ds.working?.dirty || s.version === 'live') {
    const previewing = s.version === 'live';
    out.push(html`<div class="banner banner-warn" role="status" key="working">
      <span>${previewing
        ? html`<strong>Previewing the unrecorded working copy</strong> (read-only, reloads as ${agent} edits).`
        : html`<strong>Unrecorded changes on disk</strong> (${agent} is editing).`}</span>
      <span class="banner-actions">
        ${previewing
          ? html`<button type="button" class="btn btn-sm" onClick=${() => switchVersion(head)}>Back to v${head}</button>`
          : html`<button type="button" class="btn btn-sm" onClick=${() => switchVersion('live')}>Preview live</button>`}
        ${recording
          ? html`<form class="inline-form" onSubmit=${(/** @type {Event} */ e) => { e.preventDefault(); recordWorkingCopy(summary); stopRecording(); setSummary(''); }}>
              <input ref=${recordRef} type="text" aria-label="Revision summary" placeholder="Summary of your edit" value=${summary}
                onInput=${(/** @type {any} */ e) => setSummary(e.currentTarget.value)}
                onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopRecording(); } }} />
              <button type="submit" class="btn btn-sm btn-primary">Record</button>
              <button type="button" class="btn btn-sm" onClick=${stopRecording}>Cancel</button>
            </form>`
          : html`<button type="button" class="btn btn-sm" onClick=${startRecording}>Record as my revision</button>`}
      </span>
    </div>`);
  }
  if (typeof s.version === 'number' && s.version < head) {
    out.push(html`<div class="banner banner-info" role="status" key="older">
      <span>You are viewing <strong>v${s.version}</strong> (latest is v${head}). Comments are carried forward to v${head}.</span>
      <span class="banner-actions"><button type="button" class="btn btn-sm" onClick=${() => switchVersion(head)}>Go to v${head}</button></span>
    </div>`);
  } else if (s.newHead && s.newHead !== s.version) {
    out.push(html`<div class="banner banner-info" role="status" key="newhead">
      <span><strong>v${s.newHead}</strong> is available.</span>
      <span class="banner-actions"><button type="button" class="btn btn-sm" onClick=${goToNewHead}>Switch to v${s.newHead}</button></span>
    </div>`);
  }
  if (ds.doc.state === 'approved' && ds.doc.final) {
    const fv = Number(ds.doc.final.version);
    out.push(html`<div class="banner banner-ok" role="status" key="final">
      <span><strong>Approved at v${fv}.</strong>${head > fv ? ' Newer unapproved changes exist.' : ''}</span>
      <span class="banner-actions">
        <button type="button" class="btn btn-sm" onClick=${() => { switchVersion(fv); setMode('review'); }}>View final</button>
        <button type="button" class="btn btn-sm" onClick=${() => setMode('history')}>History</button>
      </span>
    </div>`);
  } else if (ds.doc.state === 'closed') {
    out.push(html`<div class="banner banner-muted" role="status" key="closed"><span>This review session is closed.</span></div>`);
  }
  return out.length ? html`<div class="banners">${out}</div>` : null;
}
