// @ts-check
// In-memory code review (doc kind 'code') for the e2e mock server: the shapes of code-contracts.md sections 1, 7 and
// 11 with realistic data, so the code-review UI (WP4) is built and tested without the real code engine (WP3).
//
// A review compares a fixed base with rounds of the new side. Each round holds every changed file:
//   { path, oldPath?, status: 'A'|'M'|'D'|'R'|'T'|'=', oldText?, newText?, binary?, tooLarge? }
// The base side of a file is constant across rounds (so old-side anchors never move); the new side changes per
// round. Diffs use the real sourceDiff / lineHunks; hunk ids are '<path>#h<n>' like the engine's.
//
// MockCodeDoc has the interface the mock server calls on a MockDoc (docState, domTargets, source, resolveCapture,
// preview, drafts, submitReview, resolve, move, applySuggestion, miniDiff, changes, sourceDiff, recordWorking,
// saveAttachment, fragment, emit / listeners / events / seq ...) plus the code routes (files, fileDiff, fileSource).
// Test controls: revise(...) records an agent round, setWorking(...) marks the working tree dirty with a pending
// round that POST D/record (Re-snapshot) records.
//
// The 'code' scenario (buildCodeScenario): doc 'cr-feat' after one review round; see the comment there.

import { createHash } from 'node:crypto';
import { renderFragmentSync } from '../../src/core/render/index.js';
import { lineHunks, sourceDiff, unifiedPatch, wordDiff } from '../../src/core/diff/index.js';
import { httpError } from './mock-engine.mjs';
import { WS } from './mock-data.mjs';

