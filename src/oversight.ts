// Pure oversight helpers (W7.1 risk tiers, W7.2 oversight metrics). No IO, no imports from conductor.

export interface RiskTierConfig {
  enabled: boolean;
  lowRiskGlobs: string[];
  highRiskGlobs: string[];
  largeDiffLines: number;
}

export const DEFAULT_RISK_TIERS: RiskTierConfig = {
  enabled: false,
  lowRiskGlobs: ['docs/**', '**/*.md', 'test/**', '.github/ISSUE_TEMPLATE/**'],
  highRiskGlobs: [
    '**/auth/**', '**/*auth*', '**/*secret*', '**/migrations/**', '**/*migration*', '**/data/**',
    '**/infra/**', '**/terraform/**', '**/*.tf', '**/k8s/**', '**/Dockerfile*', '.github/workflows/**',
  ],
  largeDiffLines: 400,
};

export type RiskTier = 'low' | 'normal' | 'high';
export interface RiskInput { changedFiles: string[]; diffLines: number; deterministicGreen: boolean }
export interface RiskResult { tier: RiskTier; reasons: string[] }

const globCache = new Map<string, RegExp>();

// `**/` matches zero or more directories, `**` anything, `*` within a segment, `?` one non-slash char.
function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${out}$`, 'i');
  globCache.set(glob, re);
  return re;
}

export function matchGlob(glob: string, file: string): boolean {
  return globToRegExp(glob).test(file.replace(/\\/g, '/').replace(/^\.\//, ''));
}

const matchesAny = (globs: string[], file: string) => globs.some(g => matchGlob(g, file));

export function classifyRisk(input: RiskInput, cfg: RiskTierConfig = DEFAULT_RISK_TIERS): RiskResult {
  const high: string[] = [];
  for (const f of input.changedFiles) if (matchesAny(cfg.highRiskGlobs, f)) high.push(`high-risk path: ${f}`);
  if (input.diffLines > cfg.largeDiffLines) high.push(`large diff: ${input.diffLines} lines > ${cfg.largeDiffLines}`);
  if (high.length) return { tier: 'high', reasons: high };

  if (input.changedFiles.length > 0 && input.changedFiles.every(f => matchesAny(cfg.lowRiskGlobs, f))) {
    return { tier: 'low', reasons: ['all changed files are low-risk paths'] };
  }
  if (input.deterministicGreen) {
    return { tier: 'low', reasons: [`small diff (${input.diffLines} lines) with green deterministic checks`] };
  }
  return { tier: 'normal', reasons: ['no low-risk rule matched'] };
}

export interface ApprovalInput { approver: string; requester: string; approverKind?: 'human' | 'agent' }
export const AGENT_IDENTITIES = ['planner', 'worker', 'judge', 'librarian', 'evolver', 'orchestra'];

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

// Agents never approve their own work, and a requester never approves their own request.
export function canApprove(input: ApprovalInput): { ok: boolean; reason: string } {
  const approver = norm(input.approver);
  if (!approver) return { ok: false, reason: 'approver is empty' };
  if (input.approverKind === 'agent') return { ok: false, reason: 'agents cannot approve' };
  if (AGENT_IDENTITIES.includes(approver)) return { ok: false, reason: `approver "${approver}" is an agent role` };
  if (approver === norm(input.requester)) return { ok: false, reason: 'approver is the requester' };
  return { ok: true, reason: 'ok' };
}

export interface OversightRecord {
  runId: string;
  taskId?: string;
  needsHuman?: boolean; // task flagged needs_human
  requestedAt?: string; // approval requested (ISO)
  decidedAt?: string; // approval decided (ISO); absent while still waiting
  humanCommits?: number; // human commits between approval request and merge
}
export interface OversightMetrics { runId: string; interruptions: number; reviewMinutes: number; edits: number }

export function oversightMetrics(records: OversightRecord[]): OversightMetrics[] {
  const byRun = new Map<string, OversightMetrics>();
  for (const r of records) {
    const m = byRun.get(r.runId) ?? { runId: r.runId, interruptions: 0, reviewMinutes: 0, edits: 0 };
    if (r.needsHuman) m.interruptions++;
    if (r.requestedAt) {
      m.interruptions++;
      const start = Date.parse(r.requestedAt);
      const end = r.decidedAt ? Date.parse(r.decidedAt) : NaN;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) m.reviewMinutes += (end - start) / 60000;
      m.edits += Math.max(0, r.humanCommits ?? 0);
    }
    byRun.set(r.runId, m);
  }
  return [...byRun.values()];
}
