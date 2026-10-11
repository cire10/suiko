// @ts-check
// JSDoc type definitions for every JSON shape SpecReview stores or exchanges (design 5.3, 9.3-9.5, 10.2 and
// BUILD_AMENDMENTS 2-4, which win where they differ). Types only: import them with
//   /** @typedef {import('../shared/types.js').Thread} Thread */
// Conventions: lines are 1-based; character offsets are UTF-16 code units into the decoded source string;
// diff ranges are half-open; timestamps are ISO-8601 UTC strings; every stored JSON file carries `schema: 1`.

export {};

// ============================================================================ primitives

/** @typedef {'markdown' | 'html'} DocFormat */
/** @typedef {'agent' | 'human' | 'external'} ActorKind */
/** @typedef {{ kind: ActorKind, name: string }} Actor */
/** @typedef {'thread' | 'comment' | 'review' | 'lock' | 'decision' | 'draft' | 'attachment'} IdKind */
/** @typedef {'comment' | 'question' | 'suggestion' | 'agent-question'} ThreadType */
/** @typedef {'blocking' | 'normal' | 'nit'} Severity */
/** @typedef {'open' | 'addressed' | 'answered' | 'declined' | 'needs_input' | 'resolved'} ThreadStatus */
/** @typedef {'addressed' | 'answered' | 'declined' | 'needs_input'} AgentReplyStatus */
/** @typedef {'comment' | 'changes_requested' | 'approved'} Verdict */
/** @typedef {'text' | 'element' | 'cell' | 'code' | 'section' | 'source' | 'doc' | 'snip'} AnchorKind */
/** @typedef {'exact' | 'moved' | 'edited' | 'changed' | 'orphaned'} AnchorState */
/** @typedef {'textmap' | 'narrowed' | 'raw-source' | 'element' | 'block' | 'lines' | 'override'} AnchorMappedBy */
/** @typedef {'tagged' | 'hint' | 'overlap'} LinkedBy */
/** @typedef {[number, number]} LineRange inclusive [startLine, endLine], 1-based */
/** @typedef {{ x: number, y: number, w: number, h: number }} Region fractions (0..1) of the stamped element's border box */

// ============================================================================ config and daemon

/**
 * `.specreview/config.json` with defaults merged (Store.config()).
 * @typedef {object} Config
 * @property {number} schema
 * @property {{ name: string }} reviewer default: git config user.name, then the OS user name
 * @property {{ enforceLocks: boolean, maxRewriteRatio: number, unexplainedWords: number,
 *   unexplainedDeletionLines: number, unexplainedDeletion: 'refuse' | 'warn' | 'off',
 *   writeHook: 'deny' | 'warn' | 'off', writeHookRatio: number }} guards
 * @property {{ minScore: number, minQuoteSim: number, contextChars: number }} anchoring
 * @property {{ network: 'allow' | 'block', mermaid: boolean, math: boolean, highlight: boolean }} render
 * @property {{ autoCommit: boolean }} git
 * @property {{ maxBytes: number }} assets
 */

/**
 * `<SPECREVIEW_HOME>/daemon.json` (mode 0600). Token, secret and ports persist across restarts.
 * @typedef {object} DaemonInfo
 * @property {number} pid
 * @property {number} uiPort
 * @property {number} contentPort
 * @property {string} token Bearer token for /api/*
 * @property {string} secret HMAC key for per-doc content capability paths
 * @property {string} version package version
 * @property {string} startedAt
 */

// ============================================================================ docs and versions

/**
 * `docs/<docId>/doc.json`.
 * @typedef {object} Doc
 * @property {number} schema
 * @property {string} id slug of the basename ('-2' suffix on collision)
 * @property {string} path workspace-relative POSIX path of the working copy
 * @property {DocFormat} format
 * @property {string} title
 * @property {string} createdAt
 * @property {Actor} createdBy
 * @property {'in_review' | 'approved' | 'closed'} state
 * @property {number} head latest committed version (0 before v1)
 * @property {number | null} lastReviewedVersion version of the newest submitted review
 * @property {DocFinal | null} final
 * @property {Record<IdKind, number>} counters last allocated number per id kind
 */

