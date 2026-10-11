# Code review: frozen contracts after WP0b

Worktree `/home/claude/work/sr-code`, branch `feat/code-review`. The baseline is `cc9c98f`; WP0b is the 7 commits on
top of it (`ab0a8fb` … `215a469`).

**Read this first:**
- The code is the source of truth. Every path below is relative to the repo root and was checked against the code.
  Where this file and `design-final.md` disagree, this file wins (see section 14).
- "Frozen" means the export name, the signature and the data shape. Bodies may change. A change to anything frozen
  needs a note to the other work package and an update to this file.
- Every `src/core/code/*` function is a stub today. It throws
  `UsageError('code review is not available in this build', {details: {kind: 'code'}})`, which maps to exit 1 on the
  CLI and HTTP 422 in the daemon. The message is exported as `CODE_NOT_AVAILABLE` from `src/core/code/index.js`.
- Callers are already wired (op dispatch, kind adapter, packet, CLI, MCP). WP3 only replaces bodies. WP4 only
  replaces the placeholder components and adds the routes, the poller and the styles.

---

## 0. Ownership

### ENGINE (WP3): files WP3 owns

**Create:**
- `src/core/code/git.js`
- `src/core/code/spec.js`: `resolveSpec`, `specKey`, `specLabel`, `docIdFor`
- `src/core/code/snapshot.js`: `takeCodeSnapshot`
- `src/core/code/diff-text.js`
- `test/helpers/git-repo.js`, which builds on `test/helpers/hermetic-env.js`
- `test/unit/code-{git,spec,diff-text,anchor,attribution,packet,apply,files,state,security}.test.js`
- `test/integration/{cli-review,e2e-code-loop}.test.js`
- `test/fixtures/packets/code-round1.txt`

**Replace the stub bodies** (keep the signatures in section 7):
- `src/core/code/index.js`: add exports only, and keep `CODE_NOT_AVAILABLE`
- `src/core/code/{review,round,state,capture,forward,packet,apply,files,threads}.js`

**Modify:**
- `src/cli/commands/review.js`: replace `execute` only. `spec`, `parse` and `reviewInput` are frozen.
- `src/cli/commands/{ask,reanchor,show}.js`: add `--file` (and `--side` on show) and forward `input.file` and
  `input.side` to the ops. The ops and the MCP tools already accept them (section 9).
- `src/cli/commands/diff.js`: diff output for code docs.
- `src/core/anchor/describe.js`: export `linesAround` and `windowAround` only.

**Must not touch:**
- store (`src/core/store/**`), `src/core/review/ops/record.js`, `ops/revise.js`
- the packet text (`src/core/review/packet.js`), `src/core/review/packet-data.js`, `src/core/review/kinds.js`
- `src/ui/**`, `src/daemon/**`, `src/mcp/tools.js`, the installer, `integrations/**`
- `src/core/util/code-at.js` (call it; do not change it)

### UI (WP4): files WP4 owns

**Create:**
- `src/ui/components/kinds/DiffTable.js`
- `src/ui/styles/code.css`: tokens only (`tokens.css`); link it after `views.css`
- `test/e2e/{mock-code.mjs,code-review.spec.mjs}`
- `test/integration/{daemon-code-routes,code-routes-real}.test.js`

**Replace the placeholders:**
- `src/ui/components/kinds/{CodeReviewView,FileTree,CodeBanner,CodeSide}.js`

**Modify:**
- `src/daemon/api.js`: one code-routes block (section 11.2)
- `src/daemon/watch.js`: the poller block (section 11.3)
- `src/ui/api.js`: `docApi(...).files`, `.fileDiff`, `.fileSource`
- `src/ui/index.html`: one `<link>`
- `test/e2e/mock-server.mjs`: `docRoute` entries and the `code` scenario
- `test/e2e/model.test.mjs`: extend only

**Must not touch:**
- the existing CSS files, `SourceView.js`
- `App.js`, `Banners.js`, `kinds/index.js`, `kinds/PlanBanner.js` (WP1)
- `model.js`, `actions.js`, `keys.js`, `commands.js`
- `TopBar.js`, `StatusBar.js`, `ThreadCard.js`, `ThreadPanel.js`, `Home.js`
- `src/core/**`, `src/cli/**`, `src/mcp/**`

### Shared (WP0b): frozen, owned by neither

| Area | Files |
|---|---|
| Types and constants | `src/shared/types.js`, `src/shared/protocol.js` (code constants) |
| Store | `src/core/store/{store,snapshot,recovery}.js` |
| Render and anchors | `src/core/render/index.js` (`'text'`), `src/core/anchor/util.js`, `src/core/review/anchoring.js` |
| Kind adapter and ops | `src/core/review/kinds.js`, `src/core/review/ops/*.js`, `src/core/review/ops.js` |
| Packet and git | `src/core/review/{packet-data,packet,git}.js` |
| `at` grammar | `src/core/util/code-at.js` |
| CLI | `src/cli/{args,schemas,hooks}.js`, `src/cli/commands/{reply,doctor,index}.js` |
| MCP | `src/mcp/tools.js` |
| Daemon | `src/daemon/{content,api,watch}.js`, apart from WP4's two blocks |
| UI | `src/ui/{model,actions,keys,commands}.js`, `src/ui/components/{App,Banners,TopBar,StatusBar,ThreadCard,ThreadPanel,Home}.js`, `src/ui/components/kinds/index.js` |
| Tests | `test/unit/{review-kind-contract,kind-classification,code-at,code-cli-seams,store-blobs,store-repofile,packet-code-grammar,hermetic-env}.test.js`, `test/helpers/hermetic-env.js`, `test/fixtures/packets/code-item-grammar.txt` |

---

## 1. Data shapes (`src/shared/types.js`)

### Primitives
```js
/** @typedef {'markdown' | 'html' | 'text'} DocFormat */     // 'text' = code docs (never rendered)
/** @typedef {'file' | 'snapshot' | 'code'} DocKind */
/** @typedef {{ path: string, side: 'new' | 'old', oldPath?: string }} AnchorFile */
```

### Doc (doc.json) of a code doc
```js
{
  schema: 1, id, kind: 'code',
  origin: { type: 'diff', key: string | null, ... },  // key is the identity (WP3 specKey: 'diff:<mode>:<spec>[+paths=...]')
  code: CodeSpec,                                     // fixed for the doc's life
  ephemeral: true,                                    // the doc dir has '.gitignore' = '*\n'; autoCommit skips the doc
  path: 'code/<id>.diff',                             // synthetic; never read or written. Versions: versions/NNNN.diff
  format: 'text', title, createdAt, createdBy, state, head, lastReviewedVersion, final, counters
}
```

### CodeSpec (`doc.code`)
`mode` is one of `CODE_MODES`.
```js
{ mode: 'since-base'|'uncommitted'|'staged'|'branch'|'range'|'commit'|'pr',
  base?: string, from?: string, to?: string, threeDot?: boolean, commit?: string,
  pr?: { repo: string, number: number, url: string, headRefName: string },
  paths?: string[], context: number }
```
The store checks only the shape. WP3 validates the refs.

### CodeFile (`manifest.code.files[]`, sorted by path)
```js
{ path: string,                                // repo-root-relative POSIX (the old path for 'D')
  oldPath?: string,                            // 'R' only
  status: 'A'|'M'|'D'|'R'|'T'|'=',             // '=': unchanged vs base, carried because an open thread lives there
  old?: 'sha256:<hex>', new?: 'sha256:<hex>',  // Store#putDocBlob refs
  binary?: true,
  tooLarge?: { side: 'old'|'new', bytes: number|null },
  mode?: { old?: string, new?: string },       // '100644' | '100755' | '120000'
  added: number, removed: number }
```

