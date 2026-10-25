import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cohensKappa, naiveSe, pairedDecision, pairedStats, passAt1, passHatK } from '../src/stats.ts';
import { promotionDecision } from '../src/evolve.ts';

const mk = (deltas: number[], taskType = 'bugfix', prefix = 'g') =>
  deltas.map((d, k) => ({ goal: `${prefix}${k}`, taskType, incumbent: 0.5, candidate: 0.5 + d }));

test('promote when the CI lower bound is above zero', () => {
  const r = pairedDecision({ cases: mk(Array.from({ length: 30 }, (_, k) => 0.2 + (k % 2) * 0.02)), niMargin: 0.05, minCases: 5 });
  assert.equal(r.verdict, 'promote');
  assert.ok(r.ci[0] > 0);
  assert.equal(r.unproven, true);
  assert.match(r.reason, /unproven/);
});

test('reject when the CI upper bound is below zero', () => {
  const r = pairedDecision({ cases: mk(Array.from({ length: 20 }, (_, k) => -0.3 - (k % 2) * 0.02)), niMargin: 0.5, minCases: 5 });
  assert.equal(r.verdict, 'reject');
  assert.ok(r.ci[1] < 0);
});

test('inconclusive when the CI spans zero or there are too few cases', () => {
  const noisy = pairedDecision({ cases: mk([0.4, -0.3, 0.2, -0.2, 0.1, 0, 0.3, -0.4]), niMargin: 0.5, minCases: 5 });
  assert.equal(noisy.verdict, 'inconclusive');
  assert.ok(noisy.ci[0] < 0 && noisy.ci[1] > 0);
  assert.equal(pairedDecision({ cases: mk([0.5, 0.5]), niMargin: 0.05, minCases: 5 }).verdict, 'inconclusive');
});

test('a task type regressing beyond the margin vetoes an otherwise clear gain', () => {
  const cases = [...mk(Array.from({ length: 40 }, () => 0.3), 'feature', 'f'), ...mk([-0.2, -0.2, -0.2], 'refactor', 'r')];
  const r = pairedDecision({ cases, niMargin: 0.05, minCases: 5 });
  assert.ok(r.ci[0] > 0);
  assert.equal(r.verdict, 'reject');
  assert.match(r.reason, /refactor/);
  assert.equal(pairedDecision({ cases, niMargin: 0.3, minCases: 5 }).verdict, 'promote');
});

test('clustered SE differs from naive SE when clusters are correlated, and matches when singleton', () => {
  const cases = [0.5, 0.5, 0.5, 0.5, -0.1, -0.1, -0.1, -0.1].map((d, k) => ({ goal: k < 4 ? 'a' : 'b', incumbent: 0, candidate: d }));
  assert.ok(pairedStats(cases).se > naiveSe(cases) * 2);
  const single = mk([0.1, 0.3, 0.2, 0.5, 0]);
  assert.ok(Math.abs(pairedStats(single).se - naiveSe(single)) < 1e-12);
});

test('pass@1 and pass^3 match hand-computed values', () => {
  assert.equal(passAt1(5, 4), 0.8);
  assert.ok(Math.abs(passHatK(5, 4, 3)! - 0.4) < 1e-12); // C(4,3)/C(5,3) = 4/10
  assert.equal(passHatK(5, 2, 3), 0);
  assert.equal(passHatK(3, 3), 1);
  assert.equal(passHatK(2, 2), undefined);
});

test("Cohen's kappa on a known table and degenerate cases", () => {
  // 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no: po 0.7, pe 0.5, kappa 0.4
  const a: boolean[] = [], b: boolean[] = [];
  const add = (n: number, x: boolean, y: boolean) => { for (let k = 0; k < n; k++) { a.push(x); b.push(y); } };
  add(20, true, true); add(5, true, false); add(10, false, true); add(15, false, false);
  assert.ok(Math.abs(cohensKappa(a, b) - 0.4) < 1e-12);
  assert.equal(cohensKappa([true, true], [true, true]), 1);
  assert.equal(cohensKappa([false, false], [false, false]), 1);
  assert.equal(cohensKappa([], []), 0);
});

const base = { regressions: [] as string[], minGain: 0.02, minCases: 5, incumbent: 'v1' };

