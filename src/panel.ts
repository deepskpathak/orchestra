// Judge panel helpers (W4.1): pure functions, no IO. The conductor owns the agent calls.

export interface PanelJudgeVote {
  judge: string; // stable id, e.g. "j1"
  model: string;
  lineage: string; // prompt lineage the judge ran under
  criteria: Record<string, boolean>; // per-criterion binary verdict
}

export interface CriterionTally {
  criterion: string;
  pass: number;
  fail: number;
  majority: boolean | null; // null without a true majority of the judges (a tie, or too few votes)
  disagreement: number; // share of voting judges in the minority; a tie counts as 0.5
}

export interface PanelAggregate {
  majority: Record<string, boolean>; // only criteria with a clear majority
  perCriterion: CriterionTally[];
  disagreement: number; // mean per-criterion disagreement, 0 when unanimous
  split: boolean; // some criterion has no clear majority
}

// A criterion needs a true majority of the judges on the panel: more than half must pass it, or more than half
// must fail it. A criterion only some judges voted on (or none, when named in `expected`) cannot be decided by
// those few, so it counts as split and goes to escalation. Missing votes never count for either side.
export function aggregatePanel(votes: PanelJudgeVote[], expected: string[] = []): PanelAggregate {
  const order: string[] = [];
  const tally = new Map<string, { pass: number; fail: number }>();
  for (const criterion of expected) {
    tally.set(criterion, { pass: 0, fail: 0 });
    order.push(criterion);
  }
  for (const v of votes) {
    for (const [criterion, pass] of Object.entries(v.criteria)) {
      let t = tally.get(criterion);
      if (!t) {
        t = { pass: 0, fail: 0 };
        tally.set(criterion, t);
        order.push(criterion);
      }
      if (pass) t.pass += 1;
      else t.fail += 1;
    }
  }
  const majority: Record<string, boolean> = {};
  const perCriterion: CriterionTally[] = order.map((criterion) => {
    const { pass, fail } = tally.get(criterion)!;
    const n = pass + fail;
    const m = pass * 2 > votes.length ? true : fail * 2 > votes.length ? false : null;
    if (m !== null) majority[criterion] = m;
    return { criterion, pass, fail, majority: m, disagreement: n === 0 ? 0.5 : Math.min(pass, fail) / n };
  });
  const disagreement = perCriterion.length ? perCriterion.reduce((a, c) => a + c.disagreement, 0) / perCriterion.length : 0;
  return { majority, perCriterion, disagreement, split: perCriterion.some((c) => c.majority === null) };
}

// pickAB: the pick when the candidates were shown as (A, B). pickBA: the pick when they were shown
// swapped, so "A" there means the original B. A winner exists only when both orders name the same candidate.
export function pairwiseBothOrders(pickAB: 'A' | 'B' | null | undefined, pickBA: 'A' | 'B' | null | undefined): 'A' | 'B' | null {
  if (pickAB !== 'A' && pickAB !== 'B') return null;
  if (pickBA !== 'A' && pickBA !== 'B') return null;
  const swappedBack = pickBA === 'A' ? 'B' : 'A';
  return pickAB === swappedBack ? pickAB : null;
}

// One framing line per lineage so panel members read different prompts.
const FRAMING: Record<string, string> = {
  strict: 'REVIEW STANCE: assume the change is wrong until the diff and the test result show otherwise. Fail any criterion that is not clearly evidenced.',
  literal: 'REVIEW STANCE: take the acceptance criteria one at a time and check each literally against the diff, ignoring the worker summary.',
  scenario: 'REVIEW STANCE: walk the hidden scenarios first, then decide each acceptance criterion by whether those scenarios would pass.',
};

export function lineageFraming(lineage: string | undefined): string {
  if (!lineage || lineage === 'default') return '';
  return FRAMING[lineage] ?? `REVIEW STANCE: review as the "${lineage}" reviewer would, independently of other reviewers.`;
}
