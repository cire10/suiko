// @ts-check
// The command registry: one list of everything the reviewer can do, read by the command palette (Cmd/Ctrl+K:
// titles, descriptions, search keywords, whether a command can run now and why not, sub-lists) and by the keyboard
// shortcuts overlay (Cmd/Ctrl+/ or ?: the keys, grouped), so the shortcut list and the palette can never drift
// apart. Commands only call the actions in actions.js; keys.js maps key presses to the same actions (handleKey).
//
// A command: { id, title, category, description?, keywords?, keys?, help?, scope?, palette?, inline?, when?, run?,
// items? }
//   - keys: shortcut combos for keyLabel ('c', 'shift+B', 'mod+k'); the help groups commands by category and merges
//     the keys of commands that share a help row (c / s / q / a, j / k, 1-4, ...).
//   - when(s) -> true | 'why it cannot run now': the palette shows the reason on a dimmed row and does not run it.
//   - items(s) -> PaletteItem[]: a sub-list (Go to thread…, Compare versions…); an item can have items of its own
//     (the next step). With `inline`, the items also show up in the palette's top-level search under that heading,
//     so typing "t4" or a heading's words finds them directly.
//   - scope 'any': also on the doc list (home); the rest need an open doc.
//   - palette: false: listed in the help only (Esc, the palette's own key).
// The palette's "Recent" group (the last commands run) is kept in localStorage.

import {
  acceptAll, acceptDecline, acceptFocused, acceptRevisions, applyTheme, closeSession, compareVersions, copyAgentPrompt,
  copyReviewLink, copySpecPath, cycleTheme, docPath, focusItem, focusedThread, markAllChangesSeen, navChange, navigate,
  navThread, openComposer, openDialog, openSubmit, readSeen, reloadFrame, reopenFocused, scrollToSrid, seenStorageKey,
  selectionAction, setCompareLayout, setMode, showChanges, showThreads, snipScreen, startRecording, startReply, stepVersion,
  submitComposer, submitWithVerdict, switchVersion, toggleBaseKind, toggleHidden, toggleNav, togglePick, toggleSidebar,
  toggleSingleKeys, toggleSnip,
} from './actions.js';
import {
  acceptableThreads, actorLabel, agentName, baseTag, canSendNow, declinedToVerify, filterCounts, FILTERS, hasMode, kindCaps,
  modesFor, numericVersion, panelItems, plainMode, relTime, revisionsToAccept, showsDoc, staleApproveText, statusInfo,
  threadRowTitle, versionNumbers,
} from './model.js';

/** @typedef {import('./state.js').UiState} UiState */

/**
 * @typedef {object} PaletteItem  a row of a sub-list (and, for `inline` commands, of the top-level search)
 * @property {string} id unique within its list
 * @property {string} title
 * @property {string} [description]
 * @property {string[]} [keywords]
 * @property {string[]} [exact] queries that rank the row first ('t4', 'v2')
 * @property {string} [group] heading within the sub-list
 * @property {true|string} [when] true, or why it cannot run now
 * @property {() => void} [run]
 * @property {(s: UiState) => PaletteItem[]} [items] the next step
 * @property {string} [placeholder] the input's placeholder for that next step
 */

/**
 * @typedef {object} Command
 * @property {string} id
 * @property {string} title
 * @property {'Comment'|'Review'|'Navigate'|'View'|'App'} category
 * @property {string|((s: UiState) => string)} [description]
 * @property {string[]} [keywords]
 * @property {string[]} [keys]
 * @property {{ row?: string, label?: string, codeLabel?: string }} [help] the help row this command's keys go in
 *   (default: its own, labelled with `label` or the title; `codeLabel` in a code review, whose view binds the key
 *   to something else)
 * @property {'doc'|'any'} [scope]
 * @property {boolean} [palette]
 * @property {string} [inline]
 * @property {(s: UiState) => true|string} [when]
 * @property {(s: UiState) => void} [run]
 * @property {(s: UiState) => PaletteItem[]} [items]
 * @property {string} [placeholder]
 */

/** The shortcuts shown on buttons (titles and kbd hints), in the help and in the palette; handleKey implements them. */
export const KEYS = Object.freeze({
  snip: 'b',
  snipScreen: 'shift+B',
  pick: 'e',
  add: 'mod+enter',
  sendNow: 'mod+shift+enter',
  submit: 'f',
  cancel: 'esc',
  bold: 'mod+b',
  bulletList: 'mod+shift+8',
  numberedList: 'mod+shift+7',
  palette: 'mod+k',
  settings: 'mod+,',
  help: 'mod+/',
});

/** Help groups and palette categories, in order. */
export const CATEGORIES = /** @type {const} */ (['Comment', 'Review', 'Navigate', 'View', 'App']);

const READ_ONLY = 'the working copy preview is read-only';
const BUSY = 'finish or cancel the open comment first';
const NO_FRAME = 'not in a code review (click a line number to comment)';

/** @param {UiState} s */
const busyEditing = (s) => !!(s.composer || s.reply);

