// @ts-check
// Settings (Cmd/Ctrl+, or More > Settings): per-browser preferences that apply at once (no Save button) and are
// remembered in localStorage (state.js readPrefs). A sidebar of sections (a vertical tablist: Up / Down / Home / End
// move between them, the panel beside shows the one chosen; it opens on General unless asked for another). The
// dialog keeps one size whatever the section (components.css: the title and footer stay put, the section pane is the
// only part that scrolls), so moving between sections never makes it jump:
//   General           Theme: System / Light / Dark (the same state as the `t` key); Single-letter shortcuts.
//   Reading           Open documents in: Latest version (default) / Reading view / What changed since my last
//                     review; When Claude records a new version: Show the new version (default) / Just tell me / Show
//                     what changed; Outline rail: Auto / Always / Never; Thread panel open by default.
//   Sending           Send comments: Right away (default) / When I click Send; Ask before sending; When I send
//                     drafts, start on: Send feedback / Needs changes.
//   Claude & context  Doc edits: Auto (default: batched on long documents) / Right away / Batched, and what that
//                     means for the open document ("This document is long (34,120 characters), so edits are batched.").
//   About             Suiko version, workspace root, document path, the UI / content ports, and the "tell Claude"
//                     prompt to copy.
// Test hooks: every setting carries data-setting=<pref name>, and its radios the name sr-set-<pref name>.

import { html, useRef } from 'preact-htm';
import { TESTID } from 'protocol';
import { applyTheme, closeDialog, copyAgentPrompt, setPref, setSettingsSection, specPath, workspaceRoot } from '../actions.js';
import { shortcut } from '../keys.js';
import { agentName, agentPrompt, agentTitle, docSize, isPlanDoc, LONG_DOC } from '../model.js';
import { useStore } from '../state.js';
import { Icon, Modal } from './common.js';

/** @typedef {import('../state.js').SettingsSection} SettingsSection */

/** The sections, in order. @type {ReadonlyArray<{ key: SettingsSection, label: (agent: string) => string, icon: string }>} */
const SECTIONS = Object.freeze([
  { key: 'general', label: () => 'General', icon: 'gear' },
  { key: 'reading', label: () => 'Reading', icon: 'eye' },
  { key: 'sending', label: () => 'Sending', icon: 'arrowRight' },
  { key: 'context', label: (agent) => `${agent} & context`, icon: 'threads' },
  { key: 'about', label: () => 'About', icon: 'info' },
]);

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
 * Radio options as a list, each with a line saying what it does (a choice with long labels).
 * @param {{ name: string, label: string, value: string, options: Array<[string, string, string]>, onChange: (v: string) => void }} props
 */
