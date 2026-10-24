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
import { fireRateByVersion, MONITOR_MARK } from './integrity.ts';
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
async function evalCase(store: Store, runner: Runner, version: string, c: EvalCase, onRun: ((r: Run) => void) | undefined, scorer: Scorer): Promise<CaseOutcome> {
  const run = await runGoal({ store, runner, goal: c.goal, harnessVersion: version, baseRef: c.base, kind: 'eval', onUpdate: onRun });
  let cost = run.costUsd;
  if (isInfraFailure(run)) {
    deleteRunBranches(store, run);
    return { ok: false, score: 0, cost, inconclusive: run.error };
  }
  // Promotion scores come from the frozen scorer. run.satisfaction is the candidate's own
  // judge and stays advisory (repair notes), so a harness cannot grade itself into promotion.
  let ok = run.status === 'done';
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

export async function evaluate(store: Store, runner: Runner, version: string, cases: EvalCase[], onRun?: (r: Run) => void, scorer: Scorer = loadScorer()): Promise<EvalResult> {
  const tally = new EvalTally(version);
  for (const c of cases) {
    tally.add(c, await evalCase(store, runner, version, c, onRun, scorer));
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
}

export interface PromotionInput {
  incumbentScores: number[]; // per-case scores, same order as candidateScores
  candidateScores: number[];
  regressions: string[];
  minGain: number;
  minCases: number;
  incumbent?: string;
  monitorFireRate?: { incumbent: number; candidate: number }; // integrity-monitor flags per run
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  gain: number;
  spread: number;
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
  const out = (promote: boolean, reason: string): PromotionDecision => ({ promote, reason, gain: round(gain), spread: round(spread) });
  if (n < i.minCases) return out(false, `only ${n} eval cases, need at least ${i.minCases}`);
  if (i.regressions.length) return out(false, `regressed on ${i.regressions.join(', ')}`);
  const mon = i.monitorFireRate;
  // Rates are flags per replayed run, so scale the difference back to a flag count (one run per case).
  if (mon && (mon.candidate - mon.incumbent) * n > MONITOR_SLACK_FLAGS + 1e-9) {
    return out(false, `integrity monitor fire rate ${mon.candidate.toFixed(3)} per run exceeds incumbent ${mon.incumbent.toFixed(3)} by more than ${MONITOR_SLACK_FLAGS} flag: candidate edits grading files or weakens tests more often`);
  }
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
    // Monitor output must never reach the evolver, or it could learn to evade the monitor.
    .flatMap((r) => r.tasks.flatMap((t) => [...t.notes, ...(t.status === 'failed' ? [`${t.id} FAILED: ${t.verdict?.summary ?? ''}`] : [])]))
    .filter((n) => !n.includes(MONITOR_MARK))
    .slice(-40);
  const files = EVOLVABLE_FILES.map((f) => `--- ${f} ---\n${existsSync(store.path('harness', incumbent, f)) ? readFileSync(store.path('harness', incumbent, f), 'utf8') : ''}`).join('\n\n');
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
  const pair = await evaluatePair(store, runner, incumbent, candidate, cases, onRun);
  const inc = pair.incumbent;
  const cand = pair.candidate;
  const infra = { incumbent: inc.infraFailureRate, candidate: cand.infraFailureRate };
  const rates = `infra failure rate: incumbent ${inc.infraFailureRate}, candidate ${cand.infraFailureRate}`;
  // Leave the archive as it was: a half-run evaluation must not mark anything rejected.
  if (inc.inconclusive) return inconclusive(candidate, incumbent, inc.inconclusive, rates);
  updateArchive(store, incumbent, { evalScore: inc.score, evalDetail: inc.detail, evalInfraRate: inc.infraFailureRate });
  updateArchive(store, candidate, { evalScore: cand.score, evalDetail: cand.detail, evalInfraRate: cand.infraFailureRate });

  const regressions = cases.filter((c) => inc.passed[c.id] && !cand.passed[c.id]).map((c) => c.id);
  const monitor = { incumbent: inc.monitorFireRate ?? 0, candidate: cand.monitorFireRate ?? 0 };
  const decision = promotionDecision({
    incumbentScores: cases.map((c) => inc.detail[c.id] ?? 0),
    candidateScores: cases.map((c) => cand.detail[c.id] ?? 0),
    regressions,
    minGain: cfg.evolve.minGain,
    minCases: cfg.evolve.minCases,
    incumbent,
    monitorFireRate: monitor,
  });
  const better = decision.promote;
  const reason = decision.reason;

  if (better && cfg.evolve.autoPromote) {
    promote(store, candidate);
    log(`Promoted ${candidate}: ${reason}`);
    return { candidate, incumbent, candidateScore: cand.score, incumbentScore: inc.score, promoted: true, reason, infraFailureRate: infra, monitorFireRate: monitor };
  }
  updateArchive(store, candidate, { status: better ? 'candidate' : 'rejected' });
  log(`${better ? 'Kept (autoPromote off)' : 'Rejected'} ${candidate}: ${reason}`);
  return { candidate, incumbent, candidateScore: cand.score, incumbentScore: inc.score, promoted: false, reason, infraFailureRate: infra, monitorFireRate: monitor };
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
