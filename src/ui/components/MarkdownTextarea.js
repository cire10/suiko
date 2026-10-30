// @ts-check
// The text box for what the reviewer writes (comments, replies, the review summary): a textarea under a small
// formatting toolbar: Bold (Cmd/Ctrl+B), Bulleted list (Cmd/Ctrl+Shift+8), Numbered list (Cmd/Ctrl+Shift+7). Enter
// continues a list. The text stays plain Markdown (md-edit.js makes the edits): the cards render it, and the agent
// reads it as written.
// The box grows with its text up to a limit (max-height in the CSS, then it scrolls); it never shrinks while typing,
// so a height the reviewer dragged it to holds.

import { html, useLayoutEffect, useRef } from 'preact-htm';
import { KEYS, shortcut } from '../keys.js';
import { continueList, formatKey, toggleBold, toggleList } from '../md-edit.js';
import { useStore } from '../state.js';
import { IS_MAC } from '../util.js';
import { Icon } from './common.js';

/** @typedef {import('../md-edit.js').TextEdit} TextEdit */
/** @typedef {import('../md-edit.js').TextState} TextState */

const TOOLS = /** @type {const} */ ([
  { id: 'bold', label: 'Bold', icon: 'bold', weight: 3, combo: KEYS.bold, aria: 'B', edit: toggleBold },
  { id: 'bullet', label: 'Bulleted list', icon: 'listBullet', weight: 2, combo: KEYS.bulletList, aria: 'Shift+8', edit: (/** @type {TextState} */ s) => toggleList(s, 'bullet') },
  { id: 'number', label: 'Numbered list', icon: 'listNumber', weight: 2, combo: KEYS.numberedList, aria: 'Shift+7', edit: (/** @type {TextState} */ s) => toggleList(s, 'number') },
]);

/** @param {HTMLTextAreaElement} ta @returns {TextState} */
const stateOf = (ta) => ({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });

/**
 * Applies an edit through execCommand, the one way of changing a textarea that its undo history (Cmd/Ctrl+Z) keeps,
 * and which fires the `input` event the owner listens to. Otherwise the text is set directly.
 * @param {HTMLTextAreaElement} ta
 * @param {TextEdit} edit
 */
function applyEdit(ta, { from, to, text, start, end }) {
  ta.focus({ preventScroll: true });
  if (from !== to || text) {
    ta.setSelectionRange(from, to);
    const before = ta.value;
    let done = false;
    try {
      done = document.execCommand(text ? 'insertText' : 'delete', false, text);
    } catch {
      done = false;
    }
    if (!done || ta.value === before) {
      ta.setRangeText(text, from, to);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  ta.setSelectionRange(start, end);
}

/**
 * Takes the props of the textarea it renders, plus:
 * @param {{ inputRef?: { current: HTMLTextAreaElement|null }, testid?: string, value: string,
 *   onKeyDown?: (e: KeyboardEvent) => void, [prop: string]: any }} props inputRef: the textarea element
 */
export function MarkdownTextarea({ inputRef, testid, value, onKeyDown, ...rest }) {
  const own = useRef(/** @type {HTMLTextAreaElement|null} */ (null));
  const ref = inputRef ?? own;
  // A panel made narrower wraps the text into more lines.
  const panelWidth = useStore((s) => s.panelWidth);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (ta && ta.scrollHeight > ta.clientHeight) ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`;
  }, [value, panelWidth]);

  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    const ta = ref.current;
    if (ta && !e.isComposing) {
      const command = formatKey(e, IS_MAC);
      const edit = command ? TOOLS.find((t) => t.id === command)?.edit(stateOf(ta))
        : e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey ? continueList(stateOf(ta)) : null;
      if (edit) {
        e.preventDefault();
        applyEdit(ta, edit);
        return;
      }
    }
    onKeyDown?.(e);
  };

  // Pressing a tool leaves the focus and the selection in the textarea (and a tool used by keyboard gives it back).
  return html`<div class="md-input">
    <div class="md-toolbar" role="toolbar" aria-label="Formatting" onMouseDown=${(/** @type {MouseEvent} */ e) => e.preventDefault()}>
      ${TOOLS.map((t) => html`<button type="button" key=${t.id} class="icon-btn icon-btn-xs" aria-label=${t.label} title=${`${t.label} (${shortcut(t.combo)})`}
        aria-keyshortcuts=${`${IS_MAC ? 'Meta' : 'Control'}+${t.aria}`} onClick=${() => { if (ref.current) applyEdit(ref.current, t.edit(stateOf(ref.current))); }}>
        <${Icon} name=${t.icon} size=${14} weight=${t.weight} /></button>`)}
    </div>
    <textarea ...${rest} ref=${ref} data-testid=${testid} value=${value} onKeyDown=${onKey}></textarea>
  </div>`;
}
