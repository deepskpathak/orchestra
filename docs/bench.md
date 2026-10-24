# Benchmark suite (`orchestra bench`)

A fixed, in-repo suite for measuring the factory against hidden checks instead of its own judge. It is the base for paired statistics, ablations and judge calibration (milestone M2).

## Layout

```
bench/
  arms.json            arms: a name plus overrides of project config and a harness version
  fixtures/<repo>/     plain files of a small fixture repo
  goals/<id>.json      { id, fixture, goal, taskType, humanMinutes, check, oracle }
  checks/              hidden check scripts (exit 0 = pass), run with the repo as cwd
  oracles/             reference solutions: a .patch file or an overlay directory
```

`check` and `oracle` are paths relative to the suite directory. `.mjs` and `.js` checks run with node, anything else with `sh`.

## How a run works

For each arm, goal and repeat the engine materialises the fixture into a fresh temporary git repo and commits it as the base. It calls `runGoal` with `kind: 'eval'` and `baseRef` set to that base, in that repo's own store, so bench runs are never harvested as goal runs and never count toward evolution in your project. After the run it checks out the integration branch in a scratch worktree and runs the hidden check there. Checks and oracles live only in the suite directory, so they never appear in the worker or judge worktrees, the prompts or the integration branch.

## Commands

```
orchestra bench                          # all arms in bench/arms.json, all goals, 1 repeat
orchestra bench --arms a,b --repeats 3   # named arms (unknown names use the default config)
orchestra bench --goals calc-sub         # a subset of goals
orchestra bench --suite <dir>            # another suite directory
orchestra bench --ablations              # full, -scenarios, -repair, -learnings, -contrastive, -evolver, single-session
orchestra bench --report                 # summary, ablation table (latest bench with a full arm), judge calibration
orchestra bench --verify-oracles         # every oracle must pass its own check; exits 1 naming failures
```

`--verify-oracles` also fails a goal whose check already passes on the unmodified base, since such a check proves nothing.

## Output

`.orchestra/bench/<benchId>/results.jsonl` has one row per repeat: `arm, goal, taskType, humanMinutes, repeat, runId, harness, checkPass, judgeSatisfaction, taskVerdicts, costUsd, wallMs`. `summary.json` has per arm `passAt1`, `passHat3` (null until each goal has 3 repeats), `meanCostUsd` and `meanWallMs`, computed with `src/stats.ts`. The same table is printed to the terminal.

Use `ORCHESTRA_RUNNER=fake` to exercise the engine without spending tokens; the fake runner will mostly fail the hidden checks, which is expected.

## Arms

```json
[
  { "name": "default" },
  { "name": "no-prejudge", "config": { "preJudge": { "enabled": false } } },
  { "name": "v2", "harness": "v2" }
]
```

Nested config objects merge one level deep. A `harness` other than `v1` is copied from your project's store.

## Judge calibration

`orchestra bench --report` and `orchestra stats` show, per harness version, how often the judge's verdict (run satisfaction at or above `passThreshold`, else all tasks passed) matches the hidden check, plus Cohen's kappa. Human grades add a human-judge kappa.

```
orchestra bench calibrate --sample 50 [--seed 1]   # writes .orchestra/bench/calibration/sample.jsonl
# edit the file: set humanPass to true or false on each line you grade
orchestra bench calibrate --import graded.jsonl    # merges grades, prints human-judge kappa
```

The sample oversamples disagreements between judge and check, contrastive pairs whose two verdicts disagreed, and scores within 0.1 of `passThreshold`. About 70% of the sample is reserved for those; the rest is random. The same seed gives the same sample. Set `evolve.minJudgeAgreement` to block evolution when agreement falls below a floor.

## Ablations and the single-session baseline

`orchestra bench --ablations` runs six built-in arms, each over all goals and `--repeats` times. Every factory arm enables contrastive repair so that `-contrastive` has something to turn off.

| Arm | What changes |
| --- | --- |
| `full` | The current incumbent harness, everything on |
| `-scenarios` | The judge and the contrastive comparer get no hidden scenarios |
| `-repair` | One attempt per task (`maxAttempts` of 1), no repair loop |
| `-learnings` | Planner and workers get no learnings |
| `-contrastive` | Repairs use a single worker, never a contrastive pair |
| `-evolver` | Pinned to the base harness `v1`, versus the evolved incumbent that `full` runs |

The `single-session` baseline gives one worker-role call the whole goal in the fresh repo, with no planner, judge or repair. Its `budgetUsd` is the mean cost per goal of the `full` arm (matched cost, fallback to the worker budget when `full` recorded no cost), and it is scored by the same hidden check. It runs after the other arms so that the budget is known. Rows carry `budgetUsd`.

`orchestra bench --report` prints the table for the latest bench that has a `full` arm: mean check pass rate, paired gain versus `full` with a 95% CI clustered by goal (`src/stats.ts`, pairs are goal and repeat), pass@1, pass^3 and mean cost. With few goals or repeats the CIs are wide; treat small differences as unproven. `-evolver` equals `full` until the incumbent differs from `v1`.

## External anchors

Orchestra makes no network calls, so anchor slices are run by a human following each benchmark's official protocol, and the result is recorded by hand. Do this periodically (for example each release), never inside CI.

1. **SWE-rebench or SWE-bench-Live.** Take the newest slice published after the model's training cutoff, so the tasks are fresh. Use the benchmark's own task images, prompts-free evaluation harness and scoring. Run one Orchestra goal per task with the issue text as the goal and the benchmark's repository snapshot as the repo, then score the resulting diff with the benchmark's evaluator. Run the matched-cost single Claude Code session on the same tasks.
2. **Terminal-Bench 2.0.** Follow its official harness and task set unchanged, run the same two arms, and report its metric.
3. **Report** per slice: benchmark and version, slice date and size, the Orchestra harness version, the single-session baseline, resolved rate with a CI, and cost per task. Keep anchor numbers apart from the in-repo bench; they are a sanity check on external validity, not a promotion signal.
