<!-- Reference for the spec-review skill (loaded on demand from SKILL.md). Self-contained because the plugin may be installed outside this repository. Keep in sync with docs/agent-protocol.md. -->

# Suiko reference

- [Conventions](#conventions)
- [Commands](#commands)
- [The feedback packet](#the-feedback-packet)
- [Thread types, statuses and "needs action"](#thread-types-statuses-and-needs-action)
- [Batched edits: planned and APPLY](#batched-edits-planned-and-apply)
- [Attachments on your replies, and use: lines](#attachments-on-your-replies-and-use-lines)
- [Making edits: Edit, apply, edit](#making-edits-edit-apply-edit)
- [The revise input](#the-revise-input)
- [Guards](#guards)
- [How hunks are linked to threads](#how-hunks-are-linked-to-threads)
- [Anchor states](#anchor-states)
- [Locks and decisions](#locks-and-decisions)
- [Hooks](#hooks)
- [Snapshot docs](#snapshot-docs)
- [MCP tools](#mcp-tools)

## Conventions

- `<doc>` is a doc id (the slug printed by `open`, e.g. `funding-study`) or the file path. The workspace is found from the current directory or the path: the nearest ancestor with `.specreview/`, else the git top level, else the file's directory. An id that is not tracked there (or a directory with no workspace, e.g. a project without git whose `.specreview/` sits next to the documents) is looked up in the workspaces `open` registered below or above the current directory; an id tracked in several of them is an error naming them, so pass the file path or `--workspace <dir>`. A path always works.
- Line numbers are 1-based lines of the **current file on disk**. Ranges such as `L42-43` are inclusive.
- Ids are sequential per doc: threads `t1`, comments `c1`, reviews `rv1`, locks `L1`, decisions `D1`, versions `v1`. Hunk ids `h1…` are numbered per diff.
- Output is compact text; `--json` (where listed) prints the same data as JSON.
- Agent name: `--as <name>`, else `$SPECREVIEW_AGENT`, else `claude` when `$CLAUDECODE` is set, else `agent`.
- Environment: `SPECREVIEW_HOME` (runtime state, default `~/.specreview`), `SPECREVIEW_PORT` (UI port; the content port is UI port + 1).

## Commands

| Command | What it does | Exit |
|---|---|---|
| `open <file...> [--title T] [--browser pane\|system\|none] [--workspace <dir>] [--json]` | Track the doc, record v1 if new, start the local server, print the UI URL. Warns if the working copy differs from head, and (stderr) when the installed Suiko instructions are older than the CLI, naming the command that updates them. | 0 |
| `open <dir>` | Every `.md`/`.markdown`/`.html`/`.htm` file below the folder (no dot-directories or `node_modules`, at most 200; says what it skipped): one line per doc, then the UI's home URL listing them. | 0 |
| `open - [--name N] [--title T]` | Review Markdown piped on stdin (at most 5 MB) as a snapshot doc: a new doc each time, or with `--name` the doc of that name (piping it again records a new version). | 0 |
| `last [--session <id>] [--transcript <path>] [--title T]` | Open your last message (Claude Code transcript of `$CLAUDE_CODE_SESSION_ID`) as a snapshot doc; prints the URL and the background `wait` command and returns. Codex transcripts are not supported. | 0 / 4 |
| `snapshot <url> [--title T] [--reader auto\|direct\|jina] [--as-html] [--allow-private] [--allow-remote-assets] [--replies <file\|->]` | Review a web page as a snapshot doc (the only command that uses the network; refused when `SPECREVIEW_OFFLINE=1`). Public hosts only unless `--allow-private`. Again for the same URL records the next version when the page changed; `--replies -` posts replies with it. | 0 / 1 / 3 / 4 |
| `review [<range>] [--uncommitted \| --staged \| --base <ref> [--committed] \| --commit <sha> \| --pr <n\|url>] [--path <pathspec>]... [--context N] [--max-files N] [--title T]` | Open a **code review** of your changes (doc kind `code`, see Code reviews), print the URL and the `wait` command. Again with the same arguments: a new round when the files changed. | 0 / 1 / 3 / 4 |
| `wait [<doc>] [--all] [--timeout 0\|30m] [--allow-dirty] [--allow-unanswered] [--json]` | Block until a review is submitted, print the packet for **all** undelivered reviews, mark them delivered. Returns at once if one is already waiting. Exits 3 at once if the working copy differs from head (unless `--allow-dirty`), or if a thread you received has no reply yet (unless `--allow-unanswered`): it names the threads; reply on each, then wait again. | 0 / 2 / 3 / 5 / 6 |
| `feedback <doc> [--peek] [--include-drafts] [--all-open] [--json]` | The same packet without blocking. Marks it delivered unless `--peek`. `--all-open` also lists threads waiting on the reviewer. | 0 |
| `apply <doc> <tid...> [--dry-run]` | Apply suggestion threads verbatim to the working copy (staged, not recorded). | 0 / 3 |
| `edit <doc> --thread t1[,t2] --old <s> --new <s> [--all]` | Thread-tagged exact replace. `old` must be unique unless `--all`. | 0 / 3 |
| `edit <doc> --stdin` | Batch: `[{"threads":["t1"],"old":"...","new":"...","all":false}]` on stdin. | 0 / 3 |
| `reply <doc> <tid> -m <md> [--status answered\|planned\|declined\|needs_input\|addressed] [--at L42-46] [--attach <file>]... [--decision "text"]` | Reply without recording a version; `--attach` shows an image or an HTML mockup on the reply. | 0 / 4 |
| `revise <doc> [-m <summary>] [--replies <file\|->] [--dry-run] [--break-lock L1="why"]... [--allow-rewrite] [--force]` | Record the working copy as a new version, with replies; runs the guards. | 0 / 3 |
| `revise <doc> --source <file\|-> [--replies <file\|->]` | Snapshot docs: record the given text as the new version (guards only warn). With `--source -` the replies must come from a file. | 0 |
| `revert <doc> (--hunk hN \| --lock L1)` | Reverse one head-to-working hunk, or write a lock's agreed text back, in the doc's file only: for a document built from sources, undo the change in the sources and rebuild instead. | 0 / 3 |
| `reanchor <doc> <tid> (--lines A-B \| --quote TEXT) [--file <path>]` | Move a thread's anchor. Applies to head when the working copy is clean, else staged until the next revise. | 0 / 3 |
| `ask <doc> (--quote TEXT \| --lines A-B \| --file <path> [--lines A-B]) -m <question>` | Ask the reviewer a question anchored on the doc (status `needs_input`). | 0 / 3 |
| `threads <doc> [--status open\|addressed\|needs_input\|resolved\|outdated\|all] [--json]` | One line per thread. | 0 |
| `show <doc> [<tid>] [--version N] [--lines A-B] [--file <path> [--side new\|old]]` | A full thread with its timeline, or exact source of an old version (code reviews: one file of a round). | 0 / 4 |
| `diff <doc> [vA..vB] [--stat\|--unified] [--json]` | Changes between versions (default: last reviewed..head); `head..live` is your unrecorded changes. | 0 |
| `log <doc> [--json]` | Timeline of versions and reviews. | 0 |
| `status [<doc>] [--json]` | Docs, head, thread counts, undelivered reviews, listeners, working-copy state. | 0 |
| `final <doc> [--decisions] [--out <dir>]` | Check the working copy equals the final version; `--decisions` writes `<name>.decisions.md`. | 0 / 3 |
| `close <doc>` | End the review session; running waits exit 5. A PR review also loses `refs/specreview/pr/<n>`. | 0 |
| `snip [<doc>] [-m <text>] [--question] [--send] [--file <png>] [--json]` | The **reviewer's** screenshot tool (macOS picker, or `--file`): adds a draft comment with the picture, or submits it at once with `--send`. Never run it yourself: it opens a picker on the user's screen. | 0 |
| `serve [--foreground] [--port N]`, `stop [--rotate]`, `doctor [--fix]` | Local server control and health checks. | |
| `mcp` | stdio MCP server. | |
| `hook pre-write`, `hook prompt` | Claude Code hook entry points. | always 0 |
| `plan-gate [--timeout 30m] [--browser system\|none]` | Claude Code plan-mode gate (PermissionRequest hook, matcher ExitPlanMode). | always 0 |
| `install [--only a,b] [--user\|--project] [--apply]`, `install claude [--user\|--project] [--with-hooks] [--with-mcp] [--apply]`, `install agents-md [--apply]` | Print (or with `--apply`, write) the integration files; every instruction file ends with `installed by suiko <version>`. After an upgrade, `open` names the command that updates the copies that are out of date (e.g. `suiko install --only claude --apply`, or `suiko install agents-md --apply` for an AGENTS.md block that command wrote). | 0 |

Exit codes: 0 ok or delivered · 1 error or bad usage · 2 wait timed out · 3 refused (guard, dirty working copy, a thread without a reply, conflict, `old` not unique) · 4 doc, thread or version not found · 5 session closed · 6 superseded by a newer `wait` for the same doc and agent.

## The feedback packet

### Text form

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
  crop: /abs/path/.specreview/docs/funding-study/attachments/a1.png  (Read it to see the region)
  Eric: Does the dedupe step run before or after the join?

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

The PROTOCOL lines appear in the first packet.

- **Header:** doc, path, the review(s) and the version they were made on, and the verdict (`COMMENT`, `CHANGES REQUESTED`, `APPROVED`; `· FINAL = vN` when the reviewer marked a final version). The second line says whether the working copy is identical to head or differs (`lines mapped`). `EDITS: batch` and `APPLY:` lines are explained in [Batched edits](#batched-edits-planned-and-apply).
- **Items** appear in file order, blocking first within ties: `[tN] [LABEL ·] [severity ·] type · L<a>-<b> · §<section path> [· <target>]`. Severity is shown when it is not `normal`.
- **Labels:** none for new threads, `REOPENED`, `REPLY` (the reviewer replied after your reply), `ANSWER` (the reviewer answered your `needs_input` question), `APPLY` (make the change you planned).
- **`use:`** under a thread: the reviewer wants one of your attachments in the document (see [Attachments](#attachments-on-your-replies-and-use-lines)). In a packet that approves a final version it reads `use: <absolute path> (chart.html) — the doc is final (v3); say in your reply whether this should go into a next version`: reply, do not edit.
- **Targets:** text (no label), `<img alt="…">`, `region x40-62% y10-30%`, a snipped area `snip (figure + 2 paragraphs)`, `mermaid node "Gateway"`, `table cell row "…" x col "…"`, a section `§7 Rollout plan (L170-196)`, raw source lines, or `GENERAL:` for the whole doc. `(script-rendered inside <div id="chart">)` means the text was built by a script, so `src>` is the enclosing static element.
- **`on:`** the rendered text the reviewer selected (up to 120 characters). Not source.
- **`src>`** exact full lines from the file on disk, extended until the string is unique in the file. Strip the `  src> ` prefix and join with newlines to get an Edit `old_string`.
  - More than 8 lines are shortened to the first 3, `...(N more lines)` and the last; that is not a valid `old_string`. Read the lines instead.
  - A very long line is printed as the shortest unique window around the anchor; it is still a valid `old_string` substring.
  - `data:` URIs are elided as `data:image/png;base64,...(512 KB)`; Read the line before editing it.
  - At most about 1,200 characters of `src>` per thread.
- **`crop:`** an absolute path to a PNG of the region the reviewer drew. Read it to see what they mean.
- **`image:`** an absolute path to a picture the reviewer attached: a snipped area of the doc, a screenshot of anything on their screen, or a pasted image (PNG, or JPEG when very large). **Read every `crop:` and `image:` file with the Read tool before acting on its thread**; the comment often only makes sense with the picture. See [Pictures](#pictures-snips-and-screenshots).
- **Suggestions** show `-` (current) and `+` (proposed) lines and the `apply` command (in a batched round, `suggestion: plan it now; it is applied in the APPLY round` instead). For a document built from sources, the proposed text goes into the sources (see [Making edits](#making-edits-edit-apply-edit)).
- **Conversation:** your last reply (`claude (v2): …`, `claude (v2, needs_input): …`) and every reviewer comment since. Older ones collapse to `(+2 earlier, suiko show <doc> t2)`.
- **Anchor notes:** `(outdated: text changed)` means the quoted text was edited since the comment; `(orphaned: was "…" in §5 v1 L260; reanchor with suiko reanchor)` means it could not be found.
- **Footer:** `LOCKED` ranges, `DECISIONS` to keep true, drafts (only with `--include-drafts`, clearly labelled as not submitted), the protocol reminder and `NEXT`.
- **Size cap:** 10,000 characters. Threads beyond it are listed one per line; run `suiko show <doc> tN` for each.
- **Approved:** `… · APPROVED · FINAL = v3`, `0 threads need action`, `NEXT: suiko final funding-study --decisions   (then stop waiting)`. When the approval also reopened or answered threads, they are listed and NEXT says to answer each with `suiko reply <doc> <tid> -m <md> --status answered|declined` (no edits, no new version) before `final`, and the PROTOCOL lines are replaced by a reply-only line. This applies only when the final version is the current head; an approval without a final version keeps the usual revise flow.

### Pictures: snips and screenshots

```text
[t5] comment · L60-64 · §2 Method · snip (figure + 2 paragraphs)
  src>     <figure><img src="img/pipeline.png" alt="Pipeline overview"></figure>
  src> 
  src>     <p>Trades are joined to quotes by session, then deduplicated.</p>
  src> 
  src>     <p>A session with a trading halt is split at the halt.</p>
  image: /abs/path/.specreview/docs/funding-study/attachments/a2.png  (Read it to see what the reviewer snipped)
  Eric: The figure shows the dedupe before the join, but the text says after. Which is it?

[t6] comment · GENERAL
  image: /abs/path/.specreview/docs/funding-study/attachments/a3.png  (Read it to see the image the reviewer attached)
  Eric: This is the dashboard today. The mockup in §5 should match it.
```

- **Snip** (the Area tool at the bottom of the document, or `b`): the reviewer boxed an area of the rendered doc. `src>` covers every block under the box, in file order; change only what the comment is about. A large snip's `src>` is shortened like any other: Read those lines first.
- **Screenshot** (`B`, or `suiko snip` from a hotkey): usually a `GENERAL` thread, or anchored to text the reviewer had selected. It may show something outside the doc (the running app, a terminal, another page). Tie it to the document through the comment; if you cannot tell which part it concerns, reply `needs_input`.
- **Something drawn or built at runtime** (a canvas, a chart drawn by a script, a state reached by clicking): the thread cites the nearest source lines and usually has a picture. Read it, find what produces it (markup, data, styles, script, template), change that, and rebuild if the document is built.
- In JSON, `attachments` lists the absolute paths of a thread's pictures, and `attachmentKind` says what they are (`region`, `snip` or `image`).

### JSON form (`--json`, and MCP `structuredContent`)

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

## Thread types, statuses and "needs action"

- Types: `comment`, `question`, `suggestion`, `agent-question` (created by `ask`). Severities: `blocking`, `normal`, `nit`.
- Statuses: `open`, `addressed`, `answered`, `planned`, `declined`, `needs_input`, `resolved`. You set `addressed`, `answered`, `planned`, `declined` or `needs_input` through `revise` or `reply`. **Only the reviewer resolves** (Accept) or reopens.
- A thread needs action when its status is `open`, or when the reviewer's newest comment is newer than yours and it is not `resolved`. A `planned` thread waits for the reviewer's APPLY.
- The reviewer usually sends each comment as they write it (or with `suiko snip --send`), as a review with verdict `comment` and one thread; comments sent while you work arrive together in your next packet. Every packet needs action: handle it, revise, wait again.
- Delivery: a review is marked delivered when the packet has been printed. Your next command on that doc (`revise`, `reply`, `apply`, `edit`, `show`, `feedback`, `ask`, `reanchor`) acknowledges it. If you never act on it, the prompt hook reminds you after about 5 minutes.

## Batched edits: planned and APPLY

The reviewer can batch the edits (Suiko does it by default on long documents), so you answer each comment at once and change the document once per batch:

- A packet with the line `EDITS: batch. Answer every thread now. …` asks you to answer every thread now without editing the document. Next to an APPLY round it reads `EDITS: batch for every thread not marked APPLY. …`; when only some threads are batched, `EDITS: batch for t9 only (the other threads: edit now). …` (handle the others as usual). For a change you agree to make, reply with status `planned` and say exactly what you will change; questions get `answered` (also `declined` and `needs_input` as usual). A batched suggestion says `suggestion: plan it now; it is applied in the APPLY round`. Post all replies with one `suiko revise <doc> --replies -` (the working copy equals head, so it records no version and only posts them; the packet's `NEXT` says `replies only, no edits yet`) or with `suiko reply <doc> tN -m <md> --status planned`.
- A `planned` thread is not waiting on you: `wait` does not count it as unanswered. Until each batched thread has a reply, `wait` exits 3 and asks for one (status `planned` with exactly what you will change).
- When the reviewer applies the plan, an `APPLY` packet arrives: its header line `APPLY: make every planned change below in one pass, then record ONE version as NEXT says (status addressed).`, then each thread with the label `APPLY`, the reviewer's original request and your planned reply. Make every change (a suggestion as in [Making edits](#making-edits-edit-apply-edit)), then record one version as `NEXT` says, with status `addressed` for each thread: one `suiko revise <doc> --replies -` (for a web page you build, the `suiko snapshot` command it names).

## Attachments on your replies, and use: lines

- **Show, don't only tell.** When the reviewer asks to see a chart, an image or a mockup, or when a picture explains your answer better than words, attach files to your reply: `--attach <file>` (repeatable) on `suiko reply`, or `"attachments": ["<file>", …]` on a thread of the revise JSON (paths relative to the current directory, or absolute). Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`) show as thumbnails, an `.html`/`.htm` file as a live preview in a sandbox; at most 6 per reply, 5 MB each. Suiko keeps a copy in `.specreview/docs/<doc>/attachments/`, so write the file anywhere (a temp directory is fine). Iterate on it in the thread: the reviewer replies, you attach the next version.
- **`use:` line.** When the reviewer chooses **Use in doc** for one of your attachments, the thread comes back with `use: <absolute path> (chart.html) — put this into the doc at this thread's place …`. Put it into the document at the thread's anchor, the way the document holds such things (copy the file next to the document and reference it, or inline its content), then reply `addressed`.

## Making edits: Edit, apply, edit

1. **Read first, and only what you need.** Read the cited ranges (Read with `offset`/`limit`) before editing, not the whole document, and do not re-read the whole document each round. The reviewer may have recorded their own revision since the packet.
2. **Change only what the thread asks for.** In the document itself: the Edit tool with `old_string` = the `src>` text, edit bottom-up or rely on the `src>` text rather than line numbers, and keep the surrounding formatting. In a document built from sources (a template, data, a script that writes the HTML): `src>` shows the built output; change the source that produces it, rebuild the document the way it was built, and name the rebuilt lines in the thread's `at`: it explains every change on the lines it names (a rebuilt table, data blob or chart script usually reaches beyond the anchored paragraph). Never restyle or rewrite parts no thread asked about.
3. **`suiko apply <doc> <tid...>`** for suggestions, after all Edit-tool edits. It maps the anchored range to the current file and splices the exact text if it is still there (or if it occurs once, or near the expected place). Otherwise it reports `conflict tN: expected text not found near L120; treat as a normal comment` (exit 3). On success the suggestion is `staged` and the edit is tagged to the thread. `apply` rewrites the file, so re-Read before any later Edit. **A document built from sources:** do not run `apply`. It changes only the built file, so the next rebuild brings the old text back, and `revise` then refuses with `ERR reverted` (below). Put the suggested text into the sources, rebuild, and reply `addressed`.
4. **`suiko edit`** is the CLI form of an exact replace, tagged to threads. Use it when you have no Edit tool:
   ```bash
   suiko edit funding-study --thread t1 --old "widened on 12 days" --new "widened on 31 days (above 50 bp)"
   suiko edit funding-study --stdin <<'JSON'
   [{"threads":["t1"],"old":"widened on 12 days","new":"widened on 31 days (above 50 bp)"},
    {"threads":["t4"],"old":"<td>2024-Q2</td><td>4</td>","new":"<td>2024-Q2</td><td>5</td>","all":false}]
   JSON
   ```
5. **Writes are guarded.** In Claude Code, a Write that would replace more than 40% of the text of a document under review (its visible text, for HTML) makes the pre-write hook ask the user to allow it (in a workspace whose config says `"writeHook": "deny"`, it is denied). Change only what the threads ask for, with Edit, or in the sources followed by a rebuild. See [Hooks](#hooks).

## The revise input

`suiko revise <doc> --replies -` reads JSON from stdin (or `--replies <file>`):

```text
{ "summary": string,                                      // -m <summary> overrides it
  "threads": { "<tid>": { "status": "addressed" | "answered" | "planned" | "declined" | "needs_input",
                          "reply": string,                // Markdown, shown to the reviewer
                          "at": "L42-46" | "L12,L90-91",  // optional: lines of the NEW file you changed for it
                          "attachments": [string] } },    // optional: files shown on the reply (see Attachments)
  "other":   [ { "at": "L12" | "L12-14" | "del:h6" | "h6", "why": string } ],   // changes no thread asked for
  "breakLocks": { "L1": "reason" } }                      // only when the user explicitly asked
```

- Give one `threads` entry for every thread the packet listed. A missing entry is a warning.
- `at` explains every change on the lines it names (see [How hunks are linked](#how-hunks-are-linked-to-threads)). To find them, `suiko revise <doc> --dry-run` lists each hunk with its lines, and so does `suiko diff <doc> head..live --stat` (your unrecorded changes).
- `addressed` with no linked change is a warning: add `at` if you changed it somewhere away from the anchor.
- If the working copy equals head, `revise` posts the replies only. If there is nothing to record and no replies, it says so and exits 0. An `addressed` reply then gets `WARN tN is marked addressed but nothing was recorded: the document did not change. …`: a file the document loads at runtime (with `fetch` or XHR) is not versioned, so a change made only there records nothing; change the document itself, or reply `answered`.
- `--break-lock L1="reason"` on the command line is the same as `breakLocks`.

Successful report:

```text
suiko: recorded v2 for funding-study (+9 -3 lines, 4 hunks) · responds to rv1
  h1 L48     §3 Findings         -> t2 addressed  (hint)
  h2 L120    §2.1 Data           -> t3 addressed  (tagged: apply)
  h3 L212    §3.2 Funding stress -> t1 addressed  (overlap)
  h4 L12     header              -> other: Bumped 'Last revised' date
  t4 needs_input (reply only)
guards: ok · lock L1 untouched · no unexplained deletions · rewrite 4%
anchors: 4 threads + 1 lock -> 1 exact, 1 moved, 3 edited, 0 changed, 0 orphaned
reviewer notified (1 UI open). next: suiko wait funding-study (background)
```

Refusal (exit 3, nothing recorded, working copy untouched):

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

Errors are listed bottom-up (the highest hunk first): reverting a hunk renumbers the hunks after it, so follow the fixes in that order. How to respond:
- **A change a thread asked for:** name its lines in that thread's `at`. An `at` explains every change on the lines it names; a hunk linked only by overlap is explained only within the thread's text and its paragraph or section.
- **A change no thread asked for:** undo it where you made it. In a document built from sources, undo it in the sources and rebuild: `suiko revert <doc> --hunk hN` restores only the file it is run on, so for a built document the next rebuild brings the change back. For a file you edited directly, `suiko revert` is the quickest way. If you meant the change, explain it with `other`.
- **`reverted`:** a rebuild dropped a suggestion that an earlier version applied to the built file only. Put the suggested text into the sources and rebuild.
- **A lock:** reply `needs_input` and let the reviewer decide (use `--break-lock` only when the user explicitly asks).
- Never revert a hunk you did not make: explain it (`"why": "not mine: external edit"`).

## Guards

What the deletion and rewrite checks count is the text the reviewer reads: for HTML its visible text (not tags or attributes, so not `data:` URIs or inline styles, and not scripts, styles or JSON data blobs, except the sentences in the string literals of an inline script of up to 256 KB, which the page may show as text), for Markdown the source, less inline `data:` images. A rebuilt document whose data blob or chart script changed together with the sentences the threads asked about passes. `revise` is the real gate: the pre-write hook ([Hooks](#hooks)) only catches a Write that replaces most of the document, while `revise` checks every change, however it was made.

| Check | Default | Way out |
|---|---|---|
| An active lock's agreed text is no longer intact | refuse | undo the change (`revert --lock L1` writes the agreed text back), or `--break-lock L1="reason"` when the user asks |
| ... but the lock was added after the last packet you received | warn | |
| A hunk removes or replaces 20 or more words, or 3 or more whole lines, of that text that nothing explains: all of it for an unlinked hunk; for a linked hunk, the part outside its threads' text (the anchor and its paragraph, or a heading's section) and outside the lines an `at` names | refuse | name the lines in the `at` of the thread that asked for it, an `other` entry, undo it where you made it, or config |
| More than half of that text removed or replaced where no thread asked for it (unlinked hunks, and what a linked hunk changes outside its threads' text and its `at` lines; a GENERAL thread covers the whole document), in a document of 40 lines or 300 words or more (HTML: 300 visible words) | refuse | name the lines in the `at` of the thread that asked for it; `--allow-rewrite` only when the user asked for a rewrite |
| A suggestion an earlier version applied (its thread addressed or resolved) is in head but gone from the working copy, and no hunk that removes it is linked with `at` (or a tagged edit) or explained by `other` (`reverted`: a rebuild from sources that never had it) | refuse | put the suggested text into the sources and rebuild; if a thread asked to change it again, name its lines in that thread's `at` |
| A thread in the packet has no reply entry | warn | add the entry |
| A thread marked `addressed` has no linked change | warn | add `at` |
| A decision's text is touched by a hunk not linked to that decision's thread | warn | |
| `--force` | overrides every refusal; recorded and shown in red to the reviewer | never without an explicit request |

## How hunks are linked to threads

For each hunk between head and the working copy, in order:

1. **tagged:** an `apply` or `edit` made for that thread produced it.
2. **hint:** your `at` lines for a thread overlap it. An `at` explains every change on the lines it names.
3. **overlap:** it changes text inside an actionable thread's anchored range (the anchor's whole lines, on lines of up to 1,000 characters). This link is inferred, so it explains only the thread's text and its paragraph-level block (for a heading, its section; for a GENERAL thread, the whole document). Whatever the hunk changes beyond that counts as unasked: the deletion check then says `linked to tN only because it overlaps tN's text`, and naming the hunk's lines in that thread's `at` explains it, if the thread asked for the whole change.
4. Otherwise it is **unlinked** and must be explained by an `other` entry (`at` lines of the new file, or `del:hN` / `hN`).

`suiko revise <doc> --dry-run` shows how each hunk is linked and its lines; `suiko diff <doc> head..live --stat` lists the hunks of your unrecorded changes.

Human and external edits look the same as yours. If you did not make a hunk, explain it (`"why": "not mine: external edit"`); do not revert it.

## Anchor states

| State | Meaning | In the packet |
|---|---|---|
| `exact` | Same text, same lines | lines |
| `moved` | Same text, different place | lines |
| `edited` | Changed by a hunk linked to the thread | lines of the new text |
| `changed` | The text was edited without a link ("outdated") | `(outdated: text changed)` |
| `orphaned` | Not found | `(orphaned: …; reanchor with suiko reanchor)` |

If an anchor is wrong, move it: `suiko reanchor <doc> tN --lines A-B` or `--quote "exact text"`.

## Locks and decisions

- **Locks** (`L1`, "Mark agreed" in the UI) are hard: `revise` refuses a version that changes the agreed text. The packet lists them under `LOCKED`.
- **Decisions** (`D1`) are recorded when the reviewer accepts a thread with a one-line decision. They are soft: changing their text is a warning, and every packet reminds you under `DECISIONS`.
- `suiko final <doc> --decisions` writes `<name>.decisions.md`: each decision with its context, resolution, version and hunk.

## Hooks

- **`hook pre-write`** (PreToolUse, matcher `Write`): if the target is a tracked doc that has at least one review and is not closed, and the Write would replace more than 40% of its text (measured as the guards do: the visible text of HTML, so a changed script, style, data blob or `data:` URI counts for nothing), it asks the user to allow the Write: a permission prompt with the reason (in a headless `claude -p` run the Write is denied and you get the reason). The reason reads: "Suiko: this Write would replace 91% of the visible text of reports/funding-study.html, which is under review (v3, 7 open threads). Allow it only if a full rewrite was asked for; otherwise change only what the review threads ask for (Edit the file, or change its sources and rebuild). After an approved full rewrite, record it with `suiko revise funding-study --allow-rewrite`." A workspace whose `.specreview/config.json` sets `"writeHook": "deny"` denies such Writes instead, and `"off"` turns the hook off. Smaller Writes are allowed. A rebuild by a script is not a Write, so the hook never sees it. **`suiko revise` is the real gate:** the hook only catches near-total rewrites, while `revise` refuses any unexplained deletion or rewrite. After a full rewrite the user asked for, record it with `suiko revise <doc> --allow-rewrite --replies -`.
- **`hook prompt`** (UserPromptSubmit): adds a note to the prompt when a submitted review on a doc in this workspace was not delivered and nothing is waiting for it, or was delivered more than about 5 minutes ago but never acted on. Example: `suiko: review rv2 on funding-study (2 threads, CHANGES REQUESTED) was submitted at 14:20 and not delivered. Run suiko feedback funding-study and address it per the spec-review skill.` When the current directory has no workspace of its own, the registered workspaces below it are checked and the command names them (`suiko feedback funding-study --workspace reports`).
- Both always exit 0 and print nothing on error.
- **`plan-gate`** (PermissionRequest, matcher `ExitPlanMode`, timeout 345600): records the plan (the plan file, else the inline plan) as a snapshot doc, a new version on each ExitPlanMode of the same plan file in the session, opens the UI and blocks until the review (`wait --all` never takes a plan review). Threads your new version changed are marked addressed (`Changed in vN.`). Approved: allows ExitPlanMode. Request changes or Comment: denies it with feedback citing the plan file and its lines (`YOUR PLAN WAS NOT APPROVED ...`): make targeted Edit-tool changes to the plan file and call ExitPlanMode again. On any error, or when the user answers in the terminal, it prints nothing and exits 0. Comments sent with an approval are not passed on.

## Snapshot docs

A plan, your last message or piped text is a **snapshot doc**: no working file (its synthetic path, e.g. `plans/<slug>.md`, is never read or written), versions recorded from text. Threads, re-anchoring, attribution, Changes and History work as for files. Differences:
- `apply`, `edit` and `revert` are refused; revise with `revise <doc> --source <file> --replies -` (or, for a plan, edit the plan file and call ExitPlanMode again).
- Guards still run, but their errors are recorded as warnings: nothing is refused.
- A **web page** (`snapshot <url>`, path `web/<slug>.md`): the packet's line basis names the page (`Line numbers = lines of Suiko's Markdown snapshot of <url> (fetched …)`). For a page you build (`--allow-private`), change its sources as the threads ask and run the `NEXT:` command, `suiko snapshot <url> --allow-private --replies -`, with the replies JSON on stdin. A public page has nothing to edit: answer each thread with `suiko reply <doc> <tid> -m <md> --status answered|declined`.
- When the current directory cannot be a workspace (your home directory or `/`), the doc goes to a scratch workspace under `$SPECREVIEW_HOME/scratch/`, and every printed command carries `--workspace <dir>`: keep it.

## Code reviews

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

These are left out and listed as skipped: the `.specreview/` store; untracked files that look like secrets (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa` and other keys) or are very large; and binary or too-large files, which have no `src>`. Your index, branches and commits are never changed: rounds use a temporary index, and `apply` writes working files only.

### The code packet

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
- **JSON:** `kind: "code"`, `code: {label, baseSha, newSha, worktree, root}`, and per thread `file`, `fileFromCwd`, `side`, `lines`, `src`, `was` and `fileState` (`ok`, `missing`, `not-checked-out`, `binary` or `too-large`).

### Revising a code review

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

### PR reviews

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

## MCP tools

`suiko mcp` serves these tools over stdio. Each returns the CLI text as `content` and the `--json` shape as `structuredContent`, with `isError: true` on a refusal or conflict. In Claude Code the background CLI `wait` is preferred.

| Tool | Input |
|---|---|
| `suiko_open` | `{path, title?}` -> `{doc, version, url}` |
| `suiko_snapshot` | `{url, title?}` -> `{doc, version, url, page}`: a public web page only |
| `suiko_review` | `{mode?, base?, range?, commit?, paths?, title?}` -> a code review (modes as in Code reviews, without PR mode) |
| `suiko_wait` | `{doc?, timeout_sec?, allow_unanswered?}` (default 50, max 600) -> the packet, `{status:"waiting"}` (call again) or `{status:"closed"}`; refused (`{status:"unanswered", threads}`) while a thread you received has no reply |
| `suiko_feedback` | `{doc, peek?, include_drafts?}` |
| `suiko_apply` | `{doc, thread_ids}` |
| `suiko_edit` | `{doc, thread_ids, old_string, new_string, replace_all?}` |
| `suiko_reply` | `{doc, thread_id, body, status?, at?, attachments?, decision?}` |
| `suiko_revise` | `{doc, summary, threads, other?, break_locks?, allow_rewrite?, dry_run?}` (each thread may carry `attachments`) |
| `suiko_revert` | `{doc, hunk?, lock?}` |
| `suiko_reanchor` | `{doc, thread_id, lines?, quote?, file?}` |
| `suiko_ask` | `{doc, body, quote? or lines?, file?}` |
| `suiko_threads` | `{doc, status?}` |
| `suiko_diff` | `{doc, from?, to?, format?: "stat" or "unified"}` |
| `suiko_log`, `suiko_status` | `{doc?}` |
| `suiko_show` | `{doc, thread_id?, version?, lines?, file?, side?}` |
| `suiko_final` | `{doc, decisions?, out_dir?}` |
