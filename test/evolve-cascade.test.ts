import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Runner } from '../src/agent.ts';
import { evolve, harnessIntegrity, type EvalCase } from '../src/evolve.ts';
import { holdoutLeaks, splitEvals } from '../src/evalsets.ts';
import { fakeRunner } from '../src/fake.ts';
import { currentVersion, readArchive } from '../src/harness.ts';
import { selectParent } from '../src/pareto.ts';
import type { Store } from '../src/store.ts';
import type { ProjectConfig } from '../src/types.ts';
import { tempRepo } from './helpers.ts';
import { DEFAULT_PROJECT_CONFIG } from '../src/store.ts';

const quiet = () => {};

function repoWith(n: number, evolveCfg: Partial<ProjectConfig['evolve']>): { store: Store; cases: EvalCase[] } {
  const store = tempRepo({ evolve: { ...DEFAULT_PROJECT_CONFIG.evolve, every: 1, autoPromote: true, minGain: 0.02, sample: 10, minCases: 3, candidates: 1, ...evolveCfg } });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: store.root, encoding: 'utf8' }).trim();
  const cases = Array.from({ length: n }, (_, i) => ({ id: `case-${String(i).padStart(2, '0')}`, goal: `unique goal text zq${i}x`, base, source: `src-${i}`, taskType: 'cli', createdAt: 1000 + i }));
  for (const c of cases) store.writeJson(`evals/${c.id}.json`, c);
  return { store, cases };
}

function spy(inner: Runner, tweak?: (req: Parameters<Runner>[0], res: Awaited<ReturnType<Runner>>) => Awaited<ReturnType<Runner>>) {
  const evolverPrompts: string[] = [];
  let planners = 0;
  const runner: Runner = async (req) => {
    if (req.role === 'evolver') evolverPrompts.push(req.prompt);
    if (req.role === 'planner') planners++;
    const res = await inner(req);
    return tweak ? tweak(req, res) : res;
  };
  return { runner, evolverPrompts, planners: () => planners };
}

const cosmetic = (inner: Runner): Runner => async (req) =>
  req.role === 'evolver'
    ? { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { rationale: 'cosmetic', files: [{ name: 'planner.md', content: 'You are the PLANNER. Be brief.' }] } }
    : inner(req);

test('splits: evolver prompt has no holdout case id or goal text', async () => {
  // minCases above the validation size, so the cycle ends right after the evolver call.
  const { store, cases } = repoWith(10, { splits: { enabled: true, feedback: 0.3, validation: 0.5, holdout: 0.2, signoffBelow: 12 }, minCases: 9 });
  const s = spy(fakeRunner());
  await evolve(store, s.runner, quiet);
  const { holdout, feedback } = splitEvals(cases);
  assert.ok(holdout.length > 0 && s.evolverPrompts.length === 1);
  assert.deepEqual(holdoutLeaks(s.evolverPrompts[0], holdout), []);
  assert.ok(s.evolverPrompts[0].includes(feedback[0].goal), 'feedback cases are shown');
});

test('cascade: nothing clears the minibatch, so the cycle stops with no full validation', async () => {
  const { store } = repoWith(6, { cascade: { enabled: true, minibatch: 2, finalists: 2 } });
  const s = spy(cosmetic(fakeRunner()));
  const out = await evolve(store, s.runner, quiet);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /no candidate cleared the minibatch/);
  // One smoke replay + incumbent minibatch (2) + candidate minibatch (2); full validation would add 12 more.
  assert.equal(s.planners(), 5);
  assert.equal(readArchive(store).find((a) => a.version === 'v2')!.status, 'rejected');
});

test('cascade: a candidate that fails the smoke test never reaches the minibatch', async () => {
  const { store } = repoWith(6, { cascade: { enabled: true, minibatch: 2, finalists: 2 } });
  writeFileSync(store.path('harness', 'v1', 'checklist.md'), '- keep tests green\n');
  const s = spy(fakeRunner());
  // Corrupt the candidate on disk right after it is created: its checklist loses a parent line.
  const log = (m: string) => {
    if (m.startsWith('Candidate v2')) writeFileSync(store.path('harness', 'v2', 'checklist.md'), '');
  };
  const out = await evolve(store, s.runner, log);
  assert.match(out.reason, /smoke test/);
  assert.match(out.reason, /checklist line removed/);
  assert.equal(s.planners(), 0, 'no replay of any kind was spent');
});

