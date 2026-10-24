// Exploration and footprint metrics (W9.0). Pure aggregation over ledger rows; recording is passive.

import type { LedgerRow, Role } from './types.ts';

export type ToolCounts = Record<string, number>;

// Adds the tool_use blocks of one stream-json message to `counts`. Non-assistant messages are ignored.
export function countToolUse(msg: any, counts: ToolCounts): void {
  if (msg?.type !== 'assistant' || !Array.isArray(msg.message?.content)) return;
  for (const block of msg.message.content) {
    if (block?.type === 'tool_use' && typeof block.name === 'string') counts[block.name] = (counts[block.name] ?? 0) + 1;
  }
}

// Repo paths mentioned in free text, matched against the repo file list (no guessing at unknown paths).
export function plannedFiles(text: string, repoFiles: string[]): string[] {
  const tokens = new Set(text.split(/[\s`'"()[\]{},;:<>]+/).map((t) => t.replace(/^\.\//, '').replace(/[.]+$/, '')).filter(Boolean));
  return repoFiles.filter((f) => tokens.has(f));
}

export interface Footprint {
  precision?: number; // of the planned files, share actually changed; undefined when nothing was planned
  recall?: number; // of the changed files, share that was planned; undefined when nothing changed
}

export function footprintAccuracy(planned: string[], changed: string[]): Footprint {
  const p = new Set(planned);
  const c = new Set(changed);
  const hit = [...p].filter((f) => c.has(f)).length;
  return { precision: p.size ? hit / p.size : undefined, recall: c.size ? hit / c.size : undefined };
}

export interface ExplorationRow {
  harness: string;
  role: Role;
  calls: number;
  turns: number;
  inputTokens: number;
  cacheTokens: number;
  costUsd: number;
  read: number;
  grep: number;
  glob: number;
  withToolCounts: number; // calls that carried toolCounts; legacy rows do not
}

export interface FootprintRow {
  harness: string;
  tasks: number;
  precision?: number;
  recall?: number;
}

export interface ExplorationMetrics {
  roles: ExplorationRow[];
  footprint: FootprintRow[];
}

const vnum = (v: string) => Number(v.slice(1)) || 0;
const avg = (xs: (number | undefined)[]): number | undefined => {
  const v = xs.filter((x): x is number => x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};

export function explorationMetrics(rows: LedgerRow[]): ExplorationMetrics {
  const goal = rows.filter((r) => (r.kind ?? 'goal') === 'goal');
  const byKey = new Map<string, ExplorationRow>();
  for (const r of goal) {
    if (r.outcome !== undefined) continue; // outcome rows are bookkeeping, not agent calls
    const k = `${r.harness}|${r.role}`;
    const e = byKey.get(k) ?? { harness: r.harness, role: r.role, calls: 0, turns: 0, inputTokens: 0, cacheTokens: 0, costUsd: 0, read: 0, grep: 0, glob: 0, withToolCounts: 0 };
    e.calls++;
    e.turns += r.turns ?? 0;
    e.inputTokens += r.inputTokens ?? 0;
    e.cacheTokens += (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
    e.costUsd += r.costUsd ?? 0;
    if (r.toolCounts) {
      e.withToolCounts++;
      e.read += r.toolCounts.Read ?? 0;
      e.grep += r.toolCounts.Grep ?? 0;
      e.glob += r.toolCounts.Glob ?? 0;
    }
    byKey.set(k, e);
  }
  const roles = [...byKey.values()].sort((a, b) => vnum(a.harness) - vnum(b.harness) || a.role.localeCompare(b.role));
  const fp = new Map<string, { p: (number | undefined)[]; r: (number | undefined)[] }>();
  for (const r of goal) {
    if (r.outcome !== 'merged' || !r.footprint) continue;
    const a = footprintAccuracy(r.footprint.planned, r.footprint.changed);
    const e = fp.get(r.harness) ?? { p: [], r: [] };
    e.p.push(a.precision);
    e.r.push(a.recall);
    fp.set(r.harness, e);
  }
  const footprint = [...fp.entries()]
    .map(([harness, e]) => ({ harness, tasks: e.p.length, precision: avg(e.p), recall: avg(e.r) }))
    .sort((a, b) => vnum(a.harness) - vnum(b.harness));
  return { roles, footprint };
}

const pct = (x: number | undefined) => (x === undefined ? 'n/a' : `${(x * 100).toFixed(0)}%`);

export function renderExploration(m: ExplorationMetrics): string {
  const out = ['Exploration by harness version and role (Read/Grep/Glob n/a when the runs predate tool counts)'];
  if (!m.roles.length) out.push('  no agent calls recorded yet');
  else {
    out.push('  version  role         calls  turns  input-tok  cache-tok  cost($)  Read  Grep  Glob');
    for (const r of m.roles) {
      const t = r.withToolCounts > 0;
      const n = (x: number) => (t ? String(x) : 'n/a').padStart(4);
      out.push(
        `  ${r.harness.padEnd(8)} ${r.role.padEnd(12)} ${String(r.calls).padStart(5)} ${String(r.turns).padStart(6)} ${String(r.inputTokens).padStart(10)} ${String(r.cacheTokens).padStart(10)} ${r.costUsd.toFixed(2).padStart(8)}  ${n(r.read)}  ${n(r.grep)}  ${n(r.glob)}`,
      );
    }
  }
  out.push('Footprint accuracy (planned files vs files changed, merged tasks)');
  if (!m.footprint.length) out.push('  no footprint data yet');
  for (const f of m.footprint) out.push(`  ${f.harness.padEnd(8)} tasks ${String(f.tasks).padStart(3)}  precision ${pct(f.precision)}  recall ${pct(f.recall)}`);
  return out.join('\n');
}
