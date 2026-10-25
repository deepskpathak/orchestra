import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePanel, lineageFraming, pairwiseBothOrders, type PanelJudgeVote } from '../src/panel.ts';

const vote = (judge: string, criteria: Record<string, boolean>): PanelJudgeVote => ({ judge, model: 'm', lineage: 'default', criteria });

test('unanimous panel has zero disagreement and no split', () => {
  const a = aggregatePanel([vote('j1', { x: true, y: false }), vote('j2', { x: true, y: false }), vote('j3', { x: true, y: false })]);
  assert.deepEqual(a.majority, { x: true, y: false });
  assert.equal(a.disagreement, 0);
  assert.equal(a.split, false);
});

test('2-1 majority: per-criterion disagreement is the minority share', () => {
  const a = aggregatePanel([vote('j1', { x: true, y: true }), vote('j2', { x: true, y: true }), vote('j3', { x: false, y: true })]);
  assert.equal(a.majority.x, true);
  assert.equal(a.perCriterion[0].disagreement, 1 / 3);
  assert.equal(a.perCriterion[1].disagreement, 0);
  assert.equal(a.disagreement, 1 / 6);
  assert.equal(a.split, false);
});

test('tie on any criterion is a split with no majority entry', () => {
  const a = aggregatePanel([vote('j1', { x: true, y: true }), vote('j2', { x: false, y: true })]);
  assert.equal(a.split, true);
  assert.equal('x' in a.majority, false);
  assert.equal(a.perCriterion[0].majority, null);
  assert.equal(a.perCriterion[0].disagreement, 0.5);
  assert.equal(a.majority.y, true);
});

test('empty panel is not a split', () => {
  const a = aggregatePanel([]);
  assert.equal(a.split, false);
  assert.equal(a.disagreement, 0);
});

test('pairwiseBothOrders: agree when both orders name the same candidate', () => {
  assert.equal(pairwiseBothOrders('A', 'B'), 'A'); // swapped run picked its B, which is the original A
  assert.equal(pairwiseBothOrders('B', 'A'), 'B');
});

test('pairwiseBothOrders: position bias or missing pick yields null', () => {
  assert.equal(pairwiseBothOrders('A', 'A'), null);
  assert.equal(pairwiseBothOrders('B', 'B'), null);
  assert.equal(pairwiseBothOrders('A', null), null);
  assert.equal(pairwiseBothOrders(undefined, 'A'), null);
});

test('lineage framing differs per lineage and is empty for default', () => {
  assert.equal(lineageFraming(undefined), '');
  assert.equal(lineageFraming('default'), '');
  assert.notEqual(lineageFraming('strict'), lineageFraming('literal'));
  assert.match(lineageFraming('custom-x'), /custom-x/);
});
