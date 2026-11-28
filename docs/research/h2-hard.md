# H2 on hard goals: preregistration (draft)

Written 2026-11-28. **Not run.** This is a draft for approval. Nothing below is spent until the user approves the pilot and its budget. Results will be appended below the preregistration and will not change it.

## Why another H2 run

Both earlier H2 runs (the pilot `b20261027013645` and the rerun `b20261125075146`, see [h2-rerun.md](h2-rerun.md)) had workers pass every hidden check, so merged-but-wrong never happened and bar B2 could not be met. This design adds goals built so that workers fail the hidden check part of the time. It also keeps the store and branch diffs of every failed run, so a failure can be read after the run.

## Design

- **Arms** (`bench/arms.json`): `h2h-none` and `h2h-agentic`. They differ only in `verification.agenticJudge.enabled`. Both set `testCommand` to `node --test` and `runBudgetUsd` to 3.
- **Goals:** the four hard goals `calc-expr`, `args-refactor-preserve`, `text-wrap-unicode` and `rec-csv-strict` (see [bench.md](../bench.md)). Each states every rule its hidden check tests. The difficulty is in the number of rules and how they interact, not in hidden requirements.
- **Repeats:** 3. That gives 12 paired cases per arm and 24 runs in total.
- **Command:** `orchestra bench --arms h2h-none,h2h-agentic --goals calc-expr,args-refactor-preserve,text-wrap-unicode,rec-csv-strict --repeats 3`.
- **Code:** `main` with the `runBudgetUsd` ceiling (#124). Without it, `runBudgetUsd` 3 does not bound a run's spend.

## Pilot gate

Before the full run, do one pilot: `h2h-none` only, the four goals, 1 repeat (4 runs).

- **Go** if at least 1 and at most 3 of the 4 pilot runs fail the hidden check. Then merged-but-wrong can happen, and the goals are not so hard that every run fails.
- **No go** if 0 or 4 of 4 fail. Then change the goal set (add or drop goals) and write a new pilot section here before any further spend.
- The pilot rows are not counted in the full run.

## Measures

All are computed from `results.jsonl`. A run's judge passes when `judgeSatisfaction` is at least the pass threshold (0.75).

- **Agreement:** the share of runs where judge pass equals hidden check pass.
- **Merged but wrong:** runs where the judge passed and the hidden check failed.
- **Hidden check pass rate,** with the paired gain and its 95% CI from `orchestra bench`. Secondary. It has no bar.

## Bars

H2 counts as supported in this run only if both bars are met:

1. **B1:** agreement in `h2h-agentic` is at least 0.10 higher than in `h2h-none` (at least 2 more agreeing runs out of 12).
2. **B2:** `h2h-agentic` has fewer merged-but-wrong runs than `h2h-none`, and `h2h-none` has at least 2 (so the difference is not a single run).

With 12 cases per arm, a result in either direction is directional evidence only, not a confirmed effect.

## Budget and stop rules

The 2026-11-25 rerun cost $2.15 per run on easier goals. These goals are larger, so assume $2.50 per run.

| Step | Runs | Expected | Hard cap (`runBudgetUsd` 3 each) |
|---|---|---|---|
| Pilot | 4 | $10 | $12 |
| Full run | 24 | $60 | $72 |

- Stop and report if the full run's spend reaches $75, or if a crash turns 3 or more rows into `error` rows.
- Claude Code checks `--max-budget-usd` between turns, so a run can end up to one turn past its ceiling. The hard caps above can be passed by that margin.
- No goals, arms or bars change after the full run starts.

## Checked at zero cost (2026-11-28)

- `orchestra bench --verify-oracles` passes for all four goals: each oracle passes its check, and each check fails on the unmodified fixture.
- `npm test` loads the new goals and arms.

## Pilot 1 (2026-11-28): invalid, budget-bound

Bench `b20261128035158`, `h2h-none`, the four hard goals, 1 repeat, on `main` with #124. Spend was $10.86 against a $10 estimate and the $12 cap.

| Goal | Hidden check | Judge satisfaction | Tasks | Cost |
|---|---|---|---|---|
| `args-refactor-preserve` | fail | 0.49 | T1 pass, T2 judge not started | $3.00 |
| `calc-expr` | pass | 0.98 | T1 pass, T2 pass | $2.92 |
| `rec-csv-strict` | pass | 0.48 | T1 pass, T2 worker not started | $2.00 |
| `text-wrap-unicode` | pass | 0.98 | T1 pass, T2 pass | $2.93 |

On its face, 1 of 4 failed the check, which is a go. **The result is not valid**, because the $3 ceiling decided both failures:

- **`args-refactor-preserve`** reached $3.00 before T2's judge could start, so T2 (the `tokenize` export) never merged and the check failed. The worker did not get it wrong.
- **`rec-csv-strict`** T2 failed with "run budget $3 exhausted" while $2.07 was unspent. A sibling worker had reserved the whole remainder. That was a bug in #124, fixed in #128.
- The two runs that finished cleanly cost $2.92 and $2.93, so a full two-task run on these goals needs more than $3.

**Deviation:** before a second pilot, `runBudgetUsd` for `h2h-none` and `h2h-agentic` must go up (to $4 is proposed), and the budget table above must be redone at about $3 per run. That needs approval. The kept stores are in `.orchestra/bench/b20261128035158/kept/`.
