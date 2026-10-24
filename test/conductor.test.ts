import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Runner } from '../src/agent.ts';
import * as g from '../src/git.ts';
import { runGoal, normalizeTasks, shouldEscalate, missingTestIssues, preJudgeIssues, fastPathDecision, FAST_PLAN_SCHEMA } from '../src/conductor.ts';
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
  assert.equal(run.domain, 'cli');
  assert.equal(store.readJson<{ domain?: string }>(`runs/${run.id}/run.json`, {}).domain, 'cli');
  const domainLessons = readLearnings(store, 'cli');
  assert.equal(domainLessons.length, 2);
  assert.ok(domainLessons.every((l) => l.evidence.some((e) => e.run === run.id)));
  assert.equal(readLearnings(store).length, 0);
  assert.ok(existsSync(store.path('learnings/cli.json')));

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

test('an invalid planner domain leaves run.domain unset without failing the run', async () => {
  const store = tempRepo();
  const inner = fakeRunner();
  const runner: Runner = async (req) => {
    const r = await inner(req);
    if (req.role === 'planner') (r.structured as { domain?: string }).domain = 'Not A Slug!';
    return r;
  };
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.status, 'done');
  assert.equal(run.domain, undefined);
  assert.equal(readLearnings(store).length, 2, 'lessons land in global');
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

test('preJudge defaults off and an older config.json gets the full default', () => {
  assert.deepEqual(DEFAULT_PROJECT_CONFIG.preJudge, { enabled: false, lintCommand: null, requireTests: true });
  const store = tempRepo();
  const cfg = store.readJson<Record<string, unknown>>('config.json', {});
  delete cfg.preJudge;
  store.writeJson('config.json', cfg);
  assert.deepEqual(store.config().preJudge, { enabled: false, lintCommand: null, requireTests: true });
});

test('missingTestIssues flags new src exports without a changed test', () => {
  const add = '+++ b/src/x.ts\n@@ -1 +1,2 @@\n+export function f() {}\n';
  assert.equal(missingTestIssues(add, ['src/x.ts']).length, 1);
  assert.match(missingTestIssues(add, ['src/x.ts'])[0], /src\/x\.ts/);
  assert.deepEqual(missingTestIssues(add, ['src/x.ts', 'test/x.test.ts']), []);
  assert.deepEqual(missingTestIssues(add, ['src/x.ts', 'src/y.test.ts']), []);
  assert.deepEqual(missingTestIssues('+++ b/src/x.ts\n+const a = 1;\n', ['src/x.ts']), []);
  assert.deepEqual(missingTestIssues('+++ b/src/x.ts\n@@\n context\n', ['src/x.ts']), []);
  assert.deepEqual(missingTestIssues('+++ b/README.md\n+export nothing\n', ['README.md']), []);
});

test('fastPath defaults off and an older config.json gets it', () => {
  assert.deepEqual(DEFAULT_PROJECT_CONFIG.fastPath, { enabled: false, maxGoalChars: 400 });
  const store = tempRepo();
  const cfg = store.readJson<Record<string, unknown>>('config.json', {});
  delete cfg.fastPath;
  store.writeJson('config.json', cfg);
  assert.deepEqual(store.config().fastPath, { enabled: false, maxGoalChars: 400 });
});

test('fastPathDecision applies each rule', () => {
  const on = { enabled: true, maxGoalChars: 100 };
  assert.equal(fastPathDecision('Fix the typo in README.', { ...on, enabled: false }).fast, false);
  assert.deepEqual(fastPathDecision('Fix the typo in README.', on), { fast: true, reason: 'small single-concern goal' });
  assert.equal(fastPathDecision('x'.repeat(101), on).fast, false);
  assert.equal(fastPathDecision('Do this:\n- one\n- two', on).fast, false);
  assert.equal(fastPathDecision('Do this:\n1. one\n2) two', on).fast, false);
  assert.equal(fastPathDecision('Do (1) a and (2) b', on).fast, false);
  assert.equal(fastPathDecision('   ', on).fast, false);
});

test('fast plan schema allows one task and does not require scenarios', () => {
  assert.equal(FAST_PLAN_SCHEMA.properties.tasks.maxItems, 1);
  assert.deepEqual(FAST_PLAN_SCHEMA.required, ['tasks']);
});

test('preJudgeIssues combines lint failure and test issues', () => {
  assert.deepEqual(preJudgeIssues({ lint: { ok: true, tail: '' }, testIssues: [] }), []);
  assert.deepEqual(preJudgeIssues({ lint: null, testIssues: ['t'] }), ['t']);
  const out = preJudgeIssues({ lint: { ok: false, tail: 'boom', cmd: 'npm run lint' }, testIssues: ['t'] });
  assert.equal(out.length, 2);
  assert.match(out[0], /Lint command `npm run lint` fails\. Output tail: boom/);
});

test('preJudge enabled with a failing lint goes to repair without a judge call', async () => {
  const store = tempRepo({ preJudge: { enabled: true, lintCommand: 'exit 1', requireTests: true } });
  const { runner, calls } = oneTaskRunner(0);
  const run = await runGoal({ store, runner, goal: 'g' });
  const t = run.tasks[0];
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts, 3);
  assert.equal(calls.judge ?? 0, 0);
  const rows = store.ledgerRows();
  assert.ok(!rows.some((r) => r.role === 'judge' && r.attempt === 1));
  assert.ok(rows.some((r) => (r as { outcome?: string }).outcome === 'prejudge_fail'));
  assert.ok(store.events(run.id).some((e) => e.kind === 'task.repair'));
  assert.match(t.verdict!.issues[0], /Lint command `exit 1` fails/);
});

