// `orchestra bench`: a fixed suite of small fixture repos with hidden checks and oracle solutions.
// Each (arm, goal, repeat) runs the normal conductor as an eval run in a throwaway repo, then the hidden
// check runs against the integration branch. Checks and oracles live outside every repo workers see.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Runner } from './agent.ts';
import { runGoal, type Ablation } from './conductor.ts';
import { excludeOrchestra, git } from './git.ts';
import { PACKAGE_ROOT, currentVersion, listVersions, loadHarness, seedHarness } from './harness.ts';
import { meanDefined, pairedStats, passAt1, passHatK, type PairedCase } from './stats.ts';
import { DEFAULT_PROJECT_CONFIG, Store } from './store.ts';
import type { ProjectConfig } from './types.ts';

export interface BenchGoal {
  id: string;
  fixture: string; // directory under <suite>/fixtures
  goal: string;
  taskType: string;
  humanMinutes: number;
  check: string; // hidden check script, relative to the suite dir; exit 0 = pass
  oracle: string; // reference solution: a .patch/.diff file or an overlay directory, relative to the suite dir
}

export interface BenchArm {
  name: string;
  config?: Partial<ProjectConfig>; // shallow overrides of the project config (nested objects are merged one level)
  harness?: string; // harness version to run; copied from the source store when not v1. "incumbent" means the source store's current version
  ablate?: Ablation; // turn one conductor component off
  singleSession?: boolean; // baseline: one worker call with the whole goal, no planner or judge
  compareTo?: string; // single-session only: the arm whose mean cost per goal sets the budget (default "full", else the first other arm)
}

// Built-in arms for `orchestra bench --ablations`: the full factory, each component off in turn, and the evolver arm
// pinned to the base harness (v1) against the evolved incumbent that "full" runs.
// Every factory arm runs with contrastive repair enabled, so that `-contrastive` has something to turn off.
const FULL_CONFIG = { contrastive: { enabled: true } } as Partial<ProjectConfig>;
export const ABLATION_ARMS: BenchArm[] = [
  { name: 'full', harness: 'incumbent', config: FULL_CONFIG },
  { name: '-scenarios', harness: 'incumbent', config: FULL_CONFIG, ablate: { scenarios: true } },
  { name: '-repair', harness: 'incumbent', config: FULL_CONFIG, ablate: { repair: true } },
  { name: '-learnings', harness: 'incumbent', config: FULL_CONFIG, ablate: { learnings: true } },
  { name: '-contrastive', harness: 'incumbent', config: FULL_CONFIG, ablate: { contrastive: true } },
  { name: '-evolver', harness: 'v1', config: FULL_CONFIG },
];
export const SINGLE_SESSION_ARM: BenchArm = { name: 'single-session', singleSession: true, compareTo: 'full' };

export interface BenchRow {
  arm: string;
  goal: string;
  taskType: string;
  humanMinutes: number;
  repeat: number;
  runId: string;
  harness: string;
  checkPass: boolean;
  judgeSatisfaction: number | null;
  taskVerdicts: Record<string, boolean | null>;
  split?: boolean; // a contrastive pair's two judge verdicts disagreed; written only when true
  budgetUsd?: number; // single-session rows: the matched-cost budget
  singleSession?: boolean; // written only when true: the row has no judge, so calibration skips it
  costUsd: number;
  wallMs: number;
}

export interface ArmSummary {
  arm: string;
  goals: number;
  repeats: number;
  passAt1: number | null;
  passHat3: number | null; // null until every goal has at least 3 repeats
  meanCostUsd: number;
  meanWallMs: number;
}

export const DEFAULT_SUITE = join(PACKAGE_ROOT, 'bench');

export function loadGoals(suite = DEFAULT_SUITE, only?: string[]): BenchGoal[] {
  const dir = join(suite, 'goals');
  const all = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as BenchGoal)
    : [];
  if (!only?.length) return all;
  const missing = only.filter((id) => !all.some((g) => g.id === id));
  if (missing.length) throw new Error(`unknown bench goal(s): ${missing.join(', ')}`);
  return all.filter((g) => only.includes(g.id));
}

