# SpecReview v1: build amendments (AUTHORITATIVE)

`docs/design.md` is the baseline design. **This file overrides it wherever they differ.** It folds in the
adversarial critique, simplifies parts that were too risky for one build, and freezes the contracts between work
packages (WPs). If something is underspecified in both documents, choose the simplest behaviour that preserves the
user's goals (below), document the choice in a header comment, and move on.

## 0. The user's goals (never trade these away)
1. Claude (or any agent) writes an HTML/Markdown spec. The user reviews it in a rich UI next to the chat.
2. The user comments on **specific parts**: phrases, paragraphs, images (whole or a region), table cells, code,
   diagrams (mermaid / SVG), sections, the whole doc. They can ask questions and suggest exact replacements.
3. The agent gets precise, located feedback and makes **targeted edits**. It never regenerates the whole spec, and
   agreed content is never silently lost.
4. Iteration: threads with replies, revisions, reopen/accept, many rounds.
5. The user sees **what changed** (since their last review, between any two versions), per thread and overall.
6. Full **version history** over time (git-friendly files), and a clear **final** version.
7. Faithful rendering of messy, real HTML (scripts, SVG, images, tables, code, mermaid, math) and Markdown.

## 1. Scope of this build
IN (v1): everything in design.md sections 3-12, EXCEPT the items in OUT. Specifically: `open`, render MD + HTML
faithfully, all anchor kinds below, suggestions (text + source mode), questions, severity, drafts + Submit review with
verdict, background `wait` + packet, `apply`, `edit` (incl. `--stdin` batch), `reply`, `revise` (+ guards, attribution,
replies), `ask`, `reanchor`, `revert --hunk`/`--lock`, `threads`, `show`, `diff`, `log`, `status`, `final --decisions`,
`close`, `serve`/`stop`/`doctor`, `mcp`, `hook pre-write`, `hook prompt`, `install claude`, `install agents-md`,
locks ("Mark agreed"), decisions, re-anchoring with states, Changes overlay, Source diff, History, Verify queue,
per-thread mini-diff, "since my last review", changed-image before/after, presence, SSE live updates, narrow layout,
dark mode, keyboard shortcuts, Claude Code plugin + skill + slash command + hooks, AGENTS snippet, README.

OUT (later): pristine mode (`?pristine=1`), `?nocsp=1`, media timestamps, code-block line gutter (code lines are
still commentable via text selection and pick), the "Aligned" Google-Docs card layout (use the List layout: cards in
document order; focusing a card scrolls the doc), pixel-parity fidelity suite, CDN proxy cache, git-mirror branch,
static redline / side-by-side rendered view, image swipe/onion skin (a simple before/after pair is IN).
`git.autoCommit` is IN but minimal (off by default).

## 2. Process / storage changes
### 2.1 Runtime state lives outside the repo
The repo-side `<workspace>/.specreview/` holds only durable, commit-worthy data:
```
.specreview/config.json  .specreview/.gitignore (contains: "*.tmp-*")
.specreview/assets/sha256/<2>/<hex>.<ext>
.specreview/docs/<docId>/{doc.json, versions/NNNN.<ext>, versions/NNNN.json, threads/tN.json, reviews/rvN.json,
                          locks/LN.json, attachments/aN.png}
```
Everything volatile lives in `SPECREVIEW_HOME` (default `~/.specreview`):
```
~/.specreview/daemon.json (0600)  workspaces.json  daemon.log
~/.specreview/ws/<wsId>/events/<docId>.jsonl        append-only feed, {seq, at, type, ...}
~/.specreview/ws/<wsId>/waiters/<docId>/<pid>.json  {pid, agent, since, heartbeatAt, supersededBy?}
~/.specreview/ws/<wsId>/locks/<docId>/              mkdir lock dir (+ owner.json)
~/.specreview/ws/<wsId>/cache/render/<docId>/...    render cache
~/.specreview/ws/<wsId>/drafts/<docId>.json         reviewer drafts
~/.specreview/ws/<wsId>/pending/<docId>.jsonl       tagged edits since head (apply/edit/override)
```
`Store` exposes `runtimeDir(...parts)` for these.

