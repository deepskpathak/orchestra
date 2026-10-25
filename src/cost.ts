// Cost-control helpers: plan cascade, budget lines, best-of-n gate, cache share. Pure, no IO.

export interface PlanTaskLike {
  id: string;
  deps?: string[];
  acceptance?: string[];
}

// Deterministic plan checks. Returns human-readable issues; empty means clean.
export function planChecks(tasks: PlanTaskLike[]): string[] {
  const issues: string[] = [];
  if (!tasks || tasks.length === 0) return ['plan has no tasks'];
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const d of t.deps ?? []) if (!ids.has(d)) issues.push(`${t.id} depends on unknown task ${d}`);
    if (!t.acceptance || t.acceptance.filter((a) => a && a.trim()).length === 0) issues.push(`${t.id} has no acceptance criteria`);
  }
  // Cycle detection (DFS colouring), ignoring unknown deps already reported.
  const state = new Map<string, 1 | 2>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let cycle: string | undefined;
  const visit = (id: string, path: string[]): void => {
    if (cycle) return;
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { cycle = [...path.slice(path.indexOf(id)), id].join(' -> '); return; }
    state.set(id, 1);
    for (const d of byId.get(id)?.deps ?? []) if (byId.has(d)) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
  if (cycle) issues.push(`dependency cycle: ${cycle}`);
  return issues;
}

export function shouldEscalatePlan(o: { confidence?: number; threshold: number; issues: string[] }): { escalate: boolean; reason: string } {
  if (o.issues.length > 0) return { escalate: true, reason: `deterministic plan check failed: ${o.issues[0]}` };
  if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence)) return { escalate: true, reason: 'draft plan reported no confidence' };
  if (o.confidence < o.threshold) return { escalate: true, reason: `confidence ${o.confidence} below threshold ${o.threshold}` };
  return { escalate: false, reason: `confidence ${o.confidence} meets threshold ${o.threshold} and checks are clean` };
}

export interface BudgetState {
  turnsUsed: number;
  maxTurns: number;
  usdSpent: number;
  usdCap: number;
}

export function budgetLine(b: BudgetState): string {
  const turns = Math.max(0, b.maxTurns - b.turnsUsed);
  const usd = Math.max(0, b.usdCap - b.usdSpent);
  return `Budget: ${turns} turns remaining of ${b.maxTurns}, $${usd.toFixed(2)} remaining of a $${b.usdCap.toFixed(2)} hard cap. Stop and report when either runs out.`;
}

export function budgetExhausted(b: BudgetState): boolean {
  return b.turnsUsed >= b.maxTurns || b.usdSpent >= b.usdCap;
}

// Extra samples only where an executable verifier (test command or scenario checks) exists.
export function bestOfNAllowed(o: { n: number; hasExecutableVerifier: boolean }): number {
  if (!o.hasExecutableVerifier) return 1;
  return Math.max(1, Math.floor(o.n) || 1);
}

export interface TestCandidate {
  id: string;
  testsPassed: number;
  testsTotal: number;
  distinguishingPasses?: number;
}

// Winner by passing tests, then distinguishing inputs. undefined on a tie: a judge is needed.
export function selectBestByTests(cands: TestCandidate[]): TestCandidate | undefined {
  if (cands.length === 0) return undefined;
  if (cands.length === 1) return cands[0];
  const sorted = [...cands].sort((a, b) => b.testsPassed - a.testsPassed || (b.distinguishingPasses ?? 0) - (a.distinguishingPasses ?? 0));
  const [a, b] = sorted;
  if (a.testsPassed === b.testsPassed && (a.distinguishingPasses ?? 0) === (b.distinguishingPasses ?? 0)) return undefined;
  return a;
}

export interface TokenRow {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function cacheReadShare(rows: TokenRow[]): number | undefined {
  let input = 0, read = 0, write = 0, seen = false;
  for (const r of rows) {
    if (r.inputTokens === undefined && r.cacheReadTokens === undefined && r.cacheWriteTokens === undefined) continue;
    seen = true;
    input += r.inputTokens ?? 0; read += r.cacheReadTokens ?? 0; write += r.cacheWriteTokens ?? 0;
  }
  const total = input + read + write;
  if (!seen || total === 0) return undefined;
  return read / total;
}
