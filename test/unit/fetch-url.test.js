// @ts-check
// `specreview snapshot <url>` fetching (cli/fetch-url.js), with no internet: local HTTP servers on 127.0.0.1
// (allowPrivate), and an injected DNS `lookup` plus an injected `request` that connects to the local server while
// the URL names a "public" host, to test what happens after a public hop. Covers the address rules (private,
// mapped, NAT64, decimal and hex literals, mixed answers), pinning, redirects re-checked (public -> private refused),
// the redirect, size (declared, streamed, decompressed) and time limits, content-type dispatch, charset decoding, the
// GitHub blob rewrite, the Jina reader rules, DNS failures and the offline / network.allow policy.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { NotFoundError, RefusedError } from '../../src/core/store/errors.js';
import { EXIT } from '../../src/shared/protocol.js';
import { fetchForSnapshot, githubRawUrl, isPublicAddress, networkRefusal, normalizeUrl, stripJinaHeader, userSnapshotConfig } from '../../src/cli/fetch-url.js';

const PUBLIC_IP = '93.184.216.34';

/** @type {http.Server} */
let server;
let port = 0;
/** @type {Array<{ url: string, headers: http.IncomingHttpHeaders }>} */
const hits = [];
/** @type {Set<import('node:net').Socket>} */
const sockets = new Set();