/** @typedef {{ version: number, review: string, at: string, by: string }} DocFinal */

/**
 * A hunk as recorded in a version manifest (head -> new version), with its attribution.
 * @typedef {object} ManifestHunk
 * @property {string} id 'h1'...
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {string[]} threads linked thread ids
 * @property {LinkedBy | null} linkedBy
 * @property {string | null} other explanation from ReviseInput.other
 */

/**
 * `docs/<docId>/versions/NNNN.json` (the commit point of a version).
 * @typedef {object} VersionManifest
 * @property {number} schema
 * @property {number} v
 * @property {number | null} parent
 * @property {string} file 'NNNN.<ext>'
 * @property {string} sha256 of the source bytes
 * @property {number} bytes
 * @property {number} lines
 * @property {string} createdAt
 * @property {Actor} author
 * @property {string} summary
 * @property {string | null} respondsTo review id
 * @property {'open' | 'revise' | 'ui-record' | 'ui-apply'} capturedBy
 * @property {Record<string, string>} assets workspace-relative path -> 'sha256:<hex>' | 'live'
 * @property {{ added: number, removed: number, hunks: number, rewriteRatio: number }} [stats]
 * @property {ManifestHunk[]} [hunks]
 * @property {{ errors: string[], warnings: string[], forced: boolean, brokenLocks: string[] }} [guards]
 * @property {{ commit: string | null }} [git]
 */

// ============================================================================ anchors

/**
 * Source range of an anchor (half-open offsets, inclusive 1-based lines).
 * @typedef {object} AnchorSrc
 * @property {number} start
 * @property {number} end
 * @property {number} startLine
 * @property {number} endLine
 * @property {string} text exact source slice [start, end)
 * @property {string} prefix up to `contextChars` source characters before
 * @property {string} suffix up to `contextChars` source characters after
 */

/** @typedef {{ exact: string, prefix: string, suffix: string }} AnchorQuote rendered text (whitespace as captured) */

/**
 * @typedef {object} AnchorElement
 * @property {number} srid
 * @property {string} tag
 * @property {Record<string, string>} attrs e.g. {src, alt}
 * @property {string | null} [assetSha256] hash of the referenced local file (images)
 * @property {string} label e.g. '<img alt="System overview">'
 * @property {number} ordinal index among same-tag elements in the same section
 */

/** @typedef {{ nodeId: string, label: string }} SvgTarget mermaid node or authored SVG child */

/**
 * @typedef {object} CellTarget
 * @property {number} [tableSrid]
 * @property {number} row
 * @property {number} col
 * @property {string} rowKey first cell's text of the row
 * @property {string} colHeader header row's text of the column
 * @property {string} text
 */

/** @typedef {{ fromLine: number, toLine: number, lang?: string }} CodeTarget lines within the code block, 1-based */

/**
 * One anchor of a thread / lock / draft at one version (amendments version: `srid`/`endSrid` replace the design's
 * `dom` offsets, since there is no character aligner).
 * @typedef {object} Anchor
 * @property {number} v version the anchor refers to
 * @property {AnchorKind} kind
 * @property {AnchorState} state
 * @property {AnchorMappedBy} mappedBy
 * @property {AnchorSrc} src
 * @property {AnchorQuote | null} quote
 * @property {number | null} srid deepest stamped element containing the anchor (start)
 * @property {number | null} endSrid deepest stamped element containing the anchor end (null = same as srid)
 * @property {string[]} section heading chain before src.start
 * @property {boolean} generated true when the text was not found verbatim (script-built content, fallbacks)
 * @property {AnchorElement | null} element
 * @property {Region | null} region
 * @property {SvgTarget | null} svg
 * @property {CellTarget | null} cell
 * @property {CodeTarget | null} code
 * @property {{ t: number } | null} media
 * @property {'cell' | 'row' | 'column' | 'table'} [scope] cell anchors
 * @property {boolean} [assetChanged] the anchored image's bytes changed
 * @property {Anchor | null} [lastKnown] previous anchor, kept when orphaned
 * @property {SnipInfo} [snip] snip anchors (kind 'snip', or 'doc' when the box covered nothing stamped)
 */

