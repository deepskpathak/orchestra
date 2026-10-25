import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sequentialDecision, roundsOf, BudgetTracker, utility, costGate } from '../src/selection.ts';
import { DEFAULT_PROJECT_CONFIG } from '../src/store.ts';

const mk = (deltas: number[]) => deltas.map((d, i) => ({ goal: `g${i}`, incumbent: 0.5, candidate: 0.5 + d }));

test('roundsOf splits into consecutive rounds', () => {
  assert.deepEqual(roundsOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(roundsOf([1, 2], 0), [[1, 2]]);
  assert.deepEqual(roundsOf([], 3), []);
});

test('sequentialDecision promotes early on consistent gains', () => {
  const r = sequentialDecision(mk([0.2, 0.25, 0.22, 0.18]), { roundSize: 2, totalCases: 20 });
  assert.equal(r.verdict, 'promote');
  assert.equal(r.exhausted, false);
  assert.ok(r.ci[0] > 0);
});

test('sequentialDecision rejects early on consistent losses', () => {
  const r = sequentialDecision(mk([-0.2, -0.25, -0.22, -0.18]), { roundSize: 2, totalCases: 20 });
  assert.equal(r.verdict, 'reject');
  assert.ok(r.ci[1] < 0);
});

test('sequentialDecision rejects when upper bound is below the margin', () => {
  const r = sequentialDecision(mk([-0.2, -0.21, -0.19, -0.2]), { roundSize: 2, niMargin: 0.1 });
  assert.equal(r.verdict, 'reject');
});

test('sequentialDecision continues when the CI straddles zero', () => {
  const r = sequentialDecision(mk([0.3, -0.3, 0.2, -0.2]), { roundSize: 2, totalCases: 10 });
  assert.equal(r.verdict, 'continue');
});

test('one source goal gives an unbounded CI and continue, never NaN', () => {
  const one = [1, 2, 3].map((d) => ({ goal: 'same', incumbent: 0.5, candidate: 0.5 + d / 10 }));
  const r = sequentialDecision(one, { roundSize: 1, totalCases: 3 });
  assert.equal(r.verdict, 'continue');
  assert.equal(r.exhausted, true);
  assert.ok(!r.ci.some(Number.isNaN));
  assert.equal(sequentialDecision([], { roundSize: 1 }).verdict, 'continue');
});

test('BudgetTracker exhausts exactly at the cap', () => {
  const b = new BudgetTracker(1);
  b.add(0.6);
  assert.equal(b.exhausted, false);
  assert.equal(b.wouldExceed(0.5), true);
  assert.equal(b.wouldExceed(0.4), false);
  b.add(0.4);
  assert.equal(b.spent, 1);
  assert.equal(b.exhausted, true);
});

test('BudgetTracker cap 0 or undefined is unlimited', () => {
  for (const cap of [0, undefined]) {
    const b = new BudgetTracker(cap);
    b.add(1e6);
    assert.equal(b.exhausted, false);
    assert.equal(b.wouldExceed(1e9), false);
  }
});

test('utility rises with score and falls with cost or time', () => {
  const w = { costWeight: 0.1, timeWeight: 0.02 };
  const base = { score: 0.7, costUsd: 1, durationMs: 60000 };
  assert.ok(utility({ ...base, score: 0.8 }, w) > utility(base, w));
  assert.ok(utility({ ...base, costUsd: 2 }, w) < utility(base, w));
  assert.ok(utility({ ...base, durationMs: 120000 }, w) < utility(base, w));
});

test('costGate rejects equal quality at +30% cost and accepts when gain matches', () => {
  const incumbent = { score: 0.7, costUsd: 1 };
  const bad = costGate({ incumbent, candidate: { score: 0.7, costUsd: 1.3 }, maxCostRisePct: 10, minGainForCost: 0.05 });
  assert.equal(bad.ok, false);
  const good = costGate({ incumbent, candidate: { score: 0.76, costUsd: 1.3 }, maxCostRisePct: 10, minGainForCost: 0.05 });
  assert.equal(good.ok, true);
  assert.equal(costGate({ incumbent, candidate: { score: 0.7, costUsd: 1.05 }, maxCostRisePct: 10, minGainForCost: 0.05 }).ok, true);
  assert.equal(costGate({ incumbent: { score: 0.7, costUsd: 0 }, candidate: { score: 0.7, costUsd: 1 }, maxCostRisePct: 10, minGainForCost: 0.05 }).ok, true);
});

test('new evolve options default to off', () => {
  const e = DEFAULT_PROJECT_CONFIG.evolve;
  assert.equal(e.budgetUsd, 0);
  assert.equal(e.sequential?.enabled, false);
  assert.equal(e.cost?.enabled, false);
});
