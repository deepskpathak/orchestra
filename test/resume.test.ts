import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRequest, AgentResult, Runner } from '../src/agent.ts';
import { approveTask } from '../src/approve.ts';
import { resumeRun, runGoal } from '../src/conductor.ts';
import { fakeRunner } from '../src/fake.ts';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { runSatisfaction } from '../src/oversight.ts';
import { DEFAULT_PROJECT_CONFIG } from '../src/store.ts';
import type { ProjectConfig } from '../src/types.ts';
import type { ProbeExec } from '../src/sandbox.ts';
import { tempRepo } from './helpers.ts';

// W7.1 resume: finish a run that approval finalised with deferred work, on the same run and integration branch.

const t = (id: string, deps: string[] = []) => ({ id, title: id, description: id, acceptance: [`${id} works`], deps });

// Fixed plan; workers of the `risky` tasks also write an infra file, which the default risk tiers hold.
function planned(tasks: any[], risky: string[], calls: string[] = [], judgePrompts: string[] = []): Runner {
  const inner = fakeRunner({ stepMs: 0, failFirstAttemptOf: [] });
  return async (req: AgentRequest): Promise<AgentResult> => {
    calls.push(`${req.role}:${req.meta?.task ?? ''}`);
    if (req.role === 'judge') judgePrompts.push(req.prompt);
    if (req.role === 'planner') return { ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, structured: { tasks, scenarios: [{ id: 'S1', given: 'a hidden setup', when: 'HIDDEN-SCENARIO-MARK happens', then: 'it works' }] } };
    const res = await inner(req);
    const id = req.meta?.task ?? '';
    if (req.role === 'worker' && risky.includes(id)) {
      mkdirSync(join(req.cwd, 'infra'), { recursive: true });
      writeFileSync(join(req.cwd, 'infra', `${id}.tf`), 'resource {}\n');
    }
    return res;
  };
}

function repo(config: Partial<ProjectConfig> = {}) {
  return tempRepo({ oversight: { riskTiers: { ...DEFAULT_PROJECT_CONFIG.oversight!.riskTiers, enabled: true } }, ...config });
}

async function asRequester<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ORCHESTRA_REQUESTER;
  process.env.ORCHESTRA_REQUESTER = 'alice';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_REQUESTER;
    else process.env.ORCHESTRA_REQUESTER = prev;
  }
}

const branchFiles = (root: string, branch: string) => execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: root, encoding: 'utf8' });
const branches = (root: string) => execFileSync('git', ['branch', '--list', 'orchestra/*/integration', '--format=%(refname:short)'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

test('resume runs the task blocked behind an approved task on the same run and branch, then learns', () => asRequester(async () => {
  const store = repo();
  const calls: string[] = [];
  const judged: string[] = [];
  const runner = planned([t('T1'), t('T2'), t('T3', ['T2'])], ['T2'], calls, judged);
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.status, 'awaiting_approval');
  assert.deepEqual(run.tasks.map((x) => x.status), ['merged', 'awaiting_approval', 'blocked']);

  const approved = await approveTask(store, run.id, 'T2', 'bob');
  assert.equal(approved.status, 'failed');
  assert.deepEqual(approved.deferred, ['tasks', 'learning']);
  assert.match(approved.error!, /orchestra resume/);
  assert.ok(store.events(run.id).some((e) => e.kind === 'task.merged' && /orchestra resume/.test(e.msg)));
  const tip = execFileSync('git', ['rev-parse', run.integrationBranch!], { cwd: store.root, encoding: 'utf8' }).trim();

  calls.length = 0;
  judged.length = 0;
  const done = await resumeRun({ store, runner, runId: run.id });
  assert.equal(done.id, run.id);
  assert.ok(judged.length && judged.every((p) => p.includes('HIDDEN-SCENARIO-MARK')), 'hidden scenarios are reloaded for the judge');
  assert.equal(done.integrationBranch, run.integrationBranch);
  assert.deepEqual(branches(store.root), [run.integrationBranch], 'no new integration branch');
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.error, undefined);
  assert.equal(done.deferred, undefined);
  assert.deepEqual(done.tasks.map((x) => x.status), ['merged', 'merged', 'merged']);
  assert.equal(done.satisfaction, runSatisfaction(done.tasks));
  assert.ok(done.satisfaction! > approved.satisfaction!, 'satisfaction now counts T3');
  assert.ok(!calls.includes('planner:'), 'resume does not re-plan');
  assert.ok(calls.includes('worker:T3') && calls.includes('judge:T3'));
  assert.ok(!calls.some((c) => c === 'worker:T1' || c === 'worker:T2'), 'merged tasks are not redone');
  assert.ok(calls.includes('librarian:'), 'learning runs on resume');
  assert.ok(store.events(run.id).some((e) => e.kind === 'learn'));
  const files = branchFiles(store.root, run.integrationBranch!);
  assert.match(files, /fake\/T3/);
  assert.match(files, /infra\/T2\.tf/);
  // The branch moved forward from the approved tip: T3 was merged on top of it.
  execFileSync('git', ['merge-base', '--is-ancestor', tip, run.integrationBranch!], { cwd: store.root });
  assert.equal(store.events(run.id).filter((e) => e.kind === 'run.end').length, 2);
  assert.equal(store.loadRun(run.id)!.status, 'done');
  // The integration worktree is cleaned up again.
  assert.doesNotMatch(execFileSync('git', ['worktree', 'list'], { cwd: store.root, encoding: 'utf8' }), /_integration/);
}));

