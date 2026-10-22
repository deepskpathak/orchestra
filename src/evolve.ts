// Self-improvement engine (Darwin Gödel Machine style, with guard rails):
// measure each harness version, let the evolver propose one variant, score it on the
// Factory Eval against the incumbent, keep every variant in the archive, promote only on
// a measured gain with no regressions.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJson, type Runner } from './agent.ts';
import { runGoal } from './conductor.ts';
import { git } from './git.ts';
import {
  EVOLVABLE_FILES,
  createVariant,
  currentVersion,
  loadHarness,
  promote,
  readArchive,
  updateArchive,
} from './harness.ts';
import { summarizeLearnings } from './learnings.ts';
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
  const c: EvalCase = { id: run.id, goal: run.goal, base: run.baseRef, check: store.config().testCommand, harvestedFrom: run.id };
  store.writeJson(`evals/${run.id}.json`, c);
  return c;
}

export interface EvalResult {
  score: number;
  detail: Record<string, number>;
  passed: Record<string, boolean>;
  cost: number;
}

const INFRA_ERROR = /usage limit|session limit|rate limit|overloaded|quota|credit|not logged in|\/login|authentication|ECONN|ETIMEDOUT|ENOTFOUND|network/i;

// A failed run whose error is infrastructure, not the harness's fault.
export function isInfraFailure(run: Run): boolean {
  return run.status === 'failed' && INFRA_ERROR.test(run.error ?? '');
}

export async function evaluate(store: Store, runner: Runner, version: string, cases: EvalCase[], onRun?: (r: Run) => void): Promise<EvalResult> {
  const detail: Record<string, number> = {};
  const passed: Record<string, boolean> = {};
  let cost = 0;
  for (const c of cases) {
    const run = await runGoal({ store, runner, goal: c.goal, harnessVersion: version, baseRef: c.base, kind: 'eval', onUpdate: onRun });
    cost += run.costUsd;
    if (isInfraFailure(run)) {
      deleteRunBranches(store, run);
      return { score: 0, detail, passed, cost: round(cost), inconclusive: run.error };
    }
    let ok = run.status === 'done';
    if (ok && c.check && run.integrationBranch) ok = checkBranch(store, run.integrationBranch, c.check);
    passed[c.id] = ok;
    detail[c.id] = ok ? run.satisfaction ?? 0 : 0;
    deleteRunBranches(store, run);
  }
  const vals = Object.values(detail);
  return { score: vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0, detail, passed, cost: round(cost) };
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
}

export interface PromotionInput {
  incumbentScores: number[]; // per-case scores, same order as candidateScores
  candidateScores: number[];
  regressions: string[];
  minGain: number;
  minCases: number;
  incumbent?: string;
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  gain: number;
  spread: number;
}

// Pure promotion gate. With few cases a lucky run looks like a gain, so refuse below minCases,
// and require the mean gain to beat the observed spread (stddev of per-case deltas).
export function promotionDecision(i: PromotionInput): PromotionDecision {
  const n = Math.min(i.incumbentScores.length, i.candidateScores.length);
  const deltas = Array.from({ length: n }, (_, k) => i.candidateScores[k] - i.incumbentScores[k]);
  const gain = n ? deltas.reduce((a, b) => a + b, 0) / n : 0;
  const spread = n ? Math.sqrt(deltas.reduce((a, d) => a + (d - gain) ** 2, 0) / n) : 0;
  const out = (promote: boolean, reason: string): PromotionDecision => ({ promote, reason, gain: round(gain), spread: round(spread) });
  if (n < i.minCases) return out(false, `only ${n} eval cases, need at least ${i.minCases}`);
  if (i.regressions.length) return out(false, `regressed on ${i.regressions.join(', ')}`);
  const bar = Math.max(i.minGain, spread);
  if (!(gain > bar)) return out(false, `gain ${gain.toFixed(3)} not above ${spread > i.minGain ? 'spread' : 'minGain'} ${bar.toFixed(3)}`);
  return out(true, `+${gain.toFixed(3)} over ${i.incumbent ?? 'incumbent'} with no regressions (spread ${spread.toFixed(3)})`);
}

