// @ts-check
// Keyboard shortcuts overlay (`?`, design 11.8), grouped: Comment / Review / Navigate / View. Keys are shown the way
// this platform writes them (⌘⇧↵ on a Mac, Ctrl+Shift+Enter elsewhere); rows with an id carry data-key-row so tests
// and docs can point at them.

import { html } from 'preact-htm';
import { closeDialog } from '../actions.js';
import { KEYMAP, shortcut } from '../keys.js';
import { Modal } from './common.js';

export function HelpOverlay() {
  return html`<${Modal} title="Keyboard shortcuts" testid="help-overlay" onClose=${closeDialog} wide>
    <table class="keymap">
      ${KEYMAP.map((g) => html`<tbody key=${g.group}>
        <tr class="keymap-group"><th colspan="2" scope="colgroup">${g.group}</th></tr>
        ${g.rows.map((row) => html`<tr key=${row.label} data-key-row=${row.id}>
          <td class="keys">${row.keys.map((k, i) => html`${i ? ' ' : ''}<kbd>${shortcut(k)}</kbd>`)}</td>
          <td>${row.label}</td>
        </tr>`)}
      </tbody>`)}
    </table>
    <p class="small muted">Keys typed inside the document are forwarded here; resolve / reopen keys (x o y), Add to review and
      Send now only work with focus in this panel. In the composer: <kbd>1</kbd>-<kbd>3</kbd> set the severity. Paste an
      image into a comment to attach it.</p>
  <//>`;
}