/** @param {UiState} s @param {string} [unless] */
const capturable = (s, unless) => {
  if (s.ds && !kindCaps(s.ds).frame) return NO_FRAME;
  if (s.version === 'live') return READ_ONLY;
  if (!s.guest.connected) return 'the document is still loading';
  return unless || true;
};

/**
 * c / s / q / a in the palette: why the selection command cannot run now, or true.
 * @param {UiState} s @param {'c'|'s'|'q'|'a'} key
 */
function selectionWhen(s, key) {
  if (s.version === 'live') return READ_ONLY;
  if (s.ds && key === 'a' && !kindCaps(s.ds).locks) return 'code reviews have no locks';
  // a kind view without the doc frame (a code review) has its own selection (registerKindSelection)
  if (s.ds && !kindCaps(s.ds).frame) return s.mode === 'history' ? 'switch to Files first' : true;
  if (s.mode === 'history') return 'switch to Review first';
  if (s.mode === 'source') {
    if (key !== 'c') return 'in Source, only Comment works on lines';
    return s.sourceSel ? true : 'click a line number in Source first';
  }
  return s.guest.selection ? true : 'select text in the doc first';
}

/**
 * @param {string} id @param {'c'|'s'|'q'|'a'} key @param {string} title @param {string} description
 * @param {string[]} keywords
 * @returns {Command}
 */
const selectionCommand = (id, key, title, description, keywords) => ({
  id,
  title,
  category: 'Comment',
  description,
  keywords,
  keys: [key],
  help: { row: 'comment', label: 'Comment, suggest, question, or mark agreed on the selected text' },
  when: (s) => selectionWhen(s, key),
  run: () => {
    selectionAction(key);
  },
});

/** @param {UiState} s */
function threadWhen(s) {
  if (!s.ds) return 'open a document first';
  return focusedThread() ? true : 'focus a thread first (j / k, or click its card)';
}

/** A mode that shows the rendered doc (Read, Review, Changes) for commands that show something in it. @param {UiState} s */
function toDocMode(s) {
  if (!showsDoc(s.mode)) setMode('review');
}

/** "Go to thread…": every thread and new-thread draft, in document order. @param {UiState} s @returns {PaletteItem[]} */
function threadItems(s) {
  if (!s.ds) return [];
  const agent = agentName(s.ds);
  return panelItems(s.ds, 'all', s.version).map((it) => {
    const { title, body } = threadRowTitle(it);
    const status = it.kind === 'thread' ? statusInfo(it.item, agent).label : 'Draft (not sent yet)';
    return {
      id: it.id,
      title,
      description: [status, it.item?.severity === 'blocking' ? 'Blocking' : ''].filter(Boolean).join(' · '),
      keywords: [body],
      exact: [it.id],
      group: it.kind === 'draft' ? 'Drafts' : 'Threads',
      run: () => {
        if (it.kind === 'thread' || it.anchor?.kind !== 'doc') toDocMode(s);
        focusItem(it.id);
      },
    };
  });
}

/** "Go to section…": the outline, each heading with the section it is in. @param {UiState} s @returns {PaletteItem[]} */
function sectionItems(s) {
  const outline = s.guest.outline.length ? s.guest.outline : (s.targets?.outline || []);
  /** @type {any[]} */
  const chain = [];
  return outline.map((/** @type {any} */ h) => {
    const level = Number(h.level) || 1;
    while (chain.length && (Number(chain[chain.length - 1].level) || 1) >= level) chain.pop();
    const parent = chain.length ? chain[chain.length - 1] : null;
    chain.push(h);
    return {
      id: String(h.srid),
      title: String(h.text || 'Untitled section'),
      description: parent ? `in ${parent.text}` : `Heading ${level}`,
      run: () => {
        toDocMode(s);
        scrollToSrid(Number(h.srid));
      },
    };
  });
}

/** "Switch to version…": newest first, plus the live working copy when it has unrecorded changes. @param {UiState} s @returns {PaletteItem[]} */
function versionItems(s) {
  const ds = s.ds;
  if (!ds) return [];
  const head = Number(ds.doc.head);
  const busy = busyEditing(s) ? BUSY : null;
  /** @type {PaletteItem[]} */
  const out = [];
  if ((ds.working?.dirty && !ds.working?.missing) || s.version === 'live') {
    out.push({
      id: 'live',
      title: 'Working copy (live)',
      description: 'Unrecorded changes on disk, read-only preview',
      exact: ['live'],
      when: s.version === 'live' ? 'shown now' : busy || true,
      run: () => switchVersion('live'),
    });
  }
  for (const v of versionNumbers(ds).slice().reverse()) {
    const meta = (ds.versions || []).find((/** @type {any} */ x) => Number(x.v) === v);
    out.push({
      id: String(v),
      title: `v${v}${v === head ? ' (latest)' : ''}${ds.doc.final?.version === v ? ' · FINAL' : ''}`,
      description: [actorLabel(meta?.author), meta?.summary || '', relTime(meta?.createdAt)].filter(Boolean).join(' · '),
      exact: [`v${v}`, String(v)],
      when: s.version === v ? 'shown now' : busy || true,
      run: () => switchVersion(v),
    });
  }
  return out;
}

