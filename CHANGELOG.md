# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Lesson hygiene (W3.7): the librarian now returns item edits (add, update, remove by lesson id) applied by `applyLessonEdits`, so no code path replaces a domain's lessons from model output. Lessons carry stable ids and helpful/harmful counters (old files load with zeros). Opt-in `learnings.expiryDays` (default 0 = off) expires stale or harmful lessons. New `orchestra evals ablation` replays the holdout with and without learnings and reports the paired delta and CI.

### Fixed

- Atlas: the atlas schema is now version 2 and persists `skipped` (oversized, binary or unreadable paths). Older caches are ignored and rebuilt, and incremental builds re-extract only changed and genuinely new paths instead of re-reading skipped files every time.
- Atlas TS/JS extractor: class methods are only the lines at the class body's own indent (learned from the first member line, as the Python extractor does), so calls such as `emit({` or `describe('x', function () {` inside a method are no longer recorded as methods.
- Atlas tests edges: the test subject is derived only from real test naming patterns (`.test`/`.spec`, `_test`, `test_` prefix, Java `Test`/`Tests`/`IT` after a lowercase letter or digit), so names like `EDIT.java` are no longer mangled, and a name-based edge is limited to the test's own directory or the subtree above its `tests/` directory instead of any directory in the repo.
- Exploration metrics: planner-declared `footprint.files` no longer replace the title-derived "planned" set in the ledger. Planned keeps its meaning with the atlas on or off; declared files (intersected with tracked files) go in a separate `footprint.declared` field and a second "declared" line in `orchestra stats`.
- Bench: `orchestra bench --reference <arm>` now fails before running when the arm is not among the arms in the run, instead of rendering every row as `(reference)`.
- Atlas Go imports: resolution uses the `go.mod` module path when present (stdlib and external imports get no edge) and otherwise needs at least two trailing path segments, via a precomputed directory-suffix map instead of scanning every directory per import.
- Atlas TS/JS imports: the import/export regex is anchored per statement and cannot span another import or export keyword, so in semicolon-less code an earlier `export ...` no longer swallows the next import.
- Atlas L1 task pack: skeletons come from the base-commit atlas, so a file changed on integration is now annotated "changed since base; symbols and lines as of the base commit" instead of looking current.
- Atlas build: blobs are sized with `git cat-file --batch-check` and only those within 256KB are read, binary extensions are skipped up front, and a failed chunk read degrades to per-blob reads, so large or binary files can no longer overflow the buffer and abort the build.
- Atlas cache: `loadOrBuildAtlas` picks at most 8 candidates cheaply (ancestors from one `git rev-list`, then most recently written caches) before diffing instead of diffing every cached sha, and prunes `.orchestra/atlas` to the 16 most recent files.
- Sandbox: the srt and claude write policy now includes the shared git common dir (hooks and config stay read-only inside it), so a worker's `git commit` in a worktree can write objects, refs and worktree metadata. Matches the docker backend.
- Sandbox: `permissions.deny` rules now use Claude Code's absolute-path form (`Read(//home/u/.ssh)`, not `Read(/home/u/.ssh)`, which means settings-relative) and add a `/**` variant so directories cover their contents. Globs such as `**/.env` are unchanged. Unverified against a live Claude Code, so both the bare and `/**` forms are emitted.
- Sandbox: `srt --settings` now gets a file in srt's own shape (top-level `network.allowedDomains`, `filesystem.allowWrite/denyRead/denyWrite`) instead of the Claude Code shape. The `claude` backend keeps the Claude shape. Key names follow the sandbox-runtime README as recalled and are unverified against an installed srt.
- Sandbox: settings are no longer written to the worker-writable `<worktree>/.claude/settings.local.json` and merged with whatever was there. The `claude` backend passes the sandbox block inline in `--settings`, built fresh from the policy; the `srt` backend gets a fresh file under `.orchestra/sandbox/`, which the worker cannot write. Repo or worker content can no longer persist `excludedCommands`, `allow` rules or hooks into the sandbox settings. Residual: Claude Code still merges the repo's own project settings by design, so a hostile repo `sandbox.excludedCommands` is not stripped under the `claude` backend; prefer `srt` or `docker` for untrusted repos.
- Sandbox: judge sessions (same task worktree as the worker) no longer inherit the worker's sandbox settings, because no `settings.local.json` is left in the worktree any more. The `.git/info/exclude` entry for it is dropped. A test checks that no session cwd contains the file.
- Conductor: the git common dir for the worker sandbox policy is resolved once per run instead of running `git rev-parse` on every agent call.
- Sandbox pre-flight (docker): the read-probe canary used to sit under the temp directory, which docker mounts read-write, so the probe could never pass against a real daemon. It now lives outside every mount (`/var/tmp`, else the home directory); if none is usable the probe is skipped with a warning. `PreflightResult` gains `warnings`, logged by the conductor.
- Sandbox pre-flight: a failed network probe no longer counts as BLOCKED by itself. The same fetch runs unsandboxed first as a positive control; if it also fails the result is reported as inconclusive (no connectivity), the sandboxed network probe is skipped, and a warning is logged that network confinement is not verified. The control is one extra outbound request to the probe host by the orchestrator process. Tests use the injected exec only.
- CLI: `orchestra run` no longer drops goal words that equal the `--sandbox` or `--sandbox-image` value (`orchestra run turn off the cache --sandbox off` kept only `turn the cache`). The flag and its value are removed by position.
- Docker backend: containers now run as the invoking `uid:gid` (`--user`, with `HOME` set to the temp mount) so files in the worktree are not root-owned. New `--sandbox-network <net>` (default `none`, unchanged) lets the user pick a docker network that can reach the model API. With `none` the pre-flight logs a clear warning that a claude worker cannot call the model; on a non-`none` network it skips the network probe and warns that docker does not enforce the host allow-list. The default still cannot run a claude worker without an image-provided route; that is documented, not solved. Behaviour is unchanged when docker is not selected.

