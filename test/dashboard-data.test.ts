import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { gitHumanCommits, infoSnapshot, taskDetail } from '../src/dashboard-data.ts';
import { tempRepo } from './helpers.ts';
import type { Run } from '../src/types.ts';

function seed() {
  const store = tempRepo();
  const run = {
    id: 'r1', goal: 'g', harness: 'v1', kind: 'goal', status: 'running', startedAt: 1, costUsd: 0, active: [],
    tasks: [{ id: 'T1', title: 't', status: 'running' }],
  } as unknown as Run;
  store.saveRun(run);
  return store;
}

test('taskDetail returns null for unknown run or task', () => {
  const store = seed();
  assert.equal(taskDetail(store, 'r1', 'T9'), null);
  assert.equal(taskDetail(store, 'nope', 'T1'), null);
});

test('taskDetail returns logs for a task with a log file', () => {
  const store = seed();
  const dir = store.path('runs', 'r1', 'logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/T1-1.log`, 'hello log');
  writeFileSync(`${dir}/T2-1.log`, 'other');
  const d = taskDetail(store, 'r1', 'T1');
  assert.ok(d);
  assert.equal(d.logs.length, 1);
  assert.equal(d.logs[0].name, 'T1-1.log');
  assert.equal(d.logs[0].tail, 'hello log');
  assert.equal(d.diff, null);
});

test('infoSnapshot reports current run and repo', () => {
  const store = seed();
  const info = infoSnapshot(store);
  assert.equal(info.repo, store.root);
  assert.equal(info.current, store.currentRunId());
});

test('gitHumanCommits: worker commits under the developer identity on a merged task branch are not human edits', () => {
  const root = tempRepo().root;
  const sh = (args: string[], at: number, who = 'Dev') =>
    execFileSync('git', ['-c', `user.name=${who}`, '-c', `user.email=${who}@l`, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: who, GIT_COMMITTER_NAME: who, GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at} +0000` },
    });
  const T = 1_800_000_000;
  sh(['checkout', '-q', '-b', 'integration'], T);
  // The worker commits as the developer on its task branch; Orchestra merges it.
  sh(['checkout', '-q', '-b', 'task'], T + 10);
  writeFileSync(`${root}/w.txt`, 'w\n');
  sh(['add', '-A'], T + 10);
  sh(['commit', '-qm', 'worker change'], T + 20);
  sh(['checkout', '-q', 'integration'], T + 30);
  sh(['merge', '--no-ff', '-qm', 'Merge T1', 'task'], T + 40, 'Orchestra');
  // A real human edit directly on the integration branch.
  writeFileSync(`${root}/h.txt`, 'h\n');
  sh(['add', '-A'], T + 50);
  sh(['commit', '-qm', 'human fix'], T + 60);
  // The worker commit (T+20) is excluded; only the direct commit (T+60) counts.
  assert.equal(gitHumanCommits(root, 'integration', (T + 5) * 1000, (T + 100) * 1000), 1);
  // The window is exact, with no slack before its start; its start is inclusive.
  assert.equal(gitHumanCommits(root, 'integration', (T + 61) * 1000, (T + 100) * 1000), 0);
  assert.equal(gitHumanCommits(root, 'integration', (T + 60) * 1000, (T + 100) * 1000), 1);
});
