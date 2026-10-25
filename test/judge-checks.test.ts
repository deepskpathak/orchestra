import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenarioChecks, executedChecksSection } from '../src/judge-checks.ts';
import { aggregateCriteria, buildVerdict, judgePrompt } from '../src/conductor.ts';
import * as g from '../src/git.ts';
import type { Task } from '../src/types.ts';

const sc = [
  { id: 'S1', given: 'g', when: 'w', then: 't', check: 'echo one' },
  { id: 'S2', given: 'g', when: 'w', then: 't' },
  { id: 'S3', given: 'g', when: 'w', then: 't', check: 'boom' },
];

test('runScenarioChecks records ok/exit/tail, skips scenarios without check, passes timeout', () => {
  const seen: [string, number][] = [];
  const res = runScenarioChecks({
    cwd: '/x', scenarios: sc, testCommand: 'npm test', timeoutMs: 77,
    exec: (_c, cmd, t) => { seen.push([cmd, t]); return cmd === 'boom' ? { ok: false, exit: 2, tail: 'bad' } : { ok: true, tail: 'fine' }; },
  });
  assert.deepEqual(res.map((r) => [r.id, r.ok, r.exit, r.tail]), [['S1', true, 0, 'fine'], ['S3', false, 2, 'bad'], ['tests', true, 0, 'fine']]);
  assert.ok(seen.every(([, t]) => t === 77));
});

test('runScenarioChecks turns an exec throw into a failed result', () => {
  const res = runScenarioChecks({ cwd: '/x', scenarios: sc, timeoutMs: 1, exec: () => { throw new Error('nope'); } });
  assert.equal(res.length, 2);
  assert.equal(res[0].ok, false);
  assert.match(res[0].tail, /nope/);
});

const task: Task = { id: 'T1', title: 't', description: 'd', acceptance: ['a'], deps: [], status: 'pending', attempts: 0, notes: [] } as unknown as Task;
const base = { task, scenarios: sc, workerText: 'w', tests: null, diff: 'D' };

test('judgePrompt agentic adds EXECUTED CHECKS and evidence instruction; off equals previous output', () => {
  const off = judgePrompt(base);
  assert.deepEqual(off, judgePrompt({ ...base, agentic: undefined }));
  // Literal copy of the pre-W4.2 output.
  assert.deepEqual(off, {
    prefix: 'HIDDEN SCENARIOS for the whole goal (judge only the parts this task is responsible for):\n' +
      '- S1: GIVEN g WHEN w THEN t\n- S2: GIVEN g WHEN w THEN t\n- S3: GIVEN g WHEN w THEN t\n\n' +
      'Also return criteria: one entry per acceptance criterion, in order, each with pass, score and a short note.',
    body: 'TASK T1: t\nd\n\nACCEPTANCE CRITERIA:\n- a\n\nWORKER SUMMARY (unverified):\nw\n\nTEST RESULT: no test command configured\n\nDIFF vs base:\nD',
  });
  const on = judgePrompt({ ...base, agentic: [{ id: 'S1', command: 'echo one', ok: true, exit: 0, tail: 'one' }] });
  assert.match(on.body, /EXECUTED CHECKS[\s\S]*S1[\s\S]*PASSED/);
  assert.match(on.prefix, /evidence/);
  assert.match(executedChecksSection([]), /none configured/);
});

test('aggregateCriteria keeps evidence; no-evidence note only in agentic mode', () => {
  const crit = [{ criterion: 'a', pass: true, score: 1, evidence: 'ran x: ok' }, { criterion: 'b', pass: true, score: 1 }];
  const a = aggregateCriteria(crit)!;
  assert.equal(a.list[0].evidence, 'ran x: ok');
  assert.equal(a.unevidenced.length, 0);
  assert.equal(aggregateCriteria(crit, true)!.unevidenced.length, 1);
  const off = buildVerdict({ pass: true, score: 1, summary: '', issues: [], criteria: crit }, null, 0.5);
  assert.deepEqual(off.issues, []);
  const on = buildVerdict({ pass: true, score: 1, summary: '', issues: [], criteria: crit }, null, 0.5, undefined, true);
  assert.equal(on.pass, true);
  assert.deepEqual(on.issues, ['Criterion passed without executed evidence: b']);
});

test('runScenarioChecks reuses the supplied tests result instead of re-running the test command', () => {
  const ran: string[] = [];
  const res = runScenarioChecks({
    cwd: '/x', scenarios: sc, testCommand: 'npm test', testsResult: { ok: false, exit: 3, tail: 'red' }, timeoutMs: 1,
    exec: (_c, cmd) => { ran.push(cmd); return { ok: true, tail: '' }; },
  });
  assert.deepEqual(ran, ['echo one', 'boom']);
  assert.deepEqual(res.at(-1), { id: 'tests', command: 'npm test', ok: false, exit: 3, tail: 'red' });
});

test('git.runTests reports the real exit code', () => {
  assert.equal(g.runTests(process.cwd(), 'exit 7').exit, 7);
  assert.equal(g.runTests(process.cwd(), 'true').exit, 0);
});
