<!-- The complete, agent-agnostic Suiko protocol: commands, waiting, the feedback packet, edits, the revise JSON, guards and recovery. The Claude Code skill (integrations/claude-code/skills/spec-review/) and the AGENTS.md snippet (integrations/agents-md/) are condensed forms of this document; keep them in sync. -->

# Suiko agent protocol

This is the contract between Suiko and the coding agent that revises a document under review. It applies to every agent: Claude Code (through the `spec-review` skill), Codex, Gemini CLI, any MCP client, or a person at a terminal. The CLI's text and JSON output, its exit codes and the MCP tools are the whole interface. Suiko never calls an LLM.

It starts at `suiko open`. Until then the agent writes the document exactly as it would without Suiko, with whatever HTML, CSS, JavaScript, libraries, data files or build scripts the best document needs: nothing here is about how to write it.

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
18. [Snapshot docs: plans, messages, piped text, web pages](#18-snapshot-docs-plans-messages-piped-text-web-pages)
19. [Code reviews](#19-code-reviews)

## 1. Model

| Term | Meaning | Id |
|---|---|---|
| Workspace | The directory that holds `.specreview/` (nearest ancestor with one, else the git top level, else the file's directory) | `wsId` |
| Doc | A tracked document file (`.html`, `.htm`, `.md`, `.markdown`) | slug of the file name, e.g. `funding-study` |
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
the document exists        ──> suiko open <file>            (records v1, prints the UI URL)
                               show the URL to the reviewer
                               suiko wait <doc>             (background, foreground, or "done" mode)
reviewer comments, sends   ──> wait exits 0 and prints the packet
agent reads the cited lines, changes what each thread asks for (Edit tool or suiko edit, or the
  document's sources and a rebuild), then suiko apply for suggestions (a built document: the
  suggested text goes into its sources too)
                               suiko revise <doc> --replies -   (records v2, links hunks to threads, runs guards)
                               reports to the user, waits again
reviewer checks the changes ──> accepts / reopens / replies, sends again ... until APPROVED
                               suiko final <doc> --decisions
```

## 3. Conventions

- **`<doc>`** is a doc id or a file path. An id is looked up in the workspace of the current directory; when it is not tracked there (or the directory has none, e.g. a project without git whose `.specreview/` sits next to the documents), in the workspaces `open` registered below or above the current directory. An id tracked in several of them is an error naming them: pass the file path or `--workspace <dir>`.
- **Line numbers** are 1-based lines of the **current working file**. `L42-43` is inclusive. Hunk ranges inside Suiko are half-open, but every range printed for the agent is an inclusive `L<a>-<b>`.
- **Output** is compact text; `--json` (where listed) prints the same data structured.
- **Agent name** (used for delivery and presence): `--as <name>`, else `$SPECREVIEW_AGENT`, else `claude` when `$CLAUDECODE` is set, else `agent`.
- **Environment:** `SPECREVIEW_HOME` (runtime state, default `~/.specreview`), `SPECREVIEW_PORT` (UI port; the content port is UI port + 1).
- **Exit codes:**

| Code | Name | Meaning |
|---|---|---|
| 0 | OK | Success, or a packet was delivered (any verdict) |
| 1 | ERROR | Generic error or bad usage |
| 2 | TIMEOUT | `wait --timeout` expired |
| 3 | REFUSED | A guard refused, the working copy is dirty, a thread you received has no reply yet (`wait`), a compare-and-swap conflict, or `old` is not unique |
| 4 | NOT_FOUND | Doc, thread or version not found |
| 5 | CLOSED | The review session was closed (UI or `suiko close`) |
| 6 | SUPERSEDED | A newer `wait` for the same doc and agent replaced this one; ignore it |

## 4. Starting a review

```text
$ suiko open reports/funding-study.html
suiko: tracking reports/funding-study.html as "funding-study" (html, 1377 lines) · recorded v1
review UI: http://127.0.0.1:4777/d/3f9a1c2e/funding-study?k=Zx81Qm0v7c
next: the URL was opened in the system browser; run `suiko wait funding-study` in the background
```

- `open` creates `.specreview/` at the workspace root if needed, records v1 (the source bytes plus snapshots of local images and other assets), and starts the local server in the background if it is not running. The document renders exactly as written, scripts and libraries included.
- If the doc is already tracked, `open` only prints the URL. If the working copy differs from head, it adds `working copy differs from v3 (unrecorded)`; `wait` will refuse (exit 3) until that is recorded.
- When the Suiko instructions installed for the agent (the Claude Code skill and commands, a protocol block in AGENTS.md and the like) are older than the CLI, `open` prints one line on stderr that names the command updating exactly those files, e.g. "Your Suiko skill for Claude Code is from 0.3.0; run `suiko install --only claude --apply` to update it." For an AGENTS.md block that `suiko install agents-md` wrote, it names `suiko install agents-md --apply`; for files installed into the project, the command has `--project`. Pass the line on to the user as printed: `npm` upgrades do not refresh those copies.
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
| Background CLI wait | Claude Code (primary) | Bash `suiko wait <doc>` with `run_in_background: true`, then end the turn. No tokens are spent while waiting; the agent is re-invoked when it exits. |
| Foreground CLI wait | Agents whose shell can block for minutes | `suiko wait <doc> --timeout 10m`; exit 2 means run it again. |
| MCP wait | MCP-only agents | Call `suiko_wait` repeatedly; it returns `{"status":"waiting"}` after `timeout_sec` (default 50, max 600). |
| Done mode | Agents with short shell timeouts | The user says "done" once they have sent their comments; run `suiko feedback <doc> --include-drafts`. |
| Prompt hook | Claude Code safety net | Injects a note when a submitted review was not delivered (see [section 14](#14-claude-code-hooks)). |
| Polling | Scripts | `suiko status --json` reports undelivered reviews. |

`wait` details:

- It exits 3 immediately if the working copy differs from head (`run suiko revise first`), unless `--allow-dirty`.
- It returns immediately if undelivered reviews exist; otherwise it blocks until feedback is sent or the session is closed (exit 5). The packet covers **all** undelivered reviews for that doc.
- `wait --all` waits on every doc in the workspace, except Claude Code plans (their reviews go to the plan gate).
- While it runs, the UI shows "**claude is listening**" (presence comes from a heartbeat file). On stderr it prints `suiko: waiting for a review of <doc> vN (as claude). Safe to interrupt; nothing is lost.`
- Only one `wait` per doc and agent is live. Starting a new one makes the older one print `suiko: superseded by pid N (a newer wait is listening); ignore this.` and exit 6.
- **Single comments.** The reviewer usually sends each comment as they write it (or with `suiko snip --send`). Each arrives as an ordinary review with verdict `comment` and one thread, so a running `wait` exits with a short packet; comments sent while you work are merged into your next packet. A `COMMENT` verdict still needs action: handle the thread, revise, and wait again. So does a review whose only feedback is its summary: change what it asks for and record it as `NEXT` says (for a file, `suiko revise <doc> --replies -` with an `other` entry per change). On a long document the reviewer may batch the edits (section 7.1).
- **Delivery and acknowledgement.** A review is marked delivered only after the packet has been written to stdout, so a killed `wait` re-delivers next time. The agent's next command on that doc (`revise`, `reply`, `apply`, `edit`, `show`, `feedback`, `ask`, `reanchor`) acknowledges it. The UI shows "Delivered to claude 14:02", then "revising…".

## 6. The feedback packet

### 6.1 Text form (round 1)

```text
SPECREVIEW FEEDBACK · funding-study (reports/funding-study.html) · review rv1 on v1 · CHANGES REQUESTED
Line numbers = current file on disk (identical to v1).
Reviewer summary: Good start. Section 7 is agreed - keep it.
4 threads need action (4 new): 1 blocking · 1 question · 1 suggestion · 1 comment

[t1] blocking · comment · L212 · §3 Findings > 3.2 Funding stress
  on: "spreads widened on 12 days"
  src>     <p>Funding spreads widened on 12 days, all of them after the March rate decision.</p>
  Eric: Count the days over the full two-year window, and say which threshold you used.

[t2] question · L88 · §2 Method · <img alt="Pipeline overview"> region x40-62% y10-30%
  src>     <img src="img/pipeline.png" alt="Pipeline overview">
  crop: /home/eric/proj/.specreview/docs/funding-study/attachments/a1.png  (Read it to see the region)
  Eric: Does the dedupe step run before or after the join? The arrow is ambiguous.

[t3] suggestion · L120 · §2.1 Data · apply verbatim: suiko apply funding-study t3
  -     <p>Sessions with fewer than 10 trades are dropped.</p>
  +     <p>Sessions with fewer than 10 trades, or with a trading halt, are dropped.</p>
  Eric: Halted sessions skew the spread too.

[t4] comment · L151 · §4 Results · table cell row "2024-Q2" x col "Days" = "4"
  src>       <tr><td>2024-Q2</td><td>4</td><td>61 bp</td></tr>
  Eric: The chart above shows 5 days for this quarter.

LOCKED (agreed - do not modify): L1 §7 Caveats (L170-196)
DECISIONS to keep true: (none yet)
PROTOCOL: change only what the threads ask for; src> lines are exact Edit old_string (for a built doc, change its sources and rebuild); edit bottom-up. Suggestions: `suiko apply` (for a doc built from sources: put the text into the sources and rebuild).
  Questions: answer in the thread's reply; edit only if the answer belongs in the doc. Unsure: status needs_input.
REPLIES: answer every thread above on the thread itself, with a status (the reviewer reads replies in Suiko, not in this chat).
NEXT: edits, if any -> suiko revise funding-study --replies - (JSON, one entry per thread) -> suiko wait funding-study (background)
```

### 6.2 Text form (later rounds and approval)

```text
SPECREVIEW FEEDBACK · funding-study · review rv2 on v2 · CHANGES REQUESTED
Line numbers = current file on disk (identical to v2).
Reviewer summary: Close. The pipeline caption is still unclear.
2 threads need action: 1 reopened · 1 answer to your question   (2 resolved this round)

[t2] REOPENED · question · L90-91 · §2 Method · <img alt="Pipeline overview"> region x40-62% y10-30%
  src>     <figcaption>Figure 2: trades are deduplicated before the join.</figcaption>
  claude (v2): The dedupe runs first. Fixed the caption.
  Eric: Say which steps run per session and which per day.

[t4] ANSWER · comment · L151-152 · §4 Results · table cell row "2024-Q2" x col "Days"
  src>       <tr><td>2024-Q2</td><td>5</td><td>61 bp</td></tr>
  src>       <tr><td>2024-Q3</td><td>?</td><td>48 bp</td></tr>
  claude (v2, needs_input): Q3 has 2 days above 50 bp, or 6 above 40 bp: which threshold?
  Eric: 50 bp everywhere.

LOCKED (agreed - do not modify): L1 §7 Caveats (L173-199)
DECISIONS to keep true: D1 (t1) threshold 50 bp · D2 (t3) drop halted sessions
REPLIES: answer every thread above on the thread itself, with a status (the reviewer reads replies in Suiko, not in this chat).
NEXT: edits, if any -> suiko revise funding-study --replies - (JSON, one entry per thread) -> suiko wait funding-study (background)
```

```text
SPECREVIEW FEEDBACK · funding-study · review rv3 on v3 · APPROVED · FINAL = v3
0 threads need action · 7 resolved · 0 open
NEXT: suiko final funding-study --decisions   (then stop waiting)
```
### 6.3 Text grammar

- **Header:** `SPECREVIEW FEEDBACK · <doc> (<path>) · review <rvN> on <vN> · <VERDICT>[ · FINAL = vN]`. Verdicts: `COMMENT`, `CHANGES REQUESTED`, `APPROVED`.
- **Line basis:** `Line numbers = current file on disk (identical to vN).` or `(working copy differs from vN: lines mapped)`. Anchors are mapped from head to the working copy, and `src>` is read from the working copy.
- **Counts:** threads needing action, by kind; resolved this round.
- **Item header:** `[tN] [LABEL ·] [severity ·] <type> · L<a>[-<b>] · §<section path> [· <target>]`, in file order, blocking first within ties. Severity is shown when it is not `normal`.
- **Labels:** none for new threads; `REOPENED` (the reviewer reopened a thread you addressed); `REPLY` (a reviewer reply on an addressed, answered or declined thread); `ANSWER` (the reviewer answered your `needs_input`); `APPLY` (make the change you planned, section 7.1).
- **Batched edits:** under the counts line, `EDITS: batch. …` (answer every thread now, edit later; `EDITS: batch for every thread not marked APPLY. …` when the packet also has APPLY threads; `EDITS: batch for t9 only (the other threads: edit now). …` when only some threads are batched) and `APPLY: make every planned change below in one pass, then record ONE version as NEXT says (status addressed).` (section 7.1).
- **`use:`** under a thread: `use: <absolute path> (chart.html) — put this into the doc at this thread's place …`, an attachment of yours the reviewer wants in the document (section 7.2). In a packet that approves a final version: `use: <absolute path> (chart.html) — the doc is final (v3); say in your reply whether this should go into a next version`.
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
- **`image:`** an absolute path to a picture the reviewer attached: a snipped area of the doc (the Area tool, `b`; `(Read it to see what the reviewer snipped)`), a screenshot of anything on their screen (`B`, `suiko snip`) or a pasted image (`(Read it to see the image the reviewer attached)`). PNG, or JPEG for very large screenshots. A thread can have several.
- **Pictures are part of the comment.** The agent MUST open every `crop:` and `image:` file before acting on that thread (Claude Code: the Read tool). The comment text often only makes sense with the picture ("this arrow", "this is what it looks like now").
- **Suggestion:** `apply verbatim: suiko apply <doc> <tid>` in the header (in a batched round: `suggestion: plan it now; it is applied in the APPLY round`), then `- old` / `+ new` lines. For a document built from sources the new text goes into the sources (section 7).
- **Conversation:** the last agent reply (`claude (v2): …`, `claude (v2, needs_input): …`) and every reviewer comment after it. Older comments collapse to `(+2 earlier, suiko show <doc> t2)`.
- **Anchor notes:** `(outdated: text changed)`; `(orphaned: was "…" in §5 v1 L260; reanchor with suiko reanchor)`.
- **Footer:** `LOCKED (agreed - do not modify): …`, `DECISIONS to keep true: …`, drafts (only with `--include-drafts`, labelled as not submitted), `PROTOCOL: …` (the first packet), `REPLIES: …` (every packet with threads to act on: replies go on the threads, where the reviewer reads them in Suiko), `NEXT: …`.
- **Summary only:** a review whose only feedback is its summary (no thread to act on, not an approval) is a request too: `NEXT: act on the reviewer summary (no thread asks for anything): edits it asks for, if any -> suiko revise <doc> --replies - (JSON: …) -> suiko wait <doc> (background)`. Record the change with the version `summary` and an `other` entry per change (`"at": "L12-14"`, or `"del:h6"` for a cut that leaves no lines): no thread explains it, and the guards refuse an unexplained cut. A code review and a snapshot get their round's own steps, recorded with `-m <what changed>` (their guards do not refuse); `suiko snapshot` records a page you build as it is; a public page is not edited.
- **Size cap:** 10,000 characters. Threads beyond the cap are listed one per line with `suiko show <doc> tN`.

### 6.4 JSON form (`--json`, MCP `structuredContent`)

```json
{"schema":1,"doc":"funding-study","path":"reports/funding-study.html","head":1,"working":"clean",
 "reviews":[{"id":"rv1","version":1,"verdict":"changes_requested","body":"...","by":"Eric","at":"..."}],
 "verdict":"changes_requested","edits":"now","final":null,
 "threads":[{"id":"t1","why":"new","type":"comment","severity":"blocking","status":"open",
   "lines":[212,212],"section":["3 Findings","3.2 Funding stress"],"target":"text","label":"text",
   "on":"spreads widened on 12 days","src":"    <p>Funding spreads widened on 12 days, all of them after the March rate decision.</p>",
   "srcUnique":true,"srcWindow":false,"srcEditable":true,"anchorState":"exact",
   "comments":[{"by":"Eric","kind":"human","body":"...","at":"..."}],
   "suggestion":null,"attachments":[],"apply":null}],
 "locks":[{"id":"L1","lines":[170,196],"section":["7 Caveats"]}],
 "decisions":[],"drafts":null,
 "counts":{"actionable":4,"new":4,"reopened":0,"reply":0,"answer":0,"awaitingReviewer":0,"resolved":0,"outdated":0},
 "next":"edits, if any -> suiko revise funding-study --replies - -> suiko wait funding-study (background)"}
```

- `why`: `new`, `reopened`, `reply` or `answer`.
- `attachments`: absolute paths of the thread's `crop:` and `image:` files, in order. `attachmentKind` says what they show: `region` (a region crop, printed as `crop:`), `snip` (a snipped area of the doc) or `image` (a screenshot or pasted image); both print as `image:`. Listed drafts (`--include-drafts`) carry absolute `attachments` too.
- `anchorState`: `exact`, `moved`, `edited`, `changed` or `orphaned` (see [section 10](#10-anchors-re-anchoring-and-agent-questions)).
- A thread is **actionable** when its status is `open`, or when the reviewer's newest comment is newer than the agent's newest comment and it is not `resolved`.

### 6.5 Pictures: snips and screenshots

Reviewers attach pictures from the tool dock at the bottom of the document or with one key: the Area tool (`b`) snips any area of the rendered doc, `B` (or `suiko snip`, often bound to a global hotkey) captures anything on their screen. Such threads look like this:

```text
[t5] comment · L60-64 · §2 Method · snip (figure + 2 paragraphs)
  src>     <figure><img src="img/pipeline.png" alt="Pipeline overview"></figure>
  src> 
  src>     <p>Trades are joined to quotes by session, then deduplicated.</p>
  src> 
  src>     <p>A session with a trading halt is split at the halt.</p>
  image: /home/eric/proj/.specreview/docs/funding-study/attachments/a2.png  (Read it to see what the reviewer snipped)
  Eric: The figure shows the dedupe before the join, but the text says after. Which is it?

[t6] comment · GENERAL
  image: /home/eric/proj/.specreview/docs/funding-study/attachments/a3.png  (Read it to see the image the reviewer attached)
  Eric: This is the dashboard today. The mockup in §5 should match it.
```

- Open each `image:` file before deciding anything. The words alone are often ambiguous.
- A snip's `src>` covers every block under the box, in file order. Change only what the comment asks about; the other lines are context. A large snip is shortened (`...(N more lines)`) like any long `src>`: Read those lines from the file before editing.
- A screenshot on a GENERAL thread may show something outside the doc, such as the running app or a terminal. Relate it to the document through the comment; if you cannot tell which part of the document it concerns, reply `needs_input` with one precise question.
- A screenshot on a text thread (the reviewer had text selected) has the usual `on:` and `src>`; the picture explains what they mean about that text.
- Something drawn or built at runtime (a canvas, a chart drawn by a script, a state reached by clicking) is cited by its nearest source lines and usually a picture: find what produces it and change that.

## 7. Acting on feedback

**Before editing, read the cited ranges, not the whole document** (in Claude Code: Read with `offset`/`limit` around the cited lines), and do not re-read the whole document each round. The reviewer may have recorded their own revision or applied a suggestion since the packet was printed.

**Change only what each thread asks for.** In the document itself, replace the `src>` text (Edit tool, or `suiko edit`) and keep the surrounding formatting. A document **built from sources** (a template, data, a script that writes the HTML) is changed at those sources and then rebuilt the way it was built: `src>` shows the built output, so find what produces it. Link the rebuilt lines to the thread with `at` when they reach beyond its paragraph (a rebuilt table, a data blob, a chart script): an `at` explains every change on the lines it names (section 9.1). Never rewrite, restyle or reformat parts no thread asked about.

| Thread | Action | Reply status |
|---|---|---|
| suggestion | `suiko apply <doc> <tid>`; never retype it. In a document built from sources, put its text into the sources and rebuild instead: `apply` changes only the built file, and `revise` refuses a rebuild that drops it (`reverted`, section 9.2) | `addressed` (an automatic reply is added if you give none) |
| comment you agree with | Change what it asks for, replacing the `src>` text (or its source) | `addressed` |
| question | Answer in the reply; change the document only if the answer belongs in it | `answered`, or `addressed` if you changed it |
| disagree | No change; explain why | `declined` |
| unclear | No change; ask one precise question | `needs_input` |
| image / diagram region | Read the `crop:`; change whatever produces it (its markup, data, styles, or the generating script or source) | `addressed` |
| snipped area (`image:`) | Read the `image:` first; then change the blocks in `src>` (Read the file when `src>` is shortened) | `addressed` |
| screenshot on a GENERAL thread | Read the `image:`; it may show something outside the doc (the running app, a terminal). Change the document where the comment points; if it is unclear which part, ask | `addressed`, or `needs_input` |
| asks to see a chart, an image or a mockup | Render it and attach it to the reply (section 7.2); iterate in the thread | `answered` |
| `use:` line | Put that attachment into the document at the thread's place (section 7.2) | `addressed` |
| `EDITS: batch` packet | Answer now; no change yet (section 7.1) | `planned` for a change you will make |
| APPLY | Make the change you planned | `addressed` |
| REOPENED | Read the new comment; change it again | `addressed` |
| ANSWER | Apply the answer | `addressed` |

**Editing rules:**

1. Change only what the threads ask for, in the document or in its sources (then rebuild). Keep the surrounding formatting; never re-wrap paragraphs, restyle or reformat parts you were not asked to touch.
2. Do all Edit-tool (or `suiko edit`) edits first. Then run `suiko apply <doc> <tid...>` for suggestions in a file you edit directly. `apply` rewrites the file, so re-read it before any later edit. If your editor reports the file changed since it was read, re-read and retry.
3. Edit bottom-up, or locate text by the `src>` string rather than by line numbers.
4. Never touch locked text or text behind decisions, and never make drive-by edits.
5. Never revert a change you did not make. The reviewer, a formatter or another tool may have edited the file.

**`suiko apply <doc> <tid...> [--dry-run]`** maps the thread's anchored range from head to the working copy. If the expected text is there, it is replaced. Otherwise, if it occurs exactly once, or one occurrence is within 2,000 characters of the expected place, that one is replaced. Otherwise it reports `conflict t3: expected text not found near L120; treat as a normal comment` (exit 3). On success the edit is tagged to the thread and the suggestion becomes `staged`; it becomes `applied` when the next `revise` records it. `apply` writes the doc's file only: for a document built from sources, put the suggested text into the sources and rebuild instead. Otherwise the next rebuild brings the old text back, and `revise` refuses that version (`reverted`, section 9.2).

```text
$ suiko apply funding-study t3
applied t3 at L120 (exact) · staged (not recorded yet)
```

**`suiko edit`** is an exact replace tagged to threads, with Edit-tool semantics: `old` must occur exactly once unless `--all`.

```bash
suiko edit funding-study --thread t1 --old "widened on 12 days" --new "widened on 31 days (above 50 bp)"
suiko edit funding-study --stdin <<'JSON'
[{"threads": ["t1"], "old": "widened on 12 days", "new": "widened on 31 days (above 50 bp)"},
 {"threads": ["t4"], "old": "<td>2024-Q2</td><td>4</td>", "new": "<td>2024-Q2</td><td>5</td>", "all": false}]
JSON
```

### 7.1 Batched edits: `planned` and `APPLY`

On a long document the reviewer may batch the edits, so you answer each comment at once and change the document once per batch. A review that hands over no thread (only a summary) is never batched: act on it as its `NEXT` says.

- A packet with the line `EDITS: batch. Answer every thread now. For a change you agree to make, do not edit the doc yet: reply with status "planned" and say exactly what you will change; questions get "answered". The edits come later in one APPLY packet.` asks for replies only (`NEXT: replies only, no edits yet -> …`). Post them with one `suiko revise <doc> --replies -` (the working copy equals head, so it records no version and only posts the replies), or with `suiko reply <doc> <tid> -m <md> --status planned`. Other statuses (`answered`, `declined`, `needs_input`) work as usual. A batched suggestion reads `suggestion: plan it now; it is applied in the APPLY round`.
- When only some threads are batched (the newest review that handed each thread over decides), the line names them: `EDITS: batch for t9 only (the other threads: edit now). Answer it now. For a change you agree to make there, …`. Edit the other threads as usual.
- A `planned` thread is not waiting on you: `wait` does not count it as unanswered. A batched thread without a reply makes `wait` exit 3 with `Reply on each: … (one entry per thread; batched edits: no edits yet, status "planned" with exactly what you will change) …`.
- When the reviewer applies the plan, the packet header says `APPLY: make every planned change below in one pass, then record ONE version as NEXT says (status addressed).`, and each thread is labelled `APPLY`, with the reviewer's original request and your planned reply quoted. Make every change, then record one version as `NEXT` says, with status `addressed` for each: one `suiko revise <doc> --replies -` (for a web page you build, the `suiko snapshot` command NEXT names).

### 7.2 Attachments on your replies, and `use:` lines

- When the reviewer asks to see a chart, an image or a mockup, or when showing beats telling, render it and attach it to your reply: `suiko reply <doc> <tid> -m <md> --attach <file>` (repeatable), or `"attachments": ["<file>", …]` on a thread of the revise JSON (paths relative to the current directory, or absolute). Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`) show as thumbnails, an `.html`/`.htm` file as a live preview in a sandbox; at most 6 per reply, 5 MB each. Suiko stores a copy under `.specreview/docs/<doc>/attachments/`. Iterate on it in the thread.
- When the reviewer chooses **Use in doc** for one of your attachments, the thread comes back with `use: <absolute path> (chart.html) — put this into the doc at this thread's place (copy it next to the doc or inline it)`. Put it into the document at the thread's anchor, the way the document holds such things, then reply `addressed`.
- When that comes with an approval of a final version, the line reads `use: <absolute path> (chart.html) — the doc is final (v3); say in your reply whether this should go into a next version`. Do not edit the document (it must stay identical to the final version): say in the reply whether the file belongs in a next version.

## 8. Recording a revision

### 8.1 Input

```bash
suiko revise funding-study --replies - <<'JSON'
{"summary": "rv1: two-year window, halted sessions, pipeline caption",
 "threads": {
  "t1": {"status": "addressed", "reply": "Counted over two years (31 days) with a 50 bp threshold; both are stated now.", "at": "L212,L913"},
  "t2": {"status": "addressed", "reply": "The dedupe runs before the join. Fixed the caption.", "at": "L90-91"},
  "t3": {"status": "addressed", "reply": "Applied your suggestion."},
  "t4": {"status": "needs_input", "reply": "Q3 has 2 days above 50 bp, or 6 above 40 bp: which threshold?", "attachments": ["/tmp/q3-thresholds.png"]}},
 "other": [{"at": "L12", "why": "Bumped 'Last revised' date"}]}
JSON
```

Schema:

| Field | Type | Meaning |
|---|---|---|
| `summary` | string | One line describing the revision. `-m <summary>` overrides it. |
| `threads` | object | One entry per thread listed in the packet, keyed by thread id. |
| `threads.<tid>.status` | `addressed` \| `answered` \| `planned` \| `declined` \| `needs_input` | `addressed`: you changed the document. `answered`: reply only. `planned`: you will make the change when the reviewer applies the plan (section 7.1). `declined`: you disagree. `needs_input`: you need the reviewer to decide. |
| `threads.<tid>.reply` | string | Markdown shown to the reviewer on the thread. |
| `threads.<tid>.at` | string, optional | Lines of the **new** file you changed for this thread: `"L90-91"`, `"L12,L90-91"`. Links the hunks on those lines and explains every change on them (section 9.1). Name them whenever a change reaches beyond the thread's paragraph: a rebuilt table, data blob or chart script. `suiko revise <doc> --dry-run` and `suiko diff <doc> head..live --stat` list the changed lines. |
| `threads.<tid>.attachments` | array of paths, optional | Images or HTML files shown on the reply (section 7.2). |
| `other` | array, optional | `[{ "at": "L12" \| "L12-14" \| "del:h6" \| "h6", "why": string }]`. Explains changes no thread asked for, and edits you did not make (`"why": "not mine: external edit"`). |
| `breakLocks` | object, optional | `{ "L1": "reason" }`. Same as `--break-lock L1="reason"`. Only when the user explicitly asks. |

Flags: `-m <summary>`, `--replies <file|->`, `--dry-run` (print the full report, record nothing), `--break-lock L1="why"` (repeatable), `--allow-rewrite`, `--force`.

### 8.2 What `revise` does

1. Locks the doc and reads the working copy. If it equals head and there are replies, it posts the replies only; with no replies either, it reports "nothing to record" and exits 0. A replies-only revise warns for each `addressed` reply: `WARN tN is marked addressed but nothing was recorded: the document did not change. A file the document loads at runtime (fetch, XHR) is not versioned; change the document itself, or reply "answered".` A version holds the document and the local files its markup references (images, stylesheets, scripts, frames); a data file a script fetches at runtime is not part of it, so changing only that records nothing.
2. Computes hunks (head to working copy), links each hunk to threads, and runs the guards. On refusal it stops (exit 3) and the working copy is untouched.
3. Snapshots local assets, commits the new version, re-anchors every thread and lock, posts the replies, marks staged suggestions applied, and notifies the UI.

### 8.3 Report

```text
suiko: recorded v2 for funding-study (+9 -3 lines, 5 hunks) · responds to rv1
  h1 L12     header              -> other: Bumped 'Last revised' date
  h2 L90-91  §2 Method           -> t2 addressed  (hint)
  h3 L120    §2.1 Data           -> t3 addressed  (tagged: apply)
  h4 L212    §3.2 Funding stress -> t1 addressed  (overlap)
  h5 L913    §3.2 Funding stress -> t1 addressed  (hint)
  t4 needs_input (reply only)
guards: ok · lock L1 untouched · no unexplained deletions · rewrite 1%
anchors: 4 threads + 1 lock -> 1 exact, 1 moved, 3 edited, 0 changed, 0 orphaned
reviewer notified (1 UI open). next: suiko wait funding-study (background)
```

### 8.4 Refusal

```text
suiko: REFUSED - nothing recorded (exit 3)
  ERR deletion: h6 removes 14 lines (v2 L201-214, §8 Open questions) linked to no thread
      fix: undo it where you made it (in the sources, then rebuild, for a document built from them; `suiko revert funding-study --hunk h6` restores a file edited directly), or, if a thread asked for it, add its lines ("L200-201") to that thread's "at", or explain it: "other":[{"at":"del:h6","why":"..."}]
  ERR lock: h5 L171-174 changes L1 §7 Caveats (agreed in rv1)
      fix: undo it where you made it (in the sources, then rebuild, for a document built from them; `suiko revert funding-study --hunk h5` restores a file edited directly), or, if the user agreed to change it, --break-lock L1="<reason>"
  ERR deletion: h3 removes or replaces 23 words (v2 L150-162, §4 Results) outside the text of t4 (linked to t4 only because it overlaps t4's text)
      fix: undo it where you made it (in the sources, then rebuild, for a document built from them; `suiko revert funding-study --hunk h3` restores a file edited directly), or, if t4 asked for the whole change, name its lines ("L150-162") in t4's "at", or explain it: "other":[{"at":"h3","why":"..."}]
  ERR reverted: h1 removes t3's applied suggestion "Sessions with fewer than 10 trades, or with a trading halt, …" (applied in v2)
      fix: a rebuild from sources brings back the old text: put the suggestion into the sources and rebuild. If a thread asked to change it again, add its lines ("L120") to that thread's "at"
  WARN t2 marked addressed but no hunk is linked to it (add "at":"L90-91" if you changed it)
working copy left untouched. Preview with --dry-run.
```

Errors are listed bottom-up (the highest hunk first): reverting a hunk renumbers the hunks after it, so follow the fixes in that order. A rewrite refusal reads `ERR rewrite: rewrites 64% of the visible text of v1 where no thread asked for a change (limit 50%): h1, h2, h4, h5, h6, h7` with the same kind of fix, or `--allow-rewrite` (only if the user asked for a rewrite).

Follow the printed `fix:` lines:
- **A change a thread asked for:** name its lines in that thread's `at` (section 9.1). An overlap link alone explains only the thread's text and its paragraph or section.
- **A change no thread asked for:** undo it where you made it. In a document built from sources, undo it in the sources and rebuild: `suiko revert <doc> --hunk hN` restores only the file it runs on, so for a built document the next rebuild brings the change back. For a file you edit directly, `suiko revert` is the quickest way. A change you meant to make: explain it with `other`.
- **`reverted`:** a rebuild dropped a suggestion that an earlier version applied to the built file only (`suiko apply`). Put the suggested text into the sources and rebuild.
- **A lock:** ask the reviewer (`needs_input`) unless the user explicitly asked you to break it.
- Never revert a hunk you did not make; explain it instead (`"why": "not mine: external edit"`).

### 8.5 Replying without a version

```bash
suiko reply funding-study t2 -m "The dedupe runs first; see the caption at L90." --status answered
suiko reply funding-study t3 -m "Volume under the price chart, as a mockup." --status answered --attach /tmp/volume-mockup.html
```

`reply` accepts `--status answered|planned|declined|needs_input|addressed`, `--at L42-46`, `--attach <file>` (repeatable; section 7.2) and `--decision "text"`. Exit 4 if the thread does not exist. Without `--status` the thread keeps its status: an open thread stays open, and `wait` refuses until it has one.

## 9. Guards and attribution

### 9.1 Attribution: how hunks are linked to threads

For each hunk between head and the working copy, in order:

1. **tagged:** an `apply` or `edit` for that thread produced it.
2. **hint:** a thread's `at` lines overlap the hunk's new lines.
3. **overlap:** the hunk changes text inside an actionable thread's anchored range (widened to whole lines, on lines of up to 1,000 characters; on a longer line, such as a minified document's, the exact anchored text).
4. Otherwise it is **unlinked**. An `other` entry explains it: `at: "L12"` overlaps the new lines; `at: "del:h6"` or `"h6"` names the hunk.

Edits made by people or other tools cannot be told apart from yours; they show up as unlinked hunks.

What a link explains:
- Every link explains the part of a hunk inside its threads' scope: the anchored text and the paragraph-level block around it (for a heading, its section; for a GENERAL thread, the whole document). A tagged `apply` or `edit` is explained as a whole.
- An explicit `at` (hint) also explains everything that lands on the lines it names. An overlap link is only inferred, so it explains the scope and nothing more: when a thread asked for a change that reaches further (a rebuilt table, a regenerated section), name its lines in that thread's `at`.
- What a hunk removes outside all of that counts as unexplained (the deletion and rewrite checks below).

To find the lines to name: `suiko revise <doc> --dry-run` lists each hunk with its lines and links, and `suiko diff <doc> head..live --stat` lists the hunks of the unrecorded changes.

### 9.2 Guards

The deletion and rewrite checks count the text the reviewer reads: for HTML its visible text, whitespace aside (not tags or attributes, so not `data:` URIs, inline styles or handlers, and not the content of `script`, `style`, `template` and similar elements, so not JSON data blobs, except prose in the string literals of an inline JS or JSON script of up to 256 KB: sentences a page renders from its own script count, numbers, dates and short labels do not); for Markdown the source, less base64 `data:` images and raw `<script>`/`<style>` blocks. So a rebuilt document whose data blob, chart script or embedded image changed together with the sentences the threads asked about passes, while rewriting more than half of the prose where no thread asked for it is refused. The Claude Code pre-write hook measures the same way (section 14). `revise` is the real gate: the hook only catches a Write that replaces most of the document, while `revise` checks every change, however it was made.

| Check | Default | Way out |
|---|---|---|
| An active lock's agreed text is no longer intact at the new version | refuse | undo the change where it was made (`revert --lock L1` writes the agreed text back into the file); `--break-lock L1="reason"` only when the user asks |
| ... but the lock was created after the last packet the agent received | warn | |
| A hunk removes or replaces 20 or more words, or 3 or more whole old lines, of that text that nothing explains (section 9.1): all of it for an unlinked hunk; for a hint or overlap linked hunk, the part outside its threads' scope and outside the lines an `at` names | refuse | name the lines in the `at` of the thread that asked for it, an `other` entry, undo it where it was made, or config `guards.unexplainedDeletion: warn` or `off` |
| More than half (`guards.maxRewriteRatio`, 0.5) of that text removed or replaced where no thread asked for it (unlinked hunks, and the part of linked hunks that their links do not explain), when head has 40 or more lines or 300 or more words (HTML: 300 visible words) | refuse | name the lines in the `at` of the thread that asked for it; `--allow-rewrite` only when the user asked for a rewrite |
| `reverted`: the text of a suggestion an earlier version applied (its thread addressed or resolved) is in head and nowhere in the working copy, and no hunk that removes it is linked with `at` or a tagged edit, or explained by `other` (an overlap link does not count). Typically a rebuild from sources that never got the suggestion | refuse | put the suggested text into the sources and rebuild; if a thread asked to change that text again, name its lines in that thread's `at` |
| A thread in the packet has no reply entry | warn | |
| A thread marked `addressed` has no linked hunk and no asset change | warn | add `at` |
| A decision's anchored text intersects a hunk not linked to that decision's thread | warn | |
| `--force` | overrides every refusal; recorded and shown in red in the UI | only on explicit request |

### 9.3 Changed images

Local assets are snapshotted per version. A changed image counts as a change to every element that references it, so a thread on that image is linked to the change and the reviewer sees a before/after pair.

## 10. Anchors, re-anchoring and agent questions

After every version, Suiko re-anchors every thread and lock against the new source, one version at a time: untouched text first, then text inside linked hunks, then exact matches elsewhere, then fuzzy matches, then the thread's original anchor.

| State | Meaning | Packet |
|---|---|---|
| `exact` | Same text, same lines | lines |
| `moved` | Same text, different place | lines |
| `edited` | Changed by a hunk linked to the thread | lines of the new text |
| `changed` | The quoted text was edited without a link ("outdated") | `(outdated: text changed)` |
| `orphaned` | Not found | `(orphaned: was "…" in §5 v1 L260; reanchor with suiko reanchor)` |

- **Move an anchor:** `suiko reanchor <doc> <tid> --lines A-B` or `--quote "exact text"`. It applies to head when the working copy is clean; otherwise it is staged until the next `revise`.
- **Ask the reviewer:** `suiko ask <doc> --quote "exact text" -m "question"` (or `--lines A-B`) creates an `agent-question` thread with status `needs_input`. The answer arrives in a later packet as `ANSWER`.

## 11. Locks and decisions

- **Locks** ("Mark agreed" in the UI) are hard guarantees. `revise` refuses a version in which the agreed text is not intact. `suiko revert <doc> --lock L1` writes the agreed text back. Breaking a lock (`--break-lock L1="reason"`) records the break, deactivates the lock and shows a red badge until the reviewer re-locks it.
- **Decisions** are soft. The reviewer records one when accepting a thread ("Record as decision"). A hunk that touches a decision's text, without being linked to that decision's thread, is a warning, and every packet lists decisions under `DECISIONS to keep true`.

## 12. Approval and the final version

When the reviewer approves with "Mark vN final", the packet says `APPROVED · FINAL = vN`. Then:

```text
$ suiko final funding-study --decisions
final: funding-study = v3 (approved in rv3 by Eric; 3 versions, 3 reviews, 7 threads resolved, 2 decisions)
working copy matches v3: ok
wrote reports/funding-study.decisions.md
```

If the same submission also reopened a thread or answered a question, the packet lists those threads and NEXT says to answer each with `suiko reply <doc> <tid> -m … --status answered|declined` (no edits, no new version) before running `final`; without a status the thread stays open.

`final` exits 3 if the working copy does not match the final version. `--out <dir>` changes where the decisions file is written. A later `revise` puts the doc back in review; the earlier final stays in the history.

## 13. Recovery

| Situation | Do |
|---|---|
| The user says "done" or "sent" but no packet arrived | `suiko feedback <doc> --include-drafts`. If it lists only drafts, ask the user to send them. Do not act on drafts. |
| The background wait died (agent restarted) | `suiko feedback <doc>`; the prompt hook also reminds you. |
| `wait` exits 3 | The working copy has unrecorded edits. Record them with `revise`, then wait. If they are not yours, ask the user (the UI offers **Record as my revision**). |
| `wait` exits 6 | Another `wait` took over. Ignore it. |
| The user mentions "t4" | `suiko show <doc> t4` |
| You need old text | `suiko show <doc> --version N --lines A-B` |
| What changed between versions | `suiko diff <doc> v1..v2 --stat` or `--unified` |
| Which lines your unrecorded changes touch (for `at`) | `suiko diff <doc> head..live --stat`, or `suiko revise <doc> --dry-run` |

## 14. Claude Code hooks

Both hooks read the hook JSON on stdin, print nothing on any error, always exit 0, and finish quickly.

- **`suiko hook pre-write`** (PreToolUse, matcher `Write`). If the target is a tracked doc with at least one review, its state is not `closed`, and `guards.writeHook` is not `off`, it compares the new content with the file the way the guards measure (section 9.2): the share of the old text (for HTML its visible text, so a changed script, style, data blob or `data:` URI counts for nothing) that the new content no longer has, compared block by block (a Markdown line; HTML text between block-level tags and line breaks; moved blocks are free, a changed block costs the words it lost). Above `guards.writeHookRatio` (0.4) it asks the user to allow the Write:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Suiko: this Write would replace 91% of the visible text of reports/funding-study.html, which is under review (v3, 7 open threads). Allow it only if a full rewrite was asked for; otherwise change only what the review threads ask for (Edit the file, or change its sources and rebuild). After an approved full rewrite, record it with `suiko revise funding-study --allow-rewrite`."}}
  ```

  - Claude Code shows the user a permission prompt with that reason (in default and auto mode). A headless `claude -p` run denies the Write and gives Claude the reason. So a full rewrite the user asked for costs one click, and an accidental regeneration is still stopped.
  - `guards.writeHook` in `.specreview/config.json`: `"warn"` (the default) or its synonym `"ask"` asks; `"deny"` denies such Writes without asking (its reason: "… which is under review (v3, 7 open threads); this workspace denies such Writes (guards.writeHook "deny"). Instead, change only what the review threads ask for (Edit the file, or change its sources and rebuild). If the user asked for a full rewrite, make it with Edit, then record it with `suiko revise funding-study --allow-rewrite`."); `"off"` turns the hook off. Workspaces created by Suiko 0.3.1 or earlier have `"writeHook": "deny"` written in their config and keep denying until it is changed or removed.
  - **`suiko revise` is the real gate.** The hook only catches a Write that replaces most of the document; `revise` refuses any unexplained deletion or rewrite (section 9.2), whatever produced it. After a full rewrite the user asked for, record it with `suiko revise <doc> --allow-rewrite --replies -`.
  - A rebuild by a script is not a Write: the hook never sees it, and `revise` checks the result.
- **`suiko hook prompt`** (UserPromptSubmit). For docs in the current workspace, it adds context when a submitted review was not delivered and no live `wait` exists, or was delivered more than about 5 minutes ago and never acknowledged:

  ```json
  {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"suiko: review rv2 on funding-study (2 threads, CHANGES REQUESTED) was submitted at 14:20 and not delivered. Run `suiko feedback funding-study` and address it per the spec-review skill."}}
  ```

  The note is capped at 1,000 characters. When the current directory has no workspace at or above it, the workspaces registered by `open` below it are checked instead, and the suggested command names the workspace (`suiko feedback funding-study --workspace reports`).

The plugin registers the hooks as `suiko hook pre-write` and `suiko hook prompt` (the binary on `PATH`). `suiko install claude --with-hooks --apply` writes them into settings with absolute paths instead. The plan gate below is opt-in: neither the plugin nor `suiko install` registers it unless asked with `--with-plan-gate` (on `install` or `install claude`). A gate already in settings is kept, and re-pointed, by later installs.

**Plan-mode gate.** `suiko plan-gate` is a PermissionRequest hook (matcher `ExitPlanMode`, timeout 345600 s) that runs the full CLI, not the fast hook path:

- It reads the plan from `tool_input.planFilePath` when that is an absolute path to a regular `.md` file under 2 MB (a symlink only when its target is one too), else from `tool_input.plan`, and records it as a snapshot doc (section 18) with the origin key `claude-plan:<session_id>:<planFilePath or "inline">`, in the workspace of `$CLAUDE_PROJECT_DIR` (else the hook's `cwd`). The committed `.specreview` files get only a hash of that key; the session id, the plan file path, the cwd and the transcript path stay in local state under `SPECREVIEW_HOME`, so feedback still names the plan file. The first ExitPlanMode records v1; each later one for the same plan file records the next version, so the reviewer sees a diff. Open threads that the new version's changes are linked to get the reply `Changed in vN.` (status addressed), since Claude has no reply channel at the gate.
- It opens the review UI in the system browser (unless `--browser none` or `$SPECREVIEW_BROWSER=none`; `pane` means the system browser here, since a hook cannot drive the agent's pane) and blocks until a review of that version is submitted (`--timeout` gives up; by default it waits until Claude Code cancels it). Plan reviews belong to the gate: `wait --all` and a `wait` without a doc skip plan docs. A gate whose version is no longer the doc's head (a newer ExitPlanMode recorded a later one) steps aside.
- **Approve** prints the allow decision, whose `updatedInput` is the tool input with `plan` set to the reviewed text:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"# Plan: cache\n…","planFilePath":"/Users/me/.claude/plans/cache.md"}}}}
  ```

- **Request changes** or **Comment** prints a deny decision whose `message` is the feedback: the packet's threads and `src>` lines, citing the plan file and its line numbers, then what to do: make targeted Edit-tool changes to that file (never rewrite it), address every thread, call ExitPlanMode again.

  ```json
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"YOUR PLAN WAS NOT APPROVED: the reviewer requested changes (Suiko rv1 on v1).\nPlan file: /Users/me/.claude/plans/cache.md   (line numbers below are lines of this file)\n…"}}}
  ```

- The review is marked delivered only after the decision reached stdout. On any error (bad input, the server not starting), on SIGTERM/SIGINT/SIGHUP (the user answered in the terminal first, and Claude Code discards the hook) or on a closed stdout, it prints nothing, exits 0 and marks nothing delivered: Claude Code then decides as if there were no hook. Comments sent with an approval are not passed on: the allow decision has no field for them.

## 15. MCP tools

`suiko mcp` is a stdio MCP server. Logs go to stderr only. Every tool returns the CLI text as `content: [{type: "text"}]` and the `--json` shape as `structuredContent`, with `isError: true` on a refusal or conflict.

| Tool | Input | Returns |
|---|---|---|
| `suiko_open` | `{path, title?}` | `{doc, version, url}` |
| `suiko_review` | `{mode?, base?, range?, commit?, paths?, title?}` | the `review --json` shape: a code review (section 19; no PR mode) |
| `suiko_snapshot` | `{url, title?}` | `{doc, version, recorded, url, page}`; public hosts only (a private host or the network turned off is refused); see section 18 |
| `suiko_wait` | `{doc?, timeout_sec?, allow_unanswered?}` (default 50, max 600) | the packet, `{status: "waiting", hint: "call again"}`, or `{status: "closed"}`; an error `{status: "unanswered", threads}` while a thread you received has no reply |
| `suiko_feedback` | `{doc, peek?, include_drafts?}` | the packet |
| `suiko_apply` | `{doc, thread_ids}` | `{applied, conflicts}` |
| `suiko_edit` | `{doc, thread_ids, old_string, new_string, replace_all?}` | `{lines}` |
| `suiko_reply` | `{doc, thread_id, body, status?, at?, attachments?, decision?}` | thread summary |
| `suiko_revise` | `{doc, summary, threads, other?, break_locks?, allow_rewrite?, dry_run?}` (each thread may carry `attachments`) | the revise report |
| `suiko_revert` | `{doc, hunk?, lock?}` | report |
| `suiko_reanchor` | `{doc, thread_id, lines?, quote?, file?}` | the anchor |
| `suiko_ask` | `{doc, body, quote? or lines?, file?}` | the new agent-question thread |
| `suiko_threads` | `{doc, status?}` | one line per thread (`structuredContent.threads`) |
| `suiko_diff` | `{doc, from?, to?, format?: "stat" or "unified"}` | the diff |
| `suiko_log`, `suiko_status` | `{doc?}` | text |
| `suiko_show` | `{doc, thread_id?, version?, lines?, file?, side?}` | text |
| `suiko_final` | `{doc, decisions?, out_dir?}` | paths |

While `suiko_wait` blocks, it sends progress notifications every 15 s when the request carries a progress token. MCP-only loop: `suiko_open`, `suiko_wait` (again while it returns `waiting`), `suiko_apply` / `suiko_edit`, `suiko_revise`.

## 16. Command reference

| Command | Behaviour | Exit |
|---|---|---|
| `open <file...> [--title T] [--browser pane\|system\|none] [--workspace <dir>] [--json]` | Track the doc and record v1 if new; start the server; print the URL; warn if dirty, and (stderr) when the installed Suiko instructions are older than the CLI, with the command that updates them | 0 |
| `open <dir>` | Open every `.md`/`.markdown`/`.html`/`.htm` file below the folder (at most 200); one line per doc and the UI's home URL | 0 |
| `open - [--name N] [--title T]` | Piped Markdown (at most 5 MB) as a snapshot doc; the same `--name` records a new version | 0 |
| `last [--session <id>] [--transcript <path>] [--title T] [--browser pane\|system\|none]` | The agent's last message (Claude Code transcript) as a snapshot doc; prints the URL and the wait command | 0 / 4 |
| `snapshot <url> [--title T] [--reader auto\|direct\|jina] [--as-html] [--allow-private] [--allow-remote-assets] [--replies <file\|->] [--browser pane\|system\|none]` | A web page as a snapshot doc (the only command that uses the network); again for the same URL records the next version when the page changed; `--replies` posts replies with it | 0 / 1 / 3 / 4 |
| `review [<range>] [--uncommitted \| --staged \| --base <ref> [--committed] \| --commit <sha> \| --pr <n\|url>] [--path <pathspec>]... [--context N] [--max-files N] [--title T] [--browser pane\|system\|none]` | Open a code review of the changes (section 19); again with the same arguments: a new round when the files changed | 0 / 1 / 3 / 4 |
| `wait [<doc>] [--all] [--timeout 0\|30m] [--allow-dirty] [--allow-unanswered] [--json]` | Block until a review arrives; print the packet; mark it delivered. Exits 3 at once while a thread you received has no reply (unless `--allow-unanswered`) | 0 / 2 / 3 / 5 / 6 |
| `feedback <doc> [--peek] [--include-drafts] [--all-open] [--json]` | The packet, without blocking; marks delivered unless `--peek` | 0 |
| `apply <doc> <tid...> [--dry-run]` | Apply suggestions verbatim; stage tagged edits | 0 / 3 |
| `edit <doc> --thread t1[,t2] --old <s> --new <s> [--all]` | Thread-tagged exact replace | 0 / 3 |
| `edit <doc> --stdin` | Batch of `{threads, old, new, all?}` on stdin | 0 / 3 |
| `reply <doc> <tid> -m <md> [--status answered\|planned\|declined\|needs_input\|addressed] [--at L42-46] [--attach <file>]... [--decision "text"]` | Reply without a version; `--attach` shows an image or HTML file on the reply | 0 / 4 |
| `revise <doc> [-m <summary>] [--replies <file\|->] [--dry-run] [--break-lock L1="why"]... [--allow-rewrite] [--force]` | Record a version with replies | 0 / 3 |
| `revise <doc> --source <file\|-> [--replies <file\|->]` | Snapshot docs: record the given text as the new version | 0 |
| `revert <doc> (--hunk hN \| --lock L1)` | Restore part of the doc's file (a document built from sources: undo the change in the sources and rebuild instead) | 0 / 3 |
| `reanchor <doc> <tid> (--lines A-B \| --quote TEXT) [--file <path>]` | Move a thread's anchor (code reviews: lines of the working file now) | 0 / 3 |
| `ask <doc> (--quote TEXT \| --lines A-B \| --file <path> [--lines A-B]) -m <question>` | Ask the reviewer a question | 0 / 3 |
| `threads <doc> [--status open\|addressed\|needs_input\|resolved\|outdated\|all] [--json]` | One line per thread | 0 |
| `show <doc> [<tid>] [--version N] [--lines A-B] [--file <path> [--side new\|old]]` | A thread with its timeline, or old source (code reviews: a file of a round) | 0 / 4 |
| `diff <doc> [vA..vB] [--stat\|--unified] [--json]` | Changes (default: last reviewed..head; `head..live`: the unrecorded changes) | 0 |
| `log <doc> [--json]` | Timeline | 0 |
| `status [<doc>] [--json]` | Docs, head, counts, undelivered reviews, listeners, working copy | 0 |
| `final <doc> [--decisions] [--out <dir>]` | Final checks and the decisions export | 0 / 3 |
| `close <doc>` | End the review session; waits exit 5; a PR review also loses `refs/specreview/pr/<n>` | 0 |
| `snip [<doc>] [-m <text>] [--question] [--send] [--file <png>] [--json]` | Reviewer tool: a screenshot (macOS picker, or `--file`) as a draft comment, or submitted at once with `--send`. Agents do not run it: it opens a picker on the reviewer's screen | 0 |
| `serve [--foreground] [--port N]` · `stop [--rotate]` · `doctor [--fix]` | Server control and checks | |
| `mcp` | stdio MCP server | |
| `hook pre-write` · `hook prompt` | Claude Code hooks | always 0 |
| `plan-gate [--timeout 30m] [--browser system\|none]` | Claude Code plan-mode gate (section 14) | always 0 |
| `install [--only a,b] [--user\|--project] [--apply]` · `install claude [--user\|--project] [--with-hooks] [--with-mcp] [--apply]` · `install agents-md [--apply]` | Print, or with `--apply` write, the integration files; every instruction file ends with `installed by suiko <version>`; after an upgrade, `open` and `doctor` name the command that updates the copies that are out of date | 0 |

## 17. Rules summary

Do:

- Start at `suiko open`: until then, write the document exactly as you would without Suiko.
- Change only what the threads ask for: in the file, or in the sources it is built from (then rebuild it the way it was built). In a built document a suggestion goes into the sources too; `suiko apply` is for files you edit directly.
- Read the cited ranges before editing, not the whole document each round; re-read after `apply` and whenever the editor says the file changed.
- Open every `crop:` and `image:` picture before acting on its thread.
- Give one reply per listed thread; use `needs_input` when unsure. Show a chart or mockup on the thread with an attachment when that says it better.
- Name in a thread's `at` the lines of every change it asked for that reaches beyond its paragraph (a rebuilt table, data blob or chart script); explain every change no thread asked for in `other`.
- Follow the printed `fix:` on a refusal; undo an unasked change where you made it (for a built document, in its sources, then rebuild).
- End the turn after starting a background wait; never poll. Keep the chat to one line per thread.

Do not:

- Rewrite, restyle or reformat parts no thread asked about.
- Modify `LOCKED` text or text behind `DECISIONS` without the reviewer's say-so.
- Revert hunks you did not make.
- Use `--force`, `--allow-rewrite` or `--break-lock` unless the user explicitly asks.
- Edit the document while handling an `EDITS: batch` packet; the edits come with `APPLY`.
- Act on draft comments the reviewer has not sent.
- Resolve threads: only the reviewer resolves.

## 18. Snapshot docs: plans, messages, piped text, web pages

A **snapshot doc** reviews text that is not a file in the workspace: a Claude Code plan (the plan gate), an agent's last message (`suiko last`, `/suiko-last` in Claude Code), Markdown piped to `suiko open -`, or a web page (`suiko snapshot <url>`). Its versions are recorded from text; its synthetic path (`plans/<slug>.md`, `messages/<slug>.md`, `text/<slug>.md`, `web/<slug>.md` or `web/<slug>.html`) is never read or written and never matches a real file. Threads, attribution, re-anchoring, Changes and History work as for file docs.

- The packet header names the kind (`token-plan (Claude Code plan)`), line numbers are lines of the head version, and no thread offers `suiko apply`.
- `apply`, `edit` and `revert` are refused (exit 3) with what to do instead, and so is `revise` without `--source` (exit 1).
- **Revising a message or piped text:** write the complete revised text to a temporary file (`suiko show <doc>` prints the current version), address every thread in it, and run `suiko revise <doc> --source <file> --replies -` with the replies JSON (section 8.1) on stdin. With `--source -` the text comes from stdin, so `--replies` must name a file. The guards run, but their errors are recorded as warnings: a snapshot revision is never refused.
- **Revising a plan:** edit the plan file with targeted Edit-tool changes and call ExitPlanMode again; the plan gate records the version.
- **Workspace:** found from the current directory as usual. When that is your home directory or `/`, the doc goes to the scratch workspace `$SPECREVIEW_HOME/scratch/<8 hex>/`, and every printed command carries `--workspace <dir>`: keep it on every command for that doc.
- `suiko last` reads `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<session>.jsonl` (session from `--session`, else `$CLAUDE_CODE_SESSION_ID`; else the newest transcript of the current directory), takes the newest assistant message with text (skipping sidechains, tool results and command echoes), and returns at once. When the newest assistant message is still running a tool call (you ran `suiko last` yourself, maybe after a sentence), that whole turn is skipped. The text is stored with a final newline, as `show` prints it. Running it again for the same message reopens the same doc and records nothing, so your revisions stay. Its committed `.specreview` files keep only a hash of the message's identity: the session id, the message id and the transcript path stay in local state under `SPECREVIEW_HOME`. Codex transcripts are not supported.

### Web pages

`suiko snapshot <url>` fetches a page once and records it as a snapshot doc whose key is the URL (normalised: lowercase scheme and host, no default port, no fragment). Running the command is the consent to use the network: it is the only command that does, and it is refused (exit 3) when `SPECREVIEW_OFFLINE=1` or `network.allow` is `false` in `$SPECREVIEW_HOME/config.json`.

- **What is fetched:** http(s) only, no user name or password in the URL, at most 10 MB and 30 s, at most 10 redirects. Hosts that resolve to this machine or a private network (loopback, `10/8`, `172.16/12`, `192.168/16`, link-local, unique-local IPv6 and their mapped forms) are refused (exit 3) unless `--allow-private`, and every redirect is checked again. A name that does not resolve exits 4; a connection error or an HTTP status of 400 or more exits 1.
- **What is stored:** never the page as served. HTML is cleaned with an allowlist (no scripts, styles, forms, frames, embeds, SVG or event handlers; links `http`/`https`/`mailto` only, resolved against the page), the page's single `<main>` or `<article>` is kept when it has one, and the result is converted to Markdown (`web/<slug>.md`). `--as-html` keeps the cleaned HTML (`web/<slug>.html`); a doc keeps its format, so a later run must use the same choice. Markdown pages (a `.md` URL, `raw.githubusercontent.com`, a `github.com/.../blob/...md` page fetched from its raw URL) are kept as served when they contain no raw HTML, and lose it otherwise. A page rendered by JavaScript is nearly empty: the command says so, and `--reader jina` (public hosts only) has r.jina.ai render it, sending it the URL without its query string.
- **In the review UI** the doc is served with a strict policy (no scripts but the review overlay, no forms) and its remote images and styles are blocked unless the run had `--allow-remote-assets`.
- **The packet** names the page instead of a file: `Line numbers = lines of Suiko's Markdown snapshot of <url> (fetched 2026-10-11 14:05 UTC); there is no file for you to edit.` `src>` lines quote that conversion.
- **A page you build** (fetched with `--allow-private`): the packet says `PROTOCOL: the doc is a snapshot of a web page, not a file: change the sources that produce the page …` and `NEXT: edit the sources that produce the page -> suiko snapshot <url> --allow-private --replies - (records vN+1) -> suiko wait <doc> (background)`. Change only what the threads ask for, then run that command with the replies JSON (section 8.1) on stdin: it fetches the page again, records the next version and posts the replies in one step. When the page did not change, it records nothing and only posts the replies. `revise <doc>` without `--source` prints the same command.
- **A public page**: there is nothing for you to edit. The packet says `PROTOCOL: the doc is a snapshot of a public web page: there is nothing for you to edit.` and `NEXT: answer each thread with suiko reply <doc> <tid> -m <md> --status answered|declined -> suiko wait <doc> (background)`. Running `suiko snapshot <url>` again records a newer version when the page itself changed.
- **MCP:** `suiko_snapshot` `{url, title?}` does the same for public hosts only (no `--allow-private`, `--reader` or `--as-html`); for a page you build, use the CLI.

## 19. Code reviews


`review` opens a doc of kind `code`: each round (version) is the diff of the reviewed files plus a stored copy of both sides, and threads anchor on a file, a side and lines. Ids: `cr-<branch>`, `cr-uncommitted`, `cr-staged`, `cr-<from>-<to>`, `cr-<sha7>`, `cr-pr-<n>`.

| Flags | Old side .. new side |
|---|---|
| (none) | merge-base(default branch, HEAD) .. working tree, untracked files included. On the default branch, detached, or without a default branch: as `--uncommitted` |
| `--uncommitted` | HEAD .. working tree (untracked included) |
| `--staged` | HEAD .. the index |
| `--base <ref>` | merge-base(ref, HEAD) .. working tree; with `--committed`: .. HEAD |
| `A..B`, `A...B` | A .. B; with three dots, merge-base(A, B) .. B |
| `--commit <sha>` | its parent .. the commit; from round 2 on, the working tree, limited to the commit's files |
| `--pr <n\|url>` | the PR's merge-base .. your working tree when the PR is checked out; otherwise .. its head, fetched once into `refs/specreview/pr/<n>` |

The default branch is `code.defaultBase` in the config, else `origin/HEAD`, else main, master, trunk or develop. `--path <pathspec>` limits any mode, `--context N` sets the context lines, and `--max-files N` raises the file limit.

These are left out and listed as skipped: the `.specreview/` store; untracked files that look like credentials or keys, by name or by path (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa` and other SSH keys, anything under `.ssh/` or `.gnupg/`, keystores such as `*.keystore` and `*.jks`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.aws/credentials`, `.docker/config.json`, `.kube/config`, `credentials.json`, `*service-account*.json`, `client_secret*.json`, `.htpasswd`, `.pgpass`, `*.tfstate` and a few more) or are very large; and binary or too-large files, which have no `src>`. Every report names each file it left out and why (`.npmrc (excluded: looks like npm credentials)`); their contents are never read into the review. Your index, branches and commits are never changed: rounds use a temporary index, and `apply` writes working files only.

### 19.1 The code packet

```text
SPECREVIEW FEEDBACK · cr-feat-token-refresh (code review: since-base main, merge-base 5a7273c) · review rv1 on v1 · CHANGES REQUESTED
Repo root: /path/to/repo (paths below are relative to it)
Line numbers = files in your working tree now (all identical to v1).
3 threads need action (3 new): 1 question · 1 suggestion · 1 comment

[t1] comment · src/auth/refresh.js:L12
  src>   if (stored.used) throw new TokenReuseError();
  Eric: Two tabs refreshing at once will trip this. Allow reuse within 30 s before throwing.

[t2] suggestion · src/auth/refresh.js:L11 · apply verbatim: suiko apply cr-feat-token-refresh t2
  -   const ttlSec = config.refreshTtlSec;
  +   const ttlSec = config.refreshTtlSec ?? 30 * 24 * 3600;
  Eric: Keep the old default when the config has no TTL.

[t3] question · src/auth/store.js (old side) base L1-3, now between L1
  was> export function legacyLookup(id) {
  was>   return db.tokens.findOne({ id });
  was> }
  Eric: Does anything still call legacyLookup? Was removing it intended?

DECISIONS to keep true: (none yet)
PROTOCOL: Read each cited file (or range) before editing; paths are relative to the repo root above; src> lines are exact Edit old_string for that file; edit bottom-up per file.
  Suggestions: `suiko apply`. Questions: answer in the thread's reply; change code only if the answer needs it. Unsure: status needs_input.
REPLIES: answer every thread above on the thread itself, with a status (the reviewer reads replies in Suiko, not in this chat).
NEXT: edit the files -> suiko revise cr-feat-token-refresh --replies - (records round v2 from your working tree) -> suiko wait cr-feat-token-refresh (background)
```

- **Items** cite `path:L..` relative to the repo root, with `(new file)`, `(old side)` or `(whole file)` where it applies. There is no `on:` line, no section and no LOCKED line: code reviews have no locks.
- **`src>`** is the cited lines in the working file now, grown (up to 8 lines or 1200 characters) until it is unique in that file. Otherwise it says `(not unique in the file: Read around L42 before editing)`.
- **Old-side items** print the deleted lines as `was>`, and `now between L..` says where they would go in the working file.
- `FILE MISSING in your working tree` means the file is gone: restore it, or reply explaining the deletion.
- **Line basis:**
  - normally: the files in your working tree now;
  - a commit that is not checked out: `Line numbers = files of vN (commit 1a2b3c4), which is not checked out: check it out before editing.`;
  - a PR that is not checked out: `PR #123 is not checked out here: run \`gh pr checkout 123\` before editing; line numbers are the PR head 4c5d6e7.`;
  - after a rebase or merge, old-side lines are lines of the new merge-base.
- **Not in the review:** when the round left files out (untracked credential files, unsupported names), a line under the header names each one and why: `Not in the review (the reviewer never saw them; the verdict does not cover them): .npmrc (excluded: looks like npm credentials)`. An approval does not cover those files.
- **JSON:** `kind: "code"`, `code: {label, baseSha, newSha, worktree, root, notReviewed}` (`notReviewed`: `[{path, reason, detail?}]`), and per thread `file`, `fileFromCwd`, `side`, `lines`, `src`, `was` and `fileState` (`ok`, `missing`, `not-checked-out`, `binary` or `too-large`).

### 19.2 Revising a code review

Edit the files with your editor tools. Use `apply <doc> <tid>` for suggestions, and re-Read a file after `apply`. Then record the round:

```json
{"summary": "reuse grace window, TTL default",
 "threads": {
   "t1": {"status": "addressed", "reply": "Reuse within 30 s no longer throws.", "at": "src/auth/refresh.js:L12"},
   "t2": {"status": "addressed", "reply": "Applied."},
   "t3": {"status": "answered", "reply": "Nothing calls it any more, so the removal is intended."}},
 "other": [{"at": "src/auth/index.js:L3", "why": "export the new error type"}]}
```

- `at` and `other[].at` take `path:L..`, or a path for a whole file. The revise report names hunks `src/auth/refresh.js#h1`.
- `edit` and `revert` are refused on code docs.
- Code rounds are never refused by guards: there is no rewrite ratio and no locks, and an unexplained change is only a note, and only for files that hold threads.
- `wait` exits 3 while reviewed files have unrecorded edits. Record them with `revise` first, or pass `--allow-dirty`.
- `diff <doc> v1..v2` is the interdiff between rounds. `show <doc> --file <path> [--side new|old] [--version N]` prints a file of a round.
- `ask <doc> --file <path> [--lines A-B] -m "…"` asks about code, with lines of the working file now. `reanchor <doc> tN [--file <path>] --lines A-B` moves a thread.

### 19.3 PR reviews

`review --pr <n|url>` needs the GitHub CLI (`gh`), signed in.
- **Resolving:** gh resolves the repository (from the URL, or `gh repo view`), the PR and its merge-base. Every value it returns is checked before git runs.
- **Checked out:** when the PR's head commit is HEAD or an ancestor of HEAD, after `gh pr checkout <n>` plus any commits on top, the review covers your working tree.
- **Not checked out:** the head is fetched once from the remote whose URL is the PR's repository, rounds compare against that ref, and the packet says to check out before editing. With no such remote, the review is refused (exit 3) with the `git remote add` to run.
- **Network:** this is the only review that uses the network. Rounds, the review UI and the daemon never run `gh` or `git fetch`. Run `review --pr <n>` again to pick up new PR commits; it refreshes the stored head and merge-base.
- **Exits:**
  - `SPECREVIEW_OFFLINE=1` or `network.allow: false`: exit 3, before anything runs;
  - `gh` missing or not signed in: exit 1;
  - PR not found: exit 4.
- `close` deletes the ref. PR mode is not available over MCP.
