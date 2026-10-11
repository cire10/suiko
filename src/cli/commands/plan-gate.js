// @ts-check
// `specreview plan-gate [--timeout 30m] [--browser system|none]`: the Claude Code plan-mode gate, run as a
// PermissionRequest hook with matcher ExitPlanMode (integrations/claude-code/hooks/plan-gate.json, timeout 345600 s).
//
// 1. Reads the hook JSON on stdin ({session_id, cwd, tool_name: "ExitPlanMode", tool_input: {plan, planFilePath}}).
//    The plan text is the plan file (tool_input.planFilePath, read only when it is an absolute path to a regular .md
//    file under 2 MB), else tool_input.plan. No plan text: prints nothing.
// 2. Records it as a snapshot doc (store/snapshot.js) with origin key `claude-plan:<session_id>:<planFilePath or
//    "inline">`: v1 the first time, vN+1 when Claude calls ExitPlanMode again for the same plan (the reviewer sees
//    the diff). Open threads the new version's changes are linked to get the agent reply "Changed in vN."
//    (addressed): Claude has no reply channel here, and a handled thread must not come back as still open.
//    Workspace: discovered from $CLAUDE_PROJECT_DIR (it stays at the project root while the hook's cwd follows `cd`),
//    else the hook's cwd; when discovery is refused, the scratch workspace (cli/snapshot.js).
// 3. Makes sure the daemon runs, opens the review UI in the system browser (unless --browser none or
//    $SPECREVIEW_BROWSER=none; `pane` means the system browser here: a hook cannot drive the agent's browser pane)
//    and blocks until a review of this version is submitted, through the engine's wait machinery (waiter
//    registration, supersede, delivery under the doc lock). Plan docs are left out of `wait --all` (isGated), so a
//    background wait never takes the verdict. A gate whose version is no longer the doc's head (a newer gate recorded
//    a later version) steps aside and never answers for a plan it did not read.
// 4. Approved -> prints the allow decision, with `updatedInput` (required for ExitPlanMode allows): the tool input
//    with `plan` = the reviewed text. Request changes / Comment -> prints the deny decision whose `message` is the
//    plan feedback (packet.js formatPlanFeedback: threads and src> lines citing the plan file and its lines, and
//    the instruction to make targeted Edit-tool changes and call ExitPlanMode again). The review is marked
//    delivered only after that line reached stdout.
// Fail open everywhere: bad input, any error, the daemon not starting, SIGTERM/SIGINT/SIGHUP (the user answered in
// the terminal, which makes Claude Code discard the hook; no browser is opened after that) or a closed stdout ->
// nothing on stdout, exit 0, nothing marked delivered. Stdout never carries anything but the one decision line; notes go to stderr.
// Known limit: an approval's comments are not passed on (an allow decision has no field for them).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT } from '../../shared/protocol.js';
import { parseDuration } from '../args.js';
import { formatWith } from '../engine.js';
import { writeAll } from '../io.js';
import { commandHelp } from './index.js';
import { resolveBrowser } from './open.js';
import { externalsLines, recordSnapshotDoc, snapshotWorkspace } from '../snapshot.js';

export const spec = {
  name: 'plan-gate',
  usage: 'plan-gate [--timeout 30m] [--browser system|none]   (reads the PermissionRequest hook JSON on stdin)',
  summary: 'Claude Code plan-mode gate: review the plan of ExitPlanMode in SpecReview, then allow it or send the feedback back.',
  // parsed by the command itself (never fails: a hook must fail open)
  raw: true,
  options: {
    timeout: { type: 'string' },
    browser: { type: 'string' },
  },
  details: [
    'Hook: {"PermissionRequest":[{"matcher":"ExitPlanMode","hooks":[{"type":"command","command":"specreview plan-gate","timeout":345600}]}]}',
    'Each ExitPlanMode of the same plan file in a session is recorded as a new version of one snapshot doc, so the reviewer sees a diff.',
    'Approve -> ExitPlanMode is allowed. Request changes or Comment -> it is denied with the feedback: threads citing the',
    '  plan file and its line numbers, and the instruction to make targeted Edit-tool changes and call ExitPlanMode again.',
    'Comments sent with an approval are not passed on (Claude Code has no field for them).',
    'Fails open: on any error, a signal or a closed stdout it prints nothing and exits 0; Claude Code then asks in the terminal.',
    '--timeout 30m    give up (fail open) after that long; default: wait until Claude Code cancels the hook',
    '--browser none   do not open the browser (the review URL is printed on stderr); default: the system browser',
    '                 ($SPECREVIEW_BROWSER=none keeps it closed too; pane means system here: a hook has no pane)',
  ],
};

const MAX_HOOK_INPUT = 8 * 1024 * 1024;
const MAX_PLAN_FILE = 2 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 30000;

/**
 * @typedef {object} GateInput
 * @property {boolean} [help]
 * @property {string} [error] invalid arguments (reported on stderr; the gate then fails open)
 * @property {number} [timeoutMs]
 * @property {'system' | 'none'} [browser]
 * @property {string} [as]
 * @property {string} [workspace]
 */

