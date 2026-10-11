<!--
How to use (for Eric, not part of the prompt):
1. In Terminal:  mkdir -p ~/Desktop/Projects/specreview-playground
2. In the Claude desktop app, start a NEW Claude Code session whose folder is ~/Desktop/Projects/specreview-playground.
3. Paste everything below the line into that session.
-->
---

You are going to help me test **SpecReview** end to end. SpecReview is a local tool (already installed on this Mac) that makes reviewing AI-written specs work like a pull request: you write a spec and open it in a review UI; I comment on specific parts of it (text, table cells, diagram nodes, image regions, snipped areas of the page or screen); you receive located feedback, make targeted edits and record versions; I see exactly what changed, verify your replies, and approve a final version.

You have two roles: (1) the **spec author**, following SpecReview's protocol exactly, and (2) the **test conductor**: you drive the rounds, tell me precisely what to try in the review UI each round, exercise every agent-side capability yourself, and keep a test log.

## Before you start

- Run `pwd`. This session must be running in `~/Desktop/Projects/specreview-playground`. If it is anything else, stop and tell me: a `cd` outside the session folder is not kept between your commands, and SpecReview's prompt hook only looks for reviews from the session's folder.
- If the playground already contains a `.specreview/` folder from an earlier run, stop and ask me to rename the folder; don't reuse it.
- Read the installed skill: `~/.claude/skills/spec-review/SKILL.md` and `~/.claude/skills/spec-review/reference.md`. Follow that protocol throughout; the exceptions this test needs are spelled out below.
- Skim `/Users/erictang/Desktop/Projects/html_documentation_annotator/README.md`, especially "Keyboard shortcuts" and "Snipping", so you can guide me through the UI. That directory is the tool itself: **do not modify anything in it**. If you find a bug, log it; don't fix it.
- `specreview` is not on PATH. Set up the playground and a wrapper (safe to re-run), and use the wrapper for every command:

  ```bash
  git init -q
  printf '#!/bin/sh\nexec "/Users/erictang/.nvm/versions/node/v24.12.0/bin/node" "/Users/erictang/Desktop/Projects/html_documentation_annotator/bin/specreview.js" "$@"\n' > sr && chmod +x sr
  ```

  Run every command as `./sr <command>`. Wherever SpecReview's own output says `specreview …`, run `./sr …` instead.
- Keep a running test log in `TEST-LOG.md`, one row per feature: `| # | feature | tested by (me/you) | result (pass/fail/partial/untested) | notes |`. Update it at the end of every turn. Expected warnings that the tool documents are not bugs.

## Step 1: write two demo specs (each written ONCE with the Write tool)

Images first, in `docs/specs/img/`:
- `cp /Users/erictang/Desktop/Projects/html_documentation_annotator/test/fixtures/docs/img/arch.png docs/specs/img/architecture.png`, then enlarge it so a region is easy to drag over: `sips --resampleWidth 800 docs/specs/img/architecture.png >/dev/null`.
- Hand-write a small SVG `docs/specs/img/sequence.svg` (three labelled boxes joined by arrows). Make one label deliberately wrong (e.g. "Provider" where it should say "Queue") so I can comment on it and you can fix the image later.

**A. `docs/specs/notification-service.md`**: a realistic implementation spec for a "Notification Service", about 180 lines. It must contain:
- YAML front matter; an H1 and numbered H2/H3 sections;
- a goals list and a task list (`- [ ]` items);
- a GFM table of channels (email, SMS, push, webhook) × columns (rate limit, retry policy, TTL, provider) with some inline code;
- a mermaid flowchart with named nodes (API, Queue, Worker, Provider, DLQ) and a mermaid sequence diagram;
- a TypeScript code block of at least 15 lines and a JSON config block;
- both images: `![Architecture](img/architecture.png)` and `![Sequence](img/sequence.svg)`;
- inline math (e.g. `$p_{99} < 200\,\text{ms}$`) and a display math block;
- a blockquote, two footnotes, and a raw-HTML `<details>` block;
- "Rollout plan" and "Open questions" sections.
Plant 4–5 deliberate, reviewable flaws (an ambiguous retry policy, an over-long TTL, a vague SLO, a missing failure mode, an inconsistency between the table and the prose). Don't tell me where they are.

