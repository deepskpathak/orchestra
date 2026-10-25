import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProgress, joinPrompt, judgePrompt, plannerPrompt, progressRel, workerPrompt } from '../src/conductor.ts';
import type { Task } from '../src/types.ts';

const mk = (id: string, over: Partial<Task> = {}): Task =>
  ({ id, title: `title ${id}`, description: `desc ${id}`, acceptance: [`ok ${id}`], deps: [], status: 'pending', attempts: 1, notes: [], ...over }) as Task;

const common = { goal: 'GOALTEXT', learnings: 'LEARNTEXT', testCommand: 'npm test' };

test('worker prompt prefix is byte-identical across tasks and attempts', () => {
  const a = workerPrompt({ ...common, task: mk('T1'), others: ['- T2 two [pending]'] });
  const b = workerPrompt({ ...common, task: mk('T2'), others: ['- T1 one [running]'] });
  const c = workerPrompt({ ...common, task: mk('T1', { attempts: 2, notes: ['fix it'] }), others: ['- T2 two [merged]'] });
  assert.equal(a.prefix, b.prefix);
  assert.equal(a.prefix, c.prefix);
  assert.ok(a.prefix.length > 0);
  assert.notEqual(a.body, c.body);
});

test('worker prompt orders stable content before task content, repair notes last', () => {
  const p = joinPrompt(workerPrompt({ ...common, task: mk('T1', { notes: ['fix it'] }), others: ['- T2 x [pending]'] }));
  const at = (s: string) => p.indexOf(s);
  assert.ok(at('LEARNTEXT') < at('npm test') && at('npm test') < at('GOALTEXT'));
  assert.ok(at('GOALTEXT') < at('YOUR TASK T1'));
  assert.ok(at('OTHER TASKS') < at('REPAIR NOTES'));
  assert.ok(p.trimEnd().endsWith('- fix it'));
});

test('judge prompt prefix is byte-identical across tasks and diffs, diff last', () => {
  const scenarios = [{ id: 'S1', given: 'g', when: 'w', then: 't' }];
  const base = { scenarios, workerText: 'did', testCommand: 'npm test', tests: { ok: true, tail: 'tail' } };
  const a = judgePrompt({ ...base, task: mk('T1'), diff: 'diff one' });
  const b = judgePrompt({ ...base, task: mk('T2'), diff: 'diff two', tests: null });
  assert.equal(a.prefix, b.prefix);
  assert.ok(a.prefix.includes('S1: GIVEN g WHEN w THEN t'));
  const p = joinPrompt(a);
  assert.ok(p.indexOf('S1: GIVEN') < p.indexOf('TASK T1'));
  assert.ok(p.trimEnd().endsWith('diff one'));
});

test('planner prompt puts learnings, files, test command and goal before the instruction', () => {
  const p = plannerPrompt({ goal: 'GOALTEXT', files: ['a.ts'], testCommand: undefined, learnings: 'LEARNTEXT', domains: ['cli', 'docs'] });
  assert.ok(p.prefix.indexOf('LEARNTEXT') < p.prefix.indexOf('a.ts'));
  assert.ok(p.prefix.indexOf('TEST COMMAND') < p.prefix.indexOf('GOALTEXT'));
  assert.match(p.body, /^Produce the task graph and hidden scenarios\./);
});

test('planner prompt lists existing domains and the at-most-one-new-domain rule', () => {
  const p = plannerPrompt({ goal: 'G', files: [], learnings: 'L', domains: ['cli', 'web-ui'] });
  assert.match(p.prefix, /EXISTING DOMAINS:\ncli\nweb-ui/);
  assert.match(p.body, /at most one new kebab-case slug/);
  assert.match(plannerPrompt({ goal: 'G', files: [], learnings: 'L', domains: [] }).prefix, /EXISTING DOMAINS:\n\(none yet\)/);
});

test('planner fast path keeps the prefix and asks for exactly one task', () => {
  const base = { goal: 'G', files: ['a.ts'], learnings: 'L', domains: [] as string[] };
  const slow = plannerPrompt(base);
  const fast = plannerPrompt({ ...base, fastPath: true });
  assert.equal(fast.prefix, slow.prefix);
  assert.match(fast.body, /exactly one task/);
  assert.doesNotMatch(slow.body, /exactly one task/);
});

test('planner asks for a scenario check only when scenarioChecks (agentic judge) is on', () => {
  const base = { goal: 'G', files: ['a.ts'], learnings: 'L', domains: [] as string[] };
  const off = plannerPrompt(base);
  const on = plannerPrompt({ ...base, scenarioChecks: true });
  assert.doesNotMatch(off.body, /check/i);
  assert.match(on.body, /"check": one shell command/);
  assert.equal(on.prefix, off.prefix);
  assert.deepEqual(plannerPrompt({ ...base, scenarioChecks: false }), off);
  assert.match(plannerPrompt({ ...base, scenarioChecks: true, fastPath: true }).body, /"check"[\s\S]*exactly one task/);
});

