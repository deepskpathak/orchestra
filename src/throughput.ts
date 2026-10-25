// Pure throughput helpers (W6.1, W6.2): footprint overlap, parallel-safe groups,
// merge batches with bisect, conflict rate. No IO, no git.
import type { LedgerRow, Task } from './types.ts';

type Footprint = Task['footprint'];

function norm(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

function isEmpty(fp: Footprint): boolean {
  return !fp || !Array.isArray(fp.files) || fp.files.map(norm).filter(Boolean).length === 0;
}

// a equals b, or one is a directory prefix of the other.
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

// A missing or empty footprint is unknown, so it overlaps everything (safe default).
export function footprintsOverlap(a: Footprint, b: Footprint): boolean {
  if (isEmpty(a) || isEmpty(b)) return true;
  const fa = a!.files.map(norm).filter(Boolean);
  const fb = b!.files.map(norm).filter(Boolean);
  return fa.some((x) => fb.some((y) => pathsOverlap(x, y)));
}

// Greedy grouping: each group's footprints are pairwise disjoint.
export function parallelSafeGroups(tasks: Task[]): string[][] {
  const groups: Task[][] = [];
  for (const t of tasks) {
    const g = groups.find((grp) => grp.every((o) => !footprintsOverlap(t.footprint, o.footprint)));
    if (g) g.push(t);
    else groups.push([t]);
  }
  return groups.map((g) => g.map((t) => t.id));
}

// Single writer: a task may not start while an overlapping task is in flight.
export function canStart(task: Task, inflightTasks: Task[]): boolean {
  return !inflightTasks.some((o) => o.id !== task.id && footprintsOverlap(task.footprint, o.footprint));
}

const LOG_MAX = 600;

// Short decision log for tasks that depend on already merged tasks.
export function decisionLog(depTasks: Task[]): string {
  const lines = depTasks.map((d) => {
    const files = (d.footprint?.files ?? []).slice(0, 5).join(', ') || 'unknown files';
    const reason = (d.verdict?.reasons ?? '').replace(/\s+/g, ' ').trim();
    return `- ${d.id} "${d.title}": changed ${files}${reason ? `; ${reason}` : ''}`;
  });
  const out = lines.join('\n');
  return out.length > LOG_MAX ? out.slice(0, LOG_MAX - 3) + '...' : out;
}

// Batches of disjoint-footprint tasks, each at most maxBatch long, in input order.
export function planBatches(readyToMerge: Task[], maxBatch: number): string[][] {
  const cap = Math.max(1, Math.floor(maxBatch) || 1);
  const batches: Task[][] = [];
  for (const t of readyToMerge) {
    const b = batches.find((x) => x.length < cap && x.every((o) => !footprintsOverlap(t.footprint, o.footprint)));
    if (b) b.push(t);
    else batches.push([t]);
  }
  return batches.map((b) => b.map((t) => t.id));
}

// Test the full batch once; on failure split in halves and recurse. When the left half passes, the
// right half must hold the culprit, so it is not tested as a whole (saves a run per level).
export async function bisectBatch(
  ids: string[],
  testFn: (ids: string[]) => Promise<boolean>,
): Promise<{ good: string[]; bad: string[]; testRuns: number }> {
  let testRuns = 0;
  const good: string[] = [];
  const bad: string[] = [];
  const walk = async (batch: string[], knownFail: boolean): Promise<void> => {
    if (batch.length === 0) return;
    if (!knownFail) {
      testRuns++;
      if (await testFn(batch)) {
        good.push(...batch);
        return;
      }
    }
    if (batch.length === 1) {
      bad.push(...batch);
      return;
    }
    const mid = Math.ceil(batch.length / 2);
    const badBefore = bad.length;
    await walk(batch.slice(0, mid), false);
    await walk(batch.slice(mid), bad.length === badBefore);
  };
  await walk(ids, false);
  return { good, bad, testRuns };
}

// conflicts / (conflicts + merged); 0 when there were no merge attempts.
export function conflictRate(rows: Pick<LedgerRow, 'outcome'>[]): number {
  let conflicts = 0;
  let merged = 0;
  for (const r of rows) {
    if (r.outcome === 'conflict') conflicts++;
    else if (r.outcome === 'merged') merged++;
  }
  const attempts = conflicts + merged;
  return attempts === 0 ? 0 : conflicts / attempts;
}