/**
 * What a snip anchor remembers about the boxed area (src/core/anchor/snip.js).
 * @typedef {object} SnipInfo
 * @property {string} label the guest's label, e.g. 'area over "2. Request flow" (figure + 2 paragraphs)'
 * @property {string} covers what the box covers, computed from the render: 'figure + 2 paragraphs'
 * @property {string} text visible text inside the box, whitespace-collapsed (<= SNIP.maxText chars)
 * @property {Region | null} region the box as captured (fractions of the container, or of the document without one)
 * @property {{ srid: number | null, tag: string, s: number, e: number, label: string } | null} container deepest
 *   stamped element containing the whole box at the anchor's version (null once lost)
 */

// ============================================================================ captures (guest -> server) and DOM targets

/**
 * @typedef {{ kind: 'text', startSrid: number | null, endSrid: number | null, exact: string, prefix: string, suffix: string }
 *   | { kind: 'element', srid: number, tag: string, label: string, region?: Region, svg?: SvgTarget,
 *       cell?: { row: number, col: number, rowKey: string, colHeader: string, text: string },
 *       scope?: 'cell' | 'row' | 'column' | 'table' }
 *   | { kind: 'section', headingSrid: number }
 *   | { kind: 'source', startLine: number, endLine: number }
 *   | SnipCapture
 *   | { kind: 'doc' }} Capture
 */

/**
 * A snip (key `b`): a box dragged over any area of the rendered doc (protocol.js SNIP documents the fields).
 * @typedef {{ kind: 'snip', srids: number[], startSrid: number | null, endSrid: number | null,
 *   containerSrid: number | null, region: Region, text: string, label: string }} SnipCapture
 */

/**
 * What the guest paints for one thread / lock / draft (amendments 3.4).
 * @typedef {object} DomTarget
 * @property {string} id
 * @property {number} num display number
 * @property {AnchorKind} kind
 * @property {'open' | 'addressed' | 'resolved' | 'outdated' | 'orphaned' | 'draft' | 'lock' | 'needs_input'} state
 * @property {number | null} srid
 * @property {number | null} endSrid
 * @property {string | null} quote rendered text to look for (whitespace-insensitive)
 * @property {string} prefix
 * @property {string} suffix
 * @property {Region | null} region
 * @property {SvgTarget | null} svg
 * @property {object | null} cell
 * @property {string} label
 * @property {string} [severity]
 * @property {string} [type]
 */

// ============================================================================ threads, reviews, locks, drafts

/**
 * @typedef {object} Comment
 * @property {string} id 'c1'...
 * @property {Actor} by
 * @property {string} body Markdown
 * @property {string} at
 * @property {number} version version the comment was made against
 * @property {string} [review] review id (reviewer comments)
 * @property {AgentReplyStatus} [status] agent replies
 */

/**
 * @typedef {object} Suggestion
 * @property {'text' | 'source'} mode text = the exact slice; source = whole lines
 * @property {number} version
 * @property {number} start
 * @property {number} end
 * @property {number} startLine
 * @property {number} endLine
 * @property {string} old
 * @property {string} new
 * @property {'pending' | 'staged' | 'applied' | 'conflict'} status
 * @property {number | null} appliedIn
 */

/**
 * @typedef {object} Decision
 * @property {string} id 'D1'...
 * @property {string} text one-line agreement
 * @property {number} version
 * @property {string} [srcText] anchored source text when recorded
 * @property {string} at
 * @property {string} [thread] owning thread (in DocState.decisions)
 */

