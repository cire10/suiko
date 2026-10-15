# SpecReview: design spec, v1 (implementation-ready)

Status: final design for the v1 build · Date: 2026-10-10 · Target: `~/src/suiko`

## 0. Summary

SpecReview is a local tool. It turns an AI-written spec (`.md` or `.html`) into a review loop that works like a pull request. It runs offline and keeps its history in git-friendly files.

1. **Open.** The agent writes the spec once and runs `specreview open <file>`.
   - The spec renders faithfully in a local web UI: scripts, SVG, images, tables, code, mermaid and math all work.
   - The UI opens in the user's default browser; the Claude desktop app's built-in browser pane is an option (`SPECREVIEW_BROWSER=pane`).
2. **Wait.** The agent runs `specreview wait <doc>` in the background and ends its turn. Waiting costs no tokens.
3. **Review.** The reviewer can comment on anything: a phrase, a region of an image, a mermaid node, a table cell, code lines, a section, or raw source lines.
   - They can ask questions, suggest exact replacements, and mark parts **Agreed**, which locks them.
   - Then they click **Submit review** with a verdict: Comment, Request changes or Approve.
4. **Feedback.** `wait` exits and prints a compact feedback packet.
   - There is one item per thread. Each item has line numbers in the current file and the exact source lines, which the agent can pass straight to the Edit tool as `old_string`.
5. **Revise.** The agent makes targeted edits (or runs `specreview apply` for suggestions), then runs `specreview revise` with one reply per thread. SpecReview then:
   - records an immutable version;
   - links every diff hunk to the thread it addresses;
   - **refuses** edits to locked text, unexplained deletions and whole-file rewrites;
   - re-anchors every comment;
   - notifies the UI.
6. **Verify and finish.** The reviewer sees:
   - "changes since my last review" drawn over the live document;
   - a before/after for each thread;
   - the agent's replies.

   They accept or reopen threads and repeat. **Approve** marks the final version. Every version, thread, review round and decision is a plain file in `.specreview/`, and can be committed to git.

The core does not depend on any one agent: it is a CLI with a text and JSON stdout contract, plus an MCP server. Claude Code gets a skill, a slash command and two hooks on top. The tool itself makes no network calls, and every UI asset is vendored.

### 0.1 Provenance
- **Backbone: "Margin" (agent-loop)**, the strongest fit for "Claude regenerates everything and agreed things get lost". From it:
  - the filesystem store is the source of truth;
  - background `wait`;
  - `revise` with per-thread replies;
  - hunk-to-thread attribution;
  - guards and locks;
  - source-exact `src>` lines;
  - presence and delivery receipts;
  - the Write hook and the prompt hook;
  - the decision log.
- **Grafted from "SpecReview" (fidelity):**
  - byte-splice source stamping with parse5;
  - an observe-only guest script (CSS Custom Highlight API plus a closed-shadow overlay in the top layer);
  - commit-point crash safety and delivery ack;
  - line numbers taken from the file currently on disk;
  - quote narrowing for generated content;
  - version-pinned assets;
  - CSP fallback and pristine mode;
  - fidelity parity tests;
  - agent `reanchor` and `ask`.
- **Grafted from "Specpen" (reviewer UX):**
  - pending review with a verdict;
  - Verify queue;
  - "Addressed in vN" with a mini-diff;
  - decisions ledger;
  - text-mode suggestions;
  - "since my last review" as the entry point;
  - narrow-pane drawer, keyboard map and empty states;
  - reviewer "Apply suggestion".
- **From research:**
  - unified for exact Markdown offsets;
  - Hypothesis anchor scoring and approx-string-match;
  - MCP SDK v2;
  - node:http with SSE;
  - zero network by default;
  - layered notification.

### 0.2 Conflict resolutions (choice and reason)
| # | Conflict | Decision | Why |
|---|---|---|---|
| C1 | Who writes `.specreview/`: the daemon as single writer (Specpen, SpecReview), or any process through a lock (Margin) | **Any process writes through `src/core/store` under a per-doc `proper-lockfile` lock with atomic renames.** The CLI never needs the daemon. | The agent loop survives a dead or absent daemon. The CLI needs no HTTP client. Packages can be built in parallel against one library. |
| C2 | Markdown engine: markdown-it (line maps) or unified (offsets) | **unified** (remark/rehype + rehype-raw) | Exact offsets on inline elements and on text nodes, including raw HTML (verified). These are needed for byte-exact suggestions and exact line numbers. |
| C3 | Highlighter: shiki or highlight.js | **highlight.js via rehype-highlight**, server-side | Synchronous and small. Code-line anchors use fence offsets, not tokenizer spans. |
| C4 | Source map: offsets in attributes, block keys, or srid plus a map | **`data-srid="n"` plus a per-version SrcMap** | Compact, keeps rich metadata server-side, and identity across versions is not needed because re-anchoring works on source text. |
| C5 | Re-anchoring basis: block keys or source text | **Source text**: a line-diff hint, then exact quote, then Hypothesis-scored fuzzy matching, chained one version at a time. Rendered quotes are derived per version. | Source is what the agent edits and what packets cite. Block alignment is used only to present changes. |
| C6 | `push` + `reply` (two steps) or a combined `revise` | **Combined `revise --replies`**, plus a standalone `reply` for answers that need no edit | The version, replies and guard result are committed atomically. |
| C7 | Random ids or sequential ids | **Sequential per doc** (t4, rv2, v3, L1, D2), allocated under the lock | Agents and the user say "t4" in chat. v1 has a single reviewer, and `doctor --fix` can renumber later if needed. |
| C8 | Write hook: blanket deny or measured | **Measured**: deny a Write only when it would rewrite more than 40% of a tracked doc that is under review | Small Writes stay allowed, and regeneration is blocked. |
| C9 | Guard strictness | **Refuse (exit 3):** a touched lock, an unexplained net deletion of 3 or more lines, a rewrite ratio above 0.5. **Warn:** everything else. `--force` is recorded and shown in red. | Directly targets "agreed things got lost" while keeping escape hatches. |
| C10 | How `wait` learns about a review: HTTP long-poll or file watch | **File watch on the store** (fs.watch plus a 2 s poll). A review is marked delivered only after stdout has flushed. | Works without the daemon, and a killed `wait` never loses a review. |
| C11 | MCP SDK v1 or v2 | **`@modelcontextprotocol/server` 2.3.1** (v2) | Verified working on Node 24 by the research. v1 pulls in express, hono and other heavy dependencies. |
| C12 | MCP wait duration | **Default 50 s, maximum 600 s**, with progress notifications; returns `{status:"waiting"}` | Generic clients often time out around 60 s. Claude Code users get the background CLI `wait` instead. |
| C13 | HTTP stack: hono or node:http | **node:http** plus a roughly 80-line router | No dependency for about 25 routes and SSE. |
| C14 | Frontend build: vite/tsup or no build | **No build step**: Node ESM with JSDoc types (checked by `tsc --noEmit`), Preact through `htm/preact/standalone.module.js`, vendored from node_modules. The guest script is an ordered concatenation of plain files. | See section 4.2. Most robust for parallel agents and `npm link`. |
| C15 | External CDN resources referenced by docs | **Pass them through** for fidelity, and report failures in the UI. The proxy cache and vendor substitution are v1.1. `render.network:"block"` adds a CSP. | Keeps v1 simple. The tool itself never contacts the network. |
| C16 | Diff presentation | **v1:** overlay on the live new version, a source diff (unified or split), a mini-diff on each thread, and the history timeline. **v1.1:** static redline, side-by-side rendered view, image swipe and onion skin. | The overlay keeps scripts working and covers HTML and Markdown with one code path. |
| C17 | Locks or decisions | **Both.** A lock is hard (`revise` refuses). A decision is soft (a warning plus a reminder in every packet). | They are different guarantees. |
| C18 | Resolve immediately or batch it | **Resolve and accept take effect immediately.** Replies, reopens and new comments are batched in the pending review. | The agent does not need to act on a resolve. |
| C19 | Commenting on the unrecorded working copy | **Not allowed.** It is a read-only live preview. | Anchors must point at immutable text. |
| C20 | Who resolves threads | **Only the reviewer** (Accept). Approve can auto-resolve addressed threads (a checkbox, on by default). | Same as GitHub. The agent never closes its own homework. |

## 1. Product

### 1.1 Pain points and how they are solved
| The user's pain | Mechanism |
|---|---|
| "I can't comment on specific parts" | Anchored threads on text, elements, image regions, SVG and mermaid nodes, table cells, code lines, math, media timestamps, sections, source lines, and the whole doc |
| "Claude regenerates the entire spec" | Packets carry exact `src>` lines. `apply` and `edit` make deterministic splices. The protocol in the skill. The Write hook. The rewrite-ratio guard. |
| "Things we had before get lost" | Locks (refuse), decisions (warn), the unexplained-deletion guard, immutable versions, `revert --hunk`, `show --version` |
| "It's not iterative" | Review rounds, threaded replies, `needs_input` questions back to the reviewer, reopen, the Verify queue |
| "I want to review what changed" | Changes overlay, source diff, "since my last review", per-thread mini-diff, history timeline, any-to-any comparison |
| "See the final version" | Approve, then a FINAL badge, `specreview final`, and the decision log |
| "Change over time, as on GitHub" | Versions are plain files in `.specreview/`; optional `git.autoCommit` |
| "Handle different HTML elements" | Faithful two-origin rendering (scripts run) plus element-level anchors and crops |

### 1.2 Non-goals for v1
- Multiple reviewers or identities.
- Real-time co-editing or WYSIWYG editing.
- Hosted sharing.
- PDF/DOCX export.
- Reviewing several files in one round (each doc has its own rounds; `wait --all` covers several docs).
- Annotating inside nested iframes or shadow roots. These are commentable only as whole elements.

### 1.3 Principles
1. **The source file is the truth.** Versions are immutable byte copies. All coordinates given to the agent are source lines of the file currently on disk.
2. **No regeneration.** Every change is a targeted edit linked to a thread or explained.
3. **Observe-only rendering.** The author's HTML is never sanitised, never re-serialised and never restyled. The only additions are inert `data-srid` attributes and one script tag.
4. **Deterministic and offline.** No LLM calls and no network. The same input gives the same packet.
5. **One formatter.** The CLI, MCP, hooks and UI previews all use `src/core/review/packet.js`.

## 2. Glossary and identifiers
| Term | Meaning | ID format |
|---|---|---|
| Workspace | Directory that contains `.specreview/` (see 5.1) | `wsId` = first 8 hex characters of sha256(realpath) |
| Doc | A tracked spec file (`.md`, `.markdown`, `.html`, `.htm`) | slug of the basename, e.g. `token-service` (a `-2` suffix on collision) |
| Working copy | The file on disk now | |
| Version | An immutable recorded snapshot | `v1, v2…` (files `0001.md`) |
| Head | The latest version | |
| Review | One submitted batch from the reviewer, with a verdict | `rv1…` |
| Thread | An anchored conversation | `t1…` |
| Comment | One message in a thread | `c1…` |
| Lock | An "Agreed" region; `revise` refuses changes to it | `L1…` |
| Decision | A one-line agreement recorded when a thread is resolved | `D1…` |
| Hunk | One line-diff block between head and the working copy (or between two versions) | `h1…` (numbered per diff) |
| Draft | An unsubmitted reviewer item | `d1…` |
| Packet | The feedback text or JSON printed for the agent | |
| Guest | The script injected into the rendered doc | |
| Daemon | Local server for the UI and documents | |

## 3. End-to-end loop (exact commands and outputs)

Running example:
- Workspace `~/proj`.
- Spec `docs/specs/token-service.md`, which contains a table, a ts code fence, a mermaid fence, `$math$` and `![System overview](./img/arch.png)`.
- Reviewer: Eric. Agent: claude.

### 3.0 One-time install
```
cd ~/src/suiko && npm install && npm link
# Claude Code (recommended): in a Claude Code session
/plugin marketplace add ~/src/suiko
/plugin install specreview@specreview          # skill + /review-spec + hooks
# or without the plugin system (prints what it would do; --apply writes it):
specreview install claude --user --apply        # -> ~/.claude/skills/spec-review/SKILL.md
# any MCP client (Cursor, Claude Desktop, ...):
claude mcp add specreview -- specreview mcp
# other CLI agents (Codex, Gemini CLI): append the protocol to AGENTS.md
specreview install agents-md --apply
```

### 3.1 Claude writes the spec once
User: "Write an implementation spec for the token service; I want to review it."

The `spec-review` skill triggers. Claude writes `docs/specs/token-service.md` with the Write tool. This is the only whole-file write; every later change is an Edit.

### 3.2 Register the doc
```
$ specreview open docs/specs/token-service.md
specreview: tracking docs/specs/token-service.md as "token-service" (markdown, 212 lines) · recorded v1
review UI: http://127.0.0.1:4777/d/3f9a1c2e/token-service?k=Zx81Qm0v7c
next: open the URL (browser pane), then run `specreview wait token-service` in the background
```
- `open` creates `.specreview/` if needed and records v1: the source bytes plus a snapshot of `img/arch.png`.
- It starts the daemon detached if it is not already running.
- If the doc is already tracked, `open` only prints the URL. If the working copy differs from head, it adds `working copy differs from v3 (unrecorded)`.

### 3.3 Show the UI beside the chat
`open` opens the URL in the user's default browser (the in-app pane is too cramped next to the chat and sidebar for a review). With `--browser pane` or `SPECREVIEW_BROWSER=pane`, it only prints the URL and Claude calls `mcp__Claude_Browser__preview_start({"url": "<url>"})` when the desktop pane tool exists, or prints the URL otherwise.

### 3.4 Wait for the review
Claude runs Bash `specreview wait token-service` with `run_in_background: true`. It tells the user "v1 is open in the pane; comment on anything, then click **Submit review**. I'll pick it up automatically." Then it ends its turn.

stderr prints `specreview: waiting for a review of token-service v1 (as claude). Safe to interrupt; nothing is lost.` The waiter heartbeat makes the UI show **"claude is listening"**.

### 3.5 The reviewer reviews (the UI is described in section 11)
- Selects "rotated on every use", presses `c`, writes a comment and sets **Blocking**.
- Presses `e` (pick mode), shift-drags a box over the gateway arrow in `arch.png`, and asks a question. A PNG crop is attached.
- Selects the retry sentence and presses `s`. Because the selection has no markup, the suggestion opens in **text mode**; the reviewer types the replacement.
- Clicks the `refresh_token`/`TTL` table cell in pick mode and comments.
- In the outline, right-clicks "7 Rollout plan" and chooses **Mark agreed**. This creates lock L1 immediately.
- Clicks **Submit review**, chooses **Request changes**, and writes a summary.

Drafts are autosaved on the server as the reviewer types, so a reload loses nothing.

### 3.6 `wait` exits and prints the packet (exit 0)
```
SPECREVIEW FEEDBACK · token-service (docs/specs/token-service.md) · review rv1 on v1 · CHANGES REQUESTED
Line numbers = current file on disk (identical to v1).
Reviewer summary: Good start. Section 7 is agreed - keep it.
4 threads need action (4 new): 1 blocking · 1 question · 1 suggestion · 1 comment

[t1] blocking · comment · L42-43 · §3 Tokens > 3.2 Token refresh
  on: "rotated on every use"
  src> Refresh tokens are rotated on every use, and the previous token is
  src> invalidated immediately.
  Eric: Rotation on every use breaks multi-tab sessions. Use a 30 s reuse-detection grace window.

[t2] question · L88 · §4 Architecture · <img alt="System overview"> region x40-62% y10-30%
  src> ![System overview](./img/arch.png)
  crop: .specreview/docs/token-service/attachments/a1.png  (Read it to see the region)
  Eric: Does the gateway sit in front of the auth service or beside it? The arrow is ambiguous.

[t3] suggestion · L120 · §5.1 Retries · apply verbatim: specreview apply token-service t3
  - The client MUST retry 3 times.
  + The client MUST retry up to 5 times with exponential backoff (base 200 ms, full jitter).
  Eric: Match the platform retry policy.

[t4] comment · L151 · §6 Data model · table cell row "refresh_token" x col "TTL" = "30d"
  src> | refresh_token | opaque | 30d |
  Eric: 30 days is too long for admin accounts; split by role.

LOCKED (agreed - do not modify): L1 §7 Rollout plan (L170-196)
DECISIONS to keep true: (none yet)
PROTOCOL: targeted edits only; src> lines are exact Edit old_string; edit bottom-up. Suggestions: `specreview apply`.
  Questions: answer in the thread's reply; edit only if the answer belongs in the spec. Unsure: status needs_input.
REPLIES: answer every thread above on the thread itself, with a status (the reviewer reads replies in Suiko, not in this chat).
NEXT: edits, if any -> specreview revise token-service --replies - (JSON, one entry per thread) -> specreview wait token-service (background)
```
After stdout has flushed, the review is marked delivered. The UI shows "Delivered to claude 14:02 · revising…".