### CodeManifest (`VersionManifest.code`)
```js
{ root: string,                                // absolute repo top level at capture time
  baseSha: string,                             // old-side commit, or the empty tree
  headSha: string|null,
  newSha: string|null,                         // branch/range/commit/pr; null for worktree and staged
  newTree: string|null,
  newSide: 'commit'|'worktree'|'index',
  baseMoved: { from, to } | null,
  files: CodeFile[],
  skipped: Array<{ path, reason: 'binary'|'too-large'|'submodule'|'excluded'|'unsupported-name' }>,
  stat: Record<string, { size: number, mtimeMs: number }> }   // worktree new-side stat cache
```

### Fields added to existing types
- **`VersionManifest`**: `capturedBy` gains `'round'` (a code round recorded by `revise`). `code?: CodeManifest`.
- **`ManifestHunk.file?: string`**: on code docs, the hunk's repo file. Hunk ids are `'<path>#h<n>'`.
- **`Anchor.file?: AnchorFile`**: on code docs. `src.startLine` and `src.endLine` are lines of that file side at
  version `v`. A whole-review anchor (`kind: 'doc'`) has no `file`. Line anchors are built like
  `anchorFromLines(...)`, giving `kind: 'source'`, `mappedBy: 'lines'`, `section: [file]`, plus `file`.
- **`Capture`** gains two code shapes:
  - `{ kind: 'line', file, side: 'new'|'old', startLine, endLine }`
  - `{ kind: 'file', file }`: a whole file, for binary, too-large or deleted files
  - A code doc also accepts `{ kind: 'doc' }` (a whole-review thread). Every other capture kind is refused.
- **`Comment`**:
  - `atLines?: LineRange`
  - `atFile?: string`: code, the file of `atLines`
  - `atCode?: CodeAtItem[]`: code, every item of the reply's `at`, with paths as written
  - `auto?: true`
- **`Suggestion`**: `mode` gains `'lines'` (whole lines of a repo file) and `file?: string` (new side only).
- **`PendingEdit.file?: string`**.
- **`RepoRead`** (the result of `Store#readRepoFile`):
  - `{ kind: 'file', buf: Buffer, text: string, sha256: string /* hex */, mode: number }`
  - `| { kind: 'symlink', target: string }`
  - `| { kind: 'other' }`
- **`PacketThread`** (`types.js` and `packet-data.js`), code fields, all optional:
  - `file: string|null`, `fileFromCwd: string|null`, `side: 'new'|'old'|null`
  - `was: string[]|null`
  - `fileState: 'ok'|'missing'|'not-checked-out'|'binary'|'too-large'|null`
  - `nowBetween: [number, number]|null`, `fileStatus: string|null`

---

## 2. Constants (`src/shared/protocol.js`)

```js
LIMITS.codeFileMaxBytes      = 5 * 1024 * 1024   // a changed file above this (either side) -> tooLarge stub
LIMITS.codeFileMaxLines      = 20000
LIMITS.codeMaxFiles          = 500               // `review` refuses more unless --max-files
LIMITS.codeContext           = 3
LIMITS.codeMaxFilesHard      = 5000
LIMITS.codeFileMaxBytesHard  = 20 * 1024 * 1024
LIMITS.untrackedExcludeMax   = 1000
LIMITS.codePollMs            = 5000              // daemon poll of a code doc's working tree
DOC_KINDS       = ['file', 'snapshot', 'code']
CODE_MODES      = ['since-base', 'uncommitted', 'staged', 'branch', 'range', 'commit', 'pr']
GIT_MIN_VERSION = '2.32.0'
CODE_TESTID = {
  view: 'code-view',              // CodeReviewView root; also data-view="code" and data-ready when loaded
  fileTree: 'code-file-tree',
  fileRow: 'code-file-row',       // + data-path
  fileDiff: 'code-file-diff',     // + data-path
  lineBtn: 'code-line-btn',       // + data-side="new|old" data-line
  stub: 'code-file-stub',         // binary / too-large / submodule placeholder
  resnapshot: 'code-resnapshot',  // "Re-snapshot" (POST D/record)
}
```
`SSE.WORKING_CHANGED` is `'working.changed'` (unchanged).

---

## 3. Store (`src/core/store/store.js`, `snapshot.js`, `recovery.js`)

### `createSnapshotDoc`
```js
Store#createSnapshotDoc({ title?, kind?: 'snapshot'|'code', format?, origin, slug?, createdBy?, code? })
  -> Promise<{ doc: Doc, created: boolean }>
```
For `kind: 'code'`:
- It requires `format: 'text'` (the default for code), `origin.type: 'diff'` and a CodeSpec in `code`. Otherwise it
  throws UsageError.
- It writes `.gitignore` (`*\n`) to the doc dir before doc.json, and sets `ephemeral: true`.
- The path is `code/<id>.diff`.

With `origin.key`, an existing doc with that key is returned (`created: false`). The check runs under the workspace
lock.

Errors:
- A key held by a doc of another kind throws ConflictError (`origin key "…" belongs to <id>, a <kind> doc`).
- `origin.type 'diff'` on a snapshot throws UsageError (the type is reserved for code reviews).

### Lookup and the virtual working copy
- `Store#findDocByOrigin(key) -> Promise<Doc|null>` finds snapshot and code docs.
- `Store#findDoc(...)` never returns a virtual doc by path or basename.
- `Store#workingPath`, `readWorking` and `writeWorking` treat code like snapshot. The "working copy" is the head
  version (the diff text) and writes are refused. The real working state of a code doc is
  `kindOf(doc).workingState` (section 5).
- `Store#commitVersion(doc, {source, ext?, manifest, assetFiles, beforeCommit})` stores `versions/NNNN.diff` for code
  docs, since the extension comes from `doc.path`.

### Blobs and repo files
```js
Store#putDocBlob(docId, buf: Buffer|Uint8Array|string) -> Promise<'sha256:<hex>'>   // idempotent, atomic; docs/<id>/blobs/<hex[0..2]>/<hex>
Store#readDocBlob(docId, ref: 'sha256:<hex>') -> Promise<Buffer>                     // NotFoundError if absent; UsageError if malformed
Store#readRepoFile(rel: string) -> Promise<RepoRead | null>                         // null = missing
Store#writeRepoFile(rel, text: string|Buffer, { expectSha256, allowed: Iterable<string> }) -> Promise<{ sha256, bytes }>
```

`readRepoFile` never follows a symlink: it uses lstat and `O_NOFOLLOW`, and a symlink returns its link text only. It
refuses (RefusedError):
- a parent whose real path leaves the root;
- any component that is `.git` or `.specreview` (case-insensitive);
- `..`, empty or absolute paths.

`writeRepoFile` is a compare-and-swap write:
- `expectSha256` is hex, and a `sha256:` prefix is accepted. A mismatch, checked before writing and again before the
  rename, throws ConflictError.
