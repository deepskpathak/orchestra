# Configuration

Orchestra has two config layers, both plain JSON:

- **Project config**: `config.json` in the `.orchestra` directory, created by `orchestra init`. Controls concurrency, tool permissions and budgets.
- **Harness config**: `harness/v1/config.json` in the package, copied into the `.orchestra` directory on init. Controls models, retries and thresholds per role. This layer is versioned and evolvable.

## Project config (`.orchestra/config.json`)

Defaults come from `DEFAULT_PROJECT_CONFIG` in `src/store.ts`. Missing keys fall back to the defaults, and the `judgeTiers` and `evolve` objects are merged key by key. On `orchestra init`, `testCommand` is filled in by auto-detection (it stays `null` if nothing is detected).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `concurrency` | number | `3` | Maximum tasks running in parallel. |
| `testCommand` | string or null | `null` | Command run in each worktree and on the integration branch. `null` means no tests are run. |
| `allowedTools` | string[] | `["Read", "Edit", "Write", "Glob", "Grep", "Bash"]` | Tools workers may use. |
| `disallowedTools` | string[] | `["WebFetch", "WebSearch", "Bash(git push:*)", "Bash(curl:*)", "Bash(wget:*)"]` | Tools workers may not use. Keeps workers off the network and from publishing. A guard hook enforces more. |
| `permissionMode` | string | `"acceptEdits"` | Permission mode passed to worker sessions. |
| `runBudgetUsd` | number | `20` | Spend cap per run. Once reached, tasks that are pending or in repair fail with "run budget exhausted". |
| `judgeTiers` | object | see below | Tiered judging settings. |
| `evolve` | object | see below | Self-improvement settings. |

### `judgeTiers`

Off by default. When enabled, a cheap judge runs first and its verdict is final only if tests passed (or none ran), the score differs from `passThreshold` by more than `margin`, and it listed no issues. Otherwise, or if the cheap judge returns no verdict, the strong judge from the harness config (`models.judge`) runs and its verdict is final. Ledger rows record the model actually used.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `judgeTiers.enabled` | boolean | `false` | Turn tiered judging on. |
| `judgeTiers.cheapModel` | string | `"haiku"` | Model alias for the first, cheap judge call. |
| `judgeTiers.margin` | number | `0.1` | Escalate when the score is within this distance of `passThreshold`. |

### `evolve`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `evolve.every` | number | `3` | Auto-evolve after every N completed runs. `0` disables. |
| `evolve.autoPromote` | boolean | `true` | Promote a candidate automatically when it beats the current version. If `false`, a winning candidate is kept but not promoted. |
| `evolve.minGain` | number | `0.02` | Minimum eval score gain a candidate needs to count as better. The gain must also exceed the observed spread (standard deviation of per-case score deltas), with no regressions. |
| `evolve.sample` | number | `5` | Eval cases used per evaluation, newest first. Bounds cost. Keep it at or above `evolve.minCases`, or promotion is never possible. |
| `evolve.minCases` | number | `5` | Minimum eval cases that must be evaluated before a candidate can be promoted. Fewer cases and the candidate is rejected with a reason. |

Example:

```json
{
  "concurrency": 2,
  "testCommand": "npm test --silent",
  "runBudgetUsd": 10,
  "evolve": { "every": 0 }
}
```

## Harness config (`harness/v1/config.json`)

Typed as `HarnessConfig` in `src/types.ts`. Shipped values:

| Field | Type | v1 value | Meaning |
|---|---|---|---|
| `models` | map of role to string | see below | Model alias used by each role. |
| `maxAttempts` | number | `3` | Attempts allowed per task before it fails. |
| `passThreshold` | number | `0.75` | Minimum judge score for a task to pass. |
| `budgetUsd` | map of role to number | see below | Spend cap in USD for one session of that role. |

Per-role values (roles are `planner`, `worker`, `judge`, `librarian`, `evolver`):

| Role | `models` | `budgetUsd` |
|---|---|---|
| planner | `opus` | `2` |
| worker | `sonnet` | `3` |
| judge | `opus` | `1` |
| librarian | `sonnet` | `1` |
| evolver | `opus` | `3` |

## Harness versions

The harness is the evolvable part of Orchestra: role prompts (`planner.md`, `worker.md`, `judge.md`, `librarian.md`, `evolver.md`) plus `config.json` (see `src/harness.ts`). Paths below are relative to the `.orchestra` directory.

- Each version lives in its own directory, `harness/<vN>/`. `orchestra init` seeds `v1` from the package.
- `harness/current` holds the name of the promoted version.
- `archive.json` records every version with its parent, rationale, eval score and status (`promoted`, `candidate`, `rejected` or `retired`).
- The evolver creates `vN+1` as a copy of a parent with changed files. It may edit only `planner.md`, `worker.md`, `judge.md`, `librarian.md` and `config.json`.
- Guard rails: a candidate `config.json` may not lower `passThreshold`, and must define a model for every role.
- Promoting a version marks it `promoted` and the previous one `retired`. See [self-improvement.md](self-improvement.md) for the full evolve, promote and rollback flow.
- Agent sessions cannot write to the harness, evals or archive (enforced by the guard hook in `src/guard.ts`).

## Environment variables

| Variable | Meaning |
|---|---|
| `ORCHESTRA_RUNNER` | Set to `fake` to use the built-in simulator instead of real Claude sessions. Any other value uses Claude. |
| `ORCHESTRA_FAKE_STEP_MS` | Delay in milliseconds per simulated step when the fake runner is active. Defaults to `150`. |