### 3.7 Targeted edits
- **t3:** `specreview apply token-service t3` prints `applied t3 at L120 (exact) · staged (not recorded yet)`.
- **t1:** an Edit tool call with `old_string` set to the two `src>` lines.
- **t2:** Claude Reads the crop PNG, fixes the caption at L90-91, and will answer in its reply.
- **t4:** the values are unclear, so Claude will reply with `needs_input`.

### 3.8 Record the revision with replies
```
$ specreview revise token-service --replies - <<'JSON'
{"summary":"rv1: grace window, retry policy, figure caption",
 "threads":{
  "t1":{"status":"addressed","reply":"Replaced rotate-every-use with a 30 s reuse-detection grace window; added rationale."},
  "t2":{"status":"addressed","reply":"Gateway sits in front of auth. Fixed the caption.","at":"L90-91"},
  "t3":{"status":"addressed","reply":"Applied your suggestion."},
  "t4":{"status":"needs_input","reply":"Split TTL by role: user 30d, admin 12h or 24h?"}},
 "other":[{"at":"L12","why":"Bumped 'Last revised' date"}]}
JSON
specreview: recorded v2 for token-service (+9 -3 lines, 4 hunks) · responds to rv1
  h1 L42-46  §3.2 Token refresh  -> t1 addressed  (overlap)
  h2 L90-91  §4 Architecture     -> t2 addressed  (hint)
  h3 L120    §5.1 Retries        -> t3 addressed  (tagged: apply)
  h4 L12     front matter        -> other: Bumped 'Last revised' date
  t4 needs_input (reply only)
guards: ok · lock L1 untouched · no unexplained deletions · rewrite 4%
anchors: 4 threads + 1 lock -> 1 exact, 1 moved, 3 edited, 0 changed, 0 orphaned
reviewer notified (1 UI open). next: specreview wait token-service (background)
```
If a guard trips, nothing is recorded and the command exits 3:
```
specreview: REFUSED - nothing recorded (exit 3)
  ERR lock: h5 L171-174 changes L1 §7 Rollout plan (agreed in rv1)
      fix: specreview revert token-service --hunk h5   or   --break-lock L1="<reason>"
  ERR deletion: h6 removes 14 lines (v1 L201-214, §8 Open questions) linked to no thread
      fix: specreview revert token-service --hunk h6   or   add "other":[{"at":"del:h6","why":"..."}]
  WARN t2 marked addressed but no hunk is linked to it (add "at":"L90-91" if you changed it)
working copy left untouched. Preview with --dry-run.
```

### 3.9 Report and wait again
Claude gives a one-line summary per thread in chat. Then it starts `specreview wait token-service` in the background again.

### 3.10 The reviewer checks the changes
1. An SSE `version.created` event arrives. The UI shows the toast "v2 ready · 3 addressed · 1 needs you [Review changes] [Verify 3]". The tab title becomes "(v2) token-service".
2. **Review changes** opens Changes mode with base = v1 (the last reviewed version). It shows:
   - green and amber change bars;
   - inserted words tinted;
   - a "⊖ 3 lines removed" tab;
   - the orange "Other change" card for h4, with the agent's reason.
3. **Verify** walks through t1, t2 and t3. Each card shows the comment, the agent's reply and a word-level mini-diff of the linked hunk. The reviewer:
   - presses `x` to accept t1 and records decision D1, "30 s reuse-detection grace window";
   - accepts t3 (decision D2);
   - presses `o` on t2 to reopen it, with the reply "caption still ambiguous".
4. They answer t4 ("admin 12h") and click **Submit review**, then **Request changes**.

### 3.11 Round 2 packet
```
SPECREVIEW FEEDBACK · token-service · review rv2 on v2 · CHANGES REQUESTED
Line numbers = current file on disk (identical to v2).
Reviewer summary: Close. Caption still unclear.
2 threads need action: 1 reopened · 1 answer to your question   (2 resolved this round)

[t2] REOPENED · question · L90-91 · §4 Architecture · <img alt="System overview"> region x40-62% y10-30%
  src> *Figure 2: the gateway sits in front of the auth service.*
  claude (v2): Gateway sits in front of auth. Fixed the caption.
  Eric: Caption still ambiguous: say which arrows are sync vs async.

[t4] ANSWER · comment · L151-152 · §6 Data model · table cell row "refresh_token" x col "TTL"
  src> | refresh_token (user)  | opaque | 30d |
  src> | refresh_token (admin) | opaque | ?   |
  claude (v2, needs_input): Split TTL by role: user 30d, admin 12h or 24h?
  Eric: admin 12h.

LOCKED (agreed - do not modify): L1 §7 Rollout plan (L173-199)
DECISIONS to keep true: D1 (t1) 30 s reuse-detection grace window · D2 (t3) retries: up to 5, exponential backoff, full jitter
REPLIES: answer every thread above on the thread itself, with a status (the reviewer reads replies in Suiko, not in this chat).
NEXT: edits, if any -> specreview revise token-service --replies - (JSON, one entry per thread) -> specreview wait token-service (background)
```

### 3.12 Approve and finalise
The reviewer submits **Approve** on v3. "Mark v3 final" and "Resolve 2 addressed threads" are both checked. `wait` prints:
```
SPECREVIEW FEEDBACK · token-service · review rv3 on v3 · APPROVED · FINAL = v3
0 threads need action · 7 resolved · 0 open
NEXT: specreview final token-service --decisions   (then stop waiting)
$ specreview final token-service --decisions
final: token-service = v3 (approved in rv3 by Eric; 3 versions, 3 reviews, 7 threads resolved, 2 decisions)
working copy matches v3: ok
wrote docs/specs/token-service.decisions.md
```
The History tab and `specreview log` show v1 -> v2 -> v3. With `git.autoCommit` turned on, every version is also a commit.

### 3.13 Variants
- **The user says "done" in chat but never submitted.** `specreview feedback token-service --include-drafts` prints `0 submitted reviews pending; 3 DRAFT comments not yet submitted (ask the reviewer to click Submit review)` and lists the drafts, clearly labelled.
- **The background wait died** (for example, Claude restarted). The UserPromptSubmit hook injects: "specreview: review rv2 on token-service is waiting (2 threads). Run `specreview feedback token-service`." `feedback` delivers it and marks it delivered.
- **MCP-only agent:** `specreview_open`, `specreview_wait` (call it again while it returns waiting), `specreview_apply` or `specreview_edit`, `specreview_revise`.
- **Codex, Gemini CLI and similar:** the same commands, run in the foreground.

## 4. Architecture

### 4.1 Processes
```
 Agent (Claude Code / Codex / ...)                MCP client
   | argv, stdout, exit code                        | JSON-RPC over stdio
   v                                                v
 specreview <cmd>  (short-lived)               specreview mcp  (stdio server)
   \___________________________  ________________/
                               \/
   core library (src/core): store | render | text | diff | anchor | review ops
        reads/writes <workspace>/.specreview/ under a per-doc lock (atomic renames)
                               |
                               |  watched (chokidar) by
                               v
   specreview daemon   (one per OS user; auto-started detached by the CLI; idle-exit 12 h)
      UI origin       http://127.0.0.1:4777  /d/... SPA, /ui/*, /vendor/*, /api/*, /api/events (SSE)
      content origin  http://127.0.0.1:4778  /c/<secret>/<ws>/<v|live>/<path>, /c/<secret>/__sr/*
                               |
   Browser (Claude desktop browser pane, or any Chromium/Safari/Firefox 140+)
      UI SPA (origin :4777) <== postMessage, origin-checked ==> <iframe> (origin :4778)
                                                                 author's document (as authored)
                                                                 + data-srid attributes + guest.js
```
Key decisions:
- **D1 Store authority.** Every mutation goes through `src/core/review/ops.js`, which wraps `store.withDocLock(docId, fn)`. CLI, MCP and daemon processes all call the same ops. The daemon learns about agent actions by watching the store and the tracked files. There is no IPC.
- **D2 Two origins.** Untrusted, script-bearing documents run on :4778. The UI, its token and the API live on :4778's sibling :4777. Different ports mean different origins. The doc iframe can therefore keep `allow-same-origin`, so localStorage, module scripts and fetch work as authored, but it can never reach the UI or the API.
- **D3 Guest/host split.** All DOM work inside the doc happens in the injected guest: selection, picking, highlights, overlays, change marks, crops and positions. The UI holds the state and talks to the API.
- **D4 One daemon, many workspaces.**
  - `~/.specreview/daemon.json` (mode 0600) holds `{pid, uiPort, contentPort, token, secret, version, startedAt}`.
  - `~/.specreview/workspaces.json` maps `wsId` to the workspace root.
  - Ports default to 4777/4778. If either is busy, the daemon tries the next free pair up to 4799, then picks random ports.
- **D5 Versions are explicit.** Versions are created only by `open` (v1), `revise`, the UI's **Record as my revision**, and the UI's **Apply suggestion now**. The file watcher only drives the read-only live preview.

### 4.2 Tech stack and the no-build decision
All code is **plain Node ESM JavaScript with JSDoc types** (`// @ts-check`). `tsc --noEmit -p jsconfig.json` checks it in CI. Nothing is compiled.
- **UI:** Preact plus htm, imported from the vendored single file `htm/preact/standalone.module.js` (it exports `html, render, useState, useEffect, useRef, useMemo, useCallback, useContext, createContext`; verified). It loads through an import map.
- **Guest:** an ordered list of plain script files (`src/guest/parts.json`). The daemon concatenates them into one IIFE at startup.
- **Why no build:**
  1. Parallel agents cannot break a shared bundler config.
  2. `npm link` works straight from source, and no `dist/` can go stale.
  3. Errors show up at runtime with real file and line numbers.
  4. Offline use is guaranteed: vendor files are served from `node_modules` through an allowlist.
  5. Fewer devDependencies.
- **Trade-off:** no JSX (htm tagged templates are close), and mermaid's 5.5 MB bundle is served as-is but lazy-loaded only when a diagram exists.

Runtime dependencies (pin exact versions; all verified on npm on 2026-10-10):
```json
{
  "name": "specreview", "version": "0.1.0", "type": "module",
  "bin": { "specreview": "bin/specreview.js" },
  "engines": { "node": ">=20.19" },
  "files": ["bin", "src", "integrations", ".claude-plugin", "README.md", "docs"],
  "scripts": {
    "test": "node --test test/unit/ test/integration/",
    "test:unit": "node --test test/unit/",
    "e2e": "playwright test",
    "typecheck": "tsc -p jsconfig.json",
    "check": "npm run typecheck && npm test"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "2.3.1", "zod": "4.6.5",
    "unified": "11.0.5", "remark-parse": "11.0.0", "remark-gfm": "4.0.1", "remark-frontmatter": "5.0.0",
    "remark-math": "6.0.0", "remark-rehype": "11.1.2", "rehype-raw": "7.0.0", "rehype-katex": "7.0.1",
    "katex": "0.16.47", "rehype-highlight": "7.0.2", "highlight.js": "11.12.0", "rehype-slug": "6.0.0",
    "rehype-stringify": "10.0.1", "unist-util-visit": "5.1.0",
    "parse5": "8.0.1", "diff": "9.0.0", "approx-string-match": "2.0.1",
    "chokidar": "5.0.0", "proper-lockfile": "4.1.2",
    "mermaid": "12.1.0", "github-markdown-css": "5.9.0",
    "htm": "3.1.1", "marked": "18.1.0", "dompurify": "3.4.16"
  },
  "devDependencies": { "typescript": "5.9.3", "@playwright/test": "1.64.0", "jsdom": "30.1.2" }
}
```
Notes:
- `katex` is pinned to 0.16.x because `rehype-katex@7.0.1` depends on `katex ^0.16.0`.
- The browser loads `htm`, `marked`, `dompurify` and `diff` from node_modules. Their ESM builds have no bare imports, which was verified.
- There is no hono, express, commander, shiki, CodeMirror or diff2html.
- CLI parsing uses `node:util.parseArgs`. Opening the system browser spawns `open`, `xdg-open` or `start`.

### 4.3 Source tree and ownership (WP = work package; see the build plan)
```
package.json  jsconfig.json  .gitignore                      WP1
bin/specreview.js                                             WP4
src/shared/{types.js, schemas.js, protocol.js, vendor.js}     WP1
src/core/util/{hash.js, paths.js, time.js, lines-arg.js, log.js, stable-read.js}  WP1
src/core/store/{workspace.js, home.js, atomic.js, lock.js, store.js, recovery.js}  WP1
src/core/render/{index.js, markdown.js, html.js, plugins/*.js, shell.js, assets.js, cache.js, fragment.js}  WP2
src/core/render/static/{shell.css, mermaid-init.js}           WP2
src/core/text/{lines.js, textindex.js, align.js, normalize.js}  WP2
src/core/diff/{hunks.js, offsets.js, words.js, changes.js, source-diff.js}  WP2
src/core/anchor/{create.js, reanchor.js, fuzzy.js, fingerprint.js, describe.js, dom.js}  WP3
src/core/review/{context.js, ops.js, attribution.js, guards.js, packet.js, apply.js, export.js, git.js, wait.js}  WP3
src/cli/{main.js, commands/*.js, daemon-client.js, hooks.js, install.js, format.js}  WP4
src/mcp/server.js                                             WP4
src/daemon/{main.js, router.js, security.js, api.js, content.js, sse.js, watch.js, ui-index.js, guest-bundle.js}  WP4
src/guest/{parts.json, 00-env.js ... 99-main.js}              WP5
src/ui/{index.html, importmap.json, main.js, api.js, state.js, sse.js, frame.js, keys.js, components/*.js, styles/*.css}  WP6
test/**, fixtures/**, playwright.config.js                    WP7
integrations/**, .claude-plugin/marketplace.json, README.md, docs/**  WP8
```

### 4.4 Module contracts (frozen interfaces)
Types live in `src/shared/types.js` as JSDoc `@typedef`s that mirror section 5. The zod versions are in `src/shared/schemas.js`.

