---
name: bench
description: Run the Orchestra benchmark suite (arms x goals x repeats against hidden checks) and report pass@1, pass^3, cost and wall clock per arm.
allowed-tools: Bash(orchestra *)
---

Run `orchestra bench --verify-oracles` first, then `orchestra bench` with any `--arms`, `--goals` and `--repeats` the user asked for. Show the summary table verbatim in a code block and give the path to `results.jsonl` and `summary.json`. Note that pass^3 is n/a below 3 repeats and that bench runs cost real tokens unless `ORCHESTRA_RUNNER=fake` is set.