### Added

- W9.1 and W9.2 Repo Atlas (opt-in, off by default via `context.atlas`): a deterministic, commit-keyed code graph (`src/atlas.ts`, regex extractors for TS/JS, Python, Go, Java and Rust with a file-level fallback) stored at `.orchestra/atlas/<sha>.json` and rebuilt incrementally from `git diff --name-only`. It never indexes `.orchestra/`, `.env*` or the guard's secret patterns, and is outside `EVOLVABLE_FILES` and the scorer. No new dependencies or network calls.
- W9.1 L0 ranked map: a tree outline ranked by personalised PageRank seeded by goal terms, within `mapTokens` (default 1024). It replaces the planner's first-300-files list and goes in the shared worker prefix, byte-identical across workers.
- W9.2 footprints and L1 task packs: optional `footprint: { files, symbols? }` per task in the plan schema, and a per-task pack (footprint signatures, 1-hop callers and importers, related tests, files changed on integration since run start) in the worker prompt body under `packTokens` (default 1500). The judge does not get the pack.
- W9.1 CLI: `orchestra atlas build` and `orchestra atlas stats`.
- W9 bench ablation: `bench/arms.json` gains `atlas-off`, `atlas-l0` and `atlas-l0-l1` arms that set `context.atlas` per arm (marked `optional`, so a plain `orchestra bench` still runs only `default`). `orchestra bench` gains `--reference <arm>` and prints the paired table for any multi-arm run and for `--report` (reference `full`, else the first arm); `armConfig` now merges nested config objects recursively. docs/bench.md explains how to read tokens per accepted merge (H6) and footprint recall (H7) from the paired report and `orchestra stats`.
- W5.5 boundary model docs: README, docs/architecture.md, docs/configuration.md and the whitepaper limitations now state that OS-level confinement (`srt`, Claude Code sandbox via `bwrap`/`socat` or `sandbox-exec`, optional docker/gVisor) is the isolation boundary and the `src/guard.ts` hook is a deny-list backstop. Covers M5 as a whole: W5.1 OS sandbox per worker, W5.2 pre-flight self-test, W5.3 credential scrubbing, read-only git hooks and config and orchestrator-only commit, push and PR, W5.4 docker backend, W5.5 hook as backstop. Notes `srt` research-preview status, OS variance (Linux unprivileged user namespaces), the `--unattended` refusal and detect-and-degrade. Header comment of `src/guard.ts` updated; no logic change.
- W5.2 sandbox pre-flight (`preflightSandbox` in `src/sandbox.ts`): when `--sandbox` or `--unattended` enables sandboxing, the conductor runs two probes once per run, before the first agent call, inside the same wrapper workers get: a network probe to a host not on the allow-list and a read of a canary file in a deny-read directory. Both must fail. If either succeeds, the wrapper cannot start, or the result is inconclusive, the run aborts with an error naming the probe (recorded in run state and events, exit 1). The network probe is a deliberate outbound attempt expected to be blocked. Skipped entirely when the sandbox is off. Tests use an injected exec.
- W5.4 opt-in docker backend: `orchestra run --sandbox docker [--sandbox-image <image>] [--gvisor]` runs each worker as `docker run --rm --network=none` with the worktree and temp read-write and git `hooks`/`config` read-only (`src/container.ts`, docs/isolation.md). Exits 1 with a hint when docker is missing. `--network=none` also blocks the model API; the docs say how that is left to the user. `ORCHESTRA_SANDBOX_DETECT` accepts `docker`.
- W5.1 and W5.3 wiring: opt-in `orchestra run --sandbox auto|srt|claude|off` (default `off`) and `--unattended`. Workers are spawned through `srt`, or get fail-closed `sandbox` settings merged into the worktree's `.claude/settings.local.json` (existing keys kept, file excluded from commits). `sandbox.allowedHosts` in `.orchestra/config.json` extends the network allow-list. Agent env has git-hosting, registry and cloud credentials stripped whenever either flag is on. `--unattended` exits 1 before any agent call when no backend (`srt`, `bwrap` + `socat`, `sandbox-exec`) is found. `ORCHESTRA_SANDBOX_DETECT=none|srt|claude` overrides detection for tests and CI. With no flags, spawning is unchanged.
- W2.3 and W2.4 ablations and baseline: `runGoal` takes an opt-in `ablate` (`scenarios`, `repair`, `learnings`, `contrastive`) that turns one component off; unset behaviour is unchanged. `orchestra bench --ablations` runs the built-in arms `full`, `-scenarios`, `-repair`, `-learnings`, `-contrastive`, `-evolver` (pinned to harness v1 against the evolved incumbent) plus a `single-session` baseline: one worker call with the whole goal, no planner or judge, budget set to the mean cost per goal of `full`, scored by the same hidden check. `orchestra bench --report` prints the ablation table (check pass rate, paired gain versus `full` with 95% CI clustered by goal, pass@1, pass^3, mean cost). docs/bench.md documents the external anchor protocol (SWE-rebench or SWE-bench-Live, Terminal-Bench 2.0), run manually by a human.
- W2.5 judge calibration (`src/calibration.ts`): agreement and Cohen's kappa between the judge verdict and the bench hidden check per harness version, shown in `orchestra bench --report` and `orchestra stats`. `orchestra bench calibrate --sample N` writes a seeded, stratified sample (near-threshold scores and split votes oversampled) to `.orchestra/bench/calibration/sample.jsonl`; `--import <file>` reads human grades and reports human-judge kappa. Opt-in `evolve.minJudgeAgreement` (default `null`) makes `evolve` refuse to run when the incumbent's agreement is below the floor. Bench rows gain an optional `split` flag.
- W2.1 `orchestra bench` (`src/bench.ts`, `bench/`, docs/bench.md): a fixed in-repo suite (see docs/bench.md for the shipped goals) with fixture repos, hidden check scripts and oracle solutions that never enter worker or judge worktrees. Runs arms x goals x repeats as `kind: 'eval'` runs in throwaway repos, writes `results.jsonl` and `summary.json` (pass@1, pass^3, mean cost and wall clock per arm) under `.orchestra/bench/<id>/`. `--verify-oracles` checks every oracle against its own check. Opt-in; nothing else changes.
- W2.1 bench suite content: 32 goals over four dependency-free fixtures (`calc`, `text`, `args`, `records`) covering bugfix, feature, test, docs and refactor tasks from 5 to 60 human minutes. Test goals are scored by mutants, docs goals by README content. A test proves every check fails on the untouched base and passes with its oracle. docs/bench.md documents the schema and how to add a goal.
- W9.0 exploration and footprint metrics (`src/exploration.ts`): tool_use counts by tool name are recorded passively on agent results and as optional `toolCounts` on ledger rows, and merged-task ledger rows carry the planned versus changed files. `orchestra stats` gains a section per harness version and role (turns, input and cache tokens, cost, Read/Grep/Glob calls) plus footprint precision and recall. No prompt or agent behaviour change; legacy rows show n/a.
- W2.2 paired statistics (`src/stats.ts`): cluster-robust paired gain and 95% CI, pass@1, pass^k and Cohen's kappa. Opt-in `evolve.promotionRule: "paired"` (with `evolve.niMargin`) promotes only when the CI lower bound is above zero with no task type regressing; the default `gain` rule is unchanged. Promotion reasons now include the CI, pass@1 and pass^3.
- W2.6 outcome metrics beyond satisfaction (`src/outcomes.ts`): merge acceptance, edits before landing, revert rate and breakage proxy, cost and wall-clock per accepted merge, and success versus task length. Shown in `orchestra stats` and added to `/api/info` as `outcomes` (existing fields unchanged); see docs/dashboards.md.
- M1 Integrity (W0.1, W1.1 to W1.5), which closes the self-graded eval gap:
  - W0.1: the README Status section matches `package.json`, with a guard test.
  - W1.1: a frozen promotion scorer in the top-level `scorer/` directory (pinned `config.json`, `judge.md`, `checklist.md`), outside the evolvable harness. Eval replays are scored by it plus the case `check`, not by the candidate's own judge. The guard blocks writes to the installed `scorer/`, and the evolver never sees it.
  - W1.2 and W1.4: a pure integrity monitor (`src/integrity.ts`) flags edits to tests, scenarios, CI config and the scorer, weakened tests (removed assertions, skip/only/todo) and reward-hack patterns (early success exit, monkey-patching, special-casing inputs). When a task edits a grading file that existed at the base, grading re-runs the `testCommand` with the originals restored and the task goes to repair with an automatic note. Flags are stored on `task.integrityFlags`.
  - Promotion is blocked when the candidate's monitor fire rate (flags per replayed run) exceeds the incumbent's by more than one flag. Monitor text is kept out of every evolver prompt.
  - W1.3: the `flag_for_human` worker outcome (below).
  - W1.5: clean-room, interleaved eval trials (fresh worktree per replay, no learnings, candidate and incumbent alternating) and a reported `infraFailureRate` per side.
