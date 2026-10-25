import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeProvider, resolveProvider } from '../src/provider.ts';
import type { AgentRequest, AgentResult } from '../src/agent.ts';

test('claude adapter delegates the identical request to the runner', async () => {
  const seen: AgentRequest[] = [];
  const result = { ok: true } as unknown as AgentResult;
  const p = makeClaudeProvider(async (r) => { seen.push(r); return result; });
  const req = { prompt: 'hi' } as unknown as AgentRequest;
  assert.equal(await p.run(req), result);
  assert.equal(seen[0], req);
  assert.equal(p.name, 'claude');
});

test('resolveProvider', () => {
  assert.equal(resolveProvider().name, 'claude');
  assert.equal(resolveProvider('claude').name, 'claude');
  assert.throws(() => resolveProvider('gpt'), /unknown model provider "gpt"/);
});