/** @param {string} s */
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Lines without terminators ('' has none). @param {string|undefined|null} s */
function linesOf(s) {
  if (!s) return [];
  const out = s.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * @typedef {{ path: string, oldPath?: string, status: 'A'|'M'|'D'|'R'|'T'|'=', oldText?: string, newText?: string,
 *   binary?: boolean, tooLarge?: { side: 'old'|'new', bytes: number|null } }} RoundFile
 * @typedef {{ v: number, files: RoundFile[], manifest: any }} Round
 */

export class MockCodeDoc {
  /**
   * @param {{ ws: string, id: string, title: string, files: RoundFile[], skipped?: Array<{ path: string, reason: string }>,
   *   reviewer?: string, clock?: () => string }} opts
   */
  constructor(opts) {
    this.ws = opts.ws;
    this.id = opts.id;
    this.format = 'text';
    this.reviewer = opts.reviewer || 'Eric';
    this.clock = opts.clock || (() => new Date().toISOString());
    /** @type {Round[]} */
    this.rounds = [];
    /** @type {any[]} */
    this.threads = [];
    /** @type {any[]} */
    this.reviews = [];
    /** @type {any[]} */
    this.locks = [];
    /** @type {{ schema: number, items: any[] }} */
    this.drafts = { schema: 1, items: [] };
    /** @type {any[]} */
    this.waiters = [];
    /** @type {{ dirty: boolean, sha256: string, changedFiles: string[], pending: RoundFile[]|null }} */
    this.working = { dirty: false, sha256: '', changedFiles: [], pending: null };
    this.skipped = opts.skipped || [];
    /** Code docs have no assets: the content origin answers 404 (except attachments). */
    this.assetHashes = {};
    /** @type {Map<string, Buffer>} */
    this.assetBlobs = new Map();
    /** @type {any[]} */
    this.events = [];
    this.seq = 0;
    /** @type {Set<(ev: any, doc: any) => void>} */
    this.listeners = new Set();
    this.counters = { thread: 0, comment: 0, review: 0, lock: 0, decision: 0, draft: 0, attachment: 0 };
    /** @type {Map<string, string>} */
    this.attachments = new Map();
    this.contentBase = '';
    this.doc = {
      schema: 1,
      id: opts.id,
      kind: 'code',
      origin: { type: 'diff', key: 'diff:since-base:main' },
      code: { mode: 'since-base', base: 'main', context: 3 },
      ephemeral: true,
      path: `code/${opts.id}.diff`,
      format: 'text',
      title: opts.title,
      createdAt: this.clock(),
      createdBy: { kind: 'agent', name: 'claude' },
      state: 'in_review',
      head: 0,
      lastReviewedVersion: null,
      final: null,
      counters: this.counters,
    };
    this.addRound(opts.files, { author: { kind: 'agent', name: 'claude' }, summary: 'Initial review of feat vs main', capturedBy: 'open' }, false);
  }

  // ------------------------------------------------------------------------------------------ basics

  get head() {
    return this.doc.head;
  }

  /** @param {number} v */
  round(v) {
    const r = this.rounds[Number(v) - 1];
    if (!r || !Number.isInteger(Number(v))) throw httpError(404, `version ${v} not found`);
    return r;
  }

  /** @param {number} v @param {string} path */
  file(v, path) {
    const f = this.round(v).files.find((x) => x.path === path);
    if (!f) throw httpError(404, `${path} is not in round v${v}`, 'NOT_FOUND');
    return f;
  }

  /** The text of one side of a file (base for old; '' where the side does not exist). @param {RoundFile} f @param {'new'|'old'} side */
  sideText(f, side) {
    if (side === 'old') return f.status === 'A' ? '' : f.oldText ?? f.newText ?? '';
    return f.status === 'D' ? '' : f.newText ?? '';
  }

  /** The canonical diff text of a round (what GET D/source answers; the code UI does not use it). @param {number|'live'} v */
  source(v) {
    const r = this.round(v === 'live' ? this.head : Number(v));
    return r.files.filter((f) => !f.binary && !f.tooLarge).map((f) => unifiedPatch(this.sideText(f, 'old'), this.sideText(f, 'new'), {
      fromLabel: `a/${f.oldPath || f.path}`, toLabel: `b/${f.path}`,
    })).join('');
  }

  /** Code docs are never rendered. */
  render() {
    throw httpError(404, 'code reviews are not rendered');
  }

  /** @param {'thread'|'comment'|'review'|'lock'|'decision'|'draft'|'attachment'} kind */
  nextId(kind) {
    const prefix = { thread: 't', comment: 'c', review: 'rv', lock: 'L', decision: 'D', draft: 'd', attachment: 'a' }[kind];
    this.counters[kind] += 1;
    return `${prefix}${this.counters[kind]}`;
  }

  /** @param {string} type @param {Record<string, any>} [payload] @param {{ volatile?: boolean }} [opts] */
  emit(type, payload = {}, opts = {}) {
    const ev = opts.volatile ? { at: this.clock(), type, ...payload } : { seq: ++this.seq, at: this.clock(), type, ...payload };
    if (!opts.volatile) this.events.push(ev);
    for (const fn of this.listeners) fn(ev, this);
    return ev;
  }

  /** @param {string} id */
  thread(id) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) throw httpError(404, `thread ${id} not found`);
    return t;
  }

  latestReview() {
    return this.reviews.length ? this.reviews[this.reviews.length - 1] : null;
  }

  // ------------------------------------------------------------------------------------------ rounds

  /** @param {RoundFile} f */
  codeFile(f) {
    /** @type {any} */
    const out = { path: f.path, status: f.status, added: 0, removed: 0 };
    if (f.oldPath) out.oldPath = f.oldPath;
    if (f.status !== 'A') out.old = `sha256:${sha(f.oldText ?? f.newText ?? '')}`;
    if (f.status !== 'D') out.new = `sha256:${sha(f.newText ?? '')}`;
    if (f.binary) out.binary = true;
    if (f.tooLarge) out.tooLarge = f.tooLarge;
    if (!f.binary && !f.tooLarge) {
      for (const h of lineHunks(this.sideText(f, 'old'), this.sideText(f, 'new'))) {
        out.added += h.newLines;
        out.removed += h.oldLines;
      }
    }
    return out;
  }

  /**
   * Records a round of the new side.
   * @param {RoundFile[]} files
   * @param {{ author: any, summary: string, capturedBy: string, respondsTo?: string|null,
   *   hunkLinks?: Record<string, { threads?: string[], other?: string|null }> }} meta
   * @param {boolean} [notify] re-anchor the threads onto the new round
   */
  addRound(files, meta, notify = true) {
    const v = this.rounds.length + 1;
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const prev = v > 1 ? this.rounds[v - 2] : null;
    const hunks = [];
    let added = 0;
    let removed = 0;
    if (prev) {
      for (const path of new Set([...prev.files.map((f) => f.path), ...sorted.map((f) => f.path)])) {
        const a = prev.files.find((f) => f.path === path);
        const b = sorted.find((f) => f.path === path);
        for (const h of lineHunks(a ? this.sideText(a, 'new') : '', b ? this.sideText(b, 'new') : '')) {
          const id = `${path}#${h.id}`;
          added += h.newLines;
          removed += h.oldLines;
          hunks.push({
            id, file: path, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines,
            threads: meta.hunkLinks?.[id]?.threads || [],
            linkedBy: meta.hunkLinks?.[id]?.threads?.length ? 'overlap' : null,
            other: meta.hunkLinks?.[id]?.other ?? null,
          });
        }
      }
    }
    const text = sorted.map((f) => `${f.path}\n${f.newText ?? ''}`).join('\0');
    const manifest = {
      schema: 1, v, parent: prev ? v - 1 : null, file: `${String(v).padStart(4, '0')}.diff`, sha256: sha(text),
      createdAt: this.clock(), author: meta.author, summary: meta.summary, respondsTo: meta.respondsTo ?? null,
      capturedBy: meta.capturedBy, assets: {},
      stats: { added, removed, hunks: hunks.length, rewriteRatio: 0 },
      hunks,
      guards: { errors: [], warnings: [], forced: false, brokenLocks: [] },
      git: { commit: null },
      code: {
        root: '/repo', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40), newSha: null, newTree: null, newSide: 'worktree',
        baseMoved: null, files: sorted.map((f) => this.codeFile(f)), skipped: this.skipped, stat: {},
      },
    };
    this.rounds.push({ v, files: sorted, manifest });
    this.doc.head = v;
    this.working = { dirty: false, sha256: manifest.sha256, changedFiles: [], pending: null };
    if (notify) for (const t of this.threads) this.carry(t, v - 1, v);
    return manifest;
  }

  /**
   * The agent's round (`revise`): records the files, posts replies, links hunks, emits version.created.
   * @param {{ files: RoundFile[], summary: string, replies?: Record<string, { status: string, reply: string }>,
   *   hunkLinks?: Record<string, { threads?: string[], other?: string|null }>, agent?: string }} p
   */
  revise(p) {
    const agent = p.agent || 'claude';
    const last = this.latestReview();
    const manifest = this.addRound(p.files, {
      author: { kind: 'agent', name: agent }, summary: p.summary, capturedBy: 'round', respondsTo: last ? last.id : null, hunkLinks: p.hunkLinks,
    }, false);
    const v = manifest.v;
    for (const h of manifest.hunks) {
      for (const tid of h.threads) {
        const t = this.threads.find((x) => x.id === tid);
        if (t) t.changes.push({ version: v, hunk: h.id, linkedBy: 'overlap' });
      }
    }
    for (const t of this.threads) this.carry(t, v - 1, v);
    let addressed = 0;
    let needs = 0;
    for (const [tid, r] of Object.entries(p.replies || {})) {
      const t = this.thread(tid);
      t.comments.push({ id: this.nextId('comment'), by: { kind: 'agent', name: agent }, body: r.reply, at: this.clock(), version: v, status: r.status });
      t.status = r.status;
      t.updatedAt = this.clock();
      if (['addressed', 'answered', 'declined'].includes(r.status)) addressed++;
      if (r.status === 'needs_input') needs++;
    }
    if (last) last.ackedBy = { ...(last.ackedBy || {}), [agent]: this.clock() };
    if (this.doc.state === 'approved') this.doc.state = 'in_review';
    this.emit('version.created', { v, author: `agent:${agent}`, summary: p.summary, respondsTo: last?.id ?? null, counts: { addressed, needs_input: needs } });
    return manifest;
  }

  /** The files of the head round with some replaced (or added), for revise / setWorking. @param {Record<string, string|null>} edits path -> new text (null drops the file) */
  filesWith(edits) {
    const out = this.round(this.head).files.map((f) => ({ ...f }));
    for (const [path, text] of Object.entries(edits)) {
      const i = out.findIndex((f) => f.path === path);
      if (text == null) {
        if (i >= 0) out.splice(i, 1);
      } else if (i >= 0) out[i] = { ...out[i], newText: text };
      else out.push({ path, status: 'A', newText: text });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ anchors

  /**
   * A line anchor (like anchorFromLines plus `file`).
   * @param {number} v @param {string} path @param {'new'|'old'} side @param {number} startLine @param {number} endLine
   * @param {Record<string, any>} [extra]
   */
  lineAnchor(v, path, side, startLine, endLine, extra = {}) {
    const f = this.file(v, path);
    const lines = linesOf(this.sideText(f, side));
    return {
      v, kind: 'source', state: 'exact', mappedBy: 'lines',
      src: { start: 0, end: 0, startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n'), prefix: '', suffix: '' },
      quote: null, srid: null, endSrid: null, section: [path], generated: false, element: null, region: null, svg: null,
      cell: null, code: null, media: null,
      file: { path, side, ...(f.oldPath && side === 'old' ? { oldPath: f.oldPath } : {}) },
      ...extra,
    };
  }

  /** A whole-review anchor, or a whole-file one with `path`. @param {number} v @param {string} [path] */
  docAnchor(v, path) {
    const f = path ? this.file(v, path) : null;
    return {
      v, kind: 'doc', state: 'exact', mappedBy: 'block',
      src: { start: 0, end: 0, startLine: 1, endLine: 1, text: '', prefix: '', suffix: '' },
      quote: null, srid: null, endSrid: null, section: path ? [path] : [], generated: false, element: null, region: null,
      svg: null, cell: null, code: null, media: null,
      ...(f ? { file: { path: f.path, side: f.status === 'D' ? 'old' : 'new' } } : {}),
    };
  }

  /**
   * Resolves a code capture (line / file / doc) against round v, refusing every other kind like the engine.
   * @param {number} v @param {any} cap
   */
  resolveCapture(v, cap) {
    if (!cap || typeof cap !== 'object') throw httpError(422, 'capture is required');
    if (!Number.isInteger(v) || v > this.head || v < 1) throw httpError(404, `version ${v} not found`);
    if (cap.kind === 'doc') return this.docAnchor(v);
    if (cap.kind === 'file') {
      if (typeof cap.file !== 'string' || !cap.file) throw httpError(422, 'capture.file is required');
      return this.docAnchor(v, cap.file);
    }
    if (cap.kind !== 'line') throw httpError(422, `a code review takes line, file or doc captures, not ${cap.kind}`, 'USAGE');
    if (cap.side !== 'new' && cap.side !== 'old') throw httpError(422, 'capture.side must be new or old');
    const f = this.file(v, String(cap.file));
    if (f.binary || f.tooLarge) throw httpError(422, `${f.path} has no lines to comment on; comment on the whole file`);
    if (cap.side === 'new' && f.status === 'D') throw httpError(422, `${f.path} was deleted: it has no new side`);
    if (cap.side === 'old' && f.status === 'A') throw httpError(422, `${f.path} is a new file: it has no old side`);
    const n = linesOf(this.sideText(f, cap.side)).length;
    const s = Number(cap.startLine);
    const e = Number(cap.endLine ?? cap.startLine);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s || e > n) throw httpError(422, `lines ${s}-${e} are outside ${f.path} (${n} lines)`);
    return this.lineAnchor(v, f.path, cap.side, s, e);
  }

  /** @param {any} a */
  label(a) {
    if (!a) return '';
    if (!a.file) return 'whole review';
    if (a.kind === 'doc') return `${a.file.path} (whole file)`;
    const { startLine: s, endLine: e } = a.src;
    const lines = s === e ? `L${s}` : `L${s}-${e}`;
    return a.file.side === 'old' ? `${a.file.path} (old side) ${lines}` : `${a.file.path}:${lines}`;
  }

  /** The composer preview: {label, lines, section, src, text}. @param {any} a */
  preview(a) {
    const lines = a.kind === 'doc' ? null : [a.src.startLine, a.src.endLine];
    const label = this.label(a);
    return {
      label,
      lines,
      section: a.section || [],
      src: lines ? a.src.text.split('\n').slice(0, 3).join('\n') : '',
      text: `Agent will see: ${a.file ? label : 'GENERAL whole review'}`,
    };
  }

  /**
   * Carries a thread's anchor from round a to round b: old-side lines never move (the base is fixed), new-side lines
   * shift by the hunks above them, and lines inside a changed hunk become 'edited' (linked) or 'changed'.
   * @param {any} item @param {number} a @param {number} b
   */
  carry(item, a, b) {
    const prev = item.anchors[String(a)] || Object.values(item.anchors).slice(-1)[0];
    if (!prev) return;
    const nextFile = prev.file ? this.round(b).files.find((f) => f.path === prev.file.path) : null;
    if (prev.file && !nextFile) {
      item.anchors[String(b)] = { ...prev, v: b, state: 'orphaned', lastKnown: prev };
      return;
    }
    if (prev.kind === 'doc' || prev.file?.side === 'old') {
      item.anchors[String(b)] = { ...prev, v: b, state: prev.state === 'orphaned' ? 'orphaned' : 'exact' };
      return;
    }
    const before = this.sideText(this.file(a, prev.file.path), 'new');
    const after = this.sideText(/** @type {RoundFile} */ (nextFile), 'new');
    const { startLine: s, endLine: e } = prev.src;
    let delta = 0;
    for (const h of lineHunks(before, after)) {
      const oEnd = h.oldStart + h.oldLines - 1;
      if (h.oldLines && h.oldStart <= e && oEnd >= s) {
        const linked = (item.changes || []).some((/** @type {any} */ c) => c.version === b);
        const start = s < h.oldStart ? s + delta : h.newStart;
        const end = e > oEnd ? e + delta + h.newLines - h.oldLines : h.newStart + h.newLines - 1;
        if (end < start) {
          item.anchors[String(b)] = { ...prev, v: b, state: 'orphaned', lastKnown: prev };
          return;
        }
        item.anchors[String(b)] = this.lineAnchor(b, prev.file.path, 'new', start, end, { state: linked ? 'edited' : 'changed' });
        return;
      }
      if (h.oldStart + h.oldLines <= s && (h.oldLines || h.oldStart <= s)) delta += h.newLines - h.oldLines;
    }
    const moved = delta !== 0;
    item.anchors[String(b)] = this.lineAnchor(b, prev.file.path, 'new', s + delta, e + delta, { state: moved ? 'moved' : 'exact' });
  }

  // ------------------------------------------------------------------------------------------ DocState and targets

  docState() {
    return {
      ws: this.ws,
      doc: { ...this.doc, counters: { ...this.counters } },
      versions: this.rounds.map(({ manifest: m }) => ({
        v: m.v, author: m.author, summary: m.summary, createdAt: m.createdAt, stats: m.stats, guards: m.guards,
        respondsTo: m.respondsTo, capturedBy: m.capturedBy, hunks: m.hunks, assets: {},
      })),
      threads: structuredClone(this.threads),
      locks: [],
      reviews: structuredClone(this.reviews),
      drafts: structuredClone(this.drafts),
      waiters: structuredClone(this.waiters),
      working: { dirty: this.working.dirty, missing: false, sha256: this.working.sha256, changedFiles: [...this.working.changedFiles] },
      reviewer: { name: this.reviewer },
      decisions: this.threads.filter((t) => t.decision).map((t) => ({ ...t.decision, thread: t.id })),
    };
  }

  /** GET D/versions/:v/targets of a code doc: nothing to paint, no outline. */
  domTargets() {
    return { threads: [], locks: [], drafts: [], outline: [] };
  }

  /** Thread ids anchored in a file at round v. @param {number} v @param {string} path */
  threadsIn(v, path) {
    return this.threads.filter((t) => {
      const a = anchorAt(t, v);
      return a?.file?.path === path && t.createdIn <= v;
    }).map((t) => t.id);
  }

  // ------------------------------------------------------------------------------------------ code routes

  /** GET D/files. @param {{ v?: number, from?: number, to?: number }} q */
  files(q) {
    if (q.from != null || q.to != null) {
      const from = Number(q.from);
      const to = Number(q.to);
      const A = this.round(from);
      const B = this.round(to);
      const out = [];
      for (const path of new Set([...A.files.map((f) => f.path), ...B.files.map((f) => f.path)])) {
        const a = A.files.find((f) => f.path === path);
        const b = B.files.find((f) => f.path === path);
        const hs = lineHunks(a ? this.sideText(a, 'new') : '', b ? this.sideText(b, 'new') : '');
        const binChanged = (a?.binary || b?.binary) && JSON.stringify(a) !== JSON.stringify(b);
        if (a && b && !hs.length && !binChanged && a.oldPath === b.oldPath) continue;
        const change = !a ? 'added' : !b ? 'dropped' : a.oldPath !== b.oldPath ? 'renamed' : 'changed';
        out.push({
          path, ...(b?.oldPath ? { oldPath: b.oldPath } : {}), change,
          added: hs.reduce((n, h) => n + h.newLines, 0), removed: hs.reduce((n, h) => n + h.oldLines, 0),
          threads: this.threadsIn(to, path),
        });
      }
      out.sort((x, y) => (x.path < y.path ? -1 : 1));
      return { from, to, files: out };
    }
    const v = Number(q.v ?? this.head);
    const r = this.round(v);
    return {
      v,
      files: r.manifest.code.files.map((/** @type {any} */ f) => ({ ...f, threads: this.threadsIn(v, f.path) })),
      skipped: this.skipped,
    };
  }

  /**
   * Display hunks with '<path>#h<n>' ids and the threads on each.
   * @param {string} path @param {string} a @param {string} b @param {number} context @param {(h: any) => string[]} threadsOf
   */
  displayHunks(path, a, b, context, threadsOf) {
    const hs = lineHunks(a, b).map((h) => ({ ...h, id: `${path}#${h.id}` }));
    return sourceDiff(a, b, { context, hunks: hs }).hunks.map((h) => ({ ...h, threads: threadsOf(h) }));
  }

  /** GET D/files/diff. @param {{ path: string, v?: number, from?: number, to?: number, context?: number }} q */
  fileDiff(q) {
    const context = q.context ?? 3;
    if (q.from != null || q.to != null) {
      const from = Number(q.from);
      const to = Number(q.to);
      const a = this.round(from).files.find((f) => f.path === q.path);
      const b = this.round(to).files.find((f) => f.path === q.path);
      if (!a && !b) throw httpError(404, `${q.path} is not in v${from} or v${to}`, 'NOT_FOUND');
      const f = /** @type {RoundFile} */ (b || a);
      const base = { path: q.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), from, to };
      if (f.binary) return { ...base, stub: 'binary', hunks: [] };
      if (f.tooLarge) return { ...base, stub: 'too-large', hunks: [] };
      const links = this.round(to).manifest.hunks;
      return {
        ...base,
        hunks: this.displayHunks(q.path, a ? this.sideText(a, 'new') : '', b ? this.sideText(b, 'new') : '', context,
          (h) => [...new Set(h.hunkIds.flatMap((/** @type {string} */ id) => links.find((/** @type {any} */ x) => x.id === id)?.threads || []))]),
      };
    }
    const v = Number(q.v ?? this.head);
    const f = this.file(v, q.path);
    const base = { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), v };
    if (f.binary) return { ...base, stub: 'binary', hunks: [] };
    if (f.tooLarge) return { ...base, stub: 'too-large', hunks: [] };
    const threads = this.threads.map((t) => ({ t, a: anchorAt(t, v) })).filter(({ t, a }) => a?.file?.path === f.path && a.kind !== 'doc' && t.createdIn <= v);
    return {
      ...base,
      hunks: this.displayHunks(f.path, this.sideText(f, 'old'), this.sideText(f, 'new'), context, (h) => threads.filter(({ a }) => {
        const key = a.file.side === 'old' ? 'oldNo' : 'newNo';
        return h.rows.some((/** @type {any} */ r) => r[key] != null && r[key] >= a.src.startLine && r[key] <= a.src.endLine);
      }).map(({ t }) => t.id)),
    };
  }

  /** GET D/files/source. @param {{ path: string, v: number, side: 'new'|'old' }} q */
  fileSource(q) {
    const f = this.file(Number(q.v), q.path);
    if (f.binary || f.tooLarge) throw httpError(422, `${f.path} is ${f.binary ? 'binary' : 'too large'}: no text`);
    if (q.side === 'new' && f.status === 'D') throw httpError(422, `${f.path} was deleted: it has no new side`);
    if (q.side === 'old' && f.status === 'A') throw httpError(422, `${f.path} is a new file: it has no old side`);
    const text = this.sideText(f, q.side);
    return { path: f.path, side: q.side, v: Number(q.v), text, lines: linesOf(text).length };
  }

  // ------------------------------------------------------------------------------------------ diffs (ChangeSet-compatible)

  /** GET D/diff of a code doc: the interdiff of two rounds as a ChangeSet. @param {number} from @param {number|'live'} to */
  changes(from, to) {
    const toN = to === 'live' ? this.head : Number(to);
    const A = this.round(from);
    const B = this.round(toN);
    const links = toN === from + 1 ? B.manifest.hunks : [];
    /** @type {any[]} */
    const hunks = [];
    let added = 0;
    let removed = 0;
    for (const path of new Set([...A.files.map((f) => f.path), ...B.files.map((f) => f.path)].sort())) {
      const a = A.files.find((f) => f.path === path);
      const b = B.files.find((f) => f.path === path);
      for (const h of lineHunks(a ? this.sideText(a, 'new') : '', b ? this.sideText(b, 'new') : '')) {
        const id = `${path}#${h.id}`;
        const m = links.find((/** @type {any} */ x) => x.id === id);
        added += h.newLines;
        removed += h.oldLines;
        hunks.push({
          id, file: path, op: h.oldLines === 0 ? 'add' : h.newLines === 0 ? 'del' : 'mod',
          old: { start: h.oldStart, lines: h.oldLines }, new: { start: h.newStart, lines: h.newLines },
          srids: [], words: [], deleted: null, insertBefore: null, insertAfter: null, section: [],
          threads: m?.threads || [], linkedBy: m ? m.linkedBy : null, other: m?.other ?? null,
        });
      }
    }
    /** @type {Record<string, string[]>} */
    const threadLinks = {};
    for (const h of hunks) for (const t of h.threads) (threadLinks[t] ||= []).push(h.id);
    return {
      from, to, stats: { added, removed, hunks: hunks.length, blocksChanged: 0 }, hunks, assets: [], threadLinks,
      guards: toN === from + 1 ? B.manifest.guards : { forced: false, brokenLocks: [] },
    };
  }

  /** GET D/diff/source of a code doc: the diff of the canonical diff texts (unused by the code UI). @param {number} from @param {number|'live'} to */
  sourceDiff(from, to) {
    return sourceDiff(this.source(from), this.source(to));
  }

  /** GET D/threads/:tid/minidiff: the anchored lines at creation and at head ({kind:'text', ...}). @param {string} tid */
  miniDiff(tid) {
    const t = this.thread(tid);
    const a0 = t.anchors[String(t.createdIn)];
    const a1 = anchorAt(t, this.head) || a0;
    /** @param {any} a @param {number} v */
    const text = (a, v) => {
      if (!a || a.kind === 'doc' || a.state === 'orphaned' || !a.file) return '';
      const f = this.round(v).files.find((x) => x.path === a.file.path);
      return f ? linesOf(this.sideText(f, a.file.side)).slice(a.src.startLine - 1, a.src.endLine).join('\n') : '';
    };
    const before = text(a0, t.createdIn);
    const after = text(a1, this.head);
    return { kind: 'text', version: this.head, from: t.createdIn, before, after, words: wordDiff(before, after), state: a1?.state ?? null };
  }

  // ------------------------------------------------------------------------------------------ reviewer operations

  /** @param {any} anchor @param {any} input */
  suggestionFor(anchor, input) {
    if (!anchor?.file || anchor.kind === 'doc' || anchor.file.side !== 'new') {
      throw httpError(422, 'a suggestion replaces lines of the new side; select lines on the right-hand side', 'USAGE');
    }
    if (!input || typeof input.new !== 'string') throw httpError(422, 'a suggestion draft needs suggestion.new');
    const f = this.file(anchor.v, anchor.file.path);
    const old = linesOf(this.sideText(f, 'new')).slice(anchor.src.startLine - 1, anchor.src.endLine).join('\n');
    return {
      mode: 'lines', file: anchor.file.path, version: anchor.v, start: 0, end: 0, startLine: anchor.src.startLine,
      endLine: anchor.src.endLine, old, new: input.new, status: 'pending', appliedIn: null,
    };
  }

  /** @param {any} item */
  saveDraft(item) {
    if (!item || !['thread', 'reply', 'resolve'].includes(item.kind)) throw httpError(422, 'kind must be thread, reply or resolve');
    const draft = { ...item, id: this.nextId('draft'), updatedAt: this.clock() };
    if (draft.kind === 'thread') {
      if (!draft.anchor && draft.capture) draft.anchor = this.resolveCapture(Number(draft.version || this.head), draft.capture);
      if (!draft.anchor) throw httpError(422, 'anchor or capture is required');
      draft.version = Number(draft.version || draft.anchor.v || this.head);
      draft.attachments = draft.attachments || [];
      draft.type = draft.type || (draft.suggestion ? 'suggestion' : 'comment');
      draft.suggestion = draft.type === 'suggestion' ? this.suggestionFor(draft.anchor, draft.suggestion) : null;
      draft.severity = draft.severity || 'normal';
    } else {
      this.thread(draft.thread);
    }
    this.drafts.items.push(draft);
    this.emit('drafts.changed', { draft: draft.id });
    return draft;
  }

  /** @param {string} id @param {any} patch */
  patchDraft(id, patch) {
    const i = this.drafts.items.findIndex((d) => d.id === id);
    if (i < 0) throw httpError(404, `draft ${id} not found`);
    const { id: _i, kind: _k, ...rest } = patch || {};
    const next = { ...this.drafts.items[i], ...rest, updatedAt: this.clock() };
    if (next.kind === 'thread' && next.type === 'suggestion' && rest.suggestion) next.suggestion = this.suggestionFor(next.anchor, rest.suggestion);
    this.drafts.items[i] = next;
    this.emit('drafts.changed', { draft: id });
    return next;
  }

  /** @param {string} id */
  deleteDraft(id) {
    const before = this.drafts.items.length;
    this.drafts.items = this.drafts.items.filter((d) => d.id !== id);
    if (before === this.drafts.items.length) throw httpError(404, `draft ${id} not found`);
    this.emit('drafts.changed', { draft: id });
    return { ok: true, deleted: id };
  }

  /**
   * @param {{ verdict: string, body?: string, markFinal?: boolean, resolveAddressed?: boolean, draftIds?: string[],
   *   reviewedVersion?: number, expectHead?: number }} p
   */
  submitReview(p) {
    if (!['comment', 'changes_requested', 'approved'].includes(p.verdict)) throw httpError(422, 'bad verdict');
    const seen = p.expectHead ?? p.reviewedVersion;
    if (p.verdict === 'approved' && seen != null && seen !== this.head) {
      throw httpError(409, `v${this.head} of ${this.id} was recorded after you opened v${seen}; review it before approving`, 'CONFLICT');
    }
    const picked = p.draftIds ? this.drafts.items.filter((d) => p.draftIds?.includes(d.id)) : [...this.drafts.items];
    const id = this.nextId('review');
    const at = this.clock();
    const by = { kind: 'human', name: this.reviewer };
    const review = {
      schema: 1, id, version: this.head, by, verdict: p.verdict, body: p.body || '', markFinal: !!p.markFinal,
      newThreads: /** @type {string[]} */ ([]), replies: /** @type {any[]} */ ([]), reopened: /** @type {string[]} */ ([]),
      resolved: /** @type {string[]} */ ([]), locksAdded: [], submittedAt: at, deliveredTo: {}, ackedBy: {},
    };
    for (const d of picked) {
      if (d.kind === 'thread') {
        const tid = this.nextId('thread');
        const v = Number(d.version || d.anchor.v || this.head);
        const t = {
          schema: 1, id: tid, doc: this.id, type: d.type, severity: d.severity, status: 'open', createdIn: v, createdBy: by, review: id,
          anchors: { [String(v)]: d.anchor }, override: null,
          suggestion: d.suggestion ? { ...d.suggestion, status: 'pending', appliedIn: null } : null,
          comments: [{ id: this.nextId('comment'), by, body: d.body || '', at, review: id, version: v }],
          changes: [], attachments: d.attachments || [], decision: null, resolvedIn: null, updatedAt: at,
        };
        for (let k = v + 1; k <= this.head; k++) this.carry(t, k - 1, k);
        this.threads.push(t);
        review.newThreads.push(tid);
      } else if (d.kind === 'reply') {
        const t = this.thread(d.thread);
        const cid = this.nextId('comment');
        t.comments.push({ id: cid, by, body: d.body, at, review: id, version: this.head });
        if (d.reopen) {
          t.status = 'open';
          t.resolvedIn = null;
          review.reopened.push(t.id);
        }
        t.updatedAt = at;
        review.replies.push({ thread: t.id, comment: cid });
      } else if (d.kind === 'resolve') {
        this.resolve(d.thread, d.decision);
        review.resolved.push(d.thread);
      }
    }
    if (p.verdict === 'approved') {
      if (p.resolveAddressed) {
        for (const t of this.threads) {
          if (t.status === 'addressed' || t.status === 'answered') {
            t.status = 'resolved';
            t.resolvedIn = this.head;
            review.resolved.push(t.id);
          }
        }
      }
      if (p.markFinal) {
        this.doc.state = 'approved';
        this.doc.final = { version: this.head, review: id, at, by: this.reviewer };
      }
    }
    this.drafts.items = this.drafts.items.filter((d) => !picked.includes(d));
    this.reviews.push(review);
    this.doc.lastReviewedVersion = this.head;
    this.emit('review.submitted', { review: id, verdict: p.verdict });
    if (p.verdict === 'approved' && p.markFinal) this.emit('doc.approved', { v: this.head });
    return review;
  }

  /** @param {string} reviewId @param {string} [agent] */
  deliver(reviewId, agent = 'claude') {
    const r = this.reviews.find((x) => x.id === reviewId);
    if (!r) return;
    r.deliveredTo = { ...r.deliveredTo, [agent]: this.clock() };
    this.waiters = this.waiters.filter((w) => w.agent !== agent);
    this.emit('review.delivered', { review: reviewId, agent, at: r.deliveredTo[agent] });
    this.emit('presence', { waiters: this.waiters }, { volatile: true });
  }

  /** @param {string} tid @param {string} [decision] */
  resolve(tid, decision) {
    const t = this.thread(tid);
    t.status = 'resolved';
    t.resolvedIn = this.head;
    t.updatedAt = this.clock();
    if (decision) t.decision = { id: this.nextId('decision'), text: decision, version: this.head, srcText: anchorAt(t, this.head)?.src?.text || '', at: this.clock() };
    this.emit('thread.updated', { thread: tid });
    return t;
  }

  /** @param {string} tid */
  unresolve(tid) {
    const t = this.thread(tid);
    t.status = 'open';
    t.resolvedIn = null;
    t.updatedAt = this.clock();
    this.emit('thread.updated', { thread: tid });
    return t;
  }

  /** @param {string} tid @param {{ version: number, capture: any }} p */
  move(tid, p) {
    const t = this.thread(tid);
    const a = { ...this.resolveCapture(Number(p.version || this.head), p.capture), mappedBy: 'override' };
    t.anchors[String(a.v)] = a;
    t.override = { version: a.v, lines: a.kind === 'doc' ? null : [a.src.startLine, a.src.endLine], file: a.file?.path ?? null, by: 'human' };
    t.updatedAt = this.clock();
    this.emit('thread.updated', { thread: tid });
    return t;
  }

  /** Reviewer "Apply now": writes the lines into the file and records a 'ui-apply' round. @param {string} tid */
  applySuggestion(tid) {
    const t = this.thread(tid);
    const s = t.suggestion;
    if (!s) throw httpError(422, 'not a suggestion');
    if (s.status === 'applied') throw httpError(409, `${tid} was already applied in v${s.appliedIn}`, 'REFUSED');
    if (this.working.dirty) throw httpError(409, 'the working tree has changes that are not in a round; Re-snapshot first', 'CONFLICT');
    const a = anchorAt(t, this.head);
    const f = this.file(this.head, s.file);
    const lines = linesOf(this.sideText(f, 'new'));
    const now = lines.slice(a.src.startLine - 1, a.src.endLine).join('\n');
    if (now !== s.old) {
      s.status = 'conflict';
      throw httpError(409, `conflict ${tid}: ${s.file} changed at L${a.src.startLine}-${a.src.endLine}`, 'REFUSED');
    }
    lines.splice(a.src.startLine - 1, a.src.endLine - a.src.startLine + 1, ...linesOf(`${s.new}\n`));
    const m = this.addRound(this.filesWith({ [s.file]: `${lines.join('\n')}\n` }), {
      author: { kind: 'human', name: this.reviewer }, summary: `Applied suggestion ${tid}`, capturedBy: 'ui-apply',
    });
    s.status = 'applied';
    s.appliedIn = m.v;
    t.status = 'resolved';
    t.resolvedIn = m.v;
    this.emit('version.created', { v: m.v, author: `human:${this.reviewer}`, summary: m.summary });
    return m;
  }

  addLock() {
    throw httpError(409, 'code reviews have no locks', 'REFUSED');
  }

  removeLock() {
    throw httpError(409, 'code reviews have no locks', 'REFUSED');
  }

  relock() {
    throw httpError(409, 'code reviews have no locks', 'REFUSED');
  }

  /** POST D/record (Re-snapshot): records the pending working-tree round. @param {string} summary */
  recordWorking(summary) {
    if (!this.working.dirty || !this.working.pending) throw httpError(409, 'nothing to record: the working tree matches the last round', 'CONFLICT');
    const m = this.addRound(this.working.pending, { author: { kind: 'human', name: this.reviewer }, summary, capturedBy: 'ui-record' });
    this.emit('version.created', { v: m.v, author: `human:${this.reviewer}`, summary });
    return m;
  }

  /** @param {string} dataUrl */
  saveAttachment(dataUrl) {
    if (!/^data:image\/(png|jpeg);base64,/.test(String(dataUrl))) throw httpError(422, 'PNG or JPEG data URL required');
    const id = this.nextId('attachment');
    const path = `attachments/${id}.${dataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png'}`;
    this.attachments.set(path, dataUrl);
    return { path };
  }

  /** @param {string} source */
  fragment(source) {
    return { html: renderFragmentSync({ format: 'markdown', source }) };
  }

  // ------------------------------------------------------------------------------------------ test controls

  /** @param {Array<{ agent: string, since?: string, pid?: number }>} waiters */
  setWaiters(waiters) {
    this.waiters = waiters.map((w) => ({ since: this.clock(), pid: 4242, ...w }));
    this.emit('presence', { waiters: this.waiters }, { volatile: true });
  }

  /**
   * The working tree as the daemon's poller sees it: `edits` (path -> new text, null drops the file) make it dirty
   * with a pending round (POST D/record records it); null makes it clean again. Emits working.changed.
   * @param {Record<string, string|null>|null} edits
   */
  setWorking(edits) {
    if (!edits || !Object.keys(edits).length) {
      this.working = { dirty: false, sha256: this.round(this.head).manifest.sha256, changedFiles: [], pending: null };
    } else {
      const pending = this.filesWith(edits);
      this.working = { dirty: true, sha256: sha(JSON.stringify(pending)), changedFiles: Object.keys(edits).sort(), pending };
    }
    this.emit('working.changed', { dirty: this.working.dirty, missing: false, sha256: this.working.sha256, changedFiles: this.working.changedFiles }, { volatile: true });
  }
}