**WP1: shared and store**
```js
// src/shared/protocol.js
export const EXIT = { OK: 0, ERROR: 1, TIMEOUT: 2, REFUSED: 3, NOT_FOUND: 4, CLOSED: 5 };
export const PORTS = { ui: 4777, content: 4778, max: 4799 };
export const CONTEXT_CHARS = 32;
export const TEXT_EXCLUDE = { tags: ['script','style','noscript','template','textarea','title'],
  classes: ['katex-mathml'], attrs: ['data-sr-ignore'], kinds: ['mermaid'] };   // same rule in server + guest
export const BLOCK_TAGS = ['p','h1','h2','h3','h4','h5','h6','li','dt','dd','blockquote','pre','table','thead','tbody',
  'tr','td','th','figure','figcaption','img','svg','canvas','video','audio','iframe','embed','object','hr','details',
  'summary','section','article','aside','header','footer','nav','main','div','ul','ol','dl','form'];
export const SSE = { /* names in section 10.3 */ };  export const MSG = { /* names in section 10.5 */ };
// src/shared/vendor.js  (prefix maps; resolved by walking up from this file for node_modules/<pkg>)
export const VENDOR_UI  = { 'htm/': 'htm/', 'marked/': 'marked/lib/', 'dompurify/': 'dompurify/dist/', 'diff/': 'diff/libesm/' };
export const VENDOR_DOC = { 'github-markdown-css/': 'github-markdown-css/', 'highlight.js/styles/': 'highlight.js/styles/',
  'katex/': 'katex/dist/', 'mermaid/': 'mermaid/dist/' };
export function resolveVendor(map, publicPath) /* -> absPath|null; rejects '..', only files under the mapped dir */ {}
// src/core/util/*
export function sha256(bufOrString) {}                  // hex
export function slugify(name) {}                        // 'Token Service.md' -> 'token-service'
export function isDeniedPath(relPosix) {}               // any segment starting with '.', *.pem|*.key|*.p12|id_rsa*
export function realpathWithin(root, rel) {}            // -> abs | null (symlink-safe)
export async function stableRead(abs) {}                // -> {buf, text, sha256, mtimeMs}; retries while size/mtime change
export function parseLinesArg('L42-46,L90') {}          // -> [[42,46],[90,90]]
// src/core/store/workspace.js
export async function findWorkspace(fileOrDir, {create}) {}   // -> {root, storeDir, wsId}
// src/core/store/home.js   (SPECREVIEW_HOME overrides ~/.specreview)
export function homeDir() {} export async function readDaemonInfo() {} export async function writeDaemonInfo(info) {}
export async function registerWorkspace(root) /* -> wsId */ {} export async function workspaceRoot(wsId) {}
export async function listWorkspaces() {}
// src/core/store/store.js
export class Store {
  static async open(root, { create = false } = {}) {}
  root; storeDir; wsId;
  async config() {}                                       // Config with defaults merged
  async withDocLock(docId, fn) {}                         // proper-lockfile on runtime/locks/<docId>
  async listDocs() {} async findDoc(idOrPath) {} async createDoc({ path, format, title, createdBy }) {} async saveDoc(doc) {}
  nextId(doc, kind /* 'thread'|'comment'|'review'|'lock'|'decision'|'draft'|'attachment' */) {} // mutates doc.counters; caller saves
  async listVersions(docId) {} async readVersion(docId, v) /* -> {manifest, source} */ {}
  async commitVersion(docId, { source, ext, manifest, assetFiles /* {rel: abs} */ }) {} // blobs -> source -> manifest (commit point)
  async putBlob(buf, ext) /* -> 'sha256:<hex>' */ {} blobPath(ref) {}
  async listThreads(docId) {} async getThread(docId, id) {} async saveThread(docId, thread) {} async deleteThread(docId, id) {}
  async listReviews(docId) {} async getReview(docId, id) {} async saveReview(docId, review) {}
  async listLocks(docId) {} async saveLock(docId, lock) {}
  async getDrafts(docId) {} async saveDrafts(docId, drafts) {}
  async appendPendingEdit(docId, e) {} async readPendingEdits(docId) {} async clearPendingEdits(docId) {}
  async appendEvent(docId, ev) /* -> seq */ {} async readEvents(docId, afterSeq) {}
  async registerWaiter(docId /* or '*' */, { agent, pid }) /* -> {heartbeat(), remove()} */ {}
  async listWaiters(docId, { liveOnly = true } = {}) {}
  async saveAttachment(docId, name, buf) /* -> store-relative path */ {}
  async readWorking(doc) /* stableRead of the tracked file */ {}
  async writeWorking(doc, text, { expectSha256 }) /* CAS + atomic rename, keeps file mode */ {}
  cacheDir(...parts) {}
}
```
**WP2: render, text and diff**
```js
// src/core/render/index.js
/** @returns {Promise<RenderResult>} */
export async function renderSource({ format, source, docPath, stamp = true }) {}
// RenderResult = { html, guestInsertAt, srcmap: SrcMap, text: TextIndexData, outline: OutlineItem[],
//                  assets: string[] /* workspace-relative local refs */, externals: string[], title,
//                  features: { mermaid, math, code } }
export async function getRender(store, doc, ver /* number|'live' */, { stamp = true } = {}) {} // disk cache
export function finalizeHtml(render, { assetBase, guestTag, stripCsp = false }) {} // -> served HTML string
export async function renderFragment({ format, source }) {} // -> HTML with script/on* stripped (deletion popovers)
// src/core/text/*
export function lineIndex(source) {}   // -> { count, lineOf(off), colOf(off), startOf(line), endOf(line) } 1-based lines
export function textIndex(data) {}     // TextIndexData -> TextIndex:
//   { text, span(srid) -> [g0,g1], toGlobal(srid, o), fromGlobal(g) -> {srid, o} (deepest element),
//     textToSource(g) -> {off, flag}, sourceToText(off) -> g|null, slice(g0,g1), context(g0,g1,n) -> {prefix,suffix} }
export function normalizeWs(s) {}      // -> { text, map: number[] } (map: normalized index -> raw index)
// src/core/diff/*
export function lineHunks(a, b) {}             // -> Hunk[] (half-open, 1-based; see 8.2)
export function offsetMapper(a, b, hunks) {}   // -> { mapOffset(off) -> {off, hunk|null}, mapLine(line) -> {line, hunk|null} }
export function wordDiff(a, b) {}              // -> [{op:'eq'|'ins'|'del', text, aStart, aEnd, bStart, bEnd}]
export function rewriteRatio(hunks, oldLineCount) {}
export async function changeSet({ fromSource, toSource, fromRender, toRender, format, hunks }) {} // -> Changes (no thread links)
export function sourceDiff(a, b, { context = 3 } = {}) {}  // -> SourceDiff rows for the UI table
export function unifiedPatch(a, b, { fromLabel, toLabel }) {}
```
**WP3: anchor and review engine**
```js
// src/core/anchor/*
export function createAnchor({ version, capture, source, render, lines }) {}       // AnchorCapture -> Anchor
export function anchorFromLines({ version, startLine, endLine, source, render }) {}
export function anchorFromQuote({ version, quote, source, render }) {}             // -> Anchor | null
export function reanchor({ anchor, fromSource, toSource, hunks, mapper, toRender, link, config }) {} // -> Anchor (state set)
export function fuzzyFind(hay, needle, { prefix, suffix, hint, minScore, minQuoteSim }) {} // -> {start,end,score,quoteSim}|null
export function toDomTarget(anchor, render, { id, state, label }) {}               // -> DomTarget
export function describeAnchor(anchor, { source, workingSource, workingMapper }) {} // -> {lines,label,section,src,srcUnique,on}
// src/core/review/context.js
export async function createContext({ cwd, file, agent }) {}  // -> Ctx { store, wsId, agent, reviewer, config, now(), render(doc, ver) }
// src/core/review/ops.js   (every mutating op = one withDocLock critical section)
export async function openDoc(ctx, { path, title }) {}                 // -> { doc, version, created, workingDirty }
export async function docState(ctx, docId) {}                          // -> DocState (without contentBase)
export async function resolveCapture(ctx, docId, { version, capture }) {} // -> { anchor, preview }
export async function saveDraft(ctx, docId, item) {}  export async function deleteDraft(ctx, docId, draftId) {}
export async function submitReview(ctx, docId, { verdict, body, markFinal, resolveAddressed, by }) {} // -> Review
export async function resolveThread(ctx, docId, tid, { by, decision }) {} export async function unresolveThread(ctx, docId, tid, { by }) {}
export async function moveThread(ctx, docId, tid, { version, capture, lines, quote, by }) {}
export async function addLock(ctx, docId, { version, capture, note, by }) {} export async function removeLock(ctx, docId, lockId, { by }) {}
export async function relock(ctx, docId, lockId, { by }) {}
export async function revise(ctx, docId, input /* ReviseInput */) {}   // -> ReviseReport (refused => report.refused = true)
export async function reply(ctx, docId, tid, { body, status, at, decision }) {}
export async function ask(ctx, docId, { quote, lines, body }) {}       // agent-authored question thread
export async function reanchorThread(ctx, docId, tid, { lines, quote }) {}
export async function applySuggestions(ctx, docId, tids, { dryRun }) {} // -> { applied:[{id,lines}], conflicts:[{id,reason}] }
export async function taggedEdit(ctx, docId, { threads, oldString, newString, replaceAll }) {} // -> { lines }
export async function revert(ctx, docId, { hunk, lock }) {}
export async function recordReviewerVersion(ctx, docId, { summary, by }) {}
export async function applySuggestionAsReviewer(ctx, docId, tid, { by }) {} // requires clean working copy; creates a version
export async function feedback(ctx, docId, { peek, includeDrafts, allOpen }) {} // -> Packet (marks delivered unless peek)
export async function waitForFeedback(ctx, { docIds, timeoutMs, allowDirty, signal, onStart }) {}
//   -> {status:'delivered', packets} | {status:'timeout'} | {status:'closed'} | {status:'dirty', docId}
export async function changes(ctx, docId, { from, to }) {}            // Changes + threadLinks + per-hunk attribution
export async function sourceDiffOp(ctx, docId, { from, to }) {}
export async function threadMiniDiff(ctx, docId, tid) {}              // -> { version, before, after, words }
export async function domTargets(ctx, docId, ver) {}                  // -> { threads: DomTarget[], locks: DomTarget[] }
export async function log(ctx, docId) {} export async function show(ctx, docId, { thread, version, lines }) {}
export async function status(ctx, docId) {} export async function finalize(ctx, docId, { decisions, outDir }) {}
export async function closeSession(ctx, docId) {} export async function saveAttachment(ctx, docId, { dataUrl }) {}
// src/core/review/packet.js
export function formatPacket(packet) {} export function formatReviseReport(r) {} export function formatStatus(s) {}
export function formatLog(l) {} export function formatDiffStat(c) {} export function formatThread(t) {}
```
**WP4: surfaces**
```js
// src/cli/daemon-client.js
export async function ensureDaemon() {}   // -> { uiPort, contentPort, token, secret } (spawn + health poll <= 5 s)
export function reviewUrl(info, wsId, docId) {}
// src/daemon/main.js
export async function startDaemon({ foreground, uiPort, contentPort }) {}
// src/daemon/guest-bundle.js: reads src/guest/parts.json, concatenates the files in order inside "(function(){'use strict';\n...\n})();"
// src/mcp/server.js
export async function startMcp() {}
```

## 5. Storage

### 5.1 Workspace discovery
For a file, SpecReview looks for the workspace root in this order:
1. The nearest ancestor that contains `.specreview/`.
2. Otherwise the git toplevel (`git rev-parse --show-toplevel`, or walking up to a `.git` directory).
3. Otherwise the file's own directory.

`open` creates `.specreview/` at that root. Doc paths are stored workspace-relative in POSIX form. `--workspace <dir>` overrides the lookup.

### 5.2 Layout
```
<workspace>/
  docs/specs/token-service.md             the live spec (the working copy; the agent edits this)
  .specreview/
    config.json                           committed
    .gitignore                            runtime/  docs/*/drafts.json  docs/*/pending-edits.jsonl
    assets/sha256/44/44ab...e1.png        content-addressed asset snapshots (deduplicated)
    docs/token-service/
      doc.json
      versions/0001.md  0001.json         exact source bytes + manifest (the manifest is the commit point)
      versions/0002.md  0002.json
      threads/t1.json t2.json ...         one file per thread (merge-friendly)
      reviews/rv1.json ...
      locks/L1.json ...
      attachments/a1.png ...              region crops, pasted images
      drafts.json                         reviewer's unsent items (gitignored)
      pending-edits.jsonl                 tags from apply/edit since head (gitignored; cleared by revise)
    runtime/                              gitignored; safe to delete
      events/token-service.jsonl          append-only change feed (seq)
      waiters/token-service/81234.json    presence heartbeats ('_all' dir for wait --all)
      cache/render/token-service/v0002-<renderer>-<sha8>.json
      locks/                              proper-lockfile dirs
~/.specreview/   (SPECREVIEW_HOME)
  daemon.json  (0600)   workspaces.json   daemon.log
```
The first time it runs, `open` prints the recommended `.gitattributes` lines. It does not write them.
```
.specreview/assets/** binary
.specreview/docs/*/versions/* linguist-generated=true
```

### 5.3 JSON schemas
All files carry `"schema": 1`. They are written with sorted top-level keys, 2-space indent, LF and a trailing newline. Timestamps are ISO-8601 UTC. Line numbers are 1-based. Offsets are UTF-16 code units into the source string, decoded per 6.3.

**config.json**
```json
{"schema":1,
 "reviewer":{"name":"Eric"},
 "guards":{"enforceLocks":true,"maxRewriteRatio":0.5,"unexplainedDeletionLines":3,"unexplainedDeletion":"refuse",
           "writeHook":"deny","writeHookRatio":0.4},
 "anchoring":{"minScore":0.65,"minQuoteSim":0.6,"contextChars":32},
 "render":{"network":"allow","mermaid":true,"math":true,"highlight":true},
 "git":{"autoCommit":false},
 "assets":{"maxBytes":20971520}}
```
- `reviewer.name` defaults to `git config user.name`, then the OS username.
- `unexplainedDeletion` is one of `refuse | warn | off`.
- `writeHook` is one of `deny | warn | off`.
- `render.network` is one of `allow | block`.

**doc.json**
```json
{"schema":1,"id":"token-service","path":"docs/specs/token-service.md","format":"markdown",
 "title":"Token Service Implementation Spec","createdAt":"2026-10-10T13:55:02Z",
 "createdBy":{"kind":"agent","name":"claude"},
 "state":"in_review","head":2,"lastReviewedVersion":1,
 "final":null,
 "counters":{"thread":4,"comment":9,"review":1,"lock":1,"decision":0,"draft":7,"attachment":1}}
```
- `state` is one of `in_review | approved | closed`.
- When set, `final` is `{"version":3,"review":"rv3","at":"...","by":"Eric"}`.

**versions/0002.json**
```json
{"schema":1,"v":2,"parent":1,"file":"0002.md","sha256":"9c1e...","bytes":18233,"lines":215,
 "createdAt":"2026-10-10T14:09:40Z","author":{"kind":"agent","name":"claude"},
 "summary":"rv1: grace window, retry policy, figure caption","respondsTo":"rv1",
 "capturedBy":"revise",
 "assets":{"docs/specs/img/arch.png":"sha256:44ab..."},
 "stats":{"added":9,"removed":3,"hunks":4,"rewriteRatio":0.04},
 "hunks":[
  {"id":"h1","oldStart":42,"oldLines":2,"newStart":42,"newLines":5,"threads":["t1"],"linkedBy":"overlap","other":null},
  {"id":"h4","oldStart":12,"oldLines":1,"newStart":12,"newLines":1,"threads":[],"linkedBy":null,"other":"Bumped 'Last revised' date"}],
 "guards":{"errors":[],"warnings":[],"forced":false,"brokenLocks":[]},
 "git":{"commit":null}}
```
- `capturedBy` is one of `open | revise | ui-record | ui-apply`.
- `author.kind` is one of `agent | human | external`.
- `linkedBy` is one of `tagged | hint | overlap | null`.

**Anchor** (embedded in threads, drafts and locks; one per version)
```json
{"v":1,"kind":"text","state":"exact","mappedBy":"textmap",
 "src":{"start":2210,"end":2230,"startLine":42,"endLine":42,"text":"rotated on every use",
        "prefix":"Refresh tokens are ","suffix":", and the previous token is\ninval"},
 "quote":{"exact":"rotated on every use","prefix":"...32 chars of rendered text","suffix":"..."},
 "dom":{"s":{"srid":412,"o":19},"e":{"srid":412,"o":39}},
 "section":["3 Tokens","3.2 Token refresh"],
 "generated":false,
 "element":null,"region":null,"svg":null,"cell":null,"code":null,"media":null}
```
- `kind` is one of `text | element | cell | code | section | source | doc`.
- `state` is one of `exact | moved | edited | changed | orphaned` (see 7.6).
- `mappedBy` is one of `textmap | narrowed | raw-source | element | block | lines | override`.

Sub-target examples:
```json
"element":{"srid":530,"tag":"img","attrs":{"src":"./img/arch.png","alt":"System overview"},"assetSha256":"44ab...","label":"<img alt=\"System overview\">","ordinal":0},
"region":{"x":0.40,"y":0.10,"w":0.22,"h":0.20},
"svg":{"nodeId":"Gateway","label":"API Gateway"},
"cell":{"tableSrid":610,"row":2,"col":2,"rowKey":"refresh_token","colHeader":"TTL","text":"30d"},
"code":{"fromLine":3,"toLine":5,"lang":"ts"},
"media":{"t":42.0}
```

**threads/t1.json**
```json
{"schema":1,"id":"t1","doc":"token-service","type":"comment","severity":"blocking","status":"addressed",
 "createdIn":1,"createdBy":{"kind":"human","name":"Eric"},"review":"rv1",
 "anchors":{"1":{"...":"Anchor"},"2":{"...":"Anchor (state edited)"}},
 "override":null,
 "suggestion":null,
 "comments":[
  {"id":"c1","by":{"kind":"human","name":"Eric"},"body":"Rotation on every use breaks...","at":"2026-10-10T14:01:55Z","review":"rv1","version":1},
  {"id":"c5","by":{"kind":"agent","name":"claude"},"body":"Replaced rotate-every-use with...","at":"2026-10-10T14:09:40Z","version":2,"status":"addressed"}],
 "changes":[{"version":2,"hunk":"h1","linkedBy":"overlap"}],
 "attachments":[],
 "decision":null,
 "resolvedIn":null,"updatedAt":"2026-10-10T14:09:40Z"}
```
- `type` is one of `comment | question | suggestion | agent-question`.
- `severity` is one of `blocking | normal | nit`.
- `status` is one of `open | addressed | answered | declined | needs_input | resolved`.
- When set, `decision` is `{"id":"D1","text":"30 s reuse-detection grace window","version":2,"srcText":"...","at":"..."}`.
- When set, `override` is `{"version":3,"lines":[45,47]}` or `{"version":3,"quote":"..."}` with `"by":"agent|human"`.
- A suggestion thread adds:
  `"suggestion":{"mode":"text","version":1,"start":5120,"end":5150,"startLine":120,"endLine":120,"old":"The client MUST retry 3 times.","new":"The client MUST retry up to 5 times with exponential backoff (base 200 ms, full jitter).","status":"pending","appliedIn":null}`
  - `mode` is `text` (the exact slice) or `source` (whole lines).
  - `status` is one of `pending | staged | applied | conflict`.

**reviews/rv1.json**
```json
{"schema":1,"id":"rv1","version":1,"by":{"kind":"human","name":"Eric"},"verdict":"changes_requested",
 "body":"Good start. Section 7 is agreed - keep it.","markFinal":false,
 "newThreads":["t1","t2","t3","t4"],"replies":[{"thread":"t2","comment":"c11"}],"reopened":[],
 "resolved":[],"locksAdded":["L1"],"submittedAt":"2026-10-10T14:02:11Z",
 "deliveredTo":{"claude":"2026-10-10T14:02:12Z"}}
```
`verdict` is one of `comment | changes_requested | approved`.

