// @ts-check
// `specreview revise <doc> [-m <summary>] [--replies <file|->] [--dry-run] [--break-lock L1="why"]...
//  [--allow-rewrite] [--force] [--json]` (design 3.8 / 8.1 / 9.5).
// Records the working copy as a new version with one reply per thread. The replies JSON is validated with the
// ReviseInput zod schema (unknown keys rejected); -m overrides its summary; --break-lock pairs are merged into
// breakLocks (flags win); --allow-rewrite/--force/--dry-run are OR-ed with the JSON fields.
// Exit 0 when recorded (or dry run / nothing to record), 3 when a guard refused (nothing recorded).
// A snapshot doc (an agent message, piped text: store/snapshot.js) has no working file: `--source <file|->` gives
// the new version's text (at most 5 MB; with `-` it comes from stdin, so --replies must then name a file). Without
// --source, revise explains how to revise such a doc; --source on a file doc is a usage error.

import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError, UsageError } from '../../core/store/errors.js';
import { EXIT } from '../../shared/protocol.js';
import { expectPositionals, parseBreakLocks } from '../args.js';
import { readAll, readAllBytes } from '../io.js';
import { ReviseInputSchema, parseJsonInput, validate } from '../schemas.js';
import { formatWith } from '../engine.js';
import { FALLBACK_FORMATTERS } from '../format.js';
import { callOp, docContext } from '../runtime.js';
import { MAX_SNAPSHOT_BYTES } from '../snapshot.js';

export const spec = {
  name: 'revise',
  usage: 'revise <doc> [-m <summary>] [--replies <file|->] [--source <file|->] [--dry-run] [--break-lock L1="why"]... [--allow-rewrite] [--force] [--json]',
  summary: 'Record the working copy as a new version, linking hunks to threads and posting your replies.',
  options: {
    message: { type: 'string', short: 'm' },
    replies: { type: 'string' },
    source: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'break-lock': { type: 'string', multiple: true },
    'allow-rewrite': { type: 'boolean' },
    force: { type: 'boolean' },
  },
  details: [
    '--replies - reads JSON from stdin:',
    '  {"summary":"...","threads":{"t1":{"status":"addressed","reply":"...","at":"L90-91"}},',
    '   "other":[{"at":"L12","why":"..."}],"breakLocks":{"L1":"why"}}',
    'status: addressed | answered | declined | needs_input.  other[].at: "L12" | "L12-14" | "del:h6" | "h6".',
    '--source <file|-> snapshot docs (an agent message, piped text): the complete new text; with -, from stdin',
    '  (then --replies must name a file). File docs take no --source: edit the file instead.',
    'Never use --force, --allow-rewrite or --break-lock unless the user explicitly asked.',
  ],
};

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('revise', positionals, 1, 1, spec.usage);
  if (values.source === '-' && values.replies === '-') {
    throw new UsageError('revise: --source - reads the new text from stdin, so --replies must name a file');
  }
  /** @type {Buffer | undefined} */
  let source;
  if (values.source !== undefined) source = await readSource(rt, values.source);
  /** @type {any} */
  let input = { threads: {} };
  if (values.replies !== undefined) {
    let text;
    if (values.replies === '-') {
      text = await readAll(rt.stdin);
    } else {
      const file = path.resolve(rt.cwd, values.replies);
      try {
        text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      } catch {
        throw new NotFoundError(`revise: --replies file not found: ${values.replies}`);
      }
    }
    input = parseJsonInput(text, ReviseInputSchema, '--replies JSON');
  }
  const breakLocks = { ...(input.breakLocks ?? {}), ...parseBreakLocks(values['break-lock']) };
  return {
    doc: positionals[0],
    ...(source ? { source } : {}),
    input: buildReviseInput(input, {
      summary: values.message,
      breakLocks,
      allowRewrite: values['allow-rewrite'],
      force: values.force,
      dryRun: values['dry-run'],
    }),
  };
}

/**
 * The text of `--source`: a file (relative to the cwd), or stdin for '-'. At most 5 MB.
 * @param {import('../runtime.js').Runtime} rt
 * @param {string} arg
 * @returns {Promise<Buffer>}
 */
async function readSource(rt, arg) {
  const tooBig = () => new UsageError(`revise: --source is larger than ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB`);
  if (arg === '-') {
    try {
      // bytes: the engine detects the encoding (a UTF-16 BOM), as for a --source file
      return await readAllBytes(rt.stdin, { maxBytes: MAX_SNAPSHOT_BYTES });
    } catch (err) {
      if (err instanceof RangeError) throw tooBig();
      throw err;
    }
  }
  const file = path.resolve(rt.cwd, arg);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new NotFoundError(`revise: --source file not found: ${arg}`, { details: { path: file } });
  }
  if (!st.isFile()) throw new UsageError(`revise: --source is not a file: ${arg}`);
  if (st.size > MAX_SNAPSHOT_BYTES) throw tooBig();
  return fs.readFileSync(file);
}

/**
 * Merges flag values into a (validated) ReviseInput.
 * @param {any} base
 * @param {{ summary?: string, breakLocks?: Record<string, string>, allowRewrite?: boolean, force?: boolean, dryRun?: boolean }} flags
 * @returns {import('../../shared/types.js').ReviseInput}
 */
export function buildReviseInput(base, flags) {
  const merged = validate(base ?? {}, ReviseInputSchema, 'revise input');
  /** @type {any} */
  const out = {
    summary: flags.summary ?? merged.summary ?? '',
    threads: merged.threads ?? {},
  };
  if (merged.other?.length) out.other = merged.other;
  const breakLocks = { ...(merged.breakLocks ?? {}), ...(flags.breakLocks ?? {}) };
  if (Object.keys(breakLocks).length) out.breakLocks = breakLocks;
  if (flags.allowRewrite || merged.allowRewrite) out.allowRewrite = true;
  if (flags.force || merged.force) out.force = true;
  if (flags.dryRun || merged.dryRun) out.dryRun = true;
  return out;
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {{ doc: string, input: import('../../shared/types.js').ReviseInput, source?: Buffer }} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const { ctx, engine, docId } = await docContext(rt, input.doc);
  const report = input.source
    ? await callOp(engine, 'revise', ctx, docId, input.input, { source: input.source })
    : await callOp(engine, 'revise', ctx, docId, input.input);
  const refused = Boolean(report?.refused);
  const shown = { doc: docId, dryRun: Boolean(input.input.dryRun), ...report };
  const text = typeof report?.text === 'string' ? report.text : formatWith(engine, 'formatReviseReport', shown, () => FALLBACK_FORMATTERS.formatReviseReport(shown));
  return { exit: refused ? EXIT.REFUSED : EXIT.OK, text, json: { doc: docId, ...report } };
}