/**
 * Never throws: invalid arguments become `error` (the gate fails open).
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 * @returns {Promise<GateInput>}
 */
export async function parse({ positionals }, rt) {
  try {
    const { values, positionals: rest } = parseArgs({
      args: positionals,
      options: {
        timeout: { type: 'string' },
        browser: { type: 'string' },
        as: { type: 'string' },
        workspace: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) return { help: true };
    if (rest.length) return { error: `plan-gate takes no arguments (got ${rest.join(' ')})` };
    return {
      timeoutMs: values.timeout === undefined ? 0 : parseDuration(values.timeout),
      // a hook cannot drive the agent's browser pane (Claude is blocked on ExitPlanMode): pane = system here
      browser: resolveBrowser(values.browser, rt.env) === 'none' ? 'none' : 'system',
      as: values.as,
      workspace: values.workspace,
    };
  } catch (err) {
    return { error: /** @type {Error} */ (err).message };
  }
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {GateInput} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  if (input.help) return { exit: EXIT.OK, text: commandHelp(spec) };
  // a closed stderr (EPIPE) must not crash the gate: notes there are best effort
  if (rt.stderr === process.stderr) process.stderr.on('error', () => {});
  /** nothing on stdout, exit 0: Claude Code falls back to its own prompt */
  const failOpen = { exit: EXIT.OK, printed: true };
  if (input.error) {
    note(rt, `plan-gate: ${input.error}; letting Claude Code ask instead`);
    return failOpen;
  }
  try {
    await gate(rt, input);
  } catch (err) {
    note(rt, `plan-gate failed open (Claude Code asks in the terminal): ${/** @type {Error} */ (err)?.message ?? err}`);
  }
  return failOpen;
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {GateInput} input
 */
async function gate(rt, input) {
  if (rt.signal?.aborted) return;
  const hook = await readHookInput(rt.stdin);
  if (!hook || hook.tool_name !== 'ExitPlanMode') return;
  if (hook.hook_event_name !== undefined && hook.hook_event_name !== 'PermissionRequest') return;
  const toolInput = hook.tool_input && typeof hook.tool_input === 'object' && !Array.isArray(hook.tool_input) ? hook.tool_input : {};
  const plan = planText(toolInput);
  if (!plan) return;

  const session = typeof hook.session_id === 'string' && hook.session_id.trim() ? hook.session_id.trim() : 'no-session';
  const cwd = isDir(hook.cwd) ? path.resolve(hook.cwd) : rt.cwd;
  // the project root, not the cwd (which follows `cd`): every ExitPlanMode of a plan lands in the same workspace
  const projectDir = isDir(rt.env.CLAUDE_PROJECT_DIR) ? path.resolve(rt.env.CLAUDE_PROJECT_DIR) : cwd;
  const keyPath = typeof toolInput.planFilePath === 'string' && path.isAbsolute(toolInput.planFilePath) ? path.resolve(toolInput.planFilePath) : 'inline';
  /** @type {import('../runtime.js').Runtime} */
  const grt = {
    ...rt,
    cwd,
    agent: (input.as || rt.env.SPECREVIEW_AGENT || 'claude').trim() || 'claude',
    workspace: input.workspace ? path.resolve(cwd, input.workspace) : undefined,
  };

  const ws = await snapshotWorkspace(grt, projectDir);
  if (rt.signal?.aborted) return;
  const origin = {
    type: 'plan',
    key: `claude-plan:${session}:${keyPath}`,
    session,
    planFilePath: plan.file,
    cwd,
    ...(typeof hook.transcript_path === 'string' ? { transcript: hook.transcript_path } : {}),
  };
  const t = await recordSnapshotDoc(grt, ws, { source: plan.text, origin, summary: '', autoAddress: true });
  const gateVersion = t.doc.head;
  // the user may have answered in the terminal meanwhile: then no browser tab nobody waits for
  if (rt.signal?.aborted) return;

  const info = await rt.ensureDaemon();
  if (rt.signal?.aborted) return;
  const url = rt.reviewUrl(info, t.wsId, t.doc.id);
  note(rt, `specreview: review the plan (${t.doc.id} v${gateVersion}) at ${url}`);
  for (const line of externalsLines(t.externalHosts)) note(rt, `specreview: ${line}`);
  if (await superseded(t, gateVersion)) return;
  if (input.browser !== 'none') {
    await rt.openBrowser(url).catch((err) => note(rt, `specreview: could not open the system browser: ${err?.message ?? err}`));
  }

  const controller = new AbortController();
  const stop = (/** @type {unknown} */ why) => {
    if (!controller.signal.aborted) controller.abort(why);
  };
  const onSignal = () => stop(rt.signal?.reason ?? 'signal');
  rt.signal?.addEventListener('abort', onSignal, { once: true });
  if (rt.signal?.aborted) return;
  /** @type {NodeJS.Timeout | null} */
  const timer = input.timeoutMs ? setTimeout(() => stop('timeout'), input.timeoutMs) : null;
  timer?.unref?.();

  /**
   * Called by the engine under the doc lock; the review is marked delivered only after this resolves.
   * @param {string} _text
   * @param {any} packet
   */
  const write = async (_text, packet) => {
    if (controller.signal.aborted) throw new Error('the plan gate gave up; not delivering');
    // a later version was recorded (a newer gate is waiting on it): this gate's plan text is not the reviewed one
    if (packet?.head !== gateVersion) throw new Error(`the plan doc moved on to v${packet?.head} (this gate recorded v${gateVersion}); not delivering`);
    const decision = decisionFor(t.engine, packet, toolInput, plan);
    await writeAll(rt.stdout, `${JSON.stringify(decision)}\n`);
  };
  try {
    const res = await t.engine.ops.waitForFeedback(t.ctx, {
      docIds: [t.doc.id],
      allowDirty: true,
      minVersion: gateVersion,
      signal: controller.signal,
      write,
      heartbeatMs: rt.heartbeatMs,
      ...(rt.deps.pollMs ? { pollMs: rt.deps.pollMs } : {}),
    });
    if (res?.status !== 'delivered') note(rt, `specreview: plan gate ended without a review (${res?.aborted ? 'interrupted' : res?.status ?? 'unknown'}); Claude Code decides`);
  } finally {
    if (timer) clearTimeout(timer);
    rt.signal?.removeEventListener('abort', onSignal);
  }
}

/**
 * Whether the doc's head moved past the gate's version (a newer ExitPlanMode of the same plan recorded a later
 * version, and its gate waits on it): this gate then steps aside (fails open) before waiting, so it neither
 * supersedes the newer gate's waiter nor answers for a plan text it did not read.
 * @param {{ ctx: any, doc: any }} t
 * @param {number} gateVersion
 * @returns {Promise<boolean>}
 */
async function superseded(t, gateVersion) {
  const doc = await t.ctx.store.getDoc(t.doc.id);
  return Boolean(doc) && doc.head !== gateVersion;
}

/**
 * The PermissionRequest decision for a delivered review: allow (approved) with `updatedInput`, else deny with the
 * plan feedback.
 * @param {import('../engine.js').Engine} engine
 * @param {any} packet
 * @param {Record<string, unknown>} toolInput
 * @param {{ text: string, file: string | null }} plan
 * @returns {object}
 */
export function decisionFor(engine, packet, toolInput, plan) {
  if (packet?.verdict === 'approved') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...toolInput, plan: plan.text } } } };
  }
  const message = formatWith(engine, 'formatPlanFeedback', packet, () => engine.format.formatPacket(packet)).replace(/\n+$/, '');
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
}

