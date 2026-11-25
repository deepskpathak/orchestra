# H2 rerun: preregistration

Written 2026-11-25, before the run. Results are appended below and do not change this section.

## Question

H2 (verification): the M4 checks raise judge agreement with hidden checks on the bench and lower the rate of merged-but-wrong tasks. The pilot (bench `b20261027013645`, see `docs/status.md`) could not separate the arms at n = 3 and had no test command, so the agentic judge only ran planner-written scenario checks. This rerun tests one M4 mode, the agentic judge.

## Design

- **Arms** (`bench/arms.json`): `h2r-none` and `h2r-agentic`. They differ only in `verification.agenticJudge.enabled`. Both set `testCommand` to `node --test` and cap each run at `runBudgetUsd` 1.5.
- **Goals:** `rec-csv` (60 human minutes, the largest goal in the suite), `args-usage` (30 minutes, the only pilot failure) and `text-wrap` (30 minutes).
- **Repeats:** 3. That gives 9 paired cases per arm and 18 runs in total.
- **Command:** `orchestra bench --arms h2r-none,h2r-agentic --goals rec-csv,args-usage,text-wrap --repeats 3`.
- **Code:** `main` plus #120 (bench rows record `verificationModes` and `checkOutput`) and #121 (pre-flight probe change, not exercised by the bench).

## Measures

All are computed from `results.jsonl`. A run's judge passes when `judgeSatisfaction` is at least the pass threshold (0.75).

- **Agreement:** the share of runs where judge pass equals hidden check pass.
- **Merged but wrong:** runs where the judge passed and the hidden check failed.
- **Hidden check pass rate,** with the paired gain and its 95% CI from `orchestra bench`. Secondary. It has no bar.

## Bars

H2 counts as supported in this rerun only if both bars are met:

1. **B1:** agreement in `h2r-agentic` is at least 0.10 higher than in `h2r-none`, which is at least one more agreeing run out of 9.
2. **B2:** `h2r-agentic` has fewer merged-but-wrong runs than `h2r-none`.

With 9 cases per arm, a result in either direction is directional evidence only, not a confirmed effect.

## Budget and stop rules

- Expected spend is about $25, at the pilot's $1.40 per run. The hard cap is 18 x $1.50 = $27.
- Stop and report if spend reaches $35, or if a crash turns 3 or more rows into `error` rows.
- No goals, arms or bars change after the run starts.

## Results (2026-11-25)

Bench `b20261125075146`, run from a local branch holding `main`, #120 and #121. All 18 runs completed with no `error` rows.

| Arm | Hidden check pass | Judge pass | Agreement | Merged but wrong | Spend |
|---|---|---|---|---|---|
| `h2r-none` | 9 of 9 | 6 of 9 | 6 of 9 (0.67) | 0 | $20.27 |
| `h2r-agentic` | 9 of 9 | 7 of 9 | 7 of 9 (0.78) | 0 | $18.42 |

Every row in `h2r-agentic` recorded `verificationModes: ["agentic"]`, and every row in `h2r-none` recorded `[]`. No row has `checkOutput`, because no hidden check failed. The paired gain on check pass is +0.0 [+0.0, +0.0].

- **B1 is met, by one run.** Agreement is 0.11 higher in `h2r-agentic`.
- **B2 is missed.** Both arms had 0 merged-but-wrong runs.
- **H2 is not supported by this rerun.**

What the numbers show:

- **No worker failed a hidden check**, in either arm, on any of the three goals. So merged-but-wrong could not occur, and B2 could not be met. These goals are too easy to measure H2's second claim. A useful H2 measurement needs goals where workers fail the hidden check part of the time.
- **Every disagreement went the same way: the judge failed a run whose hidden check passed.** All 5 were two-task runs with satisfaction around 0.49. T1 merged, and T2 either failed (2 runs) or never got a verdict (3 runs), yet the integration branch still passed the hidden check. 4 of the 5 were `rec-csv`. The work T2 was meant to add was more than the hidden check asks for, so this measures planner over-decomposition as much as judge accuracy. The throwaway bench stores are deleted after each run, so the T2 failures cannot be inspected now.
- **The agentic arm cost less, not more:** $2.05 per run against $2.25 for `h2r-none`.

## Deviations

- **Spend.** The preregistration assumed about $1.40 per run and a hard cap of 18 x $1.50 = $27. The real cost was $2.15 per run and $38.69 in total. `runBudgetUsd` only stops tasks from being dispatched. The planner, judge and librarian still run once the cap is reached, so it does not bound a run's spend. The first three runs showed the overrun, and the user approved finishing all 18 runs before the $35 stop rule was reached. No goal, arm or bar changed.
- **Calibration tooling.** `orchestra stats` reported judge agreement of 0.00 for `agentic` and 0.07 for `none`. This was a pre-existing bug: calibration read `passThreshold` from the project config, which has no such key, so every judge verdict counted as a fail. The figures above are computed directly from `results.jsonl` at the harness threshold of 0.75. The fix is a separate PR.
