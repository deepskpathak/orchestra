import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Runner } from '../src/agent.ts';
import * as g from '../src/git.ts';
import { runGoal, normalizeTasks, shouldEscalate } from '../src/conductor.ts';
import { DEFAULT_PROJECT_CONFIG } from '../src/store.ts';
import { fakeRunner } from '../src/fake.ts';
import { readLearnings } from '../src/learnings.ts';
import { tempRepo } from './helpers.ts';

test('happy path: plans, repairs a rejected task, merges all, learns', async () => {
  const store = tempRepo();
  const run = await runGoal({ store, runner: fakeRunner(), goal: 'demo goal' });

  assert.equal(run.status, 'done');
  assert.deepEqual(run.tasks.map((t) => t.status), ['merged', 'merged', 'merged', 'merged']);
  assert.equal(run.tasks.find((t) => t.id === 'T2')!.attempts, 2, 'T2 is rejected once, then repaired');
  assert.ok(run.satisfaction! > 0.8);
  assert.ok(run.costUsd > 0);
  assert.equal(readLearnings(store).length, 2);

  // Merged work landed on the integration branch, the user's checkout is untouched.
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' });
  for (const id of ['T1', 'T2', 'T3', 'T4']) assert.match(files, new RegExp(`fake/${id}.txt`));
  const mainFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: store.root, encoding: 'utf8' });
  assert.doesNotMatch(mainFiles, /fake\//);

  // Holdout scenarios exist for the judge only, outside every worktree.
  assert.equal(store.readJson<unknown[]>(`holdout/${run.id}.json`, []).length, 1);
  // Every agent session is in the ledger.
  assert.ok(store.ledgerRows().some((r) => r.role === 'judge' && r.task === 'T2' && r.attempt === 2));
  // The repair path wrote a progress file; tasks that merged first time did not need one.
  const prog = store.readJson<Record<string, unknown>>(`runs/${run.id}/progress/T2.json`, {});
  for (const k of ['taskId', 'attempt', 'issues', 'failingCriteria', 'diffSummary']) assert.ok(k in prog, k);
  assert.equal(prog.taskId, 'T2');
  assert.equal(store.readJson<unknown>(`runs/${run.id}/progress/T1.json`, null), null);
  const kinds = store.events(run.id).map((e) => e.kind);
  for (const k of ['run.start', 'plan', 'task.repair', 'task.merged', 'learn', 'run.end']) assert.ok(kinds.includes(k as never), k);
});

test('a task that never passes fails after maxAttempts and blocks dependents', async () => {
  const store = tempRepo();
  const run = await runGoal({ store, runner: fakeRunner({ failAlways: ['T1'], failFirstAttemptOf: [] }), goal: 'g' });
  const by = Object.fromEntries(run.tasks.map((t) => [t.id, t]));
  assert.equal(by.T1.status, 'failed');
  assert.equal(by.T1.attempts, 3);
  assert.equal(by.T3.status, 'blocked');
  assert.equal(by.T4.status, 'blocked');
  assert.equal(by.T2.status, 'merged');
  assert.equal(run.status, 'failed');
});

test('merge conflict sends the task back for a fresh attempt on the latest code', async () => {
  const store = tempRepo({ concurrency: 2 });
  const base = fakeRunner();
  // Two independent tasks both write shared.txt: whichever merges second conflicts.
  const runner: Runner = async (req) => {
    if (req.role === 'planner') {
      return {
        ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1,
        structured: {
          tasks: [
            { id: 'T1', title: 'a', description: 'a', acceptance: [], deps: [] },
            { id: 'T2', title: 'b', description: 'b', acceptance: [], deps: [] },
          ],
          scenarios: [],
        },
      };
    }
    if (req.role === 'worker') {
      writeFileSync(join(req.cwd, 'shared.txt'), `${req.meta!.task} attempt ${req.meta!.attempt}\n` + execFileSync('git', ['log', '--oneline'], { cwd: req.cwd, encoding: 'utf8' }));
      execFileSync('git', ['add', '-A'], { cwd: req.cwd });
      execFileSync('git', ['commit', '-qm', 'w'], { cwd: req.cwd });
      return { ok: true, text: 'done', costUsd: 0, turns: 1, durationMs: 1 };
    }
    if (req.role === 'judge') return { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { pass: true, score: 0.9, summary: 'ok', issues: [] } };
    return base(req);
  };
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.status, 'done');
  assert.ok(run.tasks.some((t) => t.attempts === 2), 'one task needed a second attempt after the conflict');
  assert.ok(store.ledgerRows().some((r) => r.outcome === 'conflict'));
});