/**
 * The plan: the plan file when tool_input.planFilePath is an absolute path to a regular .md file under 2 MB (Claude
 * Code may pass a stale inline plan), else tool_input.plan. null when there is no plan text. A symlink counts only
 * when its target is such a file too (a `plan.md` link to a secret is never read); the path is normalised.
 * @param {Record<string, unknown>} toolInput
 * @returns {{ text: string, file: string | null } | null}
 */
export function planText(toolInput) {
  const given = toolInput.planFilePath;
  if (typeof given === 'string' && path.isAbsolute(given)) {
    const fp = path.resolve(given);
    try {
      const real = fs.realpathSync(fp);
      const st = fs.statSync(real);
      if (/\.md$/i.test(fp) && /\.md$/i.test(real) && st.isFile() && st.size < MAX_PLAN_FILE) {
        const text = fs.readFileSync(real, 'utf8').replace(/^﻿/, '');
        if (text.trim()) return { text, file: fp };
      }
    } catch {
      // unreadable: fall back to the inline plan
    }
  }
  const inline = toolInput.plan;
  return typeof inline === 'string' && inline.trim() ? { text: inline, file: null } : null;
}

/**
 * The hook JSON from stdin; null for a terminal, empty or invalid input, or input that does not arrive in time.
 * @param {NodeJS.ReadableStream & { isTTY?: boolean, destroy?: () => void }} stream
 * @returns {Promise<any>}
 */
async function readHookInput(stream) {
  if (!stream || stream.isTTY) return null;
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  const read = (async () => {
    for await (const chunk of stream) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(/** @type {Uint8Array} */ (chunk));
      size += buf.length;
      if (size > MAX_HOOK_INPUT) throw new Error('hook input too large');
      chunks.push(buf);
    }
    return true;
  })();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), STDIN_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const done = await Promise.race([read, timedOut]);
    if (!done) {
      stream.destroy?.();
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} p
 * @returns {p is string}
 */
function isDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A note on stderr; never throws (a closed stderr must not turn into an error).
 * @param {import('../runtime.js').Runtime} rt
 * @param {string} line
 */
function note(rt, line) {
  try {
    rt.stderr.write(`${line}\n`, () => {});
  } catch {
    // ignore
  }
}
