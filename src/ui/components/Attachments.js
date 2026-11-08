// @ts-check
// Files shown in a thread (components/ThreadCard.js, kinds/InlineThread.js):
// - Screenshots: the reviewer's images on a thread or draft (snips, picked regions, pasted images, `suiko snip`) as
//   thumbnails; a click shows one full size (Lightbox). Without an attachment URL (a daemon that serves none) only
//   the file names are listed.
// - AgentAttachments: what the agent attached to a reply (Comment.attachments {path, name, kind}; rich replies):
//   - pictures (png, jpg, gif, webp, svg) as thumbnails at most 160 px tall; a click shows one in the image viewer
//     (PreviewOverlay -> Lightbox.js ImageView: fitted to the view, a small one scaled up at most 2x);
//   - an HTML attachment (a chart, a mock-up, a table) as a live preview card: a 260 px tall
//     <iframe sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy">, never with allow-same-origin, so
//     it runs in an opaque origin (the content origin also serves it with its own CSP): it can draw, but it cannot
//     reach the doc, the UI, the reviewer's screenshots or the network beyond what that CSP allows. Its footer has the
//     file name, "Open large" (PreviewOverlay: the same frame at about 92vw x 86vh) and "Use in doc".
//   - "Use in doc" (TESTID.useAttachment) on every attachment: a reply on the thread asking the agent to put that
//     file into the doc (actions.js useAttachment: sent at once, or a draft when sending is batched).
// - PreviewOverlay (dialog 'preview'): an agent's picture or HTML attachment shown large, with the thread's footer
//   "From t7 · Reply · Use in doc" (Reply opens the thread's reply box with "About chart.html: " to ask for another
//   take). Esc closes it and the focus goes back to the button. A click in the sandboxed HTML preview takes the
//   focus into a frame whose keys never reach the UI, so the focus comes back to the dialog as soon as the pointer
//   leaves the frame, and a visible "Close (Esc)" button is always there.
// URLs are DocState.attachmentBase plus the file name, on the content origin only (model.js attachmentUrl).

import { html, useEffect, useRef } from 'preact-htm';
import { TESTID } from 'protocol';
import { closeDialog, openLightbox, openPreview, startReply, useAttachment } from '../actions.js';
import { agentAttachments, attachmentName, attachmentUrl, sendModeOf } from '../model.js';
import { useStore } from '../state.js';
import { Icon, Modal } from './common.js';
import { ImageView } from './Lightbox.js';

/**
 * Thumbnails of the screenshots of a thread or draft; a click shows one full size.
 * @param {{ paths: unknown, ds: any }} props
 */
export function Screenshots({ paths, ds }) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
  if (!list.length) return null;
  const urls = list.map((p) => attachmentUrl(ds, p));
  if (!urls.some(Boolean)) {
    return html`<p class="attachments small muted">${list.length} attachment${list.length > 1 ? 's' : ''}
      (${list.map(attachmentName).join(', ')})</p>`;
  }
  return html`<ul class="card-attachments" aria-label=${`${list.length} attachment${list.length > 1 ? 's' : ''}`}>
    ${list.map((p, i) => {
      const src = urls[i];
      const name = attachmentName(p);
      return html`<li key=${p}>${src
        ? html`<button type="button" class="thumb-btn" title=${`Show ${name} full size`} onClick=${() => openLightbox(src, name)}>
            <img src=${src} alt=${`Screenshot ${name}`} loading="lazy" referrerpolicy="no-referrer" data-attachment=${p} /></button>`
        : html`<span class="small muted">${name}</span>`}</li>`;
    })}
  </ul>`;
}

/**
 * The files an agent attached to one reply: pictures as thumbnails, HTML as a sandboxed live preview, each with
 * "Use in doc".
 * @param {{ comment: any, ds: any, threadId: string, canUse: boolean, busy?: boolean, compact?: boolean }} props
 *   canUse: the reviewer can reply (a recorded version is shown); compact: the inline card of a code review (no
 *   live preview: its name and Open large only)
 */
export function AgentAttachments({ comment, ds, threadId, canUse, busy = false, compact = false }) {
  const list = agentAttachments(comment);
  if (!list.length) return null;
  const images = list.filter((a) => a.kind === 'image');
  const pages = list.filter((a) => a.kind === 'html');
  return html`<div class="agent-attachments">
    ${images.length ? html`<ul class="agent-images" aria-label=${`${images.length} picture${images.length === 1 ? '' : 's'}`}>
      ${images.map((a) => {
        const src = attachmentUrl(ds, a.path);
        return html`<li key=${a.path} class="agent-image">
          ${src ? html`<button type="button" class="thumb-btn agent-thumb" title=${`Show ${a.name} large`}
            onClick=${() => openPreview({ src, name: a.name, threadId, path: a.path })}>
            <img src=${src} alt=${a.name} loading="lazy" referrerpolicy="no-referrer" data-attachment=${a.path} /></button>`
            : html`<span class="small muted">${a.name}</span>`}
          <div class="attachment-foot">
            <span class="attachment-name" title=${a.name}>${a.name}</span>
            ${canUse ? html`<${UseButton} threadId=${threadId} path=${a.path} name=${a.name} busy=${busy} />` : null}
          </div>
        </li>`;
      })}
    </ul>` : null}
    ${pages.map((a) => {
      const src = attachmentUrl(ds, a.path);
      return html`<div class=${`preview-card${compact ? ' is-compact' : ''}`} key=${a.path} data-attachment=${a.path}>
        ${src && !compact ? html`<${PreviewFrame} src=${src} name=${a.name} />` : null}
        <div class="attachment-foot">
          <${Icon} name="window" size=${14} />
          <span class="attachment-name" title=${a.name}>${a.name}</span>
          ${src ? html`<button type="button" class="link-btn" onClick=${() => openPreview({ src, name: a.name, threadId, path: a.path })}
            title=${`Show ${a.name} large`}>Open large</button>` : null}
          ${canUse ? html`<${UseButton} threadId=${threadId} path=${a.path} name=${a.name} busy=${busy} />` : null}
        </div>
      </div>`;
    })}
  </div>`;
}

