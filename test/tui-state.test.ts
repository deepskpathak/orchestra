import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState, KEYMAP, parseKeys, reduce, type TuiCtx, type TuiState } from '../src/tui/state.ts';

const ctx: TuiCtx = { runIds: ['r2', 'r1'], taskIds: ['T1', 'T2', 'T3'], currentRunId: 'r2' };
const press = (s: TuiState, keys: string[], c: TuiCtx = ctx) => keys.reduce((st, k) => reduce(st, k, c).state, s);

test('arrow and hjkl navigation clamps at both ends', () => {
  const s0 = initialState('r2');
  assert.equal(press(s0, ['up']).taskIndex, 0);
  assert.equal(press(s0, ['h', 'k']).taskIndex, 0);
  assert.equal(press(s0, ['down', 'j', 'l', 'right', 'down']).taskIndex, 2);
  assert.equal(press(s0, ['down', 'down', 'up', 'left']).taskIndex, 0);
});

test('Enter opens drawer, Tab cycles tabs, Esc closes drawer then returns to run list', () => {
  let s = press(initialState('r2'), ['enter']);
  assert.equal(s.drawerOpen, true);
  assert.equal(s.drawerTab, 'detail');
  s = press(s, ['tab']); assert.equal(s.drawerTab, 'diff');
  s = press(s, ['tab']); assert.equal(s.drawerTab, 'logs');
  s = press(s, ['tab']); assert.equal(s.drawerTab, 'detail');
  s = press(s, ['esc']);
  assert.equal(s.drawerOpen, false);
  assert.equal(s.screen, 'board');
  s = press(s, ['esc']);
  assert.equal(s.screen, 'runs');
});

test('Enter on the run list opens the highlighted run', () => {
  let s = initialState();
  assert.equal(s.screen, 'runs');
  s = press(s, ['down', 'enter']);
  assert.equal(s.screen, 'board');
  assert.equal(s.runId, 'r1');
  assert.equal(s.follow, false);
  s = press(s, ['f']);
  assert.equal(s.runId, 'r2');
  assert.equal(s.follow, true);
});

test('v, t, ? and r toggles', () => {
  let s = initialState('r2');
  s = press(s, ['v']); assert.equal(s.view, 'flow');
  s = press(s, ['v']); assert.equal(s.view, 'board');
  s = press(s, ['t']); assert.equal(s.showToolCalls, true);
  s = press(s, ['?']); assert.equal(s.helpOpen, true);
  s = press(s, ['esc']); assert.equal(s.helpOpen, false);
  s = press(s, ['?', '?']); assert.equal(s.helpOpen, false);
  s = press(s, ['r']); assert.equal(s.screen, 'runs');
});

test('q and ctrl-c quit', () => {
  assert.equal(reduce(initialState('r2'), 'q', ctx).quit, true);
  assert.equal(reduce(initialState('r2'), 'ctrl-c', ctx).quit, true);
  assert.equal(reduce(initialState('r2'), 'j', ctx).quit, false);
});

test('selection clamps with zero or shrinking tasks', () => {
  const empty: TuiCtx = { ...ctx, taskIds: [] };
  const s = press(initialState('r2'), ['down', 'down', 'enter'], empty);
  assert.equal(s.taskIndex, 0);
  assert.equal(s.drawerOpen, false);
  const deep = press(initialState('r2'), ['down', 'down']);
  assert.equal(deep.taskIndex, 2);
  assert.equal(reduce(deep, 'x', { ...ctx, taskIds: ['T1'] }).state.taskIndex, 0);
});

test('drawer scroll via PgDn/PgUp/g/G', () => {
  let s = press(initialState('r2'), ['enter', 'pgdn']);
  assert.equal(s.drawerScroll, 10);
  s = press(s, ['pgup', 'pgup']); assert.equal(s.drawerScroll, 0);
  s = press(s, ['G']); assert.equal(s.drawerScroll, Infinity);
  s = press(s, ['g']); assert.equal(s.drawerScroll, 0);
});

test('parseKeys decodes escapes and multi-key chunks', () => {
  assert.deepEqual(parseKeys('\x1b[A'), ['up']);
  assert.deepEqual(parseKeys('\x1b[B'), ['down']);
  assert.deepEqual(parseKeys('\x1b[5~'), ['pgup']);
  assert.deepEqual(parseKeys('\x1b[6~'), ['pgdn']);
  assert.deepEqual(parseKeys('\r'), ['enter']);
  assert.deepEqual(parseKeys('\x1b'), ['esc']);
  assert.deepEqual(parseKeys('\x03'), ['ctrl-c']);
  assert.deepEqual(parseKeys('jjk'), ['j', 'j', 'k']);
  assert.deepEqual(parseKeys('\x1b[Aj\x1b[1;2B\x1b[3~q'), ['up', 'j', 'down', 'q']);
});

test('KEYMAP documents every bound key', () => {
  assert.ok(KEYMAP.length >= 10);
  assert.ok(KEYMAP.every((k) => k.keys && k.label && k.action));
});
