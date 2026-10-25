// Pure selection math for evolution: sequential testing, budget cap, cost-aware utility (no IO).
import { pairedStats, type PairedCase } from './stats.ts';

export type SequentialVerdict = 'promote' | 'reject' | 'continue';

export interface SequentialOptions {
  roundSize: number;
  totalCases?: number; // cases planned in all; the comparison is exhausted once all are seen
  niMargin?: number; // reject only once the upper bound is below -niMargin (a loss within the margin keeps going); default 0 (upper bound below 0)
  looks?: number; // planned interim looks, for the Bonferroni-style widening; default ceil(totalCases / roundSize), 1 = one look, no widening
}

export interface SequentialDecision {
  verdict: SequentialVerdict;
  ci: [number, number];
  gain: number;
  n: number;
  exhausted: boolean; // no more rounds to run
  reason: string;
}

// Split cases into consecutive rounds of roundSize (the last may be short). A size below 1 means one round.
export function roundsOf<T>(cases: T[], roundSize: number): T[][] {
  const size = Math.floor(roundSize) >= 1 ? Math.floor(roundSize) : Math.max(cases.length, 1);
  const out: T[][] = [];
  for (let i = 0; i < cases.length; i += size) out.push(cases.slice(i, i + size));
  return out;
}

const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : String(x));

// Standard normal CDF (Numerical Recipes erfc approximation, relative error about 1e-7).
function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - 0.5 * erfc : 0.5 * erfc;
}

// Upper-tail normal quantile by bisection (p in (0, 0.5]).
function normQuantileUpper(p: number): number {
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (1 - normCdf(mid) > p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Peeking at a 95% CI after every round inflates the type I error. Bonferroni-style spending: with L planned looks
// each look uses alpha 0.05 / L, so the family-wise error stays at or below 0.05. Returns the factor that scales a
// 95% interval half-width up to the 1 - 0.05 / L level (a normal-quantile ratio, applied to the t interval).
export function wideningFactor(looks: number): number {
  const l = Math.max(1, Math.floor(looks));
  if (l === 1) return 1;
  return normQuantileUpper(0.025 / l) / normQuantileUpper(0.025);
}

// Decide from the paired cases seen so far. Promote once the (widened) CI lower bound is above zero, reject once the
// upper bound is below -niMargin (zero by default), else continue. The CI is widened for the planned number of
// looks, see wideningFactor. With fewer than two source goals the CI is unbounded, so the answer stays 'continue'
// until the rounds run out.
export function sequentialDecision(cases: PairedCase[], opts: SequentialOptions): SequentialDecision {
  const s = pairedStats(cases);
  const total = opts.totalCases ?? cases.length;
  const exhausted = cases.length >= total;
  const looks = opts.looks ?? (opts.totalCases ? Math.ceil(opts.totalCases / Math.max(1, opts.roundSize)) : 1);
  const factor = wideningFactor(looks);
  const [rawLo, rawHi] = s.ci;
  const mid = (rawLo + rawHi) / 2;
  const lo = Number.isFinite(rawLo) ? mid - (mid - rawLo) * factor : rawLo;
  const hi = Number.isFinite(rawHi) ? mid + (rawHi - mid) * factor : rawHi;
  const base = { ci: [lo, hi] as [number, number], gain: s.gain, n: s.n, exhausted };
  if (!Number.isFinite(s.se) || Number.isNaN(lo) || Number.isNaN(hi)) {
    return { ...base, ci: [-Infinity, Infinity], verdict: 'continue', reason: `CI not estimable from ${s.clusters} source goal(s), need 2+` };
  }
  const level = looks > 1 ? `${(100 - 5 / looks).toFixed(1)}% CI (${looks} planned looks)` : '95% CI';
  const ci = `${level} [${f3(lo)}, ${f3(hi)}]`;
  if (lo > 0) return { ...base, verdict: 'promote', reason: `gain ${f3(s.gain)}, ${ci} is above zero` };
  const rejectBelow = -Math.abs(opts.niMargin ?? 0);
  if (hi < rejectBelow) return { ...base, verdict: 'reject', reason: `gain ${f3(s.gain)}, ${ci} is below ${rejectBelow === 0 ? 'zero' : f3(rejectBelow)}` };
  return { ...base, verdict: 'continue', reason: `gain ${f3(s.gain)}, ${ci} includes zero` };
}

// Tracks spend against a hard cap. A cap of 0, negative or undefined means unlimited.
export class BudgetTracker {
  spent = 0;
  readonly cap: number;

  constructor(cap?: number) {
    this.cap = cap && cap > 0 ? cap : 0;
  }

  get unlimited(): boolean {
    return this.cap === 0;
  }

  add(cost: number): void {
    if (Number.isFinite(cost) && cost > 0) this.spent += cost;
  }

  wouldExceed(nextEstimate: number): boolean {
    return !this.unlimited && this.spent + Math.max(0, nextEstimate || 0) > this.cap;
  }

  get exhausted(): boolean {
    return !this.unlimited && this.spent >= this.cap;
  }
}

export interface Outcome {
  score: number; // 0..1
  costUsd: number;
  durationMs: number;
}

export interface UtilityWeights {
  costWeight: number; // score lost per USD
  timeWeight: number; // score lost per minute
}

// SICA style: utility = score - costWeight * USD - timeWeight * minutes.
export function utility(o: Outcome, w: UtilityWeights): number {
  return o.score - w.costWeight * Math.max(0, o.costUsd) - w.timeWeight * (Math.max(0, o.durationMs) / 60000);
}

export interface CostGateInput {
  incumbent: Pick<Outcome, 'score' | 'costUsd'>;
  candidate: Pick<Outcome, 'score' | 'costUsd'>;
  maxCostRisePct: number;
  minGainForCost: number;
}

export interface CostGateResult {
  ok: boolean;
  risePct: number | null; // null when the incumbent cost is zero (no baseline)
  gain: number;
  reason: string;
}

// Reject a candidate whose cost rises more than maxCostRisePct unless quality rose by at least minGainForCost.
export function costGate(i: CostGateInput): CostGateResult {
  const gain = i.candidate.score - i.incumbent.score;
  const base = i.incumbent.costUsd;
  const risePct = base > 0 ? ((i.candidate.costUsd - base) / base) * 100 : null;
  if (risePct === null || risePct <= i.maxCostRisePct) return { ok: true, risePct, gain, reason: 'cost within limit' };
  if (gain >= i.minGainForCost) return { ok: true, risePct, gain, reason: `cost up ${risePct.toFixed(0)}% but gain ${f3(gain)} meets ${i.minGainForCost}` };
  return { ok: false, risePct, gain, reason: `cost up ${risePct.toFixed(0)}% (limit ${i.maxCostRisePct}%) with gain ${f3(gain)} below ${i.minGainForCost}` };
}
