// Pure paired statistics for promotion and measurement (no IO).

export interface PairedCase {
  goal: string; // source goal: cases sharing a goal are one cluster
  taskType?: string;
  incumbent: number;
  candidate: number;
}

export interface PairedStats {
  n: number;
  clusters: number;
  gain: number;
  se: number; // cluster-robust; plain paired SE when every cluster has one case
  ci: [number, number];
}

export type PairedVerdict = 'promote' | 'reject' | 'inconclusive';

export interface PairedDecision extends PairedStats {
  verdict: PairedVerdict;
  perType: Record<string, { n: number; gain: number }>;
  reason: string;
  unproven: boolean;
}

// Paired cases needed to detect a 10 point gain at 80% power, 5% two-sided, per-case SD 0.4.
export const PROVEN_CASES = 125;

// Two-sided 95% Student t critical values by degrees of freedom; the normal value past 30.
const T95 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
export function tCritical95(df: number): number {
  if (df < 1) return Infinity;
  return df >= T95.length ? 1.96 : T95[df];
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function pairedDeltas(cases: PairedCase[]): number[] {
  return cases.map((c) => c.candidate - c.incumbent);
}

// Mean gain with a cluster-robust (CR1) standard error: residuals are summed within each source goal,
// so repeats of one goal do not masquerade as independent evidence. With G clusters the CI uses t(G-1).
export function pairedStats(cases: PairedCase[]): PairedStats {
  const n = cases.length;
  const d = pairedDeltas(cases);
  const gain = mean(d);
  const byGoal = new Map<string, number[]>();
  cases.forEach((c, i) => byGoal.set(c.goal, [...(byGoal.get(c.goal) ?? []), d[i]]));
  const G = byGoal.size;
  let se = Infinity;
  if (G >= 2) {
    if ([...byGoal.values()].every((v) => v.length === 1)) {
      se = Math.sqrt(d.reduce((a, x) => a + (x - gain) ** 2, 0) / (n - 1) / n);
    } else {
      const sumSq = [...byGoal.values()].reduce((a, v) => a + (v.reduce((s, x) => s + (x - gain), 0)) ** 2, 0);
      se = Math.sqrt((G / (G - 1)) * sumSq) / n;
    }
  }
  const half = se === 0 ? 0 : se * tCritical95(G - 1);
  return { n, clusters: G, gain, se, ci: [gain - half, gain + half] };
}

// Naive SE that ignores clustering, kept for comparison in tests and reports.
export function naiveSe(cases: PairedCase[]): number {
  const d = pairedDeltas(cases);
  const n = d.length;
  if (n < 2) return Infinity;
  const m = mean(d);
  return Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1) / n);
}

export interface PairedInput {
  cases: PairedCase[];
  niMargin: number; // a task type whose mean delta is below -niMargin vetoes promotion
  minCases: number;
}

const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : String(x));

export function pairedDecision(i: PairedInput): PairedDecision {
  const s = pairedStats(i.cases);
  const types = new Map<string, number[]>();
  for (const c of i.cases) types.set(c.taskType || 'unknown', [...(types.get(c.taskType || 'unknown') ?? []), c.candidate - c.incumbent]);
  const perType: Record<string, { n: number; gain: number }> = {};
  for (const [t, v] of types) perType[t] = { n: v.length, gain: mean(v) };
  const regressed = Object.entries(perType).filter(([, v]) => v.gain < -i.niMargin).map(([t]) => t);
  const unproven = s.n < PROVEN_CASES;
  const ci = `95% CI [${f3(s.ci[0])}, ${f3(s.ci[1])}]`;
  const done = (verdict: PairedVerdict, reason: string): PairedDecision => ({
    ...s,
    verdict,
    perType,
    unproven: verdict === 'promote' && unproven,
    reason: verdict === 'promote' && unproven ? `${reason}; unproven: ${s.n} paired cases is below ${PROVEN_CASES}` : reason,
  });
  if (s.n < i.minCases) return done('inconclusive', `only ${s.n} paired cases, need at least ${i.minCases}`);
  if (regressed.length) return done('reject', `task type ${regressed.join(', ')} regressed beyond the ${i.niMargin} margin`);
  if (s.ci[1] < 0) return done('reject', `gain ${f3(s.gain)}, ${ci} is entirely below zero`);
  if (s.ci[0] > 0) return done('promote', `gain ${f3(s.gain)}, ${ci} is above zero`);
  return done('inconclusive', `gain ${f3(s.gain)}, ${ci} includes zero`);
}

// pass@1 over n repeats with c passes.
export function passAt1(n: number, c: number): number | undefined {
  return n > 0 ? c / n : undefined;
}

// pass^k, the chance that k independent repeats all pass: unbiased C(c,k)/C(n,k). Undefined when n < k.
export function passHatK(n: number, c: number, k = 3): number | undefined {
  if (n < k || k < 1) return undefined;
  let p = 1;
  for (let j = 0; j < k; j++) p *= Math.max(0, c - j) / (n - j);
  return p;
}

// Mean of the defined per-goal values; undefined when no goal has one.
export function meanDefined(xs: (number | undefined)[]): number | undefined {
  const v = xs.filter((x): x is number => x !== undefined);
  return v.length ? mean(v) : undefined;
}

// Cohen's kappa for two raters. All-agree on one class has zero chance-disagreement: report 1, not NaN.
export function cohensKappa(a: boolean[], b: boolean[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let agree = 0, aT = 0, bT = 0;
  for (let k = 0; k < n; k++) {
    if (a[k] === b[k]) agree++;
    if (a[k]) aT++;
    if (b[k]) bT++;
  }
  const po = agree / n;
  const pe = (aT / n) * (bT / n) + (1 - aT / n) * (1 - bT / n);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}
