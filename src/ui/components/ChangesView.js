// @ts-check
// Changes mode side panel (design 8.6 / 11.3): what changed from the base to the shown version.
// - The header (sticky: it stays at the top of the panel while the list scrolls under it): "v1 → v3" and what the
//   older end is to the reviewer ("since your last review"), +/− and the number of changes with the "seen" progress,
//   Prev / Next (n / p), "Accept all" (TESTID.acceptRevisions: on the latest version while its revisions are new to
//   the reviewer; it accepts them and the threads the agent addressed or answered, with Undo) and the Inline / Side
//   by side switch (TESTID.compareLayout; wide windows only, and not while side by side is shown: the compare bar
//   holds it then).
// - The change list, grouped by section, with "seen" checkboxes (kept in localStorage per comparison, through
//   actions.js, so the command palette's "Mark all changes seen" ticks them too) and a progress count. Clicking an
//   item (or n / p) scrolls the doc to the hunk. Each item shows the hunk as an inline word diff (old words struck,
//   new words marked, unchanged words as context, long unchanged runs shortened), capped at 6 lines with "Show
//   more". For an HTML doc (and an HTML snapshot) the diff is of what a reader reads: the hunk's source lines
//   (GET .../diff/source) without their tags, comments, scripts and styles (readableLines), with a "Source" toggle
//   for the markup itself; "Only the markup changed" when the text did not, and a change with no block or words of
//   the page (a chart's data, a script) says it is in the page's code or data. A Markdown doc shows its source lines,
//   which read as text already. The change's id and lines ("h2 · L105-106") are in the item's tooltip. Group titles
//   drop the doc's only H1 (the spec title would otherwise prefix every section).
// - Linked threads per hunk, and the agent's word on a change no thread asked for ("Also changed: ..."), plus guard
//   badges of the version.
// - Changed assets: images as a before / after pair; other files (an HTML chart the doc frames, CSS, data) as one
//   line, "Added in v2 · Open v2", since a picture of them would be a broken image.
// - "Results": the agent's replies in this range, with Looks good / Not yet (Reply for its questions), and Accept
//   all (AcceptAllBar).

import { html, useEffect, useMemo, useRef, useState } from 'preact-htm';
import { TESTID } from 'protocol';
import { docApi } from '../api.js';
import {
  acceptRevisions, focusItem, goToHunk, navChange, readSeen, resolveThread, seenStorageKey, setChangesSeen, setCompareLayout,
  splitShown, startReply,
} from '../actions.js';
import { Markdown } from '../markdown.js';
import {
  acceptableThreads, agentName, agentTitle, baseTag, coalesceWordParts, diffLines, guardBadges, groupHunks, hunkLines, hunkPreview,
  hunkSourceText, isVerifiable, kindCaps, numericVersion, revisionsToAccept, roundResults, singleH1, statusInfo, targetLabel,
  anchorAt, trimDiffContext, versionMeta,
} from '../model.js';
import { store, useStore } from '../state.js';
import { contentUrl, scrollIntoViewSoft, wordParts } from '../util.js';
import { Chip, Icon } from './common.js';
import { AcceptAllBar } from './ThreadPanel.js';

/** Changed assets shown as a before / after picture pair; any other file (an HTML chart, CSS, data) gets a line. */
const IMAGE_ASSET = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
/** Hunks longer than this many display lines are collapsed behind "Show more". */
const HUNK_LINES = 6;
/** ...and so are hunks with more characters than this (one long Markdown paragraph is a single source line). */
const HUNK_CHARS = 480;

/**
 * The source diff of the comparison shown (one request per base / version / head), for the hunks' word diffs.
 * Null while loading or when it cannot be loaded (the items then show the rendered-text preview).
 * @param {any} route
 * @param {number|null} base
 * @param {number|'live'|null} version
 * @param {any} changes waited for, and followed for the live working copy (it changes under the same pair)
 */
function useSourceDiff(route, base, version, changes) {
  const [state, setState] = useState(/** @type {{ key: string, data: any }} */ ({ key: '', data: null }));
  const key = `${route.ws}/${route.doc}|${base}|${version}`;
  useEffect(() => {
    if (base == null || version == null || !changes) return undefined;
    let alive = true;
    docApi(route.ws, route.doc).sourceDiff(base, version)
      .then((data) => { if (alive) setState({ key, data }); })
      .catch(() => { if (alive) setState({ key, data: null }); });
    return () => {
      alive = false;
    };
  }, [key, version === 'live' ? changes : !!changes]);
  return state.key === key ? state.data : null;
}

