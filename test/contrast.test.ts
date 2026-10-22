import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alternateWorkerSection, comparePrompt, COMPARE_SCHEMA, contrastApplies, resolveContrast } from '../src/contrast.ts';
import { DEFAULT_PROJECT_CONFIG } from '../src/store.ts';
import * as g from '../src/git.ts';
import type { Task } from '../src/types.ts';

const cfg = (c: object = {}, testCommand: string | null = null) => ({ testCommand, contrastive: { ...DEFAULT_PROJECT_CONFIG.contrastive, enabled: true, ...c } });
const task = (o: Partial<Task> = {}): Task => ({ id: 'T1', title: 't', description: 'd', acceptance: ['x', 'y'], deps: [], status: 'running', attempts: 2, notes: ['fix x'], costUsd: 0, ...o });

test('defaults are disabled', () => {
  assert.deepEqual(DEFAULT_PROJECT_CONFIG.contrastive, { enabled: false, onlyWithoutTests: true, maxPairs: 1 });
});

test('contrastApplies', () => {
  assert.equal(contrastApplies(cfg(), task()), true);
  assert.equal(contrastApplies(cfg(), task({ attempts: 1 })), false);
  assert.equal(contrastApplies(cfg({ enabled: false }), task()), false);
  assert.equal(contrastApplies(cfg({}, 'npm test'), task()), false);
  assert.equal(contrastApplies(cfg({ onlyWithoutTests: false }, 'npm test'), task()), true);
  const used = task({ contrast: { attempt: 2, a: { branch: 'a' }, b: { branch: 'b' }, picked: 'A', reasons: '' } });
  assert.equal(contrastApplies(cfg(), used), false);
  assert.equal(contrastApplies(cfg({ maxPairs: 2 }), used), true);
});

test('prompt pieces', () => {
  assert.match(alternateWorkerSection(['fix x']), /different approach[\s\S]*fix x/);
  const p = comparePrompt({ task: task(), scenarios: [{ id: 's1', given: 'g', when: 'w', then: 't' }], workerTextA: 'wa', workerTextB: 'wb', diffA: 'DA', diffB: 'DB' });
  assert.match(p.prefix, /s1/);
  assert.match(p.prefix, /preferred/);
  assert.match(p.body, /DA[\s\S]*DB/);
  assert.deepEqual(COMPARE_SCHEMA.required, ['a', 'b', 'preferred', 'reasons']);
});

const att = (score: number, pass = true) => ({ pass, score, summary: 's', issues: [] });

test('resolveContrast: preferred passes', () => {
  const r = resolveContrast({ a: att(0.9), b: att(0.8), preferred: 'B', reasons: 'cleaner' }, null, null, 0.7);
  assert.equal(r.picked, 'B');
  assert.equal(r.reasons, 'cleaner');
});

test('resolveContrast: preferred fails, other passes', () => {
  const r = resolveContrast({ a: att(0.5), b: att(0.8), preferred: 'A', reasons: 'nicer' }, null, null, 0.7);
  assert.equal(r.picked, 'B');
  assert.match(r.reasons, /did not pass/);
});

test('resolveContrast: neither passes', () => {
  const r = resolveContrast({ a: att(0.5), b: att(0.6, false), preferred: 'A', reasons: 'x' }, null, null, 0.7);
  assert.equal(r.picked, null);
});

test('resolveContrast: malformed output', () => {
  for (const raw of [null, undefined, 'junk', 42, {}, { a: 5, b: [], preferred: 'A' }, { a: { score: 'hi' }, b: null }]) {
    assert.equal(resolveContrast(raw, null, null, 0.7).picked, null);
  }
});

test('deleteBranch tolerates a missing branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orc-contrast-'));
  g.git(dir, 'init', '-q');
  g.git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'i');
  g.git(dir, 'branch', 'tmp-b');
  g.deleteBranch(dir, 'tmp-b');
  assert.equal(g.git(dir, 'branch', '--list', 'tmp-b'), '');
  assert.doesNotThrow(() => g.deleteBranch(dir, 'nope'));
});
