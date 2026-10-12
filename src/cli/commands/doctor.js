// @ts-check
// `suiko doctor [--fix] [--json]` (design 9.2): checks the installation, the review server and the
// workspace store, printing one line per check:
//   ok    node v24.12.0
//   WARN  review server not running (it starts with `suiko open`)
//   ERR   src/daemon/main.js is missing
//   fixed removed 1 uncommitted version source of token-service
// Checks: Node version; SPECREVIEW_HOME writable and daemon.json private (0600); server health and version;
// required modules and vendored libraries present; registered workspaces still exist; for the workspace of the cwd
// (or --workspace): config readable, and per doc: working copy present, versions sequential and matching
// doc.head, leftovers of interrupted writes (fixed with --fix via the store's recoverDoc), unrecorded edits.
// --fix also chmods daemon.json to 0600 and (re)starts a missing or outdated server.
// Last, the agent integrations: per detected (or configured) agent, whether `suiko install` configured it and
// whether that configuration is current (a dry run of the installer; nothing is written).
// Exit 0 when no ERR remains, else 1.

import fs from 'node:fs';
import path from 'node:path';
import { RefusedError } from '../../core/store/errors.js';
import { ensureHome, homeDir, homePath, listWorkspaces } from '../../core/store/home.js';
import { Store } from '../../core/store/store.js';
import { findWorkspace } from '../../core/store/workspace.js';
import { EXIT } from '../../shared/protocol.js';
import { VENDOR_DOC, VENDOR_UI, listVendorDirs } from '../../shared/vendor.js';
import { expectPositionals } from '../args.js';
import { PACKAGE_ROOT, daemonStatus, ensureDaemon, packageIdentity, packageVersion, stopDaemon } from '../daemon-client.js';
import { isCode, isVirtual, snapshotNoun } from '../../core/store/snapshot.js';

export const spec = {
  name: 'doctor',
  usage: 'doctor [--fix] [--json]',
  summary: 'Check the installation, the review server and the workspace store (--fix repairs what it can).',
  options: { fix: { type: 'boolean' } },
};

/** Files the full product needs (owned by other work packages). */
const REQUIRED_FILES = [
  'src/core/review/ops.js',
  'src/daemon/main.js',
  'src/guest/build.js',
  'src/ui/index.html',
  'src/core/render/index.js',
  'integrations/claude-code/skills/spec-review/SKILL.md',
];

/**
 * @typedef {{ level: 'ok' | 'warn' | 'err' | 'fixed', check: string, message: string }} Check
 */

/**
 * @param {import('../args.js').ParsedArgs} parsed
 */
export async function parse({ values, positionals }) {
  expectPositionals('doctor', positionals, 0, 0, spec.usage);
  return { fix: Boolean(values.fix) };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ fix?: boolean }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const fix = Boolean(input.fix);
  /** @type {Check[]} */
  const checks = [];
  /** @type {(level: Check['level'], check: string, message: string) => void} */
  const add = (level, check, message) => checks.push({ level, check, message });

  checkNode(add);
  checkHome(add, fix);
  await checkServer(rt, add, fix);
  checkFiles(add);
  await checkWorkspaces(add);
  await checkStore(rt, add, fix);
  await checkIntegrations(rt, add);

  const tag = /** @type {Record<Check['level'], string>} */ ({ ok: 'ok   ', warn: 'WARN ', err: 'ERR  ', fixed: 'fixed' });
  const errors = checks.filter((c) => c.level === 'err').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  const text = [
    ...checks.map((c) => `${tag[c.level]} ${c.message}`),
    errors || warnings ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}${fix ? '' : ' (try --fix)'}` : 'all checks passed',
  ].join('\n');
  return { exit: errors ? EXIT.ERROR : EXIT.OK, text, json: { ok: errors === 0, checks } };
}

/**
 * @param {(level: Check['level'], check: string, message: string) => void} add
 */
function checkNode(add) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > 20 || (major === 20 && minor >= 19);
  add(ok ? 'ok' : 'err', 'node', `node v${process.versions.node}${ok ? '' : ' (Suiko needs Node >= 20.19)'}`);
  add('ok', 'version', `suiko ${packageVersion()} at ${PACKAGE_ROOT}`);
}

/**
 * @param {(level: Check['level'], check: string, message: string) => void} add
 * @param {boolean} fix
 */
function checkHome(add, fix) {
  const home = homeDir();
  try {
    ensureHome();
    fs.accessSync(home, fs.constants.W_OK);
    add('ok', 'home', `home ${home} is writable`);
  } catch (err) {
    add('err', 'home', `home ${home} is not writable: ${/** @type {Error} */ (err).message}`);
    return;
  }
  const file = homePath('daemon.json');
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (process.platform !== 'win32' && mode & 0o077) {
      if (fix) {
        fs.chmodSync(file, 0o600);
        add('fixed', 'daemon.json', `daemon.json was readable by others (mode ${mode.toString(8)}); now 600`);
      } else {
        add('warn', 'daemon.json', `daemon.json holds the API token but has mode ${mode.toString(8)} (expected 600)`);
      }
    }
  } catch {
    // no daemon.json yet: fine
  }
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {(level: Check['level'], check: string, message: string) => void} add
 * @param {boolean} fix
 */
async function checkServer(rt, add, fix) {
  const status = await (rt.deps.daemonStatus ?? daemonStatus)();
  const version = packageVersion();
  const { root, build } = packageIdentity();
  if (status.running && status.info) {
    const where = `http://127.0.0.1:${status.info.uiPort} (content ${status.info.contentPort}, pid ${status.health?.pid ?? status.info.pid})`;
    const otherVersion = Boolean(status.health?.version && status.health.version !== version);
    if (otherVersion || status.health?.build !== build) {
      // Same version but another build: another checkout (daemon.json `root`), or this one before its code changed.
      const other = otherVersion
        ? `version ${status.health?.version}, this CLI is ${version}`
        : status.info.root && status.info.root !== root
          ? `the code in ${status.info.root}, not ${root}`
          : 'code that has changed since it started';
      if (fix) {
        await (rt.deps.stopDaemon ?? stopDaemon)({});
        const info = await rt.ensureDaemon();
        add('fixed', 'server', `restarted the review server (it ran ${other}) at http://127.0.0.1:${info.uiPort}`);
      } else {
        add('warn', 'server', `review server ${where} runs ${other} (restarts on next open)`);
      }
    } else {
      add('ok', 'server', `review server running at ${where}`);
    }
    return;
  }
  if (fix) {
    try {
      const info = await rt.ensureDaemon();
      add('fixed', 'server', `started the review server at http://127.0.0.1:${info.uiPort} (pid ${info.pid})`);
    } catch (err) {
      add('err', 'server', `could not start the review server: ${/** @type {Error} */ (err).message}`);
    }
    return;
  }
  const ports = status.info ? ` (last ports ${status.info.uiPort}/${status.info.contentPort})` : '';
  add('warn', 'server', `review server not running${ports}; it starts automatically with \`suiko open\``);
}