/** "Compare versions…": pick the older version, then the newer one. @param {UiState} s @returns {PaletteItem[]} */
function compareItems(s) {
  const ds = s.ds;
  if (!ds) return [];
  const vs = versionNumbers(ds);
  const busy = busyEditing(s) ? BUSY : null;
  return vs.slice(0, -1).reverse().map((from) => ({
    id: String(from),
    title: `From v${from}`,
    description: { review: 'your last review', accepted: 'the revisions you accepted' }[baseTag(ds, from) ?? ''] ?? '',
    exact: [`v${from}`, String(from)],
    when: busy || true,
    placeholder: `Compare v${from} with which newer version?`,
    items: () => vs.filter((v) => v > from).reverse().map((to) => ({
      id: `${from}-${to}`,
      title: `v${from} → v${to}`,
      description: to === Number(ds.doc.head) ? 'latest' : '',
      exact: [`v${to}`, String(to)],
      when: busy || true,
      run: () => compareVersions(from, to),
    })),
  }));
}

/** "Open another document…": every tracked doc (GET /api/docs, loaded when the palette opens). @param {UiState} s @returns {PaletteItem[]} */
function docItems(s) {
  const docs = s.home.docs;
  if (!docs) return [{ id: 'loading', title: s.home.error ? `Cannot list the documents: ${s.home.error}` : 'Loading documents…', when: 'not available yet' }];
  const r = s.route;
  const busy = busyEditing(s) ? BUSY : null;
  return docs.map((/** @type {any} */ d) => {
    const current = r.view === 'doc' && r.ws === d.ws && r.doc === d.id;
    return {
      id: `${d.ws}/${d.id}`,
      title: String(d.title || d.id),
      description: [d.path, `v${d.head}`, d.openThreads ? `${d.openThreads} open` : ''].filter(Boolean).join(' · '),
      keywords: [String(d.id), String(d.path || '')],
      when: current ? 'open now' : busy || true,
      run: () => navigate(docPath(d.ws, d.id)),
    };
  });
}

/** Seen marks of the comparison shown: why "Mark all changes seen" has nothing to do, or true. @param {UiState} s */
function markSeenWhen(s) {
  const hunks = s.changes?.hunks || [];
  if (s.base == null || !hunks.length) return 'no changes in this comparison';
  const seen = readSeen(seenStorageKey(s));
  return hunks.some((/** @type {any} */ h) => !seen.has(String(h.id))) ? true : 'all changes are already seen';
}

/** "Show changes" / "Hide changes": why the switch cannot be used now, or true. @param {UiState} s */
function changesWhen(s) {
  if (!s.ds) return 'open a document first';
  if (!kindCaps(s.ds).frame) return 'a code review shows its changes in Files';
  return versionNumbers(s.ds).length > 1 || s.version === 'live' ? true : 'there is only one version';
}

/** "Accept all revisions": why it cannot run now, or true. @param {UiState} s */
function acceptRevisionsWhen(s) {
  if (!s.ds) return 'open a document first';
  if (!kindCaps(s.ds).frame) return 'not in a code review';
  if (s.version === 'live') return READ_ONLY;
  const todo = revisionsToAccept(s.ds);
  if (!todo) return 'no new revisions since your last review';
  return s.version === todo.version ? true : `switch to v${todo.version} (latest) first`;
}

/** @param {UiState} s @param {1|-1} dir */
function stepWhen(s, dir) {
  if (!s.ds) return 'open a document first';
  if (busyEditing(s)) return BUSY;
  const vs = versionNumbers(s.ds);
  const cur = s.version === 'live' ? vs[vs.length - 1] + 1 : Number(s.version);
  if (dir > 0) return vs.some((v) => v > cur) ? true : 'this is the latest version';
  return vs.some((v) => v < cur) ? true : 'this is the first version';
}

// One command per mode of a spec doc (model.js modesFor); a code review offers its own subset (review labelled
// "Files", no Source), so the descriptions follow the open doc and a missing mode says why.
const MODE_COMMANDS = modesFor(null).map((m) => /** @type {Command} */ ({
  id: `mode-${m.key}`,
  title: `Switch to ${m.label} mode`,
  category: 'Navigate',
  description: (s) => modesFor(s.ds).find((x) => x.key === m.key)?.description ?? m.description,
  keywords: [m.label.toLowerCase(), 'mode', 'tab', 'view', ...(m.key === 'review' ? ['files'] : []),
    ...(m.key === 'read' ? ['clean', 'latest', 'final', 'preview', 'plain', 'reader'] : [])],
  keys: [String(m.n)],
  help: { row: 'modes', label: 'Read / Review / Changes / Source / History' },
  when: (s) => (s.ds && !hasMode(s.ds, m.key) ? 'not in a code review' : s.mode === m.key ? 'shown now' : true),
  run: () => setMode(m.key),
}));