- `flag_for_human` worker outcome: a worker that finds the spec and tests contradict each other ends with `FLAG_FOR_HUMAN: <reason>`. The task stops with status `needs_human` (reason recorded, `task.needs_human` event), gets no repair retries, and is reported separately from failed tasks in the run summary, TUI and web dashboard.
- Research paper `docs/research/closing-the-gaps.md`: a review of about 90 academic, industry and practitioner sources on evaluating, verifying, isolating and self-improving agentic software factories, and an ordered plan (8 workstreams, 6 milestones, stated hypotheses) to address the whitepaper's limitations. It also documents a gap: a candidate harness's own evolvable judge scores its Factory Eval runs.
- Research note on repo context for agents (`docs/research/repo-context-atlas.md`): reviews code knowledge graphs, agentic RAG and existing tools, and proposes the opt-in Repo Atlas workstream W9 (#56).

## [0.6.1] - 2026-10-22

### Added

- Whitepaper (`docs/whitepaper-orchestra.md`) and Substack-style blog post (`docs/blog/orchestra-substack-post.md`), linked from the README and the architecture doc.

## [0.6.0] - 2026-10-22

### Added

- Wider evolvable harness surface (#9). Three small optional files, `tools.md` (worker and judge), `style.md` (worker) and `checklist.md` (judge), can now be tuned by the evolver without rewriting a role prompt. Missing files are treated as empty, and a variant may not remove lines from `checklist.md`. Skills and executable scripts remain out of scope.
- Multi-candidate evolution (#8). The opt-in `evolve.candidates` setting (default `1`, behaviour unchanged) makes the evolver propose k variants per cycle, screen each on `min(2, sample)` eval cases and drop any that regress a case the incumbent passes, compose the survivors into one variant, and decide with the usual `promotionDecision` rules. Archive entries gain optional `parents` and `screenScore`, and screened-out candidates appear under PREVIOUSLY REJECTED VARIANTS.
- The seed evolver prompt documents the `{ variants: [...] }` output, the different-weaknesses rule and `COMPOSE VARIANTS`.
- Contrastive repair (#11), opt-in via the `contrastive` block in `.orchestra/config.json`. On a repair attempt in a repo without a `testCommand`, two workers try the task in separate worktrees (one follows the repair notes, one takes a different approach) and one comparison judge call picks a winner. The winner's branch continues, the loser is deleted, and the judge's reasons feed the librarian as lesson evidence. The task drawer shows "Picked A over B because ...". Disabled by default; `passThreshold` is never lowered.

## [0.5.0] - 2026-10-22

### Added

- Per-domain learning libraries (#10). The planner tags each run with a short `domain` slug (existing domains plus at most one new one per run), stored on the run. Lessons live in `learnings/<domain>.json` plus `learnings/_global.json`, and the `learnings.md` mirror is grouped by domain.
- Every lesson carries `evidence` (the run or task that supports it) and a `hits` count. The librarian must cite evidence, and lessons without it are dropped.
- `orchestra learnings --domain <slug>` filters the list to one domain.

### Changed

- Prompts receive the run's domain lessons then global ones under a token budget, instead of the whole store.
- The 25-lesson cap applies per domain, and the least recently evidenced lessons are dropped first.
- `orchestra evolve` receives a per-domain summary (counts and top lessons) instead of the full store.
- An existing `learnings.json` is migrated to `_global.json` on first read.

## [0.4.0] - 2026-10-22

### Added

- `orchestra serve --tui` (alias `orchestra tui`): an interactive full-screen terminal dashboard for environments where a browser is not allowed. It needs no HTTP server or port. It shows the run board, tasks, agents and events live, follows new runs (`f` re-follows), and opens a drawer with per-task diff and logs. Keyboard driven, restores the terminal on exit and signals, and exits 1 with a hint to use `orchestra status` or `orchestra watch` when not attached to a TTY.

### Changed

- Dashboard data access moved from the web server into a shared `src/dashboard-data.ts`, used by both the web dashboard and the TUI.

## [0.3.0] - 2026-10-22

### Added

- `orchestra --version` (and `-v`) prints the installed version.
- Web dashboard redesign: a Trello-style task board with SVG dependency arrows (coloured by whether the dependency is merged, in progress, waiting or failed), a Flow view that groups tasks by dependency depth, a run progress ring, pipeline stepper and status mix bar, per-card stage tracks, live agent lanes, and a slide-in task drawer with per-criterion results, the judge score against the pass line, diff and logs. Still a single dependency-free page.
- `/api/info` also returns the current harness `maxAttempts` and `passThreshold`.

### Fixed

- `orchestra evolve` no longer scores an eval run that died of infrastructure (usage limit, auth, network) as 0 and rejects the candidate; the result is inconclusive and the candidate stays available.
- `evolve` raises `evolve.sample` to `evolve.minCases`, and exits before running any eval when there are too few cases, instead of spending runs and then refusing to promote.

## [0.2.0] - 2026-10-22

### Added

- Community and project health files: contributing guide, code of conduct, security policy, issue and pull request templates.
- GitHub Actions CI (`npm test` on Node 24) and a branching section in the contributing guide (one `iter/<topic>` branch per iteration, changes land by pull request).
- Token and cache usage per agent session in the ledger, and cache hit ratio in `orchestra stats`.
- Tiered judging (`judgeTiers` in `.orchestra/config.json`): a cheap judge model first, escalating to the strong judge on test failure, borderline scores or open issues. Off by default.
- Research notes and a ranked improvement backlog in `docs/research/cost-accuracy-speed.md`.
- Per-criterion judging: verdicts may carry an optional `criteria` list (pass, score and note per acceptance criterion), the score is aggregated from it, and repair notes list the failing criteria.
- Planner fast path (`fastPath` in `.orchestra/config.json`): a small single-concern goal gets exactly one task and no hidden-scenario requirement. Off by default.
- Model tiers (`strong`, `balanced`, `fast`) in harness `models`, resolved through the capability table in `src/models.ts` using the optional `provider` key. Literal model names are still accepted unchanged.
- Progress file for repair attempts at `.orchestra/runs/<run>/progress/<task>.json`, holding the previous diff summary and judge issues. The repair prompt points at it instead of inlining long text.
- Deterministic pre-judge checks (`preJudge` in `.orchestra/config.json`): an optional lint command and a check that new exports under `src/` come with a changed test file. Failures go straight to repair without a judge call. Off by default.

### Changed

- The judge now retries once on failure and never scores a worker 0.00 for a judge error.
- Role prompts are ordered from stable to volatile content so their prefix can be shared and cached.
- Harness promotion requires a minimum number of eval cases (`evolve.minCases`, default 5) and a gain above the observed spread. `evolve.sample` defaults to 5.

## [0.1.0]

First release.

### Added

- **Software factory**: a zero-dependency TypeScript CLI (Node 23.6+, native type stripping) and Claude Code plugin. The conductor runs planner, then parallel workers in isolated git worktrees, then tests and a judge against hidden holdout scenarios, a repair loop, a serialized merge queue with post-merge tests, and a librarian that records learnings.
- **Self-improvement**: versioned harness (`harness/v1`), an evolver that proposes variants, Factory Eval harvested from successful runs that scores a candidate against the incumbent, promotion only on measured gain with no regressions, and a full archive with rollback.
- **Terminal visuals**: live dashboard (`orchestra watch`, and `orchestra run` on a TTY), one-shot status, stats with trends, and a Claude Code statusline.
- **Safety**: isolated agent settings, a `PreToolUse` guard (holdout, network, secrets, harness edits), read-only judges, and per-role and per-run budgets.
- **Claude Code plugin**: `/orchestra:run`, `status`, `stats`, `evolve`, `setup`, and a local marketplace.
- **Simulated runner** for tests and `orchestra demo`.
- **Read-only web dashboard**: `orchestra serve` and `orchestra run --serve`. A dependency-free `node:http` server on `127.0.0.1` streams `run.json` and `events.jsonl` over SSE to a single-file HTML page, with task detail (verdict, diff, agent log tails) and an `/orchestra:serve` skill.

[Unreleased]: https://github.com/deepskpathak/orchestra/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/deepskpathak/orchestra/releases/tag/v0.3.0
[0.2.0]: https://github.com/deepskpathak/orchestra/releases/tag/v0.2.0
