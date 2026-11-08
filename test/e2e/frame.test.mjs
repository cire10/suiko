// @ts-check
// Unit tests (node:test) for the UI side of the guest channel, src/ui/frame.js GuestBridge: every load gets a fresh
// nonce on the frame's URL, and only a hello that carries it (from the frame's window, at the content origin) is
// answered with a port, once. A `bye` closes the port; a hello that no load asked for brings the frame back with a
// new load, at most every STRAY_RELOAD_MS. No browser: the iframe is a stand-in object, and a small resolve hook maps
// the UI's bare `protocol` import to src/shared/protocol.js.
// Run: node --test test/e2e/frame.test.mjs

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, test } from 'node:test';

register('./protocol-hook.mjs', import.meta.url);
/** @type {any} */ (globalThis).window = new EventTarget();

const { GuestBridge, STRAY_RELOAD_MS, helloNonce, nonceUrl } = await import('../../src/ui/frame.js');
const { HELLO_NONCE_PARAM, MSG } = await import('../../src/shared/protocol.js');

const CONTENT = 'http://127.0.0.1:4778';
const DOC = `${CONTENT}/c/0123456789abcdef01234567/v2/docs/spec.html`;

/** Ports the tests hold (closed after each test, so the process can exit). @type {MessagePort[]} */
const held = [];
afterEach(() => {
  for (const p of held.splice(0)) p.close();
});

/** A stand-in iframe whose window records what the bridge posts to it. */
function makeFrame() {
  /** @type {{ msg: any, origin: string, transfer: MessagePort[] }[]} */
  const posted = [];
  const contentWindow = {
    /** @param {any} msg @param {string} origin @param {MessagePort[]} [transfer] */
    postMessage(msg, origin, transfer = []) {
      held.push(...transfer);
      posted.push({ msg, origin, transfer });
    },
  };
  return { src: '', contentWindow, posted };
}

/** A bridge bound to a fresh stand-in frame, with its callbacks counted. */
function setup() {
  const bridge = new GuestBridge();
  const frame = makeFrame();
  const calls = { hello: 0, bye: 0, stray: 0, messages: /** @type {string[]} */ ([]) };
  bridge.setHandlers({
    onHello: () => calls.hello++,
    onBye: () => calls.bye++,
    onStray: () => calls.stray++,
    onMessage: (type) => calls.messages.push(type),
  });
  bridge.attach(/** @type {any} */ (frame), CONTENT);
  return { bridge, frame, calls };
}

/** The nonce of the frame's current URL. @param {{ src: string }} frame */
const nonceOf = (frame) => new URL(frame.src).searchParams.get(HELLO_NONCE_PARAM);

/**
 * A hello as the window 'message' listener sees it.
 * @param {any} frame @param {Record<string, any>} [fields] @param {{ source?: any, origin?: string }} [from]
 */
function hello(frame, fields = {}, from = {}) {
  return /** @type {any} */ ({
    source: from.source ?? frame.contentWindow,
    origin: from.origin ?? CONTENT,
    data: { sr: 1, type: MSG.HELLO, target: 'ws/spec/v2', href: DOC, highlightApi: true, guestVersion: 2, ...fields },
  });
}

