// @ts-check
// `specreview last`: finding a Claude Code transcript (by session id under ${CLAUDE_CONFIG_DIR}/projects/*/, else
// the newest transcript of the cwd's project directory) and extracting the last assistant message from its JSONL
// (one content block per line sharing message.id, sidechains, tool results, meta and command lines skipped, the
// active branch after a /rewind, a half-written last line).

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NotFoundError, UsageError } from '../../src/core/store/errors.js';
import { extractLastMessage, findTranscript, lastAssistantMessage, projectSlug } from '../../src/cli/transcript.js';

const SID = '0b6f6c2e-1111-4222-8333-944445555666';
let n = 0;

/** A user prompt line. */
function user(text, extra = {}) {
  n += 1;
  return { type: 'user', uuid: `u${n}`, parentUuid: extra.parentUuid ?? null, sessionId: SID, timestamp: `2026-10-11T10:00:${String(n).padStart(2, '0')}Z`, message: { role: 'user', content: text }, ...extra };
}

/** One assistant content-block line. */
function asst(id, block, extra = {}) {
  n += 1;
  return { type: 'assistant', uuid: `a${n}`, parentUuid: extra.parentUuid ?? null, sessionId: SID, timestamp: `2026-10-11T10:01:${String(n).padStart(2, '0')}Z`, message: { id, role: 'assistant', content: [block] }, ...extra };
}

const text = (/** @type {string} */ t) => ({ type: 'text', text: t });
const toolUse = (/** @type {string} */ id) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
const toolResult = (/** @type {string} */ id) => user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