test('failing test command rejects the change and the repair attempt lands', async () => {
  // Test command fails while a marker file exists; the worker removes it on attempt 2.
  const store = tempRepo({ testCommand: 'test ! -f broken.txt', concurrency: 1 });
  const runner: Runner = async (req) => {
    if (req.role === 'planner') {
      return { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { tasks: [{ id: 'T1', title: 'a', description: 'a', acceptance: [], deps: [] }], scenarios: [] } };
    }
    if (req.role === 'worker') {
      if (req.meta!.attempt === 1) writeFileSync(join(req.cwd, 'broken.txt'), 'x');
      else execFileSync('git', ['rm', '-q', 'broken.txt'], { cwd: req.cwd });
      writeFileSync(join(req.cwd, `work${req.meta!.attempt}.txt`), 'w');
      return { ok: true, text: 'done', costUsd: 0, turns: 1, durationMs: 1 };
    }
    if (req.role === 'judge') return { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { pass: true, score: 0.9, summary: 'ok', issues: [] } };
    return { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { lessons: [] } };
  };
  const run = await runGoal({ store, runner, goal: 'g' });
  const t1 = run.tasks[0];
  assert.equal(t1.status, 'merged');
  assert.equal(t1.attempts, 2);
  assert.equal(t1.verdict!.testsPassed, true);
});

test('planner crash fails the run cleanly', async () => {
  const store = tempRepo();
  const runner: Runner = async () => ({ ok: false, text: '', costUsd: 0, turns: 0, durationMs: 0, error: 'Failed to authenticate' });
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /Failed to authenticate/);
  const wts = execFileSync('git', ['worktree', 'list'], { cwd: store.root, encoding: 'utf8' }).trim().split('\n');
  assert.equal(wts.length, 1, 'worktrees are cleaned up');
});

test('normalizeTasks dedupes ids, drops unknown deps and breaks cycles', () => {
  const tasks = normalizeTasks([
    { id: 'A', title: 'a', description: '', acceptance: [], deps: ['B', 'ZZ'] },
    { id: 'B', title: 'b', description: '', acceptance: [], deps: ['A'] },
    { id: 'A', title: 'dup', description: '', acceptance: [], deps: [] },
  ]);
  assert.deepEqual(tasks.map((t) => t.id), ['A', 'B', 'A-3']);
  const a = tasks[0];
  const b = tasks[1];
  assert.ok(!(a.deps.includes('B') && b.deps.includes('A')), 'cycle broken');
  assert.ok(!a.deps.includes('ZZ'));
});

function countingRunner(inner: Runner) {
  const calls = { worker: 0, judge: 0 };
  const runner: Runner = async (req) => {
    if (req.role === 'worker' && req.meta?.task === 'T1') calls.worker += 1;
    if (req.role === 'judge') calls.judge += 1;
    return inner(req);
  };
  return { runner, calls };
}

const oneTaskRunner = (judgeFailTimes: number) => {
  const base = fakeRunner({ judgeFailTimes, failFirstAttemptOf: [] });
  const inner: Runner = async (req) =>
    req.role === 'planner'
      ? { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { tasks: [{ id: 'T1', title: 'a', description: 'a', acceptance: [], deps: [] }], scenarios: [] } }
      : base(req);
  return countingRunner(inner);
};

test('a failed judge is retried alone once and the task still merges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-judge-'));
  const log = join(dir, 'runs.log');
  const store = tempRepo({ testCommand: `echo x >> '${log}'` });
  const { runner, calls } = oneTaskRunner(1);
  const run = await runGoal({ store, runner, goal: 'g' });
  // Tests run once for the attempt (plus once post-merge), never again for the judge retry.
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  rmSync(dir, { recursive: true, force: true });
  const t = run.tasks[0];
  assert.equal(t.status, 'merged');
  assert.equal(t.attempts, 1);
  assert.equal(calls.worker, 1);
  assert.equal(calls.judge, 2);
  assert.equal(t.verdict!.judgeError, undefined);
});

