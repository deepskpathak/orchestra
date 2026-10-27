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
- **The research hypotheses H1 to H8.** M2 built the machinery (`orchestra bench`, paired statistics, ablations, judge calibration). No measurement has been run yet.

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

## Known approximations

- Sequential testing (M3) widens the confidence interval with a Bonferroni-style factor: a normal-quantile ratio applied to a t-based interval. Not checked against a reference.
- The mutation scanner (M4) is a heuristic, not a TypeScript parser. Ambiguous cases are skipped, and compile failures count as invalid mutants rather than killed.
- `orchestra approve --by` (M6) is an advisory four-eyes check against a free-text name. It is not authenticated identity.
- srt on Linux: `denyRead` globs such as `**/.env` are expanded to the files that exist when the worker starts, so a `.env` created mid-run is readable from a shell. macOS matches the globs as patterns.
- srt wraps the worker argv into one `bash -c` string. On Linux one argument is capped at 128 KiB, so a very large prompt or system prompt would fail to spawn (E2BIG). The harness prompt files total about 22 KB today, but task text, lessons and repair notes add to that and have not been measured.
- The sandbox pre-flight probe checks argv pass-through for srt and docker with a hand-written, worker-like argv (`node -e <script> orchestra-probe --settings <json> -p <prompt>`, no `--` of its own), so a srt wrapper that drops its `--` (the #74 bug) or a wrapper that mangles quoting fails pre-flight. It does not build the probe through the worker code path (`buildCommand` in `src/agent.ts`), so it cannot catch a bug in how workers assemble their own argv, and the claude backend probe (a Bash tool call) does not check argv. Checked against fakes only. If both probes are skipped, pre-flight warns that argv was not verified.
- `orchestra resume` reloads the hidden scenarios, contract and atlas from planning but not per-task in-memory state such as worker budget use from the first pass; resumed tasks start fresh. It runs no automatic evolution check, unlike `orchestra run`. Checked with the fake runner only.

## Recommended next steps

Done on 2026-10-26: `claude -p --max-turns` confirmed on Claude Code 2.1.310 (hidden from `--help`; a reached cap ends with `error_max_turns`), sandbox formats checked (#74), whitepaper and blog updated (#75). Released as 0.7.0.

Done on 2026-10-27: real end-to-end runs with the Claude Code sandbox (above), and their fixes merged (#77, #78).

1. Start measuring H1 to H8 with `orchestra bench`, beginning with H1 (integrity) and H2 (verification), which the plan needs before trusting further evolution.
2. Stop shared append-only files such as `CHANGELOG.md` from counting as footprint overlap, so independent tasks can run and merge in parallel.
3. Log the budget lines given to workers (or record them in the run events), so budget behaviour can be checked after a run.
4. Reduce integrity-monitor false positives on test fakes, such as branching on a command name in a fake executor.
5. Build the pre-flight probe through the same wrapper code path as workers (buildCommand in src/agent.ts) instead of a hand-written argv, and cover the claude backend.
6. Make the M6 batch-merge interleaving test deterministic if it flakes in CI. It uses short sleeps.
