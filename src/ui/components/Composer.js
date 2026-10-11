// @ts-check
// The composer (design 11.4). It opens at the top of the side panel, or inside the drawer on narrow screens, for a
// capture from the doc (selection toolbar, picker, keys), the outline, Source mode or "General comment".
// - The anchor chip shows what the agent will see ("Agent will see: L42-43 §3.2 'rotated on every use'"), from the
//   server's /anchors/resolve preview. [Widen to block] (in the header) asks the server to resolve the capture as its
//   block. The preview resolves asynchronously, so it keeps a fixed two-line height: nothing below it moves.
// - Focus moves to the composer when it opens, also when a guest `action` opened it while focus was in the doc
//   iframe: the textarea, or the suggestion input once it is ready (unless the user already typed elsewhere).
// - Type chips (Comment / Question / Suggestion) and severity chips (Blocking / Normal / Nit, keys 1-3 outside the
//   textarea).
// - A Markdown textarea: paste or drop an image to attach it (re-encoded to PNG/JPEG, at most 5 MB).
// - Screenshots: the crop of a doc snip (b) or a picked region, and attached images (pasted, a screen snip with
//   Shift+B), show as thumbnails (TESTID.composerAttachment); a click shows one full size.
// - Add to review (Cmd/Ctrl+Enter) creates a draft. Send now (Cmd/Ctrl+Shift+Enter) submits a one-item review with
//   verdict `comment`. Cancel (Esc) closes the composer, with an Undo toast. The buttons show their keys.
// - Suggestions: text mode (an input prefilled with the exact slice) when the source slice equals the rendered
//   quote modulo whitespace; otherwise source mode (a monospace textarea with the anchor's whole lines). A live word
//   diff is shown, plus an optional rendered preview (/fragment, sanitised).
// - "Mark agreed" (type 'agree', from `a` or the outline menu) asks for confirmation, then creates a lock.

