import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Runner } from '../src/agent.ts';
import { runGoal } from '../src/conductor.ts';
import { evolutionDue, evolve, harvest, listEvals, metrics, promotionDecision } from '../src/evolve.ts';
import { fakeRunner } from '../src/fake.ts';
import { createVariant, currentVersion, loadHarness, readArchive } from '../src/harness.ts';
import { tempRepo } from './helpers.ts';
import { DEFAULT_PROJECT_CONFIG } from '../src/store.ts';

const quiet = () => {};

test('full self-improvement loop: run, harvest, evolve, evaluate, promote', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1, minCases: 1 } });
  const runner = fakeRunner();
  const run = await runGoal({ store, runner, goal: 'build it' });
  assert.ok(harvest(store, run), 'clean run is harvested into the Factory Eval');
  assert.equal(listEvals(store).length, 1);
  assert.ok(evolutionDue(store));

  const out = await evolve(store, runner, quiet);
  assert.equal(out.candidate, 'v2');
  assert.equal(out.promoted, true, out.reason);
  assert.ok(out.candidateScore! > out.incumbentScore!);
  assert.equal(currentVersion(store), 'v2');
  assert.match(loadHarness(store).prompts.worker, /edge cases/);

  const archive = readArchive(store);
  assert.equal(archive.find((a) => a.version === 'v1')!.status, 'retired');
  assert.equal(archive.find((a) => a.version === 'v2')!.status, 'promoted');
  assert.equal(evolutionDue(store), false, 'no new evidence for v2 yet');

  // Eval runs are excluded from goal metrics and leave no branches behind.
  assert.equal(metrics(store).find((m) => m.version === 'v1')!.runs, 1);
});

test('variant that does not beat the incumbent is rejected and kept in the archive', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1, minCases: 1 } });
  const runner = fakeRunner();
  const run = await runGoal({ store, runner, goal: 'build it' });
  harvest(store, run);
  const noop: Runner = async (req) =>
    req.role === 'evolver'
      ? { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { rationale: 'cosmetic', files: [{ name: 'planner.md', content: 'You are the PLANNER. Be brief.' }] } }
      : runner(req);
  const out = await evolve(store, noop, quiet);
  assert.equal(out.promoted, false);
  assert.equal(currentVersion(store), 'v1');
  assert.equal(readArchive(store).find((a) => a.version === 'v2')!.status, 'rejected');
});

test('guard rails: evolver cannot lower the bar or edit its own prompt', () => {
  const store = tempRepo();
  const cfg = loadHarness(store).config;
  assert.throws(() => createVariant(store, 'v1', { 'config.json': JSON.stringify({ ...cfg, passThreshold: 0.1 }) }, 'x'), /lower passThreshold/);
  assert.throws(() => createVariant(store, 'v1', { 'evolver.md': 'x' }, 'x'), /may not edit evolver\.md/);
});

test('without eval cases a candidate is created but not promoted', async () => {
  const store = tempRepo();
  const out = await evolve(store, fakeRunner(), quiet);
  assert.equal(out.candidate, 'v2');
  assert.equal(out.promoted, false);
  assert.match(out.reason, /No Factory Eval cases/);
  assert.equal(currentVersion(store), 'v1');
});

const base = { regressions: [], minGain: 0.02, minCases: 5 };

test('promotion gate refuses below minCases even with a large gain', () => {
  const d = promotionDecision({ ...base, incumbentScores: [0, 0, 0], candidateScores: [1, 1, 1] });
  assert.equal(d.promote, false);
  assert.match(d.reason, /only 3 eval cases, need at least 5/);
});

test('promotion gate requires gain above the observed spread', () => {
  // deltas 0.25, -0.05, 0.25, -0.05, 0.25 -> mean 0.15, stddev ~0.14: rejected
  const noisy = promotionDecision({ ...base, incumbentScores: [0.5, 0.5, 0.5, 0.5, 0.5], candidateScores: [0.75, 0.45, 0.75, 0.45, 0.75] });
  assert.equal(noisy.promote, false);
  assert.ok(noisy.gain > 0.02 && noisy.spread > noisy.gain);
  const steady = promotionDecision({ ...base, incumbentScores: [0.5, 0.5, 0.5, 0.5, 0.5], candidateScores: [0.6, 0.7, 0.65, 0.7, 0.6] });
  assert.equal(steady.promote, true, steady.reason);
  assert.ok(steady.gain > steady.spread);
});

