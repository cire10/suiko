# Developing Suiko

Notes for working on Suiko itself. Using it is covered in the [README](../README.md) and the [reviewer guide](user-guide.md).

- Plain Node.js ESM with JSDoc types and `// @ts-check`; no build step. The UI is Preact + htm, loaded from vendored files.
- Layout: `bin/suiko.js` (CLI entry), `src/cli` and `src/mcp` (agent surfaces), `src/core` (store, render, text, diff, anchoring, review operations), `src/daemon` (local server), `src/guest` (script injected into documents), `src/ui` (review UI), `integrations/` (Claude Code plugin and AGENTS.md snippet).
- Tests: `npm test` (unit and integration, `node --test`), `npm run test:guest`, `npm run test:ui` (UI model tests, then Playwright e2e with your system Chrome; `npm run e2e` runs only the Playwright part). Tests use a temporary `SPECREVIEW_HOME` and never the default ports. Screen-snip tests set `SPECREVIEW_SCREENCAPTURE` to a fake capture command, so they never open the real picker.
- Validate the plugin: `claude plugin validate .` and `claude plugin validate ./integrations/claude-code`.
