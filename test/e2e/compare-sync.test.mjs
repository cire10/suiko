// @ts-check
// Unit tests: src/ui/compare-sync.js, the scroll sync of Changes side by side (which point of the older version
// goes with a point of the newer one). Run: node --test "test/e2e/**/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeLinks, followScroll, mapThrough, monotonicChain, pairHeadings, swapAnchors, syncAnchors,
} from '../../src/ui/compare-sync.js';

test('pairHeadings: same text and occurrence, else the only heading with that text', () => {
  const main = [{ srid: 1, text: 'Intro' }, { srid: 2, text: 'Notes' }, { srid: 3, text: 'API' }, { srid: 4, text: 'Notes' },
    { srid: 5, text: ' Rollout  plan ' }, { srid: 6, text: 'New section' }];
  const base = [{ srid: 10, text: 'Intro' }, { srid: 11, text: 'Notes' }, { srid: 12, text: 'Notes' }, { srid: 13, text: 'API' },
    { srid: 14, text: 'Rollout plan' }];
  assert.deepEqual(pairHeadings(main, base), [[1, 10], [2, 11], [3, 13], [4, 12], [5, 14]]);
  // a heading that occurs more often in one version than the other pairs with the only one there is
  assert.deepEqual(pairHeadings([{ srid: 1, text: 'A' }, { srid: 2, text: 'A' }], [{ srid: 9, text: 'A' }]), [[1, 9], [2, 9]]);
  assert.deepEqual(pairHeadings([], base), []);
});

test('monotonicChain: the longest chain that never goes back in either version (a moved section is dropped)', () => {
  // the section at 500 in the newer version sits at 2000 in the older one: it moved, and cannot twist the mapping
  const pts = /** @type {Array<[number, number]>} */ ([[0, 0], [100, 100], [500, 2000], [600, 520], [900, 820], [900, 820], [1200, 1100]]);
  assert.deepEqual(monotonicChain(pts), [[0, 0], [100, 100], [600, 520], [900, 820], [1200, 1100]]);
  // ties are kept in order: a deletion (one point in the newer version, a stretch in the older one)
  assert.deepEqual(monotonicChain([[0, 0], [300, 300], [300, 450], [600, 750]]), [[0, 0], [300, 300], [300, 450], [600, 750]]);
  assert.deepEqual(monotonicChain([[NaN, 1], [0, 0]]), [[0, 0]]);
  assert.deepEqual(monotonicChain([]), []);
});

/** The newer version (main): a paragraph changed (h1, longer), a paragraph added (h2), a heading pair, the ends. */
const MAIN = {
  hunks: { h1: 400, h2: 1000, h3: null },
  hunkEnds: { h1: 520, h2: 1150 },
  headings: { 1: 0, 2: 800, 3: 1600 },
  docH: 2000,
  viewportH: 600,
};
/** The older version (base): h1 shorter, h2 not there (its lines would go at 860), one heading less. */
const BASE = {
  hunks: { h1: 400, h2: 860 },
  hunkEnds: { h1: 480, h2: 860 },
  headings: { 11: 0, 12: 760, 99: 1300 },
  docH: 1700,
  viewportH: 600,
};
const PAIRS = /** @type {Array<[number, number]>} */ ([[1, 11], [2, 12], [3, 13]]);

test('syncAnchors: matched headings, the tops and ends of the changes, the document starts and ends', () => {
  const anchors = syncAnchors(MAIN, BASE, PAIRS);
  assert.deepEqual(anchors, [[0, 0], [400, 400], [520, 480], [800, 760], [1000, 860], [1150, 860], [2000, 1700]]);
  assert.deepEqual(syncAnchors(null, BASE, PAIRS), []);
  assert.deepEqual(swapAnchors([[0, 0], [1000, 860], [1150, 860]]), [[0, 0], [860, 1000], [860, 1150]]);
});

test('mapThrough: linear between anchors, a jump over lines the leading version lacks, slope 1 outside', () => {
  const anchors = syncAnchors(MAIN, BASE, PAIRS);
  assert.equal(mapThrough(anchors, 200), 200, 'unchanged stretch');
  assert.equal(mapThrough(anchors, 460), 440, 'inside the changed paragraph: spread over its shorter counterpart');
  assert.equal(mapThrough(anchors, 1075), 860, 'inside the added paragraph: the older version waits at its place');
  assert.equal(mapThrough(anchors, 1150), 860);
  assert.equal(mapThrough(anchors, 1200), 860 + (50 * (1700 - 860)) / (2000 - 1150));
  assert.equal(mapThrough(anchors, 2100), 1800);
  assert.equal(mapThrough([], 42), 42);
  // the older version leading: past the place of the added lines the newer one jumps over them
  const back = swapAnchors(anchors);
  assert.equal(mapThrough(back, 859), 1000 - (1 * (1000 - 800)) / (860 - 760));
  assert.equal(mapThrough(back, 860), 1150);
});

test('changeLinks: changes both frames show on screen, from where each frame is scrolled; insertion points too', () => {
  const hunks = [{ id: 'h1', op: 'mod' }, { id: 'h2', op: 'add' }, { id: 'h3', op: 'del' }];
  const main = { ...MAIN, scrollY: 300 };
  const base = { ...BASE, scrollY: 300 };
  // frames 600 px high, both scrolled to 300: only h1 is on screen in both (h2 is below; h3 is not drawn anywhere)
  assert.deepEqual(changeLinks(main, base, hunks, 600), [{ id: 'h1', op: 'mod', old: [100, 180], new: [100, 220] }]);
  // scrolled on: h1 off screen in the newer frame, h2 on screen in both (the older one is the point its lines go)
  assert.deepEqual(changeLinks({ ...MAIN, scrollY: 700 }, { ...BASE, scrollY: 500 }, hunks, 600),
    [{ id: 'h2', op: 'add', old: [360, 360], new: [300, 450] }]);
  // one end off screen: no link
  assert.deepEqual(changeLinks({ ...MAIN, scrollY: 700 }, { ...BASE, scrollY: 0 }, hunks, 600), []);
  assert.deepEqual(changeLinks(main, null, hunks, 600), []);
});

test('followScroll: the line a third down stays level; tops and ends are reached together', () => {
  const anchors = syncAnchors(MAIN, BASE, PAIRS);
  const lead = (/** @type {number} */ y) => ({ y, vh: 600, docH: 2000 });
  const follow = { vh: 600, docH: 1700 };
  assert.equal(followScroll(anchors, lead(0), follow), 0, 'both at the top');
  // in the middle: the level line is 200 px down; at main y 600 that is 800 (the matched heading) -> base 760 - 200
  assert.equal(followScroll(anchors, lead(600), follow), 560);
  // at main y 875 the line is at 1075, in the added paragraph: the older version waits with its place on the line
  assert.equal(followScroll(anchors, lead(875), follow), 660);
  assert.equal(followScroll(anchors, lead(1400), follow), 1100, 'the end of the newer version: the older one at its end');
  assert.equal(followScroll(anchors, lead(5000), follow), 1100, 'clamped');
  // the older version leading, to its end
  assert.equal(followScroll(swapAnchors(anchors), { y: 1100, vh: 600, docH: 1700 }, { vh: 600, docH: 2000 }), 1400);
  // a document shorter than its frame
  assert.equal(followScroll([[0, 0], [300, 300]], { y: 0, vh: 600, docH: 300 }, { vh: 600, docH: 300 }), 0);
});
