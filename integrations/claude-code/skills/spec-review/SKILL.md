---
name: spec-review
description: Suiko review loop for a document that already exists (an .html or .md file you or the user wrote): open it in Suiko, wait for the reviewer's located feedback, change what the threads ask for and answer on them. Use when the user asks to open, review, comment on or iterate on a document in Suiko or mentions suiko, mentions a Suiko thread id such as t4, or when a "SPECREVIEW FEEDBACK" packet or a suiko hook message arrives.
---

<!-- Suiko protocol for Claude Code. Long reference material is in reference.md next to this file. Keep in sync with docs/agent-protocol.md and integrations/agents-md/AGENTS.snippet.md. -->

# Suiko: the review loop

If the document does not exist yet, write it first exactly as you would without Suiko, with whatever HTML, CSS, JavaScript, libraries, data files or build scripts the best document needs; nothing below applies until you run `suiko open`.

The reviewer reads the document in a local web UI and comments on exact parts of it. You get located feedback, change what each thread asks for, and record each round as a version. The file on disk is the source of truth.

**The conversation lives in Suiko.** Every answer, explanation or question for the reviewer goes on its thread (the replies of `suiko revise`, `suiko reply`, `suiko ask`), where the reviewer reads it next to the document. Your chat only gets a one-line summary per thread.

## 1. Open it and hand over

```bash
suiko open <file>          # e.g. suiko open reports/funding-study.html
```

It prints the doc id (`tracking … as "<doc>"`, here `"funding-study"`) and a `review UI: <url>` line. Below, `<doc>` is that id or the file path.