/**
 * `docs/<docId>/threads/tN.json`.
 * @typedef {object} Thread
 * @property {number} schema
 * @property {string} id
 * @property {string} doc
 * @property {ThreadType} type
 * @property {Severity} severity
 * @property {ThreadStatus} status
 * @property {number} createdIn version
 * @property {Actor} createdBy
 * @property {string | null} review review that introduced it (null for agent questions)
 * @property {Record<string, Anchor>} anchors keyed by version number
 * @property {{ version: number, lines?: LineRange, quote?: string, by: 'agent' | 'human' } | null} override
 * @property {Suggestion | null} suggestion
 * @property {Comment[]} comments
 * @property {Array<{ version: number, hunk: string, linkedBy: LinkedBy }>} changes
 * @property {string[]} attachments doc-relative paths ('attachments/a1.png')
 * @property {Decision | null} decision
 * @property {number | null} resolvedIn
 * @property {string} updatedAt
 */

/**
 * `docs/<docId>/reviews/rvN.json` (the commit point of a review submit).
 * @typedef {object} Review
 * @property {number} schema
 * @property {string} id
 * @property {number} version
 * @property {Actor} by
 * @property {Verdict} verdict
 * @property {string} body
 * @property {boolean} markFinal
 * @property {string[]} newThreads
 * @property {Array<{ thread: string, comment: string }>} replies
 * @property {string[]} reopened
 * @property {string[]} resolved
 * @property {string[]} locksAdded
 * @property {string} submittedAt
 * @property {Record<string, string>} deliveredTo agent -> delivery time
 * @property {Record<string, string>} ackedBy agent -> time of the agent's next op after delivery
 */

/**
 * `docs/<docId>/locks/LN.json` ("Mark agreed").
 * @typedef {object} Lock
 * @property {number} schema
 * @property {string} id
 * @property {boolean} active
 * @property {string} note
 * @property {number} createdIn
 * @property {Actor} by
 * @property {Record<string, Anchor>} anchors keyed by version number
 * @property {string} text exact source slice at creation (used by revert --lock)
 * @property {string} textSha256
 * @property {Array<{ version: number, reason: string, by: string, at: string }>} breaks
 * @property {string} [createdAt]
 */

/**
 * @typedef {{ id: string, kind: 'thread', type: ThreadType, severity: Severity, anchor: Anchor, body: string,
 *   suggestion: Suggestion | null, attachments: string[], updatedAt: string, version?: number }
 *   | { id: string, kind: 'reply', thread: string, body: string, reopen?: boolean, updatedAt: string }
 *   | { id: string, kind: 'resolve', thread: string, decision?: string, updatedAt: string }} DraftItem
 */

/** @typedef {{ schema: number, items: DraftItem[] }} Drafts runtime drafts/<docId>.json */

/**
 * One line of runtime pending/<docId>.jsonl: a tagged edit made since head.
 * @typedef {object} PendingEdit
 * @property {string} at
 * @property {'apply' | 'edit' | 'override' | 'revert'} via
 * @property {string[]} [threads] apply / edit
 * @property {string} [thread] override
 * @property {LineRange} [newLines] apply / edit: lines of the working copy after the edit
 * @property {LineRange} [lines] override
 * @property {string} [quote] override
 * @property {string} [beforeSha256]
 * @property {string} [afterSha256]
 */

// ============================================================================ runtime: events and waiters

/**
 * One line of runtime events/<docId>.jsonl. `type` is one of the SSE names in protocol.js.
 * @typedef {{ seq: number, at: string, type: string } & Record<string, unknown>} StoreEvent
 */
/** @typedef {StoreEvent} Event */

/**
 * runtime waiters/<docId>/<pid>.json ('_all' dir for wait --all).
 * @typedef {object} Waiter
 * @property {number} pid
 * @property {string} agent
 * @property {string} since
 * @property {string} heartbeatAt
 * @property {number} [supersededBy] pid of the newer waiter that replaced this one
 */

