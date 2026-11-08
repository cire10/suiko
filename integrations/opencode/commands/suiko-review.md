---
description: Open an HTML or Markdown document in Suiko, wait for the reviewer's feedback and address it
---

<!-- /suiko-review (OpenCode command): installed by `suiko install` from integrations/opencode/commands/suiko-review.md; `suiko uninstall` removes it. -->

Start a Suiko review round for this file: $ARGUMENTS

Follow the "Suiko reviews" protocol in your AGENTS.md. Steps:

1. **Pick the file.** If no path was given above, run `suiko status` to list the tracked documents and ask the user which one to open (or suggest a document you wrote in this session). The file must be `.html`, `.htm`, `.md` or `.markdown`. Do not create or rewrite it.
2. **Open it.** Run `suiko open "<path>"`. Note the doc id from `tracking … as "<doc>"` and give the user the URL on the `review UI:` line: they comment by selecting text and pressing c, or with the tools at the bottom of the document (Comment, Element, Area).
3. **Get the feedback.** If your shell can block for minutes, run `suiko wait <doc> --timeout 10m` (pick a timeout below your shell tool's limit; exit 2 means it timed out, so run it again). If the `suiko_wait` MCP tool is available, you can call it instead (it returns `{"status":"waiting"}` when it should be called again). Otherwise ask the user to tell you "done" once they have sent their comments, then run `suiko feedback <doc> --include-drafts`.
4. **Handle the packet** as the protocol says: change only what the threads ask for (the file, or the sources it is built from and a rebuild), then `suiko revise <doc> --replies -` with one entry per thread: every answer goes in its thread's reply, where the reviewer reads it in Suiko. Summarise one line per thread for the user and get the next feedback, until the reviewer approves.
