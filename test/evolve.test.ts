import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Runner } from '../src/agent.ts';
import { runGoal } from '../src/conductor.ts';
import { evolutionDue, evolve, harvest, listEvals, metrics } from '../src/evolve.ts';
import { fakeRunner } from '../src/fake.ts';
import { createVariant, currentVersion, loadHarness, readArchive } from '../src/harness.ts';
import { tempRepo } from './helpers.ts';

const quiet = () => {};

test('full self-improvement loop: run, harvest, evolve, evaluate, promote', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1 } });
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
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1 } });
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
