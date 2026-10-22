import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DOMAIN_CAP, formatLearnings, listDomains, normalizeDomain, readAllLearnings, readLearnings, summarizeLearnings, writeLearnings, type Lesson,
} from '../src/learnings.ts';
import { tempRepo } from './helpers.ts';

function lesson(text: string, run = 'r20261022-0001-aaaa', role: Lesson['role'] = 'worker'): Lesson {
  return { role, lesson: text, evidence: [{ run }], hits: 0 };
}

test('normalizeDomain slugs, rejects invalid and reserved names', () => {
  assert.equal(normalizeDomain('Web UI'), 'web-ui');
  assert.equal(normalizeDomain('cli'), 'cli');
  assert.equal(normalizeDomain('_global'), undefined);
  assert.equal(normalizeDomain('../x'), undefined);
  assert.equal(normalizeDomain(''), undefined);
  assert.equal(normalizeDomain(5), undefined);
});

test('migrates legacy learnings.json into _global.json once', () => {
  const store = tempRepo();
  store.writeJson('learnings.json', { updatedAt: 1, run: 'r1', lessons: [{ role: 'planner', lesson: 'old one' }, { role: 'worker', lesson: 'old two' }] });
  const first = readLearnings(store);
  assert.deepEqual(first.map((l) => l.lesson), ['old one', 'old two']);
  assert.deepEqual(first[0].evidence, [{ run: 'legacy' }]);
  assert.equal(first[0].hits, 0);
  assert.equal(store.readJson<{ lessons: unknown[] }>('learnings/_global.json', { lessons: [] }).lessons.length, 2);
  // Idempotent: a later legacy change or a new write is not clobbered by re-migrating.
  writeLearnings(store, [lesson('new')], 'r2');
  store.writeJson('learnings.json', { lessons: [{ role: 'worker', lesson: 'resurrected' }] });
  assert.deepEqual(readLearnings(store).map((l) => l.lesson), ['new']);
  assert.deepEqual(listDomains(store), []);
});

test('lessons without evidence or text are dropped; roles and hits are normalised', () => {
  const store = tempRepo();
  const bad = [
    { role: 'worker', lesson: 'no evidence' },
    { role: 'worker', lesson: 'empty evidence', evidence: [] },
    { role: 'worker', lesson: 'blank run', evidence: [{ run: '  ' }] },
    { role: 'worker', lesson: '   ', evidence: [{ run: 'r1' }] },
    { role: 'bogus', lesson: ' kept ', evidence: [{ run: 'r1', task: 'T1' }, { run: '' }] },
  ] as unknown as Lesson[];
  writeLearnings(store, bad, 'r2');
  const got = readLearnings(store);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { role: 'worker', lesson: 'kept', evidence: [{ run: 'r1', task: 'T1' }], hits: 0 });
});

test('cap is per domain and drops least recent evidence first', () => {
  const store = tempRepo();
  writeLearnings(store, [lesson('web stays')], 'r20261022-0000-zzzz', 'web-ui');
  const ls: Lesson[] = [];
  for (let i = 0; i < DOMAIN_CAP; i++) ls.push(lesson(`l${i}`, `r20261022-10${String(i).padStart(2, '0')}-aaaa`));
  ls.push(lesson('oldest', 'r20200101-0000-aaaa'));
  ls.push(lesson('current', 'r20261022-9999-cur'));
  writeLearnings(store, ls, 'r20261022-9999-cur', 'cli');
  const cli = readLearnings(store, 'cli').map((l) => l.lesson);
  assert.equal(cli.length, DOMAIN_CAP);
  assert.ok(!cli.includes('oldest'));
  assert.ok(!cli.includes('l0'), 'next oldest dropped too');
  assert.ok(cli.includes('current'));
  assert.deepEqual(readLearnings(store, 'web-ui').map((l) => l.lesson), ['web stays']);
});

test('writing one domain leaves _global and other domains untouched; md mirror groups by domain', () => {
  const store = tempRepo();
  writeLearnings(store, [lesson('g1')], 'r1');
  writeLearnings(store, [lesson('d1')], 'r1', 'docs');
  const globalBefore = store.readText('learnings/_global.json');
  const docsBefore = store.readText('learnings/docs.json');
  writeLearnings(store, [{ role: 'judge', lesson: 'c1', evidence: [{ run: 'r2', task: 'T3' }], hits: 2 }], 'r2', 'cli');
  assert.equal(store.readText('learnings/_global.json'), globalBefore);
  assert.equal(store.readText('learnings/docs.json'), docsBefore);
  assert.deepEqual(listDomains(store), ['cli', 'docs']);
  const md = store.readText('learnings.md');
  assert.match(md, /## global[\s\S]*g1/);
  assert.match(md, /## cli[\s\S]*\[judge\] c1 \(evidence: r2\/T3\)/);
  assert.match(md, /## docs[\s\S]*d1/);
  assert.deepEqual(Object.keys(readAllLearnings(store)).sort(), ['_global', 'cli', 'docs']);
});

test('formatLearnings puts domain lessons first, role-matching first, within the budget', () => {
  const store = tempRepo();
  writeLearnings(store, [lesson('g-worker'), lesson('g-planner', 'r1', 'planner')], 'r1');
  writeLearnings(store, [lesson('d-worker'), lesson('d-planner', 'r1', 'planner')], 'r1', 'cli');
  const out = formatLearnings(store, 'planner', 'cli').split('\n');
  assert.deepEqual(out.map((l) => l.replace(/^- \[\w+\] /, '')), ['d-planner', 'd-worker', 'g-planner', 'g-worker']);
  assert.equal(formatLearnings(store, 'planner').split('\n').length, 2, 'no domain means global only');

  const many: Lesson[] = Array.from({ length: 20 }, (_, i) => lesson(`m${i}`));
  writeLearnings(store, many, 'r1', 'big');
  const lines = formatLearnings(store, 'worker', 'big').split('\n');
  assert.equal(lines.length, 15);
  assert.ok(lines[0].includes('m0'));
  assert.equal(formatLearnings(store, 'worker', 'big', 3).split('\n').length, 3);
  assert.equal(formatLearnings(tempRepo(), 'worker', 'cli'), '(none yet)');
});

test('summarizeLearnings is compact: counts and top lessons per domain', () => {
  const store = tempRepo();
  writeLearnings(store, Array.from({ length: 6 }, (_, i) => lesson(`c${i}`)), 'r1', 'cli');
  const s = summarizeLearnings(store);
  assert.equal(s.cli.count, 6);
  assert.equal(s.cli.top.length, 3);
  assert.ok(!('_global' in s), 'empty groups are omitted');
});