import { html, useEffect, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { docApi } from '../api.js';
import {
  attachImage, cancelComposer, errorText, openComposer, openLightbox, removeAttachment, resolveComposerAnchor,
  setComposerType, setSuggestionText, submitComposer, toast, updateComposer,
} from '../actions.js';
import { KEYS, shortcut } from '../keys.js';
import { SafeHtml } from '../markdown.js';
import { anchorChipParts, attachmentName, attachmentUrl, canSendNow, linesLabel } from '../model.js';
import { store, useStore } from '../state.js';
import { imageFileToDataUrl, isEditable } from '../util.js';
import { Spinner, WordDiff } from './common.js';

const TYPES = /** @type {const} */ ([
  { key: 'comment', label: 'Comment' },
  { key: 'question', label: 'Question' },
  { key: 'suggestion', label: 'Suggestion' },
]);
const SEVERITIES = /** @type {const} */ ([
  { key: 'blocking', label: 'Blocking', n: 1 },
  { key: 'normal', label: 'Normal', n: 2 },
  { key: 'nit', label: 'Nit', n: 3 },
]);

export function Composer() {
  const c = useStore((s) => s.composer);
  const bases = useStore((s) => ({ attachmentBase: s.ds?.attachmentBase, contentBase: s.ds?.contentBase }));
  const taRef = useRef(/** @type {HTMLTextAreaElement|null} */ (null));
  const rootRef = useRef(/** @type {HTMLElement|null} */ (null));

  useEffect(() => {
    if (!c) return;
    rootRef.current?.scrollIntoView({ block: 'nearest' });
    // Take the focus from wherever it is (often the doc iframe, when a guest `action` or a forwarded key opened the
    // composer): the textarea, or the suggestion input when it is already there. A suggestion's input appears once
    // the anchor is resolved; until then the textarea holds the focus so keys typed meanwhile are not shortcuts.
    // "Mark agreed" focuses its own button (AgreeForm).
    if (c.type === 'agree') return;
    const sug = /** @type {HTMLElement|null} */ (rootRef.current?.querySelector('.suggestion-editor [data-testid]') || null);
    (c.type === 'suggestion' && sug ? sug : taRef.current)?.focus({ preventScroll: true });
  }, [c?.key]);

  if (!c) return null;
  const chip = anchorChipParts(c.preview, c.anchor);
  const kind = c.capture?.kind || c.anchor?.kind;
  // Suggestions replace text: not for the whole doc or a section (also a snip or screen snip that resolved to one).
  const noSuggestion = ['doc', 'section'].includes(kind) || ['doc', 'section'].includes(c.anchor?.kind);
  const widenable = !c.draftId && c.capture?.kind === 'text';
  const title = c.draftId ? `Edit draft ${c.draftId}` : c.type === 'agree' ? 'Mark agreed' : 'New comment';
  const previewText = c.resolving ? 'Locating what the agent will see…'
    : typeof c.preview?.text === 'string' && c.preview.text ? c.preview.text
      : ['Agent will see:', chip.lines, chip.section, chip.label ? `“${chip.label}”` : ''].filter(Boolean).join(' ');

  /** @param {KeyboardEvent} e */
  const onRootKey = (e) => {
    // A dialog over the composer (a screenshot shown full size) gets its keys first (Esc closes it, not this).
    if (store.get().dialog) return;
    const el = /** @type {HTMLElement} */ (e.target);
    const typing = el.localName === 'textarea' || (el.localName === 'input' && /** @type {HTMLInputElement} */ (el).type === 'text');
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      // Cmd+Shift+Enter on a draft being edited or on "Mark agreed" bubbles up to the global Submit review.
      if (e.shiftKey && !canSendNow(c)) return;
      e.preventDefault();
      e.stopPropagation();
      submitComposer(e.shiftKey ? { sendNow: true } : {});
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelComposer();
      return;
    }
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && ['1', '2', '3'].includes(e.key) && c.type !== 'agree') {
      e.preventDefault();
      e.stopPropagation();
      updateComposer({ severity: SEVERITIES[Number(e.key) - 1].key });
    }
  };

  /** @param {ClipboardEvent} e */
  const onPaste = (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!items.length) return;
    e.preventDefault();
    for (const it of items) {
      const file = it.getAsFile();
      if (file) addImage(file);
    }
  };
  /** @param {DragEvent} e */
  const onDrop = (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) addImage(f);
  };

  return html`<section ref=${rootRef} class=${`composer type-${c.type}`} data-testid=${TESTID.composer} role="group" aria-label=${title}
    onKeyDown=${onRootKey}>
    <header class="composer-head"><strong>${title}</strong>${c.version ? html`<span class="small muted"> on v${c.version}</span>` : null}
      ${widenable && !(c.resolveError && !c.resolving) ? html`<button type="button" class="link-btn widen-btn" disabled=${c.resolving}
        onClick=${() => resolveComposerAnchor(!c.widened)}>${c.widened ? 'Back to selection' : 'Widen to block'}</button>` : null}</header>
    <div class=${`anchor-preview ${c.resolveError && !c.resolving ? 'is-error' : ''}`} aria-live="polite">
      ${c.resolving
        ? html`<span class="preview-text muted"><${Spinner} label="Locating" /> Locating what the agent will see…</span>`
        : c.resolveError
          ? html`<span class="preview-text error">Could not anchor this: ${c.resolveError}</span>
              <button type="button" class="link-btn" onClick=${() => {
                // Keeps what was written and the screenshots (a snip that could not be anchored still has its crop).
                const { body, crop, attachments } = c;
                store.set({ composer: null });
                openComposer({ capture: { kind: 'doc' }, body, crop, attachments });
              }}>Make it a general comment</button>`
          : typeof c.preview?.text === 'string' && c.preview.text
            ? html`<span class="preview-text agent-sees" data-anchor-lines=${chip.lines} title=${previewText}>${c.preview.text}</span>`
            : html`<span class="preview-text agent-sees" data-anchor-lines=${chip.lines} title=${previewText}><span class="muted">Agent will see:</span>
              ${chip.lines ? html` <strong>${chip.lines}</strong>` : null}${chip.section ? html` <span>${chip.section}</span>` : null}
              ${chip.label ? html` <q>${chip.label}</q>` : null}</span>`}
    </div>
    ${c.crop ? html`<button type="button" class="thumb-btn crop-btn" title="Show full size"
      onClick=${() => openLightbox(/** @type {string} */ (c.crop), cropAlt(c.capture))}>
      <img class="crop" data-testid=${TESTID.composerAttachment} data-attachment="crop" src=${c.crop} alt=${cropAlt(c.capture)} /></button>` : null}
    ${c.type === 'agree' ? html`<${AgreeForm} c=${c} kind=${kind} />` : html`
      <div class="chip-row" role="radiogroup" aria-label="Type">
        ${TYPES.map((t) => html`<button type="button" role="radio" aria-checked=${c.type === t.key}
          class=${`chip-toggle ${c.type === t.key ? 'on' : ''}`} onClick=${() => setComposerType(t.key)}
          disabled=${t.key === 'suggestion' && noSuggestion}>${t.label}</button>`)}
      </div>
      <div class="chip-row" role="radiogroup" aria-label="Severity">
        ${SEVERITIES.map((sv) => html`<button type="button" role="radio" aria-checked=${c.severity === sv.key}
          class=${`chip-toggle sev-${sv.key} ${c.severity === sv.key ? 'on' : ''}`} title=${`${sv.label} (${sv.n})`}
          onClick=${() => updateComposer({ severity: sv.key })}>${sv.label}</button>`)}
      </div>
      ${c.type === 'suggestion' ? html`<${SuggestionEditor} c=${c} />` : null}
      <label class="sr-only" for="sr-composer-body">Comment</label>
      <textarea ref=${taRef} id="sr-composer-body" data-testid=${TESTID.composerTextarea} rows=${c.type === 'suggestion' ? 2 : 4}
        value=${c.body} placeholder=${c.type === 'suggestion' ? 'Why? (optional, Markdown)' : c.type === 'question' ? 'Ask a question (Markdown)'
          : c.crop || c.attachments.length ? 'What about this screenshot? (Markdown, optional)' : 'Leave a comment (Markdown). Paste an image to attach it.'}
        onInput=${(/** @type {any} */ e) => updateComposer({ body: e.currentTarget.value })} onPaste=${onPaste} onDrop=${onDrop}></textarea>
      ${c.attachments.length ? html`<ul class="attach-list">${c.attachments.map((a) => {
        const src = a.preview || attachmentUrl(bases, a.path);
        const name = attachmentName(a.path);
        return html`<li key=${a.path}>
          ${src ? html`<button type="button" class="thumb-btn" title=${`Show ${name} full size`} onClick=${() => openLightbox(src, name)}>
            <img data-testid=${TESTID.composerAttachment} data-attachment=${a.path} src=${src} alt=${`Attached screenshot ${name}`} /></button>` : null}
          <span class="small">${name}</span>
          <button type="button" class="link-btn danger" onClick=${() => removeAttachment(a.path)} aria-label=${`Remove ${a.path}`}>Remove</button>
        </li>`;
      })}</ul>` : null}
      ${c.error ? html`<p class="error small" role="alert">${c.error}</p>` : null}
      <div class="composer-actions">
        <button type="button" class="btn btn-primary" data-testid=${TESTID.composerAdd} disabled=${c.busy || c.resolving}
          onClick=${() => submitComposer()} title=${`${c.draftId ? 'Save the draft' : 'Add to the review, send it later with Submit review'} (${shortcut(KEYS.add)})`}
          aria-keyshortcuts="Meta+Enter Control+Enter">${c.draftId ? 'Save draft' : 'Add to review'}<kbd class="btn-kbd" aria-hidden="true">${shortcut(KEYS.add, { compact: true })}</kbd></button>
        ${c.draftId ? null : html`<button type="button" class="btn" data-testid=${TESTID.composerSendNow} disabled=${c.busy || c.resolving}
          onClick=${() => submitComposer({ sendNow: true })} title=${`Send just this comment to the agent now, as a review with verdict comment (${shortcut(KEYS.sendNow)})`}
          aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter">Send now<kbd class="btn-kbd" aria-hidden="true">${shortcut(KEYS.sendNow, { compact: true })}</kbd></button>`}
        <button type="button" class="btn" onClick=${cancelComposer} title="Cancel (Esc)" aria-keyshortcuts="Escape">Cancel</button>
        ${c.busy ? html`<${Spinner} label="Saving" />` : null}
      </div>`}
  </section>`;
}

