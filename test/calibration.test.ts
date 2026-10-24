import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BenchRow } from '../src/bench.ts';
import { agreementBlock, calibrate, importGrades, judgePass, parseGrades, renderCalibration, rowId, stratifiedSample, writeSample, type CalRow } from '../src/calibration.ts';
import { evolve } from '../src/evolve.ts';
import { tempRepo } from './helpers.ts';

const row = (o: Partial<CalRow> = {}): CalRow => ({
  bench: 'b1', arm: 'a', goal: 'g', taskType: 't', humanMinutes: 5, repeat: 1, runId: 'r', harness: 'v1',
  checkPass: true, judgeSatisfaction: 0.9, taskVerdicts: {}, costUsd: 0, wallMs: 0, ...o,
});
const mk = (n: number, f: (i: number) => Partial<CalRow>): CalRow[] => Array.from({ length: n }, (_, i) => row({ goal: `g${i}`, ...f(i) }));

test('judgePass uses satisfaction vs threshold, falling back to all tasks passed', () => {
  assert.equal(judgePass(row({ judgeSatisfaction: 0.8 }), 0.8), true);
  assert.equal(judgePass(row({ judgeSatisfaction: 0.79 }), 0.8), false);
  assert.equal(judgePass(row({ judgeSatisfaction: null, taskVerdicts: { a: true, b: true } }), 0.8), true);
  assert.equal(judgePass(row({ judgeSatisfaction: null, taskVerdicts: { a: true, b: false } }), 0.8), false);
  assert.equal(judgePass(row({ judgeSatisfaction: null, taskVerdicts: {} }), 0.8), false);
});

test('agreement and kappa per harness version on synthetic rows', () => {
  const rows = [
    ...mk(10, (i) => ({ harness: 'v1', judgeSatisfaction: i < 5 ? 0.9 : 0.2, checkPass: i < 5 })), // perfect agreement
    ...mk(10, (i) => ({ harness: 'v2', judgeSatisfaction: 0.9, checkPass: i < 5 })), // judge always passes
  ];
  const [v1, v2] = calibrate(rows, 0.8);
  assert.equal(v1.harness, 'v1');
  assert.equal(v1.agreement, 1);
  assert.equal(v1.kappa, 1);
  assert.equal(v2.agreement, 0.5);
  assert.equal(v2.kappa, 0);
  assert.equal(v2.humanKappa, null);
});

test('human-judge kappa uses imported grades', () => {
  const rows = mk(4, (i) => ({ judgeSatisfaction: i < 2 ? 0.9 : 0.1 }));
  const grades = new Map(rows.map((r, i) => [rowId(r), i < 2] as [string, boolean]));
  const [c] = calibrate(rows, 0.8, grades);
  assert.equal(c.humanN, 4);
  assert.equal(c.humanKappa, 1);
});

test('sampler is deterministic per seed, oversamples near-threshold and disagreements, and caps at size', () => {
  const rows = [
    ...mk(40, () => ({ judgeSatisfaction: 0.95, checkPass: true })), // clear agreement
    ...mk(10, (i) => ({ goal: `n${i}`, judgeSatisfaction: 0.82, checkPass: true })), // near threshold
    ...mk(5, (i) => ({ goal: `d${i}`, judgeSatisfaction: 0.95, checkPass: false })), // disagreement
  ];
  const a = stratifiedSample(rows, 0.8, 20, 7);
  const b = stratifiedSample([...rows].reverse(), 0.8, 20, 7);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((x) => x.id), stratifiedSample(rows, 0.8, 20, 8).map((x) => x.id));
  assert.equal(a.length, 20);
  assert.equal(a.filter((x) => x.stratum === 'disagreement').length, 5);
  assert.ok(a.filter((x) => x.stratum === 'near-threshold').length >= 9);
  assert.equal(new Set(a.map((x) => x.id)).size, 20);
  assert.equal(stratifiedSample(rows, 0.8, 500, 1).length, rows.length);
  assert.equal(stratifiedSample(rows, 0.8, 0, 1).length, 0);
  assert.ok(stratifiedSample(rows, 0.8, 3, 1).every((x) => x.stratum === 'disagreement'));
});

test('contrastive split flag counts as a split vote', () => {
  const rows = [...mk(5, () => ({})), row({ goal: 'split', split: true })];
  const s = stratifiedSample(rows, 0.8, 1, 1);
  assert.equal(s[0].goal, 'split');
});

test('grade import parses, skips ungraded lines and merges into the store', () => {
  const m = parseGrades('{"id":"x","humanPass":true}\n\n{"id":"y","humanPass":null}\n{"id":"z","human":false}\n');
  assert.deepEqual([...m], [['x', true], ['z', false]]);
  assert.throws(() => parseGrades('nope'), /not valid JSON/);

  const store = tempRepo();
  mkdirSync(store.path('bench', 'b1'), { recursive: true });
  const rows: BenchRow[] = mk(4, (i) => ({ judgeSatisfaction: i < 2 ? 0.9 : 0.1, checkPass: i < 2 }));
  writeFileSync(store.path('bench', 'b1', 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { items, file } = writeSample(store, 3, 1);
  assert.equal(items.length, 3);
  const graded = join(store.root, 'graded.jsonl');
  writeFileSync(graded, items.map((i) => JSON.stringify({ id: i.id, humanPass: i.judgePass })).join('\n') + '\n');
  assert.deepEqual(importGrades(store, graded), { imported: 3, total: 3 });
  assert.ok(file.endsWith('calibration/sample.jsonl'));
  assert.match(renderCalibration(calibrate(rows, 0.8)), /v1\s+4\s+1\.00\s+1\.00/);
});

test('agreementBlock: off when unset, lenient on small samples, names the floor when below', () => {
  const cal = [{ harness: 'v1', n: 20, agreement: 0.6, kappa: 0.1, humanN: 0, humanKappa: null }];
  assert.equal(agreementBlock(cal, 'v1', null), null);
  assert.equal(agreementBlock(cal, 'v1', undefined), null);
  assert.equal(agreementBlock(cal, 'v1', 0.5), null);
  assert.match(agreementBlock(cal, 'v1', 0.8)!, /minJudgeAgreement 0.8/);
  assert.equal(agreementBlock([{ ...cal[0], n: 3 }], 'v1', 0.8), null);
  assert.equal(agreementBlock(cal, 'v9', 0.8), null);
});

test('evolve refuses to run, without calling the evolver, when agreement is below the floor', async () => {
  const store = tempRepo({ evolve: { ...tempRepo().config().evolve, minJudgeAgreement: 0.9 } });
  mkdirSync(store.path('bench', 'b1'), { recursive: true });
  const rows = mk(12, (i) => ({ harness: 'v1', judgeSatisfaction: 0.95, checkPass: i < 6 }));
  writeFileSync(store.path('bench', 'b1', 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  let calls = 0;
  const out = await evolve(store, async () => { calls++; throw new Error('should not run'); }, () => {});
  assert.equal(calls, 0);
  assert.equal(out.promoted, false);
  assert.match(out.reason, /minJudgeAgreement 0\.9/);
});

test('old config resolves minJudgeAgreement to null', () => {
  assert.equal(tempRepo().config().evolve.minJudgeAgreement, null);
});
