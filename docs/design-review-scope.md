# SpecReview: Plannotator scope for direct agent and human review (final design)

Status: final design for `feat/review-scope`. Nothing under `/home/claude/work/sr` was changed while writing it.

**Baseline** (re-checked on 2026-10-11):
- `feat/review-scope` at **HEAD `2e22f7d`**. The snapshot work that the draft called "in flight" has landed as
  `19817ae..2e22f7d`. It covers snapshot docs, `specreview plan-gate`, `last`, `open -`, `open <dir>`,
  `revise --source`, the plugin hook, `/specreview-last` and the docs.
- `feat/installer` at **`6398f6c`**, in the worktree `/home/claude/work/sr-installer`, plus that session's
  uncommitted `src/cli/install/toml.js` and its `files.js` and `install.js` edits. It holds a multi-agent installer,
  `uninstall` and `install.sh`. It forked from `35a8507`.

Inputs:
- `notes/design-draft.md`;
- the three critiques `notes/critique-{architecture,agent-ux,test-security-scope}.md`;
- the map and research notes;
- the source at the baseline above.

Every critique point was checked against the code or the notes. Appendix A logs each one: accepted (and where it is
fixed), changed, or rejected (with the reason).

**Scope, from the user.** Build Plannotator's capabilities for direct agent <-> human review only:
- F1: the plan-mode gate;
- F2: code review of the agent's changes;
- F3: the agent's last message and piped text;
- F4: a folder of specs, and a URL snapshot;
- F5: a one-step multi-agent installer with dry run, uninstall and a bootstrap script.

**Out of scope:** team sharing, hosted features, a TUI, a VS Code extension, Ask AI, visual polish.

**What changed from the draft, in brief:**
1. It is re-based on the landed code and on `feat/installer`. WP1, WP2 and WP5 are now **delta** packages, and the
   shipped names and keys are kept.
2. WP0 is split in two:
   - **WP0a**: small contracts and snapshot, plan and delivery fixes. It unblocks WP1, WP2 and WP5.
   - **WP0b**: the code-kind seams. It unblocks WP3 and WP4.
3. Code docs get a **kind adapter** seam that covers every render, loader and anchor path. A contract test calls
   every op and every route on a code doc.
4. `wait --all` and `feedback` no longer collide with the plan gate.
5. URL pages are converted to Markdown through an **allowlist** sanitizer, and every snapshot doc gets a strict CSP and
   sandbox.
6. Security-relevant config is read only from a new user-level config file.
7. The git subprocess hygiene, symlink, hostile-file-name and hermetic-test gaps are closed.
8. PR mode becomes an optional WP3b.

---

## 0. Decisions at a glance

| # | Question | Decision |
|---|---|---|
| D1 | Baseline | HEAD `2e22f7d` plus `feat/installer`. The shipped contracts in 1.2 are adopted as frozen. A WP changes one only where this design lists the delta. |
| D2 | How the inputs fit the model | Three doc kinds. **`file`** is today's kind. **`snapshot`** (shipped) covers plan, message and stdin, plus the new **url**. **`code`** is new: one doc per code review, whose versions are diff rounds. Store, versions, threads, reviews, packets, Verify, SSE and the guest are reused. Code docs plug in through a **kind adapter** (2.9). |
| D3 | Repo pollution | Snapshot and code doc dirs are **ephemeral**: the doc dir holds a `.gitignore` containing `*`, and `autoCommit` skips the doc. The user-level `store.commitSnapshots: true` keeps snapshot docs committable. Code docs are always ephemeral. |
| D4 | Plan gate | Shipped `specreview plan-gate`: a normal command, signal-aware, waiting as agent `claude`, with key `claude-plan:<session>:<planFilePath\|inline>`. Deltas (section 3): plan docs leave `wait --all` and generic delivery; linked threads become `addressed` automatically; long feedback overflows to a file; approve-with-notes; subagent calls fail open; a closed plan doc means "gating paused"; the implicit gate never creates a store; liveness checks; a PlanBanner with "Approve + accept edits". |
| D5 | Code review model | One `code` doc per review spec. A round is stored as three parts: a canonical diff text that SpecReview generates (the version source), doc-local blobs per file side, and `manifest.code`. Anchors live in **file space**. The merge-base is re-computed each round for ref bases. |
| D6 | Who records a round | The agent, with `specreview revise <code-doc>`. The reviewer can also press "Re-snapshot". NEXT is per mode: staged mode says `git add`, branch and range modes say commit. A fixed-endpoint review (one commit, or a range ending in a sha) switches its new side to the working tree after v1. |
| D7 | Packet lines for code | Repo-root-relative `path:L42-44` and one `Repo root: <abs>` basis line. `src>` comes from the working file and is unique in it. Old-side items print `was>`. PROTOCOL says to Read before Edit. |
| D8 | Suggestions on code | `specreview apply` writes the real file with a CAS write (`store.writeRepoFile`). A reviewer "Apply now" also records a `ui-apply` round. |
| D9 | Network | Only these touch the network: `snapshot <url>` (CLI; MCP for public hosts only), `review --pr` (CLI only, WP3b) and `install.sh`. The daemon and UI never fetch. `network.allow` (user config) and `SPECREVIEW_OFFLINE=1` refuse them. |
| D10 | URL docs | HTML is sanitized with the GitHub allowlist schema (`hast-util-sanitize`), then converted to Markdown (`hast-util-to-mdast`). The result contains no raw HTML. `--as-html` keeps the sanitized HTML. Remote assets are blocked per doc. Jina only with `--reader jina`, never for private hosts, and never with the query string. There is no `--keep-scripts`. |
| D11 | Config | A new user layer, `$SPECREVIEW_HOME/config.json`. Precedence: env > workspace (allowed keys only) > user > defaults. `plan.*`, `store.commitSnapshots`, `network.*` and `snapshot.*` are read from the user layer only. |
| D12 | Installer | Adopt `feat/installer`, then close its gaps (section 7): Gemini and Copilot MCP, code and last commands for every agent, the plan-notes hook, symlink-safe writes, opt-in Claude permissions, and a confirmation prompt in `install.sh`. |
| D13 | Work split | WP0a lands first. Then WP0b, WP1, WP2 and WP5 run in parallel. When WP0b lands, WP3 and WP4 run in parallel. WP3b (PR mode) is optional and comes after WP3. WP6 (protocol and docs) merges last. |

---

## 1. Ground rules and baseline

### 1.1 Principles kept

- **Offline by default.** D9 lists every network path. Nothing fetches at view time: URL docs are served with
  `render.network: "block"` unless the user passed `--allow-remote-assets`.
- **Deterministic packets.**
  - The existing packet grammar stays.
  - Code items replace `L.. · §section` with `path:L..`.
  - Plan denials use `formatPlanFeedback`.
  - Packets are capped at `LIMITS.packetChars` (10000). The full text overflows to a file (2.6).
- **Disk is the source of truth.**
  - Review data lives in plain files in `.specreview/docs/<id>/`, plus doc-local `blobs/` for code.
  - Runtime state lives in `$SPECREVIEW_HOME/ws/<wsId>/`.
  - Git objects are never the only copy of review data.
- **Commit points do not change.** The manifest is still the commit point behind the redo journal. Unknown doc.json
  and manifest fields persist.
- **Guards keep their meaning for specs.** Snapshots keep the shipped warn-only profile. Code docs get a code profile
  (4.9).
- **Hooks fail open.** No hook ever blocks Claude Code on an error.

### 1.2 What has landed (adopted as frozen contracts)

| Area | Shipped contract (file) |
|---|---|
| Snapshot kind | `doc.kind: 'snapshot'`. `origin: {type, key, …}`. Synthetic path `<dir>/<id>.md` with `ORIGIN_TYPES` `plan`→`plans`, `message`→`messages`, `stdin`→`text`. Helpers `isSnapshot`, `originType`, `originInfo`, `normalizeOrigin`, `snapshotPath`, `scratchBase`, `isScratchRoot`, `docRefFor`, `planFileOf`, `reviseHint`, `snapshotRefusal` (`src/core/store/snapshot.js`). |
| Store | `createSnapshotDoc({title, format, origin, slug, createdBy}) -> {doc, created}`, deduplicated on `origin.key` under the workspace lock. `findDocByOrigin(key)`. `findDoc` never matches a snapshot. For snapshots, `readWorking` returns the head bytes and `writeWorking` refuses (`store.js`). |
| Ops | `openSnapshot`, `recordSnapshot`, `takeSnapshot` (`ops/snapshot.js`). `openSnapshot` reopens a closed doc. `revise(ctx, ref, input, snapshot)` with the warn-only guard profile and `manifestExtra.origin`. `waitForFeedback({…, minVersion, write})`. `formatPlanFeedback(packet, {planFilePath, maxChars})`. `snapshotNextStep`, `SNAPSHOT_PROTOCOL`, `PLAN_PROTOCOL`. |
| CLI helpers | `src/cli/snapshot.js`: `snapshotWorkspace(rt, dir)`, `scratchRootFor(dir)` = `$SPECREVIEW_HOME/scratch/<sha256(realpath dir)[:8]>`, `recordSnapshotDoc`, `snapshotLine`, `scratchNote`, `defaultTitle`, `showUrl`, `shownPrefix`, `MAX_SNAPSHOT_BYTES` (5 MiB). |
| Plan gate | `specreview plan-gate [--timeout 30m] [--browser system\|none]` (`src/cli/commands/plan-gate.js`; hidden `--as`, `--workspace`). It is SIGNAL_AWARE in `src/cli/main.js`. Agent `rt.env.SPECREVIEW_AGENT \|\| 'claude'`. Key `claude-plan:<session>:<planFilePath\|inline>`. The decision is computed and printed **inside** the engine's `write` callback, so delivery is recorded only after stdout is flushed. It fails open on everything. |
| `last` | `specreview last [--session <id>] [--transcript <path>] [--title T] [--browser …] [--workspace <dir>] [--json]`. Key `claude-msg:<session>:<message id>`. `findTranscript({transcript, session, env, cwd}) -> {path, session, note}` (it throws when nothing is found). `lastAssistantMessage(file)`. `readTranscript`. `extractLastMessage(jsonl)`, which follows the active `parentUuid` branch so `/rewind` is honoured (`src/cli/transcript.js`). |
| `open -` | Reads stdin up to 5 MiB. Markdown only. Key `stdin:<name>` with `--name`, otherwise `null` (a new doc every time). Empty or oversized input is a UsageError (exit 1). |
| `open <dir>` | `.md/.markdown/.html/.htm` files, recursive and sorted. It skips dot dirs, `node_modules`, `isDeniedPath` paths and symlinks that leave the dir. It opens the first 200 files and reports the rest (`overCap`). JSON `{docs, home, skipped:{dot,nodeModules,denied,symlinks,overCap}}`. Zero files is a UsageError. |
| `revise --source` | `revise <ref> --source <file\|->`. With `-`, `--replies` must be a file. |
| Integrations | `hooks.json` has PermissionRequest/ExitPlanMode → `specreview plan-gate`, timeout 345600. There is a `/specreview-last` command. The skill, reference, AGENTS snippet and `agent-protocol.md` have plan, last and stdin sections. |
| Daemon and UI | Snapshots have no file watcher. Unlisted content-origin paths of a snapshot return 404. `docSummary` returns `kind` and `origin`. ThreadCard hides "Apply now" for snapshots. `pre-write` ignores snapshots. The `prompt` hook skips plan docs. Doctor skips working-file checks for snapshots. |
| Tests | `test/integration/{plan-gate,cli-snapshot}.test.js`, `test/unit/{store-snapshot,transcript}.test.js`, `test/e2e/snapshot.spec.mjs`. |
| URLs | Review URL: `http://127.0.0.1:<uiPort>/d/<wsId>/<docId>?k=<token>`. Home URL: `http://127.0.0.1:<uiPort>/?k=<token>`. |

These differ from the draft, and **the shipped form wins**:
- the command is `plan-gate`, not `hook plan`;
- the agent identity is `claude`, not `claude-plan`;
- the origin keys are the shipped ones;
- `open -` without `--name` makes a new doc;
- the shipped exit codes for `open -`, `open <dir>` and `last` stay;
- `open <dir>` truncates at 200 files;
- `last` has no `--turn`.

No origin-key migration is needed, because no shipped key changes.

### 1.3 `feat/installer` (adopted by WP5)

`/home/claude/work/sr-installer`, `feat/installer` at `6398f6c`, plus its uncommitted work, already provides:
- **Agent planners** for claude, codex, gemini, cursor, opencode, copilot, amp, droid, kiro and claude-desktop, in
  `src/cli/install/{agents,content,files,multi}.js` plus `toml.js`. Antigravity and Devin are listed as unverified.
- **Options:** dry run by default, `--apply`, `--only/--skip`, `--user/--project`.
- **Safety:** one-time backups (`*.specreview-backup`), an install manifest, managed-file and marker ownership, and a
  structure-aware TOML block for Codex `config.toml`.
- **Shared skills:** a shared-skill dedupe with `stillUsesShared`, so a partial uninstall keeps what another agent
  uses.
- **Hooks:** the ownership regex `OUR_HOOK_RE`, which matches `specreview … hook <name>` and `… plan-gate`, PATH-relative
  or absolute. `hookEntries({planGate, hooks})` filters by flag. With the plugin installed, it refuses to install the
  Claude hooks.
- **MCP:** `claude mcp add` is printed, never executed.
- **Skill and commands:** the agent-neutral skill `integrations/agent-skills/specreview-review/SKILL.md`, plus Gemini
  and OpenCode `specreview-review` commands.
- **Bootstrap:** `install.sh` (POSIX sh, Node ≥ 20.19 check, a clone or a local checkout, `npm link` with a shim
  fallback, then the dry run; `--yes` applies).
- **Tests:** `test/integration/{cli-install-agents,install-sh}.test.js` and `test/unit/install-files.test.js`. The
  `install-sh` test uses a fake `npm` on a restricted PATH.

It conflicts with `80574e1` and `4705411` in `src/cli/commands/{index,doctor}.js`, `README.md` and
`test/integration/docs-cli.test.js`. WP5 rebases it onto WP0a and resolves those conflicts (9.5).

### 1.4 Reused machinery

| Piece | Where | Reused for |
|---|---|---|
| Version recording from given bytes | `prepareRecord(… {working})`, `commitRecord` | snapshot re-captures, code rounds |
| Format-agnostic anchors, re-anchoring and attribution (`render = null`) | `core/anchor/*`, `review/attribution.js`, `review/workmap.js` | code anchors (file space), snapshots |
| Packet build and format | `packet-data.js`, `packet.js` | all kinds |
| Blocking wait, superseding, "printed before recorded" | `ops/wait.js`, `ops/feedback.js`, the `write` callback | plan gate, every wait |
| Source-diff rows `{op, oldNo, newNo, text, words, hunk}` | `diff/source-diff.js` (frozen shape) | code diff view, interdiff |
| CAS working-file write | `store.writeWorking` | generalised into `store.writeRepoFile` |
| Installer plan model | `feat/installer` | F5 |

---

## 2. Shared contracts

The contracts in this section are written by WP0a and WP0b. The owner of each subsection is named in its title.

### 2.1 Doc kinds, doc.json and origin keys (WP0a types; WP0b code kind)

```jsonc
{
  "schema": 1,
  "id": "plan-refactor-auth",
  "kind": "file" | "snapshot" | "code",          // absent = "file"
  "origin": {                                     // snapshot and code docs
    "type": "plan" | "message" | "stdin" | "url" | "diff",
    "key": "<identity, below>" | null,            // null = a new doc every time
    // type-specific fields, kept as given (shipped): session, planFilePath, cwd, transcript, messageId, name;
    // url: url, finalUrl, private (bool: the host resolved to a non-public address)
  },
  "code": { /* CodeSpec, code docs only (2.8) */ },
  "ephemeral": true,                              // the doc dir holds ".gitignore" = "*"; autoCommit skips it
  "render": { "network": "block" },               // per-doc override of render.network (url docs)
  "path": "plans/plan-refactor-auth.md",          // synthetic for snapshot and code docs
  "format": "markdown" | "html" | "text"
}
```

Allowed combinations:

| kind | origin.type | format | synthetic path |
|---|---|---|---|
| `file` | none | markdown, html | the real workspace file (unchanged) |
| `snapshot` | plan, message, stdin | markdown | `plans/`, `messages/`, `text/` + `<id>.md` (shipped) |
| `snapshot` | url | markdown (default) or html (`--as-html`) | `web/<id>.md` or `.html`. WP0a adds the `ORIGIN_TYPES` row `url: {dir: 'web', label: 'web page', noun: 'page'}`. |
| `code` | diff | text | `code/<id>.diff` |

Origin keys:

| type | key | Owner |
|---|---|---|
| plan | `claude-plan:<session>:<planFilePath\|inline>` (shipped) | shipped |
| message | `claude-msg:<session>:<message.id>` (shipped) | shipped |
| stdin | `stdin:<name>` with `--name`, otherwise `null` (shipped) | shipped |
| url | `url:<normalized url>`. Normalisation lowercases the scheme and host, drops default ports and the fragment, and keeps the query. | WP2 |
| diff | `diff:<mode>:<canonical spec>[+paths=<sorted pathspecs>]` (4.2) | WP3 |

**Re-taking a closed doc** (one rule for all kinds):
- A message, stdin, url or code doc is **reopened** and records the new version. This is the shipped `openSnapshot`
  behaviour, extended to code docs.
- A **plan** doc is the exception. A closed plan doc means **gating is paused** for that plan (3.8). The gate records
  the version but does not reopen the doc, does not wait, and prints nothing.

### 2.2 Types (`src/shared/types.js`, WP0a)

```js
/** @typedef {'markdown' | 'html' | 'text'} DocFormat */
/** @typedef {'file' | 'snapshot' | 'code'} DocKind */
// Doc gains:        kind?: DocKind, origin?: DocOrigin, code?: CodeSpec, ephemeral?: boolean,
//                   render?: { network?: 'allow' | 'block' }
// VersionManifest:  capturedBy adds 'round'; gains origin?: DocOrigin, code?: CodeManifest (2.8)
// Anchor gains:     file?: { path: string, side: 'new' | 'old', oldPath?: string }
// Capture adds:     { kind: 'line', file: string, side: 'new' | 'old', startLine: number, endLine: number }
//                 | { kind: 'file', file: string }                  // whole-file comment (binary, too large, deleted)
// Suggestion gains: file?: string            (code docs: the repo file the suggestion targets; new side only)
// PendingEdit gains: file?: string
// ManifestHunk gains: file?: string          (code docs: hunk ids are '<path>#h<n>')
// ThreadReply gains:  atFile?: string, auto?: true    (auto: written by SpecReview, e.g. "changed in v3 (L14-18)")
// Review gains:       meta?: { planApproveMode?: 'default' | 'acceptEdits' | 'auto' }   (plan docs only)
// PacketThread gains: file?: string, fileFromCwd?: string, side?: 'new' | 'old', was?: string[],
//                     fileState?: 'ok' | 'missing' | 'not-checked-out' | 'binary' | 'too-large'
// Packet:             kind adds 'code'; gains code?: { label, baseSha, newSha, worktree, root },
//                     overflowPath?: string, deliveredVia?: 'doc' | 'all'
```

### 2.3 Constants (`src/shared/protocol.js`, WP0a writes all of them)

```js
export const DOC_KINDS = Object.freeze(['file', 'snapshot', 'code']);
export const CODE_MODES = Object.freeze(['since-base', 'uncommitted', 'staged', 'branch', 'range', 'commit', 'pr']);
export const PLAN_GATE = Object.freeze({
  HOOK_TIMEOUT_SEC: 345600,          // what installers and hooks.json write
  NOTES_HOOK_TIMEOUT_SEC: 10,        // PostToolUse ExitPlanMode `hook plan-notes`
  NOTES_TTL_MS: 3600000,             // a notes record older than this is dropped
  NOTES_MAX_CHARS: 8000,
  MAX_PLAN_BYTES: 2097152,           // shipped
});
// LIMITS additions (existing keys kept):
//   codeFileMaxBytes 5242880, codeFileMaxLines 20000, codeMaxFiles 500, codeContext 3,
//   codeMaxFilesHard 5000, codeFileMaxBytesHard 20971520,   (clamps for workspace config, 2.4)
//   untrackedExcludeMax 1000, codePollMs 5000,
//   urlMaxBytes 10485760, urlTimeoutMs 30000, urlMaxRedirects 10, urlLowTextChars 200
export const FOLDER_EXCLUDES = Object.freeze(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  '_site', 'public', '__pycache__', 'venv', 'bower_components']);   // plus every dot dir (shipped rule)
export const GIT_MIN_VERSION = '2.32.0';   // --end-of-options everywhere, GIT_CONFIG_GLOBAL in tests
export const CODE_TESTID = Object.freeze({
  view: 'code-view', fileTree: 'code-file-tree', fileRow: 'code-file-row', fileDiff: 'code-file-diff',
  lineBtn: 'code-line-btn', stub: 'code-file-stub', resnapshot: 'code-resnapshot',
});
export const PLAN_TESTID = Object.freeze({ banner: 'plan-gate-banner', approve: 'plan-approve', approveEdits: 'plan-approve-edits' });
// EXIT is unchanged: every new failure maps onto 0/1/2/3/4/5/6.
```

`CODE_TESTID` and `PLAN_TESTID` are separate objects, so the existing coverage test over `TESTID` does not demand
them.

### 2.4 Config layers (`src/core/store/config.js`, WP0a)

A new **user layer** lives at `$SPECREVIEW_HOME/config.json`. It is read with the same deep merge and type checks as
the workspace file.

```jsonc
// user layer: the only place these keys are read
{ "plan":    { "gate": true, "approveMode": "", "openBrowser": "auto", "gateSubagents": false },
             //  approveMode: "" (Claude Code's own default after approval) | "default" | "acceptEdits" | "auto"
             //  openBrowser: "auto" (open when no UI client shows this doc) | "always" | "never"
  "store":   { "commitSnapshots": false },          // never applies to kind "code"
  "network": { "allow": true },                     // false: snapshot <url> and review --pr refuse (exit 3)
  "snapshot":{ "reader": "auto" },                  // "auto" | "direct"; Jina only per invocation (--reader jina)
  "code":    { "context": 3, "maxFiles": 500, "maxFileBytes": 5242880, "defaultBase": "" } }
```

Rules:
- Precedence is env > workspace > user > defaults.
- In the **workspace** config (`.specreview/config.json`, which is committed), the keys `plan.*`,
  `store.commitSnapshots`, `network.*` and `snapshot.*` are **ignored with a warning**. A cloned repository must not
  choose the permission mode or the network policy.
- `code.*` is allowed in the workspace config. `maxFiles` and `maxFileBytes` are clamped to
  `LIMITS.codeMaxFilesHard` and `LIMITS.codeFileMaxBytesHard`.
- Environment overrides:
  - `SPECREVIEW_OFFLINE=1` sets `network.allow` to false;
  - `SPECREVIEW_PLAN_GATE=off` makes the gate exit at once, printing nothing.