**B. `docs/specs/admin-dashboard.html`**: a self-contained HTML spec (no CDN), about 150 lines, with: a `<style>` block; a header; a two-tab section (tab buttons plus panels switched by inline JS; the second panel hidden at first and holding real content); an inline SVG architecture diagram with `<g id="…">` groups and `<text>` labels; a `<canvas>` bar chart drawn by an inline script; a table with rowspan and colspan; a `<figure>` with `<img src="img/architecture.png">` and a `<figcaption>`; a `<pre class="mermaid">` flowchart; a `<details>` FAQ; and a `<pre><code>` snippet.

Then `git add -A && git commit -qm "demo specs"` so anything can be recovered.

## Step 2: review rounds on the Markdown spec

How every round works: `./sr open <spec>` (first time only) prints a `review UI:` URL and a `next:` line. Open the full URL (including `?k=…`) in the built-in browser with `mcp__Claude_Browser__navigate`. Run `./sr wait <doc exactly as the next: line names it>` with `run_in_background: true`, then **end your turn** with a short numbered checklist of what I should do. Never poll. When the wait exits, process the packet.

General tips to give me once: the review UI hides the left outline behind the ☰ "Outline and history" button when the pane is narrow; single-letter keys act on the doc or the side panel depending on where I last clicked; `⌘/` (or `?`) lists every shortcut, `⌘K` opens a command palette with every action, and `⌘,` opens settings.

### Round 1: commenting (tell me to do all of these, then submit)
1. Select a phrase, press `c`, write a comment, click the **Blocking** chip above the text box (the `1`–`3` severity keys only work when focus is outside the text box), then `⌘↵` (add to review).
2. Select a sentence, press `s`, type a replacement (a suggestion), `⌘↵`.
3. Select some text, press `q`, ask you a question, `⌘↵`.
4. Mark the whole "Rollout plan" section as agreed: open the outline (☰ if needed), use the section's `⋯` menu → **Mark agreed**, then click **Mark agreed** again in the confirmation box. Don't use `a` for this one: `a` locks only the selected text.
5. Press `e` (pick), click a table cell, choose **Row** in the chooser (or press `2`), comment, `⌘↵`.
6. `e`, click a node in the mermaid flowchart, comment, `⌘↵`.
7. `e`, then **Shift-drag** over part of the architecture image, comment, `⌘↵` (you will receive a crop of that region).
8. Comment on the wrong label in the sequence SVG image (`e`, click the image, comment).
9. Press `b` and drag a box over the TypeScript code block plus the paragraph after it, comment, `⌘↵` (you will receive a screenshot of that area).
10. Click **General comment** and leave a doc-wide comment.
11. Press `f`, choose **Request changes**, submit.