/**
 * @param {(level: Check['level'], check: string, message: string) => void} add
 */
function checkFiles(add) {
  const missing = REQUIRED_FILES.filter((rel) => !fs.existsSync(path.join(PACKAGE_ROOT, rel)));
  if (missing.length) for (const rel of missing) add('err', 'files', `${rel} is missing (incomplete installation)`);
  else add('ok', 'files', 'engine, server, guest, UI and integration files present');
  const vendors = { ...listVendorDirs(VENDOR_UI), ...listVendorDirs(VENDOR_DOC) };
  const absent = Object.entries(vendors).filter(([, dir]) => !dir);
  if (absent.length) add('err', 'vendor', `vendored libraries missing: ${absent.map(([p]) => p).join(', ')} (run npm install)`);
  else add('ok', 'vendor', `${Object.keys(vendors).length} vendored libraries present`);
}

/**
 * @param {(level: Check['level'], check: string, message: string) => void} add
 */
async function checkWorkspaces(add) {
  const all = await listWorkspaces();
  const gone = all.filter((w) => !w.exists);
  add(gone.length ? 'warn' : 'ok', 'workspaces', `${all.length} registered workspace${all.length === 1 ? '' : 's'}${gone.length ? `; ${gone.length} no longer exist: ${gone.map((w) => w.root).join(', ')}` : ''}`);
}

/**
 * Which agents have Suiko configured (user scope), from a dry run of the multi-agent installer. Skipped when the
 * home directory is unknown (the installer never guesses it).
 * @param {import('../runtime.js').Runtime} rt
 * @param {(level: Check['level'], check: string, message: string) => void} add
 */
