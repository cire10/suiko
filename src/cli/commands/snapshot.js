// @ts-check
// `specreview snapshot <url> [--title T] [--reader auto|direct|jina] [--as-html] [--allow-private]
//  [--allow-remote-assets] [--replies <file|->] [--browser pane|system|none] [--workspace <dir>] [--json]`
// (design 6.2): review a web page. Running the command is the consent to use the network; it is refused (exit 3)
// when SPECREVIEW_OFFLINE=1 or the user config ($SPECREVIEW_HOME/config.json) says network.allow: false.
//
// Fetches the page (cli/fetch-url.js: public hosts only unless --allow-private, every redirect re-checked, size and
// time caps), turns it into review text that cannot run anything (cli/html-convert.js: an allowlist sanitizer, then
// Markdown without raw HTML; --as-html keeps the sanitized HTML), and records it as a snapshot doc of origin type
// "url" with the key `url:<normalized url>`: running it again for the same URL records vN+1 when the page changed
// (nothing when it is identical), with --replies posting the agent's replies to the open threads at the same time.
// The doc blocks remote images and styles in the review UI unless --allow-remote-assets (doc.render.network).
// Then it makes sure the daemon runs, opens the review UI and returns at once with the review URL and the `wait`
// command, like `open`.
// Exit 0; 1 for a network error or an HTTP status of 400 and above; 3 when refused (offline, a non-public host
// without --allow-private, user info in the URL, too large, not HTML or Markdown); 4 when the host does not resolve.

import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError, RefusedError, UsageError, exitCodeOf } from '../../core/store/errors.js';
import { resnapshotCommand } from '../../core/store/snapshot.js';
import { EXIT, LIMITS } from '../../shared/protocol.js';
import { expectPositionals } from '../args.js';
import { readAll } from '../io.js';
import { ReviseInputSchema, parseJsonInput } from '../schemas.js';
import { fetchForSnapshot, networkRefusal, normalizeUrl, READERS, userSnapshotConfig } from '../fetch-url.js';
import { htmlToMarkdown, sanitizeHtml, stripRawHtmlFromMarkdown } from '../html-convert.js';
import { resolveBrowser } from './open.js';
import { defaultTitle, recordSnapshotDoc, scratchNote, showUrl, shownPrefix, snapshotLine, snapshotWorkspace } from '../snapshot.js';

export const spec = {
  name: 'snapshot',
  usage:
    'snapshot <url> [--title T] [--reader auto|direct|jina] [--as-html] [--allow-private] [--allow-remote-assets] [--replies <file|->] [--browser pane|system|none] [--workspace <dir>] [--json]',
  summary: 'Snapshot a web page for review (uses the network): record it as a doc, print the review URL and the wait command, and return.',
  options: {
    title: { type: 'string' },
    reader: { type: 'string' },
    'as-html': { type: 'boolean' },
    'allow-private': { type: 'boolean' },
    'allow-remote-assets': { type: 'boolean' },
    replies: { type: 'string' },
    browser: { type: 'string' },
  },
  details: [
    'The page is fetched once, now; the review UI never fetches it. Scripts never run: the HTML is cleaned with an',
    '  allowlist (no scripts, styles, forms, frames or event handlers) and converted to Markdown.',
    'Running it again for the same URL records the next version when the page changed (--replies - posts your',
    '  replies with it: the revise JSON on stdin).',
    '--reader auto     (default) github.com .../blob/....md pages come from raw.githubusercontent.com; .md URLs as Markdown',
    '--reader direct   fetch the URL exactly as given',
    '--reader jina     let r.jina.ai render a JavaScript page (sends the URL, without its query, to r.jina.ai; public hosts only)',
    '--as-html         keep the sanitized HTML instead of converting it to Markdown',
    '--allow-private   allow a page on this machine or your network (localhost, 10.x, 192.168.x...): a page you build',
    '--allow-remote-assets  let the review UI load the page\'s remote images and styles (blocked by default)',
    'Refused when SPECREVIEW_OFFLINE=1 or network.allow is false in $SPECREVIEW_HOME/config.json.',
  ],
};

/**
 * @typedef {object} SnapshotInput
 * @property {string} url
 * @property {string} [title]
 * @property {'auto' | 'direct' | 'jina'} [reader]
 * @property {boolean} [asHtml]
 * @property {boolean} [allowPrivate]
 * @property {boolean} [allowRemoteAssets]
 * @property {{ summary?: string, threads: Record<string, { status: string, reply: string, at?: string }>,
 *   other?: Array<{ at: string, why: string }> }} [replies]
 * @property {'pane' | 'system' | 'none'} [browser]
 */

/**
 * @param {import('../args.js').ParsedArgs} parsed
 * @param {import('../runtime.js').Runtime} rt
 * @returns {Promise<SnapshotInput>}
 */
