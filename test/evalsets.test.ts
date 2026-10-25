import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitEvals, needsHumanSignoff, holdoutLeaks, promptHasNoHoldout } from '../src/evalsets.ts';
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