1. **Show the UI** as the `next:` line says:
   - `the URL was opened in the system browser`: it is already open in the user's browser. Do nothing more.
   - `open the URL (browser pane)` (the user set `SPECREVIEW_BROWSER=pane`): if the tool `mcp__Claude_Browser__navigate` exists, call it with `{"url": "<url>"}`; it opens the browser pane if needed. `mcp__Claude_Browser__preview_start` with `{"url": "<url>"}` works too. If the tool is listed as deferred, load it first. If neither exists, or only a `mcp__remote-devices__…` variant does (that browser runs on another machine and cannot reach this one's 127.0.0.1), give the user the URL.
   - Anything else (the browser could not be opened, or `none`): give the user the URL.
2. **Wait in the background:** run Bash `suiko wait <doc>` with `run_in_background: true`, naming the doc exactly as the `next:` line of `open` prints it.
3. Tell the user: "v1 is open. Comment on anything: select text and press c, or use the tools at the bottom of the document (Comment, Element, Area). I'll pick it up automatically." Then **end the turn**. Do not poll, sleep or loop on `status`: you are re-invoked when `wait` exits.

If `open` prints a line saying your Suiko skill or instructions are from an earlier version, pass it on to the user as printed: it names the command that updates them.

## 2. When `wait` exits

| Exit | Meaning | Do |
|---|---|---|
| 0 | A packet was printed (any verdict) | Handle it (section 3), or finish (section 6) if it says APPROVED. A packet with one thread is a comment the reviewer sent at once: handle it the same way |
| 2 | The `--timeout` you passed expired | Start the wait again only if a review is still expected |
| 3 | The working copy differs from the head version, or a thread you received has no reply yet | Unrecorded edits: if yours, record them with `revise` (section 4); if not, ask the user (the UI has **Record as my revision**). A thread without a reply (the message names it): reply on it (a batched thread: `planned`, with exactly what you will change). Then wait again |
| 5 | The reviewer closed the session | Stop waiting and tell the user |
| 6 | Superseded by a newer `wait` | Ignore it and end the turn quietly |
| 1, 4 | Error, or doc not found | Read the message and fix the command |

## 3. Handle a packet

```text
[t1] blocking · comment · L212 · §3 Findings > 3.2 Funding stress
  on: "spreads widened on 12 days"
  src>     <p>Funding spreads widened on 12 days, all of them after the March rate decision.</p>
  Eric: Count the days over the full two-year window, and say which threshold you used.
```

- Line numbers are lines of the file on disk **now**. The `src>` lines, with the `  src> ` prefix removed and joined by newlines, are an exact Edit `old_string`. `on:` is rendered text: never use it as `old_string`.
- Labels: `REOPENED` (the reviewer rejected your change), `REPLY` (the reviewer answered your reply), `ANSWER` (the answer to your `needs_input` question), `APPLY` (section 3.1). Read `LOCKED` and `DECISIONS` at the end of the packet before editing.
- **Before editing, Read the cited ranges** (Read with `offset`/`limit` around the `L` numbers), not the whole document, and do not re-read the whole document each round.

Per thread, **change only what it asks for**:
- **comment**: in the document itself, Edit with `old_string` = the `src>` text and keep the surrounding formatting. In a document built from sources (a template, data, a script), change those sources and rebuild it the way it was built; then link the rebuilt lines with `at` (section 4).
- **suggestion** (`apply verbatim: suiko apply <doc> tN`): do not retype it; run `apply` after your other edits. In a document built from sources, `apply` would change only the built file and the next rebuild would bring the old text back (`revise` refuses that as `ERR reverted`): put the suggested text into the sources instead, rebuild, and reply `addressed`.
- **question**: answer it in the thread's reply (`answered`); also change the document only if the answer belongs in it (`addressed`).
- **disagree**: `declined` with the reason. **Unclear**: `needs_input` with one precise question.
- **`image:` and `crop:` lines** are pictures the reviewer attached (a snipped area, a screenshot of their screen, a pasted image, a region crop). **Read every one before acting on its thread.** A snip's `src>` covers every block under the snipped area: change only what the comment is about. A screenshot may show something outside the document; if you cannot tell which part it concerns, use `needs_input`.
- **a picture, chart, diagram or interactive part**: change whatever produces it (its markup, data, styles, script, or the source it is built from).
- **asks to see a chart, an image or a mockup** (or showing beats telling): render it (an image, or a small self-contained HTML file) and attach it to your reply, with `--attach <file>` on `suiko reply` or `"attachments"` in the revise JSON. Iterate on it in the thread; it goes into the document when the reviewer says so.
- **`use:` line** (the reviewer chose **Use in doc** for your attachment): put that file into the document at the thread's place, the way the document holds such things (copy it next to the document and reference it, or inline it), then reply `addressed`.
- A `src>` shortened with `...(N more lines)`, or with an elided `data:` URI, is not a usable `old_string`: Read those lines first.

**Order:** do all Edit-tool edits first, then `suiko apply <doc> t3 t5` for the suggestions in a file you edit directly (`apply` rewrites the file, so re-Read before any later Edit). If Edit says the file changed since it was read, re-Read and retry. If `apply` reports a conflict, treat that thread as a normal comment.

**Summary only:** a packet with a `Reviewer summary:` and no thread to act on (`NEXT: act on the reviewer summary …`) is a request too: change what the summary asks for, then record it as `NEXT` says: `suiko revise <doc> --replies -` with the version `summary` and an `other` entry (`at`, `why`) for each change, since no thread explains it.

**Never:**
- Rewrite, restyle or reformat parts no thread asked about. (A rebuild that changes only what the threads asked for is fine.)
- Touch `LOCKED` text or text behind `DECISIONS`. If a thread asks you to change locked text, reply `needs_input` and ask the reviewer to unlock it.
- Revert changes you did not make: the reviewer or another tool may have edited the file. Explain them in `other` with `"why": "not mine: external edit"`.
- Use `--force`, `--allow-rewrite` or `--break-lock` unless the user explicitly asks for it in chat.

### 3.1 Batched edits: `EDITS: batch`, `planned` and `APPLY`

On a long document the reviewer may batch the edits. The packet then says `EDITS: batch` (or `EDITS: batch for t2, t5 only`: handle the other threads as usual): answer every batched thread now, but do not edit the document for it yet. For a change you agree to make, reply with status `planned` and say exactly what you will change (a batched suggestion says `plan it now`); questions get `answered`. Post the replies with one `suiko revise <doc> --replies -` (with no edits it records nothing and only posts them). Later an `APPLY` packet lists the planned threads, each with the reviewer's request and your plan: make every planned change in one pass, then record **one** version as its `NEXT` line says (status `addressed` for each).

## 4. Record the revision

```bash
suiko revise <doc> --replies - <<'JSON'
{"summary": "rv1: two-year window, threshold, volume mockup",
 "threads": {
  "t1": {"status": "addressed", "reply": "Counted over two years (31 days) with a 50 bp threshold; both are stated now."},
  "t2": {"status": "addressed", "reply": "Rebuilt the chart from two years of data.", "at": "L48,L913"},
  "t3": {"status": "answered", "reply": "Here is volume under the price chart. Use it if it reads well.", "attachments": ["/tmp/volume-mockup.html"]},
  "t4": {"status": "needs_input", "reply": "Show the 2024 outlier or drop it?"}},
 "other": [{"at": "L12", "why": "Bumped the 'Last revised' date"}]}
JSON
```

- One `threads` entry for every thread in the packet. `status`: `addressed` (you changed the document), `answered` (reply only), `planned` (batched edits, section 3.1), `declined`, or `needs_input`.
- `at`: the lines of the new file you changed for that thread, e.g. `"L90-91"` or `"L12,L90-91"`. It explains every change on the lines it names. Without it, a change is linked to a thread only where it overlaps the thread's text, and that explains the thread's paragraph (for a heading, its section) and nothing beyond it: name the lines whenever the change reaches further, e.g. a rebuilt table, data blob or chart script. `suiko revise <doc> --dry-run` and `suiko diff <doc> head..live --stat` list the changed lines.
- `attachments`: files to show on your reply (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`, `.html`; at most 6, 5 MB each). Suiko keeps a copy.
- `other[].at`: `"L12"` or `"L12-14"` (lines of the new file), or `"del:h6"` / `"h6"` (a hunk id from a refusal).
- `--dry-run` previews the report. **Exit 3 means refused and nothing was recorded.** Read each `ERR` line and follow its `fix:`, then run `revise` again. Undo a change no thread asked for where you made it: in a document built from sources, in the sources, then rebuild (`suiko revert <doc> --hunk hN` restores only the built file, and the next rebuild brings the change back); `revert` is for a file you edited directly.
- To answer without changing the document: `suiko reply <doc> tN -m "..." --status answered` (add `--attach <file>` to show a picture or mockup).

## 5. Report and wait again

In chat, give one line per thread (what you changed, answered or asked); the full replies are on the threads. Then start `suiko wait <doc>` in the background again and end the turn. `wait` exits 3 while a thread you received has no reply: reply on it, then wait again.

## 6. Approval, recovery and other requests

- **APPROVED** packet: run `suiko final <doc> --decisions`, report the final version and the decisions file, and stop waiting. If the packet still lists threads (the reviewer reopened or answered one in the same submission), answer each with `suiko reply <doc> <tid> -m <md> --status answered` (or `declined`) first and do not change the document: a new version would no longer match the final one.
- The user says "done" or "sent" but no packet arrived: run `suiko feedback <doc> --include-drafts`. If it only lists DRAFT comments, ask the user to send them; do not act on drafts.
- A hook message says a review was not delivered or not handled: run `suiko feedback <doc>` and handle it as in section 3.
- The user mentions a thread ("t4"): `suiko show <doc> t4`.
- You need the reviewer's decision before changing something: `suiko ask <doc> --quote "exact text" -m "question"`.
- A thread is anchored on the wrong text: `suiko reanchor <doc> tN --lines A-B`.
- The user explicitly asks for a full rewrite: make it the way you produced the document (a Write of most of the file first asks the user to allow it, and if it is denied, follow the reason it gives; or change its sources and rebuild), then record it with `suiko revise <doc> --allow-rewrite --replies -`.

## 7. Plans, your last message and piped text

These are **snapshots**, not files: a Claude Code plan (the plan gate), your last message (`/suiko-last`) or text piped to `suiko open -`. The packet header names the kind, e.g. `plan-cache (Claude Code plan)`.

- **Plan gate.** With the plan-mode hook installed, ExitPlanMode opens your plan in Suiko and waits for the review. Approved: carry on. Otherwise ExitPlanMode is denied with feedback that cites the plan file and its line numbers: change what the threads ask for in that plan file with the Edit tool, then call ExitPlanMode again. The reviewer sees a diff.
- **Web pages** (`suiko snapshot <url>`) are snapshots too. For a page you build (`--allow-private`), change the sources that produce it as the threads ask, then run the `NEXT:` command, `suiko snapshot <url> --allow-private --replies -`, with the replies JSON on stdin. A public page has nothing for you to edit: answer each thread with `suiko reply`.
- **Other snapshots** have no file to edit, so `apply`, `edit` and `revert` are refused. Write your complete revised text to a temporary file outside the project (`suiko show <doc>` prints the current version), address every thread in it, then record it with `suiko revise <doc> --source <file> --replies -`. If the `next:` line includes `--workspace <dir>`, keep that flag on every command for the doc.

## 8. Code review

When the user wants your code changes reviewed, or a GitHub PR, open a **code review**: `suiko review` (the user's `/review-code` runs it). By default it covers everything on this branch since it left the default branch, uncommitted and untracked files included. Others: `--uncommitted`, `--staged`, `--base <ref> [--committed]`, `A..B` or `A...B`, `--commit <sha>`, `--pr <n|url>`; `--path <pathspec>` narrows any of them. Then start the printed `suiko wait <doc>` in the background and end the turn, as in section 1.

A code packet differs:
- **Paths.** The `Repo root` is printed at the top, and every item cites `path:L42-44` relative to it. Read the cited range before you edit it.
- **`src>` lines** are the file's current lines, grown until they are unique in that file: use them as the exact Edit `old_string`. If the packet says they are not unique, Read around the cited line first.
- **Old-side items** (comments on deleted lines) print `was>` lines and where they would go now (`now between L39-40`). Restore the code, or reply `answered` or `declined` with the reason.
- **Suggestions:** `suiko apply <doc> t2` writes them into the real files. Re-Read a file after `apply` before you Edit it again.
- **`FILE MISSING`:** the file is gone from your working tree. Restore it, or reply explaining the deletion.

Record the round with `suiko revise <doc> --replies -` (the same JSON as section 4; `at` takes `path:L..`, e.g. `"src/auth/refresh.js:L41-49"`, and so does `other[].at`). Never run `edit` or `revert` on a code review. `wait` exits 3 while the reviewed files have edits you have not recorded: run `revise` first. **PR reviews** (`--pr <n>`): when the PR is not checked out here, run `gh pr checkout <n>` before you edit anything; running `suiko review --pr <n>` again picks up new commits.

## Cheat-sheet

| Command | Use |
|---|---|
| `suiko open <file>` | Track the document, record v1, print the UI URL |
| `suiko wait <doc>` | Block until feedback arrives (run it in the background) |
| `suiko feedback <doc> [--include-drafts] [--peek]` | The same packet, without blocking |
| `suiko apply <doc> <tid...> [--dry-run]` | Apply suggestions verbatim (a built document: put the text into its sources instead) |
| `suiko edit <doc> --thread t1 --old <s> --new <s>` | Thread-tagged exact replace (`--stdin` takes a JSON batch) |
| `suiko revise <doc> --replies -` | Record a version with replies (`--dry-run` previews) |
| `suiko reply <doc> <tid> -m <md> --status answered [--attach <file>]` | Reply without recording a version |
| `suiko revert <doc> --hunk hN` | Undo one unrecorded hunk in the file itself (`--lock L1` restores locked text); a built document: undo it in its sources and rebuild |
| `suiko threads <doc>` / `suiko show <doc> <tid>` | List threads / one full thread |
| `suiko diff <doc> head..live --stat` | Your unrecorded changes, with their lines (for `at`) |
| `suiko diff <doc> --stat` / `suiko log <doc>` / `suiko status` | What changed since the last review / timeline / overview |
| `suiko final <doc> --decisions` | Check the final version and export the decision log |
| `suiko last` / `suiko open - [--name N]` | Review your last message / piped Markdown (snapshots) |
| `suiko snapshot <url> [--allow-private]` | Review a web page (snapshot); again records the next version |
| `suiko review [--uncommitted \| --staged \| --base <ref> \| A..B \| --commit <sha> \| --pr <n>]` | Open a code review; again records the next round |

Exit codes: 0 ok · 1 error · 2 timeout · 3 refused (guard, dirty working copy, a thread without a reply, conflict, not unique) · 4 not found · 5 closed · 6 superseded.

The full packet format, revise JSON, guards, hooks and MCP tools are in [reference.md](reference.md).
