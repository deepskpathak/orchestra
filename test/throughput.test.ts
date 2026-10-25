import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footprintsOverlap, parallelSafeGroups, canStart, decisionLog, planBatches, bisectBatch, conflictRate } from '../src/throughput.ts';
import type { Task } from '../src/types.ts';

function task(id: string, files?: string[], extra: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, description: '', acceptance: [], deps: [], status: 'pending', attempts: 0, notes: [], costUsd: 0,
    footprint: files ? { files } : undefined, ...extra,
  } as Task;
}

test('overlap: shared file, disjoint files', () => {
  assert.equal(footprintsOverlap({ files: ['a.ts', 'b.ts'] }, { files: ['b.ts'] }), true);
  assert.equal(footprintsOverlap({ files: ['a.ts'] }, { files: ['c.ts'] }), false);
});

test('overlap: missing or empty footprint overlaps everything', () => {
  assert.equal(footprintsOverlap(undefined, { files: ['a.ts'] }), true);
  assert.equal(footprintsOverlap({ files: ['a.ts'] }, { files: [] }), true);
  assert.equal(footprintsOverlap(undefined, undefined), true);
});

test('overlap: directory prefix covers files but not sibling names', () => {
  assert.equal(footprintsOverlap({ files: ['src/'] }, { files: ['src/a.ts'] }), true);
  assert.equal(footprintsOverlap({ files: ['src'] }, { files: ['src/deep/a.ts'] }), true);
  assert.equal(footprintsOverlap({ files: ['src'] }, { files: ['src2/a.ts'] }), false);
});

test('parallelSafeGroups keeps groups pairwise disjoint', () => {
  const groups = parallelSafeGroups([task('1', ['a']), task('2', ['a']), task('3', ['b']), task('4')]);
  assert.deepEqual(groups, [['1', '3'], ['2'], ['4']]);
});

test('canStart refuses overlap with an in-flight task', () => {
  assert.equal(canStart(task('2', ['a.ts']), [task('1', ['a.ts'])]), false);
  assert.equal(canStart(task('2', ['b.ts']), [task('1', ['a.ts'])]), true);
  assert.equal(canStart(task('2', ['b.ts']), []), true);
  assert.equal(canStart(task('2'), [task('1', ['a.ts'])]), false);
});

test('decisionLog is short and mentions title, files and reason', () => {
  const dep = task('1', ['src/a.ts'], { verdict: { reasons: 'looks good' } as Task['verdict'] });
  const log = decisionLog([dep]);
  assert.match(log, /Task 1/);
  assert.match(log, /src\/a\.ts/);
  assert.match(log, /looks good/);
  const many = Array.from({ length: 50 }, (_, i) => task(String(i), ['f'], { verdict: { reasons: 'x'.repeat(100) } as Task['verdict'] }));
  assert.ok(decisionLog(many).length <= 600);
  assert.equal(decisionLog([]), '');
});

test('planBatches groups disjoint tasks and respects maxBatch', () => {
  const ts = [task('1', ['a']), task('2', ['b']), task('3', ['a']), task('4', ['c'])];
  assert.deepEqual(planBatches(ts, 10), [['1', '2', '4'], ['3']]);
  assert.deepEqual(planBatches(ts, 2), [['1', '2'], ['3', '4']]);
});

test('bisectBatch isolates the bad id', async () => {
  const r = await bisectBatch(['a', 'b', 'c', 'd'], async (ids) => !ids.includes('c'));
  assert.deepEqual(r.bad, ['c']);
  assert.deepEqual([...r.good].sort(), ['a', 'b', 'd']);
  assert.ok(r.testRuns > 1);
});

test('bisectBatch all green uses one run', async () => {
  const r = await bisectBatch(['a', 'b', 'c', 'd'], async () => true);
  assert.equal(r.testRuns, 1);
  assert.deepEqual(r.good, ['a', 'b', 'c', 'd']);
  assert.deepEqual(r.bad, []);
});

test('conflictRate', () => {
  assert.equal(conflictRate([]), 0);
  assert.equal(conflictRate([{ outcome: 'pass' }]), 0);
  assert.equal(conflictRate([{ outcome: 'merged' }, { outcome: 'merged' }, { outcome: 'merged' }, { outcome: 'conflict' }]), 0.25);
});
