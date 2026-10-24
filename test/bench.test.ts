import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { AgentRequest, Runner } from '../src/agent.ts';
import { DEFAULT_SUITE, applyOracle, loadArms, loadGoals, materialiseFixture, runBench, runCheck, summarize, verifyOracles, type BenchRow } from '../src/bench.ts';
import { fakeRunner } from '../src/fake.ts';
import { git } from '../src/git.ts';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { goalRuns } from '../src/evolve.ts';
import { tempRepo } from './helpers.ts';

test('starter suite: every goal has fixture, check and oracle, and every oracle passes its own check', () => {
  const goals = loadGoals();
  assert.ok(goals.length >= 3);
  for (const g of goals) {
    assert.ok(g.goal && g.taskType && g.humanMinutes > 0, g.id);
    assert.ok(existsSync(join(DEFAULT_SUITE, 'fixtures', g.fixture)), g.id);
  }
  const res = verifyOracles();
  assert.deepEqual(res.filter((r) => !r.ok), []);
  assert.equal(res.length, goals.length);
});

test('verify-oracles flags a broken oracle by goal name', () => {
  const suite = mkdtempSync(join(tmpdir(), 'bench-suite-'));
  cpSync(DEFAULT_SUITE, suite, { recursive: true });
  writeFileSync(join(suite, 'oracles', 'calc-sub', 'src', 'calc.js'), 'export function add(a, b) { return a + b; }\n');
  const res = verifyOracles(suite);
  assert.deepEqual(res.filter((r) => !r.ok).map((r) => r.goal), ['calc-sub']);
  const cli = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'bin', 'orchestra.ts'), 'bench', '--verify-oracles', '--suite', suite], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stdout + cli.stderr, /calc-sub/);
  const ok = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'bin', 'orchestra.ts'), 'bench', '--verify-oracles'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('a check that passes on the unmodified base is rejected', () => {
  const suite = mkdtempSync(join(tmpdir(), 'bench-suite-'));
  cpSync(DEFAULT_SUITE, suite, { recursive: true });
  writeFileSync(join(suite, 'checks', 'calc-div.mjs'), 'process.exit(0);\n');
  const bad = verifyOracles(suite).filter((r) => !r.ok);
  assert.deepEqual(bad.map((r) => r.goal), ['calc-div']);
});

test('arms: named arms fall back to the default config; arms.json is read', () => {
  assert.deepEqual(loadArms(DEFAULT_SUITE, ['a', 'b']).map((a) => a.name), ['a', 'b']);
  assert.ok(loadArms(DEFAULT_SUITE).length >= 1);
});