**locks/L1.json**
```json
{"schema":1,"id":"L1","active":true,"note":"Agreed","createdIn":1,"by":{"kind":"human","name":"Eric"},
 "anchors":{"1":{"kind":"section","src":{"start":7310,"end":8902,"startLine":170,"endLine":196,"text":"..."},"section":["7 Rollout plan"],"state":"exact"}},
 "text":"<exact source slice at creation>","textSha256":"1f0e...",
 "breaks":[]}
```
Each entry in `breaks` is `{"version":4,"reason":"...","by":"claude","at":"..."}`. Breaking a lock sets `active:false` until the reviewer re-locks it.

**drafts.json**
```json
{"schema":1,"items":[
 {"id":"d3","kind":"thread","type":"comment","severity":"normal","anchor":{"...":"Anchor"},"body":"...",
  "suggestion":null,"attachments":["attachments/a1.png"],"updatedAt":"..."},
 {"id":"d4","kind":"reply","thread":"t2","body":"Caption still ambiguous","reopen":true,"updatedAt":"..."}]}
```

**pending-edits.jsonl** (one object per line)
```
{"at":"...","via":"apply","threads":["t3"],"newLines":[120,120],"beforeSha256":"...","afterSha256":"..."}
{"at":"...","via":"override","thread":"t2","lines":[90,91]}
```

**runtime/events/<doc>.jsonl**
```
{"seq":21,"at":"2026-10-10T14:02:11Z","type":"review.submitted","review":"rv1","verdict":"changes_requested"}
{"seq":22,"at":"2026-10-10T14:02:12Z","type":"review.delivered","review":"rv1","agent":"claude"}
{"seq":23,"at":"2026-10-10T14:09:40Z","type":"version.created","v":2,"author":"agent:claude"}
```
Event types: `doc.opened, version.created, review.submitted, review.delivered, thread.updated, lock.changed, drafts.changed, doc.approved, session.closed`.

**runtime/waiters/<doc>/<pid>.json**: `{"pid":81234,"agent":"claude","since":"...","heartbeatAt":"..."}`. A waiter counts as live when its heartbeat is less than 30 s old and `process.kill(pid, 0)` succeeds.

### 5.4 Write protocol and crash safety
- **Atomic file:** write `<f>.tmp-<pid>-<rand>`, fsync, rename, then fsync the directory (best effort). JSON is never edited in place.
- **Lock:** `proper-lockfile` on `runtime/locks/<docId>` with `{stale:15000, update:5000, retries:{retries:60, minTimeout:50, maxTimeout:250}}`. Every op in `ops.js` takes it once and does all reads and writes inside it.
- **Version commit:**
  1. Asset blobs (content-addressed and idempotent; re-hashed before rename).
  2. `versions/NNNN.<ext>`.
  3. `versions/NNNN.json`. This is the **commit point**.
  4. `doc.json.head`.

  Recovery (`recovery.js`, run by `Store.open`):
  - A source file with no manifest is deleted.
  - `head` is set to the highest manifest present.
  - Stray `.tmp-*` files are removed.
- **Review submit:** allocate ids and save `doc.json`, write the new thread files, then write `reviews/rvN.json` (the **commit point**), then remove the submitted drafts. Recovery deletes thread files whose `review` has no file; their drafts still exist, so nothing is lost.
- **Delivery:** the review is marked delivered only after stdout has flushed (`process.stdout.write(text, cb)`). A killed `wait` therefore re-delivers on the next run.
- **Working-copy writes** (`apply`, `edit`, `revert`, UI apply) use compare-and-swap. The file is re-read, its sha256 must equal the expected value, the new content is written atomically, and the file mode is preserved. Up to 3 retries, then a conflict.

### 5.5 Git policy
- `.specreview/` is designed to be committed. Snapshots, threads and reviews are small text files with sequential names.
- `git.autoCommit` is off by default. When it is on, `revise` and the UI record actions run:
  ```
  git add -- <doc> .specreview/docs/<id> .specreview/assets
  git commit -m "spec(<id>): v3 - <summary> [t1 t2]" -- <same paths>
  ```
  This happens only when the workspace is a git repo. It commits only those paths and never pushes.
- A "git-mirror" branch with one commit per version, built with plumbing commands only, is planned for v1.1.

## 6. Rendering

### 6.1 Serving model
- The doc URL is `http://127.0.0.1:4778/c/<secret>/<wsId>/<ver>/<workspace-relative path>`, where `ver` is `v3` or `live`.
- The doc is served at its real relative path, so `./img/arch.png`, `../shared/x.css` and `<script src="app.js">` resolve without `<base>` injection.
- **Historical versions:** the doc comes from its snapshot, and assets come from that version's manifest blobs, falling back to the live file. **`live`:** the working copy, freshly rendered, read-only in the UI.
- **Root-absolute URLs** (`/img/a.png`): any content-origin GET outside `/c/` uses the `Referer` header (`/c/<secret>/<ws>/<ver>/...`) to resolve against that workspace root. With no Referer, it returns 404.
- **Response headers:**
  - `Content-Type` with the detected charset (BOM, then a `<meta charset>` prescan of the first 1024 bytes, else UTF-8);
  - `Cache-Control: no-store`;
  - `X-Content-Type-Options: nosniff`;
  - `Content-Security-Policy: frame-ancestors http://127.0.0.1:<uiPort> http://localhost:<uiPort>`;
  - with `render.network:"block"`, also `default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'`.

### 6.2 Markdown pipeline (`render/markdown.js`, exact order)
```
unified()
  .use(remarkParse)
  .use(remarkGfm)                          // tables, task lists, footnotes, strikethrough, autolinks
  .use(remarkFrontmatter, ['yaml','toml'])
  .use(remarkMath)
  .use(remarkSrFrontmatter)                // ours: yaml/toml node -> code node (lang yaml, meta 'sr-frontmatter'), position kept
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)                          // raw HTML becomes real nodes with positions (parse5)
  .use(rehypeSrPrepare)                    // ours, see below
  .use(rehypeKatex)                        // server-side KaTeX HTML+MathML
  .use(rehypeHighlight, { detect: false }) // highlight.js (lowlight), language from fence info only
  .use(rehypeSlug)
  .use(rehypeSrStamp, { out })             // ours: data-srid, SrcMap, TextIndex, outline, assets (last)
  .use(rehypeStringify)
```
`rehypeSrPrepare` does four things:
1. A `pre>code.language-mermaid` becomes `<pre class="mermaid" data-sr-kind="mermaid">source</pre>`, keeping its position.
2. Math elements (`code.math-inline` / `pre>code.math-display`) are wrapped in `<span|div class="sr-math" data-sr-kind="math">`, with the position copied. This is needed because KaTeX output carries no positions (verified).
3. Every `pre` with a positioned `code` gets `data-sr-kind="code"`, and its verbatim mapping is recorded as `{contentStart, contentEnd, firstLine}`: the content starts after the opening fence line and ends before the closing fence. Container indentation and blockquote prefixes are handled per line.
4. The front-matter code block is wrapped in `<details class="sr-frontmatter" open><summary>Front matter</summary>…</details>`.

**Shell** (`render/shell.js`): the Markdown output is wrapped in a full HTML page.
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="__SR_ASSET_BASE__/vendor/github-markdown-css/github-markdown-light.css" media="(prefers-color-scheme: light)" data-sr-theme="light">
<link rel="stylesheet" href="__SR_ASSET_BASE__/vendor/github-markdown-css/github-markdown-dark.css" media="(prefers-color-scheme: dark)" data-sr-theme="dark">
<link rel="stylesheet" href="__SR_ASSET_BASE__/vendor/highlight.js/styles/github.css" media="(prefers-color-scheme: light)" data-sr-theme="light">
<link rel="stylesheet" href="__SR_ASSET_BASE__/vendor/highlight.js/styles/github-dark.css" media="(prefers-color-scheme: dark)" data-sr-theme="dark">
<!-- if math --><link rel="stylesheet" href="__SR_ASSET_BASE__/vendor/katex/katex.min.css">
<link rel="stylesheet" href="__SR_ASSET_BASE__/static/shell.css">
</head><body><article class="markdown-body">...rendered...</article>
<!-- if mermaid --><script src="__SR_ASSET_BASE__/vendor/mermaid/mermaid.min.js"></script><script src="__SR_ASSET_BASE__/static/mermaid-init.js"></script>
</body></html>
```
- `guestInsertAt` is the offset just after `<head>`.
- At serve time, the daemon replaces the literal `__SR_ASSET_BASE__` (Markdown shells only) with `http://127.0.0.1:<contentPort>/c/<secret>/__sr`.
- `mermaid-init.js` runs:
  ```js
  mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme: dark ? 'dark' : 'default'})
  ```
  then `mermaid.run({querySelector:'pre.mermaid'})`. If a diagram fails, its error and source are shown in place.
- If `github-markdown-css` lacks the light/dark files, fall back to `github-markdown.css`.
- Raw HTML and `<script>` inside Markdown run as written: the doc runs on the isolated origin.

### 6.3 HTML pipeline (`render/html.js`): byte splice, never re-serialise
1. **Decode** to a JS string, using the charset rule in 6.1. All offsets are computed on this string.
2. **Parse** with `parse5.parse(src, {sourceCodeLocationInfo: true})`. Its tree matches the browser's pre-script DOM (verified: implied `tbody`, self-closing SVG).
3. **Stamp** ` data-srid="n"` into each eligible element's original start tag.
   - **Eligible:** the element has a `sourceCodeLocation.startTag`, is not inside `<head>`, is not `script/style/template/noscript/title`, and does not already have `data-srid`.
   - **Insertion point:**
     - If the start-tag text ends with `/>`:
       - If the last attribute is **unquoted** and ends just before the `/`, the slash belongs to the value. For HTML elements, insert just before `>`. For foreign (SVG/MathML) elements, **skip stamping**.
       - Otherwise insert just before the `/`.
     - Otherwise insert just before the final `>`.
   - Splices are applied from the highest offset down, so earlier offsets stay valid.
   - Removing every inserted ` data-srid="n"` must give back the original string. A test asserts this.
4. **Guest insertion point** (`guestInsertAt`): just after the `<head…>` start tag. If there is none, just after `<html…>`. If there is none, just after the doctype. Otherwise at 0 (after any BOM). It is never placed before the doctype, so quirks/standards mode is preserved.
5. **Asset references:** `img[src|srcset]`, `source[src|srcset]`, `video[src|poster]`, `audio[src]`, `link[href]`, `script[src]`, `object[data]`, `embed[src]`, `iframe[src]`, and CSS `url()` in style attributes, `<style>` blocks and linked local CSS (one level). Local and root-absolute paths that resolve inside the workspace go into `assets`. `http(s)` URLs go into `externals`.
6. **`stamp:false`** (pristine mode, `?pristine=1`) skips step 3. Anchoring then falls back to quote search (see 6.6).

### 6.4 SrcMap and TextIndex (built by `rehypeSrStamp` / `html.js`)
**SrcMap:**
```js
{ order: [srid...],
  nodes: { [srid]: { t: 'p', s: 2190, e: 2297, ls: 42, le: 43, p: parentSrid|0, b: isBlock,
                     k: kind?, h: {level, text}?, a: {id, src, alt, href, class, poster, data}?,
                     c: {contentStart, contentEnd, firstLine}? } } }
```
- `kind` is one of `code|math|mermaid|frontmatter|table|tr|cell|img|svg|media|embed|heading`.
- srids are assigned in document order starting at 1, to every element that has a source position. For Markdown that means positioned hast elements; for HTML, every stamped element.

**TextIndexData** is a single global text stream:
```js
{ text: "...",                       // concatenation of text nodes in document order (raw, not normalised)
  runs: [[tStart, len, sStart, flag], ...],   // flag 0 aligned-exact, 1 approximate, 2 verbatim(code), 3 atomic
  spans: { [srid]: [tStart, tEnd] } }  // contiguous text range covered by each srid's descendants
```
The stream excludes text under `TEXT_EXCLUDE`, using the same rule as the guest:
- tags `script style noscript template textarea title`;
- class `katex-mathml`;
- attribute `data-sr-ignore`;
- `data-sr-kind="mermaid"`;
- for HTML docs, `<head>`.

**Aligner** (`text/align.js`): maps a text node's value to its source range `[ns, ne)` character by character.
```
p = ns
for i, ch in value:
  repeat at most 16 times:
    if src[p] == ch                         -> map(i, p); p++; next char
    if md && src[p]=='\\' && src[p+1]==ch   -> map(i, p+1); p += 2; next char
    if src[p]=='&' and an entity at p decodes to a string starting with ch -> map(i, p); p += entityLen; next char
    if isSpace(ch) && isSpace(src[p])       -> map(i, p); p++; next char
    p++                                     // skip markup: `, *, _, [, ](url), '>' / indentation after '\n', '\r'
  if the repeat budget is exhausted          -> map the rest of the node proportionally over [p, ne) with flag 1; stop
