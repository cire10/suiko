// @ts-check
// In-memory stand-in for the review engine (WP3) behind the e2e mock server. It implements the daemon API shapes
// (design 10.2 + amendments 3/4/6) with realistic data. Rendering, text search and diffs use the real WP2 modules
// (renderSourceSync, findQuote, lineHunks, changeSet, sourceDiff), so srids, outlines, Changes and SourceDiff
// payloads look exactly like the real daemon's. Anchoring and re-anchoring are deliberately simple (good enough
// for UI tests); they are not the WP3 algorithms.
//
// Every state change appends an event (seq, at, type, ...) and notifies subscribers, which is how the mock SSE
// endpoint streams `version.created`, `review.submitted`, `drafts.changed`, ...

import { createHash } from 'node:crypto';
import { deepestBlockAt, elementText, renderFragmentSync, renderSourceSync, sectionAt } from '../../src/core/render/index.js';
import { changeSet, lineHunks, sourceDiff, wordDiff } from '../../src/core/diff/index.js';
import { findQuote, lineIndex, linesOfRange } from '../../src/core/text/index.js';

const CTX = 32;

/** @param {string} s */
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** @param {string} s @param {number} n */
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * One tracked doc with versions, threads, reviews, locks and drafts.
 */
export class MockDoc {
  /**
   * @param {{ ws: string, id: string, path: string, format: 'markdown'|'html', title?: string, source: string,
   *   reviewer?: string, clock?: () => string }} opts
   */
  constructor(opts) {
    this.ws = opts.ws;
    this.id = opts.id;
    this.format = opts.format;
    this.reviewer = opts.reviewer || 'Eric';
    this.clock = opts.clock || (() => new Date().toISOString());
    /** @type {Array<{ v: number, source: string, manifest: any, render?: any }>} */
    this.versions = [];
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
    /** @type {{ dirty: boolean, sha256: string, source: string|null }} */
    this.working = { dirty: false, sha256: '', source: null };
    /** @type {Record<string, Record<string, string>>} version -> asset path -> 'sha256:...' */
    this.assetHashes = {};
    /** @type {any[]} */
    this.events = [];
    this.seq = 0;
    /** @type {Set<(ev: any, doc: MockDoc) => void>} */
    this.listeners = new Set();
    this.counters = { thread: 0, comment: 0, review: 0, lock: 0, decision: 0, draft: 0, attachment: 0 };
    /** @type {Map<string, string>} attachment path -> data URL */
    this.attachments = new Map();
    /** Set by the server: `http://127.0.0.1:<cport>/c/<docKey>` (used for asset URLs). */
    this.contentBase = '';
    /** @type {Map<string, Buffer>} 'sha256:<hex>' -> bytes of assets that differ from the fixture files */
    this.assetBlobs = new Map();
    this.doc = {
      schema: 1,
      id: opts.id,
      path: opts.path,
      format: opts.format,
      title: opts.title || opts.id,
      createdAt: this.clock(),
      createdBy: { kind: 'agent', name: 'claude' },
      state: 'in_review',
      head: 0,
      lastReviewedVersion: null,
      final: null,
      counters: this.counters,
    };
    this.addVersion(opts.source, { author: { kind: 'agent', name: 'claude' }, summary: 'Initial version', capturedBy: 'open' }, false);
    this.doc.title = opts.title || this.render(1).title || opts.id;
  }

  // ------------------------------------------------------------------------------------------ basics

  get head() {
    return this.doc.head;
  }

  /** @param {number|'live'} v */
  source(v) {
    if (v === 'live') return this.working.source ?? this.versions[this.head - 1].source;
    const rec = this.versions[Number(v) - 1];
    if (!rec) throw httpError(404, `version ${v} not found`);
    return rec.source;
  }

  /** @param {number|'live'} v */
  render(v) {
    if (v === 'live') {
      const src = this.source('live');
      if (!this.liveRender || this.liveRender.src !== src) {
        this.liveRender = { src, render: renderSourceSync({ format: this.format, source: src, docPath: this.doc.path }) };
      }
      return this.liveRender.render;
    }
    const rec = this.versions[Number(v) - 1];
    if (!rec) throw httpError(404, `version ${v} not found`);
    if (!rec.render) rec.render = renderSourceSync({ format: this.format, source: rec.source, docPath: this.doc.path });
    return rec.render;
  }