async function checkIntegrations(rt, add) {
  if (!(rt.deps.home ?? rt.env.HOME ?? rt.env.USERPROFILE)) return;
  try {
    const { buildContext, integrationStatus } = await import('../install/multi.js');
    const list = integrationStatus(buildContext(rt, { scope: 'user' }));
    if (!list.length) {
      add('ok', 'integrations', 'agents: none detected (`suiko install --only <agent>` configures one anyway)');
      return;
    }
    for (const s of list) {
      const check = `integration:${s.id}`;
      if (s.problem) add('warn', check, `${s.name}: ${s.problem}`);
      else if (s.plugin) add('ok', check, `${s.name}: Suiko plugin installed (${s.plugin})`);
      else if (s.configured && s.upToDate) add('ok', check, `${s.name}: Suiko configured`);
      else if (s.configured) add('warn', check, `${s.name}: Suiko configuration is incomplete or outdated (run \`suiko install --only ${s.id} --apply\`)`);
      else add('ok', check, `${s.name}: detected, Suiko not configured (\`suiko install --only ${s.id}\` shows what it would add)`);
    }
  } catch (err) {
    add('warn', 'integrations', `could not check the agent integrations: ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {(level: Check['level'], check: string, message: string) => void} add
 * @param {boolean} fix
 */
async function checkStore(rt, add, fix) {
  /** @type {import('../../core/store/workspace.js').WorkspaceInfo} */
  let ws;
  try {
    ws = await findWorkspace(rt.workspace ?? rt.cwd, { create: false, explicitRoot: rt.workspace ?? null });
  } catch (err) {
    if (err instanceof RefusedError) add('ok', 'workspace', `no workspace for ${rt.cwd} (${err.message.split(';')[0]})`);
    else add('warn', 'workspace', `workspace lookup failed: ${/** @type {Error} */ (err).message}`);
    return;
  }
  if (!ws.exists) {
    add('ok', 'workspace', `no .specreview store at ${ws.root} (nothing tracked here)`);
    return;
  }
  /** @type {Store} */
  let store;
  try {
    store = await Store.open(ws.root);
    await store.config();
  } catch (err) {
    add('err', 'workspace', `store at ${ws.storeDir} is unreadable: ${/** @type {Error} */ (err).message}`);
    return;
  }
  const docs = await store.listDocs();
  add('ok', 'workspace', `workspace ${ws.root} (${ws.wsId}): ${docs.length} doc${docs.length === 1 ? '' : 's'}`);
  for (const doc of docs) await checkDoc(store, doc, add, fix);
}

/**
 * @param {Store} store
 * @param {any} doc
 * @param {(level: Check['level'], check: string, message: string) => void} add
 * @param {boolean} fix
 */
async function checkDoc(store, doc, add, fix) {
  const id = doc.id;
  const leftovers = findLeftovers(store, id);
  if (leftovers.length) {
    if (fix) {
      const r = await store.recoverDoc(id);
      const n = r.removedSources.length + r.removedTmp.length + r.removedThreads.length;
      add('fixed', `doc:${id}`, `${id}: removed ${n} leftover file${n === 1 ? '' : 's'} of interrupted writes${r.head ? `; head ${r.head.from} -> ${r.head.to}` : ''}`);
    } else {
      add('warn', `doc:${id}`, `${id}: ${leftovers.length} leftover file${leftovers.length === 1 ? '' : 's'} of interrupted writes (${leftovers.slice(0, 3).join(', ')})`);
    }
  }
  const versions = await store.listVersions(id);
  const nums = versions.map((m) => m.v);
  const sequential = nums.every((v, i) => v === i + 1);
  const last = nums.length ? nums[nums.length - 1] : 0;
  if (!sequential) add('err', `doc:${id}`, `${id}: versions are not sequential (${nums.map((v) => `v${v}`).join(' ')})`);
  else if (last !== doc.head) {
    if (fix) {
      const r = await store.recoverDoc(id);
      add('fixed', `doc:${id}`, `${id}: head repaired${r.head ? ` (${r.head.from} -> ${r.head.to})` : ''}`);
    } else {
      add('warn', `doc:${id}`, `${id}: doc.json head v${doc.head} but the newest version is v${last}`);
    }
  }
  if (isVirtual(doc)) {
    // no working file: its versions are its content (a code review's rounds capture repo files)
    add('ok', `doc:${id}`, `${id}: ${isCode(doc) ? 'a code review' : snapshotNoun(doc)} head v${doc.head} (${doc.state})`);
    return;
  }
  /** @type {string} */
  let abs;
  try {
    abs = store.workingPath(doc);
  } catch (err) {
    add('err', `doc:${id}`, `${id}: ${/** @type {Error} */ (err).message}`);
    return;
  }
  if (!fs.existsSync(abs)) {
    add('warn', `doc:${id}`, `${id}: working copy ${doc.path} is missing`);
    return;
  }
  let dirty = false;
  try {
    const head = versions.find((m) => m.v === doc.head);
    if (head) dirty = (await store.readWorking(doc)).sha256 !== head.sha256;
  } catch {
    // unreadable working copy: reported by the engine when used
  }
  add('ok', `doc:${id}`, `${id}: ${doc.path} head v${doc.head} (${doc.state})${dirty ? ' · working copy has unrecorded edits' : ''}`);
}

/**
 * Version sources without manifests and *.tmp-* files in a doc's directories.
 * @param {Store} store
 * @param {string} docId
 * @returns {string[]}
 */
function findLeftovers(store, docId) {
  const out = [];
  const docDir = store.docDir(docId);
  for (const sub of ['', 'versions', 'threads', 'reviews', 'locks', 'attachments']) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(docDir, sub));
    } catch {
      continue;
    }
    for (const name of names) {
      if (/\.tmp-/.test(name)) out.push(path.posix.join(sub, name));
      else if (sub === 'versions') {
        const m = /^(\d{4,})\.([a-z0-9]+)$/i.exec(name);
        if (m && m[2] !== 'json' && !names.includes(`${m[1]}.json`)) out.push(path.posix.join(sub, name));
      }
    }
  }
  return out;
}