### 2.2 Lock (no proper-lockfile)
`src/core/store/lock.js` exports `withLock(lockDir, fn, {timeoutMs=20000, staleMs=30000})`:
mkdir-based; writes `owner.json {pid, at}`; refreshes `at` every 5 s while held; a lock is stale when its pid is not
alive (`process.kill(pid,0)` throws ESRCH) or `at` is older than `staleMs`; stale locks are removed and retried;
retries with backoff 20-200 ms until `timeoutMs` then throws `LockTimeoutError`. **Re-entrant within one process**
(a Map of held lock dirs with depth counters), because ops may call other ops.

### 2.3 Recovery
No global recovery in `Store.open`. Readers simply **ignore** a version source without its manifest, a `.tmp-*`
file, and a thread whose `review` id has no review file (unless `review` is null: agent questions). Mutating ops run
`recoverDoc(docId)` inside the doc lock (delete manifest-less sources, stale tmp files whose pid is dead).

### 2.4 Single waiter + delivery lease + ack
- Waiter files: `waiters/<docId>/<pid>.json`. When `wait` starts for (doc, agent), it marks every other live waiter
  for the same (doc, agent) as `supersededBy: <newPid>`. A waiter checks its own file on each poll; if superseded it
  prints `specreview: superseded by pid N (a newer wait is listening); ignore this.` and exits 6.
- `wait --all` uses docId `_all`.
- Delivery happens under the doc lock: build packet -> write stdout (await flush) -> set
  `review.deliveredTo[agent] = at` -> append `review.delivered` event.
- **Ack**: the agent's next op on that doc (`revise`, `reply`, `apply`, `edit`, `show`, `feedback`, `ask`,
  `reanchor`) sets `review.ackedBy[agent] = at` for delivered-but-unacked reviews and emits `review.acked`.
- `hook prompt` injects (a) submitted reviews not delivered to the agent when no live waiter exists, and
  (b) reviews delivered > 5 minutes ago but not acked.

### 2.5 Daemon resilience
Token, secret and ports persist in `daemon.json` across restarts (rotate only with `specreview stop --rotate`).
Ports are sticky. UI detects 401/connection loss -> shows "Reconnecting to SpecReview..." and retries `/api/health`
then refetches. The daemon idle-exits only after 12 h with no SSE clients, no live waiters and no requests.

## 3. Rendering and text mapping (SIMPLIFIED: no character aligner)
### 3.1 Render result (WP2) - FROZEN
```js
renderSource({ format: 'markdown'|'html', source, docPath, stamp = true }) -> Promise<RenderResult>
RenderResult = {
  html,              // full HTML page (markdown: shell page; html: original bytes with data-srid spliced in)
  guestInsertAt,     // offset in html where the daemon inserts the guest <script> tag
  srcmap: { order: number[], nodes: { [srid]: SrcNode } },
  text: { text: string, spans: { [srid]: [t0, t1] } },  // global rendered-text stream (TEXT_EXCLUDE applied), spans per srid
  outline: [{ srid, level, text, line, id }],
  assets: string[],   // workspace-relative POSIX paths of local files referenced (img, srcset, video, link css, script src, url())
  externals: string[],// absolute http(s) URLs referenced
  title: string,
  features: { mermaid: boolean, math: boolean, code: boolean },
}
SrcNode = { t: tag, s: startOffset, e: endOffset, ls: startLine, le: endLine, p: parentSrid|0, b: isBlock,
            k?: 'code'|'math'|'mermaid'|'frontmatter'|'table'|'tr'|'cell'|'img'|'svg'|'media'|'embed'|'heading',
            h?: { level, text }, a?: { id?, src?, alt?, href?, class?, poster?, data? },
            c?: { contentStart, contentEnd, firstLine } }   // c: verbatim content mapping for code/mermaid fences
elementText(render, srid) -> string        // render.text.text.slice(...spans[srid])
deepestBlockAt(render, startOff, endOff) -> srid|null // deepest block element whose [s,e] contains [startOff,endOff)
elementsIntersecting(render, startOff, endOff, { blocksOnly, leafBlocks }) -> srid[]
```
Offsets are UTF-16 code units into the decoded source string. Lines are 1-based. srids start at 1 in document order.
Markdown: `s/e` come from hast/mdast positions; elements without positions get no srid (their text is attributed to
the nearest positioned ancestor). HTML: every eligible element is stamped (design 6.3) and `s/e` are its full
outer range from parse5 `sourceCodeLocation` (`startOffset`..`endOffset`, or startTag only for void elements).