export async function parse({ values, positionals }, rt) {
  expectPositionals('snapshot', positionals, 1, 1, spec.usage);
  const reader = /** @type {string | undefined} */ (values.reader);
  if (reader !== undefined && !READERS.includes(reader)) throw new UsageError(`snapshot: --reader must be one of ${READERS.join(', ')}`);
  /** @type {SnapshotInput['replies']} */
  let replies;
  if (values.replies !== undefined) {
    let text;
    if (values.replies === '-') {
      text = await readAll(rt.stdin);
    } else {
      const file = path.resolve(rt.cwd, String(values.replies));
      try {
        text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      } catch {
        throw new NotFoundError(`snapshot: --replies file not found: ${values.replies}`);
      }
    }
    const json = parseJsonInput(text, ReviseInputSchema, '--replies JSON');
    replies = { threads: json.threads ?? {}, ...(json.summary ? { summary: json.summary } : {}), ...(json.other?.length ? { other: json.other } : {}) };
  }
  return {
    url: positionals[0],
    title: /** @type {string | undefined} */ (values.title),
    reader: /** @type {'auto' | 'direct' | 'jina' | undefined} */ (reader),
    asHtml: Boolean(values['as-html']),
    allowPrivate: Boolean(values['allow-private']),
    allowRemoteAssets: Boolean(values['allow-remote-assets']),
    ...(replies ? { replies } : {}),
    browser: resolveBrowser(/** @type {string | undefined} */ (values.browser), rt.env),
  };
}

/**
 * @param {import('../runtime.js').Runtime} rt
 * @param {SnapshotInput} input
 * @returns {Promise<import('../io.js').CommandResult>}
 */
export async function execute(rt, input) {
  const refusal = networkRefusal(rt.env);
  if (refusal) throw new RefusedError(`snapshot: the network is turned off (${refusal}); nothing was fetched`, { details: { reason: refusal } });
  const key = normalizeUrl(input.url);
  const reader = input.reader ?? userSnapshotConfig(rt.env).reader;
  const browser = input.browser ?? resolveBrowser(undefined, rt.env);
  /** @type {string[]} */
  const stderr = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {typeof fetchForSnapshot} */
  const fetchPage = /** @type {any} */ (rt.deps).fetchUrl ?? fetchForSnapshot;
  const page = await fetchPage(input.url, { reader, allowPrivate: Boolean(input.allowPrivate), notes, signal: rt.signal });
  for (const n of notes) stderr.push(`specreview: ${n}`);

  const converted = convert(page, Boolean(input.asHtml));
  if (input.asHtml && page.format === 'markdown') stderr.push('specreview: --as-html applies to HTML pages; this page is Markdown and stays Markdown');
  const scripted = converted.hadScripts && converted.textChars < LIMITS.urlLowTextChars && page.reader !== 'jina';
  const jsHint = page.private
    ? 'it is probably rendered by JavaScript, which SpecReview never runs'
    : 'it is probably rendered by JavaScript: try --reader jina (sends the URL to r.jina.ai)';
  if (!converted.textChars) {
    throw new UsageError(`snapshot: ${page.finalUrl} has no text to review${converted.hadScripts ? ` (${jsHint})` : ''}`, { details: { url: page.finalUrl } });
  }

  const ws = await snapshotWorkspace(rt, rt.cwd);
  const host = new URL(key).hostname;
  const origin = {
    type: 'url',
    key: `url:${key}`,
    url: key,
    finalUrl: page.finalUrl,
    private: page.private,
    fetchedAt: page.fetchedAt,
    status: page.status,
    contentType: page.contentType,
    etag: page.etag,
    reader: page.reader,
    removed: converted.removed,
  };
  const replies = input.replies;
  let t;
  try {
    t = await recordSnapshotDoc(rt, ws, {
      source: converted.text,
      format: converted.format,
      origin,
      title: input.title || converted.title || page.title || defaultTitle(converted.format === 'markdown' ? converted.text : '', host),
      slug: slugFor(key),
      render: { network: input.allowRemoteAssets ? 'allow' : 'block' },
      ...(replies ? { replies: replies.threads, other: replies.other ?? [], summary: replies.summary ?? '' } : {}),
    });
  } catch (err) {
    // the doc of this URL was taken in the other format (with or without --as-html)
    const had = /** @type {any} */ (err)?.details?.format;
    if (err instanceof UsageError && (had === 'markdown' || had === 'html') && had !== converted.format) {
      throw new UsageError(`snapshot: ${/** @type {any} */ (err).details.doc} tracks this URL as ${had === 'html' ? 'HTML' : 'Markdown'}: run it ${had === 'html' ? 'with' : 'without'} --as-html`, { details: /** @type {any} */ (err).details });
    }
    throw err;
  }
  if (t.created && replies && Object.keys(replies.threads).length) stderr.push('specreview: --replies was ignored: the doc is new, so it has no threads yet');

  /** @type {import('../../shared/types.js').DaemonInfo | null} */
  let info = null;
  /** @type {unknown} */
  let daemonError = null;
  try {
    info = await rt.ensureDaemon();
  } catch (err) {
    daemonError = err;
  }
  const url = info ? rt.reviewUrl(info, t.wsId, t.doc.id) : null;
  const shown = url ? await showUrl(rt, url, browser, stderr) : 'none';
  const recorded = t.created || Boolean(t.report?.version && !t.report?.dryRun);
  const posted = t.report?.replies?.length ?? 0;
  let first = snapshotLine(t);
  if (recorded && converted.removed) first += ` · removed ${converted.removed} element${converted.removed === 1 ? '' : 's'}`;
  if (posted) first += ` · posted ${posted} repl${posted === 1 ? 'y' : 'ies'}`;
  const lines = [first, url ? `review UI: ${url}` : `review UI: unavailable (${/** @type {Error} */ (daemonError)?.message ?? 'server not running'})`];
  if (page.finalUrl !== key) lines.push(`fetched: ${page.finalUrl}${page.redirects ? ` (after ${page.redirects} redirect${page.redirects === 1 ? '' : 's'})` : ''}`);
  if (t.externalHosts.length) {
    lines.push(
      input.allowRemoteAssets
        ? `remote assets loaded live by the review UI from: ${t.externalHosts.join(', ')}`
        : `remote images and styles are blocked in the review UI (${t.externalHosts.join(', ')}); --allow-remote-assets loads them`,
    );
  }
  if (scripted) lines.push(`note: little text was found; ${jsHint}`);
  const again = resnapshotCommand(t.doc, ws.root);
  lines.push(
    page.private
      ? `next: ${shownPrefix(shown)}run \`specreview wait ${t.ref}\` in the background. When the review arrives, change the sources that produce the page, then record what it serves with \`${again} --replies -\` (replies JSON on stdin) and wait again.`
      : `next: ${shownPrefix(shown)}run \`specreview wait ${t.ref}\` in the background`,
  );
  lines.push(...scratchNote(ws));
  if (daemonError) stderr.push(`specreview: the review server could not be started: ${/** @type {Error} */ (daemonError).message} (the doc is tracked; run \`specreview doctor\`)`);
  return {
    exit: daemonError ? exitCodeOf(daemonError) || EXIT.ERROR : EXIT.OK,
    text: lines.join('\n'),
    stderr,
    json: {
      doc: t.doc.id,
      version: t.doc.head,
      created: t.created,
      recorded,
      format: t.doc.format,
      url,
      wsId: t.wsId,
      root: ws.root,
      scratch: ws.scratch,
      ref: t.ref,
      page: { url: key, finalUrl: page.finalUrl, status: page.status, contentType: page.contentType, private: page.private, reader: page.reader, redirects: page.redirects },
      removed: converted.removed,
      replies: posted,
      renderNetwork: input.allowRemoteAssets ? 'allow' : 'block',
      externals: t.externalHosts,
      ...(daemonError ? { error: { message: /** @type {Error} */ (daemonError).message } } : {}),
    },
  };
}