- It keeps the file mode and the encoding or BOM. It refuses text that does not decode losslessly.
- It refuses everything `readRepoFile` refuses, plus symlinks, non-regular files and any `rel` not in `allowed` (the
  head manifest's file list).
- A missing file throws NotFoundError.
- Callers match line endings themselves (`review/apply.js matchEol`).

The root is the workspace root, which is the repo top level for code reviews.

### `snapshot.js` helpers
```js
SNAPSHOT_KIND = 'snapshot'; CODE_KIND = 'code'
isSnapshot(doc) -> boolean;  isCode(doc) -> boolean;  isVirtual(doc) -> boolean   // snapshot or code
docKind(doc) -> 'file'|'snapshot'|'code'
docOriginType(doc) -> string|null        // 'plan'|'message'|'stdin'|'diff'|... ; null for file docs
codePath(slug) -> 'code/<slug>.diff'
docRefFor(id, root) -> string            // the doc as follow-up commands name it
codeEditRefusal(doc, ref) -> string      // message of refuseCode
```

### Recovery and git
- `recoverDoc` sweeps temp files in `blobs/<xx>/` and removes stale `code-index-*` temp dirs (older than 1 h) from
  `$SPECREVIEW_HOME/ws/<wsId>/cache/`. WP3 must create its temp index copies with `fs.mkdtemp(<cache>/code-index-)`.
- `autoCommit({..., ephemeral})` with `ephemeral: true` returns `{ commit: null, skipped: 'ephemeral doc' }`.
  `record.js` passes `doc.ephemeral`.

---

## 4. Render (`src/core/render/index.js`)

- `normalizeFormat('text') -> 'text'`.
- `renderSourceSync` and `getRender` return `textRender()` for `'text'`.
- `textRender()` returns this RenderResult:
  ```js
  { format: 'text', html: '', guestInsertAt: 0, bodyEndAt: 0, srcmap: { order: [], nodes: {} },
    text: { text: '', spans: {} }, outline: [], assets: [], externals: [], title: '',
    features: { mermaid: false, math: false, code: false } }
  ```
- A code doc is never framed. The content origin returns 404 for it (section 11.1).

---

## 5. Kind adapter (`src/core/review/kinds.js`)

```js
kindOf(doc) -> KindAdapter        // codeKind if isCode(doc), else fileKind (file and snapshot docs, unchanged)
versionLoader(ctx, doc) -> (v) => Promise<{ source, render, manifest }>
preview(anchor, source, title) -> CapturePreview      // file kinds
SNAPSHOT_SITES                                        // frozen map; see below
```

The KindAdapter shape:
```ts
KindAdapter = {
  kind: DocKind,
  render(ctx, doc, v: number|'live', source?) -> Promise<RenderResult>           // code: textRender()
  forwarder(ctx, doc) -> (anchor, toVersion) => Promise<Record<string, Anchor>>  // code: codeForwarder
  capture(ctx, doc, capture, v, opts?: { widen? }) -> Promise<{ anchor, preview: CapturePreview }>  // code: resolveCodeCapture
  workingState(ctx, doc, head: HeadState|null) -> Promise<WorkingState>          // code: codeWorkingState
  describeThread(snap, thread, opts: DescribeOpts) -> ThreadView | null          // code: describeCodeThread (null when no anchor at head)
  loadExtra(ctx, doc, snap) -> Promise<void>                                     // code: loadCodeSnapshot (sets snap.code)
}
CapturePreview = { label: string, lines: [number, number]|null, section: string[], src: string, text: string }
WorkingState   = { text, sha256: string|null, buf: Buffer|null, missing: boolean, dirty: boolean }
HeadState      = { v, manifest, source }
DescribeOpts   = { workingText?, attachmentPath?: (rel) => string, env?, config?, cwd?: string|null, root?: string|null }
ThreadView     = { lines, src, srcUnique?, srcWindow?, srcEditable?, on?, label?, crops?, cropKind?, lastKnown?,
                   file?, fileFromCwd?, side?, was?, fileState?, nowBetween?, fileStatus? }
```

### Op dispatch on `isCode(doc)`, at op entry

| Op | File | Code path |
|---|---|---|
| `revise` | `ops/revise.js` | `reviseCode(ctx, doc, parsedInput)`. `--source` is refused for code. |
| `recordReviewerVersion` (`POST D/record`) | `ops/revise.js` | `recordCodeRound(ctx, doc, {author: human, capturedBy: 'ui-record'})`. `{nothing}` gives RefusedError "the working tree matches vN; nothing to record". Returns the manifest. |
| `applySuggestionAsReviewer` (`POST D/threads/:tid/apply`) | `ops/revise.js` | `applyCodeSuggestions(ctx, doc, [tid], {dryRun: false, actor: human})`, then `recordCodeRound(…, 'ui-apply')`. |
| `applySuggestions` | `ops/edits.js` | `applyCodeSuggestions(ctx, doc, uniqueTids, {dryRun, actor: agent})` |
| `taggedEdit`, `taggedEdits`, `revert` | `ops/edits.js` | `refuseCode`: RefusedError, exit 3 |
| `addLock`, `relock` | `ops/locks.js` | RefusedError "code reviews have no locks", before any render |
| `resolveCapture` (`POST D/anchors/resolve`) | `ops/drafts.js` | `kindOf(doc).capture` |
| Draft suggestion | `ops/drafts.js` | `{...await codeSuggestionFor(ctx, doc, anchor, anchor.v), new, status: 'pending', appliedIn: null}` |
| `submit` (drafts from older versions) | `ops/submit.js` | `kindOf(doc).forwarder` |
| `ask` | `ops/threads.js` | `askCode(ctx, doc, {file, lines, body})`. `quote` is refused. A spec doc refuses `file`. |
| `reanchorThread` | `ops/threads.js` | `reanchorCode(ctx, doc, tid, {file, lines})`. `quote` is refused. |
| `moveThread` (`POST D/threads/:tid/move`) | `ops/threads.js` | A capture is required: `kind.capture`, then `kind.forwarder`, then the head anchor with `mappedBy: 'override'`. |
| `reply` with `at` | `ops/threads.js` | `parseCodeAt(at, {defaultFile: thread's anchor file})` gives `{atCode, atFile, atLines}` |
| `show({file, side, version})` without a thread | `ops/threads.js` | `{kind: 'code-source', doc, ...codeFileSource(ctx, doc, {path, v, side})}` |
| `show` with a thread | `ops/threads.js` | `showCodeThread`, through `describeThread`; `changes: []` |
| `changes` (`GET D/diff`) | `ops/changes.js` | `codeChanges(ctx, doc, range)` |
| `sourceDiffOp` (`GET D/diff/source`) | `ops/changes.js` | `codeFileDiff(ctx, doc, range)`. The `path` comes from the range (none today; WP3 decides). |
| `unifiedDiff` | `ops/changes.js` | `codeUnifiedDiff(ctx, doc, range)` |
| `threadMiniDiff` (`GET D/threads/:tid/minidiff`) | `ops/changes.js` | `codeThreadMiniDiff(ctx, doc, tid)` |
| `domTargets` (`GET D/versions/:v/targets`) | `ops/changes.js` | `{version, threads: [], locks: [], drafts: [], outline: []}` |
| `docState` (`GET D`) | `ops/docs.js` | `working = {dirty, sha256, missing, changedFiles}` from `kindOf(doc).workingState`. Strict: a stub error gives 422. |
| `status` | `ops/docs.js` | `kind: 'code'`, `origin: 'diff'`, `ref`, `file: null`, `pathFromCwd: null`. An engine error gives working `'unknown'`. |
| `final` | `ops/final.js` | Compares with `readWorkingState`. Without `--out`, writes `decisions.md` to `.specreview/docs/<id>/`. |
| `waitForFeedback` | `ops/wait.js` | `wait --all` skips the dirty pre-check for virtual docs. `wait <code-doc>` checks it through the adapter. |
| `readWorkingState` | `ops/common.js` | `kindOf(doc).workingState` for every kind |
| `loadSnapshot` | `ops/common.js` | calls `kindOf(doc).loadExtra` |
| `recordSnapshot` | `ops/snapshot.js` | "is not a snapshot doc" (refuses code docs) |

`ops/common.js` exports:
```js
refuseCode(ctx, doc)              // RefusedError(codeEditRefusal) when isCode
respondsToOf(reviews, agent) -> string | null
```

### `SNAPSHOT_SITES`
Every remaining snapshot check, as path relative to `src/` with its count:
```js
{ 'core/review/ops/revise.js': 2, 'core/review/ops/snapshot.js': 1, 'core/review/ops/common.js': 1,
  'core/review/ops/docs.js': 1, 'core/review/ops/final.js': 1, 'core/review/packet-data.js': 1,
  'core/review/packet.js': 6, 'cli/hooks.js': 1, 'ui/components/Home.js': 1, 'ui/model.js': 1 }
```
`test/unit/kind-classification.test.js` greps for `isSnapshot(` and `kind ===/!== 'snapshot'` and fails on any
difference. A new check needs a classification in the `kinds.js` header and an update to this map. WP3 and WP4 should
use `isCode` or `isVirtual` instead.

---

## 6. Record seams (`src/core/review/ops/record.js`)

`prepareRecord` and `commitRecord` are unchanged for spec docs. A code round builds its own `Prepared` and calls
`commitRecord`.

```js
commitRecord(ctx, doc, prep: Prepared, {
  author, summary, capturedBy: 'revise'|'ui-record'|'ui-apply'|'snapshot'|'round', respondsTo,
  manifestExtra?: Record<string, unknown>,   // a code round passes { code: CodeManifest }
  replies?, autoReply?, breakLocks?, finish?,
}) -> Promise<{ manifest, anchors: {threads, locks, exact, moved, edited, changed, orphaned}, git }>
reportHunks(prep)
```

The seam fields are optional on `Prepared`. When one is absent, today's behaviour applies.
```ts
stepFor?(item: Thread|Lock, prev: Anchor, linkIds: string[],
         extra: { linked?: boolean, override?: { lines?: [number, number], quote?: string } | null, toVersion: number }) -> Anchor
landed?(thread: Thread, linkedHunks: AttributedHunk[]) -> boolean
assetFiles?: Record<string, string|null>
```
- `stepFor` replaces `stepAnchor` in the version journal.
- `landed` replaces `suggestionLanded`: whether a staged suggestion's text is really in the new version.
- `assetFiles` is passed to `commitVersion`. Code docs pass `{}`. The default is the working render's assets, and a
  virtual doc has none.

A code round's `Prepared.hunks` and `attribution.hunks` carry `file`, with ids `'<path>#h<n>'`. The manifest gets
`hunks[].file`.

---

## 7. Code engine (`src/core/code/*`): frozen signatures

All of these are re-exported from `src/core/code/index.js`. `ops.js` additionally re-exports `openCodeReview`,
`codeFiles`, `codeFileDiff` and `codeFileSource`, so `engine.call('codeFiles', ...)` works in the daemon.

### `review.js`
```js
openCodeReview(ctx, { input: ReviewInput, title?: string })
  -> Promise<{ doc: Doc, created: boolean, version: VersionManifest, recorded: boolean, code: CodeManifest }>
```

### `round.js`
```js
reviseCode(ctx, doc, input: ReviseInput & Record<string, unknown>)   // parsed ReviseInput; `at` in code forms
  -> Promise<ReviseReport & { code: { files: number, baseMoved: {from, to} | null, carried: string[] } }>
recordCodeRound(ctx, doc, { author: Actor, capturedBy: 'ui-record'|'ui-apply'|'round' })
  -> Promise<{ manifest: VersionManifest } | { nothing: true, v: number }>
```

### `state.js`
```js
codeWorkingState(ctx, doc, head: HeadState|null)
  -> Promise<WorkingState & { changedFiles: string[] }>
```
`text`, `sha256` and `buf` describe the canonical diff text of the working tree. `dirty` compares it with head.
`changedFiles` lists repo-relative paths. Memoize it: 2 s per `(doc, head)`.

### `capture.js`
```js
resolveCodeCapture(ctx, doc, capture: Capture, v: number)
  -> Promise<{ anchor: Anchor /* file set, except kind 'doc' */,
               preview: { label, lines: [number, number]|null, section: string[], src, text } }>
codeSuggestionFor(ctx, doc, anchor, v) -> Promise<Suggestion>   // mode 'lines', file (new side), old = anchored whole lines
```
- `resolveCodeCapture` accepts `line`, `file` and `doc` captures, and refuses any other kind with UsageError.
- `preview.text` should read like `'Agent will see: src/a.js:L3-4'` or `'… src/a.js (old side) L7'`. The UI shows
  `preview.label` in the anchor chip.
- `codeSuggestionFor` returns a suggestion without `new`, `status` or `appliedIn`; `drafts.js` sets those.

### `forward.js`
```js
codeForwarder(ctx, doc) -> (anchor: Anchor, toVersion: number) => Promise<Record<string /* 'v' */, Anchor>>
```
The forwarder keeps `anchor.file`, following renames, and maps the line numbers of that file side. It never
re-anchors on the diff text.

### `packet.js`
```js
loadCodeSnapshot(ctx, doc, snap) -> Promise<void>     // snap.code = { manifest: CodeManifest, blobs, working, root }
describeCodeThread(snap, thread, opts: { cwd?, root?, attachmentPath? })
  -> { file, fileFromCwd, side, lines, src, was, fileState, srcUnique?, nowBetween?, fileStatus? }
codePacketLabel(snap) -> string        // 'since-base origin/main, merge-base 1a2b3c4'
codeLineBasis(snap, threads: PacketThread[]) -> string[]   // 'Repo root: …' first, then 'Line numbers = …', then a base-change line
codeNextStep(doc, ref, { approved, finalNow }, actionable: number) -> string   // without the 'NEXT: ' prefix
```
- In `loadCodeSnapshot`, `blobs` is `(ref) => Promise<Buffer>` or a cache.
- In `describeCodeThread`, `lines` are new-side lines of the working tree, or base lines for the old side. `src` holds
  the exact working-file lines. `was` holds base lines (old side). `nowBetween` gives the working lines an old-side
  position falls between. A `fileStatus` of `'A'` prints "(new file)".

### `apply.js`
```js
applyCodeSuggestions(ctx, doc, tids: string[], { dryRun?: boolean, actor: Actor })
  -> Promise<{ applied: Array<{ id, file, lines: [number, number], how: string }>,
               conflicts: Array<{ id, reason }>, skipped?: Array<{ id, reason }>, dryRun: boolean }>
```
Each thread needs `suggestion.file` and a new-side anchor. Write with `Store#writeRepoFile` (CAS, `allowed` = the
head file list). `packet.js formatApply` prints the result.

### `files.js`
These back the daemon routes (section 11.2) and the CLI `diff`.
```js
codeFiles(ctx, ref, q: { v } | { from, to })
  // {v}:        { v, files: Array<CodeFile & { threads: string[] }>, skipped }
  // {from, to}: { from, to, files: Array<{ path, oldPath?, change: 'changed'|'added'|'dropped'|'renamed', added, removed, threads: string[] }> }
codeFileDiff(ctx, ref, q: ({ path, v } | { path, from, to }) & { context?: number })
  // { path, oldPath?, v | (from, to), stub?: 'binary'|'too-large'|'submodule'|'excluded'|'unsupported-name',
  //   hunks: Array<DisplayHunk & { threads: string[] }> }      NotFoundError for a path not in the round
codeFileSource(ctx, ref, { path, v, side: 'new'|'old' }) -> { path, side, v, text, lines }
codeChanges(ctx, ref, range: { from?, to? })
codeUnifiedDiff(ctx, ref, range: { from?, to? })      // { from, to, patch }  (like unifiedDiff)
codeThreadMiniDiff(ctx, ref, tid)
```
- `DisplayHunk` comes from `src/core/diff/source-diff.js`:
  ```js
  { id, header, hunkIds, rows: DiffRow[] }
  // DiffRow = { op: ' '|'-'|'+', oldNo, newNo, text, words: [start, end, 'ins'|'del'][], hunk? }
  ```
- **`codeChanges` must stay ChangeSet-compatible**, because the UI keeps it in `s.changes` (via `GET D/diff`):
  ```js
  { from, to, stats, hunks: Array<{ id: '<path>#h<n>', file, op?, section?: [], threads, linkedBy, other, … }>,
    assets: [], threadLinks: Record<tid, hunkId[]>, guards: { forced, brokenLocks: [] } }
  ```
  The UI reads `hunks[].id` (n/p, "mark seen"), `hunks[].threads`, `hunks[].section`, `hunks[].op`, `stats` and
  `assets`.
- **`codeThreadMiniDiff` must return the current shape**, because `ThreadPanel`'s Verify queue renders it and WP4
  does not touch ThreadPanel:
  ```js
  { kind: 'text', version: head, from: base, before: string, after: string, words, state }
  ```

### `threads.js`
```js
askCode(ctx, doc, { file?: string|null, lines?: [number, number]|null, body })
  -> Promise<{ thread, version, lines: [number, number]|null }>        // no file: a whole-review thread
reanchorCode(ctx, doc, tid, { file?: string|null, lines?: [number, number]|null })
  -> Promise<{ thread, anchor: Anchor|null, staged: boolean }>
```

### Still to come from WP3 (signatures from the design, not in the tree yet)
```js
resolveSpec(git, input, config) -> CodeSpec;  specKey(spec) -> string;  specLabel(spec, code) -> string;  docIdFor(spec, branch) -> string
takeCodeSnapshot(ctx, spec, { prev, docId }) -> { text, buf, code: CodeManifest }
```

---

## 8. The `at` grammar (`src/core/util/code-at.js`)

These are pure functions. They throw RangeError, which callers map to UsageError.

```js
/** @typedef {{ file: string, startLine: number, endLine: number }} CodeAtItem */
parseCodeAt(s, { defaultFile?: string|null }?) -> CodeAtItem[]
parseCodeOtherAt(s) -> { file, lines: Array<[number, number]> } | { file, hunk: 'h<n>', del: boolean }
isCodeAt(s) -> boolean;  isCodeOtherAt(s) -> boolean
formatCodeAt(items) -> string
resolveCodePath(written, files: readonly string[], { root?, cwd? }?) -> { file: string|null, candidates: string[] }
```

The forms:
- `src/a.js:L12-14`; the `L` before the end is optional (`L12-L14`).
- `src/a.js:L12,src/b.js:L3-4`: a list.
- `src/a.js:L12,L20-22`: a bare item continues the previous file.
- `"a,b.js":L3`: a path that contains `,` or starts with `"` is quoted.
- `src/a.js#h3` and `del:src/a.js#h3`: hunks, in `other[].at` only.

Paths are parsed from the right, so a path may contain `:`.

`resolveCodePath` tries, in order: an absolute path inside the root, a repo-relative path, a cwd-relative path, then a
unique suffix. With two or more candidates, the caller refuses with exit 3 and lists them.

Where the forms are accepted and canonicalised:
- `src/cli/schemas.js`: `LinesAt` accepts lines or `isCodeAt`; `OtherAt` also accepts `isCodeOtherAt`.
- `src/cli/args.js normalizeAt(input)`: `'src/a.js:L12-L14, L20'` becomes `'src/a.js:L12-14,L20'`.
- `ops/revise.js refuseCodeAtForms`: a spec or snapshot doc refuses the code forms before anything is recorded, with
  the hint `file paths are for code reviews; give lines of the spec, e.g. "L42-46"`. `reply --at` does the same.

---

## 9. Packet (`src/core/review/packet-data.js`, `packet.js`)

`buildPacket` on a code doc returns:
```js
{ schema: 1, doc, path, kind: 'code', origin: 'diff', ref, root, file: null, pathFromCwd: null,
  code: { label: codePacketLabel(snap), baseSha, newSha, worktree: newSide !== 'commit', root },
  basis: codeLineBasis(snap, items),
  title, head, working: 'missing'|'dirty'|'clean', reviews, verdict, final, threads: PacketThread[], locks: [],
  decisions, drafts, counts, resolvedThisRound, firstPacket, replyOnly, agent,
  next: codeNextStep(doc, ref, approval, counts.actionable) }
```
- Items come from `kindOf(doc).describeThread`, with the code fields from section 1.
- The order is by file, with whole-review threads last. Within a file it is bottom-up (old side by `nowBetween`),
  then blocking first, then id.
- An orphaned item's note is `(orphaned: reanchor with specreview reanchor <doc> <tid> --file <path> --lines A-B)`.
- A draft summary carries `file`, `side` and the label `<path>[ (old side)]`.

`formatPacket` renders the code item grammar; `test/fixtures/packets/code-item-grammar.txt` is the golden file. Its
pieces:
- the header `(code review: <label>)`;
- the basis lines, `Repo root:` first;
- `[t1] blocking · comment · src/auth/refresh.js:L41-44` followed by `src>` lines;
- `src/x.js (old side) base L12-14, now between L11-12` followed by `was>` lines;
- `:L1 (new file)`;
- `FILE MISSING` with its action;
- the code PROTOCOL line;
- NEXT.

WP3 must not change `packet.js` or `packet-data.js`. It fills them through the `code/packet.js` functions.

---

## 10. CLI and MCP

### `specreview review` (`src/cli/commands/review.js`)
Registry entry: `review: { load, summary: 'Open a code review of your changes (since-base, uncommitted, staged, range, commit)', group: 'loop' }`.

```text
review [<range>] [--uncommitted | --staged | --base <ref> [--committed] | --commit <sha>] [--path <pathspec>]...
       [--context N] [--max-files N] [--title T] [--browser pane|system|none] [--workspace <dir>] [--json]
```

```js
export const spec = { name: 'review', usage, summary, options: { uncommitted, staged, base, committed, commit,
  path (multiple), context, 'max-files', title, browser }, details }
export async function parse(parsed, rt) -> { input: ReviewInput, title?: string, browser: 'pane'|'system'|'none' }
export function reviewInput(o) -> ReviewInput        // shared with MCP; validates mode/field consistency
export async function execute(rt, { input, title, browser })   // STUB: UsageError(CODE_NOT_AVAILABLE)
ReviewInput = { mode?: 'since-base'|'uncommitted'|'staged'|'branch'|'range'|'commit',  // omitted = default (engine decides)
                base?, range?: 'A..B'|'A...B', commit?, paths?: string[], context?: number, maxFiles?: number }
```

How flags map to modes:

| Flags | Mode |
|---|---|
| (none) | `{}` |
| `--uncommitted` | `uncommitted` |
| `--staged` | `staged` |
| `--base X` | `since-base` + base |
| `--base X --committed` | `branch` + base |
| `A..B` | `range` |
| `--commit S` | `commit` |

Conflicting flags are UsageError.

The exit codes WP3 must produce:
- 0: open.
- 1: not a git repository, git too old, or git failure.
- 3: refused (too many files, unmerged entries with `--staged`, too many large untracked files).
- 4: base, range end or commit not found, or nothing to review.

### `ask`, `reanchor`, `show`
The ops already take `file` (ask and reanchor) and `file` + `side` (show). WP3 adds the CLI flags `--file <path>` on
`ask` and `reanchor`, and `--file <path> [--side new|old]` on `show`. It forwards them as `input.file` and
`input.side` to `callOp(...)`. Today `execute` passes only `quote`, `lines`, `body` and `version`.

### MCP (`src/mcp/tools.js`)

**`specreview_review`** (`command: 'review'`):
- Schema: `{ mode?: enum(6 modes, no 'pr'), base?, range?, commit?, paths?: string[], title?, workspace? }`.
- `toInput(a)` returns `{ input: reviewInput({mode, base, range, commit, paths}), title }`.

Code arguments on the other tools:

| Tool | Added args | Passed through when given |
|---|---|---|
| `specreview_ask` | `file?` | `input.file` |
| `specreview_reanchor` | `file?` | `input.file` |
| `specreview_show` | `file?`, `side?: 'new'\|'old'` | `input.file`, `input.side` |

The `specreview_reply` `at` description names the code form.

---

## 11. Daemon

### 11.1 Behaviour today, for a code doc (WP0b)

**Content origin** (`src/daemon/content.js`): every route returns 404 for a code doc, except `__att` (attachments).
`#serveAsset` uses `isVirtual`.

**`GET /api/docs`**: the summary has `kind: 'file'|'snapshot'|'code'` and `origin: 'diff'|'plan'|…|null`.

**Doc routes** (`D` = `/api/docs/:ws/:doc`):
- `GET D`: `docState`, with `working.changedFiles` for code docs. It returns 422 until WP3 lands, because the stub is
  strict.
- `GET D/versions/:v/targets`: empty lists and `outline: []`.
- `GET D/diff`: `codeChanges`. `GET D/diff/source`: `codeFileDiff`. `GET D/threads/:tid/minidiff`:
  `codeThreadMiniDiff`.
- `POST D/anchors/resolve`: `resolveCodeCapture`. `POST D/drafts` with a suggestion: `codeSuggestionFor`.
- `POST D/record`: `recordCodeRound('ui-record')`. `POST D/threads/:tid/apply`: `applyCodeSuggestions` plus a
  `'ui-apply'` round.
- `POST D/locks`, `D/locks/:id/relock`: 409 ("code reviews have no locks").
- `GET D/source`: the head diff text (virtual working copy). The code UI should not use it.

**Error mapping**: USAGE gives 422, NOT_FOUND gives 404, CONFLICT and REFUSED give 409.
`test/unit/review-kind-contract.test.js` hits every `D/*` route except `snip/screen` and accepts only
200, 404, 409 or 422.

**Watch** (`src/daemon/watch.js`): no chokidar watcher and no stat poll for virtual docs (`'virtual'`).

### 11.2 New routes (WP4, one block in `src/daemon/api.js`)

These are GET-only. The file path goes in the query (`path=` URL-encoded). The ops are reached with
`engine.call(name, wsId, docId, q)`.

| Route | Engine op | 200 response JSON |
|---|---|---|
| `GET D/files?v=N` | `codeFiles(ctx, doc, {v})` | `{ v, files: Array<CodeFile & { threads: string[] }>, skipped: Array<{path, reason}> }` |
| `GET D/files?from=A&to=B` | `codeFiles(ctx, doc, {from, to})` | `{ from, to, files: Array<{ path, oldPath?, change: 'changed'\|'added'\|'dropped'\|'renamed', added, removed, threads: string[] }> }` |
| `GET D/files/diff?path=P&v=N[&context=K]` | `codeFileDiff(ctx, doc, {path, v, context?})` | `{ path, oldPath?, v, stub?: 'binary'\|'too-large'\|'submodule'\|'excluded'\|'unsupported-name', hunks: Array<DisplayHunk & { threads: string[] }> }` |
| `GET D/files/diff?path=P&from=A&to=B[&context=K]` | `codeFileDiff(ctx, doc, {path, from, to, context?})` | the same shape, with `from` and `to` in place of `v` |
| `GET D/files/source?path=P&v=N&side=new\|old` | `codeFileSource(ctx, doc, {path, v, side})` | `{ path, side, v, text, lines }` |

Error responses:
- **A non-code doc** returns 400 with body `{ error: 'not a code review', code: 'BAD_REQUEST' }`. Check
  `isCode(doc)` from `resolveDoc(params)`, then `throw new HttpError(400, 'not a code review')` (`http-util.js`).
- **An unknown path** returns 404, from the engine's NotFoundError.
- **Malformed `v`, `from`, `to`, `context` or `side`** return 422 (`invalid(...)`).
- **The stub engine** returns 422 with `CODE_NOT_AVAILABLE`.

For tests, inject an explicit stub engine with `startDaemon({ ops: { ...realOps, codeFiles: … }, uiPort: 0,
contentPort: 0, logFile: false, idleMs: 0 })` (`src/daemon/main.js` accepts `opts.ops` and `opts.createContext`).

### 11.3 Poller (WP4, `src/daemon/watch.js` block)
- For a code doc with at least one SSE subscriber, call `kindOf(doc).workingState(ctx, doc, head)` (that is,
  `codeWorkingState`) every `LIMITS.codePollMs`. Do nothing when there is no subscriber.
- On a change of `dirty` or `changedFiles`, publish `working.changed` with
  `{ dirty: boolean, missing: false, sha256: string|null, changedFiles: string[] }`.
- `actions.js` already copies `dirty`, `missing`, `sha256` and `changedFiles` into `ds.working`.
- `docState` reads through the same memo in `codeWorkingState`.

---

## 12. UI kind seam

### Dispatchers (`src/ui/components/kinds/index.js`)

These are plain functions of the DocState. App calls them; it does not mount them. Each returns a vnode or null.
```js
KindBanners({ ds }) -> vnode|null  // plan snapshot -> <PlanBanner ds>, code -> <CodeBanner ds>; non-null REPLACES the banner stack
KindMain({ ds })    -> vnode|null  // code -> <CodeReviewView ds>; replaces <DocFrame /> in main.center
KindRail({ ds })    -> vnode|null  // code -> <FileTree ds>; replaces <Outline /> (rail title "Files")
KindSide({ ds })    -> vnode|null  // code -> <CodeSide ds>; replaces <ChangesView /> (changes mode, Changes tab)
export { kindCaps }                // from model.js
```

**Placeholders** (WP4 replaces the code ones, WP1 the plan banner). Each is `export function X({ ds }) { return null; }`:
- `kinds/CodeReviewView.js`
- `kinds/FileTree.js`
- `kinds/CodeBanner.js`
- `kinds/CodeSide.js`
- `kinds/PlanBanner.js`

**App mounting**:
- `MainSlot` is always mounted in `main.center`. `SourceView` and `HistoryView` overlay it in their modes. Code docs
  have no source mode.
- **CodeReviewView must hide itself in History mode**: read `mode` with `useStore`.
- `BannerSlot` and `RailSlot` work the same way.
- The side panel shows `KindSide({ds}) ?? ChangesView` in the Changes tab of changes mode. The Threads tab, including
  the Verify queue, stays `ThreadPanel`, which uses `D/threads/:tid/minidiff` (the `codeThreadMiniDiff` shape in
  section 7).

**`Banners.js`**:
- `export function Banners()` is the generic stack. `CodeBanner` may render `<${Banners} />` below its own
  "Files changed since vN: Re-snapshot" banner (`CODE_TESTID.resnapshot`, then `recordWorkingCopy(summary)`, which is
  `POST D/record`).
- When `kindCaps(ds).liveBanners` is false, it skips the lost-frame and working-copy banners. It keeps the
  older-version, new-head, approved and closed banners.

### `src/ui/model.js`
```js
docKindOf(ds) -> 'file'|'snapshot'|'code'
kindCaps(ds) -> { frame, pick, snip, hide, pageErrors, applyNow, liveBanners, locks }
modesFor(ds) -> readonly ModeInfo[]
hasMode(ds, mode) -> boolean
targetLabel(anchor)                // a.file: 'src/a.js:L3-4' | 'src/a.js (old side) L3-4' | 'src/a.js (whole file)'
anchorChipParts(preview, anchor)   // a.file: { lines: '', section: '', label: preview.label || targetLabel }
panelItems(ds, filter, version)    // sorted by anchor.file.path first (no-file items first), then doc order
```

`kindCaps` values:
- code: all false, except `applyNow: true`.
- file: all true.
- snapshot: all true, except `applyNow: false`.

`ModeInfo` is `{ key: 'review'|'changes'|'source'|'history', label, n, description }`:

| Kind | Modes (key, label, number key) |
|---|---|
| file and snapshot | `review` "Review" 1, `changes` "Changes" 2, `source` "Source" 3, `history` "History" 4 |
| code | `review` "Files" 1, `changes` "Changes" 2, `history` "History" 4 |

Number keys are stable per mode key. Code has no key 3.

### `src/ui/actions.js`
```js
registerKindFocus(fn: (id: string|null) => void) -> () => void       // unregister on unmount
registerKindSelection(fn: () => Capture|null) -> () => void          // current line selection, e.g. {kind:'line', file, side, startLine, endLine}
openComposer({ capture, action?: 'comment'|'suggest'|'question', crop?, body?, type?, severity?, attachments?, restore? })
recordWorkingCopy(summary)                                           // POST D/record (Re-snapshot)
```

How existing actions behave when `kindCaps(ds).frame` is false (a code doc):
- **`focusItem(id)` and `clearFocus()`** call the registered focus function instead of messaging the guest. `j`/`k`
  and clicking a card both go through `focusItem`.
- **`selectionAction('c'|'s'|'q')`** opens the composer with `kindSelection()`. Without a selection it toasts "Click a
  line number (shift-click for a range), then press C." `'a'` (agree) does nothing when `locks` is false.
- **The screen snip's capture** is `kindSelection() || {kind: 'doc'}`.
- **`setTool('pick'|'snip')`** toasts and refuses. `toggleHidden()` does nothing.
- **`setMode`** accepts only `hasMode(ds, mode)`.

Changes mode:
- `loadChanges()` keeps `GET D/diff` (that is, `codeChanges`) in `s.changes`.
- `n`/`p` set `s.activeHunk` to `'<path>#h<n>'`. CodeReviewView should follow `activeHunk` (via `useStore`) and scroll
  to it. The guest message is a no-op without a frame.

Store fields the code view reads with `useStore`: `ds`, `version`, `mode`, `base`, `changes`, `activeHunk`,
`focusedId`, `composer`, and `ds.working.changedFiles`.

### Other components (already done; WP4 does not touch them)
- **TopBar**:
  - mode tabs from `modesFor`;
  - the comment, pick, snip and hide buttons gated by caps;
  - the live option needs `liveBanners`.
- **StatusBar**:
  - page errors and externals gated by `pageErrors`;
  - the working text for code is "working tree changed since this round" or "working tree matches this round".
- **ThreadCard**: "Apply now" by `applyNow`; a code card target shows `targetLabel`.
- **ThreadPanel**:
  - frame-only states;
  - kind-aware "General comment" and empty texts.
- **Home**: `virtualDoc(d)` gives a kind chip `<Chip tone="info" class="kind-chip">`, with the values `code`, `plan`,
  `message`, `text` and `web`.
- **keys and commands**: digits come from `modesFor`; a frame-only command says why it is unavailable.

### The contract WP4 must keep
- The root of CodeReviewView has `data-testid="code-view"`, `data-view="code"`, and `data-ready` once the file list
  and the first diffs are loaded. This is the ready marker `[data-view="code"][data-ready]`.
- Use the testids `CODE_TESTID.fileTree`, `fileRow[data-path]`, `fileDiff[data-path]`,
  `lineBtn[data-side][data-line]`, `stub` and `resnapshot`.
- Markers are keyed `${file}:${side}:${line}`.
- Captures posted to `D/anchors/resolve` and `D/drafts` are exactly the section 1 shapes.
- Diffs are text nodes: no `innerHTML`.

---

## 13. Tests and helpers

### `test/helpers/hermetic-env.js`
```js
GIT_TEST_ARGS: readonly string[]   // -c init.defaultBranch=main, user.name=t, user.email=t@example.invalid,
                                   //    commit.gpgsign=false, core.autocrlf=false, core.hooksPath=/dev/null, protocol.file.allow=always
GIT_TEST_DATES = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
hermeticEnv(tmp, extra?: Record<string, string|undefined>) -> Record<string, string>   // complete env; undefined deletes a key
nodeBinDir() -> string             // add to extra.PATH to spawn node
```

What `hermeticEnv` sets up:
- The homes, all inside `tmp` and created: `HOME`, the XDG dirs, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`,
  `GEMINI_CLI_HOME` and `SPECREVIEW_HOME`.
- `PATH` is `<tmp>/bin:/usr/bin:/bin`. `<tmp>/bin` starts empty; put a fake `gh` there.
- Git isolation: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`.
- `SPECREVIEW_BROWSER=none` and `SPECREVIEW_OFFLINE=1`.
- No variable is inherited except `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SYSTEMROOT` and `COMSPEC`.

### Test files
- **`test/unit/review-kind-contract.test.js`**:
  - The fixture is a code doc with two rounds, blobs and thread t1, built in a temp workspace.
  - It covers every `ops.js` export and every `D/*` route, the content-origin 404, and anchors kept through submit.
  - **It must stay green with the real WP3 engine.** Today it accepts a `CODE_NOT_AVAILABLE` UsageError wherever the
    engine runs. WP3 may tighten those expectations to real results.
- **`test/unit/kind-classification.test.js`**: the `SNAPSHOT_SITES` grep.
- **`test/unit/code-cli-seams.test.js`**: the `review` flags, `ReviewInput`, `specreview_review`, the ask, reanchor
  and show file arguments, and the `at` forms.
- **`test/unit/{code-at,store-blobs,store-repofile,packet-code-grammar,hermetic-env}.test.js`**.
- **`test/e2e/model.test.mjs`**: kinds, modes, caps, code anchor labels and panel order.

---

## 14. Deviations from `design-final.md`

1. **Content origin.** It returns 404 for a code doc except `__att`, so attachments of code threads still load.
2. **Mode numbers.** `n` is stable per mode key. Code `history` is 4, not 3, so a digit never changes meaning across
   kinds.
3. **`registerKindSelection` is new**, in addition to `registerKindFocus`. It gives `c`, `s` and `q` and the screen
   snip a capture without a guest selection.
4. **`Banners.js` was extracted** from `App.js`, so a kind banner can compose the generic stack.
5. **`KindBanners` does both jobs.** A non-null result replaces the stack, and it also covers plan docs
   (`PlanBanner`), which is WP1's placeholder.
6. **`docState` stays strict on code docs.** An engine error is a 422 on `GET D`; `status` reports working
   `'unknown'` instead.
7. **No `test/fixtures/code-doc/**`.** The contract test builds its code doc in a temp workspace, using the store and
   hand-written `manifest.code`.
8. **MCP `file` and `side` already exist** on ask, reanchor and show, so WP3 does not need to touch
   `src/mcp/tools.js`.
9. **`codeThreadMiniDiff(ctx, ref, tid)` takes a thread id**, not a `q` object.
10. **`codeChanges` must be ChangeSet-compatible.** The UI's `s.changes`, `n`/`p` and "mark seen" read it.
11. **Origin keys never cross kinds.** `'diff'` is reserved for code (ConflictError or UsageError).
12. **Number-key help label.** The help label stays "Review / Changes / Source / History", to keep e2e text stable.

## 15. Open points (decide in WP3 or WP4)

- **`sourceDiffOp` on a code doc** passes the range object to `codeFileDiff`, and `GET D/diff/source` has no `path`.
  WP3 decides whether to refuse it (UsageError) or return the first file. The code UI uses `D/files/diff`.
- **The CLI `diff <code-doc>`** formats `codeChanges` and `codeUnifiedDiff` (WP3, `diff.js`).
- **`D/files/*` is not in the contract test** yet. WP4's `daemon-code-routes` test covers the routes.
- **`n`/`p` scrolling** is up to CodeReviewView, which follows `s.activeHunk`.

## UI changes (WP4)

What WP4 (branch `feat/code-ui`) did differently from, or on top of, the frozen contract. Everything else follows
sections 11.2, 11.3 and 12 as written.

### Frozen files touched (minimal)
1. **`src/ui/actions.js` `initSuggestion`**: a code line anchor (`a.file`) gets mode `'lines'` and its prefill from
   `GET D/files/source?path&v&side=new` (lines `startLine..endLine` of the new side), not from `D/source` (the
   round's `.diff` text). An old-side or whole-file anchor sets the composer error "Suggestions replace lines of the
   new side: select lines on the right-hand side, or write a comment." (`Composer.js` is untouched.)
2. **`src/ui/actions.js` `moveThread`**: without the doc frame (`kindCaps(ds).frame` false) the capture is
   `kindSelection()` (the selected lines), with a code-specific toast when nothing is selected.
3. **`src/ui/api.js`**: `docApi().files(q)`, `fileDiff(q)`, `fileSource(path, v, side)` (path in the query).
4. **`src/ui/index.html`**: `code.css` linked after `views.css`.

### Files added beyond the ownership list
- `src/ui/components/kinds/code-model.js` (pure helpers: tree, filter, gaps, split pairs, selection, thread
  placement), `code-state.js` (the view's own store and caches, keyed by route + round), `InlineThread.js` (the
  compact thread / draft card under a line; `ThreadCard.js` untouched).
- `test/e2e/code-model.test.mjs` (node:test for code-model.js) instead of extending `test/e2e/model.test.mjs`.

### Keys (section 12 said j/k go through `focusItem`)
- In the code view a capture-phase `keydown` listener (it `preventDefault`s, so `keys.js` skips the key) makes
  **`j`/`k` the next / previous file card**, and in Files mode **`n`/`p` the next / previous hunk across cards**. In
  Changes mode `n`/`p` stay `navChange` (`s.activeHunk`, which the view follows). Threads are focused by clicking the
  card, the panel or a chip. **Escape** clears the line selection (only with no composer, reply or open drawer).
  `s` with an old-side selection toasts why it cannot suggest.
- **Open:** the help overlay (`commands.js`, frozen) still labels `j`/`k` as "next / previous thread"; whoever owns
  `commands.js` should make that label kind-aware ("next / previous file" for code).

### Daemon
- **Poller source.** `watch.js` does not call `kindOf(doc).workingState` itself: `api.js` registers
  `hub.setCodeWorking((ws, doc) => engine.call('docState', ws, doc).working)`, which is the same memoized
  `codeWorkingState` value (11.3, last bullet) and keeps `startDaemon({ ops })` injection working for tests. An engine
  error (the stub) sends nothing. `startDaemon({ timing: { codePollMs } })` overrides `LIMITS.codePollMs`. Only a
  change of `dirty` or `changedFiles` is published (a `sha256`-only change is not).
- **Route details.** `v`, `from`, `to` are recorded rounds: `live` is 422, `v` together with `from`/`to` is 422.
  Defaults: no query = `{v: head}`; `to` = head; `from` = last reviewed round (like `D/diff`). `from > to` is passed to
  the engine (like `D/diff`). `files/source` with `from`/`to` is 422; `side` defaults to `new`. `path` is required,
  at most 4096 characters, no NUL. `context` is 0..10000.
- **`test/integration/code-routes-real.test.js`** runs the routes against the real ops of the build: each answers
  the 11.2 shape (checked) or a typed 404/409/422; the stub's `CODE_NOT_AVAILABLE` is accepted, like the contract
  test. WP3 may tighten it to real results only once the engine lands.

### UI behaviour the engine should know about
- The diff geometry (collapsed unchanged lines between and after hunks, "Show N lines") is computed from the
  `DisplayHunk.header` `@@ -a,b +c,d @@` (rows as fallback) and filled from `D/files/source?side=new` of the shown
  round. Added and deleted files have no trailing gap.
- `data-hunk-ids` of a display hunk is matched against `s.activeHunk` (`'<path>#h<n>'`), so `hunkIds` must use the
  `codeChanges` ids. Changes mode shows `D/files?from&to` + `D/files/diff?path&from&to`; its line selection is new
  side only (the lines of round `to`), captured at the shown version.
- The Changes side list groups `s.changes.hunks` by `h.file` (falling back to the path in the hunk id) and takes the
  status letters from `D/files?from&to` (`change`).
- Binary / too-large files (CodeFile flags, or `stub` from files/diff) are never fetched; they show a placeholder
  and take whole-file comments ("Comment on file", capture `{kind:'file', file}`).
- A card renders at most 3000 rows before "Show all".
- The Unified / Split choice is the existing `sourceLayout` preference; a narrow window (< 900 px) is always unified
  and the file tree is the nav drawer.
- The Re-snapshot button exists once, in `CodeBanner`, shown while `ds.working.dirty`.

### Mock server
- `test/e2e/mock-server.mjs` gained `scenario: 'code'` (`test/e2e/mock-code.mjs`), the three code routes with the
  daemon's validation, and `kind` / `origin` on `/api/docs` entries.

## Engine changes (WP3)

Where the engine (branch feat/code-engine) differs from or adds to the frozen contracts above. The code is the
source of truth.

### Contracts adapted
- **Workspace = repository top level.** `openCodeReview` (and every git call) refuses with UsageError a `ctx.root`
  that is not `git rev-parse --show-toplevel`. `specreview review` uses `--workspace`, else the top level of the
  cwd; `--workspace` still has to name the top level.
- **`GET D/diff/source` (`sourceDiffOp`) without a path** on a code doc is UsageError (422). With `{path, v}` or
  `{path, from, to}` it is `codeFileDiff`.
- **`codeThreadMiniDiff`** also returns `file` (the head anchor's file) and `state`.
- **`reviseCode` report** adds `kind: 'code'`, `text` (the round report of design 4.8, printed by the CLI as is),
  `manifest`, and `nothing` / `repliesOnly`. `recordCodeRound` is as frozen.
- **`test/unit/code-cli-seams.test.js`**: the "exits 1 until the engine lands" test is now "outside a git repository
  `execute` and `openCodeReview` are UsageError".

### Data the engine writes beyond section 7
- `CodeFile.ids: {old?, new?}` (git blob ids, or `sha256:` for an untracked file) on binary and too-large stubs, so a
  changed binary changes the round. `CodeFile.mode: {old?, new?}`. `tooLarge: {side, bytes}`.
- `status: '='` files: a file that holds an open thread and is unchanged against base stays in the round (both
  blobs). The "unchanged?" check and the dirty state compare with head's carried files kept, so resolving a thread
  never makes a round by itself; a recorded round drops them.
- Skipped `submodule` entries carry `old` / `new` commit ids. Names that are not UTF-8, contain a control character
  or have a component starting with `-` are skipped as `unsupported-name` (shown with `?`). Only untracked
  secret-looking files are excluded (design 4.16); tracked ones are reviewed.
- `doc.code.maxFiles` keeps `--max-files` for later rounds.
- Blobs are written only when a round is recorded (dry rounds keep the bytes: `takeCodeSnapshot` returns
  `{text, buf, code, texts, bufs}`). "Nothing to review", dry runs and unchanged rounds write nothing.

### Behaviour worth knowing (WP4 / WP6)
- `codeWorkingState` memo: 2 s per (doc, head) **and** an unchanged lstat signature of head's working-tree files, so
  an edit of a reviewed file is seen at once. Untracked files, tracked files outside the round and the index /
  commit sides are seen once the memo expires (at most 2 s).
- The temp index keeps the real index's timestamps (git's racy-entry check; a fresh copy missed same-size edits
  made in the index's own second).
- git prefix extras beyond 4.3: `core.safecrlf=false`, `maintenance.auto=false`, `advice.*=false`, and
  `GIT_NO_LAZY_FETCH=1` in the env.
- `revise` on a staged review whose round is unchanged while a reply says `addressed`: exit 3 "stage your changes
  with `git add` first"; branch / range by ref: "commit your changes first".
- Applying a lines-mode suggestion drops one trailing newline of `new` (the anchored `old` excludes the final line
  terminator). The packet shows `new` as stored, so the UI should send it without a trailing newline.
- Old-side items: `nowBetween` is the mapped range when the base lines exist again in the working file (restored
  code prints "now between L12-14"); a deletion gives the two lines around it.
- Interdiff: a file that enters the review as a rename is `renamed` (with `oldPath`); a pure path change prints
  "(renamed, content unchanged)" in `diff --unified`; a carried file restored to base is `changed`.
- `codeFileSource` resolves a path as an agent writes it (cwd-relative, unique suffix) when it is not exact.
- No automatic "renamed?" detection for D + A below git's similarity: packet-data's orphan note already offers
  `reanchor --file`.

### CLI
- `review` JSON as design 4.2. `stats.files` counts the round's files (binary and too-large ones are files and also
  appear in `skipped`). Text line 1: `code review <id> v1 · <label>`, or `recorded round vN` / `unchanged since vN`
  on a re-run.
- `ask --file <path> [--lines A-B]` (no lines: the whole file; neither: the whole review); `reanchor [--file]
  --lines`; `show --file <path> [--side new|old] [--version N] [--lines A-B]` prints numbered lines (`--json`: the
  range as `text`; `--version live` is refused); `diff` on a code doc: `--stat` one line per file with its threads,
  `--unified` per-file patches (`live` refused).
- `wait.js` (outside WP3's list, one block): a dirty code review's refusal names the changed files (design 4.13) and
  its JSON adds `changedFiles`.
