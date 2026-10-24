// Judge calibration (W2.5): how often does the judge's verdict match the bench's hidden check, and a
// stratified sample of verdicts for humans to grade. Pure functions over bench rows; file IO is at the edge.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchRow } from './bench.ts';
import { cohensKappa } from './stats.ts';
import type { Store } from './store.ts';

export type CalRow = BenchRow & { bench: string };

export interface SampleItem {
  id: string;
  bench: string;
  arm: string;
  goal: string;
  repeat: number;
  runId: string;
  harness: string;
  judgeScore: number | null;
  judgePass: boolean;
  checkPass: boolean;
  stratum: 'disagreement' | 'near-threshold' | 'other';
  humanPass: boolean | null; // fill in true/false, then `orchestra bench calibrate --import`
}

export interface HarnessCalibration {
  harness: string;
  n: number;
  agreement: number | null;
  kappa: number | null; // judge vs hidden check
  humanN: number;
  humanKappa: number | null; // human vs judge
}

export const MIN_CALIBRATION_SAMPLE = 10;
export const DEFAULT_NEAR_MARGIN = 0.1;

export const rowId = (r: CalRow): string => `${r.bench}:${r.arm}:${r.goal}:${r.repeat}`;

// The judge's verdict for a bench row: run satisfaction against the threshold, else every task passed.
export function judgePass(r: BenchRow, passThreshold: number): boolean {
  if (r.judgeSatisfaction !== null && r.judgeSatisfaction !== undefined) return r.judgeSatisfaction >= passThreshold;
  const v = Object.values(r.taskVerdicts ?? {});
  return v.length > 0 && v.every((x) => x === true);
}

// Rows with no judge at all (the single-session baseline: no satisfaction, no task verdicts) say nothing about
// judge calibration, so they are excluded rather than counted as a judge "fail".
export function hasJudge(r: BenchRow): boolean {
  return !r.singleSession && ((r.judgeSatisfaction !== null && r.judgeSatisfaction !== undefined) || Object.keys(r.taskVerdicts ?? {}).length > 0);
}

export function isNearThreshold(r: BenchRow, passThreshold: number, margin = DEFAULT_NEAR_MARGIN): boolean {
  return r.judgeSatisfaction !== null && r.judgeSatisfaction !== undefined && Math.abs(r.judgeSatisfaction - passThreshold) <= margin;
}

export function isSplit(r: BenchRow, passThreshold: number): boolean {
  return judgePass(r, passThreshold) !== r.checkPass || r.split === true;
}

export function calibrate(allRows: BenchRow[], passThreshold: number, grades: Map<string, boolean> = new Map()): HarnessCalibration[] {
  const rows = allRows.filter(hasJudge);
  const versions = [...new Set(rows.map((r) => r.harness))].sort();
  return versions.map((harness) => {
    const mine = rows.filter((r) => r.harness === harness);
    const judge = mine.map((r) => judgePass(r, passThreshold));
    const check = mine.map((r) => r.checkPass);
    const agree = judge.filter((j, i) => j === check[i]).length;
    const graded = mine.map((r, i) => ({ h: grades.get(rowId(r as CalRow)), j: judge[i] })).filter((x) => x.h !== undefined);
    return {
      harness,
      n: mine.length,
      agreement: mine.length ? agree / mine.length : null,
      kappa: mine.length ? cohensKappa(judge, check) : null,
      humanN: graded.length,
      humanKappa: graded.length ? cohensKappa(graded.map((x) => x.h!), graded.map((x) => x.j)) : null,
    };
  });
}

// Small deterministic PRNG so the same seed gives the same sample.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Oversample the informative verdicts: disagreements and split votes first, then near-threshold scores,
// reserving about 70% of the sample for them; the rest is random. Never exceeds `size`.
export function stratifiedSample(rows: CalRow[], passThreshold: number, size: number, seed = 1, margin = DEFAULT_NEAR_MARGIN): SampleItem[] {
  const rnd = mulberry32(seed);
  const ordered = rows.filter(hasJudge).sort((a, b) => (rowId(a) < rowId(b) ? -1 : 1)); // input order must not change the sample
  const dis = shuffle(ordered.filter((r) => isSplit(r, passThreshold)), rnd);
  const near = shuffle(ordered.filter((r) => !isSplit(r, passThreshold) && isNearThreshold(r, passThreshold, margin)), rnd);
  const rest = shuffle(ordered.filter((r) => !isSplit(r, passThreshold) && !isNearThreshold(r, passThreshold, margin)), rnd);
  const cap = Math.max(0, Math.floor(size));
  const priority = [...dis, ...near];
  const k = Math.min(priority.length, Math.ceil(cap * 0.7));
  const picked = [...priority.slice(0, k)];
  picked.push(...rest.slice(0, cap - picked.length));
  picked.push(...priority.slice(k).slice(0, cap - picked.length)); // too few ordinary rows: top up with more informative ones
  return picked.slice(0, cap).map((r) => ({
    id: rowId(r),
    bench: r.bench,
    arm: r.arm,
    goal: r.goal,
    repeat: r.repeat,
    runId: r.runId,
    harness: r.harness,
    judgeScore: r.judgeSatisfaction ?? null,
    judgePass: judgePass(r, passThreshold),
    checkPass: r.checkPass,
    stratum: isSplit(r, passThreshold) ? 'disagreement' : isNearThreshold(r, passThreshold, margin) ? 'near-threshold' : 'other',
    humanPass: null,
  }));
}