test('harnessIntegrity flags a removed checklist line and passes an intact variant', () => {
  const { store } = repoWith(0, {});
  writeFileSync(store.path('harness', 'v1', 'checklist.md'), '- a\n- b\n');
  execFileSync('cp', ['-R', store.path('harness', 'v1'), store.path('harness', 'v2')]);
  assert.equal(harnessIntegrity(store, 'v1', 'v2'), null);
  writeFileSync(store.path('harness', 'v2', 'checklist.md'), '- a\n');
  assert.match(harnessIntegrity(store, 'v1', 'v2')!, /checklist line removed: - b/);
});

test('cascade: a winning candidate goes through to promotion', async () => {
  const { store } = repoWith(4, { cascade: { enabled: true, minibatch: 2, finalists: 2 } });
  const out = await evolve(store, fakeRunner(), quiet);
  assert.equal(out.promoted, true, out.reason);
  assert.equal(currentVersion(store), 'v2');
});

test('budgetUsd halts the cycle with a budget reason and stays within one replay of the cap', async () => {
  const cap = 4;
  const { store } = repoWith(6, { budgetUsd: cap });
  const s = spy(fakeRunner());
  const out = await evolve(store, s.runner, quiet);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /budget/);
  const spent = store.ledgerRows().reduce((n, r) => n + r.costUsd, 0);
  assert.ok(spent <= cap + 1.6, `spent ${spent} against cap ${cap}`);
  assert.ok(s.planners() < 12, 'not all validation replays ran');
});

test('sequential: stops before all validation cases once the CI settles', async () => {
  const { store } = repoWith(6, { sequential: { enabled: true, roundSize: 2 } });
  const s = spy(fakeRunner());
  const out = await evolve(store, s.runner, quiet);
  assert.match(out.reason, /sequential stop after 2 of 6 cases/);
  assert.equal(s.planners(), 4, 'one round of two pairs, not six');
  assert.equal(out.promoted, true, out.reason);
});

test('cost: a cost-inflating variant with equal quality is rejected when cost is enabled', async () => {
  const costly: Runner = async (req) => req.role === 'evolver'
    ? { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { rationale: 'verbose', files: [{ name: 'worker.md', content: 'You are a WORKER. Be verbose and thorough.' }] } }
    : fakeRunner()(req);
  const inflate = (req: Parameters<Runner>[0], res: Awaited<ReturnType<Runner>>) => (req.role === 'worker' && /Be verbose/.test(req.system ?? '') ? { ...res, costUsd: res.costUsd * 6 } : res);
  const { store } = repoWith(3, { cost: { enabled: true, maxCostRisePct: 25, minGainForCost: 0.02, costWeight: 0.1, timeWeight: 0 } });
  const out = await evolve(store, spy(costly, inflate).runner, quiet);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /cost gate/);
});

test('splits: below the sign-off threshold a winning candidate is kept, not promoted', async () => {
  const { store } = repoWith(8, { splits: { enabled: true, feedback: 0.3, validation: 0.5, holdout: 0.2, signoffBelow: 12 } });
  const out = await evolve(store, fakeRunner(), quiet);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /human sign-off/);
  assert.equal(currentVersion(store), 'v1');
  assert.equal(readArchive(store).find((a) => a.version === 'v2')!.status, 'candidate');
});

test('splits: above the threshold a win is confirmed on the locked holdout before promotion', async () => {
  const { store } = repoWith(8, { splits: { enabled: true, feedback: 0.3, validation: 0.5, holdout: 0.2, signoffBelow: 3 } });
  const out = await evolve(store, fakeRunner(), quiet);
  assert.equal(out.promoted, true, out.reason);
  assert.match(out.reason, /confirmed on the locked holdout/);
  assert.ok(readArchive(store).find((a) => a.version === 'v2')!.holdoutScore! > 0);
});

const SPLITS = { enabled: true, feedback: 0.3, validation: 0.5, holdout: 0.2, signoffBelow: 3 };