test('preJudge disabled (default) still calls the judge', async () => {
  const store = tempRepo({ preJudge: { enabled: false, lintCommand: 'exit 1', requireTests: true } });
  const { runner, calls } = oneTaskRunner(0);
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(calls.judge, 1);
  assert.equal(run.tasks[0].status, 'merged');
});

test('diffStat throws on a bogus base (repairOrFail guards it) and is empty for no changes', async () => {
  const store = tempRepo();
  assert.throws(() => g.diffStat(store.root, 'no-such-ref'));
  assert.equal(g.diffStat(store.root, 'HEAD'), '');
});

// ---------- contrastive repair ----------

const countBy = (runner: Runner) => {
  const seen = { worker: [] as Array<string | undefined>, compare: 0, judge: 0 };
  const wrapped: Runner = async (req) => {
    if (req.role === 'worker') seen.worker.push(`${req.meta?.task}:${req.meta?.attempt}:${req.meta?.variant ?? '-'}`);
    if (req.role === 'judge') {
      seen.judge += 1;
      if (/ATTEMPT A DIFF/.test(req.prompt)) seen.compare += 1;
    }
    return runner(req);
  };
  return { seen, wrapped };
};
const contrastive = { enabled: true, onlyWithoutTests: true, maxPairs: 1 };

test('contrastive: attempt 1 single worker, repair runs two workers and one comparison; B wins and merges', async () => {
  const store = tempRepo({ concurrency: 1, contrastive });
  const { seen, wrapped } = countBy(fakeRunner({ contrastPick: 'B' }));
  const run = await runGoal({ store, runner: wrapped, goal: 'g' });
  const t2 = run.tasks.find((t) => t.id === 'T2')!;
  assert.equal(t2.status, 'merged');
  assert.deepEqual(seen.worker.filter((w) => w!.startsWith('T2:')), ['T2:1:-', 'T2:2:a', 'T2:2:b']);
  assert.equal(seen.compare, 1);
  assert.equal(t2.contrast?.picked, 'B');
  assert.match(t2.contrast!.reasons, /empty config/);
  assert.equal(t2.verdict?.pass, true);
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' });
  assert.match(files, /fake\/T2-b\.txt/);
  // Loser A: worktree dir and branch are gone.
  assert.ok(!existsSync(store.path('worktrees', run.id, 'T2')));
  const branches = execFileSync('git', ['branch', '--list', `orchestra/${run.id}/*`], { cwd: store.root, encoding: 'utf8' });
  assert.doesNotMatch(branches, new RegExp(`${run.id}/T2\\s*$`, 'm'));
  const ev = store.events(run.id).find((e) => e.kind === 'task.contrast')!;
  assert.match(ev.msg, /T2 picked B over A because .*empty config/);
  assert.equal((ev.data as { picked: string }).picked, 'B');
  const rows = store.ledgerRows().filter((r) => r.role === 'worker' && r.task === 'T2' && r.attempt === 2 && !r.outcome);
  assert.equal(rows.length, 2);
});

