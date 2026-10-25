# Configuration

Orchestra has two config layers, both plain JSON:

- **Project config**: `config.json` in the `.orchestra` directory, created by `orchestra init`. Controls concurrency, tool permissions and budgets.
- **Harness config**: `harness/v1/config.json` in the package, copied into the `.orchestra` directory on init. Controls models, retries and thresholds per role. This layer is versioned and evolvable.

## Project config (`.orchestra/config.json`)

Defaults come from `DEFAULT_PROJECT_CONFIG` in `src/store.ts`. Missing keys fall back to the defaults, and the `judgeTiers`, `preJudge`, `contrastive`, `fastPath`, `verification` and `evolve` objects are merged key by key, so older configs get the defaults for newer keys automatically. On `orchestra init`, `testCommand` is filled in by auto-detection (it stays `null` if nothing is detected).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `concurrency` | number | `3` | Maximum tasks running in parallel. |
| `testCommand` | string or null | `null` | Command run in each worktree and on the integration branch. `null` means no tests are run. |
| `allowedTools` | string[] | `["Read", "Edit", "Write", "Glob", "Grep", "Bash"]` | Tools workers may use. |
| `disallowedTools` | string[] | `["WebFetch", "WebSearch", "Bash(git push:*)", "Bash(curl:*)", "Bash(wget:*)"]` | Tools workers may not use. Keeps workers off the network and from publishing at the tool-permission level. A guard hook adds a deny-list backstop. Neither is OS isolation; see the `sandbox` section below. |
| `permissionMode` | string | `"acceptEdits"` | Permission mode passed to worker sessions. |
| `runBudgetUsd` | number | `20` | Spend cap per run. Once reached, tasks that are pending or in repair fail with "run budget exhausted". |
| `judgeTiers` | object | see below | Tiered judging settings. |
| `preJudge` | object | see below | Deterministic checks before any judge call. |
| `fastPath` | object | see below | Single-task planning for small goals. |
| `contrastive` | object | see below | Two-worker contrastive repair. |
| `verification` | object | see below | M4 Verification checks, all off by default. |
| `context` | object | see below | Repo context settings (`context.atlas`). |
| `evolve` | object | see below | Self-improvement settings. |

### `sandbox`

