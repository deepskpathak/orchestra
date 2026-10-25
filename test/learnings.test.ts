import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DOMAIN_CAP, applyLessonEdits, editsFromResponse, expireDomain, expireStale, lessonAblation, lessonId, formatLearnings, listDomains, normalizeDomain, readAllLearnings, readLearnings, summarizeLearnings, writeLearnings, type Lesson,
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
  assert.deepEqual(got[0], { role: 'worker', lesson: 'kept', evidence: [{ run: 'r1', task: 'T1' }], hits: 0, id: lessonId('kept'), helpful: 0, harmful: 0 });
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

const DAY = 86_400_000;

test('update edit changes only the targeted lesson; the others stay identical', () => {
  const store = tempRepo();
  writeLearnings(store, [lesson('alpha'), lesson('beta'), lesson('gamma')], 'r1', 'cli');
  const before = readLearnings(store, 'cli');
  const res = applyLessonEdits(store, 'cli', [{ op: 'update', id: before[1]!.id!, lesson: 'beta sharpened', evidence: [{ run: 'r2', task: 'T1' }] }], 'r2', 5000);
  const after = readLearnings(store, 'cli');
  assert.deepEqual(res, { added: 0, updated: 1, removed: 0, skipped: 0, evicted: 0 });
  assert.deepEqual(after[0], before[0]);
  assert.deepEqual(after[2], before[2]);
  assert.equal(after[1]!.id, before[1]!.id, 'id is stable across a text update');
  assert.equal(after[1]!.lesson, 'beta sharpened');
  assert.deepEqual(after[1]!.evidence, [...before[1]!.evidence, { run: 'r2', task: 'T1' }]);
  assert.equal(after[1]!.updatedAt, 5000);
});

test('add and remove edits; unknown ids and evidence-less adds are skipped', () => {
  const store = tempRepo();
  writeLearnings(store, [lesson('keep'), lesson('drop')], 'r1');
  const [keep, drop] = readLearnings(store);
  const res = applyLessonEdits(store, undefined, [
    { op: 'remove', id: drop!.id! },
    { op: 'remove', id: 'nope' },
    { op: 'update', id: 'nope', lesson: 'x' },
    { op: 'add', lesson: 'no evidence', evidence: [] },
    { op: 'add', role: 'judge', lesson: 'fresh', evidence: [{ run: 'r2' }] },
  ], 'r2');
  assert.deepEqual([res.added, res.removed, res.skipped], [1, 1, 3]);
  assert.deepEqual(readLearnings(store).map((l) => l.lesson), ['keep', 'fresh']);
  assert.deepEqual(readLearnings(store)[0], keep);
});

test('a full-rewrite shaped response is applied as item edits, so no lesson silently disappears', () => {
  const store = tempRepo();
  writeLearnings(store, [lesson('one'), lesson('two'), lesson('three')], 'r1', 'cli');
  const existing = readLearnings(store, 'cli');
  // The model "rewrites" the set but only mentions one old lesson plus a new one.
  const edits = editsFromResponse({ lessons: [{ role: 'worker', lesson: 'one', evidence: [{ run: 'r2' }] }, { role: 'worker', lesson: 'four', evidence: [{ run: 'r2' }] }] }, existing);
  assert.deepEqual(edits.map((e) => e.op), ['update', 'add']);
  applyLessonEdits(store, 'cli', edits, 'r2');
  assert.deepEqual(readLearnings(store, 'cli').map((l) => l.lesson), ['one', 'two', 'three', 'four']);
});

test('counters increment, persist across reads and apply to any domain; legacy files without them load', () => {
  const store = tempRepo();
  writeLearnings(store, [lesson('a'), lesson('b')], 'r1', 'cli');
  const [a, b] = readLearnings(store, 'cli');
  const bump = (edits: Parameters<typeof applyLessonEdits>[2]) => applyLessonEdits(store, 'cli', edits, 'r2');
  bump([{ op: 'update', id: a!.id!, helped: true }]);
  bump([{ op: 'update', id: a!.id!, helped: true }, { op: 'update', id: b!.id!, helped: true }]);
  bump([{ op: 'update', id: b!.id!, helped: false }]);
  const got = readLearnings(store, 'cli');
  assert.deepEqual([got[0]!.helpful, got[0]!.harmful, got[1]!.helpful, got[1]!.harmful], [2, 0, 1, 1]);
  assert.equal(bump([{ op: 'update', id: 'missing', helped: true }]).skipped, 1);
  // Old file shape: no id, helpful, harmful.
  store.writeJson('learnings/old.json', { lessons: [{ role: 'worker', lesson: 'legacy', evidence: [{ run: 'r1' }], hits: 2 }] });
  const [legacy] = readLearnings(store, 'old');
  assert.deepEqual([legacy!.helpful, legacy!.harmful, legacy!.hits, legacy!.id], [0, 0, 2, lessonId('legacy')]);
  assert.equal(applyLessonEdits(store, 'old', [{ op: 'remove', id: lessonId('legacy') }], 'r2').removed, 1);
});

test('expireStale drops stale or harmful lessons only when expiry is enabled', () => {
  const now = Date.UTC(2026, 9, 25);
  const fresh = { ...lesson('fresh', 'r20261020-0900-aaaa') };
  const stale = { ...lesson('stale', 'r20260101-0900-aaaa') };
  const harmful = { ...lesson('bad', 'r20261020-0900-aaaa'), helpful: 0, harmful: 3 };
  const mixed = { ...lesson('mixed', 'r20261020-0900-aaaa'), helpful: 3, harmful: 3 };
  const untimed = { ...lesson('untimed', 'legacy') };
  const all = [fresh, stale, harmful, mixed, untimed];
  assert.deepEqual(expireStale(all, now, 0), all, 'off: unchanged');
  assert.deepEqual(expireStale(all, now, 30 * DAY).map((l) => l.lesson), ['fresh', 'mixed', 'untimed']);
  // A recent updatedAt keeps an old-evidence lesson alive.
  assert.equal(expireStale([{ ...stale, updatedAt: now - DAY }], now, 30 * DAY).length, 1);

  const store = tempRepo();
  writeLearnings(store, all, 'r1', 'cli');
  assert.equal(expireDomain(store, 'cli', 0, 'r2', now), 0);
  assert.equal(readLearnings(store, 'cli').length, 5);
  assert.equal(expireDomain(store, 'cli', 30, 'r2', now), 2);
  assert.deepEqual(readLearnings(store, 'cli').map((l) => l.lesson), ['fresh', 'mixed', 'untimed']);
});

test('lessonAblation reports per-case scores, mean delta and CI with fake evaluators', async () => {
  const cases = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, goal: `goal ${i}` }));
  const withL = async (c: { id: string }) => (c.id === 'c5' ? 0.7 : 0.9);
  const withoutL = async () => 0.6;
  const r = await lessonAblation(withL, withoutL, cases);
  assert.equal(r.n, 6);
  assert.equal(r.cases[0]!.delta.toFixed(2), '0.30');
  assert.equal(r.cases[5]!.delta.toFixed(2), '0.10');
  assert.equal(r.meanDelta.toFixed(4), '0.2667');
  assert.ok(r.ci[0] < r.meanDelta && r.meanDelta < r.ci[1]);
  assert.equal(r.verdict, 'helps');
  const tie = await lessonAblation(async () => 0.5, async () => 0.5, cases);
  assert.equal(tie.meanDelta, 0);
  assert.equal(tie.verdict, 'no-evidence');
});
