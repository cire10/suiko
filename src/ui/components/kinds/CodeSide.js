// @ts-check
// The code review's Changes list (KindSide, changes mode): what changed between the base version and the shown one,
// grouped by file, from the ChangeSet the app keeps in s.changes (GET D/diff, hunk ids '<path>#h<n>'). Each change
// has a "seen" checkbox (per comparison, like the spec Changes list), its lines, the threads the agent linked to it
// and its word on a change no thread asked for ("Also changed: ..."); a click (or n / p) scrolls the centre to that
// hunk. Below: "Results", the agent's replies in this range with Looks good / Not yet for the threads to check (Reply
// for its questions).

import { html, useEffect, useMemo, useRef } from 'preact-htm';
import { TESTID } from 'protocol';
import { focusItem, goToHunk, navChange, readSeen, resolveThread, seenStorageKey, setChangesSeen, startReply } from '../../actions.js';
import { Markdown } from '../../markdown.js';
import { agentName, agentTitle, anchorAt, isVerifiable, numericVersion, roundResults, statusInfo, targetLabel } from '../../model.js';
import { store, useStore } from '../../state.js';
import { scrollIntoViewSoft } from '../../util.js';
import { Chip } from '../common.js';
import { fileStatus, hunkFile } from './code-model.js';
import { listKeyOf, loadList, useCode } from './code-state.js';

/** @param {any} h */
function hunkLabel(h) {
  if (h.op === 'del') {
    const s = Number(h.old?.start);
    const n = Number(h.old?.lines) || 0;
    return `removed L${s}${n > 1 ? `-${s + n - 1}` : ''}`;
  }
  const s = Number(h.new?.start);
  const n = Number(h.new?.lines) || 0;
  return n > 1 ? `L${s}-${s + n - 1}` : `L${s}`;
}