The OS sandbox (or docker backend) is the real boundary for workers. `disallowedTools` and the guard hook are defence in depth and can be bypassed through `python`, `node`, git remotes or DNS. See [architecture.md](architecture.md#boundary-model-os-sandbox-first-guard-hook-as-backstop).

Optional, absent by default. Read only from the repo's own `.orchestra/config.json` (never the run-time harness copy). Used when `orchestra run --sandbox` or `--unattended` is on.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `sandbox.allowedHosts` | string[] | `[]` | Extra hosts (for example package registries) workers may reach. The model API host is always allowed. |

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

### `verification`

M4 Verification. Every part is off by default; later releases fill in the behaviour behind each switch. Nested objects are merged key by key, so a partial block such as `{"mutation": {"floor": 0.8}}` keeps all other defaults. Panel and oracle calls reuse the judge role with a different model, there is no new role.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `verification.contracts.enabled` | boolean | `false` | The planner writes acceptance criteria as a machine-readable contract that workers can only mark passing, never edit. Unresolved ambiguities block the plan. |
| `verification.panel.enabled` | boolean | `false` | Score with a panel of judges and record per-judge votes and disagreement. |
| `verification.panel.judges` | `{model, lineage?}[]` | `[]` | Panel members. `lineage` names the prompt variant used for that judge. |
| `verification.panel.escalateModel` | string or null | `null` | Model that breaks split votes. `null` uses the harness judge model. |
| `verification.agenticJudge.enabled` | boolean | `false` | The judge runs builds, tests and scenario checks per requirement instead of only reading the diff. |
| `verification.agenticJudge.checkTimeoutMs` | number | `120000` | Timeout for one check command. |
| `verification.oracles.enabled` | boolean | `false` | Grade repos without tests with oracles the worker did not write. |
| `verification.oracles.model` | string or null | `null` | Model that writes oracle tests. `null` uses the judge model, never the worker's. |
| `verification.oracles.propertyRuns` | number | `50` | Cases per property-based check. |
| `verification.oracles.seed` | number | `1` | Property test seed, fixed so runs reproduce. |
| `verification.oracles.differential` | boolean | `true` | Compare unchanged behaviour against the base commit. |
| `verification.oracles.excludeWorkerTests` | boolean | `true` | A worker's own tests never count towards its grade. |
| `verification.mutation.enabled` | boolean | `false` | Report a mutation score per run. |
| `verification.mutation.floor` | number | `0.6` | Minimum share of mutants that tests and scenarios must kill (0 to 1). |
| `verification.mutation.maxMutants` | number | `20` | Cap on mutants generated per run. |
| `verification.mutation.failBelowFloor` | boolean | `false` | Fail the run when the score is under the floor. `false` reports only. |


With the panel on, `judgeTiers` is bypassed. Each member sees a framing line chosen by `lineage` (`strict`, `literal`, `scenario`, or any custom name; omit or `default` for none). Votes are per criterion; a tie on any criterion calls `escalateModel` once and its verdict decides (`verdict.panel.escalated` is `true`). Members that return no verdict are skipped. `verdict.panel.disagreement` is the mean share of judges in the minority per criterion. Contrastive repair also compares in both orders and picks nothing when the orders disagree.

### `context.atlas`

Off by default. The Repo Atlas is a deterministic, commit-keyed code graph (files, symbols, imports, references, tests) built with regex extractors, no LLM and no dependencies. It is stored at `.orchestra/atlas/<sha>.json` and refreshed incrementally from the nearest cached commit. Build or inspect it by hand with `orchestra atlas build` and `orchestra atlas stats`; those commands work even when the atlas is disabled.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `context.atlas.enabled` | boolean | `false` | Use the atlas in runs: a ranked repo map for the planner and the shared worker prefix. |
| `context.atlas.mapTokens` | number | `1024` | Token budget of the ranked repo map (L0). |
| `context.atlas.packs` | boolean | `false` | Add a per-task pack (L1: footprint signatures, callers, importers, related tests) to the worker prompt body. |
| `context.atlas.packTokens` | number | `1500` | Token budget of each task pack. |

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

### `learnings`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `learnings.expiryDays` | number | `0` | Drop lessons whose newest evidence is older than this many days, or whose harmful count is well above helpful, after each run. `0` disables expiry. See [self-improvement.md](self-improvement.md#learnings-orchestra-learnings). |

### `evolve`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `evolve.every` | number | `3` | Auto-evolve after every N completed runs. `0` disables. |
| `evolve.autoPromote` | boolean | `true` | Promote a candidate automatically when it beats the current version. If `false`, a winning candidate is kept but not promoted. |
| `evolve.minGain` | number | `0.02` | Minimum eval score gain a candidate needs to count as better. The gain must also exceed the observed spread (standard deviation of per-case score deltas), with no regressions. |
| `evolve.promotionRule` | `"gain"` or `"paired"` | `"gain"` | Promotion rule. `gain` keeps the gain-above-spread rule. `paired` promotes only when the lower bound of the 95% CI on the mean paired gain (standard errors clustered by source goal) is above zero and no task type's mean delta is below `-niMargin`. Fewer than 125 paired cases is reported as unproven. Gates on `minCases`, regressions and the integrity monitor still apply. |
| `evolve.niMargin` | number | `0.05` | Paired rule only: non-inferiority margin per task type. |
| `evolve.minJudgeAgreement` | number or `null` | `null` | Judge calibration floor. When set and the incumbent's measured agreement between judge verdicts and bench hidden checks is below it (needs at least 10 bench runs for that harness version), `orchestra evolve` refuses to run and says why. `null` disables the check. See [bench.md](bench.md#judge-calibration). |
| `evolve.sample` | number | `5` | Eval cases used per evaluation, newest first. Bounds cost. Keep it at or above `evolve.minCases`, or promotion is never possible. |
| `evolve.minCases` | number | `5` | Minimum eval cases that must be evaluated before a candidate can be promoted. Fewer cases and the candidate is rejected with a reason. |
| `evolve.candidates` | number | `1` | Variants proposed per evolve cycle. `1` keeps the single-variant cycle. Above `1`, candidates are screened on `min(2, sample)` cases, survivors are composed into one variant, and only that variant gets the full evaluation. See [self-improvement.md](self-improvement.md#multi-candidate-evolution-evolvecandidates). |
| `evolve.budgetUsd` | number | `0` | Hard cap in USD on spend per evolve cycle (evolver calls plus eval replays). The cycle checks the cap before each replay batch using the running average cost per replay, and halts with the candidate kept for later evaluation. `0` means no cap. See [self-improvement.md](self-improvement.md#cycle-controls-m3). |
| `evolve.sequential.enabled` | boolean | `false` | Evaluate the candidate in rounds and stop as soon as the CI on the paired gain settles the comparison (lower bound above zero, or upper bound below `-niMargin`). The CI is widened for the number of planned rounds (alpha 0.05 split across them, Bonferroni style), so peeking after every round does not inflate the false promotion rate. |
| `evolve.sequential.roundSize` | number | `3` | Cases per round. A value below 1 means one round. A CI needs at least two source goals, so the first round alone rarely settles. No early stop happens before `evolve.minCases` cases are evaluated. |
| `evolve.splits.enabled` | boolean | `false` | Split eval cases by age into feedback, validation and a locked holdout. The evolver sees feedback cases only, selection uses validation, and the holdout (newest cases) is touched only to confirm a promotion. Assignments are persisted in `.orchestra/splits.json` and never change once made. |
| `evolve.splits.feedback` / `validation` / `holdout` | number | `0.3` / `0.5` / `0.2` | Split ratios (normalised, so they need not sum to 1). With 3 or more cases the holdout and validation each get at least one. |
| `evolve.splits.signoffBelow` | number | `12` | With splits on and fewer eval cases in total than this, a winning candidate is kept and is not promoted until a human promotes it (`orchestra promote <vN>`). |
| `evolve.cascade.enabled` | boolean | `false` | Cascade screening: a smoke test, then a minibatch against the parent, then full validation for the top finalists only. A cycle where nothing clears the minibatch stops with no full-validation spend. |
| `evolve.cascade.minibatch` | number | `2` | Newest validation cases a candidate must beat its parent on (without regressing). |
| `evolve.cascade.finalists` | number | `2` | Candidates that go on to full validation, best minibatch gain first. |
| `evolve.pareto.enabled` | boolean | `false` | Choose the parent from the Pareto archive (variants best on at least one validation case), show the evolver the scored archive history, and record per-case wins and stepping stones in `archive.json`. |
| `evolve.regression.enabled` | boolean | `false` | Always replay the cases tagged `regression` (`orchestra evals add --regression`, human-fix harvests) in the validation sample, ahead of the newest cases and capped at one sample's worth. Drawn from the validation pool only, so with splits on the holdout and feedback cases are never pulled in. |
| `evolve.cost.enabled` | boolean | `false` | Cost-aware objective: a variant whose cost rises more than `maxCostRisePct` without a matching gain is rejected, and candidates are ranked by utility rather than raw score. |
| `evolve.cost.maxCostRisePct` | number | `25` | Largest allowed cost rise over the incumbent, in percent. |
| `evolve.cost.minGainForCost` | number | `0.02` | Score gain that excuses a cost rise above the limit. |
| `evolve.cost.costWeight` / `timeWeight` | number | `0.1` / `0.02` | SICA-style utility: `score - costWeight x USD - timeWeight x minutes`. |

Example:

```json
{
  "concurrency": 2,
  "testCommand": "npm test --silent",
  "runBudgetUsd": 10,
  "evolve": { "every": 0, "candidates": 3 }
}
```

All M3 evolve options are off by default, so an existing config behaves exactly as before. A fuller opt-in example:

```json
{
  "evolve": {
    "budgetUsd": 15,
    "splits": { "enabled": true },
    "cascade": { "enabled": true, "minibatch": 2, "finalists": 2 },
    "sequential": { "enabled": true, "roundSize": 3 },
    "cost": { "enabled": true },
    "pareto": { "enabled": true }
  },
  "learnings": { "expiryDays": 60 }
}
```

Eval case files (`.orchestra/evals/<id>.json`) also accept optional `createdAt` (ms epoch, orders the time split), `tags` (for example `regression`) and `reference` (a known-good fix, never shown to workers). `orchestra evals add` writes them for you.

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
- Agent sessions cannot write to the harness, evals or archive (denied by the guard hook in `src/guard.ts`, a backstop; the OS sandbox confines writes when enabled).

## Environment variables

| Variable | Meaning |
|---|---|
| `ORCHESTRA_RUNNER` | Set to `fake` to use the built-in simulator instead of real Claude sessions. Any other value uses Claude. |
| `ORCHESTRA_FAKE_STEP_MS` | Delay in milliseconds per simulated step when the fake runner is active. Defaults to `150`. |
