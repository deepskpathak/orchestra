# Self-improvement

Orchestra measures its own harness, proposes a better one, tests the proposal against past work, and promotes it only when the numbers improve. This page covers the pieces and the commands behind them. The design follows the Darwin Godel Machine idea of keeping an archive of variants (see `src/evolve.ts`).

All paths below are relative to the `.orchestra` directory in your repo.

## The harness

The harness is the evolvable part of the factory: role prompts (`planner.md`, `worker.md`, `judge.md`, `librarian.md`, `evolver.md`) plus `config.json` (models, `maxAttempts`, `passThreshold`, per-role `budgetUsd`).

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

## Factory Eval: `orchestra evals`

```
orchestra evals
```

The Factory Eval is a set of regression cases stored as JSON files in the `evals` directory. Each case has an `id`, the original `goal`, a `base` commit to start from, and an optional shell `check` that must pass on the result.

- **Harvesting is automatic.** After a goal run finishes with status `done`, satisfaction of at least 0.8 and a recorded base commit, the run becomes a case. The `check` is copied from the project `testCommand`.
- `orchestra evals` lists each case with its short base commit, check and goal, or says none exist yet.
- To score a harness version, each case is replayed as an eval run. A case passes if the run is `done` and the `check` (if any) passes on the integration branch. The case score is the run satisfaction, or 0 on failure. The version score is the mean across cases.
- Eval runs delete their `orchestra/<run>/*` branches afterwards.

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

The command prints whether it promoted or kept the incumbent, with the reason and both eval scores. Evaluation reruns past goals, so one cycle costs roughly `sample x 2` runs plus the evolver call.

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

- **Evolvable set.** The evolver can only edit `planner.md`, `worker.md`, `judge.md`, `librarian.md` and `config.json`. Any other file name is rejected (`EVOLVABLE_FILES` in `src/harness.ts`). It cannot edit `evolver.md`.
- **No lowered bar.** A `config.json` with a lower `passThreshold` than its parent is rejected, as is one missing a model for any role.
- **Measured gain only.** Promotion needs `minGain` and zero regressions on the sampled eval cases.
- **Agent hook** (`src/guard.ts`, run as `orchestra guard`). Every agent session gets a PreToolUse hook that denies:
  - any access to the hidden holdout scenarios (visible to the judge only)
  - writes to the harness, evals or archive files (read, grep and glob stay allowed)
  - Bash network commands (`curl`, `wget`, `ssh`, and similar), `git push`, `npm publish` and `gh` create commands
  - secret files such as `.env`, `.npmrc`, SSH keys, `.pem` and `.key` files
  - unreadable hook input, which fails closed
- **Reversibility.** Variants are append-only and runs work on `orchestra/<run>/*` branches. The active harness changes only through `promote`, by evolution or by you.

## Try it without spending money

`orchestra demo` uses the simulator and sets `evolve.every` and `evolve.sample` to 1 in its temporary project, so the whole loop runs quickly.
