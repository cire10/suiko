// @ts-check
// The doc list's "whose turn" counts (ops/docs.js turnCounts, GET /api/docs yourTurn / withAgent): the rule of the
// doc's own turn pill (ui/model.js turnReason) at the head version, so the doc list and the open doc never disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnCounts } from '../../src/core/review/ops/docs.js';

const human = { kind: 'human', name: 'Eric' };
const agent = { kind: 'agent', name: 'claude' };

/**
 * @param {string} id @param {string} status @param {Array<'h'|'a'>} who comments in order
 * @param {string} [anchorState]
 */
const thread = (id, status, who, anchorState = 'exact') => ({
  id, status, comments: who.map((w, i) => ({ id: `c${i}`, by: w === 'h' ? human : agent, body: 'x' })),
  anchors: { 1: { v: 1, state: 'exact' }, 2: { v: 2, state: anchorState } },
});

test('turnCounts: what waits for the reviewer and what waits for the agent, like the turn pill', () => {
  const threads = [
    thread('t1', 'open', ['h']), // with the agent
    thread('t2', 'addressed', ['h', 'a']), // changed: to check
    thread('t3', 'answered', ['h', 'a', 'h']), // the reviewer replied: with the agent again
    thread('t4', 'needs_input', ['h', 'a']), // a question for the reviewer
    thread('t5', 'declined', ['h', 'a']), // the agent did not change it: the reviewer decides
    thread('t6', 'planned', ['h', 'a']), // a planned change: with the agent (it waits for Apply)
    thread('t7', 'open', ['h'], 'orphaned'), // lost its place at the head
    thread('t8', 'resolved', ['h', 'a']), // done: neither
    thread('t9', 'open', ['h']), // with the agent, but a reply of the reviewer's is pending
  ];
  const drafts = { items: [{ id: 'd1', kind: 'thread' }, { id: 'd2', kind: 'thread' }, { id: 'd3', kind: 'reply', thread: 't9' }] };
  // yours: d1, d2 (comments not sent yet) + t2, t4, t5, t7, t9; the agent's: t1, t3, t6
  assert.deepEqual(turnCounts(threads, drafts, 2), { yourTurn: 7, withAgent: 3 });
  // at v1 nothing has lost its place yet
  assert.deepEqual(turnCounts(threads, drafts, 1), { yourTurn: 6, withAgent: 4 });
  assert.deepEqual(turnCounts([], null, 1), { yourTurn: 0, withAgent: 0 });
});
