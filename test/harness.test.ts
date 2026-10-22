import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { EVOLVABLE_FILES, createVariant, listVersions, loadHarness, readArchive } from '../src/harness.ts';
import { tempRepo } from './helpers.ts';

const NEW_FILES = ['tools.md', 'style.md', 'checklist.md'];

test('EVOLVABLE_FILES includes the optional guidance files', () => {
  for (const f of ['planner.md', 'worker.md', 'judge.md', 'librarian.md', 'config.json', ...NEW_FILES]) assert.ok(EVOLVABLE_FILES.includes(f), f);
});

test('loadHarness tolerates a version dir without the optional files', () => {
  const store = tempRepo();
  for (const f of NEW_FILES) rmSync(store.path('harness', 'v1', f), { force: true });
  assert.deepEqual(loadHarness(store, 'v1').guidance, { tools: '', style: '', checklist: '' });
});

test('loadHarness reads the optional files when present', () => {
  const store = tempRepo();
  writeFileSync(store.path('harness', 'v1', 'tools.md'), 'use rg');
  writeFileSync(store.path('harness', 'v1', 'style.md'), 'two spaces');
  writeFileSync(store.path('harness', 'v1', 'checklist.md'), '- check tests');
  assert.deepEqual(loadHarness(store, 'v1').guidance, { tools: 'use rg', style: 'two spaces', checklist: '- check tests' });
});

test('createVariant accepts checklist appends and rewording by addition', () => {
  const store = tempRepo();
  writeFileSync(store.path('harness', 'v1', 'checklist.md'), '- check tests\n\n- check docs\n');
  const v = createVariant(store, 'v1', { 'checklist.md': '- check tests\n  - check docs  \n- check types\n' }, 'add');
  assert.equal(v, 'v2');
  assert.match(loadHarness(store, 'v2').guidance.checklist, /check types/);
});

test('createVariant rejects removing a parent checklist line and writes nothing', () => {
  const store = tempRepo();
  writeFileSync(store.path('harness', 'v1', 'checklist.md'), '- check tests\n- check docs\n');
  const archiveBefore = readArchive(store).length;
  assert.throws(() => createVariant(store, 'v1', { 'checklist.md': '- check tests\n' }, 'drop'), /may not remove checklist lines/);
  assert.deepEqual(listVersions(store), ['v1']);
  assert.equal(readArchive(store).length, archiveBefore);
});

test('createVariant accepts checklist.md when the parent had none', () => {
  const store = tempRepo();
  rmSync(store.path('harness', 'v1', 'checklist.md'), { force: true });
  const v = createVariant(store, 'v1', { 'checklist.md': '- new check\n' }, 'first');
  assert.equal(loadHarness(store, v).guidance.checklist, '- new check\n');
});

test('createVariant still rejects non-evolvable files', () => {
  const store = tempRepo();
  assert.throws(() => createVariant(store, 'v1', { 'evolver.md': 'x' }, 'no'), /may not edit evolver\.md/);
});
