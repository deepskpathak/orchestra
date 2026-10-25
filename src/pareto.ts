// Pareto archive math (W3.6). Pure: no IO. Persistence goes through readArchive/updateArchive.
import type { ArchiveEntry } from './harness.ts';

const EPS = 1e-9;

// Per-case validation scores. validationDetail wins; evalDetail is the legacy fallback.
export function validationScores(e: ArchiveEntry): Record<string, number> {
  return e.validationDetail ?? e.evalDetail ?? {};
}

// Versions best (ties count) on each case, keyed by case id.
function winnersByCase(entries: ArchiveEntry[]): Map<string, string[]> {
  const best = new Map<string, number>();
  for (const e of entries) {
    for (const [c, s] of Object.entries(validationScores(e))) {
      if (Number.isFinite(s) && s > (best.get(c) ?? -Infinity)) best.set(c, s);
    }
  }
  const out = new Map<string, string[]>();
  for (const [c, top] of best) {
    out.set(c, entries.filter((e) => {
      const s = validationScores(e)[c];
      return Number.isFinite(s) && s >= top - EPS;
    }).map((e) => e.version));
  }
  return out;
}

// Number of validation cases each version is best on (ties count for everyone tied).
export function paretoWins(entries: ArchiveEntry[]): Map<string, number> {
  const wins = new Map<string, number>();
  for (const winners of winnersByCase(entries).values()) {
    for (const v of winners) wins.set(v, (wins.get(v) ?? 0) + 1);
  }
  return wins;
}

// Every variant that is best on at least one validation case. Entries with no per-case detail
// cannot be best anywhere and are dropped.
export function paretoFront(entries: ArchiveEntry[]): ArchiveEntry[] {
  const wins = paretoWins(entries);
  return entries.filter((e) => (wins.get(e.version) ?? 0) > 0);
}

// Children whose score beat their parent's (via parent links).
export function descendantSuccess(entries: ArchiveEntry[], version: string): number {
  const parent = entries.find((e) => e.version === version);
  if (!parent || parent.evalScore === null) return 0;
  return entries.filter((e) => e.parent === version && e.evalScore !== null && e.evalScore > parent.evalScore! + EPS).length;
}

// Pick a parent from the front: most Pareto wins plus successful descendants, then higher score,
// then version name. rng only breaks exact ties; without it the first tied entry wins.
export function selectParent(entries: ArchiveEntry[], rng?: () => number): ArchiveEntry | null {
  const front = paretoFront(entries);
  if (!front.length) return null;
  const wins = paretoWins(entries);
  const rank = (e: ArchiveEntry) => [(wins.get(e.version) ?? 0) + descendantSuccess(entries, e.version), e.evalScore ?? -Infinity];
  const sorted = [...front].sort((a, b) => {
    const [ra, sa] = rank(a);
    const [rb, sb] = rank(b);
    return rb - ra || sb - sa || a.version.localeCompare(b.version, undefined, { numeric: true });
  });
  const [r0, s0] = rank(sorted[0]);
  const tied = sorted.filter((e) => { const [r, s] = rank(e); return r === r0 && s === s0; });
  if (!rng || tied.length === 1) return tied[0];
  return tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))];
}

// Compact scored history for the evolver prompt. Holdout scores are never read here.
export function archiveHistory(entries: ArchiveEntry[], limit = 10): string {
  if (!entries.length) return '(no archive history)';
  const wins = paretoWins(entries);
  const rows = [...entries].sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(0, limit)).reverse();
  const lines = rows.map((e) => {
    const score = e.evalScore === null || e.evalScore === undefined ? 'n/a' : e.evalScore.toFixed(3);
    const step = e.stepping ? ' stepping' : '';
    return `${e.version} parent=${e.parent ?? '-'} status=${e.status}${step} score=${score} wins=${wins.get(e.version) ?? 0}`;
  });
  return lines.join('\n');
}

// Fields to persist after a cycle: paretoWins for everyone, stepping for front members that are not promoted.
export function archivePatches(entries: ArchiveEntry[]): Map<string, Partial<ArchiveEntry>> {
  const wins = paretoWins(entries);
  const out = new Map<string, Partial<ArchiveEntry>>();
  for (const e of entries) {
    const w = wins.get(e.version) ?? 0;
    out.set(e.version, { paretoWins: w, stepping: w > 0 && e.status !== 'promoted' && e.status !== 'rejected' });
  }
  return out;
}
