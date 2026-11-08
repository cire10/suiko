// @ts-check
// The tool dock: a small floating pill at the bottom centre of the doc area with the comment tools, where the work
// happens instead of in the header: Comment on the selection (c), pick an Element (e), snip an Area (b), and snip
// anywhere on the Screen (⇧B: only while the daemon can run the macOS picker). Icons with tooltips that name the key.
// It belongs to kinds with a rendered doc frame (a code review comments from its line numbers and has no dock) and
// stays mounted there in every mode: the comment button ([data-selection-comment]) is how the UI and its tests know
// the guest reported a selection. Hidden in Source and History (no rendered doc); quieter in Read mode. It never
// hides the doc for good: the guest gives the page room to scroll its last line clear of the dock (99-main.js), and
// while the doc scrolls the dock fades almost away (is-scrolling: 15%, and clicks go through it to the text) until
// about a second after the scrolling stops; it comes back at once when the pointer comes near the bottom edge of the
// doc (the guest's positions.pointerLow), when it has the focus, or while text is selected (the Comment button is
// what the reviewer reaches for then). At rest it is fully there. Same enabled / disabled rules as the old header
// tools: nothing on the read-only working copy preview, pick only on a shown doc.

import { html, useEffect, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { openComposer, snipScreen, togglePick, toggleSnip } from '../actions.js';
import { KEYS, shortcut } from '../keys.js';
import { kindCaps, showsDoc } from '../model.js';
import { useStore } from '../state.js';
import { Icon } from './common.js';

/** How long after the last scroll report the dock stays faded (ms). */
const SCROLL_FADE_MS = 1000;

export function ToolDock() {
  const s = useStore((st) => ({
    ds: st.ds,
    mode: st.mode,
    version: st.version,
    tool: st.tool,
    selection: st.guest.selection,
    screenRunning: st.screenSnip.running,
    screenSupported: st.screenSnip.supported,
    scrollY: st.guest.positions?.scrollY ?? null,
    // the pointer is near the bottom edge of the doc, where the dock is (guest positions)
    near: st.guest.positions?.pointerLow === true,
  }));
  const [scrolling, setScrolling] = useState(false);
  const last = useRef(/** @type {number|null} */ (null));
  const timer = useRef(/** @type {ReturnType<typeof setTimeout>|undefined} */ (undefined));
  useEffect(() => {
    if (s.scrollY == null) return;
    if (last.current != null && last.current !== s.scrollY) {
      setScrolling(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setScrolling(false), SCROLL_FADE_MS);
    }
    last.current = s.scrollY;
  }, [s.scrollY]);
  // Coming near the dock (or selecting text, to comment on it) brings it back at once, until the next scroll.
  const wake = s.near || !!s.selection;
  useEffect(() => {
    if (!wake) return;
    clearTimeout(timer.current);
    setScrolling(false);
  }, [wake]);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!s.ds || !kindCaps(s.ds).frame) return null;
  const caps = kindCaps(s.ds);
  const live = s.version === 'live';
  const canPick = !live && showsDoc(s.mode);
  const hidden = !showsDoc(s.mode);
  const cls = ['tool-dock', s.mode === 'read' ? 'is-quiet' : '', scrolling && !wake ? 'is-scrolling' : ''].filter(Boolean).join(' ');
  return html`<div class=${cls} data-testid=${TESTID.toolDock} role="group" aria-label="Comment tools" hidden=${hidden}>
    <button type="button" class="dock-btn" data-selection-comment disabled=${!s.selection || !canPick}
      aria-label="Comment on the selection" title="Comment on the selected text (c)"
      onClick=${() => s.selection && openComposer({ capture: s.selection })}><${Icon} name="comment" size=${17} /></button>
    ${caps.pick || caps.snip || s.screenSupported ? html`<span class="dock-sep" aria-hidden="true"></span>` : null}
    ${caps.pick ? html`<button type="button" class=${`dock-btn ${s.tool === 'pick' ? 'active' : ''}`} data-testid=${TESTID.pickTool}
      aria-pressed=${s.tool === 'pick'} disabled=${!canPick} aria-keyshortcuts="e"
      aria-label="Pick an element (image, diagram, table, code)" title=${`Pick an element: image, diagram, table, code (${shortcut(KEYS.pick)})`}
      onClick=${togglePick}><${Icon} name="pick" size=${17} /></button>` : null}
    ${caps.snip ? html`<button type="button" class=${`dock-btn ${s.tool === 'snip' ? 'active' : ''}`} data-testid=${TESTID.snipTool}
      aria-pressed=${s.tool === 'snip'} disabled=${live} aria-keyshortcuts="b" aria-label="Snip an area of the document"
      title=${`Snip an area of the document: drag a box over text, images or diagrams, then comment (${shortcut(KEYS.snip)})`}
      onClick=${() => toggleSnip()}><${Icon} name="scissors" size=${17} /></button>` : null}
    ${s.screenSupported ? html`<button type="button" class=${`dock-btn ${s.screenRunning ? 'active' : ''}`} data-testid=${TESTID.snipScreen}
      aria-busy=${s.screenRunning ? 'true' : undefined} disabled=${s.screenRunning || live} aria-keyshortcuts="Shift+B"
      aria-label="Snip anywhere on your screen"
      title=${`Snip anywhere on your screen with the macOS picker, then comment on the screenshot (${shortcut(KEYS.snipScreen)})`}
      onClick=${snipScreen}><${Icon} name="screen" size=${17} /></button>` : null}
  </div>`;
}
