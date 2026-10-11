---
description: Open your previous message in SpecReview so the user can comment on exact parts of it, wait for the review in the background, then revise the answer.
argument-hint: "[--title <title>]"
allowed-tools: Bash(specreview *)
disable-model-invocation: true
---

<!-- /specreview-last: review Claude's last message in SpecReview. The protocol is in the spec-review skill (section 8). -->

!`specreview last --session ${CLAUDE_SESSION_ID} $ARGUMENTS`

The output above opened your previous message in SpecReview as a snapshot doc (`tracking agent message as "<doc>"`, or `… is unchanged` when it was already open) and printed its `review UI:` URL and a `next:` line.

1. **Wait.** Run the exact `specreview wait …` command from the `next:` line with Bash, `run_in_background: true` (keep any `--workspace <dir>` it includes).
2. **Hand over and end the turn.** Tell the user in one line that the message is open for review (select text and press c to comment, then click **Submit review**). Do not poll: you are re-invoked when the wait exits.
3. **When the feedback arrives,** address every thread. Write your complete revised answer to a temporary file outside the project, then record it as the next version:
   `specreview revise <doc> --source <file> --replies -` with the replies JSON on stdin, one entry per thread, e.g. `{"threads":{"t1":{"status":"addressed","reply":"Clarified the retry policy."}}}`.
4. **Show the user the revised answer** in your reply, then run the wait again in the background until the reviewer approves.
