// @ts-check
// `specreview last [--session <id>] [--transcript <path>] [--title T] [--browser pane|system|none] [--workspace <dir>]
// [--json]` (Claude Code's /specreview-last): opens the agent's last message for review.
//
// Finds the session's transcript (cli/transcript.js: --transcript, else the session id from --session or
// $CLAUDE_CODE_SESSION_ID, else the newest transcript of the cwd's project directory), extracts the last assistant
// message, records it as a snapshot doc (origin type "message", key `claude-msg:<session>:<message id>`, so running
// it again for the same message reopens the same doc without recording anything: the agent's revisions stay; the
// text is stored with a final newline, as `show` prints it), makes sure the daemon runs, opens the review UI and returns
// at once with the review URL and the exact background `wait` command. The agent then revises its answer and records
// it with `specreview revise <doc> --source <file> --replies -`.
// Only Claude Code transcripts are read (the Codex rollout format is not documented well enough to parse safely).

import { UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { resolveBrowser } from './open.js';
import { findTranscript, lastAssistantMessage } from '../transcript.js';
import {
  MAX_SNAPSHOT_BYTES, defaultTitle, externalsLines, recordSnapshotDoc, scratchNote, showUrl, shownPrefix, snapshotLine, snapshotWorkspace,
} from '../snapshot.js';

export const spec = {
  name: 'last',
  usage: 'last [--session <id>] [--transcript <path>] [--title T] [--browser pane|system|none] [--workspace <dir>] [--json]',
  summary: "Open the agent's last message (Claude Code transcript) for review, print the review URL and the wait command, and return.",
  options: {
    session: { type: 'string' },
    transcript: { type: 'string' },
    title: { type: 'string' },
    browser: { type: 'string' },
  },
  details: [
    'The transcript: --transcript <file>, else the session by id (--session, else $CLAUDE_CODE_SESSION_ID) under',
    '  ${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<id>.jsonl, else the newest transcript of the current directory.',
    'Running it again for the same message reopens the same doc (your revisions stay). Claude Code only: Codex',
    '  transcripts are not supported.',
    'Then run the printed `specreview wait` in the background; revise with `specreview revise <doc> --source <file> --replies -`.',
    '--browser system (default) | pane | none, as for open; $SPECREVIEW_BROWSER changes the default.',
  ],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('last', positionals, 0, 0, spec.usage);
  if (values.session !== undefined && values.transcript !== undefined) throw new UsageError('last: pass either --session or --transcript, not both');
  return {
    session: /** @type {string | undefined} */ (values.session),
    transcript: /** @type {string | undefined} */ (values.transcript),
    title: /** @type {string | undefined} */ (values.title),
    browser: resolveBrowser(/** @type {string | undefined} */ (values.browser), rt.env),
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ session?: string, transcript?: string, title?: string, browser?: 'pane' | 'system' | 'none' }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const browser = input.browser ?? resolveBrowser(undefined, rt.env);
  /** @type {string[]} */
  const stderr = [];
  const found = findTranscript({ transcript: input.transcript, session: input.session, env: rt.env, cwd: rt.cwd });
  if (found.note) stderr.push(`specreview: ${found.note}`);
  const msg = lastAssistantMessage(found.path);
  if (!msg) throw new UsageError(`no assistant message with text in ${found.path}`, { details: { transcript: found.path } });
  if (Buffer.byteLength(msg.text) > MAX_SNAPSHOT_BYTES) throw new UsageError(`the last message is larger than ${MAX_SNAPSHOT_BYTES} bytes`);
  const session = found.session ?? msg.session ?? 'unknown';

  const ws = await snapshotWorkspace(rt, rt.cwd);
  const origin = { type: 'message', key: `claude-msg:${session}:${msg.id}`, session, messageId: msg.id, transcript: found.path };
  // a final newline, as files and `show` output have: a revision written from `show` output then differs only where
  // the agent changed the text
  const source = `${msg.text.replace(/\s+$/, '')}\n`;
  const t = await recordSnapshotDoc(rt, ws, { source, origin, title: input.title || defaultTitle(msg.text, 'Agent message') });

  const info = await rt.ensureDaemon();
  const url = rt.reviewUrl(info, t.wsId, t.doc.id);
  const shown = await showUrl(rt, url, browser, stderr);
  const text = [
    snapshotLine(t),
    `review UI: ${url}`,
    ...externalsLines(t.externalHosts),
    `next: ${shownPrefix(shown)}run \`specreview wait ${t.ref}\` in the background (Bash run_in_background: true) and end your turn. ` +
      `When the review arrives, write your complete revised answer to a file and record it with \`specreview revise ${t.ref} --source <file> --replies -\` (replies JSON on stdin), then wait again.`,
    ...scratchNote(ws),
  ];
  return {
    exit: EXIT.OK,
    text: text.join('\n'),
    stderr,
    json: {
      doc: t.doc.id,
      version: t.doc.head,
      created: t.created,
      url,
      wsId: t.wsId,
      root: ws.root,
      scratch: ws.scratch,
      ref: t.ref,
      transcript: found.path,
      session,
      messageId: msg.id,
      externals: t.externalHosts,
    },
  };
}