export function loadArms(suite = DEFAULT_SUITE, names?: string[]): BenchArm[] {
  const file = join(suite, 'arms.json');
  const defined: BenchArm[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  if (!names?.length) return defined.length ? defined : [{ name: 'default' }];
  // An unnamed arm is the unmodified default config, so `--arms a,b` always works.
  return names.map((n) => defined.find((a) => a.name === n) ?? { name: n });
}

// Fresh git repo holding only the fixture files, committed as the base. Returns the repo path and base sha.
export function materialiseFixture(suite: string, fixture: string): { dir: string; base: string } {
  const src = join(suite, 'fixtures', fixture);
  if (!existsSync(src)) throw new Error(`bench fixture "${fixture}" not found at ${src}`);
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-bench-'));
  cpSync(src, dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=Orchestra', '-c', 'user.email=orchestra@localhost', 'commit', '-qm', 'bench base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

const scriptPath = (suite: string, rel: string): string => (isAbsolute(rel) ? rel : resolve(suite, rel));

// Run the hidden check with `cwd` as the repo. The script stays in the suite dir, never in the repo.
export function runCheck(suite: string, goal: BenchGoal, cwd: string): { pass: boolean; tail: string } {
  const script = scriptPath(suite, goal.check);
  if (!existsSync(script)) return { pass: false, tail: `check script missing: ${script}` };
  const cmd = /\.(mjs|js)$/.test(script) ? process.execPath : 'sh';
  const r = spawnSync(cmd, [script], { cwd, encoding: 'utf8', timeout: 120_000 });
  return { pass: r.status === 0, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n') };
}

export function applyOracle(suite: string, goal: BenchGoal, cwd: string): void {
  const oracle = scriptPath(suite, goal.oracle);
  if (!existsSync(oracle)) throw new Error(`oracle missing: ${oracle}`);
  if (/\.(patch|diff)$/.test(oracle)) execFileSync('git', ['apply', oracle], { cwd, stdio: 'pipe' });
  else cpSync(oracle, cwd, { recursive: true });
}

export interface OracleResult {
  goal: string;
  ok: boolean;
  detail: string;
}

// Each oracle must pass its own check on a fresh base, and the unmodified base must fail it (else the check proves nothing).
export function verifyOracles(suite = DEFAULT_SUITE, only?: string[]): OracleResult[] {
  return loadGoals(suite, only).map((goal) => {
    const cleanups: string[] = [];
    try {
      const base = materialiseFixture(suite, goal.fixture);
      cleanups.push(base.dir);
      if (runCheck(suite, goal, base.dir).pass) return { goal: goal.id, ok: false, detail: 'check passes on the unmodified base, so it proves nothing' };
      applyOracle(suite, goal, base.dir);
      const r = runCheck(suite, goal, base.dir);
      return { goal: goal.id, ok: r.pass, detail: r.pass ? 'oracle passes its check' : `oracle fails its check: ${r.tail}` };
    } catch (err) {
      return { goal: goal.id, ok: false, detail: `oracle could not be applied: ${(err as Error).message}` };
    } finally {
      for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    }
  });
}

function armConfig(arm: BenchArm): ProjectConfig {
  const cfg: Record<string, any> = { ...DEFAULT_PROJECT_CONFIG, testCommand: null };
  for (const [k, v] of Object.entries(arm.config ?? {})) {
    cfg[k] = v && typeof v === 'object' && !Array.isArray(v) && cfg[k] && typeof cfg[k] === 'object' ? { ...cfg[k], ...v } : v;
  }
  return cfg as ProjectConfig;
}

// Mean cost per goal of the compared arm (cost per row, so repeats average out). Falls back to the worker budget
// when the compared arm has no recorded cost.
export function matchedBudget(rows: BenchRow[], arm: BenchArm, arms: BenchArm[], fallback: number | (() => number)): number {
  const target = arm.compareTo ?? (arms.some((a) => a.name === 'full') ? 'full' : arms.find((a) => !a.singleSession)?.name);
  const mine = rows.filter((r) => r.arm === target);
  const mean = mine.length ? mine.reduce((a, r) => a + r.costUsd, 0) / mine.length : 0;
  return mean > 0 ? mean : typeof fallback === 'function' ? fallback() : fallback; // the fallback may read the harness, so only pay for it when needed
}

export function summarize(rows: BenchRow[]): ArmSummary[] {
  const arms = [...new Set(rows.map((r) => r.arm))];
  return arms.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm);
    const byGoal = new Map<string, BenchRow[]>();
    for (const r of mine) byGoal.set(r.goal, [...(byGoal.get(r.goal) ?? []), r]);
    const per = [...byGoal.values()].map((g) => ({ n: g.length, c: g.filter((r) => r.checkPass).length }));
    const mean = (f: (r: BenchRow) => number) => (mine.length ? mine.reduce((a, r) => a + f(r), 0) / mine.length : 0);
    return {
      arm,
      goals: byGoal.size,
      repeats: Math.max(0, ...per.map((p) => p.n)),
      passAt1: meanDefined(per.map((p) => passAt1(p.n, p.c))) ?? null,
      passHat3: meanDefined(per.map((p) => passHatK(p.n, p.c, 3))) ?? null,
      meanCostUsd: mean((r) => r.costUsd),
      meanWallMs: mean((r) => r.wallMs),
    };
  });
}

export function renderSummary(s: ArmSummary[]): string {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const lines = [`${'arm'.padEnd(20)} ${'goals'.padStart(5)} ${'reps'.padStart(4)} ${'pass@1'.padStart(7)} ${'pass^3'.padStart(7)} ${'cost $'.padStart(8)} ${'wall s'.padStart(8)}`];
  for (const a of s) {
    lines.push(`${a.arm.padEnd(20)} ${String(a.goals).padStart(5)} ${String(a.repeats).padStart(4)} ${pct(a.passAt1).padStart(7)} ${pct(a.passHat3).padStart(7)} ${a.meanCostUsd.toFixed(3).padStart(8)} ${(a.meanWallMs / 1000).toFixed(1).padStart(8)}`);
  }
  return lines.join('\n');
}

export interface BenchOptions {
  store: Store; // results go to <store>/.orchestra/bench/<benchId>
  runner: Runner;
  suite?: string;
  arms?: BenchArm[];
  goals?: string[];
  repeats?: number;
  benchId?: string;
  onRow?: (row: BenchRow) => void;
}

export async function runBench(o: BenchOptions): Promise<{ benchId: string; dir: string; rows: BenchRow[]; summary: ArmSummary[] }> {
  const suite = o.suite ?? DEFAULT_SUITE;
  const goals = loadGoals(suite, o.goals);
  if (!goals.length) throw new Error(`no bench goals found in ${join(suite, 'goals')}`);
  const arms = o.arms ?? loadArms(suite);
  const repeats = Math.max(1, o.repeats ?? 1);
  const benchId = o.benchId ?? `b${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const dir = o.store.path('bench', benchId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'results.jsonl');
  writeFileSync(file, '');
  const rows: BenchRow[] = [];

  // Single-session baselines run last: their budget is the mean cost per goal of the arm they are compared with.
  const ordered = [...arms.filter((a) => !a.singleSession), ...arms.filter((a) => a.singleSession)];
  for (const arm of ordered) {
    const fallbackBudget = () => loadHarness(o.store, arm.harness === 'incumbent' ? undefined : arm.harness).config.budgetUsd.worker;
    let budgetUsd: number | undefined; // single-session arms only; resolved on first use, inside the per-row try
    for (const goal of goals) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const { dir: repo, base } = materialiseFixture(suite, goal.fixture);
        const t0 = Date.now();
        try {
          // The run happens in the throwaway repo's own store, so it is never harvested or counted for evolution here.
          excludeOrchestra(repo);
          const store = new Store(repo);
          store.writeJson('config.json', armConfig(arm));
          seedHarness(store);
          const version = arm.harness === 'incumbent' ? currentVersion(o.store) : arm.harness;
          if (version && version !== 'v1') {
            const from = o.store.path('harness', version);
            if (!existsSync(from)) throw new Error(`arm ${arm.name}: harness ${version} not found (have ${listVersions(o.store).join(', ')})`);
            cpSync(from, store.path('harness', version), { recursive: true });
          }
          let row: BenchRow;
          if (arm.singleSession) {
            budgetUsd ??= matchedBudget(rows, arm, arms, fallbackBudget);
            const harness = loadHarness(store, version);
            const res = await o.runner({
              role: 'worker',
              prompt: goal.goal,
              system: harness.prompts.worker,
              cwd: repo,
              model: harness.config.models.worker,
              budgetUsd: budgetUsd!,
              allowedTools: store.config().allowedTools,
              timeoutMs: 30 * 60_000,
              meta: { attempt: 1 },
            });
            const checkPass = runCheck(suite, goal, repo).pass;
            row = { arm: arm.name, goal: goal.id, taskType: goal.taskType, humanMinutes: goal.humanMinutes, repeat, runId: `single-${goal.id}-${repeat}`, harness: harness.version, checkPass, judgeSatisfaction: null, taskVerdicts: {}, singleSession: true, budgetUsd, costUsd: res.costUsd, wallMs: Date.now() - t0 };
          } else {
            const run = await runGoal({ store, runner: o.runner, goal: goal.goal, harnessVersion: version, baseRef: base, kind: 'eval', ablate: arm.ablate });
            let checkPass = false;
            if (run.integrationBranch) {
              const co = mkdtempSync(join(tmpdir(), 'orchestra-bench-check-'));
              try {
                git(repo, 'worktree', 'add', '-q', '--detach', co, run.integrationBranch);
                checkPass = runCheck(suite, goal, co).pass;
              } finally {
                try { git(repo, 'worktree', 'remove', '--force', co); } catch { rmSync(co, { recursive: true, force: true }); }
              }
            }
            row = {
              arm: arm.name,
              goal: goal.id,
              taskType: goal.taskType,
              humanMinutes: goal.humanMinutes,
              repeat,
              runId: run.id,
              harness: run.harness,
              checkPass,
              judgeSatisfaction: run.satisfaction ?? null,
              taskVerdicts: Object.fromEntries(run.tasks.map((t) => [t.id, t.verdict ? t.verdict.pass : null])),
              ...(run.tasks.some((t) => t.contrast?.a.verdict && t.contrast.b.verdict && t.contrast.a.verdict.pass !== t.contrast.b.verdict.pass) ? { split: true } : {}),
              costUsd: run.costUsd,
              wallMs: Date.now() - t0,
            };
          }
          rows.push(row);
          appendFileSync(file, JSON.stringify(row) + '\n');
          o.onRow?.(row);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      }
    }
  }
  const summary = summarize(rows);
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ benchId, repeats, arms: summary }, null, 2) + '\n');
  return { benchId, dir, rows, summary };
}

export interface AblationRow {
  arm: string;
  checkRate: number; // mean hidden-check pass rate
  gain: number | null; // paired gain versus the reference arm; null for the reference itself
  ci: [number, number] | null;
  clusters: number;
  passAt1: number | null;
  passHat3: number | null;
  meanCostUsd: number;
  budgetUsd?: number;
}

// Per-arm table against `reference`: pairs are (goal, repeat) cases, standard errors clustered by goal.
export function ablationTable(rows: BenchRow[], reference = 'full'): AblationRow[] {
  const ref = new Map(rows.filter((r) => r.arm === reference).map((r) => [`${r.goal}#${r.repeat}`, r]));
  return summarize(rows).map((sum) => {
    const mine = rows.filter((r) => r.arm === sum.arm);
    const cases: PairedCase[] = [];
    for (const r of mine) {
      const base = ref.get(`${r.goal}#${r.repeat}`);
      if (base && sum.arm !== reference) cases.push({ goal: r.goal, taskType: r.taskType, incumbent: base.checkPass ? 1 : 0, candidate: r.checkPass ? 1 : 0 });
    }
    const st = cases.length ? pairedStats(cases) : undefined;
    const budgets = mine.map((r) => r.budgetUsd).filter((b): b is number => b !== undefined);
    return {
      arm: sum.arm,
      checkRate: mine.length ? mine.filter((r) => r.checkPass).length / mine.length : 0,
      gain: st ? st.gain : null,
      ci: st && Number.isFinite(st.se) ? st.ci : null,
      clusters: st?.clusters ?? 0,
      passAt1: sum.passAt1,
      passHat3: sum.passHat3,
      meanCostUsd: sum.meanCostUsd,
      ...(budgets.length ? { budgetUsd: budgets.reduce((a, b) => a + b, 0) / budgets.length } : {}),
    };
  });
}

export function renderAblationTable(t: AblationRow[], reference = 'full'): string {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const sgn = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
  const lines = [`${'arm'.padEnd(16)} ${'check'.padStart(6)} ${`gain vs ${reference} (pts, 95% CI)`.padEnd(34)} ${'pass@1'.padStart(7)} ${'pass^3'.padStart(7)} ${'cost $'.padStart(8)}`];
  for (const a of t) {
    const gain = a.gain === null ? '(reference)' : `${sgn(a.gain)} [${a.ci ? `${sgn(a.ci[0])}, ${sgn(a.ci[1])}` : 'n/a: need 2+ goals'}]`;
    lines.push(`${a.arm.padEnd(16)} ${pct(a.checkRate).padStart(6)} ${gain.padEnd(34)} ${pct(a.passAt1).padStart(7)} ${pct(a.passHat3).padStart(7)} ${a.meanCostUsd.toFixed(3).padStart(8)}${a.budgetUsd !== undefined ? `  (budget $${a.budgetUsd.toFixed(3)} matched)` : ''}`);
  }
  return lines.join('\n');
}
