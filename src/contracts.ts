// W4.3 machine-readable acceptance contracts. Pure: no file or process IO.
// The planner's acceptance criteria are frozen into a feature list. Workers can flip a criterion
// from failing to passing and nothing else; ids, text, count and invariants never change.

import { createHash } from 'node:crypto';

export type CriterionStatus = 'failing' | 'passing';

export interface Criterion {
  id: string; // e.g. T1.c1
  task: string;
  text: string;
  status: CriterionStatus;
  invariants: string[]; // planner-written invariants of the owning task, consumed by oracles
}

export interface Contract {
  criteria: Criterion[];
}

export interface Ambiguity {
  question: string;
  resolution?: string;
}

interface ContractTask {
  id: string;
  acceptance: string[];
  invariants?: string[];
}

export function buildContract(tasks: ContractTask[]): Contract {
  const criteria: Criterion[] = [];
  for (const t of tasks) {
    t.acceptance.forEach((text, i) =>
      criteria.push({ id: `${t.id}.c${i + 1}`, task: t.id, text, status: 'failing', invariants: [...(t.invariants ?? [])] }),
    );
  }
  return { criteria };
}

// Canonical JSON, so identical input always hashes the same.
export function contractSha(contract: Contract): string {
  const canon = contract.criteria.map((c) => ({ id: c.id, task: c.task, text: c.text, status: c.status, invariants: c.invariants }));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// The only allowed mutation. Returns a new contract; throws on an unknown id.
export function markPassing(contract: Contract, criterionId: string): Contract {
  if (!contract.criteria.some((c) => c.id === criterionId)) throw new Error(`Unknown criterion ${criterionId}`);
  return { criteria: contract.criteria.map((c) => (c.id === criterionId ? { ...c, status: 'passing' as const } : c)) };
}

// One task's frozen acceptance text (in criterion order) and invariants, as the judge and the oracle author read them.
export function criteriaForTask(contract: Contract, taskId: string): { acceptance: string[]; invariants: string[] } {
  const own = contract.criteria.filter((c) => c.task === taskId);
  return { acceptance: own.map((c) => c.text), invariants: own[0]?.invariants ?? [] };
}

export type ContractUpdate = { ok: true; contract: Contract } | { ok: false; errors: string[] };

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// Validates a worker-proposed contract against the frozen one. Accepts only failing->passing flips
// (and unchanged criteria); anything else is rejected with every violation listed.
export function applyContractUpdate(old: Contract, proposed: unknown): ContractUpdate {
  const list = (proposed as Contract | undefined)?.criteria;
  if (!Array.isArray(list)) return { ok: false, errors: ['proposed contract has no criteria list'] };
  const errors: string[] = [];
  if (list.length !== old.criteria.length) errors.push(`criterion count changed (${old.criteria.length} -> ${list.length})`);
  old.criteria.forEach((o, i) => {
    const p = list[i];
    if (!p) return errors.push(`criterion ${o.id} removed`);
    if (p.id !== o.id) errors.push(`criterion id changed at position ${i + 1} (${o.id} -> ${p.id})`);
    if (p.task !== o.task) errors.push(`${o.id}: task changed`);
    if (p.text !== o.text) errors.push(`${o.id}: text changed`);
    if (!Array.isArray(p.invariants) || !sameList(p.invariants, o.invariants)) errors.push(`${o.id}: invariants changed`);
    if (p.status !== 'failing' && p.status !== 'passing') errors.push(`${o.id}: invalid status ${JSON.stringify(p.status)}`);
    else if (o.status === 'passing' && p.status === 'failing') errors.push(`${o.id}: passing -> failing is not allowed`);
  });
  return errors.length ? { ok: false, errors } : { ok: true, contract: { criteria: list.map((c) => ({ ...c })) } };
}

// Ambiguities the planner left open: no resolution, or a blank one.
export function unresolvedAmbiguities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const a of raw) {
    const q = typeof a === 'string' ? a : String((a as Ambiguity)?.question ?? '').trim();
    const r = typeof a === 'string' ? '' : String((a as Ambiguity)?.resolution ?? '').trim();
    if (!r) out.push(q || '(unspecified question)');
  }
  return out;
}

// True for a path inside the store's runs/<id>/contract.json.
export function isContractPath(path: string): boolean {
  return /(^|\/)\.orchestra\/runs\/[^/]+\/contract\.json$/.test(path.replace(/\\/g, '/'));
}
