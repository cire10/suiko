// @ts-check
// Full-size view of an image (dialog 'image': a screenshot attachment, a snip or a picked region's crop, opened from
// its thumbnail), and the image viewer an agent's picture opens in (Attachments.js PreviewOverlay, with the thread's
// actions in its footer). Esc (keys.js), the backdrop or Close shut it, and the focus returns to the thumbnail
// (Modal). The dialog fits the picture: a small one is scaled up to fill the view, at most twice its own size, a
// large one down to fit; the dialog is as wide as the picture (480 px at least). Stored attachments live on the
// content origin, so they can also be opened in a tab of their own.

import { html, useEffect, useRef, useState } from 'preact-htm';
import { closeDialog } from '../actions.js';
import { useStore } from '../state.js';
import { Modal } from './common.js';

/** How far a small picture is scaled up. */
const MAX_UPSCALE = 2;

/**
 * The size an image is shown at: as large as the view allows (`room`), never more than MAX_UPSCALE times its own
 * size; null until its size is known.
 * @param {number} w natural width @param {number} h natural height
 * @param {{ w: number, h: number }} room
 * @returns {{ w: number, h: number }|null}
 */
export function fitImage(w, h, room) {
  if (!(w > 0 && h > 0) || !(room.w > 0 && room.h > 0)) return null;
  const scale = Math.min(MAX_UPSCALE, room.w / w, room.h / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** The room a picture has in the image dialog (the viewport less the dialog's frame, title and footer). */
function viewRoom() {
  return { w: Math.min(window.innerWidth * 0.92, 1600) - 36, h: window.innerHeight * 0.88 - 150 };
}

/**
 * The image dialog: the picture sized to the view, and a footer (`children`).
 * @param {{ src: string, alt: string, children?: any }} props
 */
export function ImageView({ src, alt, children }) {
  const [size, setSize] = useState(/** @type {{ w: number, h: number }|null} */ (null));
  const ref = useRef(/** @type {HTMLImageElement|null} */ (null));
  /** Sizes the picture once its own size is known (now, when it was cached, or on load). */
  const fit = () => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth) setSize(fitImage(img.naturalWidth, img.naturalHeight, viewRoom()));
  };
  useEffect(fit, [src]);
  return html`<${Modal} title=${alt} testid="lightbox" onClose=${closeDialog} class="modal-image">
    <img ref=${ref} class="lightbox-img" src=${src} alt=${alt} referrerpolicy="no-referrer" onLoad=${fit} data-fit=${size ? 'yes' : undefined}
      style=${size ? { width: `${size.w}px`, height: `${size.h}px` } : undefined} />
    ${children}
  <//>`;
}

/** A screenshot, snip or crop full size. */
export function Lightbox() {
  const lb = useStore((s) => s.lightbox);
  if (!lb) return null;
  const alt = lb.alt || 'Screenshot';
  return html`<${ImageView} src=${lb.src} alt=${alt}>
    ${/^https?:/i.test(lb.src)
      ? html`<p class="small lightbox-foot"><a href=${lb.src} target="_blank" rel="noopener noreferrer">Open in a new tab</a></p>`
      : null}
  <//>`;
}
