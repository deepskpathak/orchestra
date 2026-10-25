// Compound memory: lessons the librarian distills after each run, fed to future planners/workers/judges.
// Stored per domain (learnings/<domain>.json) plus learnings/_global.json, each lesson backed by run evidence.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { MONITOR_MARK } from './integrity.ts';
import { pairedStats } from './stats.ts';
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
  id?: string; // stable handle for item edits; derived from the text when a legacy file has none
  helpful?: number; // runs where this lesson was credited with helping
  harmful?: number; // runs where it was blamed for hurting
  updatedAt?: number; // ms epoch of the last add or update edit; drives expiry
}

/** One item-level change. Edits address lessons by id and never replace the whole set. */
export type LessonEdit =
  | { op: 'add'; role?: Lesson['role']; lesson: string; evidence: Evidence[] }
  | { op: 'update'; id: string; role?: Lesson['role']; lesson?: string; evidence?: Evidence[]; helped?: boolean }
  | { op: 'remove'; id: string };

export interface EditResult { added: number; updated: number; removed: number; skipped: number; evicted: number }

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

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Deterministic id from the lesson text, so a legacy lesson without one is addressable. */
export function lessonId(text: string): string {
  return 'L' + createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 8);
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
      hits: count(l.hits),
      id: typeof l.id === 'string' && l.id.trim() ? l.id.trim() : lessonId(l.lesson),
      helpful: count(l.helpful),
      harmful: count(l.harmful),
      ...(typeof l.updatedAt === 'number' && Number.isFinite(l.updatedAt) ? { updatedAt: l.updatedAt } : {}),
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

/** Internal persistence primitive. Model output must go through applyLessonEdits, never here. */
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

function resolveDomain(domain: string | undefined): string | undefined {
  if (domain === undefined || domain === GLOBAL) return undefined;
  const d = normalizeDomain(domain);
  if (!d) throw new Error(`Invalid learnings domain: ${domain}`);
  return d;
}

function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const out = [...a];
  for (const e of cleanEvidence(b)) if (!out.some((x) => x.run === e.run && x.task === e.task)) out.push(e);
  return out;
}

/**
 * Apply item edits to one domain. Only the addressed lessons change; every other lesson is carried over
 * untouched, so a bad model response cannot make the rest of the store disappear. Unknown ids are skipped.
 */
export function applyLessonEdits(store: Store, domain: string | undefined, edits: LessonEdit[], runId: string, now: number = Date.now()): EditResult {
  const d = resolveDomain(domain);
  const current = readLearnings(store, d);
  const byId = new Map(current.map((l) => [l.id!, l]));
  const res: EditResult = { added: 0, updated: 0, removed: 0, skipped: 0, evicted: 0 };
  for (const e of Array.isArray(edits) ? edits : []) {
    if (!e || typeof e !== 'object') { res.skipped++; continue; }
    if (e.op === 'add') {
      const [l] = cleanLessons([{ role: e.role, lesson: e.lesson, evidence: e.evidence, updatedAt: now }]);
      if (!l) { res.skipped++; continue; }
      const dup = byId.get(l.id!);
      if (dup) { dup.evidence = mergeEvidence(dup.evidence, l.evidence); dup.updatedAt = now; res.updated++; continue; }
      byId.set(l.id!, l);
      res.added++;
    } else if (e.op === 'update') {
      const cur = byId.get(e.id);
      if (!cur) { res.skipped++; continue; }
      if (typeof e.lesson === 'string' && e.lesson.trim()) cur.lesson = e.lesson.trim();
      if (e.role && ROLES.includes(e.role)) cur.role = e.role;
      if (e.evidence) cur.evidence = mergeEvidence(cur.evidence, e.evidence);
      if (e.helped === true) cur.helpful = (cur.helpful ?? 0) + 1;
      if (e.helped === false) cur.harmful = (cur.harmful ?? 0) + 1;
      cur.updatedAt = now;
      res.updated++;
    } else if (e.op === 'remove') {
      if (byId.delete(e.id)) res.removed++;
      else res.skipped++;
    } else {
      res.skipped++;
    }
  }
  const next = [...byId.values()];
  const kept = applyCap(cleanLessons(next), runId);
  res.evicted = next.length - kept.length;
  writeLearnings(store, kept, runId, d);
  return res;
}

/**
 * Turn a librarian response into edits. An `edits` array is used as is. A full `lessons` set (the old shape)
 * is converted: lessons matching an existing id or text become updates, the rest become adds, and existing
 * lessons the response omits are left alone. Removal only ever happens through an explicit remove edit.
 */
