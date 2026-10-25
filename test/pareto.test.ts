import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readArchive, updateArchive, writeArchive } from '../src/harness.ts';
import type { ArchiveEntry } from '../src/harness.ts';
import { archiveHistory, archivePatches, paretoFront, selectParent } from '../src/pareto.ts';
import { tempRepo } from './helpers.ts';

function entry(version: string, parent: string | null, score: number | null, detail?: Record<string, number>, extra: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return { version, parent, createdAt: Number(version.slice(1)), rationale: '', evalScore: score, validationDetail: detail, status: 'candidate', ...extra };
}

test('front keeps a variant best on one case and drops a fully dominated one', () => {
  const a = entry('v1', null, 0.5, { c1: 1, c2: 0, c3: 0.5 });
  const b = entry('v2', 'v1', 0.5, { c1: 0, c2: 1, c3: 0.5 });
  const c = entry('v3', 'v1', 0.2, { c1: 0, c2: 0, c3: 0.2 });
  const names = paretoFront([a, b, c]).map((e) => e.version);
  assert.deepEqual(names, ['v1', 'v2']);
});

test('ties count and entries without detail are dropped', () => {
  const a = entry('v1', null, 0.5, { c1: 1 });
  const b = entry('v2', 'v1', 0.5, { c1: 1 });
  const legacy = entry('v3', 'v1', 0.9);
  assert.deepEqual(paretoFront([a, b, legacy]).map((e) => e.version), ['v1', 'v2']);
});

test('falls back to evalDetail for legacy entries', () => {
  const legacy: ArchiveEntry = { version: 'v1', parent: null, createdAt: 1, rationale: '', evalScore: 1, evalDetail: { c1: 1 }, status: 'promoted' };
  assert.equal(paretoFront([legacy]).length, 1);
});

test('selectParent prefers more Pareto wins', () => {
  const a = entry('v1', null, 0.5, { c1: 1, c2: 1, c3: 0 });
  const b = entry('v2', null, 0.5, { c1: 0, c2: 0, c3: 1 });
  assert.equal(selectParent([a, b])!.version, 'v1');
});

test('with equal wins selectParent prefers the variant whose descendants did better', () => {
  const a = entry('v1', null, 0.5, { c1: 1, c2: 0 });
  const b = entry('v2', null, 0.5, { c1: 0, c2: 1 });
  const kidOfB = entry('v3', 'v2', 0.7, { c1: 0, c2: 0 });
  const kidOfA = entry('v4', 'v1', 0.3, { c1: 0, c2: 0 });
  assert.equal(selectParent([a, b, kidOfA, kidOfB])!.version, 'v2');
});

test('selectParent is deterministic for a fixed rng and null when empty', () => {
  const a = entry('v1', null, 0.5, { c1: 1, c2: 0 });
  const b = entry('v2', null, 0.5, { c1: 0, c2: 1 });
  const pick = () => selectParent([a, b], () => 0.9)!.version;
  assert.equal(pick(), pick());
  assert.equal(pick(), 'v2');
  assert.equal(selectParent([a, b], () => 0)!.version, 'v1');
  assert.equal(selectParent([]), null);
});

test('archiveHistory excludes holdout scores and honours the limit', () => {
  const a = entry('v1', null, 0.5, { c1: 1 }, { holdoutScore: 0.123456 });
  const b = entry('v2', 'v1', 0.6, { c1: 1 }, { holdoutScore: 0.987654, stepping: true });
  const c = entry('v3', 'v2', 0.7, { c1: 1 });
  const out = archiveHistory([a, b, c], 2);
  assert.ok(!out.includes('0.123') && !out.includes('0.987'));
  assert.ok(!out.includes('holdout'));
  assert.ok(!out.startsWith('v1 '));
  assert.match(out, /v2 parent=v1 status=candidate stepping score=0.600/);
});

test('archive persists across two simulated cycles with per-case detail; old entries load', () => {
  const store = tempRepo();
  const old = readArchive(store);
  assert.ok(old.length >= 1);
  updateArchive(store, 'v1', { validationDetail: { c1: 0.5, c2: 0.5 } });
  writeArchive(store, [...readArchive(store), entry('v2', 'v1', 0.6, { c1: 0.8, c2: 0 })]);
  for (const [v, p] of archivePatches(readArchive(store))) updateArchive(store, v, p);
  // cycle two reads back what cycle one wrote
  const next = readArchive(store);
  assert.deepEqual(next.find((e) => e.version === 'v2')!.validationDetail, { c1: 0.8, c2: 0 });
  assert.equal(next.find((e) => e.version === 'v2')!.stepping, true);
  writeArchive(store, [...next, entry('v3', 'v2', 0.9, { c1: 1, c2: 1 })]);
  const front = paretoFront(readArchive(store)).map((e) => e.version);
  assert.deepEqual(front, ['v3']);
});
