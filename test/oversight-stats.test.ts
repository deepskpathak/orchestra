import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { oversightSummary, renderOversight } from '../src/dashboard-data.ts';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { tempRepo } from './helpers.ts';
import type { Run, Task } from '../src/types.ts';

const task = (id: string, extra: Partial<Task> = {}) => ({ id, title: id, description: '', acceptance: [], deps: [], status: 'merged', attempts: 1, notes: [], costUsd: 0, ...extra }) as Task;
const run = (id: string, tasks: Task[], extra: Partial<Run> = {}) => ({ id, goal: 'g', harness: 'v1', kind: 'goal', status: 'done', startedAt: 1, costUsd: 0, active: [], integrationBranch: `orchestra/${id}/integration`, tasks, ...extra }) as Run;

test('oversight summary: one approval gives review minutes, edits and an interruption; a run with none is zeros', () => {
  const store = tempRepo();
  const t0 = Date.UTC(2026, 9, 25, 10, 0, 0);
  store.saveRun(run('r1', [task('T1', { approval: { requestedAt: t0, by: 'bob', decidedAt: t0 + 12 * 60_000 }, mergeWaitMs: 2000 }), task('T2', { mergeWaitMs: 4000 })], { conflictRate: 0.25, cacheReadShare: 0.6 }));
  store.saveRun(run('r2', [task('T1')]));
  const calls: unknown[][] = [];
  const s = oversightSummary(store, (root, branch, from, to) => {
    calls.push([branch, from, to]);
    return 2;
  });
  assert.deepEqual(calls, [['orchestra/r1/integration', t0, t0 + 12 * 60_000]]);
  const r1 = s.runs.find((r) => r.runId === 'r1')!;
  assert.equal(r1.interruptions, 1);
  assert.equal(r1.reviewMinutes, 12);
  assert.equal(r1.edits, 2);
  assert.equal(r1.conflictRate, 0.25);
  assert.equal(r1.meanMergeWaitMs, 3000);
  assert.equal(r1.cacheReadShare, 0.6);
  const r2 = s.runs.find((r) => r.runId === 'r2')!;
  assert.deepEqual([r2.interruptions, r2.reviewMinutes, r2.edits, r2.conflictRate, r2.meanMergeWaitMs, r2.cacheReadShare], [0, 0, 0, null, null, null]);
  assert.equal(s.total.interruptions, 1);
  assert.equal(s.total.reviewMinutes, 12);
  assert.equal(s.total.edits, 2);
});

test('oversight summary: needs_human and pending approvals are interruptions without review minutes; eval runs are left out', () => {
  const store = tempRepo();
  store.saveRun(run('r1', [task('T1', { status: 'needs_human' }), task('T2', { status: 'awaiting_approval', approval: { requestedAt: 1000 } })]));
  store.saveRun(run('e1', [task('T1', { status: 'needs_human' })], { kind: 'eval' }));
  const s = oversightSummary(store, () => 9);
  assert.equal(s.total.runs, 1);
  assert.equal(s.total.interruptions, 2);
  assert.equal(s.total.reviewMinutes, 0);
  assert.equal(s.total.edits, 0, 'no edits are counted before a decision');
});

test('renderOversight prints n/a without data and the numbers with it', () => {
  const store = tempRepo();
  const empty = renderOversight(oversightSummary(store));
  assert.match(empty, /Conflict rate:\s+n\/a/);
  assert.match(empty, /Cache-read share:\s+n\/a/);
  assert.match(empty, /Interruptions:\s+0/);
  store.saveRun(run('r1', [task('T1', { mergeWaitMs: 1500 })], { conflictRate: 0.5, cacheReadShare: 0.25 }));
  const out = renderOversight(oversightSummary(store, () => 0));
  assert.match(out, /Mean merge wait:\s+1\.5s/);
  assert.match(out, /Cache-read share:\s+n\/a/); // pooled from the ledger, which is empty here
});

test('git human commits ignore Orchestra authors and commits outside the window', () => {
  const store = tempRepo();
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: store.root, encoding: 'utf8' });
  const at = (iso: string, name: string, msg: string) => execFileSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: store.root, env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
  at('2030-01-01T10:05:00Z', 'Carol', 'human edit');
  at('2030-01-01T10:06:00Z', 'Orchestra', 'orchestra work');
  at('2030-01-01T11:30:00Z', 'Dave', 'too late');
  const branch = sh('rev-parse', '--abbrev-ref', 'HEAD').trim();
  store.saveRun(run('r1', [task('T1', { approval: { requestedAt: Date.parse('2030-01-01T10:00:00Z'), by: 'bob', decidedAt: Date.parse('2030-01-01T11:00:00Z') } })], { integrationBranch: branch }));
  const s = oversightSummary(store);
  assert.equal(s.runs[0].edits, 1);
  assert.equal(s.runs[0].reviewMinutes, 60);
});

test('orchestra stats prints the oversight section and --json includes it', () => {
  const store = tempRepo();
  store.saveRun(run('r1', [task('T1')], { conflictRate: 0, cacheReadShare: 0.5 }));
  const cli = join(PACKAGE_ROOT, 'bin', 'orchestra.ts');
  const text = spawnSync(process.execPath, [cli, 'stats', '--plain'], { cwd: store.root, encoding: 'utf8', timeout: 60000 });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Oversight and throughput/);
  assert.match(text.stdout, /Interruptions:\s+0/);
  assert.match(text.stdout, /Conflict rate:\s+0\.0%/);
  const json = spawnSync(process.execPath, [cli, 'stats', '--json'], { cwd: store.root, encoding: 'utf8', timeout: 60000 });
  assert.equal(json.status, 0, json.stderr);
  const o = JSON.parse(json.stdout);
  assert.equal(o.oversight.total.runs, 1);
  assert.equal(o.oversight.runs[0].conflictRate, 0);
  assert.ok(Array.isArray(o.versions));
  assert.equal(typeof o.outcomes, 'object');
});
