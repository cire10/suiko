// @ts-check
// Keyboard shortcuts overlay (Cmd/Ctrl+/ or `?`, the top bar's help button; design 11.8), generated from the command
// registry (commands.js), so it lists exactly the keys the palette shows. Grouped: Comment / Review / Navigate /
// View / App. Keys are shown the way this platform writes them (⌘⇧↵ on a Mac, Ctrl+Shift+Enter elsewhere); rows
// carry data-key-row (the command or help-row id) so tests and docs can point at them.
// A filter box narrows the rows (typing a letter while the overlay has focus starts filtering). When single-letter
// shortcuts are off (Settings), their keys show as "off (Settings)".

import { html, useMemo, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { closeDialog, openDialog } from '../actions.js';
import { helpGroups } from '../commands.js';
import { shortcut } from '../keys.js';
import { docKindOf, isSingleKeyCombo, matchRow } from '../model.js';
import { useStore } from '../state.js';
import { IS_MAC, isEditable } from '../util.js';
import { Modal } from './common.js';

export function HelpOverlay() {
  const singleKeys = useStore((s) => s.prefs.singleKeys);
  const kind = useStore((s) => (s.route.view === 'doc' && s.ds ? docKindOf(s.ds) : 'file'));
  const [query, setQuery] = useState('');
  const filterRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const groups = useMemo(() => helpGroups(kind), [kind]);
  const q = query.trim();
  const shown = groups.map((g) => ({
    group: g.group,
    rows: g.rows.filter((row) => !q || !!matchRow(q, {
      title: row.label,
      category: g.group,
      keywords: [...row.commands, ...row.keys.map((k) => shortcut(k)), ...row.keys],
    })),
  })).filter((g) => g.rows.length);

  /** Typing a character while the overlay (not a field in it) has focus goes to the filter. @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (e.key.length !== 1 || e.key === '?' || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
    filterRef.current?.focus();
  };

  return html`<${Modal} title="Keyboard shortcuts" testid=${TESTID.helpOverlay} onClose=${closeDialog} wide onKeyDown=${onKeyDown}>
    <div class="help-filter">
      <label class="sr-only" for="sr-help-filter">Filter shortcuts</label>
      <input ref=${filterRef} id="sr-help-filter" type="search" class="help-filter-input" placeholder="Filter shortcuts…"
        value=${query} autocomplete="off" spellcheck="false" onInput=${(/** @type {any} */ e) => setQuery(e.currentTarget.value)} />
    </div>
    ${!singleKeys ? html`<p class="small warn-text help-off" role="note">Single-letter shortcuts are off.
      <button type="button" class="link-btn" onClick=${() => openDialog('settings')}>Turn them on in Settings</button></p>` : null}
    ${shown.length ? html`<table class="keymap">
      ${shown.map((g) => html`<tbody key=${g.group}>
        <tr class="keymap-group"><th colspan="2" scope="colgroup">${g.group}</th></tr>
        ${g.rows.map((row) => {
          const keys = singleKeys ? row.keys : row.keys.filter((k) => !isSingleKeyCombo(k));
          return html`<tr key=${row.id} data-key-row=${row.id}>
            <td class="keys">${keys.length
              ? keys.map((k, i) => html`${i ? ' ' : ''}<kbd>${shortcut(k)}</kbd>`)
              : html`<span class="key-off" title="Single-letter shortcuts are off">off (Settings)</span>`}</td>
            <td>${row.label}</td>
          </tr>`;
        })}
      </tbody>`)}
    </table>` : html`<p class="muted small">No shortcut matches “${q}”.</p>`}
    <p class="small muted">Keys typed inside the document are forwarded here; resolve / reopen keys (x o y), Add to review and
      Send now only work with focus in this panel. In the composer: <kbd>1</kbd>-<kbd>3</kbd> set the severity. Paste an
      image into a comment to attach it.${IS_MAC ? html` On a Mac, <kbd>⌃K</kbd>, <kbd>⌃,</kbd> and <kbd>⌃/</kbd> work too.` : null}</p>
    <p class="small help-foot">Everything is also in the command palette (<kbd>${shortcut('mod+k')}</kbd>). Settings: <kbd>${shortcut('mod+,')}</kbd></p>
  <//>`;
}
