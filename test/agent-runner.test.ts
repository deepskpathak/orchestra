import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { makeClaudeRunner, type AgentRequest, type SpawnFn } from '../src/agent.ts';

const req: AgentRequest = { role: 'worker', prompt: 'p', system: 's', cwd: process.cwd(), model: 'm', budgetUsd: 1 };

// Fake spawn: writes the given stream-json lines, then closes after delayMs with the given exit.
const spawnEmitting = (lines: object[], delayMs = 0, exit: { code: number | null; signal: string | null } = { code: 0, signal: null }): SpawnFn =>
  ((_c: string, _a: string[], _o: any) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n');
      setTimeout(() => child.emit('close', exit.code, exit.signal), delayMs);
    });
    return child;
  }) as unknown as SpawnFn;

// Fake spawn for a session that emits its lines, then hangs until killed (as a resumed session does
// while it waits on a background task). kill() closes it with that signal, like a real child.
const spawnHanging = (lines: object[]): SpawnFn =>
  ((_c: string, _a: string[], _o: any) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (sig: string) => (setImmediate(() => child.emit('close', null, sig)), true);
    setImmediate(() => {
      for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n');
    });
    return child;
  }) as unknown as SpawnFn;

const usage = (i: number, o: number, r: number, w: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
});

test('single result: fields pass through unchanged', async () => {
  const res = await makeClaudeRunner(
    spawnEmitting([
      { type: 'result', subtype: 'success', result: 'done', num_turns: 4, duration_ms: 999999, total_cost_usd: 0.1, usage: usage(1, 2, 3, 4), structured_output: { a: 1 } },
    ]),
  )(req);
  assert.equal(res.ok, true);
  assert.equal(res.text, 'done');
  assert.equal(res.turns, 4);
  assert.equal(res.costUsd, 0.1);
  assert.deepEqual(res.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
  assert.deepEqual(res.structured, { a: 1 });
});

test('two results: turns and usage sum, cost and text from the last, duration is wall clock', async () => {
  const res = await makeClaudeRunner(
    spawnEmitting(
      [
        { type: 'result', subtype: 'success', result: 'first', num_turns: 11, duration_ms: 176517, total_cost_usd: 0.2656, usage: usage(10, 20, 30, 40) },
        { type: 'result', subtype: 'success', result: 'second', num_turns: 2, duration_ms: 6439, total_cost_usd: 0.2992, usage: usage(1, 2, 3, 4), structured_output: { b: 2 } },
      ],
      30,
    ),
  )(req);
  assert.equal(res.turns, 13);
  assert.equal(res.costUsd, 0.2992);
  assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
  assert.equal(res.text, 'second');
  assert.equal(res.ok, true);
  assert.deepEqual(res.structured, { b: 2 });
  assert.ok(res.durationMs >= 30 && res.durationMs < 6439, `durationMs ${res.durationMs}`);
});

test('two results: ok and error come from the last result', async () => {
  const res = await makeClaudeRunner(
    spawnEmitting([
      { type: 'result', subtype: 'success', result: 'fine', num_turns: 1, total_cost_usd: 0.1 },
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'cap', num_turns: 2, total_cost_usd: 0.2 },
    ]),
  )(req);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'cap');
  assert.equal(res.turns, 3);
  assert.equal(res.usage, undefined);
});

test('usage on only one of two results is kept', async () => {
  const res = await makeClaudeRunner(
    spawnEmitting([
      { type: 'result', subtype: 'success', result: 'a', num_turns: 1, usage: usage(5, 5, 5, 5) },
      { type: 'result', subtype: 'success', result: 'b', num_turns: 1 },
    ]),
  )(req);
  assert.deepEqual(res.usage, { inputTokens: 5, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 5 });
});

test('cost: a last result without total_cost_usd keeps the earlier cumulative cost', async () => {
  const res = await makeClaudeRunner(
    spawnEmitting([
      { type: 'result', subtype: 'success', result: 'a', num_turns: 1, total_cost_usd: 0.2656 },
      { type: 'result', subtype: 'success', result: 'b', num_turns: 1 },
    ]),
  )(req);
  assert.equal(res.costUsd, 0.2656);
});

test('structured: an earlier segment structured_output survives a last segment without one', async () => {
  const flag = { decision: 'flag_for_human', reason: 'needs a human' };
  const res = await makeClaudeRunner(
    spawnEmitting([
      { type: 'result', subtype: 'success', result: 'a', num_turns: 3, structured_output: flag },
      { type: 'result', subtype: 'success', result: 'b', num_turns: 1 },
    ]),
  )(req);
  assert.deepEqual(res.structured, flag);
});

const ok1 = { type: 'result', subtype: 'success', result: 'first', num_turns: 11, total_cost_usd: 0.2656, usage: usage(10, 20, 30, 40) };

test('exit: timeout SIGTERM after a success result reports failure and keeps the accounting', async () => {
  const res = await makeClaudeRunner(spawnHanging([ok1]))({ ...req, timeoutMs: 20 });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /killed by SIGTERM after the 20ms timeout/);
  assert.equal(res.text, 'first');
  assert.equal(res.costUsd, 0.2656);
  assert.equal(res.turns, 11);
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
});

test('exit: a signal not from our timeout is named without the timeout note', async () => {
  const res = await makeClaudeRunner(spawnEmitting([ok1], 0, { code: null, signal: 'SIGKILL' }))(req);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'claude killed by SIGKILL after a result');
});

test('exit: non-zero exit after a success result reports failure naming the code', async () => {
  const res = await makeClaudeRunner(spawnEmitting([ok1], 0, { code: 1, signal: null }))(req);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'claude exited 1 after a result');
  assert.equal(res.costUsd, 0.2656);
});

test('exit: an error result keeps its own error on a non-zero exit', async () => {
  const res = await makeClaudeRunner(
    spawnEmitting([{ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'cap', num_turns: 2 }], 0, { code: 1, signal: null }),
  )(req);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'cap');
});

test('exit: a single success result with exit 0 stays ok', async () => {
  const res = await makeClaudeRunner(spawnEmitting([ok1], 0, { code: 0, signal: null }))(req);
  assert.equal(res.ok, true);
  assert.equal(res.error, undefined);
});
