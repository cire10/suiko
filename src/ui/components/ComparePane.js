// @ts-check
// Changes side by side: the older version (the base) in a second, read-only doc frame beside the newer one, each
// under a label. The older frame has its own guest (frame.js baseGuest), which paints the changes placed in that
// version (Changes.hunks[].oldSide): removed and replaced words struck through in red, red bars, and where added
// lines go. The newer frame is the usual DocFrame, with the changes drawn inline.
// Placement is CSS grid on the center column (.center.is-split): these elements come after the DocFrame in the DOM
// and are placed left of it, so toggling side by side never moves (and so never reloads) the newer version's iframe.
// The frame the pointer is over leads the scrolling (setSyncLeader); actions.js lines the other one up by heading.

import { html, useEffect, useRef } from 'preact-htm';
import { TESTID } from 'protocol';
import { baseFrameNavigating, baseFrameUrl, contentOrigin, setSyncLeader } from '../actions.js';
import { baseGuest, frameSandbox } from '../frame.js';
import { baseTag } from '../model.js';
import { useStore } from '../state.js';

/** The labels over the two frames and the older version's frame. */
export function ComparePane() {
  const s = useStore((st) => ({
    base: st.base,
    version: st.version,
    head: st.ds ? Number(st.ds.doc.head) : null,
    ds: st.ds,
  }));
  /** @param {number|'live'|null} v */
  const label = (v) => {
    if (v === 'live') return 'Working copy (unrecorded)';
    if (v == null) return '';
    const notes = [];
    const tag = baseTag(s.ds, v);
    if (tag) notes.push(tag === 'accepted' ? 'accepted' : 'your last review');
    if (v === s.head) notes.push('latest');
    return `v${v}${notes.length ? ` · ${notes.join(', ')}` : ''}`;
  };
  return html`<div class="compare-split">
    <div class="compare-head compare-head-old"><strong>${label(s.base)}</strong><span class="small muted">older · removed text struck through</span></div>
    <div class="compare-head compare-head-new"><strong>${label(s.version)}</strong><span class="small muted">newer · added text in green</span></div>
    <${BaseFrame} />
  </div>`;
}

/** The older version's frame (read-only: no comments on it; they belong on the version beside it). */
function BaseFrame() {
  const src = useStore((st) => baseFrameUrl(st));
  const origin = useStore((st) => contentOrigin(st));
  const title = useStore((st) => st.ds?.doc?.title || 'Document');
  const base = useStore((st) => st.base);
  const sandbox = useStore((st) => frameSandbox(st.ds));
  const connected = useStore((st) => st.baseConnected);
  const ref = useRef(/** @type {HTMLIFrameElement|null} */ (null));
  const loaded = useRef('');

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !origin) return undefined;
    baseGuest.attach(frame, origin);
    return () => baseGuest.detach(frame);
  }, [origin]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !src || !origin || loaded.current === src) return;
    loaded.current = src;
    baseGuest.attach(frame, origin);
    baseFrameNavigating();
    frame.src = src;
  }, [src, origin]);

  return html`<div class="frame-wrap compare-base" data-guest=${connected ? 'ready' : 'loading'}
    onPointerEnter=${() => setSyncLeader('base')} onFocusCapture=${() => setSyncLeader('base')}>
    <iframe ref=${ref} class="doc-frame" data-testid=${TESTID.compareBaseFrame} title=${`Older version v${base}: ${title}`}
      sandbox=${sandbox} referrerpolicy="no-referrer" allow="fullscreen; clipboard-write"></iframe>
  </div>`;
}
