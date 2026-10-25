# Self-improvement

Orchestra measures its own harness, proposes a better one, tests the proposal against past work, and promotes it only when the numbers improve. This page covers the pieces and the commands behind them. The design follows the Darwin Godel Machine idea of keeping an archive of variants (see `src/evolve.ts`).

All paths below are relative to the `.orchestra` directory in your repo.

## The harness

The harness is the evolvable part of the factory: role prompts (`planner.md`, `worker.md`, `judge.md`, `librarian.md`, `evolver.md`) plus `config.json` (models, `maxAttempts`, `passThreshold`, per-role `budgetUsd`) and three small optional text files (`tools.md`, `style.md`, `checklist.md`).

### Small evolvable files

The evolver can tune one habit by editing a short file instead of rewriting a whole role prompt. Each file is injected as its own labelled section in the stable part of the prompt, so prompt caching still works.

| File | Section | Received by | Purpose |
| --- | --- | --- | --- |
| `tools.md` | `TOOL GUIDANCE:` | worker, and the read-only part of the judge | Tool-use habits, such as how to search or run tests |
| `style.md` | `STYLE:` | worker only | Repo coding conventions learned over time |
| `checklist.md` | `REVIEW CHECKLIST:` | judge only | Extra review checks |

- **Checklist only adds strictness.** A variant may append lines to `checklist.md` or reword a line by adding to it, but may not remove any line the parent had. This is the same spirit as `passThreshold` never going down, and `createVariant` rejects violations.
- **Missing files are empty.** Harness versions created before these files existed still load, and a missing file is treated as empty, so no section is added.
- **Out of scope.** Evolvable skills and executable scripts are not part of the harness. Only text files are evolvable.

- Each version lives in `harness/<vN>/`, seeded from `harness/v1` in the package on `orchestra init`.
- `harness/current` names the active version.
- `archive.json` records every version with its parent, rationale, eval score and status (`promoted`, `candidate`, `rejected`, `retired`).
- Versions are append-only. Nothing is overwritten, so any version can be made current again.

## Metrics per version: `orchestra stats`

```
orchestra stats [--plain] [--color]
```

Prints one row per harness version that has completed goal runs, then the number of Factory Eval cases and the known versions. Metrics come from run records and the cost ledger (`metrics()` in `src/evolve.ts`):

| Metric | Meaning |
| --- | --- |
| runs, tasks, merged | Completed goal runs, their tasks, and tasks that merged |
| first-pass yield | Tasks merged on attempt 1, divided by all tasks |
| satisfaction | Mean run satisfaction |
| cost per merged | Total ledger cost for the version divided by merged tasks |

Evaluation runs (`kind: eval`) are excluded, so evolution does not distort the numbers it is judged on.

## Learnings: `orchestra learnings`

After each run the librarian distills lessons for the planner, worker and judge roles. Lessons are scoped by domain, a short slug such as `cli`, `web-ui`, `docs` or `config` that the planner assigns to the run.

**Layout** (relative to `.orchestra`):

- `learnings/<domain>.json`: lessons for one domain.
- `learnings/_global.json`: lessons that are clearly general across domains.
- `learnings.md`: readable mirror, grouped by domain (global first), rewritten after each run.

**Migration.** On first read, an existing `learnings.json` becomes `learnings/_global.json`. Its lessons get a placeholder evidence entry (`run: legacy`) and `hits: 0`.

**Evidence and hits.** Each lesson has `evidence` (a list of `{run, task?}` ids from run reports) and `hits`. The librarian must cite evidence, and lessons without evidence are dropped.

**Cap.** Each domain (and global) keeps at most 25 lessons, not the whole store. Over the cap, lessons with the least recent evidence are dropped first.

**Retrieval budget.** The planner and worker prompts get a `LEARNINGS:` section (`src/conductor.ts`) with at most 15 lessons: the run's domain first, then global. The evolver gets a per-domain summary (counts and top lessons), not the full store. The files are plain JSON and Markdown you can read and edit.

**Viewing.**

```
orchestra learnings                  # the whole mirror, or a hint if no run has completed yet
orchestra learnings --domain cli     # only the cli lessons: role, text, evidence ids, hits
orchestra learnings --domain global  # only the global lessons
```

An unknown domain exits non-zero and lists the known domains.

**Lesson hygiene.** The librarian returns item edits, never the whole set. Each lesson has a stable `id`, and an edit is `add`, `update` (new text, extra evidence, optional `helped` true or false) or `remove`, addressed by id. Lessons the librarian does not mention are kept, and a response shaped like a full rewrite is converted into edits (matching lessons are updated, new ones added, nothing is removed). `applyLessonEdits` in `src/learnings.ts` is the only path from model output to the store.

