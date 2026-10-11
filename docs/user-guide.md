<!-- Reviewer guide for the SpecReview web UI: layout, modes, commenting gestures, submitting, verifying changes, locks, history, final, and keyboard shortcuts. Describes the v1 UI (see docs/BUILD_AMENDMENTS.md section 1 for what is out of scope). -->

# SpecReview reviewer guide

SpecReview shows a spec exactly as written (scripts, SVG, images, tables, code, mermaid and math all work) and lets you comment on any part of it. Your agent receives each comment with the exact source lines behind it, makes targeted edits, and records a new version. You then see precisely what changed, accept or reopen each thread, and repeat until you approve a final version.

- [Opening a document](#opening-a-document)
- [The screen](#the-screen)
- [Modes](#modes)
- [Commenting on anything](#commenting-on-anything)
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
- [Theme, accessibility and clean reading](#theme-accessibility-and-clean-reading)
- [When something looks wrong](#when-something-looks-wrong)

## Opening a document

Your agent runs `specreview open <file>` and opens the printed URL for you. In the Claude desktop app it appears in the browser pane beside the chat; elsewhere, open the URL in any modern browser. You can also run `specreview open <file>` yourself.

- The URL contains an access token (`?k=…`). It works only on this machine; don't share it.
- The doc list (top-left) shows every tracked doc with its head version, open threads and whether an agent is listening.
- If the local server restarts, the UI shows "Reconnecting to SpecReview…" and recovers on its own. Your drafts are saved on the server, so a reload loses nothing.

## The screen

Wide layout (900 px and up):

- **Top bar:** doc name, version picker, mode tabs (**Review**, **Changes**, **Source**, **History**), the comparison base (in Changes and Source modes), the presence chip (for example "claude is listening"), the draft count and **Submit review**.
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

## The composer

The composer opens in the thread panel (or the drawer) when you start a comment.

- **Agent will see:** a preview of exactly what the agent receives, for example `L42-43 §3.2 'rotated on every use'`. If it looks too narrow, click **Widen to block**.
- **Type:** Comment, Question or Suggestion. **Severity:** Blocking, Normal or Nit (keys `1`-`3` while the composer has focus).
- **Body:** Markdown. Paste an image to attach it. A crop thumbnail shows when you drew a region.
- **Add to review** (`Cmd+Enter`) saves the comment as a draft in your pending review. **Send now** submits it immediately as a one-item review (verdict Comment). **Cancel** (`Esc`).
- Drafts autosave as you type and survive reloads. The draft count in the top bar shows how many are pending.

## Suggesting exact text

Press `s` on a selection to propose replacement text.

- **Text mode** (when the selection is plain text): an input prefilled with the selection. Type the replacement.
- **Source mode** (when the selection spans markup): a monospace editor prefilled with the full source lines. Edit them directly.
- A live word diff shows your change, and an optional rendered preview shows how it will look.

The agent applies suggestions verbatim with `specreview apply`. You can also apply one yourself with **Apply now** on its card when the file on disk has no unrecorded changes; that records a new version authored by you.

## Submitting a review

Click **Submit review** (`f`, or `Cmd+Shift+Enter`). The dialog has:

- a summary box;
- the verdict: **Comment**, **Request changes** or **Approve**;
- the list of drafts, with links to each;
- the locks you added this round.

With **Approve**, two options appear, both on by default: **Mark vN final** and **Resolve N addressed threads**. The dialog warns you if blocking threads are still open.

If no agent is listening, the dialog says so and offers **Copy prompt**, which copies an instruction such as "Run `specreview feedback token-service` and address it." Paste it into your agent's chat.

After you submit, a status chip moves through **Submitted**, **Delivered to claude 14:02**, **revising…** and **v3 ready**.

## While the agent works

The presence chip shows what the agent is doing:

| Chip | Meaning |
|---|---|
| claude is listening (green) | A `specreview wait` is running; your next submit is delivered at once |
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
- `specreview revise` **refuses** any version that changes locked text. The agent can only override that with an explicit reason (`--break-lock`), which shows a red "lock broken" badge on the version and deactivates the lock until you re-lock it with **Relock** (offered in the message that appears when you click the lock bracket).
- **Unlock** removes a lock when you want the agent to change that part again.

## Decisions

When you accept a thread you can record a one-line decision, such as "30 s reuse-detection grace window". Decisions are listed in every packet as `DECISIONS to keep true`, and the agent gets a warning if it changes their text. When the doc is final, `specreview final <doc> --decisions` writes a decision log next to the spec.

## History and versions

The History mode timeline interleaves versions and reviews. Each version row shows the author, time, summary, the review it answers, thread chips, +/- line counts and guard badges. Row actions:

- **View**: render that version read-only with its own anchors.
- **Diff vs previous**: Changes mode for that version against the one before.
- **Compare with…**: Changes mode for any pair, including the live working copy.

The version picker and `[` / `]` (outside pick mode) move between versions. Every version is an immutable copy under `.specreview/`, so nothing the agent does can lose an earlier state.

## Approving and the final version

Submit with **Approve** and keep **Mark vN final** checked. The doc shows a **FINAL vN** badge. If the agent records a later version, the badge stays on vN and the UI notes that newer unapproved changes exist. The agent then runs `specreview final <doc> --decisions`, which checks the file on disk matches the final version and writes the decision log.

## Keyboard shortcuts

Press `?` in the UI for this list.

| Key | Action |
|---|---|
| `c` / `s` / `q` / `a` | Comment, suggest, question, or mark agreed on the selection |
| `e` | Pick mode (in pick mode: `[` / `]` parent / child, `Esc` exits) |
| `j` / `k` | Next / previous thread |
| `n` / `p` | Next / previous change |
| `r` | Reply to the focused thread |
| `x` | Resolve / accept |
| `o` | Reopen |
| `y` | Accept a decline |
| `v` | Verify queue |
| `f` or `Cmd+Shift+Enter` | Submit review dialog |
| `Cmd+Enter` | Add the draft to the review |
| `1` / `2` / `3` / `4` | Review / Changes / Source / History |
| `[` / `]` (outside pick mode) | Previous / next version |
| `d` | Toggle base: your last review vs the previous version |
| `h` | Hide all annotations (clean read) |
| `\` | Toggle the thread sidebar or drawer |
| `t` | Cycle theme (light, dark, system) |
| `?` | Help overlay |
| `Esc` | Close or cancel |

Navigation keys work while the document has focus too, as long as you are not typing in one of its fields. Keys that change state act only when focus is in the SpecReview UI: `x`, `o` and `y` do nothing while focus is inside the document (click the thread panel first), and `a` on a document selection asks you to confirm before it locks anything. This keeps scripts in a reviewed document from triggering actions on your behalf.

## Theme, accessibility and clean reading

- `t` cycles light, dark and system themes. Markdown documents follow the theme (including mermaid diagrams); raw HTML documents keep their own styling.
- `h` hides every highlight, pin and change mark for a clean read; press it again to bring them back.
- All controls are labelled buttons with visible focus rings. The thread and change lists are the keyboard-accessible counterparts of the highlights. States are shown with icons and text, not colour alone. Reduced-motion settings are respected.

## When something looks wrong

| Symptom | What it means | What to do |
|---|---|---|
| "Annotations are blocked by this document's Content-Security-Policy" | The document's own CSP meta tag blocks the review overlay | Review in **Source** mode, or ask the agent to remove the restrictive CSP meta |
| "2 external resources failed (offline?)" | The document loads files from the internet and they did not load | Expected offline. Ask the agent to make the document self-contained |
| Page errors count in the status bar | The document's own scripts threw errors | Check whether they affect what you are reviewing; mention them in a comment if so |
| A thread is **Outdated** | Its text was edited without being linked to it | Read "was / now" on the card; reply, resolve, or **Move here** |
| A thread is **Orphaned** | Its text is gone | Use the orphan tray: **Move here**, **Keep as general** or **Resolve** |
| "No agent listening" after you submit | The agent's wait is not running | Click **Copy prompt** and paste it into the agent's chat, or tell it "done" |
| "Reconnecting to SpecReview…" | The local server restarted or is starting | Wait a few seconds; run `specreview doctor` if it persists |