/**
 * The fetched body as review text.
 * @param {import('../fetch-url.js').FetchResult} page
 * @param {boolean} asHtml
 * @returns {{ format: 'markdown' | 'html', text: string, removed: number, textChars: number, title: string, hadScripts: boolean }}
 */
function convert(page, asHtml) {
  if (page.format === 'markdown') {
    const r = stripRawHtmlFromMarkdown(page.text, { baseUrl: page.finalUrl });
    return { format: 'markdown', text: r.markdown, removed: r.removed, textChars: r.markdown.replace(/\s+/g, ' ').trim().length, title: '', hadScripts: false };
  }
  if (asHtml) {
    const r = sanitizeHtml(page.text, { baseUrl: page.finalUrl });
    return { format: 'html', text: r.html, removed: r.removed, textChars: r.textChars, title: r.title, hadScripts: r.hadScripts };
  }
  const r = htmlToMarkdown(page.text, { baseUrl: page.finalUrl });
  return { format: 'markdown', text: r.markdown, removed: r.removed, textChars: r.textChars, title: r.title, hadScripts: r.hadScripts };
}

/**
 * A doc id base for a URL: its host (without www.) and path, without a page extension or a trailing index
 * ('https://docs.example.com/spec/' -> 'docs.example.com spec'; the store slugifies it).
 * @param {string} normalized
 * @returns {string}
 */
export function slugFor(normalized) {
  const u = new URL(normalized);
  const p = decodeURIComponentSafe(u.pathname)
    .replace(/\/index\.(?:html?|md|markdown)$/i, '/')
    .replace(/\.(?:html?|md|markdown|php|aspx?)$/i, '')
    .replace(/\/+$/, '');
  return `${u.hostname.replace(/^www\./, '')} ${p.replace(/\//g, ' ')}`.replace(/\s+/g, ' ').trim();
}

/** @param {string} s */
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
