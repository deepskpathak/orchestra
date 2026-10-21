import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinPrompt, judgePrompt, plannerPrompt, workerPrompt } from '../src/conductor.ts';
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
  const p = plannerPrompt({ goal: 'GOALTEXT', files: ['a.ts'], testCommand: undefined, learnings: 'LEARNTEXT' });
  assert.ok(p.prefix.indexOf('LEARNTEXT') < p.prefix.indexOf('a.ts'));
  assert.ok(p.prefix.indexOf('TEST COMMAND') < p.prefix.indexOf('GOALTEXT'));
  assert.equal(p.body, 'Produce the task graph and hidden scenarios.');
});
