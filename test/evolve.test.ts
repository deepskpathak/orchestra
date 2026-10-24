import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Runner } from '../src/agent.ts';
import { runGoal } from '../src/conductor.ts';
import { evaluate, evaluatePair, evolutionDue, evolve, harvest, listEvals, metrics, promotionDecision } from '../src/evolve.ts';
import { fakeRunner } from '../src/fake.ts';
import { EVOLVABLE_FILES, createVariant, currentVersion, loadHarness, readArchive } from '../src/harness.ts';
import { loadScorer } from '../src/scorer.ts';
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

// ---- multi-candidate cycle ----

async function seeded(candidates: number, cases = 2, extra: Record<string, unknown> = {}) {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: cases, minCases: cases, candidates, ...extra } });
  const runner = fakeRunner();
  for (let i = 0; i < cases; i++) harvest(store, await runGoal({ store, runner, goal: `goal ${i}` }));
  return { store, runner };
}

// Wraps a runner: counts non-evolver sessions per planner call, records evolver prompts, and optionally
// makes the evolver answer with custom variants / fail planners whose prompt contains a marker.
function instrument(inner: Runner, opts: { variants?: (prompt: string) => unknown; failMarker?: string } = {}) {
  const evolverPrompts: string[] = [];
  let planners = 0;
  const runner: Runner = async (req) => {
    if (req.role === 'evolver') {
      evolverPrompts.push(req.prompt);
      const custom = opts.variants?.(req.prompt);
      if (custom) return { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: custom };
    }
    if (req.role === 'planner') {
      planners++;
      if (opts.failMarker && req.system?.includes(opts.failMarker)) return { ok: false, text: '', costUsd: 0, turns: 0, durationMs: 1, error: 'planner broke' };
    }
    return inner(req);
  };
  return { runner, evolverPrompts, planners: () => planners };
}

const planFile = (marker: string) => ({ name: 'planner.md', content: `You are the PLANNER. ${marker}` });

test('candidates:3 proposes 3, screens, composes one variant with parents and bounded cost', async () => {
  const { store, runner } = await seeded(3);
  const inst = instrument(runner);
  const out = await evolve(store, inst.runner, quiet);
  const archive = readArchive(store);
  const proposals = archive.filter((a) => a.version !== 'v1' && !a.parents);
  const composed = archive.filter((a) => a.parents);
  assert.equal(proposals.length, 3);
  assert.equal(composed.length, 1);
  assert.deepEqual(composed[0].parents, proposals.map((a) => a.version));
  assert.equal(out.candidate, composed[0].version);
  assert.ok(proposals.every((a) => typeof a.screenScore === 'number'));
  assert.ok(inst.evolverPrompts[0].includes('PROPOSE 3 VARIANTS'));
  assert.ok(inst.evolverPrompts[1].startsWith('COMPOSE VARIANTS'));
  assert.equal(inst.evolverPrompts.length, 2);
  // screen = min(2, sample) = 2: incumbent once + 3 candidates, then 2 x sample (2) full runs.
  assert.ok(inst.planners() <= 3 * 2 + 2 + 2 * 2, `planner sessions ${inst.planners()}`);
  assert.ok(inst.planners() >= 2 + 3 * 2);
});

test('candidates:1 spends exactly the legacy eval runs (2 x sample, one evolver call)', async () => {
  const { store, runner } = await seeded(1);
  const inst = instrument(runner);
  await evolve(store, inst.runner, quiet);
  assert.equal(inst.planners(), 4);
  assert.equal(inst.evolverPrompts.length, 1);
  assert.ok(!inst.evolverPrompts[0].includes('PROPOSE'));
});

