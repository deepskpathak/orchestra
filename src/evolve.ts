// Self-improvement engine (Darwin Gödel Machine style, with guard rails):
// measure each harness version, let the evolver propose one variant, score it on the
// Factory Eval against the incumbent, keep every variant in the archive, promote only on
// a measured gain with no regressions.

import { agreementBlock, storeCalibration } from './calibration.ts';
import { meanDefined, pairedDecision, passAt1, passHatK, type PairedCase } from './stats.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJson, type Runner } from './agent.ts';
import { runGoal } from './conductor.ts';
import { git } from './git.ts';
import { fireRateByVersion, MONITOR_MARK } from './integrity.ts';
import {
  EVOLVABLE_FILES,
  ROLES,
  createVariant,
  currentVersion,
  loadHarness,
  promote,
  readArchive,
  updateArchive,
  writeArchive,
} from './harness.ts';
import { archiveHistory, archivePatches, selectParent } from './pareto.ts';
import { needsHumanSignoff, splitEvals } from './evalsets.ts';
import { summarizeLearnings } from './learnings.ts';
import { BudgetTracker, costGate, roundsOf, sequentialDecision, utility } from './selection.ts';
import { loadScorer, scoreReplay, type Scorer } from './scorer.ts';
import type { Store } from './store.ts';
import type { Run } from './types.ts';

export interface VersionMetrics {
  version: string;
  runs: number;
  tasks: number;
  merged: number;
  firstPassYield: number; // merged on attempt 1 / tasks
  satisfaction: number; // mean run satisfaction
  costPerMerged: number;
  totalCost: number;
  cacheHitRatio?: number | null; // cacheRead / (input + cacheRead + cacheWrite); null when no ledger rows have usage
}

export interface EvalCase {
  id: string;
  goal: string;
  base: string; // commit to start from
  check?: string | null; // shell command that must pass on the result
  harvestedFrom?: string;
  source?: string; // source goal id; cases sharing it form one cluster in paired statistics
  taskType?: string;
  createdAt?: number; // ms epoch; orders cases for time-split eval sets
  tags?: string[];
  reference?: string; // human fix or known-good solution, never shown to workers
}

export function goalRuns(store: Store, kind: 'goal' | 'eval' = 'goal'): Run[] {
  return store
    .listRuns()
    .map((id) => store.loadRun(id))
    .filter((r): r is Run => !!r && (r.kind ?? 'goal') === kind && !!r.endedAt);
}