test('contrastive: A wins, B worktree and branch removed', async () => {
  const store = tempRepo({ concurrency: 1, contrastive });
  const run = await runGoal({ store, runner: fakeRunner({ contrastPick: 'A' }), goal: 'g' });
  const t2 = run.tasks.find((t) => t.id === 'T2')!;
  assert.equal(t2.contrast?.picked, 'A');
  assert.equal(t2.status, 'merged');
  assert.ok(!existsSync(store.path('worktrees', run.id, 'T2-b')));
  const branches = execFileSync('git', ['branch', '--list', `orchestra/${run.id}/*`], { cwd: store.root, encoding: 'utf8' });
  assert.doesNotMatch(branches, /T2-b/);
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' });
  assert.doesNotMatch(files, /T2-b\.txt/);
});

test('contrastive: a worker flagging for a human removes the B worktree and branch', async () => {
  const store = tempRepo({ concurrency: 1, contrastive });
  const run = await runGoal({ store, runner: fakeRunner({ failFirstAttemptOf: ['T2'], flagOnRepair: ['T2'] }), goal: 'g' });
  const t2 = run.tasks.find((t) => t.id === 'T2')!;
  assert.equal(t2.status, 'needs_human');
  assert.ok(!existsSync(store.path('worktrees', run.id, 'T2-b')));
  const branches = execFileSync('git', ['branch', '--list', `orchestra/${run.id}/*`], { cwd: store.root, encoding: 'utf8' });
  assert.doesNotMatch(branches, /T2-b/);
});

test('contrastive: a preferred attempt below passThreshold is not merged on preference alone', async () => {
  const store = tempRepo({ concurrency: 1, contrastive });
  const run = await runGoal({ store, runner: fakeRunner({ contrastPick: 'B', contrastScores: { a: 0.3, b: 0.5 }, failFirstAttemptOf: ['T1'] }), goal: 'g' });
  const t1 = run.tasks.find((t) => t.id === 'T1')!;
  assert.equal(t1.contrast?.picked, null);
  // Attempt 2 was not merged; the next (single, pairs exhausted) attempt is what lands.
  assert.equal(t1.attempts, 3);
  assert.match(t1.verdict!.summary, /Meets criteria/);
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' });
  assert.doesNotMatch(files, /T1-b\.txt/);
  assert.ok(!existsSync(store.path('worktrees', run.id, 'T1-b')));
});

test('contrastive: with a testCommand and onlyWithoutTests the repair stays single-worker', async () => {
  const store = tempRepo({ concurrency: 1, testCommand: 'true', contrastive });
  const { seen, wrapped } = countBy(fakeRunner());
  const run = await runGoal({ store, runner: wrapped, goal: 'g' });
  assert.equal(run.tasks.find((t) => t.id === 'T2')!.contrast, undefined);
  assert.equal(seen.compare, 0);
  assert.ok(seen.worker.every((w) => w!.endsWith(':-')));
});

test('contrastive: librarian prompt carries the judge reasons with run and task id', async () => {
  const store = tempRepo({ concurrency: 1, contrastive });
  const inner = fakeRunner({ contrastPick: 'B' });
  let libPrompt = '';
  const run = await runGoal({
    store,
    goal: 'g',
    runner: async (req) => {
      if (req.role === 'librarian') libPrompt = req.prompt;
      return inner(req);
    },
  });
  assert.match(libPrompt, new RegExp(`contrast \\(run ${run.id}, task T2, attempt 2\\): picked B over A because Attempt B handled`));
});