/**
 * An agent's HTML attachment, live: scripts run (charts draw) in an opaque origin, nothing else is allowed.
 * @param {{ src: string, name: string, large?: boolean, frameRef?: any }} props
 */
function PreviewFrame({ src, name, large = false, frameRef }) {
  return html`<iframe ref=${frameRef} class=${`preview-frame${large ? ' is-large' : ''}`} src=${src} title=${`Preview: ${name}`}
    sandbox="allow-scripts" referrerpolicy="no-referrer" loading=${large ? 'eager' : 'lazy'}></iframe>`;
}

/** @param {{ threadId: string, path: string, name: string, busy?: boolean }} props */
function UseButton({ threadId, path, name, busy = false }) {
  const batch = useStore((s) => sendModeOf(s) === 'batch');
  return html`<button type="button" class="btn btn-sm use-btn" data-testid=${TESTID.useAttachment} disabled=${busy}
    title=${batch ? `Add a reply to your review asking to put ${name} into the document` : `Ask to put ${name} into the document now`}
    onClick=${() => useAttachment(threadId, path)}><${Icon} name="insert" size=${14} />Use in doc</button>`;
}

/**
 * Reply on the attachment's thread, "About chart.html: " ready to go on: the reply box of that thread, with the text
 * when it opens empty (startReply's prefill: a box with words in it, or a reply draft, keeps its own).
 * @param {{ name: string, threadId: string }} p
 */
function replyAbout(p) {
  closeDialog();
  startReply(p.threadId, { body: `About ${p.name}: ` });
}

/**
 * The footer of an agent's attachment shown large: where it is from, and what to do with it: Reply (another take,
 * "About chart.html: ") and Use in doc, while a recorded version is shown.
 * @param {{ p: { name: string, threadId: string, path: string }, canUse: boolean, children?: any }} props children: more
 *   buttons at the end
 */
function PreviewFoot({ p, canUse, children }) {
  return html`<div class="preview-foot">
    <span class="small muted" title=${`${p.name}, attached to ${p.threadId}`}>From ${p.threadId}</span>
    <span class="spacer"></span>
    ${canUse ? html`<button type="button" class="btn btn-sm preview-reply" title=${`Reply on ${p.threadId} about ${p.name}: ask for another take`}
      onClick=${() => replyAbout(p)}><${Icon} name="comment" size=${14} />Reply</button>
    <button type="button" class="btn btn-sm" data-testid=${TESTID.useAttachment}
      onClick=${() => { closeDialog(); useAttachment(p.threadId, p.path); }}><${Icon} name="insert" size=${14} />Use in doc</button>` : null}
    ${children}
  </div>`;
}

/**
 * An agent's attachment shown large (dialog 'preview'): a picture in the image viewer, an HTML attachment in the same
 * sandboxed frame as its card, both with the thread's footer.
 */
export function PreviewOverlay() {
  const p = useStore((s) => s.preview);
  const canUse = useStore((s) => s.version !== 'live' && !!s.ds);
  const frameRef = useRef(/** @type {HTMLIFrameElement|null} */ (null));
  const closeRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const isPage = !!p && /\.html?$/i.test(p.path);
  // The frame's own keys (Esc) never reach the UI: as soon as the pointer is over anything else (the dialog's title or
  // footer, the backdrop), the focus comes back to the dialog, on its Close button.
  useEffect(() => {
    if (!isPage) return undefined;
    /** @param {Event} e */
    const reclaim = (e) => {
      const frame = frameRef.current;
      if (frame && e.target !== frame && document.activeElement === frame) closeRef.current?.focus({ preventScroll: true });
    };
    // pointermove, not pointerover: Chrome does not always send boundary events when the pointer leaves a frame
    document.addEventListener('pointermove', reclaim, { capture: true, passive: true });
    return () => document.removeEventListener('pointermove', reclaim, { capture: true });
  }, [isPage]);
  if (!p) return null;
  if (!isPage) {
    return html`<${ImageView} src=${p.src} alt=${p.name}><${PreviewFoot} p=${p} canUse=${canUse} /><//>`;
  }
  return html`<${Modal} title=${p.name} testid="attachment-preview" onClose=${closeDialog} class="modal-preview">
    <${PreviewFrame} src=${p.src} name=${p.name} large=${true} frameRef=${frameRef} />
    <${PreviewFoot} p=${p} canUse=${canUse}>
      <button ref=${closeRef} type="button" class="btn btn-sm preview-close" onClick=${closeDialog}
        title="Close (Esc)">Close <kbd>Esc</kbd></button>
    <//>
  <//>`;
}