- **Counters.** Each lesson carries `helpful` and `harmful` counts. Older files without them load as zero.
- **Expiry (opt-in).** Set `learnings.expiryDays` above 0 in `.orchestra/config.json` to drop, after each run, lessons whose newest evidence is older than that many days, or whose harmful count is well above helpful. `0` (the default) never expires anything.
- **Ablation.** `orchestra evals ablation` replays the locked holdout cases twice, with and without the learnings store, and prints per-case scores, the mean delta and its 95% CI. A positive delta means lessons help. It costs two replays per holdout case. Normal eval replays stay clean-room; only the with-lessons arm of this command reads learnings.

**Contrast evidence.** When [contrastive repair](configuration.md#contrastive) ran, the comparison judge's reasons for why one attempt beat the other are passed to the librarian as lesson evidence, so lessons can cite a concrete winning approach.

## Factory Eval: `orchestra evals`

```
orchestra evals
```

The Factory Eval is a set of regression cases stored as JSON files in the `evals` directory. Each case has an `id`, the original `goal`, a `base` commit to start from, and an optional shell `check` that must pass on the result.

- **Harvesting is automatic.** After a goal run finishes with status `done`, satisfaction of at least 0.8 and a recorded base commit, the run becomes a case. The `check` is copied from the project `testCommand`.
- `orchestra evals` lists each case with its short base commit, check and goal, or says none exist yet.
- To score a harness version, each case is replayed as an eval run. A case passes if the run is `done` and the `check` (if any) passes on the integration branch. The case score is the run satisfaction, or 0 on failure. The version score is the mean across cases.
- Eval runs delete their `orchestra/<run>/*` branches afterwards.
- **Clean-room trials.** Every replay gets its own fresh worktree cut from the case's `base` commit (unique run id, nothing reused), reads no learnings (the planner and worker prompts show `(none yet)` for eval runs, so lessons accumulated on past goals cannot leak into the comparison) and carries no cache between trials. Branches sit in the same repository, so history beyond the base commit is not hidden.
- **Interleaved.** The candidate and incumbent replay the same case back to back (candidate, incumbent, candidate, incumbent...) instead of as two batches, so drift in the infrastructure hits both sides alike.
- **Your own cases.** `orchestra evals add "<goal>"` adds a case you choose (see [Harder and imported cases](#harder-and-imported-cases)).
- **Infra failure rate.** Replays that die of infrastructure (usage limit, auth, network) are inconclusive. `EvalResult.infraFailureRate` is infra-failed replays divided by replays attempted, per side. The first infra failure ends the pair, so a non-zero rate means the comparison was inconclusive.

### Harder and imported cases

Automatic harvesting only keeps successes, so the set under-represents hard goals. These commands add the rest. All of them write only to the repo's own `.orchestra/evals`, and none runs a model.

```
orchestra evals add "<goal>" [--base <ref>] [--check <cmd>] [--id <id>] [--tag <t>] [--regression] [--reference <ref>]
orchestra evals add --from-run <runId> --fix <commit>
orchestra evals list [--regression | --tag <t>]
orchestra evals audit
```

- **Add.** `--base` defaults to `HEAD` and is stored as the full commit sha. `--check` defaults to the project `testCommand`. The case id defaults to `m-<goal slug>`. `--regression` adds the `regression` tag, which is how you keep a regression suite of past bugs; `list --regression` shows it.
- **Human-fix harvest.** `--from-run <runId> --fix <commit>` turns a goal run that failed, or finished `done` with satisfaction below 0.8, into a case `h-<runId>`. The goal and base commit come from the run, and the diff from that base to your fix commit is stored as `reference` (the human fix), never shown to workers. It is tagged `human-fix` and `regression`. Successful runs are refused because they are harvested automatically. `evals harvest` is an alias for the same flags.
- **Leakage audit.** `orchestra evals audit` scans every case and every lesson in the learnings store for solution leakage: a goal that embeds a unified diff, a goal that quotes a telling line (24 characters or more) of its own reference fix, or a lesson that quotes a case's reference or full goal text. `add` runs the same check on the new case and refuses a leaky one.
- **Exit codes.** `audit` exits `0` when the set is clean, when it is empty, and when Orchestra is not initialised in the repo (or there is no git repo): there is nothing to audit, and CI runs the audit in a fresh checkout where `.orchestra/` does not exist, so a failure there would only be noise. It prints a clear message in each case. It exits `1` and lists each finding when it finds leakage. The CI workflow runs it after `npm test`.
- **Unknown subcommands** exit 1 and list the known ones (`list`, `add`, `harvest`, `audit`, `ablation`).

## Frozen scorer

Promotion scores come from a frozen scorer, not from the candidate harness's own judge. It lives in the top-level `scorer/` directory (`config.json` pinning `version`, `model` and `budgetUsd`, plus `judge.md` and `checklist.md`), outside `EVOLVABLE_FILES` and never shown to the evolver. `src/scorer.ts` loads it and `evaluate()` in `src/evolve.ts` uses it for every eval replay.

- A replay scores 0 unless the case `check` passed (when the case has one) and the scorer's verdict passed. Otherwise the score is the scorer's 0 to 1 score. `run.satisfaction` from the candidate's judge is not used.
- The candidate's judge still runs during the replay and its text can feed repair, but it has no say in promotion.
- The agent guard denies writes to the installed `scorer/` (a `scorer/` directory in the repo being worked on is ordinary code). Changing the scorer is a deliberate edit by you, and its version is part of `scorer/config.json`.
- Scorer calls are recorded in the ledger as `eval` entries with the scorer model.

## Integrity monitor

`src/integrity.ts` is a pure function over a unified diff (no file or process IO). The conductor runs it on every worker diff and on eval replays, and stores the flags on `task.integrityFlags`.

- **Grading surface.** Edits to scenario files, CI workflows or a root-level `scorer/` are flagged, as is deleting a test file. Editing an existing test file is normal work; only weakening it counts (next item).
- **Weakened test.** A deleted test file, a net loss of assertion lines, or an added `skip`, `only` or `todo`.
- **Reward hack.** Early success exits (`process.exit(0)`, `exit 0`), monkey-patching globals or assert helpers, branching on the test environment, and special-casing a literal input.
- **Restore and repair.** If a task edits a grading file that existed at the base commit, the conductor re-runs the `testCommand` with the original files restored and grades on that. The task fails the attempt with an automatic repair note (prefixed `[integrity-monitor]`) telling the worker to revert the change, or to stop with `FLAG_FOR_HUMAN` if a test change is truly required. Newly added tests are normal work and do not trigger this.
- **Promotion blocking.** Each replay counts its flags. `promotionDecision` rejects a candidate whose monitor fire rate (flags per replayed run) is more than one flag higher than the incumbent's (`MONITOR_SLACK_FLAGS`, so a single heuristic false positive cannot veto a better harness), and the rates appear on the `EvalResult` and in the archive.
- **Hidden from the evolver.** Monitor text and rates are filtered out of every evolver prompt, so the evolver cannot optimize against the monitor.

## Hand the task to a human: `FLAG_FOR_HUMAN`

A worker that finds the spec and the tests contradict each other ends with `FLAG_FOR_HUMAN: <reason>` instead of bending the tests. This is a stop condition, not a failure: the task becomes `needs_human` with the reason stored, gets no repair retries, and is reported separately in the run summary and dashboards. This removes the pressure that repeated failures put on a worker to cheat. See [architecture](architecture.md#the-attempt-and-retry-loop).

## Evolution: `orchestra evolve`

```
orchestra evolve
```

One evolution cycle (`evolve()` in `src/evolve.ts`):

1. **Study.** The evolver (role prompt in `harness/v1/evolver.md` in the package) receives the current harness files, metrics per version, recent repair notes and failures, up to five previously rejected variants, and the learnings. It runs with no tools and returns a rationale plus replacement files.
2. **Propose.** `createVariant` copies the incumbent into the next `vN+1` directory, applies the changed files, and records it in the archive as `candidate`.
3. **Evaluate.** The most recent `evolve.sample` eval cases are run against the incumbent and then the candidate. With no eval cases, the candidate is kept unevaluated for later.
4. **Decide.** The candidate wins only if its score beats the incumbent by at least `evolve.minGain` and no case that the incumbent passed fails for the candidate.
5. **Promote or record.** If it wins and `evolve.autoPromote` is true, it is promoted. Otherwise the archive status becomes `candidate` (kept, autoPromote off) or `rejected`.

The command prints whether it promoted or kept the incumbent, with the reason and both eval scores, then the infra failure rate of the incumbent and the candidate replays. `orchestra stats` also lists the infra failure rate of each version's last full evaluation. Evaluation reruns past goals, so one cycle costs roughly `sample x 2` runs plus the evolver call.

**Paired promotion rule.** Set `evolve.promotionRule` to `"paired"` (default `"gain"`) to replace gain-above-spread with a per-case paired comparison (`src/stats.ts`). Standard errors are clustered by source goal (plain paired SE when every goal has one case) and the 95% CI uses Student t. A candidate is promoted when the CI lower bound is above zero and no task type's mean delta is below `-evolve.niMargin` (default 0.05); it is rejected when the CI upper bound is below zero or a task type regresses beyond the margin; otherwise the result is inconclusive and nothing is promoted. A promotion on fewer than 125 paired cases is marked unproven in the reason. Every decision, in either mode, reports the CI, pass@1 and pass^3 (pass^3 is n/a until a goal has 3 repeats). Eval cases may carry optional `source` and `taskType` fields; they default to the case id and `unknown`.

The `evolve` settings live in `config.json`, with defaults `every: 3`, `autoPromote: true`, `minGain: 0.02`, `sample: 5`, `minCases: 5`, `candidates: 1`. A `sample` below `minCases` is raised to `minCases`, so an old `config.json` that pins a small value cannot block promotion. With fewer than `minCases` eval cases, `evolve` keeps the candidate for later and spends no eval runs. If an eval run dies of infrastructure (usage limit, auth, network), the result is inconclusive: the candidate stays a candidate and no score is recorded.

## Multi-candidate evolution: `evolve.candidates`

Opt-in. `evolve.candidates` defaults to `1`, which keeps the single-variant cycle above unchanged, in behaviour and cost. With `candidates: k` (k > 1) a cycle becomes:

1. **Propose k.** One evolver call returns `{ variants: [{ rationale, files }] }` with k variants. Each must target a different weakness and must not repeat a previously rejected variant. Every variant is recorded with `createVariant` and gets an `archive.json` entry.
2. **Screen.** Each candidate is run on a small screening sample of the eval cases, `min(2, evolve.sample)`, against the incumbent on the same cases. A candidate that regresses any case the incumbent passes is dropped: its archive entry is marked `rejected` and stores its `screenScore`, so later prompts list it under PREVIOUSLY REJECTED VARIANTS.
3. **Compose.** If two or more candidates survive, a second evolver call (prompt starts with `COMPOSE VARIANTS`) receives the survivors, their per-case scores and their rationales. It returns one composed variant that keeps only edits backed by score evidence. It is recorded with `createVariant`, and its archive entry has `parents` listing the surviving versions it was built from. A single survivor skips this step and goes forward as is.
4. **Decide.** The composed variant (or the single survivor) gets the full `evolve.sample` evaluation against the incumbent, and `promotionDecision()` decides exactly as before: `evolve.minCases`, the no-regression rule and the spread rule are unchanged. Screening scores never promote anything.
5. **Record.** The result is archived like a normal candidate (`candidate`, `promoted` or `rejected`). If every candidate is screened out, nothing is promoted and the incumbent stays.

**Cost model.** A dud single candidate wastes roughly `2 x sample` eval runs. Multi-candidate evolution spends about `k x screen + 2 x sample` (plus two evolver calls), where `screen = min(2, sample)`. Duds are caught at the screening price, so the full evaluation is spent on a variant that already passed a cheap check. Because `k x screen` is paid every cycle, keep `k` small (2 to 4).

New archive fields: `parents` (version names a composed variant was built from, absent otherwise) and `screenScore` (the screening score, present on candidates that were screened).

## Cycle controls (M3)

Every option here is opt-in and off by default; with none set, `orchestra evolve` behaves as described above. Keys are listed in [configuration.md](configuration.md#evolve).

- **Time-split eval sets (`evolve.splits`).** Cases are ordered by `createdAt` (then id) and split deterministically, oldest to newest, into feedback (about 30%), validation (50%) and a locked holdout (20%). The evolver prompt lists feedback cases only and never contains holdout or validation cases. Selection uses validation cases. The holdout is evaluated only after a candidate would otherwise be promoted, to confirm it beats its parent there, and it is never used for selection. If it does not, the candidate is kept, not promoted, and its `holdoutScore` is stored in the archive. With fewer than `signoffBelow` (12) cases in total, a winning candidate is kept for a human to promote.
- **Cascade screening (`evolve.cascade`).** (1) Smoke test per candidate: the checklist lines, pass threshold and models of the parent must be intact, and one case must pass. (2) Minibatch: each survivor must beat its parent on the same newest `minibatch` cases without regressing. (3) Full validation only for the top `finalists` by minibatch gain. A cycle where nothing clears the minibatch stops there and spends nothing on full validation. This replaces the older screening used with `evolve.candidates` above.
- **Sequential testing and budget (`evolve.sequential`, `evolve.budgetUsd`).** Validation runs in rounds of `roundSize` cases. After each round the paired 95% CI (clustered by source goal) is checked and the cycle stops early on a settled comparison: promote-side when the lower bound is above zero, reject-side when the upper bound is below zero or `-niMargin`. `budgetUsd` is a hard cap per cycle for evolver calls plus replays; the cycle halts before a batch that would cross it and keeps the candidate for later evaluation. `0` means no cap.
- **Cost in the objective (`evolve.cost`).** Utility is `score - costWeight x USD - timeWeight x minutes`. A candidate whose cost rises more than `maxCostRisePct` over the incumbent is rejected unless its score gain is at least `minGainForCost`, so a cost-inflating variant with equal quality does not win.
- **Pareto archive (`evolve.pareto`).** The archive keeps the per-case validation scores of each variant. Every variant best on at least one validation case stays on the front. The parent of the next variant is the front member with the most Pareto wins plus descendants that beat it (ties broken by score, then version). The evolver prompt gets a compact scored history of recent versions (parent, status, score, wins; never holdout scores). Front members that are not promoted are marked `stepping` in `archive.json`; the best overall is still the only one promoted.
- **Holdout confirmation (H3).** A promotion with splits on means the candidate beat its parent on the validation cases and on the locked, newest-cases holdout. The outcome prints both holdout scores.

Lesson hygiene (item-level edits, counters, expiry and the `orchestra evals ablation` with-lessons versus without-lessons report on the holdout) is covered under [Learnings](#learnings-orchestra-learnings).

## Automatic evolution after a run

At the end of `orchestra run`, the run is harvested if eligible, then `evolutionDue()` is checked. Evolution fires when at least `evolve.every` goal runs have finished on the current version since the last variant was created from it. Setting `every` to 0 disables the check.

```
orchestra run "<goal>" --no-evolve
```

`--no-evolve` skips the automatic check for that run (it is also forwarded when `run` starts a detached background run). You can still call `orchestra evolve` by hand at any time.

## Promote and rollback: `orchestra promote <vN>`

```
orchestra promote v2
orchestra promote v1    # rollback
```

`promote` points `harness/current` at the given version, marks it `promoted` in the archive, and marks the previous version `retired`. It fails if the version directory does not exist, and prints `harness <vN> is now current`.

There is no separate rollback command: rolling back is promoting an older version. Because versions are never deleted, this is instant and lossless. Use `orchestra stats` to see the known versions. Runs already finished keep the harness version recorded in their run file.

## Guard rails

Rails are enforced in code, not only in prompts:

- **Evolvable set.** The evolver can only edit the 8 files `planner.md`, `worker.md`, `judge.md`, `librarian.md`, `config.json`, `tools.md`, `style.md` and `checklist.md`. Any other file name is rejected (`EVOLVABLE_FILES` in `src/harness.ts`). It cannot edit `evolver.md`.
- **No lowered bar.** A `config.json` with a lower `passThreshold` than its parent is rejected, as is one missing a model for any role. A `checklist.md` that drops a line the parent had is rejected too.
- **Measured gain only.** Promotion needs `minGain` and zero regressions on the sampled eval cases, scored by the frozen scorer, and no rise in the integrity monitor fire rate beyond one flag.
- **Frozen scorer.** `scorer/` is outside the evolvable set, and the guard blocks writes to the installed copy.
- **Agent hook** (`src/guard.ts`, run as `orchestra guard`). A deny-list backstop, not the isolation boundary (the OS sandbox is; see [architecture.md](architecture.md#boundary-model-os-sandbox-first-guard-hook-as-backstop)). Every agent session gets a PreToolUse hook that denies:
  - any access to the hidden holdout scenarios (visible to the judge only)
  - writes to the harness, evals or archive files (read, grep and glob stay allowed)
  - Bash network commands (`curl`, `wget`, `ssh`, and similar), `git push`, `npm publish` and `gh` create commands
  - secret files such as `.env`, `.npmrc`, SSH keys, `.pem` and `.key` files
  - unreadable hook input, which fails closed
- **Reversibility.** Variants are append-only and runs work on `orchestra/<run>/*` branches. The active harness changes only through `promote`, by evolution or by you.

## Try it without spending money

`orchestra demo` uses the simulator and sets `evolve.every` and `evolve.sample` to 1 in its temporary project, so the whole loop runs quickly.

## Judge calibration floor (`evolve.minJudgeAgreement`)

The evolver optimises against the judge, so a drifting judge corrupts evolution. Set `evolve.minJudgeAgreement` (for example `0.8`) and `orchestra evolve` first measures the incumbent's agreement between judge verdicts and bench hidden checks. With at least 10 bench runs on record and agreement below the floor, it returns without calling the evolver and the reason names the floor. Unset (`null`, the default) behaviour is unchanged. See [bench.md](bench.md#judge-calibration).
