# Orchestra: A Self-Improving Multi-Agent Software Factory with Hidden Verification

**Whitepaper, describing Orchestra version 0.6.0** (`package.json`, `CHANGELOG.md`). Written 2026-10-22.

Every statement about Orchestra below points to a file in this repository. Statements about outside work are marked `(unverified)` when they could not be confirmed while writing. **This paper reports no empirical results.** The repo contains no benchmark of Orchestra against other systems, and none is claimed here (see [section 7](#7-methodology) and [section 8](#8-limitations)).

## Abstract

Orchestra is a command line tool and Claude Code plugin that turns a goal into reviewed code on a git branch. It runs five agent roles (planner, worker, judge, librarian, evolver) around git worktrees, a serialized merge queue and an append-only event log (`docs/architecture.md`, `src/conductor.ts`). Its central design choices are: (1) the judge checks each task against hidden given/when/then scenarios that workers cannot read, and this is enforced by a hook in code (`src/guard.ts`) as well as by prompt; (2) failures feed a repair loop, optionally with a contrastive step that compares two independent repair attempts (`src/contrast.ts`); (3) the factory's own prompts and config form a versioned harness that an evolver can change, with promotion allowed only after a measured gain over the incumbent on a regression set harvested from past successful runs (`src/evolve.ts`, `src/harness.ts`); and (4) lessons are stored per domain with evidence and capped retrieval (`src/learnings.ts`). Runs can be followed in a web dashboard, a terminal dashboard or a one-shot board, all reading the same files (`src/dashboard-data.ts`). We describe the design, the evaluation method, and the limits. Empirical results are not yet available, so we propose an evaluation protocol for real runs instead of reporting numbers.

## 1 Introduction and motivation

Coding agents are now good enough that the hard problems move from "can the model write this function" to "how do we know the result is right, and how does the process get better over time". `PLAN.md` frames this as the shift of a software factory from generating code to orchestrating, verifying and improving agents. It names three properties of a modern factory: spec in and software out, validation instead of human diff review, and a factory that improves itself.

Orchestra is a small, zero-dependency implementation of that idea (`README.md`, `CHANGELOG.md` entry 0.1.0). It targets a developer who wants to hand over a multi-part goal and review one integration branch at the end, rather than supervise a single long conversation.

We built it around four problems that `PLAN.md` and `docs/research/cost-accuracy-speed.md` identify in existing practice:

1. **Agents mark their own homework.** If the author of a change also decides it is done, errors pass. Orchestra separates roles: planners never code and judges never edit (`README.md`, `harness/v1/judge.md`).
2. **Visible tests invite gaming.** Workers can pass tests they can see without meeting intent. Orchestra keeps hidden scenarios outside every worktree (`docs/architecture.md`, "Hidden holdout scenarios").
3. **Long conversations lose state.** Orchestra keeps durable state in git and in a `.orchestra/` directory, and uses a fresh agent context per attempt (`docs/architecture.md`, `src/agent.ts`, `src/store.ts`).
4. **Self-modification without measurement drifts.** Orchestra lets the factory propose changes to itself but gates promotion on a measured gain with no regressions (`docs/self-improvement.md`).

The contributions of the repository, as documented, are the combination of these elements in one tool, the specific promotion gate (`promotionDecision` in `src/evolve.ts`), multi-candidate evolution (0.6.0), per-domain learnings with evidence (0.5.0), contrastive repair (0.6.0), and two dashboards that share one data layer (0.4.0). We make no claim that any of these outperforms an alternative. No such comparison exists in the repo.

## 2 Related work

This section follows the survey in `PLAN.md` (sections 1 and 2) and `docs/research/cost-accuracy-speed.md`, and adds a few well-known academic sources. Links are in [section 11](#11-references). Details of outside systems come from those repo notes, which themselves say some claims were read from abstracts only. We repeat their caveats.

**Software factories and agent harnesses.** `PLAN.md` compares several recent systems. StrongDM's software factory uses scenarios as holdout sets stored outside the repo and a satisfaction metric rather than pass or fail. Orchestra adopts both ideas (hidden scenarios stored per run outside every worktree, and run satisfaction in `src/conductor.ts`). Gas Town contributes explicit roles and a merge queue, which maps to Orchestra's serialized merge queue. Cursor's write-up on scaling agents contributes the planner and worker split and a judge that decides when work is done. Anthropic's long-running agent harness contributes fresh sessions, progress files and git as state. Orchestra writes a per-task progress file for repair attempts at `.orchestra/runs/<run>/progress/<task>.json` (`CHANGELOG.md`, 0.2.0). Carlini's parallel-Claudes C compiler is cited in `PLAN.md` as a case where a large external test suite was the real manager. Orchestra differs in that it has no such oracle by default and must rely on a project `testCommand` plus the judge.

**Compounding learnings.** Every's Compound Engineering writes structured learnings that later planning consults, but `PLAN.md` notes the learning there is human curated and not measured. Orchestra's librarian writes lessons automatically, requires evidence for each, and the evolver may act on them (`src/learnings.ts`, `harness/v1/librarian.md`).

**Self-improving agents.** The Darwin Godel Machine (Zhang et al.) keeps an archive of agent variants, branches from any member, and validates changes empirically. `docs/self-improvement.md` states that Orchestra's archive follows this idea. The DGM paper reports results on SWE-bench in a research setting; `PLAN.md` quotes 20% to 50% and notes reported cases of agents gaming the metric. Orchestra does not reproduce those results and its eval is far smaller (see [section 8](#8-limitations)).

**Harness2 (google-research) (unverified).** The project's issue tracker references a Harness2 project from google-research (we could not see the issue text, so we do not describe its topic). We could not confirm the exact repository path, its method, or any reported figures from inside this repo, which does not mention it in any file. We therefore link only the organization page, [github.com/google-research](https://github.com/google-research), and make no claim about what Harness2 does or how it compares. Readers should locate the repository from the issue that references it. Any similarity to Orchestra's evolver is a hypothesis, not a finding.

**Iterative refinement and learning from feedback.** Reflexion (Shinn et al.) stores verbal feedback from failed attempts to improve later attempts. Self-Refine (Madaan et al.) has a model critique and revise its own output. Orchestra's repair loop is related in shape, since judge issues become repair notes for the next attempt (`src/conductor.ts`), but it differs in using a separate judge with hidden scenarios rather than self-critique. DSPy (Khattab et al.) treats prompts as optimizable program components. Orchestra's evolver also edits prompts, but by LLM proposal and an empirical gate over past tasks, not by a compiler over a metric.

**Evaluation of coding agents.** SWE-bench (Jimenez et al.) evaluates models on real GitHub issues. Orchestra's Factory Eval is not comparable: it replays the user's own past goals in the user's own repo, with the repo's own check command (`docs/self-improvement.md`). It measures regression against the factory's own history, not general ability.

**Multi-agent cost and reliability.** The repo's research notes cite Anthropic's multi-agent research system write-up (agents use several times the tokens of chat) and the MAST study (Cemri et al.), which finds failures cluster in system design, inter-agent misalignment and task verification. Both motivate a verification-centered design and cost tracking (`docs/research/cost-accuracy-speed.md`).

## 3 System design

### 3.1 Roles

Each role is a system prompt in `harness/v1/<role>.md`, with models and limits in `harness/v1/config.json` (`docs/architecture.md`). The shipped defaults are in the table below. Models can also be given as tiers (`strong`, `balanced`, `fast`) that resolve through a capability table in `src/models.ts`.

| Role | Prompt | Default model | Responsibility |
|---|---|---|---|
| Planner | `harness/v1/planner.md` | opus | Reads the goal, tracked files, test command and learnings. Returns a task graph with dependencies and acceptance criteria, hidden scenarios, and a short `domain` slug. Read-only tools. |
| Worker | `harness/v1/worker.md` | sonnet | Implements one task in that task's worktree. Receives the goal, its task, acceptance criteria, other task titles, learnings and any repair notes. |
| Judge | `harness/v1/judge.md` | opus | Scores the diff against acceptance criteria and hidden scenarios. Returns pass, a 0 to 1 score, a summary and issues. Its edits are discarded. |
| Librarian | `harness/v1/librarian.md` | sonnet | After a goal run, distills repairs and failures into lessons. No tools. |
| Evolver | `harness/v1/evolver.md` | opus | Proposes harness variants. May edit the other prompts and config, not its own prompt. |

Three optional small files (`harness/v1/tools.md`, `harness/v1/style.md`, `harness/v1/checklist.md`) hold tool habits, coding conventions and extra review checks. They ship empty and can be tuned by the evolver without rewriting a role prompt (`CHANGELOG.md`, 0.6.0).

The conductor (`src/conductor.ts`) sequences plan, build, verify, merge and learn. Each agent session is a fresh context. Session cost, tokens and cache use are recorded per session in `ledger.jsonl` under `.orchestra` (`src/store.ts`, `CHANGELOG.md` 0.2.0).

### 3.2 Git worktrees and the integration branch

`src/git.ts` leaves the user's checkout untouched. Per run it creates an integration branch `orchestra/<run>/integration` and, per task, a branch `orchestra/<run>/<task>` with its own worktree under `.orchestra/worktrees/<run>/`. Parallel workers cannot collide on files because each has its own working directory. `.orchestra/` is added to `.git/info/exclude` rather than the tracked ignore file. At the end of a run the worktrees are removed, and the integration branch remains for the user to review and merge (`docs/architecture.md`).

### 3.3 Task lifecycle

Task states are `pending`, `running`, `judging`, `repair`, `merging`, `merged`, `failed` and `blocked` (`docs/architecture.md`, `src/types.ts`). Tasks start in dependency order, up to `concurrency` at a time (default 3), until `runBudgetUsd` (default 20) is spent (`docs/configuration.md`). A task passes only if the judge says pass, the score is at least `passThreshold` (default 0.75), and any `testCommand` did not fail. After `maxAttempts` (default 3) a task is `failed`, and its dependents become `blocked`.

### 3.4 Merge queue

Passing tasks enter a queue that merges one at a time onto the integration branch with `--no-ff` (`enqueueMerge` and `mergeOne` in `src/conductor.ts`). A merge conflict aborts the merge and restarts the task on the latest integration tip. A failing `testCommand` after the merge resets the integration branch to its previous head and sends the task to repair. Serializing merges removes a class of race conditions at the cost of throughput (see [section 8](#8-limitations)). Run satisfaction is the mean judge score of merged tasks scaled by the fraction of tasks that merged, and a run is `done` only if every task merged (`docs/architecture.md`).

### 3.5 Event log and state

`src/store.ts` owns the on-disk layout. Writes go to a temporary file and are renamed, so readers can poll while a run writes. Per run, `runs/<run>/run.json` holds the current state and `runs/<run>/events.jsonl` is an append-only event log. Event kinds are `run.start`, `run.end`, `plan`, `task.start`, `task.verdict`, `task.repair`, `task.merged`, `task.failed`, `agent.start`, `agent.action`, `agent.end`, `learn`, `evolve` and `log` (`docs/architecture.md`). Both dashboards and the statusline are views over these files, which is why they agree.

### 3.6 Safety rails

An agent hook in `src/guard.ts` (run as `orchestra guard`) is injected into every agent session. It denies access to the hidden scenarios, writes to the harness, evals and archive, network commands, `git push`, `npm publish` and secret files, and it fails closed on unreadable input (`docs/self-improvement.md`, "Guard rails"). Workers also run with isolated agent settings and per-role and per-run budgets (`CHANGELOG.md` 0.1.0, `harness/v1/config.json`). Workers share one machine and there are no containers yet (`README.md`, Status).

## 4 Verification

### 4.1 Hidden scenarios and holdout

Besides tasks, the planner returns scenarios in given/when/then form. The conductor writes them to a `holdout/<run>.json` file under `.orchestra`, outside every worktree. Workers are never given them. Only the judge prompt includes them, and the judge is told to assess only the parts a given task is responsible for (`docs/architecture.md`, `src/conductor.ts`). The separation is enforced in code: the guard in `src/guard.ts` denies any tool call whose input mentions the holdout directory. The motivation, from `PLAN.md`, is that hidden holdouts reduce reward hacking, since a worker cannot optimize for checks it cannot see.

A small goal can take the planner fast path (`fastPath` in the project config, off by default). In that mode the planner returns one task and is not required to produce hidden scenarios, which weakens this protection for those goals (`docs/configuration.md`).

### 4.2 The judge

The judge (`harness/v1/judge.md`) runs read-only. It scores per acceptance criterion, and the task score is aggregated from the criteria (`CHANGELOG.md` 0.2.0). It retries once on failure and never scores a worker 0.00 for a judge error (`CHANGELOG.md` 0.2.0). Two opt-in cost controls exist. `judgeTiers` runs a cheap judge first and escalates to the strong judge on test failure, borderline scores or open issues. `preJudge` runs a lint command and a check that new exports under `src/` come with a changed test, and failures go straight to repair without a judge call (`docs/configuration.md`).

### 4.3 The repair loop

When a task fails, the judge's issues (and any test output) become repair notes, and the task returns to `repair` for another worker attempt in a fresh context. A progress file records the previous diff summary and issues so the repair prompt can point at it instead of inlining long text (`CHANGELOG.md` 0.2.0). Three events trigger repair: a judge rejection, a merge conflict, and a red test run after merge (`docs/architecture.md`, "The attempt and retry loop"). If the worker changed nothing, the verdict is an automatic fail with a repair note.

### 4.4 Contrastive repair

Without a `testCommand`, the judge scores one attempt with no objective check, so scores are noisy (`docs/configuration.md`, "contrastive"). Contrastive repair, opt-in via the `contrastive` block, addresses this on repair attempts (attempt 2 or later). Two workers try the same task in separate worktrees off the same base. Worker A follows the repair notes. Worker B is told to take a deliberately different approach (`alternateWorkerSection` in `src/contrast.ts`). One comparison judge call (`comparePrompt` in `src/contrast.ts`) sees both diffs, the acceptance criteria and the hidden scenarios, scores each attempt per criterion, and returns a preferred attempt with reasons. The winner continues to the merge queue and the loser's branch and worktree are deleted. The judge's reasons are passed to the librarian as lesson evidence, and the task drawer shows "Picked A over B because ..." (`CHANGELOG.md` 0.6.0, `docs/self-improvement.md`).

Constraints in the design: it is off by default, applies by default only when `testCommand` is `null` (`contrastApplies` in `src/contrast.ts`), is capped by `contrastive.maxPairs` (default 1), costs two worker sessions plus one comparison call, and never lowers `passThreshold`. The preferred attempt must still pass the threshold on its own scores (`docs/configuration.md`). The comparison prompt itself says a preference never lowers the bar (`src/contrast.ts`). Whether contrastive repair improves outcomes has not been measured in the repo.

## 5 Self-improvement

### 5.1 The harness and the archive

The harness is the evolvable part of the factory: role prompts, `config.json` (models, `maxAttempts`, `passThreshold`, per-role `budgetUsd`) and the three small text files. Versions live in `harness/<vN>/` under `.orchestra`, seeded from `harness/v1` on `orchestra init`. `harness/current` names the active one. `archive.json` records every version with parent, rationale, eval score and status (`promoted`, `candidate`, `rejected`, `retired`). Versions are append-only, so any version can be made current again (`docs/self-improvement.md`, `src/harness.ts`).

### 5.2 Ledger and metrics

Every agent session is a row in the ledger. `orchestra stats` reports per harness version: runs, tasks, merged, first-pass yield (tasks merged on attempt 1 divided by all tasks), mean satisfaction and cost per merged task. Eval runs are excluded so evolution does not distort the numbers it is judged on (`metrics()` in `src/evolve.ts`, `docs/self-improvement.md`). `docs/research/cost-accuracy-speed.md` states that a measurement-first approach (record tokens and cache use before optimizing) was a deliberate priority.

### 5.3 Factory Eval

After a goal run ends `done` with satisfaction of at least 0.8 and a recorded base commit, it is harvested into a case with an `id`, the original `goal`, a `base` commit and an optional shell `check` copied from the project `testCommand` (`harvest` in `src/evolve.ts`). To score a harness version, each case is replayed as an eval run. A case passes if the run is `done` and the check passes on the integration branch. The case score is the run satisfaction, or 0 on failure, and the version score is the mean (`docs/self-improvement.md`). `orchestra evals` lists the cases.

### 5.4 The evolve cycle

One cycle (`evolve()` in `src/evolve.ts`):

1. **Study.** The evolver receives the current harness files, metrics per version, recent repair notes and failures, up to five previously rejected variants, and a per-domain learnings summary. It runs without tools.
2. **Propose.** `createVariant` copies the incumbent to the next version, applies changed files and archives it as `candidate`.
3. **Evaluate.** The most recent `evolve.sample` cases are run against the incumbent and the candidate.
4. **Decide.** `promotionDecision()` promotes only when there are at least `evolve.minCases` cases, no case the incumbent passed regresses, and the mean gain exceeds both `evolve.minGain` and the observed spread (standard deviation of per-case deltas).
5. **Promote or record.** With `evolve.autoPromote` true the winner is promoted. Otherwise it is kept as `candidate` or marked `rejected`.

An eval run that dies of infrastructure (usage limit, auth, network) is inconclusive and is not scored as 0 (`isInfraFailure` in `src/evolve.ts`, `CHANGELOG.md` 0.3.0). Automatic evolution fires after `evolve.every` goal runs on the current version (`evolutionDue`), and `--no-evolve` skips it.

Guard rails are in code: the evolver may edit only eight named files (`EVOLVABLE_FILES` in `src/harness.ts`), not `evolver.md`. A variant with a lower `passThreshold` than its parent, a missing model for any role, or a `checklist.md` that drops a line is rejected (`docs/self-improvement.md`).

### 5.5 Multi-candidate evolution

Opt-in via `evolve.candidates` (default 1, behaviour unchanged). With k above 1, one cycle becomes propose k, screen, compose, decide (`CHANGELOG.md` 0.6.0, `docs/self-improvement.md`):

- **Propose.** One evolver call returns k variants, each targeting a different weakness and none repeating a rejected variant.
- **Screen.** Each runs on `min(2, evolve.sample)` cases. A candidate that regresses a case the incumbent passes is dropped and archived as `rejected` with its `screenScore`.
- **Compose.** If two or more survive, a second evolver call (`COMPOSE VARIANTS`) merges them into one variant that keeps only edits backed by score evidence. The archive entry lists `parents`.
- **Decide.** The composed variant gets the full evaluation and the same `promotionDecision()` rules. Screening scores never promote anything.

The documented cost model is: a dud single candidate wastes about `2 x sample` eval runs, while multi-candidate costs about `k x screen + 2 x sample` plus two evolver calls (`docs/self-improvement.md`). That is an estimate from the design, not a measurement.

### 5.6 Promote and rollback

`orchestra promote <vN>` points `harness/current` at a version, marks it `promoted` and marks the previous one `retired`. Rollback is promoting an older version. Nothing is deleted, so it is instant and lossless, and finished runs keep the harness version recorded in their run file (`docs/self-improvement.md`).

### 5.7 Per-domain learnings

After each goal run the librarian distills lessons for the planner, worker and judge (`harness/v1/librarian.md`). The planner tags the run with a domain slug (existing domains plus at most one new per run). Lessons are stored in `learnings/<domain>.json` and `learnings/_global.json` under `.orchestra`, with `learnings.md` as a generated mirror grouped by domain (`src/learnings.ts`).

- **Evidence.** Each lesson carries `evidence` (run and optional task ids) and a `hits` count. Lessons without evidence are dropped.
- **Cap.** At most 25 lessons per domain (`DOMAIN_CAP`). Over the cap, those with the least recent evidence go first.
- **Retrieval budget.** Planner and worker prompts get at most 15 lessons (`RETRIEVAL_BUDGET`), the run's domain first, then global.
- **Evolver view.** The evolver gets a per-domain summary of counts and top lessons, not the full store (`summarizeLearnings`).
- **Migration.** A legacy `learnings.json` becomes `_global.json` on first read.
- **Viewing.** `orchestra learnings [--domain <slug>]`.

The intent is to keep prompts small and relevant as the store grows. Whether retrieved lessons improve outcomes has not been measured.

## 6 Observability

All views read `run.json` and `events.jsonl` (`docs/dashboards.md`). Dashboard data access is shared in `src/dashboard-data.ts`, used by both the web and terminal dashboards (`CHANGELOG.md` 0.4.0).

- **Web dashboard** (`orchestra serve [--port N]`, `orchestra run --serve`). A dependency-free `node:http` server on `127.0.0.1` (`src/web/server.ts`) streams run state over server-sent events to a single page (`src/web/page.ts`). It shows a Trello-style task board with SVG dependency arrows, a Flow view by dependency depth, a progress ring, live agent lanes and a task drawer with per-criterion results, the judge score against the pass line, diff and logs. It is read-only. Default port 4317, trying up to 4326.
- **Terminal dashboard** (`orchestra serve --tui`, alias `orchestra tui`). An interactive full-screen view for places where a browser is not allowed, in `src/tui/app.ts` with a pure state reducer (`src/tui/state.ts`) and pure renderers (`src/tui/screens.ts`). It opens no port, follows the current run, and exits 1 with a hint to use `orchestra status` or `orchestra watch` if stdin or stdout is not a TTY. It restores the terminal on quit, Ctrl-C, SIGTERM and errors.
- **`orchestra watch`** is a non-interactive full-screen live view, and **`orchestra status`** prints the same board once, for scripts and chat (`src/tui/render.ts`).
- **Statusline.** `orchestra statusline` prints at most two lines for Claude Code (`renderStatusLine` in `src/tui/render.ts`).

## 7 Methodology

This section describes how Orchestra is evaluated today, and proposes how it should be evaluated on real runs. **No results are reported, because none exist in the repo.**

### 7.1 What exists now

1. **Simulator runner.** Setting `ORCHESTRA_RUNNER=fake` swaps real Claude sessions for a simulator (`src/fake.ts`, `src/cli.ts`). `orchestra demo` runs the whole pipeline in a temporary repo with `evolve.every` and `evolve.sample` set to 1 (`docs/self-improvement.md`). The simulator checks plumbing (scheduling, merging, events, archive transitions), not the quality of agent work.
2. **Test suite.** `npm test` runs unit and CLI tests under `test/` (for example `test/conductor.test.ts`, `test/evolve.test.ts`, `test/contrast.test.ts`, `test/learnings.test.ts`, `test/tui-state.test.ts`, `test/web.test.ts`) against the simulator. `README.md` says the suite runs against the simulator.
3. **`orchestra stats`.** Per-version first-pass yield, satisfaction and cost per merged task, computed from the user's own runs and ledger (`metrics()` in `src/evolve.ts`).
4. **Factory Eval cases.** Harvested from successful runs and replayed against candidate harnesses. The gate is described in [section 5.4](#54-the-evolve-cycle).
5. **Measured notes.** `docs/research/cost-accuracy-speed.md` contains a small number of figures labelled measured from Orchestra's own ledger and runs, from a single-task run. We do not restate them as general results. It also records a production failure (a judge hitting its budget) that led to the "judge always returns a verdict" change, and notes that with 2 to 3 eval cases a small gain is noise, which motivated `evolve.minCases` and the spread rule.

### 7.2 Proposed evaluation protocol for real runs

We propose, but have not run, the following protocol. Each step uses existing commands.

1. **Fix the task set.** Choose a set of goals of varied size in one or more repos with a `testCommand`, and record the base commit for each. The research notes suggest about 20 eval cases as a starting size (`docs/research/cost-accuracy-speed.md`). That is a suggestion from those notes, not a validated number.
2. **Define arms.** For example harness v1 as shipped, a promoted later version, and ablations: no hidden scenarios, no repair loop, contrastive on or off, learnings on or off. Use identical models and budgets across arms.
3. **Repeat.** Run each goal several times per arm, because agent runs are stochastic. The promotion gate already uses spread across cases, and the same caution applies to any comparison.
4. **Primary outcomes.** Task and run success under an independent check that neither workers nor the judge saw, first-pass yield, run satisfaction, and cost per merged task, all taken from `orchestra stats` and the ledger.
5. **Secondary outcomes.** Number of repair attempts, merge conflicts, wall-clock time, cache hit ratio (`CHANGELOG.md` 0.2.0), and human review effort measured by edits needed before landing the integration branch.
6. **Judge calibration.** Sample merged and failed tasks, have a human grade them, and compare with judge verdicts to estimate agreement and bias. Do this with hidden scenarios on and off.
7. **Evolution study.** Track harness versions over a sequence of runs, and evaluate each promoted version on a held-out set of goals that were never harvested into Factory Eval, to detect overfitting to the eval set.
8. **Report** all runs, including inconclusive ones and rejected variants, with the config and harness versions used. Do not report only promoted variants.

## 8 Limitations

- **No empirical results.** There is no benchmark of Orchestra against a baseline in the repo. Claims here are about design, not performance.
- **Judge is an LLM.** Verdicts can be wrong, and the quality of hidden scenarios depends on the planner. The fast path removes the hidden-scenario requirement for small goals (`docs/configuration.md`).
- **Small eval sets.** The gate refuses to promote below `evolve.minCases` and requires a gain above the observed spread, but the repo's own notes say small sets are noisy (`docs/research/cost-accuracy-speed.md`).
- **Cost.** Evolution reruns past goals and costs roughly `sample x 2` runs plus the evolver call (`README.md`, Status). Multi-candidate adds `k x screen` each cycle. The research notes report that the Opus-tier planner and judge dominated cost in one measured run (`docs/research/cost-accuracy-speed.md`).
- **No containers.** Workers share one machine (`README.md`, Status). The guard hook blocks listed commands and paths, but a hook is a deny list, not isolation.
- **Serialized merges.** The merge queue is one at a time, which bounds throughput.
- **Eval is local.** Factory Eval cases come from the user's own successful goals, so they cover only past work types.
- **Contrastive repair is narrow.** It applies only on repair attempts, by default only without a test command, and one pair per task by default.
- **Platform coupling.** Real runs need Claude Code with headless auth. Model tiers map through a capability table (`src/models.ts`), but the only provider shipped is Anthropic (`DEFAULT_PROVIDER`).
- **Release metadata.** `README.md` Status says "Version 0.1" while `package.json` and `CHANGELOG.md` describe 0.6.0. We follow the latter.

## 9 Threats to validity

**Internal.** (a) The judge and the evolver share a model family by default (opus), so correlated errors are possible. `PLAN.md` suggests a different prompt lineage for the judge, but the shipped harness does not enforce a different model. (b) Eval runs are stochastic, and a single replay per case can mislead. The spread rule reduces but does not remove this. (c) Harvested cases only include successes (`done` and satisfaction at least 0.8), so Factory Eval underrepresents hard goals. (d) The judge sees the worker's diff and a worker summary, which could bias it. The compare prompt labels the worker summary as unverified (`src/contrast.ts`). (e) Agents have been reported to game metrics in the DGM setting (`PLAN.md`). Orchestra's guard blocks edits to evals and the archive, but gaming through legitimate prompt edits is not ruled out.

**External.** (a) Results may not generalize beyond the tasks, languages and repos used. (b) Behaviour depends on model versions and Claude Code behaviour, which change. (c) A repo with no `testCommand` has weaker verification, and the judge alone is the oracle. (d) Outside-system descriptions in section 2 come from secondary notes in `PLAN.md`, and some details are unverified.

**Construct.** (a) Satisfaction is the mean judge score, a proxy for correctness and intent, not a direct measure. (b) First-pass yield rewards getting it right early, which can favour easy decompositions. (c) Cost per merged task depends on how the planner splits goals. (d) A passing hidden scenario shows consistency with the planner's reading of the goal, which may itself differ from the user's intent.

## 10 Future work

Drawn from `README.md`, `CHANGELOG.md`, `PLAN.md` and `docs/research/cost-accuracy-speed.md`:

- **Containers for workers.** Replace shared-machine execution (`README.md`, Status).
- **Cheaper evolution.** Evolution costs about `sample x 2` runs per cycle. Screening in 0.6.0 is a step. Further options are tuning `evolve.sample`, `evolve.every` and `evolve.candidates`, as `README.md` suggests.
- **Run the evaluation protocol** in [section 7.2](#72-proposed-evaluation-protocol-for-real-runs) and publish results, including negative ones.
- **Evolvable surface.** Skills and executable scripts are out of scope today (`docs/self-improvement.md`).
- **Backlog items** in `docs/research/cost-accuracy-speed.md`, such as model-agnostic roles beyond Anthropic.
- **Phases not yet built.** `PLAN.md` describes digital twins, risk tiers with human gates and a scheduled supervisor. We did not verify which of these exist in `src/`, and we treat them as plans.
- **Learnings follow-ups.** Known follow-ups include returning the dropped-lesson count from `writeLearnings` instead of re-reading the file, and testing a planner response that omits `domain` (`src/learnings.ts`). These come from the project's working notes, not from a file in the repo.
- **Terminal dashboard polish.** Clear the screen on resize, improve the empty-store idle state, add missing footer hints, and test `harnessLimits` and the git diff path (`src/tui/`, `src/dashboard-data.ts`). Same source as the previous item.

## 11 References

**Repository files cited**

- `README.md`, `PLAN.md`, `CHANGELOG.md`, `package.json`
- `docs/architecture.md`, `docs/self-improvement.md`, `docs/dashboards.md`, `docs/configuration.md`, `docs/research/cost-accuracy-speed.md`
- `harness/v1/planner.md`, `harness/v1/worker.md`, `harness/v1/judge.md`, `harness/v1/librarian.md`, `harness/v1/evolver.md`, `harness/v1/config.json`
- `src/conductor.ts`, `src/contrast.ts`, `src/evolve.ts`, `src/harness.ts`, `src/learnings.ts`, `src/guard.ts`, `src/models.ts`, `src/git.ts`, `src/store.ts`, `src/fake.ts`, `src/dashboard-data.ts`, `src/tui/`, `src/web/`

**External sources**

1. Zhang et al. *Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents.* [arXiv:2505.22954](https://arxiv.org/abs/2505.22954). Also Sakana AI, [Darwin Godel Machine](https://sakana.ai/dgm/). Linked from `PLAN.md`.
2. google-research, **Harness2** (unverified): [github.com/google-research](https://github.com/google-research). Exact repository path, authorship, method and results unconfirmed.
3. Jimenez et al. *SWE-bench: Can Language Models Resolve Real-World GitHub Issues?* [arXiv:2310.06770](https://arxiv.org/abs/2310.06770).
4. Shinn et al. *Reflexion: Language Agents with Verbal Reinforcement Learning.* [arXiv:2303.11366](https://arxiv.org/abs/2303.11366).
5. Madaan et al. *Self-Refine: Iterative Refinement with Self-Feedback.* [arXiv:2303.17651](https://arxiv.org/abs/2303.17651).
6. Khattab et al. *DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines.* [arXiv:2310.03714](https://arxiv.org/abs/2310.03714).
7. Cemri et al. *Why Do Multi-Agent LLM Systems Fail?* (MAST). [arXiv:2503.13657](https://arxiv.org/abs/2503.13657). Linked from the research notes.
8. Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (URL path as recalled, the repo's research notes truncate it, so unverified). Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents). Anthropic, [Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents). Anthropic, [Building a C compiler with parallel Claudes](https://anthropic.com/engineering/building-c-compiler).
9. StrongDM, [The StrongDM Software Factory](https://www.strongdm.com/blog/the-strongdm-software-factory-building-software-with-ai). Cursor, [Scaling agents](https://cursor.com/blog/scaling-agents). Geoffrey Huntley, [everything is a ralph loop](https://ghuntley.com/loop/). Every, [Compound Engineering](https://every.to/compound-engineering/). All as listed in `PLAN.md`. We did not re-read them, so details are as summarized there (unverified).
10. Claude Code documentation, [glossary](https://code.claude.com/docs/en/glossary) (page linked from `PLAN.md`).
