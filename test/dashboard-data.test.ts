import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { infoSnapshot, taskDetail } from '../src/dashboard-data.ts';
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
