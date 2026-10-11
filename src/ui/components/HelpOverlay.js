// @ts-check
// Keyboard shortcuts overlay (`?`, design 11.8).

import { html } from 'preact-htm';
import { closeDialog } from '../actions.js';
import { KEYMAP } from '../keys.js';
import { Modal } from './common.js';

export function HelpOverlay() {
  return html`<${Modal} title="Keyboard shortcuts" testid="help-overlay" onClose=${closeDialog}>
    <table class="keymap">
      <tbody>
        ${KEYMAP.map((row) => html`<tr key=${row.label}>
          <td class="keys">${row.keys.map((k, i) => html`${i ? ' ' : ''}<kbd>${k}</kbd>`)}</td>
          <td>${row.label}</td>
        </tr>`)}
      </tbody>
    </table>
    <p class="small muted">Keys typed inside the document are forwarded here; resolve / reopen keys (x o y) only work with focus in this panel. In the composer: <kbd>1</kbd>-<kbd>3</kbd> set the severity.</p>
  <//>`;
}
