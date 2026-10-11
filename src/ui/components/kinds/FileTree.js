// @ts-check
// The code review's left rail (KindRail): a filter box and the changed files as a tree (directories with a single
// child directory are compacted, 'src/util'). Each file row shows its status letter (A added, M modified, D
// deleted, R renamed, T type changed, = unchanged but carrying a thread), its name, +/- line counts, the number of
// open threads and a badge for binary / too-large files. In Changes mode the tree lists the files that changed
// between the two rounds. Clicking a row scrolls the centre to that file's card (and closes the drawer on a narrow
// window). The filter also narrows the cards in the centre. Below the tree: the review's rounds.

import { html, useEffect, useMemo, useState } from 'preact-htm';
import { CODE_TESTID } from 'protocol';
import { setMode, switchVersion } from '../../actions.js';
import { actorLabel, numericVersion, relTime, versionNumbers } from '../../model.js';
import { store, useStore } from '../../state.js';
import { Icon } from '../common.js';
import { buildTree, fileStatus, matchesFilter, openCounts, outsideReview } from './code-model.js';
import { listKeyOf, loadList, revealFile, setFilter, useCode } from './code-state.js';

/** @param {{ ds: any }} props */
export function FileTree({ ds }) {
  const s = useStore((st) => ({ mode: st.mode, version: st.version, base: st.base, narrow: st.narrow }));
  const changes = s.mode === 'changes' && s.base != null;
  const v = numericVersion(ds, s.version);
  const base = changes ? Number(s.base) : null;
  const listKey = listKeyOf(v, base);
  const c = useCode((st) => ({ list: st.lists[listKey], filter: st.filter, active: st.activePath }));
  const [closed, setClosed] = useState(/** @type {Set<string>} */ (new Set()));
  useEffect(() => {
    loadList(v, base);
  }, [listKey]);

  const files = /** @type {any[]} */ (c.list?.status === 'ok' ? c.list.data?.files || [] : []);
  const shown = useMemo(() => files.filter((f) => matchesFilter(f, c.filter)), [files, c.filter]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  const counts = useMemo(() => openCounts(ds, v), [ds.threads, v]);
  const skipped = useMemo(() => (!changes ? outsideReview(files, c.list?.data?.skipped) : []), [files, changes]);

  /** @param {string} path */
  const open = (path) => {
    if (s.mode !== 'review' && s.mode !== 'changes') setMode('review');
    revealFile(path);
    if (s.narrow) store.set({ nav: false });
  };
  /** @param {string} path */
  const toggleDir = (path) => {
    const next = new Set(closed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setClosed(next);
  };

  /** @param {import('./code-model.js').TreeNode[]} nodes @param {number} depth @returns {any} */
  const renderNodes = (nodes, depth) => nodes.map((n) => {
    if (n.type === 'dir') {
      const isClosed = closed.has(n.path) && !c.filter;
      return html`<li key=${`d:${n.path}`} class="cd-tree-dir" role="treeitem" aria-expanded=${isClosed ? 'false' : 'true'}>
        <button type="button" class="cd-tree-row cd-tree-dirrow" style=${{ '--depth': depth }} onClick=${() => toggleDir(n.path)} title=${n.path}>
          <span class=${`cd-tree-caret${isClosed ? '' : ' open'}`} aria-hidden="true"><${Icon} name="chevron" size=${12} /></span>
          <span class="cd-tree-name">${n.name}</span>
        </button>
        ${isClosed ? null : html`<ul role="group">${renderNodes(n.children, depth + 1)}</ul>`}
      </li>`;
    }
    const f = n.file;
    const st = changes ? fileStatus(f.change) : fileStatus(f.status);
    const open_ = counts.get(f.path) || 0;
    const active = c.active === f.path;
    return html`<li key=${`f:${f.path}`} role="treeitem">
      <button type="button" class=${`cd-tree-row cd-tree-file${active ? ' active' : ''}`} style=${{ '--depth': depth }}
        data-testid=${CODE_TESTID.fileRow} data-path=${f.path} aria-current=${active ? 'true' : undefined}
        title=${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} onClick=${() => open(f.path)}>
        <span class=${`cd-status tone-${st.tone}`} aria-label=${st.label}>${st.letter}</span>
        <span class="cd-tree-name">${n.name}</span>
        ${f.binary ? html`<span class="cd-stub-badge" title="Binary file: comment on the whole file">bin</span>`
          : f.tooLarge ? html`<span class="cd-stub-badge" title="Too large to show: comment on the whole file">large</span>` : null}
        <span class="cd-tree-counts">
          ${f.added ? html`<span class="ins-text">+${f.added}</span>` : null}
          ${f.removed ? html`<span class="del-text">−${f.removed}</span>` : null}
        </span>
        ${open_ ? html`<span class="badge tone-accent" title=${`${open_} open thread${open_ === 1 ? '' : 's'}`}>${open_}</span>` : null}
      </button>
    </li>`;
  });

  return html`<div class="rail-inner code-tree" data-testid=${CODE_TESTID.fileTree}>
    <section aria-label="Changed files">
      <h2 class="rail-title">${changes ? `Changed v${base} → v${v}` : 'Files'}
        ${c.list?.status === 'ok' ? html` <span class="cd-tree-total">${c.filter ? `${shown.length}/` : ''}${files.length}</span>` : null}</h2>
      <input type="search" class="cd-filter" placeholder="Filter files" aria-label="Filter files" value=${c.filter}
        onInput=${(/** @type {any} */ e) => setFilter(e.currentTarget.value)}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Escape' && c.filter) {
            e.preventDefault();
            setFilter('');
          }
        }} />
      ${c.list?.status === 'loading' || !c.list ? html`<p class="small muted">Loading files…</p>` : null}
      ${c.list?.status === 'error' ? html`<p class="small error" role="alert">${c.list.error}
        <button type="button" class="link-btn" onClick=${() => loadList(v, base, { retry: true })}>Retry</button></p>` : null}
      ${c.list?.status === 'ok' && !files.length ? html`<p class="small muted">${changes ? 'No files changed between these rounds.' : 'No changed files.'}</p>` : null}
      ${c.list?.status === 'ok' && files.length && !shown.length ? html`<p class="small muted">No file matches.</p>` : null}
      ${tree.length ? html`<ul class="cd-tree" role="tree" aria-label="Files">${renderNodes(tree, 0)}</ul>` : null}
      ${skipped.length ? html`<p class="small muted cd-tree-skipped" title=${skipped.map((/** @type {any} */ k) => `${k.path} (${k.reason})`).join('\n')}>
        ${skipped.length} file${skipped.length === 1 ? '' : 's'} not in the review</p>` : null}
    </section>
    <${Rounds} ds=${ds} version=${s.version} />
  </div>`;
}

/** The review's rounds (newest first), like the outline rail's history. @param {{ ds: any, version: number|'live'|null }} props */
function Rounds({ ds, version }) {
  const vs = versionNumbers(ds).slice().reverse().slice(0, 12);
  if (vs.length < 2) return null;
  return html`<section class="mini-history" aria-label="Rounds">
    <h2 class="rail-title">Rounds</h2>
    <ul>
      ${vs.map((n) => {
        const meta = (ds.versions || []).find((/** @type {any} */ x) => Number(x.v) === n);
        const current = version === n;
        return html`<li key=${n}>
          <button type="button" class=${`mini-version ${current ? 'active' : ''}`} aria-current=${current ? 'true' : undefined}
            onClick=${() => switchVersion(n)} title=${meta?.summary || ''}>
            <strong>v${n}</strong>
            <span class="mini-author">${actorLabel(meta?.author)}</span>
            ${ds.doc.final?.version === n ? html`<span class="badge tone-ok">FINAL</span>` : null}
            <span class="mini-time">${relTime(meta?.createdAt)}</span>
          </button>
        </li>`;
      })}
    </ul>
    <button type="button" class="link-btn" onClick=${() => setMode('history')}>Full history</button>
  </section>`;
}