/** @type {Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>} */
const routes = {
  '/page.html': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: '"v1"' });
    res.end('<!doctype html><title>Page</title><p>Hello</p>');
  },
  '/spec.md': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('# Spec\n\nText.\n');
  },
  '/notes': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end('# Notes\n');
  },
  '/plain': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('plain text');
  },
  '/json': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  },
  '/untyped': (_req, res) => {
    res.writeHead(200);
    res.end('<!DOCTYPE html><html><body><p>untyped</p></body></html>');
  },
  '/latin1': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=windows-1252' });
    res.end(Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])); // <p>café</p>
  },
  '/meta-charset': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><p>na'), Buffer.from([0xef]), Buffer.from('ve</p>')]));
  },
  '/missing': (_req, res) => {
    res.writeHead(404, 'Not Found', { 'Content-Type': 'text/html' });
    res.end('nope');
  },
  '/big-declared': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '5000' });
    res.end('x'.repeat(5000));
  },
  '/big-chunked': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    for (let i = 0; i < 5; i++) res.write('y'.repeat(1000));
    res.end();
  },
  '/gzip-bomb': (_req, res) => {
    const z = zlib.gzipSync(Buffer.alloc(200 * 1024, 0x61));
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': String(z.length) });
    res.end(z);
  },
  '/gzip-ok': (_req, res) => {
    const z = zlib.gzipSync(Buffer.from('<p>compressed</p>'));
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
    res.end(z);
  },
  '/hang': () => {
    // never answers
  },
  '/stall-body': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<p>start');
  },
  '/to-private': (_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${port}/page.html` });
    res.end();
  },
  '/to-lan-name': (_req, res) => {
    res.writeHead(301, { Location: '/../page.html' });
    res.end();
  },
  '/to-ten': (_req, res) => {
    res.writeHead(307, { Location: 'http://intranet.test/page.html' });
    res.end();
  },
  '/hop': (req, res) => {
    const n = Number(new URL(String(req.url), 'http://x').searchParams.get('n') ?? 0);
    res.writeHead(302, { Location: n >= 3 ? '/page.html' : `/hop?n=${n + 1}` });
    res.end();
  },
  '/loop': (req, res) => {
    const n = Number(new URL(String(req.url), 'http://x').searchParams.get('n') ?? 0);
    res.writeHead(302, { Location: `/loop?n=${n + 1}` });
    res.end();
  },
  '/jina': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Title: Rendered page\nURL Source: https://docs.test/app\n\nMarkdown Content:\n# Rendered\n\nBody.\n');
  },
};

before(async () => {
  server = http.createServer((req, res) => {
    hits.push({ url: String(req.url), headers: req.headers });
    const route = routes[new URL(String(req.url), 'http://x').pathname];
    if (route) route(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
});
after(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(() => r(undefined)));
});

const local = (/** @type {string} */ p) => `http://127.0.0.1:${port}${p}`;

/**
 * A fake DNS: names map to address lists; anything else is ENOTFOUND.
 * @param {Record<string, string[]>} table
 */
function fakeLookup(table) {
  /** @type {string[]} */
  const asked = [];
  /** @type {import('../../src/cli/fetch-url.js').Lookup & { asked: string[] }} */
  const fn = Object.assign(
    async (/** @type {string} */ host) => {
      asked.push(host);
      const list = table[host];
      if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    { asked },
  );
  return fn;
}

/**
 * An injected request function: whatever host the URL names, connect to the local server (the URL's path and
 * query are kept, and its host goes into the Host header). Records each URL and the pinned address.
 */
function toLocal() {
  /** @type {Array<{ url: string, pinned: any }>} */
  const seen = [];
  /** @type {any} */
  const request = (/** @type {URL} */ url, /** @type {any} */ opts) => {
    /** @type {any} */
    let pinned = null;
    opts.lookup(url.hostname, { all: true }, (/** @type {any} */ _e, /** @type {any} */ addrs) => {
      pinned = addrs;
    });
    seen.push({ url: url.href, pinned });
    return http.request({ host: '127.0.0.1', port, path: `${url.pathname}${url.search}`, method: 'GET', headers: { ...opts.headers, host: url.host }, signal: opts.signal, agent: false });
  };
  return { request, seen };
}

describe('address rules', () => {
  test('isPublicAddress', () => {
    const cases = /** @type {Array<[string, boolean]>} */ ([
      ['8.8.8.8', true], [PUBLIC_IP, true], ['2606:4700:4700::1111', true], ['::ffff:8.8.8.8', true], ['64:ff9b::808:808', true],
      ['127.0.0.1', false], ['127.255.0.9', false], ['0.0.0.0', false], ['10.0.0.1', false], ['172.16.5.4', false], ['172.31.255.255', false],
      ['192.168.1.1', false], ['169.254.169.254', false], ['100.64.0.1', false], ['224.0.0.1', false], ['255.255.255.255', false],
      ['198.18.0.1', false], ['192.0.2.1', false], ['::', false], ['::1', false], ['::ffff:127.0.0.1', false], ['::ffff:7f00:1', false],
      ['::ffff:10.0.0.1', false], ['64:ff9b::a00:1', false], ['64:ff9b::127.0.0.1', false], ['2002:7f00:1::', false], ['2002:c0a8:101::1', false],
      ['fc00::1', false], ['fd00:1234::1', false], ['fe80::1', false], ['fe80::1%eth0', false], ['ff02::1', false], ['2001:db8::1', false],
      ['2001::1', false], ['[::1]', false], ['not-an-ip', false], ['', false],
    ]);
    for (const [ip, expected] of cases) assert.equal(isPublicAddress(ip), expected, ip);
  });

  test('a loopback page is refused without allowPrivate (exit 3), fetched with it', async () => {
    await assert.rejects(fetchForSnapshot(local('/page.html')), (err) => err instanceof RefusedError && err.exit === EXIT.REFUSED && /non-public address \(127\.0\.0\.1\).*--allow-private/.test(err.message));
    const r = await fetchForSnapshot(local('/page.html'), { allowPrivate: true });
    assert.equal(r.format, 'html');
    assert.equal(r.status, 200);
    assert.equal(r.private, true);
    assert.equal(r.etag, '"v1"');
    assert.equal(r.finalUrl, local('/page.html'));
    assert.match(r.text, /<p>Hello<\/p>/);
    assert.match(String(hits.at(-1)?.headers['user-agent']), /^specreview\//);
  });

  test('literal forms of private addresses are refused before any connection', async () => {
    const before = hits.length;
    for (const u of [
      `http://[::ffff:127.0.0.1]:${port}/page.html`, `http://[::1]:${port}/`, `http://0.0.0.0:${port}/`, `http://2130706433:${port}/page.html`,
      `http://0x7f.0.0.1:${port}/page.html`, `http://017700000001:${port}/`, `http://[64:ff9b::a00:1]/`, 'http://169.254.169.254/latest/meta-data/',
    ]) {
      await assert.rejects(fetchForSnapshot(u), RefusedError, u);
    }
    assert.equal(hits.length, before, 'nothing reached the server');
  });

  test('a name with one private address among public ones is refused; localhost too', async () => {
    const lookup = fakeLookup({ 'mixed.test': [PUBLIC_IP, '10.0.0.5'], localhost: ['127.0.0.1', '::1'] });
    await assert.rejects(fetchForSnapshot('http://mixed.test/', { lookup }), (err) => err instanceof RefusedError && /10\.0\.0\.5/.test(err.message));
    await assert.rejects(fetchForSnapshot(`http://localhost:${port}/page.html`, { lookup }), RefusedError);
  });

  test('URLs with user info, and other schemes, are refused', async () => {
    await assert.rejects(fetchForSnapshot(`http://user:pw@127.0.0.1:${port}/page.html`, { allowPrivate: true }), (err) => err instanceof RefusedError && /user name or password/.test(err.message));
    await assert.rejects(fetchForSnapshot('file:///etc/passwd'), RefusedError);
    await assert.rejects(fetchForSnapshot('ftp://example.com/x'), RefusedError);
  });

  test('a host that does not resolve is NotFound (exit 4)', async () => {
    await assert.rejects(fetchForSnapshot('https://nowhere.test/', { lookup: fakeLookup({}) }), (err) => err instanceof NotFoundError && err.exit === EXIT.NOT_FOUND && /ENOTFOUND/.test(err.message));
  });
});

describe('redirects', () => {
  test('a public page redirecting to a private address is refused, and the request was pinned', async () => {
    const lookup = fakeLookup({ 'public.test': [PUBLIC_IP] });
    const { request, seen } = toLocal();
    await assert.rejects(
      fetchForSnapshot('http://public.test/to-private', { lookup, request }),
      (err) => err instanceof RefusedError && /127\.0\.0\.1/.test(err.message) && /redirected from public\.test/.test(err.message),
    );
    assert.equal(seen.length, 1, 'the private hop was never requested');
    assert.deepEqual(seen[0].pinned, [{ address: PUBLIC_IP, family: 4 }], 'connected to the checked address only');
  });

  test('a redirect to a name that resolves privately is refused (each hop is resolved again)', async () => {
    const lookup = fakeLookup({ 'public.test': [PUBLIC_IP], 'intranet.test': ['192.168.1.20'] });
    const { request } = toLocal();
    await assert.rejects(fetchForSnapshot('http://public.test/to-ten', { lookup, request }), (err) => err instanceof RefusedError && /intranet\.test/.test(err.message));
    assert.deepEqual(lookup.asked, ['public.test', 'intranet.test']);
  });

  test('redirects are followed (relative locations too) and counted; more than the limit is an error (exit 1)', async () => {
    const ok = await fetchForSnapshot(local('/hop'), { allowPrivate: true });
    assert.equal(ok.redirects, 4);
    assert.equal(ok.finalUrl, local('/page.html'));
    const rel = await fetchForSnapshot(local('/to-lan-name'), { allowPrivate: true });
    assert.equal(rel.finalUrl, local('/page.html'));
    await assert.rejects(fetchForSnapshot(local('/loop'), { allowPrivate: true }), (err) => /** @type {any} */ (err).code === 'NETWORK' && /** @type {any} */ (err).exit === 1 && /too many redirects \(more than 10\)/.test(/** @type {Error} */ (err).message));
    await assert.rejects(fetchForSnapshot(local('/hop'), { allowPrivate: true, maxRedirects: 2 }), /too many redirects \(more than 2\)/);
  });
});

describe('limits', () => {
  test('a declared, a streamed and a decompressed body over maxBytes are refused (exit 3)', async () => {
    for (const p of ['/big-declared', '/big-chunked']) {
      await assert.rejects(fetchForSnapshot(local(p), { allowPrivate: true, maxBytes: 1024 }), (err) => err instanceof RefusedError && /larger than 1 KB/.test(err.message), p);
    }
    await assert.rejects(fetchForSnapshot(local('/gzip-bomb'), { allowPrivate: true, maxBytes: 10 * 1024 }), (err) => err instanceof RefusedError && /larger than 10 KB/.test(err.message));
    const gz = await fetchForSnapshot(local('/gzip-ok'), { allowPrivate: true });
    assert.equal(gz.text, '<p>compressed</p>');
  });

  test('the total time limit covers waiting for the answer and for the body (exit 1)', async () => {
    for (const p of ['/hang', '/stall-body']) {
      const t0 = Date.now();
      await assert.rejects(fetchForSnapshot(local(p), { allowPrivate: true, timeoutMs: 300 }), (err) => /** @type {any} */ (err).code === 'NETWORK' && /timed out after/.test(/** @type {Error} */ (err).message), p);
      assert.ok(Date.now() - t0 < 3000, `${p} took ${Date.now() - t0} ms`);
    }
  });

  test('an HTTP error status is an error with the status line (exit 1)', async () => {
    await assert.rejects(fetchForSnapshot(local('/missing'), { allowPrivate: true }), (err) => /** @type {any} */ (err).exit === 1 && /HTTP 404 Not Found from/.test(/** @type {Error} */ (err).message));
  });
});

describe('content types', () => {
  test('dispatch: markdown, text/plain on a .md path, html, untyped html; others refused', async () => {
    const opts = { allowPrivate: true };
    assert.equal((await fetchForSnapshot(local('/notes'), opts)).format, 'markdown');
    assert.equal((await fetchForSnapshot(local('/spec.md'), opts)).format, 'markdown');
    assert.match(String(hits.at(-1)?.headers.accept), /^text\/markdown, text\/plain/);
    assert.equal((await fetchForSnapshot(local('/page.html'), opts)).format, 'html');
    assert.match(String(hits.at(-1)?.headers.accept), /^text\/markdown, text\/html;q=0\.9/);
    assert.equal((await fetchForSnapshot(local('/untyped'), opts)).format, 'html');
    for (const p of ['/plain', '/json']) await assert.rejects(fetchForSnapshot(local(p), opts), (err) => err instanceof RefusedError && /unsupported content type/.test(err.message), p);
  });

  test('charsets: the header, then a <meta charset>', async () => {
    assert.equal((await fetchForSnapshot(local('/latin1'), { allowPrivate: true })).text, '<p>café</p>');
    assert.match((await fetchForSnapshot(local('/meta-charset'), { allowPrivate: true })).text, /naïve/);
  });
});

describe('readers', () => {
  test('auto rewrites a github.com blob page of a .md file to raw.githubusercontent.com; direct does not', async () => {
    assert.equal(String(githubRawUrl(new URL('https://github.com/o/r/blob/main/docs/spec.md'))), 'https://raw.githubusercontent.com/o/r/main/docs/spec.md');
    assert.equal(githubRawUrl(new URL('https://github.com/o/r/blob/main/src/a.js')), null);
    const lookup = fakeLookup({ 'raw.githubusercontent.com': [PUBLIC_IP], 'github.com': [PUBLIC_IP] });
    const a = toLocal();
    routes['/o/r/main/spec.md'] = routes['/spec.md'];
    const r = await fetchForSnapshot('https://github.com/o/r/blob/main/spec.md', { lookup, request: a.request });
    assert.equal(a.seen[0].url, 'https://raw.githubusercontent.com/o/r/main/spec.md');
    assert.equal(r.format, 'markdown');
    assert.equal(r.finalUrl, 'https://raw.githubusercontent.com/o/r/main/spec.md');
    const b = toLocal();
    await assert.rejects(fetchForSnapshot('https://github.com/o/r/blob/main/spec.md', { lookup, request: b.request, reader: 'direct' }));
    assert.equal(b.seen[0].url, 'https://github.com/o/r/blob/main/spec.md');
  });

  test('jina: refused for a private host even with allowPrivate; drops the query with a note; strips its header', async () => {
    const before = hits.length;
    await assert.rejects(fetchForSnapshot(local('/page.html'), { reader: 'jina', allowPrivate: true }), (err) => err instanceof RefusedError && /r\.jina\.ai/.test(err.message));
    assert.equal(hits.length, before);
    const lookup = fakeLookup({ 'docs.test': [PUBLIC_IP], 'r.jina.ai': ['1.1.1.1'] });
    const { request, seen } = toLocal();
    routes['/https://docs.test/app'] = routes['/jina'];
    /** @type {string[]} */
    const notes = [];
    const r = await fetchForSnapshot('https://docs.test/app?token=secret#frag', { reader: 'jina', lookup, request, notes });
    assert.equal(seen[0].url, 'https://r.jina.ai/https://docs.test/app');
    assert.equal(seen[0].url.includes('secret'), false);
    assert.deepEqual(notes, ['--reader jina: the query string was dropped (it is not sent to r.jina.ai)']);
    assert.equal(r.format, 'markdown');
    assert.equal(r.reader, 'jina');
    assert.equal(r.title, 'Rendered page');
    assert.equal(r.text, '# Rendered\n\nBody.\n');
    assert.equal(r.finalUrl, 'https://docs.test/app?token=secret');
    assert.deepEqual(stripJinaHeader('# no header\n'), { text: '# no header\n', title: '' });
  });
});

describe('policy and identity', () => {
  test('SPECREVIEW_OFFLINE and the user-level network.allow refuse; a workspace config cannot', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-fetch-home-'));
    try {
      assert.equal(networkRefusal({ SPECREVIEW_HOME: home }), null);
      assert.match(String(networkRefusal({ SPECREVIEW_HOME: home, SPECREVIEW_OFFLINE: '1' })), /SPECREVIEW_OFFLINE/);
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ network: { allow: false }, snapshot: { reader: 'direct' } }));
      assert.match(String(networkRefusal({ SPECREVIEW_HOME: home })), /network\.allow is false in .*config\.json/);
      assert.deepEqual(userSnapshotConfig({ SPECREVIEW_HOME: home }), { reader: 'direct' });
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ snapshot: { reader: 'jina' } }));
      assert.deepEqual(userSnapshotConfig({ SPECREVIEW_HOME: home }), { reader: 'auto' }, 'jina is never a default');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('normalizeUrl lowercases scheme and host, drops the default port and the fragment, keeps the query', () => {
    assert.equal(normalizeUrl('HTTPS://Docs.Example.COM:443/A/b?x=1&y=2#top'), 'https://docs.example.com/A/b?x=1&y=2');
    assert.equal(normalizeUrl('http://example.com:80'), 'http://example.com/');
    assert.equal(normalizeUrl('http://example.com:8080/x'), 'http://example.com:8080/x');
  });
});