```
Special cases:
- Inline `code` text positions include the backticks (verified); the aligner skips them.
- Text nodes with no position inside a `k:code` element use the verbatim per-line map (flag 2): code line `i` maps to source line `firstLine + i`, column = indexOf(lineText) within that source line.
- Other text nodes with no position (KaTeX internals, generated footnote back-references) are flag 3. They map to the nearest positioned ancestor's whole range.

**Outline:** headings in order, as `{srid, level, text, line, id}`.

### 6.5 Guest and vendor assets
- The guest tag inserted at `guestInsertAt` is:
  ```html
  <script src="http://127.0.0.1:4778/c/<secret>/__sr/guest.js" data-sr-ui="http://127.0.0.1:4777 http://localhost:4777" data-sr-target="<ws>/<doc>/<ver>" data-sr-ignore></script>
  ```
  The URL is absolute so a doc's own `<base href>` cannot redirect it. It is a classic synchronous script that only installs listeners and does its work on `DOMContentLoaded`.
- Content-origin `/c/<secret>/__sr/` routes:
  - `guest.js` (the concatenated bundle);
  - `static/*` from `src/core/render/static/`;
  - `vendor/*` through `VENDOR_DOC`.
- The UI origin serves `/vendor/*` through `VENDOR_UI` and `/ui/*` from `src/ui/` (subresources only, never documents; see 12.4).

### 6.6 Fidelity rules
- The iframe has:
  ```html
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
  allow="clipboard-write; fullscreen"
  referrerpolicy="no-referrer"
  ```
  It has no top-navigation permission.
- **CSP in the doc:** if the doc's own CSP meta blocks the guest (no `hello` within 3 s), the UI shows "Annotations are blocked by this document's Content-Security-Policy" with two options:
  - **[Serve without its CSP meta]** reloads with `?nocsp=1`, which strips `<meta http-equiv=Content-Security-Policy>` at serve time;
  - **[Review in Source view]**.
- **Pristine mode** (`?pristine=1`, a UI toggle) serves the file without `data-srid`. The guest then sends captures with no srid. The server anchors them by quote search over the whole TextIndex (`mappedBy: raw-source`). Use this for pages whose scripts are sensitive to attributes.
- **External resources** load as authored when `network` is `allow`. The guest reports failures (resource `error` events in the capture phase, plus PerformanceObserver). The UI shows a badge: "2 external resources failed (offline?)". `open` lists the external hosts the doc references.

### 6.7 Cache and performance
- Render results are cached as JSON at `runtime/cache/render/<doc>/v<NNNN>-<RENDERER_VERSION>-<sha8>.json`. `live` renders are cached in memory by sha256.
- Expect about 30-60 ms for a 200 KB spec.
- Mermaid is loaded only when the doc has a diagram.

## 7. Anchoring

### 7.1 Anchor kinds and capture
| Target | Reviewer gesture | Capture (guest to server) | The agent sees |
|---|---|---|---|
| Text, including across blocks | Select, then `c`, `s` or `q` | `text:{startSrid,startOffset,endSrid,endOffset,exact,prefix,suffix}` (offsets relative to each srid's text span) | `L42-43 §3.2` plus `on:` and `src>` lines |
| Image or picture (whole) | `e`, then click | `element:{srid,tag,attrs,label}` | `L88 <img alt="System overview">` plus the source line |
| Region of an image, SVG, canvas, video or iframe | `e`, then shift-drag | element plus `region:{x,y,w,h}` (fractions of the stamped element's border box), plus a crop PNG where possible | `region x40-62% y10-30%` and `crop: <path>` |
| Any area of the doc (text, images, diagrams, a mix) | `b`, then drag a box | `snip:{srids,startSrid,endSrid,containerSrid,region,text,label}` (protocol.js SNIP) plus a PNG of exactly the boxed area; stored as anchor kind `snip` | `snip (figure + 2 paragraphs)`, the covered blocks' `src>` lines and `image: <path>` |
| Anything on the reviewer's screen | `B` (macOS `screencapture -i`), or `specreview snip` | the current selection's capture, else `doc` | `GENERAL` (or the selection's anchor) and `image: <path>` |
| Inline SVG child (authored) | `e`, hover; `[` and `]` walk ancestors; click | the element's own srid | the exact source lines of that `<g>` or `<rect>` |
| Mermaid node (generated) | `e`, click a node | element (srid of `pre.mermaid`, `generated:true`) plus `svg:{nodeId,label}` | `mermaid node "Gateway"` narrowed to the fence line containing the node |
| Table cell, row or column | `e`, click a cell; a chooser offers cell, row, column or table | `cell:{tableSrid,row,col,rowKey,colHeader,text}` (rowspan/colspan-aware grid) | `table cell row "refresh_token" x col "TTL"` plus the row's source line |
| Code lines | Hover the `pre` gutter, click or shift-click; or select text | `code:{srid,fromLine,toLine}` (1-based within the block) | the exact source lines |
| Math | A selection inside `.sr-math` / `.katex` snaps to the element | element (`k:math`) | `L33 math` plus `src> $E=mc^2$` |
| Video or audio | `e`, click | element plus `media:{t}` | `<video src=demo.mp4> at 0:42` |
| Section | Outline item: "Comment on section", "Mark agreed" | `section:{headingSrid}` | `§7 Rollout plan (L170-196)` |
| Source lines | Source view: select lines, then `c` | `source:{startLine,endLine,version}` | the exact lines (for head meta, script config, attributes) |
| Whole doc | Review summary, or "General comment" | `doc` | `GENERAL:` |
| Script-generated text | Select | text capture with the nearest srid ancestor; the server finds the quote does not verify | `L200-240 (script-rendered inside <div id="chart">)` |

### 7.2 Resolving a capture (server, `anchor/create.js`)
**Text:**
1. **Verify.** `g0 = span(startSrid)[0] + startOffset` and `g1 = span(endSrid)[0] + endOffset`. If `normalizeWs(text.slice(g0,g1)) == normalizeWs(exact)`, the selection is verified.
2. **If not verified,** search for `exact`:
   - inside `span(startSrid)`;
   - then in the whole stream nearest to `g0`, scored by prefix/suffix;
   - if still not found, the content is **generated** (go to step 5).
3. **Source range.**
   - `srcStart = textToSource(g0).off`.
   - `srcEnd = textToSource(g1-1).off + 1`, extended to the end of any entity or escape.
   - If either end falls in a flag 1 or flag 3 run, set `mappedBy: block` and widen to the deepest enclosing element's `[s,e]`. Otherwise `mappedBy: textmap`.
4. **Fill in the anchor:**
   - `src.text` = the source slice;
   - `src.prefix/suffix` = 32 source characters on each side;
   - lines from `lineIndex`;
   - `quote.prefix/suffix` = 32 normalised rendered characters (`context`);
   - `section` = the heading chain before `srcStart`;
   - `dom` = `{s, e}`.
5. **Generated content.** Let C be the nearest srid ancestor of the selection.
   1. **Narrowing:** whitespace-normalised search for `exact` inside C's source slice, case-sensitive then case-insensitive. A hit gives `mappedBy: narrowed`.
   2. **Raw source:** a unique occurrence anywhere in the source gives `raw-source`. This catches text built from template literals or `innerHTML`.
   3. **Otherwise** use C's whole range: `block`, `generated: true`.

**Element:** `src` = the srid's `[s,e]`. `element.attrs` comes from the SrcMap. `assetSha256` is the hash of the referenced local file (images). `ordinal` = the index among same-tag elements in the same section.

**Mermaid node:** inside the fence lines, search for `\b<nodeId>\b`, then the label text. Narrow `src` to the matching line(s). If neither matches, use the whole fence.

**Cell:**
- `src` = the cell element's range: Markdown `td`/`th` have positions (verified), and HTML cells have srids.
- `lines` = the row line(s).
- `rowKey` = the first cell's text; `colHeader` = the header row's text in that column.

**Code:** Markdown source lines are `c.firstLine + fromLine - 1` through `c.firstLine + toLine - 1`. For HTML `<pre>`, count newlines from the content start, applying the parser rule that drops a leading newline.

**Section:** from `heading.s` to the start of the next heading of the same or higher level, or EOF.

**Source:** offsets come straight from the line numbers.

The composer preview returns `{label, lines, section, src (at most 3 lines)}`, for example "Agent will see: L42-43 §3.2 'rotated on every use'". **[Widen to block]** re-resolves the anchor as the deepest block element.

### 7.3 Painting (guest; observe-only)
- **Text highlights** use the CSS Custom Highlight API. Highlights: `sr-open`, `sr-resolved`, `sr-active`, `sr-draft`, `sr-ins`, `sr-lock`. Their `::highlight()` styles live in one constructed stylesheet appended to `document.adoptedStyleSheets`, which is re-checked on each update. No DOM node is added for this.
  - **Fallback** when `CSS.highlights` is missing: draw `Range.getClientRects()` boxes in the overlay.
  - **Hit-testing:** `caretPositionFromPoint` (or `caretRangeFromPoint`) plus `Range.isPointInRange`.
- **The overlay** is one `<sr-overlay data-sr-ignore>` appended to `<html>`.
  - It has a closed shadow root, `all: initial`, and `popover="manual"` plus `showPopover()` so it sits in the top layer. It is shown again after the page opens a modal. Without popover support it falls back to `position: fixed` with the maximum z-index.
  - It holds: element outlines, region boxes, numbered margin pins, the selection mini-toolbar, the picker hover box and breadcrumb, code-gutter "+" buttons, change bars, deletion tabs and popovers, and lock brackets.
  - `pointer-events: none`, except on interactive children.
- **Resolving anchors in the DOM:** for each DomTarget, find `[data-srid="n"]` and walk its text nodes with the shared `TEXT_EXCLUDE` rule to build a Range from `{srid, o}` pairs. Check that `Range.toString()` matches `quote` after whitespace normalisation. If it does not, search for the quote inside the element, then in the whole document. If that fails, report `missing`.
  - Element targets use the srid. Regions are drawn as fractions of `getBoundingClientRect` (or `getBBox` plus `getScreenCTM` for SVG children).
  - Mermaid nodes are found by `data-id`, then by the id pattern `^[a-z]+-(.+)-\d+$`, then by label text, after mermaid has rendered.
- **Positions** are posted to the UI, throttled with rAF. Triggers:
  - `scroll` (capture phase), `resize`;
  - `ResizeObserver`;
  - a `MutationObserver` debounced to 100 ms (mermaid rendering, tabs, lazy images);
  - `document.fonts.ready`.

  A target is `hidden` when `checkVisibility()` is false.
- **Reveal:** focusing a hidden thread opens its ancestor `<details>`. Failing that, it clicks the controlling tab: an element whose `aria-controls` or `href="#id"` points at a hidden ancestor. Otherwise the card offers **View in source**.
- **Crops:**
  - img (same-origin) and canvas: `drawImage` of the region into a canvas, then PNG (at most 1024 px).
  - svg: serialise, rasterise through `Image`, then crop.
  - Tainted canvases skip the crop silently.

### 7.4 Re-anchoring (server, `anchor/reanchor.js`)
This runs inside `revise`, `recordReviewerVersion`, `applySuggestionAsReviewer` and draft submission (drafts made on older versions). It covers every thread, every lock, and drafts at submit time. It steps forward one version at a time: `anchors[a]` becomes `anchors[a+1]`.

```
input: A = anchors[a]; hunks = lineHunks(src_a, src_b); M = offsetMapper; link = attribution(thread, b)
0. override for b (thread.override or a pending 'override' edit) -> anchorFromLines/Quote -> state 'exact', mappedBy 'override'
1. link: if the thread is linked to hunks in b:
     R = union of the linked hunks' new line ranges (whole lines)
     m = fuzzyFind(src_b restricted to R, A.src.text, {prefix,suffix})
     anchor = m ? m : R ;  state 'edited'
2. untouched: if no hunk's old range intersects [A.src.startLine, A.src.endLine]:
     start' = M.mapOffset(A.src.start); verify src_b.slice(start', start'+len) == A.src.text
     state = (line unchanged ? 'exact' : 'moved')
3. exact elsewhere: candidates = all indexOf(A.src.text) in src_b;
     score = (50*1 + 20*sim(prefix) + 20*sim(suffix) + 2*proximity(hint)) / 92 ; hint = M.mapOffset(start)
     best score >= minScore -> state 'moved'
4. fuzzy: approx-string-match search(window, text, maxErrors = min(256, floor(0.4*len)))
     window = [hint - (2*len + 2000), hint + (2*len + 2000)], then the whole source
     quotes longer than 256 chars: search the first 64 and last 64 chars; join spans that are 0.5x-1.5x the original length
     quoteSim = 1 - errors/len ; score = (50*quoteSim + 20*prefixSim + 20*suffixSim + 2*proximity)/92
     accept if score >= config.minScore (0.65) && quoteSim >= config.minQuoteSim (0.6) -> state 'changed'
5. if still nothing: try steps 3-4 using the thread's ORIGINAL anchor (anchors[createdIn]) against src_b
6. else 'orphaned' (keep lastKnown = previous anchor)
after success: recompute quote, dom, section, lines from render_b (sourceToText); element anchors re-verify the fingerprint
```
- **sim()** is normalised similarity: 1 - levenshtein/maxLen on at most 32 characters.
- **proximity** = `max(0, 1 - |pos - hint| / max(len(src_b), 1))`.
- **Element anchors:** map `src` first using steps 1-4. Then require an element in b with the same tag whose range overlaps the mapped range. If there is none, score same-tag elements:
  ```
  0.4*idEqual + 0.25*attrSim(src, href, alt, class) + 0.25*contentSim(asset hash, text) + 0.1*context(section, ordinal)
  ```
  Accept at 0.5 or above. If `assetSha256` changed, mark `changed` with `assetChanged: true`; a region is then drawn with a "drawn on the previous image" badge.
- **Cells:** re-find the table element, then the row by `rowKey` (exact, then fuzzy, then index), then the column by `colHeader`, then index.
- **Sections and locks:** heading text (fuzzy) plus level. The extent is recomputed. A lock keeps its `text` for `revert --lock`.

### 7.5 Packet line numbers come from the working copy
Packets are printed against the file on disk:
- `head` anchors are mapped through `offsetMapper(head, working)`;
- the header says `Line numbers = current file on disk (identical to vN)`, or `(working copy differs from vN: lines mapped)`;
- `src>` lines are read from the working copy.

`src` is always made of **full source lines**, extended by whole lines until the string is **unique** in the file (`srcUnique: true`). Anything longer than 8 lines is shortened to the first 3 lines, `...(N more lines)`, and the last line, with `srcUnique: false`.

### 7.6 States
| Anchor state | Meaning | UI | Packet |
|---|---|---|---|
| `exact` | Same text, same lines | normal | lines |
| `moved` | Same text, different place | "moved" chip | lines |
| `edited` | Changed by a linked hunk | "Addressed in vN" when the agent replied `addressed` | lines of the new text |
| `changed` | The quoted text was edited without a link (like GitHub's "outdated") | "Outdated" chip; card shows "was ... now ..." | `(outdated: text changed)` |
| `orphaned` | Not found | Orphan tray under its last known section: **[Move here] [Keep as general] [Resolve]** | `(orphaned: was "..." in §5 v1 L260; reanchor with specreview reanchor)` |

Threads are never deleted. Resolved threads are re-anchored too, so "show resolved" works on any version.

## 8. Versions, attribution, guards and diffs

### 8.1 Recording a version
- **`revise`:**
  1. Lock the doc.
  2. Do a stable read of the working copy. If it equals head and there are no replies, report "nothing to record" and exit 0. If it equals head and there are replies, post the replies only.
  3. Compute hunks, attribution and guards.
  4. If refused, stop. With `--dry-run`, print the report and stop.
  5. Snapshot the assets.
  6. Commit the version.
  7. Re-anchor every thread and lock.
  8. Post the replies.
  9. Mark staged suggestions `applied` (an addressed thread with no reply gets the auto reply "Applied the suggestion verbatim.").
  10. Clear `pending-edits`.
  11. Append `version.created`.
  12. Run git autoCommit if enabled.
- **Asset snapshot:** each local asset (6.3 step 5, or Markdown image and link URLs) is hashed into `assets/`. Assets larger than `assets.maxBytes` are recorded as `"live"`.
- **The review entry file is the only diffed source.** Changed linked assets (CSS, JS, images) appear in the changes list as "asset changed" from manifest hash comparison.

### 8.2 Hunks
`lineHunks(a,b)` uses jsdiff `structuredPatch(…, {context: 0})`, converted to **half-open, 1-based** ranges:
- old lines `[oldStart, oldStart+oldLines)`, new lines `[newStart, newStart+newLines)`;
- a pure insertion has `oldLines = 0` and `oldStart` = the old line it is inserted before;
- ids are `h1..hN` in file order, and are deterministic for a given pair of texts.

`offsetMapper` shifts offsets in unchanged regions by the cumulative delta. Offsets inside a hunk map to the hunk's new start and report `hunk`.

### 8.3 Attribution (`review/attribution.js`)
For each hunk of `head` to `working`, try these in order:
1. **tagged:** a `pending-edits` entry from `apply` or `edit` whose `newLines` overlap the hunk's new range.
2. **hint:** a manifest `threads[t].at` range (lines of the new file, e.g. `L90-91` or `L12,L90-91`) that overlaps.
3. **overlap:** an actionable thread whose head anchor lines, widened by 1, intersect the hunk's old range.
4. **unlinked:** the hunk must be explained by an `other[]` entry. `at:"L12"` overlaps the new lines; `at:"del:h6"` names the hunk id. Otherwise it is reported.

### 8.4 Guards (`review/guards.js`)
| Check | Default | Override |
|---|---|---|
| A hunk's old range intersects an active lock's head anchor lines | **refuse** | `--break-lock L1="reason"`, which records a break, sets the lock inactive and shows a red badge |
| An unlinked, unexplained hunk with net removed lines (oldLines - newLines) at or above `unexplainedDeletionLines` (3) | **refuse** | `other` entry, `revert --hunk`, or config |
| `rewriteRatio = Σ max(oldLines,newLines) / max(1, headLines)` above `maxRewriteRatio` (0.5) | **refuse** | `--allow-rewrite` (the user asked for a rewrite) |
| An actionable thread with no manifest entry | warn | |
| A thread marked `addressed` with no linked hunk | warn | add `at` |
| A thread anchored on an image, marked addressed, whose asset bytes did not change | warn ("re-render the image?") | |
| A decision's anchor intersects a hunk not linked to that thread | warn ("decision D2 region modified") | |
| `--force` | overrides every refusal; recorded in `guards.forced`; red badge in the UI | |

`--dry-run` prints the full report and records nothing. A refusal exits 3 and leaves the working copy untouched.

### 8.5 Changes payload (`GET /api/.../diff?from=&to=`, `ops.changes`)
```json
{"from":1,"to":2,"stats":{"added":9,"removed":3,"hunks":4,"blocksChanged":5},
 "hunks":[
  {"id":"h1","op":"mod","old":{"start":42,"lines":2},"new":{"start":42,"lines":5},
   "srids":[412,413],"section":["3 Tokens","3.2 Token refresh"],
   "words":[{"s":{"srid":412,"o":24},"e":{"srid":412,"o":61}}],
   "deleted":{"text":"rotated on every use","html":null},
   "insertBefore":null,"threads":["t1"],"linkedBy":"overlap","other":null},
  {"id":"h5","op":"del","old":{"start":201,"lines":14},"new":{"start":199,"lines":0},
   "srids":[],"insertBefore":{"srid":702},"deleted":{"lines":14,"html":"<h2>8 Open questions</h2>...","text":"..."},
   "threads":[],"linkedBy":null,"other":"Merged into section 6"}],
 "assets":[{"path":"docs/specs/img/arch.png","from":"sha256:44ab...","to":"sha256:77c0..."}],
 "threadLinks":{"t1":["h1"]},
 "guards":{"forced":false,"brokenLocks":[]}}
```
- `op` is `add` (oldLines 0), `del` (newLines 0) or `mod`.
- `srids` are the **deepest block elements** (`b` true, with no block descendant intersecting) whose `[ls,le]` intersect the new range.
- `words` comes from `wordDiff(oldSlice, newSlice)`: inserted segments are mapped through `sourceToText`, and segments that map to no text (markup only) are dropped.
- `deleted.html` comes from `renderFragment` for Markdown. HTML docs get `text` only.
- `insertBefore` = the first block that starts at or after `new.start`.
- `threadLinks` and `other` come from the `to` version's manifest when the two versions are adjacent. For a multi-version span, they are the union of the manifests in the span, with each hunk linked by line overlap.

### 8.6 Rendered changes overlay (Changes mode)
The `to` version renders **live and interactive**. The guest draws:
- a 3 px left bar on each element in `srids`: green for `add`, amber for `mod`;
- `sr-ins` highlights on `words`;
- a "⊖ N lines removed" tab before `insertBefore`, which opens a popover with `deleted.html` (rendered inside the shadow root) or `deleted.text` as monospace text;
- a badge on each bar: `t1` for a linked thread, or an orange `other` badge whose hover shows the reason.

The UI lists changes grouped by section. `n`/`p` navigate (`scrollTo {hunk}`), and a "seen" checkbox per change is stored in UI localStorage.

Script-generated regions cannot be diffed by source. Their container gets a "changed (source lines L...)" bar.

### 8.7 Source diff (Source mode)
`sourceDiff(a,b)` returns rows:
```
{hunks:[{id, header, rows:[{op:' '|'-'|'+', oldNo, newNo, text, words:[[start,end,'ins'|'del']]}]}]}
```
The UI renders them as a unified table or a two-column table with word highlights, hunk ids and thread chips. With no base it shows plain numbered source. Selecting lines and pressing `c` creates a `source` anchor.

### 8.8 "Since my last review", Verify and the mini-diff
- `doc.lastReviewedVersion` = the version of the newest submitted review. `doc.acceptedVersion` (absent until then) = the newest version whose revisions the reviewer accepted all at once (**Accept all revisions**: it also resolves the Verify queue's addressed and answered threads; Undo restores both). "Since your last review" starts at the newer of the two.
- When `head` is newer than that, the UI opens in Changes mode with that base and shows the banner (the reviewer's **Default view** setting can open docs in Read or Review instead). A "Show changes" switch in the top bar turns Changes on and off from Read and Review. The base picker offers "your last review", "previous version", or any vN. Any pair vA to vB, or vN to live, is allowed.
- **Verify queue:** threads with status `addressed`, `answered` or `declined` that have no newer reviewer comment. Keys: `j`/`k` move, `x` accepts (resolves, optionally recording a decision), `o` reopens with a reply draft, `y` accepts a decline.
- **Mini-diff on each card:** `threadMiniDiff` returns the word diff between the thread's anchored source at the version where the comment was made (or last delivered) and its anchored source at head, clipped to 6 lines, plus "View in Changes".

### 8.9 History, final, decisions, revert
- **History** is a timeline that interleaves versions and reviews. Each version row shows:
  - id, author, time, summary, and the review it responds to;
  - thread chips and +/- stats;
  - guard badges: `lock broken`, `forced`, `large rewrite`.

  Row actions: **View** (renders that version read-only with its own anchors), **Diff vs previous**, **Compare with...** (Changes mode with that pair).
- **Final:** an `approved` review with `markFinal` sets `doc.state="approved"` and `doc.final`, and appends `doc.approved`.
  - The UI shows a **FINAL vN** badge, and "newer unapproved changes exist" if head is past final.
  - `final` checks that the working copy equals final, then writes `<name>.decisions.md` if `--decisions` was given.
  - A later revise sets `state` back to `in_review`; `final` stays as history.
- **decisions.md** contains, for each decision and resolved thread: the decision, the quoted context, the resolution (agent reply), and the version and hunk.
- **Revert:**
  - `revert --hunk hN` reverses one head-to-working hunk in the working copy.
  - `revert --lock L1` writes `lock.text` back over the lock's mapped range.
  - In the UI, **Ask to revert** on a change creates a `comment` thread with the old text, which the agent executes deterministically.

## 9. Agent interface

### 9.1 Conventions
- **`<doc>`** accepts a doc id or a file path. The workspace is found from the cwd or the path.
- **Output:** compact text by default; `--json` gives the same data structured.
- **Line numbers** are always 1-based lines of the **current working file**.
- **Exit codes:** 0 ok or delivered (any verdict) · 1 error or usage · 2 wait timeout · 3 refused (guard, dirty working copy, conflict, not unique) · 4 doc or thread not found · 5 session closed.
- **Agent name:** `--as <name>`, else `$SPECREVIEW_AGENT`, else `claude` if `$CLAUDECODE` is set, else `agent`.
- **Environment:** `SPECREVIEW_HOME`, `SPECREVIEW_PORT` (UI port; content port = UI port + 1).

### 9.2 CLI reference (bin `specreview`)
| Command | Behaviour | Exit |
|---|---|---|
| `open <file...> [--title T] [--browser pane\|system\|none] [--json]` | Tracks the doc and records v1 if it is new. Ensures the daemon is running. Prints the URL, and a warning if the working copy is dirty. | 0 |
| `wait [<doc>] [--all] [--timeout 0\|30m] [--allow-dirty] [--allow-unanswered] [--json]` | Exits 3 at once if the working copy differs from head (prints `run specreview revise` first), unless `--allow-dirty`; and while a thread this agent received has no reply on it (it is still open, or the reviewer spoke last), unless `--allow-unanswered`: answers belong on the threads, where the reviewer reads them, not in the agent's chat. Registers a waiter with a 10 s heartbeat. Returns immediately if undelivered reviews exist. Otherwise watches `reviews/` (fs.watch plus a 2 s poll) until a review or a `session.closed` event arrives. Prints the packet covering **all** undelivered reviews and marks them delivered. | 0 / 2 / 3 / 5 |
| `feedback <doc> [--peek] [--include-drafts] [--all-open] [--json]` | Same packet as `wait`, without blocking. Marks it delivered unless `--peek`. `--all-open` also lists threads that are waiting on the reviewer. | 0 |
| `apply <doc> <tid...> [--dry-run]` | Applies suggestions verbatim (see 9.4) and stages tagged edits. | 0 / 3 |
| `edit <doc> --thread t1[,t2] --old <s> --new <s> [--all]` | Thread-tagged exact replace with Edit-tool semantics: `old` must be unique unless `--all`. | 0 / 3 |
| `reply <doc> <tid> -m <md> [--status answered\|declined\|needs_input\|addressed] [--at L42-46] [--decision "text"]` | Replies without recording a version. | 0 / 4 |
| `revise <doc> [-m <summary>] [--replies <file\|->] [--dry-run] [--break-lock L1="why"]... [--allow-rewrite] [--force]` | Records a version with replies (see 8.1). | 0 / 3 |
| `revert <doc> (--hunk hN \| --lock L1)` | Restores the working copy. | 0 / 3 |
| `reanchor <doc> <tid> (--lines A-B \| --quote TEXT)` | Agent override. Applies to head when the working copy is clean, otherwise staged until the next revise. | 0 / 3 |
| `ask <doc> (--quote TEXT \| --lines A-B) -m <question>` | Creates an `agent-question` thread (status `needs_input`) anchored on head. | 0 / 3 |
| `threads <doc> [--status open\|addressed\|needs_input\|resolved\|outdated\|all] [--json]` | One line per thread. | 0 |
| `show <doc> [<tid>] [--version N] [--lines A-B]` | Full thread with timeline, or exact old source. | 0 / 4 |
| `diff <doc> [vA..vB] [--stat\|--unified] [--json]` | Defaults to lastReviewed..head. | 0 |
| `log <doc> [--json]` | Timeline. | 0 |
| `status [<doc>] [--json]` | Docs, head, counts, undelivered reviews, listeners, working-copy state. | 0 |
| `final <doc> [--decisions] [--out <dir>]` | Final checks and exports. | 0 / 3 |
| `close <doc>` | Ends the review session; waiters exit 5. | 0 |
| `serve [--foreground] [--port N]` · `stop` · `doctor [--fix]` | Daemon control; `doctor` checks ports, store recovery and versions. | |
| `mcp` | stdio MCP server. Logs go to stderr only. | |
| `hook pre-write` · `hook prompt` | Claude Code hook entry points (JSON on stdin). | always 0 |
| `install claude [--user\|--project] [--with-hooks] [--with-mcp] [--apply]` · `install agents-md [--apply]` | Without `--apply`, prints exactly what it would write. | 0 |

### 9.3 Feedback packet
- **Text:** the formats are shown in 3.6, 3.11 and 3.12.
- **Rules:**
  - The header gives the verdict, the reviewed version and the line-number basis.
  - Threads appear in file order, blocking first within ties.
  - Labels: `NEW` (implicit), `REOPENED`, `REPLY` (a reviewer reply on an addressed, answered or declined thread), `ANSWER` (reply to `needs_input`).
  - Each item shows: target label, `on:` (the rendered quote, up to 120 characters), `src>` lines, `crop:` (if any), and the conversation. The conversation shows the last agent reply and every reviewer comment since; older comments are collapsed as "(+2 earlier, `specreview show <doc> t2`)".
  - Then come locks, decisions, drafts (only with `--include-drafts`), the protocol reminder and NEXT.
- **Size cap: 10,000 characters.** Beyond that, the remaining threads are printed one line each with `specreview show <doc> tN`.
- **JSON (`--json`, MCP `structuredContent`):**
```json
{"schema":1,"doc":"token-service","path":"docs/specs/token-service.md","head":1,"working":"clean",
 "reviews":[{"id":"rv1","version":1,"verdict":"changes_requested","body":"...","by":"Eric","at":"..."}],
 "verdict":"changes_requested","final":null,
 "threads":[{"id":"t1","why":"new","type":"comment","severity":"blocking","status":"open",
   "lines":[42,43],"section":["3 Tokens","3.2 Token refresh"],"target":"text","label":"text",
   "on":"rotated on every use","src":"Refresh tokens are rotated on every use, and the previous token is\ninvalidated immediately.",
   "srcUnique":true,"anchorState":"exact","comments":[{"by":"Eric","kind":"human","body":"...","at":"..."}],
   "suggestion":null,"attachments":[],"apply":null}],
 "locks":[{"id":"L1","lines":[170,196],"section":["7 Rollout plan"]}],
 "decisions":[],"drafts":null,
 "counts":{"actionable":4,"new":4,"reopened":0,"reply":0,"answer":0,"awaitingReviewer":0,"resolved":0,"outdated":0},
 "next":"targeted edits, then: specreview revise token-service --replies -"}
```
A thread is **actionable** when either:
- its status is `open`; or
- its newest comment is from the reviewer and comes after the newest agent comment, and its status is not `resolved`.

### 9.4 `apply` and `edit` semantics
- **apply:** map the thread's head anchor range to the working copy (`offsetMapper(head, working)`).
  - If `working.slice(start, start + old.length) === old`, splice it.
  - Otherwise search for all occurrences of `old`: if exactly one exists, or the nearest is within 2,000 characters of the mapped position, splice it.
  - Otherwise report a conflict (`conflict t3: expected text not found near L120; treat as a normal comment`).
  - On success, append a pending edit `{via:'apply', threads:[tid], newLines}` and set the suggestion status to `staged`.
- **edit:** `oldString` must occur exactly once in the working copy unless `--all`. Splice it and append the tagged pending edit.

### 9.5 `revise` input (zod `ReviseInput`)
```ts
{ summary: string,                                   // -m overrides
  threads: Record<string /* tN */, { status: 'addressed'|'answered'|'declined'|'needs_input', reply: string, at?: string }>,
  other?: { at: string /* "L12" | "L12-14" | "del:h6" */, why: string }[],
  breakLocks?: Record<string /* L1 */, string /* reason */> }
