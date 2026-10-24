import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderFrame, type FrameData } from '../src/tui/screens.ts';
import { visible } from '../src/tui/render.ts';
import { initialState, type TuiState } from '../src/tui/state.ts';
import type { Run, Task } from '../src/types.ts';

const task = (id: string, status: Task['status'], deps: string[] = [], extra: Partial<Task> = {}): Task => ({
  id, title: `Title ${id}`, description: `Describe ${id}`, acceptance: ['it works', 'it is fast'], deps, status,
  attempts: 1, notes: [], costUsd: 0.1, ...extra,
});

const run: Run = {
  id: 'run-new', goal: 'Build the thing', harness: 'v2', kind: 'goal', status: 'running', startedAt: 0, costUsd: 1.5, active: [
    { key: 'k', role: 'worker', task: 'T2', model: 'm', startedAt: 0, lastAction: 'editing foo.ts', tools: 3, costUsd: 0 },
  ],
  tasks: [
    task('T1', 'merged'),
    task('T2', 'running', ['T1']),
    task('T3', 'pending', ['T2']),
    task('T4', 'judging', ['T1'], { verdict: { pass: true, score: 0.82, summary: 'Looks good', issues: [], testsPassed: true, criteria: [
      { criterion: 'it works', pass: true, score: 1 }, { criterion: 'it is fast', pass: false, score: 0.2, note: 'slow' }] }, notes: ['fix speed'] }),
    task('T5', 'merging'),
    task('T6', 'failed'),
  ],
};

const data: FrameData = {
  run,
  runs: [
    { id: 'run-new', goal: 'Build the thing', status: 'running', endedAt: null, costUsd: 1.5, satisfaction: null, tasks: 6, merged: 1 },
    { id: 'run-old', goal: 'Older goal', status: 'done', endedAt: 5, costUsd: 0.5, satisfaction: 0.9, tasks: 2, merged: 2 },
  ],
  events: [
    { t: 1000, run: 'run-new', kind: 'task.start', msg: 'started T2' },
    { t: 2000, run: 'run-new', kind: 'agent.action', msg: 'TOOLCALL-bash' },
  ],
  detail: { diff: 'diff --git a/x b/x\n+added line\n-removed line', logs: [{ name: 'T4-judge.log', tail: 'log line one\nlog line two' }] },
  maxAttempts: 3,
  passThreshold: 0.7,
};

const opts = (width: number, rows: number) => ({ width, rows, now: 60_000, color: false, frame: 0 });
const board = (over: Partial<TuiState> = {}): TuiState => ({ ...initialState('run-new'), ...over });

function assertBounds(out: string, width: number, rows: number) {
  const lines = out.split('\n');
  assert.equal(lines.length, rows);
  for (const l of lines) assert.ok(visible(l) <= width, `too wide (${visible(l)}): ${l}`);
}

test('frames never exceed width or rows across screens and sizes', () => {
  const states = [board(), board({ view: 'flow' }), board({ drawerOpen: true }), board({ drawerOpen: true, drawerTab: 'diff', drawerScroll: Infinity }),
    board({ drawerOpen: true, drawerTab: 'logs' }), board({ helpOpen: true }), initialState(null), board({ taskIndex: 3, showToolCalls: true })];
  for (const [w, r] of [[120, 40], [60, 20], [80, 24], [40, 10]] as const)
    for (const s of states) assertBounds(renderFrame(s, data, opts(w, r)), w, r);
  assertBounds(renderFrame(board(), { ...data, run: { ...run, goal: 'x'.repeat(300) } }, { ...opts(120, 40), color: true }), 120, 40);
});

test('board view shows six columns, header, and marks the selected task', () => {
  const out = renderFrame(board({ taskIndex: 1 }), data, opts(120, 40));
  for (const t of ['Queued', 'Building', 'Verifying', 'Merging', 'Done', 'Failed']) assert.match(out, new RegExp(t));
  for (const t of ['run-new', 'harness v2', 'PLAN', 'LEARN', '1/6', 'LIVE']) assert.ok(out.includes(t), t);
  assert.match(out, /▶.*T2/);
  assert.match(out, /try 1\/3/);
  assert.match(out, /editing foo\.ts/);
});

