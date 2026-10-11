<!-- Reference for the spec-review skill (loaded on demand from SKILL.md). Self-contained because the plugin may be installed outside this repository. Keep in sync with docs/agent-protocol.md. -->

# SpecReview reference

- [Conventions](#conventions)
- [Commands](#commands)
- [The feedback packet](#the-feedback-packet)
- [Thread types, statuses and "needs action"](#thread-types-statuses-and-needs-action)
- [Making edits: Edit, apply, edit](#making-edits-edit-apply-edit)
- [The revise input](#the-revise-input)
- [Guards](#guards)
- [How hunks are linked to threads](#how-hunks-are-linked-to-threads)
- [Anchor states](#anchor-states)
- [Locks and decisions](#locks-and-decisions)
- [Hooks](#hooks)
- [MCP tools](#mcp-tools)
- [Writing specs that review well](#writing-specs-that-review-well)

## Conventions

- `<doc>` is a doc id (the slug printed by `open`, e.g. `token-service`) or the file path. The workspace is found from the current directory or the path: the nearest ancestor with `.specreview/`, else the git top level, else the file's directory. An id that is not tracked there (or a directory with no workspace, e.g. a project without git whose `.specreview/` sits next to the specs) is looked up in the workspaces `open` registered below or above the current directory; an id tracked in several of them is an error naming them, so pass the file path or `--workspace <dir>`. A path always works.
- Line numbers are 1-based lines of the **current file on disk**. Ranges such as `L42-43` are inclusive.
- Ids are sequential per doc: threads `t1`, comments `c1`, reviews `rv1`, locks `L1`, decisions `D1`, versions `v1`. Hunk ids `h1…` are numbered per diff.
- Output is compact text; `--json` (where listed) prints the same data as JSON.
- Agent name: `--as <name>`, else `$SPECREVIEW_AGENT`, else `claude` when `$CLAUDECODE` is set, else `agent`.
- Environment: `SPECREVIEW_HOME` (runtime state, default `~/.specreview`), `SPECREVIEW_PORT` (UI port; the content port is UI port + 1).

## Commands

| Command | What it does | Exit |
|---|---|---|
| `open <file...> [--title T] [--browser pane\|system\|none] [--workspace <dir>] [--json]` | Track the doc, record v1 if new, start the local server, print the UI URL. Warns if the working copy differs from head. | 0 |
| `wait [<doc>] [--all] [--timeout 0\|30m] [--allow-dirty] [--json]` | Block until a review is submitted, print the packet for **all** undelivered reviews, mark them delivered. Returns at once if one is already waiting. Exits 3 at once if the working copy differs from head (unless `--allow-dirty`). | 0 / 2 / 3 / 5 / 6 |
| `feedback <doc> [--peek] [--include-drafts] [--all-open] [--json]` | The same packet without blocking. Marks it delivered unless `--peek`. `--all-open` also lists threads waiting on the reviewer. | 0 |
| `apply <doc> <tid...> [--dry-run]` | Apply suggestion threads verbatim to the working copy (staged, not recorded). | 0 / 3 |
| `edit <doc> --thread t1[,t2] --old <s> --new <s> [--all]` | Thread-tagged exact replace. `old` must be unique unless `--all`. | 0 / 3 |
| `edit <doc> --stdin` | Batch: `[{"threads":["t1"],"old":"...","new":"...","all":false}]` on stdin. | 0 / 3 |
| `reply <doc> <tid> -m <md> [--status answered\|declined\|needs_input\|addressed] [--at L42-46] [--decision "text"]` | Reply without recording a version. | 0 / 4 |
| `revise <doc> [-m <summary>] [--replies <file\|->] [--dry-run] [--break-lock L1="why"]... [--allow-rewrite] [--force]` | Record the working copy as a new version, with replies; runs the guards. | 0 / 3 |
| `revert <doc> (--hunk hN \| --lock L1)` | Reverse one head-to-working hunk, or write a lock's agreed text back. | 0 / 3 |
| `reanchor <doc> <tid> (--lines A-B \| --quote TEXT)` | Move a thread's anchor. Applies to head when the working copy is clean, else staged until the next revise. | 0 / 3 |
| `ask <doc> (--quote TEXT \| --lines A-B) -m <question>` | Ask the reviewer a question anchored on the doc (status `needs_input`). | 0 / 3 |
| `threads <doc> [--status open\|addressed\|needs_input\|resolved\|outdated\|all] [--json]` | One line per thread. | 0 |
| `show <doc> [<tid>] [--version N] [--lines A-B]` | A full thread with its timeline, or exact source of an old version. | 0 / 4 |
| `diff <doc> [vA..vB] [--stat\|--unified] [--json]` | Changes between versions (default: last reviewed..head). | 0 |
| `log <doc> [--json]` | Timeline of versions and reviews. | 0 |
| `status [<doc>] [--json]` | Docs, head, thread counts, undelivered reviews, listeners, working-copy state. | 0 |
| `final <doc> [--decisions] [--out <dir>]` | Check the working copy equals the final version; `--decisions` writes `<name>.decisions.md`. | 0 / 3 |
| `close <doc>` | End the review session; running waits exit 5. | 0 |
| `serve [--foreground] [--port N]`, `stop [--rotate]`, `doctor [--fix]` | Local server control and health checks. | |
| `mcp` | stdio MCP server. | |
| `hook pre-write`, `hook prompt` | Claude Code hook entry points. | always 0 |
| `install claude [--user\|--project] [--with-hooks] [--with-mcp] [--apply]`, `install agents-md [--apply]` | Print (or with `--apply`, write) the integration files. | 0 |

Exit codes: 0 ok or delivered · 1 error or bad usage · 2 wait timed out · 3 refused (guard, dirty working copy, conflict, `old` not unique) · 4 doc, thread or version not found · 5 session closed · 6 superseded by a newer `wait` for the same doc and agent.

## The feedback packet

### Text form

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
  crop: /abs/path/.specreview/docs/token-service/attachments/a1.png  (Read it to see the region)
  Eric: Does the gateway sit in front of the auth service or beside it?

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
NEXT: edits -> specreview revise token-service --replies - (JSON, one entry per thread) -> specreview wait token-service (background)
```

- **Header:** doc, path, the review(s) and the version they were made on, and the verdict (`COMMENT`, `CHANGES REQUESTED`, `APPROVED`; `· FINAL = vN` when the reviewer marked a final version). The second line says whether the working copy is identical to head or differs (`lines mapped`).
- **Items** appear in file order, blocking first within ties: `[tN] [LABEL ·] [severity ·] type · L<a>-<b> · §<section path> [· <target>]`. Severity is shown when it is not `normal`.
- **Labels:** none for new threads, `REOPENED`, `REPLY` (the reviewer replied after your reply), `ANSWER` (the reviewer answered your `needs_input` question).
- **Targets:** text (no label), `<img alt="…">`, `region x40-62% y10-30%`, `mermaid node "Gateway"`, `table cell row "…" x col "…"`, a section `§7 Rollout plan (L170-196)`, raw source lines, or `GENERAL:` for the whole doc. `(script-rendered inside <div id="chart">)` means the text was built by a script, so `src>` is the enclosing static element.
- **`on:`** the rendered text the reviewer selected (up to 120 characters). Not source.
- **`src>`** exact full lines from the file on disk, extended until the string is unique in the file. Strip the `  src> ` prefix and join with newlines to get an Edit `old_string`.
  - More than 8 lines are shortened to the first 3, `...(N more lines)` and the last; that is not a valid `old_string`. Read the lines instead.
  - A very long line is printed as the shortest unique window around the anchor; it is still a valid `old_string` substring.
  - `data:` URIs are elided as `data:image/png;base64,...(512 KB)`; Read the line before editing it.
  - At most about 1,200 characters of `src>` per thread.
- **`crop:`** an absolute path to a PNG of the region the reviewer drew. Read it to see what they mean.
- **Suggestions** show `-` (current) and `+` (proposed) lines and the `apply` command.
- **Conversation:** your last reply (`claude (v2): …`, `claude (v2, needs_input): …`) and every reviewer comment since. Older ones collapse to `(+2 earlier, specreview show <doc> t2)`.
- **Anchor notes:** `(outdated: text changed)` means the quoted text was edited since the comment; `(orphaned: was "…" in §5 v1 L260; reanchor with specreview reanchor)` means it could not be found.
- **Footer:** `LOCKED` ranges, `DECISIONS` to keep true, drafts (only with `--include-drafts`, clearly labelled as not submitted), the protocol reminder and `NEXT`.
- **Size cap:** 10,000 characters. Threads beyond it are listed one per line; run `specreview show <doc> tN` for each.
- **Approved:** `… · APPROVED · FINAL = v3`, `0 threads need action`, `NEXT: specreview final token-service --decisions   (then stop waiting)`.

### JSON form (`--json`, and MCP `structuredContent`)

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

## Thread types, statuses and "needs action"

- Types: `comment`, `question`, `suggestion`, `agent-question` (created by `ask`). Severities: `blocking`, `normal`, `nit`.
- Statuses: `open`, `addressed`, `answered`, `declined`, `needs_input`, `resolved`. You set `addressed`, `answered`, `declined` or `needs_input` through `revise` or `reply`. **Only the reviewer resolves** (Accept) or reopens.
- A thread needs action when its status is `open`, or when the reviewer's newest comment is newer than yours and it is not `resolved`.
- Delivery: a review is marked delivered when the packet has been printed. Your next command on that doc (`revise`, `reply`, `apply`, `edit`, `show`, `feedback`, `ask`, `reanchor`) acknowledges it. If you never act on it, the prompt hook reminds you after about 5 minutes.

## Making edits: Edit, apply, edit

1. **Read first.** Read the spec file, or the cited ranges, before editing. The reviewer may have recorded their own revision since the packet.
2. **Edit tool** for comments: `old_string` = the `src>` text. Edit bottom-up, or rely on the `src>` text rather than line numbers.
3. **`specreview apply <doc> <tid...>`** for suggestions, after all Edit-tool edits. It maps the anchored range to the current file and splices the exact text if it is still there (or if it occurs once, or near the expected place). Otherwise it reports `conflict tN: expected text not found near L120; treat as a normal comment` (exit 3). On success the suggestion is `staged` and the edit is tagged to the thread. `apply` rewrites the file, so re-Read before any later Edit.
4. **`specreview edit`** is the CLI form of an exact replace, tagged to threads. Use it when you have no Edit tool:
   ```bash
   specreview edit token-service --thread t1 --old "rotated on every use" --new "rotated with a 30 s grace window"
   specreview edit token-service --stdin <<'JSON'
   [{"threads":["t1"],"old":"rotated on every use","new":"rotated with a 30 s grace window"},
    {"threads":["t4"],"old":"| refresh_token | opaque | 30d |","new":"| refresh_token (user) | opaque | 30d |","all":false}]
   JSON
   ```
5. **Writes are guarded.** In Claude Code, a Write that would replace more than 40% of a spec under review is denied by the pre-write hook. Use Edit.

## The revise input

`specreview revise <doc> --replies -` reads JSON from stdin (or `--replies <file>`):

```text
{ "summary": string,                                      // -m <summary> overrides it
  "threads": { "<tid>": { "status": "addressed" | "answered" | "declined" | "needs_input",
                          "reply": string,                // Markdown, shown to the reviewer
                          "at": "L42-46" | "L12,L90-91" } },  // optional: lines of the NEW file you changed for it
  "other":   [ { "at": "L12" | "L12-14" | "del:h6" | "h6", "why": string } ],   // changes no thread asked for
  "breakLocks": { "L1": "reason" } }                      // only when the user explicitly asked
```

- Give one `threads` entry for every thread the packet listed. A missing entry is a warning.
- `addressed` with no linked change is a warning: add `at` if you changed it somewhere away from the anchor.
- If the working copy equals head, `revise` posts the replies only. If there is nothing to record and no replies, it says so and exits 0.
- `--break-lock L1="reason"` on the command line is the same as `breakLocks`.

Successful report:

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

Refusal (exit 3, nothing recorded, working copy untouched):

```text
specreview: REFUSED - nothing recorded (exit 3)
  ERR lock: h5 L171-174 changes L1 §7 Rollout plan (agreed in rv1)
      fix: specreview revert token-service --hunk h5   or   --break-lock L1="<reason>"
  ERR deletion: h6 removes 14 lines (v1 L201-214, §8 Open questions) linked to no thread
      fix: specreview revert token-service --hunk h6   or   add "other":[{"at":"del:h6","why":"..."}]
  WARN t2 marked addressed but no hunk is linked to it (add "at":"L90-91" if you changed it)
working copy left untouched. Preview with --dry-run.
```

How to respond: revert hunks that were your mistake; explain intended changes with `other`; for a lock, reply `needs_input` and let the reviewer decide (use `--break-lock` only when the user explicitly asks). Never revert a hunk you did not make.

## Guards

| Check | Default | Way out |
|---|---|---|
| An active lock's agreed text is no longer intact | refuse | `revert --lock L1`, or `--break-lock L1="reason"` when the user asks |
| ... but the lock was added after the last packet you received | warn | |
| An unlinked, unexplained hunk removes or replaces 20 or more words, or 3 or more whole lines | refuse | an `other` entry, `revert --hunk hN`, or config |
| More than half of the old text removed or replaced (head of 40 lines or more) | refuse | `--allow-rewrite` only when the user asked for a rewrite |
| A thread in the packet has no reply entry | warn | add the entry |
| A thread marked `addressed` has no linked change | warn | add `at` |
| A decision's text is touched by a hunk not linked to that decision's thread | warn | |
| `--force` | overrides every refusal; recorded and shown in red to the reviewer | never without an explicit request |

## How hunks are linked to threads

For each hunk between head and the working copy, in order:

1. **tagged:** an `apply` or `edit` made for that thread produced it.
2. **hint:** your `at` lines for a thread overlap it.
3. **overlap:** it changes text inside an actionable thread's anchored range.
4. Otherwise it is **unlinked** and must be explained by an `other` entry (`at` lines of the new file, or `del:hN` / `hN`).

Human and external edits look the same as yours. If you did not make a hunk, explain it (`"why": "not mine: external edit"`); do not revert it.

## Anchor states

| State | Meaning | In the packet |
|---|---|---|
| `exact` | Same text, same lines | lines |
| `moved` | Same text, different place | lines |
| `edited` | Changed by a hunk linked to the thread | lines of the new text |
| `changed` | The text was edited without a link ("outdated") | `(outdated: text changed)` |
| `orphaned` | Not found | `(orphaned: …; reanchor with specreview reanchor)` |

If an anchor is wrong, move it: `specreview reanchor <doc> tN --lines A-B` or `--quote "exact text"`.

## Locks and decisions

- **Locks** (`L1`, "Mark agreed" in the UI) are hard: `revise` refuses a version that changes the agreed text. The packet lists them under `LOCKED`.
- **Decisions** (`D1`) are recorded when the reviewer accepts a thread with a one-line decision. They are soft: changing their text is a warning, and every packet reminds you under `DECISIONS`.
- `specreview final <doc> --decisions` writes `<name>.decisions.md`: each decision with its context, resolution, version and hunk.

## Hooks

- **`hook pre-write`** (PreToolUse, matcher `Write`): if the target is a tracked doc that has at least one review and is not closed, and the Write would change more than 40% of its lines, it denies the Write with a reason pointing to Edit, `specreview apply` and `specreview edit` (in `warn` mode it asks the user instead). Small Writes are allowed.
- **`hook prompt`** (UserPromptSubmit): adds a note to the prompt when a submitted review on a doc in this workspace was not delivered and nothing is waiting for it, or was delivered more than about 5 minutes ago but never acted on. Example: `specreview: review rv2 on token-service (2 threads, CHANGES REQUESTED) was submitted at 14:20 and not delivered. Run specreview feedback token-service and address it per the spec-review skill.` When the current directory has no workspace of its own, the registered workspaces below it are checked and the command names them (`specreview feedback token-service --workspace notes/specs`).
- Both always exit 0 and print nothing on error.

## MCP tools

`specreview mcp` serves these tools over stdio. Each returns the CLI text as `content` and the `--json` shape as `structuredContent`, with `isError: true` on a refusal or conflict. In Claude Code the background CLI `wait` is preferred.

| Tool | Input |
|---|---|
| `specreview_open` | `{path, title?}` -> `{doc, version, url}` |
| `specreview_wait` | `{doc?, timeout_sec?}` (default 50, max 600) -> the packet, `{status:"waiting"}` (call again) or `{status:"closed"}` |
| `specreview_feedback` | `{doc, peek?, include_drafts?}` |
| `specreview_apply` | `{doc, thread_ids}` |
| `specreview_edit` | `{doc, thread_ids, old_string, new_string, replace_all?}` |
| `specreview_reply` | `{doc, thread_id, body, status?, at?, decision?}` |
| `specreview_revise` | `{doc, summary, threads, other?, break_locks?, allow_rewrite?, dry_run?}` |
| `specreview_revert` | `{doc, hunk?, lock?}` |
| `specreview_reanchor` | `{doc, thread_id, lines?, quote?}` |
| `specreview_ask` | `{doc, body, quote? or lines?}` |
| `specreview_threads` | `{doc, status?}` |
| `specreview_diff` | `{doc, from?, to?, format?: "stat" or "unified"}` |
| `specreview_log`, `specreview_status` | `{doc?}` |
| `specreview_show` | `{doc, thread_id?, version?, lines?}` |
| `specreview_final` | `{doc, decisions?, out_dir?}` |

## Writing specs that review well

Reviewers comment on what they see; you receive the source lines behind it. Specs that keep a clean link between the two get precise feedback and small diffs.

**Format.** Use Markdown unless layout or interactivity matters. Use HTML for dashboards, interactive mockups, tabbed or side-by-side layouts, and custom visual design.

**Markdown:**

- GitHub-flavoured Markdown renders fully: tables, task lists, footnotes, `$math$` and `$$math$$`, fenced code with a language, ```` ```mermaid ```` fences, front matter and raw HTML.
- Use unique, stable headings. They define sections for section comments, locks and the `§` paths in packets. Do not rename or renumber headings unless asked.
- Keep paragraphs and lines reasonably short. Diffs and `src>` excerpts work per line, so a 2,000-character line turns every edit into a large hunk. Never re-wrap existing text while editing.
- Avoid repeating the same sentence in several places; unique text gives unique `src>` excerpts.
- Put one table row per line (Markdown requires it) and give tables a header row, so cell comments name the row and column.

**Images and diagrams:**

- Reference local images by relative path (`./img/arch.png`). They are snapshotted with every version, and the reviewer sees a before/after when one changes. Avoid `data:` URIs; they bloat packets and cannot be edited through `src>`.
- Prefer diagrams as text: a mermaid fence (Markdown) or `<pre class="mermaid">` (HTML), or inline `<svg>` with readable `id`s and `<text>` labels. The reviewer can comment on single nodes, and you fix them with a small text edit instead of regenerating an image.
- If an image is generated by a script, mention the script next to the image so feedback on the image can be traced back to it.

**HTML:**

- Keep the reviewable text in static markup. Text built by scripts at runtime (client-side templating, `innerHTML`, data fetched at load) can only be anchored to the nearest static element, so feedback on it arrives as a wide block.
- Make the file self-contained: inline CSS and JS, or local files next to the doc. No CDN scripts, remote fonts or remote images. SpecReview works offline and only versions local files.
- Put mermaid in `<pre class="mermaid">…</pre>`. If the doc does not load mermaid itself, SpecReview injects its own copy.
- Use real `<h1>`-`<h6>` headings with `id`s, real `<table>`s with `<th>` header cells, and `<figure>`/`<figcaption>` for images.
- Pretty-print the file (roughly one element per line). Do not minify it.
- Interactive parts such as tabs and `<details>` are fine: a hidden target is revealed when its thread is focused.
- Do not add a restrictive `Content-Security-Policy` meta tag; it can block the review overlay. Do not put content to be reviewed inside nested iframes or shadow DOM; those are commentable only as whole elements.
