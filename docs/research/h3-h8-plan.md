# H1 check and H3 to H8 preregistration plan

Written 2026-11-28. **Nothing here has been run, and no spend is approved.** Each experiment below needs its own approval of the budget before it starts. Results will be appended to a per-experiment file and will not change this plan.

The hypotheses are defined in [closing-the-gaps.md](closing-the-gaps.md) section 7 (H1 to H5) and [repo-context-atlas.md](repo-context-atlas.md) section 6 (H6 to H8). H2 has its own files: [h2-rerun.md](h2-rerun.md) and [h2-hard.md](h2-hard.md).

## Common rules

- **Cost per run.** Estimates use the measured cost of a bench run, $2.15 (the 2026-11-25 H2 rerun), rounded up to $2.50 for larger goals and $3.00 for multi-task goals. Earlier estimates used $1.40 and were 54% low.
- **Ceiling.** Every arm sets `runBudgetUsd`, which is a real ceiling once #124 is merged. Before #124 it only stopped dispatch, so no experiment here should run without it. Claude Code checks `--max-budget-usd` between turns, so a run can end up to one turn past its ceiling.
- **Scale.** Section 7 of closing-the-gaps.md estimates about 125 paired cases to detect a 10-point gain at 80% power. That is about $550 per two-arm experiment at $2.20 per run. Every design below is **directional** (12 to 24 paired cases). A result at that size is reported as directional evidence, never as a confirmed effect.
- **Stop rules, for every experiment.** Stop and report if spend reaches 110% of the expected spend, or if a crash turns 3 or more rows into `error` rows. Arms, goals and bars do not change once a run starts.
- **Reporting.** Every run is reported, including negative and inconclusive ones, with cost next to quality and the exact harness and config versions.

## H1 (integrity): checked 2026-11-28, still not measurable

H1 says that no promoted variant shows a gain on its own judge that disappears under the frozen scorer. Measuring it needs at least one promotion made under the frozen scorer.

The archives of the five local projects that use Orchestra were read on 2026-11-28:

- **New evolution cycles since 0.8.0** ran in two projects (2026-11-14 to 2026-11-21): one seed, and four variants of which one was rejected and three are still candidates.
- **No variant has been promoted** in any project, except the seed `v1`.
- In one project every eval replay scored 0, for the seed and the rejected variant alike. Those replays ended `failed`, with tasks that needed a human or were blocked, so they never reached the frozen scorer. That is a correct score of 0, not a scorer fault.
- Four runs on 2026-11-21 failed at planning with "Failed to authenticate: this login reached its time limit". Evolution cycles that run unattended need a login that does not expire.

So H1 has no data yet. **No spend is proposed.** Check the archives again after the next promotion. Re-scoring also needs the eval-run branches, which `evalCase` deletes after scoring (`src/evolve.ts`), so keep the diff or the branch of any promoted variant's replays (the same idea as the bench `kept` directories in #125).

## H3 (evolution): wait for a promotion

**Claim:** a promoted harness beats its parent on the locked, time-split holdout, not only on the validation set.

- **Prerequisite:** a promotion under the frozen scorer with `evolve.splits` enabled, so that a holdout exists. There is none yet (see H1).
- **Design, once one exists:** replay every holdout case with the promoted version and with its parent, 3 repeats each, scored by the frozen scorer. The holdout is the newest 20% of cases (`DEFAULT_RATIOS` in `src/evalsets.ts`), so a project needs about 30 eval cases before its holdout reaches 6.
- **Measure:** the paired difference in frozen score per holdout case, with its 95% CI.
- **Bar:** supported if the mean holdout difference is above 0 and at least half of the validation-set gain. Unproven if the CI includes 0.
- **Budget:** 6 holdout cases x 2 versions x 3 repeats = 36 replays at $2.50, so **$90 expected and a $108 hard cap**.

## H4 (cost): ready to run

**Claim:** the planner cascade and cache discipline cut cost per accepted merge with no significant drop in success.

