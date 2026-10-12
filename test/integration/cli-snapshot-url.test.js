// @ts-check
// `specreview snapshot <url>` against the real engine (main() in-process, ensureDaemon stubbed) and a local HTTP
// server on 127.0.0.1 (hence --allow-private): the url doc (kind snapshot, origin url, key url:<normalized>,
// render.network block, synthetic web/<id>.md), what the stored text keeps and drops (scripts, event handlers,
// javascript: URLs), refusals (no --allow-private, SPECREVIEW_OFFLINE, user-level network.allow false), re-runs
// (identical: nothing recorded; changed: vN+1; --replies posts replies), --as-html, --allow-remote-assets, the
// JavaScript-page note, and the feedback packet's basis line and NEXT for a page the agent builds.

import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as ops from '../../src/core/review/index.js';
import { main } from '../../src/cli/main.js';
import { memorySink } from '../../src/cli/io.js';
import { slugFor } from '../../src/cli/commands/snapshot.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const DAEMON = { pid: 1, uiPort: 5873, contentPort: 5874, token: 'tok', secret: 's', version: '0.1.0', startedAt: '' };
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'web');

/** Bodies served by path (tests change them to simulate an edited page). */
/** @type {Record<string, { type: string, body: string }>} */
let pages = {};
/** @type {string[]} */
const hits = [];
/** @type {http.Server} */
let server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(String(req.url), 'http://x').pathname;
    hits.push(p);
    if (p === '/moved') {
      res.writeHead(301, { Location: '/spec.html' });
      res.end();
      return;
    }
    const page = pages[p];
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': page.type });
    res.end(page.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
});
after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
});

/** @type {Awaited<ReturnType<typeof makeWorkspace>>} */
let ws;
beforeEach(async () => {
  ws = await makeWorkspace({ files: [] });
  fs.mkdirSync(path.join(ws.root, '.git'));
  pages = {
    '/spec.html': { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(WEB, 'spec.html'), 'utf8') },
    '/hostile.html': { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(WEB, 'hostile.html'), 'utf8') },
    '/notes.md': { type: 'text/plain; charset=utf-8', body: '# Notes\n\n* one\n* two\n\n<script>alert(1)</script>\n' },
    '/app.html': { type: 'text/html', body: '<html><head><title>App</title><script src="/bundle.js"></script></head><body><div id="root">Loading…</div></body></html>' },
    '/empty.html': { type: 'text/html', body: '<html><head><script src="/bundle.js"></script></head><body><div id="root"></div></body></html>' },
  };
});
afterEach(async () => {
  await ws.cleanup();
});

const url = (/** @type {string} */ p) => `http://127.0.0.1:${port}${p}`;

/**
 * Runs the CLI in-process (ensureDaemon and the browser stubbed).
 * @param {string[]} argv
 * @param {{ input?: string, env?: Record<string, string> }} [o]
 */