/** Alt text of a crop: what was snipped or picked. @param {any} capture */
function cropAlt(capture) {
  if (capture?.kind === 'snip') return `Snip of ${String(capture.label || 'an area of the document')}`;
  return 'Crop of the selected region';
}

/** @param {Blob} file */
async function addImage(file) {
  try {
    const url = await imageFileToDataUrl(file);
    await attachImage(url);
  } catch (err) {
    toast(`Image not attached: ${errorText(err)}`, { tone: 'danger' });
  }
}

/** @param {{ c: any, kind: string }} props */
function AgreeForm({ c, kind }) {
  const ref = useRef(/** @type {HTMLButtonElement|null} */ (null));
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return html`<div class="agree-form">
    <p>Mark this ${kind === 'section' ? 'section' : 'part'} as <strong>agreed</strong>? Revisions that change it will be refused
      unless the agent breaks the lock with a reason.</p>
    <label for="sr-lock-note" class="small">Note (optional)</label>
    <input id="sr-lock-note" type="text" value=${c.note} placeholder="Agreed" onInput=${(/** @type {any} */ e) => updateComposer({ note: e.currentTarget.value })} />
    ${c.error ? html`<p class="error small" role="alert">${c.error}</p>` : null}
    <div class="composer-actions">
      <button ref=${ref} type="button" class="btn btn-primary" disabled=${c.busy || c.resolving} onClick=${() => submitComposer()}>Mark agreed</button>
      <button type="button" class="btn" onClick=${cancelComposer}>Cancel</button>
    </div>
  </div>`;
}

