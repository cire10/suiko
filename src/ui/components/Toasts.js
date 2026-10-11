// @ts-check
// Toast notifications in an aria-live region (design 11.9). Actions run on click only.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import { dismissToast } from '../actions.js';
import { useStore } from '../state.js';
import { Icon } from './common.js';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div class="toasts" role="status" aria-live="polite" aria-relevant="additions">
    ${toasts.map((t) => html`<div class=${`toast tone-${t.tone}`} data-testid=${TESTID.toast} key=${t.id}>
      <span class="toast-text">${t.text}</span>
      ${t.actions.map((a) => html`<button type="button" class="btn btn-sm" onClick=${() => { dismissToast(t.id); a.run(); }}>${a.label}</button>`)}
      <button type="button" class="icon-btn icon-btn-xs" aria-label="Dismiss" onClick=${() => dismissToast(t.id)}><${Icon} name="close" size=${14} /></button>
    </div>`)}
  </div>`;
}
