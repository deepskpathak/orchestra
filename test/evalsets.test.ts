import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATIOS, holdoutRunIds, splitEvals, stickySplit, needsHumanSignoff, holdoutLeaks, promptHasNoHoldout } from '../src/evalsets.ts';
import type { EvalCase } from '../src/evolve.ts';

const mk = (n: number): EvalCase[] => Array.from({ length: n }, (_, i) => ({ id: `c${String(i).padStart(2, '0')}`, goal: `goal number ${i}`, base: 'x', createdAt: 1000 + i }));
const ids = (a: EvalCase[]) => a.map((c) => c.id);

test('default ratios give 30/50/20 on 10 and 20 cases', () => {
  for (const [n, want] of [[10, [3, 5, 2]], [20, [6, 10, 4]]] as const) {
    const s = splitEvals(mk(n));
    assert.deepEqual([s.feedback.length, s.validation.length, s.holdout.length], want);
  }
});

test('deterministic under shuffling; newest to holdout, oldest to feedback; disjoint and covering', () => {
  const cases = mk(10);
  const shuffled = [...cases].reverse().sort((a, b) => (a.id.charCodeAt(2) % 3) - (b.id.charCodeAt(2) % 3));
  const a = splitEvals(cases), b = splitEvals(shuffled);
  assert.deepEqual(a, b);
  assert.deepEqual(ids(a.holdout), ['c08', 'c09']);
  assert.deepEqual(ids(a.feedback), ['c00', 'c01', 'c02']);
  const all = [...a.feedback, ...a.validation, ...a.holdout];
  assert.equal(new Set(ids(all)).size, 10);
});

test('ties on createdAt break by id', () => {
  const cases: EvalCase[] = ['b', 'a', 'd', 'c'].map((id) => ({ id, goal: id, base: 'x', createdAt: 5 }));
  const s = splitEvals(cases);
  assert.deepEqual(ids(s.holdout), ['d']);
  assert.deepEqual(ids(s.feedback), ['a']);
});

test('cases without createdAt sort oldest and do not crash', () => {
  const cases = [...mk(4), { id: 'zz', goal: 'legacy', base: 'x' }];
  const s = splitEvals(cases);
  assert.equal(s.feedback[0].id, 'zz');
  assert.equal(s.holdout.length, 1);
  assert.doesNotThrow(() => splitEvals([]));
});

test('holdout has at least one case from 3 cases up; small sets stay valid', () => {
  assert.equal(splitEvals(mk(3)).holdout.length, 1);
  assert.equal(splitEvals(mk(3)).validation.length, 1);
  assert.equal(splitEvals(mk(0)).holdout.length, 0);
  for (let n = 3; n < 15; n++) {
    const s = splitEvals(mk(n));
    assert.ok(s.holdout.length >= 1);
    assert.equal(s.feedback.length + s.validation.length + s.holdout.length, n);
  }
});

test('needsHumanSignoff threshold', () => {
  assert.equal(needsHumanSignoff(11), true);
  assert.equal(needsHumanSignoff(12), false);
  assert.equal(needsHumanSignoff(5, 5), false);
});

test('holdout leak check', () => {
  const { holdout } = splitEvals(mk(10));
  assert.ok(promptHasNoHoldout('goal number 1 and c01', holdout));
  assert.equal(promptHasNoHoldout('see goal number 9 here', holdout), false);
  assert.deepEqual(holdoutLeaks('case c08 failed', holdout), ['c08']);
});

test('stickySplit equals splitEvals when nothing was assigned before', () => {
  for (const n of [0, 1, 2, 3, 5, 10, 17, 30]) {
    const s = stickySplit(mk(n));
    const want = splitEvals(mk(n));
    assert.deepEqual([ids(s.feedback), ids(s.validation), ids(s.holdout)], [ids(want.feedback), ids(want.validation), ids(want.holdout)], `n=${n}`);
  }
});

test('stickySplit never moves a holdout case out of the holdout as new cases arrive', () => {
  let assignment = stickySplit(mk(10)).assignment;
  const firstHoldout = ids(stickySplit(mk(10)).holdout);
  assert.deepEqual(firstHoldout, ['c08', 'c09']);
  for (const n of [11, 14, 20, 40]) {
    const s = stickySplit(mk(n), DEFAULT_RATIOS, assignment);
    assignment = s.assignment;
    for (const id of firstHoldout) assert.ok(ids(s.holdout).includes(id), `${id} still holdout at n=${n}`);
    assert.ok(!ids(s.feedback).some((id) => firstHoldout.includes(id)));
    // Disjoint and covering, and the holdout does not balloon past its share.
    const all = [...s.feedback, ...s.validation, ...s.holdout];
    assert.equal(new Set(ids(all)).size, n);
    assert.ok(s.holdout.length <= Math.round(n * 0.2) + 1, `holdout ${s.holdout.length} of ${n}`);
  }
  // A plain re-split with the time window slid would have pushed c08 out of the holdout.
  assert.ok(!ids(splitEvals(mk(40)).holdout).includes('c08'));
});

test('stickySplit keeps earlier validation and feedback assignments too, and is stable when re-run', () => {
  const first = stickySplit(mk(10));
  const again = stickySplit(mk(10), DEFAULT_RATIOS, first.assignment);
  assert.deepEqual(again, first);
  const grown = stickySplit(mk(15), DEFAULT_RATIOS, first.assignment);
  for (const name of ['feedback', 'validation', 'holdout'] as const) for (const id of ids(first[name])) assert.ok(ids(grown[name]).includes(id), `${id} stays ${name}`);
});

test('holdoutRunIds finds the harvested run and runs with the same goal text', () => {
  const hold: EvalCase[] = [{ id: 'r1', goal: 'fix the parser', base: 'x', harvestedFrom: 'r1' }, { id: 'm-x', goal: 'add retry', base: 'x' }];
  const runs = [{ id: 'r1', goal: 'fix the parser' }, { id: 'r2', goal: ' add retry ' }, { id: 'r3', goal: 'other' }];
  assert.deepEqual([...holdoutRunIds(runs, hold)].sort(), ['r1', 'r2']);
});

test('holdoutLeaks matches an id only as a whole token', () => {
  const hold: EvalCase[] = [{ id: 'x', goal: 'a very particular goal', base: 'b' }];
  assert.deepEqual(holdoutLeaks('example text inside words like box and x-ray', hold), []);
  assert.deepEqual(holdoutLeaks('case x failed', hold), ['x']);
  assert.deepEqual(holdoutLeaks('prefix a very particular goal suffix', hold), ['x']);
});
