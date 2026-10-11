// @ts-check
// The per-user SpecReview home (SPECREVIEW_HOME, default ~/.specreview): daemon info, the workspace registry and
// all volatile runtime state (BUILD_AMENDMENTS 2.1). Layout:
//   <home>/daemon.json (0600)   {pid, uiPort, contentPort, token, secret, version, startedAt}
//   <home>/workspaces.json      {schema:1, workspaces: {<wsId>: {root, addedAt}}}
//   <home>/daemon.log
//   <home>/locks/               home-level locks (workspace registry)
//   <home>/ws/<wsId>/...        per-workspace runtime state (see Store.runtimeDir)
// wsId = first 8 hex characters of sha256(realpath(workspace root)).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson, exists } from './atomic.js';
import { withLock } from './lock.js';
import { shortHash } from '../util/hash.js';
import { nowIso } from '../util/time.js';

const DAEMON_FILE = 'daemon.json';
const WORKSPACES_FILE = 'workspaces.json';

/**
 * Absolute path of the SpecReview home. Not created here (see ensureHome).
 * @returns {string}
 */
export function homeDir() {
  const env = process.env.SPECREVIEW_HOME;
  return env ? path.resolve(env) : path.join(os.homedir(), '.specreview');
}

/**
 * Path inside the home: homePath('daemon.log').
 * @param {...string} parts
 * @returns {string}
 */
export function homePath(...parts) {
  return path.join(homeDir(), ...parts);
}

/**
 * Creates the home directory (mode 0700) if needed and returns it.
 * @returns {string}
 */
export function ensureHome() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** @returns {string} */
export function daemonLogPath() {
  return homePath('daemon.log');
}

/**
 * Workspace id of a root directory (realpath'd when it exists).
 * @param {string} root
 * @returns {string}
 */
export function wsIdOf(root) {
  let real = path.resolve(root);
  try {
    real = fs.realpathSync(real);
  } catch {
    // not created yet: hash the resolved path
  }
  return shortHash(real, 8);
}

/**
 * @typedef {import('../../shared/types.js').DaemonInfo} DaemonInfo
 */

/**
 * Reads daemon.json; null when absent or unreadable.
 * @returns {Promise<DaemonInfo | null>}
 */
export async function readDaemonInfo() {
  try {
    return await readJson(homePath(DAEMON_FILE));
  } catch {
    return null;
  }
}

/**
 * Writes daemon.json atomically with mode 0600 (it holds the API token and the content secret).
 * @param {DaemonInfo} info
 */
export async function writeDaemonInfo(info) {
  ensureHome();
  await writeJson(homePath(DAEMON_FILE), info, { mode: 0o600 });
}

/**
 * Removes daemon.json (used by `stop`); missing is fine.
 */
export async function removeDaemonInfo() {
  await fsp.rm(homePath(DAEMON_FILE), { force: true });
}

/**
 * @typedef {{ schema: number, workspaces: Record<string, { root: string, addedAt: string }> }} WorkspaceRegistry
 */

/** @returns {Promise<WorkspaceRegistry>} */
async function readRegistry() {
  /** @type {any} */
  let reg = null;
  try {
    reg = await readJson(homePath(WORKSPACES_FILE));
  } catch {
    reg = null; // corrupt registry: rebuilt by the next registration
  }
  const workspaces = reg && typeof reg.workspaces === 'object' && reg.workspaces ? reg.workspaces : {};
  return { schema: 1, workspaces };
}

/**
 * Registers a workspace root (idempotent) and returns its wsId. Only writes when something changed.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function registerWorkspace(root) {
  const real = await fsp.realpath(root);
  const wsId = shortHash(real, 8);
  const current = await readRegistry();
  if (current.workspaces[wsId]?.root === real) return wsId;
  ensureHome();
  await withLock(homePath('locks', 'workspaces'), async () => {
    const reg = await readRegistry();
    if (reg.workspaces[wsId]?.root === real) return;
    reg.workspaces[wsId] = { root: real, addedAt: reg.workspaces[wsId]?.addedAt ?? nowIso() };
    /** @type {WorkspaceRegistry['workspaces']} */
    const sorted = {};
    for (const id of Object.keys(reg.workspaces).sort()) sorted[id] = reg.workspaces[id];
    await writeJson(homePath(WORKSPACES_FILE), { schema: 1, workspaces: sorted });
  }, { timeoutMs: 10000 });
  return wsId;
}

/**
 * Root of a registered workspace, or null.
 * @param {string} wsId
 * @returns {Promise<string | null>}
 */
export async function workspaceRoot(wsId) {
  const reg = await readRegistry();
  return reg.workspaces[wsId]?.root ?? null;
}

/**
 * All registered workspaces, sorted by root. `exists` tells whether `<root>/.specreview` is still there.
 * @returns {Promise<Array<{ wsId: string, root: string, addedAt: string, exists: boolean }>>}
 */
export async function listWorkspaces() {
  const reg = await readRegistry();
  const out = [];
  for (const [wsId, entry] of Object.entries(reg.workspaces)) {
    if (!entry || typeof entry.root !== 'string') continue;
    out.push({ wsId, root: entry.root, addedAt: entry.addedAt, exists: await exists(path.join(entry.root, '.specreview')) });
  }
  return out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}