export function editsFromResponse(out: { edits?: unknown; lessons?: unknown } | undefined, existing: Lesson[]): LessonEdit[] {
  const edits: LessonEdit[] = [];
  if (Array.isArray(out?.edits)) edits.push(...(out!.edits as LessonEdit[]));
  if (Array.isArray(out?.lessons)) {
    const byId = new Map(existing.map((l) => [l.id!, l]));
    for (const raw of out!.lessons as Partial<Lesson>[]) {
      if (!raw || typeof raw.lesson !== 'string') continue;
      const id = typeof raw.id === 'string' && byId.has(raw.id) ? raw.id : lessonId(raw.lesson);
      if (byId.has(id)) edits.push({ op: 'update', id, lesson: raw.lesson, role: raw.role, evidence: raw.evidence });
      else edits.push({ op: 'add', role: raw.role, lesson: raw.lesson, evidence: raw.evidence as Evidence[] });
    }
  }
  return edits;
}

/** Credit or blame lessons by id (any domain). Counters persist; unknown ids are ignored. Returns how many changed. */
export function recordLessonOutcome(store: Store, ids: string[], helped: boolean, runId = 'outcome'): number {
  const want = new Set(ids);
  let changed = 0;
  for (const [key, ls] of Object.entries(readAllLearnings(store))) {
    let touched = false;
    for (const l of ls) {
      if (!want.has(l.id!)) continue;
      if (helped) l.helpful = (l.helpful ?? 0) + 1;
      else l.harmful = (l.harmful ?? 0) + 1;
      touched = true;
      changed++;
    }
    if (touched) writeLearnings(store, ls, runId, key);
  }
  return changed;
}

const RUN_TIME = /^r(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/;

/** Newest time evidence for this lesson was seen: updatedAt, else the newest parsable run id; undefined when unknown. */
function lastEvidenceAt(l: Lesson): number | undefined {
  let best = l.updatedAt;
  for (const e of l.evidence) {
    const m = RUN_TIME.exec(e.run);
    if (!m) continue;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if (best === undefined || t > best) best = t;
  }
  return best;
}

/** Harmful clearly outweighs helpful. */
export function isHarmful(l: Lesson): boolean {
  return (l.harmful ?? 0) >= 3 && (l.harmful ?? 0) >= 2 * (l.helpful ?? 0) + 2;
}

/**
 * Pure: drop lessons whose evidence is older than maxAgeMs, or whose harmful count is well above helpful.
 * maxAgeMs <= 0 means expiry is off and the input is returned unchanged. Lessons with no usable timestamp are kept.
 */
export function expireStale(lessons: Lesson[], now: number, maxAgeMs: number): Lesson[] {
  if (!(maxAgeMs > 0)) return lessons;
  return lessons.filter((l) => {
    if (isHarmful(l)) return false;
    const at = lastEvidenceAt(l);
    return at === undefined || now - at <= maxAgeMs;
  });
}

/** Opt-in expiry for one domain (learnings.expiryDays; 0 = off). Returns how many lessons were dropped. */
export function expireDomain(store: Store, domain: string | undefined, expiryDays: number, runId: string, now: number = Date.now()): number {
  if (!(expiryDays > 0)) return 0;
  const d = resolveDomain(domain);
  const cur = readLearnings(store, d);
  const kept = expireStale(cur, now, expiryDays * 86_400_000);
  if (kept.length === cur.length) return 0;
  writeLearnings(store, kept, runId, d);
  return cur.length - kept.length;
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
      const score = l.helpful || l.harmful ? `, +${l.helpful ?? 0}/-${l.harmful ?? 0}` : '';
      md.push(`- [${l.role}] ${l.lesson} (evidence: ${ev}${score})`);
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
    out[d] = { count: ls.length, byRole, top: ranked.filter((l) => !l.lesson.includes(MONITOR_MARK)).slice(0, top).map((l) => l.lesson) };
  }
  return out;
}

export interface AblationCase { id: string; goal: string; source?: string }
export interface LessonAblation {
  n: number;
  cases: { id: string; withLessons: number; withoutLessons: number; delta: number }[];
  meanDelta: number;
  ci: [number, number];
  clusters: number;
  verdict: 'helps' | 'hurts' | 'no-evidence';
}

/**
 * With-lessons versus without-lessons on a case set (use the holdout). Evaluators are injected and score one
 * case in [0,1]; each case is scored by both arms so the comparison is paired. A positive delta favours lessons.
 */
export async function lessonAblation(
  evalWith: (c: AblationCase) => Promise<number>,
  evalWithout: (c: AblationCase) => Promise<number>,
  cases: AblationCase[],
): Promise<LessonAblation> {
  const rows: LessonAblation['cases'] = [];
  for (const c of cases) {
    const w = await evalWith(c);
    const wo = await evalWithout(c);
    rows.push({ id: c.id, withLessons: w, withoutLessons: wo, delta: w - wo });
  }
  const st = pairedStats(cases.map((c, i) => ({ goal: c.source ?? c.goal, incumbent: rows[i]!.withoutLessons, candidate: rows[i]!.withLessons })));
  const verdict = st.ci[0] > 0 ? 'helps' : st.ci[1] < 0 ? 'hurts' : 'no-evidence';
  return { n: st.n, cases: rows, meanDelta: st.gain, ci: st.ci, clusters: st.clusters, verdict };
}