```
`ReviseReport`:
```
{refused, version?, hunks:[{id, oldRange, newRange, section, threads, linkedBy, other}],
 replies:[{thread, status}], guards:{errors, warnings}, anchors:{exact, moved, edited, changed, orphaned}, notified}
```
It is formatted as in 3.8.

### 9.6 Other command outputs
```
$ specreview status
token-service  docs/specs/token-service.md  head v2 (claude, 14:09)  in_review
  threads: open 0 · addressed 3 · needs_input 1 · resolved 0 · outdated 0   locks: L1
  reviewer: last review rv1 on v1 · drafts 0 · undelivered reviews: none
  listening: claude (pid 81234)   working copy: clean
$ specreview log token-service
v3  agent claude  14:31  rv2: caption sync/async, admin TTL 12h         +4 -2   t2 t4
    rv2  Eric  14:20  CHANGES_REQUESTED  2 threads (t1, t3 resolved; D1, D2)
v2  agent claude  14:09  rv1: grace window, retry policy, caption       +9 -3   t1 t2 t3 (+1 other)
    rv1  Eric  14:02  CHANGES_REQUESTED  4 threads, lock L1
v1  agent claude  13:55  initial draft                                   212 lines
final: none
$ specreview diff token-service v1..v2 --stat
v1..v2  +9 -3  4 hunks
  h1 L42-46  §3.2 Token refresh   t1 (overlap)
  h2 L90-91  §4 Architecture      t2 (hint)
  h3 L120    §5.1 Retries         t3 (tagged)
  h4 L12     front matter         other: Bumped 'Last revised' date
  assets: docs/specs/img/arch.png unchanged
$ specreview show token-service t2
[t2] question · REOPENED · anchor exact (v2 L90-91) · <img alt="System overview"> region x40-62% y10-30%
  v1 Eric (rv1): Does the gateway sit in front of the auth service or beside it?
  v2 claude (addressed, h2): Gateway sits in front of auth. Fixed the caption.
  v2 Eric (rv2): Caption still ambiguous: say which arrows are sync vs async.
  change v1->v2 h2:  - *Figure 2: system overview.*  + *Figure 2: the gateway sits in front of the auth service.*