Mermaid in HTML docs: if an HTML doc contains `pre.mermaid` / `div.mermaid` elements and **no** script whose src or
text mentions `mermaid`, the render sets `features.mermaid = true` and the daemon appends the vendored mermaid +
`mermaid-init.js` before `</body>` (so self-contained HTML specs can use mermaid offline).

### 3.2 Quote <-> source (WP2, `src/core/text/quote.js`) - FROZEN
```js
normalizeWs(s) -> { text, map }          // collapse runs of whitespace to ' ', trim; map[i] = raw index of text[i]
findQuote(hay, needle, { prefix = '', suffix = '', hint = null, markupTolerant = false, format = 'markdown' })
  -> Array<{ start, end, score }>        // best first; [] if none. markupTolerant: allow inline markup between words
                                          // (md: * _ ` ~ [ ] ( ) ! # > | \ and "](url)", html tags, entities; also \n + indentation)
sourceToPlainText(format, sourceSlice) -> string   // strip md/html markup + decode entities: approximates the rendered text
similarity(a, b) -> number in [0,1]      // 1 - levenshtein/maxLen on at most 64 chars per side
```

### 3.3 Capture -> anchor (WP3)
Guest captures (FROZEN shapes):
```js
{ kind: 'text', startSrid, endSrid, exact, prefix, suffix }   // srids: nearest [data-srid] ancestors of the range ends
{ kind: 'element', srid, tag, label, region?: {x,y,w,h}, svg?: {nodeId, label}, cell?: {row, col, rowKey, colHeader, text},
  scope?: 'cell'|'row'|'column'|'table' }
{ kind: 'section', headingSrid }
{ kind: 'source', startLine, endLine }
{ kind: 'doc' }
```
Text capture resolution: window = source range spanning `nodes[startSrid].s .. nodes[endSrid].e` (if either srid is
missing, the whole source). (1) `findQuote(window, exact, {prefix, suffix})` exact; (2) whitespace-normalised;
(3) `markupTolerant`; -> `mappedBy: 'textmap'` (3 = `'narrowed'`). (4) unique occurrence (any of 1-3) in the whole
source -> `'raw-source'`, `generated: true`. (5) fallback: the deepest common element's whole range -> `'block'`,
`generated: true`. Inside code/mermaid fences search only within `c.contentStart..contentEnd`.
Element: `src` = the element's `[s,e]`. Mermaid node (`svg` present on a mermaid element): narrow to the fence
line(s) containing `nodeId` (word boundary) else the label; else whole fence. Cell: `src` = cell element range (Markdown
table rows are single lines, so lines = that row). Section: heading.s .. next heading of same-or-higher level (or EOF).

### 3.4 Anchor -> DOM (WP3 produces DomTarget, WP6 resolves it) - FROZEN
```js
DomTarget = { id, num, kind, state: 'open'|'addressed'|'resolved'|'outdated'|'orphaned'|'draft'|'lock'|'needs_input',
              srid: number|null, endSrid: number|null,          // deepest stamped element(s) containing the anchor
              quote: string|null, prefix: string, suffix: string, // rendered text to look for (whitespace-insensitive)
              region: {x,y,w,h}|null, svg: {nodeId,label}|null, cell: object|null,
              label: string, severity?: string, type?: string }
