import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { AgentRequest, Runner } from '../src/agent.ts';
import { DEFAULT_SUITE, loadArms, loadGoals, runBench, summarize, verifyOracles, type BenchRow } from '../src/bench.ts';
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
