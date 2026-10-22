# Configuration

Orchestra has two config layers, both plain JSON:

- **Project config**: `config.json` in the `.orchestra` directory, created by `orchestra init`. Controls concurrency, tool permissions and budgets.
- **Harness config**: `harness/v1/config.json` in the package, copied into the `.orchestra` directory on init. Controls models, retries and thresholds per role. This layer is versioned and evolvable.

## Project config (`.orchestra/config.json`)

Defaults come from `DEFAULT_PROJECT_CONFIG` in `src/store.ts`. Missing keys fall back to the defaults, and the `judgeTiers`, `preJudge`, `contrastive`, `fastPath` and `evolve` objects are merged key by key, so older configs get the defaults for newer keys automatically. On `orchestra init`, `testCommand` is filled in by auto-detection (it stays `null` if nothing is detected).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `concurrency` | number | `3` | Maximum tasks running in parallel. |
| `testCommand` | string or null | `null` | Command run in each worktree and on the integration branch. `null` means no tests are run. |
| `allowedTools` | string[] | `["Read", "Edit", "Write", "Glob", "Grep", "Bash"]` | Tools workers may use. |
| `disallowedTools` | string[] | `["WebFetch", "WebSearch", "Bash(git push:*)", "Bash(curl:*)", "Bash(wget:*)"]` | Tools workers may not use. Keeps workers off the network and from publishing. A guard hook enforces more. |
| `permissionMode` | string | `"acceptEdits"` | Permission mode passed to worker sessions. |
| `runBudgetUsd` | number | `20` | Spend cap per run. Once reached, tasks that are pending or in repair fail with "run budget exhausted". |
| `judgeTiers` | object | see below | Tiered judging settings. |
| `preJudge` | object | see below | Deterministic checks before any judge call. |
| `fastPath` | object | see below | Single-task planning for small goals. |
| `contrastive` | object | see below | Two-worker contrastive repair. |
| `evolve` | object | see below | Self-improvement settings. |

### `judgeTiers`

Off by default. When enabled, a cheap judge runs first and its verdict is final only if tests passed (or none ran), the score differs from `passThreshold` by more than `margin`, and it listed no issues. Otherwise, or if the cheap judge returns no verdict, the strong judge from the harness config (`models.judge`) runs and its verdict is final. Ledger rows record the model actually used.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `judgeTiers.enabled` | boolean | `false` | Turn tiered judging on. |
| `judgeTiers.cheapModel` | string | `"haiku"` | Model alias for the first, cheap judge call. |
| `judgeTiers.margin` | number | `0.1` | Escalate when the score is within this distance of `passThreshold`. |

### `preJudge`

Off by default. When enabled, cheap checks run after the worker's tests and before any judge call. If any check fails, the task goes straight to repair with the failures as repair notes, and no judge call is spent.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `preJudge.enabled` | boolean | `false` | Turn the checks on. |
| `preJudge.lintCommand` | string or null | `null` | Command run in the task worktree. A non-zero exit fails the check. `null` skips linting. |
| `preJudge.requireTests` | boolean | `true` | When the diff adds an `export` to a source file under `src/`, require that a test file also changed. |

### `fastPath`

Off by default. When enabled and the goal is short and has no list structure (numbered or bulleted lines, or inline `(1)` items), the planner is told to return exactly one task, and is not required to produce hidden scenarios. Otherwise planning is unchanged.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `fastPath.enabled` | boolean | `false` | Turn the fast path on. |
| `fastPath.maxGoalChars` | number | `400` | Goals longer than this never take the fast path. |

### `contrastive`

Off by default. Without a test command the judge scores a single attempt with no objective check, so scores are noisy. When enabled, a repair attempt runs two workers instead of one, in separate worktrees off the same base: A follows the repair notes as usual, B is told to take a different approach to the same failing criteria. One comparison judge call sees both diffs, the acceptance criteria and the hidden scenarios, scores each attempt per criterion, and picks a winner with reasons. The winner's branch continues to the merge queue, the loser's worktree and branch are deleted, and both attempts are recorded in run events and the task drawer.

**When it applies.** Only on repair attempts (attempt 2 or later); first attempts stay single. By default only when `testCommand` is `null`. Set `onlyWithoutTests` to `false` to apply it in repos with tests too.

**Cost.** A contrastive repair costs two worker sessions (each capped by `budgetUsd.worker`) plus one comparison judge call, instead of one worker session and one judge call.