async function cli(argv, o = {}) {
  const out = memorySink();
  const err = memorySink();
  const code = await main(argv, {
    cwd: ws.root,
    env: { SPECREVIEW_BROWSER: 'none', SPECREVIEW_HOME: ws.home, HOME: process.env.HOME, ...(o.env ?? {}) },
    stdin: Readable.from(o.input !== undefined ? [Buffer.from(o.input)] : []),
    stdout: out,
    stderr: err,
    ensureDaemon: async () => /** @type {any} */ (DAEMON),
    openBrowser: async () => {},
    pollMs: 50,
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

/** @param {string} id */
async function docOf(id) {
  const ctx = await engineCtx(ws.root);
  return ctx.store.requireDoc(id);
}

/** @param {string} id @param {number} v */
function versionText(id, v) {
  return fs.readFileSync(path.join(ws.root, '.specreview', 'docs', id, 'versions', `${String(v).padStart(4, '0')}.${id.endsWith('html') ? 'html' : 'md'}`), 'utf8');
}

/**
 * The reviewer comments on `quote` in the doc's head and submits.
 * @param {string} docId
 * @param {string} quote
 */
async function review(docId, quote) {
  const ctx = await engineCtx(ws.root);
  const doc = await ctx.store.requireDoc(docId);
  const render = await ctx.render(doc, doc.head);
  await ops.saveDraft(ctx, docId, { kind: 'thread', type: 'comment', capture: textCapture(render, quote), body: 'Say why.' });
  await ops.submitReview(ctx, docId, { verdict: 'changes_requested', body: '' });
}

describe('snapshot <url>', () => {
  test('--allow-private records a Markdown url doc that blocks remote assets', async () => {
    const r = await cli(['snapshot', url('/spec.html'), '--allow-private']);
    assert.equal(r.code, 0, r.stderr);
    const id = '127-0-0-1-spec';
    const lines = r.stdout.trimEnd().split('\n');
    assert.match(lines[0], new RegExp(`^specreview: tracking web page as "${id}" \\(markdown, \\d+ lines\\) · recorded v1 · removed 1 element$`));
    assert.match(lines[1], new RegExp(`^review UI: http://127\\.0\\.0\\.1:5873/d/[^/]+/${id}\\?k=tok$`));
    assert.match(r.stdout, /^next: run `specreview wait 127-0-0-1-spec` in the background\. When the review arrives, change the sources that produce the page, then record what it serves with `specreview snapshot http:\/\/127\.0\.0\.1:\d+\/spec\.html --allow-private --replies -`/m);
    // the page's image is an absolute URL now: the review UI does not load it
    assert.match(r.stdout, new RegExp(`^remote images and styles are blocked in the review UI \\(127\\.0\\.0\\.1:${port}\\); --allow-remote-assets loads them$`, 'm'));

    const doc = /** @type {any} */ (await docOf(id));
    assert.equal(doc.kind, 'snapshot');
    assert.equal(doc.path, `web/${id}.md`);
    assert.equal(doc.format, 'markdown');
    assert.equal(doc.title, 'Token Service Spec');
    assert.deepEqual(doc.render, { network: 'block' });
    assert.equal(doc.origin.type, 'url');
    assert.equal(doc.origin.key, `url:${url('/spec.html')}`);
    assert.equal(doc.origin.url, url('/spec.html'));
    assert.equal(doc.origin.private, true);
    assert.match(doc.origin.fetchedAt, /^\d{4}-\d\d-\d\dT/);

    const text = versionText(id, 1);
    assert.match(text, /^# Token Service$/m);
    assert.match(text, /^- Give up after `3` attempts\.$/m);
    assert.match(text, new RegExp(`!\\[Flow\\]\\(http://127\\.0\\.0\\.1:${port}/img/flow\\.png\\)`));
    assert.match(text, /\[RFC\]\(https:\/\/example\.org\/rfc\)/);
    assert.equal(/Home|Copyright|document\.title|track\(\)|<script/.test(text), false, text);
    const manifest = JSON.parse(fs.readFileSync(path.join(ws.root, '.specreview', 'docs', id, 'versions', '0001.json'), 'utf8'));
    assert.equal(manifest.origin.status, 200);
    assert.equal(manifest.origin.removed, 1);
    assert.equal(manifest.origin.reader, 'auto');
    assert.equal(fs.existsSync(path.join(ws.root, 'web')), false, 'nothing written at the synthetic path');
  });

  test('a hostile page: scripts, event handlers and javascript: URLs never reach the stored text', async () => {
    const r = await cli(['snapshot', url('/hostile.html'), '--allow-private', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.format, 'markdown');
    assert.equal(j.renderNetwork, 'block');
    assert.ok(j.removed >= 10);
    const text = versionText(j.doc, 1);
    for (const marker of ['onerror', 'onclick', 'javascript:', 'evil.example', 'TEMPLATE', 'SVG_SCRIPT', 'formaction']) {
      assert.equal(text.includes(marker), false, `${marker} in:\n${text}`);
    }
    // the page's own escaped "<script>" text is kept as escaped text, never as a tag
    assert.equal(/(^|[^\\])<script/m.test(text), false, text);
    assert.match(text, /Refresh tokens are \*\*rotated\*\*/);
  });

  test('a private host without --allow-private is refused (exit 3) and nothing is stored', async () => {
    const before = hits.length;
    const r = await cli(['snapshot', url('/spec.html')]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /refusing to fetch 127\.0\.0\.1: it resolves to a non-public address .*--allow-private/);
    assert.equal(hits.length, before, 'no request was sent');
    assert.equal(fs.existsSync(path.join(ws.root, '.specreview')), false);
  });

  test('offline: SPECREVIEW_OFFLINE=1 and the user-level network.allow false refuse before any request (exit 3)', async () => {
    const before = hits.length;
    const a = await cli(['snapshot', url('/spec.html'), '--allow-private'], { env: { SPECREVIEW_OFFLINE: '1' } });
    assert.equal(a.code, 3);
    assert.match(a.stderr, /the network is turned off \(SPECREVIEW_OFFLINE is set\); nothing was fetched/);
    fs.writeFileSync(path.join(ws.home, 'config.json'), JSON.stringify({ network: { allow: false } }));
    const b = await cli(['snapshot', url('/spec.html'), '--allow-private']);
    assert.equal(b.code, 3);
    assert.match(b.stderr, /network\.allow is false in .*config\.json/);
    assert.equal(hits.length, before);
  });

  test('re-running: identical content records nothing, changed content records v2, the key follows the normalized URL', async () => {
    assert.equal((await cli(['snapshot', url('/spec.html'), '--allow-private'])).code, 0);
    const same = await cli(['snapshot', `HTTP://127.0.0.1:${port}/spec.html#retries`, '--allow-private']);
    assert.equal(same.code, 0, same.stderr);
    assert.match(same.stdout, /^specreview: "127-0-0-1-spec" \(web page\) is unchanged \(identical to v1\)$/m);
    assert.equal((await docOf('127-0-0-1-spec')).head, 1);

    pages['/spec.html'].body = pages['/spec.html'].body.replace('3 times', '5 times');
    const changed = await cli(['snapshot', url('/spec.html'), '--allow-private']);
    assert.equal(changed.code, 0, changed.stderr);
    assert.match(changed.stdout, /^specreview: recorded v2 of "127-0-0-1-spec" \(web page; \+1 -1 lines\) · removed 1 element$/m);
    assert.match(versionText('127-0-0-1-spec', 2), /retry 5 times/);
    const dirs = fs.readdirSync(path.join(ws.root, '.specreview', 'docs'));
    assert.deepEqual(dirs, ['127-0-0-1-spec'], 'one doc for the URL');
  });

  test('a redirect: the key is the URL given, the final URL is reported', async () => {
    const r = await cli(['snapshot', url('/moved'), '--allow-private', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.page.url, url('/moved'));
    assert.equal(j.page.finalUrl, url('/spec.html'));
    assert.equal(j.page.redirects, 1);
    const doc = /** @type {any} */ (await docOf(j.doc));
    assert.equal(doc.origin.key, `url:${url('/moved')}`);
    assert.equal(doc.origin.finalUrl, url('/spec.html'));
  });

  test('the review loop: the packet names the page, NEXT says to change its sources and snapshot again with --replies', async () => {
    assert.equal((await cli(['snapshot', url('/spec.html'), '--allow-private'])).code, 0);
    const id = '127-0-0-1-spec';
    await review(id, 'exponential backoff');
    const fb = await cli(['feedback', id]);
    assert.equal(fb.code, 0, fb.stderr);
    assert.match(fb.stdout, /^SPECREVIEW FEEDBACK · 127-0-0-1-spec \(web page\) · review rv1 on v1/m);
    assert.match(fb.stdout, new RegExp(`^Line numbers = lines of SpecReview's Markdown snapshot of http://127\\.0\\.0\\.1:${port}/spec\\.html \\(fetched \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\); there is no file for you to edit\\.$`, 'm'));
    assert.match(fb.stdout, /^PROTOCOL: the doc is a snapshot of a web page, not a file: change the sources that produce the page/m);
    assert.match(fb.stdout, new RegExp(`^NEXT: edit the sources that produce the page -> specreview snapshot http://127\\.0\\.0\\.1:${port}/spec\\.html --allow-private --replies - \\(records v2\\) -> specreview wait ${id} \\(background\\)$`, 'm'));

    // revise without --source explains how a web page is revised
    const rev = await cli(['revise', id]);
    assert.equal(rev.code, 1);
    assert.match(rev.stderr, /change the sources that produce the page, then record what the page serves now with `specreview snapshot http:\/\/127\.0\.0\.1:\d+\/spec\.html --allow-private --replies -`/);

    // the page changes; the snapshot records v2 and posts the reply in the same step
    pages['/spec.html'].body = pages['/spec.html'].body.replace('with exponential backoff', 'with exponential backoff (base 2, capped at 5 s)');
    const replies = JSON.stringify({ threads: { t1: { status: 'addressed', reply: 'Spelled out the backoff.' } } });
    const r = await cli(['snapshot', url('/spec.html'), '--allow-private', '--replies', '-'], { input: replies });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^specreview: recorded v2 of "127-0-0-1-spec" \(web page; \+1 -1 lines\) · removed 1 element · posted 1 reply$/m);
    const ctx = await engineCtx(ws.root);
    const t1 = /** @type {any} */ (await ctx.store.getThread(id, 't1'));
    assert.equal(t1.status, 'addressed');
    assert.equal(t1.comments.at(-1).body, 'Spelled out the backoff.');

    // identical page + replies: the replies only
    const again = await cli(['snapshot', url('/spec.html'), '--allow-private', '--replies', '-'], { input: JSON.stringify({ threads: { t1: { status: 'answered', reply: 'Also see the RFC.' } } }) });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /is unchanged \(identical to v2\) · posted 1 reply$/m);
  });

  test('a public page gets a reply-only NEXT and protocol (no file, nothing to edit)', async () => {
    assert.equal((await cli(['snapshot', url('/spec.html'), '--allow-private'])).code, 0);
    const id = '127-0-0-1-spec';
    // as if the page had been fetched from a public host
    const ctx = await engineCtx(ws.root);
    const doc = /** @type {any} */ (await ctx.store.requireDoc(id));
    doc.origin.private = false;
    await ctx.store.saveDoc(doc);
    await review(id, 'exponential backoff');
    const fb = await cli(['feedback', id]);
    assert.match(fb.stdout, /^PROTOCOL: the doc is a snapshot of a public web page: there is nothing for you to edit\./m);
    assert.match(fb.stdout, new RegExp(`^NEXT: answer each thread with specreview reply ${id} <tid> -m <md> --status answered\\|declined -> specreview wait ${id} \\(background\\)$`, 'm'));
  });

  test('--as-html keeps the sanitized HTML; the format cannot change later', async () => {
    const r = await cli(['snapshot', url('/hostile.html'), '--allow-private', '--as-html', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.format, 'html');
    const doc = await docOf(j.doc);
    assert.equal(doc.path, `web/${j.doc}.html`);
    const html = fs.readFileSync(path.join(ws.root, '.specreview', 'docs', j.doc, 'versions', '0001.html'), 'utf8');
    assert.equal(/<script|\son[a-z]+=|javascript:|evil\.example|<form|<iframe/i.test(html), false, html);
    assert.match(html, /<h1 id="user-content-SR"[^>]*>Token service<\/h1>/);
    const md = await cli(['snapshot', url('/hostile.html'), '--allow-private']);
    assert.equal(md.code, 1);
    assert.match(md.stderr, /tracks this URL as HTML: run it with --as-html/);
  });

  test('fetched Markdown loses its raw HTML; --allow-remote-assets flips the doc to allow and back', async () => {
    const r = await cli(['snapshot', url('/notes.md'), '--allow-private', '--allow-remote-assets', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.renderNetwork, 'allow');
    assert.equal(j.removed, 1);
    assert.equal(versionText(j.doc, 1).includes('<script'), false);
    assert.deepEqual(/** @type {any} */ (await docOf(j.doc)).render, { network: 'allow' });
    assert.equal((await cli(['snapshot', url('/notes.md'), '--allow-private'])).code, 0);
    assert.deepEqual(/** @type {any} */ (await docOf(j.doc)).render, { network: 'block' });
  });

  test('a page rendered by JavaScript: a note with little text, an error with none', async () => {
    const a = await cli(['snapshot', url('/app.html'), '--allow-private']);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /^note: little text was found; it is probably rendered by JavaScript, which SpecReview never runs$/m);
    const b = await cli(['snapshot', url('/empty.html'), '--allow-private']);
    assert.equal(b.code, 1);
    assert.match(b.stderr, /has no text to review \(it is probably rendered by JavaScript/);
  });

  test('usage: a bad URL, a bad reader, an HTTP error', async () => {
    assert.equal((await cli(['snapshot', 'not a url'])).code, 1);
    assert.equal((await cli(['snapshot', url('/spec.html'), '--reader', 'magic'])).code, 1);
    const missing = await cli(['snapshot', url('/nope.html'), '--allow-private']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /HTTP 404 Not Found from/);
    const ftp = await cli(['snapshot', 'ftp://example.com/spec.md']);
    assert.equal(ftp.code, 3);
  });

  test('slugFor: host and path, without www, extensions and index pages', () => {
    assert.equal(slugFor('https://www.example.com/docs/spec.html'), 'example.com docs spec');
    assert.equal(slugFor('https://docs.example.com/guide/'), 'docs.example.com guide');
    assert.equal(slugFor('https://docs.example.com/guide/index.html'), 'docs.example.com guide');
    assert.equal(slugFor('https://example.com/'), 'example.com');
  });
});