/** Chains entries by parentUuid in order (like a real linear transcript) and returns JSONL. */
function jsonl(/** @type {any[]} */ entries, { chain = true } = {}) {
  let prev = null;
  for (const e of entries) {
    if (chain && e.uuid && e.parentUuid == null && prev) e.parentUuid = prev;
    if (e.uuid) prev = e.uuid;
  }
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('extractLastMessage', () => {
  test('joins the text blocks of the last message (one line per block), skipping tool use and results', () => {
    const t = jsonl([
      user('first question'),
      asst('msg_1', text('Old answer.')),
      user('Design the token refresh.'),
      asst('msg_2', text('## Plan\n\nRotate tokens.')),
      asst('msg_2', toolUse('tu1')),
      toolResult('tu1'),
      asst('msg_3', { type: 'thinking', thinking: 'hmm' }),
      asst('msg_3', text('Part one.')),
      asst('msg_3', toolUse('tu2')),
      toolResult('tu2'),
      asst('msg_3', text('Part two.')),
      { type: 'system', subtype: 'turn_duration', uuid: 'sys1' },
    ]);
    const m = extractLastMessage(t);
    assert.ok(m);
    assert.equal(m.id, 'msg_3');
    assert.equal(m.text, 'Part one.\n\nPart two.');
    assert.equal(m.session, SID);
    assert.match(String(m.timestamp), /^2026-10-11T10:01/);
  });

  test('a turn whose newest message has no text yet falls back to the previous message with text', () => {
    const t = jsonl([
      user('Q'),
      asst('msg_1', text('The answer.')),
      user('<command-name>/specreview-last</command-name>\n<command-message>specreview-last</command-message>\n<command-args></command-args>'),
      user('<local-command-stdout>ok</local-command-stdout>'),
      { ...user('Base directory for this skill: x'), isMeta: true },
      asst('msg_2', toolUse('tu1')),
      toolResult('tu1'),
    ]);
    assert.deepEqual(pick(extractLastMessage(t)), { id: 'msg_1', text: 'The answer.' });
  });

  test('stops at the prompt that started the message: an earlier message is never merged in', () => {
    const t = jsonl([user('Q1'), asst('msg_1', text('A1')), user('Q2'), asst('msg_1x', text('A2'))]);
    assert.deepEqual(pick(extractLastMessage(t)), { id: 'msg_1x', text: 'A2' });
    // two messages in one turn (text, tool, text): only the newest one
    const t2 = jsonl([user('Q'), asst('m1', text('Looking.')), asst('m1', toolUse('x')), toolResult('x'), asst('m2', text('Done.'))]);
    assert.deepEqual(pick(extractLastMessage(t2)), { id: 'm2', text: 'Done.' });
  });

  test('sidechain (subagent) lines, bookkeeping lines and a half-written last line are ignored', () => {
    const t =
      jsonl([
        user('Q'),
        asst('msg_main', text('Main answer.')),
        { ...asst('msg_side', text('Subagent text.')), isSidechain: true },
        { type: 'file-history-snapshot', messageId: 'x', snapshot: {} },
        { type: 'summary', summary: 'Summary', leafUuid: 'a2' },
      ]) + '{"type":"assistant","message":{"id":"msg_partial","content":[{"type":"text","text":"cut';
    assert.deepEqual(pick(extractLastMessage(t)), { id: 'msg_main', text: 'Main answer.' });
  });

  test('follows the active branch after a rewind', () => {
    const u1 = user('Q');
    const a1 = asst('msg_A', text('Answer A.'), { parentUuid: u1.uuid });
    const u2 = user('Follow-up that was rewound', { parentUuid: a1.uuid });
    const b1 = asst('msg_B', text('Abandoned answer B.'), { parentUuid: u2.uuid });
    const u3 = user('<command-name>/specreview-last</command-name>', { parentUuid: a1.uuid }); // forked from a1
    const t = jsonl([u1, a1, u2, b1, u3], { chain: false });
    assert.deepEqual(pick(extractLastMessage(t)), { id: 'msg_A', text: 'Answer A.' });
  });

  test('string content and missing message ids work; nothing usable gives null', () => {
    const e = { type: 'assistant', uuid: 'zz', sessionId: SID, message: { role: 'assistant', content: '  Plain string.  ' } };
    assert.deepEqual(pick(extractLastMessage(jsonl([user('Q'), e]))), { id: 'zz', text: 'Plain string.' });
    assert.equal(extractLastMessage(''), null);
    assert.equal(extractLastMessage('not json\n[1,2]\n'), null);
    assert.equal(extractLastMessage(jsonl([user('Q'), asst('m', toolUse('x'))])), null);
  });
});

describe('findTranscript', () => {
  /** @type {string} */
  let base;
  /** @type {string} */
  let claude;
  /** @type {string} */
  let cwd;
  beforeEach(async () => {
    base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'sr-transcript-')));
    claude = path.join(base, 'claude');
    cwd = path.join(base, 'My Project.v2');
    fs.mkdirSync(cwd, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(base, { recursive: true, force: true });
  });

  /** @param {string} dir @param {string} name @param {string} body @param {number} [ageS] */
  function put(dir, name, body, ageS = 0) {
    const d = path.join(claude, 'projects', dir);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, name);
    fs.writeFileSync(f, body);
    const t = Date.now() / 1000 - ageS;
    fs.utimesSync(f, t, t);
    return f;
  }

  test('projectSlug replaces every non-alphanumeric character', () => {
    assert.equal(projectSlug('/home/u/My Project.v2'), '-home-u-My-Project-v2');
  });

  test('by session id under any project directory (the shell may have cd-ed elsewhere)', () => {
    const f = put('-somewhere-else', `${SID}.jsonl`, jsonl([user('Q'), asst('m', text('Hi.'))]));
    put(projectSlug(cwd), 'other.jsonl', 'x');
    const r = findTranscript({ session: SID, env: { CLAUDE_CONFIG_DIR: claude }, cwd });
    assert.deepEqual(r, { path: f, session: SID, note: null });
    assert.equal(lastAssistantMessage(r.path)?.text, 'Hi.');
    // $CLAUDE_CODE_SESSION_ID works the same way
    assert.equal(findTranscript({ env: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SID }, cwd }).path, f);
  });

  test('without a session: the newest transcript of the cwd project directory; an unknown session says so', () => {
    put(projectSlug(cwd), 'older-session.jsonl', 'x', 100);
    const newer = put(projectSlug(cwd), 'newer-session.jsonl', 'x', 1);
    put('-unrelated', 'newest.jsonl', 'x', 0);
    const r = findTranscript({ env: { CLAUDE_CONFIG_DIR: claude }, cwd });
    assert.deepEqual(r, { path: newer, session: 'newer-session', note: null });
    const r2 = findTranscript({ session: 'missing-session', env: { CLAUDE_CONFIG_DIR: claude }, cwd });
    assert.equal(r2.path, newer);
    assert.match(String(r2.note), /no transcript for session missing-session/);
  });

  test('defaults to ~/.claude from HOME', () => {
    const home = path.join(base, 'home');
    const f = path.join(home, '.claude', 'projects', 'p', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    assert.equal(findTranscript({ session: SID, env: { HOME: home }, cwd }).path, f);
  });

  test('errors: no transcript, a missing --transcript, an invalid session id', () => {
    assert.throws(() => findTranscript({ env: { CLAUDE_CONFIG_DIR: claude }, cwd }), (/** @type {any} */ e) => e instanceof NotFoundError && /--session <id> or --transcript <file>/.test(e.message));
    assert.throws(() => findTranscript({ transcript: 'nope.jsonl', env: { CLAUDE_CONFIG_DIR: claude }, cwd }), NotFoundError);
    assert.throws(() => findTranscript({ session: '../etc/passwd', env: { CLAUDE_CONFIG_DIR: claude }, cwd }), UsageError);
    const f = path.join(cwd, 't.jsonl');
    fs.writeFileSync(f, 'x');
    assert.deepEqual(findTranscript({ transcript: 't.jsonl', env: {}, cwd }), { path: f, session: 't', note: null });
  });
});

/** @param {any} m */
function pick(m) {
  return m ? { id: m.id, text: m.text } : null;
}
