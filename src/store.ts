// Filesystem state under <repo>/.orchestra. All writes are atomic (write tmp, rename)
// so the dashboard and statusline can read concurrently without seeing torn JSON.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LedgerRow, OrchestraEvent, ProjectConfig, Run } from './types.ts';

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  concurrency: 3,
  testCommand: null,
  allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
  // Workers must not reach the network or publish anything. The guard hook enforces more.
  disallowedTools: ['WebFetch', 'WebSearch', 'Bash(git push:*)', 'Bash(curl:*)', 'Bash(wget:*)'],
  permissionMode: 'acceptEdits',
  runBudgetUsd: 20,
  judgeTiers: { enabled: false, cheapModel: 'haiku', margin: 0.1 },
  preJudge: { enabled: false, lintCommand: null, requireTests: true },
  contrastive: { enabled: false, onlyWithoutTests: true, maxPairs: 1 },
  fastPath: { enabled: false, maxGoalChars: 400 },
  evolve: { every: 3, autoPromote: true, minGain: 0.02, sample: 5, minCases: 5, candidates: 1, promotionRule: 'gain', niMargin: 0.05, minJudgeAgreement: null },
};

export class Store {
  readonly root: string; // the target repo
  readonly dir: string; // <root>/.orchestra

  constructor(root: string) {
    this.root = root;
    this.dir = join(root, '.orchestra');
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  exists(): boolean {
    return existsSync(this.path('config.json'));
  }

  readJson<T>(rel: string, fallback: T): T {
    const p = this.path(rel);
    if (!existsSync(p)) return fallback;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch (err) {
      throw new Error(`Corrupt JSON in ${p}: ${(err as Error).message}`);
    }
  }

  writeJson(rel: string, value: unknown): void {
    this.writeText(rel, JSON.stringify(value, null, 2) + '\n');
  }

  readText(rel: string, fallback = ''): string {
    const p = this.path(rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : fallback;
  }

  writeText(rel: string, text: string): void {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, p);
  }

  append(rel: string, line: unknown): void {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(line) + '\n');
  }

  readJsonl<T>(rel: string): T[] {
    const text = this.readText(rel);
    const out: T[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A line can be mid-write while a reader tails the file; skip it, the next read gets it.
      }
    }
    return out;
  }

  config(): ProjectConfig {
    const c = this.readJson<Partial<ProjectConfig>>('config.json', {});
    return { ...DEFAULT_PROJECT_CONFIG, ...c, judgeTiers: { ...DEFAULT_PROJECT_CONFIG.judgeTiers, ...(c.judgeTiers ?? {}) }, preJudge: { ...DEFAULT_PROJECT_CONFIG.preJudge, ...(c.preJudge ?? {}) }, contrastive: { ...DEFAULT_PROJECT_CONFIG.contrastive, ...(c.contrastive ?? {}) }, fastPath: { ...DEFAULT_PROJECT_CONFIG.fastPath, ...(c.fastPath ?? {}) }, evolve: { ...DEFAULT_PROJECT_CONFIG.evolve, ...(c.evolve ?? {}) } };
  }

  // ---- runs ----
  saveRun(run: Run): void {
    this.writeJson(`runs/${run.id}/run.json`, run);
    this.writeText('current', run.id + '\n');
  }

  loadRun(id: string): Run | null {
    return this.readJson<Run | null>(`runs/${id}/run.json`, null);
  }

  currentRunId(): string | null {
    const id = this.readText('current').trim();
    return id || null;
  }

  listRuns(): string[] {
    const d = this.path('runs');
    if (!existsSync(d)) return [];
    return readdirSync(d).sort();
  }

  event(e: OrchestraEvent): void {
    this.append(`runs/${e.run}/events.jsonl`, e);
  }

  events(runId: string): OrchestraEvent[] {
    return this.readJsonl<OrchestraEvent>(`runs/${runId}/events.jsonl`);
  }

  ledger(row: LedgerRow): void {
    this.append('ledger.jsonl', row);
  }

  ledgerRows(): LedgerRow[] {
    return this.readJsonl<LedgerRow>('ledger.jsonl');
  }
}

export function findRepoRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.orchestra', 'config.json')) || existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `r${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
