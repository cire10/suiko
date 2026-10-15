// @ts-check
// Settings (Cmd/Ctrl+, or the gear in the top bar): per-browser preferences that apply at once (no Save button) and
// are remembered in localStorage. Esc closes it.
//   Appearance  Theme: System / Light / Dark (the same state as the `t` key).
//   Layout      Outline rail: Auto / Always / Never; Thread panel open by default.
//   Keyboard    Single-letter shortcuts on / off (off: c, j, b, 1, ? ... do nothing, in the UI and in the doc).
//   Behaviour   Default view (what a doc opens in: Changes when revised / Read / Review); when the agent records a
//               new version: toast / switch to Changes; Ask before Send now; the default verdict when nothing is
//               blocking.
//   About       Suiko version, workspace root, spec path, the UI / content ports, and the "tell the agent"
//               prompt to copy.

import { html } from 'preact-htm';
import { TESTID } from 'protocol';
import { applyTheme, closeDialog, copyAgentPrompt, setPref, specPath, workspaceRoot } from '../actions.js';
import { shortcut } from '../keys.js';
import { agentPrompt } from '../model.js';
import { useStore } from '../state.js';
import { Modal } from './common.js';

/**
 * A row of radio buttons styled as a segmented control.
 * @param {{ name: string, label: string, value: string, options: Array<[string, string]>, onChange: (v: string) => void }} props
 */
function Choice({ name, label, value, options, onChange }) {
  return html`<div class="seg seg-choice" role="radiogroup" aria-label=${label} data-setting=${name}>
    ${options.map(([v, text]) => html`<label class=${`seg-opt ${value === v ? 'on' : ''}`} key=${v}>
      <input type="radio" name=${`sr-set-${name}`} value=${v} checked=${value === v} onChange=${() => onChange(v)} />
      <span>${text}</span>
    </label>`)}
  </div>`;
}

/**
 * An on / off switch.
 * @param {{ name: string, label: string, checked: boolean, onChange: (v: boolean) => void }} props
 */
function Switch({ name, label, checked, onChange }) {
  return html`<label class="switch" data-setting=${name}>
    <input type="checkbox" role="switch" checked=${checked} aria-checked=${checked ? 'true' : 'false'}
      onChange=${(/** @type {any} */ e) => onChange(!!e.currentTarget.checked)} />
    <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
    <span class="sr-only">${label}</span>
  </label>`;
}

/**
 * @param {{ title: string, hint?: any, children?: any, id: string }} props
 */
function Setting({ title, hint, children, id }) {
  return html`<div class="setting">
    <div class="setting-text">
      <span class="setting-title" id=${id}>${title}</span>
      ${hint ? html`<span class="setting-hint small muted">${hint}</span>` : null}
    </div>
    <div class="setting-control">${children}</div>
  </div>`;
}