/** The anchor of an item at version v (the newest one at or before v). @param {any} item @param {number} v */
function anchorAt(item, v) {
  if (item.anchors[String(v)]) return item.anchors[String(v)];
  const keys = Object.keys(item.anchors).map(Number).filter((k) => k <= v).sort((x, y) => x - y);
  return keys.length ? item.anchors[String(keys[keys.length - 1])] : null;
}

// ------------------------------------------------------------------------------------------ the 'code' scenario

/** Lines 1..n of `export const fN = () => N;` (unchanged filler between the hunks of src/a.js). @param {number} from @param {number} n */
const filler = (from, n) => Array.from({ length: n }, (_, i) => `export const f${from + i} = () => ${from + i};`).join('\n');

export const A_BASE = `// a.js: cart totals
import { round } from './util/strings.js';

/** Sum of price x quantity. */
export function total(items) {
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  return round(sum);
}

/** Tax on an amount. */
export function tax(amount, rate) {
  if (rate < 0) throw new RangeError('negative rate');
  return round(amount * rate);
}

${filler(1, 18)}

export function shipping(weight) {
  return weight > 10 ? 15 : 5;
}
`;

/** Round 1 of src/a.js: a discount, the tax guard removed, new shipping prices. */
export const A_V1 = A_BASE
  .replace('export function total(items) {\n  let sum = 0;', 'export function total(items, discount = 0) {\n  let sum = -discount;')
  .replace("  if (rate < 0) throw new RangeError('negative rate');\n", '')
  .replace('  return weight > 10 ? 15 : 5;', '  if (weight === 0) return 0;\n  return weight > 10 ? 20 : 5;');

