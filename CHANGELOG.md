# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Community and project health files: contributing guide, code of conduct, security policy, issue and pull request templates.
- GitHub Actions CI (`npm test` on Node 24) and a branching section in the contributing guide (one `iter/<topic>` branch per iteration, changes land by pull request).
- Token and cache usage per agent session in the ledger, and cache hit ratio in `orchestra stats`.
- Tiered judging (`judgeTiers` in `.orchestra/config.json`): a cheap judge model first, escalating to the strong judge on test failure, borderline scores or open issues. Off by default.
- Research notes and a ranked improvement backlog in `docs/research/cost-accuracy-speed.md`.

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

[Unreleased]: https://github.com/OWNER/orchestra/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/orchestra/releases/tag/v0.1.0