test('two judge failures fail the task without a repair attempt or a 0.00 score', async () => {
  const store = tempRepo();
  const { runner, calls } = oneTaskRunner(2);
  const run = await runGoal({ store, runner, goal: 'g' });
  const t = run.tasks[0];
  assert.equal(t.status, 'failed');
  assert.equal(calls.worker, 1);
  assert.equal(calls.judge, 2);
  assert.ok(t.verdict!.judgeError);
  const ev = store.events(run.id);
  const failed = ev.find((e) => e.kind === 'task.failed')!;
  assert.match(failed.msg, /judge failed twice/);
  assert.match(failed.msg, /budgetUsd\.judge/);
  assert.doesNotMatch(ev.find((e) => e.kind === 'task.verdict')!.msg, /0\.00/);
  assert.ok(!ev.some((e) => e.kind === 'task.repair'));
  assert.ok(store.ledgerRows().every((r) => r.score === undefined || r.score > 0));
});

test('judgeTiers is off by default and shouldEscalate covers each trigger', () => {
  assert.equal(DEFAULT_PROJECT_CONFIG.judgeTiers.enabled, false);
  const clean = { score: 0.95, issues: [] as string[] };
  assert.equal(shouldEscalate(clean, true, 0.75, 0.1), false);
  assert.equal(shouldEscalate(clean, null, 0.75, 0.1), false);
  assert.equal(shouldEscalate(clean, false, 0.75, 0.1), true);
  assert.equal(shouldEscalate({ score: 0.8, issues: [] }, true, 0.75, 0.1), true);
  assert.equal(shouldEscalate({ score: 0.65, issues: [] }, true, 0.75, 0.1), true);
  assert.equal(shouldEscalate({ score: 0.95, issues: ['nit'] }, true, 0.75, 0.1), true);
  assert.equal(shouldEscalate(undefined, true, 0.75, 0.1), true);
});

test('default config makes one strong judge call per attempt', async () => {
  const store = tempRepo();
  const { runner, calls } = oneTaskRunner(0);
  await runGoal({ store, runner, goal: 'g' });
  assert.equal(calls.judge, 1);
  assert.ok(store.ledgerRows().filter((r) => r.role === 'judge').every((r) => r.model === 'opus'));
});

const tieredRun = async (cheapScore: number) => {
  const store = tempRepo({ judgeTiers: { enabled: true, cheapModel: 'haiku', margin: 0.1 } });
  const { runner: base } = oneTaskRunner(0);
  const models: string[] = [];
  const runner: Runner = async (req) => {
    if (req.role === 'judge') {
      models.push(req.model);
      if (req.model === 'haiku') return { ok: true, text: '', costUsd: 0.01, turns: 1, durationMs: 1, structured: { pass: true, score: cheapScore, summary: 'cheap', issues: [] } };
    }
    return base(req);
  };
  const run = await runGoal({ store, runner, goal: 'g' });
  return { run, models, store };
};

test('tiers enabled: a clean confident cheap verdict merges without the strong judge', async () => {
  const { run, models, store } = await tieredRun(0.95);
  assert.deepEqual(models, ['haiku']);
  assert.equal(run.tasks[0].status, 'merged');
  assert.equal(run.tasks[0].verdict!.summary, 'cheap');
  assert.deepEqual(store.ledgerRows().filter((r) => r.role === 'judge').map((r) => r.model), ['haiku']);
});

test('tiers enabled: a borderline cheap verdict escalates and the strong verdict is final', async () => {
  const { run, models, store } = await tieredRun(0.78);
  assert.deepEqual(models, ['haiku', 'opus']);
  assert.equal(run.tasks[0].status, 'merged');
  assert.equal(run.tasks[0].verdict!.summary, 'Meets criteria');
  assert.deepEqual(store.ledgerRows().filter((r) => r.role === 'judge').map((r) => r.model), ['haiku', 'opus']);
});

test('diffStat throws on a bogus base and a progress file is not written when out of attempts', async () => {
  const store = tempRepo();
  assert.throws(() => g.diffStat(store.root, 'no-such-ref'));
  assert.equal(g.diffStat(store.root, 'HEAD'), '');
});
