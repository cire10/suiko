// @ts-check
// Full-size view of an image (a screenshot attachment, a snip or a picked region's crop), opened from a thumbnail.
// Esc (keys.js, dialog 'image'), the backdrop or Close shut it, and the focus returns to the thumbnail (Modal).
// Stored attachments live on the content origin, so they can also be opened in a tab of their own.

import { html } from 'preact-htm';
import { closeDialog } from '../actions.js';
import { useStore } from '../state.js';
import { Modal } from './common.js';

export function Lightbox() {
  const lb = useStore((s) => s.lightbox);
  if (!lb) return null;
  const alt = lb.alt || 'Screenshot';
  return html`<${Modal} title=${alt} testid="lightbox" onClose=${closeDialog} class="modal-image">
    <img class="lightbox-img" src=${lb.src} alt=${alt} referrerpolicy="no-referrer" />
    ${/^https?:/i.test(lb.src)
      ? html`<p class="small lightbox-foot"><a href=${lb.src} target="_blank" rel="noopener noreferrer">Open in a new tab</a></p>`
      : null}
  <//>`;
}
