// @ts-check
// Changes side by side ("compare focus", actions.js): the compare bar over both frames (CompareBar), a header over
// each frame with its version picker and a muted note on what that version is (your last review, previous, latest,
// the working copy), and the older version (the base) in a second, read-only doc frame on the left. The older frame
// has its own guest (frame.js baseGuest), which paints the changes placed in that version (Changes.hunks[].oldSide):
// removed and replaced words struck through in red, a red bar beside each block that lost text, and where added lines
// go. The newer version is the usual DocFrame on the right, with the added words in green and its own bars.
// The pickers are the top bar's #sr-base (TESTID.compareFrom) and #sr-version (TESTID.versionPicker): while side by
// side is shown the top bar renders neither, each frame's header does.
// Placement is CSS grid on the center column (.center.is-split, styles/compare.css): these elements come after the
// DocFrame in the DOM and are placed around it, so entering and leaving side by side never moves (and so never
// reloads) the newer version's iframe. Both frames get the same width.
// Scroll sync: the frame the reader scrolls leads (actions.js syncScroll); the pointer only settles a tie.
// Links: a narrow band over the seam between the frames joins each change both frames show on screen, its place in
// the older version to its place in the newer one (compare-sync.js changeLinks), coloured like the change; drawn only
// once both frames are at rest (they fade out while scrolling) and only when both ends are visible.

import { html, useEffect, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { baseFrameNavigating, baseFrameUrl, contentOrigin, setBase, setSyncLeader, switchVersion } from '../actions.js';
import { changeLinks } from '../compare-sync.js';
import { baseGuest, frameSandbox } from '../frame.js';
import { baseTag, kindCaps, versionNumbers } from '../model.js';
import { useStore } from '../state.js';
import { CompareBar } from './CompareBar.js';

/** The compare bar, the two frame headers, the older version's frame and the links between the frames. */
export function ComparePane() {
  return html`<div class="compare-split">
    <${CompareBar} />
    <${OldHead} />
    <${NewHead} />
    <${BaseFrame} />
    <${CompareLinks} />
  </div>`;
}

/** Width of the band over the seam between the frames (half of it over each frame's margin). */
const LINK_WIDTH = 16;
/** How long both frames must be still before the links show again (ms). */
const LINK_SETTLE_MS = 220;

/**
 * The band of one link: from the change's span on the older frame's edge (x 0) to its span on the newer one's (x w),
 * with eased sides.
 * @param {{ old: [number, number], new: [number, number] }} l @param {number} w
 */
function linkPath(l, w) {
  const m = w / 2;
  const [o0, o1] = l.old;
  const [n0, n1] = l.new;
  return `M0 ${o0} C${m} ${o0} ${m} ${n0} ${w} ${n0} L${w} ${n1} C${m} ${n1} ${m} ${o1} 0 ${o1} Z`;
}

/** The links between the two frames (see the header). */
function CompareLinks() {
  const s = useStore((st) => ({
    main: st.guest.positions, base: st.basePositions, changes: st.changes, active: st.activeHunk,
  }));
  const [still, setStill] = useState(true);
  const moved = `${s.main?.scrollY}|${s.base?.scrollY}|${s.main?.viewportH}`;
  useEffect(() => {
    setStill(false);
    const t = setTimeout(() => setStill(true), LINK_SETTLE_MS);
    return () => clearTimeout(t);
  }, [moved]);
  if (!s.main || !s.base || !s.changes) return null;
  const height = Number(s.main.viewportH) || 0;
  const links = changeLinks(s.main, s.base, s.changes.hunks || [], height);
  const w = LINK_WIDTH;
  return html`<div class=${`compare-links ${still ? '' : 'is-moving'}`} aria-hidden="true">
    <svg width=${w} height=${height} viewBox=${`0 0 ${w} ${height}`}>
      ${links.map((l) => html`<path key=${l.id} data-hunk=${l.id} d=${linkPath(l, w)}
        class=${`compare-link op-${l.op} ${l.id === s.active ? 'active' : ''}`} />`)}
    </svg>
  </div>`;
}

/**
 * The versions of the comparison: the shown (newer) one as a number (the working copy counts as head + 1), the
 * recorded versions, and the ones older than the shown one (every recorded version for the working copy).
 * @param {any} ds @param {number|'live'|null} version
 */
function versionsOf(ds, version) {
  const head = Number(ds.doc.head);
  const all = versionNumbers(ds);
  const numericV = version === 'live' ? head + 1 : Number(version);
  const olders = all.filter((v) => v < numericV || (version === 'live' && v <= head)).reverse();
  return { head, all, numericV, olders };
}

/** The older version's header: its picker (#sr-base) and what it is. */
function OldHead() {
  const s = useStore((st) => ({ ds: st.ds, base: st.base, version: st.version }));
  if (!s.ds || s.base == null) return null;
  const { numericV, olders } = versionsOf(s.ds, s.version);
  const tag = baseTag(s.ds, s.base);
  const note = tag === 'accepted' ? 'the revisions you accepted' : tag === 'review' ? 'your last review'
    : s.base === numericV - 1 ? 'previous version' : 'older version';
  return html`<div class="compare-head compare-head-old">
    <label class="sr-only" for="sr-base">Older version</label>
    <select id="sr-base" class="select compare-select" data-testid=${TESTID.compareFrom} value=${String(s.base)}
      title="The older version: what changed since it is shown (d: your last review / the previous version)"
      onChange=${(/** @type {any} */ e) => setBase(Number(e.currentTarget.value))}>
      ${olders.map((v) => html`<option value=${String(v)}>v${v}</option>`)}
    </select>
    <span class="compare-note">${note}</span>
    <span class="compare-key compare-key-del" title="Removed text is struck through in red">removed</span>
  </div>`;
}

/** The newer version's header: its picker (#sr-version) and what it is. */
function NewHead() {
  const s = useStore((st) => ({ ds: st.ds, version: st.version }));
  if (!s.ds) return null;
  const ds = s.ds;
  const { head, all } = versionsOf(ds, s.version);
  const live = kindCaps(ds).liveBanners && ((ds.working?.dirty && !ds.working?.missing) || s.version === 'live');
  const final = ds.doc.final?.version;
  const note = s.version === 'live' ? 'working copy, not recorded' : s.version === head
    ? (final === head ? 'latest, final' : 'latest') : final === s.version ? 'final' : 'newer version';
  /** @param {Event} e */
  const onVersion = (e) => {
    const el = /** @type {HTMLSelectElement} */ (e.currentTarget);
    const v = el.value === 'live' ? 'live' : Number(el.value);
    if (!switchVersion(v)) el.value = String(s.version);
  };
  return html`<div class="compare-head compare-head-new">
    <label class="sr-only" for="sr-version">Newer version</label>
    <select id="sr-version" class="select compare-select" data-testid=${TESTID.versionPicker} value=${String(s.version)}
      title="The newer version: shown with what changed" onChange=${onVersion}>
      ${all.slice().reverse().map((v) => html`<option value=${String(v)}>v${v}</option>`)}
      ${live ? html`<option value="live">Working copy</option>` : null}
    </select>
    <span class="compare-note">${note}</span>
    <span class="compare-key compare-key-ins" title="Added text is highlighted in green">added</span>
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
