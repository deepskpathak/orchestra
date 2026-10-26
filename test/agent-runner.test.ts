import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { makeClaudeRunner, type AgentRequest, type SpawnFn } from '../src/agent.ts';

const req: AgentRequest = { role: 'worker', prompt: 'p', system: 's', cwd: process.cwd(), model: 'm', budgetUsd: 1 };

// Fake spawn: writes the given stream-json lines, then closes after delayMs.
const spawnEmitting = (lines: object[], delayMs = 0): SpawnFn =>
  ((_c: string, _a: string[], _o: any) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n');
      setTimeout(() => child.emit('close', 0), delayMs);
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