export function metrics(store: Store): VersionMetrics[] {
  const runs = goalRuns(store);
  const rows = store.ledgerRows().filter((r) => (r.kind ?? 'goal') === 'goal');
  const versions = [...new Set(runs.map((r) => r.harness))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return versions.map((version) => {
    const rs = runs.filter((r) => r.harness === version);
    const tasks = rs.flatMap((r) => r.tasks);
    const merged = tasks.filter((t) => t.status === 'merged');
    const totalCost = rows.filter((r) => r.harness === version).reduce((s, r) => s + r.costUsd, 0);
    const withUsage = rows.filter((r) => r.harness === version && r.cacheReadTokens !== undefined);
    const sum = (k: 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => withUsage.reduce((s, r) => s + (r[k] ?? 0), 0);
    const denom = sum('inputTokens') + sum('cacheReadTokens') + sum('cacheWriteTokens');
    return {
      version,
      cacheHitRatio: withUsage.length && denom > 0 ? sum('cacheReadTokens') / denom : null,
      runs: rs.length,
      tasks: tasks.length,
      merged: merged.length,
      firstPassYield: tasks.length ? merged.filter((t) => t.attempts === 1).length / tasks.length : 0,
      satisfaction: rs.length ? rs.reduce((s, r) => s + (r.satisfaction ?? 0), 0) / rs.length : 0,
      costPerMerged: merged.length ? totalCost / merged.length : 0,
      totalCost,
    };
  });
}

// ---- Factory Eval ----

export function listEvals(store: Store): EvalCase[] {
  const dir = store.path('evals');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalCase);
}

// Harvest: a clean, high-satisfaction run becomes a regression case for future harnesses.
export function harvest(store: Store, run: Run, minSatisfaction = 0.8): EvalCase | null {
  if (run.kind !== 'goal' || run.status !== 'done' || (run.satisfaction ?? 0) < minSatisfaction || !run.baseRef) return null;
  // Cluster by goal text (re-runs of the same goal are correlated) and type by the planner's domain slug, the only
  // task metadata a goal run carries; without these every case is its own cluster of type 'unknown'.
  const c: EvalCase = { id: run.id, goal: run.goal, base: run.baseRef, check: store.config().testCommand, harvestedFrom: run.id, source: run.goal.trim().replace(/\s+/g, ' ').toLowerCase(), taskType: run.domain || 'unknown', createdAt: run.endedAt ?? Date.now() };
  store.writeJson(`evals/${run.id}.json`, c);
  return c;
}

export interface EvalResult {
  score: number;
  detail: Record<string, number>;
  passed: Record<string, boolean>;
  cost: number;
  infraFailureRate: number; // infrastructure-failed replays / replays attempted
  inconclusive?: string;
  monitorFireRate?: number; // integrity-monitor flags per replayed run; kept out of every evolver prompt
}

const INFRA_ERROR = /usage limit|session limit|rate limit|overloaded|quota|credit|not logged in|\/login|authentication|ECONN|ETIMEDOUT|ENOTFOUND|network/i;

// A failed run whose error is infrastructure, not the harness's fault.
export function isInfraFailure(run: Run): boolean {
  return run.status === 'failed' && INFRA_ERROR.test(run.error ?? '');
}

interface CaseOutcome {
  ok: boolean;
  score: number;
  cost: number;
  flags?: number; // integrity-monitor flags raised across the replay's tasks
  inconclusive?: string;
}

// One clean-room replay: runGoal gives every eval run its own fresh worktree cut from the case's
// base commit (unique run id, nothing reused), and eval runs bypass the learnings store.
async function evalCase(store: Store, runner: Runner, version: string, c: EvalCase, onRun: ((r: Run) => void) | undefined, scorer: Scorer, withLearnings = false): Promise<CaseOutcome> {
  const run = await runGoal({ store, runner, goal: c.goal, harnessVersion: version, baseRef: c.base, kind: 'eval', onUpdate: onRun, ...(withLearnings ? { evalLearnings: true } : {}) });
  let cost = run.costUsd;
  if (isInfraFailure(run)) {
    deleteRunBranches(store, run);
    return { ok: false, score: 0, cost, inconclusive: run.error };
  }
  // Promotion scores come from the frozen scorer. run.satisfaction is the candidate's own
  // judge and stays advisory (repair notes), so a harness cannot grade itself into promotion.
  // A run that finished without an integration branch produced nothing to score: that is a failed replay.
  let ok = run.status === 'done' && !!run.integrationBranch;
  let checkPassed: boolean | null = null;
  if (ok && c.check && run.integrationBranch) {
    checkPassed = checkBranch(store, run.integrationBranch, c.check);
    ok = checkPassed;
  }
  let score = 0;
  if (ok && run.integrationBranch) {
    const diff = c.base ? git(store.root, 'diff', `${c.base}...${run.integrationBranch}`) : '';
    const scored = await scoreReplay(scorer, runner, { goal: c.goal, diff, checkPassed, integrityFlags: run.tasks.flatMap((t) => (t.integrityFlags ?? []).map((f) => `${f.kind} in ${f.file} (${f.detail})`)), cwd: store.root, runId: run.id });
    cost += scored.cost;
    store.ledger({ t: Date.now(), run: run.id, kind: 'eval', harness: version, role: 'judge', model: scorer.model, ok: scored.ok, costUsd: scored.cost, durationMs: 0, turns: 0 });
    if (!scored.ok && INFRA_ERROR.test(scored.error ?? '')) {
      deleteRunBranches(store, run);
      return { ok: false, score: 0, cost, inconclusive: scored.error };
    }
    ok = scored.ok && !!scored.verdict?.pass;
    score = scored.score;
  }
  deleteRunBranches(store, run);
  return { ok, score: ok ? score : 0, cost, flags: run.tasks.reduce((n, t) => n + (t.integrityFlags?.length ?? 0), 0) };
}

// Accumulates per-version results across (possibly interleaved) replays.
class EvalTally {
  detail: Record<string, number> = {};
  passed: Record<string, boolean> = {};
  cost = 0;
  attempts = 0;
  infraFailures = 0;
  monitor: { harnessVersion: string; flags: number }[] = [];
  inconclusive?: string;
  version: string;
  constructor(version = '') {
    this.version = version;
  }

  add(c: EvalCase, o: CaseOutcome): void {
    this.attempts++;
    this.cost += o.cost;
    if (o.inconclusive) {
      this.infraFailures++;
      this.inconclusive = o.inconclusive;
      return;
    }
    this.monitor.push({ harnessVersion: this.version, flags: o.flags ?? 0 });
    this.passed[c.id] = o.ok;
    this.detail[c.id] = o.score;
  }

  result(): EvalResult {
    const vals = Object.values(this.detail);
    const rate = fireRateByVersion(this.monitor)[0]?.rate;
    const base = { detail: this.detail, passed: this.passed, cost: round(this.cost), infraFailureRate: this.attempts ? round(this.infraFailures / this.attempts) : 0, ...(rate === undefined ? {} : { monitorFireRate: round(rate) }) };
    if (this.inconclusive) return { score: 0, ...base, inconclusive: this.inconclusive };
    return { score: vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0, ...base };
  }
}

export async function evaluate(store: Store, runner: Runner, version: string, cases: EvalCase[], onRun?: (r: Run) => void, scorer: Scorer = loadScorer(), opts: { learnings?: boolean } = {}): Promise<EvalResult> {
  const tally = new EvalTally(version);
  for (const c of cases) {
    tally.add(c, await evalCase(store, runner, version, c, onRun, scorer, opts.learnings));
    if (tally.inconclusive) break;
  }
  return tally.result();
}

// Replays candidate and incumbent interleaved per case (A,B,A,B...) so drift in the
// infrastructure (rate limits, model changes) hits both sides alike. The first infrastructure
// failure ends both sides as inconclusive.
export async function evaluatePair(store: Store, runner: Runner, incumbent: string, candidate: string, cases: EvalCase[], onRun?: (r: Run) => void, scorer: Scorer = loadScorer()): Promise<{ incumbent: EvalResult; candidate: EvalResult }> {
  const inc = new EvalTally(incumbent);
  const cand = new EvalTally(candidate);
  for (const c of cases) {
    // Candidate first within each pair, then incumbent.
    cand.add(c, await evalCase(store, runner, candidate, c, onRun, scorer));
    if (cand.inconclusive) break;
    inc.add(c, await evalCase(store, runner, incumbent, c, onRun, scorer));
    if (inc.inconclusive) break;
  }
  const reason = cand.inconclusive ?? inc.inconclusive;
  const out = { incumbent: inc.result(), candidate: cand.result() };
  if (reason) {
    out.incumbent.inconclusive = reason;
    out.candidate.inconclusive = reason;
  }
  return out;
}

function checkBranch(store: Store, branch: string, check: string): boolean {
  const path = store.path('worktrees', `check-${Date.now()}`);
  try {
    git(store.root, 'worktree', 'add', '-q', '--detach', path, branch);
    return spawnSync('sh', ['-c', check], { cwd: path, timeout: 10 * 60_000 }).status === 0;
  } finally {
    try {
      git(store.root, 'worktree', 'remove', '--force', path);
    } catch {
      // Already gone; prune below covers stale entries.
    }
    git(store.root, 'worktree', 'prune');
  }
}

function deleteRunBranches(store: Store, run: Run): void {
  const refs = git(store.root, 'for-each-ref', '--format=%(refname:short)', `refs/heads/orchestra/${run.id}/`).split('\n').filter(Boolean);
  for (const r of refs) git(store.root, 'branch', '-D', r);
}

// ---- Evolution ----

const VARIANT_ITEM = {
  type: 'object',
  properties: {
    rationale: { type: 'string' },
    files: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { name: { type: 'string', enum: EVOLVABLE_FILES }, content: { type: 'string' } },
        required: ['name', 'content'],
      },
    },
  },
  required: ['rationale', 'files'],
};

