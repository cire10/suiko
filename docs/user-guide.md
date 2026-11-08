<!-- Reviewer guide for the Suiko web UI: the screen (top bar, tool dock, marks, outline, thread panel), modes, commenting and snipping (area snips, screen snips, `suiko snip` and a global macOS hotkey), sending (right away or as a review), whose turn it is, threads, Claude's pictures and HTML mockups, batched edits and planned changes, new versions, what changed (inline and side by side), locks, decisions, history, approving, keyboard shortcuts, the command palette and settings. Describes the UI as it is; docs/BUILD_AMENDMENTS.md section 1 lists what is out of scope. -->

# Suiko reviewer guide

Suiko shows a document exactly as written (a report with charts and scripts, a spec, a plan: scripts, SVG, images, tables, code, mermaid and math all work) and lets you comment on any part of it. Your agent receives each comment with the exact source lines behind it, answers on the thread, changes what you asked for (in the file, or in the sources it builds the document from) and records a new version. You see what changed, check each answer, and go on until you approve a final version.

This guide writes "Claude" where the UI writes your agent's name: with another agent, the buttons and labels name that agent instead.

- [Opening a document](#opening-a-document)
- [The screen](#the-screen)
- [Modes](#modes)
- [Commenting on anything](#commenting-on-anything)
- [Snipping](#snipping)
- [The composer](#the-composer)
- [Suggesting exact text](#suggesting-exact-text)
- [Sending](#sending)
- [Whose turn it is](#whose-turn-it-is)
- [Threads](#threads)
- [Pictures and mockups from Claude](#pictures-and-mockups-from-claude)
- [Batched edits and planned changes](#batched-edits-and-planned-changes)
- [New versions](#new-versions)
- [Reviewing what changed](#reviewing-what-changed)
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
- A document opens on its latest version, with your threads and without change highlights; the **Changes** tab says how much is new. **Open documents in** ([Settings](#settings) > Reading) can open it in the reading view, or on what changed since your last review, instead.
- The thread panel opens by itself when the document has threads or drafts (and when you open **Changes**), unless **Thread panel open by default** is off in Settings. `\` shows or hides it at any time.
- The doc list (the Suiko mark at the top left, or **Open the document list** in the [command palette](#command-palette)) shows every tracked document with its version and state (**In review**, **Approved**, **Closed**), whose turn its threads are (**Your turn 4**, **With Claude 3**), **Waiting for Claude** when a review you sent waits for Claude to connect, **Claude is listening**, and **Final v2** once a version is final. Its header has the command palette ("Search or run a command"), the theme, Settings and the keyboard shortcuts.
- If the local server restarts, the UI shows "Reconnecting to Suiko..." and recovers on its own. Your drafts are saved on the server, so a reload loses nothing; a comment you were still writing is offered back ("You have an unsent comment from earlier.", **Restore**).
- A web page can be reviewed too: `suiko snapshot <url>` fetches it once and opens a cleaned copy (no scripts; remote images blocked unless `--allow-remote-assets`). The doc list shows it as "web page · <host>". Running the command again records the next version when the page changed. See [Snapshot a web page](../README.md#snapshot-a-web-page) in the README.

## The screen

### The top bar

One row, left to right:

- **≡**: the outline, when it is not beside the document (see [The outline](#the-outline)).
- The Suiko mark (back to the doc list) and the document's title.
- The version shown: `v3 · latest`, `v2`, `v3 · final`. While the file has edits that are not recorded yet, its menu also offers **Working copy (live)**: pick it (or **Preview live** in the banner) to preview them. In **Changes** and **Source** it becomes a range, `[v1 · last review] → [v3 · latest]`: pick the older version on the left and the newer one on the right.
- **Read · Review · Changes**: the [modes](#modes). The **Changes** tab counts the changes that are new since your last review.
- On the right: the **turn pill**, which says whose turn it is (see [Whose turn it is](#whose-turn-it-is)); a **⚠** chip, only when something is wrong (script errors in the page, resources that did not load, a file missing on disk; click it for the details); the search icon (the [command palette](#command-palette), `Cmd+K`); the threads button with the number of open threads (`\`); the **⋯** More menu; and the one main button: **Send 3** while you have drafts, else **Approve**.

Below 1200 px the versions show only their numbers (the working copy is **Working copy**) and the turn pill a short label ("Listening", "Apply 2"); below 1024 px the pill keeps only its dot (and your count). Its tooltip always says it in full.

**⋯ More** holds what you need less often, each with its key: **Source** (`3`), **History** (`4`), **Hide marks** (`h`; **Show marks** brings them back; Read mode has none to hide), **Theme** (`t`; it cycles System, Light, Dark, and the menu stays open while you click through them), **Keyboard shortcuts** (`?`), **Settings** (`Cmd+,`) and **Document info**: the file and its path (**Copy path**), the version shown, the final version, the working copy, script errors and resources that did not load, threads that lost their place (**Show them**), where Claude is, and the prompt to paste into its chat when it isn't connected. While Source or History is open, it shows as a fourth tab.

### The tool dock

A small pill floats at the bottom centre of the document with the comment tools. They are icons without labels: hover one and its tooltip says what it does and names its key.

| Icon | Key | Does |
|---|---|---|
| Speech bubble | `c` | Comment on the selected text (it is enabled while text is selected) |
| Crosshair | `e` | Pick an element: an image, diagram, table or code block (see [Commenting on anything](#commenting-on-anything)) |
| Scissors | `b` | Snip an area of the document (see [Snipping](#snipping)) |
| Monitor | `Shift+B` | Snip anywhere on your screen with the macOS picker (macOS only) |

It is quieter in Read mode and hidden in Source and History. While the document scrolls it fades almost away, and clicks go through it to the text; it comes back about a second after the scrolling stops, at once when the pointer nears the bottom of the document, and while text is selected. The document gets room at its end, so its last line always scrolls clear of the dock. On the read-only working copy preview the tools are off.

Selecting text in the document also shows a small toolbar above the selection: **Comment**, **Suggest**, **Question** and **Agreed** (the keys `c`, `s`, `q` and `a` do the same). Using the dock's speech bubble instead hides it.

### Marks over the document

What is drawn over the document is what still needs you; a thread you mark done leaves the page. Its colour says whose turn it is, in the hue of its card's chip, except a draft (dashed soft indigo) and a thread that lost its place in this version (grey):

| Colour | The thread |
|---|---|
| Indigo | **With Claude**: sent, waiting for Claude's answer |
| Green | **Changed in vN — check it** or **Claude answered**: check it |
| Amber | **Claude didn't change it**: agree, or reply to say why it should |
| Orange | A question from Claude for you |
| Violet | **Will change**: Claude plans this change for when you apply it |
| Grey | **Lost its place** |
| Dashed soft indigo | A draft, not sent yet |
| Teal bracket in the margin | Text you marked agreed (locked) |

Highlights mark text, numbered pins in the margin mark threads, and boxes mark elements and regions. The selected thread keeps its colour and gets a ring. Clicking a mark focuses its card. A thread that is done is not drawn: select its card under **Done** or **All** to see where it was. **Hide marks** (`h`) hides all of them for a clean read.

### The outline

The headings of the document, with badges: the number of open threads, `~` changed, `+` added, `L` agreed (locked); in Read mode it is a plain table of contents. The **⋯** button next to a heading offers **Comment on section** and **Mark agreed** (**Unlock (L1)** instead when the section is locked). With the **Outline rail** setting on Auto it sits beside the document from 1600 px; in a narrower window it waits behind **≡** (open it there and it stays open).

### The thread panel

On the right: **Threads**, a **+** for a general comment, the filters **Your turn · Claude · Done · All** (see [Threads](#threads)) and the cards in document order. Clicking a card scrolls the document to its place. Drag the panel's left edge to make it wider or narrower (the arrow keys move it when it has focus, and a double-click goes back to the default width); the width is remembered in this browser. In **Changes** the panel has two tabs, **Changes** and **Threads**.

### Narrow windows

Below 900 px (typical for the pane next to a chat) the outline is behind **≡**, the threads open in a drawer (`\` or the threads button; its head says **Threads**, or holds the **Changes** and **Threads** tabs in Changes), and the modes become a dropdown that lists all five. Clicking a mark opens the drawer on its thread. Side by side needs a window at least 900 px wide.

## Modes

| Mode | Shows | Use it to |
|---|---|---|
| **Read** (`0`) | The latest version as its readers see it: no highlights, change marks or threads | Read the document clean. You can still select text and comment; the composer opens beside the document |
| **Review** (`1`) | The version shown, with your threads | Read and comment |
| **Changes** (`2`) | What changed between two versions: drawn over the newer one (Inline), or the older one beside it (Side by side) | See what Claude did |
| **Source** (`3`, in **⋯ More**) | The numbered source, or its diff against the older version (**Diff against v1**, Unified or Split) | Check exact text; comment on raw lines (head metadata, attributes, script config) |
| **History** (`4`, in **⋯ More**) | Versions and reviews, newest first | Go back in time; compare any two versions |

Hover a tab to see what it shows. The palette's **Show changes** and **Hide changes** go to Changes and back to the mode you came from. A code review (`suiko review`, see [Code review](../README.md#code-review) in the README) has **Files · Changes** and History instead.

You can comment on any recorded version. On an older version a banner says "You are viewing v2 (latest is v3). Comments are carried forward to v3." with **Go to v3**. When the file on disk has edits that are not recorded yet, a banner says "Unrecorded changes on disk (Claude is editing)" with **Preview live** (a read-only view that reloads as the file changes) and **Record as my revision** (type a summary, then **Record**). You cannot comment on the live preview, because comments must point at text that will not change under them.

## Commenting on anything

| Target | Gesture |
|---|---|
| A phrase, sentence or paragraph (even across blocks) | Select it, then press `c` (comment), `s` (suggest), `q` (question) or `a` (agreed), or use the toolbar above the selection or the dock's speech bubble |
| Any area of the doc: text, images, diagrams, or a mix of them | The dock's scissors (or `b`), then drag a box (see [Snipping](#snipping)). A picture of the area is attached |
| Anything on your screen, inside or outside the doc (macOS) | The dock's monitor (or `Shift+B`), then drag with the macOS picker. The screenshot is attached to your selection, or to a general comment |
| A whole image, SVG, canvas, video, table, code block, list item or heading | The dock's crosshair (or `e`, pick mode): hover until the outline and label chip show the right element, then click |
| A region of an image, SVG, canvas, video or iframe | In pick mode, shift-drag a box. A cropped PNG is attached so the agent can see exactly what you mean |
| A mermaid node | In pick mode, click the node: `mermaid node "Gateway"` |
| A part of an inline SVG | In pick mode, hover it; `[` and `]` walk up to the parent or down to the child |
| A table cell, row, column or the whole table | In pick mode, click a cell, then choose cell, row, column or table |
| Lines of code | Select the text in the code block (or pick the whole block) |
| A formula | Select it; the selection snaps to the whole formula |
| A section | The **⋯** menu of its heading in the outline: **Comment on section** |
| Raw source lines | **Source** (**⋯ More**, or `3`): click a line number (shift-click for a range), then press `c` |
| The whole document | The **+** (General comment) at the top of the thread panel, **General comment** in the palette, or the summary in the Send dialog |

Press `Esc` to leave pick mode. Text that a page script generates at runtime is commentable too; the agent then receives the enclosing static element's source, labelled as script-rendered.

A document with its own keyboard shortcuts keeps the single-letter keys pressed in it, so its own `j`, `3` or `b` keep working; Suiko says so once ("This document has its own keyboard shortcuts, so single-letter keys pressed in it stay with it."). The dock, the selection toolbar, "select text and press `c`", and keys pressed with the focus in the Suiko UI (click the thread panel first) still work.

## Snipping

A snip is a comment with a picture: "this, here". The agent gets the picture's file path and opens it (Claude Code reads it with its Read tool) before acting, so it sees exactly what you saw.

| Snip | How | Where it works | The agent gets |
|---|---|---|---|
| An area of the doc | The dock's scissors, or `b` | Any browser, any OS | The picture, the source lines of every block under the box, and a label |
| Anything on your screen | The dock's monitor, or `Shift+B` | macOS | The screenshot, on your selection or as a general comment |
| Anything, without the UI | `suiko snip`, or a global hotkey | macOS (or any OS with `--file`) | The screenshot as a draft comment, or sent at once with `--send` |
| A region of one image | The dock's crosshair (or `e`), then shift-drag on the image | Any browser, any OS | The crop, the image's source and the region as percentages |

### Snip an area of the doc (`b`)

Use it when the thing you mean is not a neat text selection: a figure together with its caption, the left half of a table, a diagram and the paragraph that contradicts it, a chart in an HTML report.

1. Click the scissors in the tool dock at the bottom of the document (its tooltip: "Snip an area of the document…"), or press `b`. The cursor becomes a crosshair. The key works whether focus is in the Suiko UI or in the document (unless the document has its own keyboard shortcuts: then use the dock).
2. Drag a box over the area. It can cover anything: text, images, SVG, mermaid diagrams, tables, or a mix. Boxes smaller than a few pixels are ignored.
3. When you let go, the composer opens with a thumbnail of the area. **Claude will see** names what the agent receives (the source lines are in its tooltip).
4. Type your comment, then **Send** (`Cmd+Enter`), or **Save as draft** (`Cmd+Shift+Enter`) to send it later with others. Text is optional: a comment with a picture can be sent without any.

`Esc` cancels at any point. Each snip takes one box; afterwards you are back to selecting text. The agent receives the picture plus the source lines of every block the box touches, so it can edit them directly. If the browser cannot draw part of the area (for example an image from another website or a playing video), the comment still carries the source lines, just without a picture; snip the screen instead to attach a real screenshot.

Area snips and image regions (the crosshair, then shift-drag) both remain available. A region is tied to one image and tells the agent where inside it, in percent; an area snip can span several blocks of any kind.

### Snip anything on your screen (`Shift+B`)

Use it for things outside the document: the app the document describes, a terminal with an error, a competitor's page, a design file.

1. Click the monitor in the tool dock (its tooltip: "Snip anywhere on your screen…"), or press `Shift+B`. While the picker waits, Suiko says "Select an area anywhere on your screen… (Esc to cancel)".
2. macOS's own region picker appears, exactly as with `Cmd+Shift+4`. Drag a box, or press Space and click a window. `Esc` cancels.
3. The composer opens with the screenshot attached. If you had text selected in the doc, the comment is anchored to it; otherwise it is a general comment on the whole doc. If a comment is already open in the composer, the screenshot is added to that comment instead.
4. Type your comment and send it, or save it as a draft.

Suiko's local server takes the screenshot on your Mac with `screencapture`, so this needs macOS and the Screen Recording permission (see [below](#screen-recording-permission)). Large screenshots are scaled down to 2000 px on the longest side, and very large ones are stored as JPEG. Only one screen snip runs at a time, and an unused picker closes after two minutes.

### Snip from a terminal or a global hotkey

`suiko snip` runs the same picker from any terminal and adds the screenshot to the doc as a **draft** comment. An open review UI shows it at once, with a toast "Screenshot added from your Mac" and an **Edit** button to add text before you send it.

```bash
suiko snip                                              # picker, then a draft on this workspace's doc
suiko snip token-service -m "The header overlaps the logo"
suiko snip --question -m "Should the empty state look like this?"
suiko snip --send -m "This is the login page today"     # sent to the agent right away
suiko snip --file ~/Desktop/shot.png -m "From the design review"
```

| Option | Effect |
|---|---|
| `<doc>` | The doc id or file path. Without it, the only doc tracked in the current directory's workspace (or the one given with `--workspace <dir>`). When that workspace tracks several docs, or the current directory has none (a Shortcut starts in your home folder), the most recently active doc; the command names its choice on stderr |
| `-m <text>` | The comment text. Without it, the draft has only the picture; add text from the toast's **Edit** |
| `--question` | Make it a question instead of a comment |
| `--send` | Send it immediately as a one-item review, so a waiting agent picks it up at once |
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

   Variations: add `--send` to send every snip to the agent at once instead of making a draft; add `--question` for a question. If the workspace tracks several docs, the snip goes to the most recently active one; to pin it to one doc, give the document's file path instead of `--workspace`, for example `suiko snip ~/projects/my-app/docs/specs/token-service.md`.
6. **Assign the keyboard shortcut.** Click the **Shortcut Details** button (ⓘ) in the right sidebar, then **Add Keyboard Shortcut**, and press the combination you want, for example `Ctrl+Option+Cmd+S`. Pick one that no app uses.
7. **Try it.** Press your hotkey (or click Run, ▶, in the shortcut's window). The crosshair appears; drag a box. The draft shows up in the review UI with a toast. If Shortcuts asks whether the shortcut may run a script, allow it. The first run also asks for the Screen Recording permission.

You can make two shortcuts, one that drafts and one with `--send`, on two different keys.

### Screen Recording permission

macOS only lets an app capture other apps' windows after you allow it. The permission belongs to the app that runs the capture:

| You snip with | Allow |
|---|---|
| The dock's monitor or `Shift+B` in the UI | The app that started the Suiko server: usually your terminal (Terminal, iTerm2), your editor, or Claude |
| `suiko snip` in a terminal | That terminal app |
| A Shortcuts hotkey | **Shortcuts** (or the app macOS names in its prompt) |

macOS asks on first use. To allow it later: **System Settings > Privacy & Security > Screen & System Audio Recording**, turn the app on, then quit and reopen it. For screen snips from the UI, also run `suiko stop` and open the doc again, so the server restarts under the reopened app. A screenshot that shows only the desktop wallpaper or empty windows means the permission is missing.

## The composer

The composer opens at the top of the thread panel (in the drawer on a narrow screen, beside the document in Read mode) when you start a comment. Its title says what it is: **New comment on v3**, **Edit draft d2**, or **Mark agreed**.

- **Claude will see:** what the agent receives, in plain words: `Claude will see: “rotated on every use” (§3.2 Token refresh)`. Its tooltip adds the source lines. If a text selection looks too narrow, click **Widen to block** (and **Back to selection** to undo it). If Suiko cannot anchor what you picked, it says so and offers **Make it a general comment**, keeping your text and pictures.
- **Type:** **Comment**, **Question** or **Suggestion** (see [Suggesting exact text](#suggesting-exact-text); not for a whole document or section).
- **Must fix:** a toggle for what Claude has to change before you approve. With the focus in the composer but not in its text box, `1` sets Must fix, `2` normal and `3` nit (a removable **Nit** chip).
- **The text:** Markdown. The buttons above the box make text **bold**, or lines a bulleted or numbered list (`Cmd+B`, `Cmd+Shift+8`, `Cmd+Shift+7`); press one again to undo it. `Enter` continues a list, `Enter` on an empty item ends it, and `Shift+Enter` is a plain line break. You see the Markdown while you write and the formatted text on the card; the agent reads it as you wrote it. The box grows with your text. The reply box and the Send dialog's summary work the same way.
- **Pictures:** paste or drop an image to attach it. Thumbnails show what is attached: the area you snipped, your screenshot, or the region you drew; click one to see it full size. Pasted images and screenshots have **Remove**; the picture of an area snip or a region stays with the comment (**Cancel** to start over). A comment with a picture needs no text.
- **The buttons** follow Settings > Sending > **Send comments**. Right away (the default): **Send** (`Cmd+Enter`, the key shows on the button) sends the comment to Claude now, and **Save as draft** (`Cmd+Shift+Enter`) keeps it in your review for later. When I click Send: **Add to review** (`Cmd+Enter`) and **Send now** (`Cmd+Shift+Enter`, this comment alone). A draft you are editing has **Save draft** only. See [Sending](#sending).
- **Cancel** (`Esc`) closes it; the toast has **Undo**.
- The buttons show their keys when you hover them. On Windows and Linux, use `Ctrl` instead of `Cmd`.

What you type is kept in this browser while you write, so a reload offers it back. Drafts are saved on the server.

## Suggesting exact text

Press `s` on a selection (or **Suggest** in its toolbar) to propose replacement text.

- **Text mode** (when the selection is plain text): an input prefilled with the selection. Type the replacement.
- **Source mode** (when the selection spans markup): a monospace editor prefilled with the full source lines. Edit them directly.
- A live word diff shows your change, and **Preview rendered** shows how it will look.

The agent applies suggestions verbatim with `suiko apply`. You can also apply one yourself with **Apply now** on its card when the file on disk has no unrecorded changes; that records a new version authored by you.

## Sending

**Send comments** in [Settings](#settings) > Sending decides when what you write reaches Claude.

- **Right away** (the default): each comment and reply goes to Claude when you press **Send** (`Cmd+Enter`). When Claude is listening, it gets it at once; while it is working or editing, it gets it at its next `suiko wait`, together with anything else you sent meanwhile (both say "Sent to Claude."). When Claude isn't connected, it gets it when it next asks ("Saved for Claude. It gets it when it connects."). **Save as draft** (`Cmd+Shift+Enter`) keeps one for later: drafts are listed under **Your turn** with **Send** and **Edit** on their card, and the top bar's **Send N** sends them together.
- **When I click Send:** comments wait in your review as drafts (**Add to review**, `Cmd+Enter`) until you send them with **Send N** in the top bar. **Send now** (`Cmd+Shift+Enter`) sends one comment on its own; your other drafts stay. Replies work the same way, and the two keys swap everywhere with this setting (the [keyboard shortcuts](#keyboard-shortcuts) list follows it).
- **A plan from Claude Code's plan mode** (the opt-in [plan-mode gate](../README.md#plan-mode-gate)) always works like **When I click Send**, whatever the setting: Claude waits in the gate and cannot answer threads, and the first review you send answers it. Settings > Sending says so while a plan is open.

**Ask before sending** (Settings > Sending, off by default): a send asks first, in the box ("Send this comment to Claude now?", **Send** or **Not yet**). Press the key again to confirm, or `Esc` to go back.

### The Send dialog

**Send N** in the top bar (or `f`, or `Cmd+Shift+Enter` while no comment is open) opens the Send dialog for everything in your review:

- **Summary:** overall feedback (Markdown, optional).
- **What happens next:** **Send feedback** ("Your comments go to Claude; no decision yet."), **Needs changes** ("Claude should revise before you approve.") or **Approve v3** ("This version is good to go."). It starts on Needs changes when something you send is marked Must fix, else on the **When I send drafts, start on** setting; on Approve when there is nothing to send.
- **Going out with it:** your drafts (click one to jump to it) and the locks you added this round.
- Whether Claude gets it now ("Claude is listening and gets it right away."), or, when Claude isn't connected, the prompt to paste into its chat after you send, such as "Run suiko feedback token-service and address it.", with **Copy prompt**.

A comment or reply you are still writing is not part of it, and the dialog says so. Closing the dialog keeps the summary and your choices. With nothing to send, the top bar's button is **Approve** and the dialog is titled Approve (see [Approving and the final version](#approving-and-the-final-version)).

### When a send fails

The comment (or reply) box stays open with the error and the draft it saved, for example "Not sent: … It is kept as draft d2: Send tries again." That draft's card says **Being edited** and keeps only Delete, so the comment can never go out twice. **Cancel** deletes that draft and says so ("Comment discarded, and its draft d2 deleted."), with **Undo**.

### What "since your last review" means

The **Changes** tab, the comparison Changes opens on, and "Open documents in: What changed since my last review" all start at your last review. Sending one item does not move it: **Send** on a comment or a reply, a draft's **Send**, **Use in doc** and **Apply**. What moves it:

- a review sent from the Send dialog, and an approval;
- **Accept all** in the Changes panel (see [Reviewing what changed](#reviewing-what-changed));
- going through everything a version answered while you send right away: once nothing it answered waits for you, Suiko says "You went through everything v2 answered: its changes no longer count as new.", with **Undo**.

## Whose turn it is

The turn pill in the top bar answers one question: whose turn is it? Its dot always shows where Claude is: green while it is listening, indigo and pulsing while it works on your feedback, amber and pulsing while it edits the file, grey while it isn't connected.

| Pill | Means |
|---|---|
| **Your turn** with a count | Something waits for you: answers to check, Claude's questions, threads that lost their place, comments and replies not sent yet. It counts what **Your turn** lists |
| **Apply 2 planned** | Only Claude's planned changes are left: they wait for your Apply (see [Batched edits and planned changes](#batched-edits-and-planned-changes)) |
| **Claude is listening** | Claude runs `suiko wait`: what you send reaches it at once |
| **Claude is working…** | It has your feedback and is working on it |
| **Claude is editing** | It is changing the file; the changes show as a new version once it records them |
| **Claude isn't connected** | Nothing is waiting: your feedback waits until Claude asks for it |
| **Approved v3** | You approved the latest version |
| **Review closed** | The review session was closed |

Click the pill for the details: what the presence means ("Your feedback waits until Claude runs `suiko wait`. Tell it to, or paste the prompt into its chat."), how your last review is doing (**Sent 14:02**, **Claude has it · 14:03**), or which version answered it (**v3 answers your last review**), the final version, and under **Waiting for you** what is behind your count (answers to check, questions for you, threads that lost their place, replies and comments not sent yet). Then the next step: **Show my turn** (the thread panel on Your turn), **Apply 2 planned** with "Claude planned 2 changes. They go into the document when you apply them.", and, while Claude isn't connected, **Copy the prompt for Claude**.

## Threads

### Your turn · Claude · Done · All

The thread panel's filters say whose turn each thread is. **Your turn**, **Claude** and **Done** show how many threads they hold (**All** has no count); until you pick one for a document, the panel shows Your turn when something waits for you, else Claude, else All.

- **Your turn:** what waits for you: comments and replies not sent yet, answers to check, Claude's questions, threads that lost their place. The same count as the turn pill. It starts with **Accept all** (below).
- **Claude:** threads waiting for Claude. Its planned changes come first, under **Planned changes · 2** with **Apply 2** ("Claude answered these and will edit the document when you apply them."), then **Waiting for Claude**. A planned thread that also waits for you (a reply not sent yet, a lost place) is listed in Your turn too, and says **Also waits for you** here.
- **Done:** threads you marked done.
- **All:** every thread and draft.

### Thread cards

A card shows its id (`#t3`), one status chip, **Must fix** for a must-fix thread, **?** for a question and **Nit** for a nit. Under it, what the thread is about: the quoted text (or what it points at: `img "System overview"`, `cell "refresh_token" × "TTL"`, a section) with its section, the source lines in the tooltip; click it to see the place in the document. Then the conversation: who said it (**You**, **Claude**), what Claude did ("changed it", "answered", "didn't change it", "will change it"), on which version and when, and Claude's pictures and mockups. A thread whose text changed shows what it **was** and what it is **now**. When Claude asks you something, a banner says "Claude asked you: reply to unblock the revision."

The status chip, in plain words:

| Chip | Means |
|---|---|
| **With Claude** | Sent, waiting for Claude's answer; also after you reply to its answer |
| **Will change** | Claude agreed and will make this change when you apply the planned changes |
| **Claude answered** | Claude answered it without changing the document |
| **Changed in v3 — check it** | Claude changed the document for this thread: check the change |
| **Claude didn't change it** | Claude left it as it is and says why |
| **Needs your answer** | Claude asked you a question |
| **Done** | You marked it done |
| **Lost its place** | The text it was on changed or was removed in this version |

Each card has at most two buttons and a **⋯** menu with the rest:

| Thread | Buttons | **⋯** |
|---|---|---|
| With Claude | **Reply** | Mark as done, Record as decision… |
| With Claude, after you replied to its answer (without **Reopen**) | **Reply**, **Done** | Reopen…, Show change, Record as decision… |
| Changed in v3 — check it | **Looks good**, **Not yet** | Reply, Show change, Record as decision… |
| Claude answered / Claude didn't change it / Needs your answer | **Reply**, **Done** | Reopen… (not when Claude asked you), Show change, Record as decision… |
| Will change | **Reply** | Apply this now, Mark as done, Record as decision… |
| Lost its place | **Move here**, **Keep as general** | View on v1, Reply, Mark as done |
| Done | | Reopen |

- **Looks good** and **Done** mark the thread done (`x`). On a thread Claude didn't change, Done means you agree to leave it as it is (`y`); on Claude's question, that no answer is needed.
- **Not yet** and **Reopen…** open the reply box with **Reopen** ticked: say what still needs to change (`o`).
- **Reply** (`r`) answers on the thread: a question about the answer, say, that Claude answers on the same thread (the chip says **With Claude** until it does). Ticking **Reopen** in the reply box hands the thread back to Claude as work still to do.
- **Show change** (when the document changed at the thread's place) shows that change as a word diff, or the before and after of an image, with **View in Changes**.
- **Move here** anchors the thread to what is selected in the document now (select the new text first, or pick an element); **Keep as general** makes it a comment about the whole document; **View on v1** shows the version it was written on. A thread whose target is inside a closed `<details>` or an inactive tab says **Hidden: Reveal**; **Not on page** means its target is not in the rendered page.

Marking a thread done takes effect at once, with no Send: its mark leaves the document and its card moves to **Done** ("t1 is done."). Only you mark threads done; the agent never closes its own work.

**Accept all**, at the top of Your turn ("3 changed or answered", **Accept all 3**, or `Shift+X`), marks done every thread Claude changed or answered, at once. Threads Claude didn't change stay for you to decide one by one ("1 thread Claude didn't change: decide on it below."). The toast has **Undo**.

### Replies

The reply box follows **Send comments** like the composer: **Send** (`Cmd+Enter`) and **Save as draft** (`Cmd+Shift+Enter`) when sending right away; **Add to review** and **Send now** with **When I click Send**. Replies not sent yet show on the card above the box as **Reply (draft)** or **Reopen (draft)**, with **Send** (when sending right away), **Edit** and **Delete**; the one the box is editing says **Being edited below**.

### Drafts

A comment not sent yet is a **Draft** card under Your turn: **Send** · **Edit** · **⋯** (Delete) when sending right away, **Edit** · **⋯** (Send now, Delete) with **When I click Send**. While the composer holds it, it says **Being edited** and keeps only Delete. A draft written on another version says so (**On v1**): it is drawn on that version only, its line numbers are that version's, and it is carried forward to the latest version when you send it.

## Pictures and mockups from Claude

Claude can answer on a thread with a picture (PNG, JPEG, GIF, WebP or SVG) or a small self-contained HTML file: a chart, a mockup, a table. Ask for one ("Can you show the token lifetimes as a chart?"), iterate on it there, and put it into the document when it is right.

- **Pictures** show as thumbnails. Click one to open it in the image viewer, fitted to the window (a small picture is scaled up, at most twice its size).
- **HTML attachments** run as a live preview on the card: their scripts run (charts draw), in a sandbox that keeps them away from the document, Suiko and your files. **Open large** shows the same preview big; **Close** (`Esc`) closes it.
- The viewer and Open large have **From t7 · Reply · Use in doc** at the bottom. **Reply** opens the thread's reply box with "About chart.html: " to ask for another take, which Claude answers on the thread.
- **Use in doc** (on every attachment) asks Claude to put that file into the document, at the thread's place. When you send right away it goes at once ("Asked Claude to put chart.html in the document."); with **When I click Send**, it joins the thread's reply in your review. The thread then shows "You asked Claude to put chart.html in the document".

## Batched edits and planned changes

Every edit to a long document costs Claude context: it reads the part again, changes it, and records a version that Suiko checks. Comments sent one at a time on a long document would make it do that again and again. **Doc edits** ([Settings](#settings) > Claude & context) decides when Claude edits:

- **Auto** (the default): batched on long documents (over 20,000 characters of text), right away otherwise. Settings says what that means for the open document, for example "This document is long (34,120 characters), so edits are batched."
- **Right away:** Claude edits the document for each comment you send.
- **Batched:** always plan first; you apply the planned changes together.

Batched, Claude still answers every comment right away: a question gets its answer, and a change it agrees to make becomes **Will change**, with exactly what it will change. Nothing in the document changes yet. (A review with only a summary, and no comments, is never batched: there is nothing to plan, so Claude acts on it right away.) When you are ready, **Apply** them: Claude makes every planned change in one pass and records one version, and those threads come back to you to check. Apply is in four places, and all of them apply the same planned changes:

- **Apply 2** under **Planned changes** in the Claude filter (or **Apply this now** in a planned card's **⋯**, for that one);
- the turn pill: **Apply 2 planned** when nothing else is left for you (its popover has it also while it is your turn);
- the Approve dialog: "2 planned changes aren't in v3 yet" with **Apply 2**;
- the palette: **Apply planned changes**.

The thread then says "You asked Claude to make this change", and the toast "Sent 2 planned changes to Claude." (or "Saved 2 planned changes for Claude. It gets them when it connects.").

## New versions

**When Claude records a new version** ([Settings](#settings) > Reading) decides what the view does:

- **Show the new version** (the default): while you read the previous version in Read or Review, it switches to the new one where you are reading, at the same place, without change highlights, and says "Updated to v4" with **Show changes**. Otherwise (in Changes, Source or History, on an older version, or in the middle of something) it only says "v4 is ready", with **Show**.
- **Just tell me:** the view stays where it is. A note says what arrived, such as "Claude recorded v4 · 1 changed, 1 needs your answer", with **Show changes** and **Show my turn** when something in it waits for you, else **Show** and **Show changes**; and a banner says "You are viewing v3 (latest is v4)" with **Go to v4**.
- **Show what changed:** it switches to the new version's Changes ("Claude recorded v4 · 2 changed. Showing what changed.").

It never moves the view while you are writing a comment or a reply, have text selected, or have a dialog or menu open: then you only get the note. The browser tab's title shows `(v4)` until you look.

## Reviewing what changed

**Changes** (the tab, or `2`) compares your last review with the version shown: the top bar shows the range, `[v1 · last review] → [v3 · latest]`. Pick any older version on the left and any version on the right to compare those two; `d` switches the older end between your last review and the previous version. **Compare versions…** in the palette and **Compare with…** in History do the same.

### Inline

The changes drawn over the newer version:

- a green bar beside added blocks and an amber bar beside changed ones; the change you stepped to is framed;
- inserted words are tinted green;
- a "⊖ N lines removed" tab marks each deletion, and a "⊖ was" tab a changed block that lost text: click it to see the removed text;
- each change carries badges with the threads it answers (`t1`), or a quiet **note** whose tooltip gives Claude's reason for a change no thread asked for ("Also changed: …");
- a changed image gets an outline (its before and after are in the Changes panel).

### Side by side

**Side by side** (in the Changes panel, or **Compare side by side** in the palette) puts the older version beside the newer one and gives them the whole window: the outline and the thread panel step aside until you are done (you can reopen them). A bar over both says **Comparing**, steps through the changes (**‹ 3 of 12 ›**, or `n` / `p`), switches back to **Inline**, and **Done** goes back to the mode you came from (the changes inline, when that was Changes).

- Each side's header names its version, with a picker and what it is ("your last review", "previous version"; "latest", "working copy, not recorded").
- On the older side, removed and replaced words are struck through in red, with a red bar beside each block that lost text, and a green "⊕ N lines added" note in the margin marks where the newer version added lines. On the newer side, added words are green, and "⊖ N lines removed" marks a deletion.
- The two scroll together, whichever one you scroll, even where a section changed length. Stepping puts the change at the same height on both sides and frames it on both; bands over the seam join each change's two places. A change with nothing to draw (a script or a style) says "not on the page".
- The older side is read-only: comment on the newer one.

Side by side needs a window at least 900 px wide; your choice of Inline or Side by side is remembered in this browser.

### The Changes panel

In Changes the side panel lists what changed:

- the comparison ("v1 → v3", "since your last review"), +/− lines, the number of changes and how many you ticked as seen ("2/5 reviewed"), Claude's summary of the version, and badges when the version broke a lock, was forced through a refusal, or rewrote much of the document;
- **Prev** / **Next** (`p` / `n`), and **Inline** / **Side by side**;
- the changes, grouped by section, each with a "seen" checkbox (**Mark all changes seen** in the palette ticks them all), what it did (**+ added**, **− removed**, **~ changed**) as a word diff, its threads and Claude's "Also changed: …". For an HTML document a change shows the text a reader reads, with **Source** for the markup itself; "Only the markup changed" when the text did not, and "In the page's code or data, not its text:" for a chart's data or a script. Click a change to see it in the document;
- **Changed assets**: an image as a before / after pair, any other file (an HTML chart beside the document, a stylesheet) with **Open** links to both versions;
- **Results**: what Claude answered in this range, with **Looks good** (or **Done**) and **Not yet**, **Reply** to its questions, and **Accept all**.

### Accept all

**Accept all** at the top of the Changes panel (on the latest version, while its changes are new to you; **Accept all revisions** in the palette) is for when you are happy with what Claude did:

- the version's changes stop counting as new: the Changes tab loses its count, and the next version is compared with this one (`v3 · accepted` in the range);
- every thread Claude changed or answered is done; threads it didn't change stay for you to decide;
- you go back to the document without change marks, with the changes ticked as seen.

It takes effect at once and sends nothing to Claude; the toast has **Undo**.

### Source

**Source** (**⋯ More**, or `3`) shows the same comparison as a source diff (**Diff against v1**, **Unified** or **Split**), with change ids and thread chips. Click a line number (shift-click for a range) and press `c` to comment on raw lines.

## Locks: marking parts agreed

Select text and press `a` (or **Agreed** in its toolbar, or **Mark agreed** in the **⋯** menu of a heading in the outline). Suiko asks first ("Mark this part as agreed? Revisions that change it will be refused unless Claude breaks the lock with a reason.", with an optional note), then creates a lock (`L1`) at once; it does not wait for a Send. Locked text has a teal bracket in the margin and `L` in the outline; clicking the bracket says what it is, with **Unlock**.

- Claude sees every lock as `LOCKED (agreed - do not modify)` in its feedback.
- `suiko revise` **refuses** any version that changes locked text. Claude can only override that with an explicit reason (`--break-lock`), which shows a red "lock broken" badge on the version and switches the lock off: its bracket and the `L` in the outline go away. To protect that text again, mark it agreed again (`a` on a selection, or **Mark agreed** in the **⋯** menu of its heading), which creates a new lock.
- **Unlock** removes a lock when you want Claude to change that part again.

## Decisions

When you mark a thread done you can record a one-line decision, such as "30 s reuse-detection grace window": **Record as decision…** in its **⋯** menu, then **Record and mark done**. Decisions are listed in every packet as `DECISIONS to keep true`, and the agent gets a warning if it changes their text. When the doc is final, `suiko final <doc> --decisions` writes a decision log next to the document.

## History and versions

**History** (**⋯ More**, or `4`) lists versions and reviews, newest first, in plain words.

- A version: its number, **latest** and **Final**, who recorded it and when, the review it answers ("answers your review of 14:02"), its summary, +/− lines, its threads (click one to see it on that version) and guard badges. **View** shows it in Review; **What changed** compares it with the version before; **Compare with…** with any other.
- A review: what you did, as a sentence ("You sent 2 comments", "You applied 2 planned changes", "You approved v3"), what kind of review it was (**Feedback**, **Needs changes**, **Approved v3**), the version it was on, and whether Claude has it ("Claude has it · 14:03") or it waits for Claude to connect ("Waiting for Claude"). Comments you sent one at a time merge into one row ("3 comments sent") with **Show each**.

The version picker in the top bar, **Switch to version…** in the palette and `[` / `]` (outside pick mode) move between versions. Every version is an immutable copy under `.specreview/`, so nothing Claude does can lose an earlier state.

## Approving and the final version

With nothing left to send, the top bar's main button is **Approve** (in the accent colour when approving is the obvious next step: Claude answered your last review and nothing waits for either of you). It opens the dialog titled Approve, on **Approve v3**:

- **Mark v3 final** starts ticked when approving is the obvious next step (as above). Otherwise, for example when you approve a version you never sent comments on, it starts unticked: tick it to make v3 the final version.
- **Mark 2 answered threads done** (ticked) marks done the threads Claude changed or answered.
- When something would be left pending, amber rows say what, each with its way out: "2 planned changes aren't in v3 yet" (**Apply 2**), "3 threads still wait for you" (**Show**), "1 thread is still with Claude". An open Must fix thread is a red row ("1 Must fix thread is still open (t1)."). While any of these rows shows, `Enter` never approves: only the **Approve v3** button does.
- When a newer version exists than the one you are looking at, the dialog sends you to review it first (**Review v4**).

After you approve with **Mark v3 final** ticked, the turn pill says **Approved v3**, the version is `v3 · latest · final`, and a banner says "Approved at v3." with **View final** and **History** (and "Newer unapproved changes exist." if Claude records another version). Approved without it, the approval is recorded (History says "You approved v3") but no version is final. The agent then runs `suiko final <doc> --decisions`, which checks the file on disk matches the final version and writes the decision log.

## Keyboard shortcuts

Press `Cmd+/` (or `?`) in the UI for this list, or **Keyboard shortcuts** in **⋯ More**. Buttons show their key when you hover them. On Windows and Linux, use `Ctrl` where this says `Cmd`. The two comment keys swap with **Send comments**: the first key is for Right away (the default), the one in brackets for When I click Send. On a plan from plan mode they always work as with When I click Send.

| | Key | Action |
|---|---|---|
| **Comment** | `c` `s` `q` `a` | Comment, suggest, question, or mark agreed on the selected text |
| | `b` | Snip an area of the document: drag a box over text, images or diagrams, then comment (Esc cancels) |
| | `Shift+B` | Snip anywhere on your screen (macOS picker), then comment on the screenshot |
| | `e` | Pick an image, diagram, table or code block ([ ] parent / child, Shift-drag a region, Esc exits) |
| | `Cmd+Shift+Enter` (`Cmd+Enter`) | Save the comment as a draft / Add to review (in the composer) |
| | `Cmd+Enter` (`Cmd+Shift+Enter`) | Send the comment now, on its own (in the composer) |
| | `Cmd+B` `Cmd+Shift+8` `Cmd+Shift+7` | Bold / bulleted list / numbered list (while writing) |
| **Review** | `f` `Cmd+Shift+Enter` | Send dialog: your drafts and a verdict, or Approve (the second key while no comment is open) |
| | `r` | Reply to the focused thread |
| | `x` | Mark the focused thread done (Looks good / Done) |
| | `o` | Reopen the focused thread |
| | `y` | Agree when Claude didn't change it |
| | `Shift+X` | Accept all: every thread Claude changed or answered (Undo in the toast) |
| | `v` | Show your turn (what waits for you) |
| **Navigate** | `j` `k` | Next / previous thread |
| | `n` `p` | Next / previous change |
| | `0` `1` `2` `3` `4` | Read / Review / Changes / Source / History |
| | `[` `]` | Previous / next version |
| | `d` | Toggle the base: your last review / previous version |
| **View** | `h` | Hide all annotations (clean read) |
| | `\` | Toggle the thread panel |
| | `t` | Cycle theme (system, light, dark) |
| **App** | `Cmd+K` | Command palette: run anything by name |
| | `Cmd+,` | Settings |
| | `Cmd+/` `?` | Keyboard shortcuts (this list) |
| | `Esc` | Close or cancel |

In the composer, `1` sets Must fix, `2` normal and `3` nit (with the focus outside its text box). Paste an image into a comment to attach it. The reply box uses the same two keys as the composer.

`Cmd+K`, `Cmd+,` and `Cmd+/` work everywhere: in the Suiko UI, in the document, and while you type a comment or reply (your text is kept). On a Mac, `Ctrl+K`, `Ctrl+,` and `Ctrl+/` do the same, because Safari and the Claude desktop app may keep `Cmd+,` or `Cmd+K` for themselves.

Keys typed in the document are passed on to Suiko, as long as you are not typing in one of its fields and it has no keyboard shortcuts of its own (see [Commenting on anything](#commenting-on-anything)). Keys that change state act only when focus is in the Suiko UI: `x`, `o`, `y` and `Shift+X` do nothing while focus is inside the document, the keys that send or save a comment never send or save from there (click the thread panel first), and `a` on a document selection asks you to confirm before it locks anything. This keeps scripts in a reviewed document from acting on your behalf. A held key acts once; with focus in the Suiko UI, `j`, `k`, `n` and `p` keep stepping while held.

## Command palette

Press `Cmd+K` (or click the search icon in the top bar) to search everything Suiko can do by name, so you do not need to remember a key. Type a few letters (for example "turn", "apply" or "compare") and press `Enter` to run the highlighted command; `Up` / `Down` (or `Ctrl+N` / `Ctrl+P`) move through the list. `Esc` or `Cmd+K` closes it. With nothing typed, it starts with the commands you ran last.

A command that cannot run right now is dimmed and says why (for example "select text in the doc first"). Commands with an arrow (›) at the end of their row, such as **Go to thread…** or **Compare versions…**, open a short list of their own: type to narrow it, and press `Backspace` in the empty field to go back. **Send feedback…** and the other Send and Approve commands open the Send dialog instead. A thread id such as `t4`, a version such as `v2` or the words of a heading also work straight from the top-level search.

The palette lists every action that has a key, plus these, which have none:

| Command | Does |
|---|---|
| **Go to thread… / Go to section… / Switch to version…** | Jump to a thread or draft by id or words, a heading, or any recorded version (or the live working copy) |
| **Compare versions…** | Changes for any two versions: pick the older one, then the newer one |
| **Compare side by side / Compare inline** | Changes with the older version beside the newer one, or drawn over the newer one |
| **Show changes / Hide changes** | Changes, or back to the document without change marks |
| **Show threads with Claude / Show done threads / Show all threads** | The thread panel's filters (Your turn is `v`) |
| **Send feedback… / Send as Needs changes… / Approve this version…** | Open the Send dialog with that choice made; nothing is sent until you send there |
| **General comment** | A comment about the whole document |
| **Apply planned changes** | Claude makes its planned changes in one pass and records one version |
| **Accept all revisions** | Accept the latest version: its changes stop showing as new, and the threads Claude changed or answered are done |
| **Mark all changes seen** | Tick every change of the comparison shown in the Changes list |
| **Record the working copy as my revision** | Opens the record form when the file on disk has unrecorded changes (otherwise it is dimmed: "no unrecorded changes") |
| **Copy the review link** | The UI's URL. It contains your access token and works only on this machine |
| **Copy the prompt for Claude** | What to paste into Claude's chat after sending, when it isn't connected |
| **Copy the spec path** | The document's path on disk |
| **Document info** | The same as **⋯ More** > Document info |
| **Toggle the outline rail** | Show or hide the outline beside the document |
| **Reload the document** | Render the version shown again |
| **Open the document list / Open another document…** | The list of tracked docs, or switch straight to another one |
| **Close the review session…** | Asks first, then ends the session like `suiko close`; a waiting agent stops waiting |
| **Theme: System / Light / Dark** | Pick a theme directly |
| **Toggle single-letter shortcuts** | Turn them on or off (see [Settings](#settings)) |

## Settings

Press `Cmd+,`, or choose **Settings** in **⋯ More** (a gear on the doc list). Settings apply at once to every doc and are remembered in this browser. They are in five sections:

| Section | Setting | Choices (default first) | What it does |
|---|---|---|---|
| **General** | **Theme** | System, Light, Dark | Same as `t`. Markdown documents follow it; raw HTML documents keep their own styling |
| | **Single-letter shortcuts** | On, Off | Off: every one-key shortcut (`c`, `j`, `b`, `1`, `?` …) does nothing, in the UI and in the document. Turn this off if the document has its own keyboard controls, you use speech input, or you press keys by accident. `Esc`, the `Cmd` shortcuts, the buttons and the command palette keep working |
| **Reading** | **Open documents in** | Latest version, Reading view, What changed since my last review | Latest version: the newest version with your threads, no change highlights (the Changes tab says how much is new). Reading view: nothing drawn over it. What changed since my last review: its changes, when Claude revised it since you last looked |
| | **When Claude records a new version** | Show the new version, Just tell me, Show what changed | See [New versions](#new-versions). Never while you are writing a comment or a reply, have text selected, or a dialog or menu is open: then you only get a note |
| | **Outline rail** | Auto, Always, Never | Auto: beside the document when the window is very wide (1600 px and up; a code review's file tree from 1200 px), behind the **≡** button otherwise. Always: beside the document when there is room. Never: always behind the button |
| | **Thread panel open by default** | On, Off | Whether the thread panel shows when you open a document that has threads or drafts. `\` still shows or hides it at any time |
| **Sending** | **Send comments** | Right away, When I click Send | Right away: each comment and reply goes to Claude when you press Send; Save as draft keeps one for later. When I click Send: comments wait in your review as drafts; Send in the top bar sends them together. See [Sending](#sending) |
| | **Ask before sending** | Off, On | On: Send (or its key) in a comment or a reply asks you to confirm first |
| | **When I send drafts, start on** | Send feedback, Needs changes | What the Send dialog starts on when nothing is marked Must fix (a Must fix comment always starts it on Needs changes) |
| **Claude & context** | **Doc edits** | Auto, Right away, Batched | See [Batched edits and planned changes](#batched-edits-and-planned-changes). The section says what Auto means for the open document |
| **About** | | | The Suiko version, the workspace and the document's path, the ports in use, and the prompt for Claude with **Copy the prompt for Claude** |

## Theme, accessibility and clean reading

- `t` cycles the System, Light and Dark themes (or pick one in [Settings](#settings)). Markdown documents follow the theme (including mermaid diagrams); raw HTML documents keep their own styling.
- **Read** mode (`0`) shows the latest version with nothing drawn over it and no thread panel; choose **Reading view** under **Open documents in** in [Settings](#settings) to open every document that way. `h` (**Hide marks**) hides every highlight, pin and change mark in the other modes; press it again to bring them back.
- All controls are labelled buttons with visible focus rings. The thread and change lists are the keyboard-accessible counterparts of the marks. States are shown with words and icons, not colour alone. Reduced-motion settings are respected.
- If one-key shortcuts get in your way (speech input, or a document with its own keyboard controls), turn off **Single-letter shortcuts** in [Settings](#settings); every action stays available from the buttons and the [command palette](#command-palette).

## When something looks wrong

| Symptom | What it means | What to do |
|---|---|---|
| A **⚠** chip in the top bar: "script errors in the page" | The document's own scripts threw errors (the popover shows the last one) | Check whether they affect what you are reviewing; mention them in a comment if so. **Reload the document** renders it again |
| A **⚠** chip: "resources did not load" | The document loads files (scripts, fonts, images) that did not load, for example from the internet while you are offline | Check your connection, then reload the document (**Reload the document** in the palette). Everything else in the review keeps working |
| A **⚠** chip: "The file is missing on disk" | The document was moved or deleted | Recorded versions are still available; move it back, or ask the agent to |
| Nothing is drawn over an HTML document, and the tools say "The document is still loading." | The document's own Content-Security-Policy `<meta>` tag may keep Suiko's script out of it | Review in **Source** (**⋯ More**), or comment with a screen snip (`Shift+B`) or a general comment (**+** in the thread panel) |
| Single-letter keys do nothing in the document | It has keyboard shortcuts of its own, and keeps its keys (Suiko says so once) | Use the tool dock, select text and press `c`, click the thread panel and press the key there, or the [command palette](#command-palette) |
| A thread says **Lost its place** | Its text was changed or removed | Read what it **was** and is **now** on the card; select the new text and click **Move here**, **Keep as general**, or reply or mark it done |
| The turn pill says **Claude isn't connected** after you send | The agent's `suiko wait` is not running | Click the pill and **Copy the prompt for Claude**, then paste it into the agent's chat, or tell it "done" |
| "Not sent: …" in a comment or reply box | The send failed; the comment is kept as a draft | **Send** tries again; **Cancel** deletes that draft (see [When a send fails](#when-a-send-fails)) |
| "Reconnecting to Suiko..." | The local server restarted or is starting | Wait a few seconds; run `suiko doctor` if it persists |
| A screen snip shows only the wallpaper or empty windows | macOS has not allowed the capturing app to record the screen | Allow it under [Screen Recording permission](#screen-recording-permission), quit and reopen the app, then `suiko stop` and reopen the doc |
| A screen snip or `suiko snip` reports that screen snips are unsupported | Screen snips use macOS's `screencapture`, which this machine does not have | Snip inside the doc with the dock's scissors (`b`), paste an image into the composer, or `suiko snip --file <png>` |
| An area snip has no thumbnail | The browser could not draw that area (an image from another site, a video, a cross-origin frame) | The comment still carries the source lines. Snip the screen (`Shift+B`) to attach a real screenshot |
| The Shortcuts hotkey does nothing | Scripts are not allowed, or the command cannot find Node | Turn on **Allow Running Scripts** in Shortcuts settings, use the full form with absolute paths, and run the shortcut from its window to see the error |
