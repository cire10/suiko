// @ts-check
// Claude Code transcripts (`specreview last`): finding the session's JSONL file and extracting the last assistant
// message from it. The format is internal to Claude Code and changes between versions, so everything here is
// defensive: unparseable lines (a half-written last line) and unknown shapes are skipped, never fatal.
//
// Location: ${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd slug>/<session id>.jsonl. The session is found by id with
// a glob over projects/*/ (a `cd` changes the shell's cwd, not the transcript directory); without an id (or when it
// is not found), the newest transcript of the cwd's project directory (every non-alphanumeric character of the path
// replaced by '-'; names over 200 characters are truncated and suffixed with a hash).
//
// Last assistant message (as Plannotator's extractLastRenderedMessage): follow the active branch (parentUuid chain
// from the newest entry, so a /rewind is honoured; file order when that branch has no text), walk it backwards
// skipping sidechains, meta entries, tool results, attachments and bookkeeping lines and local-command echoes, lock
// onto the newest assistant line with a non-empty text block, and collect the text blocks of the lines sharing its
// message.id (one API message spans several lines, one content block each), stopping at another message or a real
// prompt. When the current turn has no text yet (the slash command running now is the first thing in it), the walk
// simply continues into the earlier turns.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotFoundError, UsageError } from '../core/store/errors.js';

/** Transcripts larger than this are read from their tail only. */
const MAX_READ_BYTES = 64 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SKIPPED_TYPES = new Set(['queue-operation', 'progress', 'system', 'file-history-snapshot', 'attachment', 'last-prompt', 'summary', 'ai-title', 'atis-latch']);
const NOT_A_PROMPT = ['<local-command-', '<command-name>', '<command-message>', '<command-args>', '<local-command-stdout>', '<local-command-stderr>', '<system-reminder>', '<system-notification>'];

/**
 * @typedef {object} LastMessage
 * @property {string} text the message's text blocks joined by a blank line
 * @property {string} id message.id (else the uuid of its newest line)
 * @property {string | null} session sessionId of its lines
 * @property {string | null} timestamp of its newest line
 */

/**
 * Claude Code's config directory: $CLAUDE_CONFIG_DIR, else ~/.claude.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function claudeHome(env) {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(env.HOME?.trim() || os.homedir(), '.claude');
}

/**
 * The transcript to read: --transcript, else the session's file (by id: --session, else $CLAUDE_CODE_SESSION_ID),
 * else the newest transcript of the cwd's project directory.
 * @param {{ transcript?: string | null, session?: string | null, env: Record<string, string | undefined>, cwd: string }} opts
 * @returns {{ path: string, session: string | null, note: string | null }}
 */