const VARIANT_SCHEMA = {
  type: 'object',
  properties: { variants: { type: 'array', minItems: 1, items: VARIANT_ITEM } },
  required: ['variants'],
};

interface ProposedVariant {
  rationale?: string;
  files?: { name: string; content: string }[];
}

// Accepts { variants: [...] } and the legacy single { rationale, files } shape.
function parseVariants(structured: unknown): ProposedVariant[] {
  const raw = structured as (ProposedVariant & { variants?: ProposedVariant[] }) | undefined;
  if (Array.isArray(raw?.variants)) return raw.variants;
  return raw?.files ? [raw] : [];
}

export interface EvolveOutcome {
  candidate: string | null;
  incumbent: string;
  candidateScore: number | null;
  incumbentScore: number | null;
  promoted: boolean;
  reason: string;
  monitorFireRate?: { incumbent: number; candidate: number }; // integrity-monitor flags per replayed run
  infraFailureRate?: { incumbent: number; candidate: number }; // set when candidate and incumbent were replayed
  holdout?: { parent: number; candidate: number; confirmed: boolean }; // locked holdout confirmation (parent = the incumbent it must beat); never shown to the evolver
}

export interface PromotionInput {
  incumbentScores: number[]; // per-case scores, same order as candidateScores
  candidateScores: number[];
  regressions: string[];
  minGain: number;
  minCases: number;
  incumbent?: string;
  monitorFireRate?: { incumbent: number; candidate: number }; // integrity-monitor flags per run
  rule?: 'gain' | 'paired'; // default 'gain'
  niMargin?: number; // paired rule: per task type non-inferiority margin, default 0.05
  sources?: string[]; // per-case source goal (cluster), same order as the scores; default one cluster per case
  taskTypes?: string[]; // per-case task type; default 'unknown'
  candidatePassed?: boolean[]; // per-case pass flags for pass@1 and pass^3; default score >= 0.5
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  gain: number;
  spread: number;
  ci?: [number, number]; // 95% CI on the mean gain (cluster-robust), always reported
  passAt1?: number; // candidate pass rate per source goal, averaged
  passHat3?: number; // candidate pass^3, undefined when no goal has 3 repeats
}

// One stray monitor flag (a heuristic false positive) must not veto a clearly better harness, so the
// candidate may exceed the incumbent by this many flags before the monitor blocks promotion.
export const MONITOR_SLACK_FLAGS = 1;