- Existing workspace keys, `render.network` among them, keep their current meaning.

### 2.5 Ephemeral docs (WP0a; WP0b extends to code)

- `createSnapshotDoc` writes `docs/<id>/.gitignore` containing `*\n`, and sets `doc.ephemeral: true`. The exception
  is the user-level `store.commitSnapshots: true`, which never applies to code docs.
- `autoCommit` returns `{commit: null, skipped: 'ephemeral doc'}` for ephemeral docs.
- Recovery, `listDocs` and doctor ignore dotfiles inside doc dirs.
- Docs created by the shipped build have no `.gitignore`. They get one on their next recorded version.

### 2.6 Delivery rules (`ops/wait.js`, `ops/feedback.js`, `packet-data.js`, WP0a; WP0b adds the code rule)

1. **`wait --all` and `wait` with no doc argument** use the same doc filter. It skips:
   - **plan docs** (the plan gate is their only consumer);
   - **closed docs** (they are ignored, not answered with `closed`);
   - message and stdin docs whose `origin.session` differs from the current session, when the session is known
     (`CLAUDE_CODE_SESSION_ID`).

   For virtual docs (snapshot and code), the dirty pre-check is skipped in `_all` mode. A code doc is checked for
   dirtiness only by an explicit `wait <code-doc>`.
2. **`wait <plan-doc>`** is refused with exit 3: "plan docs are answered through ExitPlanMode; the plan gate delivers
   them". This also prevents a background wait from superseding the gate's waiter, which has the same key and agent.
3. **`feedback <plan-doc>`**:
   - prints the plan in **notes framing** (`formatPlanNotes`, 3.6);
   - marks the review delivered **only when no live gate waiter** exists for that doc. That is the late-review path
     of 3.9.
4. **NEXT keeps `--all`.** When a packet is delivered through an `_all` waiter, `Packet.deliveredVia` is `'all'`, and
   every "`specreview wait <ref>`" in NEXT becomes "`specreview wait --all`".
5. **Overflow file.** When `formatPacket`, `formatPlanFeedback` or `formatPlanNotes` truncates:
   - `deliverPacket` first writes the full text to `$SPECREVIEW_HOME/ws/<wsId>/feedback/<doc>-<rv>.txt`;
   - it passes `overflowPath` to the formatter;
   - the overflow line reads `N more threads: Read <abs path> (the full feedback)`. This replaces the per-thread
     `specreview show` lines.

   Plan feedback lists blocking threads first, so they stay inline.

### 2.7 Rendering and content-origin security (WP0a; WP0b adds the `text` format)

- **Per-doc network.** `#csp(wsId)` becomes `#csp(wsId, doc)`, cached by `(wsId, docId)`. The network rule is
  `doc.render?.network ?? config.render.network`. All three call sites pass the doc.
- **Strict profile for snapshot docs.** A snapshot doc (plan, message, stdin, url) does not come from a workspace
  file. Its CSP adds `script-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'`.
  - The guest, mermaid and vendor scripts are served from `/__sr/`.
  - If the shell turns out to need an inline bootstrap, it gets a per-response nonce. The existing guest tests verify
    this.
- **Strict sandbox.** The new `FRAME_SANDBOX_STRICT` in `src/ui/frame.js` is `allow-scripts allow-same-origin
  allow-modals`. It drops `allow-forms`, `allow-popups`, `allow-popups-to-escape-sandbox` and `allow-downloads`.
  `DocFrame` uses it for `kind === 'snapshot'`. File docs keep today's sandbox (spec authors use interactive HTML).
- **Code docs.** `normalizeFormat` and `renderSource` accept `'text'`, which returns an empty `RenderResult`
  (`html: ''`, no outline, blocks, assets or externals). This is a dated amendment to BUILD_AMENDMENTS 3.1. Every
  content-origin route of a code doc returns 404 (WP0b), so code text never reaches an iframe.
- **URL docs** contain no raw HTML by construction (D10, 6.2), so the Markdown pipeline's `rehype-raw` has nothing to
  process. `--as-html` docs are sanitized with an allowlist before they are stored.

### 2.8 Store API (frozen)

**Shipped:** `createSnapshotDoc`, `findDocByOrigin`, and the snapshot branches of `workingPath`, `readWorking`,
`writeWorking` and `findDoc`.

**WP0a** adds:

```js
async createSnapshotDoc({ title, format, origin, slug, createdBy,
                          render = undefined })        // NEW: { network } (url docs)
  // writes docs/<id>/.gitignore unless the user-level store.commitSnapshots; sets doc.ephemeral
// ops/snapshot.js: openSnapshot / takeSnapshot accept `render` and pass it to createSnapshotDoc.
// openSnapshot: a closed PLAN doc is not reopened (2.1); takeSnapshot then returns { doc, created: false,
//   version, report, paused: true } after recording the version.
editCopyPath(wsId, docId) -> '<SPECREVIEW_HOME>/ws/<wsId>/edit/<docId>.md'   // store/snapshot.js (5.3)
```

**WP0b** adds the code kind and repo-file access:

```js
async createSnapshotDoc({ …, kind = 'snapshot', code = undefined })   // kind 'code': format 'text', origin.type 'diff',
                                                                      //   path `code/<id>.diff`, always ephemeral
async putDocBlob(docId, buf)  -> Promise<string>       // 'sha256:<hex>'; idempotent; atomic; blobs/<hex[0..2]>/<hex>
async readDocBlob(docId, ref) -> Promise<Buffer>       // NotFoundError
async readRepoFile(rel) -> Promise<RepoRead | null>    // null when missing
  // RepoRead = { kind: 'file', buf, text, sha256, mode } | { kind: 'symlink', target: string }
  //          | { kind: 'other' }                        (a directory, fifo, socket: never read)
  // lstat only; NEVER follows a symlink; refuses (RefusedError) a path whose parent's realpath leaves the root,
  // any path component equal to '.git' (case-insensitive; this covers .git files in worktrees), and '.specreview'
async writeRepoFile(rel, text, { expectSha256, allowed }) -> Promise<{ sha256, bytes }>
  // writeWorking's CAS, encoding, EOL and mode rules for any repo file. Refuses the same paths as readRepoFile,
  // symlink targets, and any rel not in `allowed` (the head manifest's file list). ConflictError on a sha mismatch.
```

`commitVersion` takes the version file extension from `doc.path`, so `.diff` is allowed for code docs.
`findDocByOrigin` matches snapshot **and** code docs.

### 2.9 The kind adapter and op dispatch (WP0b)

The critiques showed that code docs reach render, version-loader and anchor paths that the draft's dispatch table
missed. Those paths would crash, or would write wrong anchors into thread files. WP0b therefore routes **every** such
path through one seam.

```js
// src/core/review/kinds.js
/** @typedef {object} KindAdapter
 * @property {DocKind} kind
 * @property {(ctx, doc, v, source) => Promise<RenderResult>} render          // openDoc, record, targets, drafts
 * @property {(ctx, doc) => (anchor, toVersion) => Promise<Record<string, Anchor>>} forwarder
 *           // submit (drafts on older versions), moveThread, addLock, changes (forward mapping)
 * @property {(ctx, doc, capture, v) => Promise<{ anchor, preview }>} capture  // resolveCapture, every capture kind
 * @property {(ctx, doc, head) => Promise<WorkingState>} workingState         // readWorkingState callers
 * @property {(snap, thread, opts) => ThreadView} describeThread              // packetThread, showThread, threads()
 * @property {(ctx, doc, snap) => Promise<void>} loadExtra                     // loadSnapshot add-ons (code: blobs)
 */
export function kindOf(doc) // -> fileKind (file and snapshot docs: today's code, moved without behaviour change)
                            //    | codeKind (delegates to src/core/code/*; stubs until WP3)
```

Whole ops that differ for code docs dispatch at the **op entry**, on `doc.kind === 'code'`. They never dispatch on
the capture kind or on whether a `file` argument is present.

| Op (existing file) | For a code doc |
|---|---|
| `revise` (`ops/revise.js`) | `code/round.js` `reviseCode(ctx, doc, input)` |
| `recordReviewerVersion` (UI "Re-snapshot") | `recordCodeRound(ctx, doc, {author: human, capturedBy: 'ui-record'})` |
| `applySuggestions` (`ops/edits.js`) | `code/apply.js` `applyCodeSuggestions(ctx, doc, tids, {dryRun, actor})` |
| `applySuggestionAsReviewer` | `applyCodeSuggestions(…, {actor: human})`, then `recordCodeRound(…, {capturedBy: 'ui-apply'})` |
| `addLock` (`ops/locks.js`) | refuse before any render: "code reviews have no locks" |
| `taggedEdits`, `revert` | refuse (exit 3): "code docs: edit the files with your own tools; `specreview revise <doc>` records the round" |
| `ask`, `reanchorThread` (`ops/threads.js`) | `code/threads.js` `askCode`, `reanchorCode`. Without `file`, the question becomes a whole-review (doc-level) thread. |
| `changes`, `sourceDiffOp`, `unifiedDiff`, `threadMiniDiff` (`ops/changes.js`) | `code/files.js` `codeChanges`, `codeFileDiff`, `codeUnifiedDiff`, `codeThreadMiniDiff` |
| `domTargets` | empty lists |
| `docState`, `status` (`ops/docs.js`) | `docState.working` from `kindOf(doc).workingState`; `status.file` is null |
| `final` decisions export | written into the doc dir (`.specreview/docs/<id>/decisions.md`, git-ignored) unless `--out`. A file in the cwd would join the next round. |
| packet header, basis, NEXT (`packet-data.js`) | `code/packet.js` `codePacketLabel`, `codeLineBasis`, `codeNextStep` |
| daemon targets outline fallback (`api.js`) | empty |
| content origin (`content.js`) | 404 for every route |
| `daemon/watch.js` | no chokidar watcher and no stat poll (`isVirtual`); WP4 adds the code poller (4.13) |

**`isSnapshot` classification.** WP0b adds `isVirtual(doc)`, which is true for snapshot and code docs, and
`isCode(doc)`. Each of the ~35 current `isSnapshot` call sites gets one of three outcomes:

| Outcome | Call sites |
|---|---|
| stays `isSnapshot` | `revise.js` snapshot profile and `--source` handling, `packet-data.js` snapshot NEXT and lines, `snapshot.js` ops, `ThreadCard` |
| becomes `isVirtual` | `store.js` (`workingPath`, `readWorking`, `writeWorking`, `findDoc`, `findDocByOrigin`, `createDoc` duplicate check), `record.js` asset skips and `autoCommit` `docPath`, `common.js` `changedWorkingAssets`, `content.js:370`, `watch.js`, `doctor.js`, `hooks.js` `pre-write`, `Home.js` |
| becomes kind dispatch | `common.js` `refuseSnapshot` ordering (code apply is dispatched **before** the snapshot refusal), `api.js` and `docs.js` `kind` field (they emit `'code'`), `final.js` |

The full list goes into a comment in `kinds.js`. A grep test fails on any new unclassified use.

**Contract test** (`test/unit/review-kind-contract.test.js`, WP0b):
- Build a code-doc fixture: `createSnapshotDoc({kind: 'code'})` plus two committed `.diff` versions with hand-written
  `manifest.code`.
- Call **every** export of `ops.js` and **every** daemon `D/*` route on it.
- Each call must return a result or a typed error (`UsageError`, `RefusedError`, `NotFoundError`), **never** a
  `TypeError`.
- After a submit across rounds, a code-anchored draft must keep its `anchor.file` and line numbers. This guards
  against `forwardAnchor` corrupting anchors.
- Until WP3 lands, the code stubs throw `UsageError('code review is not available in this build')`. The contract
  test accepts that.

Also in WP0b:
- `formatOf` (`anchor/util.js`) and `envOf` (`anchoring.js`) treat `'text'` as identity. A code quote is never
  Markdown-stripped.
- `recovery.js` `DOC_SUBDIRS` adds `blobs`, and recovery sweeps stale `code-index-*` temp dirs.

### 2.10 Record seams (`ops/record.js`, WP0b)

These are optional overrides on `Prepared`. When they are absent, behaviour is exactly as today.

```js
/** @property {(item, prev: Anchor, linkIds: string[], extra) => Anchor} [stepFor]   // replaces stepAnchor in versionJournal
 *  @property {(thread, linkedHunks) => boolean} [landed]                             // replaces suggestionLanded
 *  @property {Record<string, string|null>} [assetFiles]                             // code: {}
 */
commitRecord(ctx, doc, prep, { …, capturedBy /* adds 'round' */, manifestExtra /* origin; adds code */ })
```

- The manifest hunk projection (`record.js:268-277`) passes `file` through. Today it drops it.
- `respondsToOf(reviews, agent)` moves from `revise.js` to `common.js` and is exported.

**Plan re-captures (WP0a).** `revise(ctx, ref, input, snapshot)` gains `snapshot.autoAddressLinked: boolean`, which
only the plan gate sets:
- After attribution, an actionable thread that is linked to a hunk of vN→vN+1, and that has no explicit reply in
  `input.threads`, becomes `addressed`.
- It gets a reply `{author: agent, auto: true, body: "changed in v<N+1> (L<a>-<b>)"}`.
- Unlinked threads stay open.

### 2.11 Revise input grammar (`src/cli/schemas.js`, `args.js`, `ops/threads.js`)

- **WP0a:** `ReviseInputSchema` gains `source?: string`. It is the full new text for snapshot docs, and the same as
  `--source`. MCP `specreview_revise` uses it.
- **WP0b:** the `at` forms for code docs.
  - `src/core/util/code-at.js` (pure, frozen) exports `parseCodeAt(s) -> Array<{file, startLine, endLine}>` and
    `parseCodeOtherAt(s) -> {file, lines} | {file, hunk, del}`.
  - Paths are parsed **from the right**: `/:L(\d+)(?:-L?(\d+))?$/`. A path containing `,` must be double-quoted inside
    a list.
  - Accepted forms: `src/a.js:L12-14`, `"a,b.js":L3`, `src/a.js:L12,src/b.js:L3-4`, `src/a.js#h3`, `del:src/a.js#h3`.
  - Paths may be repo-root-relative, cwd-relative or absolute. They are resolved against the round's file list, and
    an ambiguous path gives exit 3 with the candidates.
  - The schemas accept `LinesAt | CodeAt` syntactically. The op validates per kind: a spec doc refuses path forms; a
    code doc accepts a bare `L12` only when the thread anchors exactly one file.
  - `normalizeAt` passes path forms through. `addAgentReply` stores `atFile`.
  - `lines-arg.js` is unchanged.

### 2.12 CLI and MCP registries (WP0a; WP0b adds the `specreview_review` MCP tool)

WP0a adds every new registry entry, each with a **stub module that already exports the final `spec`** (usage and
options):
- each stub's `execute` throws `UsageError('<command> is not available in this build')`;
- because the final `spec` is there, `docs-cli.test.js` loads every entry and can check every flag from day one.

```js
snapshot:  { load: () => import('./snapshot.js'),  summary: 'Snapshot a web page for review (uses the network)', group: 'loop' },     // stub WP0a -> WP2
review:    { load: () => import('./review.js'),    summary: 'Open a code review of your changes (since-base, uncommitted, staged, range, commit)', group: 'loop' },  // stub WP0a -> WP3
uninstall: { load: () => import('./uninstall.js'), summary: 'Remove what install wrote (dry run unless --apply)', group: 'admin' },    // stub WP0a -> WP5
```

- The `hook` summary becomes `hook pre-write | hook prompt | hook plan-notes`. WP0a adds a `plan-notes` branch to
  `runHook` that prints nothing; WP1 fills it in.
- `test/integration/docs-cli.test.js` `SUBCOMMANDS` becomes `{hook: ['pre-write','prompt','plan-notes'], install:
  ['claude','agents-md']}`. WP5 extends it with the agent ids from `feat/installer`.

**MCP** (`src/mcp/tools.js`). Each tool maps onto a command's `execute`, as today.

| Tool | Input | Notes |
|---|---|---|
| `specreview_open` (extended, WP0a) | `{path?, text?, title?, name?, workspace?}`, exactly one of `path` and `text` | `text` goes through `open -` (WP0a adds the `stdinText` branch, 3 lines, to `open.js`) |
| `specreview_revise` (extended, WP0a) | adds `source?: string` | snapshot docs |
| `specreview_snapshot` (WP0a; implemented by WP2) | `{url, title?}` | **No** `allow_private`, `reader` or `as_html`. Public hosts only; honours the user-level `network.allow`. |
| `specreview_review` (WP0b; implemented by WP3) | `{mode?, base?, range?, commit?, paths?, title?, workspace?}` | **No** `pr`: PR mode is CLI-only. |

### 2.13 Daemon health and restart (WP0a)

- `GET /api/health` adds `buildId`, a sha256 over the package version plus the mtimes of `src/**`, computed once at
  start.
- `ensureDaemon` restarts a running daemon whose `buildId` differs. Today it compares versions only, so an old daemon
  would keep serving the new kinds.
- `GET /api/health?ws=<wsId>&doc=<docId>` adds `docClients`, the number of SSE subscribers on that doc (`sse.js` gets
  a per-doc count). The plan gate opens a tab only when `docClients === 0`. A global count would let a tab left on
  Home stop the plan tab from opening.
- The submit route passes `meta.planApproveMode` through. It is validated, and accepted only for plan docs.

### 2.14 UI kind seam (WP0a banners; WP0b everything else)

- **WP0a** adds `src/ui/components/kinds/index.js` with `KindBanners({ds})`, and the placeholder
  `kinds/PlanBanner.js` (it returns `null`; WP1 replaces it). `App.js` `DocView` renders `<KindBanners/>` above the
  banner stack. When `KindBanners` returns non-null, it **replaces** the stack.
- **WP0b** extends `kinds/index.js`:
  - `KindMain({ds})` replaces `<DocFrame/>` when non-null;
  - `KindRail({ds})` replaces `<Outline/>`;
  - `KindSide({ds})` replaces the SidePanel content in `changes` mode;
  - `kindCaps(ds)` returns `{frame, pick, snip, hide, pageErrors, applyNow, liveBanners, locks}`.

  WP0b edits the consumers so WP4 never has to: `App.js`, `SidePanel.js`, `TopBar.js` (tool slots), `StatusBar.js`
  (page errors), `ThreadCard.js` (Apply now) and `ThreadPanel.js` (`targetStates`; "General comment" captures
  `{kind: 'doc'}`, which a code doc accepts as a whole-review thread).
- **Modes.**
  - `modesFor(ds)` (`model.js`) replaces the hard-coded mode lists in `actions.setMode`, `keys.js`, `TopBar.js`,
    `commands.js` and `state.js`.
  - Code docs **reuse the mode key `review`**, labelled "Files", for the review diff. They also have `changes` and
    `history`. The 12+ `'review'` defaults in `actions.js` therefore keep working.
- **Focus.** `actions.focusItem` calls a registered kind focus handler (`registerKindFocus(fn)`) when
  `kindCaps.frame` is false, instead of posting `MSG.FOCUS`.
- **Card targets.** `targetLabel` (`model.js`) prints `src/a.js:L3-4`, `src/a.js (old side) L3-4` or
  `src/a.js (whole file)` for `anchor.file`.
- **Placeholders** `kinds/CodeReviewView.js`, `kinds/FileTree.js`, `kinds/CodeBanner.js` and `kinds/CodeSide.js`.
  They return `null`, and WP4 replaces them. `KindBanners` dispatches plan docs to `PlanBanner` and code docs to
  `CodeBanner`. `KindSide` dispatches code docs to `CodeSide`.

### 2.15 Hermetic tests (WP0a; used by every WP)

`test/helpers/hermetic-env.js` exports `hermeticEnv(tmp, extra)`:
- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`
  and `SPECREVIEW_HOME` all point into `tmp`;
- `PATH` is `<tmp>/bin:/usr/bin:/bin`, a fake-bin dir with no `gh`, `claude`, `codex` or `gemini`;
- `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`;
- every other `GIT_*`, `CLAUDE*` and `CODEX*` variable is deleted;
- `SPECREVIEW_BROWSER=none` and `SPECREVIEW_OFFLINE=1`.

It also exports `GIT_TEST_ARGS`: `-c init.defaultBranch=main -c user.name=t -c user.email=t@example.invalid -c
commit.gpgsign=false -c core.autocrlf=false -c core.hooksPath=/dev/null -c protocol.file.allow=always`, used with fixed
`GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE`.

Rules:
- Spawned tests use `hermeticEnv` as their **complete** env.
- In-process tests set `process.env.HOME` to a temp dir at the top of the file.
- New code reads HOME from the injected env only, never from `os.homedir()`.
- A canary test runs the CLI suite with `HOME` pointing at a read-only directory, and fails on any write there.
- Playwright specs that need Chrome **fail** when it is missing, rather than skip.

---

## 3. F1: the plan-mode gate

### 3.1 What the user sees

1. Claude finishes a plan in plan mode and calls ExitPlanMode. Claude Code shows its native "Would you like to
   proceed?" chooser. At the same time `specreview plan-gate` (the PermissionRequest hook) does three things:
   - records the plan as **v1** of a plan doc;
   - opens the review tab, if no tab already shows this doc;
   - blocks.
2. The reviewer comments, suggests and asks in the browser, then submits:
   - **Approve**, or **Approve + accept edits** in the PlanBanner: Claude Code proceeds. Notes on an approving review
     reach Claude after it leaves plan mode (3.6).
   - **Request changes** or **Comment**: ExitPlanMode is denied with the feedback. Claude stays in plan mode, edits the
     plan file in place, writes one reply line per thread, and calls ExitPlanMode again.
3. The next call becomes **v2 of the same doc**:
   - threads re-anchor;
   - threads whose lines Claude changed become `addressed` ("changed in v2 (L14-18)"), and explicit reply lines
     override that;
   - Verify lists them, and the reviewer sees the v1→v2 diff.

   The loop repeats until approval.
4. The user can answer the terminal chooser at any time. The first answer wins. The gate notices (3.7), stops waiting
   and prints nothing. A review submitted afterwards reaches Claude with its next prompt (3.9).
5. **Close session** on a plan doc pauses gating for that plan. Claude Code then asks in the terminal until the doc is
   reopened.

### 3.2 Hook registration (frozen)

The plugin's `hooks.json` (WP6) and the installer (WP5, absolute `"<node>" "<bin>"` form) write these entries:

```json
{ "hooks": {
    "PermissionRequest": [ { "matcher": "ExitPlanMode",
        "hooks": [ { "type": "command", "command": "specreview plan-gate", "timeout": 345600 } ] } ],
    "PostToolUse":       [ { "matcher": "ExitPlanMode",
        "hooks": [ { "type": "command", "command": "specreview hook plan-notes", "timeout": 10 } ] } ] } }