test('screening regression is archived rejected with its score and shown in the next prompt', async () => {
  const { store, runner } = await seeded(3);
  const inst = instrument(runner, {
    failMarker: 'BAD',
    variants: (p) => (p.startsWith('COMPOSE') ? undefined : { variants: [{ rationale: 'good one', files: [planFile('GOOD1')] }, { rationale: 'bad one', files: [planFile('BAD')] }, { rationale: 'good two', files: [planFile('GOOD2')] }] }),
  });
  await evolve(store, inst.runner, quiet);
  const bad = readArchive(store).find((a) => a.rationale === 'bad one')!;
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.screenScore, 0);
  assert.equal(bad.evalScore, 0);
  const composed = readArchive(store).find((a) => a.parents)!;
  assert.equal(composed.parents!.length, 2);
  assert.ok(!composed.parents!.includes(bad.version));

  const next = instrument(runner);
  await evolve(store, next.runner, quiet);
  assert.match(next.evolverPrompts[0], new RegExp(`PREVIOUSLY REJECTED VARIANTS[^]*- ${bad.version} \\(score 0\\): bad one`));
});

test('all candidates regress in screening: no compose, no full evaluation', async () => {
  const { store, runner } = await seeded(2);
  const inst = instrument(runner, {
    failMarker: 'BAD',
    variants: () => ({ variants: [{ rationale: 'a', files: [planFile('BAD a')] }, { rationale: 'b', files: [planFile('BAD b')] }] }),
  });
  const out = await evolve(store, inst.runner, quiet);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /regressed in screening/);
  assert.equal(inst.evolverPrompts.length, 1);
  assert.equal(inst.planners(), 2 + 2 * 2, 'incumbent + 2 candidates on the 2 screen cases only');
  assert.ok(readArchive(store).filter((a) => a.version !== 'v1').every((a) => a.status === 'rejected'));
});

test('compose failure falls back to the best surviving candidate', async () => {
  const { store, runner } = await seeded(2);
  const inst = instrument(runner, {
    variants: (p) =>
      p.startsWith('COMPOSE')
        ? { variants: [] }
        : { variants: [{ rationale: 'a', files: [planFile('A')] }, { rationale: 'b', files: [planFile('B')] }] },
  });
  const out = await evolve(store, inst.runner, quiet);
  assert.equal(inst.evolverPrompts.length, 2);
  assert.ok(!readArchive(store).some((a) => a.parents), 'no composed variant');
  assert.ok(['v2', 'v3'].includes(out.candidate!));
});

test('finalist that does not beat the incumbent is never promoted', async () => {
  const { store, runner } = await seeded(2);
  const inst = instrument(runner, {
    variants: () => ({ variants: [{ rationale: 'a', files: [planFile('A')] }, { rationale: 'b', files: [planFile('B')] }] }),
  });
  const out = await evolve(store, inst.runner, quiet);
  assert.equal(out.promoted, false);
  assert.equal(currentVersion(store), 'v1');
  assert.equal(readArchive(store).find((a) => a.version === out.candidate)!.status, 'rejected');
});

test('too few cases with candidates:3 keeps every candidate and spends no eval runs', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 3, minCases: 5, candidates: 3 } });
  const inst = instrument(fakeRunner());
  const out = await evolve(store, inst.runner, quiet);
  assert.equal(out.promoted, false);
  assert.equal(inst.planners(), 0);
  const entries = readArchive(store).filter((a) => a.version !== 'v1');
  assert.equal(entries.length, 3);
  assert.ok(entries.every((a) => a.status === 'candidate'));
});

// ---- Frozen promotion scorer ----

test('eval score comes from the frozen scorer, not the candidate run satisfaction', async () => {
  const store = tempRepo();
  const base = fakeRunner();
  const run = await runGoal({ store, runner: base, goal: 'build it' });
  const c = harvest(store, run)!;
  assert.ok((run.satisfaction ?? 0) > 0.7, 'the run itself reports high satisfaction');
  const scorerCalls: string[] = [];
  const failing: Runner = async (req) => {
    if (req.prompt.startsWith('FROZEN SCORER REPLAY')) {
      scorerCalls.push(req.prompt);
      return { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { pass: false, score: 0.99, summary: 'reward hacked' } };
    }
    return base(req);
  };
  const res = await evaluate(store, failing, 'v1', [c]);
  assert.equal(res.detail[c.id], 0);
  assert.equal(res.passed[c.id], false);
  assert.equal(res.score, 0);
  assert.equal(scorerCalls.length, 1);
  assert.ok(!/satisfaction/i.test(scorerCalls[0]), 'self-reported satisfaction is withheld from the scorer');

  const ok = await evaluate(store, base, 'v1', [c]);
  assert.equal(ok.passed[c.id], true);
  assert.ok(ok.detail[c.id] > 0.8);
});

