import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateCriteria, buildVerdict, judgePrompt } from '../src/conductor.ts';

test('aggregateCriteria returns undefined for missing, empty or non-array input', () => {
  assert.equal(aggregateCriteria(undefined), undefined);
  assert.equal(aggregateCriteria([]), undefined);
  assert.equal(aggregateCriteria('x'), undefined);
  assert.equal(aggregateCriteria([null, { criterion: 1 }]), undefined);
});

test('aggregateCriteria: all pass gives mean score and pass', () => {
  const a = aggregateCriteria([
    { criterion: 'a', pass: true, score: 1 },
    { criterion: 'b', pass: true, score: 0.5 },
  ])!;
  assert.equal(a.score, 0.75);
  assert.equal(a.pass, true);
  assert.deepEqual(a.failing, []);
});

test('aggregateCriteria: one failing criterion fails the aggregate', () => {
  const a = aggregateCriteria([
    { criterion: 'a', pass: true, score: 0.9 },
    { criterion: 'b', pass: false, score: 0.2, note: 'nope' },
  ])!;
  assert.equal(a.pass, false);
  assert.deepEqual(a.failing, [{ criterion: 'b', pass: false, score: 0.2, note: 'nope' }]);
});

test('aggregateCriteria: non-finite scores are 0, out-of-range clamped, malformed skipped', () => {
  const a = aggregateCriteria([
    { criterion: 'a', pass: true, score: Number.NaN },
    { criterion: 'b', pass: true, score: 5 },
    { criterion: 'c', pass: true, score: -3 },
    { criterion: 'd' },
    42,
  ])!;
  assert.deepEqual(a.list.map((c) => c.score), [0, 1, 0]);
  assert.equal(a.score, 1 / 3);
});

test('buildVerdict: failing criterion gives pass=false and a Criterion failed issue before free-form issues', () => {
  const v = buildVerdict(
    { pass: true, score: 0.95, summary: 's', issues: ['free'], criteria: [{ criterion: 'handles empty input', pass: false, score: 0.4, note: 'crashes' }, { criterion: 'ok', pass: true, score: 1 }] },
    true,
    0.75,
  );
  assert.equal(v.pass, false);
  assert.deepEqual(v.issues, ['Criterion failed: handles empty input: crashes', 'free']);
  assert.equal(v.score, 0.7);
  assert.equal(v.criteria?.length, 2);
});

test('buildVerdict: test failure issue comes before criterion issues', () => {
  const v = buildVerdict({ pass: true, score: 1, summary: '', issues: ['x'], criteria: [{ criterion: 'c', pass: false, score: 0 }] }, false, 0.75, 'TESTS FAIL');
  assert.deepEqual(v.issues, ['TESTS FAIL', 'Criterion failed: c', 'x']);
});

test('buildVerdict: no criteria behaves as before', () => {
  const v = buildVerdict({ pass: true, score: 0.8, summary: 'ok', issues: ['i'] }, null, 0.75);
  assert.deepEqual(v, { pass: true, score: 0.8, summary: 'ok', issues: ['i'], testsPassed: null });
  assert.equal('criteria' in v, false);
  const low = buildVerdict({ pass: true, score: 0.5, summary: '', issues: [] }, true, 0.75);
  assert.equal(low.pass, false);
  const bad = buildVerdict({ pass: true, score: 0.9, summary: '', issues: [] }, false, 0.75, 'T');
  assert.deepEqual([bad.pass, bad.issues], [false, ['T']]);
});

test('judge prompt asks for criteria in the prefix, task text stays in the body', () => {
  const p = judgePrompt({ task: { id: 'T9', title: 't', description: 'd', acceptance: ['a1'], deps: [] } as never, scenarios: [], workerText: '', tests: null, diff: '' });
  assert.match(p.prefix, /return criteria/);
  assert.doesNotMatch(p.prefix, /T9/);
});
