---
name: specreview-review
description: Review loop for specs, plans, RFCs and design docs (Markdown or HTML) with SpecReview, the specreview CLI. Use it when the user asks to review, open or iterate on such a doc in SpecReview, when you write one for the user's review, or when SpecReview feedback (a feedback packet) arrives.
---

<!-- Agent-neutral SpecReview skill, installed by `specreview install` into ~/.agents/skills/ (read by Codex, Cursor, Gemini CLI, OpenCode, Copilot CLI, Amp and Factory Droid) and ~/.kiro/skills/. `specreview uninstall` removes it. The installer replaces the specreview:protocol line below with the protocol from integrations/agents-md/AGENTS.snippet.md. -->

# SpecReview

The user reviews the doc in a local web UI and comments on exact parts of it. You get located feedback, make targeted edits and record each revision as a version.

**When the user names a file to review**, start a round for it now:

1. The file must be `.md`, `.markdown`, `.html` or `.htm`. If no file was named, run `specreview status` to list the tracked docs and ask which one to open (or offer a spec you wrote in this session). Do not create or rewrite the file.
2. Run `specreview open "<path>"`, give the user the URL, and continue with step 3 of "Start a review" below.

If the `specreview_*` MCP tools are available, they do the same as the commands below; `specreview_wait` waits in chunks of up to 50 seconds by default and returns `{"status":"waiting"}` when it should be called again.

<!-- specreview:protocol -->
