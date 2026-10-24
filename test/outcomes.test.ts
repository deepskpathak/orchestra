import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGE_ROOT } from '../src/harness.ts';
import { collectOutcomes, computeOutcomes, renderOutcomes } from '../src/outcomes.ts';
import { infoSnapshot } from '../src/dashboard-data.ts';
import { tempRepo } from './helpers.ts';
import type { Run } from '../src/types.ts';

function mkRun(id: string, o: Partial<Run> & { merged?: number; total?: number } = {}): Run {
  const total = o.total ?? 2;
  const merged = o.merged ?? total;
  return {
    id, goal: 'goal', harness: 'v1', kind: 'goal', status: 'done', startedAt: 0, endedAt: 60_000, costUsd: 1, active: [],
    tasks: Array.from({ length: total }, (_, i) => ({ id: `T${i + 1}`, status: i < merged ? 'merged' : 'failed' })),
    ...o,
  } as unknown as Run;
}

test('acceptance, edits, revert, breakage, cost and wall-clock per accepted merge', () => {
  const runs = [mkRun('a', { costUsd: 2 }), mkRun('b', { costUsd: 4, endedAt: 120_000 }), mkRun('c'), mkRun('d', { merged: 0, status: 'failed' })];
  const m = computeOutcomes(runs, {
    a: { landed: true, editLines: 0, reverted: false, fixups: 0 },
    b: { landed: true, editLines: 10, reverted: true, fixups: 0 },
    c: { landed: false },
    d: { landed: false },
  });
  assert.equal(m.candidates, 3); // d merged nothing
  assert.equal(m.accepted, 2);
  assert.ok(Math.abs(m.acceptanceRate! - 2 / 3) < 1e-9);
  assert.equal(m.unedited, 1);
  assert.equal(m.meanEditLines, 5);
  assert.equal(m.revertRate, 0.5);
  assert.equal(m.breakageRate, 0.5);
  assert.equal(m.costPerAcceptedUsd, (2 + 4 + 1 + 1) / 2);
  assert.equal(m.wallClockPerAcceptedMs, (60_000 + 120_000 + 60_000 + 60_000) / 2);
});

test('a follow-up fix counts as breakage but not as a revert', () => {
  const m = computeOutcomes([mkRun('a')], { a: { landed: true, editLines: 0, fixups: 1 } });
  assert.equal(m.revertRate, 0);
  assert.equal(m.breakageRate, 1);
});

test('zero accepted merges: no divide by zero, rendered as n/a', () => {
  const m = computeOutcomes([mkRun('a')], {});
  assert.equal(m.accepted, 0);
  for (const v of [m.meanEditLines, m.revertRate, m.breakageRate, m.costPerAcceptedUsd, m.wallClockPerAcceptedMs]) assert.equal(v, null);
  const text = renderOutcomes(m);
  assert.match(text, /merge acceptance\s+0%/);
  assert.match(text, /edits before landing\s+n\/a/);
  assert.match(text, /revert rate\s+n\/a/);
  assert.match(text, /per accepted merge\s+n\/a, n\/a/);
  assert.doesNotMatch(text, /NaN|Infinity/);
  assert.equal(computeOutcomes([], {}).acceptanceRate, null);
  assert.match(renderOutcomes(computeOutcomes([], {})), /merge acceptance\s+n\/a/);
});

test('success by task count, goal length and bench human minutes', () => {
  const runs = [
    mkRun('a', { total: 1, goal: 'x'.repeat(10) }),
    mkRun('b', { total: 3, status: 'failed', goal: 'x'.repeat(100) }),
    mkRun('c', { total: 3, goal: 'x'.repeat(300) }),
    mkRun('d', { total: 9, goal: 'x'.repeat(300), status: 'failed' }),
    mkRun('e', { kind: 'eval', total: 1 }),
  ];
  const m = computeOutcomes(runs, {}, [
    { humanMinutes: 10, pass: true }, { humanMinutes: 30, pass: false }, { humanMinutes: 30, pass: true }, { humanMinutes: 600, pass: false },
  ]);
  const by = (bs: { label: string; runs: number; succeeded: number }[], l: string) => bs.find((b) => b.label === l);
  assert.deepEqual([by(m.byTaskCount, '1 task')!.succeeded, by(m.byTaskCount, '1 task')!.runs], [1, 1]);
  assert.deepEqual([by(m.byTaskCount, '2-3 tasks')!.succeeded, by(m.byTaskCount, '2-3 tasks')!.runs], [1, 2]);
  assert.deepEqual([by(m.byTaskCount, '7+ tasks')!.succeeded, by(m.byTaskCount, '7+ tasks')!.runs], [0, 1]);
  assert.equal(by(m.byTaskCount, '4-6 tasks'), undefined); // empty buckets are omitted
  assert.equal(by(m.byGoalLength, 'goal 200+ chars')!.rate, 0.5);
  assert.equal(by(m.byHumanMinutes, '16-60 min')!.rate, 0.5);
  assert.equal(by(m.byHumanMinutes, '>4 h')!.rate, 0);
});

// Build a run whose integration branch carries one commit, optionally landed and edited on main.
function seedLanded(opts: { edit?: boolean; revert?: boolean; land?: boolean }) {
  const store = tempRepo();
  const root = store.root;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'orchestra/r1/integration');
  writeFileSync(join(root, 'f.txt'), 'one\ntwo\n');
  g('add', '-A');
  g('commit', '-qm', 'feat: f');
  const tipCommit = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  if (opts.land) {
    g('merge', '--no-ff', '-q', '-m', 'Merge r1', 'orchestra/r1/integration');
    if (opts.edit) {
      writeFileSync(join(root, 'f.txt'), 'one\ntwo\nthree\n');
      g('commit', '-qam', 'tweak');
    }
    if (opts.revert) g('revert', '--no-edit', tipCommit);
  }
  store.saveRun(mkRun('r1', { integrationBranch: 'orchestra/r1/integration', baseRef: base }));
  return store;
}

test('collector: unlanded, clean landing, edited landing, reverted landing', () => {
  assert.equal(collectOutcomes(seedLanded({})).accepted, 0);
  const clean = collectOutcomes(seedLanded({ land: true }));
  assert.equal(clean.accepted, 1);
  assert.equal(clean.meanEditLines, 0);
  assert.equal(clean.revertRate, 0);
  assert.equal(collectOutcomes(seedLanded({ land: true, edit: true })).meanEditLines, 1);
  const rev = collectOutcomes(seedLanded({ land: true, revert: true }));
  assert.equal(rev.revertRate, 1);
  assert.equal(rev.breakageRate, 1);
});

test('collector tolerates a pruned integration branch', () => {
  const store = tempRepo();
  store.saveRun(mkRun('r1', { integrationBranch: 'orchestra/r1/integration', baseRef: 'HEAD' }));
  const m = collectOutcomes(store);
  assert.equal(m.accepted, 0);
  assert.equal(m.acceptanceRate, 0);
});

test('dashboard info includes outcomes and keeps existing fields', () => {
  const info = infoSnapshot(seedLanded({ land: true }));
  assert.equal(info.outcomes.accepted, 1);
  assert.ok(info.harness && info.repo);
});

test('orchestra stats prints the outcome section', () => {
  const store = seedLanded({ land: true });
  const r = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'bin', 'orchestra.ts'), 'stats', '--plain'], { cwd: store.root, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Outcome metrics/);
  assert.match(r.stdout, /merge acceptance\s+100% \(1 of 1/);
  assert.match(r.stdout, /success by task count/);
});