test('flag_for_human stops after one attempt: needs_human, reason stored, event emitted, not a failure', async () => {
  const store = tempRepo();
  const run = await runGoal({ store, runner: fakeRunner({ flagForHuman: ['T1'], failFirstAttemptOf: [] }), goal: 'g' });
  const by = Object.fromEntries(run.tasks.map((t) => [t.id, t]));
  assert.equal(by.T1.status, 'needs_human');
  assert.equal(by.T1.attempts, 1);
  assert.match(by.T1.humanReason ?? '', /contradict/);
  assert.equal(by.T3.status, 'blocked');
  assert.equal(by.T2.status, 'merged');
  const evs = store.events(run.id);
  assert.equal(evs.filter((e) => e.kind === 'task.needs_human' && e.task === 'T1').length, 1);
  assert.equal(evs.filter((e) => e.kind === 'task.repair' && e.task === 'T1').length, 0);
  assert.equal(evs.filter((e) => e.kind === 'task.failed' && e.task === 'T1' && !/blocked/.test(e.msg)).length, 0);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /1 need a human/);
  assert.match(run.error ?? '', /\(2 failed|\(\d+ failed/);
});

test('parseWorkerOutcome reads structured and text flags', async () => {
  const { parseWorkerOutcome } = await import('../src/agent.ts');
  const base = { ok: true, costUsd: 0, turns: 1, durationMs: 0 };
  assert.deepEqual(parseWorkerOutcome({ ...base, text: 'did it' }), { outcome: 'done' });
  assert.deepEqual(parseWorkerOutcome({ ...base, text: 'x\nFLAG_FOR_HUMAN: spec vs test' }), { outcome: 'flag_for_human', reason: 'spec vs test' });
  assert.deepEqual(parseWorkerOutcome({ ...base, text: '', structured: { outcome: 'flag_for_human' } }), { outcome: 'flag_for_human', reason: 'no reason given' });
});

function addSampleTest(store: ReturnType<typeof tempRepo>): void {
  mkdirSync(join(store.root, 'test'), { recursive: true });
  writeFileSync(join(store.root, 'test', 'sample.test.js'), "import assert from 'node:assert';\nassert.equal(1, 1);\nassert.ok(true);\n");
  execFileSync('git', ['add', '-A'], { cwd: store.root });
  execFileSync('git', ['commit', '-qm', 'add sample test'], { cwd: store.root });
}

test('integrity monitor: a deleted assertion is flagged, graded on restored tests, noted for repair, persisted', async () => {
  const store = tempRepo({ testCommand: 'grep -q "assert.ok" test/sample.test.js' });
  addSampleTest(store);
  const runner = fakeRunner({ failFirstAttemptOf: [], tamper: (req) => req.meta?.task === 'T1' && req.meta?.attempt === 1 });
  const run = await runGoal({ store, runner, goal: 'g' });
  const t1 = run.tasks.find((t) => t.id === 'T1')!;
  assert.equal(t1.attempts, 2, 'tampered attempt 1 goes to repair, attempt 2 is clean');
  assert.equal(t1.status, 'merged');

  const repair = store.events(run.id).find((e) => e.kind === 'task.repair' && e.task === 'T1')!;
  const issues = (repair.data as { issues: string[] }).issues;
  assert.match(issues[0], /weakened-test in test\/sample\.test\.js/);
  assert.match(issues[0], /assertion line\(s\) removed/);
  // The tampered tree would fail this grep; the restored originals pass, and that is what graded.
  assert.ok(store.events(run.id).some((e) => e.task === 'T1' && /tests with original grading files restored passed/.test(e.msg)));

  const stored = store.loadRun(run.id)!.tasks.find((t) => t.id === 'T1')!;
  assert.ok(stored.integrityFlags?.some((f) => f.kind === 'weakened-test' && f.file === 'test/sample.test.js'));
  assert.equal(run.tasks.find((t) => t.id === 'T2')!.integrityFlags, undefined, 'clean tasks carry no flags');
  // The tampered edit never reached the integration branch.
  const sample = execFileSync('git', ['show', `${run.integrationBranch}:test/sample.test.js`], { cwd: store.root, encoding: 'utf8' });
  assert.match(sample, /assert\.ok/);
});

test('integrity monitor: restored originals that still fail the tests are reported in the repair note', async () => {
  const store = tempRepo({ testCommand: 'grep -q "never-there" test/sample.test.js' });
  addSampleTest(store);
  const runner = fakeRunner({ failFirstAttemptOf: [], tamper: (req) => req.meta?.task === 'T1' && req.meta?.attempt === 1 });
  const run = await runGoal({ store, runner, goal: 'g' });
  const repair = store.events(run.id).find((e) => e.kind === 'task.repair' && e.task === 'T1')!;
  assert.ok(store.events(run.id).some((e) => e.task === 'T1' && /restored FAILED/.test(e.msg)));
  assert.match((repair.data as { issues: string[] }).issues[0], /Tests on the original files failed/);
});
