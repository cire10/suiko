---
name: suiko-review
description: Suiko review loop (the suiko CLI) for a document that already exists (an .html or .md file): open it in Suiko, get the reviewer's located feedback, change what the threads ask for and answer on them. Use when the user asks to open, review or iterate on a document in Suiko or mentions suiko, or when Suiko feedback (a SPECREVIEW FEEDBACK packet) arrives.
---

<!-- Agent-neutral Suiko skill, installed by `suiko install` into ~/.agents/skills/ (read by Codex, Cursor, Gemini CLI, OpenCode, Copilot CLI, Amp and Factory Droid) and ~/.kiro/skills/. `suiko uninstall` removes it. The installer replaces the specreview:protocol line below with the protocol from integrations/agents-md/AGENTS.snippet.md. -->

# Suiko

**When the user names a file to review**, start a round for it now:

1. The file must be `.html`, `.htm`, `.md` or `.markdown`. If no file was named, run `suiko status` to list the tracked documents and ask which one to open (or offer a document you wrote in this session). Do not create or rewrite the file for Suiko.
2. Run `suiko open "<path>"`, give the user the URL, and continue with step 2 of "Start a review" below.

If the `suiko_*` MCP tools are available, they do the same as the commands below; `suiko_wait` waits in chunks of up to 50 seconds by default and returns `{"status":"waiting"}` when it should be called again.

<!-- specreview:protocol -->