### Guard demos (do these first when the round-1 packet arrives, before addressing it, and log the results)
a. With the Edit tool, change one line inside the range the packet's `LOCKED` footer lists for L1. Run `./sr revise <doc> --dry-run --replies - <<'JSON'` with `{"summary":"guard test","threads":{}}`. Expect `dry run - would be REFUSED (exit 3)` and an `ERR lock: hN … changes L1 …` line (the `WARN … has no reply entry` lines are expected). Undo it with `./sr revert <doc> --hunk <that hN>` and confirm `./sr status <doc>` shows `working copy: clean`.
b. This one Write attempt is the only sanctioned exception to "never rewrite a spec": Read the spec, then call the Write tool with a short rewrite (about 40 lines of new prose; don't copy any code block, table or diagram), so far more than 40% of its lines change. The installed PreToolUse hook should **deny** it with a reason starting `docs/specs/notification-service.md is under SpecReview (…); this Write would replace NN% of its lines`. Log that reason and don't retry the write any other way. If it is not denied, restore with `git checkout -- docs/specs/notification-service.md` and log a bug.

### Your response to every packet
- Read the spec file first. **Read every `image:` / `crop:` file listed in the packet** (with the Read tool) before acting on that thread.
- Make targeted Edit-tool edits only (use the `src>` lines as `old_string`), then `./sr apply <doc> <tid>` for suggestions (re-Read the file after apply).
- Fix the wrong label inside `img/sequence.svg` for that thread (the review will show the image before/after).
- Across the round, use a spread of reply statuses: `addressed`; `answered` for my question; `declined` with a reason for one debatable comment; `needs_input` with one precise question back to me.
- Proactively ask me one question with `./sr ask <doc> --quote "<a plain-text phrase from the last recorded version, without Markdown markup>" -m "<question>"`. Run it before you start editing or right after `revise` (it anchors on the recorded version, so quoting text you just changed fails with exit 3).
- Explain any change not tied to a thread in `"other"`.
- Record with `./sr revise <doc> --replies - <<'JSON' … JSON` (one entry per thread) and paste the revise report (hunks → threads, guards, anchors) into your message.
- Start a background `./sr wait`, and end the turn with my next checklist.

### Round 2: seeing what changed and verifying (tell me to)
1. Click **Review changes** in the "v2 ready" toast (it lasts about 15 s; otherwise press `2`). Look at the change bars, the inline word diffs and a "⊖ was" tab (shown where words were replaced; click it to see the old text); step through changes with `n` / `p`; tick "seen"; press `d` to switch the comparison base. Check the image before/after for the SVG fix.
2. Press `3` (Source): toggle unified / split diff; then click a line number, shift-click a few lines and press `c` to comment on raw source lines.
3. Press `4` (History) and compare v1 with v2.
4. Press `v` (Verify), then click a thread card in the side panel (`x` / `o` only act when focus is in the panel, not in the doc). Accept two threads with `x`. On a third, click **Record as decision**, type a one-line decision and press Enter. Reopen one with `o` and write why. Accept your declined thread with `y` (or reopen it). Switch the filter to **Needs me** and use **Answer claude** on your `needs_input` thread and on your `ask` question. (Replies, reopens and answers stay drafts until step 8.)
5. Check that the image-region, snip, table-row and mermaid comments still sit in the right places on v2. Try `h` (hide all annotations), `\` (thread panel), `j` / `k` (next / previous thread), `t` (theme).
6. App-level shortcuts. If `⌘K` / `⌘,` / `⌘/` don't reach the page inside the Claude app, use `Ctrl+K` / `Ctrl+,` / `Ctrl+/` or the top-bar buttons (search "⌘K", gear, "?"), and tell me which worked so you can log it.
   - `⌘K` (command palette): type `t1` and press Enter (jumps to that thread); type a section name (scrolls there); run **Compare versions** (pick v1, then v2); run **Copy review link**; note that commands that can't run right now are dimmed with the reason.
   - `⌘,` (settings): set "When the agent records a new version" to **Switch to Changes**, and turn **Ask before Send now** on (it matters in the next step). Turn **Single-letter shortcuts** off, check that `c` and `b` now do nothing (in the side panel and in the doc) while `⌘K` → "Comment on the selection" still works, then turn them back on.
   - `⌘/` (keyboard shortcuts): type "snip" in its filter.
7. Make one new comment and press `⌘⇧↵` (**Send now**). Because "Ask before Send now" is on, it asks first: press `⌘⇧↵` again to confirm. This wakes you immediately with a one-item review: address it, revise, start the wait again, and end your turn with "continue round 2". (With "Switch to Changes" on, my UI should jump to the Changes view when your new version lands.)
8. Press `f` and submit with **Request changes**.

Your response: same protocol. The packet will show REOPENED / ANSWER items and DECISIONS; keep every decision true. Also run these and paste the output: `./sr log <doc>`, `./sr diff <doc> --stat`, `./sr diff <doc> v1..v2 --unified`, `./sr threads <doc> --status all`, `./sr show <doc> t1`, `./sr status`.

### Round 3: approve
Tell me to click **Review changes** in the newest "vN ready" toast (Approve is refused on an older version), look over the changes, then press `f`, choose **Approve**, and keep **Mark vN final** and **Resolve N addressed threads** checked (both are on by default). On the APPROVED packet run `./sr final <doc> --decisions`, show me the decisions file, and stop waiting on this doc.

## Step 3: the HTML spec (one round, then approve)

Run `./sr open docs/specs/admin-dashboard.html` and open the URL in the browser pane. In the same turn, before giving me the checklist:
- Run `./sr snip docs/specs/admin-dashboard.html --file docs/specs/img/architecture.png -m "Agent-side snip test"`. With `--file` no picker opens, so this is the one sanctioned time you run `snip` (never run it without `--file`). Expect `added a screenshot to admin-dashboard as draft dN`. Ask me to confirm the "Screenshot added from your Mac" toast and the thumbnail on the draft card. That draft goes out with my review as a `GENERAL` thread with an `image:` line: Read the image and reply `answered`.
- This time **do not start `wait`**. Instead tell me to review and then send you a chat message saying "submitted". This tests the safety net: with that message, the installed UserPromptSubmit hook should add a note to your context like `specreview: review rv1 on admin-dashboard (N threads, CHANGES REQUESTED) was submitted at HH:MM and not delivered. Run specreview feedback admin-dashboard …`. Quote it in TEST-LOG.md (pass) or log a fail if no such note appeared. Then fetch the packet with `./sr feedback <doc>`.

Checklist for me:
1. `e`, hover the inline SVG diagram, use `[` / `]` to move between a `<g>` group and its parent, click, comment.
2. `e`, Shift-drag over part of the canvas chart, comment.
3. Switch to the second tab, select text in it, press `c`, comment.
4. `e`, click a cell that spans rows (rowspan), choose **Cell**, comment.
5. `e`, click a node in the mermaid diagram, comment.
6. `b`, snip a box across the figure and its caption, comment.
7. Optional, only if Claude already has the macOS Screen Recording permission (granting it now means quitting Claude, which would end this test): press `⇧B`, drag a box anywhere on the screen, comment. If the screenshot shows only wallpaper, skip it and log "untested".
8. Press `f` and submit with **Request changes**, then send you "submitted".

Your response this round also exercises the other agent-side commands:
- `./sr reply <doc> <tid> -m "…" --status answered` on one thread (a reply without recording a version);
- `./sr edit <doc> --stdin` with a JSON batch `[{"threads":["tN"],"old":"…","new":"…"}]` for one thread instead of the Edit tool;
- `./sr reanchor <doc> <tid> --lines A-B` to move one thread's anchor to better lines;
- then revise, start a background wait, and have me Approve (same as round 3); finish with `./sr final <doc> --decisions`.

## Step 4: wrap up

- Exit codes: write a tiny throwaway spec `docs/specs/scratch.md` and `./sr open` it. Then `./sr wait <doc> --timeout 5s` (expect exit 2); start a background `./sr wait <doc>`, then a second one (the first exits 6, "superseded"); then `./sr close <doc>` (the running wait exits 5).
- Optional MCP smoke test: run `./sr mcp` and confirm it lists its `specreview_*` tools over stdio (a few JSON-RPC lines are enough; don't register it with Claude).
- Optional: walk me through a global snip hotkey with the Shortcuts app (README → "Snipping"), skipping its PATH step. In the "Run Shell Script" action use exactly: `"/Users/erictang/.nvm/versions/node/v24.12.0/bin/node" "/Users/erictang/Desktop/Projects/html_documentation_annotator/bin/specreview.js" snip "/Users/erictang/Desktop/Projects/specreview-playground/docs/specs/admin-dashboard.html"`. Shortcuts needs its own Screen Recording permission; the snip arrives as a draft with the "Screenshot added from your Mac" toast while that doc's review UI is open.
- Finalize `TEST-LOG.md` and give me a short report: everything exercised, pass / fail / untested, and every bug with exact repro steps and command output.
- Run `./sr stop` at the very end.

## Rules
- Never regenerate or rewrite a spec after `open` (the single sanctioned Write attempt in guard demo b is the only exception). Read before you Edit. Keep edits minimal and targeted.
- Never use `--force`, `--allow-rewrite` or `--break-lock` (the guard demo only uses `--dry-run`).
- One background wait per doc; never poll; end your turn right after starting a wait.
- Don't change anything in `/Users/erictang/Desktop/Projects/html_documentation_annotator`.
- Keep chat messages short: one line per thread you handled, then my next checklist.