test('promotion gate rejects any regression regardless of gain', () => {
  const d = promotionDecision({ ...base, regressions: ['c1'], incumbentScores: [0, 0, 0, 0, 0], candidateScores: [1, 1, 1, 1, 1] });
  assert.equal(d.promote, false);
  assert.match(d.reason, /regressed on c1/);
});

test('minCases defaults to 5 and is filled for configs that lack it', () => {
  assert.equal(DEFAULT_PROJECT_CONFIG.evolve.minCases, 5);
  const store = tempRepo();
  store.writeJson('config.json', { evolve: { every: 3, autoPromote: true, minGain: 0.02, sample: 3 } });
  assert.equal(store.config().evolve.minCases, 5);
});

test('too few eval cases: candidate is kept without spending any eval runs', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 3, minCases: 5 } });
  const runner = fakeRunner();
  harvest(store, await runGoal({ store, runner, goal: 'build it' }));
  let evalCalls = 0;
  const counting: Runner = async (req) => {
    if (req.role !== 'evolver') evalCalls++;
    return runner(req);
  };
  const out = await evolve(store, counting, quiet);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /only 1 eval cases, need at least 5/);
  assert.equal(evalCalls, 0, 'no planner/worker/judge sessions were spent');
  assert.equal(readArchive(store).find((a) => a.version === 'v2')!.status, 'candidate', 'not marked rejected');
});

test('a stale sample below minCases is raised to minCases', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1, minCases: 2 } });
  const runner = fakeRunner();
  harvest(store, await runGoal({ store, runner, goal: 'first goal' }));
  harvest(store, await runGoal({ store, runner, goal: 'second goal' }));
  const logs: string[] = [];
  await evolve(store, runner, (m) => logs.push(m));
  assert.ok(logs.some((l) => /on 2 eval case/.test(l)), logs.join('\n'));
});

test('infrastructure failure during evaluation is inconclusive, not a rejection', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1, minCases: 1 } });
  const runner = fakeRunner();
  harvest(store, await runGoal({ store, runner, goal: 'build it' }));
  const limited: Runner = async (req) =>
    req.role === 'planner' ? { ok: false, text: '', costUsd: 0, turns: 0, durationMs: 1, error: "You've hit your session limit" } : runner(req);
  const out = await evolve(store, limited, quiet);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /inconclusive/);
  const v2 = readArchive(store).find((a) => a.version === 'v2')!;
  assert.equal(v2.status, 'candidate');
  assert.equal(v2.evalScore, null, 'no fake zero score recorded');
  assert.equal(currentVersion(store), 'v1');
});

test('evolve.candidates defaults to 1 and old config.json files resolve to it', () => {
  assert.equal(DEFAULT_PROJECT_CONFIG.evolve.candidates, 1);
  const store = tempRepo();
  const { candidates: _drop, ...legacy } = DEFAULT_PROJECT_CONFIG.evolve;
  store.writeJson('config.json', { ...DEFAULT_PROJECT_CONFIG, evolve: legacy });
  assert.equal(store.config().evolve.candidates, 1);
});

test('createVariant records parents only when given', () => {
  const store = tempRepo();
  const plain = createVariant(store, 'v1', { 'worker.md': 'a' }, 'plain');
  const composed = createVariant(store, 'v1', { 'worker.md': 'b' }, 'composed', [plain, 'v1']);
  const archive = readArchive(store);
  assert.equal(archive.find((a) => a.version === plain)?.parents, undefined);
  assert.deepEqual(archive.find((a) => a.version === composed)?.parents, [plain, 'v1']);
});

test('fake evolver: k distinct variants, single by default, one composed variant', async () => {
  const runner = fakeRunner();
  const ask = async (prompt: string) => {
    const res = await runner({ role: 'evolver', prompt } as Parameters<typeof runner>[0]);
    return (res.structured as { variants: { rationale: string; files: { name: string; content: string }[] }[] }).variants;
  };
  const base = '--- worker.md ---\nYou are a WORKER.\n\n--- planner.md ---\nx';
  const three = await ask(`PROPOSE 3 VARIANTS\n${base}`);
  assert.equal(three.length, 3);
  assert.equal(new Set(three.map((v) => v.files[0].content)).size, 3);
  assert.equal(new Set(three.map((v) => v.rationale)).size, 3);
  assert.equal((await ask(base)).length, 1);
  const composed = await ask(`COMPOSE VARIANTS\n${base}`);
  assert.equal(composed.length, 1);
  assert.match(composed[0].files[0].content, /edge cases/);
  assert.match(composed[0].files[0].content, /composed/);
  assert.match(composed[0].rationale, /compos/i);
});