test('pareto: archive persists across cycles and the second parent comes from selectParent', async () => {
  const { store } = repoWith(8, { pareto: { enabled: true }, autoPromote: false });
  const s = spy(fakeRunner());
  await evolve(store, s.runner, quiet);
  const after1 = readArchive(store);
  const v2 = after1.find((a) => a.version === 'v2')!;
  assert.deepEqual(after1.map((a) => a.version).slice(0, 2), ['v1', 'v2']);
  assert.ok(v2.validationDetail && Object.keys(v2.validationDetail).length > 0);
  assert.ok((v2.paretoWins ?? 0) > 0 && v2.stepping === true, 'winner kept as a stepping stone');
  const expected = selectParent(after1)!.version;
  await evolve(store, s.runner, quiet);
  const v3 = readArchive(store).find((a) => a.version === 'v3')!;
  assert.equal(v3.parent, expected);
  assert.ok(readArchive(store).find((a) => a.version === 'v2'), 'earlier variants survive');
});

test('pareto: evolver prompt carries the scored history and no holdout numbers', async () => {
  const { store, cases } = repoWith(8, { pareto: { enabled: true }, splits: SPLITS, autoPromote: false });
  const s = spy(fakeRunner());
  await evolve(store, s.runner, quiet);
  await evolve(store, s.runner, quiet);
  assert.equal(s.evolverPrompts.length, 2);
  assert.ok(!s.evolverPrompts[0].includes('v2 parent='));
  const second = s.evolverPrompts[1];
  assert.match(second, /SCORED ARCHIVE HISTORY/);
  assert.match(second, /v2 parent=v1 status=candidate/);
  const hold = readArchive(store).find((a) => a.version === 'v2')!.holdoutScore;
  assert.equal(typeof hold, 'number');
  assert.ok(!/holdoutScore|holdout=/i.test(second));
  assert.deepEqual(holdoutLeaks(second, splitEvals(cases).holdout), []);
});

test('pareto: a candidate that wins validation and holdout is promoted and reported confirmed', async () => {
  const { store } = repoWith(8, { pareto: { enabled: true }, splits: SPLITS });
  const out = await evolve(store, fakeRunner(), quiet);
  assert.equal(out.promoted, true, out.reason);
  assert.equal(out.holdout!.confirmed, true);
  assert.ok(out.holdout!.candidate > out.holdout!.parent);
  assert.equal(currentVersion(store), 'v2');
});

test('pareto: a candidate that wins validation but loses the holdout stays a stepping stone', async () => {
  const { store, cases } = repoWith(8, { pareto: { enabled: true }, splits: SPLITS });
  const holdIds = new Set(splitEvals(cases).holdout.map((c) => c.id));
  // The frozen scorer fails the careful (candidate) diff, but only on holdout goals.
  const tweak = (req: Parameters<Runner>[0], res: Awaited<ReturnType<Runner>>) => {
    const onHoldout = [...holdIds].some((id) => req.prompt.includes(cases.find((c) => c.id === id)!.goal));
    return req.role === 'judge' && req.prompt.startsWith('FROZEN SCORER REPLAY') && onHoldout && /edge-cases-covered/.test(req.prompt)
      ? { ...res, structured: { pass: false, score: 0.1, summary: 'Regressed' } }
      : res;
  };
  const out = await evolve(store, spy(fakeRunner(), tweak).runner, quiet);
  assert.equal(out.promoted, false);
  assert.equal(out.holdout?.confirmed, false, out.reason);
  assert.match(out.reason, /not confirmed on the locked holdout/);
  assert.equal(currentVersion(store), 'v1');
  const v2 = readArchive(store).find((a) => a.version === 'v2')!;
  assert.equal(v2.status, 'candidate');
  assert.equal(v2.stepping, true);
});

test('pareto off: no archive seeding, no history in the prompt, no extra fields', async () => {
  const { store } = repoWith(4, {});
  const s = spy(fakeRunner());
  await evolve(store, s.runner, quiet);
  assert.ok(!/SCORED ARCHIVE HISTORY/.test(s.evolverPrompts[0]));
  assert.ok(readArchive(store).every((a) => a.paretoWins === undefined && a.stepping === undefined));
});
