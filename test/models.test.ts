import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadHarness, PACKAGE_ROOT, ROLES } from '../src/harness.ts';
import { CAPABILITIES, DEFAULT_PROVIDER, isTier, resolveModel, resolveModels } from '../src/models.ts';
import type { Store } from '../src/store.ts';
import type { Role } from '../src/types.ts';

test('each tier resolves for anthropic', () => {
  assert.equal(DEFAULT_PROVIDER, 'anthropic');
  assert.equal(resolveModel('strong'), 'opus');
  assert.equal(resolveModel('balanced', 'anthropic'), 'sonnet');
  assert.equal(resolveModel('fast'), 'haiku');
  assert.ok(isTier('fast') && !isTier('opus'));
});

test('literal names pass through, even for unknown providers', () => {
  assert.equal(resolveModel('opus'), 'opus');
  assert.equal(resolveModel('claude-sonnet-x'), 'claude-sonnet-x');
  assert.equal(resolveModel('gpt-x', 'nope'), 'gpt-x');
});

test('a tier with an unknown provider throws naming provider and known ones', () => {
  assert.throws(() => resolveModel('fast', 'nope'), /nope.*anthropic/s);
  assert.throws(() => resolveModel('fast', 'toString'), /toString/);
});

test('custom table is honored', () => {
  const table = { acme: { ...CAPABILITIES.anthropic, fast: { model: 'acme-mini', contextTokens: 1, cacheMinTokens: 1 } } };
  assert.equal(resolveModel('fast', 'acme', table), 'acme-mini');
  assert.throws(() => resolveModel('fast', 'anthropic', table), /acme/);
});

const roleMap = (v: string) => Object.fromEntries(ROLES.map((r) => [r, v])) as Record<Role, string>;

test('resolveModels maps every role', () => {
  const out = resolveModels({ ...roleMap('fast'), judge: 'strong', worker: 'my-model' });
  assert.equal(out.planner, 'haiku');
  assert.equal(out.judge, 'opus');
  assert.equal(out.worker, 'my-model');
});

function loadWith(config: unknown): ReturnType<typeof loadHarness> {
  const root = mkdtempSync(join(tmpdir(), 'orch-models-'));
  try {
    const dir = join(root, 'harness', 'v1');
    mkdirSync(dir, { recursive: true });
    for (const r of ROLES) writeFileSync(join(dir, `${r}.md`), r);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const store = { path: (...p: string[]) => join(root, ...p), readText: () => 'v1' } as unknown as Store;
    return loadHarness(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('loadHarness leaves seed models unchanged and resolves tiers', async () => {
  const { readFileSync } = await import('node:fs');
  const seed = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'harness', 'v1', 'config.json'), 'utf8'));
  assert.deepEqual(loadWith(seed).config.models, seed.models);
  const tiered = loadWith({ ...seed, models: { ...seed.models, planner: 'strong', worker: 'balanced', librarian: 'fast' } });
  assert.equal(tiered.config.models.planner, 'opus');
  assert.equal(tiered.config.models.worker, 'sonnet');
  assert.equal(tiered.config.models.librarian, 'haiku');
  assert.equal(tiered.config.models.judge, 'opus');
});