test('approving the last held task with no blocked dependents defers mutation and learning only; resume runs both', () => asRequester(async () => {
  const store = repo({ testCommand: 'true', verification: { ...DEFAULT_PROJECT_CONFIG.verification, mutation: { ...DEFAULT_PROJECT_CONFIG.verification.mutation, enabled: true, floor: 0 } } });
  writeFileSync(join(store.root, 'calc.js'), 'export const ok = (a, b) => a === b && a < 3;\n');
  execFileSync('git', ['add', '-A'], { cwd: store.root });
  execFileSync('git', ['commit', '-qm', 'calc'], { cwd: store.root });
  const calls: string[] = [];
  const runner = planned([t('T1'), t('T2')], ['T2'], calls);
  const mutation = { changedFiles: ['calc.js'], exec: () => ({ ok: true }) };
  const run = await runGoal({ store, runner, goal: 'g', mutation });
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.mutation, undefined, 'mutation waits for approval');
  assert.ok(!calls.includes('librarian:'));

  const approved = await approveTask(store, run.id, 'T2', 'bob');
  assert.equal(approved.status, 'done');
  assert.deepEqual(approved.deferred, ['mutation', 'learning']);

  calls.length = 0;
  const done = await resumeRun({ store, runner, runId: run.id, mutation });
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.deferred, undefined);
  assert.ok(!calls.some((c) => c.startsWith('worker:')), 'nothing to run, no workers');
  assert.equal(done.mutation!.total, 3);
  assert.ok(store.events(run.id).some((e) => /Mutation score/.test(e.msg)));
  assert.ok(calls.includes('librarian:'));
  assert.ok(store.ledgerRows().some((r) => r.run === run.id && r.role === 'librarian'));
}));

test('resume preconditions: unknown run, tasks still held, nothing to resume', () => asRequester(async () => {
  const store = repo();
  const runner = planned([t('T1'), t('T2', ['T1'])], ['T1']);
  await assert.rejects(() => resumeRun({ store, runner, runId: 'nope' }), /unknown run "nope"/);

  const run = await runGoal({ store, runner, goal: 'g' });
  assert.equal(run.status, 'awaiting_approval');
  await assert.rejects(() => resumeRun({ store, runner, runId: run.id }), new RegExp(`awaiting approval \\(T1\\).*orchestra approve ${run.id} T1 --by <name>`));
  assert.equal(store.loadRun(run.id)!.status, 'awaiting_approval', 'a refused resume changes nothing');

  await approveTask(store, run.id, 'T1', 'bob');
  const done = await resumeRun({ store, runner, runId: run.id });
  assert.equal(done.status, 'done', done.error);
  await assert.rejects(() => resumeRun({ store, runner, runId: run.id }), /nothing to resume/);

  const plain = await runGoal({ store, runner: fakeRunner({ stepMs: 0 }), goal: 'plain' });
  await assert.rejects(() => resumeRun({ store, runner, runId: plain.id }), /nothing to resume/);
}));

test('a resumed task that is itself high risk holds the run again; approve and resume finish it', () => asRequester(async () => {
  const store = repo();
  const runner = planned([t('T1'), t('T2', ['T1'])], ['T1', 'T2']);
  const run = await runGoal({ store, runner, goal: 'g' });
  await approveTask(store, run.id, 'T1', 'bob');

  const held = await resumeRun({ store, runner, runId: run.id });
  assert.equal(held.status, 'awaiting_approval');
  assert.equal(held.deferred, undefined, 'a held run carries no marker until approval finalises it');
  assert.equal(held.error, undefined);
  assert.deepEqual(held.tasks.map((x) => x.status), ['merged', 'awaiting_approval']);
  await assert.rejects(() => resumeRun({ store, runner, runId: run.id }), /T2/);

  const approved = await approveTask(store, run.id, 'T2', 'bob');
  assert.equal(approved.status, 'done');
  assert.deepEqual(approved.deferred, ['learning']);
  const done = await resumeRun({ store, runner, runId: run.id });
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.id, run.id);
  assert.match(branchFiles(store.root, run.integrationBranch!), /infra\/T2\.tf/);
}));

