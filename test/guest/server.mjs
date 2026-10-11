// @ts-check
// Two-origin static harness for the guest tests.
//   UI origin      (http://127.0.0.1:<uiPort>):      /parent.html?doc=<name>  - embeds the doc iframe and speaks the
//                  protocol: answers the guest's `hello` with a MessageChannel `connect`, records every message on
//                  window.__msgs (hello from the window, everything else from the port) and exposes
//                  window.__send(type, payload) to talk to the guest over the port.
//   content origin (http://127.0.0.1:<contentPort>): /doc/<name>.html - a fixture from test/guest/fixtures with the
//                  guest <script> tag inserted right after <head> (as the daemon does); /__sr/guest.js - the bundle
//                  from buildGuestBundle(); /img/*.png - PNGs generated in memory (plain zlib, no deps);
//                  /raw/<name>.html - the same fixture without the guest (baseline for observe-only checks).
// Both servers bind 127.0.0.1 on port 0 by default (never the default SpecReview ports).

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { buildGuestBundle } from '../../src/guest/build.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** @param {Buffer} buf */
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * Encodes an RGBA PNG.
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number, number]} pixel
 * @returns {Buffer}
 */
export function makePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], row + 1 + x * 4);
    }
  }
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 300x200 four-quadrant test image (red, green, blue, yellow). */
const ARCH_PNG = makePng(300, 200, (x, y) => {
  if (y < 100) return x < 150 ? [220, 40, 40, 255] : [40, 180, 60, 255];
  return x < 150 ? [40, 70, 220, 255] : [240, 200, 30, 255];
});

/** @param {import('node:http').Server} server @param {number} port */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

/**
 * Starts both servers.
 * @param {{ uiPort?: number, contentPort?: number }} [opts]
 */
export async function startHarness(opts = {}) {
  const bundle = buildGuestBundle();
  /** @type {{ ui: string, content: string }} */
  const origins = { ui: '', content: '' };

  const content = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const send = (/** @type {number} */ code, /** @type {string} */ type, /** @type {string|Buffer} */ body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/__sr/guest.js') return send(200, 'text/javascript; charset=utf-8', bundle);
    if (url.pathname === '/img/arch.png') return send(200, 'image/png', ARCH_PNG);
    const raw = /^\/raw\/([a-z0-9-]+)\.html$/.exec(url.pathname);
    if (raw && existsSync(join(FIXTURES, raw[1] + '.html'))) {
      return send(200, 'text/html; charset=utf-8', readFileSync(join(FIXTURES, raw[1] + '.html'), 'utf8'));
    }
    const m = /^\/doc\/([a-z0-9-]+)\.html$/.exec(url.pathname);
    if (m && existsSync(join(FIXTURES, m[1] + '.html'))) {
      const src = readFileSync(join(FIXTURES, m[1] + '.html'), 'utf8');
      const tag = `<script src="${origins.content}/__sr/guest.js" data-sr-ui="${origins.ui} http://localhost:${new URL(origins.ui).port}" ` +
        `data-sr-target="ws1/${m[1]}/v1" data-sr-ignore></script>`;
      const at = src.search(/<head[^>]*>/i);
      const html = at < 0 ? tag + src : src.replace(/<head[^>]*>/i, (h) => h + tag);
      return send(200, 'text/html; charset=utf-8', html);
    }
    return send(404, 'text/plain', 'not found');
  });

  const ui = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/parent.html') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const doc = (url.searchParams.get('doc') || 'prose').replace(/[^a-z0-9-]/g, '');
    const docUrl = `${origins.content}/doc/${doc}.html`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>guest harness</title>
<style>html,body{margin:0;padding:0;background:#fff}iframe{display:block;border:0;width:900px;height:700px}</style>
</head><body>
<iframe id="doc" src="${docUrl}" referrerpolicy="no-referrer"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"></iframe>
<script>
  const contentOrigin = ${JSON.stringify(origins.content)};
  const frame = document.getElementById('doc');
  window.__msgs = [];
  window.__port = null;
  window.addEventListener('message', (ev) => {
    if (ev.source !== frame.contentWindow || ev.origin !== contentOrigin) return;
    const d = ev.data;
    if (!d || d.sr !== 1 || d.type !== 'hello') return;
    window.__msgs.push(d);
    if (window.__port) return;
    const ch = new MessageChannel();
    window.__port = ch.port1;
    ch.port1.onmessage = (e) => window.__msgs.push(e.data);
    frame.contentWindow.postMessage({ sr: 1, type: 'connect' }, contentOrigin, [ch.port2]);
  });
  window.__send = (type, payload) => window.__port.postMessage(Object.assign({ sr: 1, type }, payload || {}));
</script></body></html>`);
  });

  const uiPort = await listen(ui, opts.uiPort ?? 0);
  const contentPort = await listen(content, opts.contentPort ?? 0);
  origins.ui = `http://127.0.0.1:${uiPort}`;
  origins.content = `http://127.0.0.1:${contentPort}`;

  return {
    uiOrigin: origins.ui,
    contentOrigin: origins.content,
    /** @param {string} doc */
    parentUrl: (doc) => `${origins.ui}/parent.html?doc=${encodeURIComponent(doc)}`,
    /** @param {string} doc */
    docUrl: (doc) => `${origins.content}/doc/${doc}.html`,
    /** @param {string} doc */
    rawUrl: (doc) => `${origins.content}/raw/${doc}.html`,
    async close() {
      for (const s of [ui, content]) {
        s.closeAllConnections?.();
        await new Promise((resolve) => s.close(() => resolve(undefined)));
      }
    },
  };
}