test('bench runs arms x goals x repeats with the fake runner, hides checks and oracles, and stays eval-only', async () => {
  const store = tempRepo();
  const seen: AgentRequest[] = [];
  const inner = fakeRunner();
  const runner: Runner = async (req) => {
    seen.push(req);
    return inner(req);
  };
  const rows: BenchRow[] = [];
  const res = await runBench({ store, runner, arms: [{ name: 'a' }, { name: 'b', config: { concurrency: 1 } }], repeats: 2, benchId: 'bt', onRow: (r) => rows.push(r) });
  const goals = loadGoals();
  const lines = readFileSync(join(store.dir, 'bench', 'bt', 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2 * goals.length * 2);
  for (const k of ['arm', 'goal', 'taskType', 'humanMinutes', 'repeat', 'runId', 'harness', 'checkPass', 'judgeSatisfaction', 'taskVerdicts', 'costUsd', 'wallMs']) assert.ok(k in lines[0], k);
  const summary = JSON.parse(readFileSync(join(store.dir, 'bench', 'bt', 'summary.json'), 'utf8'));
  assert.deepEqual(summary.arms.map((a: any) => a.arm), ['a', 'b']);
  for (const a of summary.arms) assert.ok('passAt1' in a && 'passHat3' in a);
  assert.equal(res.rows.length, rows.length);

  // Hidden material never reaches an agent prompt or working directory.
  assert.ok(seen.length > 0);
  for (const req of seen) {
    const text = `${req.prompt}\n${req.system}`;
    for (const g of goals) {
      assert.ok(!text.includes(g.check) && !text.includes(g.oracle), `${g.id} leaked into a prompt`);
      assert.ok(!text.includes('checks/') || !text.includes('.mjs'), 'check script path leaked');
    }
    assert.ok(!existsSync(join(req.cwd, 'checks')) && !existsSync(join(req.cwd, 'oracles')) && !existsSync(join(req.cwd, 'bench')));
  }

  // The user's store sees no goal runs, so nothing is harvested or counted toward evolution.
  assert.equal(goalRuns(store).length, 0);
  assert.equal(readdirSync(join(store.dir)).includes('runs') ? readdirSync(join(store.dir, 'runs')).length : 0, 0);
});

test('integration branch holds no check or oracle files', async () => {
  const store = tempRepo();
  const branches: { repo: string; branch: string }[] = [];
  const inner = fakeRunner();
  const runner: Runner = async (req) => {
    // cwd is a worktree of the throwaway repo; the integration branch is named after the run.
    if (req.role === 'worker' && req.meta?.run) branches.push({ repo: req.cwd, branch: `orchestra/${req.meta.run}/integration` });
    return inner(req);
  };
  let tree = '';
  const origRun = runner;
  const wrapped: Runner = async (req) => {
    const r = await origRun(req);
    if (req.role === 'judge' && !tree) tree = git(req.cwd, 'ls-files');
    return r;
  };
  await runBench({ store, runner: wrapped, goals: ['calc-sub'], benchId: 'bi' });
  assert.ok(tree.includes('src/calc.js'));
  assert.ok(!/checks|oracles|\.mjs$/m.test(tree.replace(/^fake\/.*$/gm, '')), tree);
});

test('summarize: pass@1 and pass^3 per arm', () => {
  const row = (arm: string, goal: string, repeat: number, checkPass: boolean): BenchRow => ({ arm, goal, taskType: 't', humanMinutes: 1, repeat, runId: 'r', harness: 'v1', checkPass, judgeSatisfaction: null, taskVerdicts: {}, costUsd: 1, wallMs: 1000 });
  const rows = [row('a', 'g', 1, true), row('a', 'g', 2, true), row('a', 'g', 3, false), row('b', 'g', 1, true), row('b', 'g', 2, true)];
  const [a, b] = summarize(rows);
  assert.ok(Math.abs(a.passAt1! - 2 / 3) < 1e-9);
  assert.equal(a.passHat3, 0);
  assert.equal(b.passHat3, null);
  assert.equal(a.meanCostUsd, 1);
});

// ---------- ablation arms and the matched-cost baseline (W2.3, W2.4) ----------

import { ABLATION_ARMS, SINGLE_SESSION_ARM, ablationTable, matchedBudget, renderAblationTable } from '../src/bench.ts';

test('built-in arms: full plus five ablations and the evolver pinned to v1', () => {
  assert.deepEqual(ABLATION_ARMS.map((a) => a.name), ['full', '-scenarios', '-repair', '-learnings', '-contrastive', '-evolver']);
  assert.equal(ABLATION_ARMS.find((a) => a.name === '-evolver')!.harness, 'v1');
  assert.equal(ABLATION_ARMS.find((a) => a.name === 'full')!.harness, 'incumbent');
  assert.equal(SINGLE_SESSION_ARM.singleSession, true);
});

test('bench --ablations arms: single-session budget equals the full arm mean cost, one worker call, same hidden check', async () => {
  const store = tempRepo();
  const calls: AgentRequest[] = [];
  const inner = fakeRunner();
  const runner: Runner = async (req) => {
    if (!req.meta?.run) calls.push(req);
    return inner(req);
  };
  const arms = [ABLATION_ARMS[0], ABLATION_ARMS[2], SINGLE_SESSION_ARM];
  const { rows, summary } = await runBench({ store, runner, goals: ['calc-sub', 'calc-div'], repeats: 1, arms, benchId: 'ba' });
  const full = rows.filter((r) => r.arm === 'full');
  const mean = full.reduce((a, r) => a + r.costUsd, 0) / full.length;
  assert.ok(mean > 0);
  const single = rows.filter((r) => r.arm === 'single-session');
  assert.equal(single.length, 2);
  for (const r of single) assert.ok(Math.abs(r.budgetUsd! - mean) < 1e-9);
  assert.deepEqual(summary.map((s) => s.arm), ['full', '-repair', 'single-session']);
  const sessions = calls.filter((c) => c.role === 'worker' && c.meta?.attempt === 1 && !c.meta.task);
  assert.equal(sessions.length, 2);
  for (const c of sessions) {
    assert.ok(Math.abs(c.budgetUsd - mean) < 1e-9);
    assert.ok(!/checks|oracles/.test(c.prompt));
  }
});

test('matchedBudget: falls back when the compared arm has no cost', () => {
  const row = (arm: string, costUsd: number): BenchRow => ({ arm, goal: 'g', taskType: 't', humanMinutes: 1, repeat: 1, runId: 'r', harness: 'v1', checkPass: true, judgeSatisfaction: null, taskVerdicts: {}, costUsd, wallMs: 1 });
  const arms = [{ name: 'full' }, { name: 'x' }, SINGLE_SESSION_ARM];
  assert.equal(matchedBudget([row('full', 1), row('full', 3)], SINGLE_SESSION_ARM, arms, 9), 2);
  assert.equal(matchedBudget([row('full', 0)], SINGLE_SESSION_ARM, arms, 9), 9);
  assert.equal(matchedBudget([row('x', 5)], { name: 's', singleSession: true, compareTo: 'x' }, arms, 9), 5);
});

test('ablationTable: rows per arm with paired gain, CI clustered by goal, and the single-session row', () => {
  const rows: BenchRow[] = [];
  const add = (arm: string, goal: string, repeat: number, checkPass: boolean, extra: Partial<BenchRow> = {}) =>
    rows.push({ arm, goal, taskType: 't', humanMinutes: 1, repeat, runId: 'r', harness: 'v1', checkPass, judgeSatisfaction: null, taskVerdicts: {}, costUsd: 0.5, wallMs: 1, ...extra });
  const names = ['full', '-scenarios', '-repair', '-learnings', '-contrastive', '-evolver', 'single-session'];
  for (let g = 0; g < 8; g++) {
    for (let rep = 1; rep <= 3; rep++) {
      for (const n of names) {
        // full always passes; -repair always fails; others pass except goal 0
        const pass = n === 'full' ? true : n === '-repair' ? false : g !== 0;
        add(n, `g${g}`, rep, pass, n === 'single-session' ? { budgetUsd: 0.5 } : {});
      }
    }
  }
  const t = ablationTable(rows);
  assert.deepEqual(t.map((r) => r.arm), names);
  const ref = t[0];
  assert.equal(ref.gain, null);
  assert.equal(ref.passHat3, 1);
  const repair = t.find((r) => r.arm === '-repair')!;
  assert.equal(repair.gain, -1);
  assert.ok(repair.ci && repair.ci[1] <= -1 + 1e-9);
  const scen = t.find((r) => r.arm === '-scenarios')!;
  assert.ok(Math.abs(scen.gain! + 1 / 8) < 1e-9);
  assert.ok(scen.ci && scen.ci[0] < scen.gain! && scen.ci[1] > scen.gain!);
  assert.equal(t.find((r) => r.arm === 'single-session')!.budgetUsd, 0.5);
  const text = renderAblationTable(t);
  for (const n of names) assert.ok(text.includes(n), n);
  assert.match(text, /95% CI/);
  assert.match(text, /budget \$0\.500 matched/);
});

test('shipped suite: size, spread, schema, and every check fails on the base but passes with its oracle', () => {
  const goals = loadGoals();
  assert.ok(goals.length >= 20, `only ${goals.length} goals`);
  assert.equal(new Set(goals.map((g) => g.id)).size, goals.length, 'duplicate goal ids');
  const fixtures = new Set(goals.map((g) => g.fixture));
  assert.ok(fixtures.size >= 2 && fixtures.size <= 4, `${fixtures.size} fixtures`);
  const types = new Map<string, number>();
  for (const g of goals) {
    assert.equal(typeof g.id, 'string');
    assert.equal(g.goal.trim().length > 20, true, `${g.id}: goal text too short`);
    assert.ok(Number.isFinite(g.humanMinutes) && g.humanMinutes >= 5 && g.humanMinutes <= 60, `${g.id}: humanMinutes ${g.humanMinutes}`);
    assert.ok(existsSync(join(DEFAULT_SUITE, g.check)) && existsSync(join(DEFAULT_SUITE, g.oracle)), `${g.id}: check or oracle missing`);
    assert.ok(g.id.startsWith(g.check.replace(/^checks\//, '').replace(/\.mjs$/, '')), `${g.id}: check name`);
    types.set(g.taskType, (types.get(g.taskType) ?? 0) + 1);
  }
  assert.ok([...types.values()].filter((n) => n >= 4).length >= 3, `task types: ${JSON.stringify([...types])}`);
  const minutes = goals.map((g) => g.humanMinutes);
  assert.ok(Math.min(...minutes) <= 8 && Math.max(...minutes) >= 45, 'task lengths should span short and long');

  // verifyOracles fails a goal whose check passes on the untouched base, and one whose oracle fails its check.
  const res = verifyOracles();
  assert.equal(res.length, goals.length);
  assert.deepEqual(res.filter((r) => !r.ok), []);
  for (const g of goals) {
    const base = materialiseFixture(DEFAULT_SUITE, g.fixture);
    try {
      assert.equal(runCheck(DEFAULT_SUITE, g, base.dir).pass, false, `${g.id}: check passes on the unmodified base`);
      applyOracle(DEFAULT_SUITE, g, base.dir);
      assert.equal(runCheck(DEFAULT_SUITE, g, base.dir).pass, true, `${g.id}: oracle fails its check`);
    } finally {
      rmSync(base.dir, { recursive: true, force: true });
    }
  }
});

test('shipped suite is dependency-free and offline', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  for (const f of walk(DEFAULT_SUITE)) {
    if (f.endsWith('package.json')) {
      const pkg = JSON.parse(readFileSync(f, 'utf8'));
      assert.ok(!pkg.dependencies && !pkg.devDependencies && !pkg.scripts, `${f} declares dependencies or scripts`);
    }
    if (!/\.(m?js|ts)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket)\(/.test(text) && !/node:(http|https|net|dgram|dns|tls)\b/.test(text), `${f} uses the network`);
    for (const m of text.matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('.') || m[1].startsWith('node:'), `${f} imports ${m[1]}`);
  }
});

test('single-session budget does not read the source store harness when the compared arm has a cost', async () => {
  const store = tempRepo();
  rmSync(store.path('harness'), { recursive: true, force: true }); // the eager fallback used to throw here, after the full arm was paid for
  const arms = [ABLATION_ARMS[0], SINGLE_SESSION_ARM];
  const { rows } = await runBench({ store, runner: fakeRunner(), goals: ['calc-sub'], repeats: 1, arms, benchId: 'bl' });
  const single = rows.find((r) => r.arm === 'single-session')!;
  assert.ok(single.budgetUsd! > 0);
});
