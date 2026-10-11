// @ts-check
// Which code a process runs: the package folder (real path) and a fingerprint of its code files. The daemon reports
// both in daemon.json and /api/health; the CLI reuses a running daemon only when they match its own, so a daemon
// started from another checkout (all report the same package version), or before the code changed (git pull, an
// edit), is restarted instead of serving code the CLI does not match.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash.js';

/** What the fingerprint covers, relative to the package folder. node_modules changes need a version bump. */
const CODE_ENTRIES = ['package.json', 'bin', 'src'];

/**
 * @param {string} packageRoot
 * @returns {{ root: string, build: string }} root: real path of the package folder; build: 16 hex characters over the
 *   relative path, size and mtime of every file under package.json, bin/ and src/ (stat only, no reads; about 200
 *   files, a few ms). Not cached: the daemon takes it once at startup, the CLI when it looks for a daemon.
 */
export function codeIdentity(packageRoot) {
  let root = path.resolve(packageRoot);
  try {
    root = fs.realpathSync(root);
  } catch {
    // keep the resolved path
  }
  /** @type {string[]} */
  const lines = [];
  /** @param {string} rel */
  const visit = (rel) => {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(abs).sort();
      } catch {
        return;
      }
      for (const name of names) visit(path.join(rel, name));
    } else if (st.isFile()) {
      lines.push(`${rel.split(path.sep).join('/')}\t${st.size}\t${st.mtimeMs}`);
    }
  };
  for (const entry of CODE_ENTRIES) visit(entry);
  return { root, build: sha256(`${root}\n${lines.join('\n')}`).slice(0, 16) };
}