```

- **Never** set `onFailure: "block"`: on PermissionRequest, a failure would then become a deny.
- `plan-notes` is a builtins-only branch of `src/cli/hooks.js`, under the 150 ms hook rule of BUILD_AMENDMENTS 5. It
  prints nothing when there are no notes, so registering it is harmless even if PostToolUse never fires after a hook
  allow (spike S1). The `prompt` hook is the fallback for notes (3.6).

### 3.3 stdin and stdout contract

stdin (Claude Code PermissionRequest; there is no `tool_use_id`):

```json
{"session_id":"00893aaf-…","transcript_path":"/Users/me/.claude/projects/-Users-me-repo/00893aaf-….jsonl",
 "cwd":"/Users/me/repo","permission_mode":"plan","hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode",
 "tool_input":{"plan":"# Refactor auth middleware\n…","planFilePath":"/Users/me/.claude/plans/refactor-auth-snug-otter.md"}}
```

stdout is exactly one JSON line, or **nothing**. The exit code is always 0.

| Outcome | stdout |
|---|---|
| approved | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{...tool_input,"plan":"<reviewed text>"}}}}`. `updatedInput` has been required since Claude Code 2.1.199. When the review's `meta.planApproveMode` is set, or the user-level `plan.approveMode` is, the decision also carries `"updatedPermissions":[{"type":"setMode","mode":"<mode>","destination":"session"}]`. |
| changes requested, or comment | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"<formatPlanFeedback(...)>"}}}` |
| anything else (3.7) | nothing: the native chooser decides |

`hook plan-notes` (PostToolUse) prints, when a notes record exists for `session_id` (3.6):

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<formatPlanNotes text, at most 8000 chars>"}}
```

### 3.4 Algorithm of `plan-gate` (shipped, plus WP1 deltas marked NEW)

1. Parse the arguments; this never fails. Fail open when `SPECREVIEW_PLAN_GATE=off` or the user-level `plan.gate` is
   false (NEW). Read stdin (8 MiB cap, 30 s). Continue only for `tool_name === 'ExitPlanMode'` with
   `hook_event_name` absent or `PermissionRequest`.
2. **NEW: subagents.** When `agent_id` is present, fail open, unless the user-level `plan.gateSubagents` is set. When
   it is set, `agent_id` joins the key, so a subagent's plan never becomes vN of the main plan.
3. **Plan text.** Use the plan file when all of these hold:
   - it is an absolute `.md` path;
   - it is a regular file of at most 2 MiB;
   - it is non-empty;
   - **NEW:** its realpath lies under `${CLAUDE_CONFIG_DIR:-~/.claude}/plans/`, or under the git top level of `cwd`
     (Claude Code requires `plansDirectory` to stay inside the project).

   Otherwise use the inline `tool_input.plan`. When there is neither, fail open. `planFilePath` is passed to the
   formatter only when the text came from the file.
4. **Workspace.** NEW: `snapshotWorkspace(grt, cwd, {createInRepo: false})`.
   - Use a store at or above `cwd` when one exists.
   - Otherwise use the scratch workspace `scratchRootFor(gitTopLevel(cwd) ?? cwd)`.
   - The implicit gate never creates `.specreview/` in a repo.
5. **Record.** `takeSnapshot(ctx, {source, format: 'markdown', origin, slug, autoAddressLinked: true, replies})`.
   - `origin` is the shipped `{type: 'plan', key, session, planFilePath, cwd, transcript}`.
   - `replies` are the reply lines of 3.5, when spike S3 allows them.
   - NEW: if the doc is closed, `takeSnapshot` records the version, returns `paused: true`, and the gate fails open
     with a stderr note.
6. **Daemon and tab.** `ensureDaemon()`. NEW: open the system browser when `--browser` resolves to `system` and one of
   these holds:
   - `plan.openBrowser` is `always`;
   - it is `auto`, and the doc was just created or `docClients === 0` (2.13).

   Write the review URL to stderr.
7. **NEW: gate marker.** Write `$SPECREVIEW_HOME/plan-gate/<sha256(session)[:16]>.json` with `{pid, root, wsId,
   doc, version, createdAt}`. The marker is removed after a decision is printed. It stays (with a dead pid) otherwise,
   so the late-review path of 3.9 can find the doc.
8. **Wait** (shipped):
   - `waitForFeedback(ctx, {docIds: [doc], allowDirty: true, minVersion: head, signal, write})`;
   - the **decision is computed and printed inside `write`**, so delivery is recorded only after stdout is flushed;
   - SIGTERM, SIGINT and SIGHUP abort the wait;
   - `--timeout` aborts it.

   NEW liveness checks (3.7) also abort it.
9. **Decide** (inside `write`):
   - **approved:** allow with `updatedInput.plan` set to the reviewed text, plus `updatedPermissions` as in 3.3.
     NEW: when the review has a non-empty summary or still-open threads, write the notes record first (3.6).
   - **changes requested or comment:** deny with `formatPlanFeedback(packet, {planFilePath, maxChars:
     LIMITS.packetChars, overflowPath, replyLines})`. `overflowPath` comes from 2.6. `replyLines` is true when S3
     passed.

There is **no plan-file write-back** on approve. Reviewer edits of plans are "later", so the head text always equals
the captured text.

### 3.5 Versions, statuses and replies across ExitPlanMode calls

| Situation | Effect |
|---|---|
| First ExitPlanMode for a plan file in a session | a new doc, v1 |
| The next call, with the plan file edited | vN+1 of the same doc. Threads re-anchor. Linked threads with no explicit reply become `addressed` (2.10). Verify lists them. |
| The next call, with the plan unchanged, and an undelivered review on head | no new version; that review is delivered at once |
| The next call, with the plan unchanged, and nothing undelivered | no new version; the gate waits for a new review. The banner says "Claude resubmitted vN unchanged". |
| Undelivered reviews on older versions | delivered with the next delivery (the `minVersion` rule) |
| `/fork` | a new session and its own plan file give a new doc. Resume keeps the session, and so the doc. |
| Two gates for the same doc | the newer waiter supersedes the older one, which then prints nothing |

**Reply lines** (WP1; enabled only if spike S3 shows the transcript is current when the hook fires):
- The deny message asks for one line per thread in Claude's reply text: `t3: addressed - <what changed>`,
  `t1: answered - <answer>`, `t2: declined - <why>`.
- On the next ExitPlanMode, the gate reads the transcript tail after the deny `tool_result`. It uses the shipped
  `readTranscript` with the active-branch rule.
- It parses `^\s*t(\d+):\s*(addressed|answered|declined|needs_input)\s*[-–—:]\s*(.+)$`.
- It passes the lines to `takeSnapshot` as `replies`. Explicit lines override the automatic status.
- When S3 fails, `replyLines` stays false. The deny message then omits the instruction, and only automatic statuses
  apply.

### 3.6 Approve with notes

- On an approving review with a summary or open threads, the gate writes
  `$SPECREVIEW_HOME/plan-notes/<sha256(session)[:16]>.json`: `{session, root, wsId, doc, review, version,
  createdAt, text}`. `text` is `formatPlanNotes(packet)`.
- `formatPlanNotes` (WP0a, `packet.js`; golden file `plan-notes.txt`):
  - header: `SpecReview: the reviewer APPROVED plan vN (<doc>) with notes (non-blocking).`;
  - the summary;
  - the threads as notes, where `src>` gives location only;
  - footer: `Do not edit the plan file or call ExitPlanMode again. Apply these notes while implementing, and say in
    your summary how you handled each.`
  - It has no PROTOCOL line and no `snapshotNextStep`.
  - Variant `{late: true, verdict}`, for reviews submitted after the gate stopped waiting: the header says "after the
    plan gate stopped waiting", and a non-approving verdict adds: "If you are still planning, make targeted changes
    to the plan file and call ExitPlanMode again; otherwise tell the user how you will handle these points."
