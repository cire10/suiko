---
description: Open a code review of your changes (or of a GitHub PR) in Suiko, show it in the browser, and wait in the background for the reviewer's feedback.
argument-hint: "[--uncommitted | --staged | --base <ref> | A..B | --commit <sha> | --pr <n|url>] [--path <pathspec>]"
allowed-tools: Bash(suiko *)
disable-model-invocation: true
---

<!-- /review-code: start a Suiko code review. The protocol is in the spec-review skill (section 9, Code review). -->

!`suiko review $ARGUMENTS 2>&1 || true`

The output above comes from `suiko review`. Without arguments it reviews everything on this branch since it left the default branch, uncommitted and untracked files included.

- **If it is an error** (nothing to review, not a git repository, `gh` missing or not signed in for `--pr`, offline), tell the user what it says and stop.
- **Otherwise** its first line is `suiko: code review <doc> …` and its `next:` line names the wait. Run that `suiko wait <doc>` with Bash `run_in_background: true`. Then tell the user in one line that the review is open in their browser: click a line number (shift-click for a range), press `c` to comment or `s` to suggest replacement lines, and click **Submit review**; you will pick it up automatically. End the turn. Do not poll.

When the wait exits, follow the spec-review skill, section 9 (Code review):
1. Read each cited file before you edit it.
2. Use the `src>` lines as exact Edit `old_string`s.
3. Run `suiko apply <doc> <tid>` for the suggestions.
4. Record the next round with `suiko revise <doc> --replies -`.
5. Start the wait again.
