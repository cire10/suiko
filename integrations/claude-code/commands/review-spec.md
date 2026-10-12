---
description: Open an existing HTML or Markdown spec in Suiko, show the review UI in the browser, and wait in the background for the reviewer's feedback.
argument-hint: <path/to/spec.md|.html>
allowed-tools: Bash(suiko open *) Bash(suiko wait *) Bash(suiko status *)
---

<!-- /review-spec: start a Suiko round for an existing file. The full protocol is in the spec-review skill. -->

Start a Suiko review round for this file: $ARGUMENTS

Follow the spec-review skill. Steps:

1. **Pick the file.** If no path was given above, run `suiko status` to list tracked docs and ask the user which one to open (or suggest a spec you wrote in this session). The file must be `.md`, `.markdown`, `.html` or `.htm`. Do not create or rewrite the file.

2. **Open it.** Run `suiko open "<path>"`. Note the doc id from `tracking … as "<doc>"` and the URL on the `review UI:` line.
   - If it says the doc is already tracked, that is fine: it only prints the URL.
   - If it says `working copy differs from vN (unrecorded)`, the file has changes that are not recorded yet. If you made them while addressing review feedback, record them with `suiko revise <doc> --replies -` per the skill. Otherwise tell the user, and suggest they click **Record as my revision** in the UI. Do not start the wait until the working copy is recorded (it would exit 3).

3. **Show the UI.** By default `open` has already opened it in the user's browser (`next:` says so). Only when `next:` says `open the URL (browser pane)`: if the tool `mcp__Claude_Browser__navigate` exists, call it with `{"url": "<url>"}` (or `mcp__Claude_Browser__preview_start` with `{"url": "<url>"}`); load it first if it is deferred. If neither exists, only a `mcp__remote-devices__…` variant does, or the system browser could not be opened, give the user the URL.

4. **Wait.** Run Bash `suiko wait <doc>` with `run_in_background: true`.

5. **Hand over and end the turn.** Tell the user in one or two lines: the doc is open; comment on any part (select text and press c, press b and drag a box to snip any area, or press e to pick images, diagrams and table cells), then click **Submit review**, or press Cmd+Shift+Enter in a comment to send just that one now; you will pick it up automatically. Do not poll. When the wait exits, handle the packet as the skill describes.