const FILTER_COMMANDS = FILTERS.map((f) => /** @type {Command} */ ({
  id: `filter-${f.key}`,
  title: `Filter threads: ${f.label}`,
  category: 'Navigate',
  description: (s) => {
    const n = s.ds ? filterCounts(s.ds, s.version)[f.key] || 0 : 0;
    return `${n} thread${n === 1 ? '' : 's'}${s.filter === f.key ? ' · shown now' : ''}`;
  },
  keywords: ['filter', 'show', 'list', 'threads', f.key],
  run: () => showThreads(f.key),
}));

const THEMES = /** @type {const} */ (['system', 'light', 'dark']);
const THEME_COMMANDS = THEMES.map((theme) => /** @type {Command} */ ({
  id: `theme-${theme}`,
  title: `Theme: ${theme[0].toUpperCase()}${theme.slice(1)}`,
  category: 'View',
  description: theme === 'system' ? 'Follow the system light / dark setting' : `Always ${theme}`,
  keywords: ['theme', 'appearance', 'color', 'colour', theme === 'dark' ? 'night' : theme === 'light' ? 'day' : 'auto'],
  scope: 'any',
  when: (s) => (s.theme === theme ? 'in use' : true),
  run: () => applyTheme(theme),
}));

/** Every command, in help / palette order. @type {readonly Command[]} */
export const COMMANDS = Object.freeze([
  // ------------------------------------------------------------------------------------------- Comment
  selectionCommand('comment', 'c', 'Comment on the selection', 'Comment on the selected text, or the selected lines in Source', ['note', 'annotate']),
  selectionCommand('suggest', 's', 'Suggest a change to the selection', 'Propose replacement text for the agent to apply', ['edit', 'rewrite', 'suggestion']),
  selectionCommand('question', 'q', 'Ask a question about the selection', 'A question the agent answers', ['ask', 'why']),
  selectionCommand('agree', 'a', 'Mark the selection agreed', 'Lock it: revisions that change it are refused', ['lock', 'approve part', 'freeze']),
  {
    id: 'general-comment',
    title: 'General comment',
    category: 'Comment',
    description: 'A comment about the whole document',
    keywords: ['doc', 'overall', 'document', 'note'],
    when: (s) => (s.version === 'live' ? READ_ONLY : true),
    run: () => openComposer({ capture: { kind: 'doc' } }),
  },
  {
    id: 'snip',
    title: 'Snip an area of the document',
    category: 'Comment',
    description: 'Drag a box over text, images or diagrams, then comment',
    keywords: ['screenshot', 'capture', 'crop', 'region', 'box'],
    keys: [KEYS.snip],
    help: { label: 'Snip an area of the document: drag a box over text, images or diagrams, then comment (Esc cancels)' },
    when: (s) => capturable(s),
    run: () => toggleSnip(),
  },
  {
    id: 'snip-screen',
    title: 'Snip anywhere on your screen',
    category: 'Comment',
    description: 'The macOS screenshot picker, then comment on the screenshot',
    keywords: ['screenshot', 'capture', 'screen', 'macos', 'picker'],
    keys: [KEYS.snipScreen],
    help: { label: 'Snip anywhere on your screen (macOS picker), then comment on the screenshot' },
    when: (s) => {
      if (!s.screenSnip.supported) return 'needs macOS';
      if (s.screenSnip.running) return 'a screen snip is already waiting';
      if (s.version === 'live') return READ_ONLY;
      if (s.composer && (s.composer.type === 'agree' || s.composer.busy)) return BUSY;
      return true;
    },
    run: () => {
      snipScreen();
    },
  },
  {
    id: 'pick',
    title: 'Pick an element',
    category: 'Comment',
    description: 'An image, diagram, table or code block',
    keywords: ['image', 'diagram', 'table', 'code', 'element', 'select'],
    keys: [KEYS.pick],
    help: { label: 'Pick an image, diagram, table or code block ([ ] parent / child, Shift-drag a region, Esc exits)' },
    when: (s) => capturable(s, showsDoc(s.mode) ? undefined : 'switch to Review or Changes first'),
    run: () => togglePick(),
  },
  {
    id: 'add',
    title: 'Add the comment to the review',
    category: 'Comment',
    description: 'Save the open comment as a draft; it goes out with Submit review',
    keywords: ['save', 'draft', 'add to review'],
    keys: [KEYS.add],
    help: { label: 'Add the comment to the review (in the composer)' },
    when: (s) => (!s.composer ? 'no comment is open' : s.composer.busy ? 'saving…' : true),
    run: () => {
      submitComposer();
    },
  },
  {
    id: 'send-now',
    title: 'Send the comment now',
    category: 'Comment',
    description: 'Just this comment, to the agent, right away',
    keywords: ['send now', 'submit comment', 'immediately'],
    keys: [KEYS.sendNow],
    help: { label: 'Send now: this comment alone, right away (in the composer)' },
    when: (s) => {
      if (!s.composer) return 'no comment is open';
      if (!canSendNow(s.composer)) return 'only a new comment can be sent on its own';
      return s.composer.busy ? 'saving…' : true;
    },
    run: () => {
      submitComposer({ sendNow: true });
    },
  },
  {
    id: 'format',
    title: 'Bold, bulleted list, numbered list',
    category: 'Comment',
    keys: [KEYS.bold, KEYS.bulletList, KEYS.numberedList],
    help: { label: 'Bold / bulleted list / numbered list (while writing)' },
    palette: false,
  },

  // ------------------------------------------------------------------------------------------- Review
  {
    id: 'submit',
    title: 'Submit review…',
    category: 'Review',
    description: 'Everything in the review goes to the agent',
    keywords: ['send', 'finish', 'review', 'done'],
    keys: [KEYS.submit, KEYS.sendNow],
    help: { label: 'Submit review: everything in it (the second key while no new comment is open)' },
    run: () => openSubmit(),
  },
  {
    id: 'submit-comment',
    title: 'Submit review as Comment',
    category: 'Review',
    description: 'Feedback without a decision',
    keywords: ['verdict', 'send'],
    run: () => submitWithVerdict('comment'),
  },
  {
    id: 'submit-changes',
    title: 'Submit review as Request changes',
    category: 'Review',
    description: 'The agent should revise before you approve',
    keywords: ['verdict', 'request changes', 'reject', 'send'],
    run: () => submitWithVerdict('changes_requested'),
  },
  {
    id: 'submit-approve',
    title: 'Submit review as Approve',
    category: 'Review',
    description: 'The spec is good to go',
    keywords: ['verdict', 'approve', 'lgtm', 'accept', 'final', 'send'],
    when: (s) => {
      if (!s.ds) return 'open a document first';
      const head = Number(s.ds.doc.head);
      const stale = staleApproveText(s.ds, numericVersion(s.ds, s.version));
      return stale && head > numericVersion(s.ds, s.version) ? `review v${head} first` : true;
    },
    run: () => submitWithVerdict('approved'),
  },
  {
    id: 'reply',
    title: 'Reply to the focused thread',
    category: 'Review',
    keywords: ['answer', 'respond'],
    keys: ['r'],
    when: (s) => threadWhen(s),
    run: (s) => {
      if (focusedThread()) startReply(/** @type {string} */ (s.focusedId));
    },
  },
  {
    id: 'accept',
    title: 'Resolve the focused thread',
    category: 'Review',
    description: 'Accept what the agent did and close the thread',
    keywords: ['accept', 'resolve', 'close', 'done', 'ok'],
    keys: ['x'],
    help: { label: 'Resolve / accept the focused thread' },
    when: (s) => {
      const w = threadWhen(s);
      if (w !== true) return w;
      return focusedThread()?.status === 'resolved' ? 'the focused thread is already resolved' : true;
    },
    run: () => {
      acceptFocused();
    },
  },
  {
    id: 'reopen',
    title: 'Reopen the focused thread',
    category: 'Review',
    keywords: ['unresolve', 'not done'],
    keys: ['o'],
    when: (s) => threadWhen(s),
    run: () => {
      reopenFocused();
    },
  },
  {
    id: 'accept-decline',
    title: 'Accept the decline of the focused thread',
    category: 'Review',
    description: 'Agree with the agent not to make the change',
    keywords: ['declined', 'won\'t fix'],
    keys: ['y'],
    help: { label: 'Accept a decline' },
    when: (s) => {
      const w = threadWhen(s);
      if (w !== true) return w;
      return focusedThread()?.status === 'declined' ? true : 'the focused thread is not declined';
    },
    run: () => {
      acceptDecline();
    },
  },
  {
    id: 'accept-all',
    title: 'Accept all addressed threads',
    category: 'Review',
    description: (s) => {
      const n = acceptableThreads(s.ds).length;
      const d = declinedToVerify(s.ds).length;
      return `${n} addressed or answered in Verify${d ? `; ${d} declined stay for you to decide` : ''}. You can undo it`;
    },
    keywords: ['accept', 'resolve', 'all', 'everything', 'bulk', 'verify', 'addressed', 'answered'],
    keys: ['shift+X'],
    help: { label: 'Accept all addressed or answered threads in Verify (Undo in the toast)' },
    when: (s) => {
      if (!s.ds) return 'open a document first';
      if (s.version === 'live') return READ_ONLY;
      return acceptableThreads(s.ds).length ? true : 'nothing addressed or answered is waiting in Verify';
    },
    run: () => {
      acceptAll();
    },
  },
  {
    id: 'accept-revisions',
    title: 'Accept all revisions',
    category: 'Review',
    description: (s) => {
      const todo = revisionsToAccept(s.ds);
      if (!todo) return 'The latest version\'s changes stop showing as new, and the threads the agent addressed or answered are resolved';
      const n = acceptableThreads(s.ds).length;
      return `v${todo.version}: its changes stop showing as new${n ? `, and ${n} addressed or answered thread${n === 1 ? ' is' : 's are'} resolved` : ''}. You can undo it`;
    },
    keywords: ['accept', 'revisions', 'changes', 'all', 'track changes', 'accept changes', 'markup', 'resolve', 'done', 'version'],
    when: acceptRevisionsWhen,
    run: () => {
      acceptRevisions();
    },
  },
  {
    id: 'verify',
    title: 'Verify queue',
    category: 'Review',
    description: 'Threads the agent addressed, waiting for you to accept or reopen',
    keywords: ['check', 'addressed', 'answered', 'queue'],
    keys: ['v'],
    run: () => showThreads('verify', { review: true }),
  },
  {
    id: 'record',
    title: 'Record the working copy as my revision',
    category: 'Review',
    description: 'Save your edits on disk as a new version',
    keywords: ['record', 'commit', 'save', 'version', 'working copy', 'edit'],
    when: (s) => {
      if (s.ds?.working?.missing) return 'the file is missing on disk';
      if (!s.ds?.working?.dirty) return 'no unrecorded changes';
      return s.recording ? 'the record form is open' : true;
    },
    run: () => startRecording(),
  },
  {
    id: 'mark-seen',
    title: 'Mark all changes seen',
    category: 'Review',
    description: 'Tick every change of this comparison in the Changes list',
    keywords: ['seen', 'reviewed', 'read', 'check all'],
    when: markSeenWhen,
    run: () => markAllChangesSeen(),
  },
  {
    id: 'close-session',
    title: 'Close the review session…',
    category: 'Review',
    description: 'End the review; a waiting agent stops waiting (like suiko close)',
    keywords: ['end', 'stop', 'finish', 'close'],
    when: (s) => (s.ds?.doc?.state === 'closed' ? 'the session is already closed' : true),
    placeholder: 'Close the review session?',
    items: () => [
      { id: 'confirm', title: 'Close the review session', description: 'The agent is told the review is over', run: () => closeSession() },
      { id: 'cancel', title: 'Keep it open', run: () => {} },
    ],
  },

  // ------------------------------------------------------------------------------------------- Navigate
  {
    id: 'next-thread',
    title: 'Next thread',
    category: 'Navigate',
    keywords: ['down', 'forward'],
    keys: ['j'],
    help: { row: 'threads', label: 'Next / previous thread', codeLabel: 'Next / previous file' },
    when: (s) => (panelItems(s.ds, s.filter, s.version).length ? true : 'no threads in this filter'),
    run: () => navThread(1),
  },
  {
    id: 'prev-thread',
    title: 'Previous thread',
    category: 'Navigate',
    keywords: ['up', 'back'],
    keys: ['k'],
    help: { row: 'threads' },
    when: (s) => (panelItems(s.ds, s.filter, s.version).length ? true : 'no threads in this filter'),
    run: () => navThread(-1),
  },
  {
    id: 'next-change',
    title: 'Next change',
    category: 'Navigate',
    keywords: ['diff', 'hunk', 'down'],
    keys: ['n'],
    help: { row: 'changes', label: 'Next / previous change' },
    when: (s) => ((s.changes?.hunks || []).length ? true : 'no changes in this comparison'),
    run: () => navChange(1),
  },
  {
    id: 'prev-change',
    title: 'Previous change',
    category: 'Navigate',
    keywords: ['diff', 'hunk', 'up'],
    keys: ['p'],
    help: { row: 'changes' },
    when: (s) => ((s.changes?.hunks || []).length ? true : 'no changes in this comparison'),
    run: () => navChange(-1),
  },
  ...MODE_COMMANDS,
  {
    id: 'prev-version',
    title: 'Previous version',
    category: 'Navigate',
    keywords: ['older', 'back'],
    keys: ['['],
    help: { row: 'versions', label: 'Previous / next version' },
    when: (s) => stepWhen(s, -1),
    run: () => stepVersion(-1),
  },
  {
    id: 'next-version',
    title: 'Next version',
    category: 'Navigate',
    keywords: ['newer', 'forward'],
    keys: [']'],
    help: { row: 'versions' },
    when: (s) => stepWhen(s, 1),
    run: () => stepVersion(1),
  },
  {
    id: 'toggle-base',
    title: 'Toggle the base: your last review / previous version',
    category: 'Navigate',
    description: 'What Changes and Source compare against',
    keywords: ['compare', 'diff', 'base'],
    keys: ['d'],
    run: () => toggleBaseKind(),
  },
  {
    id: 'goto-thread',
    title: 'Go to thread…',
    category: 'Navigate',
    description: 'Any thread or draft, by id or by what it says',
    keywords: ['find', 'jump', 'search', 'comment'],
    inline: 'Threads',
    placeholder: 'Type a thread id like t4, or words of the comment…',
    when: (s) => (threadItems(s).length ? true : 'no threads yet'),
    items: threadItems,
  },
  {
    id: 'goto-section',
    title: 'Go to section…',
    category: 'Navigate',
    description: 'Scroll the document to a heading',
    keywords: ['heading', 'outline', 'jump', 'find', 'scroll'],
    inline: 'Sections',
    placeholder: 'Type a heading…',
    when: (s) => (sectionItems(s).length ? true : 'the document has no headings'),
    items: sectionItems,
  },
  {
    id: 'switch-version',
    title: 'Switch to version…',
    category: 'Navigate',
    description: 'Any recorded version, or the live working copy',
    keywords: ['version', 'revision', 'history', 'older'],
    inline: 'Versions',
    placeholder: 'Type a version like v2…',
    items: versionItems,
  },
  {
    id: 'compare',
    title: 'Compare versions…',
    category: 'Navigate',
    description: 'Changes between any two versions',
    keywords: ['diff', 'changes', 'versus', 'vs'],
    placeholder: 'Compare from which version?',
    when: (s) => (versionNumbers(s.ds).length > 1 ? (busyEditing(s) ? BUSY : true) : 'there is only one version'),
    items: compareItems,
  },
  {
    id: 'compare-split',
    title: 'Compare side by side',
    category: 'View',
    description: 'Changes: the older version beside the newer one, scrolled together (removed text in red, added in green)',
    keywords: ['split', 'two columns', 'diff', 'before after', 'compare', 'versions', 'parallel'],
    when: (s) => {
      if (s.ds && !kindCaps(s.ds).frame) return 'a code review has its own split diff';
      if (s.narrow) return 'needs a wider window';
      if (versionNumbers(s.ds).length < 2) return 'there is only one version';
      return s.compareLayout === 'split' && s.mode === 'changes' ? 'shown now' : true;
    },
    run: () => setCompareLayout('split'),
  },
  {
    id: 'compare-inline',
    title: 'Compare inline',
    category: 'View',
    description: 'Changes: what changed drawn over the newer version',
    keywords: ['unified', 'overlay', 'single', 'diff', 'compare'],
    when: (s) => (s.ds && !kindCaps(s.ds).frame ? 'a code review has its own diff layouts'
      : s.compareLayout !== 'split' && s.mode === 'changes' ? 'shown now' : true),
    run: (s) => {
      setCompareLayout('inline');
      if (s.mode !== 'changes') setMode('changes');
    },
  },
  ...FILTER_COMMANDS,

  // ------------------------------------------------------------------------------------------- View
  {
    id: 'show-changes',
    title: 'Show changes',
    category: 'View',
    description: 'What changed since your last review, marked in the document (Changes)',
    keywords: ['changes', 'revisions', 'markup', 'track changes', 'diff', 'marks', 'redline', 'compare', 'toggle'],
    when: (s) => {
      const w = changesWhen(s);
      return w === true && s.mode === 'changes' ? 'shown now' : w;
    },
    run: () => showChanges(true),
  },
  {
    id: 'hide-changes',
    title: 'Hide changes',
    category: 'View',
    description: (s) => `The document without change marks (${plainMode(s.ds, s.prefs.openIn) === 'read' ? 'Read' : 'Review'}, or the mode you came from)`,
    keywords: ['changes', 'clean', 'latest', 'markup', 'no markup', 'revisions', 'track changes', 'marks', 'toggle'],
    when: (s) => (s.mode !== 'changes' ? 'no changes are shown' : true),
    run: () => showChanges(false),
  },
  {
    id: 'hide',
    title: 'Hide all annotations',
    category: 'View',
    description: (s) => (s.hidden ? 'Hidden now: show them again' : 'A clean read of the document'),
    keywords: ['clean', 'highlights', 'show annotations', 'read'],
    keys: ['h'],
    help: { label: 'Hide all annotations (clean read)' },
    when: (s) => (s.ds && !kindCaps(s.ds).hide ? 'not in a code review' : true),
    run: () => toggleHidden(),
  },
  {
    id: 'toggle-panel',
    title: 'Toggle the thread panel',
    category: 'View',
    keywords: ['sidebar', 'drawer', 'threads', 'right'],
    keys: ['\\'],
    run: () => toggleSidebar(),
  },
  {
    id: 'toggle-outline',
    title: 'Toggle the outline rail',
    category: 'View',
    description: 'The outline and history beside the document',
    keywords: ['outline', 'rail', 'navigation', 'left', 'toc', 'contents'],
    run: () => toggleNav(),
  },
  {
    id: 'theme',
    title: 'Cycle theme',
    category: 'View',
    description: (s) => `System, light, dark (now ${s.theme})`,
    keywords: ['appearance', 'dark', 'light'],
    keys: ['t'],
    help: { label: 'Cycle theme (system, light, dark)' },
    scope: 'any',
    run: () => cycleTheme(),
  },
  ...THEME_COMMANDS,
  {
    id: 'reload',
    title: 'Reload the document',
    category: 'View',
    description: 'Render the shown version again',
    keywords: ['refresh', 'rerender'],
    run: () => reloadFrame(),
  },

  // ------------------------------------------------------------------------------------------- App
  {
    id: 'palette',
    title: 'Command palette',
    category: 'App',
    keys: [KEYS.palette],
    help: { label: 'Command palette: run anything by name' },
    scope: 'any',
    palette: false,
  },
  {
    id: 'settings',
    title: 'Open settings',
    category: 'App',
    description: 'Theme, layout, keyboard and behaviour',
    keywords: ['preferences', 'options', 'config'],
    keys: [KEYS.settings],
    help: { label: 'Settings' },
    scope: 'any',
    run: () => openDialog('settings'),
  },
  {
    id: 'help',
    title: 'Keyboard shortcuts',
    category: 'App',
    description: 'Every key, grouped',
    keywords: ['help', 'keys', 'hotkeys', 'keymap'],
    keys: [KEYS.help, '?'],
    help: { label: 'Keyboard shortcuts (this list)' },
    scope: 'any',
    run: () => openDialog('help'),
  },
  {
    id: 'single-keys',
    title: 'Toggle single-letter shortcuts',
    category: 'App',
    description: (s) => (s.prefs.singleKeys ? 'On: turn them off (c, j, b, 1, ? ...)' : 'Off: turn them on'),
    keywords: ['keyboard', 'shortcuts', 'keys', 'accessibility', 'speech'],
    scope: 'any',
    run: () => toggleSingleKeys(),
  },
  {
    id: 'cancel',
    title: 'Close or cancel',
    category: 'App',
    keys: [KEYS.cancel],
    scope: 'any',
    palette: false,
  },
  {
    id: 'home',
    title: 'Open the document list',
    category: 'App',
    description: 'Every tracked document',
    keywords: ['home', 'all documents', 'docs'],
    when: (s) => (busyEditing(s) ? BUSY : true),
    run: () => navigate('/'),
  },
  {
    id: 'open-doc',
    title: 'Open another document…',
    category: 'App',
    description: 'Switch to another tracked spec',
    keywords: ['switch', 'document', 'spec', 'file'],
    scope: 'any',
    placeholder: 'Type a document title or path…',
    items: docItems,
  },
  {
    id: 'copy-link',
    title: 'Copy the review link',
    category: 'App',
    description: 'This review\'s URL, with your access token',
    keywords: ['url', 'share', 'clipboard'],
    run: () => {
      copyReviewLink();
    },
  },
  {
    id: 'copy-prompt',
    title: 'Copy the "tell the agent" prompt',
    category: 'App',
    description: 'What to paste into your agent\'s chat after submitting',
    keywords: ['clipboard', 'agent', 'feedback', 'instruction'],
    run: () => {
      copyAgentPrompt();
    },
  },
  {
    id: 'copy-path',
    title: 'Copy the spec path',
    category: 'App',
    description: (s) => String(s.ds?.doc?.path || ''),
    keywords: ['file', 'clipboard', 'location'],
    run: () => {
      copySpecPath();
    },
  },
]);