test('a scorer call that fails closes to zero, an infra failure is inconclusive', async () => {
  const store = tempRepo();
  const base = fakeRunner();
  const c = harvest(store, await runGoal({ store, runner: base, goal: 'build it' }))!;
  const broken = (error: string): Runner => async (req) => (req.prompt.startsWith('FROZEN SCORER REPLAY') ? { ok: false, text: '', error, costUsd: 0, turns: 1, durationMs: 1 } : base(req));
  const crash = await evaluate(store, broken('boom'), 'v1', [c]);
  assert.equal(crash.score, 0);
  assert.equal(crash.inconclusive, undefined);
  const infra = await evaluate(store, broken('rate limit hit'), 'v1', [c]);
  assert.match(infra.inconclusive ?? '', /rate limit/);
});

test('scorer is pinned outside the evolvable harness and loads with model and version', () => {
  assert.ok(!EVOLVABLE_FILES.some((f) => f.includes('scorer')));
  const s = loadScorer();
  assert.ok(s.model && s.version);
  assert.ok(s.judge.length > 0 && s.checklist.length > 0);
  assert.throws(() => createVariant(tempRepo(), 'v1', { 'scorer/judge.md': 'x' }, 'hack'), /may not edit/);
});

test('evolver prompt never contains scorer file contents', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1, minCases: 1 } });
  const base = fakeRunner();
  harvest(store, await runGoal({ store, runner: base, goal: 'build it' }));
  const prompts: string[] = [];
  const spy: Runner = async (req) => {
    if (req.role === 'evolver') prompts.push(`${req.system}\n${req.prompt}`);
    return base(req);
  };
  await evolve(store, spy, quiet);
  assert.ok(prompts.length > 0);
  const s = loadScorer();
  for (const text of [s.judge, ...s.checklist.split('\n')].map((t) => t.trim()).filter(Boolean)) {
    for (const p of prompts) assert.ok(!p.includes(text), `evolver saw scorer text: ${text.slice(0, 40)}`);
  }
});

// ---- Clean-room, interleaved eval trials ----

test('eval replays interleave candidate and incumbent, never two batches', async () => {
  const store = tempRepo();
  const base = fakeRunner();
  harvest(store, await runGoal({ store, runner: base, goal: 'build it' }));
  harvest(store, await runGoal({ store, runner: base, goal: 'build it again' }));
  const v2 = createVariant(store, 'v1', { 'planner.md': 'You are the PLANNER. Be brief.' }, 'x');
  const seen: string[] = [];
  const ids = new Set<string>();
  await evaluatePair(store, base, 'v1', v2, listEvals(store), (r) => {
    if (!ids.has(r.id)) {
      ids.add(r.id);
      seen.push(r.harness);
    }
  });
  assert.deepEqual(seen, [v2, 'v1', v2, 'v1']);
});

test('eval runs get no learnings and each its own fresh worktree at the case base commit', async () => {
  const store = tempRepo();
  const base = fakeRunner();
  const first = await runGoal({ store, runner: base, goal: 'build it' });
  const c = harvest(store, first)!;
  const { writeLearnings } = await import('../src/learnings.ts');
  writeLearnings(store, [{ role: 'planner', lesson: 'SECRET-LESSON-XYZ', evidence: [{ run: first.id }], hits: 0 }], first.id);
  const prompts: string[] = [];
  const cwds: string[] = [];
  const spy: Runner = async (req) => {
    prompts.push(req.prompt + (req.system ?? ''));
    if (req.cwd) cwds.push(req.cwd);
    return base(req);
  };
  const bases = new Map<string, string | undefined>();
  await evaluate(store, spy, 'v1', [c, c], (r) => bases.set(r.id, r.baseRef));
  assert.equal(bases.size, 2, 'two replays, two distinct run ids');
  assert.ok([...bases.values()].every((b) => b === c.base), 'each replay starts at the case base commit');
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every((p) => !p.includes('SECRET-LESSON-XYZ')), 'eval prompts carry no lessons');
  const integrations = [...new Set(cwds.filter((d) => d.includes('_integration')))];
  assert.equal(integrations.length, 2, 'each replay has its own worktree');
  // A goal run (not eval) still sees the lesson, so the bypass is eval-only.
  const seen: string[] = [];
  await runGoal({ store, runner: async (req) => (seen.push(req.prompt), base(req)), goal: 'another' });
  assert.ok(seen.some((p) => p.includes('SECRET-LESSON-XYZ')));
});