// Pure promotion gate. With few cases a lucky run looks like a gain, so refuse below minCases,
// and require the mean gain to beat the observed spread (stddev of per-case deltas).
export function promotionDecision(i: PromotionInput): PromotionDecision {
  const n = Math.min(i.incumbentScores.length, i.candidateScores.length);
  const deltas = Array.from({ length: n }, (_, k) => i.candidateScores[k] - i.incumbentScores[k]);
  const gain = n ? deltas.reduce((a, b) => a + b, 0) / n : 0;
  const spread = n ? Math.sqrt(deltas.reduce((a, d) => a + (d - gain) ** 2, 0) / n) : 0;
  const sources = Array.from({ length: n }, (_, k) => i.sources?.[k] ?? `case-${k}`);
  const pcases = Array.from({ length: n }, (_, k) => ({ goal: sources[k], taskType: i.taskTypes?.[k], incumbent: i.incumbentScores[k], candidate: i.candidateScores[k] }));
  const paired = pairedDecision({ cases: pcases, niMargin: i.niMargin ?? 0.05, minCases: i.minCases });
  const perGoal = new Map<string, { n: number; c: number }>();
  for (let k = 0; k < n; k++) {
    const g = perGoal.get(sources[k]) ?? { n: 0, c: 0 };
    g.n++;
    if (i.candidatePassed ? i.candidatePassed[k] : i.candidateScores[k] >= 0.5) g.c++;
    perGoal.set(sources[k], g);
  }
  const p1 = meanDefined([...perGoal.values()].map((g) => passAt1(g.n, g.c)));
  const p3 = meanDefined([...perGoal.values()].map((g) => passHatK(g.n, g.c, 3)));
  const f = (x?: number) => (x === undefined ? 'n/a' : x.toFixed(3));
  // With fewer than 2 source goals the interval is unbounded; report it as absent rather than as Infinity (JSON turns that into null).
  const ciKnown = Number.isFinite(paired.ci[0]) && Number.isFinite(paired.ci[1]);
  const stats = `${ciKnown ? `95% CI [${paired.ci[0].toFixed(3)}, ${paired.ci[1].toFixed(3)}]` : '95% CI n/a (needs 2+ source goals)'}, pass@1 ${f(p1)}, pass^3 ${f(p3)}`;
  const out = (promote: boolean, reason: string): PromotionDecision => ({
    promote,
    reason: `${reason} (${stats})`,
    gain: round(gain),
    spread: round(spread),
    ...(ciKnown ? { ci: [round(paired.ci[0]), round(paired.ci[1])] as [number, number] } : {}),
    ...(p1 !== undefined ? { passAt1: round(p1) } : {}),
    ...(p3 !== undefined ? { passHat3: round(p3) } : {}),
  });
  if (n < i.minCases) return out(false, `only ${n} eval cases, need at least ${i.minCases}`);
  if (i.regressions.length) return out(false, `regressed on ${i.regressions.join(', ')}`);
  const mon = i.monitorFireRate;
  // Rates are flags per replayed run, so scale the difference back to a flag count (one run per case).
  if (mon && (mon.candidate - mon.incumbent) * n > MONITOR_SLACK_FLAGS + 1e-9) {
    return out(false, `integrity monitor fire rate ${mon.candidate.toFixed(3)} per run exceeds incumbent ${mon.incumbent.toFixed(3)} by more than ${MONITOR_SLACK_FLAGS} flag: candidate edits grading files or weakens tests more often`);
  }
  if (i.rule === 'paired') {
    return out(paired.verdict === 'promote', `paired ${paired.verdict}: ${paired.reason}${paired.verdict === 'promote' ? ` over ${i.incumbent ?? 'incumbent'}` : ''}`);
  }
  const bar = Math.max(i.minGain, spread);
  if (!(gain > bar)) return out(false, `gain ${gain.toFixed(3)} not above ${spread > i.minGain ? 'spread' : 'minGain'} ${bar.toFixed(3)}`);
  return out(true, `+${gain.toFixed(3)} over ${i.incumbent ?? 'incumbent'} with no regressions (spread ${spread.toFixed(3)})`);
}

export async function evolve(store: Store, runner: Runner, log: (msg: string) => void, onRun?: (r: Run) => void): Promise<EvolveOutcome> {
  if (!store.config().evolve.pareto?.enabled) return evolveCycle(store, runner, log, onRun);
  // The incumbent must be in the archive to compete on the front (v1 is seeded without an entry).
  const inc = currentVersion(store);
  if (!readArchive(store).some((a) => a.version === inc)) {
    writeArchive(store, [{ version: inc, parent: null, createdAt: 0, rationale: 'seed harness', evalScore: null, status: 'promoted' }, ...readArchive(store)]);
  }
  try {
    return await evolveCycle(store, runner, log, onRun);
  } finally {
    // Persist Pareto wins and stepping-stone flags on every exit path.
    for (const [version, patch] of archivePatches(readArchive(store))) updateArchive(store, version, patch);
  }
}

