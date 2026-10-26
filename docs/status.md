# Project status

Last updated 2026-10-26.

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

All tests run against fakes and injected executors. None of the following has been exercised against the real tool:

- **OS sandbox backends (M5).** srt, Claude Code's sandbox, docker and sandbox-exec. The srt settings shape and the Claude Code sandbox keys and `//` permission-rule syntax were checked against their docs on 2026-10-26 (#74), and that check fixed an srt argv bug that made every srt worker fail closed. No backend has run a real worker yet.
- **universal-ctags and graphify inputs (W9.5).** Optional, detect-and-degrade.
- **The research hypotheses H1 to H8.** M2 built the machinery (`orchestra bench`, paired statistics, ablations, judge calibration). No measurement has been run yet.

## Known approximations

- Sequential testing (M3) widens the confidence interval with a Bonferroni-style factor: a normal-quantile ratio applied to a t-based interval. Not checked against a reference.
- The mutation scanner (M4) is a heuristic, not a TypeScript parser. Ambiguous cases are skipped, and compile failures count as invalid mutants rather than killed.
- `orchestra approve --by` (M6) is an advisory four-eyes check against a free-text name. It is not authenticated identity.
- srt on Linux: `denyRead` globs such as `**/.env` are expanded to the files that exist when the worker starts, so a `.env` created mid-run is readable from a shell. macOS matches the globs as patterns.
- srt wraps the worker argv into one `bash -c` string. On Linux one argument is capped at 128 KiB, so a very large prompt or system prompt would fail to spawn (E2BIG). The harness prompt files total about 22 KB today, but task text, lessons and repair notes add to that and have not been measured.
- For srt and docker, the sandbox pre-flight probe passes worker-like trailing arguments (`--settings` with a JSON value containing quotes, spaces and `$`, plus `-p`) after its `node -e` script, and fails pre-flight if they do not arrive byte for byte, so an argv bug like the one #74 fixed is caught. The claude backend probe still goes through a Bash tool call and does not check argv.
- A run that ends `awaiting_approval` finishes when its last held task is approved, but the mutation pass and `learn()` are not re-run, and blocked dependents need a new run.

## Recommended next steps

Done on 2026-10-26: `claude -p --max-turns` confirmed on Claude Code 2.1.310 (hidden from `--help`; a reached cap ends with `error_max_turns`), sandbox formats checked (#74), whitepaper and blog updated (#75), sandbox pre-flight probe made argv-shaped for srt and docker.

1. Run one real end-to-end `orchestra run` with the new flags on (sandbox, atlas, batch merge, judge panel, budgets) on a machine with a real `claude` binary and a sandbox backend.
2. Start measuring H1 to H8 with `orchestra bench`, beginning with H1 (integrity) and H2 (verification), which the plan needs before trusting further evolution.
3. Add a resume path for runs that end `awaiting_approval`.
4. Make the M6 batch-merge interleaving test deterministic if it flakes in CI. It uses short sleeps.
