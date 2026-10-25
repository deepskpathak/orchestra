import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChecks, shouldEscalatePlan, budgetLine, budgetExhausted, bestOfNAllowed, selectBestByTests, cacheReadShare } from '../src/cost.ts';

const t = (id: string, deps: string[] = [], acceptance: string[] = ['ok']) => ({ id, deps, acceptance });

test('planChecks: clean, empty, cycle, unknown dep, no acceptance', () => {
  assert.deepEqual(planChecks([t('A'), t('B', ['A'])]), []);
  assert.equal(planChecks([]).length, 1);
  assert.ok(planChecks([t('A', ['B']), t('B', ['A'])]).some((i) => i.includes('cycle')));
  assert.ok(planChecks([t('A', ['Z'])]).some((i) => i.includes('unknown task Z')));
  assert.ok(planChecks([t('A', [], [])]).some((i) => i.includes('no acceptance')));
});

test('shouldEscalatePlan', () => {
  assert.equal(shouldEscalatePlan({ confidence: 0.9, threshold: 0.7, issues: [] }).escalate, false);
  assert.equal(shouldEscalatePlan({ confidence: 0.5, threshold: 0.7, issues: [] }).escalate, true);
  assert.equal(shouldEscalatePlan({ threshold: 0.7, issues: [] }).escalate, true);
  assert.equal(shouldEscalatePlan({ confidence: 0.99, threshold: 0.7, issues: ['x'] }).escalate, true);
});

test('budgetLine and budgetExhausted', () => {
  const b = { turnsUsed: 3, maxTurns: 10, usdSpent: 0.5, usdCap: 2 };
  const l = budgetLine(b);
  assert.match(l, /7 turns remaining/);
  assert.match(l, /\$1\.50 remaining/);
  assert.match(l, /hard cap/);
  assert.equal(budgetExhausted(b), false);
  assert.equal(budgetExhausted({ ...b, turnsUsed: 10 }), true);
  assert.equal(budgetExhausted({ ...b, usdSpent: 2 }), true);
});

test('bestOfNAllowed', () => {
  assert.equal(bestOfNAllowed({ n: 3, hasExecutableVerifier: false }), 1);
  assert.equal(bestOfNAllowed({ n: 3, hasExecutableVerifier: true }), 3);
});

test('selectBestByTests', () => {
  assert.equal(selectBestByTests([{ id: 'a', testsPassed: 3, testsTotal: 5 }, { id: 'b', testsPassed: 5, testsTotal: 5 }])?.id, 'b');
  assert.equal(selectBestByTests([{ id: 'a', testsPassed: 5, testsTotal: 5 }, { id: 'b', testsPassed: 5, testsTotal: 5 }]), undefined);
  assert.equal(selectBestByTests([{ id: 'a', testsPassed: 5, testsTotal: 5, distinguishingPasses: 2 }, { id: 'b', testsPassed: 5, testsTotal: 5, distinguishingPasses: 1 }])?.id, 'a');
  assert.equal(selectBestByTests([]), undefined);
});

test('cacheReadShare', () => {
  assert.equal(cacheReadShare([{ inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 }]), 0.6);
  assert.equal(cacheReadShare([{}]), undefined);
  assert.equal(cacheReadShare([]), undefined);
});