test('infraFailureRate is reported per side and in the evolve outcome', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1, minCases: 1 } });
  const base = fakeRunner();
  const c = harvest(store, await runGoal({ store, runner: base, goal: 'build it' }))!;
  const clean = await evaluate(store, base, 'v1', [c]);
  assert.equal(clean.infraFailureRate, 0);
  const broken: Runner = async (req) => (req.prompt.startsWith('FROZEN SCORER REPLAY') ? { ok: false, text: '', error: 'rate limit hit', costUsd: 0, turns: 1, durationMs: 1 } : base(req));
  const bad = await evaluate(store, broken, 'v1', [c, c]);
  assert.equal(bad.infraFailureRate, 1, 'aborts on first infra failure: 1 of 1 attempted');
  const out = await evolve(store, base, quiet);
  assert.deepEqual(out.infraFailureRate, { incumbent: 0, candidate: 0 });
  assert.equal(readArchive(store).find((a) => a.version === 'v1')!.evalInfraRate, 0);
});

test('promotionDecision blocks a candidate whose monitor fire rate exceeds the incumbent, naming the monitor', () => {
  const base = { incumbentScores: [0.5, 0.5], candidateScores: [0.9, 0.9], regressions: [], minGain: 0.02, minCases: 2, incumbent: 'v1' };
  const blocked = promotionDecision({ ...base, monitorFireRate: { incumbent: 0, candidate: 1 } });
  assert.equal(blocked.promote, false);
  assert.match(blocked.reason, /integrity monitor/);
  assert.equal(promotionDecision({ ...base, monitorFireRate: { incumbent: 0.5, candidate: 0.5 } }).promote, true, 'equal rate is allowed');
  assert.equal(promotionDecision({ ...base, monitorFireRate: { incumbent: 0, candidate: 0.5 } }).promote, true, 'one extra flag is within the noise slack');
  assert.equal(promotionDecision(base).promote, true, 'no monitor data leaves the default path unchanged');
});

test('evolve: a candidate that trips the monitor more than the incumbent is not promoted', async () => {
  const store = tempRepo({ evolve: { every: 1, autoPromote: true, minGain: 0.02, sample: 1, minCases: 1 } });
  mkdirSync(join(store.root, 'test'), { recursive: true });
  writeFileSync(join(store.root, 'test', 'sample.test.js'), "import assert from 'node:assert';\nassert.ok(true);\n");
  execFileSync('git', ['add', '-A'], { cwd: store.root });
  execFileSync('git', ['commit', '-qm', 'sample'], { cwd: store.root });
  // Only the evolved worker prompt (edge cases) reward-hacks, and only on its first attempt.
  const runner = fakeRunner({ tamper: (req) => /edge cases/i.test(req.system ?? '') && req.meta?.attempt === 1 });
  assert.ok(harvest(store, await runGoal({ store, runner: fakeRunner(), goal: 'build it' })));

  const prompts: string[] = [];
  const spy: Runner = async (req) => {
    if (req.role === 'evolver') prompts.push(req.prompt + (req.system ?? ''));
    return runner(req);
  };
  const out = await evolve(store, spy, quiet);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /integrity monitor/);
  assert.ok(out.monitorFireRate!.candidate > out.monitorFireRate!.incumbent);
  assert.equal(currentVersion(store), 'v1');
  assert.equal(readArchive(store).find((a) => a.version === 'v2')!.status, 'rejected');

  // A second evolve sees the first run's flagged tasks in history; none of it may reach the evolver.
  await runGoal({ store, runner, goal: 'again', harnessVersion: 'v2' });
  await evolve(store, spy, quiet);
  assert.ok(prompts.length >= 2);
  for (const p of prompts) assert.doesNotMatch(p, /integrity|grading file|weakened-test|reward-hack|monitor/i);
});
