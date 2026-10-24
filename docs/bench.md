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