export function findTranscript({ transcript, session, env, cwd }) {
  if (transcript) {
    const abs = path.resolve(cwd, transcript);
    if (!isFile(abs)) throw new NotFoundError(`no such transcript: ${transcript}`, { details: { path: abs } });
    return { path: abs, session: sessionOfFile(abs), note: null };
  }
  const projects = path.join(claudeHome(env), 'projects');
  const sid = (session ?? env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  let note = null;
  if (sid) {
    if (!SESSION_ID_RE.test(sid)) throw new UsageError(`invalid session id: ${JSON.stringify(sid)}`);
    const hits = subdirs(projects)
      .map((d) => path.join(projects, d, `${sid}.jsonl`))
      .filter(isFile);
    if (hits.length) return { path: newest(hits), session: sid, note: null };
    note = `no transcript for session ${sid} under ${projects}; using the newest transcript of this directory`;
  }
  const slugs = [...new Set([cwd, realpathOr(cwd)].map(projectSlug))];
  const dirs = subdirs(projects).filter((d) => slugs.some((s) => slugMatches(d, s)));
  const files = dirs.flatMap((d) => {
    const dir = path.join(projects, d);
    return listNames(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(dir, n))
      .filter(isFile);
  });
  if (!files.length) {
    throw new NotFoundError(
      `no Claude Code transcript found${sid ? ` for session ${sid}` : ''} (looked in ${projects}); pass --session <id> or --transcript <file>`,
      { details: { projects, session: sid || null } },
    );
  }
  const file = newest(files);
  return { path: file, session: sessionOfFile(file), note };
}

/**
 * The project directory name Claude Code uses for a cwd: every non-alphanumeric character replaced by '-'.
 * @param {string} cwd
 * @returns {string}
 */
export function projectSlug(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Whether a projects/ directory name is the slug (case-insensitive; a slug over 200 characters is stored truncated
 * to 200 plus a hash suffix).
 * @param {string} dirName
 * @param {string} slug
 * @returns {boolean}
 */
function slugMatches(dirName, slug) {
  const d = dirName.toLowerCase();
  const s = slug.toLowerCase();
  return d === s || (s.length > 200 && d.startsWith(s.slice(0, 200)));
}

/**
 * Reads a transcript (its tail when huge) and extracts the last assistant message; null when there is none.
 * @param {string} file
 * @returns {LastMessage | null}
 */
export function lastAssistantMessage(file) {
  return extractLastMessage(readTranscript(file));
}

/**
 * The transcript's text; a file over 64 MB is read from its last 64 MB (the first, partial line is dropped).
 * @param {string} file
 * @returns {string}
 */
export function readTranscript(file) {
  const size = fs.statSync(file).size;
  if (size <= MAX_READ_BYTES) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
    const text = buf.subarray(0, n).toString('utf8');
    return text.slice(text.indexOf('\n') + 1);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The last assistant message of a transcript's JSONL text (see the header); null when there is none.
 * @param {string} jsonl
 * @returns {LastMessage | null}
 */
export function extractLastMessage(jsonl) {
  /** @type {any[]} */
  const entries = [];
  for (const line of String(jsonl ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && !Array.isArray(e)) entries.push(e);
    } catch {
      // a half-written or foreign line
    }
  }
  const branch = activeBranch(entries);
  return (branch && walk(branch)) || walk(entries);
}

/**
 * The entries of the active branch, oldest first: the parentUuid chain from the newest main-chain entry with a uuid.
 * null when there is no usable chain.
 * @param {any[]} entries
 * @returns {any[] | null}
 */
function activeBranch(entries) {
  /** @type {Map<string, any>} */
  const byUuid = new Map();
  for (const e of entries) if (typeof e.uuid === 'string') byUuid.set(e.uuid, e);
  let leaf = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (typeof e.uuid === 'string' && e.isSidechain !== true && (e.type === 'user' || e.type === 'assistant')) {
      leaf = e;
      break;
    }
  }
  if (!leaf) return null;
  const chain = [];
  const seen = new Set();
  for (let e = leaf; e && !seen.has(e.uuid); e = typeof e.parentUuid === 'string' ? byUuid.get(e.parentUuid) : null) {
    seen.add(e.uuid);
    chain.push(e);
  }
  return chain.reverse();
}

/**
 * Walks entries backwards for the last assistant message with text.
 * @param {any[]} entries oldest first
 * @returns {LastMessage | null}
 */
function walk(entries) {
  /** @type {string | null} */
  let locked = null;
  /** @type {string[]} */
  const texts = [];
  /** @type {any} */
  let newestLine = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (SKIPPED_TYPES.has(e.type) || e.isSidechain === true) continue;
    if (e.type === 'user') {
      if (e.isMeta === true || !isRealPrompt(e)) continue;
      if (locked) break; // the prompt that started the locked message's turn
      continue; // the current turn has no text yet: keep going into earlier turns
    }
    if (e.type !== 'assistant') continue;
    const msg = e.message && typeof e.message === 'object' ? e.message : null;
    if (!msg) continue;
    const id = typeof msg.id === 'string' && msg.id ? msg.id : typeof e.uuid === 'string' ? e.uuid : null;
    const text = textOf(msg.content);
    if (locked) {
      if (id !== locked) break;
      if (text) texts.unshift(text);
      continue;
    }
    if (!text || !id) continue;
    locked = id;
    newestLine = e;
    texts.unshift(text);
  }
  if (!locked || !texts.length) return null;
  return {
    text: texts.join('\n\n'),
    id: locked,
    session: typeof newestLine?.sessionId === 'string' ? newestLine.sessionId : null,
    timestamp: typeof newestLine?.timestamp === 'string' ? newestLine.timestamp : null,
  };
}

/**
 * The text blocks of an assistant message's content (a string, or blocks of which `text` ones count), trimmed.
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Whether a user entry is a prompt a person typed (not a tool result, a command echo or a system note).
 * @param {any} e
 * @returns {boolean}
 */
function isRealPrompt(e) {
  const content = e.message?.content;
  if (typeof content === 'string') {
    const s = content.trimStart();
    return Boolean(s) && !NOT_A_PROMPT.some((p) => s.startsWith(p));
  }
  if (!Array.isArray(content)) return false;
  if (content.some((b) => b && typeof b === 'object' && b.type === 'tool_result')) return false;
  const text = content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trimStart();
  return Boolean(text) && !NOT_A_PROMPT.some((p) => text.startsWith(p));
}

/**
 * Session id of a transcript file: its basename.
 * @param {string} file
 * @returns {string | null}
 */
function sessionOfFile(file) {
  const base = path.basename(file, '.jsonl');
  return SESSION_ID_RE.test(base) ? base : null;
}

/**
 * @param {string[]} files
 * @returns {string}
 */
function newest(files) {
  let best = files[0];
  let bestT = -Infinity;
  for (const f of files) {
    let t = -Infinity;
    try {
      t = fs.statSync(f).mtimeMs;
    } catch {
      // vanished
    }
    if (t > bestT) {
      best = f;
      bestT = t;
    }
  }
  return best;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} p
 * @returns {string}
 */
function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
