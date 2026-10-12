// @ts-check
// The code review's banner (KindBanners): when the working tree no longer matches the newest round (the daemon's
// poller sends working.changed {dirty, changedFiles}), "Files changed since vN: <files>" with Re-snapshot, which
// records the working tree as a new round (POST D/record through recordWorkingCopy). The generic banner stack
// (older version, new head, approved, closed) follows below it.

import { html, useState } from 'preact-htm';
import { CODE_TESTID } from 'protocol';
import { recordWorkingCopy } from '../../actions.js';
import { Banners } from '../Banners.js';

/** Files named in the banner before "+N more". */
const NAMED = 3;

/** @param {{ ds: any }} props */
export function CodeBanner({ ds }) {
  const [busy, setBusy] = useState(false);
  const w = ds?.working || {};
  const files = /** @type {string[]} */ (Array.isArray(w.changedFiles) ? w.changedFiles : []);
  const head = Number(ds?.doc?.head) || 1;
  const resnapshot = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await recordWorkingCopy('Re-snapshot of the working tree');
    } finally {
      setBusy(false);
    }
  };
  return html`
    ${w.dirty ? html`<div class="banners"><div class="banner banner-warn" role="status" data-code-dirty>
      <span><strong>Files changed since v${head}</strong>${files.length
        ? html`: <span class="mono">${files.slice(0, NAMED).join(', ')}</span>${files.length > NAMED ? ` (+${files.length - NAMED} more)` : ''}`
        : ' in the working tree'}. Re-snapshot to review them as a new round.</span>
      <span class="banner-actions">
        <button type="button" class="btn btn-sm btn-primary" data-testid=${CODE_TESTID.resnapshot} disabled=${busy} aria-busy=${busy ? 'true' : undefined}
          onClick=${resnapshot}>${busy ? 'Recording…' : 'Re-snapshot'}</button>
      </span>
    </div></div>` : null}
    <${Banners} />`;
}