test('promotionDecision paired rule promotes only when the CI lower bound is above zero', () => {
  const inc = Array(8).fill(0.5);
  const good = promotionDecision({ ...base, rule: 'paired', incumbentScores: inc, candidateScores: [0.8, 0.82, 0.8, 0.82, 0.8, 0.82, 0.8, 0.82] });
  assert.equal(good.promote, true);
  assert.ok(good.ci![0] > 0);
  assert.match(good.reason, /95% CI \[.*pass@1 .*pass\^3/);
  const noisy = promotionDecision({ ...base, rule: 'paired', incumbentScores: inc, candidateScores: [0.9, 0.2, 0.8, 0.3, 0.9, 0.2, 0.8, 0.3] });
  assert.equal(noisy.promote, false);
});

test('default gain rule is unchanged but still reports ci, pass@1 and pass^3', () => {
  const d = promotionDecision({ ...base, incumbentScores: [0, 0, 0, 0, 0], candidateScores: [1, 1, 1, 1, 1] });
  assert.equal(d.promote, true);
  assert.deepEqual(d.ci, [1, 1]);
  assert.equal(d.passAt1, 1);
  assert.equal(d.passHat3, undefined);
  assert.match(d.reason, /pass\^3 n\/a/);
});

// ---- W9.0 exploration and footprint ----
import { countToolUse, explorationMetrics, footprintAccuracy, plannedFiles, renderExploration } from '../src/exploration.ts';
import { fakeRunner } from '../src/fake.ts';

test('countToolUse tallies mixed tool_use blocks by name and ignores other messages', () => {
  const counts: Record<string, number> = {};
  countToolUse({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Grep' }] } }, counts);
  countToolUse({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }] } }, counts);
  countToolUse({ type: 'user', message: { content: [{ type: 'tool_use', name: 'Glob' }] } }, counts);
  countToolUse({ type: 'result' }, counts);
  assert.deepEqual(counts, { Read: 2, Grep: 1, Bash: 1 });
});

test('fake runner reports toolCounts', async () => {
  const res = await fakeRunner()({ role: 'planner', prompt: '', system: '', cwd: '.', model: 'm', budgetUsd: 1 });
  assert.deepEqual(res.toolCounts, { Glob: 1, Read: 1 });
});

test('footprint precision and recall, with n/a for empty sets', () => {
  assert.deepEqual(footprintAccuracy(['a', 'b'], ['b', 'c', 'd']), { precision: 0.5, recall: 1 / 3 });
  assert.deepEqual(footprintAccuracy([], ['a']), { precision: undefined, recall: 0 });
  assert.deepEqual(footprintAccuracy(['a'], []), { precision: 0, recall: undefined });
  assert.deepEqual(footprintAccuracy([], []), { precision: undefined, recall: undefined });
});

test('plannedFiles matches only listed repo paths', () => {
  const files = ['src/a.ts', 'src/b.ts', 'README.md'];
  assert.deepEqual(plannedFiles('Edit `src/a.ts`, then (README.md). Not src/c.ts or a.ts.', files), ['src/a.ts', 'README.md']);
});

test('explorationMetrics aggregates per version and role, legacy rows do not crash', () => {
  const base = { t: 0, run: 'r', kind: 'goal' as const, model: 'm', ok: true, durationMs: 0 };
  const m = explorationMetrics([
    { ...base, harness: 'v1', role: 'worker', costUsd: 1, turns: 4, inputTokens: 10, cacheReadTokens: 5, toolCounts: { Read: 3, Grep: 1 } },
    { ...base, harness: 'v1', role: 'worker', costUsd: 1, turns: 2 },
    { ...base, harness: 'v1', role: 'worker', costUsd: 0, turns: 0, outcome: 'merged', footprint: { planned: ['a'], changed: ['a', 'b'] } },
    { ...base, harness: 'v1', role: 'worker', costUsd: 0, turns: 0, outcome: 'merged', footprint: { planned: [], changed: ['a'] } },
  ]);
  assert.equal(m.roles.length, 1);
  assert.deepEqual([m.roles[0].calls, m.roles[0].turns, m.roles[0].read, m.roles[0].grep, m.roles[0].glob], [2, 6, 3, 1, 0]);
  assert.equal(m.footprint[0].precision, 1);
  assert.equal(m.footprint[0].recall, 0.25);
  assert.equal(m.footprint[0].declaredTasks, 0);
  const text = renderExploration(m);
  const withDeclared = explorationMetrics([{ ...base, harness: 'v1', role: 'worker', costUsd: 0, turns: 0, outcome: 'merged', footprint: { planned: [], changed: ['a', 'b'], declared: ['a'] } }]);
  assert.deepEqual([withDeclared.footprint[0].declaredTasks, withDeclared.footprint[0].declaredPrecision, withDeclared.footprint[0].declaredRecall], [1, 1, 0.5]);
  assert.match(renderExploration(withDeclared), /declared\s+1\s+precision 100%\s+recall 50%/);
  assert.ok(!text.includes('NaN'));
  assert.ok(renderExploration(explorationMetrics([])).includes('no agent calls'));
});
