<!-- Reviewer guide for the Suiko web UI: layout, modes, commenting gestures, snipping (area snips, screen snips, `suiko snip` and a global macOS hotkey), submitting, verifying changes, locks, history, final, keyboard shortcuts, the command palette and settings. Describes the v1 UI (see docs/BUILD_AMENDMENTS.md section 1 for what is out of scope). -->

# Suiko reviewer guide

Suiko shows a spec exactly as written (scripts, SVG, images, tables, code, mermaid and math all work) and lets you comment on any part of it. Your agent receives each comment with the exact source lines behind it, makes targeted edits, and records a new version. You then see precisely what changed, accept or reopen each thread, and repeat until you approve a final version.

- [Opening a document](#opening-a-document)
- [The screen](#the-screen)
- [Modes](#modes)
- [Commenting on anything](#commenting-on-anything)
- [Snipping](#snipping)
- [The composer](#the-composer)
- [Suggesting exact text](#suggesting-exact-text)
- [Submitting a review](#submitting-a-review)
- [While the agent works](#while-the-agent-works)
- [Reviewing what changed](#reviewing-what-changed)
- [Verifying the agent's replies](#verifying-the-agents-replies)
- [Thread cards](#thread-cards)
- [Locks: marking parts agreed](#locks-marking-parts-agreed)
- [Decisions](#decisions)
- [History and versions](#history-and-versions)
- [Approving and the final version](#approving-and-the-final-version)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Command palette](#command-palette)
- [Settings](#settings)
- [Theme, accessibility and clean reading](#theme-accessibility-and-clean-reading)
- [When something looks wrong](#when-something-looks-wrong)

## Opening a document

Your agent runs `suiko open <file>`, which opens the review UI in your default browser. If you prefer the Claude desktop app's built-in browser pane beside the chat, set `SPECREVIEW_BROWSER=pane` and the agent opens it there instead. If no browser can be opened (for example over SSH), open the printed URL in any modern browser on the same machine. You can also run `suiko open <file>` yourself.

- The URL contains an access token (`?k=…`). It works only on this machine; don't share it.
- The doc list (top-left) shows every tracked doc with its head version, open threads and whether an agent is listening.
- If the local server restarts, the UI shows "Reconnecting to Suiko…" and recovers on its own. Your drafts are saved on the server, so a reload loses nothing.
- A web page can be reviewed too: `suiko snapshot <url>` fetches it once and opens a cleaned copy (no scripts; remote images blocked unless `--allow-remote-assets`). The doc list shows it as "web page · <host>". Running the command again records the next version when the page changed. See the README's "Snapshot a web page".

## The screen

Wide layout (900 px and up):

- **Top bar:** doc name, version picker, mode tabs (**Review**, **Changes**, **Source**, **History**), the comparison base (in Changes and Source modes), the tool buttons (pick, the scissors for an area snip, and screen snip), the presence chip (for example "claude is listening"), the draft count and **Submit review**.
- **Left rail:** the outline (headings) with badges: open-thread count, `~` changed, `+` added, `[L]` locked. The **⋯** button next to a heading offers **Comment on section**, **Mark agreed** and **Unlock** (shown as "Unlock (L1)" with the lock id). Below it, a compact version history.
- **Centre:** the document, live and interactive, with highlights, pins and change marks drawn over it.
- **Right:** the thread panel, a list of cards in document order. Filters: **Open**, **Needs me** (the agent asked you something), **Verify**, **Drafts**, **Resolved**, **Outdated**, **All**. Clicking a card scrolls the document to it; clicking a highlight focuses its card.
- **Status bar:** version, working-copy state, page errors, failed external resources, orphaned threads, and the final badge.

Narrow layout (below 900 px, typical for the pane next to a chat): the outline and history move behind the `=` menu, the threads open in a drawer (press `\` or click "Threads (3)"), and the mode tabs become a dropdown. Clicking a highlight opens the drawer on its thread.

## Modes

| Mode | Shows | Use it to |
|---|---|---|
| **Review** (`1`) | The selected version (head by default) with your threads highlighted | Read and comment |
| **Changes** (`2`) | The new version, live, with what changed since the base drawn on top | See what the agent did |
| **Source** (`3`) | Numbered source, or a source diff against the base (unified or split) | Check exact text; comment on raw lines (head metadata, attributes, script config) |
| **History** (`4`) | A timeline of versions and reviews | Go back in time; compare any two versions |

You can comment on any recorded version. On an older version a banner says the comments will be carried forward to the latest one. When the file on disk has edits that are not recorded yet, a banner says "Unrecorded changes on disk" with **Preview live** (a read-only live view that updates as the agent edits) and **Record as my revision**. You cannot comment on the unrecorded preview, because comments must point at text that will not change under them.

## Commenting on anything

| Target | Gesture |
|---|---|
| A phrase, sentence or paragraph (even across blocks) | Select it, then press `c` (comment), `s` (suggest), `q` (question) or `a` (agreed), or use the mini-toolbar that appears |
| Any area of the doc: text, images, diagrams, or a mix of them | Press `b` and drag a box (see [Snipping](#snipping)). A picture of the area is attached |
| Anything on your screen, inside or outside the doc (macOS) | Press `B` and drag with the macOS picker. The screenshot is attached to your selection, or to a general comment |
| A whole image, SVG, canvas, video, table, code block, list item or heading | Press `e` (pick mode), hover until the outline and label chip show the right element, click |
| A region of an image, SVG, canvas, video or iframe | In pick mode, shift-drag a box. A cropped PNG is attached so the agent can see exactly what you mean |
| A mermaid node | In pick mode, click the node: `mermaid node "Gateway"` |
| A part of an inline SVG | In pick mode, hover it; `[` and `]` walk up to the parent or down to the child |
| A table cell, row, column or the whole table | In pick mode, click a cell, then choose cell, row, column or table |
| Lines of code | Select the text in the code block (or pick the whole block) |
| A formula | Select it; the selection snaps to the whole formula |
| A section | The **⋯** menu of its heading in the outline: **Comment on section** |
| Raw source lines | Source mode: select lines, press `c` |
| The whole document | **General comment**, or the summary in the Submit dialog |

Press `Esc` to leave pick mode. Text that a page script generates at runtime is commentable too; the agent then receives the enclosing static element's source, labelled as script-rendered.

## Snipping

A snip is a comment with a picture: "this, here". The agent gets the picture's file path and opens it (Claude Code reads it with its Read tool) before acting, so it sees exactly what you saw.

| Snip | Key | Where it works | The agent gets |
|---|---|---|---|
| An area of the doc | `b`, or the scissors button | Any browser, any OS | The picture, the source lines of every block under the box, and a label |
| Anything on your screen | `B` (Shift+B), or the screen-snip button | macOS | The screenshot, on your selection or as a general comment |
| Anything, without the UI | `suiko snip`, or a global hotkey | macOS (or any OS with `--file`) | The screenshot as a draft comment, or sent at once with `--send` |
| A region of one image | `e`, then shift-drag on the image | Any browser, any OS | The crop, the image's source and the region as percentages |

### Snip an area of the doc (`b`)

Use it when the thing you mean is not a neat text selection: a figure together with its caption, the left half of a table, a diagram and the paragraph that contradicts it, a mockup in an HTML spec.

1. Press `b`, or click the scissors button in the top bar. The cursor becomes a crosshair. This works whether focus is in the Suiko UI or in the document.
2. Drag a box over the area. It can cover anything: text, images, SVG, mermaid diagrams, tables, or a mix. Boxes smaller than a few pixels are ignored.
3. When you let go, the composer opens with a thumbnail of the area. **Agent will see** shows the lines and the label the agent receives, such as `L60-64 §2 Request flow snip (figure + 2 paragraphs)`.
4. Type your comment, then `Cmd+Enter` (**Add to review**) or `Cmd+Shift+Enter` (**Send now**). Text is optional: a comment with a picture can be added or sent without any.

`Esc` cancels at any point. One press of `b` takes one snip; afterwards you are back to selecting text. The agent receives the picture plus the source lines of every block the box touches, so it can edit them directly. If the browser cannot draw part of the area (for example an image from another website or a playing video), the comment still carries the source lines, just without a picture; use `B` instead to attach a real screenshot.

Area snips and image regions (`e`, then shift-drag) both remain available. A region is tied to one image and tells the agent where inside it, in percent; an area snip can span several blocks of any kind.

### Snip anything on your screen (`B`)

Use it for things outside the document: the app the spec describes, a terminal with an error, a competitor's page, a design file.

1. Press `B` (Shift+B), or click the screen-snip button in the top bar.
2. macOS's own region picker appears, exactly as with `Cmd+Shift+4`. Drag a box, or press Space and click a window. `Esc` cancels.
3. The composer opens with the screenshot attached. If you had text selected in the doc, the comment is anchored to it; otherwise it is a general comment on the whole doc. If a comment is already open in the composer, the screenshot is added to that comment instead.
4. Type your comment and add it to the review, or send it now.

Suiko's local server takes the screenshot on your Mac with `screencapture`, so this needs macOS and the Screen Recording permission (see [below](#screen-recording-permission)). Large screenshots are scaled down to 2000 px on the longest side, and very large ones are stored as JPEG. Only one screen snip runs at a time, and an unused picker closes after two minutes.

### Snip from a terminal or a global hotkey

`suiko snip` runs the same picker from any terminal and adds the screenshot to the doc as a **draft** comment. An open review UI shows it at once, with a toast "Screenshot added from your Mac" and an **Edit** button to add text before you submit.

```bash
suiko snip                                              # picker, then a draft on this workspace's doc
suiko snip token-service -m "The header overlaps the logo"
suiko snip --question -m "Should the empty state look like this?"
suiko snip --send -m "This is the login page today"     # submitted to the agent right away
suiko snip --file ~/Desktop/shot.png -m "From the design review"
```

| Option | Effect |
|---|---|
| `<doc>` | The doc id or file path. Without it, the only doc tracked in the current directory's workspace (or the one given with `--workspace <dir>`). When that workspace tracks several docs, or the current directory has none (a Shortcut starts in your home folder), the most recently active doc; the command names its choice on stderr |
| `-m <text>` | The comment text. Without it, the draft has only the picture; add text from the toast's **Edit** |
| `--question` | Make it a question instead of a comment |
| `--send` | Submit it immediately as a one-item review (verdict Comment), so a waiting agent picks it up at once |
| `--file <png>` | Attach an existing PNG or JPEG (up to 5 MB) instead of opening the picker (works on any OS) |
| `--json` | Print the result as JSON |

Pressing `Esc` in the picker cancels and adds nothing (exit code 0). Screen snips on a machine without `screencapture` exit 1; no tracked doc exits 4.

### A global hotkey with the Shortcuts app

The macOS Shortcuts app can bind `suiko snip` to a key that works in every app. Then snipping a bug in the running app and handing it to Claude is one keystroke and a drag.

1. **Find the paths of Node and Suiko.** In a terminal:

   ```bash
   command -v node                        # e.g. /opt/homebrew/bin/node, or ~/.nvm/versions/node/v24.11.0/bin/node
   realpath "$(command -v suiko)"    # e.g. /Users/you/src/suiko/bin/suiko.js
   ```

   If `suiko` is not on your `PATH`, the second path is `bin/suiko.js` inside your Suiko checkout.
2. **Allow scripts in Shortcuts.** Open the **Shortcuts** app, choose **Shortcuts > Settings > Advanced**, and turn on **Allow Running Scripts**.
3. **Create the shortcut.** Choose **File > New Shortcut** (`Cmd+N`) and give it a name, such as "Snip to Claude".
4. **Add a Run Shell Script action.** In the action list on the right, search for **Run Shell Script** and double-click it (or drag it into the shortcut).
5. **Enter the command.** Leave **Shell** as `zsh` and **Input** as it is. Replace the sample text with the full form, built from the two paths and your project folder:

   ```bash
   "/opt/homebrew/bin/node" "/Users/you/src/suiko/bin/suiko.js" snip --workspace "/Users/you/projects/my-app"
   ```

   Shortcuts runs scripts with a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), and the scripts do not start in your project, which is why the command names Node, Suiko and the workspace explicitly. The full form works with nvm, asdf and Volta. With nvm, update the Node path when you change Node versions.

   If `npm link` put `suiko` next to a system-wide Node (Homebrew's, or the nodejs.org installer's in `/usr/local/bin`), the short form works too:

   ```bash
   export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
   suiko snip --workspace ~/projects/my-app
   ```

   Variations: add `--send` to send every snip to the agent at once instead of making a draft; add `--question` for a question. If the workspace tracks several docs, the snip goes to the most recently active one; to pin it to one doc, give the spec's file path instead of `--workspace`, for example `suiko snip ~/projects/my-app/docs/specs/token-service.md`.
6. **Assign the keyboard shortcut.** Click the **Shortcut Details** button (ⓘ) in the right sidebar, then **Add Keyboard Shortcut**, and press the combination you want, for example `Ctrl+Option+Cmd+S`. Pick one that no app uses.
7. **Try it.** Press your hotkey (or click Run, ▶, in the shortcut's window). The crosshair appears; drag a box. The draft shows up in the review UI with a toast. If Shortcuts asks whether the shortcut may run a script, allow it. The first run also asks for the Screen Recording permission.

You can make two shortcuts, one that drafts and one with `--send`, on two different keys.

### Screen Recording permission

macOS only lets an app capture other apps' windows after you allow it. The permission belongs to the app that runs the capture:

| You snip with | Allow |
|---|---|
| `B` or the screen-snip button in the UI | The app that started the Suiko server: usually your terminal (Terminal, iTerm2), your editor, or Claude |
| `suiko snip` in a terminal | That terminal app |
| A Shortcuts hotkey | **Shortcuts** (or the app macOS names in its prompt) |

macOS asks on first use. To allow it later: **System Settings > Privacy & Security > Screen & System Audio Recording**, turn the app on, then quit and reopen it. For `B`, also run `suiko stop` and open the doc again, so the server restarts under the reopened app. A screenshot that shows only the desktop wallpaper or empty windows means the permission is missing.

## The composer

The composer opens in the thread panel (or the drawer) when you start a comment.

- **Agent will see:** a preview of exactly what the agent receives, for example `L42-43 §3.2 'rotated on every use'`. If it looks too narrow, click **Widen to block**.
- **Type:** Comment, Question or Suggestion. **Severity:** Blocking, Normal or Nit (keys `1`-`3` while the composer has focus).
- **Body:** Markdown. Paste an image to attach it. A thumbnail shows the attached picture: the area you snipped, your screenshot, or the region you drew; click it to see it full size. A comment with a picture needs no text.
- **Add to review** (`Cmd+Enter`) saves the comment as a draft in your pending review.
- **Send now** (`Cmd+Shift+Enter`) submits just this comment, immediately, as a one-item review with verdict Comment. A waiting agent wakes up and handles it at once; your other drafts stay pending. To be asked first, turn on **Ask before Send now** in [Settings](#settings).
- **Cancel** (`Esc`).
- The buttons show their keys when you hover them. On Windows and Linux, use `Ctrl` instead of `Cmd`.
- Drafts autosave as you type and survive reloads. The draft count in the top bar shows how many are pending.

## Suggesting exact text

Press `s` on a selection to propose replacement text.

- **Text mode** (when the selection is plain text): an input prefilled with the selection. Type the replacement.
- **Source mode** (when the selection spans markup): a monospace editor prefilled with the full source lines. Edit them directly.
- A live word diff shows your change, and an optional rendered preview shows how it will look.

The agent applies suggestions verbatim with `suiko apply`. You can also apply one yourself with **Apply now** on its card when the file on disk has no unrecorded changes; that records a new version authored by you.

## Submitting a review

Click **Submit review** (`f`, or `Cmd+Shift+Enter` while you are not writing a comment). The dialog has:

- a summary box;
- the verdict: **Comment**, **Request changes** or **Approve**;
- the list of drafts, with links to each;
- the locks you added this round.

With **Approve**, two options appear, both on by default: **Mark vN final** and **Resolve N addressed threads**. The dialog warns you if blocking threads are still open.

If no agent is listening, the dialog says so and offers **Copy prompt**, which copies an instruction such as "Run `suiko feedback token-service` and address it." Paste it into your agent's chat.

After you submit, a status chip moves through **Submitted**, **Delivered to claude 14:02**, **revising…** and **v3 ready**.

For one urgent point, you do not need a whole review: **Send now** (`Cmd+Shift+Enter` in the comment box) sends just that comment, and `suiko snip --send` does the same for a screenshot.

## While the agent works

The presence chip shows what the agent is doing:

| Chip | Meaning |
|---|---|
| claude is listening (green) | A `suiko wait` is running; your next submit is delivered at once |
| claude is revising… (amber) | Your review was delivered and the agent is working on it |
| claude is editing (unrecorded) | The file on disk has changed but no version is recorded yet |
| No agent listening (grey) | Nothing is waiting; use **Copy prompt** after submitting, or tell the agent "done" |

The UI never switches versions or reloads while you are writing a comment; it shows a banner instead.

## Reviewing what changed

When the agent records a version, a toast appears, for example "v3 ready - answers rv2 (3 addressed, 1 needs you) [Review changes] [Verify]", and the tab title gets a `(v3)` prefix.

**Review changes** opens Changes mode with the base set to the version you last reviewed ("since my last review"). The base picker also offers "previous version" or any vN; press `d` to toggle between your last review and the previous version. In Changes mode:

- a green bar marks added blocks and an amber bar marks modified ones;
- inserted words are tinted;
- a "⊖ N lines removed" tab marks each deletion; click it to see the removed text;
- each bar carries a badge: the thread it addresses (`t1`), or an orange **other** badge whose tooltip gives the agent's reason for a change you did not ask for;
- a changed image shows a before/after pair;
- guard badges flag versions where the agent broke a lock, forced a refusal, or made a large rewrite.

The change list groups changes by section, with a "seen" checkbox per change and a progress count ("5/9 reviewed"). `n` and `p` jump to the next and previous change. Source mode shows the same comparison as a source diff (unified or split), with hunk ids and thread chips.

## Verifying the agent's replies

The **Verify** filter (`v`) lists threads the agent marked addressed, answered or declined that you have not responded to yet. Each card shows your comment, the agent's reply, and a word-level mini-diff of the change linked to it (with **View in Changes**).

| Key | Action |
|---|---|
| `j` / `k` | Next / previous thread |
| `x` | **Accept**: resolve the thread. Optionally type a one-line **Record as decision** |
| `o` | **Reopen**: opens a reply box; the reply goes into your next review |
| `y` | Accept a decline |
| `r` | Reply to the focused thread |

Accepting takes effect immediately. Reopens, replies and new comments wait in your pending review until you submit. Only you can resolve a thread; the agent never closes its own work.

## Thread cards

- **Header:** id, type and severity, status (Open, Addressed in v3, Answered, Declined, Needs you, Resolved), anchor state (Moved, Outdated, Orphaned, Hidden, Generated) and the target label.
- **Body:** the quoted text (or "was … / now …" when the text changed under the comment), then the conversation, each message tagged with its author and version.
- **Suggestion block:** the `-` / `+` lines and their status (Pending, Staged, Applied in v2, Conflict), with **Apply now** when the working copy is clean.
- **Mini-diff:** for addressed or changed threads.
- **Actions:** Open threads: Reply, Resolve, and Edit or Delete for your own drafts. Addressed or answered: **Accept** and **Reopen**; declined: **Accept decline** and **Reopen**. Needs input: an orange "claude asked you" banner and an **Answer claude** button (the agent's name) that opens the reply box. Outdated or orphaned: **Move here** (re-anchor to your current selection or pick), **View on vN**, **Resolve**.

**Orphaned threads** (their text could not be found after an edit) collect in the orphan tray in the status bar, under their last known section, with **Move here**, **Keep as general** and **Resolve**. A thread whose target is inside a closed `<details>` or an inactive tab is marked **Hidden**; focusing it reveals the target.

## Locks: marking parts agreed

Select text (or use the **⋯** menu of a heading in the outline) and choose **Mark agreed** (`a`). Once you confirm, this creates a lock (`L1`) immediately; it does not wait for Submit. Locked regions show a bracket in the margin and `[L]` in the outline.

- The agent sees every lock as `LOCKED (agreed - do not modify)` in its feedback.
- `suiko revise` **refuses** any version that changes locked text. The agent can only override that with an explicit reason (`--break-lock`), which shows a red "lock broken" badge on the version and deactivates the lock until you re-lock it with **Relock** (offered in the message that appears when you click the lock bracket).
- **Unlock** removes a lock when you want the agent to change that part again.

## Decisions

When you accept a thread you can record a one-line decision, such as "30 s reuse-detection grace window". Decisions are listed in every packet as `DECISIONS to keep true`, and the agent gets a warning if it changes their text. When the doc is final, `suiko final <doc> --decisions` writes a decision log next to the spec.

## History and versions

The History mode timeline interleaves versions and reviews. Each version row shows the author, time, summary, the review it answers, thread chips, +/- line counts and guard badges. Row actions:

- **View**: render that version read-only with its own anchors.
- **Diff vs previous**: Changes mode for that version against the one before.
- **Compare with…**: Changes mode for any pair, including the live working copy.

The version picker and `[` / `]` (outside pick mode) move between versions. Every version is an immutable copy under `.specreview/`, so nothing the agent does can lose an earlier state.

## Approving and the final version

Submit with **Approve** and keep **Mark vN final** checked. The doc shows a **FINAL vN** badge. If the agent records a later version, the badge stays on vN and the UI notes that newer unapproved changes exist. The agent then runs `suiko final <doc> --decisions`, which checks the file on disk matches the final version and writes the decision log.

## Keyboard shortcuts

Press `Cmd+/` (or `?`) in the UI for this list. Buttons show their key when you hover them. On Windows and Linux, use `Ctrl` where this says `Cmd`.

| | Key | Action |
|---|---|---|
| **Anywhere** | `Cmd+K` | [Command palette](#command-palette) (press again to close) |
| | `Cmd+,` | [Settings](#settings) |
| | `Cmd+/` or `?` | Keyboard shortcuts (this list) |
| **Comment** | `c` / `s` / `q` | Comment, suggest, or ask a question on the selection |
| | `a` | Mark the selection agreed (lock) |
| | `b` | Snip an area of the doc: drag a box over anything (`Esc` cancels) |
| | `B` (Shift+B) | Snip anywhere on your screen with the macOS picker |
| | `e` | Pick mode (in pick mode: `[` / `]` parent / child, shift-drag a region of an image, `Esc` exits) |
| | `Cmd+Enter` | In the composer: **Add to review** (saves a draft) |
| | `Cmd+Shift+Enter` | In the composer: **Send now** (submits just this comment) |
| | `1` / `2` / `3` | In the composer: severity Blocking / Normal / Nit |
| | `Esc` | Close or cancel |
| **Review** | `f` or `Cmd+Shift+Enter` | Submit review dialog (outside the composer) |
| | `v` | Verify queue |
| | `x` | Resolve / accept |
| | `o` | Reopen |
| | `y` | Accept a decline |
| | `r` | Reply to the focused thread |
| **Navigate** | `j` / `k` | Next / previous thread |
| | `n` / `p` | Next / previous change |
| | `1` / `2` / `3` / `4` | Review / Changes / Source / History |
| | `[` / `]` (outside pick mode) | Previous / next version |
| | `d` | Toggle base: your last review vs the previous version |
| **View** | `h` | Hide all annotations (clean read) |
| | `\` | Toggle the thread sidebar or drawer |
| | `t` | Cycle theme (light, dark, system) |

`Cmd+K`, `Cmd+,` and `Cmd+/` work everywhere: in the Suiko UI, in the document, and while you type a comment or reply (your draft is kept). On a Mac, `Ctrl+K`, `Ctrl+,` and `Ctrl+/` do the same, because Safari and the Claude desktop app may keep `Cmd+,` or `Cmd+K` for themselves.

Navigation keys, `b` and `Cmd+Shift+Enter` work while the document has focus too, as long as you are not typing in one of its fields. Keys that change state act only when focus is in the Suiko UI: `x`, `o` and `y` do nothing while focus is inside the document (click the thread panel first), and `a` on a document selection asks you to confirm before it locks anything. This keeps scripts in a reviewed document from triggering actions on your behalf.

## Command palette

Press `Cmd+K` (or click **Commands** in the top bar) to search everything Suiko can do by name, so you do not need to remember a key. Type a few letters (for example "verify" or "compare") and press `Enter` to run the highlighted command; `Up` / `Down` move through the list. `Esc` or `Cmd+K` closes it. With nothing typed, it starts with the commands you ran last.

A command that cannot run right now is dimmed and says why (for example "select text in the doc first"). Commands that end in "…" open a short list of their own: type to narrow it, and press `Backspace` in the empty field to go back. A thread id such as `t4`, a version such as `v2` or the words of a heading also work straight from the top-level search.

The palette lists every action that has a key, plus these, which have none:

| Command | Does |
|---|---|
| **Go to thread / section / version** | Jump to a thread by id or text, a heading in the outline, or any recorded version (or the live working copy) |
| **Compare versions** | Changes mode for any two versions: pick the older one, then the newer one |
| **Filters** | Show **Open**, **Needs me**, **Verify**, **Drafts**, **Resolved**, **Outdated** or **All** threads |
| **Submit review as Comment / Request changes / Approve** | Open **Submit review** with that verdict already chosen; nothing is sent until you submit there |
| **General comment** | A comment about the whole document |
| **Record the working copy as my revision** | Listed when the file on disk has unrecorded changes; opens the record form |
| **Mark all changes seen** | Ticks every change of the comparison shown in the Changes list |
| **Copy the review link** | The UI's URL. It contains your access token and works only on this machine |
| **Copy the "tell the agent" prompt** | The instruction to paste into your agent's chat, as **Copy prompt** in the submit dialog |
| **Copy the spec path** | The spec file's path on disk |
| **Toggle the outline rail** | Show or hide the outline and history beside the document |
| **Reload the document** | Render the version shown again |
| **Open the document list / Open another document** | The list of tracked docs, or switch straight to another one |
| **Close the review session** | Asks first, then ends the session like `suiko close`; a waiting agent stops waiting |
| **Theme: System / Light / Dark** | Pick a theme directly |
| **Toggle single-letter shortcuts** | Turn them on or off (see [Settings](#settings)) |

## Settings

Press `Cmd+,`, or click the gear in the top bar, to open Settings. Settings apply to every doc and are remembered in this browser.

| Setting | Choices | What it does |
|---|---|---|
| **Theme** | Light, Dark, System | Same as `t`. Markdown documents follow it; raw HTML documents keep their own styling |
| **Outline rail** | Auto, Always, Never | Auto shows the outline beside the document when the window is wide and keeps it behind the `=` menu button when it is narrower, such as the pane next to a chat. Always keeps it beside the document when there is room; Never keeps it behind the button |
| **Thread panel open by default** | On, Off | Whether the thread panel is showing when you open a doc. `\` still shows or hides it at any time |
| **Single-letter shortcuts** | On, Off | Off: every one-key shortcut (letters such as `c`, `j` and `b`, digits, and `?`, `[`, `]`, `\`, `B`) does nothing, in the UI and in the document. Turn this off if the document has its own keyboard controls, you use speech input, or you press keys by accident. `Esc`, the `Cmd` shortcuts, the buttons and the command palette still work, and the composer's `1`-`3` severity keys keep working while you type a comment |
| **When the agent records a new version** | Show a toast, Switch to Changes | A toast with **Review changes** and **Verify**, or go straight to Changes mode against your last review. The UI never switches while you are writing a comment or reply, or while a dialog is open; you get the toast then |
| **Ask before Send now** | On, Off | On: **Send now** (`Cmd+Shift+Enter` in the composer, or its button) asks you to confirm in the composer first; press it again to send, or `Esc` to go back |
| **Default verdict** | Comment, Request changes | The verdict **Submit review** starts on when nothing in the review is blocking (a blocking comment always starts it on **Request changes**). You can still change it there, including to **Approve** |
| **About** | | The Suiko version, the workspace and spec path, the ports in use, and the "tell the agent" prompt to copy |

## Theme, accessibility and clean reading

- `t` cycles light, dark and system themes (or pick one in [Settings](#settings)). Markdown documents follow the theme (including mermaid diagrams); raw HTML documents keep their own styling.
- `h` hides every highlight, pin and change mark for a clean read; press it again to bring them back.
- All controls are labelled buttons with visible focus rings. The thread and change lists are the keyboard-accessible counterparts of the highlights. States are shown with icons and text, not colour alone. Reduced-motion settings are respected.
- If one-key shortcuts get in your way (speech input, or a document with its own keyboard controls), turn off **Single-letter shortcuts** in [Settings](#settings); every action stays available from the buttons and the [command palette](#command-palette).

## When something looks wrong

| Symptom | What it means | What to do |
|---|---|---|
| "Annotations are blocked by this document's Content-Security-Policy" | The document's own CSP meta tag blocks the review overlay | Review in **Source** mode, or ask the agent to remove the restrictive CSP meta |
| "2 external resources failed (offline?)" | The document loads files from the internet and they did not load | Expected offline. Ask the agent to make the document self-contained |
| Page errors count in the status bar | The document's own scripts threw errors | Check whether they affect what you are reviewing; mention them in a comment if so |
| A thread is **Outdated** | Its text was edited without being linked to it | Read "was / now" on the card; reply, resolve, or **Move here** |
| A thread is **Orphaned** | Its text is gone | Use the orphan tray: **Move here**, **Keep as general** or **Resolve** |
| "No agent listening" after you submit | The agent's wait is not running | Click **Copy prompt** and paste it into the agent's chat, or tell it "done" |
| "Reconnecting to Suiko…" | The local server restarted or is starting | Wait a few seconds; run `suiko doctor` if it persists |
| A screen snip shows only the wallpaper or empty windows | macOS has not allowed the capturing app to record the screen | Allow it under [Screen Recording permission](#screen-recording-permission), quit and reopen the app, then `suiko stop` and reopen the doc |
| `B` or `suiko snip` reports that screen snips are unsupported | Screen snips use macOS's `screencapture`, which this machine does not have | Use `b` to snip inside the doc, paste an image into the composer, or `suiko snip --file <png>` |
| An area snip has no thumbnail | The browser could not draw that area (an image from another site, a video, a cross-origin frame) | The comment still carries the source lines. Use `B` to attach a real screenshot |
| The Shortcuts hotkey does nothing | Scripts are not allowed, or the command cannot find Node | Turn on **Allow Running Scripts** in Shortcuts settings, use the full form with absolute paths, and run the shortcut from its window to see the error |