test('progress file path replaces long notes in the repair body, prefix unchanged', () => {
  const long = `first line of issue\n${'detail line\n'.repeat(50)}END-OF-NOTE`;
  const task = mk('T1', { attempts: 2, notes: [long] });
  const plain = workerPrompt({ ...common, task, others: [] });
  const withFile = workerPrompt({ ...common, task, others: [], progressFile: '/tmp/x/progress/T1.json' });
  assert.equal(withFile.prefix, plain.prefix);
  assert.ok(withFile.body.includes('/tmp/x/progress/T1.json'));
  assert.ok(withFile.body.includes('first line of issue'));
  assert.ok(!withFile.body.includes('END-OF-NOTE'));
  assert.ok(plain.body.includes('END-OF-NOTE'), 'without progressFile notes stay inline');
  assert.ok(!withFile.prefix.includes('/tmp/x'));
});

test('buildProgress derives failingCriteria from verdict.criteria and defaults to []', () => {
  const task = mk('T1', { attempts: 2 });
  const verdict = { pass: false, score: 0.4, summary: 's', issues: ['a'], testsPassed: true, criteria: [{ criterion: 'c1', pass: true, score: 1, note: '' }, { criterion: 'c2', pass: false, score: 0, note: 'bad' }] };
  const p = buildProgress({ task, verdict, issues: ['a'], diffSummary: 'x' }) as Record<string, unknown>;
  assert.equal(p.taskId, 'T1');
  assert.equal(p.attempt, 2);
  assert.equal(p.score, 0.4);
  assert.deepEqual((p.failingCriteria as { criterion: string }[]).map((c) => c.criterion), ['c2']);
  const q = buildProgress({ task, verdict: { ...verdict, criteria: undefined }, issues: [], diffSummary: '' }) as Record<string, unknown>;
  assert.deepEqual(q.failingCriteria, []);
  assert.deepEqual((buildProgress({ task, issues: [], diffSummary: '' }) as Record<string, unknown>).failingCriteria, []);
  assert.equal(progressRel('r1', 'T1'), 'runs/r1/progress/T1.json');
});

const jbase = { scenarios: [], workerText: '', tests: null, diff: 'DIFFTEXT' };

test('worker guidance sections go in the prefix only, and only when non-blank', () => {
  const p = workerPrompt({ ...common, task: mk('T1'), others: [], tools: 'USE GREP', style: 'TWO SPACES' });
  assert.ok(p.prefix.includes('TOOL GUIDANCE:\nUSE GREP'));
  assert.ok(p.prefix.includes('STYLE:\nTWO SPACES'));
  assert.ok(!p.body.includes('TOOL GUIDANCE') && !p.body.includes('STYLE:'));
  assert.ok(!p.prefix.includes('REVIEW CHECKLIST'));
  const plain = workerPrompt({ ...common, task: mk('T1'), others: [] });
  for (const blank of [{}, { tools: '', style: '' }, { tools: '  \n', style: '\n' }]) {
    const q = workerPrompt({ ...common, task: mk('T1'), others: [], ...blank });
    assert.deepEqual(q, plain);
  }
  assert.ok(!plain.prefix.includes('TOOL GUIDANCE') && !plain.prefix.includes('STYLE:'));
});

test('judge guidance sections go in the prefix only, and only when non-blank', () => {
  const p = judgePrompt({ ...jbase, task: mk('T1'), tools: 'USE GREP', checklist: 'CHECK ERRORS' });
  assert.ok(p.prefix.includes('TOOL GUIDANCE:\nUSE GREP'));
  assert.ok(p.prefix.includes('REVIEW CHECKLIST:\nCHECK ERRORS'));
  assert.ok(!p.body.includes('TOOL GUIDANCE') && !p.body.includes('REVIEW CHECKLIST'));
  assert.ok(!p.prefix.includes('STYLE:'));
  const plain = judgePrompt({ ...jbase, task: mk('T1') });
  assert.deepEqual(judgePrompt({ ...jbase, task: mk('T1'), tools: ' ', checklist: '' }), plain);
  assert.ok(!plain.prefix.includes('TOOL GUIDANCE') && !plain.prefix.includes('REVIEW CHECKLIST'));
});

test('prefix with guidance is identical across tasks', () => {
  const g = { tools: 'T', style: 'S', checklist: 'C' };
  const w1 = workerPrompt({ ...common, ...g, task: mk('T1'), others: ['- T2 x'] });
  const w2 = workerPrompt({ ...common, ...g, task: mk('T2', { attempts: 2, notes: ['n'] }), others: [] });
  assert.equal(w1.prefix, w2.prefix);
  const j1 = judgePrompt({ ...jbase, ...g, task: mk('T1') });
  const j2 = judgePrompt({ ...jbase, ...g, task: mk('T2'), diff: 'other' });
  assert.equal(j1.prefix, j2.prefix);
});
