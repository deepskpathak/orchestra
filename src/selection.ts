// Pure selection math for evolution: sequential testing, budget cap, cost-aware utility (no IO).
import { pairedStats, type PairedCase } from './stats.ts';

export type SequentialVerdict = 'promote' | 'reject' | 'continue';

export interface SequentialOptions {
  roundSize: number;
  totalCases?: number; // cases planned in all; the comparison is exhausted once all are seen
  niMargin?: number; // upper bound below -niMargin also rejects; default 0 (upper bound below 0)
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

// Decide from the paired cases seen so far. Promote once the 95% CI lower bound is above zero, reject once the
// upper bound is below zero (or below -niMargin), else continue. With fewer than two source goals the CI is
// unbounded, so the answer stays 'continue' until the rounds run out.
export function sequentialDecision(cases: PairedCase[], opts: SequentialOptions): SequentialDecision {
  const s = pairedStats(cases);
  const total = opts.totalCases ?? cases.length;
  const exhausted = cases.length >= total;
  const [lo, hi] = s.ci;
  const base = { ci: s.ci, gain: s.gain, n: s.n, exhausted };
  if (!Number.isFinite(s.se) || Number.isNaN(lo) || Number.isNaN(hi)) {
    return { ...base, ci: [-Infinity, Infinity], verdict: 'continue', reason: `CI not estimable from ${s.clusters} source goal(s), need 2+` };
  }
  const ci = `95% CI [${f3(lo)}, ${f3(hi)}]`;
  if (lo > 0) return { ...base, verdict: 'promote', reason: `gain ${f3(s.gain)}, ${ci} is above zero` };
  const rejectBelow = -Math.abs(opts.niMargin ?? 0);
  if (hi < 0 || hi < rejectBelow) return { ...base, verdict: 'reject', reason: `gain ${f3(s.gain)}, ${ci} is below ${hi < 0 ? 'zero' : f3(rejectBelow)}` };
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
