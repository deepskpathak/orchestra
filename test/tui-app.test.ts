import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { startTui, LEAVE_SCREEN } from '../src/tui/app.ts';
import { tempRepo } from './helpers.ts';
import type { Run } from '../src/types.ts';

function fakeTty() {
  const stdin = Object.assign(new EventEmitter(), { setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
  const out = Object.assign(new EventEmitter(), { columns: 100, rows: 30, buf: '', write(s: string) { this.buf += s; return true; } });
  return { stdin, out };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('startTui renders, opens the drawer, and restores the terminal on q', async () => {
  const store = tempRepo();
  const run: Run = {
    id: 'run-tui-1', goal: 'Goal X', harness: 'v1', kind: 'goal', status: 'running', startedAt: Date.now(), costUsd: 0, active: [],
    tasks: [{ id: 'T1', title: 'Alpha', description: 'Drawer description', acceptance: ['works'], deps: [], status: 'running', attempts: 1, notes: [], costUsd: 0 }],
  };
  store.saveRun(run);
  const { stdin, out } = fakeTty();
  const done = startTui({ store, stdin, stdout: out, pollMs: 150, color: false });
  await tick();
  assert.ok(out.buf.includes('run-tui-1'), 'run id in first frame');
  assert.ok(out.buf.includes('Alpha'), 'task title in first frame');
  const before = out.buf.length;
  stdin.emit('data', 'j');
  stdin.emit('data', '\r');
  await tick();
  assert.ok(out.buf.slice(before).includes('Drawer description'), 'drawer shown');
  stdin.emit('data', 'q');
  await done;
  assert.ok(out.buf.endsWith('\x1b[?25h\x1b[?1049l'));
  assert.ok(out.buf.endsWith(LEAVE_SCREEN));
  assert.equal(stdin.listenerCount('data'), 0);
});