- **Arms:** `h4-base` (default config, `testCommand` `node --test`, `runBudgetUsd` 3) and `h4-cost` (the same, plus `planner.cascade.enabled` and `cache.discipline.enabled` with `warmFirst`). Add both to `bench/arms.json` at the start of the run.
- **Goals:** 8 goals that usually plan into more than one task, so sibling workers can share a cached prefix: `rec-csv`, `rec-csv-strict`, `rec-pivot`, `args-usage`, `args-string-opt`, `text-wrap`, `text-wrap-unicode`, `calc-expr`.
- **Repeats:** 3, giving 24 paired cases per arm and 48 runs.
- **Measures:** cost per accepted run (the sum of `costUsd` over runs whose hidden check passed, divided by their count), and the hidden check pass rate.
- **Bars:** B1, cost per accepted run is at least 15% lower in `h4-cost`. B2, its check pass rate is at most 1 run in 24 lower than `h4-base`'s. Supported only if both are met.
- **Budget:** 48 runs at $2.20, so **$106 expected and a $144 hard cap** (48 x $3).
- **Prerequisites:** none beyond #124 and the hard goals in #125.

## H5 (throughput): needs bench fields and multi-task goals

**Claim:** footprint batching cuts merge wait without raising the post-merge breakage rate.

- **Prerequisites:**
  1. Bench rows must record each task's `mergeWaitMs` and the run's `conflictRate`. Today they live only in the run file, which the bench repo deletes.
  2. Goals that plan into at least 3 independent tasks. The current goals plan into 1 or 2, so batching has nothing to batch. Add 6 composite goals (for example, three unrelated helpers in three files of one fixture), each with a hidden check and an oracle.
- **Arms:** `h5-off` (concurrency 3, `throughput` off) and `h5-on` (concurrency 3, `throughput.footprintScheduling` and `throughput.batchMerge` with `maxBatch` 3). Both use `runBudgetUsd` 4.
- **Repeats:** 3 on the 6 composite goals, giving 18 paired cases per arm and 36 runs.
- **Measures:** median `mergeWaitMs` per run. Breakage means the hidden check failing on the integration branch after every task merged.
- **Bars:** B1, median merge wait is at least 20% lower in `h5-on`. B2, breakage in `h5-on` is at most 1 run more than in `h5-off`.
- **Budget:** 36 runs at $3.00, so **$108 expected and a $144 hard cap** (36 x $4).

## H6, H7 and H8 (atlas): one experiment, needs a larger fixture

H6 (worker tokens per accepted merge cut by at least 15%, success non-inferior within 2 points), H7 (planner footprint recall of at least 80% at file level with the atlas) and H8 (the atlas does not raise cost) can all be measured from the same runs.

- **Prerequisites:**
  1. **A larger fixture.** The bench fixtures have 1 to 3 source files, so a repo map has nothing to locate. Add one fixture with at least 50 source files across several directories (for example, a pinned snapshot of a small dependency-free open source library, licence permitting), plus 8 goals on it with hidden checks and oracles.
  2. **Bench row fields:** worker input, output and cache tokens summed from the run's ledger, and the footprint precision and recall from the ledger's merged-outcome `footprint` rows. Today both live only in the deleted bench store.
- **Arms:** the existing `atlas-off` and `atlas-l0-l1`, each with `runBudgetUsd` 4.
- **Repeats:** 3 on the 8 new goals, giving 24 paired cases per arm and 48 runs.
- **Bars:**
  - **H6:** worker tokens per accepted run are at least 15% lower with the atlas, and the check pass rate is at most 2 points lower (on 24 runs, no more than 0 runs lower).
  - **H7:** mean file-level footprint recall with the atlas is at least 0.80, and higher than without it.
  - **H8:** mean `costUsd` per run with the atlas is no more than 5% above `atlas-off`. If it is higher, cut `mapTokens` before anything else, as the atlas plan says.
- **Budget:** 48 runs at $3.00, so **$144 expected and a $192 hard cap** (48 x $4).

## Recommended order

1. **H4.** It is ready once #124 and #125 merge, and it is the cheapest to read.
2. **H2 on hard goals** (h2-hard.md). Its $10 pilot also tells whether the hard goals fail often enough to be useful for H4's success bar.
3. **The bench row fields** that H5 and H6 to H8 need. This is code only, with no spend.
4. **H5 and H6 to H8,** after their goals and fixture exist.
5. **H3 and H1,** when a promotion exists.

| Experiment | Runs | Expected | Hard cap | Ready |
|---|---|---|---|---|
| H4 | 48 | $106 | $144 | after #124 and #125 |
| H5 | 36 | $108 | $144 | needs bench fields and 6 goals |
| H6 to H8 | 48 | $144 | $192 | needs a fixture, 8 goals and bench fields |
| H3 | 36 | $90 | $108 | needs a promotion |
| H1 | 0 | $0 | $0 | needs a promotion |