/** Lets queued MessagePort messages arrive. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('load() puts a fresh 128-bit nonce in the query of the frame URL', () => {
  const { bridge, frame } = setup();
  bridge.load(DOC);
  const url = new URL(frame.src);
  assert.equal(url.origin + url.pathname, DOC);
  assert.match(nonceOf(frame) ?? '', /^[0-9a-f]{32}$/);
  assert.equal(bridge.src, DOC, 'the doc URL is kept without the nonce');
  const first = nonceOf(frame);
  bridge.load(DOC);
  assert.notEqual(nonceOf(frame), first, 'every load has its own nonce');
  assert.notEqual(helloNonce(), helloNonce());
  // the nonce goes in the query, before a fragment, next to other parameters
  assert.equal(nonceUrl('http://x/a.html#s', 'n1'), `http://x/a.html?${HELLO_NONCE_PARAM}=n1#s`);
  assert.equal(nonceUrl('http://x/a.html?q=1', 'n1'), `http://x/a.html?q=1&${HELLO_NONCE_PARAM}=n1`);
  bridge.detach();
});

test("only the hello with the load's nonce gets a port, and only once", async () => {
  const { bridge, frame, calls } = setup();
  bridge.load(DOC);
  const nonce = nonceOf(frame);
  // no nonce, a wrong one, another window, another origin: no port
  bridge.onWindowMessage(hello(frame));
  bridge.onWindowMessage(hello(frame, { nonce: '0'.repeat(32) }));
  bridge.onWindowMessage(hello(frame, { nonce }, { source: {} }));
  bridge.onWindowMessage(hello(frame, { nonce }, { origin: 'http://127.0.0.1:9999' }));
  assert.equal(frame.posted.length, 0);
  assert.equal(calls.hello, 0);
  assert.equal(calls.stray, 0, 'a load is under way: nothing is reloaded');

  bridge.onWindowMessage(hello(frame, { nonce }));
  assert.equal(frame.posted.length, 1);
  const [connect] = frame.posted;
  assert.deepEqual(connect.msg, { sr: 1, type: MSG.CONNECT });
  assert.equal(connect.origin, CONTENT, 'posted to the content origin only');
  assert.equal(connect.transfer.length, 1);
  assert.equal(calls.hello, 1);
  assert.equal(bridge.helloSeq, 1);
  assert.deepEqual(bridge.hello, { target: 'ws/spec/v2', href: DOC, highlightApi: true, guestVersion: 2 });

  // the same nonce again (or any other hello) while the page is connected: no second port, no reload
  bridge.onWindowMessage(hello(frame, { nonce }));
  bridge.onWindowMessage(hello(frame));
  assert.equal(frame.posted.length, 1);
  assert.equal(calls.stray, 0);

  // the channel works: ready, then messages both ways
  const port2 = connect.transfer[0];
  /** @type {any[]} */
  const toGuest = [];
  port2.onmessage = (e) => toGuest.push(e.data);
  assert.equal(bridge.send(MSG.SET_HIDDEN, { hidden: true }), false, 'nothing is sent before ready');
  port2.postMessage({ sr: 1, type: MSG.READY, title: 'Spec' });
  await tick();
  assert.equal(bridge.connected, true);
  assert.deepEqual(calls.messages, [MSG.READY]);
  assert.equal(bridge.send(MSG.SET_HIDDEN, { hidden: true }), true);
  await tick();
  assert.deepEqual(toGuest, [{ hidden: true, sr: 1, type: MSG.SET_HIDDEN }]);
  bridge.detach();
});

test('bye closes the port; the next hello without a nonce loads the frame again, at most every STRAY_RELOAD_MS', async () => {
  const { bridge, frame, calls } = setup();
  bridge.load(DOC);
  bridge.onWindowMessage(hello(frame, { nonce: nonceOf(frame) }));
  const port2 = frame.posted[0].transfer[0];
  port2.postMessage({ sr: 1, type: MSG.READY });
  await tick();
  assert.equal(bridge.connected, true);

  port2.postMessage({ sr: 1, type: MSG.BYE });
  await tick();
  assert.equal(calls.bye, 1);
  assert.equal(bridge.port, null);
  assert.equal(bridge.connected, false);
  assert.equal(bridge.send(MSG.SET_HIDDEN, { hidden: true }), false);

  // the page reloaded itself: its guest says hello without a nonce. It gets no port, and the bridge asks for a load.
  bridge.onWindowMessage(hello(frame, { nonce: '' }));
  assert.equal(frame.posted.length, 1, 'no port for it');
  assert.equal(calls.stray, 1);
  bridge.onWindowMessage(hello(frame, { nonce: '' }));
  assert.equal(calls.stray, 1, 'not again within STRAY_RELOAD_MS');
  bridge.strayAt -= STRAY_RELOAD_MS + 1;
  bridge.onWindowMessage(hello(frame, { nonce: '' }));
  assert.equal(calls.stray, 2, 'again once STRAY_RELOAD_MS passed');

  // the load the app makes then connects as usual
  bridge.load(DOC);
  bridge.onWindowMessage(hello(frame, { nonce: nonceOf(frame) }));
  assert.equal(frame.posted.length, 2);
  assert.equal(bridge.helloSeq, 2);
  bridge.detach();
});

test('reset() and attach() to another frame forget the pending nonce; a closed port never reaches the app', async () => {
  const { bridge, frame, calls } = setup();
  bridge.load(DOC);
  const nonce = nonceOf(frame);
  bridge.reset();
  bridge.onWindowMessage(hello(frame, { nonce }));
  assert.equal(frame.posted.length, 0, 'the nonce of a load that was given up is never answered');

  bridge.load(DOC);
  const other = makeFrame();
  const pending = nonceOf(frame);
  bridge.attach(/** @type {any} */ (other), CONTENT);
  bridge.onWindowMessage(hello(other, { nonce: pending }));
  bridge.onWindowMessage(hello(frame, { nonce: pending }));
  assert.equal(frame.posted.length + other.posted.length, 0);

  // a port the bridge closed delivers nothing more
  bridge.load(DOC);
  bridge.onWindowMessage(hello(other, { nonce: nonceOf(other) }));
  const port2 = other.posted[0].transfer[0];
  bridge.reset();
  port2.postMessage({ sr: 1, type: MSG.READY });
  await tick();
  assert.deepEqual(calls.messages, []);
  bridge.detach();
});
