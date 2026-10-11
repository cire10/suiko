// @ts-check
// Claude Code hook entry points (design 9.9, amendments 2.4 + 5): `specreview hook pre-write` (PreToolUse, matcher
// Write) and `specreview hook prompt` (UserPromptSubmit).
//
// Hard constraints: this module imports only node:* builtins (bin/specreview.js loads it before anything else),
// reads JSON files only (no store library, no recovery, no locks), never throws, prints nothing on error, always
// exits 0 and finishes well under 150 ms. It walks up from the file (pre-write) or the session cwd (prompt) with
// statSync looking for a `.specreview` directory and returns at once when there is none.
//
// pre-write: if the Write targets a tracked doc that has at least one review, is not closed, and
//   guards.writeHook != 'off', compare the new content with the file on disk. When more than guards.writeHookRatio
//   (0.4) of the file's non-blank lines would disappear, answer permissionDecision 'deny' ('ask' in 'warn' mode).
//   Changed-line heuristic (no LCS): count the non-blank old lines (trailing whitespace ignored) that are not
//   present in the multiset of new lines.
// prompt: for each doc of the workspace (not closed), add context when (a) a submitted review was not delivered
//   to this agent and no live `wait` of this agent listens on that doc (or on `_all`), or (b) a review was
//   delivered to this agent more than 5 minutes ago and never acknowledged. Agent = $SPECREVIEW_AGENT, else
//   'claude' (the same rule as the engine's undeliveredReviews(reviews, agent)).
//   Output is capped at 1,000 characters. When the cwd has no workspace at or above it (no git: `.specreview/`
//   lives next to the specs, e.g. in notes/specs/), the registered workspaces (<SPECREVIEW_HOME>/workspaces.json,
//   written by the user's own `specreview open`) whose root is inside the cwd are checked instead, nearest first
//   (at most MAX_RELATED), and their notes name the workspace: `specreview feedback <id> --workspace <dir>`.
// Untrusted input: `.specreview/` is committed, so a cloned repo can hold any JSON. Only schema-valid tokens reach
//   the agent's context: doc ids must match DOC_ID_RE (the store's rule), doc.head must be a safe integer >= 0,
//   review ids come from the rvN.json file name (never the JSON body), verdicts are mapped through VERDICT_TEXT
//   (unknown values are dropped), thread ids must look like tN; records that fail are skipped.
// Layout read here (BUILD_AMENDMENTS 2.1): <root>/.specreview/{config.json, docs/<id>/{doc.json, reviews/rvN.json,
// threads/tN.json, locks/LN.json}} and <SPECREVIEW_HOME>/ws/<wsId>/waiters/<docId|_all>/<pid>.json, with
// wsId = sha256(realpath(root)).slice(0, 8).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_DIR = '.specreview';
const WAITER_LIVE_MS = 30000;
const UNACKED_AFTER_MS = 5 * 60 * 1000;
const MAX_CONTEXT_CHARS = 1000;
const MAX_RELATED = 8;
const MAX_STDIN_BYTES = 64 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 3000;
const DEFAULT_RATIO = 0.4;
/** Doc ids as the store accepts them (src/core/store/store.js DOC_ID_RE; this module imports node builtins only). */
const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const THREAD_ID_RE = /^t\d+$/;

const VERDICT_TEXT = /** @type {Record<string, string>} */ ({
  comment: 'COMMENT',
  changes_requested: 'CHANGES REQUESTED',
  approved: 'APPROVED',
});

/**
 * @typedef {object} HookIO
 * @property {NodeJS.ReadableStream & { isTTY?: boolean }} [stdin]
 * @property {NodeJS.WritableStream} [stdout]
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [cwd]
 * @property {number} [now] current time in ms (tests)
 */

/**
 * Runs one hook. Never throws; prints the hook JSON only when there is something to say.
 * @param {string} name 'pre-write' | 'prompt'
 * @param {HookIO} [io]
 * @returns {Promise<void>}
 */