function Options({ name, label, value, options, onChange }) {
  return html`<div class="setting-options" role="radiogroup" aria-label=${label} data-setting=${name}>
    ${options.map(([v, text, hint]) => html`<label class=${`setting-option ${value === v ? 'on' : ''}`} key=${v}>
      <input type="radio" name=${`sr-set-${name}`} value=${v} checked=${value === v} onChange=${() => onChange(v)} />
      <span><span class="option-title">${text}</span>${hint ? html`<span class="option-hint small muted">${hint}</span>` : null}</span>
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
 * @param {{ title: string, hint?: any, children?: any, id: string, stacked?: boolean }} props stacked: the control
 *   under the text (a list of options), not beside it
 */
function Setting({ title, hint, children, id, stacked = false }) {
  return html`<div class=${`setting ${stacked ? 'is-stacked' : ''}`}>
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
    section: st.settingsSection,
  }));
  const listRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const agent = agentTitle(agentName(s.ds));
  const section = SECTIONS.some((x) => x.key === s.section) ? s.section : 'general';

  /** Up / Down / Home / End move between the sections (and show the one reached). @param {KeyboardEvent} e */
  const onTabKey = (e) => {
    const i = SECTIONS.findIndex((x) => x.key === section);
    const next = e.key === 'ArrowDown' ? (i + 1) % SECTIONS.length : e.key === 'ArrowUp' ? (i - 1 + SECTIONS.length) % SECTIONS.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? SECTIONS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setSettingsSection(SECTIONS[next].key);
    requestAnimationFrame(() => /** @type {HTMLElement|null} */ (listRef.current?.querySelector(`[data-section="${SECTIONS[next].key}"]`))?.focus());
  };

  return html`<${Modal} title="Settings" testid=${TESTID.settingsDialog} onClose=${closeDialog} wide class="modal-settings"
    initialFocus=${`[data-section="${section}"]`}>
    <div class="settings-layout">
      <div ref=${listRef} class="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown=${onTabKey}>
        ${SECTIONS.map((x) => html`<button type="button" role="tab" key=${x.key} id=${`sr-set-tab-${x.key}`} data-section=${x.key}
          aria-selected=${section === x.key ? 'true' : 'false'} aria-controls="sr-set-panel" tabindex=${section === x.key ? 0 : -1}
          class=${`settings-tab ${section === x.key ? 'active' : ''}`} onClick=${() => setSettingsSection(x.key)}>
          <${Icon} name=${x.icon} size=${15} /><span>${x.label(agent)}</span></button>`)}
      </div>
      <div class="settings" id="sr-set-panel" role="tabpanel" aria-labelledby=${`sr-set-tab-${section}`}>
        ${section === 'general' ? html`<${General} theme=${s.theme} prefs=${s.prefs} />` : null}
        ${section === 'reading' ? html`<${Reading} prefs=${s.prefs} agent=${agent} />` : null}
        ${section === 'sending' ? html`<${Sending} prefs=${s.prefs} agent=${agent} ds=${s.onDoc ? s.ds : null} />` : null}
        ${section === 'context' ? html`<${Context} prefs=${s.prefs} agent=${agent} ds=${s.onDoc ? s.ds : null} />` : null}
        ${section === 'about' ? html`<${About} s=${s} agent=${agent} />` : null}
      </div>
    </div>
    <p class="small muted settings-foot">Settings apply at once and are remembered in this browser. Everything is also in the
      command palette (<kbd>${shortcut('mod+k')}</kbd>).</p>
  <//>`;
}

/** @param {{ theme: string, prefs: any }} props */
function General({ theme, prefs }) {
  return html`<section class="settings-section" aria-labelledby="sr-set-h-general">
    <h3 id="sr-set-h-general">General</h3>
    <${Setting} id="sr-set-theme" title="Theme" hint=${html`Also <kbd>t</kbd>. Markdown documents follow it; raw HTML keeps its own styling.`}>
      <${Choice} name="theme" label="Theme" value=${theme}
        options=${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} onChange=${(/** @type {any} */ v) => applyTheme(v)} />
    <//>
    <${Setting} id="sr-set-keys" title="Single-letter shortcuts"
      hint=${html`Keys like <kbd>c</kbd>, <kbd>j</kbd>, <kbd>b</kbd>, <kbd>1</kbd> and <kbd>?</kbd>, in this panel and in the
        document. Turn them off if the document has its own keyboard controls, you use speech input, or you press keys by
        accident: <kbd>Esc</kbd>, <kbd>${shortcut('mod+k')}</kbd>, <kbd>${shortcut('mod+,')}</kbd>, the buttons and the command
        palette keep working.`}>
      <${Switch} name="singleKeys" label="Single-letter shortcuts" checked=${prefs.singleKeys} onChange=${(v) => setPref('singleKeys', v)} />
    <//>
  </section>`;
}

/** @param {{ prefs: any, agent: string }} props */
function Reading({ prefs, agent }) {
  return html`<section class="settings-section" aria-labelledby="sr-set-h-reading">
    <h3 id="sr-set-h-reading">Reading</h3>
    <${Setting} id="sr-set-open" title="Open documents in" stacked>
      <${Options} name="openIn" label="Open documents in" value=${prefs.openIn} onChange=${(/** @type {any} */ v) => setPref('openIn', v)}
        options=${[
          ['review', 'Latest version', 'The newest version with your threads, no change highlights. The Changes tab says how much is new.'],
          ['read', 'Reading view', 'The newest version as its readers see it: nothing drawn over it.'],
          ['auto', 'What changed since my last review', `When ${agent} revised it since you last looked, its changes; else the latest version.`],
        ]} />
    <//>
    <${Setting} id="sr-set-version" title=${`When ${agent} records a new version`} stacked
      hint="Never while you are writing a comment or a reply, have text selected, or a dialog or menu is open: then you only get a note.">
      <${Options} name="onNewVersion" label=${`When ${agent} records a new version`} value=${prefs.onNewVersion}
        onChange=${(/** @type {any} */ v) => setPref('onNewVersion', v)}
        options=${[
          ['latest', 'Show the new version', 'Switch to it where you are reading, at the same place, without change highlights.'],
          ['toast', 'Just tell me', 'A note with Show changes; the view stays where it is until you switch.'],
          ['changes', 'Show what changed', 'Switch to Changes, with what is new highlighted.'],
        ]} />
    <//>
    <${Setting} id="sr-set-rail" title="Outline rail"
      hint="Auto: beside the document when the window is very wide (1600 px and up), behind the ≡ button otherwise. Never: always behind the button.">
      <${Choice} name="railMode" label="Outline rail" value=${prefs.railMode}
        options=${[['auto', 'Auto'], ['always', 'Always'], ['never', 'Never']]} onChange=${(/** @type {any} */ v) => setPref('railMode', v)} />
    <//>
    <${Setting} id="sr-set-panel-open" title="Thread panel open by default" hint=${html`<kbd>\\</kbd> still shows or hides it at any time.`}>
      <${Switch} name="panelOpen" label="Thread panel open by default" checked=${prefs.panelOpen} onChange=${(v) => setPref('panelOpen', v)} />
    <//>
  </section>`;
}

/** @param {{ prefs: any, agent: string, ds: any }} props */
function Sending({ prefs, agent, ds }) {
  // a plan (Claude Code's plan mode) always collects comments (model.js sendModeOf): the keys below as they work there
  const plan = isPlanDoc(ds);
  const now = !plan && prefs.sendMode !== 'batch';
  return html`<section class="settings-section" aria-labelledby="sr-set-h-sending">
    <h3 id="sr-set-h-sending">Sending</h3>
    <${Setting} id="sr-set-send" title="Send comments" stacked hint=${plan
      ? `This document is a plan from ${agent}'s plan mode: its comments wait as drafts until you send them together, whatever this says (${agent} revises the plan once per review).`
      : null}>
      <${Options} name="sendMode" label="Send comments" value=${prefs.sendMode} onChange=${(/** @type {any} */ v) => setPref('sendMode', v)}
        options=${[
          ['now', 'Right away', `Each comment and reply goes to ${agent} when you press Send (${shortcut('mod+enter')}). Save as draft keeps one for later.`],
          ['batch', 'When I click Send', `Comments wait in your review as drafts; Send in the top bar sends them together.`],
        ]} />
    <//>
    <${Setting} id="sr-set-confirm" title="Ask before sending"
      hint=${now ? html`Send and <kbd>${shortcut('mod+enter')}</kbd> in a comment or a reply ask you to confirm first.`
        : html`Send now and <kbd>${shortcut('mod+shift+enter')}</kbd> ask you to confirm first.`}>
      <${Switch} name="confirmSendNow" label="Ask before sending" checked=${prefs.confirmSendNow} onChange=${(v) => setPref('confirmSendNow', v)} />
    <//>
    <${Setting} id="sr-set-verdict" title="When I send drafts, start on"
      hint="What the Send dialog starts on when nothing is marked Must fix (a Must fix comment always starts on Needs changes).">
      <${Choice} name="defaultVerdict" label="When I send drafts, start on" value=${prefs.defaultVerdict}
        options=${[['comment', 'Send feedback'], ['changes_requested', 'Needs changes']]} onChange=${(/** @type {any} */ v) => setPref('defaultVerdict', v)} />
    <//>
  </section>`;
}

/** @param {{ prefs: any, agent: string, ds: any }} props */
function Context({ prefs, agent, ds }) {
  return html`<section class="settings-section" aria-labelledby="sr-set-h-context">
    <h3 id="sr-set-h-context">${agent} & context</h3>
    <${Setting} id="sr-set-edits" title="Doc edits" stacked
      hint=${`Batched: ${agent} answers each comment right away and plans the edit; you apply the planned changes together (one version per batch). Saves ${agent}'s context on long documents.`}>
      <${Options} name="editMode" label="Doc edits" value=${prefs.editMode} onChange=${(/** @type {any} */ v) => setPref('editMode', v)}
        options=${[
          ['auto', 'Auto', `Batched on long documents (over ${LONG_DOC.chars.toLocaleString('en-US')} characters of text), right away otherwise.`],
          ['now', 'Right away', `${agent} edits the document for each comment you send.`],
          ['batch', 'Batched', 'Always plan first; you apply the planned changes together.'],
        ]} />
    <//>
    ${ds ? html`<p class="setting-live small" data-doc-size>${docLine(ds, prefs.editMode)}</p>` : null}
  </section>`;
}

/**
 * What Doc edits means for the open document.
 * @param {any} ds @param {string} mode
 */
function docLine(ds, mode) {
  const size = docSize(ds);
  const amount = size.chars != null ? `${size.chars.toLocaleString('en-US')} characters` : size.lines != null
    ? `${size.lines.toLocaleString('en-US')} lines` : 'size unknown';
  const what = `This document is ${size.long ? 'long' : 'short'} (${amount})`;
  if (mode === 'now') return `${what}; edits happen right away (your choice).`;
  if (mode === 'batch') return `${what}; edits are batched (your choice).`;
  return `${what}, so edits ${size.long ? 'are batched' : 'happen right away'}.`;
}

/** @param {{ s: any, agent: string }} props */
function About({ s, agent }) {
  return html`<section class="settings-section" aria-labelledby="sr-set-h-about" data-setting="about">
    <h3 id="sr-set-h-about">About</h3>
    <dl class="about">
      <dt>Suiko</dt><dd data-about="version">${s.about?.version ? `v${s.about.version}` : '…'}</dd>
      ${s.onDoc ? html`
        <dt>Workspace</dt><dd class="mono" data-about="root">${s.root || '…'}</dd>
        <dt>Document</dt><dd class="mono" data-about="path">${s.path}</dd>` : null}
      <dt>Ports</dt><dd data-about="ports">UI ${s.about?.uiPort || location.port || '-'}${s.about?.contentPort ? ` · content ${s.about.contentPort}` : ''}</dd>
    </dl>
    ${s.onDoc ? html`<div class="about-prompt">
      <code class="prompt">${agentPrompt(s.ds)}</code>
      <button type="button" class="btn btn-sm" onClick=${copyAgentPrompt}>Copy the prompt for ${agent}</button>
    </div>` : null}
  </section>`;
}
