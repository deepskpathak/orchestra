# Project status

Last updated 2026-10-27.

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

## What is built but not yet proven

The test suite runs against fakes and injected executors. Two real runs on 2026-10-27 (see below) exercised the Claude Code sandbox backend, the atlas, batch merge, the judge panel and budgets. The following are still unproven against the real tool:

- **OS sandbox backends (M5) other than Claude Code's.** srt, docker and sandbox-exec have not run a real worker. The srt settings shape and the Claude Code sandbox keys and `//` permission-rule syntax were checked against their docs on 2026-10-26 (#74), and that check fixed an srt argv bug that made every srt worker fail closed.
- **Budget caps (M6).** The cap was never reached in the real runs, and the budget lines added to worker prompts are not logged, so they could not be observed.
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
- Footprint scheduling serialized every task, because every footprint included `CHANGELOG.md`, so batch merge only ever saw batches of one. Open, see next steps.
- The integrity monitor flagged a test fake (`if (c === 'node')`) as special-casing. This was a false positive. Open, see next steps.

## H1 and H2, first look (2026-10-27)

**H1 (integrity) is not measurable from the existing record.** Every evolution cycle so far ran under the globally installed `orchestra` command, which links to an older clone at 0.6.1 that has no frozen scorer. The archived eval score of every case equals the candidate's own judge satisfaction to three decimals. No variant was promoted (v3 and v4 were rejected, v2 was never scored), so there is no promoted gain that could disappear under the frozen scorer. Re-scoring is not possible either, because eval-run branches are deleted after scoring, so the diffs are gone. H1 needs new evolution cycles run from this repository's code. Pointing the global install and the plugin at this checkout is a prerequisite.

**H2 (verification) pilot: no support at n = 3.** Preregistered bars, then `orchestra bench --arms h2-none,h2-agentic --goals args-usage,text-wrap,rec-pivot` (bench `b20261027013645`). The two arms differ only in `verification.agenticJudge.enabled`. Bench config has no test command, so the agentic judge only had planner-written scenario checks to run.

| Arm | Hidden check pass | Judge pass | Judge agrees with check | Merged but wrong | Mean cost per run |
|---|---|---|---|---|---|
| `h2-none` | 3 of 3 | 3 of 3 | 3 of 3 | 0 of 3 | $1.38 |
| `h2-agentic` | 2 of 3 | 3 of 3 | 2 of 3 | 1 of 3 (`args-usage`) | $1.40 |

Both preregistered H2 bars were missed, so the pilot stopped there as planned. Total spend $8.35. Three goals with one repeat cannot separate the arms (the paired 95% CI on check pass is -177 to +110 points). The one failure is more likely worker variance than an agentic judge effect. The clearer finding is that the judge passed all six runs, so judge agreement only tracked worker success. A useful H2 measurement needs goals where workers fail often, several repeats, and a test command in the bench config so the agentic judge has something to execute. At about $1.40 per run, 3 goals x 3 repeats x 2 arms costs about $25.

Two tooling gaps surfaced. Bench runs live in throwaway stores, so `orchestra stats` cannot split bench rows by verification mode (missing run files count as `none`); per-arm numbers above were computed from `results.jsonl`. And bench rows do not record the hidden check's output, so a failed check cannot be diagnosed after the run.

## Known approximations

- Sequential testing (M3) widens the confidence interval with a Bonferroni-style factor: a normal-quantile ratio applied to a t-based interval. Not checked against a reference.
- The mutation scanner (M4) is a heuristic, not a TypeScript parser. Ambiguous cases are skipped, and compile failures count as invalid mutants rather than killed.
- `orchestra approve --by` (M6) is an advisory four-eyes check against a free-text name. It is not authenticated identity.
- srt on Linux: `denyRead` globs such as `**/.env` are expanded to the files that exist when the worker starts, so a `.env` created mid-run is readable from a shell. macOS matches the globs as patterns.
- srt wraps the worker argv into one `bash -c` string. On Linux one argument is capped at 128 KiB, so a very large prompt or system prompt would fail to spawn (E2BIG). The harness prompt files total about 22 KB today, but task text, lessons and repair notes add to that and have not been measured.
- The sandbox pre-flight probe checks argv pass-through for srt and docker with a hand-written, worker-like argv (`node -e <script> orchestra-probe --settings <json> -p <prompt>`, no `--` of its own), so a srt wrapper that drops its `--` (the #74 bug) or a wrapper that mangles quoting fails pre-flight. It does not build the probe through the worker code path (`buildCommand` in `src/agent.ts`), so it cannot catch a bug in how workers assemble their own argv, and the claude backend probe (a Bash tool call) does not check argv. Checked against fakes only. If both probes are skipped, pre-flight warns that argv was not verified.
- A run that ends `awaiting_approval` finishes when its last held task is approved, but the mutation pass and `learn()` are not re-run, and blocked dependents need a new run.

## Recommended next steps

Done on 2026-10-26: `claude -p --max-turns` confirmed on Claude Code 2.1.310 (hidden from `--help`; a reached cap ends with `error_max_turns`), sandbox formats checked (#74), whitepaper and blog updated (#75). Released as 0.7.0.

Done on 2026-10-27: real end-to-end runs with the Claude Code sandbox (above), and their fixes merged (#77, #78).

1. Point the global `orchestra` install and the plugin at this repository (they run 0.6.1 today), then gather H1 from new evolution cycles. Rerun H2 with harder goals, three repeats and a bench test command (about $25), and record check output and verification modes in bench rows.
2. Add a resume path for runs that end `awaiting_approval`.
3. Stop shared append-only files such as `CHANGELOG.md` from counting as footprint overlap, so independent tasks can run and merge in parallel.
4. Log the budget lines given to workers (or record them in the run events), so budget behaviour can be checked after a run.
5. Reduce integrity-monitor false positives on test fakes, such as branching on a command name in a fake executor.
6. Build the pre-flight probe through the same wrapper code path as workers (buildCommand in src/agent.ts) instead of a hand-written argv, and cover the claude backend.
7. Make the M6 batch-merge interleaving test deterministic if it flakes in CI. It uses short sleeps.
