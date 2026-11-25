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
