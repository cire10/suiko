<!-- specreview:begin (managed by `suiko install agents-md`; edits inside this block are replaced on reinstall) -->
## Spec reviews (Suiko)

Specs, plans, RFCs and design docs written for the user's review go through Suiko (the `suiko` CLI). The user comments on exact parts of the rendered doc in a local web UI. You receive located feedback, make **targeted edits**, and record each revision as a version. The file on disk is the source of truth: never regenerate it.

### Start a review

1. Write the spec once. Use Markdown by default (`docs/specs/<name>.md`); use HTML only when layout or interactivity matters. Keep headings stable, draw diagrams as mermaid or inline SVG, reference images by relative path, and in HTML keep the text in static markup (no CDN, no client-side templating). After step 2, never rewrite the whole file.
2. Run `suiko open <file>`. It prints the doc id (`tracking … as "<doc>"`), `review UI: <url>` and a `next:` line. Give the user the URL; it is served on this machine's 127.0.0.1. Below, `<doc>` is the doc as the `next:` line names it (the id, or the file path when you run from above the workspace root).
3. Get the review in one of two ways:
   - **Wait mode**, if your shell can block for minutes: `suiko wait <doc> --timeout 10m` (pick a timeout below your shell tool's limit). Exit 0 prints the feedback packet. Exit 2 means it timed out: run it again, or switch to done mode.
   - **Done mode**, if your shell times out quickly: ask the user to click **Submit review** in the UI and then tell you "done". Then run `suiko feedback <doc> --include-drafts`. If it lists only DRAFT comments, ask the user to submit them; do not act on drafts.

### Handle the feedback packet

- Line numbers are lines of the file on disk now. Each `src>` line is an exact source line: strip the `  src> ` prefix and join the lines with newlines to get the exact text to replace. `on:` is rendered text, not source.
- Read the spec file (or the cited ranges) before editing.
- **suggestion** threads: `suiko apply <doc> <tid...>`. Do this after your other edits; `apply` rewrites the file, so re-read it before editing again. On a conflict, treat the thread as a normal comment.
- **comment** threads: make the smallest local change, replacing the `src>` text. With no edit tool, use `suiko edit <doc> --thread t1 --old "<src text>" --new "<new text>"`, or a batch: `suiko edit <doc> --stdin` with `[{"threads":["t1"],"old":"...","new":"..."}]`.
- **question**: answer in the reply (`answered`); edit too only if the answer belongs in the spec (`addressed`). **Disagree**: `declined` with the reason. **Unclear**: `needs_input` with one precise question.
- **Pictures** (`crop:` and `image:` lines): open every listed picture before acting on its thread. They are a region the reviewer drew, a snipped area of the doc, a screenshot of their screen, or a pasted image. A snip's `src>` covers every block under the snipped area: edit only what the comment is about. A `GENERAL` screenshot may show something outside the doc (the running app, a terminal); if it is unclear which part of the spec it concerns, use `needs_input`. For diagrams, edit the source (mermaid, inline SVG, or the script that draws it).
- Every packet needs handling, `COMMENT` ones included: the reviewer can send a single comment at once.
- Never touch `LOCKED` ranges or text behind `DECISIONS`. Never make drive-by edits. Never revert changes you did not make. Never use `--force`, `--allow-rewrite` or `--break-lock` unless the user explicitly asks.

### Record the revision

```bash
suiko revise <doc> --replies - <<'JSON'
{"summary": "rv1: what changed",
 "threads": {"t1": {"status": "addressed", "reply": "What I changed."},
             "t2": {"status": "answered", "reply": "The answer."},
             "t3": {"status": "addressed", "reply": "Applied your suggestion.", "at": "L120"}},
 "other": [{"at": "L12", "why": "Change no thread asked for, and why"}]}
JSON
```

- One `threads` entry per thread in the packet. `status` is `addressed`, `answered`, `declined` or `needs_input`. `at` (optional) gives the new-file lines you changed for that thread.
- Explain every change no thread asked for in `other` (`"at": "L12"`, `"L12-14"` or `"del:h6"`). Explain edits you did not make with `"why": "not mine: external edit"`.
- Exit 3 means refused and nothing was recorded: follow the printed `fix:` lines (`suiko revert <doc> --hunk hN`, an `other` entry, or an `at` hint), then revise again. `--dry-run` previews.
- Then summarise one line per thread for the user and get the next review (step 3).

### Text that is not a file

- Piped Markdown: `<command> | suiko open - [--name N]` opens it as a snapshot doc; piping the same `--name` again records a new version. A folder: `suiko open <dir>` opens every spec below it.
- A web page: `suiko snapshot <url>` (add `--allow-private` for a page on localhost you build). To revise it, change the sources that produce the page, then run the `NEXT:` command (`suiko snapshot <url> --allow-private --replies -`, replies JSON on stdin). A public page has nothing to edit: answer each thread with `suiko reply`.
- A snapshot doc has no file, so `apply`, `edit` and `revert` are refused. Write the complete revised text to a temporary file (`suiko show <doc>` prints the current version) and record it with `suiko revise <doc> --source <file> --replies -`. Keep any `--workspace <dir>` the printed commands include.

### Code reviews

- When the user wants your code changes, or a GitHub PR, reviewed: run `suiko review`.
  - The default covers everything on this branch since it left the default branch, uncommitted and untracked files included.
  - Others: `--uncommitted`, `--staged`, `--base <ref>`, `A..B`, `--commit <sha>`, or `--pr <n|url>` (needs `gh`, signed in).
  - Get the review as in step 3.
- Items cite `path:L..`, relative to the repo root the packet prints. Read each cited file before editing it.
  - `src>` lines are unique in their file: they are the exact text to replace.
  - `was>` lines are deleted code: restore it, or answer why.
- Apply suggestions with `suiko apply <doc> <tid>` and edit the files, then record the next round with `suiko revise <doc> --replies -`. `at` and `other` take `path:L..`.
- Never use `edit` or `revert` on a code review.
- `wait` exits 3 while reviewed files have unrecorded edits: revise first.
- For a PR that is not checked out here, run `gh pr checkout <n>` before editing.

### Finish and recover

- An `APPROVED` packet: run `suiko final <doc> --decisions`, report the final version, and stop. If it still lists threads (a reopen or an answer sent with the approval), answer each with `suiko reply <doc> <tid> -m <md> --status answered` (or `declined`) first; do not edit the spec.
- The user mentions a thread ("t4"): `suiko show <doc> t4`. Overview: `suiko status`. Changes: `suiko diff <doc> --stat`.
- Exit codes: 0 ok · 1 error · 2 timeout · 3 refused (guard, dirty working copy, conflict, not unique) · 4 not found · 5 session closed · 6 superseded by a newer wait (ignore it).
- Full protocol: `docs/agent-protocol.md` in the Suiko repository.
<!-- specreview:end -->