test('resume keeps failed tasks and their dependents as they are', () => asRequester(async () => {
  const store = repo();
  // T1 is held; T2 behind it gets reset; T3 behind T2 too. A run file edit marks T3 needs_human: T4 behind it stays blocked.
  const runner = planned([t('T1'), t('T2', ['T1']), t('T3'), t('T4', ['T3'])], ['T1', 'T3']);
  const run = await runGoal({ store, runner, goal: 'g' });
  assert.deepEqual(run.tasks.map((x) => x.status), ['awaiting_approval', 'blocked', 'awaiting_approval', 'blocked']);
  const stored = store.loadRun(run.id)!;
  stored.tasks[2].status = 'needs_human';
  store.saveRun(stored);
  await approveTask(store, run.id, 'T1', 'bob');
  // T3 is no longer awaiting approval, so the approval finalises the run.
  const done = await resumeRun({ store, runner, runId: run.id });
  assert.deepEqual(done.tasks.map((x) => x.status), ['merged', 'merged', 'needs_human', 'blocked']);
  assert.equal(done.status, 'failed');
  assert.match(done.error!, /1 blocked, 1 need a human/);
}));

test('resume reloads the frozen contract and refuses when it was modified', () => asRequester(async () => {
  const store = repo({ verification: { ...DEFAULT_PROJECT_CONFIG.verification, contracts: { ...DEFAULT_PROJECT_CONFIG.verification.contracts, enabled: true } } });
  const runner = planned([t('T1'), t('T2', ['T1'])], ['T1']);
  const run = await runGoal({ store, runner, goal: 'g' });
  await approveTask(store, run.id, 'T1', 'bob');
  const path = run.contract!.path;
  const original = store.readJson<any>(path, null);
  store.writeJson(path, { ...original, criteria: [] });
  const before = JSON.stringify(store.loadRun(run.id));
  await assert.rejects(() => resumeRun({ store, runner, runId: run.id }), /does not match its recorded sha256/);
  assert.equal(JSON.stringify(store.loadRun(run.id)), before, 'a refused resume leaves the run untouched');

  store.writeJson(path, original);
  const done = await resumeRun({ store, runner, runId: run.id });
  assert.equal(done.status, 'done', done.error);
}));

test('orchestra resume (CLI): usage, refusal and a finished run', () => asRequester(async () => {
  const store = repo();
  const run = await runGoal({ store, runner: planned([t('T1'), t('T2', ['T1'])], ['T1']), goal: 'g' });
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const resume = (...a: string[]) => spawnSync(process.execPath, [cli, 'resume', ...a], { cwd: store.root, encoding: 'utf8', timeout: 60000, env: { ...process.env, ORCHESTRA_RUNNER: 'fake', ORCHESTRA_FAKE_STEP_MS: '0' } });
  const usage = resume();
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: orchestra resume <runId>/);
  const held = resume(run.id);
  assert.equal(held.status, 1);
  assert.match(held.stderr, /awaiting approval/);

  const approve = spawnSync(process.execPath, [cli, 'approve', run.id, 'T1', '--by', 'bob'], { cwd: store.root, encoding: 'utf8', timeout: 60000 });
  assert.equal(approve.status, 0, approve.stderr);
  assert.match(approve.stdout, new RegExp(`orchestra resume ${run.id}`));

  const ok = resume(run.id);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, new RegExp(`run ${run.id} DONE: 2/2 tasks merged`));
  assert.equal(store.loadRun(run.id)!.status, 'done');
  const again = resume(run.id);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /nothing to resume/);
}));