/** @param {{ c: any }} props */
function SuggestionEditor({ c }) {
  const s = c.suggestion;
  const [preview, setPreview] = useState(/** @type {{ html: string|null, loading: boolean, error: string|null }} */ ({ html: null, loading: false, error: null }));
  const inputRef = useRef(/** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (null));
  useEffect(() => {
    const input = inputRef.current;
    if (!s || s.loading || !input) return;
    // The input appears after the composer opened (the anchor resolves first): take the focus unless the user has
    // already typed in another field or moved on outside the composer.
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const root = input.closest('.composer');
    const idle = !active || active === document.body
      || (!!root && root.contains(active) && !(isEditable(active) && /** @type {HTMLTextAreaElement} */ (active).value));
    if (idle) input.focus({ preventScroll: true });
  }, [!!s, s?.loading]);
  if (c.resolving || !s || s.loading) {
    if (!c.resolving && !c.anchor?.src) return html`<p class="small muted">Suggestions need a text, element or source anchor.</p>`;
    return html`<p class="small muted sugg-loading"><${Spinner} /> Loading the source…</p>`;
  }
  const single = s.mode === 'text' && !String(s.old).includes('\n');

  const loadPreview = async () => {
    const r = store.get().route;
    if (r.view !== 'doc') return;
    setPreview({ html: null, loading: true, error: null });
    try {
      const out = await docApi(r.ws, r.doc).fragment(s.new);
      setPreview({ html: String(out?.html ?? ''), loading: false, error: null });
    } catch (err) {
      setPreview({ html: null, loading: false, error: errorText(err) });
    }
  };

  return html`<div class="suggestion-editor">
    <div class="sugg-head">
      <strong>${s.mode === 'text' ? 'Replace the text with' : 'Replace the source lines with'}</strong>
      <span class="small muted">${linesLabel([s.startLine, s.endLine])} · ${s.mode === 'text' ? 'text mode' : 'source mode'}</span>
    </div>
    ${single
      ? html`<input ref=${inputRef} type="text" class="mono" data-testid=${TESTID.composerSuggestion} aria-label="Suggested text" value=${s.new}
          onInput=${(/** @type {any} */ e) => setSuggestionText(e.currentTarget.value)} />`
      : html`<textarea ref=${inputRef} class="mono" data-testid=${TESTID.composerSuggestion} aria-label="Suggested source"
          rows=${Math.min(14, Math.max(3, String(s.new).split('\n').length + 1))} value=${s.new} spellcheck="false"
          onInput=${(/** @type {any} */ e) => setSuggestionText(e.currentTarget.value)}></textarea>`}
    <div class="live-diff" aria-label="Word diff of the suggestion">
      ${s.new === s.old ? html`<span class="small muted">Edit the text above to suggest a change.</span>` : html`<${WordDiff} before=${s.old} after=${s.new} class="mono" />`}
    </div>
    ${s.new !== s.old ? html`<button type="button" class="link-btn" onClick=${loadPreview}>${preview.loading ? 'Rendering…' : 'Preview rendered'}</button>` : null}
    ${preview.error ? html`<p class="small error">${preview.error}</p>` : null}
    ${preview.html != null ? html`<${SafeHtml} fragment=${preview.html} class="fragment-preview" />` : null}
  </div>`;
}