```

### 9.7 MCP server (`specreview mcp`, `@modelcontextprotocol/server` v2)
- Setup:
  ```js
  new McpServer({ name: 'specreview', version })
  server.registerTool(name, { description, inputSchema: z.object(...) }, handler)
  await server.connect(new StdioServerTransport())   // StdioServerTransport from '@modelcontextprotocol/server/stdio'
  ```
- Every tool returns `content: [{type:'text', text: <same text as the CLI>}]` and `structuredContent: <same as --json>`, with `isError: true` on refusal or conflict.
- Logs go to stderr only.

| Tool | Input | Returns |
|---|---|---|
| `specreview_open` | `{path, title?}` | `{doc, version, url}` |
| `specreview_wait` | `{doc?, timeout_sec?: number = 50 (max 600)}` | the packet, or `{status:"waiting", hint:"call again"}`, or `{status:"closed"}` |
| `specreview_feedback` | `{doc, peek?, include_drafts?}` | packet |
| `specreview_apply` | `{doc, thread_ids: string[]}` | `{applied, conflicts}` |
| `specreview_edit` | `{doc, thread_ids, old_string, new_string, replace_all?}` | `{lines}` |
| `specreview_reply` | `{doc, thread_id, body, status?, at?, decision?}` | thread summary |
| `specreview_revise` | `{doc, summary, threads: Record<id,{status,reply,at?}>, other?, break_locks?, allow_rewrite?, dry_run?}` | revise report |
| `specreview_revert` | `{doc, hunk?, lock?}` | report |
| `specreview_reanchor` | `{doc, thread_id, lines?, quote?}` | anchor |
| `specreview_diff` | `{doc, from?, to?, format?: "stat"\|"unified"}` | diff |
| `specreview_log` / `specreview_status` | `{doc?}` | text |
| `specreview_show` | `{doc, thread_id?, version?, lines?}` | text |
| `specreview_final` | `{doc, decisions?}` | paths |

While `specreview_wait` blocks: if the request carries `_meta.progressToken`, send `notifications/progress` every 15 s through the v2 handler-context API. Skip this if the API is unavailable.

### 9.8 Knowing when the reviewer is done (layered)
1. **Claude Code, primary:** Bash `specreview wait <doc>` with `run_in_background: true`. It costs zero tokens and Claude is re-invoked when it exits. Heartbeats drive "claude is listening".
2. **MCP:** `specreview_wait`, called repeatedly. Claude Code moves long MCP calls to the background on its own.
3. **Safety net:** the UserPromptSubmit hook injects pending, undelivered reviews when no live waiter exists.
4. **Manual:** the user says "done". The agent runs `feedback`, which also reports unsent drafts.
5. **Polling:** `specreview status --json` reports `undelivered: n`.

### 9.9 Claude Code hooks (`specreview hook ...`)
Both hooks read the hook JSON on stdin and always exit 0. On any error they print nothing, and they must finish in under 300 ms.
- **`hook pre-write`** (PreToolUse, matcher `Write`). If `tool_input.file_path` is a tracked doc that has at least one review, its state is not `closed`, and `config.guards.writeHook` is not `off`:
  1. Compute `ratio = changedLines(current, tool_input.content) / max(1, currentLines)`.
  2. If `ratio > writeHookRatio` (0.4), print:
     ```json
     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"docs/specs/token-service.md is under SpecReview (v2, 3 open threads, L1 locked). Use Edit for targeted changes (or specreview apply/edit). If the user explicitly asked for a full rewrite, use `specreview revise --allow-rewrite` after writing with Edit."}}
     ```
  3. In `warn` mode, set `permissionDecision` to `"ask"`.
- **`hook prompt`** (UserPromptSubmit). From `cwd`, find the store. For docs with submitted reviews not yet delivered to `claude` and no live waiter, print:
  ```json
  {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"specreview: review rv2 on token-service (2 threads, CHANGES REQUESTED) was submitted at 14:20 and not delivered. Run `specreview feedback token-service` and address it per the spec-review skill."}}
  ```
  Output is capped at 1,000 characters.

### 9.10 Claude Code plugin and skill
Layout:
```
.claude-plugin/marketplace.json            {"name":"specreview","plugins":[{"name":"specreview","source":"./integrations/claude-code"}]}
integrations/claude-code/.claude-plugin/plugin.json   {"name":"specreview","version":"0.1.0","description":"Iterative review loop for HTML/Markdown specs"}
integrations/claude-code/skills/spec-review/SKILL.md
integrations/claude-code/commands/review-spec.md     # /review-spec <path>: open + show + background wait for an existing file
integrations/claude-code/hooks/hooks.json            # PreToolUse(Write) -> specreview hook pre-write ; UserPromptSubmit -> specreview hook prompt
integrations/agents-md/AGENTS.snippet.md             # protocol for other agents
```
The plugin does not ship `.mcp.json`; the CLI is primary in Claude Code. `install claude --with-mcp` prints `claude mcp add specreview -- specreview mcp`.

**SKILL.md outline** (about 80 lines). Front matter:
```
name: spec-review
description: Iterative, commentable review loop for HTML/Markdown specs and design docs. Use when writing a spec/plan/RFC/design doc the user will review, when the user asks to review, comment on or iterate on such a doc, or when specreview output (a feedback packet) arrives.
```
Body:
1. **When:** any spec or design doc meant for the user's review. Write it as `.md` (default) or `.html` (when rich layout or interactivity is needed) in the repo, e.g. `docs/specs/<name>.md`.
2. **Start:**
   - `specreview open <file>`.
   - If `mcp__Claude_Browser__preview_start` exists, open the printed URL with it. Otherwise give the URL.
   - Run `specreview wait <doc>` with `run_in_background: true`.
   - Tell the user to comment and click Submit review. End the turn. Do not poll.
3. **Write discipline:**
   - After `open`, NEVER use Write on the doc again. Use the Edit tool, `specreview apply` or `specreview edit` only.
   - Never regenerate the doc.
   - Edit bottom-up, or rely on the `src>` text rather than line numbers.
   - Re-read a region before editing it; the reviewer may have recorded their own version.
4. **On a packet:**
   - SUGGESTION: run `specreview apply <doc> <tid>`. Never retype it.
   - Change: edit with `src>` as old_string; keep the diff minimal and local.
   - Question: answer in the thread's reply, where the reviewer reads it; edit only if the answer belongs in the spec (`answered` vs `addressed`).
   - Disagree: `declined` with a reason.
   - Unclear: `needs_input` with a precise question.
   - Image or diagram comments: Read the crop. Edit the diagram source (mermaid fence, inline SVG, or the generator script), then regenerate.
5. **Never touch** LOCKED ranges or text behind DECISIONS, and make no drive-by edits outside threads. Explain any necessary extra change in `other`.
6. **Record:** `specreview revise <doc> --replies -` with one entry per listed thread, using a heredoc with JSON. On exit 3, fix it with `revert --hunk`, an `other` explanation or a `--break-lock` reason (only if the user asked). Never use `--force` or `--allow-rewrite` unless the user explicitly says so.
7. **Report:** one line per thread in chat, then back to step 2's wait.
8. **On APPROVED:** run `specreview final <doc> --decisions`, report the final path, and stop waiting.
9. **Recovery:** if a wait was lost or the user says "done", run `specreview feedback <doc> --include-drafts`. If the user mentions "t4", run `specreview show <doc> t4`.
10. **Reference:** exit codes, and the command cheat-sheet.

**AGENTS.snippet.md:** the same protocol without the Claude-specific tools, using foreground `specreview wait`.

## 10. HTTP API and protocols

### 10.1 Daemon lifecycle
- `ensureDaemon()`:
  1. Read `daemon.json`.
  2. Call `GET http://127.0.0.1:<uiPort>/api/health` with a 500 ms timeout.
  3. If the daemon is healthy and its `version` matches, reuse it.
  4. If the version differs, `POST /api/shutdown` (Bearer token) and wait for exit.
  5. Spawn `process.execPath [bin/specreview.js, 'serve', '--foreground']` with `detached: true`, stdio to `daemon.log`, then `unref()`.
  6. Poll health for up to 5 s.
- The daemon writes `daemon.json` (0600) after both listeners are bound.
- **Idle exit:** 12 h with no SSE clients, no live waiters and no requests.
- `specreview stop` calls `POST /api/shutdown`.

### 10.2 UI origin (`127.0.0.1:4777`) routes
These checks apply to every route:
- `Host` must be one of `127.0.0.1:<port>` or `localhost:<port>`, otherwise 421. This blocks DNS rebinding.
- `/api/*` except `health` requires `Authorization: Bearer <token>`.
- Non-GET requests also require an `Origin` that equals the request's own UI origin.
- No CORS headers are ever sent.

| Method and path | Body | Response |
|---|---|---|
| `GET /` and `GET /d/:ws/:doc` | | `index.html` (SPA; the token comes from `?k=`) |
| `GET /ui/*`, `GET /vendor/*` | | static files (`/vendor` through `VENDOR_UI` only) |
| `GET /api/health` | | `{ok, name:"specreview", version, pid}` (no secrets) |
| `POST /api/shutdown` | | `{ok}` |
| `GET /api/docs` | | `[{ws, id, path, title, head, state, openThreads, undelivered, listening, final}]` across registered workspaces |
| `GET /api/docs/:ws/:doc` | | `DocState` |
| `GET /api/docs/:ws/:doc/versions/:v/targets` | `v` = number or `live` | `{threads: DomTarget[], locks: DomTarget[], drafts: DomTarget[], outline}` (drafts written on an older version are carried forward to `v`; none for `live`) |
| `GET /api/docs/:ws/:doc/source?v=3&from=40&to=60` | | `{startLine, lines:[...]}` |
| `POST /api/docs/:ws/:doc/anchors/resolve` | `{version, capture}` | `{anchor, preview:{label, lines, section, src}}` |
| `GET /api/docs/:ws/:doc/drafts` | | `Drafts` |
| `POST /api/docs/:ws/:doc/drafts` | `DraftItem` without `id` | `DraftItem` |
| `PATCH /api/docs/:ws/:doc/drafts/:id` | partial | `DraftItem` |
| `DELETE /api/docs/:ws/:doc/drafts/:id` | | `{ok}` |
| `POST /api/docs/:ws/:doc/reviews` | `{verdict, body, markFinal?, resolveAddressed?, draftIds?, reviewedVersion?}` (draftIds omitted = all; "Send now" passes one; `reviewedVersion` = the version on screen: an `approved` verdict is refused with 409 when head differs) | `Review` |
| `POST /api/docs/:ws/:doc/threads/:tid/resolve` | `{decision?: string}` | `Thread` |
| `POST /api/docs/:ws/:doc/threads/:tid/unresolve` | | `Thread` |
| `POST /api/docs/:ws/:doc/threads/resolve` | `{threads: string[]}` (1-1000 ids) | `{resolved, unchanged}` ("Accept all": every id checked first, already resolved ones unchanged) |
| `POST /api/docs/:ws/:doc/threads/unresolve` | `{threads: string[]}` | `{reopened, unchanged}` (the Undo of "Accept all") |
| `POST /api/docs/:ws/:doc/revisions/accept` | `{version, threads?: string[]}` (0-1000 ids) | `{accepted, previous, resolved, unchanged}` ("Accept all revisions": `doc.acceptedVersion` only moves forward; the threads are resolved like "Accept all") |
| `POST /api/docs/:ws/:doc/revisions/unaccept` | `{version, previous, threads?}` | `{accepted, reopened, unchanged}` (its Undo: `acceptedVersion` back to `previous` while it is still `version`) |
| `POST /api/docs/:ws/:doc/threads/:tid/move` | `{version, capture}` | `Thread` |
| `POST /api/docs/:ws/:doc/threads/:tid/apply` | | `VersionManifest` (reviewer applies a suggestion; 409 if the working copy is dirty) |
| `GET /api/docs/:ws/:doc/threads/:tid/minidiff` | | `{version, before, after, words}` |
| `POST /api/docs/:ws/:doc/locks` | `{version, capture, note?}` | `Lock` |
| `DELETE /api/docs/:ws/:doc/locks/:id` | | `{ok}` |
| `POST /api/docs/:ws/:doc/locks/:id/relock` | | `Lock` |
| `GET /api/docs/:ws/:doc/diff?from=1&to=2` | `to` may be `live` | `Changes` (hunks carry `oldSide`, assets `oldSrids`: the same changes placed in the `from` version, for Changes side by side) |
| `GET /api/docs/:ws/:doc/diff/source?from=&to=` | | `SourceDiff` |
| `POST /api/docs/:ws/:doc/record` | `{summary}` | `VersionManifest` (reviewer-authored) |
| `POST /api/docs/:ws/:doc/attachments` | `{dataUrl}` (PNG or JPEG, at most 5 MB) | `{path}` |
| `POST /api/docs/:ws/:doc/fragment` | `{source}` | `{html}` (suggestion preview; the UI sanitises it with DOMPurify) |
| `POST /api/docs/:ws/:doc/close` | | `{ok}` |
| `GET /api/events?ws=&doc=&k=<token>` | | SSE |

`DocState`:
```json
{"ws":"3f9a1c2e","doc":{"...":"doc.json"},"versions":[{"v":1,"author":{},"summary":"","createdAt":"","stats":{},"guards":{},"respondsTo":null}],
 "threads":[{"...":"Thread"}],"locks":[],"reviews":[],"drafts":{"items":[]},
 "waiters":[{"agent":"claude","since":"..."}],"working":{"dirty":false,"sha256":"..."},
 "contentBase":"http://127.0.0.1:4778/c/<secret>/3f9a1c2e","reviewer":{"name":"Eric"},
 "decisions":[{"id":"D1","thread":"t1","text":"..."}]}
```
`DomTarget`:
```
{id, kind, state:'open'|'resolved'|'outdated'|'draft'|'active'|'lock', ranges:[{s:{srid,o}, e:{srid,o}}], quote,
 srid, region, svg, cell, code, media, generated, label}
```

### 10.3 SSE (`/api/events`)
- Each event has `id: <seq>` and the event names below.
- Payloads are **hints**. Clients refetch `DocState` on anything except `presence` and `working.changed`.
- Clients reconnect with `Last-Event-ID`. If the seq is unknown, the server sends `reset` and the client refetches.

Event names:
- `version.created {v, author, summary, counts}`
- `review.submitted {review, verdict}`
- `review.delivered {review, agent, at}`
- `thread.updated {thread}`
- `lock.changed`
- `drafts.changed`
- `doc.approved {v}`
- `session.closed`
- `working.changed {dirty, sha256}` (chokidar on the tracked file, debounced 250 ms)
- `presence {waiters}` (watching `runtime/waiters/`)
- `reset`
- `ping` every 25 s

The daemon tails `runtime/events/<doc>.jsonl` for subscribed docs.

### 10.4 Content origin (`127.0.0.1:4778`)
The content origin has no API and no state-changing routes. It checks `Host` (127.0.0.1 or localhost on that port) and the secret path segment, and denies dotfiles and the deny list.

| Path | Serves |
|---|---|
| `/c/:secret/:ws/:ver/<docPath>` | The rendered doc: guest injected, `__SR_ASSET_BASE__` replaced. Query flags `pristine=1`, `nocsp=1`. |
| `/c/:secret/:ws/:ver/<other path>` | Assets. For `vN`, from the manifest blob; otherwise the live file (`realpathWithin`). |
| `/c/:secret/__sr/guest.js` · `/c/:secret/__sr/static/*` · `/c/:secret/__sr/vendor/*` | Guest bundle, shell CSS, mermaid-init, vendored doc libraries |
| `/<anything else>` | Root-absolute fallback through `Referer`; otherwise 404 |

### 10.5 postMessage protocol (`MSG` in `protocol.js`)
- **Envelope:** `{sr: 1, type, ...}`.
- **Guest side:**
  - It reads its allowlist from `data-sr-ui` and posts `hello` to `window.parent` once for each allowed origin.
  - It accepts parent messages only when `event.source === window.parent` and `event.origin` is in the allowlist. It pins that origin after `init`.
- **UI side:** it accepts messages only when `event.source === iframe.contentWindow` and `event.origin === contentOrigin`.
- **No guest message can mutate state** without a user gesture in the UI. A forged message can at most open a composer.

Guest to UI:
- `hello {target, title, href, highlightApi: bool}`
- `ready {outline:[{srid, level, text, line}], externalsFailed:[url]}`
- `action {action:'comment'|'suggest'|'question'|'agree', capture, rect, crop?}` (from the mini-toolbar, shortcuts or the picker)
- `selection {capture|null, rect}` (to enable UI buttons)
- `positions {targets:{[id]:{top, state:'ok'|'hidden'|'missing'}}, hunks:{[id]:top}, scrollY, viewportH, docH}`
- `activate {id}` (a highlight, pin or bar was clicked)
- `key {key, meta, ctrl, shift, alt}` (forwarded only when the page did not `defaultPrevented` it and the focus is not editable)
- `scroll {topSrid, offset}`
- `pageError {count, last}`

UI to guest:
- `init {mode:'review'|'changes'|'readonly', theme, targets, locks, changes|null}`
- `setTargets {targets, locks}`
- `setChanges {changes|null}`
- `focus {id}`
- `scrollTo {srid|id|hunk}`
- `setTool {tool:'select'|'pick'}`
- `setTheme {theme:'light'|'dark'|'system'}`
- `reveal {id}`
- `draftTarget {target|null}`
- `clearSelection {}`

## 11. Reviewer UI

### 11.1 Layout, wide (900 px and up)
```
+------------------------------------------------------------------------------------------------+
| = token-service.md v | v3 (latest) v | [Review][Changes][Source][History] | base: v2 (your last review) v |
| * claude is listening    v3 ready - 3 addressed, 1 needs you        Drafts 2   [Submit review v] |
+-------------+----------------------------------------------------------+-----------------------+
| OUTLINE     | | 3.2 Token refresh                              (1)     | THREADS [Open v] [List|Aligned]
| 1 Goals     | | Refresh tokens use a 30 s reuse-detection grace...   | +-------------------+ |
| 3 Tokens  2 |                                                          | | t1 blocking       | |
|  3.2  ~     |  [ arch.png   [- - region (2) - -] ]                    | | ADDRESSED in v3   | |
| 4 Arch    1 |  (-) 3 lines removed                                    | | "rotated on..."   | |
| 7 Rollout[L]|                                                          | | Eric: Rotation... | |
| ----------- |                                                          | | claude: Replaced..| |
| HISTORY     |                                                          | | > change h1 +3 -2 | |
| v3 claude * |                                                          | | [Accept][Reopen]  | |
| v2 claude   |                                                          | +-------------------+ |
+-------------+----------------------------------------------------------+-----------------------+
| v3 · working copy clean · page errors 0 · externals ok · Orphans (0) · FINAL: -                   |
+------------------------------------------------------------------------------------------------+
```
- **Left rail:**
  - The outline (from guest `ready`), with badges: open-thread count, `~` changed, `+` added, `[L]` locked.
  - Context menu: Comment on section, Mark agreed, Unlock.
  - A compact history list.