export async function evolve(store: Store, runner: Runner, log: (msg: string) => void, onRun?: (r: Run) => void): Promise<EvolveOutcome> {
  const incumbent = currentVersion(store);
  const h = loadHarness(store, incumbent);
  const cfg = store.config();
  const m = metrics(store);
  const recentIssues = goalRuns(store)
    .slice(-5)
    .flatMap((r) => r.tasks.flatMap((t) => [...t.notes, ...(t.status === 'failed' ? [`${t.id} FAILED: ${t.verdict?.summary ?? ''}`] : [])]))
    .slice(-40);
  const files = EVOLVABLE_FILES.map((f) => `--- ${f} ---\n${readFileSync(store.path('harness', incumbent, f), 'utf8')}`).join('\n\n');
  const rejected = readArchive(store)
    .filter((a) => a.status === 'rejected')
    .slice(-5)
    .map((a) => `- ${a.version} (score ${a.evalScore}): ${a.rationale}`);

  const k = Math.max(1, Math.floor(cfg.evolve.candidates ?? 1));
  const prompt = [
    ...(k > 1 ? [`PROPOSE ${k} VARIANTS in one response. Each variant must target a different weakness; do not overlap edits.`] : []),
    `CURRENT HARNESS ${incumbent}:\n${files}`,
    `METRICS PER VERSION:\n${JSON.stringify(m, null, 2)}`,
    `RECENT REPAIR NOTES AND FAILURES:\n${recentIssues.map((i) => `- ${i.split('\n')[0]}`).join('\n') || '(none)'}`,
    `PREVIOUSLY REJECTED VARIANTS (do not repeat):\n${rejected.join('\n') || '(none)'}`,
    `LEARNINGS SUMMARY (per domain):\n${JSON.stringify(summarizeLearnings(store))}`,
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
      const version = createVariant(store, incumbent, Object.fromEntries(out.files!.map((f) => [f.name, f.content])), out.rationale ?? '');
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
  const cases = listEvals(store).slice(-Math.max(cfg.evolve.sample, cfg.evolve.minCases));
  if (!cases.length) {
    return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: 'No Factory Eval cases yet. Successful runs are harvested automatically; candidate kept for later evaluation.' };
  }

  if (cases.length < cfg.evolve.minCases) {
    // Cheaper than evaluating first and then refusing to promote: no eval runs are spent.
    const reason = `only ${cases.length} eval cases, need at least ${cfg.evolve.minCases}; candidate kept for later evaluation`;
    return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason };
  }

  if (k > 1) {
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
          const version = createVariant(store, incumbent, Object.fromEntries(out.files!.map((f) => [f.name, f.content])), `Composed from ${parents.join(', ')}: ${out.rationale ?? ''}`, parents);
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

  log(`Evaluating ${incumbent} vs ${candidate} on ${cases.length} eval case(s)`);
  const inc = await evaluate(store, runner, incumbent, cases, onRun);
  if (inc.inconclusive) return inconclusive(candidate, incumbent, inc.inconclusive);
  updateArchive(store, incumbent, { evalScore: inc.score, evalDetail: inc.detail });
  const cand = await evaluate(store, runner, candidate, cases, onRun);
  // Leave the candidate's archive entry as it was: a half-run evaluation must not mark it rejected.
  if (cand.inconclusive) return inconclusive(candidate, incumbent, cand.inconclusive);
  updateArchive(store, candidate, { evalScore: cand.score, evalDetail: cand.detail });

  const regressions = cases.filter((c) => inc.passed[c.id] && !cand.passed[c.id]).map((c) => c.id);
  const decision = promotionDecision({
    incumbentScores: cases.map((c) => inc.detail[c.id] ?? 0),
    candidateScores: cases.map((c) => cand.detail[c.id] ?? 0),
    regressions,
    minGain: cfg.evolve.minGain,
    minCases: cfg.evolve.minCases,
    incumbent,
  });
  const better = decision.promote;
  const reason = decision.reason;

  if (better && cfg.evolve.autoPromote) {
    promote(store, candidate);
    log(`Promoted ${candidate}: ${reason}`);
    return { candidate, incumbent, candidateScore: cand.score, incumbentScore: inc.score, promoted: true, reason };
  }
  updateArchive(store, candidate, { status: better ? 'candidate' : 'rejected' });
  log(`${better ? 'Kept (autoPromote off)' : 'Rejected'} ${candidate}: ${reason}`);
  return { candidate, incumbent, candidateScore: cand.score, incumbentScore: inc.score, promoted: false, reason };
}

function inconclusive(candidate: string, incumbent: string, error: string): EvolveOutcome {
  return { candidate, incumbent, candidateScore: null, incumbentScore: null, promoted: false, reason: `inconclusive, infrastructure failure (${error}); candidate kept for later evaluation` };
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
