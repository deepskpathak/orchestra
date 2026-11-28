# Project status

Last updated 2026-11-28.

## Where things stand

Every milestone in the [Closing the gaps](research/closing-the-gaps.md) plan is implemented and merged to `main`. Every new capability is opt-in and off by default, so a default run behaves as it did before M2.

| Milestone | Merge order | PR | Tests at merge |
|---|---|---|---|
| M1 Integrity | first | #64 | n/a |
| M2 Measurement | 1/6 | #66 | 231 |
| M5 Isolation | 2/6 | #67 | 271 |
| W9a Repo Atlas core | 3/6 | #68 | 311 |
| M3 Evolution | 4/6 | #69 | 395 |
| M4 Verification | 5/6 | #70 | 485 |
| M6 Throughput and oversight (with W9.3 to W9.5) | 6/6 | #71 | 572 |

Each milestone went through its own branch, a code review with one fix commit per finding, the smoke test (`npm run demo`, 4 of 4 tasks merged) and a CI-gated merge. Orchestra built most of each milestone itself. For M3, M4 and M6 it landed 6 of 8 or 9 tasks, and the rest were finished by hand; the PR bodies say which.

## Since 0.8.0 (2026-11-25)

- **Merged:** the GitHub Pages site in `site/` (#87), and on 2026-11-28:
  - #122 fixes judge calibration, which read `passThreshold` from the wrong config, so `orchestra stats` and the `evolve.minJudgeAgreement` gate counted every judge verdict as a fail.
  - #120 makes bench rows record `verificationModes` and, when a check fails, `checkOutput`.
  - #121 builds the sandbox pre-flight probes through the worker code path and adds an argv check for the claude backend.
- **Open PRs:**
  - #88 holds the W8 plan.
- **Open epics:** W8 (#89 to #105) makes Orchestra runtime and model agnostic. W10 (#106 to #119) is the OneAM integration R&D.
- **H2 rerun:** 18 runs, $38.69. H2 is not supported; see below and [the preregistration and results](research/h2-rerun.md).
- **Real runs on 2026-11-25:** one `--sandbox claude` run with the #121 probe, and one run with a deliberately low budget cap; see below.

## What is built but not yet proven

The test suite runs against fakes and injected executors. Two real runs on 2026-10-27 (see below) exercised the Claude Code sandbox backend, the atlas, batch merge, the judge panel and budgets. The following are still unproven against the real tool:

- **OS sandbox backends (M5) other than Claude Code's.** srt, docker and sandbox-exec have not run a real worker. srt and docker are not installed on the development machine, so the 2026-11-25 round could not run them. The srt settings shape and the Claude Code sandbox keys and `//` permission-rule syntax were checked against their docs on 2026-10-26 (#74), and that check fixed an srt argv bug that made every srt worker fail closed.
- **Budget caps (M6).** Reached for the first time on 2026-11-25 (run `r20261125-1553-rueo`, `runBudgetUsd` 0.1). The planner spent $0.88, so the only task failed with "run budget $0.1 exhausted" and no worker started, as documented. But the librarian still ran ($0.40), so the run spent $1.28 against a $0.10 cap. `runBudgetUsd` stops dispatch. It is not a spend ceiling. The budget line logging from #84 has still not been exercised, because no worker ran.
- **universal-ctags and graphify inputs (W9.5).** Optional, detect-and-degrade.
- **The research hypotheses H1 to H8.** M2 built the machinery (`orchestra bench`, paired statistics, ablations, judge calibration). H1 and H2 have a first look (below); H3 to H8 are unmeasured.

## Real end-to-end runs (2026-10-27)

Two runs on this repo with the real `claude` binary and `--sandbox claude`, plus atlas, batch merge, judge panel and budgets. Each produced a PR, which then went through review.

| Run | Tasks merged | Cost | Satisfaction | Result |
|---|---|---|---|---|
| `r20261027-0009-v5jt` | 2 of 2 | $3.04 | 0.94 | #77, pre-flight argv probe |
| `r20261027-0031-41bt` | 3 of 3 | $4.52 | 0.94 | #78, runner accounting and `sandbox.allowLocalBinding` |

What the runs showed:

- Claude Code sandbox pre-flight passed, and the atlas built 253 files. The judge panel (one opus and two sonnet judges, about $0.06 each) agreed fully (disagreement 0.00). The cache-read share was 0.71.
- Inside the sandbox, the worker's own `npm test` failed on the dashboard tests, which bind 127.0.0.1, and on three docker pre-flight tests that wrote to `/var/tmp` or `$HOME`. The conductor's gate, which runs outside the sandbox, passed. Fixed by #78: the opt-in `sandbox.allowLocalBinding` setting and the injectable `canaryBases`.
- Workers that start a background task emit more than one `result` message, so turns, usage and durations were undercounted (logged durations of 6 to 7 s). Fixed by #78.
- Footprint scheduling serialized every task, because every footprint included `CHANGELOG.md`, so batch merge only ever saw batches of one. Fixed by #83: `throughput.sharedFiles` (default `CHANGELOG.md`) no longer counts as overlap and merges with git's union driver.
- The integrity monitor flagged a test fake (`if (c === 'node')`) as special-casing. This was a false positive. Fixed by #82: literal special-casing is no longer flagged in test files.

## Real runs (2026-11-25)

Both runs used a throwaway copy of the `calc` fixture and the real `claude` binary (Claude Code 2.1.332), from a local branch holding `main`, #120 and #121.

| Run | Setup | Result | Cost |
|---|---|---|---|
| `r20261125-1552-mhz4` | `--sandbox claude` | Pre-flight passed in 18 s with the #121 probe. 1 of 1 tasks merged, satisfaction 1.00 | $1.87 |
| `r20261125-1553-rueo` | `runBudgetUsd` 0.1, no sandbox | The cap was reached after planning. 0 of 1 tasks merged | $1.28 |

The #121 claude probe, a worker-shaped session that checks argv pass-through through the Bash tool, passed against the real Claude Code sandbox. Its two probe sessions are not counted in the run's cost.

## H1 and H2, first look (2026-10-27)

**H1 (integrity) is not measurable from the existing record.** Every evolution cycle so far ran under the globally installed `orchestra` command, which links to an older clone at 0.6.1 that has no frozen scorer. The archived eval score of every case equals the candidate's own judge satisfaction to three decimals. No variant was promoted (v3 and v4 were rejected, v2 was never scored), so there is no promoted gain that could disappear under the frozen scorer. Re-scoring is not possible either, because eval-run branches are deleted after scoring, so the diffs are gone. H1 needs new evolution cycles run from this repository's code. The global install and the plugin were pointed at this checkout on 2026-10-27.

**H2 (verification) pilot: no support at n = 3.** Preregistered bars, then `orchestra bench --arms h2-none,h2-agentic --goals args-usage,text-wrap,rec-pivot` (bench `b20261027013645`). The two arms differ only in `verification.agenticJudge.enabled`. Bench config has no test command, so the agentic judge only had planner-written scenario checks to run.

| Arm | Hidden check pass | Judge pass | Judge agrees with check | Merged but wrong | Mean cost per run |
|---|---|---|---|---|---|
| `h2-none` | 3 of 3 | 3 of 3 | 3 of 3 | 0 of 3 | $1.38 |
| `h2-agentic` | 2 of 3 | 3 of 3 | 2 of 3 | 1 of 3 (`args-usage`) | $1.40 |

Both preregistered H2 bars were missed, so the pilot stopped there as planned. Total spend $8.35. Three goals with one repeat cannot separate the arms (the paired 95% CI on check pass is -177 to +110 points). The one failure is more likely worker variance than an agentic judge effect. The clearer finding is that the judge passed all six runs, so judge agreement only tracked worker success. A useful H2 measurement needs goals where workers fail often, several repeats, and a test command in the bench config so the agentic judge has something to execute. At about $1.40 per run, 3 goals x 3 repeats x 2 arms costs about $25.

The rerun on 2026-11-25 (below) followed up on this. Two tooling gaps surfaced. Bench runs live in throwaway stores, so `orchestra stats` cannot split bench rows by verification mode (missing run files count as `none`); per-arm numbers above were computed from `results.jsonl`. And bench rows do not record the hidden check's output, so a failed check cannot be diagnosed after the run.

## H2 rerun (2026-11-25)

Preregistered in [research/h2-rerun.md](research/h2-rerun.md) before the run. The arms were `h2r-none` and `h2r-agentic`, with `testCommand` set to `node --test`. The goals were `rec-csv`, `args-usage` and `text-wrap`, with 3 repeats each (bench `b20261125075146`).

| Arm | Hidden check pass | Judge pass | Agreement | Merged but wrong | Spend |
|---|---|---|---|---|---|
| `h2r-none` | 9 of 9 | 6 of 9 | 0.67 | 0 | $20.27 |
| `h2r-agentic` | 9 of 9 | 7 of 9 | 0.78 | 0 | $18.42 |

B1 (agreement at least 0.10 higher) was met by one run. B2 (fewer merged-but-wrong runs) was missed, because no worker failed a hidden check in either arm. H2 is not supported. Every disagreement was the judge failing a run whose hidden check passed: two-task runs where T2 failed or never got a verdict. These goals are too easy to measure merged-but-wrong. Spend was $38.69, against a $25 estimate, because `runBudgetUsd` does not cap the planner, judge or librarian; the user approved the overrun before the stop rule was reached.

## Known approximations

- Sequential testing (M3) widens the confidence interval with a Bonferroni-style factor: a normal-quantile ratio applied to a t-based interval. Not checked against a reference.
- The mutation scanner (M4) is a heuristic, not a TypeScript parser. Ambiguous cases are skipped, and compile failures count as invalid mutants rather than killed.
- `runBudgetUsd` stops new tasks once spend reaches it. The planner, judge, librarian and any session already in flight still run, so a run can spend well past it ($1.28 against $0.10 on 2026-11-25, and about $2.15 against $1.50 per bench run).
- The claude backend pre-flight probe runs two short model sessions, capped at $0.50 and 4 turns each. Their cost is not recorded in the run's cost or the ledger.
- `orchestra approve --by` (M6) is an advisory four-eyes check against a free-text name. It is not authenticated identity.
- srt on Linux: `denyRead` globs such as `**/.env` are expanded to the files that exist when the worker starts, so a `.env` created mid-run is readable from a shell. macOS matches the globs as patterns.
- srt wraps the worker argv into one `bash -c` string. On Linux one argument is capped at 128 KiB, so a very large prompt or system prompt would fail to spawn (E2BIG). The harness prompt files total about 22 KB today, but task text, lessons and repair notes add to that and have not been measured.
- The sandbox pre-flight probes are built through the worker code path (`wrapCommand` and `buildCommand` in `src/agent.ts`) and check argv pass-through for every backend, including Claude Code's Bash sandbox wrapper (#121). The claude probe passed against the real Claude Code sandbox on 2026-11-25. The srt and docker probes are checked against fakes only.
- `orchestra resume` reloads the hidden scenarios, contract and atlas from planning but not per-task in-memory state such as worker budget use from the first pass; resumed tasks start fresh. It runs no automatic evolution check, unlike `orchestra run`. Its isolation check compares free-form settings: a different docker image or network counts as weaker because Orchestra cannot rank them. The resume lock trusts a pid, so a reused pid can make a stale lock look live (delete the lock file). Checked with the fake runner only.

## Recommended next steps

Done on 2026-10-26: `claude -p --max-turns` confirmed on Claude Code 2.1.310 (hidden from `--help`; a reached cap ends with `error_max_turns`), sandbox formats checked (#74), whitepaper and blog updated (#75). Released as 0.7.0.

Done on 2026-10-27: real end-to-end runs with the Claude Code sandbox (above), and their fixes merged (#77, #78). H2 pilot (#80). `orchestra resume` for runs that end `awaiting_approval` (#81). Integrity false positive on test fakes (#82). Shared append-only files out of footprint overlap (#83). Budget lines logged (#84). Released as 0.8.0.

Done on 2026-11-25: bench row diagnostics (#120), pre-flight probes through the worker code path (#121), the calibration threshold fix (#122) (all three merged on 2026-11-28), the H2 rerun, the first real `--sandbox claude` run of the new probe, the first budget cap run, and the whitepaper and blog updated for 0.8.0.

Recommendations, in priority order:

1. **Decide what `runBudgetUsd` should mean.** Today it only stops dispatch. Either make it a ceiling (skip the librarian and stop in-flight sessions once it is reached, and count the pre-flight probes), or rename and document it as a dispatch cap. Every cost estimate in this file was low because of it.
2. **Make H2 measurable before spending on it again.** Both H2 runs had workers pass almost every hidden check, so merged-but-wrong never happened. Add goals where workers fail the hidden check part of the time (adversarial edge cases, under-specified goals, larger refactors), and keep the bench stores of failed tasks so a T2 failure can be read after the run. Budget about $2.20 per run.
3. **Prove srt and docker.** Install srt and docker (both new tools on the machine, so they need approval), then make one small real run with each. sandbox-exec is used by srt on macOS rather than being a separate backend.
4. **Gather H1 from new evolution cycles.** Unchanged: check the archive after a few normal goal runs.
5. **Make the M6 batch-merge interleaving test deterministic** if it flakes in CI. Under bun, `eval replays interleave candidate and incumbent` also showed up as timing-sensitive.
6. **Plan H3 to H8.** Preregister each with bars and a cost estimate that uses the real per-run cost.
7. **Choose between the W8 and W10 epics** and review #88.
