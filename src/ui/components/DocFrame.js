// @ts-check
// The doc iframe (content origin, sandboxed, no referrer). The guest bridge is attached BEFORE src is assigned,
// so the guest's `hello` is never missed. A new src (version switch) or a nonce bump (live preview reload) navigates
// the frame. The bridge then reconnects on the next hello, and the app re-sends init.
// Every page the frame loads should say hello (the guest runs first in its <head>). When an iframe `load` comes with
// no hello since the previous one, and none follows within LOST_AFTER_MS, the doc navigated away to a page without
// the guest: frameLost() marks it disconnected and a banner offers the way back.

import { html, useEffect, useRef } from 'preact-htm';
import { TESTID } from 'protocol';
import { contentOrigin, frameLost, frameNavigating, frameUrl } from '../actions.js';
import { FRAME_SANDBOX, guest } from '../frame.js';
import { useStore } from '../state.js';

const LOST_AFTER_MS = 1500;

export function DocFrame() {
  const src = useStore((s) => frameUrl(s));
  const origin = useStore((s) => contentOrigin(s));
  const nonce = useStore((s) => s.frameNonce);
  const mode = useStore((s) => s.mode);
  const title = useStore((s) => s.ds?.doc?.title || 'Document');
  const pick = useStore((s) => s.tool === 'pick');
  const connected = useStore((s) => s.guest.connected);
  const ref = useRef(/** @type {HTMLIFrameElement|null} */ (null));
  const loaded = useRef('');
  const helloAtLoad = useRef(0);
  const lostTimer = useRef(/** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined));
  useEffect(() => () => clearTimeout(lostTimer.current), []);

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !origin) return undefined;
    guest.attach(frame, origin);
    return () => guest.detach(frame);
  }, [origin]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !src || !origin) return;
    const key = `${src}#${nonce}`;
    if (loaded.current === key) return;
    loaded.current = key;
    clearTimeout(lostTimer.current);
    guest.attach(frame, origin);
    guest.reset();
    frameNavigating();
    frame.src = src;
  }, [src, nonce, origin]);

  const onLoad = () => {
    if (!loaded.current) return; // the initial about:blank
    const seq = guest.helloSeq;
    const prev = helloAtLoad.current;
    helloAtLoad.current = seq;
    if (seq !== prev) return; // this page said hello
    clearTimeout(lostTimer.current);
    lostTimer.current = setTimeout(() => {
      if (guest.helloSeq === seq) frameLost();
      else helloAtLoad.current = guest.helloSeq; // a late hello: the page has its guest
    }, LOST_AFTER_MS);
  };

  const hidden = mode === 'source' || mode === 'history';
  return html`<div class=${`frame-wrap ${hidden ? 'is-hidden' : ''} ${pick ? 'is-picking' : ''}`} aria-hidden=${hidden ? 'true' : undefined}
    data-guest=${connected ? 'ready' : 'loading'}>
    <iframe ref=${ref} class="doc-frame" data-testid=${TESTID.docFrame} title=${`Document: ${title}`} onLoad=${onLoad}
      sandbox=${FRAME_SANDBOX} referrerpolicy="no-referrer" allow="fullscreen; clipboard-write"></iframe>
  </div>`;
}
