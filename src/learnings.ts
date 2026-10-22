// Compound memory: lessons the librarian distills after each run, fed to future planners/workers/judges.
// Stored per domain (learnings/<domain>.json) plus learnings/_global.json, each lesson backed by run evidence.

import { existsSync, readdirSync } from 'node:fs';
import type { Store } from './store.ts';

export interface Evidence {
  run: string;
  task?: string;
}

export interface Lesson {
  role: 'planner' | 'worker' | 'judge';
  lesson: string;
  evidence: Evidence[];
  hits: number;
}

export const GLOBAL = '_global';
export const DOMAIN_CAP = 25;
export const RETRIEVAL_BUDGET = 15;
const ROLES = ['planner', 'worker', 'judge'];

/** Lowercase kebab slug, or undefined when invalid. `_global` is reserved. */
export function normalizeDomain(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const slug = s.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 40) return undefined;
  return slug;
}

function fileFor(domain: string | undefined): string {
  return `learnings/${domain && domain !== GLOBAL ? domain : GLOBAL}.json`;
}

function cleanEvidence(e: unknown): Evidence[] {
  if (!Array.isArray(e)) return [];
  const out: Evidence[] = [];
  for (const x of e) {
    if (!x || typeof x.run !== 'string' || !x.run.trim()) continue;
    const ev: Evidence = { run: x.run.trim() };
    if (typeof x.task === 'string' && x.task.trim()) ev.task = x.task.trim();
    out.push(ev);
  }
  return out;
}

function cleanLessons(lessons: unknown[]): Lesson[] {
  const out: Lesson[] = [];
  for (const raw of lessons) {
    const l = raw as Partial<Lesson> | null;
    if (!l || typeof l.lesson !== 'string' || !l.lesson.trim()) continue;
    const evidence = cleanEvidence(l.evidence);
    if (!evidence.length) continue;
    out.push({
      role: (ROLES.includes(l.role as string) ? l.role : 'worker') as Lesson['role'],
      lesson: l.lesson.trim(),
      evidence,
      hits: typeof l.hits === 'number' && Number.isFinite(l.hits) && l.hits > 0 ? Math.floor(l.hits) : 0,
    });
  }
  return out;
}

/** Newest evidence run id; the current run counts as newest. Run ids sort lexically by time. */
function recency(l: Lesson, currentRun: string): string {
  let best = '';
  for (const e of l.evidence) {
    const r = e.run === currentRun ? '￿' : e.run;
    if (r > best) best = r;
  }
  return best;
}

function applyCap(lessons: Lesson[], runId: string): Lesson[] {
  if (lessons.length <= DOMAIN_CAP) return lessons;
  const keep = new Set(
    lessons
      .map((l, i) => ({ l, i }))
      .sort((a, b) => (recency(a.l, runId) < recency(b.l, runId) ? 1 : recency(a.l, runId) > recency(b.l, runId) ? -1 : a.i - b.i))
      .slice(0, DOMAIN_CAP)
      .map((x) => x.i),
  );
  return lessons.filter((_, i) => keep.has(i));
}

/** One-time move of the legacy single-file store into learnings/_global.json. */
function migrate(store: Store): void {
  if (existsSync(store.path(fileFor(undefined)))) return;
  if (!existsSync(store.path('learnings.json'))) return;
  const legacy = store.readJson<{ lessons?: unknown[]; run?: string }>('learnings.json', {});
  const lessons = cleanLessons(
    (Array.isArray(legacy.lessons) ? legacy.lessons : []).map((l) => ({ ...(l as object), evidence: [{ run: 'legacy' }], hits: 0 })),
  );
  store.writeJson(fileFor(undefined), { updatedAt: Date.now(), run: legacy.run ?? 'legacy', lessons });
}

export function listDomains(store: Store): string[] {
  migrate(store);
  const dir = store.path('learnings');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((d) => d !== GLOBAL && normalizeDomain(d) === d)
    .sort();
}

export function readLearnings(store: Store, domain?: string): Lesson[] {
  migrate(store);
  const d = domain === undefined || domain === GLOBAL ? undefined : normalizeDomain(domain);
  if (domain !== undefined && domain !== GLOBAL && !d) return [];
  return cleanLessons(store.readJson<{ lessons?: unknown[] }>(fileFor(d), {}).lessons ?? []);
}

export function readAllLearnings(store: Store): Record<string, Lesson[]> {
  const all: Record<string, Lesson[]> = { [GLOBAL]: readLearnings(store) };
  for (const d of listDomains(store)) all[d] = readLearnings(store, d);
  return all;
}

export function writeLearnings(store: Store, lessons: Lesson[], runId: string, domain?: string): void {
  migrate(store);
  let d: string | undefined;
  if (domain !== undefined && domain !== GLOBAL) {
    d = normalizeDomain(domain);
    if (!d) throw new Error(`Invalid learnings domain: ${domain}`);
  }
  const clean = applyCap(cleanLessons(lessons), runId);
  store.writeJson(fileFor(d), { updatedAt: Date.now(), run: runId, lessons: clean });
  writeMirror(store, runId);
}

// Human-readable mirror, so you can read and edit what the factory has learned.
function writeMirror(store: Store, runId: string): void {
  const all = readAllLearnings(store);
  const md = ['# Orchestra learnings', '', `Updated after run ${runId}.`, ''];
  for (const key of [GLOBAL, ...Object.keys(all).filter((k) => k !== GLOBAL)]) {
    const ls = all[key];
    if (!ls.length) continue;
    md.push(`## ${key === GLOBAL ? 'global' : key}`, '');
    for (const l of ls) {
      const ev = l.evidence.map((e) => (e.task ? `${e.run}/${e.task}` : e.run)).join(', ');
      md.push(`- [${l.role}] ${l.lesson} (evidence: ${ev})`);
    }
    md.push('');
  }
  store.writeText('learnings.md', md.join('\n'));
}

function isStore(x: unknown): x is Store {
  return !!x && typeof (x as Store).readJson === 'function';
}

export function formatLearnings(
  source: Store | Record<string, Lesson[]>,
  role: Lesson['role'],
  domain?: string,
  budget: number = RETRIEVAL_BUDGET,
): string {
  const all = isStore(source) ? readAllLearnings(source) : source;
  const d = domain === undefined ? undefined : normalizeDomain(domain);
  const byRole = (ls: Lesson[]) => [...ls.filter((l) => l.role === role), ...ls.filter((l) => l.role !== role)];
  const picked = [...(d && d !== GLOBAL ? byRole(all[d] ?? []) : []), ...byRole(all[GLOBAL] ?? [])].slice(0, Math.max(0, budget));
  return picked.length ? picked.map((l) => `- [${l.role}] ${l.lesson}`).join('\n') : '(none yet)';
}

/** Compact per-domain summary for evolve: counts and the top lessons, not the full store. */
export function summarizeLearnings(store: Store, top = 3): Record<string, { count: number; byRole: Record<string, number>; top: string[] }> {
  const out: Record<string, { count: number; byRole: Record<string, number>; top: string[] }> = {};
  for (const [d, ls] of Object.entries(readAllLearnings(store))) {
    if (!ls.length) continue;
    const byRole: Record<string, number> = {};
    for (const l of ls) byRole[l.role] = (byRole[l.role] ?? 0) + 1;
    const ranked = [...ls].sort((a, b) => b.hits + b.evidence.length - (a.hits + a.evidence.length));
    out[d] = { count: ls.length, byRole, top: ranked.slice(0, top).map((l) => l.lesson) };
  }
  return out;
}