/** @param {{ ds: any }} props */
export function CodeSide({ ds }) {
  const s = useStore((st) => ({
    changes: st.changes,
    error: st.changesError,
    base: st.base,
    version: st.version,
    activeHunk: st.activeHunk,
    seenKey: seenStorageKey(st),
    seenRev: st.seenRev,
  }));
  const v = numericVersion(ds, s.version);
  const base = s.base == null ? null : Number(s.base);
  const listKey = listKeyOf(v, base);
  const list = useCode((c) => c.lists[listKey]);
  useEffect(() => {
    if (base != null) loadList(v, base);
  }, [listKey]);
  const seen = useMemo(() => readSeen(s.seenKey), [s.seenKey, s.seenRev]);
  const listRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  useEffect(() => {
    if (!s.activeHunk || !listRef.current) return;
    scrollIntoViewSoft(listRef.current.querySelector(`[data-hunk-id="${CSS.escape(s.activeHunk)}"]`));
  }, [s.activeHunk]);

  const hunks = /** @type {any[]} */ (s.changes?.hunks || []);
  const groups = useMemo(() => {
    /** @type {Map<string, any[]>} */
    const by = new Map();
    for (const h of hunks) {
      const f = String(h.file || hunkFile(h.id) || '');
      if (!by.has(f)) by.set(f, []);
      by.get(f)?.push(h);
    }
    return [...by.entries()].map(([file, hs]) => ({ file, hunks: hs }));
  }, [s.changes]);
  /** @type {Map<string, any>} */
  const changeOf = useMemo(() => new Map((list?.status === 'ok' ? list.data?.files || [] : []).map((/** @type {any} */ f) => [f.path, f])), [list]);

  if (base == null) {
    return html`<section class="changes-view" aria-label="Changes"><div class="empty">
      <p><strong>This is the first version.</strong></p>
      <p>After ${agentTitle(agentName(ds))} records a new version, you'll see what changed in each file.</p>
    </div></section>`;
  }
  const total = hunks.length;
  const done = hunks.filter((h) => seen.has(h.id)).length;
  const results = roundResults(ds, base, v);
  const agent = agentName(ds);
  const last = Number(ds.doc.lastReviewedVersion);
  const meta = (ds.versions || []).find((/** @type {any} */ x) => Number(x.v) === v);
  /** @param {string} t */
  const showThread = (t) => {
    store.set({ sidePane: 'threads' });
    focusItem(t);
  };

  return html`<section class="changes-view code-side" aria-label="Changes">
    <div class="changes-head">
      <div class="changes-title">
        <strong>v${base} → v${v}</strong>
        ${base === last ? html`<span class="small muted">since your last review</span>` : null}
      </div>
      ${s.changes ? html`<div class="changes-stats small">
        <span class="ins-text">+${s.changes.stats?.added ?? 0}</span> <span class="del-text">−${s.changes.stats?.removed ?? 0}</span>
        <span class="muted">· ${groups.length} file${groups.length === 1 ? '' : 's'}, ${total} change${total === 1 ? '' : 's'}</span>
        <span class="progress" aria-label=${`${done} of ${total} reviewed`}>${done}/${total} reviewed</span>
      </div>` : null}
      ${meta?.summary ? html`<p class="small version-summary">${meta.summary}</p>` : null}
      <div class="row">
        <button type="button" class="btn btn-sm" onClick=${() => navChange(-1)} disabled=${!total} title="Previous change (p)">Prev</button>
        <button type="button" class="btn btn-sm" onClick=${() => navChange(1)} disabled=${!total} title="Next change (n)">Next</button>
      </div>
    </div>
    ${s.error ? html`<p class="error small" role="alert">Cannot load the changes: ${s.error}</p>` : null}
    ${!s.changes && !s.error ? html`<p class="small muted">Loading changes…</p>` : null}
    ${s.changes && total === 0 ? html`<div class="empty"><p>No changes between v${base} and v${v}.</p></div>` : null}
    <div class="change-groups" ref=${listRef}>
      ${groups.map((g) => {
        const ch = changeOf.get(g.file);
        const st = ch ? fileStatus(ch.change) : null;
        return html`<section class="change-group" key=${g.file}>
          <h3 class="group-title cd-side-file" title=${g.file}>
            ${st ? html`<span class=${`cd-status tone-${st.tone}`} aria-label=${st.label}>${st.letter}</span> ` : null}<span class="mono">${g.file}</span>
          </h3>
          <ul class="change-list">
            ${g.hunks.map((h) => {
              const active = s.activeHunk === h.id;
              return html`<li data-testid=${TESTID.changeItem} data-hunk-id=${h.id} key=${h.id}
                class=${`change-item op-${h.op} ${active ? 'active' : ''} ${seen.has(h.id) ? 'seen' : ''}`}>
                <input type="checkbox" class="seen-box" checked=${seen.has(h.id)} aria-label=${`Mark ${h.id} as seen`}
                  onChange=${(/** @type {any} */ e) => setChangesSeen([h.id], e.currentTarget.checked)} />
                <button type="button" class="change-main" aria-current=${active ? 'true' : undefined} onClick=${() => goToHunk(h.id)}>
                  <span class="change-top">
                    <span class=${`op-badge op-${h.op}`}>${h.op === 'add' ? '+ added' : h.op === 'del' ? '− removed' : '~ changed'}</span>
                    <span class="small muted">${hunkLabel(h)}</span>
                  </span>
                </button>
                <span class="change-links">
                  ${(h.threads || []).map((/** @type {string} */ t) => html`<button type="button" class="chip tone-accent chip-btn" key=${t}
                    onClick=${() => showThread(t)}>${t}</button>`)}
                  ${h.other ? html`<span class="change-other small" title=${`${agentTitle(agent)} changed this without a thread asking for it`}>Also changed: ${h.other}</span>` : null}
                </span>
              </li>`;
            })}
          </ul>
        </section>`;
      })}
    </div>
    ${results.length ? html`<section class="round-results" aria-label="Results">
      <h3 class="group-title" title=${`What ${agentTitle(agent)} answered between v${base} and v${v}`}>Results</h3>
      ${results.map(({ thread: t, comment: c }) => {
        const st = statusInfo(t, agent, { drafts: ds.drafts, version: v });
        const verifiable = isVerifiable(t, ds.drafts);
        return html`<div class="result" key=${t.id} data-thread-id=${t.id}>
          <div class="result-head">
            <button type="button" class="link-btn tid" onClick=${() => showThread(t.id)}>${t.id}</button>
            <${Chip} tone=${st.tone} title=${st.title}>${st.label}<//>
            <span class="small muted">${targetLabel(anchorAt(t, v))}</span>
          </div>
          <${Markdown} text=${c.body} class="comment-body" />
          ${verifiable ? html`<div class="card-actions">
            <button type="button" class="btn btn-sm" data-testid=${TESTID.verifyAccept} onClick=${() => resolveThread(t.id)}
              title="Accept it: the thread is done (x)">${t.status === 'addressed' ? 'Looks good' : 'Done'}</button>
            <button type="button" class="btn btn-sm" data-testid=${TESTID.verifyReopen} title="Reopen with a reply: what still needs to change (o)"
              onClick=${() => { store.set({ sidePane: 'threads' }); startReply(t.id, { reopen: true }); }}>Not yet</button>
          </div>` : t.status === 'needs_input' ? html`<div class="card-actions">
            <button type="button" class="btn btn-sm" onClick=${() => { store.set({ sidePane: 'threads' }); startReply(t.id); }}>Reply</button>
          </div>` : null}
        </div>`;
      })}
    </section>` : null}
  </section>`;
}