**Pass bar.** Contrast never lowers `passThreshold`. The preferred attempt must still pass the threshold on its own scores; if neither does, the task is repaired or fails as usual.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `contrastive.enabled` | boolean | `false` | Turn contrastive repair on. |
| `contrastive.onlyWithoutTests` | boolean | `true` | Apply only when `testCommand` is `null`. `false` applies it whenever enabled. |
| `contrastive.maxPairs` | number | `1` | Contrastive pairs allowed per task. |

```json
{
  "testCommand": null,
  "contrastive": { "enabled": true, "onlyWithoutTests": true, "maxPairs": 1 }
}
```

### `evolve`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `evolve.every` | number | `3` | Auto-evolve after every N completed runs. `0` disables. |
| `evolve.autoPromote` | boolean | `true` | Promote a candidate automatically when it beats the current version. If `false`, a winning candidate is kept but not promoted. |
| `evolve.minGain` | number | `0.02` | Minimum eval score gain a candidate needs to count as better. The gain must also exceed the observed spread (standard deviation of per-case score deltas), with no regressions. |
| `evolve.sample` | number | `5` | Eval cases used per evaluation, newest first. Bounds cost. Keep it at or above `evolve.minCases`, or promotion is never possible. |
| `evolve.minCases` | number | `5` | Minimum eval cases that must be evaluated before a candidate can be promoted. Fewer cases and the candidate is rejected with a reason. |
| `evolve.candidates` | number | `1` | Variants proposed per evolve cycle. `1` keeps the single-variant cycle. Above `1`, candidates are screened on `min(2, sample)` cases, survivors are composed into one variant, and only that variant gets the full evaluation. See [self-improvement.md](self-improvement.md#multi-candidate-evolution-evolvecandidates). |

Example:

```json
{
  "concurrency": 2,
  "testCommand": "npm test --silent",
  "runBudgetUsd": 10,
  "evolve": { "every": 0, "candidates": 3 }
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

### Model tiers and providers

A value in `models` may be a literal model name (for example `opus` or a full model id), which is used unchanged, or a tier: `strong`, `balanced` or `fast`. Tiers are resolved when the harness is loaded, through the capability table in `src/models.ts`, using the optional top-level `provider` key (default `anthropic`). The conductor, ledger and dashboard only see the resolved model ids.

| Tier | `anthropic` model |
|---|---|
| `strong` | `opus` |
| `balanced` | `sonnet` |
| `fast` | `haiku` |

The table also records approximate context and cache-minimum token figures per tier. Treat them as approximate and re-check them against provider docs. It holds no prices. A tier with a provider that is not in the table is an error that lists the known providers, while a literal name is accepted for any provider.

```json
{
  "provider": "anthropic",
  "models": { "planner": "strong", "worker": "balanced", "judge": "strong", "librarian": "fast", "evolver": "strong" }
}
```

Note: `judgeTiers.cheapModel` in the project config is not tier-resolved yet, so give it a literal model name.

## Harness versions

The harness is the evolvable part of Orchestra: role prompts (`planner.md`, `worker.md`, `judge.md`, `librarian.md`, `evolver.md`) plus `config.json` and the optional small files `tools.md`, `style.md` and `checklist.md` (see `src/harness.ts`). Paths below are relative to the `.orchestra` directory.

- Each version lives in its own directory, `harness/<vN>/`. `orchestra init` seeds `v1` from the package.
- `harness/current` holds the name of the promoted version.
- `archive.json` records every version with its parent, rationale, eval score and status (`promoted`, `candidate`, `rejected` or `retired`).
- The evolver creates `vN+1` as a copy of a parent with changed files. It may edit only `planner.md`, `worker.md`, `judge.md`, `librarian.md`, `config.json`, `tools.md`, `style.md` and `checklist.md`. Lines in `checklist.md` may be added but not removed. See [self-improvement](self-improvement.md).
- Guard rails: a candidate `config.json` may not lower `passThreshold`, and must define a model for every role.
- Promoting a version marks it `promoted` and the previous one `retired`. See [self-improvement.md](self-improvement.md) for the full evolve, promote and rollback flow.
- Agent sessions cannot write to the harness, evals or archive (enforced by the guard hook in `src/guard.ts`).

## Environment variables

| Variable | Meaning |
|---|---|
| `ORCHESTRA_RUNNER` | Set to `fake` to use the built-in simulator instead of real Claude sessions. Any other value uses Claude. |
| `ORCHESTRA_FAKE_STEP_MS` | Delay in milliseconds per simulated step when the fake runner is active. Defaults to `150`. |