- **Delivery, in two phases:**
  1. The approved review is marked delivered to `claude` when the allow decision is flushed. That is the decision.
  2. The notes record is consumed by the first of two consumers:
     - `hook plan-notes` (PostToolUse right after approval, if S1 holds);
     - `hook prompt` (the user's next prompt). Its `UserPromptSubmit` output carries the same text.

     The consumer prints the text and renames the record to `.consumed`.

  Records older than `PLAN_GATE.NOTES_TTL_MS` (1 h) are dropped by both consumers.
- If the notes would exceed 8000 characters, the overflow file of 2.6 holds them in full. The printed text ends with
  `Read <path> for the rest`.

### 3.7 Fail-open table (the gate prints nothing; the native chooser decides)

| Case | Detection | Note |
|---|---|---|
| The user answers the terminal chooser | SIGTERM, SIGINT or SIGHUP, or a closed stdout (shipped). NEW liveness checks, polled every 2 s: `process.ppid` changed; `process.stdout` emitted `error` or `close`; the transcript gained a `tool_result` for the newest ExitPlanMode `tool_use` (this one runs regardless of spike S2, because it is cheap and covers the case where Claude Code discards the hook without killing it). | The waiter is removed and nothing is marked delivered. The marker stays for 3.9. |
| The browser tab is closed and nobody reviews | `--timeout`, or Claude Code's hook timeout (96 h) | The terminal stays usable throughout. |
| The reviewer clicks "Close session" | `closed` | Gating is paused for this plan (3.8). |
| The daemon cannot start, or a store, lock or parse error, or any exception | catch-all | Logged to stderr and `$SPECREVIEW_HOME/logs/plan-gate.log`. |
| The gate is disabled, or the call comes from a subagent | env, user config, `agent_id` | |
| `claude -p` with a permission host | the hook races the host | Fail open applies. |

### 3.8 Workspace placement and pausing

- **Placement.** The gate never creates a store (3.4 step 4). Plan docs therefore live in the repo store when one
  exists, or else in the scratch workspace for the repo. Both are ephemeral (2.5). `docRefFor` adds `--workspace` for
  scratch docs.
- **Pausing.** A closed plan doc pauses gating for that plan file in that session (2.1). Reopening it in the UI resumes
  gating. A new planning thread (a new plan file) is gated again. For a global off switch, use
  `SPECREVIEW_PLAN_GATE=off`, or `plan.gate: false` in the user config.

### 3.9 Late reviews (the gate is no longer waiting)

There is no next ExitPlanMode when one of these happens:
- the user answered in the terminal;
- the gate timed out;
- the session restarted.

`hook prompt` (WP1, builtins only) therefore checks, for the hook's `session_id`:
1. an unconsumed notes record (3.6), which it prints;
2. a gate marker whose `pid` is dead, where the doc's `reviews/` holds a review at or after the marker's version that
   is undelivered to `claude`. It prints:

   ```text
   SpecReview: the reviewer submitted a review of plan v3 after the plan gate stopped waiting. Run `specreview feedback <ref>` to read it.
   ```

   `<ref>` includes `--workspace` for scratch workspaces. `feedback <plan-doc>` prints `formatPlanNotes({late:
   true})` and marks the review delivered, because no gate is live (2.6).

The UI "Copy prompt" text (`agentPrompt(ds)` in `model.js`, changed by WP0a so that WP1 never touches `model.js`)
becomes kind-aware:
- a plan doc says "Claude sees this the next time you message it";
- a scratch doc appends `--workspace <root>`.

### 3.10 PlanBanner (WP1, `src/ui/components/kinds/PlanBanner.js`)

It is mounted through `KindBanners` when `origin.type === 'plan'`. It reuses the `.banner-*` classes. Its states:

| State | Detection | Text |
|---|---|---|
| The gate is waiting | a live waiter for this doc (presence data in DocState) | "Claude is waiting at ExitPlanMode for your verdict on vN. Approve lets it proceed. Request changes or Comment sends your threads back; its next plan arrives here as vN+1." Buttons `PLAN_TESTID.approve` ("Approve plan") and `PLAN_TESTID.approveEdits` ("Approve + accept edits"). Both submit an approving review, with any drafts, through the existing submit route. The second sets `meta.planApproveMode: 'acceptEdits'`. |
| Resubmitted unchanged | `waiter.since` is later than the head's `createdAt` | "Claude resubmitted vN unchanged." |
| A new version with automatic statuses | in the head manifest | "k threads changed in vN (marked addressed; Verify them); m threads not touched." |
| Not waiting, with an undelivered review | no live waiter | "Claude is not waiting (answered in the terminal, or timed out). Your review reaches Claude with its next prompt." |
| Paused | `doc.state === 'closed'` | "Gating is paused for this plan: Claude Code asks in the terminal. Reopen to resume." |

### 3.11 Agent protocol (WP6)

The skill, the AGENTS snippet and the reference get these rules:
- A denied ExitPlanMode that starts with `YOUR PLAN WAS NOT APPROVED` is reviewer feedback: follow WHAT TO DO.
- Edit the plan file in place. Never write a new plan file.
- Write the reply lines when asked to. Do not resubmit the plan unchanged unless you only answered questions.
- Do not run `specreview wait` on plan docs.
- Context starting with `SpecReview: the reviewer APPROVED plan` holds non-blocking notes.

### 3.12 Example deny message (this exact text goes to Claude)

```text
YOUR PLAN WAS NOT APPROVED: the reviewer requested changes (SpecReview rv2 on v2).
Plan file: /Users/me/.claude/plans/refactor-auth-snug-otter.md   (line numbers below are lines of this file)
Reviewer summary: Close. The session migration is the risky part; make it reversible.
2 threads need action (1 new, 1 reopened): 1 blocking · 1 question

[t3] blocking · comment · L14-15 · §Steps > 3 Migrate sessions
  src> 3. Migrate sessions: drop the `sessions` table and recreate it with the new
  src>    `family_id` column.
  Eric: Dropping it logs everyone out. Add the column, dual-write for a day, then backfill.

[t1] REOPENED · question · L4 · §Context
  src> Refresh tokens move to Redis.
  you (v2, auto): changed in v2 (L4)
  Eric: Which Redis? We have two clusters. The cache cluster evicts under memory pressure.

DECISIONS to keep true: D1 (t2) keep HMAC signing of access tokens
WHAT TO DO:
- Make targeted changes to /Users/me/.claude/plans/refactor-auth-snug-otter.md with the Edit tool (src> lines are exact old_string). Never rewrite the whole plan or write a new plan file.
- Address every thread above: change the plan where a thread asks for it; answer questions in the plan if the answer belongs there.
- Before calling ExitPlanMode again, write one line per thread in your reply: `t3: addressed - <what changed>`, `t1: answered - <answer>`, `t2: declined - <why>`.
- Do not resubmit the plan unchanged unless you only answered questions.
- Then call ExitPlanMode again. The reviewer will see a diff of your changes (v2 -> v3).
```

The reply-line bullet appears only when `replyLines` is true.

### 3.13 Security

- The gate reads only the plan file named by Claude Code, under the checks of 3.4 step 3. It never writes the plan
  file.
- The deny text and the notes text are the reviewer's own words plus quotes of the plan. Nothing from the network
  enters them.
- `approveMode` comes only from the user config or from the reviewer's button, never from a repository (2.4).
- Plan docs are served under the strict CSP and sandbox (2.7).

### 3.14 Gemini CLI and other agents' plan gates

Not built in this round (section 11). The Gemini `BeforeTool` payload (`plan_filename` against the documented
`plan_path`) and its confirmation order are unverified. A fixture-only adapter would test our own guess. The Codex
Stop hook, Copilot `preToolUse` and OpenCode plugin gates are deferred for the same reason. See open question Q1.

---

## 4. F2: code review

### 4.1 What the user sees

1. **Open.** "Review my changes": the agent or the user runs `specreview review`.
   - A code doc is created for the default spec: the merge-base with the default branch, up to the working tree,
     untracked files included.
   - Round v1 is recorded.
   - The browser opens on a file tree, with one diff card per file.
2. **Review.** The reviewer selects lines on either side and comments. Click a line number, then shift-click to extend
   the selection. The reviewer can also:
   - suggest a replacement (new side only);
   - comment on a whole file (needed for binary or too-large files);
   - submit approve, changes requested or comment.
3. **Feedback.** The agent's background `specreview wait <doc>` prints a packet. Each item cites a repo-relative
   `path:line` in the working tree, and its `src>` lines are usable as an Edit `old_string`.
4. **Round.**
   - The agent edits the files, or runs `specreview apply` for suggestions.
   - It runs `specreview revise <doc> --replies -`, which re-snapshots the diff as **round v2**, links hunks to
     threads and posts the replies.
   - It runs `wait` again.
5. **Verify.** The reviewer gets v2 live:
   - **Changes** shows the interdiff v1→v2 per file, with thread chips;
   - **Verify** works on addressed threads;
   - **Files** shows the full review diff at v2.

   Repeat until approval. `specreview final <doc>` works as for specs.

### 4.2 CLI: `specreview review` (WP3)

```text
specreview review [<range>] [--uncommitted | --staged | --base <ref> [--committed] | --commit <sha>]
                  [--path <pathspec>]... [--context N] [--max-files N] [--title T]
                  [--browser pane|system|none] [--workspace <dir>] [--json]
specreview review --pr <n|url> ...                                   (WP3b, optional; 4.18)
```

| Invocation | Mode | Old side | New side |
|---|---|---|---|
| `review` (default) | `since-base` | `merge-base(<default base>, HEAD)` | working tree, untracked included |
| `review` on the default branch, detached, or with no base found | `uncommitted` | HEAD (the empty tree if HEAD is unborn) | working tree, untracked included |
| `review --uncommitted` | `uncommitted` | HEAD | working tree, untracked included |
| `review --staged` | `staged` | HEAD | the index |
| `review --base main` | `since-base` | `merge-base(main, HEAD)` | working tree |
| `review --base main --committed` | `branch` | `merge-base(main, HEAD)` | `HEAD^{tree}` |
| `review A..B` | `range` | A | B |
| `review A...B` | `range` (three-dot) | `merge-base(A, B)` | B |
| `review --commit <sha>` | `commit` | `<sha>^` (the empty tree for a root commit) | `<sha>` |

**Default base detection**, in order:
1. `code.defaultBase` from config.
2. `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, verified with `git show-ref --verify --quiet`.
3. The first existing local branch among `main`, `master`, `trunk`, `develop`.
4. None: use `uncommitted`.

There is no `git fetch`. A stale `origin/main` gives an older merge-base, which is acceptable and offline.

**Workspace.**
- A code doc lives in the workspace at `git rev-parse --show-toplevel`. The store is created there if it is missing,
  as `open` does, because `review` is an explicit verb.
- `--workspace` overrides this.
- Git version below `GIT_MIN_VERSION`: exit 1, with a hint.

**Identity and re-runs.**
- The origin key is `diff:<mode>:<canonical spec>`, for example `diff:since-base:origin/main`, `diff:uncommitted`,
  `diff:range:main..HEAD` or `diff:commit:<sha40>`. When `--path` is given, `+paths=<sorted>` is appended.
- Re-running `review` with the same spec records a new round if the snapshot changed, and is otherwise a no-op. It
  reopens a closed doc (2.1). Either way it opens the tab.
- Doc ids:
  - `cr-<branch-slug>` for since-base and branch;
  - `cr-uncommitted`;
  - `cr-staged`;
  - `cr-<a>-<b>` for a range;
  - `cr-<sha7>` for a commit.

  On a collision, `-2`, `-3` and so on are appended.

**Exit codes:**

| Exit | When |
|---|---|
| 0 | the review is open (created, or re-opened with or without a new round) |
| 1 | not a git repository; git too old; a git failure |
| 3 | refused: more files than `code.maxFiles` (narrow with `--path` or raise `--max-files`, up to the hard maximum); unmerged index entries (`--staged`); more than `untrackedExcludeMax` large untracked files |
| 4 | the base, range end or commit was not found; there are no changes between the two sides ("nothing to review") |

**JSON** (`--json`, and the MCP `structuredContent`):

```json
{"doc":"cr-feat-token-refresh","kind":"code","created":true,"version":1,"recorded":true,
 "mode":"since-base","base":"origin/main","baseSha":"1a2b3c4d…","headSha":"9f8e7d6c…","newSha":null,"worktree":true,
 "root":"/Users/me/repo",
 "files":[{"path":"src/auth/refresh.js","status":"M","added":12,"removed":3},
          {"path":"test/refresh.test.js","status":"A","added":40,"removed":0},
          {"path":"src/auth/session.js","oldPath":"src/auth/sessions.js","status":"R","added":2,"removed":2}],
 "skipped":[{"path":"assets/logo.png","reason":"binary"},{"path":".env","reason":"excluded"}],
 "stats":{"files":5,"added":120,"removed":30},
 "url":"http://127.0.0.1:4777/d/ab12cd34/cr-feat-token-refresh?k=…","wsId":"ab12cd34","ref":"cr-feat-token-refresh"}
```

**Text:**

```text
specreview: code review cr-feat-token-refresh v1 · since-base origin/main (merge-base 1a2b3c4) .. working tree
  5 files · +120 -30 · skipped: assets/logo.png (binary), .env (excluded: looks like a secret)
  review UI: http://127.0.0.1:4777/d/ab12cd34/cr-feat-token-refresh?k=…
next: run `specreview wait cr-feat-token-refresh` in the background
```

**Other commands on code docs:**

| Command | Behaviour |
|---|---|
| `revise <doc> [--replies -] [-m] [--dry-run]` | Re-snapshots per `doc.code` (4.6). A changed snapshot records a round. An identical one with replies posts the replies only. NEW: when a reply says `addressed`, the snapshot is unchanged, and the mode cannot see working-tree edits (staged, branch, range by ref), it exits 3 with the missing step, for example "stage your changes with `git add` first". |
| `wait <doc>` | Exits 3 (`dirty`) when reviewed files changed after the last round (4.13), unless `--allow-dirty`. `wait --all` never checks code docs for dirtiness (2.6). |
| `apply <doc> <tid…> [--dry-run]` | Splices suggestions into the real files (4.11). Exit 0, or 3 on a conflict. |
| `edit`, `revert` | Refused (exit 3). |
| `ask <doc> --file <path> --lines A-B -m <q>`; `reanchor <doc> <tid> --file <path> --lines A-B` | The lines are lines of the working file now, mapped to the head blob. `--file` is new on both (WP3). |
| `diff <doc> [vA..vB] [--stat\|--unified]` | The interdiff per file (4.12). WP3 owns `diff.js`. |
| `show <doc> <tid>` | As today, with `path:L..` targets. |
| `show <doc> --file <path> [--version N] [--side old\|new] [--lines A-B]` | Prints blob lines (WP3 owns `show.js`). |
| `final <doc> [--decisions]` | The decisions file goes into the doc dir unless `--out` (2.9). |
| `threads`, `log`, `status`, `close`, `feedback` | Unchanged. `status` prints `kind: code · mode since-base · 5 files`. |

### 4.3 The git layer (`src/core/code/git.js`, WP3)

Every git call goes through one helper:

```js
gitx(args, { cwd, input, indexFile, maxBuffer = 64 << 20, timeoutMs = 30000, okCodes = [0] })
  -> Promise<{ code: number, stdout: Buffer, stderr: string }>
// execFile('git', [...PREFIX, ...args]); never a shell
// PREFIX: --no-pager -c color.ui=never -c color.diff=never -c core.quotePath=false -c diff.external=
//         -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=<empty dir>
//         (<empty dir>: /dev/null on POSIX; on Windows a fresh empty temp dir)
// env: process.env MINUS GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
//      GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, GIT_NAMESPACE, GIT_EXTERNAL_DIFF, GIT_DIFF_OPTS, GIT_PAGER,
//      GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT (and GIT_CONFIG_KEY_*/VALUE_*);
//      PLUS GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0, LC_ALL=C, and GIT_INDEX_FILE=<indexFile> when given
// user revs always follow --end-of-options; diff commands add --no-ext-diff --no-color --no-textconv
// cwd = the top level (computed once per round)
```

**Pathspecs.**
- The user's `--path` values keep their pathspec magic.
- Every pathspec built from a repo path is `:(literal)<path>`.
- Always appended:
  - `:(exclude,glob)**/.specreview/**`, which also covers nested stores;
  - the large-untracked and secret excludes below, as `:(exclude,literal)<path>`.

**New side of worktree modes** (`since-base`, `uncommitted`): a temporary index tree. One tree-to-tree diff then gives
untracked files, deletions and renames, while respecting `.gitignore`.

```text
dir = fs.mkdtemp(<SPECREVIEW_HOME>/ws/<wsId>/cache/code-index-)      # unique per call; removed in finally
cp "$(git rev-parse --git-path index)" dir/index                     # keeps the stat cache
                                                                     # (no index / unborn: read-tree --empty)
GIT_INDEX_FILE=dir/index git add -A -- <pathspecs>
newTree = GIT_INDEX_FILE=dir/index git write-tree
```

- **`staged`:** the same copy of the real index, then `write-tree` on the copy. The real index (and its
  `index.lock`) is never touched. Unmerged entries make it fail, which gives exit 3.
- **`branch`, `range`, `commit`:** `newTree = <newSha>^{tree}`.
- **Old side:** `<baseSha>^{tree}`, or the empty tree from `git hash-object -t tree /dev/null` (cached).
- **Hooks do not run.** `core.hooksPath=<empty>` stops `post-index-change`, which `add` would otherwise fire.
- **Clean filters** (LFS, git-crypt) still run during `add`. This is documented. The new side's bytes are read from
  disk anyway (below), and the tree is only used for name-status.
- **Objects.** Loose objects written by `add` are unreachable, and git's gc prunes them. Secrets are kept out by the
  next rule.

**Untracked files**, before `add -A`. Run `git ls-files -z --others --exclude-standard -- <pathspecs>`, then `lstat`
each file:
- **Over `codeFileMaxBytes`:** excluded and listed as `{status: 'A', tooLarge: {side: 'new', bytes}}`.
- **Matching the key-file patterns of `isDeniedPath`** (`.env*`, `*.pem`, `id_rsa*`, `*.key` and so on; not its
  dot-dir rule): excluded and listed as `skipped: {reason: 'excluded'}`. The round report names them. No object is
  written for them.
- **More than `untrackedExcludeMax` exclusions:** exit 3, "add these to .gitignore".

**File names.** A path is skipped as `{reason: 'unsupported-name'}`, and shown as a stub, when it:
- contains a control character (`\x00-\x1f`, `\x7f`);
- is not valid UTF-8;
- begins with `-`.

The canonical text, packets and the UI therefore never carry forgeable names. A path containing `:` or `,` is allowed:
`at` is parsed from the right, and quoting handles the `,` (2.11).

**Name status.** `git diff-tree -r -z -M --name-status --no-ext-diff <baseTree> <newTree> -- <pathspecs>` gives the
letters A, M, D, R<score> and T. Copies are off. R becomes `{status: 'R', path: new, oldPath: old}`.

**Contents.**
- Blob ids come from `git ls-tree -r -z --full-tree <tree> -- :(literal)<paths>`. Sizes come from
  `git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'`.
- Contents come from one `git cat-file --batch` process.
- **For worktree modes, the new side is read with `store.readRepoFile`** (2.8): `lstat`, never following links.
  - A symlink's new side is its `readlink` text.
  - A non-regular file becomes a stub.
  - Symlink targets are never read, on either side.
- A blob over `codeFileMaxBytes`, or over `codeFileMaxLines` lines, becomes a `tooLarge` stub. A missing object (in a
  partial clone) becomes a stub with `bytes: null`.
- A NUL in the first 8000 bytes means binary, which gives a stub and no blob.
- Mode `120000` (symlink): the link text, as a one-line file. Status T marks a type change.
- Mode `160000` (submodule): skipped (`submodule`); the old and new commits are shown in the stub.
- Each text side is stored with `putDocBlob`. `added` and `removed` come from `lineHunks`.

**Merge-base.** Validate with `git rev-parse --verify --quiet --end-of-options <base>^{commit}` (exit 4 when it is
missing), then run `git merge-base --end-of-options <baseCommit> HEAD`.

### 4.4 Storage per round

```text
.specreview/docs/cr-feat-token-refresh/
  .gitignore                  "*"  (code docs are always ephemeral)
  doc.json                    kind "code", format "text", path "code/cr-feat-token-refresh.diff", code: CodeSpec
  versions/0001.diff          canonical diff text (4.5): the version source
  versions/0001.json          manifest with code: CodeManifest, capturedBy 'open'
  versions/0002.diff, .json   round 2 (capturedBy 'round', 'ui-record' or 'ui-apply')
  blobs/ab/ab12…              file sides by sha256, shared across rounds
  threads/, reviews/, …       unchanged
```

```js
/** doc.code: what to diff (fixed for the doc's life)
 * @typedef {object} CodeSpec
 * @property {'since-base'|'uncommitted'|'staged'|'branch'|'range'|'commit'|'pr'} mode
 * @property {string} [base]       ref name as given, or the detected default branch
 * @property {string} [from]       range start (ref or sha, as given)
 * @property {string} [to]         range end (ref or sha, as given)
 * @property {boolean} [threeDot]
 * @property {string} [commit]
 * @property {{ repo: string, number: number, url: string, headRefName: string }} [pr]    (WP3b)
 * @property {string[]} [paths]
 * @property {number} context
 */
/** manifest.code: what one round captured
 * @typedef {object} CodeManifest
 * @property {string} root                 absolute top level at capture time
 * @property {string} baseSha              old-side commit, or the empty tree
 * @property {string | null} headSha       HEAD at capture time
 * @property {string | null} newSha        new-side commit (branch, range, commit, pr); null for worktree and staged
 * @property {string | null} newTree
 * @property {'commit' | 'worktree' | 'index'} newSide   (fixed-endpoint reviews switch to 'worktree' after v1, 4.6)
 * @property {{ from: string, to: string } | null} baseMoved
 * @property {CodeFile[]} files            sorted by path
 * @property {Array<{ path, reason: 'binary'|'too-large'|'submodule'|'excluded'|'unsupported-name' }>} skipped
 * @property {Record<string, { size: number, mtimeMs: number }>} stat   worktree new-side stat cache (4.13)
 * @typedef {object} CodeFile
 * @property {string} path      (the old path for 'D')
 * @property {string} [oldPath] ('R' only)
 * @property {'A'|'M'|'D'|'R'|'T'|'='} status    '=' unchanged against base, carried because an open thread lives there
 * @property {string} [old]     'sha256:<hex>' blob of the old side
 * @property {string} [new]     'sha256:<hex>' blob of the new side
 * @property {true} [binary]
 * @property {{ side: 'old'|'new', bytes: number | null }} [tooLarge]
 * @property {{ old?: string, new?: string }} [mode]
 * @property {number} added
 * @property {number} removed
 */
```

Code blobs do **not** go into the shared `.specreview/assets/` or into `manifest.assets`. Those mean "served by the
content origin" and are meant to be committed.

### 4.5 Canonical diff text (the version source)

SpecReview generates this text from the blobs, not from `git diff`, so its bytes depend only on the contents. It holds
no timestamps.

```text
specreview code review · since-base origin/main (merge-base 1a2b3c4d5e6f) .. working tree
files: 5 · +120 -30 · skipped: assets/logo.png (binary)

diff --specreview a/src/auth/refresh.js b/src/auth/refresh.js
status: M
--- a/src/auth/refresh.js
+++ b/src/auth/refresh.js
@@ -38,6 +38,10 @@
…unifiedPatch body…
```

- Files are sorted by new path.
- "Nothing changed" means the sha256 of this text is unchanged, which is the existing `revise` check.
- A moved base changes the header line, so it records a round even when the per-file diffs are identical.

### 4.6 Rounds

**Who records a round:**
- the agent, with `revise <doc> --replies -`;
- the reviewer, with "Re-snapshot" (`POST D/record`, which reaches `recordCodeRound(…, 'ui-record')`);
- re-running `review` with the same spec (no replies);
- the reviewer's "Apply now", which records a `ui-apply` round right after the splice (4.11).

**What a round re-resolves:**
- **New side:**
  - the working tree, for worktree modes;
  - the index, for staged;
  - `HEAD`, for branch;
  - B, when a range end is a ref name.
- **Base:**
  - re-computed **every round** as `merge-base(spec.base, HEAD)` when the base is a ref name (since-base, branch).
    After a `git merge origin/main` or a pull, the review still shows only the agent's changes;
  - an explicit sha base stays fixed;
  - a range start given as a ref is re-resolved.

  A change is recorded as `baseMoved: {from, to}` and named in the round report and in the packet basis line.
  Old-side anchors re-anchor onto the new base blobs (4.7).
- **Fixed endpoints** (`--commit`, or a range ending in a sha): from v2 on, the new side is the **working tree**,
  restricted to the files of v1 plus the files of open threads (`newSide: 'worktree'`). The old side stays fixed. So
  "review commit X, then fix it in the working tree" stays one doc, with interdiff and Verify.
- **Carried files:** a path that holds an actionable thread, but is unchanged against base in the new round, is kept
  with status `=` and both blobs, so its threads keep their place. A carried file that no longer exists is dropped,
  and its threads orphan ("file removed").

**NEXT per mode** (`codeNextStep`, WP3):

| Mode | NEXT |
|---|---|
| since-base, uncommitted, fixed endpoints after v1 | `edit the files -> specreview revise <ref> --replies - (records round v<N+1> from your working tree) -> specreview wait <ref> (background)` |
| staged | `edit the files -> git add <files> -> specreview revise <ref> --replies - -> specreview wait <ref> (background)` |
| branch, range by ref | `edit -> commit -> specreview revise <ref> --replies - -> specreview wait <ref> (background)` |
| pr (WP3b) | checked out: as the worktree modes. Not checked out: `gh pr checkout <n> -> edit the files -> specreview revise <ref> --replies - -> specreview wait <ref> (background)`. Once HEAD is the PR head, rounds use the working tree. |

### 4.7 Anchoring and re-anchoring

**From capture to anchor** (`resolveCodeCapture`):
- A `{kind: 'line', file, side, startLine, endLine}` capture at version v reads `blob(file@v, side)`, then calls
  `anchorFromLines({…, source: blobText, render: null, format: 'text'})`. It adds `anchor.file = {path, side,
  oldPath?}` and `section: [file]`, and skips widening.
- The preview reads "Agent will see: src/a.js:L42-43", or "(old side) base L40-42".
- Line numbers are the side's own (`newNo` or `oldNo`). A selection may span two hunks of one side and file. The UI
  refuses a selection across files or sides.
- A `{kind: 'file', file}` capture gives a doc-kind anchor with `file: {path, side: 'new'}` (`'old'` for a deleted
  file) and no `src`.
- A `{kind: 'doc'}` capture ("General comment") gives a whole-review anchor with no file.
- Suggestions are allowed on new-side line anchors only. `codeSuggestionFor` returns the full `Suggestion` shape:
  `{mode: 'lines', old, new: old, file, startLine, endLine, version, status: 'pending'}`.

**Re-anchoring vN→vN+1** (`stepFor`, set by WP3 on `Prepared`):

| Anchor | Situation in vN+1 | Result |
|---|---|---|
| new side, path P | P present, or renamed (an entry with `oldPath === P`) | `stepAnchor` from `blob(P@vN,new)` to `blob(P'@vN+1,new)`, with `lineHunks` and the links for `P#h*`. The path is updated to P'. Existing states apply (exact, moved, edited, changed, orphaned). |
| new side, path P | P deleted, or gone | `orphaned` ("file deleted") |
| new side, path P | P is back to base, and the thread is resolved | copied, `exact` |
| old side | base unchanged | copied, `exact` |
| old side | base moved | `stepAnchor` from the old blob at vN to the old blob at vN+1 (following `oldPath`); `orphaned` if the file left the old side |
| whole file | renamed or deleted | follows the rename, or `orphaned` |

`kindOf(code).forwarder` applies the same steps across several versions. It is used by submit, moveThread and
changes, so a draft written on an older round keeps its file-space anchor (2.9).

### 4.8 Attribution and the round report

For each file F whose new-side blob changed between vN and vN+1 (a missing side counts as empty):
1. `hunks_F = lineHunks(blob(F@vN), blob(F'@vN+1))`. Hunk ids are `F#h1`, `F#h2` and so on, in path order.
2. `attribute()` runs per file with:
   - the actionable new-side threads on F;
   - the pending edits with `file === F`;
   - hints from replies whose `atFile` is F (a bare `L..` counts when the thread anchors only F);
   - the `other` entries naming F;
   - `preciseMapper`;
   - scopes of ±3 lines.
3. The results are concatenated with `file` set. `ManifestHunk.file` is stored, now that `record.js` passes it
   through (2.10).

```text
specreview: recorded v2 for cr-feat-token-refresh (round 2: 3 files changed, +14 -6, 5 hunks) · responds to rv1
  src/auth/refresh.js#h1   L41-47  -> t1 addressed  (overlap)
  src/auth/refresh.js#h2   L88     -> t2 addressed  (tagged: apply)
  src/auth/store.js#h1     L11     -> t3 answered   (hint)
  test/refresh.test.js#h1  L52-71  -> t4 addressed  (hint)
  src/auth/index.js#h1     L3      -> (no thread)
guards: code profile · ok (1 note: src/auth/index.js#h1 is linked to no thread)
anchors: 4 threads -> 1 exact, 2 moved, 1 edited, 0 changed, 0 orphaned
base: merge-base 1a2b3c4 (unchanged) · files in review: 6 (+1) · skipped: .env (excluded)
reviewer notified (1 UI open). next: run `specreview wait cr-feat-token-refresh` in the background
```

### 4.9 Guards: the code profile

| Guard | Specs | Code |
|---|---|---|
| Rewrite ratio | refuse above 0.5 at 40+ lines | skipped |
| Unexplained deletion | refuse | a note only, and only for files that hold threads |
| Locks | enforced | not offered: `addLock` refuses, and `kindCaps.locks` is false |
| Reply, addressed and decision warnings | warn | warn; the hint suggests `"at": "src/a.js:L12-14"` |
| `hook pre-write` | denies big Writes to tracked specs | never matches (it skips every non-file kind) |

So code rounds never refuse. Exit 3 from `revise` on a code doc means a usage problem, a CAS problem, or the
missing-step refusal of 4.2.

### 4.10 The packet for code

- **Header:** `SPECREVIEW FEEDBACK · cr-feat-token-refresh (code review: since-base origin/main, merge-base 1a2b3c4) ·
  review rv1 on v1 · CHANGES REQUESTED`.
- **Basis lines** (`codeLineBasis`):
  - `Repo root: /Users/me/repo (paths below are relative to it)`;
  - `Line numbers = files in your working tree now (all identical to v1).`, or `(2 of 5 files changed since v1: lines
    mapped).`;
  - a base change adds `Base moved since v1 (rebase or merge): old-side lines are lines of merge-base 4d5e6f7.`
- **Item header:** `[tN] [LABEL ·] [severity ·] type · <path>:L42-44 [(new file) | (old side) | (whole file)] [· apply
  verbatim: specreview apply <ref> tN]`. The path is repo-root-relative. There is no `on:` line and no `§section`.
- **`src>`** comes from the working file:
  - it is mapped through `preciseMapper(headBlob, workingText)` and expanded to whole lines;
  - it is grown, up to 8 lines or 1200 characters, until it is **unique in that file**;
  - if it is still not unique: `(not unique in the file: Read around L42 before editing)`.
- **Old-side items** print `was>` lines from the base blob, then `now between L39-40` (the base position mapped into
  the working file).
- **File states:**
  - `FILE MISSING in your working tree (restore it, or reply declined/answered explaining the deletion)`. Its `src>`
    comes from the head blob.
  - `binary` and `too-large` whole-file items carry no `src`.
- **PROTOCOL** (first packet): `PROTOCOL: Read each cited file (or range) before editing; paths are relative to the
  repo root above; src> lines are exact Edit old_string for that file; edit bottom-up per file.` It is followed by the
  usual Suggestions and Questions line.
- **NEXT:** per mode (4.6).
- There is no `LOCKED` line.
- **JSON packet:** `kind: 'code'` and `code: {label, baseSha, newSha, worktree, root}`. Each thread carries `file`,
  `fileFromCwd`, `side`, `lines`, `src`, `was` and `fileState`.

WP0b implements the item grammar in `formatPacket`, driven by the `PacketThread` fields. WP3 fills those fields
(`describeCodeThread`). Example (round 1):

```text
SPECREVIEW FEEDBACK · cr-feat-token-refresh (code review: since-base origin/main, merge-base 1a2b3c4) · review rv1 on v1 · CHANGES REQUESTED
Repo root: /Users/me/repo (paths below are relative to it)
Line numbers = files in your working tree now (all identical to v1).
Reviewer summary: Mostly good. Fix the reuse race before merging.
4 threads need action (4 new): 1 blocking · 1 question · 1 suggestion · 1 comment

[t2] suggestion · src/auth/refresh.js:L88 · apply verbatim: specreview apply cr-feat-token-refresh t2
  - const ttlSec = 30 * 24 * 3600;
  + const ttlSec = config.refreshTtlSec;
  Eric: Read it from config.

[t1] blocking · comment · src/auth/refresh.js:L41-44
  src> if (stored.used) {
  src>   await revokeFamily(stored.family);
  src>   throw new TokenReuseError();
  src> }
  Eric: Two tabs refreshing at once will trip this. Allow reuse within 30 s before revoking the family.

[t3] question · src/auth/store.js (old side) base L12-14, now between L11-12
  was> export function legacyLookup(id) {
  was>   return db.tokens.findOne({ id });
  was> }
  Eric: scripts/migrate.js still calls legacyLookup. Was removing it intended?

[t4] comment · test/refresh.test.js:L1 (new file)
  src> import { test } from 'node:test';
  Eric: Add a test for the grace window.

DECISIONS to keep true: (none yet)
PROTOCOL: Read each cited file (or range) before editing; paths are relative to the repo root above; src> lines are exact Edit old_string for that file; edit bottom-up per file.
  Suggestions: `specreview apply`. Questions: answer in the reply; change code only if the answer needs it. Unsure: status needs_input.
NEXT: edit the files -> specreview revise cr-feat-token-refresh --replies - (records round v2 from your working tree) -> specreview wait cr-feat-token-refresh (background)
```

The matching `revise` input:

```json
{"summary": "grace window, config TTL, keep legacyLookup, test",
 "threads": {
   "t1": {"status": "addressed", "reply": "Added a 30 s reuse grace window.", "at": "src/auth/refresh.js:L41-49"},
   "t2": {"status": "addressed", "reply": "Applied."},
   "t3": {"status": "addressed", "reply": "Restored legacyLookup.", "at": "src/auth/store.js:L12-14"},
   "t4": {"status": "addressed", "reply": "Added two tests.", "at": "test/refresh.test.js:L52-71"}},
 "other": [{"at": "src/auth/index.js:L3", "why": "export the new error type"}]}
```

### 4.11 Suggestions applied to real files

`applyCodeSuggestions(ctx, doc, tids, {dryRun, actor})`:
1. Each thread must have `suggestion.file` and a new-side anchor. Otherwise it is a conflict: "not a code
   suggestion".
2. Threads are grouped by file. For each file F, under the doc lock:
   - `head = blob(F@head,new)`;
   - `w = store.readRepoFile(F)`. A missing file, or a symlink, is a conflict;
   - `mapper = preciseMapper(head, w.text)`;
   - the existing `suggestionTarget`, `lineWindow`, `locateSuggestion` and `spliceText` produce the new text;
   - `store.writeRepoFile(F, text, {expectSha256: w.sha256, allowed: headFiles})`. On a CAS conflict the file is
     re-read and retried once.
3. A pending edit `{threads: [tid], file: F, lines}` is recorded, and the suggestion becomes `staged`. The next round
   links the hunk as `tagged: apply`, and the code `landed` check marks the suggestion `applied`.
4. Output and exit codes are those of today's `apply`.

**Reviewer "Apply now"** (`POST D/threads/:tid/apply` → `applySuggestionAsReviewer`, dispatched by WP0b):
- it calls the same function with the human actor;
- then it records a `ui-apply` round, as specs do.

The presence chip never shows "claude is editing", and the agent's next `revise` does not take credit for the change.

### 4.12 Interdiff (Verify, Changes mode, `diff`)

- `codeFiles(ctx, ref, {from, to})` lists the files whose **new-side** blob differs between vA and vB, plus files that
  were added to or dropped from the review. Each entry is `{path, oldPath?, change: 'changed'|'added'|'dropped'|
  'renamed', added, removed, threads}`.
- `codeFileDiff(ctx, ref, {path, from, to})` returns `sourceDiff(blob(path@vA,new), blob(path'@vB,new))`:
  - for adjacent versions, the thread chips come from `manifest(vB).hunks` filtered by `file`;
  - longer spans use forward mapping, as `ops/changes.js` does today.
- `codeThreadMiniDiff(ctx, ref, tid)` returns the existing `{kind: 'text', version, from, before, after, words}` shape
  for the thread's file. Verify uses it.
- `specreview diff <code-doc> v1..v2 --unified` prints a per-file `unifiedPatch` labelled `a/<path>@v1` and
  `b/<path>@v2`. `--stat` prints one line per file.

### 4.13 Dirty state and liveness

`codeWorkingState(ctx, doc, head)` (WP3) is **stat-first and memoized**:
- **Worktree modes:**
  - `lstat` every head file that has a new blob, and compare it with `manifest.code.stat`;
  - hash only the files whose stat changed;
  - list untracked files (`git ls-files --others --exclude-standard -- <pathspecs>`) that are not in the head file
    list. This list is memoized for 5 s per doc.
- **Staged:** copy the index to a temp file, run `write-tree`, and compare with `head.code.newTree`. Memoized for 5 s.
- **Branch and range by ref:** the re-resolved new-side commit differs. **PR:** the local `refs/specreview/pr/<n>`
  differs. Neither ever fetches.
- **Fixed endpoints:** the v1 commit is never dirty. After v1, the worktree rule applies.

The result is `WorkingState & {changedFiles: string[]}`, memoized for 2 s per `(doc, head)`.

`wait <code-doc>` exits 3 with `files changed since v2 (src/a.js, +1 more): run specreview revise <ref> to record the
round first, or pass --allow-dirty`. `wait --all` does not check code docs (2.6).

**Daemon poller** (WP4, `daemon/watch.js`):
- For a code doc with at least one SSE subscriber, call `codeWorkingState` every `LIMITS.codePollMs` (5 s).
- On a change, emit `working.changed`.
- `docState` reads through the same memo, so an SSE refresh never costs more than one `lstat` pass.

### 4.14 UI (WP4)

- **View.**
  - `KindMain` renders `kinds/CodeReviewView.js` in `main.center`. There is no `DocFrame`, guest or iframe: diffs are
    text nodes in the UI origin. There is no `innerHTML`, and no highlight.js HTML.
  - `KindRail` renders `kinds/FileTree.js`: status letter, path, +/-, thread count, stub badge, and a filter box.
  - The centre lists one card per file. Each card is a **new** `kinds/DiffTable.js`. It reuses the class names
    `.diff-table`, `.diff-hunk`, `.hunk-head`, `.ln-btn`, `td.op-ins` and `td.op-del`, and supports unified and split
    views. **`SourceView.js` is not touched.**
  - The first 3000 rows render, then a "Show all" button. Cards load lazily on scroll.
- **Modes** (from WP0b's `modesFor`): `review` (labelled "Files": the review diff at the viewed version), `changes`
  (the interdiff from the last reviewed version to head, with a from/to picker) and `history`. `KindSide` renders the
  code Changes and Verify lists.
- **Selection.**
  - Click a line number on either side; shift-click selects a range on the same side and file. The capture is `{kind:
    'line', file, side, startLine, endLine}`.
  - The rest is today's composer flow: `openComposer`, `resolveComposerAnchor`, `POST D/anchors/resolve`.
  - The card header has "Comment on file", which captures `{kind: 'file', file}`.
  - Suggestion mode is prefilled from `GET D/files/source?path=&v=&side=new`.
- **Markers.** They are keyed `${file}:${side}:${line}`. Clicking a thread scrolls to it, through `registerKindFocus`.
- **Gating** (WP0b's `kindCaps`): pick, snip, hide, page errors, the live and lost-frame banners and "Mark agreed" are
  hidden. `KindBanners` shows "Files changed since v2: Re-snapshot" (`CODE_TESTID.resnapshot`, `POST D/record`) when
  `working.dirty`.
- **Home.** The existing `docSummary.kind/origin` gets a kind chip (`code`, `plan`, `message`, `text`, `web`). WP0b
  adds the chip with no new CSS.
- **Styles.** A new `src/ui/styles/code.css`, linked after `views.css` in `index.html`. It uses tokens only. The
  existing CSS files are not edited.
- **Routes** (WP4: `src/daemon/api.js` code block, `src/ui/api.js` `docApi`, `test/e2e/mock-server.mjs` `docRoute`).
  File paths go in query parameters.

| Route | Engine op | Response |
|---|---|---|
| `GET D/files?v=N` | `codeFiles(ctx, doc, {v})` | `{v, files: Array<CodeFile & {threads}>, skipped}` |
| `GET D/files?from=A&to=B` | `codeFiles(ctx, doc, {from, to})` | `{from, to, files: Array<{path, oldPath?, change, added, removed, threads}>}` |
| `GET D/files/diff?path=P&v=N[&context=K]` | `codeFileDiff(ctx, doc, {path, v})` | `{path, oldPath?, v, stub?: 'binary'\|'too-large'\|'submodule'\|'excluded'\|'unsupported-name', hunks: Array<DisplayHunk & {threads}>}` |
| `GET D/files/diff?path=P&from=A&to=B` | `codeFileDiff(ctx, doc, {path, from, to})` | the same shape, with `from` and `to` |
| `GET D/files/source?path=P&v=N&side=new\|old` | `codeFileSource(ctx, doc, {path, v, side})` | `{path, side, v, text, lines}` |

An unknown path returns 404. A non-code doc returns 400 `{error: 'not a code review'}`. The routes are GET-only reads.

### 4.15 Agent protocol (WP6)

- **Skill section "Code review":**
  - when to run `specreview review`;
  - `path:L..` items are repo-root-relative, and you Read before you Edit;
  - `src>` is unique in its file;
  - `at` and `other` take path prefixes;
  - NEXT is per mode;
  - `revise` records a round;
  - never `edit` or `revert` a code doc.
- **New command** `integrations/claude-code/commands/specreview-code.md`:
  - frontmatter `disable-model-invocation: true` and `allowed-tools: Bash(specreview *)`;
  - body `` !`specreview review $ARGUMENTS 2>&1 || true` ``, so a "nothing to review" exit does not abort the command
    (Claude Code aborts on a non-zero exit);
  - then: "If the output is an error, tell the user. Otherwise start the printed `wait` in the background and follow
    the spec-review skill."

### 4.16 Security

- **Git:**
  - argv only, through `execFile`;
  - the hygiene flags, `core.hooksPath` pointed at an empty dir, and the scrubbed env;
  - `--end-of-options`;
  - literal pathspecs for repo paths;
  - a per-call temp index. The real index is never written.
- **Reads** never follow symlinks. Secret-looking untracked files are excluded. Forgeable names are skipped.
- **Writes:** `writeRepoFile` is the only new writer. It uses CAS, a root-containment check after realpath, refuses
  `.git` in any letter case and `.specreview`, refuses symlink targets, and writes only files of the head manifest.
- **Rendering:** text nodes in the UI origin. The content origin returns 404 for code docs.

### 4.17 Failure modes

| Failure | Behaviour |
|---|---|
| Not a git repo, or git too old | exit 1, with a hint |
| HEAD unborn | `uncommitted` against the empty tree |
| Merge conflicts in the index | `--staged`: exit 3. Worktree modes still work: the temp index starts from a copy, and `add -A` resolves the paths. |
| A file is edited while the snapshot is taken | the bytes read win; the next round corrects it |
| More than `code.maxFiles` | exit 3, with the count and a `--path` hint |
| Binary, too large, submodule, excluded or unsupported name | a stub entry; whole-file comments only |
| A rename plus an edit in one round | `-M` pairs them at 50% similarity. Below that it shows as D plus A: threads on the old path orphan, with a "renamed?" hint offering `reanchor --file`. |
| A rebase or merge of the base between rounds | the base is re-computed, `baseMoved` recorded, old-side anchors re-anchored |
| CRLF files | blobs keep `\r`, so `src>` keeps it, and `apply` matches the EOL |
| `core.autocrlf=true` | a new side read from disk can differ in EOL from the base blobs. Documented; normalisation is "later". |
| Concurrent rounds (Re-snapshot on two docs at once) | each uses its own mkdtemp index; tested |

### 4.18 PR mode via `gh` (WP3b, optional; starts after WP3)

The task lists PR review as optional, and the user points cross-team review at GitHub. So PR mode is a separate,
droppable package with no fallback paths.

- **Input:** `review --pr <n|url>`.
  - The repo is pinned with `-R owner/repo`: from the URL when one is given, else from `gh repo view --json
    nameWithOwner`.
  - `owner/repo` must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, and `<n>` must be a positive integer.
- **Metadata:** `gh pr view <n> -R <repo> --json number,title,url,baseRefName,headRefName,baseRefOid,headRefOid,
  changedFiles`. Each oid must match `^[0-9a-f]{40}([0-9a-f]{24})?$`, or the command exits 1. `changedFiles` is checked
  against `code.maxFiles` first.
- **Merge-base:** `gh api repos/<repo>/compare/<baseOid>...<headOid> --jq .merge_base_commit.sha`, validated the same
  way.
- **Objects:**
  - If the local `HEAD` is the PR head commit, or the checked-out branch's upstream is `headRefName`, the review
    behaves like `since-base`, with the PR's merge-base as base and the working tree as new side. No fetch is
    needed.
  - Otherwise run `git fetch --no-tags origin --end-of-options refs/pull/<n>/head:refs/specreview/pr/<n>` once, and
    fetch the merge-base sha if it is missing.
  - With no `origin` remote for the repo, exit 3: "add the PR's repository as a remote". There is **no contents-API
    fallback**.
- **Rounds:**
  - When checked out, rounds use the working tree.
  - Otherwise they compare against the local `refs/specreview/pr/<n>` only.
  - The **daemon never runs `gh` or `git fetch`.** A re-fetch happens only when the agent or the user runs
    `review --pr <n>` again.
- **Packet:** when HEAD is not the PR head, the basis line says `PR #123 is not checked out here: run \`gh pr checkout
  123\` before editing; line numbers are the PR head 4c5d6e7.` and every thread gets `fileState: 'not-checked-out'`.
- **Offline:** `network.allow: false` or `SPECREVIEW_OFFLINE=1` gives exit 3, with no `gh` or `git fetch` call.
- **Cleanup:** `close` on a PR doc deletes `refs/specreview/pr/<n>`. Doctor reports stale refs.
- PR mode is not in MCP.

---

## 5. F3: the agent's last message, and piped text

`last`, `open -` and `revise --source` have shipped (1.2). This section freezes them and lists the deltas.

### 5.1 `specreview last` (shipped; WP2 deltas)

- **Shipped:**
  - transcript lookup through `findTranscript`;
  - the active-branch extraction (`extractLastMessage`, which honours `/rewind`);
  - key `claude-msg:<session>:<message id>`;
  - it opens the doc and returns at once with the URL and a `next:` line.
- **Delta, explicit session:** when the session id was given explicitly (`--session`, or `CLAUDE_CODE_SESSION_ID`)
  and no transcript has that name, exit 4 (`NotFoundError`). The newest transcript of the directory could belong to
  another concurrent session. The guess applies only when no id exists, and is then reported (`"guessed": true` in
  the JSON).
- **Delta, edit copy:** the output adds a `Working copy:` line, the edit copy of 5.3.
- **The slash command** `/specreview-last` (WP6):
  - the body is `` !`specreview last --session "${CLAUDE_SESSION_ID}" $ARGUMENTS 2>&1 || true` ``;
  - an empty session id falls back to the env (shipped);
  - `|| true` stops a non-zero exit from aborting the command;
  - the model is told to relay an error line.
- **Other agents** have no transcript reader in this round; the Codex rollout format is undocumented. Their generated
  `specreview-last` skill or command (WP5) says:
  1. "Write your previous answer verbatim to a temporary file with your file-write tool."
  2. "Run `specreview open - --title "<short title>" < <file>`."
  3. "Wait as the protocol says."

  Without `--name`, every answer becomes its own doc (key `null`, shipped), so unrelated answers never merge.

### 5.2 Piped text: `specreview open -` (shipped; WP0a and WP2 deltas)

- **Shipped:** stdin up to 5 MiB, Markdown, key `stdin:<name>` or `null`, `--name`, `--title`. Mixing `-` with paths
  is a usage error.
- **Delta (WP0a):** the `stdinText` input, so MCP `specreview_open {text}` works.
- **Delta (WP2):** the `Working copy:` line (5.3).

### 5.3 Revising message and stdin docs: the edit copy (WP0a mechanism; WP2 prints it)

Today, the only way to revise these docs is to regenerate the whole text. The `src>` lines cannot serve as an
`old_string`, the diff is noisy, and Verify linking weakens. The edit copy fixes that:
- `editCopyPath(wsId, docId)` = `$SPECREVIEW_HOME/ws/<wsId>/edit/<docId>.md`.
- `ops/snapshot.js` writes it from head when it creates v1, and after every recorded version of a message or stdin
  doc. It is **never** rewritten at delivery, so unrecorded agent edits survive.
- It is runtime state. Nothing is ever served from it, so D2's "served from versions only" still holds.
- The message and stdin PROTOCOL (`SNAPSHOT_PROTOCOL`, WP0a) reads: `PROTOCOL: Edit the working copy <path> with
  targeted changes (src> lines are exact old_string for it); change only what the threads ask for.`
- NEXT: `edit <path> -> specreview revise <ref> --source <path> --replies - -> specreview wait <ref> (background)`.
- `revise --source <path>` and `"source"` in the replies JSON keep working. Identical text plus replies posts the
  replies only.

---

## 6. F4: a folder of specs, and a URL snapshot

### 6.1 `specreview open <dir>` (shipped; WP2 delta)

- **Shipped:**
  - the recursive `.md/.markdown/.html/.htm` walk;
  - dot dirs, `node_modules`, denied paths and outward symlinks are skipped;
  - the first 200 files are opened and the rest reported;
  - one Home URL;
  - JSON `{docs, home, skipped}`.
- **Delta:**
  - also skip the directory names in `FOLDER_EXCLUDES` (`dist`, `build`, `out`, `target`, `vendor`, `coverage`,
    `_site`, `public`, …). They are counted as `skipped.excluded`;
  - the `next:` line says `specreview wait --all (background)`;
  - 2.6 keeps `--all` in every later NEXT that was delivered through `--all`.
- There is no `git check-ignore` pass. The exclude list covers the common build output cheaply.

### 6.2 `specreview snapshot <url>` (WP2)

```text
specreview snapshot <url> [--title T] [--reader auto|direct|jina] [--as-html] [--allow-private]
                          [--allow-remote-assets] [--replies <file|->] [--browser pane|system|none]
                          [--workspace <dir>] [--json]
```

**Opt-in rules:**
- Running the verb is the consent.
- Exit 3 when the user-level `network.allow` is false, or `SPECREVIEW_OFFLINE=1`.
- MCP `specreview_snapshot` takes `{url, title}` only. It is refused for non-public hosts, and never uses Jina.
- **Re-snapshot:** running `snapshot <url>` again with the same normalized URL records the next version when the
  content changed. `--replies` posts replies with it.

**Fetch** (`src/cli/fetch-url.js`):
- **URL checks:**
  - only `http:` and `https:`;
  - URLs with userinfo are refused.
- **Address checks:** resolve with `dns.lookup(host, {all: true})`. Refuse when **any** address is non-public, unless
  `--allow-private` is given. Non-public means:
  - loopback, `0.0.0.0/8`, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, `fe80::/10`), CGNAT
    100.64/10, ULA `fc00::/7`, multicast, unspecified (`::`);
  - IPv4-mapped (`::ffff:0:0/96`), NAT64 `64:ff9b::/96` and `2002::/16` with an embedded non-public IPv4.

  WHATWG normalises decimal and hex hosts before the check.
- **Pinning:** requests go through `http(s).request({lookup})`, pinned to the checked address. That closes the
  DNS-rebinding window with builtins only.
- **Redirects:** `redirect: 'manual'`, at most `urlMaxRedirects` (10) hops, each one re-checked.
- **Limits:** the streamed body is capped at `urlMaxBytes` (10 MiB), with `urlTimeoutMs` (30 s) in total.
- **Headers:** `User-Agent: specreview/<version>`.
- **Reader `auto`:**
  1. `github.com/<o>/<r>/blob/<ref>/<path>.md` is rewritten to `raw.githubusercontent.com/…`.
  2. A `.md`/`.markdown` path, or a `raw.githubusercontent.com` / `gist.githubusercontent.com` host: GET it as
     markdown.
  3. Otherwise GET with `Accept: text/markdown, text/html;q=0.9, */*;q=0.1`. `text/markdown` (or `text/plain` with an
     md path) gives markdown. `text/html` gives HTML.
  4. Any other type: exit 3, "unsupported content type".
- **Reader `jina`:** `GET https://r.jina.ai/<url without query and fragment>`, with a stderr note when a query was
  dropped. Refused for non-public hosts.

**Conversion** (`src/cli/html-convert.js`). This replaces the draft's hand-written denylist.
- **HTML:**
  1. `hast-util-from-html`;
  2. `hast-util-sanitize` with the **GitHub schema** (an allowlist: no `script`, `style`, forms, `meta`, `base`,
     iframes, event handlers or `javascript:` URLs; SVG and `template` contents are dropped);
  3. relative `href` and `src` are made absolute against `finalUrl`.
- **Default, Markdown:** `hast-util-to-mdast`, then `mdast-util-to-markdown` with `mdast-util-gfm`. Any `html` mdast
  node is dropped before serializing. The doc is markdown, and it contains no raw HTML.
- **`--as-html`:** the sanitized hast goes through `hast-util-to-html`. The doc is html.
- **Markdown fetched as markdown** (raw GitHub, `text/markdown`, Jina): it is parsed with `remark-parse`, its `html`
  nodes are dropped, and it is re-serialized. Markdown from the network therefore never carries raw HTML either.
- The count of removed elements goes into `manifest.origin.removed`.
- **Low text:** when the result has fewer than `urlLowTextChars` (200) characters and the page had scripts, print a
  note: "this page is probably rendered by JavaScript: try `--reader jina` (sends the URL to r.jina.ai)".
- **New direct dependencies** (WP0a adds them to `package.json`; several are already transitive): `hast-util-from-html`,
  `hast-util-sanitize`, `hast-util-to-mdast`, `hast-util-to-html`, `mdast-util-to-markdown`, `mdast-util-gfm`. Each is
  pinned to an exact version.

**Doc.**
- Origin: `{type: 'url', key: 'url:<normalized>', url, finalUrl, private}`.
- Per-version `manifest.origin`: `{url, finalUrl, status, contentType, fetchedAt, etag, reader, removed}`.
- Synthetic path: `web/<id>.md` or `.html`.
- `render: {network: 'block'}`, unless `--allow-remote-assets`. Images and CSS then do not load at view time.
- The strict CSP and sandbox of 2.7 apply.

**Packet** (strings in WP0a's `packet-data.js`):
- Basis line: `Line numbers = lines of SpecReview's Markdown snapshot of <finalUrl> (fetched <time>); there is no file
  for you to edit.`
- NEXT for a private host (a page you build): `edit the sources that produce the page -> specreview snapshot <url>
  --replies - (records v<N+1>) -> specreview wait <ref> (background)`.
- NEXT for a public host: `answer each thread with specreview reply <ref> <tid> -m <md> --status answered|declined ->
  specreview wait <ref> (background)`.

**Output:**

```text
specreview: tracking web page as "docs-example-com-spec" (markdown, 212 lines) · recorded v1 · removed 14 elements
  review UI: http://127.0.0.1:4777/d/ab12cd34/docs-example-com-spec?k=…
next: run `specreview wait docs-example-com-spec` in the background
```

**Exit codes:**
- 0: ok;
- 1: a network error, or HTTP status 400 or above (with the status line);
- 3: refused (offline, non-public host, userinfo, too large, unsupported type);
- 4: DNS failure.

---

## 7. F5: the multi-agent installer and `install.sh`

### 7.1 Adopted from `feat/installer` (1.3)

**Command surface** (from the branch):
- `specreview install [--only a,b] [--skip a,b] [--user|--project] [--apply] [--json]`, the multi-agent form;
- `specreview install claude [--user|--project] [--with-hooks] [--with-plan-gate] [--with-mcp] [--apply]`;
- `specreview install agents-md [--file F] [--apply]`;
- `specreview uninstall [--only …] [--skip …] [--user|--project] [--apply]`.

The model, ownership rules and tests are the branch's, unchanged:
- dry run by default;
- one-time backups;
- the install manifest;
- managed-file and marker ownership;
- `OUR_HOOK_RE`, which matches both `hook <name>` and `plan-gate`;
- the TOML block scanner;
- `stillUsesShared`;
- refusing to install the Claude hooks when the plugin is installed;
- printing `claude mcp add` instead of running it;
- per-file refusals that do not stop other agents (exit 1).

The agents are claude, codex, gemini, cursor, opencode, copilot, amp, droid, kiro and claude-desktop. Antigravity and
Devin are listed as unverified.

### 7.2 Gaps WP5 closes

| # | Gap | Change |
|---|---|---|
| G1 | Rebase | Rebase onto WP0a. Resolve `commands/{index,doctor}.js`, `README.md` (its Install section only; 9.7) and `docs-cli.test.js`. WP0a's `uninstall` stub is replaced by the branch's module. |
| G2 | Plan-notes hook | `hookEntries({planGate: true})` writes **both** PermissionRequest/ExitPlanMode `plan-gate` (345600 s) and PostToolUse/ExitPlanMode `hook plan-notes` (10 s), from `PLAN_GATE`. Uninstall removes both. A legacy settings file holding a bare `specreview plan-gate` entry ends with exactly one entry. |
| G3 | Gemini MCP | `~/.gemini/settings.json` `mcpServers.specreview = {command, args, timeout: 660000, trust: false}` (timeout in ms). Refused, with the snippet printed, when the file has comments. |
| G4 | Copilot MCP | `~/.copilot/mcp-config.json` `mcpServers.specreview = {type: "local", command, args, tools: ["*"], timeout: 660000}`. Copilot's default 30 s MCP timeout is shorter than `specreview_wait`'s 50 s default. |
| G5 | OpenCode MCP timeout | add `"timeout": 660000` to `mcp.specreview`. Spike S5 confirms the field. |
| G6 | Code and last commands for every agent | Claude: the command files are copied dynamically from `integrations/claude-code/commands/*.md` (WP6 adds `specreview-code.md`), so no WP5 change is needed. Other agents: new templates `integrations/agent-skills/specreview-code/SKILL.md` and `…/specreview-last/SKILL.md`; Gemini `integrations/gemini/commands/specreview-{code,last}.toml`; OpenCode `integrations/opencode/commands/specreview-{code,last}.md`. They are written next to `specreview-review`. The bodies use wait mode, done mode or `specreview_wait`, never "in the background". |
| G7 | Host-neutral guidance | A test asserts that no non-Claude output contains `run_in_background` or `mcp__Claude_`. The shared skill tells MCP hosts with unknown limits to call `specreview_wait` with `timeout_sec: 25` and repeat on `{"status":"waiting"}`. |
| G8 | Absolute `!` lines | When `specreview` is not on PATH, the copied Claude command files get their `` !`specreview …` `` lines rewritten to the absolute `"<node>" "<bin>" …` form, with a matching `allowed-tools`. An invocation note cannot help, because `!` runs before the model does. |
| G9 | Claude permissions (opt-in) | `install claude --with-permissions` (also allowed in the multi form) adds `permissions.allow` entries for `Bash(specreview wait *)`, `revise`, `feedback`, `reply`, `apply`, `show`, `status` and `threads`. Uninstall removes them. Network verbs (`snapshot`, `review --pr`) are never pre-approved. The dry run lists the item as "skipped (add --with-permissions to stop per-round prompts)". |
| G10 | Symlinked config files | Writes `realpath` the target, write the temp file in the target's directory and rename it onto the target, so a dotfiles symlink survives. A dangling symlink is refused, with the snippet printed. |
| G11 | File modes | A 0600 config stays 0600 after install and after uninstall. Backups get the source file's mode. |
| G12 | Shim safety | `install.sh` refuses to overwrite an existing `specreview` in the shim dir unless it is our shim (marker comment) or a symlink into our checkout. |
| G13 | One step under `curl \| sh` | Without `--yes`, after the dry run `install.sh` asks `Apply these changes? [y/N]` on `/dev/tty`, with a 30 s timeout that defaults to no. With no tty, it stays a dry run. `--yes` applies without asking. |
| G14 | Duplicate plan gate | Doctor reports a settings `plan-gate` entry while the plugin is also installed (two blocking gates). |
| G15 | Hermetic tests | The branch's tests run under `hermeticEnv` (2.15). Add the canary read-only-HOME test. Run `install-sh.test.js` under `dash` when it is available, and through `shellcheck` when it is installed (otherwise skipped, with a note). |
| G16 | Package | `package.json`: `"private": true` (the npm name `specreview` is taken), and `install.sh` in `files`. |

### 7.3 Behaviour changes against today's `cli-install.test.js`

These are the branch's changes, kept and listed here:
- `install` with no target runs the multi-agent dry run. It used to exit 1.
- The Claude hooks no longer include the plan gate unless `--with-plan-gate` is given, or the multi form is used. HEAD
  copies every event from `hooks.json`, and duplicates the PermissionRequest entry on each re-run.
- The branch updates `cli-install.test.js` accordingly (22 lines changed). WP5 keeps those edits and adds a test for
  G2.

### 7.4 What the multi form installs for Claude

Skill, commands, the hooks (pre-write, prompt), the plan gate and plan-notes, and `claude mcp add` printed. This is
shown in the dry run. `--skip claude` and `install claude` without `--with-plan-gate` leave the gate out.

---

## 8. Security summary (each control has a negative test)

| Surface | Control | Test (owner) |
|---|---|---|
| Network | Only `snapshot <url>`, `review --pr` and `install.sh` touch it. All are refused offline or with the user-level `network.allow: false`. The daemon never fetches. MCP has no private hosts, no Jina and no PR. | `cli-snapshot` offline refusal (WP2); `mcp.test.js` asserts the absent fields (WP0a); a fake `gh` logs zero calls on a daemon Re-snapshot (WP3b) |
| SSRF | Any non-public address is refused; mapped and NAT64 IPv6 are handled; userinfo is refused; the address is pinned through `lookup`; every redirect is re-checked; size and time caps | `fetch-url.test.js` corpus (WP2) |
| Fetched content | GitHub-schema allowlist sanitizer; Markdown carries no raw HTML; `html` nodes are dropped from fetched Markdown; network blocked per doc | `html-convert.test.js` bypass corpus: `<script>`, `onerror`, `<form>`, meta refresh, SVG `<animate>`, `<template>`, entity-obfuscated `javascript:`, `<link rel=preload>` (WP2) |
| Snapshot rendering | Strict CSP (`script-src 'self'`, `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`) and strict sandbox | daemon CSP test (WP0a); a guest e2e test where meta refresh does not navigate and an inline script does not run (WP0a) |
| Config | The permission mode, network policy and commit policy come from the user layer only; code limits are clamped | a workspace `plan.approveMode` produces no `updatedPermissions` (WP0a/WP1); `commitSnapshots` plus `autoCommit` leave code docs ignored (WP0b) |
| Git | Argv only; hooks off; scrubbed env; `--end-of-options`; literal pathspecs; per-call temp index; nested stores excluded | a hook that touches a file does not run; `GIT_DIR` and `GIT_INDEX_FILE` pointing elsewhere are ignored; concurrent rounds; a nested `.specreview` (WP3) |
| Repo reads | Symlinks never followed; parent realpath containment; `.git` in any case refused | an untracked symlink to `~/secret` shows link text; a retargeted symlink; a symlinked parent dir; `src>` never contains target bytes (WP0b, WP3) |
| Secrets in diffs | Untracked key-file patterns excluded, with no object written | an untracked `.env` and `server.pem` become stubs, and `git cat-file -e` finds no object (WP3) |
| Hostile names | Control characters, non-UTF-8 and a leading `-` are skipped; `at` parsed from the right | a name containing `\n[t9] blocking …`, `\t`, `:`, `,`, `*`, `"` and invalid UTF-8 (WP3) |
| Repo writes | `writeRepoFile`: CAS, containment, `.git` and `.specreview` refused, symlink targets refused, manifest files only | refusal tests for `../x`, `.git/config`, `.GIT/config`, `.git` as a file, a path outside the manifest, a symlink (WP0b) |
| Plan gate | Fails open; never `onFailure: block`; never writes the plan file; reads the plan only under the plans dir or the project | spawn test with garbage stdin; a plan path outside the allowed dirs falls back to inline (WP1) |
| Installer | Dry run by default; marker ownership; symlink-safe atomic writes; modes kept; shared skills reference-counted; the shim never clobbers | WP5 tests G2, G10, G11, G12, plus the branch's suite |
| Tests themselves | Hermetic env; the read-only-HOME canary | WP0a |
| Daemon | Unchanged token and host checks; new routes are GET-only reads; health counts only | `daemon-code-routes` (WP4) |

---

## 9. Work packages

**Rules:**
- Each WP is built in its own git worktree, branched from the commit named in its "Starts after" line.
- **Ownership is exclusive.** After the WP0 pair, a file is created or modified by exactly one WP. A WP that needs a
  change in a file it does not own asks the owner, or the change goes into WP0a or WP0b first.
- **Two exceptions:**
  - `docs/BUILD_AMENDMENTS.md` is append-only. WP0a, WP0b and WP1 each append one dated section, and nobody edits
    anything else in it.
  - `README.md` is split: WP5 owns the Install section, WP6 everything else.
- Every file listed as "create" was checked against `git ls-files` at `2e22f7d` and does not exist yet. Files that
  exist are listed as "modify" or "extend".

**Testing** follows BUILD_AMENDMENTS section 9 and the existing patterns:
- `node --test` for unit and integration tests; golden packets in `test/fixtures/packets/`; UI model tests in
  `test/e2e/model.test.mjs`; Playwright specs with system Chrome, using `mock-server.mjs` or `real-daemon.mjs`;
- `hermeticEnv` (2.15) everywhere;
- default ports are never bound.

**Gates:** `npm run check` and `npm run test:ui`, both green on the developer's machine. Chrome specs fail, rather than
skip, when Chrome is missing. No CI workflow is added in this round (Appendix A, S-M8).

**Sizes** are rough: S < 500 changed lines, M 500-1500, L 1500-3000, XL > 3000.

### 9.0a WP0a: shared contracts and snapshot, plan and delivery deltas (lands first; M)

**Goal.** Give WP1, WP2 and WP5 every contract they consume, and fix the delivery and security issues that cut across
features. Specifically: 2.2-2.8 (the non-code parts), 2.6, 2.7 (except the `text` format), 2.10 (`autoAddressLinked`),
2.11 (`source`), 2.12, 2.13, the banner slot of 2.14, 2.15, the packet strings of 3.6, 3.12, 5.3 and 6.2, and the
`agentPrompt` change of 3.9.

**Starts after:** `2e22f7d`.

**Files.**

| Create | Modify |
|---|---|
| `src/cli/commands/{snapshot,review,uninstall}.js` (stubs with the final `spec`) | `src/shared/{protocol,types}.js` |
| `src/ui/components/kinds/index.js` (`KindBanners`), `kinds/PlanBanner.js` (a placeholder returning null) | `src/core/store/{config,store,snapshot,recovery}.js`: the user layer, key rules and clamps; `render` on `createSnapshotDoc`; the ephemeral `.gitignore`; the `url` origin row; `editCopyPath`; dotfiles ignored |
| `test/helpers/hermetic-env.js` | `src/core/review/ops/{snapshot,revise,wait,feedback,submit}.js`: the `render` option; no reopen for a closed plan (`paused`); edit-copy writes; `autoAddressLinked`; the `_all` filters; `wait <plan-doc>` refusal; plan feedback semantics; `deliveredVia`; overflow file; `review.meta` |
| `test/unit/{config-layers,delivery-filters,packet-plan,snapshot-edit-copy}.test.js` | `src/core/review/{packet-data,packet,git}.js`: `formatPlanFeedback` (`overflowPath`, `replyLines`, the new WHAT TO DO lines); `formatPlanNotes` (with `late`); the url basis and NEXT; the edit-copy PROTOCOL and NEXT; the `--all` NEXT; the overflow line; `autoCommit` skips ephemeral docs |
| `test/integration/{home-canary,daemon-csp}.test.js` | `src/cli/{snapshot,hooks,schemas,daemon-client}.js`: `snapshotWorkspace(…, {createInRepo})`; `pre-write` skips every non-file kind; the `plan-notes` no-op branch; `source` in `ReviseInputSchema`; restart on `buildId` |
| `test/guest/strict-frame.test.mjs` (meta refresh and inline script blocked) | `src/cli/commands/{index,open,revise,hook,doctor,wait}.js`: the registry entries; the `stdinText` branch; `source` from JSON; the hook summary; doctor skips working-file checks for every non-file kind; `wait` with no doc uses the `_all` filter |
| `test/fixtures/packets/{plan-deny,plan-notes,plan-late,message-edit-copy,url-public,url-private}.txt` | `src/mcp/tools.js`: `specreview_open` with `text`, `specreview_snapshot`, `specreview_revise` with `source` |
| | `src/daemon/{content,api,sse}.js`: per-doc and strict CSP; `buildId`, `docClients`; submit `meta` |
| | `src/ui/frame.js` (`FRAME_SANDBOX_STRICT`), `src/ui/components/{DocFrame,App}.js` (strict sandbox for snapshots; the `KindBanners` slot), `src/ui/model.js` (`agentPrompt`) |
| | `package.json`, `package-lock.json` (the 6 hast/mdast dependencies of 6.2) |
| | `test/integration/{docs-cli,hooks,mcp,daemon,cli-snapshot}.test.js`, `test/unit/store-snapshot.test.js`, `test/e2e/model.test.mjs`; append to `docs/BUILD_AMENDMENTS.md` (the config layers, ephemeral docs and the strict snapshot profile) |

**Must not touch:** `src/core/code/**` (WP0b), `src/cli/commands/plan-gate.js` (WP1), `src/cli/{transcript,
fetch-url,html-convert}.js` (WP2), `src/cli/install*` (WP5), `integrations/**`.

**Frozen interfaces:**
- `Store#createSnapshotDoc({…, render})`, and `takeSnapshot` → `{…, paused?}`;
- `editCopyPath(wsId, docId)`;
- `snapshotWorkspace(rt, dir, {createInRepo = true})`;
- `revise(ctx, ref, input, {source, origin, autoAddressLinked})`;
- `formatPlanFeedback(packet, {planFilePath, maxChars, overflowPath, replyLines})`;
- `formatPlanNotes(packet, {late, verdict, maxChars, overflowPath})`;
- `Packet.deliveredVia` and `Packet.overflowPath`;
- the `_all` filter rules of 2.6;
- `ReviseInputSchema.source`;
- the user config keys of 2.4;
- `GET /api/health` `buildId`, and `?ws&doc` `docClients`;
- `review.meta.planApproveMode`;
- the stub `spec` of the `snapshot`, `review` and `uninstall` commands;
- the MCP tool inputs of 2.12;
- `KindBanners({ds})`;
- `hermeticEnv(tmp, extra)` and `GIT_TEST_ARGS`;
- the packet golden files.

**Test plan:**
- **Config:**
  - a workspace `plan.approveMode`, `network.allow` or `store.commitSnapshots` is ignored, with a warning;
  - the user layer applies;
  - env beats both;
  - `code.maxFiles: 999999` in the workspace config is clamped.
- **Delivery:**
  - `wait --all` with one closed spec doc, one plan doc with an undelivered review, one message doc of another
    session, and one spec doc with a new review: it delivers only the spec review, and NEXT says `wait --all`;
  - `wait <plan-doc>` exits 3;
  - `feedback <plan-doc>` with a live waiter does not mark delivery; without one it does, and prints the notes
    framing;
  - an overflowing packet writes the file, and the overflow line names it.
- **Plan core:**
  - a v1→v2 re-capture with `autoAddressLinked` marks a linked thread `addressed` with an `auto` reply, and leaves an
    unlinked thread open;
  - an explicit reply wins;
  - golden `plan-deny` (with and without `replyLines`), `plan-notes` and `plan-late`;
  - a closed plan doc: `takeSnapshot` records the version, returns `paused`, and the doc stays closed.
- **Snapshots:**
  - the `.gitignore` is written; with the user-level `commitSnapshots` it is not;
  - `autoCommit` skips ephemeral docs;
  - the edit copy is written on v1 and after `revise --source`, and is not rewritten at delivery;
  - golden `message-edit-copy`, `url-public` and `url-private`.
- **Daemon:**
  - the CSP of a snapshot doc has `script-src 'self'` and `form-action 'none'`;
  - a url doc with `render.network: 'block'` gets the network rule; a file doc's CSP is unchanged;
  - `buildId` differs after a source change, and `ensureDaemon` restarts on it (with a stub daemon);
  - `docClients` counts per doc.
- **Guest:** in a strict-sandbox frame, a meta refresh does not navigate and an inline script does not run.
- **CLI:**
  - the docs-cli test loads every registry entry, stubs included;
  - `hooks.test.js`: `pre-write` ignores `kind: 'code'` and `'snapshot'`; `hook plan-notes` prints nothing;
  - `mcp.test.js`: `specreview_snapshot` has no `allow_private`, `reader` or `as_html`; `specreview_open {text}`
    creates a stdin doc.
- **Canary:** the CLI suite with `HOME` read-only writes nothing there.
- **Regression:** `npm run check` and `npm run test:ui` stay green, `snapshot.spec.mjs` included under the strict
  sandbox.

### 9.0b WP0b: code-kind seams (M-L)

**Goal.** 2.7 (the `text` format and content 404), 2.8 (the code kind, blobs, `readRepoFile`, `writeRepoFile`), 2.9
(kind adapter, op dispatch, `isSnapshot` classification, contract test), 2.10 (record seams), 2.11 (code `at`
grammar), the code packet item grammar (4.10), the MCP `specreview_review` tool, and the rest of 2.14. After WP0b,
WP3 and WP4 compile and test against explicit stubs.

**Starts after:** WP0a. It runs in parallel with WP1, WP2 and WP5.

**Files.**

| Create | Modify |
|---|---|
| `src/core/review/kinds.js` | `src/core/render/index.js` (`'text'`), `src/core/anchor/util.js` (`formatOf`), `src/core/review/anchoring.js` (`envOf`) |
| `src/core/code/{index,review,round,state,capture,packet,apply,files,threads,forward}.js` (stubs throwing `UsageError('code review is not available in this build')`) | `src/core/store/{store,snapshot,recovery}.js`: kind `code`; `isVirtual` and `isCode`; blobs; `readRepoFile`, `writeRepoFile`; `.diff` versions; `findDocByOrigin`; `blobs` in `DOC_SUBDIRS`; the `code-index-*` sweep |
| `src/core/util/code-at.js` (real implementation) | `src/core/review/ops/{record,revise,common,edits,drafts,threads,changes,docs,final,locks,submit,wait,feedback,snapshot}.js` and `ops.js` (adapter routing, op dispatch, classification, hunk `file` projection, `respondsToOf` export) |
| `src/ui/components/kinds/{CodeReviewView,FileTree,CodeBanner,CodeSide}.js` (placeholders) | `src/core/review/{packet-data,packet}.js` (the code item grammar, and the code header, basis and NEXT dispatch) |
| `test/unit/{review-kind-contract,kind-classification,code-at,store-blobs,store-repofile,packet-code-grammar}.test.js` | `src/cli/{schemas,args}.js`, `src/cli/commands/reply.js` (the `at` forms, `atFile`) |
| `test/fixtures/code-doc/**` (a hand-built code doc with two rounds), `test/fixtures/packets/code-item-grammar.txt` | `src/mcp/tools.js` (`specreview_review`) |
| | `src/daemon/{content,api,watch}.js`: 404 for code docs; targets fallback; `kind: 'code'` in `docSummary`; skip virtual docs |
| | `src/ui/{model,actions,keys,commands,state}.js` (`modesFor`, `kindCaps`, `targetLabel` file branch, `registerKindFocus`) |
| | `src/ui/components/{App,SidePanel,TopBar,StatusBar,ThreadCard,ThreadPanel,Home}.js` (consult `kindCaps` and the kind slots; the kind chip), `src/ui/components/kinds/index.js` |
| | `test/e2e/model.test.mjs`; append to `docs/BUILD_AMENDMENTS.md` (the `text` RenderResult, the kind adapter) |

**Must not touch:** WP1, WP2 and WP5 files; `SourceView.js`; the CSS files.

**Frozen interfaces:**
- `kindOf(doc) -> KindAdapter` (2.9);
- the `src/core/code/*` signatures (9.3);
- `Store#createSnapshotDoc({kind: 'code', code})`;
- `putDocBlob`, `readDocBlob`, `readRepoFile` → `RepoRead`, `writeRepoFile(rel, text, {expectSha256, allowed})`;
- `Prepared.stepFor | landed | assetFiles`;
- `respondsToOf`;
- `parseCodeAt`, `parseCodeOtherAt`;
- the `PacketThread` code fields, and the item grammar;
- `KindMain`, `KindRail`, `KindSide`, `kindCaps`, `modesFor`, `registerKindFocus`;
- the capture shapes `{kind: 'line', …}` and `{kind: 'file', file}`.

**Test plan:**
- **Contract test** (2.9): every op and every `D/*` route on the code fixture returns a result or a typed error;
  anchors survive a cross-round submit; the content origin returns 404 for the code doc.
- **Classification:** the grep test fails on an unclassified `isSnapshot`.
- **Store:**
  - kind `code` requires `format: 'text'`, gets `code/<id>.diff`, and is always ephemeral, even with the user-level
    `commitSnapshots`;
  - `findDocByOrigin` finds code docs;
  - `findDoc` never returns one.
- **Blobs and repo files:**
  - `putDocBlob` is idempotent; a missing blob is NotFound;
  - `readRepoFile` returns the link text for a symlink to `../outside` and never the target bytes;
  - it refuses a symlinked parent dir, `.git/config`, `.GIT/config`, `.git` as a file, and `.specreview/x`;
  - `writeRepoFile` CAS mismatch gives ConflictError; a path outside `allowed`, or a symlink target, is refused;
  - EOL and mode are preserved.
- **`code-at`:** all the forms, a quoted comma path, parsing from the right with a `:` inside the path, ambiguous
  resolution.
- **Packet:** the golden `code-item-grammar` (from a hand-made `Packet`): `path:L..`, `(new file)`, `(old side)` with
  `was>`, `FILE MISSING` with its action, `Repo root:`, the PROTOCOL line.
- **UI model:**
  - `modesFor` per kind (code: `review`/"Files", `changes`, `history`);
  - `targetLabel` for file anchors;
  - `kindCaps` for code (no frame, pick, snip, hide, page errors or locks).
- **Regression:** `npm run check` and `npm run test:ui` green, with no visible change for file or snapshot docs.

### 9.1 WP1: plan gate deltas (F1; M)

**Goal.** Section 3 on top of the shipped gate:
- subagent handling;
- the plan-path restriction;
- no implicit store;
- the paused state;
- per-doc tab opening;
- the gate marker;
- liveness checks;
- notes records;
- reply lines (gated by S3);
- `hook plan-notes`;
- the `hook prompt` plan branch (notes fallback, late reviews, the session filter for message docs);
- the PlanBanner;
- spikes S1-S4.

**Starts after:** WP0a.

**First task: spikes S1-S4** (9.9). They need a real Claude Code (2.1.296 or later) and a human. The results are
appended to `docs/BUILD_AMENDMENTS.md` before the dependent code merges. Every feature has a fallback when a spike is
negative, so the spikes cannot block the merge.

**Files.**
- Create:
  - `src/cli/plan-gate/{liveness,replies,marker,notes}.js`;
  - `test/unit/plan-gate-helpers.test.js`;
  - `test/e2e/plan-gate.spec.mjs`;
  - `test/fixtures/plan/{permission-request.json,permission-request-subagent.json,transcript-replies.jsonl}`.
- Modify:
  - `src/cli/commands/plan-gate.js`;
  - `src/cli/hooks.js` (`plan-notes`, and the `prompt` plan and session branches);
  - `src/ui/components/kinds/PlanBanner.js` (replaces the placeholder);
  - `test/integration/{plan-gate,hooks}.test.js` (extend).

**Must not touch:** store, ops, packet code, `model.js`, `App.js`, `kinds/index.js`, the daemon, the installer,
integrations.

**Frozen interfaces:**

```js
// plan-gate/replies.js
export function parseReplyLines(text) // -> Record<'t<n>', { status, reply }>
export function repliesSinceDeny(transcriptPath, { readTranscript }) // -> string (assistant text after the last deny)
// plan-gate/liveness.js
export function watchLiveness({ ppid, stdout, transcriptPath, toolUseId, pollMs, onGone }) // -> stop()
// plan-gate/marker.js
export function markerPath(home, sessionId) // '<home>/plan-gate/<sha256(sid)[:16]>.json'
export function writeMarker(home, sessionId, info), clearMarker(home, sessionId), readMarker(home, sessionId)
// plan-gate/notes.js (builtins only; also used by hooks.js)
export function notesPath(home, sessionId) // '<home>/plan-notes/<sha256(sid)[:16]>.json'
export function writeNotes(home, sessionId, record), consumeNotes(home, sessionId, { now, ttlMs }) // -> text | null
// plan-gate.js keeps decisionFor(engine, packet, toolInput, plan) and gains an optional 5th argument
//   { approveMode } (adds updatedPermissions); planText(toolInput) gains { allowedRoots }.
```

**Test plan:**
- **Unit:**
  - `parseReplyLines`: every status, en and em dashes, colons, junk lines;
  - `consumeNotes`: TTL, reading once, the `.consumed` rename;
  - marker round trip;
  - `planText` with an allowed root, a disallowed root (falls back to inline), a symlink out of the root;
  - `decisionFor` with `approveMode` (gets `updatedPermissions`) and without.
- **Integration** (`plan-gate.test.js`, extended; in process, with stubs for `ensureDaemon`, `openBrowser` and health):
  1. A subagent payload gives empty stdout and records no doc.
  2. With no store in the repo, the doc lands in scratch and no `.specreview/` is created. With a store, the doc lands
     there.
  3. Deny, then an edited plan: v2 has the linked thread `addressed` (auto) and the unlinked one open. With a
     transcript fixture holding `t1: answered - …`, t1 gets that reply (when `replyLines` is on).
  4. Approve with a summary writes the notes record. `hook plan-notes` prints it once. `hook prompt` prints nothing
     afterwards. Without plan-notes, `hook prompt` prints it on the next prompt.
  5. Approve through the banner meta `acceptEdits` gives `updatedPermissions` `setMode acceptEdits`. A workspace
     config `plan.approveMode` is ignored.
  6. A closed plan doc: the version is recorded, stdout is empty, no browser opens.
  7. Liveness: the transcript fixture gains a `tool_result` for the ExitPlanMode `tool_use`, so the gate exits with
     empty stdout, the waiter is gone and the marker stays. A review submitted later makes `hook prompt` print the
     late line, and `feedback` delivers it in notes framing.
  8. `docClients > 0` means no browser open for v2.
  9. A deny that overflows names the overflow file, and its blocking threads are inline.
- **Spawn:**
  - garbage stdin gives exit 0 and no output;
  - with a real daemon on port 0: SIGTERM after the waiter appears gives empty stdout and removes the waiter.
- **E2E** (`real-daemon.mjs`):
  - after the gate records v1, the banner shows "waiting at ExitPlanMode";
  - "Approve + accept edits" makes the gate print an allow with `setMode`;
  - a request-changes round shows v2 with automatic statuses in Verify.

### 9.2 WP2: inputs (F3 and F4 deltas, URL snapshot; M)

**Goal.**
- `specreview snapshot <url>` (6.2): fetch, SSRF, conversion and replies;
- the folder excludes (6.1);
- the `last` explicit-session miss (5.1);
- the `Working copy:` lines in `last` and `open -` (5.3).

**Starts after:** WP0a.

**Files.**
- Create:
  - `src/cli/fetch-url.js`, `src/cli/html-convert.js`;
  - `test/unit/{fetch-url,html-convert}.test.js`;
  - `test/integration/cli-snapshot-url.test.js`;
  - `test/fixtures/web/*`.
- Modify:
  - `src/cli/commands/snapshot.js` (replaces the stub);
  - `src/cli/commands/{open,last}.js`;
  - `src/cli/transcript.js`;
  - `test/unit/transcript.test.js`, `test/integration/cli-snapshot.test.js` (extend).

**Must not touch:** `src/core/**`, `src/mcp/tools.js`, `src/cli/snapshot.js`, the daemon, the UI, `package.json` (WP0a
added the dependencies).

**Frozen interfaces:**

```js
// fetch-url.js
export async function fetchForSnapshot(url, { reader, allowPrivate, maxBytes, timeoutMs, maxRedirects, lookup, request })
//   -> { format: 'markdown' | 'html', body: Buffer, finalUrl, status, contentType, etag, reader, private: boolean, hadScripts }
export function normalizeUrl(u)          // -> string
export function isPublicAddress(ip)      // -> boolean
// html-convert.js
export function htmlToMarkdown(html, { baseUrl })      // -> { markdown, removed, textChars }
export function sanitizeHtml(html, { baseUrl })        // -> { html, removed }
export function stripRawHtmlFromMarkdown(md)           // -> { markdown, removed }
// command input
// SnapshotInput = { url, title?, reader?, asHtml?, allowPrivate?, allowRemoteAssets?, replies?, browser? }
```

**Test plan:**
- **`fetch-url`** (injected `lookup` and `request`; no internet):
  - a redirect from a public to a private address is refused;
  - an address set mixing public and private is refused;
  - `::ffff:127.0.0.1`, `64:ff9b::a00:1`, `0.0.0.0`, decimal and hex hosts, and userinfo are refused;
  - more than 10 redirects;
  - the size cap aborts the stream;
  - timeout;
  - content-type dispatch;
  - the GitHub blob rewrite;
  - Jina is refused for a private host, and the query is dropped (with a note);
  - offline gives refused.
- **`html-convert`** bypass corpus: `<script>`, `<img onerror>`, `<form>` and `formaction`, meta refresh, SVG `<script>`
  and `<animate>`, `<template>`, `jav&#x09;ascript:`, `<link rel=preload>`, `<base>`, `<iframe>`.
  - The Markdown output holds none of them, and re-parsing it yields no `html` node.
  - Fetched markdown with `<script>` loses it.
- **Integration:**
  - `snapshot http://127.0.0.1:<port>/spec.html --allow-private` against a local server gives a markdown url doc with
    `render.network: 'block'`;
  - without the flag: exit 3;
  - changed content gives v2;
  - `--replies -` posts replies;
  - `--as-html` gives an html doc with no script;
  - a JavaScript-only page prints the low-text note.
- **CLI deltas:**
  - `open docs/` skips `dist/` and `build/` (`skipped.excluded`);
  - `last --session <unknown>` exits 4;
  - `last` without an id on an empty projects dir behaves as shipped;
  - `last` and `open -` print `Working copy:`, and `revise --source <that path>` records v2.

### 9.3 WP3: code-review engine and CLI (F2 core, local modes; XL)

**Goal.** Section 4 without the UI, the routes and PR mode:
- the git layer with its hygiene, rounds, anchors and attribution;
- packet data and apply;
- interdiff and the dirty state;
- the `review` command;
- `--file` and `--side` on `ask`, `reanchor` and `show`;
- `diff` for code docs.

**Starts after:** WP0b.

**Files.**
- Create:
  - `src/core/code/{git,spec,snapshot,diff-text}.js`;
  - `test/helpers/git-repo.js` (uses `GIT_TEST_ARGS` and fixed dates);
  - `test/unit/code-{git,spec,diff-text,anchor,attribution,packet,apply,files,state,security}.test.js`;
  - `test/integration/{cli-review,e2e-code-loop}.test.js`;
  - `test/fixtures/packets/code-round1.txt`.
- Modify:
  - `src/core/code/{index,review,round,state,capture,packet,apply,files,threads,forward}.js` (replaces the stubs);
  - `src/cli/commands/{review,ask,reanchor,show,diff}.js`;
  - `src/core/anchor/describe.js` (export `linesAround` and `windowAround` only).

**Must not touch:** store, record, revise, packet text, `kinds.js` (consume the seams), UI, daemon, installer,
integrations.

**Frozen interfaces:**

```js
// ReviewInput = { mode?, base?, committed?, range?, commit?, paths?, context?, title?, browser?, maxFiles? }
// spec.js
export async function resolveSpec(git, input, config)      // -> CodeSpec
export function specKey(spec)                              // -> 'diff:since-base:origin/main[+paths=...]'
export function specLabel(spec, code)                      // -> 'since-base origin/main (merge-base 1a2b3c4) .. working tree'
export function docIdFor(spec, branch)                     // -> 'cr-feat-token-refresh'
// snapshot.js
export async function takeCodeSnapshot(ctx, spec, { prev, docId }) // -> { text, buf, code: CodeManifest }
// review.js
export async function openCodeReview(ctx, { input, title })        // -> { doc, created, version, recorded, code }
// round.js
export async function reviseCode(ctx, doc, input)                  // -> ReviseReport & { code: { files, baseMoved, carried } }
export async function recordCodeRound(ctx, doc, { author, capturedBy }) // -> { manifest } | { nothing: true, v }
// state.js
export async function codeWorkingState(ctx, doc, head)             // -> WorkingState & { changedFiles: string[] }  (memoized, 4.13)
// capture.js
export async function resolveCodeCapture(ctx, doc, capture, v)     // -> { anchor, preview }
export async function codeSuggestionFor(ctx, doc, anchor, v)       // -> Suggestion (full shape, with file)
// forward.js
export function codeForwarder(ctx, doc)                            // -> (anchor, toVersion) => Promise<Record<string, Anchor>>
// packet.js
export async function loadCodeSnapshot(ctx, doc, snap)             // sets snap.code = { manifest, blobs, working, root }
export function describeCodeThread(snap, thread, opts)             // -> { file, fileFromCwd, side, lines, src, was, fileState }
export function codePacketLabel(snap)                              // -> string
export function codeLineBasis(snap, threads)                       // -> string[]   (Repo root line first)
export function codeNextStep(doc, ref, approval, actionable)       // -> string     (per mode, 4.6)
// apply.js
export async function applyCodeSuggestions(ctx, doc, tids, { dryRun, actor }) // -> { applied, conflicts }
// files.js
export async function codeFiles(ctx, ref, q /* {v} | {from,to} */)
export async function codeFileDiff(ctx, ref, q /* {path, v} | {path, from, to}, context? */)
export async function codeFileSource(ctx, ref, { path, v, side })
export async function codeChanges(ctx, ref, range)
export async function codeUnifiedDiff(ctx, ref, range)
export async function codeThreadMiniDiff(ctx, ref, tid)
// threads.js
export async function askCode(ctx, doc, { file, lines, body })     // file absent: whole-review thread
export async function reanchorCode(ctx, doc, tid, { file, lines })
```

Response shapes are those of the 4.14 route table.

**Test plan** (all on scripted repos under `hermeticEnv`):
- **Modes:**
  - the file list of every mode: untracked files included and `.gitignore` respected; root and nested `.specreview`
    excluded; a tracked file moved to an untracked path detected as a rename;
  - binary, oversized (via a small `maxFileBytes`), symlink, submodule;
  - unborn HEAD; the default base from a bare remote's `origin/HEAD`; a missing base gives exit 4; unmerged entries
    with `--staged` give exit 3.
- **Hygiene and security:**
  - a `post-index-change` hook does not run;
  - `GIT_DIR` and `GIT_INDEX_FILE` pointing at another repo are ignored, and that repo is untouched;
  - two concurrent `recordCodeRound` calls produce correct trees;
  - an untracked `.env` becomes a stub, with no object written;
  - the symlink corpus (an untracked symlink to an outside file, retargeting, a symlinked parent): no target bytes in
    blobs, `src>` or the working-state hash;
  - the hostile-name corpus is skipped as `unsupported-name`;
  - `:` and `,` in names round-trip through `at`;
  - the real index is byte-identical after a `--staged` round;
  - git older than `GIT_MIN_VERSION` gives exit 1 (with a fake git).
- **Determinism:** the canonical text is byte-identical across two runs, and unaffected by repo config `color.ui=always`,
  `diff.noprefix=true` or `diff.external`.
- **Rounds:**
  - the base is re-computed after `git merge` of an advanced main, so the review does not balloon, and `baseMoved` is
    reported;
  - a rebase re-anchors old-side anchors;
  - `--commit` v2 uses the working tree for the review's files;
  - carried `=` files;
  - NEXT per mode;
  - a staged-mode `revise` with `addressed` and an unchanged snapshot exits 3 with the `git add` hint.
- **Anchors and attribution:** captures on both sides; moved, edited and changed lines; rename; deletion (orphaned);
  namespaced hunk ids; hints with path prefixes and bare `L..`; a tagged link after `apply`; `landed` per file;
  `codeForwarder` across two rounds.
- **Packet:** the golden `code-round1.txt` (the 4.10 example built from a scripted repo); `src>` uniqueness growth; the
  "not unique" fallback; `FILE MISSING`; a cwd in a subdirectory still prints root-relative paths.
- **Apply:** a splice into a drifted working file; a CAS conflict and retry; a missing file; a symlink refused; the
  reviewer apply records a `ui-apply` round.
- **Dirty:** stat-first (no hashing when the stats are unchanged); the memo; a new untracked file makes the doc dirty.
- **CLI** (`runCli`):
  - `review` in every local mode;
  - exit codes 1, 3 and 4;
  - the JSON shape;
  - a full round: `wait` reports dirty (exit 3), then `revise --replies -`, then `wait` is fine;
  - `diff v1..v2 --unified`;
  - `edit` and `revert` refused;
  - `ask --file`, `show --file --side old`;
  - `wait --all` does not see a dirty code doc.
- **Loop:** `e2e-code-loop.test.js` runs the agent and reviewer loop through engine ops until approval and `final`
  (the decisions file lands in the doc dir).
- The WP0b contract test passes with the real engine in place of the stubs.

### 9.3b WP3b: PR mode through `gh` (optional; S)

**Goal.** Section 4.18. It can be dropped without touching anything else.

**Starts after:** WP3 merges.

**Files.**
- Create: `src/core/code/pr.js`, `test/fixtures/gh/fake-gh.mjs`, `test/integration/cli-review-pr.test.js`.
- Modify: `src/cli/commands/review.js` (the `--pr` branch), `src/core/code/{spec,snapshot,state,index}.js` (the PR
  hooks and the close cleanup).

**Frozen interfaces:**
- `resolvePr(git, gh, input) -> {repo, number, url, headRefName, baseOid, headOid, mergeBase}`;
- `gh` is injected through `deps.gh` or `SPECREVIEW_GH`, not through PATH order.

**Test plan:**
- a fake `gh` (which asserts its argv) plus a local bare remote with `refs/pull/1/head`;
- checked out: since-base-like rounds with no fetch;
- not checked out: one fetch, then `fileState: 'not-checked-out'` and the `gh pr checkout` line;
- `gh` missing: exit 1; `gh auth` failing: exit 1; PR not found: exit 4;
- offline: exit 3, with no `gh` and no `git fetch` call;
- a malicious oid or `owner/repo` from `gh`: exit 1, with no git call;
- a daemon Re-snapshot makes zero `gh` or `fetch` calls;
- `close` deletes the ref.

### 9.4 WP4: code-review UI, daemon routes and poller (F2 UI; L)

**Goal.** Section 4.14 and the 4.13 poller.

**Starts after:** WP0b. It develops against the stub engine, and **merges after WP3**.

**Files.**
- Create:
  - `src/ui/components/kinds/DiffTable.js`;
  - `src/ui/styles/code.css`;
  - `test/e2e/{mock-code.mjs,code-review.spec.mjs}`;
  - `test/integration/{daemon-code-routes,code-routes-real}.test.js`.
- Modify:
  - `src/ui/components/kinds/{CodeReviewView,FileTree,CodeBanner,CodeSide}.js` (replace the placeholders);
  - `src/daemon/api.js` (one code-routes block);
  - `src/daemon/watch.js` (the poller block);
  - `src/ui/api.js` (`docApi.files`, `fileDiff`, `fileSource`);
  - `src/ui/index.html` (one `<link>`);
  - `test/e2e/mock-server.mjs` (the `docRoute` entries and the `code` scenario);
  - `test/e2e/model.test.mjs` (extend).

**Must not touch:** the existing CSS files, `SourceView.js`, `App.js`, `kinds/index.js`, `model.js`, `actions.js`,
`TopBar.js`, `ThreadCard.js`, `ThreadPanel.js`, `src/core/**`, `src/cli/**`.

**Frozen interfaces:**
- the route table in 4.14;
- the capture shapes;
- `CODE_TESTID`;
- the ready marker `[data-view="code"][data-ready]`;
- the poller emits `working.changed` with `{dirty, changedFiles}`.

**Test plan:**
- **`daemon-code-routes`** (an explicit stub engine): path decoding in the query (`a/b c.js`); 400 for a non-code
  doc; 404 for an unknown path; the shapes.
- **`code-routes-real`** (mandatory; the real engine after WP3): a temp repo, then `review`, a line-anchored draft, a
  submit; the agent `wait` gets a packet with `path:L..`; a Re-snapshot records v2; the routes return the interdiff.
  There is no feature sniffing.
- **Poller:** editing a reviewed file emits `working.changed` within 2 poll intervals while a client is subscribed,
  and nothing runs with no subscriber.
- **`code-review.spec.mjs`** (the mock `code` scenario: a modified file, a new file, a binary stub, two threads):
  - the file tree shows three files, with a stub badge on the binary;
  - shift-click on old-side and new-side line numbers opens the composer with "Agent will see: src/a.js:L3-4" or
    "(old side)";
  - a submitted draft posts a `line` capture (checked in the mock request log);
  - suggestion prefill;
  - Changes shows the interdiff with chips;
  - Verify shows the thread mini-diff;
  - Re-snapshot posts `D/record`;
  - the split and unified toggle;
  - "Comment on file" on the binary;
  - pick, snip and hide are absent;
  - "Show all" past 3000 rows.

### 9.5 WP5: installer (F5; M, mostly landed)

**Goal.** Land `feat/installer` (1.3) rebased onto WP0a, then close gaps G1-G16 (7.2). Run spike S5.

**Starts after:** WP0a. It runs in parallel with the session that is still editing `feat/installer`: that session's
uncommitted `toml.js` work is committed first and becomes WP5's starting point.

**Files.**
- From the branch:
  - `src/cli/install.js`, `src/cli/install/{agents,content,files,multi,toml}.js`;
  - `src/cli/commands/{install,uninstall}.js` (`uninstall` replaces WP0a's stub);
  - `install.sh`;
  - `integrations/{agent-skills,gemini,opencode}/**`;
  - `test/integration/{cli-install,cli-install-agents,install-sh}.test.js`, `test/unit/install-files.test.js`.
- New:
  - `integrations/agent-skills/{specreview-code,specreview-last}/SKILL.md`;
  - `integrations/gemini/commands/specreview-{code,last}.toml`;
  - `integrations/opencode/commands/specreview-{code,last}.md`;
  - `test/unit/install-content.test.js` (G6, G7, G8).
- Modify:
  - `src/cli/commands/doctor.js` (the agent list, and the G14 duplicate check);
  - `test/integration/docs-cli.test.js` (the install and uninstall `SUBCOMMANDS`);
  - `package.json` (`private`, `files`);
  - `README.md` (Install section only).

**Must not touch:** `integrations/claude-code/**`, `integrations/agents-md/**` (WP6; read at install time), hooks,
the plan gate, core.

**Frozen interfaces:**
- the branch's plan model (`FileAction`, `Planner`, `AgentDef`, `Report`), `OUR_HOOK_RE` and the marker strings;
- hook entries are built from `PLAN_GATE` constants, never from `hooks.json`;
- the command and skill names `specreview-review`, `specreview-code` and `specreview-last`;
- the protocol marker `<!-- specreview:protocol -->`, replaced with `integrations/agents-md/AGENTS.snippet.md`;
- `rt.deps` injection points `home`, `execPath`, `binPath`, `platform` and `claudeHome`.

**Test plan:**
- the branch's suite, under `hermeticEnv`;
- G2: a legacy `plan-gate` entry plus `--apply` gives exactly one PermissionRequest and one PostToolUse entry, and
  uninstall removes both;
- G3 and G4: the JSON shape with timeouts; a Gemini file with comments gives a refusal and is untouched;
- G6 and G7: every non-Claude output is free of `run_in_background` and `mcp__Claude_`; the Gemini TOML parses
  (`"""` and backslash escaping);
- G8: with `specreview` absent from PATH, the copied Claude commands carry the absolute invocation;
- G9: `--with-permissions` adds the narrow allow list, and uninstall removes it;
- G10: install into a symlinked `settings.json`: the symlink survives and its target is updated;
- G11: 0600 is kept;
- G12: a foreign `specreview` in the shim dir is refused and left unchanged;
- G13: with no tty it stays a dry run; with a pseudo-tty answering `y` it applies;
- the canary read-only HOME test;
- `install-sh.test.js` under `dash` when present.

### 9.6 WP6: agent protocol, Claude integrations and docs (S; merges last)

**Goal.** Teach agents the new flows (3.11, 4.15, 5.1, 5.3, 6.2) and document them.

**Starts after:** WP1, WP2, WP3, WP4 and WP5 merge (and WP3b if built).

**Files.**
- Create: `integrations/claude-code/commands/specreview-code.md`, `test/unit/integrations.test.js`.
- Modify:
  - `integrations/claude-code/skills/spec-review/{SKILL.md,reference.md}`: plan mode (reply lines, notes, no
    `wait`); code review; the edit copy; URL docs; host-neutral wording, with Claude-only steps under an "If you are
    Claude Code" heading;
  - `integrations/claude-code/commands/{review-spec,specreview-last}.md`: `review-spec` handles a folder, a URL
    (through `snapshot`) or `-`; both use `2>&1 || true`;
  - `integrations/claude-code/hooks/hooks.json`: the PostToolUse `hook plan-notes` entry;
  - `integrations/claude-code/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (version);
  - `integrations/agents-md/{AGENTS.snippet.md,README.md}`;
  - `docs/{agent-protocol,user-guide,demo-e2e-prompt}.md`, `README.md` (except Install);
  - `package.json` (version bump to 0.2.0).

**Must not touch:** `src/**`, and `test/**` except its own new test.

**Frozen:** command names, flags, packet grammar and hook commands, exactly as WP0a-WP5 define them.

**Test plan:**
- `docs-cli.test.js` passes: every documented command and flag exists;
- `integrations.test.js`:
  - `hooks.json` holds exactly the four commands, with their matchers and timeouts (`hook pre-write`, `hook prompt`,
    `plan-gate` 345600, `hook plan-notes` 10);
  - every command file has a `description`;
  - every command that combines `` !` `` with `$ARGUMENTS` has `disable-model-invocation: true` and
    `allowed-tools: Bash(specreview *)`;
  - every `specreview` line in the skill parses with the real `parseArgs` specs.

### 9.7 File ownership matrix (after WP0a and WP0b)

| Area | WP1 | WP2 | WP3 | WP3b | WP4 | WP5 | WP6 |
|---|---|---|---|---|---|---|---|
| `src/cli/commands/plan-gate.js`, `src/cli/plan-gate/*`, `src/cli/hooks.js`, `kinds/PlanBanner.js` | own | | | | | | |
| `src/cli/commands/{open,last,snapshot}.js`, `src/cli/{transcript,fetch-url,html-convert}.js` | | own | | | | | |
| `src/core/code/*` (except `pr.js`), `src/cli/commands/{review,ask,reanchor,show,diff}.js`, `src/core/anchor/describe.js` exports | | | own | after WP3: `review.js` `--pr`, `code/{spec,snapshot,state,index}.js` PR hooks | | | |
| `src/core/code/pr.js` | | | | own | | | |
| `src/daemon/api.js` code block, `src/daemon/watch.js` poller, `src/ui/api.js`, `src/ui/index.html`, `kinds/{CodeReviewView,FileTree,CodeBanner,CodeSide,DiffTable}.js`, `src/ui/styles/code.css`, `test/e2e/mock-*` | | | | | own | | |
| `src/cli/install.js`, `src/cli/install/*`, `src/cli/commands/{install,uninstall,doctor}.js`, `install.sh`, `integrations/{agent-skills,gemini,opencode}/**`, `test/integration/docs-cli.test.js`, `package.json` (`private`, `files`), README Install section | | | | | | own | |
| `integrations/claude-code/**`, `integrations/agents-md/**`, `.claude-plugin/*`, `docs/**` (BUILD_AMENDMENTS append-only), the rest of README, `package.json` version | | | | | | | own |

Everything else that this design changes belongs to WP0a or WP0b (9.0a, 9.0b).

### 9.8 Merge order and integration

1. **WP0a** as one PR. Gate: `npm run check`, `npm run test:ui`, and the WP0a tests.
2. **WP0b, WP1, WP2 and WP5** in parallel worktrees from WP0a. They share no file, and merge in any order.
3. **WP3 and WP4** in parallel from WP0b. WP3 merges first, then WP4 with `code-routes-real`.
4. **WP3b** (optional) from WP3.
5. **WP6** last. Then the integration pass:
   - `npm run check` and `npm run test:ui`;
   - one scripted demo per feature, extending `docs/demo-e2e-prompt.md`:
     - a plan-mode session with two rounds, Verify of auto-addressed threads, and an approve with notes;
     - `review` with two rounds, an `apply` and a reviewer "Apply now";
     - `/specreview-last` with an edit-copy revision;
     - `open -` from a non-Claude-style temp file;
     - `open docs/`, then `wait --all` across two docs;
     - `snapshot` against a local server;
     - `install.sh` in a temp HOME, then `install --apply`, then `uninstall --apply`, which restores every config
       byte for byte.

### 9.9 Spikes (run before the dependent code merges; results appended to BUILD_AMENDMENTS)

| # | Question | Owner | If yes | If no |
|---|---|---|---|---|
| S1 | Does PostToolUse fire for ExitPlanMode after a PermissionRequest hook allow, and does the model see its `additionalContext`? | WP1 | `hook plan-notes` delivers notes right after approval | the notes arrive with the next user prompt (`hook prompt`); the PostToolUse entry stays (harmless) |
| S2 | When the terminal answers first, does Claude Code send a signal or close stdout, or does it just discard the hook's output? | WP1 | the shipped signal handling suffices | the transcript liveness check (built regardless) ends the wait |
| S3 | When ExitPlanMode's PermissionRequest fires, does the transcript already hold the assistant text of that turn? | WP1 | `replyLines` on | `replyLines` off; automatic statuses only |
| S4 | In plan mode, does Read of a file under `$SPECREVIEW_HOME` (outside the project) prompt for permission? | WP1 | the overflow file stays under `$SPECREVIEW_HOME/ws/<wsId>/feedback/` | for repo-store plan docs, the overflow goes to `.specreview/docs/<id>/feedback/` (git-ignored), passed through `overflowPath` |
| S5 | Do Copilot, OpenCode and Cursor honour a 660 s MCP tool timeout, and does a 25-50 s blocking `specreview_wait` call work? | WP5 | write the timeouts | the skill tells those hosts to use `timeout_sec: 25` loops (G7 guidance, already the default) |

---

## 10. Revise and round semantics in one table

| Kind | Who records vN+1 | Bytes from | `capturedBy` | Guards | Replies-only path |
|---|---|---|---|---|---|
| file | agent `revise`; reviewer "Record" or "Apply now" | the working file | revise, ui-record, ui-apply | spec (refusing) | the working copy equals head |
| snapshot: plan | the plan gate, at each ExitPlanMode | the plan file, else the inline plan | snapshot | warn-only, plus automatic `addressed` for linked threads | identical plan: no version; the gate waits or delivers |
| snapshot: message, stdin | agent `revise --source <edit copy>`; a re-pipe with `--name` | the given bytes | snapshot | warn-only | identical bytes plus replies |
| snapshot: url | `snapshot <url> [--replies -]` again | the fetch, converted | snapshot | warn-only | identical body plus replies; public pages: `reply` only |
| code | agent `revise`; reviewer "Re-snapshot" or "Apply now"; a `review` re-run | git plus the working tree, per `doc.code` | round, ui-record, ui-apply | code profile (never refuses) | identical canonical diff plus replies |

---

## 11. Out of scope, and later

- **Collaboration:** team sharing, hosted links, syncing comments to GitHub PRs or Google Docs. Also a TUI, a VS Code
  extension, Ask AI, and visual polish beyond tokens and reused classes.
- **Plan gate:**
  - reviewer edits of plans (apply in the UI and return the edited plan in `updatedInput.plan`; this first needs open
    question 3 of `research-claude-code.md` answered);
  - Claude Code "mods" non-blocking review;
  - **gates for other agents** (Gemini `BeforeTool`, Codex Stop hook, Copilot `preToolUse`, an OpenCode plugin, the
    Cursor `stop` hook). See Q1.
- **More agents:** Antigravity (reported as unverified), and planners for Devin and Mistral Vibe.
- **`last` for other agents' transcripts** (Codex rollouts, Gemini sessions). The temp-file pipe covers them today.
- **URL snapshots:** downloading page assets into the store; a headless browser for pages rendered by JavaScript.
- **Code review:**
  - function-context labels;
  - per-file "viewed" checkboxes;
  - stacked commits;
  - `core.autocrlf` normalisation;
  - `edit` and `revert` for code docs;
  - locks on code;
  - posting reviews back to GitHub;
  - `close --purge` of blobs;
  - a jj backend.
- **Distribution:** npm publish under a scoped name, Homebrew, and a CI workflow.

---

## 12. Risks and open questions

**Risks:**
1. **Claude Code contract drift.** The `updatedInput` requirement, PermissionRequest semantics and the transcript
   format can all change. The shipped tests and WP1's tests pin our side, and S1-S3 record what the current version
   does. Every path fails open.
2. **Two prompts at once.** The gate races the native chooser by design. The banner, the late-review path (3.9) and the
   per-doc tab opening keep the reviewer and the terminal consistent.
3. **WP0b breadth.** About 35 classified call sites plus the adapter routing. The contract test and the grep test are
   the safety net. WP0b must leave file and snapshot behaviour byte-identical (the regression gate).
4. **Large repos.** The temp-index `add -A` costs about as much as a `git status` with a warm stat cache. Monorepos
   should use `--path`. The `codeMaxFiles` cap and the stat-first dirty check bound the cost.
5. **Duplicate code lines.** `src>` may not be unique even at 8 lines in boilerplate. The packet then says "Read around
   L..".
6. **A parallel session on `feat/installer`.** WP5 starts from that session's committed result. If it is still moving,
   WP5 waits for it rather than forking it.

**Open question for the user** (one; everything else has a stated default):
- **Q1. Plan gates for agents other than Claude Code.** Plannotator also gates Codex, Gemini, OpenCode and Copilot
  plans. F1 names Claude Code, and none of the other payloads can be verified without the real agents installed.
  **Default:** this round ships the Claude Code gate only. Each other gate is a later, separate adapter (about one
  file each), built once someone captures a real payload. Say if you want any of them in this round.

---

## Appendix A. Critique log

**Legend:**
- **Check** says how a point was verified: `code` (read at `2e22f7d` or in `sr-installer`), `notes` (the research
  notes), or `reasoned` (not directly observable; accepted when the fix is cheap).
- **A** = accepted, and fixed where shown. **C** = accepted with a different fix. **R** = rejected, with the reason.

### A.1 `critique-architecture.md`

| ID | Point | Check | Disposition |
|---|---|---|---|
| B1 | The design is built on a stale picture of the in-flight work | code: `19817ae..2e22f7d` landed; the shapes differ as the critique's table says | A: 1.2, D1; WP1/WP2 are deltas |
| B2 | WP5 ignores `feat/installer` | code: `sr-installer` holds the installer and `install.sh` | A: 1.3, 7, 9.5 |
| B3 | `format: 'text'` crashes `renderSource` | code: `render/index.js:55-63` throws | A: 2.7 (`text` format), 2.9 (op-entry dispatch, contract test) |
| B4 | File-space anchors are read against the `.diff` text (`threads`, `showThread`, submit `forwardAnchor`) | code: `threads.js:90-98,358-396`, `submit.js:71-84`, `locks.js:34-38` | A: 2.9 kind adapter (`forwarder`, `describeThread`), anchor check in the contract test |
| B5 | Registry entries without modules break the docs-cli test | code: `docs-cli.test.js:69` loads every entry | A: 2.12 stubs with the final `spec` |
| B6 | Schemas reject path `at` and `"source"` | code: `schemas.js:15-57` (strict; `LinesAt` regex) | A: 2.11 (`code-at.js`, kind-aware validation, `source` key) |
| M1 | `wait --all` steals or duplicates plan reviews, and returns `closed` for any closed doc | code: `wait.js:56-70,144` | A: 2.6 (plan docs, closed docs and other sessions filtered; one identity, `claude`) |
| M2 | A `bin/` fast path for `hook plan` breaks the hook contract | code: the shipped `plan-gate` is SIGNAL_AWARE | A: keep `plan-gate`; `plan-notes` in `hooks.js` (3.2) |
| M3 | Deciding after `waitForFeedback` breaks "printed before recorded" | code: `plan-gate.js:188-202` decides inside `write` | A: 3.4 step 8 freezes the shipped behaviour |
| M4 | "The hook is killed when the terminal answers" is only inferred | notes: rcc:224 is [inf] | A: spike S2, plus liveness checks built regardless (3.7) |
| M5 | PostToolUse after a hook allow is untested | notes: rcc open question 4 | A: spike S1, plus the `hook prompt` fallback (3.6). The proposed `updatedInput.plan` append fallback is **R**: rcc question 3 says it may rewrite the plan file and label it "edited by user". |
| M6 | Workspace placement contradicts the shipped behaviour; duplicate helpers | code: `cli/snapshot.js:36-56` | A: one helper, `snapshotWorkspace(…, {createInRepo})`; the gate never creates a store; the shipped scratch format kept (3.8) |
| M7 | `wait --all` becomes unusable while a code review is open | code: `wait.js:58-66` | A: 2.6 (no dirty check for virtual docs in `_all`) |
| M8 | `codeWorkingState` cost and liveness are undesigned | reasoned (`docState` runs on every SSE refresh) | A: 4.13 (stat-first, memoized; the WP4 poller) |
| M9 | `commitRecord` drops `ManifestHunk.file` | code: `record.js:268-277` | A: 2.10 |
| M10 | About 35 `isSnapshot` sites need a per-kind decision | code: `grep` finds 35 sites in 12 files | A: 2.9 classification table plus grep test |
| M11 | The UI seam is too narrow for WP4's must-not-touch list | code: banners in `App.js`, ThreadCard/ThreadPanel/StatusBar gates, `'review'` defaults | A: 2.14 (`KindBanners`, `KindSide`, `kindCaps`, the `review` mode key reused, WP0b edits every consumer) |
| M12 | `DiffTable` is new work, not an extraction | code: `SourceView.js:167` has new-side buttons only | A: a new `DiffTable`; `SourceView` untouched (4.14) |
| M13 | Pinning the base balloons the review after a merge of main | reasoned | A: the merge-base is re-computed each round for ref bases (4.6) |
| M14 | `:(exclude).specreview` misses nested stores | reasoned (git pathspec semantics) | A: `:(exclude,glob)**/.specreview/**` (4.3) |
| M15 | Config has only a workspace layer | code: `config.js` reads `.specreview/config.json` only | A: 2.4 user layer |
| M16 | The installer's "compatible" claims contradict the tests | code: `cli-install.test.js:100-131` | A: 7.3 lists the behaviour changes (the branch's updated tests) |
| M17 | Per-doc render network has no writer; the CSP is not one expression | code: `content.js:185-196` | A: 2.7 (`#csp(wsId, doc)`), 2.8 (`render` on `createSnapshotDoc`) |
| M18 | An old daemon keeps serving the new kinds | code: `daemon-client.js:72-90` compares versions only | C: `buildId` in health, plus restart (2.13); the version bump stays in WP6 |
| M19 | WP0 is overloaded; files are claimed twice | code: `store-snapshot.test.js`, `last.js` and `transcript.js` exist | A: WP0a/WP0b split; "create" checked against `git ls-files` (9) |
| m1 | `write-tree` on the real index takes `index.lock` | reasoned | A: staged mode also uses an index copy (4.3) |
| m2 | `add -A` runs clean filters | reasoned | C: documented (4.3); the new side is read from disk. **R** for switching to `hash-object --no-filters`: it would store full LFS contents and make every LFS file differ from base. |
| m3 | `formatOf` turns code quotes into markdown | code: `anchor/util.js:51-54` | A: 2.9 |
| m4 | `codeSuggestionFor` returns too little | reasoned | A: the full `Suggestion` shape (4.7, 9.3) |
| m5 | "Resubmitted unchanged" has nothing to key on | code: identical text records nothing | A: `waiter.since` against the head's `createdAt` (3.10) |
| m6 | The plan-file write-back is dead and impossible | code: reviewer apply on snapshots is refused | A: removed (3.4) |
| m7 | `plan-notes` is not builtins-only | reasoned | A: in `hooks.js` (3.2) |
| m8 | `review-code` is too generic a skill name | reasoned | A: `specreview-code`, `specreview-last` (7.2 G6) |
| m9 | WP5 depends on files that WP6 creates | reasoned | A: Claude commands are copied dynamically; names frozen (9.5) |
| m10 | `--keep-scripts` with permissive sandbox flags | code: `frame.js:16-17` | A: dropped; strict sandbox (2.7, 6.2) |
| m11 | Recovery does not sweep `blobs/` | code: `recovery.js` `DOC_SUBDIRS` | A: 2.9 |
| m12 | `diff --stat` needs an unowned file | reasoned | A: WP3 owns `diff.js` |
| m13 | `--no-deps` exists only in tests | code: the branch uses a fake `npm` instead | A: no `--no-deps`; the branch's approach (9.5) |
| m14 | Closed-doc semantics are inconsistent | code: `openSnapshot` reopens | A: one rule (2.1): re-take reopens, except plan docs, which pause |
| m15 | The PR contents-API fallback is extra scope | reasoned | A: dropped (4.18) |

### A.2 `critique-agent-ux.md`

| # | Point | Check | Disposition |
|---|---|---|---|
| 1 | Plan threads never get replies or statuses, so Verify is empty | code: statuses change only through replies; the gate posts none | A: automatic `addressed` for linked threads (2.10), plus reply lines gated by spike S3 (3.5) |
| 2 | Double delivery and `wait --all` exiting at once | code: `wait.js:63-70,145-147` | A: 2.6 |
| 3 | The approve-with-notes text says "call ExitPlanMode again" | code: `packet-data.js:427-429`, `packet.js:142` | A: `formatPlanNotes` (3.6) |
| 4 | The PostToolUse channel is unverified; notes are marked delivered too early | notes: rcc question 4 | A: S1; two-phase delivery, with the notes record consumed separately (3.6) |
| 5 | The design renames shipped shapes; the installer regex misses `plan-gate` and `hookEntries` installs the gate without opt-in | code: `install.js:216-245` at HEAD; `OUR_HOOK_RE` in the branch | A: the shipped names are kept (1.2); the branch's regex and flags (7.1, G2) |
| 6 | Code NEXT is wrong for staged, branch, range and commit modes | reasoned | A: per-mode NEXT; fixed endpoints switch to the working tree after v1; the missing-step refusal (4.2, 4.6) |
| 7 | A review submitted after the gate stopped is lost | code: `hooks.js:219-220` skips plan docs | A: the gate marker plus the `hook prompt` late line plus `feedback` in notes framing (3.9). The "Send to Claude as notes" button is **R**: the prompt hook delivers automatically, and a button would need a new route for no gain. |
| 8 | Packet paths are cwd-relative; the `at` base is unspecified; Read-before-Edit is missing | reasoned | A: root-relative paths plus a `Repo root:` line; `at` resolution; PROTOCOL (2.11, 4.10) |
| 9 | Overflowing plan feedback points to `show`, which plan mode cannot run | code: `packet.js:178-181` | A: the overflow file plus Read (2.6, S4) |
| 10 | The shared skill is Claude-specific and is seen twice | code: `SKILL.md` uses `run_in_background` and `Claude_Browser` | C: the branch already installs a neutral `specreview-review` skill into `~/.agents`; the Claude skill marks its Claude-only steps; a test bans Claude-only text in non-Claude outputs (G7). Merging the two skills into one is **R**: renaming the plugin's `spec-review` skill breaks existing installs. |
| 11 | MCP timeouts do not fit Copilot, OpenCode or Cursor | notes: roa:500-503, 452 | A: G4, G5, G7, S5 |
| 12 | `--name last-answer` merges unrelated messages | reasoned | A: the temp file plus `open -` without `--name` (5.1). A Codex rollout reader in WP2 is **R** for this round: the shipped code notes that the format is not documented well enough to parse safely. |
| 13 | Message and stdin docs can only be revised by regenerating them | code: `packet-data.js:441` | A: the edit copy (5.3) |
| 14 | URL docs have no agent loop | reasoned | A: basis line, two NEXT variants, `--replies`, text output, the low-text note (6.2) |
| 15 | The folder flow loses `--all` after one round | code: `packet-data.js:411-419` | A: `deliveredVia` (2.6) |
| 16 | `uiClients` is global | code: `sse.js:50-52` | A: per-doc `docClients` (2.13). `statusMessage` is deferred: whether it shows during PermissionRequest is unverified. |
| 17 | Subagent ExitPlanMode is not handled | notes: rcc:158 | A: fail open, or key on `agent_id` when enabled (3.4) |
| 18 | `approveMode: "plan"`; no per-approval mode choice | reasoned | A: `plan` removed from the enum; "Approve + accept edits" (3.10) |
| 19 | The fork row is wrong; the plan file is cited for inline plans | notes: rcc:28; code: `planFileOf` is null for inline | A: 3.5; the file is cited only when the text came from it (3.4) |
| 20 | A non-zero exit or PATH aborts `!` commands | notes: rcc:438 | A: `2>&1 \|\| true` (4.15, 5.1); absolute `!` lines (G8) |
| 21 | Every round prompts for permission | notes: rcc:418 | C: opt-in `--with-permissions` with a narrow list and no network verbs (G9) |
| 22 | Reviewer "Apply now" on code records no round | reasoned | A: a `ui-apply` round (4.11) |
| 23 | Other sessions' message docs surface | code: `hooks.js:217-244` | A: session filter (2.6, WP1 `hook prompt`) |
| 24 | `final --decisions` writes into the repo | code: `final.js` uses the cwd for snapshots | A: code docs write into the doc dir (2.9) |
| 25 | PR mode gives no checkout command | reasoned | A: `gh pr checkout` and `not-checked-out` (4.18) |
| 26 | Overflow threads are fetched one `show` at a time | code: `packet.js:178-181` | C: one overflow file for every kind (2.6) |
| 27 | FILE MISSING has no next action | reasoned | A: 4.10 |
| 28 | `agent` on PATH is too generic for Cursor | code: the branch detects `cursor` and `cursor-agent` only | already fixed in the branch |
| 29 | `claude mcp add` run inside Claude Code | code: the branch prints it | already fixed in the branch |
| 30 | Gemini sunset; Antigravity not reported | code: the branch lists Antigravity as unverified | C: reported as unverified (7.1). A planner is **R** for this round: none of its surfaces are verified. |
| 31 | Plugin plus settings hooks duplicate | code: the branch refuses when the plugin is installed | already fixed; doctor also reports it (G14) |
| 32 | `install.sh` is not one step under `curl \| sh` | code: the branch needs `--yes` | A: the `/dev/tty` confirmation (G13) |
| 33 | The draft's extraction spec drops the rewind rule | code: `transcript.js:11-17` | A: the shipped algorithm is frozen (1.2) |
| 34 | There is no per-session "stop gating" | code: `openSnapshot` reopens closed docs | C: a closed plan doc pauses gating (3.8); no extra flag file |
| 35 | The Gemini confirmation order is unverified | notes: roa:261-268 | A: Gemini gate deferred (3.14, Q1) |

### A.3 `critique-test-security-scope.md`

| ID | Point | Check | Disposition |
|---|---|---|---|
| B1 | Stale baseline; three WPs would duplicate code | code | A: 1.2, 1.3, 9 |
| B2 | Working-tree reads follow symlinks out of the workspace | code: `stable-read.js:114-116` uses `stat` and `readFile` | A: `readRepoFile` contract (2.8); the new side read through it (4.3); tests (8) |
| B3 | Tests are not hermetic | code: `review-pure.test.js:283-287`; `transcript.js` uses `os.homedir()` | A: 2.15 |
| M1 | Untrusted web content runs scripts and reaches the network | code: `markdown.js:74-75` (`rehype-raw`), `content.js:189-190`, `frame.js:16-17` | C: GitHub-schema allowlist sanitizer plus Markdown without raw HTML (6.2); strict CSP and sandbox for every snapshot doc (2.7). A `render.rawHtml` flag is **R**: every render caller would have to pass it consistently, or anchors break; conversion makes it unnecessary. |
| M2 | Committed repo config controls security-relevant keys | code: `config.js:2`; `.specreview/config.json` is committed | A: 2.4 |
| M3 | Network holes: daemon re-fetch, MCP-initiated fetches, unvalidated `gh` output | reasoned | A: the daemon never fetches (4.18); MCP has no private hosts, Jina or PR (2.12); `gh` output validated (4.18) |
| M4 | Hostile file names forge lines | reasoned (git allows any non-NUL byte) | A: unsupported names skipped; literal pathspecs; `at` parsed from the right (4.3, 2.11) |
| M5 | Git hygiene: hooks run, env leaks, temp-index collisions, untracked secrets, nested stores | the critique tested git 2.43 for hooks; reasoned for the rest | A: 4.3 (a-e) |
| M6 | Installer write safety | code: the branch prints `claude mcp add` and has `stillUsesShared`; atomic rename clobbers symlinks (`files.js`) | A: G10, G11, G12, G2; (a) and (d) already in the branch |
| M7 | PR mode is the riskiest path and the least aligned with the user's focus | the task text says "optionally" | A: WP3b, optional, without the API fallback (4.18) |
| M8 | Tests are not CI-ready | code: no `.github/` | C: (b) no feature sniffing (9.4 `code-routes-real`); (c) no test-only flag (9.5); (d) negative tests per control (8); Chrome specs fail loudly. (a) **R** for adding a CI workflow: no CI exists today, and the user scoped this round to features; the gates run locally. |
| m1 | `content.js` uses `isSnapshot`, so code docs reach live files | code: `content.js:370` | A: 404 for code docs (2.7, 2.9) |
| m2 | The plan write-back is dead code with a write surface | code: the shipped gate has none | A: removed; plan reads restricted (3.4) |
| m3 | SSRF details | reasoned | A: 6.2 (pinning through `lookup`, any non-public address, mapped and NAT64, userinfo, no query to Jina) |
| m4 | `/review-code` injects `$ARGUMENTS` without a guard | reasoned | A: `disable-model-invocation` required and tested (4.15, 9.6) |
| m5 | `writeRepoFile` refusals miss `.git` files and case variants | reasoned | A: 2.8 |
| m6 | The Gemini adapter cannot be verified | notes: roa | A: deferred (3.14, Q1) |
| m7 | Nothing is cleaned up | reasoned | C: PR refs deleted on close (4.18); doctor reports blob size. Deleting blobs on close is **R**: closed reviews must stay viewable, and the blobs are git-ignored and local. |
| m8 | No minimum git version | reasoned | A: `GIT_MIN_VERSION` 2.32 (2.3, 4.2) |
| m9 | `last` falls back to another session's transcript | code: `transcript.js:60-68` | A: exit 4 for an explicit id (5.1) |

### A.4 Draft items changed without a critique

| Draft item | Final |
|---|---|
| `last --turn` | dropped: not shipped, and not needed for parity |
| `open -` deduplication by sha16; exit codes 3 and 4 for stdin, folder and `last` | the shipped behaviour is kept (1.2) |
| `open <dir>` with a `git check-ignore` pass and exit 3 over the cap | the shipped walker plus `FOLDER_EXCLUDES`; truncation kept (6.1) |
| `plan:claude:<realpath>` and `msg:<id>` keys | the shipped keys (2.1) |
| The `#n` suffix for re-taking closed code docs | one reopen rule (2.1) |
| A pinned base per round | re-computed for ref bases (4.6) |
| The cleanHtml denylist | the allowlist sanitizer (6.2) |