/** @param {string} id */
export function commandById(id) {
  return COMMANDS.find((c) => c.id === id) || null;
}

/** Commands the palette lists for this page (all on a doc; on the doc list only those with scope 'any'). @param {UiState} s */
export function paletteCommands(s) {
  const onDoc = s.route.view === 'doc' && !!s.ds;
  return COMMANDS.filter((c) => c.palette !== false && (onDoc || c.scope === 'any'));
}

/**
 * Why a command or item cannot run now, or null when it can (a `when` that throws counts as unavailable).
 * @param {Command|PaletteItem} c
 * @param {UiState} s
 * @returns {string|null}
 */
export function unavailable(c, s) {
  try {
    const w = typeof c.when === 'function' ? c.when(s) : c.when;
    return w == null || w === true ? null : String(w);
  } catch (err) {
    console.warn('suiko: command condition failed', c.id, err);
    return 'not available';
  }
}

/** A command's palette description for this state. @param {Command} c @param {UiState} s */
export function describe(c, s) {
  try {
    return typeof c.description === 'function' ? c.description(s) : c.description || '';
  } catch {
    return '';
  }
}

/**
 * @typedef {{ id: string, keys: string[], label: string, commands: string[] }} KeyRow
 * @typedef {{ group: string, rows: KeyRow[] }} KeyGroup
 */

