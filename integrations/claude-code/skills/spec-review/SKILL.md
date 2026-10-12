---
name: spec-review
description: Iterative, commentable review loop for HTML/Markdown specs, plans, RFCs and design docs (SpecReview). Use when writing a spec or design doc the user will review, when the user asks to review, comment on or iterate on such a doc, when the user mentions specreview or a thread id such as t4, or when a "SPECREVIEW FEEDBACK" packet or a specreview hook message arrives.
---

<!-- SpecReview protocol for Claude Code. Long reference material is in reference.md next to this file. Keep in sync with docs/agent-protocol.md and integrations/agents-md/AGENTS.snippet.md. -->

# SpecReview: the spec review loop

The user reviews the spec in a local web UI and comments on exact parts of it. You receive located feedback, make **targeted edits**, and record each revision as a version. The file on disk is the source of truth. Never regenerate it.

## 1. Write the spec once

- Default to Markdown in the repo, e.g. `docs/specs/<name>.md`. Use `.html` only when layout or interactivity matters.
- Write it so it reviews well: stable headings, mermaid fences or inline SVG for diagrams, local images by relative path, no CDN dependencies, and (in HTML) the text in static markup rather than built by scripts. Details: [reference.md](reference.md#writing-specs-that-review-well).
- This first Write is the only whole-file write. After `specreview open`, never use Write on the doc again.

## 2. Open it and hand over

```bash
specreview open docs/specs/<name>.md
```

It prints the doc id (`tracking … as "<doc>"`) and a `review UI: <url>` line. Below, `<doc>` is that id or the file path.

1. **Show the UI** as the `next:` line says:
   - `the URL was opened in the system browser`: it is already open in the user's browser. Do nothing more.
   - `open the URL (browser pane)` (the user set `SPECREVIEW_BROWSER=pane`): if the tool `mcp__Claude_Browser__navigate` exists, call it with `{"url": "<url>"}`; it opens the browser pane if needed. `mcp__Claude_Browser__preview_start` with `{"url": "<url>"}` works too. If the tool is listed as deferred, load it first. If neither exists, or only a `mcp__remote-devices__…` variant does (that browser runs on another machine and cannot reach this one's 127.0.0.1), give the user the URL.
   - Anything else (the browser could not be opened, or `none`): give the user the URL.
2. **Wait in the background:** run Bash `specreview wait <doc>` with `run_in_background: true`, naming the doc exactly as the `next:` line of `open` prints it (it uses the file path when you run from above the workspace root, e.g. a project without git whose `.specreview/` sits next to the spec).
3. Tell the user: "v1 is open. Comment on anything (select text and press c, or press b and drag a box to snip any area), then click **Submit review**. I'll pick it up automatically." Then **end the turn**. Do not poll, sleep or loop on `status`: you are re-invoked when `wait` exits.

## 3. When `wait` exits

| Exit | Meaning | Do |
|---|---|---|
| 0 | A packet was printed (any verdict) | Handle it (section 4), or finish (section 7) if it says APPROVED. A `COMMENT` packet with one thread is a comment the user sent at once (**Send now**): handle it the same way |
| 2 | The `--timeout` you passed expired | Start the wait again only if a review is still expected |
| 3 | The working copy differs from the head version | Unrecorded edits. If yours, record them with `revise` (section 5); if not, ask the user (the UI has **Record as my revision**). Then wait again |
| 5 | The reviewer closed the session | Stop waiting and tell the user |
| 6 | Superseded by a newer `wait` | Ignore it and end the turn quietly |
| 1, 4 | Error, or doc not found | Read the message and fix the command |

## 4. Handle a packet

```text
[t1] blocking · comment · L42-43 · §3 Tokens > 3.2 Token refresh
  on: "rotated on every use"
  src> Refresh tokens are rotated on every use, and the previous token is
  src> invalidated immediately.
  Eric: Rotation on every use breaks multi-tab sessions. Use a 30 s grace window.
```

- Line numbers are lines of the file on disk **now**. The `src>` lines, with the `  src> ` prefix removed and joined by newlines, are an exact Edit `old_string`. `on:` is rendered text: never use it as `old_string`.
- Labels: `REOPENED` (the reviewer rejected your fix), `REPLY` (the reviewer answered your reply), `ANSWER` (the answer to your `needs_input` question). Read `LOCKED` and `DECISIONS` at the end of the packet before editing.

1. **Read the spec file** (or at least the cited ranges) before any edit.
2. Per thread:
   - **suggestion** (`apply verbatim: specreview apply <doc> tN`): do not retype it; apply it in step 3.
   - **comment**: Edit with `old_string` = the `src>` text. Make the smallest local change that resolves it. Keep the formatting; do not re-wrap paragraphs.
   - **question**: answer in the reply (`answered`). Also edit only if the answer belongs in the spec (`addressed`).
   - **disagree**: `declined` with the reason. **Unclear**: `needs_input` with one precise question.
   - **`image:` and `crop:` lines** are pictures the user attached: a snipped area of the doc, a screenshot of their screen, a pasted image, or a region crop. **Read every one with the Read tool before acting on that thread.** A snip's `src>` covers all blocks under the snipped area: edit only what the comment is about. A `GENERAL` screenshot may show something outside the doc (the running app, a terminal); if you cannot tell which part of the spec it concerns, use `needs_input`.
   - **image or diagram**: edit the diagram's source (mermaid fence, inline SVG, or the script that generates the image).
   - A `src>` shortened with `...(N more lines)`, or one with an elided `data:` URI, is not a usable `old_string`: Read those lines from the file.
3. **Order:** do all Edit-tool edits first, then `specreview apply <doc> t3 t5` for the suggestions. `apply` rewrites the file, so re-Read it before any later Edit. If Edit says the file changed since it was read, re-Read and retry. If `apply` reports a conflict, treat that thread as a normal comment.
4. **Never:**
   - Write the whole doc, regenerate it, or reformat it.
   - Touch `LOCKED` ranges or text behind `DECISIONS`. If a thread asks you to change locked text, reply `needs_input` and ask the reviewer to unlock it.
   - Make drive-by edits. Explain every necessary change that no thread asked for in `other`.
   - Revert hunks you did not make: the reviewer or another tool may have edited the file. Explain them in `other` with `"why": "not mine: external edit"`.
   - Use `--force`, `--allow-rewrite` or `--break-lock` unless the user explicitly asks for it in chat.

## 5. Record the revision

```bash
specreview revise <doc> --replies - <<'JSON'
{"summary": "rv1: grace window, retry policy, figure caption",
 "threads": {
  "t1": {"status": "addressed", "reply": "Replaced rotate-every-use with a 30 s reuse-detection grace window."},
  "t2": {"status": "addressed", "reply": "The gateway sits in front of auth; fixed the caption.", "at": "L90-91"},
  "t3": {"status": "addressed", "reply": "Applied your suggestion."},
  "t4": {"status": "needs_input", "reply": "Split the TTL by role: admin 12h or 24h?"}},
 "other": [{"at": "L12", "why": "Bumped the 'Last revised' date"}]}
JSON
```

- One `threads` entry for every thread in the packet. `status`: `addressed` (you changed the spec), `answered` (reply only), `declined`, or `needs_input`.
- `at` (optional): the lines of the new file you changed for that thread, e.g. `"L90-91"` or `"L12,L90-91"`. Add it when the change is away from the anchored text.
- `other[].at`: `"L12"` or `"L12-14"` (lines of the new file), or `"del:h6"` / `"h6"` (a hunk id from a refusal).
- `--dry-run` previews the report. **Exit 3 means refused and nothing was recorded.** Read each `ERR` line and run its printed `fix:`: `specreview revert <doc> --hunk hN` for your own accidental change, an `other` entry, or an `at` hint. Then run `revise` again.
- To answer without editing the spec: `specreview reply <doc> tN -m "..." --status answered`.

## 6. Report and wait again

Give one line per thread in chat: what you changed, or what you asked. Then start `specreview wait <doc>` in the background again and end the turn.

## 7. Approval, recovery and other requests

- **APPROVED** packet: run `specreview final <doc> --decisions`, report the final version and the decisions file, and stop waiting. If the packet still lists threads (the reviewer reopened or answered one in the same submission), answer each with `specreview reply <doc> <tid> -m <md> --status answered` (or `declined`) first and do not edit the spec: a new version would no longer match the final one. The status matters: a reply without one leaves the thread open.
- The user says "done" or "submitted" but no packet arrived: run `specreview feedback <doc> --include-drafts`. If it only lists DRAFT comments, ask the user to click **Submit review**; do not act on drafts.
- A hook message says a review was not delivered or not handled: run `specreview feedback <doc>` and handle it as in section 4.
- The user mentions a thread ("t4"): `specreview show <doc> t4`.
- You need the reviewer's decision before editing: `specreview ask <doc> --quote "exact text" -m "question"`.
- A thread is anchored on the wrong text: `specreview reanchor <doc> tN --lines A-B`.
- The user explicitly asks for a full rewrite: change the file with Edit (never Write), then `specreview revise <doc> --allow-rewrite --replies -`.

## 8. Plans, your last message and piped text

These docs are **snapshots**, not files: a Claude Code plan (the plan gate), your last message (`/specreview-last`) or text piped to `specreview open -`. The packet header names the kind, e.g. `plan-cache (Claude Code plan)`.

- **Plan gate.** With the plan-mode hook installed, ExitPlanMode opens your plan in SpecReview and waits for the review. Approved: carry on. Otherwise ExitPlanMode is denied with feedback that cites the plan file and its line numbers. Make targeted Edit-tool changes to that plan file (never rewrite it), address every thread, then call ExitPlanMode again. The reviewer sees a diff.
- **Web pages** (`specreview snapshot <url>`, which uses the network) are snapshots too. For a page you build (`--allow-private`), change the sources that produce it as the threads ask, then run the `NEXT:` command, `specreview snapshot <url> --allow-private --replies -`, with the replies JSON on stdin: it records the next version and posts the replies in one step. A public page has nothing for you to edit: answer each thread with `specreview reply`.
- **Other snapshots** have no file to edit, so `apply`, `edit` and `revert` are refused. Write your complete revised text to a temporary file outside the project (`specreview show <doc>` prints the current version), address every thread in it, then record it with `specreview revise <doc> --source <file> --replies -` (replies JSON on stdin, as in section 5). If the `next:` line includes `--workspace <dir>`, keep that flag on every command for the doc.

## 9. Code review

When the user wants your code changes reviewed, or a GitHub PR, open a **code review** instead of a spec: `specreview review` (the user's `/review-code` runs it). By default it covers everything on this branch since it left the default branch, uncommitted and untracked files included. To review something else:
- `--uncommitted`;
- `--staged`;
- `--base <ref> [--committed]`;
- `A..B` or `A...B`;
- `--commit <sha>`;
- `--pr <n|url>`.

`--path <pathspec>` narrows any of these. Then start the printed `specreview wait <doc>` in the background and end the turn, as in section 2.

A code packet differs from a spec packet:
- **Paths.** The `Repo root` is printed at the top, and every item cites `path:L42-44` relative to it. Read the file, or the cited range, before you edit it.
- **`src>` lines** are the file's current lines, grown until they are unique in that file: use them as the exact Edit `old_string`. If the packet says they are not unique, Read around the cited line first.
- **Old-side items** (comments on deleted lines) print `was>` lines and where they would go now (`now between L39-40`). Restore the code, or reply `answered` or `declined` with the reason.
- **Suggestions:** `specreview apply <doc> t2` writes them into the real files. Re-Read a file after `apply` before you Edit it again.
- **`FILE MISSING`:** the file is gone from your working tree. Restore it, or reply explaining the deletion.

Record the round with `specreview revise <doc> --replies -`, with the same JSON as section 5; it records your working tree as the next round.
- In replies, `"at"` takes `path:L..`, e.g. `"src/auth/refresh.js:L41-49"`.
- `"other"` items explain changes no thread asked for, with `path` or `path:L..` as their `"at"`.
- Never run `edit` or `revert` on a code review: they are refused. Change the files with the Edit tool.
- `wait` exits 3 while the reviewed files have edits you have not recorded: run `revise` first.
- The packet's `NEXT:` line says what to run.

**PR reviews** (`--pr <n>`): when the PR is not checked out here, line numbers are the PR head's and the packet says so. Run `gh pr checkout <n>` before you edit anything. Running `specreview review --pr <n>` again picks up new commits on the PR.

## Cheat-sheet

| Command | Use |
|---|---|
| `specreview open <file>` | Track the doc, record v1, print the UI URL |
| `specreview wait <doc>` | Block until a review arrives (run it in the background) |
| `specreview feedback <doc> [--include-drafts] [--peek]` | The same packet, without blocking |
| `specreview apply <doc> <tid...> [--dry-run]` | Apply suggestions verbatim |
| `specreview edit <doc> --thread t1 --old <s> --new <s>` | Thread-tagged exact replace (`--stdin` takes a JSON batch) |
| `specreview revise <doc> --replies -` | Record a version with replies (`--dry-run` previews) |
| `specreview reply <doc> <tid> -m <md> --status answered` | Reply without recording a version |
| `specreview revert <doc> --hunk hN` | Undo one unrecorded hunk (`--lock L1` restores locked text) |
| `specreview threads <doc>` / `specreview show <doc> <tid>` | List threads / one full thread |
| `specreview diff <doc> --stat` / `specreview log <doc>` / `specreview status` | What changed / timeline / overview |
| `specreview final <doc> --decisions` | Check the final version and export the decision log |
| `specreview last` / `specreview open - [--name N]` | Review your last message / piped Markdown (snapshot docs) |
| `specreview snapshot <url> [--allow-private]` | Review a web page (snapshot doc); again records the next version |
| `specreview revise <doc> --source <file> --replies -` | Record a new version of a snapshot doc |
| `specreview review [--uncommitted \| --staged \| --base <ref> \| A..B \| --commit <sha> \| --pr <n>]` | Open a code review of your changes, or of a PR; again records the next round |
| `specreview diff <doc> v1..v2` / `specreview show <doc> --file <path>` | Code reviews: what changed between rounds / one file of a round |

Exit codes: 0 ok · 1 error · 2 timeout · 3 refused (guard, dirty working copy, conflict, not unique) · 4 not found · 5 closed · 6 superseded.

The full packet format, revise JSON, guards, hooks and MCP tools are in [reference.md](reference.md).