test('a resume that fails before any work runs leaves the stored run untouched', () => asRequester(async () => {
  const store = repo();
  const runner = planned([t('T1'), t('T2', ['T1'])], ['T1']);
  const run = await runGoal({ store, runner, goal: 'g' });
  await approveTask(store, run.id, 'T1', 'bob');
  // The integration branch is checked out elsewhere, so the resume cannot reopen it.
  const other = join(store.root, '..', `other-${run.id}`);
  execFileSync('git', ['worktree', 'add', '-q', other, run.integrationBranch!], { cwd: store.root });
  const before = JSON.stringify(store.loadRun(run.id));
  const ends = store.events(run.id).filter((e) => e.kind === 'run.end').length;
  await assert.rejects(() => resumeRun({ store, runner, runId: run.id }), /already (checked out|used by worktree)/);
  assert.equal(JSON.stringify(store.loadRun(run.id)), before);
  assert.equal(store.events(run.id).filter((e) => e.kind === 'run.end').length, ends, 'no extra run.end');

  execFileSync('git', ['worktree', 'remove', '--force', other], { cwd: store.root });
  const done = await resumeRun({ store, runner, runId: run.id });
  assert.equal(done.status, 'done', done.error);
}));

test('the marker survives a failed pre-flight and a throw inside the tail; a retry finishes the run', () => asRequester(async () => {
  const store = repo();
  let librarianThrows = 1;
  const inner = planned([t('T1'), t('T2', ['T1'])], ['T1']);
  const runner: Runner = async (req) => {
    if (req.role === 'librarian' && librarianThrows-- > 0) throw new Error('librarian crashed');
    return inner(req);
  };
  const run = await runGoal({ store, runner: inner, goal: 'g' });
  await approveTask(store, run.id, 'T1', 'bob');
  const before = JSON.stringify(store.loadRun(run.id));

  // Pre-flight: the probe reaches a blocked host, so workers must not be dispatched.
  const open: ProbeExec = () => ({ status: 0, stdout: 'ORCHESTRA_PROBE_OPEN\n', stderr: '' });
  await assert.rejects(() => resumeRun({ store, runner, runId: run.id, sandbox: { backend: 'srt' }, preflightExec: open }), /pre-flight failed/);
  assert.equal(JSON.stringify(store.loadRun(run.id)), before);

  // A throw inside the tail (the librarian): the run fails but keeps its marker.
  const failed = await resumeRun({ store, runner, runId: run.id });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /librarian crashed/);
  assert.deepEqual(store.loadRun(run.id)!.deferred, ['tasks', 'learning']);
  assert.equal(failed.tasks[1].status, 'merged');

  const done = await resumeRun({ store, runner, runId: run.id });
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.deferred, undefined);
}));

test('a resume killed mid-run is recoverable: in-flight tasks restart, a landed merge counts as merged', () => asRequester(async () => {
  const store = repo();
  const calls: string[] = [];
  const runner = planned([t('T1'), t('T2', ['T1'])], ['T1'], calls);
  const run = await runGoal({ store, runner, goal: 'g' });
  await approveTask(store, run.id, 'T1', 'bob');
  // What a Ctrl-C during the worker leaves behind: status running, T2 running, marker still set.
  const crashed = store.loadRun(run.id)!;
  crashed.status = 'running';
  crashed.tasks[1].status = 'running';
  store.saveRun(crashed);
  const done = await resumeRun({ store, runner, runId: run.id });
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.tasks[1].status, 'merged');

  // Killed after T2's merge landed but before the run file said so.
  const landed = store.loadRun(run.id)!;
  landed.status = 'running';
  landed.tasks[1].status = 'merging';
  landed.deferred = ['learning'];
  store.saveRun(landed);
  calls.length = 0;
  const again = await resumeRun({ store, runner, runId: run.id });
  assert.equal(again.status, 'done', again.error);
  assert.equal(again.tasks[1].status, 'merged');
  assert.ok(!calls.includes('worker:T2'), 'a landed merge is not redone');
}));

test('a second concurrent resume of the same run is refused; a stale lock from a dead resume is taken over', () => asRequester(async () => {
  const store = repo();
  const runner = planned([t('T1'), t('T2', ['T1'])], ['T1']);
  const run = await runGoal({ store, runner, goal: 'g' });
  await approveTask(store, run.id, 'T1', 'bob');
  const lock = store.path('runs', run.id, 'resume.lock');

  // A lock left by a process that no longer exists.
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  writeFileSync(lock, String(dead));
  const [a, b] = await Promise.allSettled([resumeRun({ store, runner, runId: run.id }), resumeRun({ store, runner, runId: run.id })]);
  assert.equal(a.status, 'fulfilled');
  assert.equal((a as PromiseFulfilledResult<any>).value.status, 'done');
  assert.equal(b.status, 'rejected');
  assert.match(String((b as PromiseRejectedResult).reason), /already being resumed/);
  assert.equal(existsSync(lock), false, 'the lock is released');
}));
