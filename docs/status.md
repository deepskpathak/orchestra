# Project status

Last updated 2026-11-28 (afternoon).

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

- **Docker workers (M5).** On 2026-11-28 srt 0.0.83, the docker CLI 29.10.1 and colima 0.10.3 were installed, and an `orchestra-worker:latest` image was built (node 22, git, Claude Code 2.1.332; see docs/isolation.md). The srt and docker pre-flight probes passed against the real tools, and a real `--sandbox srt` run merged its task (below). No docker worker has run yet. The container passes credentials only as `ANTHROPIC_*` and `CLAUDE_*` env names, and this machine's Claude login lives in the macOS keychain, so a docker worker needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` in the environment, plus `--sandbox-network bridge` (the default `none` also blocks the model API). The srt settings shape and the Claude Code sandbox keys were checked against their docs on 2026-10-26 (#74).
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

## Real runs (2026-11-28)

Both used throwaway copies of the `calc` fixture, the real tools, and the code of #124 (the `runBudgetUsd` ceiling), with `runBudgetUsd` 3 and `testCommand` `node --test`.

| Check | Result | Cost |
|---|---|---|
| srt pre-flight, standalone (`preflightSandbox`) | The positive control reached the probe host. Inside srt, the network probe and the read canary were both blocked, and the argv check passed. | $0 |
| docker pre-flight, standalone (`--network=none`, colima) | Both probes were blocked inside the container and the argv check passed. One warning, as documented: with network `none` a claude worker cannot reach the model API. | $0 |
| `r20261128-1043-lkgy`, `--sandbox srt` | Pre-flight passed. 1 of 1 tasks merged, satisfaction 1.00. Planner $0.88, worker $0.11, judge $0.89, librarian $0.41. | $2.28 |

The srt worker could not run `git commit` itself (its sandbox makes `.git/hooks` and `.git/config` read-only), and the harness committed for it, as designed. The run stayed under the $3 ceiling, so the ceiling's cut-off path did not trigger. The fake-runner tests in #124 cover that path.

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
- `runBudgetUsd` is a ceiling since #124: each session's `--max-budget-usd` is cut to what is left of the run. Claude Code checks that cap between turns, so a run can end up to one turn past the ceiling. Before #124 it only stopped dispatch ($1.28 spent against $0.10 on 2026-11-25).
- The claude backend pre-flight probe runs two short model sessions, capped at $0.50 and 4 turns each. Since #124 their cost is counted in the run's cost and in a `sandbox_preflight` ledger row.
- `orchestra approve --by` (M6) is an advisory four-eyes check against a free-text name. It is not authenticated identity.
- srt on Linux: `denyRead` globs such as `**/.env` are expanded to the files that exist when the worker starts, so a `.env` created mid-run is readable from a shell. macOS matches the globs as patterns.
- srt wraps the worker argv into one `bash -c` string. On Linux one argument is capped at 128 KiB, so a very large prompt or system prompt would fail to spawn (E2BIG). The harness prompt files total about 22 KB today, but task text, lessons and repair notes add to that and have not been measured.
- The sandbox pre-flight probes are built through the worker code path (`wrapCommand` and `buildCommand` in `src/agent.ts`) and check argv pass-through for every backend, including Claude Code's Bash sandbox wrapper (#121). The claude probe passed against the real Claude Code sandbox on 2026-11-25. The srt and docker probes are checked against fakes only.
- `orchestra resume` reloads the hidden scenarios, contract and atlas from planning but not per-task in-memory state such as worker budget use from the first pass; resumed tasks start fresh. It runs no automatic evolution check, unlike `orchestra run`. Its isolation check compares free-form settings: a different docker image or network counts as weaker because Orchestra cannot rank them. The resume lock trusts a pid, so a reused pid can make a stale lock look live (delete the lock file). Checked with the fake runner only.

## Recommended next steps

Done on 2026-10-26: `claude -p --max-turns` confirmed on Claude Code 2.1.310 (hidden from `--help`; a reached cap ends with `error_max_turns`), sandbox formats checked (#74), whitepaper and blog updated (#75). Released as 0.7.0.

Done on 2026-10-27: real end-to-end runs with the Claude Code sandbox (above), and their fixes merged (#77, #78). H2 pilot (#80). `orchestra resume` for runs that end `awaiting_approval` (#81). Integrity false positive on test fakes (#82). Shared append-only files out of footprint overlap (#83). Budget lines logged (#84). Released as 0.8.0.

Done on 2026-11-25: bench row diagnostics (#120), pre-flight probes through the worker code path (#121), the calibration threshold fix (#122) (all three merged on 2026-11-28), the H2 rerun, the first real `--sandbox claude` run of the new probe, the first budget cap run, and the whitepaper and blog updated for 0.8.0.

Done on 2026-11-28: the `runBudgetUsd` ceiling (#124), hard H2 goals and kept stores for failed bench runs (#125), srt and docker installed with their pre-flight probes passing for real, a real srt run, the H1 archive check, and the H3 to H8 plan (research/h3-h8-plan.md). #124 and #125 merged on 2026-11-28.

Recommendations, in priority order:

1. **Run the H2 hard-goals pilot** (research/h2-hard.md): 4 runs, about $10. Go to the full 24-run design (about $60) only if 1 to 3 of the 4 runs fail the hidden check.
2. **Run H4** (research/h3-h8-plan.md): 48 runs, about $106.
3. **Run one docker worker.** Export `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and run with `--sandbox docker --sandbox-network bridge`. With a non-`none` network the network probe is skipped by design.
4. **Add the bench row fields that H5 to H8 need** (merge wait, worker tokens, footprint recall), the composite goals for H5 and a larger fixture for H6 to H8. This is code only, with no spend.
5. **H1 and H3:** check the archives again after the next promotion. Keep the replay diffs of promoted variants so they can be re-scored. Evolution cycles that run unattended need a login that does not expire (4 runs on 2026-11-21 failed with an expired login).
6. **Make the M6 batch-merge interleaving test deterministic** if it flakes in CI.
7. **Choose between the W8 and W10 epics** and review #88.