// Human grades: JSONL lines with `id` and `humanPass` (boolean). Lines without a boolean grade are skipped.
export function parseGrades(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { throw new Error(`grades line ${i + 1} is not valid JSON`); }
    const g = o.humanPass ?? o.human;
    if (typeof o.id === 'string' && typeof g === 'boolean') out.set(o.id, g);
  }
  return out;
}

// ---------- store IO ----------

const calDir = (store: Store): string => store.path('bench', 'calibration');

export function readBenchRows(store: Store): CalRow[] {
  const root = store.path('bench');
  if (!existsSync(root)) return [];
  const rows: CalRow[] = [];
  for (const id of readdirSync(root).sort()) {
    const f = join(root, id, 'results.jsonl');
    if (id === 'calibration' || !existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) if (line.trim()) rows.push({ ...(JSON.parse(line) as BenchRow), bench: id });
  }
  return rows;
}

export function readGrades(store: Store): Map<string, boolean> {
  const f = join(calDir(store), 'grades.jsonl');
  return existsSync(f) ? parseGrades(readFileSync(f, 'utf8')) : new Map();
}

export function writeSample(store: Store, size: number, seed = 1, margin = DEFAULT_NEAR_MARGIN): { file: string; items: SampleItem[] } {
  const items = stratifiedSample(readBenchRows(store), store.config().passThreshold, size, seed, margin);
  mkdirSync(calDir(store), { recursive: true });
  const file = join(calDir(store), 'sample.jsonl');
  writeFileSync(file, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  return { file, items };
}

export function importGrades(store: Store, file: string): { imported: number; total: number } {
  const incoming = parseGrades(readFileSync(file, 'utf8'));
  const merged = readGrades(store);
  for (const [k, v] of incoming) merged.set(k, v);
  mkdirSync(calDir(store), { recursive: true });
  writeFileSync(join(calDir(store), 'grades.jsonl'), [...merged].map(([id, humanPass]) => JSON.stringify({ id, humanPass })).join('\n') + '\n');
  return { imported: incoming.size, total: merged.size };
}

export function storeCalibration(store: Store): HarnessCalibration[] {
  return calibrate(readBenchRows(store), store.config().passThreshold, readGrades(store));
}

// Reason string when the incumbent's measured agreement is below the configured floor, else null.
export function agreementBlock(cal: HarnessCalibration[], incumbent: string, floor: number | null | undefined, minSample = MIN_CALIBRATION_SAMPLE): string | null {
  if (floor === null || floor === undefined) return null;
  const c = cal.find((x) => x.harness === incumbent);
  if (!c || c.agreement === null || c.n < minSample) return null;
  if (c.agreement >= floor) return null;
  return `judge agreement with hidden checks for ${incumbent} is ${c.agreement.toFixed(2)} over ${c.n} bench runs, below evolve.minJudgeAgreement ${floor}; evolution blocked until the judge is recalibrated`;
}

export function renderCalibration(cal: HarnessCalibration[]): string {
  if (!cal.length) return 'Judge calibration: no bench results yet (run `orchestra bench`).';
  const f = (x: number | null) => (x === null ? 'n/a' : x.toFixed(2));
  const lines = ['Judge calibration (judge verdict vs hidden check; human = human grades vs judge)', `${'harness'.padEnd(10)} ${'n'.padStart(4)} ${'agree'.padStart(6)} ${'kappa'.padStart(6)} ${'human n'.padStart(8)} ${'h-kappa'.padStart(8)}`];
  for (const c of cal) lines.push(`${c.harness.padEnd(10)} ${String(c.n).padStart(4)} ${f(c.agreement).padStart(6)} ${f(c.kappa).padStart(6)} ${String(c.humanN).padStart(8)} ${f(c.humanKappa).padStart(8)}`);
  return lines.join('\n');
}
