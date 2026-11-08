<!-- specreview:begin (managed by `suiko install`; edits inside this block are replaced on reinstall) -->
## Suiko reviews

Only when the user asks you to open, review or iterate on a document in Suiko (the `suiko` CLI), or a Suiko feedback packet (`SPECREVIEW FEEDBACK`) arrives. If the document does not exist yet, write it first exactly as you would without Suiko; nothing below applies until `suiko open`.

The user comments on exact parts of the rendered document in a local web UI. You receive located feedback, change what each thread asks for, and record each revision as a version. The file on disk is the source of truth. Every answer or question for the reviewer goes on its thread (`suiko revise` replies, `suiko reply`, `suiko ask`); your chat gets one line per thread.

### Start a review

1. Run `suiko open <file>`. It prints the doc id (`tracking … as "<doc>"`), `review UI: <url>` and a `next:` line. Give the user the URL (it is served on this machine's 127.0.0.1). Below, `<doc>` is the doc as the `next:` line names it. If it also says your Suiko instructions are from an earlier version, pass that line on to the user: it names the command that updates them.
2. Get the feedback in one of two ways:
   - **Wait mode**, if your shell can block for minutes: `suiko wait <doc> --timeout 10m` (below your shell tool's limit). Exit 0 prints the packet; exit 2 means it timed out, so run it again. Exit 3 at once means unrecorded edits, or a thread you received still has no reply (the message names it): reply on it, then wait again.
   - **Done mode**, if your shell times out quickly: ask the user to tell you "done" once they have sent their comments, then run `suiko feedback <doc> --include-drafts`. If it lists only DRAFT comments, ask the user to send them; do not act on drafts.

### Handle the feedback packet

- Line numbers are lines of the file on disk now. Each `src>` line is an exact source line: strip the `  src> ` prefix and join the lines with newlines to get the exact text to replace. `on:` is rendered text, not source.
- Before editing, read the cited ranges, not the whole document, and do not re-read the whole document each round.
- **Change only what each thread asks for.** Edit the file, replacing the `src>` text (with no edit tool: `suiko edit <doc> --thread t1 --old "<src text>" --new "<new text>"`). For a document built from sources (a template, data, a script), change those sources and rebuild it the way it was built, then link the rebuilt lines with `at`. Never rewrite, restyle or reformat parts no thread asked about.
- **suggestion**: `suiko apply <doc> <tid...>`, after your other edits; `apply` rewrites the file, so re-read it before editing again. On a conflict, treat the thread as a normal comment. In a document built from sources, put the suggested text into the sources instead and rebuild: `apply` changes only the built file, the next rebuild would bring the old text back, and `revise` refuses that (`ERR reverted`).
- **question**: answer it in the thread's reply (`answered`); change the document too only if the answer belongs in it (`addressed`). **Disagree**: `declined` with the reason. **Unclear**: `needs_input` with one precise question.
- **Pictures** (`crop:` and `image:` lines): open every listed picture before acting on its thread. For a picture, chart or interactive part, change whatever produces it (markup, data, styles, script, or its source).
- **Show, don't only tell**: when the reviewer asks to see a chart, an image or a mockup, attach a rendered image or a small self-contained HTML file to your reply (`--attach <file>` on `suiko reply`, or `"attachments": ["<file>"]` in the revise JSON) and iterate on it in the thread. A `use:` line asks you to put that attachment into the document at the thread's place.
- **`EDITS: batch`** (or `EDITS: batch for t2, t5 only`: edit the other threads now): answer every batched thread now without editing the document for it; for a change you agree to make, reply with status `planned` and say exactly what you will change (a batched suggestion says `plan it now`). A later `APPLY` packet lists those threads with the reviewer's request and your plan: make every planned change in one pass, then record one version as its `NEXT` line says (`addressed`).
- Never touch `LOCKED` ranges or text behind `DECISIONS`. Never revert changes you did not make. Never use `--force`, `--allow-rewrite` or `--break-lock` unless the user explicitly asks.

### Record the revision

```bash
suiko revise <doc> --replies - <<'JSON'
{"summary": "rv1: what changed",
 "threads": {"t1": {"status": "addressed", "reply": "What I changed."},
             "t2": {"status": "answered", "reply": "The answer.", "attachments": ["/tmp/mockup.png"]},
             "t3": {"status": "addressed", "reply": "Rebuilt the chart from two years of data.", "at": "L48,L913"}},
 "other": [{"at": "L12", "why": "Change no thread asked for, and why"}]}
JSON
```

- One `threads` entry per thread in the packet. `status` is `addressed`, `answered`, `planned`, `declined` or `needs_input`. `at` gives the new-file lines you changed for a thread, and explains every change on them; without it a change is explained only within the thread's paragraph, so name the lines when the change reaches further (a rebuilt table, data blob or chart script). `suiko revise <doc> --dry-run` and `suiko diff <doc> head..live --stat` list the changed lines.
- Explain every change no thread asked for in `other` (`"at": "L12"`, `"L12-14"` or `"del:h6"`); edits you did not make with `"why": "not mine: external edit"`.
- Exit 3 means refused and nothing was recorded: follow the printed `fix:` lines, then revise again. Undo a change no thread asked for where you made it: in a document built from sources, in the sources, then rebuild (`suiko revert <doc> --hunk hN` restores only the built file). `--dry-run` previews.
- Then summarise one line per thread for the user and get the next feedback (step 2).

### Other cases

- An `APPROVED` packet: run `suiko final <doc> --decisions`, report the final version, and stop. If it still lists threads, answer each with `suiko reply <doc> <tid> -m <md> --status answered` (or `declined`) first, without changing the document.
- Piped Markdown (`<command> | suiko open - [--name N]`), a web page (`suiko snapshot <url>`) and other snapshots have no file to edit: follow the packet's `PROTOCOL` and `NEXT` lines (`suiko revise <doc> --source <file> --replies -`; keep any `--workspace <dir>` the printed commands include).
- Code reviews: when the user wants your code changes, or a GitHub PR, reviewed, run `suiko review` (`--uncommitted`, `--staged`, `--base <ref>`, `A..B`, `--commit <sha>`, `--pr <n|url>`). Items cite `path:L..` relative to the repo root; `src>` lines are the exact text to replace and `was>` lines are deleted code. Edit the files, `suiko apply` suggestions, then `suiko revise <doc> --replies -` (`at` and `other` take `path:L..`). Never use `edit` or `revert` on a code review.
- The user mentions a thread ("t4"): `suiko show <doc> t4`. Overview: `suiko status`. Changes: `suiko diff <doc> --stat`.
- Exit codes: 0 ok · 1 error · 2 timeout · 3 refused (guard, dirty working copy, a thread without a reply, conflict, not unique) · 4 not found · 5 session closed · 6 superseded by a newer wait (ignore it).
- Full protocol: `docs/agent-protocol.md` in the Suiko repository.
<!-- specreview:end -->