- **Centre:** the doc iframe, with pins in the overlay margin.
- **Right:** the thread panel.
  - Filters: Open, Needs me (`needs_input`), Verify, Drafts, Resolved, Outdated, All.
  - **Aligned** layout (Google Docs style, cards follow the guest's positions with collision stacking) or **List** (by document position).
- **Status bar:** version, working-copy state, page errors, external failures, orphan tray, final badge.

### 11.2 Narrow (below 900 px; typical for the pane next to chat)
- The outline and history move behind `=`.
- Threads move to a right drawer (overlay) toggled with `\` or "Threads (3)". Clicking a pin or highlight opens the drawer on that thread.
- Mode tabs collapse into a dropdown.
- No horizontal page scroll; the iframe is full width.

### 11.3 Modes
- **Review:** the selected version (default head) with highlights. Comments are allowed on any recorded version; older versions show a banner "comments will be carried forward to v3".
- **Changes:** the overlay from 8.6 plus a change list grouped by section with "seen" checkboxes and progress ("5/9 reviewed"), plus a "Round results" panel showing agent replies with Accept / Reopen. Guard badges appear here.
- **Source:** numbered source, or a diff table (unified or split toggle) against the base. Select lines and press `c` to comment.
- **History:** the timeline from 8.9.
- **Working-copy preview:** appears automatically when `working.dirty`. Banner: "Unrecorded changes on disk (claude is editing) [Preview live] [Record as my revision]". The preview is read-only and live-reloads on `working.changed`.

### 11.4 Creating feedback
- **Selection mini-toolbar** (in the guest overlay): [Comment c] [Suggest s] [Question q] [Agreed a].
- **Pick mode** (`e`, crosshair button):
  - Hover outlines the smart target (img, picture, svg, svg `g` with text, table cell, pre, figure, video, audio, canvas, iframe, `.sr-math`, details, li, p, h1-h6) and shows a label chip such as `img "System overview"`, `td refresh_token / TTL` or `mermaid node "Gateway"`.
  - `[` and `]` move to the parent or child.
  - Click comments on the target. Shift-drag draws a region on img, svg, canvas, video or iframe. On a table cell, a chooser offers cell, row, column or table.
  - Esc exits.
- **Code blocks:** hovering shows a line gutter with "+". Click selects one line; shift-click selects a range.
- **Composer** (opens in the sidebar at the anchor's height, or in the drawer):
  - The anchor chip: "Agent will see: L42-43 §3.2 'rotated on every use'" with [Widen to block].
  - Type chips: Comment, Question, Suggestion. Severity: Blocking, Normal, Nit (keys 1-3).
  - A Markdown textarea. Paste an image to attach it. A crop thumbnail is shown when present.
  - **Add to review** (Cmd+Enter) creates a draft. **Send now** submits a one-item review with verdict `comment`. **Cancel** (Esc).
  - Drafts autosave (debounced 800 ms) through the API, with a localStorage backup.
- **Suggestion editor:**
  - **Text mode** when the anchor's source slice equals the rendered quote modulo whitespace: an inline input prefilled with the selection.
  - Otherwise **source mode**: a monospace textarea prefilled with the anchor's full source lines.
  - A live word diff (jsdiff in the browser) is shown, plus an optional rendered preview through `/fragment`, sanitised.
  - It is stored as `suggestion {mode, old, new, version, start, end, startLine, endLine}`.

### 11.5 Thread card
- **Header:** id, type and severity chips, a status chip (Open, Addressed in v3, Answered, Declined, Needs you, Resolved), an anchor-state chip (Moved, Outdated, Orphaned, Hidden: Reveal, Generated) and the target label.
- **Body:** the quote, or "was ... / now ..." for `changed`. Then the comments, each with author (You or claude), version tag and status tag. Bodies are Markdown rendered with `marked` and sanitised with DOMPurify.
- **Suggestion block:** `-`/`+` lines and a status (Pending, Staged, Applied in v2, Conflict). **[Apply now]** (reviewer) is enabled only when the working copy is clean.
- **Mini-diff:** collapsible, shown for addressed or changed threads, plus "View in Changes".
- **Actions by state:**
  - Open: Reply, Resolve, Edit or Delete (own drafts).
  - Addressed, Answered or Declined: **Accept** (resolve, with an optional "Record as decision" one-liner) and **Reopen** (reply box).
  - Needs input: an orange "claude asked you" banner and a reply box.
  - Orphaned or Outdated: Move here (re-anchor to the current selection or pick), View on vN, Resolve.
- Clicking a card scrolls the doc and pulses the anchor. Clicking a highlight focuses its card.

### 11.6 Submit review
The dialog contains:
- a summary textarea;
- a verdict radio: **Comment**, **Request changes**, **Approve**;
- the list of drafts with jump links;
- the locks added this round.

Extra options and warnings:
- With Approve: "[x] Mark vN final" and "[x] Resolve N addressed threads".
- A warning if blocking threads are still open.
- If no agent is listening: "No agent is listening. After submitting, tell claude 'review submitted'." with a [Copy prompt] button that copies "Run `specreview feedback token-service` and address it."

After submit, a status chip moves through "Submitted, then Delivered to claude 14:02, then revising..., then v3 ready". It is driven by `review.delivered`, `working.changed` and `version.created`.

### 11.7 Live updates and notifications
- `version.created` shows a toast "v3 ready - answers rv2 (3 addressed, 1 needs you) [Review changes] [Verify]", prefixes the tab title "(v3)" and adds a favicon dot.
- The UI never switches versions or reloads while a composer is open; it only shows the banner. When switching versions, scroll position is restored to the same heading or srid.
- Presence chip:
  - "claude is listening" (green) while a waiter is live;
  - "claude is revising..." (amber) after delivery;
  - "claude is editing (unrecorded)" while the working copy is dirty;
  - "No agent listening" (grey).

### 11.8 Keyboard
| Key | Action |
|---|---|
| Mod+K | Command palette (toggle) |
| Mod+, | Settings |
| Mod+/ or `?` | Keyboard shortcuts (help overlay) |
| `c` / `s` / `q` / `a` | Comment, suggest, question, or mark agreed on the selection |
| `e` | Pick mode (in pick mode: `[` `]` parent/child, Esc exits) |
| `j` / `k` | Next / previous thread |
| `n` / `p` | Next / previous change |
| `r` | Reply to the focused thread |
| `x` | Resolve / accept |
| `o` | Reopen |
| `y` | Accept a decline |
| `v` | Verify queue |
| `f` or Cmd+Shift+Enter | Submit review dialog |
| Cmd+Enter | Add the draft to the review |
| `1`-`4` | Review / Changes / Source / History |
| `[` / `]` (outside pick mode) | Previous / next version |
| `d` | Toggle base: last review vs previous |
| `h` | Hide all annotations (clean read) |
| `\` | Toggle the thread sidebar or drawer |
| `t` | Cycle theme |
| Esc | Close or cancel |

- **Mod** is Cmd on macOS (shown as ⌘ glyphs) and Ctrl elsewhere. On macOS, Ctrl+K, Ctrl+, and Ctrl+/ also work, because Safari and the Claude desktop app may reserve ⌘, or ⌘K.
- **Global:** the three Mod combos work with focus in the UI, inside UI text fields (an open composer keeps its draft), and in the doc iframe (the guest forwards them). They `preventDefault` so the browser does not act.
- **Command palette:** every keyed action (one registry, src/ui/commands.js, feeds both the palette and the help overlay), plus actions without a key: go to thread / section / version, compare versions, thread filters, submit with a verdict, general comment, record the working copy, mark all changes seen, copy review link / agent prompt / spec path, toggle the outline rail, reload, open the doc list or another doc, close session (asks first), theme, single-letter shortcuts on/off. A command that cannot run now is dimmed with the reason.
- **Settings** (localStorage, applied at once): theme; outline rail (Auto / Always / Never); thread panel open by default; single-letter shortcuts; on a new version (toast / switch to Changes); ask before Send now; default verdict when nothing is blocking (Comment / Request changes; never Approve); About (version, workspace, spec path, ports, agent prompt).
- **Single-letter shortcuts off:** the UI ignores every single-character shortcut (letters, digits, and punctuation such as `?` `[` `]` `\`; Esc and the Mod combos still work), and the guest (`setPrefs {singleKeys:false}`, also `init.prefs`) neither acts on c / s / q / a / b itself nor captures them; it forwards them like any other key.

### 11.9 Empty states, accessibility and theming
- **Empty states:**
  - No threads: "Select text and press C, or press E to comment on images, diagrams, tables and code."
  - v1 Changes: "This is the first version. After the agent revises, you'll see exactly what changed."
  - Approved: "Approved at v3. [View final] [History]".
- **Accessibility:** all controls are labelled buttons with visible focus rings. The thread and change lists are the keyboard-accessible counterpart of the highlights. Toasts use `aria-live`. Reduced motion is respected. States use icon plus text, not colour alone.
- **Theming:**
  - UI colours are CSS custom properties with light and dark sets (`prefers-color-scheme` plus a toggle). `body` has an explicit background.
  - Markdown docs follow the theme through `setTheme`: the guest flips the `media` attribute of the `data-sr-theme` links and re-runs mermaid with the matching theme.
  - Raw HTML docs keep their own styling.

## 12. Security
1. **Network binding:**
   - Both servers bind to 127.0.0.1 only.
   - A `Host` allowlist blocks DNS rebinding.
   - The UI API needs a 128-bit Bearer token (from `daemon.json`, mode 0600, or `?k=` for the SPA and SSE). Non-GET requests also need `Origin` equal to the UI origin.
   - No CORS headers. No cookies, so same-site requests from the content origin carry no credentials.
2. **Isolation:**
   - Documents run on a different origin (port 4778) inside a sandboxed iframe with no top navigation.
   - The content origin has no state-changing routes.
   - Content URLs carry a random per-daemon `secret` path segment, so other websites cannot probe or script-include workspace files.
3. **Path safety:**
   - `realpathWithin(workspaceRoot)`, which blocks symlink escapes.
   - Any path segment that starts with `.` is denied (`.env`, `.git`, `.specreview`, `.ssh`), as are `*.pem`, `*.key`, `*.p12` and `id_rsa*`.
   - Files are capped at 200 MB.
4. **UI hardening:**
   - CSP:
     ```
     default-src 'self'; script-src 'self' 'sha256-<importmap hash>'; style-src 'self' 'unsafe-inline';
     img-src 'self' data: blob: http://127.0.0.1:<content>; frame-src http://127.0.0.1:<content>;
     connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
     ```
   - `Referrer-Policy: no-referrer`.
   - Nothing on the UI origin can be framed: every response (pages, static files, API, SSE, errors) carries `X-Frame-Options: DENY`, a CSP with `frame-ancestors 'none'` (`default-src 'none'` outside the SPA page) and `Cross-Origin-Resource-Policy: same-origin`. `/ui/*` and `/vendor/*` serve subresources only, never documents (HTML, XHTML, SVG, XML, XSLT), so the SPA page exists only at `/` and `/d/:ws/:doc` with the CSP above. A framed copy of the SPA never stores `?k=`.
   - Comment and reply bodies are rendered with marked and DOMPurify. The UI never uses `innerHTML` with unsanitised data.
5. **The token in the URL** is visible in the pane address bar. It is not readable by the cross-origin iframe, and it is not leaked through Referer (`no-referrer`).
6. **postMessage:** origin and source checks on both sides. Guest messages can never submit, resolve or write anything without a click in the UI.
7. **Zero egress by the tool:** no update checks, telemetry or remote fetches. Everything is vendored. Documents may load their own remote resources when `render.network` is `allow`; with `block`, the doc CSP restricts them to self, data and blob, which also prevents exfiltration by doc scripts.
8. **Hooks and install:** hooks never fail or block a prompt on error. `install` writes nothing without `--apply` and prints a diff of what it will change.
9. **Other limits:** attachments are limited to PNG/JPEG, 5 MB, re-encoded by the browser canvas. Uploads go under `attachments/` with generated names only.

## 13. Testing strategy
- **Unit** (`node --test`, `test/unit/`):
  - store atomic writes, locks, recovery from injected crashes (`SPECREVIEW_CRASH_AT=<step>`), and id allocation;
  - workspace discovery;
  - **the HTML splice round-trip** (stripping the inserted attributes gives back identical bytes) on a corpus that includes the `/>` and unquoted-value edge cases and SVG;
  - Markdown SrcMap coverage: every fixture element kind has a srid with correct `ls`/`le`;
  - the aligner: escapes, entities, inline code backticks, CRLF, blockquote/list prefixes, approximate fallback;
  - verbatim code-line mapping;
  - `lineHunks` and `offsetMapper`;
  - word-diff mapping to DOM targets;
  - fuzzy scoring;
  - **the re-anchoring golden corpus** (`fixtures/reanchor/*.json`: v1 source, edit script, expected state and lines per thread; cases: reword, insert above, move a paragraph, table row edit, image swap, mermaid node rename, full regeneration);
  - attribution and guards (each refusal and warning);
  - apply/edit conflicts;
  - **packet golden files** (`fixtures/packets/*.txt`);
  - hook outputs, including timing under 300 ms;
  - zod schema validation of every fixture JSON.
- **Integration** (`test/integration/`): spawn the real CLI in a temporary workspace with `SPECREVIEW_HOME` set to a temp dir.
  - `open`, then a submit through ops or HTTP, then `wait` returns the packet, then `apply`, `revise` (including refusal and dry-run), then the next round, then approve and `final`.
  - A killed `wait` re-delivers.
  - Daemon security: wrong Host gives 421; a missing token gives 401; a cross-Origin POST gives 403; dotfile and traversal requests give 404; the content origin has no `/api`.
  - The MCP server through an in-process client (InMemoryTransport): tools/list, open, wait timeout, revise.
- **E2E** (`@playwright/test`, Chromium; `test/e2e/`), with fixtures `kitchen-sink.md` (GFM, footnotes, task lists, math, mermaid, code, front matter, raw HTML, images) and `app-spec.html` (inline script building DOM, inline SVG, canvas chart, video, a web component, `<details>`, tabs, its own meta CSP variant):
  - create every anchor kind through the guest and check the stored anchor lines;
  - highlights are present in `CSS.highlights`;
  - the narrow layout at 600 px;
  - the Changes overlay after a scripted revise;
  - Verify accept and reopen;
  - submit delivers to a background `wait`.
  - **Fidelity parity:** each fixture is served by a plain static server and by SpecReview with the overlay hidden. Assert pixel-identical screenshots and identical console error sets.
- **Typecheck:** `tsc -p jsconfig.json` (checkJs, noEmit) is part of `npm run check`.

## 14. Scope
**v1 (this build):** everything above, except the items listed below.
- Core: store, render (MD and HTML), TextIndex, diff, anchors (all kinds in 7.1, crops for img, canvas and svg), re-anchoring, attribution, guards, packet, ops.
- CLI: every command in 9.2.
- MCP: every tool in 9.7.
- Daemon: two origins, API, SSE, security.
- Guest and UI: Review, Changes overlay, Source diff, History, Verify, locks, decisions, suggestions (text and source mode), reviewer apply and record, narrow layout, keyboard.
- Hooks, plugin, skill, AGENTS snippet.
- `final --decisions`; opt-in `git.autoCommit`.

**v1.1:**
- Static redline view, and a side-by-side rendered view with srid scroll sync.
- Image swipe, onion skin and pixel diff.
- git-mirror branch.
- Offline CDN proxy cache with known-library substitution.
- Self-contained HTML export of the final doc.
- GitHub alerts styling.
- macOS notifications.
- `wait --each` (return on every "Send now").
- A SessionStart hook.

**Later:**
- Multi-file review rounds and folder browsing.
- Multiple reviewers with identities.
- Per-doc subdomain origins (`<doc>.localhost`) for storage isolation.
- Annotating inside nested iframes and shadow DOM.
- Runtime DOM capture to diff script-generated content.
- Rendered blame (which version and thread produced a block).
- VS Code webview host.
- Export to an Artifact or Claude Doc.
- PDF/DOCX export.

## 15. Risks and mitigations
1. **The agent regenerates the whole file anyway.** Mitigated by the Write hook (measured deny), the rewrite guard, locks, deletion guards, immutable versions with `revert --hunk` and `show --version`, and the skill protocol.
2. **The DOM and the server TextIndex diverge** (scripts mutate text, whitespace). Mitigated by:
   - one shared `TEXT_EXCLUDE` rule;
   - srid-relative offsets, which localise any drift;
   - server verification against the quote, with fallbacks (narrowed, raw-source, block);
   - a composer preview that shows exactly what the agent will see.
3. **Generated content** (mermaid, charts, innerHTML). Mitigated by quote narrowing, element and region anchors with crops, and a `(script-rendered)` label in packets.
4. **Fuzzy matching attaches to the wrong place.** Mitigated by:
   - conservative thresholds (score at least 0.65, quote similarity at least 0.6);
   - prefix/suffix and proximity scoring;
   - one-version steps with an original-anchor fallback;
   - a visible `Outdated` state with old and new text;
   - overrides (`reanchor`, Move here);
   - a golden corpus to tune against.
5. **Line drift during multi-edit rounds.** Mitigated by unique full-line `src>`, edit-bottom-up guidance, tagged edits, and attribution by overlap rather than trusting line numbers.
6. **Concurrent writers** (UI apply while the agent edits). Mitigated by per-doc locks, compare-and-swap on the working copy, reviewer apply only on a clean working copy, and comments only on recorded versions.
7. **Lost notifications** (wait killed, Claude restarted). Mitigated by: delivery marked after the flush; `feedback`; the prompt hook; presence warnings in the UI; the Copy prompt button.
8. **MCP timeouts.** Mitigated by a bounded wait with progress and a "call again" status. In Claude Code, the CLI background wait is primary.
9. **Pages with their own CSP, or attribute-sensitive pages.** Mitigated by the CSP-strip toggle, pristine mode and the Source view.
10. **CDN-dependent docs offline.** Failures are reported clearly; the proxy cache is v1.1. The tool's own rendering is fully vendored.
11. **Repository bloat.** Mitigated by content-addressed dedup, a size cap for assets (larger ones recorded as live), gitattributes guidance, and runtime caches kept out of git.
12. **Scope for parallel build.** Mitigated by frozen contracts (section 4.4 plus section 5), disjoint file ownership, golden files, and v1.1 items kept off the critical path.

## 16. Integration milestones
- **M1 (agent loop with no UI):** WP1, WP2, WP3 and WP4 CLI. `open`, then a test helper submits a review, then `wait`, `revise`, `wait`. Golden packets pass.
- **M2:** daemon and content serving plus the guest. Highlights and captures work in Chromium on both fixtures.
- **M3:** UI review flow: drafts, submit, presence, Verify.
- **M4:** Changes overlay, Source diff, History, final.
- **M5:** plugin and skill end-to-end in Claude Code with the browser pane. Fidelity parity green.
