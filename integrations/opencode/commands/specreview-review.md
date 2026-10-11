---
description: Open an HTML or Markdown spec in SpecReview, wait for the reviewer's feedback and address it
---

<!-- /specreview-review (OpenCode command): installed by `specreview install` from integrations/opencode/commands/specreview-review.md; `specreview uninstall` removes it. -->

Start a SpecReview review round for this file: $ARGUMENTS

Follow the "Spec reviews (SpecReview)" protocol in your AGENTS.md. Steps:

1. **Pick the file.** If no path was given above, run `specreview status` to list the tracked docs and ask the user which one to open (or suggest a spec you wrote in this session). The file must be `.md`, `.markdown`, `.html` or `.htm`. Do not create or rewrite it.
2. **Open it.** Run `specreview open "<path>"`. Note the doc id from `tracking … as "<doc>"` and give the user the URL on the `review UI:` line.
3. **Get the review.** If your shell can block for minutes, run `specreview wait <doc> --timeout 10m` (pick a timeout below your shell tool's limit; exit 2 means it timed out, so run it again). If the `specreview_wait` MCP tool is available, you can call it instead (it returns `{"status":"waiting"}` when it should be called again). Otherwise ask the user to click **Submit review** in the UI and tell you "done", then run `specreview feedback <doc> --include-drafts`.
4. **Handle the packet** as the protocol says: targeted edits only, then `specreview revise <doc> --replies -` with one entry per thread. Summarise one line per thread for the user and get the next review, until the reviewer approves.
