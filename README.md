# SpecReview

**Review AI-written specs the way you review pull requests.** Comment on any part of an HTML or Markdown spec in a local web UI, send precise, located feedback to your coding agent, get targeted edits instead of a regenerated document, and see exactly what changed, round after round, until you approve a final version.

SpecReview runs entirely on your machine, keeps every version and thread as plain files you can commit to git, and works with Claude Code (plugin, skill, slash command and hooks), any MCP client, and any CLI agent.

Everything is one key away: select text and press `c` to comment, press `b` to snip any area of the doc, `B` to snip anything on your screen, and `Cmd+Shift+Enter` to send a comment to the agent right now. See [Keyboard shortcuts](#keyboard-shortcuts) and [Snipping](#snipping).

![Review mode: the rendered spec with highlighted threads, pins and the thread panel](docs/img/review-mode.png)

![Changes mode after a revision: change bars, inserted words, "⊖ was" tabs, thread badges and the change list](docs/img/changes-mode.png)

![The Verify queue: an "Addressed in v2" suggestion card with its mini-diff](docs/img/verify.png)

- [Why](#why)
- [How it works](#how-it-works)
- [Install](#install)
- [Quick start](#quick-start)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Snipping](#snipping)
- [The review loop, step by step](#the-review-loop-step-by-step)
- [Command reference](#command-reference)
- [Storage layout and git](#storage-layout-and-git)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development](#development)
- [Documentation](#documentation)

## Why

Coding agents are good at writing specs and bad at revising them. Feedback in chat is vague ("the part about tokens"), the agent regenerates the whole document, things you already agreed on quietly disappear, and you cannot see what changed.

| The problem | What SpecReview does |
|---|---|
| "I can't comment on specific parts" | Anchored threads on a phrase, a paragraph, a region of an image, a mermaid node, an SVG element, a table cell, code, a formula, a section, raw source lines, or the whole doc |
| "The agent regenerates the entire spec" | Every comment reaches the agent with the exact source lines to edit. Suggestions are applied verbatim. A Write hook and a rewrite guard block whole-file rewrites |
| "Things we agreed on get lost" | Mark text **agreed** and SpecReview refuses any revision that changes it. Unexplained deletions are refused too. Every version is immutable |
| "It's not iterative" | Review rounds with verdicts, threaded replies, questions back to you, reopen and accept |
| "I want to see what changed" | Changes drawn over the live document since your last review, per-thread mini-diffs, a source diff, and any-to-any version comparison |
| "Which version is final?" | Approve marks a final version and exports a decision log |
| "My HTML spec has scripts, SVG and charts" | The document renders as authored, scripts included, on an isolated origin |

## How it works

```text
  agent (Claude Code, Codex, MCP client, ...)               you, in the browser
  ───────────────────────────────────────────               ───────────────────
  writes docs/specs/x.md once
  specreview open docs/specs/x.md  ───── records v1 ──────>  UI opens beside the chat
  specreview wait x  (background, costs nothing)            select, comment, suggest, mark agreed
                     <──── packet: one item per thread ────  Submit review (Request changes)
  targeted edits (Edit tool, specreview apply)
  specreview revise x --replies -  ── records v2, links ──>  "v2 ready": changes since your review,
                                      hunks to threads,      the agent's replies, Verify queue
                                      enforces guards        accept / reopen ... Approve -> FINAL v3
  specreview final x --decisions
```

- The **CLI** is the core. It reads and writes `.specreview/` in your workspace under a per-doc lock; it never needs the server.
- A small **local server** (started automatically) serves the review UI on `127.0.0.1:4777` and the documents on a separate origin, `127.0.0.1:4778`, so a document's scripts can never reach the UI or its API.
- The **agent integration** is plain text: compact packets on stdout, JSON with `--json`, and exit codes. The same operations are available as MCP tools.

## Install

Requirements: Node.js 20.19 or later, and a current Chromium-based browser, Safari or Firefox. Claude Code is optional. Screen snips (`B`, `specreview snip`) need macOS; everything else, including area snips (`b`), works in any of those browsers.

### 1. The CLI

```bash
cd /path/to/specreview
npm install
npm link             # puts `specreview` on your PATH
specreview doctor    # checks ports, the store and versions
```

### 2a. Claude Code plugin (recommended)

In a Claude Code session:

```text
/plugin marketplace add /path/to/specreview
/plugin install specreview@specreview
/reload-plugins
```

Or from a shell: `claude plugin marketplace add /path/to/specreview` then `claude plugin install specreview@specreview`.

The plugin adds:

- the **`spec-review` skill**: the review protocol Claude follows when it writes a spec for you, receives a feedback packet, or you mention a thread;
- the **`/review-spec <path>`** command (also `/specreview:review-spec`): opens an existing file for review, shows the UI in the browser pane, and waits in the background;
- two **hooks**: `specreview hook pre-write` (PreToolUse on `Write`) denies a Write that would rewrite most of a spec under review, and `specreview hook prompt` (UserPromptSubmit) reminds Claude of a submitted review that no background wait picked up.

The plugin's hooks run `specreview` from your `PATH`. That works when Claude Code starts from a terminal. If you use nvm, asdf or Volta and start Claude Code from the Dock or the desktop app, it may not see your shell's `PATH`, so the hooks fail with `command not found` (non-blocking, but they do nothing). Use 2b instead.

### 2b. Claude Code without the plugin system

```bash
specreview install claude --user                        # prints exactly what it would write
specreview install claude --user --with-hooks --apply   # writes it
```

This installs the skill (and with `--with-hooks`, the hooks) into `~/.claude` (`--user`) or the project's `.claude/` (`--project`). The hook commands use absolute paths, `"<path to node>" "<path to specreview>/bin/specreview.js" hook …`, so they work whatever `PATH` Claude Code starts with. That makes this the right choice for nvm users. Use either the plugin or `install claude`, not both, or the hooks run twice. Without `--apply`, nothing is written.

### 2c. MCP (Claude Code, Claude Desktop, Cursor, and other MCP clients)

```bash
claude mcp add specreview -- specreview mcp
```

Other clients: register a stdio server with command `specreview` and args `["mcp"]` (with nvm, use the absolute path to `node` as the command and `["/path/to/specreview/bin/specreview.js", "mcp"]` as args). `specreview install claude --with-mcp` prints the `claude mcp add` line. In Claude Code the background CLI `wait` is preferred over MCP; MCP is for agents without a shell.

### 2d. Codex, Gemini CLI and other CLI agents

```bash
specreview install agents-md --apply    # appends the protocol to AGENTS.md
```

See [`integrations/agents-md/README.md`](integrations/agents-md/README.md) for Gemini CLI (`GEMINI.md`) and the two waiting modes for agents that cannot run background tasks.

## Quick start

With the Claude Code plugin installed, ask Claude:

> Write an implementation spec for the token service. I want to review it.

Claude writes `docs/specs/token-service.md`, runs `specreview open`, opens the review UI in the browser pane next to the chat, starts a background `specreview wait`, and stops. Comment on anything, click **Submit review**, and Claude picks it up automatically.

For a spec that already exists: `/review-spec docs/specs/token-service.md`.

Without an agent integration:

```bash
specreview open docs/specs/token-service.md     # prints the review UI URL
specreview feedback token-service               # after you submit: prints the feedback packet
```

## Keyboard shortcuts

Press `?` in the UI to see this list. On Windows and Linux, use `Ctrl` where it says `Cmd`.

| | Key | Does |
|---|---|---|
| **Comment** | `c` / `s` / `q` | Comment on, suggest replacement text for, or ask a question about the selected text |
| | `a` | Mark the selection agreed (locks it) |
| | `b` | **Snip an area of the doc**: drag a box over anything (text, images, diagrams, a mix) |
| | `B` (Shift+B) | **Snip anywhere on your screen** with the macOS picker |
| | `e` | Pick an image, diagram node, table cell or code block (shift-drag marks a region of an image) |
| | `Cmd+Enter` | In the comment box: **Add to review** (a draft, sent when you submit) |
| | `Cmd+Shift+Enter` | In the comment box: **Send now** (this comment goes to the agent immediately) |
| | `Esc` | Cancel the comment, the snip or pick mode |
| **Review** | `f` or `Cmd+Shift+Enter` | Submit the whole review (outside the comment box) |
| | `v` | Verify queue: the threads the agent addressed, answered or declined |
| | `x` / `o` | Accept / reopen the focused thread |
| | `y` | Accept a decline |
| | `r` | Reply to the focused thread |
| **Navigate** | `j` / `k` | Next / previous thread |
| | `n` / `p` | Next / previous change |
| | `[` / `]` | Previous / next version (in pick mode: parent / child element) |
| | `1` `2` `3` `4` | Review / Changes / Source / History mode |
| | `d` | Compare with your last review, or with the previous version |
| **View** | `h` | Hide all highlights for a clean read |
| | `\` | Show or hide the thread panel |
| | `t` | Cycle the theme |
| | `?` | Help overlay |

Most keys work while focus is in the document too. Keys that change a thread's state (`x`, `o`, `y`) act only when focus is in the SpecReview UI, so scripts in a reviewed document cannot trigger them. The [reviewer guide](docs/user-guide.md#keyboard-shortcuts) has the details.

## Snipping

A snip is a comment with a picture. The agent receives the image's file path and reads it (Claude Code uses its Read tool), so it sees exactly what you see.

| To comment on | Do | The agent gets |
|---|---|---|
| Any area of the doc | Press `b` (or the scissors button in the top bar) and drag a box | The picture, the source lines of every block under the box, and a label such as `snip (figure + 2 paragraphs)` |
| Anything on your screen: the running app, a terminal, another document (macOS) | Press `B`, then drag with the macOS picker, as with `Cmd+Shift+4` | The picture, as a general comment, or on the text you had selected |
| Anything, from a terminal or a global hotkey (macOS) | `specreview snip` | The picture as a draft comment in your review, or sent at once with `--send` |
| A region of one image, SVG or canvas | Press `e`, then shift-drag on the image | The crop, the element's source and the region as percentages |

**Area snips (`b`).** The cursor becomes a crosshair. Drag a box over any part of the rendered doc; when you let go, the comment box opens with a thumbnail of the area. Type your comment, then `Cmd+Enter` to add it to your review or `Cmd+Shift+Enter` to send it now. `Esc` cancels. Each `b` takes one snip, then you are back to selecting text. It works whether focus is in the UI or in the document.

**Screen snips (`B`).** SpecReview's local server runs macOS's own region picker (`screencapture -i`). Drag a box, or press Space and click a window; `Esc` cancels. The comment box opens with the screenshot attached. Select some text in the doc first to attach the screenshot to that text; otherwise it becomes a general comment. Large screenshots are scaled down to 2000 px on the longest side. This needs macOS and, on first use, the Screen Recording permission (see below).

**From the terminal: `specreview snip`.** Runs the same picker and adds the screenshot to the doc as a draft comment. An open review UI shows it at once with a toast, "Screenshot added from your Mac", and an **Edit** button to add text.

```bash
specreview snip                                         # picker, then a draft on this workspace's doc
specreview snip token-service -m "The header overlaps the logo"
specreview snip --send -m "This is the login page today"      # submit it to the agent right away
specreview snip --file ~/Desktop/shot.png --question -m "Is this the flow you meant?"
```

`-m` adds the comment text, `--question` makes it a question, `--send` submits it immediately as a one-item review (a waiting agent picks it up at once), `--file <png>` attaches an existing PNG or JPEG (up to 5 MB) instead of opening the picker, and `--json` prints the result as JSON. Without `<doc>`, it uses the only doc tracked in the current directory's workspace (or `--workspace <dir>`); when that workspace tracks several docs, or the current directory has none (a Shortcut starts in your home folder), it picks the most recently active doc and names it on stderr. Pass the doc id or its file path to choose. `Esc` in the picker cancels: nothing is added and the exit code is 0.

### A global snip hotkey with the Shortcuts app (macOS)

Bind `specreview snip` to a key that works in every app, so you can snip a bug in the running app and hand it to Claude without switching windows.

1. **Find the two paths** in a terminal:

   ```bash
   command -v node                        # e.g. /opt/homebrew/bin/node, or ~/.nvm/versions/node/v24.11.0/bin/node
   realpath "$(command -v specreview)"    # e.g. /Users/you/src/specreview/bin/specreview.js
   ```

2. **Allow scripts.** Open the **Shortcuts** app, choose **Shortcuts > Settings > Advanced**, and turn on **Allow Running Scripts**.
3. **New shortcut.** Choose **File > New Shortcut** and name it, for example "Snip to Claude".
4. **Add the action.** In the action list on the right, search for **Run Shell Script** and double-click it.
5. **Paste the command.** Leave **Shell** as `zsh` and replace the sample text with the full form, using the two paths from step 1 and your project folder:

   ```bash
   "/opt/homebrew/bin/node" "/Users/you/src/specreview/bin/specreview.js" snip --workspace "/Users/you/projects/my-app"
   ```

   This form works with nvm, asdf and Volta too. Shortcuts runs scripts with a minimal `PATH` that contains neither `node` nor `specreview`, so the short form needs the `PATH` set first. It works when `npm link` put `specreview` next to a system-wide Node, such as Homebrew's:

   ```bash
   export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
   specreview snip --workspace ~/projects/my-app
   ```

   Add `--send` to skip the draft and send each snip to the agent at once. If the workspace tracks several docs, the snip goes to the most recently active one; name the spec's file path instead of `--workspace` to pin it to one doc.
6. **Add the hotkey.** Click the **Shortcut Details** button (ⓘ) in the right sidebar, click **Add Keyboard Shortcut**, and press the keys you want, for example `Ctrl+Option+Cmd+S`. Choose a combination no app uses.
7. **Test it.** Press the hotkey, or click Run (▶) in the shortcut's window. If Shortcuts asks whether the shortcut may run a script, allow it.

**Screen Recording permission.** macOS asks for it the first time a snip runs. Grant it to **Shortcuts** for the hotkey, and to the app that started SpecReview (your terminal, your editor, or Claude) for `B` and for `specreview snip` in a terminal: **System Settings > Privacy & Security > Screen & System Audio Recording**, turn the app on, then quit and reopen it. For `B`, also run `specreview stop` and open the doc again so the server restarts under that app. A snip that shows only your wallpaper or empty windows means the permission is missing.

## The review loop, step by step

**1. The agent writes the spec once and opens it.**

```text
$ specreview open docs/specs/token-service.md
specreview: tracking docs/specs/token-service.md as "token-service" (markdown, 212 lines) · recorded v1
review UI: http://127.0.0.1:4777/d/3f9a1c2e/token-service?k=Zx81Qm0v7c
next: open the URL (browser pane), then run `specreview wait token-service` in the background
```

**2. You review.** Select a phrase and press `c` to comment, `s` to suggest exact replacement text, or `q` to ask a question. Press `b` and drag a box to snip any area (a figure with its caption, half a table, a whole section), or `B` to snip something outside the doc. Press `e` to pick an image, a mermaid node or a table cell, and shift-drag to mark a region of an image. Use the **⋯** menu of a section in the outline and choose **Mark agreed** to lock it. Then **Submit review** with a verdict: Comment, Request changes or Approve. A single urgent comment can skip the queue with **Send now** (`Cmd+Shift+Enter` in the comment box). See the [reviewer guide](docs/user-guide.md).

**3. The agent gets a packet**, one item per thread, with the exact source lines to edit:

```text
SPECREVIEW FEEDBACK · token-service (docs/specs/token-service.md) · review rv1 on v1 · CHANGES REQUESTED
Line numbers = current file on disk (identical to v1).
4 threads need action (4 new): 1 blocking · 1 question · 1 suggestion · 1 comment

[t1] blocking · comment · L42-43 · §3 Tokens > 3.2 Token refresh
  on: "rotated on every use"
  src> Refresh tokens are rotated on every use, and the previous token is
  src> invalidated immediately.
  Eric: Rotation on every use breaks multi-tab sessions. Use a 30 s reuse-detection grace window.

[t3] suggestion · L120 · §5.1 Retries · apply verbatim: specreview apply token-service t3
  - The client MUST retry 3 times.
  + The client MUST retry up to 5 times with exponential backoff (base 200 ms, full jitter).
...
LOCKED (agreed - do not modify): L1 §7 Rollout plan (L170-196)
```

**4. The agent makes targeted edits** (the `src>` lines are an exact Edit `old_string`; suggestions go through `specreview apply`) **and records the revision** with one reply per thread:

```text
$ specreview revise token-service --replies - <<'JSON'
{"summary": "rv1: grace window, retry policy", "threads": {
  "t1": {"status": "addressed", "reply": "Replaced rotate-every-use with a 30 s grace window."},
  "t3": {"status": "addressed", "reply": "Applied your suggestion."}}}
JSON
specreview: recorded v2 for token-service (+9 -3 lines, 4 hunks) · responds to rv1
  h1 L42-46  §3.2 Token refresh  -> t1 addressed  (overlap)
  h3 L120    §5.1 Retries        -> t3 addressed  (tagged: apply)
guards: ok · lock L1 untouched · no unexplained deletions · rewrite 4%
```

If the edit touched agreed text, deleted content no thread asked about, or rewrote most of the document, `revise` refuses (exit 3), records nothing, and prints the fix.

**5. You verify.** The UI shows "v2 ready". **Review changes** draws everything that changed since your last review over the live document; **Verify** walks through each addressed thread with the agent's reply and a mini-diff. Press `x` to accept (optionally recording a decision) or `o` to reopen. Submit again.

**6. Approve.** Approving with "Mark v3 final" makes v3 the final version. The agent runs `specreview final token-service --decisions`, which checks the file on disk matches v3 and writes `token-service.decisions.md`.

The full agent-side contract (packet grammar, revise JSON, guards, recovery, MCP tools) is in [docs/agent-protocol.md](docs/agent-protocol.md).

## Command reference

`<doc>` is a doc id (`token-service`) or a file path. Line numbers are always lines of the current file on disk.

| Command | What it does |
|---|---|
| `specreview open <file...> [--title T] [--browser pane\|system\|none] [--workspace <dir>] [--json]` | Track a spec, record v1, start the server, print the UI URL |
| `specreview wait [<doc>] [--all] [--timeout 0\|30m] [--allow-dirty] [--json]` | Block until a review is submitted; print the packet |
| `specreview feedback <doc> [--peek] [--include-drafts] [--all-open] [--json]` | Print the packet without blocking |
| `specreview apply <doc> <tid...> [--dry-run]` | Apply suggestions verbatim |
| `specreview edit <doc> --thread t1[,t2] --old <s> --new <s> [--all]` | Exact replace tagged to threads (`--stdin` for a JSON batch) |
| `specreview reply <doc> <tid> -m <md> [--status answered\|declined\|needs_input\|addressed] [--at L42-46] [--decision "text"]` | Reply without recording a version |
| `specreview revise <doc> [-m <summary>] [--replies <file\|->] [--dry-run] [--break-lock L1="why"]... [--allow-rewrite] [--force]` | Record a version with replies; enforce guards |
| `specreview revert <doc> (--hunk hN \| --lock L1)` | Undo one unrecorded hunk, or restore agreed text |
| `specreview reanchor <doc> <tid> (--lines A-B \| --quote TEXT)` | Move a thread's anchor |
| `specreview ask <doc> (--quote TEXT \| --lines A-B) -m <question>` | The agent asks the reviewer a question |
| `specreview threads <doc> [--status open\|addressed\|needs_input\|resolved\|outdated\|all] [--json]` | List threads |
| `specreview show <doc> [<tid>] [--version N] [--lines A-B]` | Show a thread's timeline, or old source |
| `specreview diff <doc> [vA..vB] [--stat\|--unified] [--json]` | Show changes (default: your last review to head) |
| `specreview log <doc> [--json]` | Timeline of versions and reviews |
| `specreview status [<doc>] [--json]` | Docs, threads, undelivered reviews, listeners, working-copy state |
| `specreview final <doc> [--decisions] [--out <dir>]` | Check the final version; export the decision log |
| `specreview close <doc>` | End the review session |
| `specreview snip [<doc>] [-m <text>] [--question] [--send] [--file <png>] [--json]` | Reviewer tool: snip anywhere on screen with the macOS picker (or attach an image with `--file`) as a draft comment, or submit it at once with `--send`. See [Snipping](#snipping) |
| `specreview serve [--foreground] [--port N]` · `specreview stop [--rotate]` · `specreview doctor [--fix]` | Server control and health checks |
| `specreview mcp` | stdio MCP server |
| `specreview hook pre-write` · `specreview hook prompt` | Claude Code hook entry points |
| `specreview install claude [--user\|--project] [--with-hooks] [--with-mcp] [--apply]` · `specreview install agents-md [--apply]` | Install integrations (prints only, unless `--apply`) |

Global: `--as <name>` sets the agent name (default: `$SPECREVIEW_AGENT`, else `claude` inside Claude Code, else `agent`). Environment: `SPECREVIEW_HOME` (runtime state, default `~/.specreview`), `SPECREVIEW_PORT` (UI port; documents use the next port).

Exit codes: `0` ok or delivered · `1` error · `2` wait timed out · `3` refused (guard, dirty working copy, conflict, not unique) · `4` not found · `5` session closed · `6` superseded by a newer `wait`.

## Storage layout and git

Durable review data lives **in your repository**, next to the spec, and is meant to be committed:

```text
<workspace>/
  docs/specs/token-service.md               the live spec (the agent edits this file)
  .specreview/
    config.json                             settings (committed)
    .gitignore                              ignores temporary files (*.tmp-*)
    assets/sha256/44/44ab…e1.png            content-addressed snapshots of images and other local assets
    docs/token-service/
      doc.json                              doc metadata: head, state, final version
      versions/0001.md  0001.json           exact source bytes + manifest, one pair per version
      threads/t1.json …                     one file per thread
      reviews/rv1.json …                    one file per submitted review
      locks/L1.json …                       agreed regions
      attachments/a1.png …                  snips, screenshots, region crops and pasted images
```

Volatile state lives **outside the repository**, in `SPECREVIEW_HOME` (default `~/.specreview`). Never commit it; deleting it is safe (stop the server first):

```text
~/.specreview/
  daemon.json (0600)  workspaces.json  daemon.log
  ws/<wsId>/events/  waiters/  locks/  cache/  drafts/  pending/
```

That includes your unsubmitted drafts, presence heartbeats, the change feed, render caches and staged edits.

- **Workspace root:** the nearest ancestor of the spec that contains `.specreview/`, else the git top level, else the spec's directory. `open --workspace <dir>` overrides it.
- **Git:** the files are small, sorted JSON and plain source copies with sequential names, so they diff and merge well. Recommended `.gitattributes` (printed by `open` the first time; it does not write them):

  ```text
  .specreview/assets/** binary
  .specreview/docs/*/versions/* linguist-generated=true
  ```

- **Auto-commit (off by default):** with `"git": {"autoCommit": true}`, each recorded version is committed as `spec(<doc>): v3 - <summary> [t1 t2]`, touching only the spec and its `.specreview` paths. It never pushes.

## Configuration

`.specreview/config.json` (created by the first `open`):

```json
{"schema": 1,
 "reviewer": {"name": "Eric"},
 "guards": {"enforceLocks": true, "maxRewriteRatio": 0.5, "unexplainedWords": 20, "unexplainedDeletionLines": 3,
            "unexplainedDeletion": "refuse", "writeHook": "deny", "writeHookRatio": 0.4},
 "anchoring": {"minScore": 0.65, "minQuoteSim": 0.6, "contextChars": 32},
 "render": {"network": "allow", "mermaid": true, "math": true, "highlight": true},
 "git": {"autoCommit": false},
 "assets": {"maxBytes": 20971520}}
```

| Key | Meaning |
|---|---|
| `reviewer.name` | Your display name in threads and packets (defaults to `git config user.name`, then your OS user name) |
| `guards.maxRewriteRatio` | Refuse a revision that removes or replaces more than this share of the old text (docs of 40+ lines) |
| `guards.unexplainedWords`, `guards.unexplainedDeletionLines` | Refuse an unexplained hunk that removes or replaces at least this many words or whole lines |
| `guards.unexplainedDeletion` | `refuse`, `warn` or `off` |
| `guards.writeHook`, `guards.writeHookRatio` | Claude Code Write hook: `deny`, `warn` (ask the user) or `off`; the share of changed lines that triggers it |
| `anchoring.*` | Fuzzy re-anchoring thresholds |
| `render.network` | `allow` lets documents load their own remote resources; `block` adds a CSP that restricts them to local files |
| `git.autoCommit` | Commit each recorded version |
| `assets.maxBytes` | Assets larger than this are not snapshotted |

## Security model

- **Local only.** Both servers bind to `127.0.0.1`. A `Host` allowlist blocks DNS rebinding. The UI API requires a random 128-bit token (from `~/.specreview/daemon.json`, mode 0600, or the `?k=` in the URL), state-changing requests must come from the UI's own origin, and no CORS headers are ever sent.
- **Isolated documents.** Specs, including their scripts, run on a separate origin (port 4778) in a sandboxed iframe without top-navigation rights. That origin has no API and no state-changing routes, and each document is served under an unguessable per-document path, so other websites cannot probe your files.
- **Path safety.** Only files inside the workspace are served; symlink escapes, dot-files and dot-directories (`.env`, `.git`, `.ssh`, `.specreview`) and key files (`*.pem`, `*.key`, `*.p12`, `id_rsa*`) are refused.
- **Observe-only overlay.** Messages from the document can at most open a comment box; nothing is submitted, resolved or written without a click in the UI. Comment bodies are sanitised before rendering.
- **Screen snips are interactive.** `B` and `specreview snip` (unless given `--file`) always show macOS's own region picker; nothing is captured until you drag a box or click a window, and `Esc` cancels. The image is stored with the doc's other attachments and never leaves your machine. The UI loads attachment thumbnails from the document origin, under the doc's unguessable path, and only image files are served there.
- **No egress.** SpecReview makes no network requests: no telemetry, no update checks, every UI asset is vendored. Documents may load their own remote resources unless `render.network` is `block`.
- **Hooks and install are conservative.** Hooks never block a prompt on error and always exit 0. `install` prints what it would change and writes nothing without `--apply`.

The access token appears in the pane's address bar; it is not sent as a referrer and the document iframe cannot read it. Rotate it with `specreview stop --rotate`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `specreview: command not found` | Run `npm link` in the repository, and check that npm's global `bin` directory is on your `PATH` (`npm prefix -g`). |
| Claude Code shows a hook error mentioning `specreview` or `node` | Claude Code cannot find them on its `PATH` (common with nvm and GUI launches). Remove the plugin and use `specreview install claude --user --with-hooks --apply`, which writes absolute paths. |
| The pane stays blank or shows "Reconnecting to SpecReview…" | Run `specreview doctor`. If needed, `specreview stop`, then `specreview open <file>` again and use the new URL. |
| The old URL returns 401 | The token was rotated. Get a fresh URL from `specreview open <file>`. |
| Ports 4777/4778 are taken | The server tries the next free pair up to 4799, then random ports, and remembers its choice. Or set `SPECREVIEW_PORT`. |
| A screen snip shows only the wallpaper or empty windows | macOS has not granted Screen Recording. Turn it on for the app that started SpecReview (or Shortcuts) in System Settings > Privacy & Security > Screen & System Audio Recording, quit and reopen that app, then `specreview stop` and open the doc again. |
| `B` or `specreview snip` says screen snips are unsupported | They need macOS (`/usr/sbin/screencapture`). Use `b` to snip inside the doc, or paste an image into the comment box. |
| An area snip has no picture | The browser could not draw that area (for example a cross-origin image or a video frame). The comment still carries the source lines; use `B` to attach a real screenshot. |
| `wait` exits 3 immediately | The spec has unrecorded edits. The agent should run `specreview revise`; if the edits are yours, click **Record as my revision**. `--allow-dirty` skips the check. |
| `revise` says REFUSED | Read each `ERR` line and its `fix:`. Typical fixes: `specreview revert <doc> --hunk hN`, an `other` explanation, or asking the reviewer to unlock text. |
| Claude says a Write was denied "under SpecReview" | Working as intended: the doc is under review, so Claude must use targeted edits. Set `guards.writeHook` to `warn` or `off` to change this. |
| You submitted but the agent did nothing | Its background wait is not running (for example the session restarted). Tell it "done", or paste the **Copy prompt** text from the Submit dialog. In Claude Code the prompt hook also reminds it on your next message. |
| A `wait` printed "superseded … ignore this" (exit 6) | A newer `wait` took over. Harmless. |
| "Annotations are blocked by this document's Content-Security-Policy" | The document's own CSP meta tag blocks the overlay. Review in Source mode, or remove the tag. |
| "2 external resources failed (offline?)" | The document depends on the internet (CDN scripts, fonts). Make it self-contained. |
| Starting over | `specreview stop`, then delete `~/.specreview`. Your versions and threads in `.specreview/` are untouched. |

## FAQ

**Why not use Claude Artifacts or comments in Claude Docs?**

- **Offline and local.** Everything runs on `127.0.0.1`; nothing is uploaded.
- **Your files, in git.** The spec stays a normal file in your repository, and every version, thread and decision is a plain file you can commit, diff and review in a pull request.
- **Raw HTML fidelity.** Your HTML renders byte for byte as you wrote it, scripts and all; nothing is sanitised, re-serialised or restyled.
- **Any agent.** The interface is a CLI with text and JSON output, plus MCP. Claude Code gets a plugin, but Codex, Gemini CLI or a shell script work too.
- **Guards against regeneration.** Agreed text is locked, unexplained deletions and whole-document rewrites are refused, and every change is linked to the comment it addresses.

**Does SpecReview call an LLM or send my spec anywhere?** No. It is deterministic and offline: the same input always gives the same packet.

**Which formats are supported?** Markdown (`.md`, `.markdown`, GitHub-flavoured, with math, mermaid, footnotes and front matter) and HTML (`.html`, `.htm`).

**Can I edit the spec myself?** Yes. Edit the file, then click **Record as my revision** in the UI. If the agent finds edits it did not make, it explains them instead of reverting them.

**Can several people review?** v1 has a single reviewer per workspace. Comments carry the reviewer name from the config.

**Can I review several files at once?** Each doc has its own rounds. `specreview wait --all` waits on every doc in the workspace.

**How do I get an old version back?** `specreview show <doc> --version N` prints any recorded version's source, and History mode renders it. Ask the agent to restore the part you want, or comment on the change.

**What should a spec look like to review well?** Markdown by default, stable headings, diagrams as mermaid or inline SVG, local images, and for HTML the text in static markup with no CDN dependencies. See [writing specs that review well](integrations/claude-code/skills/spec-review/reference.md#writing-specs-that-review-well).

## Development

- Plain Node.js ESM with JSDoc types and `// @ts-check`; no build step. The UI is Preact + htm, loaded from vendored files.
- Layout: `bin/specreview.js` (CLI entry), `src/cli` and `src/mcp` (agent surfaces), `src/core` (store, render, text, diff, anchoring, review operations), `src/daemon` (local server), `src/guest` (script injected into documents), `src/ui` (review UI), `integrations/` (Claude Code plugin and AGENTS.md snippet).
- Tests: `npm test` (unit and integration, `node --test`), `npm run test:guest`, `npm run test:ui` (UI model tests, then Playwright e2e with your system Chrome; `npm run e2e` runs only the Playwright part). Tests use a temporary `SPECREVIEW_HOME` and never the default ports. Screen-snip tests set `SPECREVIEW_SCREENCAPTURE` to a fake capture command, so they never open the real picker.
- Validate the plugin: `claude plugin validate .` and `claude plugin validate ./integrations/claude-code`.

## Documentation

- [Reviewer guide](docs/user-guide.md): the UI, gestures, snipping, keyboard shortcuts, Verify, locks and final versions.
- [Agent protocol](docs/agent-protocol.md): the full contract for agents: commands, packet format, revise JSON, guards, MCP tools.
- [Claude Code skill](integrations/claude-code/skills/spec-review/SKILL.md) and its [reference](integrations/claude-code/skills/spec-review/reference.md).
- [AGENTS.md snippet](integrations/agents-md/AGENTS.snippet.md) for other agents.
- [Design](docs/design.md) and [build amendments](docs/BUILD_AMENDMENTS.md).

## License

MIT