/** Round 2 of src/a.js: the discount is clamped (answers t1). */
export const A_V2 = A_V1.replace('  let sum = -discount;', '  let sum = -Math.max(0, Math.min(discount, 100));');

export const STRINGS_V1 = `// strings.js: number formatting
export function round(n) {
  return Math.round(n * 100) / 100;
}

export function money(n) {
  return \`$\${round(n).toFixed(2)}\`;
}
`;

export const B_V2 = `// b.js: checkout
import { total, tax } from './a.js';

export function checkout(items, rate) {
  if (rate < 0) throw new RangeError('negative rate');
  const t = total(items);
  return t + tax(t, rate);
}
`;

const OLD_NAME = `// helpers: misc
export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
export const VERSION = 1;
`;

const NOTES = `# Notes

These notes moved to the wiki.
See docs/README.md.
`;

/** vendor/generated.js: a generated table long enough for the 3000-row cap ("Show all"). */
export const GENERATED_LINES = 3200;
const GENERATED = `${Array.from({ length: GENERATED_LINES }, (_, i) => `export const row${i + 1} = ${i + 1};`).join('\n')}\n`;

/**
 * The 'code' scenario: code review 'cr-feat' (feat vs main) after one round of review.
 *   v1 (agent, open): src/a.js M (two hunks, 16 unchanged lines between), src/new-name.js R (from src/old-name.js),
 *      src/util/strings.js A, docs/old-notes.md D, assets/logo.png A binary, data/fixtures.json M too large,
 *      vendor/generated.js A (3200 lines); skipped: .env.local (excluded).
 *   rv1 (changes requested, delivered to claude) created:
 *      t1 blocking comment on src/a.js new side, the two discount lines   -> addressed in v2 (linked hunk)
 *      t2 question on src/a.js OLD side, the removed tax guard            -> answered in v2
 *      t3 suggestion on src/util/strings.js L3                            -> open
 *      t4 comment on assets/logo.png (whole file)                         -> open
 *      t5 general comment (whole review)                                  -> open
 *   v2 (agent round answering rv1): src/a.js clamps the discount, src/b.js added.
 * @param {{ clock?: () => string }} [opts]
 */