/**
 * Returned by Store.registerWaiter.
 * @typedef {object} WaiterHandle
 * @property {string} docId
 * @property {string} agent
 * @property {number} pid
 * @property {string} file
 * @property {() => Promise<number | null>} heartbeat refreshes heartbeatAt; resolves to supersededBy (or null)
 * @property {() => Promise<number | null>} isSuperseded pid of the superseding waiter, or null
 * @property {() => Promise<void>} remove
 */

// ============================================================================ render (WP2)

/**
 * @typedef {object} SrcNode
 * @property {string} t tag
 * @property {number} s start offset
 * @property {number} e end offset
 * @property {number} ls start line
 * @property {number} le end line
 * @property {number} p parent srid (0 = none)
 * @property {boolean} b block element
 * @property {'code' | 'math' | 'mermaid' | 'frontmatter' | 'table' | 'tr' | 'cell' | 'img' | 'svg' | 'media' | 'embed' | 'heading'} [k]
 * @property {{ level: number, text: string }} [h]
 * @property {{ id?: string, src?: string, alt?: string, href?: string, class?: string, poster?: string, data?: string }} [a]
 * @property {{ contentStart: number, contentEnd: number, firstLine: number }} [c] verbatim content of code/mermaid fences
 */

/** @typedef {{ srid: number, level: number, text: string, line: number, id: string }} OutlineItem */

/**
 * @typedef {object} RenderResult
 * @property {string} html
 * @property {number} guestInsertAt
 * @property {{ order: number[], nodes: Record<string, SrcNode> }} srcmap
 * @property {{ text: string, spans: Record<string, [number, number]> }} text
 * @property {OutlineItem[]} outline
 * @property {string[]} assets workspace-relative POSIX paths of referenced local files
 * @property {string[]} externals absolute http(s) URLs
 * @property {string} title
 * @property {{ mermaid: boolean, math: boolean, code: boolean }} features
 */

// ============================================================================ diff (WP2) and changes (WP3)

/**
 * Line hunk from lineHunks(a, b): half-open 1-based ranges plus char offsets of the covered whole lines.
 * @typedef {object} Hunk
 * @property {string} id
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {number} oldStartOff
 * @property {number} oldEndOff
 * @property {number} newStartOff
 * @property {number} newEndOff
 */

/**
 * @typedef {object} ChangeHunk
 * @property {string} id
 * @property {'add' | 'del' | 'mod'} op
 * @property {{ start: number, lines: number }} old
 * @property {{ start: number, lines: number }} new
 * @property {number[]} srids
 * @property {Array<{ srid: number, quote: string, prefix: string, suffix: string }>} words
 * @property {{ text: string, html: string | null, lines: number } | null} deleted
 * @property {{ srid: number } | null} insertBefore
 * @property {string[]} section
 * @property {string[]} [threads] added by WP3
 * @property {LinkedBy | null} [linkedBy] added by WP3
 * @property {string | null} [other] added by WP3
 */

/**
 * @typedef {object} Changes
 * @property {number | 'live'} [from]
 * @property {number | 'live'} [to]
 * @property {{ added: number, removed: number, hunks: number, blocksChanged: number }} stats
 * @property {ChangeHunk[]} hunks
 * @property {Array<{ path: string, fromUrl: string | null, toUrl: string | null, srids: number[], from?: string, to?: string }>} [assets]
 * @property {Record<string, string[]>} [threadLinks] thread id -> hunk ids (WP3)
 * @property {{ forced: boolean, brokenLocks: string[] }} [guards]
 */

// ============================================================================ API state (WP5/WP7)