test('narrow terminals collapse columns into a grouped list', () => {
  const out = renderFrame(board({ taskIndex: 2 }), data, opts(60, 20));
  assert.match(out, /Queued \(1\)/);
  assert.match(out, /▶ .*T3/);
});

test('flow view groups by depth and shows deps', () => {
  const out = renderFrame(board({ view: 'flow' }), data, opts(120, 40));
  assert.match(out, /Depth 0/);
  assert.match(out, /Depth 2/);
  assert.match(out, /⇠ T2/);
});

test('event feed hides agent.action unless showToolCalls', () => {
  assert.ok(!renderFrame(board(), data, opts(120, 40)).includes('TOOLCALL-bash'));
  assert.ok(renderFrame(board({ showToolCalls: true }), data, opts(120, 40)).includes('TOOLCALL-bash'));
});

test('drawer detail shows criteria with pass/fail, verdict vs threshold, notes, relations', () => {
  const out = renderFrame(board({ taskIndex: 3, drawerOpen: true }), data, opts(120, 40));
  for (const t of ['it works', 'it is fast', '✓ pass', '✗ fail', '0.82', '0.70', 'fix speed', 'upstream:   T1', 'Describe T4']) assert.ok(out.includes(t), t);
});

test('drawer diff and logs tabs show content and scroll by offset', () => {
  const diff = renderFrame(board({ drawerOpen: true, drawerTab: 'diff' }), data, opts(120, 40));
  assert.match(diff, /\+added line/);
  assert.match(diff, /-removed line/);
  const colored = renderFrame(board({ drawerOpen: true, drawerTab: 'diff' }), data, { ...opts(120, 40), color: true });
  assert.ok(colored.includes('\x1b[32m+added line'));
  assert.ok(colored.includes('\x1b[31m-removed line'));
  assert.match(renderFrame(board({ drawerOpen: true, drawerTab: 'logs' }), data, opts(120, 40)), /log line two/);
  const long = { ...data, detail: { diff: Array.from({ length: 100 }, (_, i) => `+line ${i}`).join('\n'), logs: [] } };
  const s = board({ drawerOpen: true, drawerTab: 'diff' });
  assert.ok(!renderFrame(s, long, opts(120, 20)).includes('+line 50'));
  assert.ok(renderFrame({ ...s, drawerScroll: 50 }, long, opts(120, 20)).includes('+line 50'));
  assert.ok(renderFrame({ ...s, drawerScroll: Infinity }, long, opts(120, 20)).includes('+line 99'));
});

test('help overlay lists the keymap', () => {
  const out = renderFrame(board({ helpOpen: true }), data, opts(120, 40));
  assert.match(out, /\bq\b/);
  assert.match(out, /\?/);
  assert.match(out, /Quit/);
});

test('run list shows newest first with selection and ENDED indicator', () => {
  const out = renderFrame({ ...initialState(null), runIndex: 1 }, data, opts(120, 20));
  assert.ok(out.indexOf('run-new') < out.indexOf('run-old'));
  assert.match(out, /▶ run-old/);
  assert.match(out, /2\/2/);
  assert.match(out, /0\.90/);
  const ended = renderFrame(board(), { ...data, run: { ...run, endedAt: 9, status: 'done' } }, opts(120, 40));
  assert.match(ended, /ENDED/);
});

test('empty planning run says the planner is drafting', () => {
  const empty: Run = { ...run, status: 'planning', tasks: [], active: [] };
  const out = renderFrame(board(), { ...data, run: empty }, opts(120, 40));
  assert.match(out, /planner is drafting/);
  assertBounds(out, 120, 40);
});

test('needs_human tasks render within bounds and are not unknown', () => {
  const r: Run = { ...run, tasks: [...run.tasks, task('T7', 'needs_human', [], { humanReason: 'spec vs test' })] };
  for (const [w, rows] of [[120, 40], [100, 16], [50, 3], [60, 20]] as const)
    assertBounds(renderFrame(board(), { ...data, run: r }, opts(w, rows)), w, rows);
  assert.match(renderFrame(board(), { ...data, run: r }, opts(160, 40)), /Needs human/);
});