export function buildCodeScenario(opts = {}) {
  const doc = new MockCodeDoc({
    ws: WS,
    id: 'cr-feat',
    title: 'feat vs main',
    clock: opts.clock,
    skipped: [{ path: '.env.local', reason: 'excluded' }],
    files: [
      { path: 'src/a.js', status: 'M', oldText: A_BASE, newText: A_V1 },
      { path: 'src/new-name.js', oldPath: 'src/old-name.js', status: 'R', oldText: OLD_NAME, newText: OLD_NAME.replace('VERSION = 1', 'VERSION = 2') },
      { path: 'src/util/strings.js', status: 'A', newText: STRINGS_V1 },
      { path: 'docs/old-notes.md', status: 'D', oldText: NOTES },
      { path: 'assets/logo.png', status: 'A', binary: true, newText: '' },
      { path: 'data/fixtures.json', status: 'M', tooLarge: { side: 'new', bytes: 6 * 1024 * 1024 }, oldText: '{}', newText: '{}' },
      { path: 'vendor/generated.js', status: 'A', newText: GENERATED },
    ],
  });
  const a1 = linesOf(A_V1);
  const discount = a1.findIndex((l) => l.includes('total(items, discount')) + 1;
  const guard = linesOf(A_BASE).findIndex((l) => l.includes("rate < 0")) + 1;
  /** @type {Array<[any, string, string, string, any?]>} capture, type, severity, body, suggestion */
  const items = [
    [{ kind: 'line', file: 'src/a.js', side: 'new', startLine: discount, endLine: discount + 1 }, 'comment', 'blocking', 'Clamp the discount so the total can never go negative.'],
    [{ kind: 'line', file: 'src/a.js', side: 'old', startLine: guard, endLine: guard }, 'question', 'normal', 'Why remove the negative-rate guard?'],
    [{ kind: 'line', file: 'src/util/strings.js', side: 'new', startLine: 3, endLine: 3 }, 'suggestion', 'nit', 'Avoid the 1.005 rounding bug.',
      { new: '  return Math.round((n + Number.EPSILON) * 100) / 100;' }],
    [{ kind: 'file', file: 'assets/logo.png' }, 'comment', 'normal', 'Is this the final logo?'],
    [{ kind: 'doc' }, 'comment', 'normal', 'Please add tests for the discount.'],
  ];
  for (const [capture, type, severity, body, suggestion] of items) {
    doc.saveDraft({ kind: 'thread', type, severity, capture, body, version: 1, ...(suggestion ? { suggestion } : {}) });
  }
  const rv1 = doc.submitReview({ verdict: 'changes_requested', body: 'A few things before this merges.' });
  doc.deliver(rv1.id, 'claude');
  doc.revise({
    files: doc.filesWith({ 'src/a.js': A_V2, 'src/b.js': B_V2 }),
    summary: 'rv1: clamp the discount, guard moved to checkout',
    replies: {
      t1: { status: 'addressed', reply: 'The discount is now clamped to **0..100**.' },
      t2: { status: 'answered', reply: 'The guard moved to `checkout()` in src/b.js, which validates the rate once.' },
    },
    hunkLinks: { 'src/a.js#h1': { threads: ['t1'] }, 'src/b.js#h1': { other: 'New checkout entry point' } },
  });
  return [doc];
}
