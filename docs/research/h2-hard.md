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

## Pilot 2 plan (approved 2026-11-28)

The user approved raising `runBudgetUsd` to $4 for `h2h-none` and `h2h-agentic` (and for the H4 arms). Pilot 2 is the same 4 runs on `main` with #128. The gate is unchanged. At about $3 per run, pilot 2 is expected to cost $12, with a $16 hard cap. If the gate says go, the full 24-run design is expected to cost about $72, with a $96 hard cap. The full run still needs its own approval.

## Pilot 2 (2026-11-28): no go

Bench `b20261128044844`, `h2h-none`, the four hard goals, 1 repeat, `runBudgetUsd` 4, on `main` with #128. Spend was $7.12.

| Goal | Hidden check | Judge satisfaction | Cost |
|---|---|---|---|
| `args-refactor-preserve` | pass | 0.97 | $2.65 |
| `calc-expr` | pass | 0.95 | $1.73 |
| `rec-csv-strict` | pass | 0.98 | $1.00 |
| `text-wrap-unicode` | pass | 0.97 | $1.74 |

0 of 4 failed the hidden check, so by the gate this is **no go**. With enough budget, workers solved all four hard goals. Under H4 (below, and `h4.md`), the same four goals were run 24 more times across two arms, and only the `h4-cost` arm failed the check on any of them. `args-string-opt` and `args-usage` failed the check 4 times, 3 of them with the judge passing the run (merged but wrong). So a third pilot should be built from those two goals plus the four hard ones, not from the hard ones alone. That needs a new pilot section and approval before any spend.

## Pilot 3 plan (written 2026-11-28, before the run)

Approved by the user on 2026-11-28. Pilot 2 showed the four hard goals alone are solved every time at `runBudgetUsd` 4. Under H4, `args-string-opt` and `args-usage` failed the hidden check 4 times, 3 of them with the judge passing (merged but wrong), so pilot 3 adds them.

- **Arm:** `h2h-none` (`runBudgetUsd` 4, `testCommand` `node --test`).
- **Goals:** `args-string-opt`, `args-usage`, `calc-expr`, `args-refactor-preserve`, `text-wrap-unicode`, `rec-csv-strict`. 1 repeat, 6 runs.
- **Code:** `main` with #133 (interleaved arms and token totals per row).
- **Gate:** go if at least 1 and at most 4 of the 6 runs fail the hidden check. If go, the full design becomes `h2h-none` and `h2h-agentic` on these six goals with 3 repeats (36 runs). That needs its own approval and budget.
- **Budget:** $0.70 to $2.90 per run depending on cache warmth, so **about $12 expected and a $24 hard cap** (6 x $4). The watchdog stops the bench at $24.

## Pilot 3 (2026-11-28): no go

Bench `b20261128123940`, on `main` with #133. Spend was $8.21, under the $24 cap.

| Goal | Hidden check | Judge satisfaction | Cost | Cache read | Cache write |
|---|---|---|---|---|---|
| `args-refactor-preserve` | pass | 0.98 | $2.25 | 537,010 | 270,610 |
| `args-string-opt` | pass | 1.00 | $1.12 | 376,410 | 129,209 |
| `args-usage` | pass | 1.00 | $0.30 | 366,895 | 29,881 |
| `calc-expr` | pass | 0.97 | $0.97 | 1,382,478 | 91,005 |
| `rec-csv-strict` | pass | 0.96 | $1.59 | 754,780 | 175,407 |
| `text-wrap-unicode` | pass | 1.00 | $1.97 | 167,683 | 237,087 |

0 of 6 failed the hidden check, so by the gate this is **no go**.

What the three pilots and H4 show together:

- **With the default config, workers almost never fail these checks.** Across pilots 2 and 3 and the `h4-base` arm, 1 run of 34 failed the check, and that one was a merged-but-wrong run (`args-usage`, H4).
- **The failures cluster in `h4-cost`.** There, 3 of 24 runs failed, all with the judge passing. That arm adds the planner cascade, so a cheaper model drafts the plan. A weaker plan seems to be what lets wrong work through, which is the situation H2 is about.
- **Cost follows cache writes.** The token fields from #133 show it directly: runs that wrote little to the cache cost $0.30 to $1.00, and runs that wrote 230,000 or more cost about $2.

**Proposed next design (not approved):** run H2 on top of the cascade config, `h2c-none` against `h2c-agentic`, both with `planner.cascade.enabled`, on `args-string-opt`, `args-usage` and the four hard goals, with 3 repeats (36 runs, about $45, $144 hard cap). It needs a new preregistration and approval. The alternative is to accept that on this suite the default config leaves almost nothing for verification to catch, and report H2 as unmeasurable here.