export async function runHook(name, io = {}) {
  try {
    const stdin = io.stdin ?? process.stdin;
    const stdout = io.stdout ?? process.stdout;
    const env = io.env ?? process.env;
    const cwd = io.cwd ?? process.cwd();
    const now = io.now ?? Date.now();
    if (name !== 'pre-write' && name !== 'prompt') return;
    const raw = await readStdin(stdin);
    if (!raw) return;
    /** @type {any} */
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const out = name === 'pre-write' ? preWrite(input, { env, cwd }) : prompt(input, { env, cwd, now });
    if (out) await writeOut(stdout, `${JSON.stringify(out)}\n`);
  } catch {
    // hooks must never fail the user's tool call or prompt
  }
}

// ------------------------------------------------------------------------------------------------ pre-write

/**
 * @param {any} input PreToolUse payload {tool_name, tool_input: {file_path, content}, cwd}
 * @param {{ env: Record<string, string | undefined>, cwd: string }} o
 * @returns {object | null}
 */
export function preWrite(input, o) {
  if (input.tool_name !== undefined && input.tool_name !== 'Write') return null;
  const ti = input.tool_input;
  if (!ti || typeof ti.file_path !== 'string' || typeof ti.content !== 'string' || !ti.file_path) return null;
  const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : o.cwd;
  const file = path.resolve(base, ti.file_path);
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null; // creating a new file: not tracked
  const store = findStore(path.dirname(file), o.env);
  if (!store) return null;
  const rel = path.relative(realpath(store.root), realpath(file)).split(path.sep).join('/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  // a snapshot doc's path is synthetic: it never stands for a file on disk
  const doc = findDoc(store.storeDir, (d) => d.path === rel && d.kind !== 'snapshot');
  if (!doc || doc.state === 'closed') return null;
  const reviewIds = listIds(path.join(store.storeDir, 'docs', doc.id, 'reviews'), 'rv');
  if (!reviewIds.length) return null;

  const guards = readJsonFile(path.join(store.storeDir, 'config.json'))?.guards ?? {};
  const mode = ['deny', 'warn', 'off'].includes(guards.writeHook) ? guards.writeHook : 'deny';
  if (mode === 'off') return null;
  const threshold = typeof guards.writeHookRatio === 'number' && guards.writeHookRatio >= 0 ? guards.writeHookRatio : DEFAULT_RATIO;

  const current = fs.readFileSync(file, 'utf8');
  const ratio = changedLineRatio(current, ti.content);
  if (ratio <= threshold) return null;

  const docDir = path.join(store.storeDir, 'docs', doc.id);
  const reviewSet = new Set(reviewIds);
  let openThreads = 0;
  for (const id of listIds(path.join(docDir, 'threads'), 't')) {
    const t = readJsonFile(path.join(docDir, 'threads', `${id}.json`));
    if (!t || t.status === 'resolved') continue;
    if (t.review && !reviewSet.has(t.review)) continue; // uncommitted submit
    openThreads++;
  }
  const locks = listIds(path.join(docDir, 'locks'), 'L').filter((id) => readJsonFile(path.join(docDir, 'locks', `${id}.json`))?.active !== false);
  const facts = [`v${doc.head}`, `${openThreads} open thread${openThreads === 1 ? '' : 's'}`];
  if (locks.length) facts.push(`${locks.join(', ')} locked`);
  const reason =
    `${rel} is under SpecReview (${facts.join(', ')}); this Write would replace ${Math.round(ratio * 100)}% of its lines. ` +
    'Use Edit for targeted changes (or specreview apply/edit). If the user explicitly asked for a full rewrite, use ' +
    '`specreview revise --allow-rewrite` after writing with Edit.';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: mode === 'warn' ? 'ask' : 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Share of the old text's non-blank lines (trailing whitespace ignored) missing from the new text's line multiset.
 * @param {string} oldText
 * @param {string} newText
 * @returns {number} 0..1
 */
export function changedLineRatio(oldText, newText) {
  /** @type {Map<string, number>} */
  const pool = new Map();
  for (const line of newText.split('\n')) {
    const k = line.trimEnd();
    if (k) pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  let total = 0;
  let missing = 0;
  for (const line of oldText.split('\n')) {
    const k = line.trimEnd();
    if (!k) continue;
    total++;
    const n = pool.get(k);
    if (n) pool.set(k, n - 1);
    else missing++;
  }
  return missing / Math.max(1, total);
}

// ------------------------------------------------------------------------------------------------ prompt

/**
 * @param {any} input UserPromptSubmit payload {prompt, cwd, session_id}
 * @param {{ env: Record<string, string | undefined>, cwd: string, now: number }} o
 * @returns {object | null}
 */
export function prompt(input, o) {
  const base = path.resolve(typeof input.cwd === 'string' && input.cwd ? input.cwd : o.cwd);
  const nearest = findStore(base, o.env);
  /** @type {Array<{ root: string, storeDir: string, flag: string }>} */
  const stores = nearest ? [{ ...nearest, flag: '' }] : registeredBelow(base, o.env);
  if (!stores.length) return null;
  const agent = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.env.SPECREVIEW_AGENT ?? '') ? /** @type {string} */ (o.env.SPECREVIEW_AGENT) : 'claude';
  /** @type {string[]} */
  const notes = [];
  for (const store of stores) notes.push(...storeNotes(store, agent, o));
  if (!notes.length) return null;
  let text = notes.join('\n');
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

/**
 * The prompt notes of one workspace. `flag` is appended to the suggested command (' --workspace <dir>' for a
 * workspace below the cwd, '' for the cwd's own).
 * @param {{ root: string, storeDir: string, flag: string }} store
 * @param {string} agent
 * @param {{ env: Record<string, string | undefined>, now: number }} o
 * @returns {string[]}
 */
function storeNotes(store, agent, o) {
  const wsId = crypto.createHash('sha256').update(realpath(store.root)).digest('hex').slice(0, 8);
  const waitersBase = path.join(specreviewHome(o.env), 'ws', wsId, 'waiters');
  const listeningAll = hasLiveWaiter(path.join(waitersBase, '_all'), agent);

  /** @type {string[]} */
  const notes = [];
  for (const doc of listDocs(store.storeDir)) {
    if (doc.state === 'closed') continue;
    // plan snapshots are answered through the plan gate (ExitPlanMode), never by `specreview feedback`
    if (doc.kind === 'snapshot' && doc.origin?.type === 'plan') continue;
    const reviewsDir = path.join(store.storeDir, 'docs', doc.id, 'reviews');
    // the id is the file name (rvN), never the JSON body's own `id` field
    const reviews = listIds(reviewsDir, 'rv')
      .map((id) => ({ id, r: readJsonFile(path.join(reviewsDir, `${id}.json`)) }))
      .filter(({ r }) => isRecord(r))
      .map(({ id, r }) => ({ ...r, id }));
    if (!reviews.length) continue;
    const undelivered = reviews.filter((r) => !own(r.deliveredTo, agent));
    if (undelivered.length && !listeningAll && !hasLiveWaiter(path.join(waitersBase, doc.id), agent)) {
      notes.push(undeliveredNote(doc, undelivered, store.flag));
      continue;
    }
    const unacked = reviews.filter((r) => {
      const at = Date.parse(String(own(r.deliveredTo, agent) ?? ''));
      return Number.isFinite(at) && o.now - at > UNACKED_AFTER_MS && !own(r.ackedBy, agent);
    });
    if (unacked.length) notes.push(unackedNote(doc, unacked, agent, store.flag));
  }
  return notes;
}

/**
 * @param {any} doc
 * @param {any[]} reviews
 * @param {string} flag
 * @returns {string}
 */
function undeliveredNote(doc, reviews, flag) {
  const last = reviews[reviews.length - 1];
  const many = reviews.length > 1;
  return (
    `specreview: review${many ? 's' : ''} ${reviews.map((r) => r.id).join(', ')} on ${doc.id} (${reviewFacts(reviews)}) ` +
    `${many ? 'were' : 'was'} submitted ${many ? 'last ' : ''}at ${clock(last.submittedAt)} and not delivered. ` +
    `Run \`specreview feedback ${doc.id}${flag}\` and address it per the spec-review skill.`
  );
}

/**
 * @param {any} doc
 * @param {any[]} reviews
 * @param {string} agent
 * @param {string} flag
 * @returns {string}
 */
function unackedNote(doc, reviews, agent, flag) {
  const last = reviews[reviews.length - 1];
  const many = reviews.length > 1;
  return (
    `specreview: review${many ? 's' : ''} ${reviews.map((r) => r.id).join(', ')} on ${doc.id} (${reviewFacts(reviews)}) ` +
    `${many ? 'were' : 'was'} delivered to ${agent} at ${clock(own(last.deliveredTo, agent))} but not acted on yet. ` +
    `If the feedback packet was lost, run \`specreview feedback ${doc.id}${flag}\`, then address it per the spec-review skill.`
  );
}

/**
 * '2 threads, CHANGES REQUESTED' for a set of reviews (verdict of the newest; an unknown verdict is left out).
 * @param {any[]} reviews
 * @returns {string}
 */
function reviewFacts(reviews) {
  const threads = new Set();
  /** @param {unknown} t */
  const add = (t) => {
    if (typeof t === 'string' && THREAD_ID_RE.test(t)) threads.add(t);
  };
  for (const r of reviews) {
    for (const t of Array.isArray(r.newThreads) ? r.newThreads : []) add(t);
    for (const t of Array.isArray(r.reopened) ? r.reopened : []) add(t);
    for (const x of Array.isArray(r.replies) ? r.replies : []) add(x?.thread);
  }
  const verdict = own(VERDICT_TEXT, reviews[reviews.length - 1].verdict);
  return `${threads.size} thread${threads.size === 1 ? '' : 's'}${typeof verdict === 'string' ? `, ${verdict}` : ''}`;
}

/**
 * Local HH:MM of an ISO time ('?' when invalid).
 * @param {unknown} iso
 * @returns {string}
 */
function clock(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '?';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A live waiter of `agent` in a waiters dir: heartbeat < 30 s old, pid alive, not superseded.
 * @param {string} dir
 * @param {string} agent
 * @returns {boolean}
 */
function hasLiveWaiter(dir, agent) {
  for (const name of readDir(dir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const w = readJsonFile(path.join(dir, name));
    if (!w || w.agent !== agent || w.supersededBy) continue;
    const beat = Date.parse(w.heartbeatAt ?? '');
    if (!Number.isFinite(beat) || Date.now() - beat >= WAITER_LIVE_MS) continue;
    if (pidAlive(w.pid)) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ store reading

/**
 * Nearest ancestor (inclusive) with a `.specreview` directory, skipping the one directly in the user's home and
 * the runtime home itself (same rule as src/core/store/workspace.js).
 * @param {string} startDir
 * @param {Record<string, string | undefined>} env
 * @returns {{ root: string, storeDir: string } | null}
 */
export function findStore(startDir, env) {
  const userHome = path.resolve(os.homedir());
  const runtimeHome = specreviewHome(env);
  for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, STORE_DIR);
    const st = fs.statSync(candidate, { throwIfNoEntry: false });
    if (st && st.isDirectory() && dir !== userHome && candidate !== runtimeHome && !samePath(candidate, runtimeHome)) {
      return { root: dir, storeDir: candidate };
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Registered workspaces (<SPECREVIEW_HOME>/workspaces.json) whose root lies strictly inside `cwd` and still has a
 * `.specreview` directory, nearest first, at most MAX_RELATED. Nothing for the user's home or the filesystem root
 * (never workspace roots; the same rule as the CLI's relatedWorkspaceRoots). Each gets the `--workspace <dir>` flag
 * (relative to the cwd, shell-quoted when needed) that makes `specreview feedback <id>` unambiguous from the cwd.
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 * @returns {Array<{ root: string, storeDir: string, flag: string }>}
 */
export function registeredBelow(cwd, env) {
  const here = realpath(cwd);
  if (path.parse(here).root === here || here === realpath(os.homedir())) return [];
  const reg = readJsonFile(path.join(specreviewHome(env), 'workspaces.json'));
  const entries = isRecord(reg) && isRecord(reg.workspaces) ? Object.values(reg.workspaces) : [];
  const runtimeHome = specreviewHome(env);
  /** @type {Array<{ root: string, storeDir: string, flag: string, depth: number }>} */
  const out = [];
  for (const e of entries) {
    const root = isRecord(e) && typeof e.root === 'string' && path.isAbsolute(e.root) ? path.resolve(e.root) : null;
    if (!root) continue;
    const rel = path.relative(here, root);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) continue;
    const storeDir = path.join(root, STORE_DIR);
    const st = fs.statSync(storeDir, { throwIfNoEntry: false });
    if (!st || !st.isDirectory() || samePath(storeDir, runtimeHome)) continue;
    out.push({ root, storeDir, flag: ` --workspace ${shellArg(rel.split(path.sep).join('/'))}`, depth: rel.split(path.sep).length });
  }
  return out
    .sort((a, b) => a.depth - b.depth || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0))
    .slice(0, MAX_RELATED)
    .map(({ depth: _depth, ...s }) => s);
}

/**
 * A shell word for `s` (single-quoted unless it is plain); the same rule as src/cli/format.js shellArg.
 * @param {string} s
 * @returns {string}
 */
function shellArg(s) {
  return /^[A-Za-z0-9_.\/@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function specreviewHome(env) {
  return env.SPECREVIEW_HOME ? path.resolve(env.SPECREVIEW_HOME) : path.join(os.homedir(), '.specreview');
}

/**
 * Tracked docs (doc.json contents with the directory name as id). Directories whose name is not a valid doc id
 * and doc.json files without a string path or a safe-integer head are skipped (their values would otherwise reach
 * the agent's context verbatim).
 * @param {string} storeDir
 * @returns {any[]}
 */
function listDocs(storeDir) {
  const docsDir = path.join(storeDir, 'docs');
  const out = [];
  for (const id of readDir(docsDir).sort()) {
    if (!DOC_ID_RE.test(id)) continue;
    const doc = readJsonFile(path.join(docsDir, id, 'doc.json'));
    if (!isRecord(doc) || typeof doc.path !== 'string' || !Number.isSafeInteger(doc.head) || doc.head < 0) continue;
    out.push({ ...doc, id });
  }
  return out;
}

/**
 * @param {string} storeDir
 * @param {(doc: any) => boolean} pred
 * @returns {any | null}
 */
function findDoc(storeDir, pred) {
  return listDocs(storeDir).find(pred) ?? null;
}

/**
 * Ids like rv3 / t12 / L1 from `<id>.json` files in a dir, in numeric order.
 * @param {string} dir
 * @param {string} prefix
 * @returns {string[]}
 */
function listIds(dir, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)\\.json$`);
  return readDir(dir)
    .map((name) => re.exec(name))
    .filter((m) => m !== null)
    .map((m) => /** @type {RegExpExecArray} */ (m))
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => `${prefix}${m[1]}`);
}

/**
 * A plain JSON object (not null, not an array).
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `obj[key]` when `obj` is a plain object with that own property (never an inherited one such as `constructor`).
 * @param {unknown} obj
 * @param {unknown} key
 * @returns {unknown}
 */
function own(obj, key) {
  return isRecord(obj) && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function readDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} p
 * @returns {string}
 */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  return realpath(a) === realpath(b);
}

/**
 * @param {unknown} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

// ------------------------------------------------------------------------------------------------ I/O

/**
 * Reads stdin fully ('' for a TTY, on error, past the size cap, or when it does not end within the timeout).
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} stdin
 * @returns {Promise<string>}
 */
function readStdin(stdin) {
  if (stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let done = false;
    /** @param {string} value */
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.pause?.();
      resolve(value);
    };
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_STDIN_BYTES) finish('');
      else chunks.push(buf);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish('');
    const timer = setTimeout(() => finish(''), STDIN_TIMEOUT_MS);
    timer.unref?.();
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    stdin.resume?.();
  });
}

/**
 * @param {NodeJS.WritableStream} stream
 * @param {string} text
 * @returns {Promise<void>}
 */
function writeOut(stream, text) {
  return new Promise((resolve) => {
    try {
      stream.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}
