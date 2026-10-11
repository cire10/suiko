// @ts-check
// Per-doc crash recovery (BUILD_AMENDMENTS 2.3, design 5.4). There is no global recovery at Store.open: readers
// simply ignore uncommitted data, and mutating ops call `recoverDoc(store, docId)` inside the doc lock to delete it:
//   - version sources without a manifest (the manifest is the commit point of a version);
//   - `*.tmp-<pid>-<rand>` files of atomic writes whose pid is dead (or that are older than an hour, which also
//     covers pid reuse), in the doc's directory tree;
//   - thread files whose `review` names a review file that does not exist (a review submit that crashed before
//     its commit point; the reviewer's drafts still exist, so nothing is lost). Threads with `review: null`
//     (agent questions) are always kept;
// rolls an interrupted multi-file commit forward or back with its redo journal (`journal.json`, Store.writeJournal):
//   - its commit point (version manifest / review file) exists -> the journal is applied (re-anchored threads and
//     locks, replies, doc.json, consumed drafts, pending edits, events), so a `revise` or a review submit killed
//     after its commit point leaves no thread without an anchor at head, no lost reply and no stale pending edit;
//   - otherwise the journal is dropped (the commit never happened);
// repairs `doc.head` to the highest committed manifest, and drops a `doc.final` whose review was never committed.
// Idempotent and cheap (a few readdirs plus reading thread files).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseTmpName, readJson } from './atomic.js';
import { pidAlive } from '../util/proc.js';
import { createLogger } from '../util/log.js';

const log = createLogger('recovery');

/** Temp files older than this are removed even if their pid looks alive (pid reuse). */
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
const DOC_SUBDIRS = ['', 'versions', 'threads', 'reviews', 'locks', 'attachments'];

/**
 * @typedef {object} RecoveryReport
 * @property {string[]} removedSources version source files (doc-relative) deleted for lack of a manifest
 * @property {string[]} removedTmp temp files (doc-relative) deleted
 * @property {string[]} removedThreads thread ids deleted because their review was never committed
 * @property {{ from: number, to: number } | null} head doc.head repair, if any
 * @property {{ version?: number, review?: string, applied: boolean } | null} journal interrupted commit rolled
 *   forward (applied) or dropped
 * @property {{ review: string } | null} final doc.final dropped because its review file does not exist
 */

/**
 * @param {import('./store.js').Store} store
 * @param {string} docId
 * @returns {Promise<RecoveryReport>}
 */
export async function recoverDoc(store, docId) {
  return store.withDocLock(docId, async () => {
    /** @type {RecoveryReport} */
    const report = { removedSources: [], removedTmp: [], removedThreads: [], head: null, journal: null, final: null };
    const docDir = store.docDir(docId);

    // 1. stale temp files
    for (const sub of DOC_SUBDIRS) {
      const dir = path.join(docDir, sub);
      for (const name of await names(dir)) {
        const tmp = parseTmpName(name);
        if (!tmp) continue;
        const file = path.join(dir, name);
        if (pidAlive(tmp.pid) && !(await olderThan(file, TMP_MAX_AGE_MS))) continue;
        await fsp.rm(file, { force: true });
        report.removedTmp.push(path.posix.join(sub, name));
      }
    }

    // 2. manifest-less version sources
    const versionsDir = path.join(docDir, 'versions');
    const versionNames = await names(versionsDir);
    const manifests = new Set();
    for (const name of versionNames) {
      const m = /^(\d{4,})\.json$/.exec(name);
      if (m) manifests.add(Number(m[1]));
    }
    for (const name of versionNames) {
      const m = /^(\d{4,})\.([a-z0-9]{1,16})$/.exec(name);
      if (!m || m[2] === 'json' || manifests.has(Number(m[1]))) continue;
      await fsp.rm(path.join(versionsDir, name), { force: true });
      report.removedSources.push(`versions/${name}`);
    }

    // 2b. interrupted multi-file commit: roll forward when its commit point exists, else drop it
    const journal = await store.readJournal(docId);
    if (journal) {
      const applied = await store.journalCommitted(docId, journal);
      if (applied) await store.applyJournal(docId, journal);
      else await fsp.rm(store.journalFile(docId), { force: true });
      report.journal = { ...(journal.version != null ? { version: journal.version } : { review: journal.review }), applied };
    }

    // 3. head = highest committed manifest
    const doc = await store.getDoc(docId);
    const versions = await store.listVersions(docId);
    const maxV = versions.length ? versions[versions.length - 1].v : 0;
    if (doc && doc.head !== maxV) {
      report.head = { from: doc.head, to: maxV };
      doc.head = maxV;
      await store.saveDoc(doc);
    }

    // 4. threads of uncommitted reviews
    const reviewIds = new Set((await names(path.join(docDir, 'reviews'))).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));

    // 5. a final version marked by a review that was never committed
    const final = /** @type {any} */ (doc)?.final;
    if (doc && final && typeof final.review === 'string' && final.review && !reviewIds.has(final.review)) {
      report.final = { review: final.review };
      doc.final = null;
      if (doc.state === 'approved') doc.state = 'in_review';
      await store.saveDoc(doc);
    }
    const threadsDir = path.join(docDir, 'threads');
    for (const name of await names(threadsDir)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*\.json$/.test(name)) continue;
      let thread;
      try {
        thread = await readJson(path.join(threadsDir, name));
      } catch {
        continue; // corrupt: leave it for a human; readers skip it
      }
      if (!thread || typeof thread.review !== 'string' || !thread.review || reviewIds.has(thread.review)) continue;
      await fsp.rm(path.join(threadsDir, name), { force: true });
      report.removedThreads.push(name.slice(0, -5));
    }

    if (report.removedSources.length || report.removedTmp.length || report.removedThreads.length || report.head || report.journal || report.final) {
      log.info(`recovered ${docId}`, report);
    }
    return report;
  });
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function names(dir) {
  try {
    return (await fsp.readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * @param {string} file
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
async function olderThan(file, ms) {
  try {
    return Date.now() - (await fsp.stat(file)).mtimeMs > ms;
  } catch {
    return false;
  }
}