async function evolveCycle(store: Store, runner: Runner, log: (msg: string) => void, onRun?: (r: Run) => void): Promise<EvolveOutcome> {
  const incumbent = currentVersion(store);
  const cfg = store.config();
  const usePareto = !!cfg.evolve.pareto?.enabled;
  // Variants derive from a Pareto-selected parent; evaluation and promotion still compare against the incumbent.
  const parent = (usePareto ? selectParent(readArchive(store), undefined, (v) => existsSync(store.path('harness', v)))?.version : null) ?? incumbent;
  const h = loadHarness(store, incumbent);
  const m = metrics(store);
  const blocked = agreementBlock(storeCalibration(store), incumbent, cfg.evolve.minJudgeAgreement);
  if (blocked) return { candidate: null, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: blocked };
  const recentIssues = goalRuns(store)
    .slice(-5)
    // Monitor output must never reach the evolver, or it could learn to evade the monitor.
    .flatMap((r) => r.tasks.flatMap((t) => [...t.notes, ...(t.status === 'failed' ? [`${t.id} FAILED: ${t.verdict?.summary ?? ''}`] : [])]))
    .filter((n) => !n.includes(MONITOR_MARK))
    .slice(-40);
  const files = EVOLVABLE_FILES.map((f) => `--- ${f} ---\n${existsSync(store.path('harness', parent, f)) ? readFileSync(store.path('harness', parent, f), 'utf8') : ''}`).join('\n\n');
  const rejected = readArchive(store)
    .filter((a) => a.status === 'rejected')
    .slice(-5)
    .map((a) => `- ${a.version} (score ${a.evalScore}): ${a.rationale}`);

  const k = Math.max(1, Math.floor(cfg.evolve.candidates ?? 1));
  const allCases = listEvals(store);
  const useSplits = !!cfg.evolve.splits?.enabled;
  const sp = useSplits ? splitEvals(allCases, { feedback: cfg.evolve.splits!.feedback, validation: cfg.evolve.splits!.validation, holdout: cfg.evolve.splits!.holdout }) : null;
  const budget = new BudgetTracker(cfg.evolve.budgetUsd);
  const prompt = [
    ...(k > 1 ? [`PROPOSE ${k} VARIANTS in one response. Each variant must target a different weakness; do not overlap edits.`] : []),
    `CURRENT HARNESS ${parent}:\n${files}`,
    `METRICS PER VERSION:\n${JSON.stringify(m, null, 2)}`,
    `RECENT REPAIR NOTES AND FAILURES:\n${recentIssues.map((i) => `- ${i.split('\n')[0]}`).join('\n') || '(none)'}`,
    `PREVIOUSLY REJECTED VARIANTS (do not repeat):\n${rejected.join('\n') || '(none)'}`,
    `LEARNINGS SUMMARY (per domain):\n${JSON.stringify(summarizeLearnings(store))}`,
    // With splits on the evolver sees feedback cases only; validation and holdout stay hidden.
    ...(usePareto ? [`SCORED ARCHIVE HISTORY (validation scores; build on what scored well):\n${archiveHistory(readArchive(store))}`] : []),
    ...(sp ? [`FEEDBACK CASES (the only eval cases you may study):\n${sp.feedback.map((c) => `- ${c.id}: ${c.goal}`).join('\n') || '(none)'}`] : []),
  ].join('\n\n');

  // One evolver call, always ledgered.
  const askEvolver = async (p: string) => {
    const res = await runner({
      role: 'evolver',
      prompt: p,
      system: h.prompts.evolver,
      cwd: store.root,
      model: h.config.models.evolver,
      budgetUsd: h.config.budgetUsd.evolver,
      schema: VARIANT_SCHEMA,
      tools: [],
      onAction: (a) => log(`evolver: ${a}`),
    });
    budget.add(res.costUsd);
    store.ledger({ t: Date.now(), run: 'evolve', kind: 'eval', harness: incumbent, role: 'evolver', model: h.config.models.evolver, ok: res.ok, costUsd: res.costUsd, durationMs: res.durationMs, turns: res.turns });
    return { res, variants: res.ok ? parseVariants(extractJson(res)).filter((v) => v.files?.length) : [] };
  };
  const noOutcome = (reason: string): EvolveOutcome => ({ candidate: null, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason });

  log(`Evolver studying ${incumbent} (${m.find((x) => x.version === incumbent)?.runs ?? 0} runs of evidence)`);
  const proposal = await askEvolver(prompt);
  if (!proposal.variants.length) return noOutcome(`Evolver produced no variant: ${proposal.res.error ?? 'empty'}`);

  const created: { version: string; rationale: string; files: string[] }[] = [];
  let guardError = '';
  for (const out of proposal.variants.slice(0, k)) {
    try {
      const version = createVariant(store, parent, Object.fromEntries(out.files!.map((f) => [f.name, f.content])), out.rationale ?? '');
      created.push({ version, rationale: out.rationale ?? '', files: out.files!.map((f) => f.name) });
      log(`Candidate ${version}: ${out.rationale}`);
    } catch (err) {
      guardError = (err as Error).message;
      log(`Variant rejected by guard: ${guardError}`);
    }
  }
  if (!created.length) return noOutcome(`Variant rejected by guard: ${guardError}`);
  let candidate = created[0].version;

  // A sample below minCases could never promote (a stale config.json can pin an old, smaller sample).
  const cases = (sp ? sp.validation : allCases).slice(-Math.max(cfg.evolve.sample, cfg.evolve.minCases));
  if (!cases.length) {
    return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: 'No Factory Eval cases yet. Successful runs are harvested automatically; candidate kept for later evaluation.' };
  }

  if (cases.length < cfg.evolve.minCases) {
    // Cheaper than evaluating first and then refusing to promote: no eval runs are spent.
    const reason = `only ${cases.length} eval cases, need at least ${cfg.evolve.minCases}; candidate kept for later evaluation`;
    return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason };
  }

  const cascade = cfg.evolve.cascade?.enabled ? cfg.evolve.cascade : null;
  let finalists = [candidate];
  // Eval spend so far, to estimate the next replay for the budget cap.
  let replays = 0;
  let evalSpend = 0;
  const spent = (r: EvalResult, n: number) => {
    budget.add(r.cost);
    evalSpend += r.cost;
    replays += n;
  };
  const wouldCross = (n: number) => budget.wouldExceed(replays ? (evalSpend / replays) * n : 0);
  const budgetStop = (where: string): EvolveOutcome => ({ candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: `budget cap $${budget.cap} reached (spent $${round(budget.spent)}) ${where}; candidate kept for later evaluation` });

  if (cascade) {
    // Step 1: smoke test. Guards and checklist intact, then one replay of the first case.
    const smokeCase = cases[0];
    const smoked: string[] = [];
    const smokeFails: string[] = [];
    for (const c of created) {
      const broken = harnessIntegrity(store, parent, c.version);
      if (broken) {
        updateArchive(store, c.version, { status: 'rejected' });
        smokeFails.push(`${c.version}: ${broken}`);
        log(`Smoke test failed for ${c.version}: ${broken}`);
        continue;
      }
      if (wouldCross(1)) return budgetStop('during the smoke test');
      const r = await evaluate(store, runner, c.version, [smokeCase], onRun);
      spent(r, 1);
      if (r.inconclusive) return inconclusive(c.version, incumbent, r.inconclusive);
      if (!r.passed[smokeCase.id]) {
        updateArchive(store, c.version, { status: 'rejected' });
        smokeFails.push(`${c.version}: failed smoke case ${smokeCase.id}`);
        continue;
      }
      smoked.push(c.version);
    }
    if (!smoked.length) return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: `no candidate passed the smoke test (${smokeFails.join('; ')}); none evaluated further` };

    // Step 2: minibatch. A candidate must beat its parent on the same cases.
    const mb = cases.slice(-Math.min(Math.max(1, Math.floor(cascade.minibatch)), cases.length));
    if (wouldCross(mb.length)) return budgetStop('before the minibatch');
    const mInc = await evaluate(store, runner, incumbent, mb, onRun);
    spent(mInc, mb.length);
    if (mInc.inconclusive) return inconclusive(candidate, incumbent, mInc.inconclusive);
    const cw = cfg.evolve.cost?.enabled ? cfg.evolve.cost : null;
    const util = (r: EvalResult) => (cw ? utility({ score: r.score, costUsd: r.cost, durationMs: 0 }, cw) : r.score);
    const cleared: { version: string; gain: number }[] = [];
    for (const v of smoked) {
      if (wouldCross(mb.length)) return budgetStop('during the minibatch');
      const mc = await evaluate(store, runner, v, mb, onRun);
      spent(mc, mb.length);
      if (mc.inconclusive) return inconclusive(v, incumbent, mc.inconclusive);
      const regressed = mb.some((e) => mInc.passed[e.id] && !mc.passed[e.id]);
      const gain = util(mc) - util(mInc);
      updateArchive(store, v, { screenScore: mc.score });
      if (gain > 0 && !regressed) cleared.push({ version: v, gain });
      else {
        updateArchive(store, v, { status: 'rejected' });
        log(`Minibatch: ${v} did not beat ${incumbent} (gain ${gain.toFixed(3)}${regressed ? ', regressed' : ''})`);
      }
    }
    if (!cleared.length) {
      return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: `no candidate cleared the minibatch of ${mb.length} case(s) against ${incumbent}; no full validation spent` };
    }
    // Step 3: full validation for the top finalists only.
    finalists = cleared.sort((a, b) => b.gain - a.gain).slice(0, Math.max(1, Math.floor(cascade.finalists))).map((x) => x.version);
    candidate = finalists[0];
  } else if (k > 1) {
    // Screen cheaply: the newest min(2, sample) cases. Drop any candidate that fails a case the incumbent passes.
    const screen = cases.slice(-Math.max(1, Math.min(2, cfg.evolve.sample)));
    log(`Screening ${created.length} candidate(s) on ${screen.length} case(s)`);
    const sInc = await evaluate(store, runner, incumbent, screen, onRun);
    if (sInc.inconclusive) return inconclusive(candidate, incumbent, sInc.inconclusive);
    const survivors: { version: string; rationale: string; files: string[]; screenScore: number; detail: Record<string, number> }[] = [];
    for (const c of created) {
      const sc = await evaluate(store, runner, c.version, screen, onRun);
      if (sc.inconclusive) return inconclusive(candidate, incumbent, sc.inconclusive);
      const regressed = screen.filter((e) => sInc.passed[e.id] && !sc.passed[e.id]).map((e) => e.id);
      if (regressed.length) {
        updateArchive(store, c.version, { status: 'rejected', evalScore: sc.score, screenScore: sc.score, evalDetail: sc.detail });
        log(`Screened out ${c.version}: regressed on ${regressed.join(', ')}`);
      } else {
        updateArchive(store, c.version, { screenScore: sc.score, evalDetail: sc.detail });
        survivors.push({ ...c, screenScore: sc.score, detail: sc.detail });
      }
    }
    if (!survivors.length) {
      return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: `all ${created.length} candidates regressed in screening; none evaluated further` };
    }
    // Survivors that are not the finalist keep status 'candidate' with their screening score:
    // they were never judged on the full sample, so they are not rejected.
    let finalist = survivors.reduce((best, s) => (s.screenScore > best.screenScore ? s : best));
    if (survivors.length >= 2) {
      const composePrompt = [
        'COMPOSE VARIANTS: merge the surviving variants below into ONE variant. Keep only edits that the per-case screening scores support; drop the rest.',
        `CURRENT HARNESS ${incumbent}:\n${files}`,
        ...survivors.map((s) => `SURVIVOR ${s.version}\nrationale: ${s.rationale}\nfiles: ${s.files.join(', ')}\nper-case screening scores (mean ${s.screenScore}): ${JSON.stringify(s.detail)}`),
        `INCUMBENT ${incumbent} per-case screening scores: ${JSON.stringify(sInc.detail)}`,
      ].join('\n\n');
      const composed = await askEvolver(composePrompt);
      const out = composed.variants[0];
      if (out) {
        const parents = survivors.map((s) => s.version);
        try {
          const version = createVariant(store, parent, Object.fromEntries(out.files!.map((f) => [f.name, f.content])), `Composed from ${parents.join(', ')}: ${out.rationale ?? ''}`, parents);
          log(`Composed ${version} from ${parents.join(', ')}`);
          finalist = { version, rationale: out.rationale ?? '', files: out.files!.map((f) => f.name), screenScore: 0, detail: {} };
        } catch (err) {
          log(`Compose rejected by guard: ${(err as Error).message}; falling back to ${finalist.version}`);
        }
      } else {
        log(`Compose produced no variant: ${composed.res.error ?? 'empty'}; falling back to ${finalist.version}`);
      }
    }
    candidate = finalist.version;
  }

  if (!cascade) finalists = [candidate];

  // Step 3 / classic evaluation. Without sequential testing or a budget cap this is a single evaluatePair over
  // every case; otherwise it runs in rounds and may stop early (settled CI) or at the budget cap.
  const seq = cfg.evolve.sequential?.enabled ? cfg.evolve.sequential : null;
  const roundSize = seq ? Math.max(1, Math.floor(seq.roundSize)) : budget.unlimited ? cases.length : 1;
  const validate = async (version: string) => {
    const parts: { r: EvalResult; n: number }[] = [];
    const evaluated: EvalCase[] = [];
    let note = '';
    let halted = false;
    const rounds = roundsOf(cases, roundSize);
    for (let ri = 0; ri < rounds.length; ri++) {
      const rc = rounds[ri];
      if (wouldCross(2 * rc.length)) {
        halted = true;
        break;
      }
      log(`Evaluating ${incumbent} vs ${version} on ${rc.length} eval case(s)${rounds.length > 1 ? ` (round ${ri + 1}/${rounds.length})` : ''}`);
      const pr = await evaluatePair(store, runner, incumbent, version, rc, onRun);
      spent(pr.incumbent, rc.length);
      spent(pr.candidate, rc.length);
      if (pr.incumbent.inconclusive) return { version, error: pr.incumbent.inconclusive, rates: `infra failure rate: incumbent ${pr.incumbent.infraFailureRate}, candidate ${pr.candidate.infraFailureRate}` };
      parts.push({ r: pr.incumbent, n: rc.length }, { r: pr.candidate, n: rc.length });
      evaluated.push(...rc);
      if (seq && ri < rounds.length - 1) {
        const sd = sequentialDecision(pairedCases(evaluated, parts), { roundSize, totalCases: cases.length, niMargin: cfg.evolve.niMargin ?? 0.05 });
        if (sd.verdict !== 'continue') {
          note = `sequential stop after ${evaluated.length} of ${cases.length} cases: ${sd.verdict}, ${sd.reason}`;
          log(note);
          break;
        }
      }
    }
    if (halted) return { version, halted: true as const, done: evaluated.length };
    const incParts = parts.filter((_, x) => x % 2 === 0);
    const candParts = parts.filter((_, x) => x % 2 === 1);
    return { version, cases: evaluated, note, inc: combine(incParts), cand: combine(candParts) };
  };

  const judged: { version: string; cases: EvalCase[]; inc: EvalResult; cand: EvalResult; better: boolean; reason: string; gain: number; note: string }[] = [];
  for (const v of finalists) {
    const res = await validate(v);
    if ('error' in res) return inconclusive(v, incumbent, res.error!, res.rates);
    if ('halted' in res) return budgetStop(`after ${res.done} of ${cases.length} validation cases`);
    const { inc, cand } = res;
    // Leave the archive as it was on inconclusive: a half-run evaluation must not mark anything rejected.
    updateArchive(store, incumbent, { evalScore: inc.score, evalDetail: inc.detail, evalInfraRate: inc.infraFailureRate });
    updateArchive(store, v, { evalScore: cand.score, evalDetail: cand.detail, validationDetail: cand.detail, evalInfraRate: cand.infraFailureRate });
    const regressions = res.cases.filter((c) => inc.passed[c.id] && !cand.passed[c.id]).map((c) => c.id);
    const monitor = { incumbent: inc.monitorFireRate ?? 0, candidate: cand.monitorFireRate ?? 0 };
    const decision = promotionDecision({
      incumbentScores: res.cases.map((c) => inc.detail[c.id] ?? 0),
      candidateScores: res.cases.map((c) => cand.detail[c.id] ?? 0),
      regressions,
      minGain: cfg.evolve.minGain,
      // An early sequential stop judges fewer cases than the pool; the pool size was already checked above.
      minCases: Math.min(cfg.evolve.minCases, res.cases.length),
      incumbent,
      monitorFireRate: monitor,
      rule: cfg.evolve.promotionRule ?? 'gain',
      niMargin: cfg.evolve.niMargin ?? 0.05,
      sources: res.cases.map((c) => c.source ?? c.id),
      taskTypes: res.cases.map((c) => c.taskType ?? 'unknown'),
      candidatePassed: res.cases.map((c) => !!cand.passed[c.id]),
    });
    let better = decision.promote;
    let reason = decision.reason;
    // Checked first so a cost-inflating variant is rejected for its cost even when quality is merely equal.
    if (cfg.evolve.cost?.enabled) {
      const gate = costGate({ incumbent: { score: inc.score, costUsd: inc.cost }, candidate: { score: cand.score, costUsd: cand.cost }, maxCostRisePct: cfg.evolve.cost.maxCostRisePct, minGainForCost: cfg.evolve.cost.minGainForCost });
      if (!gate.ok) {
        better = false;
        reason = `cost gate: ${gate.reason}`;
      }
    }
    if (res.note) reason = `${reason}; ${res.note}`;
    judged.push({ version: v, cases: res.cases, inc, cand, better, reason, gain: decision.gain, note: res.note });
  }
  // Best promotable finalist; otherwise the top-ranked one carries the outcome.
  const chosen = judged.filter((j) => j.better).sort((a, b) => b.gain - a.gain)[0] ?? judged[0];
  for (const j of judged) if (j !== chosen) updateArchive(store, j.version, { status: j.better ? 'candidate' : 'rejected' });
  candidate = chosen.version;
  const { inc, cand } = chosen;
  const infra = { incumbent: inc.infraFailureRate, candidate: cand.infraFailureRate };
  const monitor = { incumbent: inc.monitorFireRate ?? 0, candidate: cand.monitorFireRate ?? 0 };
  let better = chosen.better;
  let reason = chosen.reason;
  let holdout: EvolveOutcome['holdout'];
  const result = (promoted: boolean): EvolveOutcome => ({ candidate, incumbent, candidateScore: cand.score, incumbentScore: inc.score, promoted, reason, infraFailureRate: infra, monitorFireRate: monitor, ...(holdout ? { holdout } : {}) });

  if (better && sp) {
    const threshold = cfg.evolve.splits!.signoffBelow;
    if (needsHumanSignoff(allCases.length, threshold)) {
      updateArchive(store, candidate, { status: 'candidate' });
      reason = `${reason}; only ${allCases.length} eval cases in total (below ${threshold}), human sign-off required before promotion`;
      log(`Kept ${candidate}: ${reason}`);
      return result(false);
    }
    // The locked holdout is touched only here, to confirm a promotion.
    if (sp.holdout.length) {
      if (wouldCross(2 * sp.holdout.length)) return { ...result(false), reason: `${reason}; budget cap reached before holdout confirmation, candidate kept for later evaluation` };
      const hp = await evaluatePair(store, runner, incumbent, candidate, sp.holdout, onRun);
      spent(hp.incumbent, sp.holdout.length);
      spent(hp.candidate, sp.holdout.length);
      if (hp.incumbent.inconclusive) return { ...result(false), reason: `${reason}; holdout confirmation inconclusive, infrastructure failure (${hp.incumbent.inconclusive}); candidate kept for later evaluation` };
      updateArchive(store, candidate, { holdoutScore: hp.candidate.score });
      const confirmed = hp.candidate.score > hp.incumbent.score;
      holdout = { parent: hp.incumbent.score, candidate: hp.candidate.score, confirmed };
      if (!confirmed) {
        better = false;
        updateArchive(store, candidate, { status: 'candidate' });
        reason = `${reason}; not confirmed on the locked holdout (candidate ${hp.candidate.score} vs incumbent ${hp.incumbent.score})`;
        log(`Kept ${candidate}: ${reason}`);
        return result(false);
      }
      reason = `${reason}; confirmed on the locked holdout (${hp.candidate.score} vs ${hp.incumbent.score})`;
    }
  }

  if (better && cfg.evolve.autoPromote) {
    promote(store, candidate);
    log(`Promoted ${candidate}: ${reason}`);
    return result(true);
  }
  updateArchive(store, candidate, { status: better ? 'candidate' : 'rejected' });
  log(`${better ? 'Kept (autoPromote off)' : 'Rejected'} ${candidate}: ${reason}`);
  return result(false);
}