/**
 * The keyboard shortcuts overlay, grouped by category: one row per command with keys, except that commands naming
 * the same help row share it (their keys listed together). In a code review (`kind` 'code') a row takes its
 * `codeLabel`: the code view binds j / k to the next / previous file.
 * @param {string} [kind] the doc kind shown (docKindOf)
 * @returns {KeyGroup[]}
 */
export function helpGroups(kind) {
  return CATEGORIES.map((group) => {
    /** @type {Map<string, KeyRow>} */
    const rows = new Map();
    for (const c of COMMANDS) {
      if (c.category !== group || !c.keys?.length) continue;
      const id = c.help?.row || c.id;
      const row = rows.get(id);
      if (row) {
        row.keys.push(...c.keys);
        row.commands.push(c.id);
      } else {
        rows.set(id, { id, keys: [...c.keys], label: (kind === 'code' && c.help?.codeLabel) || c.help?.label || c.title, commands: [c.id] });
      }
    }
    return { group, rows: [...rows.values()] };
  }).filter((g) => g.rows.length);
}

const RECENT_KEY = 'suiko.recentCommands';
const RECENT_MAX = 5;

/** Ids of the commands run last from the palette, newest first. @returns {string[]} */
export function recentCommandIds() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && commandById(x)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Remembers a command run from the palette (a sub-list item counts as its command). @param {string} id */
export function rememberCommand(id) {
  try {
    const ids = [id, ...recentCommandIds().filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable: no recent commands */
  }
}