  /** @param {'thread'|'comment'|'review'|'lock'|'decision'|'draft'|'attachment'} kind */
  nextId(kind) {
    const prefix = { thread: 't', comment: 'c', review: 'rv', lock: 'L', decision: 'D', draft: 'd', attachment: 'a' }[kind];
    this.counters[kind] += 1;
    return `${prefix}${this.counters[kind]}`;
  }

  /**
   * Appends an event and notifies the SSE subscribers.
   * @param {string} type
   * @param {Record<string, any>} [payload]
   * @param {{ volatile?: boolean }} [opts] volatile events (presence, working.changed) carry no seq
   */
  emit(type, payload = {}, opts = {}) {
    const ev = opts.volatile ? { at: this.clock(), type, ...payload } : { seq: ++this.seq, at: this.clock(), type, ...payload };
    if (!opts.volatile) this.events.push(ev);
    for (const fn of this.listeners) fn(ev, this);
    return ev;
  }

  // ------------------------------------------------------------------------------------------ versions

  /**
   * @param {string} source
   * @param {{ author: any, summary: string, capturedBy: string, respondsTo?: string|null, hunkLinks?: Record<string, { threads?: string[], other?: string|null }>, assets?: Record<string, string> }} meta
   * @param {boolean} [notify]
   */
  addVersion(source, meta, notify = true) {
    const v = this.versions.length + 1;
    const prev = v > 1 ? this.versions[v - 2].source : null;
    const hunks = prev == null ? [] : lineHunks(prev, source);
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      added += h.newLines;
      removed += h.oldLines;
    }
    const manifest = {
      schema: 1,
      v,
      parent: v > 1 ? v - 1 : null,
      file: `${String(v).padStart(4, '0')}.${this.format === 'html' ? 'html' : 'md'}`,
      sha256: sha(source),
      bytes: Buffer.byteLength(source),
      lines: lineIndex(source).count,
      createdAt: this.clock(),
      author: meta.author,
      summary: meta.summary,
      respondsTo: meta.respondsTo ?? null,
      capturedBy: meta.capturedBy,
      assets: { ...(this.assetHashes[v - 1] || {}), ...(meta.assets || {}) },
      stats: { added, removed, hunks: hunks.length, rewriteRatio: prev ? Math.min(1, removed / Math.max(1, lineIndex(prev).count)) : 0 },
      hunks: hunks.map((h) => ({
        id: h.id, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines,
        threads: meta.hunkLinks?.[h.id]?.threads || [],
        linkedBy: meta.hunkLinks?.[h.id]?.threads?.length ? 'overlap' : null,
        other: meta.hunkLinks?.[h.id]?.other ?? null,
      })),
      guards: { errors: [], warnings: [], forced: false, brokenLocks: [] },
      git: { commit: null },
    };
    this.assetHashes[v] = manifest.assets;
    this.versions.push({ v, source, manifest });
    this.doc.head = v;
    this.working = { dirty: false, sha256: manifest.sha256, source: null };
    if (notify) {
      for (const t of this.threads) this.reanchorItem(t, v - 1, v);
      for (const l of this.locks) this.reanchorItem(l, v - 1, v);
    }
    return manifest;
  }

  /**
   * The agent's revision: records a version, posts replies, re-anchors, emits version.created.
   * @param {{ source: string, summary: string, replies?: Record<string, { status: string, reply: string }>,
   *   hunkLinks?: Record<string, { threads?: string[], other?: string|null }>, assets?: Record<string, string>, agent?: string }} p
   */
  revise(p) {
    const agent = p.agent || 'claude';
    const last = this.latestReview();
    const manifest = this.addVersion(p.source, {
      author: { kind: 'agent', name: agent },
      summary: p.summary,
      capturedBy: 'revise',
      respondsTo: last ? last.id : null,
      hunkLinks: p.hunkLinks,
      assets: p.assets,
    });
    const v = manifest.v;
    // Element anchors on an image whose bytes changed (amendments 4.5).
    for (const t of this.threads) {
      const a = t.anchors[String(v)];
      const path = String(a?.element?.attrs?.src || '').replace(/^\.\//, '');
      if (path && this.assetHashes[v - 1]?.[path] !== this.assetHashes[v]?.[path]) a.assetChanged = true;
    }
    let addressed = 0;
    let needs = 0;
    for (const [tid, r] of Object.entries(p.replies || {})) {
      const t = this.thread(tid);
      t.comments.push({ id: this.nextId('comment'), by: { kind: 'agent', name: agent }, body: r.reply, at: this.clock(), version: v, status: r.status });
      t.status = r.status;
      t.updatedAt = this.clock();
      if (r.status === 'addressed' || r.status === 'answered' || r.status === 'declined') addressed++;
      if (r.status === 'needs_input') needs++;
    }
    for (const h of manifest.hunks) {
      for (const tid of h.threads) {
        const t = this.threads.find((x) => x.id === tid);
        if (t) t.changes.push({ version: v, hunk: h.id, linkedBy: 'overlap' });
      }
    }
    if (last) last.ackedBy = { ...(last.ackedBy || {}), [agent]: this.clock() };
    if (this.doc.state === 'approved') this.doc.state = 'in_review';
    this.emit('version.created', { v, author: `agent:${agent}`, summary: p.summary, respondsTo: last?.id ?? null, counts: { addressed, needs_input: needs } });
    return manifest;
  }

  latestReview() {
    return this.reviews.length ? this.reviews[this.reviews.length - 1] : null;
  }

  // ------------------------------------------------------------------------------------------ anchors

  /**
   * Builds an anchor for the source range [start, end) of version v.
   * @param {number} v
   * @param {number} start
   * @param {number} end
   * @param {Record<string, any>} extra
   */
  anchorAt(v, start, end, extra) {
    const src = this.source(v);
    const li = lineIndex(src);
    const { startLine, endLine } = linesOfRange(li, start, end);
    const render = this.render(v);
    return {
      v,
      kind: 'text',
      state: 'exact',
      mappedBy: 'textmap',
      src: {
        start, end, startLine, endLine, text: src.slice(start, end),
        prefix: src.slice(Math.max(0, start - CTX), start), suffix: src.slice(end, end + CTX),
      },
      quote: null,
      srid: deepestBlockAt(render, start, end),
      endSrid: null,
      section: sectionAt(render, start),
      generated: false,
      element: null,
      region: null,
      svg: null,
      cell: null,
      code: null,
      media: null,
      ...extra,
    };
  }

  /**
   * Resolves a guest capture (amendments 3.3) against version v.
   * @param {number} v
   * @param {any} cap
   * @param {{ widen?: boolean }} [opts]
   */
  resolveCapture(v, cap, opts = {}) {
    if (!cap || typeof cap !== 'object') throw httpError(422, 'capture is required');
    if (v > this.head || v < 1) throw httpError(404, `version ${v} not found`);
    const src = this.source(v);
    const render = this.render(v);
    const nodes = render.srcmap.nodes;
    switch (cap.kind) {
      case 'doc':
        return { ...this.anchorAt(v, 0, 0, { kind: 'doc', mappedBy: 'block' }), section: [], srid: null };
      case 'source': {
        const li = lineIndex(src);
        const s = li.startOf(Number(cap.startLine));
        const e = li.endOf(Number(cap.endLine ?? cap.startLine));
        return this.anchorAt(v, s, e, { kind: 'source', mappedBy: 'lines' });
      }
      case 'section': {
        const h = nodes[cap.headingSrid];
        if (!h) throw httpError(422, 'unknown heading');
        const level = Number(h.t.slice(1)) || 1;
        let end = src.length;
        for (const o of render.outline) {
          const n = nodes[o.srid];
          if (n.s > h.s && o.level <= level) {
            end = n.s;
            break;
          }
        }
        return this.anchorAt(v, h.s, end, { kind: 'section', mappedBy: 'element', ...sectionSrids(render, h.s, end) });
      }
      case 'element': {
        const n = nodes[cap.srid];
        if (!n) throw httpError(422, `unknown srid ${cap.srid}`);
        const label = cap.label || `<${n.t}>`;
        return this.anchorAt(v, n.s, n.e, {
          kind: cap.cell ? 'cell' : 'element',
          mappedBy: 'element',
          srid: cap.srid,
          // text: the element's text sample, like the real fingerprint (cards quote it).
          element: { srid: cap.srid, tag: n.t, attrs: n.a || {}, label, ordinal: 0, text: clip(elementText(render, cap.srid) || '', 200) },
          region: cap.region || null,
          svg: cap.svg || null,
          cell: cap.cell || null,
          scope: cap.scope,
          generated: !!cap.svg,
        });
      }
      case 'text': {
        const sNode = nodes[cap.startSrid];
        const eNode = nodes[cap.endSrid ?? cap.startSrid];
        /** @type {[number, number]} */
        const range = sNode && eNode ? [Math.min(sNode.s, eNode.s), Math.max(sNode.e, eNode.e)] : [0, src.length];
        const q = { prefix: cap.prefix || '', suffix: cap.suffix || '', markupTolerant: true, format: this.format };
        let hits = findQuote(src, String(cap.exact || ''), { ...q, range });
        let mappedBy = 'textmap';
        if (!hits.length) {
          hits = findQuote(src, String(cap.exact || ''), q);
          mappedBy = 'raw-source';
        }
        let start;
        let end;
        if (hits.length) {
          ({ start, end } = hits[0]);
          if (hits[0].mode === 'markup' && mappedBy === 'textmap') mappedBy = 'narrowed';
        } else {
          [start, end] = range;
          mappedBy = 'block';
        }
        if (opts.widen) {
          const block = deepestBlockAt(render, start, end);
          if (block != null) {
            ({ s: start, e: end } = nodes[block]);
            mappedBy = 'block';
          }
        }
        const widened = !!opts.widen;
        const exact = widened ? elementText(render, deepestBlockAt(render, start, end) ?? 0) || cap.exact : cap.exact;
        return this.anchorAt(v, start, end, {
          kind: 'text',
          mappedBy,
          generated: mappedBy === 'block' || mappedBy === 'raw-source',
          quote: { exact: String(exact || ''), prefix: widened ? '' : String(cap.prefix || ''), suffix: widened ? '' : String(cap.suffix || '') },
          srid: cap.startSrid ?? deepestBlockAt(render, start, end),
          endSrid: cap.endSrid && cap.endSrid !== cap.startSrid ? cap.endSrid : null,
        });
      }
      default:
        throw httpError(422, `unknown capture kind ${cap.kind}`);
    }
  }

  /** @param {any} a */
  label(a) {
    if (!a) return '';
    if (a.kind === 'doc') return 'whole document';
    if (a.kind === 'section') return `section "${a.section[a.section.length - 1] || ''}"`;
    if (a.kind === 'source') return `source lines`;
    if (a.svg) return `mermaid node "${a.svg.label || a.svg.nodeId}"`;
    // Like the real engine (anchorLabel): the label follows the capture scope.
    if (a.cell && a.scope === 'row') return `table row "${a.cell.rowKey}"`;
    if (a.cell && a.scope === 'column') return `table column "${a.cell.colHeader}"`;
    if (a.scope === 'table') return a.element?.label || 'table';
    if (a.cell) return `table cell row "${a.cell.rowKey}" x col "${a.cell.colHeader}"`;
    if (a.element) return a.element.label;
    return `"${clip(a.quote?.exact || a.src?.text || '', 60)}"`;
  }

  /** The composer preview (same shape as WP3's): {label, lines, section, src, text}. @param {any} a */
  preview(a) {
    const lines = a.kind === 'doc' ? null : [a.src.startLine, a.src.endLine];
    const src = lines ? this.source(a.v).split('\n').slice(lines[0] - 1, lines[1]).slice(0, 3).join('\n') : '';
    const sec = (a.section || []).slice(-1)[0] || '';
    const lineTxt = lines ? (lines[0] === lines[1] ? `L${lines[0]}` : `L${lines[0]}-${lines[1]}`) : 'GENERAL';
    const what = a.quote?.exact ? `"${clip(a.quote.exact, 60)}"` : this.label(a);
    const text = `Agent will see: ${[lineTxt, sec ? `§${sec}` : '', what].filter(Boolean).join(' ')}`;
    return { label: this.label(a), lines, section: a.section || [], src, text };
  }

  /**
   * Simple re-anchoring from version a to b: exact text near the mapped offset (exact / moved), else the new
   * range of the hunk covering the anchor (edited when linked, changed otherwise), else orphaned.
   * @param {any} item thread or lock
   * @param {number} a
   * @param {number} b
   */
  reanchorItem(item, a, b) {
    const prev = item.anchors[String(a)] || Object.values(item.anchors).slice(-1)[0];
    if (!prev) return;
    if (prev.kind === 'doc') {
      item.anchors[String(b)] = { ...prev, v: b };
      return;
    }
    const A = this.source(a);
    const B = this.source(b);
    const hunks = lineHunks(A, B);
    const text = prev.src.text;
    /** @type {number[]} */
    const hits = [];
    for (let i = B.indexOf(text); i >= 0 && text; i = B.indexOf(text, i + 1)) hits.push(i);
    if (hits.length) {
      let delta = 0;
      for (const h of hunks) if (h.oldEndOff <= prev.src.start) delta += (h.newEndOff - h.newStartOff) - (h.oldEndOff - h.oldStartOff);
      const want = prev.src.start + delta;
      const best = hits.reduce((x, y) => (Math.abs(y - want) < Math.abs(x - want) ? y : x));
      const next = this.anchorAt(b, best, best + text.length, pick(prev));
      if (prev.kind === 'section') Object.assign(next, sectionSrids(this.render(b), best, best + text.length));
      const sameLine = next.src.startLine === prev.src.startLine;
      next.state = sameLine ? 'exact' : 'moved';
      if (prev.element) {
        const n = this.render(b).srcmap.nodes;
        const srid = Object.keys(n).map(Number).find((k) => n[k].s === best && n[k].t === prev.element.tag) ?? prev.element.srid;
        next.element = { ...prev.element, srid };
        next.srid = srid;
      }
      item.anchors[String(b)] = next;
      return;
    }
    const linked = (item.changes || []).some((/** @type {any} */ c) => c.version === b);
    const h = hunks.find((x) => prev.src.startLine >= x.oldStart && prev.src.startLine < x.oldStart + Math.max(1, x.oldLines));
    if (h && h.newLines > 0) {
      const next = this.anchorAt(b, h.newStartOff, h.newEndOff, pick(prev));
      next.state = linked ? 'edited' : 'changed';
      if (prev.quote) next.quote = { ...prev.quote, exact: B.slice(h.newStartOff, h.newEndOff).replace(/^[-*>#\s]+/, '').trim() };
      item.anchors[String(b)] = next;
      return;
    }
    item.anchors[String(b)] = { ...prev, v: b, state: 'orphaned', lastKnown: prev };
  }

  // ------------------------------------------------------------------------------------------ DocState and targets

  docState() {
    return {
      ws: this.ws,
      doc: { ...this.doc, counters: { ...this.counters } },
      versions: this.versions.map(({ manifest: m }) => ({
        v: m.v, author: m.author, summary: m.summary, createdAt: m.createdAt, stats: m.stats, guards: m.guards, respondsTo: m.respondsTo,
      })),
      threads: structuredClone(this.threads),
      locks: structuredClone(this.locks),
      reviews: structuredClone(this.reviews),
      drafts: structuredClone(this.drafts),
      waiters: structuredClone(this.waiters),
      working: { dirty: this.working.dirty, sha256: this.working.sha256 },
      reviewer: { name: this.reviewer },
      decisions: this.threads.filter((t) => t.decision).map((t) => ({ ...t.decision, thread: t.id })),
    };
  }

  /** @param {string} id */
  thread(id) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) throw httpError(404, `thread ${id} not found`);
    return t;
  }

  /**
   * DomTarget of an anchor (amendments 3.4).
   * @param {string} id @param {number|null} num @param {any} a @param {string} state @param {Record<string, any>} [extra]
   */
  target(id, num, a, state, extra = {}) {
    return {
      id,
      num,
      kind: a.kind,
      state,
      srid: a.element ? a.element.srid : a.srid,
      endSrid: a.endSrid ?? null,
      quote: a.element || a.kind === 'doc' || a.kind === 'section' || a.kind === 'source' ? null : a.quote?.exact ?? null,
      prefix: a.quote?.prefix || '',
      suffix: a.quote?.suffix || '',
      region: a.region || null,
      svg: a.svg || null,
      cell: a.cell || null,
      label: this.label(a),
      ...extra,
    };
  }

  /** @param {number|'live'} v */
  domTargets(v) {
    const n = v === 'live' ? this.head : Number(v);
    /** @param {any} item */
    const anchorOf = (item) => {
      if (item.anchors[String(n)]) return item.anchors[String(n)];
      const keys = Object.keys(item.anchors).map(Number).filter((k) => k <= n).sort((x, y) => x - y);
      return keys.length ? item.anchors[String(keys[keys.length - 1])] : null;
    };
    const threads = [];
    for (const t of this.threads) {
      const a = anchorOf(t);
      if (!a || a.kind === 'doc') continue;
      let state = t.status === 'resolved' ? 'resolved' : t.status === 'needs_input' ? 'needs_input' : t.status === 'open' ? 'open' : 'addressed';
      if (a.state === 'changed') state = 'outdated';
      if (a.state === 'orphaned') state = 'orphaned';
      threads.push(this.target(t.id, Number(t.id.slice(1)), a, state, { severity: t.severity, type: t.type }));
    }
    const locks = this.locks.filter((l) => l.active).map((l) => {
      const a = anchorOf(l);
      return a ? this.target(l.id, null, a, 'lock') : null;
    }).filter(Boolean);
    const drafts = this.drafts.items.filter((d) => d.kind === 'thread' && d.anchor && Number(d.version ?? d.anchor.v) <= n && d.anchor.kind !== 'doc')
      .map((d) => this.target(d.id, null, d.anchor, 'draft', { severity: d.severity, type: d.type }));
    return { threads, locks, drafts, outline: this.render(v).outline };
  }

  // ------------------------------------------------------------------------------------------ diffs

  /** @param {number} from @param {number|'live'} to */
  changes(from, to) {
    const A = this.source(from);
    const B = this.source(to);
    const hunks = lineHunks(A, B);
    const cs = changeSet({ fromSource: A, toSource: B, toRender: this.render(to), format: this.format, hunks });
    const toN = to === 'live' ? null : Number(to);
    const manifest = toN && toN === from + 1 ? this.versions[toN - 1].manifest : null;
    /** @type {Record<string, string[]>} */
    const threadLinks = {};
    for (const h of cs.hunks) {
      const m = manifest?.hunks.find((/** @type {any} */ x) => x.id === h.id);
      h.threads = m?.threads || [];
      h.linkedBy = m ? m.linkedBy : null;
      h.other = m?.other ?? null;
      for (const t of h.threads) (threadLinks[t] ||= []).push(h.id);
    }
    const fromAssets = this.assetHashes[from] || {};
    const toAssets = to === 'live' ? this.assetHashes[this.head] || {} : this.assetHashes[toN || this.head] || {};
    const render = this.render(to);
    const assets = [];
    for (const path of new Set([...Object.keys(fromAssets), ...Object.keys(toAssets)])) {
      if (fromAssets[path] === toAssets[path]) continue;
      const srids = Object.entries(render.srcmap.nodes)
        .filter(([, n]) => /** @type {any} */ (n).a?.src && String(/** @type {any} */ (n).a.src).replace(/^\.\//, '') === path)
        .map(([k]) => Number(k));
      // Like the real engine: URLs relative to DocState.contentBase, plus the threads anchored on the image.
      const threads = this.threads.filter((t) => {
        const a = t.anchors[String(toN ?? this.head)] || Object.values(t.anchors).slice(-1)[0];
        return String(a?.element?.attrs?.src || '').replace(/^\.\//, '') === path;
      }).map((t) => t.id);
      for (const t of threads) (threadLinks[t] ||= []).push(`asset:${path}`);
      assets.push({
        path,
        from: fromAssets[path] || null,
        to: toAssets[path] || null,
        fromUrl: fromAssets[path] ? `v${from}/${path}` : null,
        toUrl: toAssets[path] ? `${to === 'live' ? 'live' : `v${to}`}/${path}` : null,
        srids,
        threads,
      });
    }
    return { from, to, ...cs, assets, threadLinks, guards: manifest?.guards || { forced: false, brokenLocks: [] } };
  }

  /** @param {number} from @param {number|'live'} to */
  sourceDiff(from, to) {
    return sourceDiff(this.source(from), this.source(to));
  }

  /** @param {string} tid */
  miniDiff(tid) {
    const t = this.thread(tid);
    const a0 = t.anchors[String(t.createdIn)];
    const a1 = t.anchors[String(this.head)] || a0;
    if (a0?.element?.tag === 'img') {
      const path = String(a0.element.attrs?.src || '').replace(/^\.\//, '');
      const before = this.assetHashes[t.createdIn]?.[path];
      const after = this.assetHashes[this.head]?.[path];
      if (path && before !== after) {
        return { kind: 'image', version: this.head, from: t.createdIn, path, beforeUrl: before ? `v${t.createdIn}/${path}` : null, afterUrl: after ? `v${this.head}/${path}` : null };
      }
    }
    // Whole source lines of the anchor at both versions, like the real engine.
    /** @param {any} a @param {number} v */
    const linesOf = (a, v) => {
      if (!a || a.kind === 'doc' || a.state === 'orphaned') return '';
      return this.source(v).split('\n').slice(a.src.startLine - 1, a.src.endLine).join('\n');
    };
    const before = linesOf(a0, t.createdIn);
    const after = linesOf(a1, this.head);
    return { kind: 'text', version: this.head, from: t.createdIn, before, after, words: wordDiff(before, after), state: a1?.state ?? null };
  }

  // ------------------------------------------------------------------------------------------ reviewer operations

  /** @param {any} item */
  saveDraft(item) {
    if (!item || !['thread', 'reply', 'resolve'].includes(item.kind)) throw httpError(422, 'kind must be thread, reply or resolve');
    const draft = { ...item, id: this.nextId('draft'), updatedAt: this.clock() };
    if (draft.kind === 'thread') {
      if (!draft.anchor && draft.capture) draft.anchor = this.resolveCapture(Number(draft.version || this.head), draft.capture);
      if (!draft.anchor) throw httpError(422, 'anchor or capture is required');
      draft.version = Number(draft.version || draft.anchor.v || this.head);
      draft.attachments = draft.attachments || [];
      draft.suggestion = draft.suggestion || null;
      draft.severity = draft.severity || 'normal';
      draft.type = draft.type || 'comment';
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
    this.drafts.items[i] = { ...this.drafts.items[i], ...rest, updatedAt: this.clock() };
    this.emit('drafts.changed', { draft: id });
    return this.drafts.items[i];
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
    // Like the engine's expectHead check: an approve of a head the reviewer has not seen is refused.
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
      resolved: /** @type {string[]} */ ([]), locksAdded: /** @type {string[]} */ ([]), submittedAt: at, deliveredTo: {}, ackedBy: {},
    };
    const announced = new Set(this.reviews.flatMap((r) => r.locksAdded));
    review.locksAdded = this.locks.filter((l) => !announced.has(l.id)).map((l) => l.id);
    for (const d of picked) {
      if (d.kind === 'thread') {
        const tid = this.nextId('thread');
        const v = Number(d.version || d.anchor.v || this.head);
        const anchors = { [String(v)]: d.anchor };
        const t = {
          schema: 1, id: tid, doc: this.id, type: d.type, severity: d.severity, status: 'open', createdIn: v, createdBy: by, review: id,
          anchors, override: null,
          suggestion: d.suggestion ? { ...d.suggestion, status: 'pending', appliedIn: null } : null,
          comments: [{ id: this.nextId('comment'), by, body: d.body || '', at, review: id, version: v }],
          changes: [], attachments: d.attachments || [], decision: null, resolvedIn: null, updatedAt: at,
        };
        for (let k = v + 1; k <= this.head; k++) this.reanchorItem(t, k - 1, k);
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
    if (this.waiters.length) {
      const agent = this.waiters[0].agent;
      setTimeout(() => this.deliver(id, agent), 30);
    }
    return review;
  }

  /** Marks a review delivered to an agent (the waiter exits, as `wait` does). @param {string} reviewId @param {string} [agent] */
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
    if (decision) {
      t.decision = { id: this.nextId('decision'), text: decision, version: this.head, srcText: t.anchors[String(this.head)]?.src?.text || '', at: this.clock() };
    }
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
    const a = this.resolveCapture(Number(p.version || this.head), p.capture);
    a.mappedBy = 'override';
    t.anchors[String(a.v)] = a;
    t.override = { version: a.v, lines: [a.src.startLine, a.src.endLine], by: 'human' };
    t.updatedAt = this.clock();
    this.emit('thread.updated', { thread: tid });
    return t;
  }

  /** Reviewer applies a suggestion: splices it and records a version. @param {string} tid */
  applySuggestion(tid) {
    const t = this.thread(tid);
    if (!t.suggestion) throw httpError(422, 'not a suggestion');
    const s = t.suggestion;
    // Same refusals (and codes) as the engine's applySuggestionAsReviewer.
    if (s.status === 'applied') throw httpError(409, `${tid} was already applied in v${s.appliedIn}`, 'REFUSED');
    if (this.working.dirty) throw httpError(409, `the working copy of ${this.doc.path} has unrecorded changes; apply needs a clean working copy`, 'CONFLICT');
    const src = this.source(this.head);
    const at = src.indexOf(s.old);
    if (at < 0) {
      s.status = 'conflict';
      throw httpError(409, `conflict ${tid}: the suggested text was not found in v${this.head}`, 'REFUSED');
    }
    const next = src.slice(0, at) + s.new + src.slice(at + s.old.length);
    const m = this.addVersion(next, { author: { kind: 'human', name: this.reviewer }, summary: `Applied suggestion ${tid}`, capturedBy: 'ui-apply' });
    s.status = 'applied';
    s.appliedIn = m.v;
    t.status = 'resolved';
    t.resolvedIn = m.v;
    this.emit('version.created', { v: m.v, author: `human:${this.reviewer}`, summary: m.summary });
    return m;
  }

  /** @param {{ version: number, capture: any, note?: string }} p */
  addLock(p) {
    const a = this.resolveCapture(Number(p.version || this.head), p.capture);
    const lock = {
      schema: 1, id: this.nextId('lock'), active: true, note: p.note || 'Agreed', createdIn: a.v,
      by: { kind: 'human', name: this.reviewer }, anchors: { [String(a.v)]: a }, text: a.src.text, textSha256: sha(a.src.text), breaks: [],
      createdAt: this.clock(),
    };
    this.locks.push(lock);
    this.emit('lock.changed', { lock: lock.id });
    return lock;
  }

  /** @param {string} id */
  removeLock(id) {
    const l = this.locks.find((x) => x.id === id);
    if (!l) throw httpError(404, `lock ${id} not found`);
    l.active = false;
    this.emit('lock.changed', { lock: id });
    return { ok: true };
  }

  /** @param {string} id */
  relock(id) {
    const l = this.locks.find((x) => x.id === id);
    if (!l) throw httpError(404, `lock ${id} not found`);
    l.active = true;
    this.emit('lock.changed', { lock: id });
    return l;
  }

  /** @param {string} summary */
  recordWorking(summary) {
    if (!this.working.dirty || this.working.source == null) throw httpError(409, 'nothing to record');
    const m = this.addVersion(this.working.source, { author: { kind: 'human', name: this.reviewer }, summary, capturedBy: 'ui-record' });
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
    return { html: renderFragmentSync({ format: this.format, source }) };
  }

  // ------------------------------------------------------------------------------------------ test controls

  /** @param {Array<{ agent: string, since?: string, pid?: number }>} waiters */
  setWaiters(waiters) {
    this.waiters = waiters.map((w) => ({ since: this.clock(), pid: 4242, ...w }));
    this.emit('presence', { waiters: this.waiters }, { volatile: true });
  }

  /** @param {string|null} source null = clean (equal to head) */
  setWorking(source) {
    if (source == null || source === this.source(this.head)) this.working = { dirty: false, sha256: this.versions[this.head - 1].manifest.sha256, source: null };
    else this.working = { dirty: true, sha256: sha(source), source };
    this.emit('working.changed', { dirty: this.working.dirty, sha256: this.working.sha256 }, { volatile: true });
  }

}

/**
 * Like the engine's section anchors: srid = the heading starting the range, endSrid = the element reaching furthest
 * inside it (so the guest brackets heading .. end of section).
 * @param {any} render @param {number} start @param {number} end
 */
function sectionSrids(render, start, end) {
  const nodes = render.srcmap.nodes;
  /** @type {number|null} */
  let srid = null;
  /** @type {number|null} */
  let endSrid = null;
  let maxEnd = -1;
  for (const k of render.srcmap.order) {
    const n = nodes[k];
    if (n.s < start || n.s >= end) continue;
    if (srid == null && n.h) srid = k;
    if (n.e > maxEnd) {
      maxEnd = n.e;
      endSrid = k;
    }
  }
  return { srid, endSrid: endSrid === srid ? null : endSrid };
}

/** Fields of an anchor that survive re-anchoring. @param {any} a */
function pick(a) {
  return {
    kind: a.kind, quote: a.quote, element: a.element, region: a.region, svg: a.svg, cell: a.cell, scope: a.scope,
    mappedBy: a.mappedBy, generated: a.generated,
  };
}

/** @param {number} status @param {string} message @param {string} [code] daemon error code (CONFLICT, REFUSED, ...) */
export function httpError(status, message, code) {
  const err = /** @type {Error & { status: number, code?: string }} */ (new Error(message));
  err.status = status;
  if (code) err.code = code;
  return err;
}