/**
 * GET /api/docs/:ws/:doc
 * @typedef {object} DocState
 * @property {string} ws
 * @property {Doc} doc
 * @property {Array<Pick<VersionManifest, 'v' | 'author' | 'summary' | 'createdAt' | 'stats' | 'guards' | 'respondsTo'>>} versions
 * @property {Thread[]} threads
 * @property {Lock[]} locks
 * @property {Review[]} reviews
 * @property {Drafts} drafts
 * @property {Array<{ agent: string, since: string, pid?: number }>} waiters
 * @property {{ dirty: boolean, sha256: string }} working
 * @property {string} contentBase 'http://127.0.0.1:<cport>/c/<docKey>' (a doc URL is `${contentBase}/${ver}/${doc.path}`)
 * @property {string} attachmentBase '<contentBase>/__att/': an attachment's image URL is attachmentBase + basename(path)
 *   (images only; served to the UI origin, refused to the doc's own origin)
 * @property {{ name: string }} reviewer
 * @property {Decision[]} decisions
 */

// ============================================================================ agent interface (WP3/WP4)

/**
 * @typedef {object} PacketThread
 * @property {string} id
 * @property {'new' | 'reopened' | 'reply' | 'answer' | 'open'} why
 * @property {ThreadType} type
 * @property {Severity} severity
 * @property {ThreadStatus} status
 * @property {LineRange | null} lines working-copy lines
 * @property {string[]} section
 * @property {AnchorKind} target
 * @property {string} label
 * @property {string | null} on rendered quote (<= 120 chars)
 * @property {string | null} src working-copy source lines
 * @property {boolean} srcUnique
 * @property {boolean} [srcWindow] src is a window of a long line
 * @property {boolean} [srcEditable] false when src had elided data: URIs
 * @property {AnchorState} anchorState
 * @property {Array<{ by: string, kind: ActorKind, body: string, at: string }>} comments
 * @property {Suggestion | null} suggestion
 * @property {string[]} attachments absolute paths
 * @property {'region' | 'snip' | 'image'} attachmentKind what the attachments show: a region crop ('crop:' lines),
 *   a snipped area or another image ('image:' lines)
 * @property {string | null} apply suggested command
 */

/**
 * Feedback packet (`wait` / `feedback --json`, MCP structuredContent).
 * @typedef {object} Packet
 * @property {number} schema
 * @property {string} doc
 * @property {string} path
 * @property {number} head
 * @property {'clean' | 'dirty'} working
 * @property {Array<{ id: string, version: number, verdict: Verdict, body: string, by: string, at: string }>} reviews
 * @property {Verdict | null} verdict
 * @property {DocFinal | null} final
 * @property {PacketThread[]} threads
 * @property {Array<{ id: string, lines: LineRange | null, section: string[] }>} locks
 * @property {Array<{ id: string, thread: string, text: string }>} decisions
 * @property {DraftItem[] | null} drafts
 * @property {{ actionable: number, new: number, reopened: number, reply: number, answer: number,
 *   awaitingReviewer: number, resolved: number, outdated: number }} counts
 * @property {string} next
 */

/**
 * `revise` input (zod ReviseInput in WP4).
 * @typedef {object} ReviseInput
 * @property {string} summary
 * @property {Record<string, { status: AgentReplyStatus, reply: string, at?: string }>} threads
 * @property {Array<{ at: string, why: string }>} [other] at: 'L12' | 'L12-14' | 'del:h6' | 'h6'
 * @property {Record<string, string>} [breakLocks] lock id -> reason
 * @property {boolean} [allowRewrite]
 * @property {boolean} [force]
 * @property {boolean} [dryRun]
 */

/**
 * @typedef {object} ReviseReport
 * @property {boolean} refused
 * @property {number} [version]
 * @property {Array<{ id: string, oldRange: LineRange | null, newRange: LineRange | null, section: string[],
 *   threads: string[], linkedBy: LinkedBy | null, other: string | null }>} hunks
 * @property {Array<{ thread: string, status: AgentReplyStatus }>} replies
 * @property {{ errors: string[], warnings: string[] }} guards
 * @property {{ exact: number, moved: number, edited: number, changed: number, orphaned: number }} anchors
 * @property {boolean} notified
 */
