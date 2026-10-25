import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelCriteria, panelMajorityVerdict } from '../src/conductor.ts';
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

test('a lone vote is not a majority: criteria need more than half of all judges', () => {
  const a = aggregatePanel([vote('j1', { x: true }), vote('j2', {}), vote('j3', {})]);
  assert.equal(a.perCriterion[0].majority, null);
  assert.equal(a.split, true);
  const b = aggregatePanel([vote('j1', { x: true }), vote('j2', { x: true }), vote('j3', {})]);
  assert.equal(b.majority.x, true);
});

test('an expected criterion nobody voted on is a split, not a silent pass', () => {
  const a = aggregatePanel([vote('j1', { x: true }), vote('j2', { x: true })], ['x', 'y']);
  assert.equal(a.majority.x, true);
  assert.equal('y' in a.majority, false);
  assert.equal(a.split, true);
});

// ---- criterion matching in the conductor ----
const acc = ['Core exists', 'Config loads', 'CLI prints help'];
const c = (criterion: string, pass: boolean, extra: object = {}) => ({ criterion, pass, score: pass ? 0.9 : 0.2, ...extra });

test('panelCriteria keys by the judge-supplied index first, then normalised text, then position', () => {
  // Free-text rewording but explicit indexes, out of order.
  assert.deepEqual(panelCriteria({ pass: true, criteria: [c('third thing', false, { index: 3 }), c('first thing', true, { index: 1 }), c('second', true, { index: 2 })] }, acc), { 'Core exists': true, 'Config loads': true, 'CLI prints help': false });
  // No index: normalised text match, case and punctuation ignored, any order.
  assert.deepEqual(panelCriteria({ pass: true, criteria: [c('cli prints help.', false), c('CORE EXISTS', true), c('Config  loads', true)] }, acc), { 'Core exists': true, 'Config loads': true, 'CLI prints help': false });
  // Neither: positional when the count matches.
  assert.deepEqual(panelCriteria({ pass: true, criteria: [c('a', true), c('b', false), c('c', true)] }, acc), { 'Core exists': true, 'Config loads': false, 'CLI prints help': true });
  // Count mismatch and no match: dropped, so the judge never invents a key of its own.
  assert.deepEqual(panelCriteria({ pass: true, criteria: [c('something else', true)] }, acc), { overall: true });
});

test('two judges that word their criteria differently still vote on the same keys', () => {
  const j1 = { pass: true, score: 0.9, criteria: [c('Core exists', true), c('Config loads', true)] };
  const j2 = { pass: true, score: 0.9, criteria: [c('core exists', true, { index: 1 }), c('the config loads', true, { index: 2 })] };
  const j3 = { pass: false, score: 0.3, criteria: [c('x', false, { index: 1 }), c('y', true, { index: 2 })] };
  const votes = [j1, j2, j3].map((v, i) => ({ judge: `j${i}`, model: 'm', lineage: 'default', criteria: panelCriteria(v, acc.slice(0, 2)) }));
  const agg = aggregatePanel(votes, acc.slice(0, 2));
  assert.deepEqual(agg.majority, { 'Core exists': true, 'Config loads': true });
  assert.equal(agg.split, false);
  const merged = panelMajorityVerdict([j1, j2, j3], agg.majority, acc.slice(0, 2));
  assert.deepEqual(merged.criteria!.map((x) => x.criterion), ['Core exists', 'Config loads']);
  assert.equal(merged.pass, true);
});

test('panelMajorityVerdict never adds a synthetic overall criterion and ignores non-finite scores', () => {
  const ok = { pass: true, score: 0.8, issues: [], criteria: [c('Core exists', true)] };
  const noCriteria = { pass: true, score: Number.NaN, issues: [] };
  const merged = panelMajorityVerdict([ok, noCriteria, ok], { 'Core exists': true }, ['Core exists']);
  assert.equal(merged.score, 0.8);
  assert.ok(Number.isFinite(merged.score));
  assert.deepEqual(merged.criteria!.map((x) => x.criterion), ['Core exists']);
  // Only synthetic answers: a plain overall verdict, no criteria, finite score derived from the votes.
  const bare = panelMajorityVerdict([noCriteria, noCriteria], { overall: true }, []);
  assert.equal(bare.criteria, undefined);
  assert.equal(bare.score, 1);
  // A non-finite criterion score is left out of the criterion mean.
  const nan = { pass: true, score: 0.9, issues: [], criteria: [{ criterion: 'Core exists', pass: true, score: Number.NaN }] };
  assert.equal(panelMajorityVerdict([nan, ok], { 'Core exists': true }, ['Core exists']).criteria![0].score, 0.9);
});