// Smoke-test half that needs no replay: the candidate must still carry every parent checklist line, keep the
// pass threshold and name a model for every role (the same guards createVariant enforces at creation).
export function harnessIntegrity(store: Store, parent: string, version: string): string | null {
  try {
    const prev = loadHarness(store, parent);
    const next = loadHarness(store, version);
    const kept = new Set(next.guidance.checklist.split('\n').map((l) => l.trim()));
    for (const line of prev.guidance.checklist.split('\n').map((l) => l.trim())) {
      if (line && !kept.has(line)) return `checklist line removed: ${line}`;
    }
    if (next.config.passThreshold < prev.config.passThreshold) return 'passThreshold lowered';
    for (const role of ROLES) if (!next.config.models?.[role]) return `config.json missing models.${role}`;
    return null;
  } catch (err) {
    return `harness unreadable: ${(err as Error).message}`;
  }
}

// Merge per-round results of one side into a single EvalResult (rates weighted by cases per round).
function combine(parts: { r: EvalResult; n: number }[]): EvalResult {
  if (parts.length === 1) return parts[0].r;
  const detail: Record<string, number> = {};
  const passed: Record<string, boolean> = {};
  let cost = 0;
  let n = 0;
  let infra = 0;
  let mon = 0;
  let monN = 0;
  for (const { r, n: k } of parts) {
    Object.assign(detail, r.detail);
    Object.assign(passed, r.passed);
    cost += r.cost;
    n += k;
    infra += r.infraFailureRate * k;
    if (r.monitorFireRate !== undefined) {
      mon += r.monitorFireRate * k;
      monN += k;
    }
  }
  const vals = Object.values(detail);
  return { score: vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0, detail, passed, cost: round(cost), infraFailureRate: n ? round(infra / n) : 0, ...(monN ? { monitorFireRate: round(mon / monN) } : {}) };
}

function pairedCases(evaluated: EvalCase[], parts: { r: EvalResult; n: number }[]): PairedCase[] {
  const inc: Record<string, number> = {};
  const cand: Record<string, number> = {};
  parts.forEach((p, x) => Object.assign(x % 2 === 0 ? inc : cand, p.r.detail));
  return evaluated.map((c) => ({ goal: c.source ?? c.id, taskType: c.taskType, incumbent: inc[c.id] ?? 0, candidate: cand[c.id] ?? 0 }));
}

function inconclusive(candidate: string, incumbent: string, error: string, rates?: string): EvolveOutcome {
  return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: `inconclusive, infrastructure failure (${error})${rates ? `; ${rates}` : ''}; candidate kept for later evaluation` };
}

// Should a completed run trigger evolution? Every N goal runs since the last harness change.
export function evolutionDue(store: Store): boolean {
  const every = store.config().evolve.every;
  if (!every) return false;
  const cur = currentVersion(store);
  const lastAttempt = Math.max(0, ...readArchive(store).filter((a) => a.parent === cur).map((a) => a.createdAt));
  return goalRuns(store).filter((r) => r.harness === cur && r.startedAt > lastAttempt).length >= every;
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
