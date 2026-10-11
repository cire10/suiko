<!-- The complete, agent-agnostic SpecReview protocol: commands, waiting, the feedback packet, edits, the revise JSON, guards and recovery. The Claude Code skill (integrations/claude-code/skills/spec-review/) and the AGENTS.md snippet (integrations/agents-md/) are condensed forms of this document; keep them in sync. -->

# SpecReview agent protocol

This is the contract between SpecReview and the coding agent that writes and revises specs. It applies to every agent: Claude Code (through the `spec-review` skill), Codex, Gemini CLI, any MCP client, or a person at a terminal. The CLI's text and JSON output, its exit codes and the MCP tools are the whole interface. SpecReview never calls an LLM.

Contents:

1. [Model](#1-model)
2. [The loop at a glance](#2-the-loop-at-a-glance)
3. [Conventions](#3-conventions)
4. [Starting a review](#4-starting-a-review)
5. [Waiting for feedback](#5-waiting-for-feedback)
6. [The feedback packet](#6-the-feedback-packet)
7. [Acting on feedback](#7-acting-on-feedback)
8. [Recording a revision](#8-recording-a-revision)
9. [Guards and attribution](#9-guards-and-attribution)
10. [Anchors, re-anchoring and agent questions](#10-anchors-re-anchoring-and-agent-questions)
11. [Locks and decisions](#11-locks-and-decisions)
12. [Approval and the final version](#12-approval-and-the-final-version)
13. [Recovery](#13-recovery)
14. [Claude Code hooks](#14-claude-code-hooks)
15. [MCP tools](#15-mcp-tools)
16. [Command reference](#16-command-reference)
17. [Rules summary](#17-rules-summary)
18. [Writing specs that review well](#18-writing-specs-that-review-well)
19. [Snapshot docs: plans, messages, piped text](#19-snapshot-docs-plans-messages-piped-text)

## 1. Model

| Term | Meaning | Id |
|---|---|---|
| Workspace | The directory that holds `.specreview/` (nearest ancestor with one, else the git top level, else the file's directory) | `wsId` |
| Doc | A tracked spec file (`.md`, `.markdown`, `.html`, `.htm`) | slug of the file name, e.g. `token-service` |
| Working copy | The file on disk now. The agent edits it. | |
| Version | An immutable recorded snapshot of the file and its local assets | `v1`, `v2`… |
| Head | The latest version | |
| Review | One submitted batch of reviewer feedback with a verdict (`comment`, `changes_requested`, `approved`) | `rv1`… |
| Thread | An anchored conversation on part of the doc | `t1`… |
| Lock | A region the reviewer marked "agreed"; `revise` refuses to change it | `L1`… |
| Decision | A one-line agreement recorded when the reviewer accepts a thread | `D1`… |
| Hunk | One line-diff block between head and the working copy (or between two versions) | `h1`… (per diff) |
| Packet | The feedback text (or JSON) printed for the agent | |

Versions are created only by `open` (v1), `revise`, and the reviewer's **Record as my revision** and **Apply now** actions in the UI. Editing the file does not create a version; the UI shows unrecorded edits as a read-only live preview.

## 2. The loop at a glance

```text
agent writes the spec once ──> specreview open <file>            (records v1, prints the UI URL)
                               show the URL to the reviewer
                               specreview wait <doc>             (background, foreground, or "done" mode)
reviewer comments, submits ──> wait exits 0 and prints the packet
agent reads the file, makes targeted edits (Edit tool or specreview edit), then specreview apply for suggestions
                               specreview revise <doc> --replies -   (records v2, links hunks to threads, runs guards)
                               reports to the user, waits again
reviewer verifies changes  ──> accepts / reopens / replies, submits again ... until APPROVED
                               specreview final <doc> --decisions
```

## 3. Conventions

- **`<doc>`** is a doc id or a file path. An id is looked up in the workspace of the current directory; when it is not tracked there (or the directory has none, e.g. a project without git whose `.specreview/` sits next to the specs), in the workspaces `open` registered below or above the current directory. An id tracked in several of them is an error naming them: pass the file path or `--workspace <dir>`.
- **Line numbers** are 1-based lines of the **current working file**. `L42-43` is inclusive. Hunk ranges inside SpecReview are half-open, but every range printed for the agent is an inclusive `L<a>-<b>`.
- **Output** is compact text; `--json` (where listed) prints the same data structured.
- **Agent name** (used for delivery and presence): `--as <name>`, else `$SPECREVIEW_AGENT`, else `claude` when `$CLAUDECODE` is set, else `agent`.
- **Environment:** `SPECREVIEW_HOME` (runtime state, default `~/.specreview`), `SPECREVIEW_PORT` (UI port; the content port is UI port + 1).
- **Exit codes:**

| Code | Name | Meaning |
|---|---|---|
| 0 | OK | Success, or a packet was delivered (any verdict) |
| 1 | ERROR | Generic error or bad usage |
| 2 | TIMEOUT | `wait --timeout` expired |
| 3 | REFUSED | A guard refused, the working copy is dirty, a compare-and-swap conflict, or `old` is not unique |
| 4 | NOT_FOUND | Doc, thread or version not found |
| 5 | CLOSED | The review session was closed (UI or `specreview close`) |
| 6 | SUPERSEDED | A newer `wait` for the same doc and agent replaced this one; ignore it |

## 4. Starting a review

```text
$ specreview open docs/specs/token-service.md
specreview: tracking docs/specs/token-service.md as "token-service" (markdown, 212 lines) · recorded v1
review UI: http://127.0.0.1:4777/d/3f9a1c2e/token-service?k=Zx81Qm0v7c
next: the URL was opened in the system browser; run `specreview wait token-service` in the background
```

- `open` creates `.specreview/` at the workspace root if needed, records v1 (the source bytes plus snapshots of local images and other assets), and starts the local server in the background if it is not running.
- If the doc is already tracked, `open` only prints the URL. If the working copy differs from head, it adds `working copy differs from v3 (unrecorded)`; `wait` will refuse (exit 3) until that is recorded.
- `open` never silently uses your home directory or `/` as the workspace root (for example when `~` is itself a git repository). Pass `--workspace <dir>` to choose the root explicitly.
- By default `open` also opens the URL in the user's default browser. `--browser pane` only prints it, for an agent that shows it in its own built-in browser pane; `--browser none` only prints it. `SPECREVIEW_BROWSER=pane|system|none` changes the default, so a user who prefers the pane can set it once in their environment.
- The URL carries an access token (`?k=`). It only works on this machine.
- Run the `wait` (and any `revise`) exactly as the `next:` line prints it. It names the doc by id when the id resolves from the current directory, and by its file path otherwise (for example from the project root when `.specreview/` lives in `notes/specs/`).

**Showing the UI:**

- Follow the `next:` line. When it says the URL was opened in the system browser, there is nothing more to show.
- When it says `open the URL (browser pane)` (the user chose `pane`), Claude Code in the Claude desktop app opens it in the built-in browser pane with `mcp__Claude_Browser__navigate {"url": …}` or `mcp__Claude_Browser__preview_start {"url": …}`. Without a pane, give the user the URL.
- When the system browser could not be opened (for example over SSH), or with `none`, give the user the URL.

## 5. Waiting for feedback

| Strategy | When | How |
|---|---|---|
| Background CLI wait | Claude Code (primary) | Bash `specreview wait <doc>` with `run_in_background: true`, then end the turn. No tokens are spent while waiting; the agent is re-invoked when it exits. |
| Foreground CLI wait | Agents whose shell can block for minutes | `specreview wait <doc> --timeout 10m`; exit 2 means run it again. |
| MCP wait | MCP-only agents | Call `specreview_wait` repeatedly; it returns `{"status":"waiting"}` after `timeout_sec` (default 50, max 600). |
| Done mode | Agents with short shell timeouts | The user says "done"; run `specreview feedback <doc> --include-drafts`. |
| Prompt hook | Claude Code safety net | Injects a note when a submitted review was not delivered (see [section 14](#14-claude-code-hooks)). |
| Polling | Scripts | `specreview status --json` reports undelivered reviews. |

`wait` details:

- It exits 3 immediately if the working copy differs from head (`run specreview revise first`), unless `--allow-dirty`.
- It returns immediately if undelivered reviews exist; otherwise it blocks until a review is submitted or the session is closed (exit 5). The packet covers **all** undelivered reviews for that doc.
- `wait --all` waits on every doc in the workspace, except Claude Code plans (their reviews go to the plan gate).
- While it runs, the UI shows "**claude is listening**" (presence comes from a heartbeat file). On stderr it prints `specreview: waiting for a review of <doc> vN (as claude). Safe to interrupt; nothing is lost.`
- Only one `wait` per doc and agent is live. Starting a new one makes the older one print `specreview: superseded by pid N (a newer wait is listening); ignore this.` and exit 6.
- **Single comments.** The reviewer can send one comment at once instead of a whole review (**Send now** in the UI, or `specreview snip --send`). It arrives as an ordinary review with verdict `comment` and one thread, so a running `wait` exits with a short packet. A `COMMENT` verdict still needs action: handle the thread, revise, and wait again.
- **Delivery and acknowledgement.** A review is marked delivered only after the packet has been written to stdout, so a killed `wait` re-delivers next time. The agent's next command on that doc (`revise`, `reply`, `apply`, `edit`, `show`, `feedback`, `ask`, `reanchor`) acknowledges it. The UI shows "Delivered to claude 14:02", then "revising…".

## 6. The feedback packet

### 6.1 Text form (round 1)

```text
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
  crop: /home/eric/proj/.specreview/docs/token-service/attachments/a1.png  (Read it to see the region)
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
  Questions: answer in the reply; edit only if the answer belongs in the spec. Unsure: status needs_input.
NEXT: edits -> specreview revise token-service --replies - (JSON, one entry per thread) -> specreview wait token-service (background)
```

### 6.2 Text form (later rounds and approval)

```text
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
NEXT: edits -> specreview revise token-service --replies - -> specreview wait token-service (background)
```

```text
SPECREVIEW FEEDBACK · token-service · review rv3 on v3 · APPROVED · FINAL = v3
0 threads need action · 7 resolved · 0 open
NEXT: specreview final token-service --decisions   (then stop waiting)
```

### 6.3 Text grammar

- **Header:** `SPECREVIEW FEEDBACK · <doc> (<path>) · review <rvN> on <vN> · <VERDICT>[ · FINAL = vN]`. Verdicts: `COMMENT`, `CHANGES REQUESTED`, `APPROVED`.
- **Line basis:** `Line numbers = current file on disk (identical to vN).` or `(working copy differs from vN: lines mapped)`. Anchors are mapped from head to the working copy, and `src>` is read from the working copy.
- **Counts:** threads needing action, by kind; resolved this round.
- **Item header:** `[tN] [LABEL ·] [severity ·] <type> · L<a>[-<b>] · §<section path> [· <target>]`, in file order, blocking first within ties. Severity is shown when it is not `normal`.
- **Labels:** none for new threads; `REOPENED` (the reviewer reopened a thread you addressed); `REPLY` (a reviewer reply on an addressed, answered or declined thread); `ANSWER` (the reviewer answered your `needs_input`).
- **Targets:**

| Target | Example |
|---|---|
| Text | (no label; see `on:`) |
| Whole element | `<img alt="System overview">` |
| Region of an image, SVG, canvas, video or iframe | `<img alt="…"> region x40-62% y10-30%` plus `crop:` |
| Snipped area (any mix of blocks) | `snip (figure + 2 paragraphs)` plus `image:`; `src>` covers every block under the box (JSON `target: "snip"`) |
| Mermaid node | `mermaid node "Gateway"` (`src>` narrowed to the fence line with the node) |
| Table cell, row, column | `table cell row "refresh_token" x col "TTL" = "30d"` |
| Code lines | the exact source lines |
| Math | `math` with `src> $E=mc^2$` |
| Section | `§7 Rollout plan (L170-196)` |
| Source lines | the exact lines (for head metadata, script config, attributes) |
| Whole doc | `GENERAL:` (a screenshot of the reviewer's screen is usually a GENERAL thread with an `image:` line) |
| Script-generated text | `(script-rendered inside <div id="chart">)`; `src>` is the enclosing static element |

- **`on:`** the rendered text the reviewer selected, up to 120 characters. Not source.
- **`src>`** full source lines of the working copy, extended by whole lines until the string is unique in the file. Strip the `  src> ` prefix (two spaces, `src>`, one space) and join with `\n` for an exact `old_string`.
  - More than 8 lines: shortened to the first 3, `...(N more lines)`, and the last line (`srcUnique: false`); not a valid `old_string`.
  - A line longer than about 300 characters: printed as the shortest unique window around the anchor (`srcWindow: true`); still a valid `old_string`.
  - `data:` URIs: elided as `data:image/png;base64,...(512 KB)` (`srcEditable: false`).
  - At most 1,200 characters of `src>` per thread.
- **`crop:`** an absolute path to a PNG of the reviewer's region. Asset paths are absolute too.
- **`image:`** an absolute path to a picture the reviewer attached: a snipped area of the doc (`b`; `(Read it to see what the reviewer snipped)`), a screenshot of anything on their screen (`B`, `specreview snip`) or a pasted image (`(Read it to see the image the reviewer attached)`). PNG, or JPEG for very large screenshots. A thread can have several.
- **Pictures are part of the comment.** The agent MUST open every `crop:` and `image:` file before acting on that thread (Claude Code: the Read tool). The comment text often only makes sense with the picture ("this arrow", "this is what it looks like now").
- **Suggestion:** `apply verbatim: specreview apply <doc> <tid>` in the header, then `- old` / `+ new` lines.
- **Conversation:** the last agent reply (`claude (v2): …`, `claude (v2, needs_input): …`) and every reviewer comment after it. Older comments collapse to `(+2 earlier, specreview show <doc> t2)`.
- **Anchor notes:** `(outdated: text changed)`; `(orphaned: was "…" in §5 v1 L260; reanchor with specreview reanchor)`.
- **Footer:** `LOCKED (agreed - do not modify): …`, `DECISIONS to keep true: …`, drafts (only with `--include-drafts`, labelled as not submitted), `PROTOCOL: …`, `NEXT: …`.
- **Size cap:** 10,000 characters. Threads beyond the cap are listed one per line with `specreview show <doc> tN`.

### 6.4 JSON form (`--json`, MCP `structuredContent`)

```json
{"schema":1,"doc":"token-service","path":"docs/specs/token-service.md","head":1,"working":"clean",
 "reviews":[{"id":"rv1","version":1,"verdict":"changes_requested","body":"...","by":"Eric","at":"..."}],
 "verdict":"changes_requested","final":null,
 "threads":[{"id":"t1","why":"new","type":"comment","severity":"blocking","status":"open",
   "lines":[42,43],"section":["3 Tokens","3.2 Token refresh"],"target":"text","label":"text",
   "on":"rotated on every use","src":"Refresh tokens are rotated on every use, and the previous token is\ninvalidated immediately.",
   "srcUnique":true,"srcWindow":false,"srcEditable":true,"anchorState":"exact",
   "comments":[{"by":"Eric","kind":"human","body":"...","at":"..."}],
   "suggestion":null,"attachments":[],"apply":null}],
 "locks":[{"id":"L1","lines":[170,196],"section":["7 Rollout plan"]}],
 "decisions":[],"drafts":null,
 "counts":{"actionable":4,"new":4,"reopened":0,"reply":0,"answer":0,"awaitingReviewer":0,"resolved":0,"outdated":0},
 "next":"targeted edits, then: specreview revise token-service --replies -"}
```

- `why`: `new`, `reopened`, `reply` or `answer`.
- `attachments`: absolute paths of the thread's `crop:` and `image:` files, in order. `attachmentKind` says what they show: `region` (a region crop, printed as `crop:`), `snip` (a snipped area of the doc) or `image` (a screenshot or pasted image); both print as `image:`. Listed drafts (`--include-drafts`) carry absolute `attachments` too.
- `anchorState`: `exact`, `moved`, `edited`, `changed` or `orphaned` (see [section 10](#10-anchors-re-anchoring-and-agent-questions)).
- A thread is **actionable** when its status is `open`, or when the reviewer's newest comment is newer than the agent's newest comment and it is not `resolved`.

### 6.5 Pictures: snips and screenshots

Reviewers attach pictures with one key: `b` snips any area of the rendered doc, `B` (or `specreview snip`, often bound to a global hotkey) captures anything on their screen. Such threads look like this:

```text
[t5] comment · L60-64 · §2 Request flow · snip (figure + 2 paragraphs)
  src> ![Request flow](./img/request-flow.png)
  src> 
  src> Clients call the gateway, which forwards each request to the token service.
  src> 
  src> On a timeout the gateway retries once, then fails over to the standby region.
  image: /home/eric/proj/.specreview/docs/token-service/attachments/a2.png  (Read it to see what the reviewer snipped)
  Eric: The figure shows the client retrying, but the text says the gateway does. Which is it?

[t6] comment · GENERAL
  image: /home/eric/proj/.specreview/docs/token-service/attachments/a3.png  (Read it to see the image the reviewer attached)
  Eric: This is the login page today. The mockup in §5 should match it.
```

- Open each `image:` file before deciding anything. The words alone are often ambiguous.
- A snip's `src>` covers every block under the box, in file order. Edit only what the comment asks about; the other lines are context. A large snip is shortened (`...(N more lines)`) like any long `src>`: Read those lines from the file before editing.
- A screenshot on a GENERAL thread may show something outside the doc, such as the running app or a terminal. Relate it to the spec through the comment; if you cannot tell which part of the spec it concerns, reply `needs_input` with one precise question.
- A screenshot on a text thread (the reviewer had text selected) has the usual `on:` and `src>`; the picture explains what they mean about that text.

## 7. Acting on feedback

**Read the spec file (or the cited ranges) before editing.** The reviewer may have recorded their own revision or applied a suggestion since the packet was printed.

| Thread | Action | Reply status |
|---|---|---|
| suggestion | `specreview apply <doc> <tid>`; never retype it | `addressed` (an automatic reply is added if you give none) |
| comment you agree with | Targeted edit replacing the `src>` text | `addressed` |
| question | Answer in the reply; edit only if the answer belongs in the spec | `answered`, or `addressed` if you edited |
| disagree | No edit; explain why | `declined` |
| unclear | No edit; ask one precise question | `needs_input` |
| image / diagram region | Read the `crop:`; edit the diagram source (mermaid, inline SVG, or the generating script) | `addressed` |
| snipped area (`image:`) | Read the `image:` first; then edit the blocks in `src>` (Read the file when `src>` is shortened) | `addressed` |
| screenshot on a GENERAL thread | Read the `image:`; it may show something outside the doc (the running app, a terminal). Change the spec where the comment points; if it is unclear which part, ask | `addressed`, or `needs_input` |
| REOPENED | Read the new comment; fix again | `addressed` |
| ANSWER | Apply the answer | `addressed` |

**Editing rules:**

1. Make the smallest local change. Keep the surrounding formatting; never re-wrap paragraphs or reformat tables you were not asked to touch.
2. Do all Edit-tool (or `specreview edit`) edits first. Then run `specreview apply <doc> <tid...>` for suggestions. `apply` rewrites the file, so re-read it before any later edit. If your editor reports the file changed since it was read, re-read and retry.
3. Edit bottom-up, or locate text by the `src>` string rather than by line numbers.
4. Never write the whole file again, never regenerate it, never touch locked text, and never make drive-by edits.
5. Never revert a change you did not make. The reviewer, a formatter or another tool may have edited the file.

**`specreview apply <doc> <tid...> [--dry-run]`** maps the thread's anchored range from head to the working copy. If the expected text is there, it is replaced. Otherwise, if it occurs exactly once, or one occurrence is within 2,000 characters of the expected place, that one is replaced. Otherwise it reports `conflict t3: expected text not found near L120; treat as a normal comment` (exit 3). On success the edit is tagged to the thread and the suggestion becomes `staged`; it becomes `applied` when the next `revise` records it.

```text
$ specreview apply token-service t3
applied t3 at L120 (exact) · staged (not recorded yet)
```

**`specreview edit`** is an exact replace tagged to threads, with Edit-tool semantics: `old` must occur exactly once unless `--all`.

```bash
specreview edit token-service --thread t1 --old "rotated on every use" --new "rotated with a 30 s reuse-detection grace window"
specreview edit token-service --stdin <<'JSON'
[{"threads": ["t1"], "old": "rotated on every use", "new": "rotated with a 30 s grace window"},
 {"threads": ["t4"], "old": "| refresh_token | opaque | 30d |", "new": "| refresh_token (user) | opaque | 30d |", "all": false}]
JSON
```

## 8. Recording a revision

### 8.1 Input

```bash
specreview revise token-service --replies - <<'JSON'
{"summary": "rv1: grace window, retry policy, figure caption",
 "threads": {
  "t1": {"status": "addressed", "reply": "Replaced rotate-every-use with a 30 s reuse-detection grace window; added rationale."},
  "t2": {"status": "addressed", "reply": "Gateway sits in front of auth. Fixed the caption.", "at": "L90-91"},
  "t3": {"status": "addressed", "reply": "Applied your suggestion."},
  "t4": {"status": "needs_input", "reply": "Split TTL by role: user 30d, admin 12h or 24h?"}},
 "other": [{"at": "L12", "why": "Bumped 'Last revised' date"}]}
JSON
```

Schema:

| Field | Type | Meaning |
|---|---|---|
| `summary` | string | One line describing the revision. `-m <summary>` overrides it. |
| `threads` | object | One entry per thread listed in the packet, keyed by thread id. |
| `threads.<tid>.status` | `addressed` \| `answered` \| `declined` \| `needs_input` | `addressed`: you changed the spec. `answered`: reply only. `declined`: you disagree. `needs_input`: you need the reviewer to decide. |
| `threads.<tid>.reply` | string | Markdown shown to the reviewer on the thread. |
| `threads.<tid>.at` | string, optional | Lines of the **new** file you changed for this thread: `"L90-91"`, `"L12,L90-91"`. Links hunks that are not at the anchored text. |
| `other` | array, optional | `[{ "at": "L12" \| "L12-14" \| "del:h6" \| "h6", "why": string }]`. Explains changes no thread asked for, and edits you did not make (`"why": "not mine: external edit"`). |
| `breakLocks` | object, optional | `{ "L1": "reason" }`. Same as `--break-lock L1="reason"`. Only when the user explicitly asks. |

Flags: `-m <summary>`, `--replies <file|->`, `--dry-run` (print the full report, record nothing), `--break-lock L1="why"` (repeatable), `--allow-rewrite`, `--force`.

### 8.2 What `revise` does

1. Locks the doc and reads the working copy. If it equals head and there are replies, it posts the replies only; with no replies either, it reports "nothing to record" and exits 0.
2. Computes hunks (head to working copy), links each hunk to threads, and runs the guards. On refusal it stops (exit 3) and the working copy is untouched.
3. Snapshots local assets, commits the new version, re-anchors every thread and lock, posts the replies, marks staged suggestions applied, and notifies the UI.

### 8.3 Report

```text
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

### 8.4 Refusal

```text
specreview: REFUSED - nothing recorded (exit 3)
  ERR lock: h5 L171-174 changes L1 §7 Rollout plan (agreed in rv1)
      fix: specreview revert token-service --hunk h5   or   --break-lock L1="<reason>"
  ERR deletion: h6 removes 14 lines (v1 L201-214, §8 Open questions) linked to no thread
      fix: specreview revert token-service --hunk h6   or   add "other":[{"at":"del:h6","why":"..."}]
  WARN t2 marked addressed but no hunk is linked to it (add "at":"L90-91" if you changed it)
working copy left untouched. Preview with --dry-run.
```

Follow the printed `fix:` lines. Revert hunks that were your mistake (`specreview revert <doc> --hunk hN`), explain intended changes with `other`, and add `at` hints. For a lock, ask the reviewer (`needs_input`) unless the user explicitly asked you to break it. Never revert a hunk you did not make; explain it instead.

### 8.5 Replying without a version

```bash
specreview reply token-service t2 -m "It sits in front; see the caption at L90." --status answered
```

`reply` accepts `--status answered|declined|needs_input|addressed`, `--at L42-46` and `--decision "text"`. Exit 4 if the thread does not exist.

## 9. Guards and attribution

### 9.1 Attribution: how hunks are linked to threads

For each hunk between head and the working copy, in order:

1. **tagged:** an `apply` or `edit` for that thread produced it.
2. **hint:** a thread's `at` lines overlap the hunk's new lines.
3. **overlap:** the hunk changes text inside an actionable thread's anchored range (widened to whole lines).
4. Otherwise it is **unlinked**. An `other` entry explains it: `at: "L12"` overlaps the new lines; `at: "del:h6"` or `"h6"` names the hunk.

Edits made by people or other tools cannot be told apart from yours; they show up as unlinked hunks.

### 9.2 Guards

| Check | Default | Way out |
|---|---|---|
| An active lock's agreed text is no longer intact at the new version | refuse | `revert --lock L1` or `revert --hunk hN`; `--break-lock L1="reason"` only when the user asks |
| ... but the lock was created after the last packet the agent received | warn | |
| An unlinked, unexplained hunk removes or replaces 20 or more words, or 3 or more whole old lines | refuse | an `other` entry, `revert --hunk hN`, or config `guards.unexplainedDeletion: warn` or `off` |
| Rewrite ratio (removed or replaced old characters / old length) above 0.5, when head has 40 or more lines | refuse | `--allow-rewrite`, only when the user asked for a rewrite |
| A thread in the packet has no reply entry | warn | |
| A thread marked `addressed` has no linked hunk and no asset change | warn | add `at` |
| A decision's anchored text intersects a hunk not linked to that decision's thread | warn | |
| `--force` | overrides every refusal; recorded and shown in red in the UI | only on explicit request |

### 9.3 Changed images

Local assets are snapshotted per version. A changed image counts as a change to every element that references it, so a thread on that image is linked to the change and the reviewer sees a before/after pair.

## 10. Anchors, re-anchoring and agent questions

After every version, SpecReview re-anchors every thread and lock against the new source, one version at a time: untouched text first, then text inside linked hunks, then exact matches elsewhere, then fuzzy matches, then the thread's original anchor.

| State | Meaning | Packet |
|---|---|---|
| `exact` | Same text, same lines | lines |
| `moved` | Same text, different place | lines |
| `edited` | Changed by a hunk linked to the thread | lines of the new text |
| `changed` | The quoted text was edited without a link ("outdated") | `(outdated: text changed)` |
| `orphaned` | Not found | `(orphaned: was "…" in §5 v1 L260; reanchor with specreview reanchor)` |

- **Move an anchor:** `specreview reanchor <doc> <tid> --lines A-B` or `--quote "exact text"`. It applies to head when the working copy is clean; otherwise it is staged until the next `revise`.
- **Ask the reviewer:** `specreview ask <doc> --quote "exact text" -m "question"` (or `--lines A-B`) creates an `agent-question` thread with status `needs_input`. The answer arrives in a later packet as `ANSWER`.

## 11. Locks and decisions

- **Locks** ("Mark agreed" in the UI) are hard guarantees. `revise` refuses a version in which the agreed text is not intact. `specreview revert <doc> --lock L1` writes the agreed text back. Breaking a lock (`--break-lock L1="reason"`) records the break, deactivates the lock and shows a red badge until the reviewer re-locks it.
- **Decisions** are soft. The reviewer records one when accepting a thread ("Record as decision"). A hunk that touches a decision's text, without being linked to that decision's thread, is a warning, and every packet lists decisions under `DECISIONS to keep true`.

## 12. Approval and the final version

When the reviewer approves with "Mark vN final", the packet says `APPROVED · FINAL = vN`. Then:

```text
$ specreview final token-service --decisions
final: token-service = v3 (approved in rv3 by Eric; 3 versions, 3 reviews, 7 threads resolved, 2 decisions)
working copy matches v3: ok
wrote docs/specs/token-service.decisions.md
```

If the same submission also reopened a thread or answered a question, the packet lists those threads and NEXT says to answer each with `specreview reply <doc> <tid> -m … --status answered|declined` (no edits, no new version) before running `final`; without a status the thread stays open.

`final` exits 3 if the working copy does not match the final version. `--out <dir>` changes where the decisions file is written. A later `revise` puts the doc back in review; the earlier final stays in the history.

## 13. Recovery

| Situation | Do |
|---|---|
| The user says "done" or "submitted" but no packet arrived | `specreview feedback <doc> --include-drafts`. If it lists only drafts, ask the user to click **Submit review**. Do not act on drafts. |
| The background wait died (agent restarted) | `specreview feedback <doc>`; the prompt hook also reminds you. |
| `wait` exits 3 | The working copy has unrecorded edits. Record them with `revise`, then wait. If they are not yours, ask the user (the UI offers **Record as my revision**). |
| `wait` exits 6 | Another `wait` took over. Ignore it. |
| The user mentions "t4" | `specreview show <doc> t4` |
| You need old text | `specreview show <doc> --version N --lines A-B` |
| What changed between versions | `specreview diff <doc> v1..v2 --stat` or `--unified` |

## 14. Claude Code hooks

Both hooks read the hook JSON on stdin, print nothing on any error, always exit 0, and finish quickly.

- **`specreview hook pre-write`** (PreToolUse, matcher `Write`). If the target is a tracked doc with at least one review, its state is not `closed`, and `guards.writeHook` is not `off`, it compares the new content with the file. If more than `guards.writeHookRatio` (0.4) of the lines would change, it denies the Write:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"docs/specs/token-service.md is under SpecReview (v2, 3 open threads, L1 locked). Use Edit for targeted changes (or specreview apply/edit). If the user explicitly asked for a full rewrite, use `specreview revise --allow-rewrite` after writing with Edit."}}
  ```

  With `guards.writeHook: "warn"` it returns `"ask"` instead, so the user decides.
- **`specreview hook prompt`** (UserPromptSubmit). For docs in the current workspace, it adds context when a submitted review was not delivered and no live `wait` exists, or was delivered more than about 5 minutes ago and never acknowledged:

  ```json
  {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"specreview: review rv2 on token-service (2 threads, CHANGES REQUESTED) was submitted at 14:20 and not delivered. Run `specreview feedback token-service` and address it per the spec-review skill."}}
  ```

  The note is capped at 1,000 characters. When the current directory has no workspace at or above it, the workspaces registered by `open` below it are checked instead, and the suggested command names the workspace (`specreview feedback token-service --workspace notes/specs`).

The plugin registers the hooks as `specreview hook pre-write` and `specreview hook prompt` (the binary on `PATH`). `specreview install claude --with-hooks --apply` writes them into settings with absolute paths instead. The plan gate below is opt-in: neither the plugin nor `specreview install` registers it unless asked with `--with-plan-gate` (on `install` or `install claude`). A gate already in settings is kept, and re-pointed, by later installs.

**Plan-mode gate.** `specreview plan-gate` is a PermissionRequest hook (matcher `ExitPlanMode`, timeout 345600 s) that runs the full CLI, not the fast hook path:

- It reads the plan from `tool_input.planFilePath` when that is an absolute path to a regular `.md` file under 2 MB (a symlink only when its target is one too), else from `tool_input.plan`, and records it as a snapshot doc (section 19) with the origin key `claude-plan:<session_id>:<planFilePath or "inline">`, in the workspace of `$CLAUDE_PROJECT_DIR` (else the hook's `cwd`). The first ExitPlanMode records v1; each later one for the same plan file records the next version, so the reviewer sees a diff. Open threads that the new version's changes are linked to get the reply `Changed in vN.` (status addressed), since Claude has no reply channel at the gate.
- It opens the review UI in the system browser (unless `--browser none` or `$SPECREVIEW_BROWSER=none`; `pane` means the system browser here, since a hook cannot drive the agent's pane) and blocks until a review of that version is submitted (`--timeout` gives up; by default it waits until Claude Code cancels it). Plan reviews belong to the gate: `wait --all` and a `wait` without a doc skip plan docs. A gate whose version is no longer the doc's head (a newer ExitPlanMode recorded a later one) steps aside.
- **Approve** prints the allow decision, whose `updatedInput` is the tool input with `plan` set to the reviewed text:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"# Plan: cache\n…","planFilePath":"/Users/me/.claude/plans/cache.md"}}}}
  ```

- **Request changes** or **Comment** prints a deny decision whose `message` is the feedback: the packet's threads and `src>` lines, citing the plan file and its line numbers, then what to do: make targeted Edit-tool changes to that file (never rewrite it), address every thread, call ExitPlanMode again.

  ```json
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"YOUR PLAN WAS NOT APPROVED: the reviewer requested changes (SpecReview rv1 on v1).\nPlan file: /Users/me/.claude/plans/cache.md   (line numbers below are lines of this file)\n…"}}}
  ```

- The review is marked delivered only after the decision reached stdout. On any error (bad input, the server not starting), on SIGTERM/SIGINT/SIGHUP (the user answered in the terminal first, and Claude Code discards the hook) or on a closed stdout, it prints nothing, exits 0 and marks nothing delivered: Claude Code then decides as if there were no hook. Comments sent with an approval are not passed on: the allow decision has no field for them.

## 15. MCP tools

`specreview mcp` is a stdio MCP server. Logs go to stderr only. Every tool returns the CLI text as `content: [{type: "text"}]` and the `--json` shape as `structuredContent`, with `isError: true` on a refusal or conflict.

| Tool | Input | Returns |
|---|---|---|
| `specreview_open` | `{path, title?}` | `{doc, version, url}` |
| `specreview_wait` | `{doc?, timeout_sec?}` (default 50, max 600) | the packet, `{status: "waiting", hint: "call again"}`, or `{status: "closed"}` |
| `specreview_feedback` | `{doc, peek?, include_drafts?}` | the packet |
| `specreview_apply` | `{doc, thread_ids}` | `{applied, conflicts}` |
| `specreview_edit` | `{doc, thread_ids, old_string, new_string, replace_all?}` | `{lines}` |
| `specreview_reply` | `{doc, thread_id, body, status?, at?, decision?}` | thread summary |
| `specreview_revise` | `{doc, summary, threads, other?, break_locks?, allow_rewrite?, dry_run?}` | the revise report |
| `specreview_revert` | `{doc, hunk?, lock?}` | report |
| `specreview_reanchor` | `{doc, thread_id, lines?, quote?}` | the anchor |
| `specreview_ask` | `{doc, body, quote? or lines?}` | the new agent-question thread |
| `specreview_threads` | `{doc, status?}` | one line per thread (`structuredContent.threads`) |
| `specreview_diff` | `{doc, from?, to?, format?: "stat" or "unified"}` | the diff |
| `specreview_log`, `specreview_status` | `{doc?}` | text |
| `specreview_show` | `{doc, thread_id?, version?, lines?}` | text |
| `specreview_final` | `{doc, decisions?, out_dir?}` | paths |

While `specreview_wait` blocks, it sends progress notifications every 15 s when the request carries a progress token. MCP-only loop: `specreview_open`, `specreview_wait` (again while it returns `waiting`), `specreview_apply` / `specreview_edit`, `specreview_revise`.

## 16. Command reference

| Command | Behaviour | Exit |
|---|---|---|
| `open <file...> [--title T] [--browser pane\|system\|none] [--workspace <dir>] [--json]` | Track the doc and record v1 if new; start the server; print the URL; warn if dirty | 0 |
| `open <dir>` | Open every `.md`/`.markdown`/`.html`/`.htm` file below the folder (at most 200); one line per doc and the UI's home URL | 0 |
| `open - [--name N] [--title T]` | Piped Markdown (at most 5 MB) as a snapshot doc; the same `--name` records a new version | 0 |
| `last [--session <id>] [--transcript <path>] [--title T] [--browser pane\|system\|none]` | The agent's last message (Claude Code transcript) as a snapshot doc; prints the URL and the wait command | 0 / 4 |
| `wait [<doc>] [--all] [--timeout 0\|30m] [--allow-dirty] [--json]` | Block until a review arrives; print the packet; mark it delivered | 0 / 2 / 3 / 5 / 6 |
| `feedback <doc> [--peek] [--include-drafts] [--all-open] [--json]` | The packet, without blocking; marks delivered unless `--peek` | 0 |
| `apply <doc> <tid...> [--dry-run]` | Apply suggestions verbatim; stage tagged edits | 0 / 3 |
| `edit <doc> --thread t1[,t2] --old <s> --new <s> [--all]` | Thread-tagged exact replace | 0 / 3 |
| `edit <doc> --stdin` | Batch of `{threads, old, new, all?}` on stdin | 0 / 3 |
| `reply <doc> <tid> -m <md> [--status answered\|declined\|needs_input\|addressed] [--at L42-46] [--decision "text"]` | Reply without a version | 0 / 4 |
| `revise <doc> [-m <summary>] [--replies <file\|->] [--dry-run] [--break-lock L1="why"]... [--allow-rewrite] [--force]` | Record a version with replies | 0 / 3 |
| `revise <doc> --source <file\|-> [--replies <file\|->]` | Snapshot docs: record the given text as the new version | 0 |
| `revert <doc> (--hunk hN \| --lock L1)` | Restore part of the working copy | 0 / 3 |
| `reanchor <doc> <tid> (--lines A-B \| --quote TEXT)` | Move a thread's anchor | 0 / 3 |
| `ask <doc> (--quote TEXT \| --lines A-B) -m <question>` | Ask the reviewer a question | 0 / 3 |
| `threads <doc> [--status open\|addressed\|needs_input\|resolved\|outdated\|all] [--json]` | One line per thread | 0 |
| `show <doc> [<tid>] [--version N] [--lines A-B]` | A thread with its timeline, or old source | 0 / 4 |
| `diff <doc> [vA..vB] [--stat\|--unified] [--json]` | Changes (default: last reviewed..head) | 0 |
| `log <doc> [--json]` | Timeline | 0 |
| `status [<doc>] [--json]` | Docs, head, counts, undelivered reviews, listeners, working copy | 0 |
| `final <doc> [--decisions] [--out <dir>]` | Final checks and the decisions export | 0 / 3 |
| `close <doc>` | End the review session; waits exit 5 | 0 |
| `snip [<doc>] [-m <text>] [--question] [--send] [--file <png>] [--json]` | Reviewer tool: a screenshot (macOS picker, or `--file`) as a draft comment, or submitted at once with `--send`. Agents do not run it: it opens a picker on the reviewer's screen | 0 |
| `serve [--foreground] [--port N]` · `stop [--rotate]` · `doctor [--fix]` | Server control and checks | |
| `mcp` | stdio MCP server | |
| `hook pre-write` · `hook prompt` | Claude Code hooks | always 0 |
| `plan-gate [--timeout 30m] [--browser system\|none]` | Claude Code plan-mode gate (section 14) | always 0 |
| `install claude [--user\|--project] [--with-hooks] [--with-mcp] [--apply]` · `install agents-md [--apply]` | Print, or with `--apply` write, the integration files | 0 |

## 17. Rules summary

Do:

- Write the spec once, then only make targeted edits.
- Read the file before editing; re-read after `apply` and whenever the editor says it changed.
- Open every `crop:` and `image:` picture before acting on its thread.
- Give one reply per listed thread; use `needs_input` when unsure.
- Explain every change no thread asked for in `other`.
- Follow the printed `fix:` on a refusal.
- End the turn after starting a background wait; never poll.

Do not:

- Write the whole file again, regenerate it, or reformat it.
- Modify `LOCKED` text or text behind `DECISIONS` without the reviewer's say-so.
- Revert hunks you did not make.
- Use `--force`, `--allow-rewrite` or `--break-lock` unless the user explicitly asks.
- Act on draft comments the reviewer has not submitted.
- Resolve threads: only the reviewer resolves.

## 18. Writing specs that review well

- **Format:** Markdown by default; HTML only when layout or interactivity matters.
- **Structure:** unique, stable headings (sections, locks and `§` paths come from them); real tables with header rows; reasonably short lines (diffs and `src>` excerpts are per line); no repeated boilerplate sentences.
- **Diagrams:** mermaid fences (Markdown), `<pre class="mermaid">` (HTML), or inline `<svg>` with readable ids and `<text>` labels, so single nodes are commentable and fixes are small text edits.
- **Images:** local files referenced by relative path (versioned with each revision, with before/after when they change); no `data:` URIs.
- **HTML:** keep reviewable text in static markup rather than client-side templating; self-contained (no CDN scripts, fonts or images); pretty-printed, not minified; real `<h1>`-`<h6>` with ids; no restrictive `Content-Security-Policy` meta; no content to be reviewed inside nested iframes or shadow DOM.
- **When editing:** never re-wrap existing paragraphs; keep heading text stable unless asked.

The longer version, with reasons, is in [`integrations/claude-code/skills/spec-review/reference.md`](../integrations/claude-code/skills/spec-review/reference.md#writing-specs-that-review-well).

## 19. Snapshot docs: plans, messages, piped text

A **snapshot doc** reviews text that is not a file in the workspace: a Claude Code plan (the plan gate), an agent's last message (`specreview last`, `/specreview-last` in Claude Code) or Markdown piped to `specreview open -`. Its versions are recorded from text; its synthetic path (`plans/<slug>.md`, `messages/<slug>.md`, `text/<slug>.md`) is never read or written and never matches a real file. Threads, attribution, re-anchoring, Changes and History work as for file docs.

- The packet header names the kind (`token-plan (Claude Code plan)`), line numbers are lines of the head version, and no thread offers `specreview apply`.
- `apply`, `edit` and `revert` are refused (exit 3) with what to do instead, and so is `revise` without `--source` (exit 1).
- **Revising a message or piped text:** write the complete revised text to a temporary file (`specreview show <doc>` prints the current version), address every thread in it, and run `specreview revise <doc> --source <file> --replies -` with the replies JSON (section 8.1) on stdin. With `--source -` the text comes from stdin, so `--replies` must name a file. The guards run, but their errors are recorded as warnings: a snapshot revision is never refused.
- **Revising a plan:** edit the plan file with targeted Edit-tool changes and call ExitPlanMode again; the plan gate records the version.
- **Workspace:** found from the current directory as usual. When that is your home directory or `/`, the doc goes to the scratch workspace `$SPECREVIEW_HOME/scratch/<8 hex>/`, and every printed command carries `--workspace <dir>`: keep it on every command for that doc.
- `specreview last` reads `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<session>.jsonl` (session from `--session`, else `$CLAUDE_CODE_SESSION_ID`; else the newest transcript of the current directory), takes the newest assistant message with text (skipping sidechains, tool results and command echoes), and returns at once. When the newest assistant message is still running a tool call (you ran `specreview last` yourself, maybe after a sentence), that whole turn is skipped. The text is stored with a final newline, as `show` prints it. Running it again for the same message reopens the same doc and records nothing, so your revisions stay. Codex transcripts are not supported.