/** Elements whose content is never read as text (protocol.js TEXT_EXCLUDE tags and inert friends). */
const HIDDEN_CONTENT = /<(script|style|template|noscript|textarea|title|iframe)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
/** Tags that end a run of text (block boxes, line breaks, cells): replaced by a space so words never run together. */
const BREAKING_TAG = /^(?:address|article|aside|blockquote|br|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/i;

/** @type {HTMLTextAreaElement|null} */
let decoder = null;

/** Decodes character references ("&amp;", "&#8212;", "&nbsp;"): a textarea's content is text, never markup. @param {string} s */
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  decoder ??= document.createElement('textarea');
  decoder.innerHTML = s;
  return decoder.value;
}

/**
 * What a reader reads in a few lines of HTML source (one change's lines): no tags, comments, scripts or styles,
 * character references decoded, spaces collapsed; one line per source line that has text left (the others are
 * dropped). Not a parser: a change's lines can begin or end inside a tag or a comment, so a cut-off tag or comment
 * at either end is left out too.
 * @param {string} src
 * @returns {string}
 */
export function readableLines(src) {
  let s = String(src ?? '');
  // the end of a comment or a tag cut off at the start ('  class="kpi">'), the start of one cut off at the end
  if (/^[^<]*-->/.test(s)) s = s.replace(/^[^<]*-->/, ' ');
  s = s.replace(/^[^<>]*?\s[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)[^<>]*>/, ' ');
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  s = s.replace(HIDDEN_CONTENT, ' ');
  s = s.replace(/<[a-zA-Z][^>]*$/, ' ');
  s = s.replace(/<\/?([a-zA-Z][\w:-]*)\b[^>]*>/g, (_, name) => (BREAKING_TAG.test(name) ? ' ' : ''));
  s = s.replace(/<![^>]*>/g, ' ');
  return s.split('\n').map((line) => decodeEntities(line).replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * One change: its op badge, then the hunk as an inline word diff (or the rendered preview until the source diff is
 * there). `markup`: an HTML doc, whose source lines are shown as the text they render to, with a Source toggle for
 * the markup. The change's id and lines are in the tooltip.
 * @param {{ h: any, active: boolean, text: { old: string, new: string }|null, markup: boolean }} props
 */
function HunkBody({ h, active, text, markup }) {
  const [expanded, setExpanded] = useState(false);
  const [source, setSource] = useState(false);
  const readable = useMemo(() => (text && markup ? { old: readableLines(text.old), new: readableLines(text.new) } : null),
    [text?.old, text?.new, markup]);
  const shownText = readable && !source ? readable : text;
  const lines = useMemo(() => (shownText ? diffLines(trimDiffContext(coalesceWordParts(wordParts(shownText.old, shownText.new)))) : null),
    [shownText?.old, shownText?.new]);
  const markupOnly = !!readable && !source && readable.old === readable.new;
  // no block and no words of the page changed: the change is in its code or data (a chart's numbers, a script)
  const code = !!readable && !source && !markupOnly && h.op === 'mod' && !(h.srids || []).length && !(h.words || []).length;
  const p = text ? null : hunkPreview(h);
  const chars = lines ? lines.reduce((n, l) => n + l.reduce((m, part) => m + part.text.length, 0), 0) : 0;
  const long = !!lines && !markupOnly && (lines.length > HUNK_LINES || chars > HUNK_CHARS);
  const shown = lines && long && !expanded ? lines.slice(0, HUNK_LINES) : lines;
  return html`<button type="button" class="change-main" aria-current=${active ? 'true' : undefined} onClick=${() => goToHunk(h.id)}
      title=${`${h.id} · ${hunkLines(h)}: show it in the document`}>
      <span class="change-top">
        <span class=${`op-badge op-${h.op}`}>${h.op === 'add' ? '+ added' : h.op === 'del' ? '− removed' : '~ changed'}</span>
      </span>
      ${code ? html`<span class="small muted hd-code-note">In the page's code or data, not its text:</span>` : null}
      ${markupOnly ? html`<span class="small muted hd-markup-only" data-hunk-diff>Only the markup changed</span>`
        : shown ? html`<span class=${`hunk-diff${long && !expanded ? ' is-capped' : ''}${source || code ? ' is-source' : ''}`} data-hunk-diff>${shown.map((line) => html`<span class="hd-line">${line.length
          ? line.map((part) => (part.op === 'ins' ? html`<ins>${part.text}</ins>`
            : part.op === 'del' ? html`<del>${part.text}</del>`
              : part.op === 'gap' ? html`<span class="hd-gap" aria-label="unchanged text omitted">${part.text}</span>` : part.text))
          : ' '}</span>`)}</span>` : null}
      ${p?.del ? html`<span class="change-del">${p.del}</span>` : null}
      ${p?.ins ? html`<span class="change-ins">${p.ins}</span>` : null}
    </button>
    ${readable ? html`<button type="button" class="link-btn hunk-source" aria-pressed=${source ? 'true' : 'false'}
      title=${source ? 'Show the text as readers see it' : 'Show the HTML source of this change'}
      onClick=${() => setSource(!source)}>Source</button>` : null}
    ${long ? html`<button type="button" class="link-btn hunk-more" aria-expanded=${expanded} onClick=${() => setExpanded(!expanded)}>
      ${expanded ? 'Show less' : lines && lines.length > HUNK_LINES ? `Show ${lines.length - HUNK_LINES} more line${lines.length - HUNK_LINES === 1 ? '' : 's'}` : 'Show more'}</button>` : null}`;
}

/**
 * Changes: Inline (what changed drawn over the newer version) or Side by side (the older version beside it). In the
 * Changes panel's header while inline; the compare bar has it while side by side is shown.
 * @param {{ layout: 'inline'|'split' }} props
 */
export function CompareLayout({ layout }) {
  return html`<span class="seg compare-layout" role="group" aria-label="Compare layout" data-testid=${TESTID.compareLayout}>
    <button type="button" data-layout="inline" aria-pressed=${layout !== 'split'} class=${layout !== 'split' ? 'active' : ''}
      title="What changed, drawn over the newer version" onClick=${() => setCompareLayout('inline')}>Inline</button>
    <button type="button" data-layout="split" aria-pressed=${layout === 'split'} class=${layout === 'split' ? 'active' : ''}
      title="The older version beside the newer one, scrolled together: removed text in red, added text in green"
      onClick=${() => setCompareLayout('split')}>Side by side</button>
  </span>`;
}

export function ChangesView() {
  const s = useStore((st) => ({
    ds: st.ds,
    changes: st.changes,
    error: st.changesError,
    base: st.base,
    version: st.version,
    activeHunk: st.activeHunk,
    route: st.route,
    outline: st.guest.outline.length ? st.guest.outline : st.targets?.outline,
    seenKey: seenStorageKey(st),
    seenRev: st.seenRev,
    busyThreads: st.busyThreads,
    layout: st.compareLayout,
    // the Inline / Side by side switch: wide windows only, and not while the compare bar shows it
    layoutHere: !st.narrow && !splitShown(st) && !!st.ds && kindCaps(st.ds).frame,
  }));
  const r = /** @type {any} */ (s.route);
  const seen = useMemo(() => readSeen(s.seenKey), [s.seenKey, s.seenRev]);
  const h1 = singleH1(s.outline);
  const groups = useMemo(() => groupHunks(s.changes, { h1 }), [s.changes, h1]);
  const sourceDiff = useSourceDiff(r, s.base, s.version, s.changes);
  const listRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const headRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  useEffect(() => {
    if (!s.activeHunk || !listRef.current) return;
    scrollIntoViewSoft(listRef.current.querySelector(`[data-hunk-id="${CSS.escape(s.activeHunk)}"]`));
  }, [s.activeHunk]);
  // The sticky header's height, so an item scrolled into view stops below it, never under it (scroll-margin-top).
  useEffect(() => {
    const head = headRef.current;
    if (!head || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => head.parentElement?.style.setProperty('--changes-head-h', `${Math.round(head.getBoundingClientRect().height)}px`));
    ro.observe(head);
    return () => ro.disconnect();
  }, [!!s.ds, s.base == null]);

  if (!s.ds) return null;
  const ds = s.ds;
  const v = numericVersion(ds, s.version);
  if (s.base == null) {
    return html`<section class="changes-view" aria-label="Changes"><div class="empty">
      <p><strong>This is the first version.</strong></p>
      <p>After ${agentTitle(agentName(ds))} revises it, you'll see exactly what changed.</p>
    </div></section>`;
  }
  const hunks = s.changes?.hunks || [];
  const total = hunks.length;
  const done = hunks.filter((/** @type {any} */ h) => seen.has(h.id)).length;
  const meta = s.version === 'live' ? null : versionMeta(ds, v);
  const badges = guardBadges(meta);
  const results = roundResults(ds, s.base, v);
  const agent = agentName(ds);
  // an HTML doc (or snapshot): its changes read as the text they render to, with the markup a toggle away
  const markup = ds.doc?.format === 'html';
  const tag = baseTag(ds, s.base);
  // "Accept all": the latest version's revisions, while they are new to the reviewer and that version is shown
  const todo = revisionsToAccept(ds);
  const acceptHere = !!todo && s.version === todo.version;
  const since = todo?.since != null ? `since v${todo.since}` : '';
  const accepting = acceptHere ? acceptableThreads(ds).length : 0;

  /** @param {string} id @param {boolean} on */
  const toggleSeen = (id, on) => setChangesSeen([id], on);

  return html`<section class="changes-view" aria-label="Changes">
    <div class="changes-head" ref=${headRef}>
      <div class="changes-head-row">
        <div class="changes-title">
          <strong>v${s.base} → ${s.version === 'live' ? 'working copy' : `v${v}`}</strong>
          ${tag ? html`<span class="small muted">${tag === 'accepted' ? 'since the revisions you accepted' : 'since your last review'}</span>` : null}
        </div>
        ${acceptHere && todo ? html`<button type="button" class="btn btn-sm accept-revisions" data-testid=${TESTID.acceptRevisions}
          aria-label="Accept all revisions" disabled=${s.busyThreads.length > 0} onClick=${() => acceptRevisions()}
          title=${`Accept the revisions of v${todo.version}${since ? ` (${since})` : ''}: they stop showing as new${accepting
            ? `, and the ${accepting} thread${accepting === 1 ? '' : 's'} ${agent} changed or answered ${accepting === 1 ? 'is' : 'are'} done` : ''}. You can undo it`}>
          <${Icon} name="check" size=${14} />Accept all</button>` : null}
      </div>
      ${s.changes ? html`<div class="changes-stats small">
        <span class="ins-text">+${s.changes.stats?.added ?? 0}</span> <span class="del-text">−${s.changes.stats?.removed ?? 0}</span>
        <span class="muted">· ${total} change${total === 1 ? '' : 's'}</span>
        <span class="progress" aria-label=${`${done} of ${total} reviewed`}>${done}/${total} reviewed</span>
      </div>` : null}
      ${badges.length ? html`<div class="guard-badges">${badges.map((b) => html`<${Chip} tone=${b.tone} key=${b.key}>${b.label}<//>`)}</div>` : null}
      ${meta?.summary ? html`<p class="small version-summary">${meta.summary}</p>` : null}
      <div class="changes-nav">
        <span class="changes-step">
          <button type="button" class="btn btn-sm" onClick=${() => navChange(-1)} disabled=${!total} title="Previous change (p)">
            <${Icon} name="chevronLeft" size=${14} />Prev</button>
          <button type="button" class="btn btn-sm" onClick=${() => navChange(1)} disabled=${!total} title="Next change (n)">
            Next<${Icon} name="chevron" size=${14} /></button>
        </span>
        ${s.layoutHere ? html`<${CompareLayout} layout=${s.layout} />` : null}
      </div>
    </div>
    ${s.error ? html`<p class="error small" role="alert">Cannot load the changes: ${s.error}</p>` : null}
    ${!s.changes && !s.error ? html`<p class="small muted">Loading changes…</p>` : null}
    ${s.changes && total === 0 && !(s.changes.assets || []).length ? html`<div class="empty"><p>No changes between v${s.base} and ${s.version === 'live' ? 'the working copy' : `v${v}`}.</p></div>` : null}
    <div class="change-groups" ref=${listRef}>
      ${groups.map((g) => html`<section class="change-group" key=${g.key}>
        <h3 class="group-title">${g.title}</h3>
        <ul class="change-list">
          ${g.hunks.map((/** @type {any} */ h) => {
            const active = s.activeHunk === h.id;
            return html`<li data-testid=${TESTID.changeItem} data-hunk-id=${h.id} class=${`change-item op-${h.op} ${active ? 'active' : ''} ${seen.has(h.id) ? 'seen' : ''}`}
              key=${h.id}>
              <input type="checkbox" class="seen-box" checked=${seen.has(h.id)} aria-label=${`Mark ${h.id} as seen`}
                onChange=${(/** @type {any} */ e) => toggleSeen(h.id, e.currentTarget.checked)} />
              <${HunkBody} h=${h} active=${active} text=${sourceDiff ? hunkSourceText(sourceDiff, h.id) : null} markup=${markup} />
              <span class="change-links">
                ${(h.threads || []).map((/** @type {string} */ t) => html`<button type="button" class="chip tone-accent chip-btn" key=${t}
                  onClick=${() => { store.set({ sidePane: 'threads' }); focusItem(t); }}>${t}</button>`)}
                ${h.other ? html`<span class="change-other small" title=${`${agentTitle(agent)} changed this without a thread asking for it`}>Also changed: ${h.other}</span>` : null}
              </span>
            </li>`;
          })}
        </ul>
      </section>`)}
    </div>
    ${(s.changes?.assets || []).length ? html`<section class="change-group" aria-label="Changed assets">
      <h3 class="group-title">Changed assets</h3>
      ${s.changes.assets.map((/** @type {any} */ a) => {
        const before = contentUrl(ds.contentBase, a.fromUrl);
        const after = contentUrl(ds.contentBase, a.toUrl);
        const afterLabel = s.version === 'live' ? 'working copy' : `v${v}`;
        return html`<div class="asset-change" data-asset=${a.path} key=${a.path}>
          <p class="small mono">${a.path}
            ${(a.threads || []).map((/** @type {string} */ t) => html` <button type="button" class="chip tone-accent chip-btn" key=${t}
              onClick=${() => { store.set({ sidePane: 'threads' }); focusItem(t); }}>${t}</button>`)}</p>
          ${IMAGE_ASSET.test(a.path) ? html`<div class="img-pair">
            <figure>${before ? html`<img src=${before} alt=${`Before: ${a.path}`} loading="lazy" referrerpolicy="no-referrer" />` : html`<span class="muted small">(none)</span>`}<figcaption>Before (v${s.base})</figcaption></figure>
            <figure>${after ? html`<img src=${after} alt=${`After: ${a.path}`} loading="lazy" referrerpolicy="no-referrer" />` : html`<span class="muted small">(removed)</span>`}<figcaption>After (${afterLabel})</figcaption></figure>
          </div>` : html`<p class="small asset-file">
            <span class="muted">${!before ? `Added in ${afterLabel}` : !after ? `Removed in ${afterLabel}` : `Changed in ${afterLabel}`}</span>
            ${before ? html` · <a href=${before} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open v${s.base}</a>` : null}
            ${after ? html` · <a href=${after} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open ${afterLabel}</a>` : null}
          </p>`}
        </div>`;
      })}
    </section>` : null}
    ${results.length ? html`<section class="round-results" aria-label="Results">
      <h3 class="group-title" title=${`What ${agentTitle(agent)} answered between v${s.base} and v${v}`}>Results</h3>
      <${AcceptAllBar} ds=${ds} busy=${s.busyThreads} live=${s.version === 'live'} />
      ${results.map(({ thread: t, comment: c }) => {
        const st = statusInfo(t, agent, { drafts: ds.drafts, version: s.version });
        const verifiable = isVerifiable(t, ds.drafts);
        return html`<div class="result" key=${t.id} data-thread-id=${t.id}>
          <div class="result-head">
            <button type="button" class="link-btn tid" onClick=${() => { store.set({ sidePane: 'threads' }); focusItem(t.id); }}>${t.id}</button>
            <${Chip} tone=${st.tone} title=${st.title}>${st.label}<//>
            <span class="small muted">${targetLabel(anchorAt(t, s.version))}</span>
          </div>
          <${Markdown} text=${c.body} class="comment-body" />
          ${verifiable ? html`<div class="card-actions">
            <button type="button" class="btn btn-sm" data-testid=${TESTID.verifyAccept} onClick=${() => resolveThread(t.id)}
              title="Accept it: the thread is done (x)">${t.status === 'addressed' ? 'Looks good' : 'Done'}</button>
            <button type="button" class="btn btn-sm" data-testid=${TESTID.verifyReopen} title="Reopen with a reply: what still needs to change (o)"
              onClick=${() => { store.set({ sidePane: 'threads' }); startReply(t.id, { reopen: true }); }}>Not yet</button>
          </div>` : t.status === 'needs_input' && s.version !== 'live' ? html`<div class="card-actions">
            <button type="button" class="btn btn-sm" onClick=${() => { store.set({ sidePane: 'threads' }); startReply(t.id); }}>Reply</button>
          </div>` : null}
        </div>`;
      })}
    </section>` : null}
  </section>`;
}
