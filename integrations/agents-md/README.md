<!-- How to give non-Claude CLI agents (Codex, Gemini CLI, Cursor, ...) the SpecReview protocol. -->

# SpecReview for other agents

`AGENTS.snippet.md` holds the SpecReview protocol for CLI agents other than Claude Code. It is the same loop as the Claude Code skill, without Claude-specific tools: the agent either runs `specreview wait` in the foreground ("wait mode") or waits for the user to say "done" and runs `specreview feedback` ("done mode").

## Install

From the workspace where your specs live:

```bash
specreview install agents-md          # prints what it would add to AGENTS.md
specreview install agents-md --apply  # appends (or updates) the block in AGENTS.md
```

The snippet is wrapped in `<!-- specreview:begin … -->` / `<!-- specreview:end -->` markers, so running the install again replaces the block instead of duplicating it. You can also paste the file's contents into any instructions file by hand.

## Per agent

| Agent | Instructions file | Notes |
|---|---|---|
| OpenAI Codex CLI | `AGENTS.md` | Read by default. |
| Gemini CLI | `GEMINI.md` by default | Either paste the snippet into `GEMINI.md`, or make Gemini CLI read `AGENTS.md` too: in `.gemini/settings.json` set `{"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}}`. Older Gemini CLI versions use the flat key `"contextFileName"` instead. |
| Other AGENTS.md-aware tools (e.g. Cursor) | `AGENTS.md` | If a tool does not read `AGENTS.md`, paste the snippet into its own rules file. |
| Any MCP client | n/a | Instead of (or as well as) the snippet, register the MCP server: command `specreview`, args `["mcp"]`. Its `specreview_wait` tool waits up to 50 s by default (600 s max) and returns `{"status":"waiting"}` when it should be called again. |

## Choosing a mode

- **Wait mode** suits agents whose shell tool can block for minutes. Pass a `--timeout` shorter than the shell tool's own limit (for example `specreview wait <doc> --timeout 10m`); exit 2 means it timed out and can simply be run again.
- **Done mode** suits agents with short shell timeouts. The reviewer clicks **Submit review**, then tells the agent "done"; the agent runs `specreview feedback <doc> --include-drafts`. If the reviewer forgot to submit, the output says how many draft comments are still unsent.

Either way, the UI shows whether an agent is listening. When none is, the Submit dialog offers a **Copy prompt** button with the exact `specreview feedback <doc>` instruction to paste into the agent's chat.