export function SettingsDialog() {
  const s = useStore((st) => ({
    theme: st.theme,
    prefs: st.prefs,
    ds: st.ds,
    about: st.about,
    root: workspaceRoot(st),
    path: specPath(st),
    onDoc: st.route.view === 'doc' && !!st.ds,
  }));
  const p = s.prefs;
  return html`<${Modal} title="Settings" testid=${TESTID.settingsDialog} onClose=${closeDialog} wide>
    <div class="settings">
      <section class="settings-section" aria-labelledby="sr-set-h-appearance">
        <h3 id="sr-set-h-appearance">Appearance</h3>
        <${Setting} id="sr-set-theme" title="Theme" hint=${html`Also <kbd>t</kbd>. Markdown documents follow it; raw HTML keeps its own styling.`}>
          <${Choice} name="theme" label="Theme" value=${s.theme}
            options=${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} onChange=${(/** @type {any} */ v) => applyTheme(v)} />
        <//>
      </section>

      <section class="settings-section" aria-labelledby="sr-set-h-layout">
        <h3 id="sr-set-h-layout">Layout</h3>
        <${Setting} id="sr-set-rail" title="Outline rail"
          hint="Auto: beside the document in a wide window, behind the menu button when narrower. Never: always behind the button.">
          <${Choice} name="railMode" label="Outline rail" value=${p.railMode}
            options=${[['auto', 'Auto'], ['always', 'Always'], ['never', 'Never']]} onChange=${(/** @type {any} */ v) => setPref('railMode', v)} />
        <//>
        <${Setting} id="sr-set-panel" title="Thread panel open by default" hint=${html`<kbd>\\</kbd> still shows or hides it at any time.`}>
          <${Switch} name="panelOpen" label="Thread panel open by default" checked=${p.panelOpen} onChange=${(v) => setPref('panelOpen', v)} />
        <//>
      </section>

      <section class="settings-section" aria-labelledby="sr-set-h-keyboard">
        <h3 id="sr-set-h-keyboard">Keyboard</h3>
        <${Setting} id="sr-set-keys" title="Single-letter shortcuts"
          hint=${html`Keys like <kbd>c</kbd>, <kbd>j</kbd>, <kbd>b</kbd>, <kbd>1</kbd> and <kbd>?</kbd>, in this panel and in the
            document. Turn them off if the document has its own keyboard controls, you use speech input, or you press keys by
            accident: <kbd>Esc</kbd>, <kbd>${shortcut('mod+k')}</kbd>, <kbd>${shortcut('mod+,')}</kbd>, the buttons and the command
            palette keep working.`}>
          <${Switch} name="singleKeys" label="Single-letter shortcuts" checked=${p.singleKeys} onChange=${(v) => setPref('singleKeys', v)} />
        <//>
      </section>

      <section class="settings-section" aria-labelledby="sr-set-h-behaviour">
        <h3 id="sr-set-h-behaviour">Behaviour</h3>
        <${Setting} id="sr-set-open" title="Default view"
          hint="What a document opens in. Read: the latest version, nothing drawn over it. Review: your threads highlighted. Changes when revised: what changed since your last review, if the agent revised it since (else Review).">
          <${Choice} name="openIn" label="Default view" value=${p.openIn}
            options=${[['auto', 'Changes when revised'], ['read', 'Read'], ['review', 'Review']]} onChange=${(/** @type {any} */ v) => setPref('openIn', v)} />
        <//>
        <${Setting} id="sr-set-version" title="When the agent records a new version"
          hint="Switching never happens while you are writing a comment or a dialog is open; you get the toast then.">
          <${Choice} name="onNewVersion" label="When the agent records a new version" value=${p.onNewVersion}
            options=${[['toast', 'Show a toast'], ['changes', 'Switch to Changes']]} onChange=${(/** @type {any} */ v) => setPref('onNewVersion', v)} />
        <//>
        <${Setting} id="sr-set-confirm" title="Ask before Send now" hint=${html`<kbd>${shortcut('mod+shift+enter')}</kbd> and the Send now button ask you to confirm first.`}>
          <${Switch} name="confirmSendNow" label="Ask before Send now" checked=${p.confirmSendNow} onChange=${(v) => setPref('confirmSendNow', v)} />
        <//>
        <${Setting} id="sr-set-verdict" title="Default verdict" hint="What Submit review starts on when nothing is blocking (a blocking comment always starts on Request changes).">
          <${Choice} name="defaultVerdict" label="Default verdict" value=${p.defaultVerdict}
            options=${[['comment', 'Comment'], ['changes_requested', 'Request changes']]} onChange=${(/** @type {any} */ v) => setPref('defaultVerdict', v)} />
        <//>
      </section>

      <section class="settings-section" aria-labelledby="sr-set-h-about" data-setting="about">
        <h3 id="sr-set-h-about">About</h3>
        <dl class="about">
          <dt>Suiko</dt><dd data-about="version">${s.about?.version ? `v${s.about.version}` : '…'}</dd>
          ${s.onDoc ? html`
            <dt>Workspace</dt><dd class="mono" data-about="root">${s.root || '…'}</dd>
            <dt>Spec</dt><dd class="mono" data-about="path">${s.path}</dd>` : null}
          <dt>Ports</dt><dd data-about="ports">UI ${s.about?.uiPort || location.port || '-'}${s.about?.contentPort ? ` · content ${s.about.contentPort}` : ''}</dd>
        </dl>
        ${s.onDoc ? html`<div class="about-prompt">
          <code class="prompt">${agentPrompt(s.ds)}</code>
          <button type="button" class="btn btn-sm" onClick=${copyAgentPrompt}>Copy "tell the agent" prompt</button>
        </div>` : null}
      </section>
    </div>
    <p class="small muted settings-foot">Settings apply at once and are remembered in this browser. Everything is also in the
      command palette (<kbd>${shortcut('mod+k')}</kbd>).</p>
  <//>`;
}