```
`quote` = the captured `exact` while the anchor's source text is unchanged; after re-anchoring to different text it is
`sourceToPlainText(format, newSlice)`. Guest resolution: scope = element(srid)..element(endSrid ?? srid); search the
whitespace-normalised quote in the scope's text (TEXT_EXCLUDE walk), choosing the best prefix/suffix match; else
search the whole document; else outline the whole scope element (`state 'block'`); else report `missing`.
Element kinds always outline the element (+ draw the region box / mermaid node box).

## 4. Diff, re-anchoring, attribution and guards
### 4.1 Diff engine (WP2, `src/core/diff/*`) - FROZEN
```js
lineHunks(a, b) -> Hunk[]   // jsdiff structuredPatch context 0, half-open 1-based ranges, ids h1..hN in file order
Hunk = { id, oldStart, oldLines, newStart, newLines,
         oldStartOff, oldEndOff, newStartOff, newEndOff }   // char offsets of the covered whole-line ranges
offsetMapper(a, b, hunks) -> { mapOffset(off) -> { off, hunk: Hunk|null }, mapLine(line) -> { line, hunk: Hunk|null } }
wordDiff(a, b) -> Array<{ op: 'eq'|'ins'|'del', text, aStart, aEnd, bStart, bEnd }>   // jsdiff diffWordsWithSpace
hunkStats(a, b, hunk) -> { removedChars, insertedChars, removedWords, insertedWords, changedOldRanges: [[s,e]], changedNewRanges: [[s,e]] }
rewriteRatio(a, b, hunks) -> number   // removed-or-replaced OLD chars / max(1, a.length); insertions excluded
changeSet({ fromSource, toSource, toRender, format, hunks, fromRender? }) -> Changes   // no thread links (WP3 adds them)
Changes = { stats: { added, removed, hunks, blocksChanged },
  hunks: [{ id, op: 'add'|'del'|'mod', old: {start, lines}, new: {start, lines},
            srids: number[],                 // deepest block elements intersecting the CHANGED new char ranges
            words: [{ srid, quote, prefix, suffix }],   // inserted/replaced text segments as rendered text, for 'sr-ins' highlights
            deleted: { text, html: string|null, lines } | null,   // html only for markdown (renderFragment, scripts stripped)
            insertBefore: { srid } | null,    // for pure deletions: first block starting at/after the deletion point
            section: string[] }] }
sourceDiff(a, b, { context = 3 }) -> { hunks: [{ id, header, rows: [{ op: ' '|'-'|'+', oldNo, newNo, text, words: [[start,end,'ins'|'del']] }] }] }
unifiedPatch(a, b, { fromLabel, toLabel }) -> string
renderFragment({ format, source }) -> Promise<string>  // (render module) sanitized-ish HTML, scripts/on* stripped
```
### 4.2 Re-anchoring order (WP3) - overrides design 7.4
For each thread/lock, from version a to b (one version at a time):
0. override (agent `reanchor`/reviewer "Move here") -> state `exact`, mappedBy `override`.
1. **untouched first**: if no hunk's old char range intersects `[A.src.start, A.src.end)`, map via `offsetMapper`,
   verify the slice equals `A.src.text` -> `exact` (same line) or `moved`.
2. **linked & intersecting**: if the thread is linked to hunks of b AND the anchored range intersects one of them:
   fuzzy-find `A.src.text` inside the linked hunks' new ranges -> found: anchor there; else anchor = the linked hunks'
   new range clipped to whole lines; state `edited`. Element/region/cell anchors relocate ONLY to an element with the
   same tag (and same src/alt fingerprint if possible); if none, keep the old element position mapped through the
   mapper (state `edited`). A link alone never moves an anchor whose text was untouched.
3. exact elsewhere (prefix/suffix + proximity scoring, design formula) -> `moved`.
4. fuzzy (`approx-string-match`, design 7.4 step 4 thresholds) -> `changed`.
5. retry 3-4 with the thread's ORIGINAL anchor; else `orphaned` (keep `lastKnown`).
After success, recompute quote/srid/endSrid/section/lines against b's render.
Add a golden test: "linked hunk adjacent to an untouched image anchor stays on the image".

### 4.3 Attribution (WP3)
Per hunk (head -> working): (1) `tagged` pending edit (apply/edit) whose new lines overlap; (2) `hint`: a thread's
`at` lines overlap the hunk's new lines; (3) `overlap`: the hunk's **changed old char ranges** intersect an actionable
thread's head anchor source range (expanded to whole lines); (4) otherwise `unlinked` unless an `other[]` entry
covers it (`at:"L12"` new lines, or `at:"del:h6"` / `"h6"` hunk id). External/human edits are indistinguishable from
agent edits; they show up as unlinked and the agent explains them with `other` (`why: "not mine: external edit"`).
**Never instruct the agent to revert hunks it did not make.**

### 4.4 Guards (WP3) - content based, overrides design 8.4
| Check | Default | Override |
|---|---|---|
| An active lock whose re-anchored state at the new version is not `exact`/`moved` (its normalised text is not intact) | refuse | `--break-lock L1="reason"` |
| ... but the lock was created after the last delivered packet (agent never saw it) | warn | |
| An unlinked, unexplained hunk that removes/replaces >= `guards.unexplainedWords` (20) words or >= 3 whole old lines | refuse | `other` entry, `revert --hunk`, or `guards.unexplainedDeletion: warn|off` |
| `rewriteRatio` > `guards.maxRewriteRatio` (0.5) and head has >= 40 lines | refuse | `--allow-rewrite` |
| Actionable thread with no reply entry | warn | |
| Thread marked `addressed` with no linked hunk and no asset change | warn | add `at` |
| Decision anchor intersects a hunk not linked to that decision's thread | warn | |
| `--force` | overrides all refusals; recorded in `guards.forced` | |

### 4.5 Changed assets (images) count as changes
`changes()` maps changed asset hashes (manifest `assets` of from vs to) to srids of elements referencing them
(`a.src`, srcset, poster) and emits `assets: [{ path, fromUrl, toUrl, srids }]` where the URLs are content-origin
URLs of each version's blob. Thread mini-diff for element anchors whose asset changed returns
`{ kind: 'image', beforeUrl, afterUrl }`. A thread anchored on that element counts as linked to the asset change.

### 4.6 Packet `src>` caps (WP3)
Per thread at most `LIMITS.threadSrcChars` (1200) chars of `src>`. A line longer than ~300 chars is printed as the
shortest unique window around the anchor (still a valid Edit `old_string` substring; JSON `srcWindow: true`).
`data:` URIs are elided as `data:image/png;base64,...(512 KB)` and that thread gets `srcEditable: false`.
`crop:` and asset paths are printed as **absolute** paths.

## 5. Agent-facing surfaces (WP4)
- Skill/agent protocol (WP8) must say: **Read the spec file (or the cited ranges) before editing**; do all Edit-tool
  edits first, then `specreview apply` for suggestions (apply rewrites the file; re-Read before any later Edit);
  if Edit says the file changed since read, re-Read and retry. `specreview edit --stdin` accepts
  `[{threads:["t1"], old:"...", new:"...", all?:false}]` for CLI-only edits.
- `bin/specreview.js` dispatches `hook *` BEFORE importing anything heavy: hooks live in `src/cli/hooks.js` and may only
  import `node:*` modules + `src/shared/protocol.js`. They walk up from cwd/file with `statSync` looking for
  `.specreview`, exit immediately if none, read JSON only, never run recovery, never print on error, always exit 0,
  and must run < 150 ms cold.
- `install claude` writes hook commands with absolute paths: `"<process.execPath>" "<abs>/bin/specreview.js" hook ...`.
  Without `--apply` it prints exactly what it would write. It never edits settings without `--apply`.
- MCP: use `@modelcontextprotocol/server` 2.3.1 (`McpServer` from '@modelcontextprotocol/server',
  `StdioServerTransport` from '@modelcontextprotocol/server/stdio', `zod/v4` schemas; see
  `test/fixtures/mcp-smoke.mjs` pattern in design). If the v2 API misbehaves, fall back to `@modelcontextprotocol/sdk`.
- MCP `specreview_wait`: default 50 s, max 600 s; returns `{status:"waiting"}` to be called again.
- `open` refuses a workspace root equal to `$HOME` or `/` unless `--workspace` is given explicitly (then a `.specreview`
  dir is created next to the file instead; i.e. fallback root = the file's directory).

## 6. Daemon (WP5)
- Two HTTP servers in one process: UI origin `127.0.0.1:<uiPort>` and content origin `127.0.0.1:<contentPort>`.
- **Per-doc capability paths** on the content origin: `docKey = hmacSha256(secret, wsId + '/' + docId).slice(0, 24)`.
  - `GET /c/<docKey>/<ver>/<docPath>` -> rendered doc (`ver` = `v<N>` or `live`), guest tag inserted at `guestInsertAt`.
  - `GET /c/<docKey>/<ver>/<otherPath>` -> an asset: for `vN`, the manifest blob if listed, else (fallback) the live
    file under the live rules; for `live`: allowed if the path is in the current render's `assets`, OR it is under the
    doc's own directory (recursive) with an allowed extension (png jpg jpeg gif webp avif svg ico bmp css js mjs json
    woff woff2 ttf otf mp4 webm ogg mp3 wav m4a txt csv md html htm pdf). Deny dot-segments, `*.pem|*.key|*.p12|id_rsa*`,
    symlink escapes (`realpathWithin(workspaceRoot)`).
  - Root-absolute paths (`/img/a.png`): resolve via the `Referer` (`/c/<docKey>/<ver>/...`) to the same docKey.
  - `GET /__sr/<RENDERER_VERSION>/guest.js|static/*|vendor/*` -> guest bundle, `src/core/render/static/*`, vendored doc
    libs (`VENDOR_DOC` map), served with `Cache-Control: public, max-age=31536000, immutable`.
  - Rendered docs: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
    `Content-Security-Policy: frame-ancestors http://127.0.0.1:<uiPort> http://localhost:<uiPort>`
    (+ `default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'` when `render.network: "block"`).
  - The markdown shell uses the placeholder `__SR_ASSET_BASE__`; the daemon replaces it with
    `http://127.0.0.1:<contentPort>/__sr/<RENDERER_VERSION>`.
- Guest tag: `<script src="http://127.0.0.1:<cport>/__sr/<RV>/guest.js" data-sr-ui="http://127.0.0.1:<uport> http://localhost:<uport>" data-sr-target="<wsId>/<docId>/<ver>" data-sr-ignore></script>`
- UI origin routes = design 10.2 plus: `PATCH /api/docs/:ws/:doc/drafts/:id`, `GET .../versions/:v/targets` returns
  `{ threads: DomTarget[], locks: DomTarget[], drafts: DomTarget[], outline }` (drafts written on an older version are
  carried forward to `v` as submit will carry them; orphaned ones are left out), `GET .../threads/:tid/minidiff`,
  `GET /ui-shared/protocol.js` (serves `src/shared/protocol.js`), `GET /vendor/*` via `VENDOR_UI`.
  `DocState.contentBase = "http://127.0.0.1:<cport>/c/<docKey>"`; a doc URL is `${contentBase}/${ver}/${doc.path}`.
- Security per design 12 (Host allowlist -> 421, Bearer token on /api/* except health -> 401, Origin check on non-GET
  -> 403, no CORS). The SPA gets the token from `?k=` and keeps it in `sessionStorage` (not when framed); SSE uses `?k=`.
  Every UI-origin response carries `X-Frame-Options: DENY`, `frame-ancestors 'none'` and CORP `same-origin`, and
  `/ui/*` + `/vendor/*` never serve documents (HTML/XHTML/SVG/XML/XSLT -> 404), so a doc cannot frame the UI (SEC-1).
- File watching: chokidar on tracked working files (-> `working.changed`), and polling/tailing of
  `~/.specreview/ws/*/events/*.jsonl` and `waiters/` (-> SSE events). Debounce 250 ms.

## 7. Guest (WP6) and UI (WP7)
- Channel: see `MSG` in `src/shared/protocol.js` (MessagePort handshake). Messages from the guest can never mutate
  state: `action` only opens a composer (user must click Add/Send); forwarded `key` events may only trigger
  non-mutating UI actions (navigation, open composer, toggle panels). `x`/`o`/`y`/`a` act only when focus is in the UI.
- Guest is a set of plain classic-script files concatenated in the order listed in `src/guest/parts.json` into one
  IIFE (`'use strict'`). It must not use ES module syntax. It inlines the constants it needs from protocol.js.
- Highlights: CSS Custom Highlight API (`sr-open`, `sr-resolved`, `sr-active`, `sr-draft`, `sr-ins`, `sr-lock`,
  `sr-outdated`) via an adopted constructed stylesheet; fallback to overlay rects. Overlay: one
  `<sr-overlay data-sr-ignore>` custom element with a closed shadow root, `popover="manual"` + `showPopover()` when
  supported, else fixed max z-index. Pins, element outlines, region boxes, picker box + label chip, selection
  mini-toolbar, change bars, `⊖ removed` tabs + popovers, lock brackets.
- UI: no-build Preact via `htm/preact/standalone.module.js` (import map: `"preact-htm": "/vendor/htm/preact/standalone.module.js"`),
  `marked` + `DOMPurify` for comment bodies, `diff` for live suggestion word-diff. Layout per design 11, List layout.
  Must render all `TESTID`s from protocol.js. Keyboard map per design 11.8 (minus removed features).
- Theming: CSS custom properties with light/dark sets (`prefers-color-scheme` + toggle); explicit body background.

## 8. Ownership (who may edit what)
| WP | Owns |
|---|---|
| WP0 (lead) | `package.json`, `package-lock.json`, `src/shared/protocol.js`, `docs/design.md`, `docs/BUILD_AMENDMENTS.md` |
| WP1 store | `src/core/util/**`, `src/core/store/**`, `src/shared/types.js`, `src/shared/vendor.js`, `test/unit/store*.test.js`, `test/unit/util*.test.js`, `test/unit/lock*.test.js` |
| WP2 render/text/diff | `src/core/render/**`, `src/core/text/**`, `src/core/diff/**`, `test/unit/render*.test.js`, `test/unit/text*.test.js`, `test/unit/diff*.test.js`, `test/fixtures/docs/**` |
| WP3 engine | `src/core/anchor/**`, `src/core/review/**`, `test/unit/anchor*.test.js`, `test/unit/review*.test.js`, `test/fixtures/reanchor/**`, `test/fixtures/packets/**`, `test/helpers/engine*.js` |
| WP4 agent surfaces | `bin/specreview.js`, `src/cli/**`, `src/mcp/**`, `test/integration/cli*.test.js`, `test/integration/mcp*.test.js`, `test/integration/hooks*.test.js` |
| WP5 daemon | `src/daemon/**`, `test/integration/daemon*.test.js` |
| WP6 guest | `src/guest/**`, `test/guest/**` |
| WP7 UI | `src/ui/**`, `test/e2e/**` (UI flows), `playwright.config.js` |
| WP8 docs/integrations | `integrations/**`, `.claude-plugin/**`, `README.md`, `docs/agent-protocol.md`, `docs/user-guide.md` |

If you need something from a file you do not own: code against the frozen contract, and append a note to
`docs/integration-notes.md` (shared append-only file: `## WPn -> WPm: <request>`). Do not edit others' files.

## 9. Testing conventions
- `node --test` with globs (see package.json). Tests must not touch the real `~/.specreview`: set
  `SPECREVIEW_HOME` to a temp dir. Never bind the default ports in tests: pass explicit ports or 0.
- Browser tests use `playwright-core`/`@playwright/test` with `channel: 'chrome'` (system Chrome; no downloads).
- Fixtures: `test/fixtures/docs/kitchen-sink.md` (GFM table, task list, footnotes, math, mermaid, code fences, front
  matter, raw HTML, image with relative path) and `test/fixtures/docs/app-spec.html` (inline script that builds DOM,
  inline SVG, canvas chart, `<details>`, tabs, table, image, mermaid `<pre class="mermaid">`), plus
  `test/fixtures/docs/img/arch.png` (generate a small PNG with plain Node zlib, no deps).
