# Foundry: A Self-Improving Multi-Agent Software Factory on Claude

Status: draft plan, 2026-10-17. Owner: Deepak.

---

## 1. What a software factory is

A **software factory** is a system that turns intent (a spec) into verified, shippable software through a repeatable, instrumented pipeline, where most of the labor is done by machines and humans own the inputs, the quality bar, and the exceptions.

The idea is old. Hitachi, Toshiba, NEC and Fujitsu ran "software factories" in the 1970s and 80s (Cusumano's research), standardizing process and reuse. Microsoft's 2004 "Software Factories" (Greenfield and Short) meant model-driven code generation for product lines. Both stalled on the same problem: generators were rigid and humans still did the creative work.

The 2025 to 2026 version is different in kind. LLM agents do the creative work (design, code, tests, fixes), so the factory's job shifts from *generating code* to **orchestrating, verifying, and improving agents**. Three properties define a modern one:

1. **Spec in, software out.** Humans write intent and acceptance criteria, not code.
2. **Validation replaces review.** Correctness is established by independent, often hidden, scenario checks run by other agents, not by humans reading diffs.
3. **The factory improves itself.** Every run produces learnings that change the prompts, skills, and process used by the next run.

Dan Shapiro's five levels (Jan 2026) give the maturity scale, from "spicy autocomplete" up to Level 5, the **dark factory**, where no human writes or reviews code. Most professional teams sit at Level 2 to 3 today. The level boundaries differ by source, so treat them as directional.

---

## 2. Landscape: the best factories and what each got right

| Factory | Who | Core idea worth stealing | Weakness |
|---|---|---|---|
| **StrongDM Software Factory** | StrongDM AI team (Feb 2026) | Scenarios as **holdout sets** stored outside the repo. **Digital Twin Universe**: agent-built behavioral clones of Okta, Slack, Jira, Google APIs for safe, cheap, high-volume testing. **Satisfaction metric** (fraction of trajectories that satisfy the user) instead of pass/fail. Specs as the artifact (Attractor is three markdown files). | Claims are self-reported. Twins cost effort and can drift from the real service. |
| **Gas Town** | Steve Yegge (Jan 2026) | Explicit **roles**: Mayor (dispatcher), Polecats (ephemeral workers), Witness (supervisor), Refinery (**merge queue**). **Beads**: git-backed work tracker that survives agent crashes and is both data and control plane. | Alpha, expensive (multiple Max plans), high cognitive load. |
| **Anthropic long-running harness** | Anthropic Engineering | **Initializer agent** writes `init.sh`, `feature_list.json` (JSON, since models rewrite markdown), progress log, first commit. **Coding agent** each session: read progress plus git log, smoke test, do **one** failing feature, verify end to end in a browser, commit. Targets four failure modes: premature victory, messy state, untested "done", not knowing how to run the app. | Single agent, serial. |
| **Agent teams C compiler** | Nicholas Carlini, Anthropic (Feb 2026) | 16 parallel Claudes, ~2,000 sessions, 100k-line Rust compiler that builds Linux. **Dumb harness**: bash loop, one container per agent, lockfiles to claim work, git to sync, **no orchestrator agent**. The test suite is the real manager. | ~$20K. Output quality below expert. Worked because a huge external test oracle existed. |
| **Cursor scaling agents** | Cursor (Jan 2026) | **Planners never code, workers never plan**, recursive sub-planners, **judge** decides done each cycle. Role split solves context, not intelligence. **Optimistic concurrency** beats file locks (20 agents with locks ran like 2 to 3). Cheaper models can execute when frontier models plan. Periodic **fresh starts** fight drift. | Self-described "nowhere near optimal". |
| **Ralph loop / Loom** | Geoffrey Huntley | Run the same prompt in a loop with **fresh context** each time. State lives in files and git, not in the conversation. Simplicity scales. | No quality gate by itself. Needs good specs and back-pressure (tests, lints). |
| **Compound Engineering** | Every (Kieran Klaassen) | Loop is brainstorm, plan, work, simplify, review, **compound**. The compound step writes structured learnings (`docs/solutions/`) that future plan steps consult. 80% of effort in plan and review. | Learning is human-curated, not measured. |
| **Darwin Gödel Machine** | Sakana AI and UBC (ICLR 2026) | Agent rewrites **its own harness**, each variant scored on a benchmark, kept in an **archive** (not just the best one) with a novelty bonus. SWE-bench 20% to 50%. Sandboxed, human oversight. | Research setting. Reported cases of agents gaming the metric. |
| **Spec-driven tools** (Spec Kit, Kiro, BMAD, Superpowers, gstack) | GitHub, AWS, community | Constitution plus spec plus plan plus tasks as versioned files. Role personas. Skills as reusable process. | Mostly single-session discipline, not a factory. |

### The synthesis: seven things the best factories agree on

1. **State lives in files and git, never in the context window.** (Anthropic, Ralph, Beads, Carlini.)
2. **Fresh context per unit of work.** One task per session, then exit. (Anthropic, Ralph, Cursor.)
3. **Separate the roles that would otherwise mark their own homework.** Planner does not code, coder does not judge. (Cursor, Gas Town, StrongDM.)
4. **The oracle is the boss.** Tests, scenarios, and twins steer more than any orchestrator. Hidden holdouts stop reward hacking. (StrongDM, Carlini, DGM.)
5. **Integration is its own job.** A merge queue (Refinery) with optimistic concurrency, not locks. (Gas Town, Cursor.)
6. **Learning must be written down and consulted.** (Compound Engineering.)
7. **Self-improvement must be measured against a fixed benchmark with an archive and a human gate.** (DGM.)

---

## 3. Target architecture: Foundry

```
                ┌──────────────────────────────────────────────────────────┐
  Human ──────▶ │ 1. INTAKE   spec.md + constitution + risk tier            │
  (intent,      │             scenarios/ (HOLDOUT, outside worker's view)   │
   approvals)   └───────────────┬──────────────────────────────────────────┘
                                ▼
                ┌──────────────────────────────────────────────────────────┐
                │ 2. PLANNER  (Opus, never writes code)                     │
                │    spec ─▶ task graph in .foundry/tasks/*.json (beads)    │
                │    recursive sub-planners per area                        │
                └───────────────┬──────────────────────────────────────────┘
                                ▼
       ┌────────────┬───────────┴───────────┬────────────┐
       ▼            ▼                       ▼            ▼
  ┌─────────┐  ┌─────────┐             ┌─────────┐  ┌─────────┐
  │ WORKER  │  │ WORKER  │   ...       │ WORKER  │  │ WORKER  │  3. one task,
  │ worktree│  │ worktree│             │ worktree│  │ worktree│     fresh ctx,
  │ Ralph   │  │ Ralph   │             │ Ralph   │  │ Ralph   │     TDD, commit
  └────┬────┘  └────┬────┘             └────┬────┘  └────┬────┘
       └────────────┴──────────┬────────────┴────────────┘
                               ▼
                ┌──────────────────────────────────────────────────────────┐
                │ 4. VERIFY   reviewers (correctness, security, simplicity) │
                │             JUDGE runs holdout scenarios vs digital twins │
                │             ─▶ satisfaction score, pass/repair/escalate   │
                └───────────────┬──────────────────────────────────────────┘
                                ▼
                ┌──────────────────────────────────────────────────────────┐
                │ 5. REFINERY merge queue: rebase, full suite, merge         │
                │             human gate by risk tier                        │
                └───────────────┬──────────────────────────────────────────┘
                                ▼
                ┌──────────────────────────────────────────────────────────┐
                │ 6. COMPOUND retro per task ─▶ docs/solutions, skill diffs │
                │ 7. EVOLVE   propose harness variants ─▶ Factory Eval      │
                │             ─▶ archive ─▶ human-approved promotion        │
                └──────────────────────────────────────────────────────────┘
       Cross-cutting: LEDGER (runs.jsonl: cost, tokens, score, interventions)
                      GUARDRAILS (hooks: secrets, network, protected paths)
```

### Roles (each is a `.claude/agents/*.md` definition)

| Role | Model (default) | Sees | Writes | Stolen from |
|---|---|---|---|---|
| **Intake** | Opus | User conversation | `spec.md`, `scenarios/` draft | Spec Kit, StrongDM |
| **Planner** | Opus | Spec, codebase, `docs/solutions` | Task graph JSON | Cursor, Anthropic initializer |
| **Dispatcher** (Mayor) | Script, not LLM | Task graph, ledger | Task claims, worktrees | Gas Town, Carlini (dumb harness) |
| **Worker** (Polecat) | Sonnet, Opus for hard tasks | One task, repo, relevant learnings | Code, tests, commit, progress note | Anthropic coding agent, Ralph |
| **Reviewers** | Sonnet, parallel lenses | Diff and task | Findings | Compound review, gstack /review |
| **Judge** | Opus, different prompt lineage | Diff, **holdout scenarios**, twins | Satisfaction score, verdict | StrongDM, Cursor judge |
| **Refinery** | Script plus Sonnet for conflicts | Merge queue | Merged main | Gas Town |
| **Librarian** (Compound) | Sonnet | Run transcript, ledger, verdicts | `docs/solutions/*.md`, proposed skill diffs | Every |
| **Evolver** | Opus | Ledger, Factory Eval results, archive | Harness variant branches | DGM |
| **Witness** | Haiku on a schedule | Ledger, stuck tasks | Restarts, escalations | Gas Town |

Rule: **the Worker never sees `scenarios/`.** It sees the spec and its own tests. Only the Judge sees holdouts. That separation is what makes a satisfaction score trustworthy.

### State model (all in git, all machine-readable)

```
.foundry/
  constitution.md        # non-negotiables: stack, security, style (from your AGENTS.md)
  specs/<id>/spec.md     # intent, non-goals, acceptance criteria
  tasks/<id>.json        # {id, spec, deps, status, owner, attempts, files, verdict}
  progress/<task>.md     # per-task handoff note for the next fresh session
  ledger/runs.jsonl      # one row per session: task, model, tokens, cost, duration, outcome
  harness/VERSION        # current promoted harness version
holdout/                 # separate repo or dir excluded from worker sandbox
  scenarios/<spec>/*.yaml
twins/                   # digital twins of external deps (mock servers)
docs/solutions/          # compound learnings, indexed by tag
.claude/
  agents/  skills/  hooks/  settings.json   # the harness itself, versioned
```

JSON for tasks (models rewrite markdown, they respect JSON schemas). Markdown for human-facing specs and learnings.

---

## 4. Mapping to Claude primitives

| Need | Claude primitive | Notes |
|---|---|---|
| Standing rules | `CLAUDE.md` + `.foundry/constitution.md` | Keep short. Link, do not inline. |
| Roles | Subagents in `.claude/agents/` | Tool allowlists per role (Judge cannot edit code). |
| Reusable process | Skills (`SKILL.md`) | spec, plan, tdd-task, review-lens, retro, evolve. |
| Hard guarantees | Hooks in `settings.json` | PreToolUse blocks writes to `holdout/`, secrets, network; Stop hook forces progress note and ledger row. |
| Parallel workers | `claude -p` headless in git worktrees, or Agent Teams | Start with a bash or Python dispatcher (Carlini). Agent Teams when you want peer messaging. |
| Orchestrator | Claude Agent SDK (Python or TS) | From Phase 2, replaces the bash loop for retries, budgets, ledger. |
| External systems | MCP servers, digital twins behind the same interface | Twins first, real services only in staging. |
| Schedules | Routines or cron | Nightly Witness, Librarian, Evolver runs. |
| Packaging | Plugin | Ship the whole harness as one installable plugin per repo. |

Verify before relying on: exact headless flags, Agent Teams availability on your plan, and hook event names. These move fast, check `code.claude.com/docs` at each phase start.

---

## 5. The self-improvement engine

Three loops, at three speeds. The fast ones are safe and automatic; the slow one changes the factory itself and is gated.

### Loop A: per task (minutes). Repair.
Judge verdict below threshold ─▶ structured failure note ─▶ new Worker session with note ─▶ max N attempts ─▶ escalate to human. Back-pressure, not hope.

### Loop B: per day (hours). Compound.
Librarian reads the day's ledger and transcripts and writes:
- `docs/solutions/<tag>.md` entries (problem, root cause, fix, how to detect early).
- **Proposed** diffs to skills, `CLAUDE.md`, or agent prompts, opened as a PR, never auto-merged in early phases.
- Planner consults `docs/solutions` by tag at plan time, which closes the loop.

### Loop C: per week (days). Evolve the harness (DGM-style).
1. **Factory Eval**: a frozen benchmark of 20 to 50 past tasks from your own repos, each with holdout scenarios and known-good outcomes. Grows by harvesting real tasks that passed.
2. Evolver reads the ledger, picks the worst failure class, and proposes **K harness variants** (prompt, skill, role split, model routing) on branches.
3. Each variant runs the Factory Eval in sandboxes. Score = satisfaction × (1 − intervention rate) ÷ cost, plus a regression check per task.
4. All variants go to the **archive** with scores (keep losers, they seed future variation).
5. Human approves promotion. `harness/VERSION` bumps. Rollback is a git revert.

**Anti-gaming rules**: the eval set and holdouts are read-only to every agent (hook-enforced). The Evolver cannot edit the Judge or the eval. Rotate a fresh slice of held-out tasks each month so variants cannot overfit.

### Metrics on the dashboard
- **Satisfaction score** per spec (Judge, holdouts).
- **Intervention rate**: human touches per merged task. The single best measure of factory level.
- **First-pass yield**: tasks merged without repair loop.
- **Cost per merged task** and tokens per task, by role and model.
- **Escaped defects**: bugs found after merge, traced to a task. This keeps the Judge honest.
- **Lead time**: spec approved to merged.

---

## 6. Build options and recommendation

| Option | Cost | Upside | Downside |
|---|---|---|---|
| **A. Adopt Gas Town as-is** | Low setup, high run cost | Fastest to "many agents" | Alpha, someone else's opinions, weak verification, hard to evolve in a measured way |
| **B. Claude Code native, grow into Agent SDK** (recommended) | Medium | Uses primitives you already run (skills, hooks, subagents, gstack, superpowers). Each phase ships value. Harness is plain files, so the Evolver can edit it. | You own the dispatcher code |
| **C. Custom platform on Agent SDK from day one** | High | Full control, best observability | Months before first value, premature for an unproven process |

**Recommend B.** Start as files plus a bash dispatcher (Carlini proved a dumb harness works when the oracle is strong). Move the dispatcher to the Agent SDK in Phase 2 when you need budgets, retries, and the ledger.

---

## 7. Roadmap

Each phase has an exit gate. Do not start the next phase until the gate passes on a real repo.

### Phase 0. Foundation (week 1)
- Pick one **pilot repo** that is personal, non-sensitive, and has decent tests. A TypeScript or Kotlin side project is ideal.
- Write `constitution.md` from your AGENTS.md.
- Implement the Anthropic pattern: initializer skill, `feature_list.json`, `progress/`, `init.sh`, single coding agent loop.
- Hooks: block secrets, block network except allowlist, Stop hook appends a ledger row.
- **Gate**: 10 features delivered by the single-agent loop, each with a ledger row, zero manual code edits.

### Phase 1. Roles and verification (weeks 2 to 4)
- Split Planner, Worker, Reviewer, Judge as subagents with tool allowlists.
- Create `holdout/scenarios` and the Judge skill. Hook blocks Worker access to `holdout/`.
- Build the **first digital twin** for the pilot's main external dependency (agent-built from its API docs, StrongDM style).
- Satisfaction score replaces "tests green" as the done signal.
- **Gate**: Judge catches at least one bug that tests missed. First-pass yield measured.

### Phase 2. Parallelism and integration (weeks 5 to 8)
- Dispatcher on the Claude Agent SDK: claims tasks from `tasks/*.json`, one git worktree per worker, 3 to 5 workers, budgets per task.
- Refinery merge queue with optimistic concurrency (rebase, rerun suite, retry), not file locks.
- Witness on a schedule: detects stuck or looping workers, restarts with fresh context.
- Model routing: Opus plans and judges, Sonnet works, Haiku watches.
- **Gate**: 5 workers in parallel with throughput at least 3x single agent, merge conflict rate under 10%.

### Phase 3. Compound learning (weeks 9 to 12)
- Librarian nightly: `docs/solutions` entries plus skill and prompt PRs.
- Planner retrieves learnings by tag. Track whether repeated failure classes decline.
- Start harvesting merged tasks into the **Factory Eval** set.
- **Gate**: a named failure class drops measurably over 4 weeks. Factory Eval has 20+ tasks.

### Phase 4. Self-evolving harness (months 4 to 6)
- Evolver plus archive plus weekly eval runs, human-approved promotion.
- Package the harness as a **plugin** so a second repo can adopt it in under an hour.
- **Gate**: two promoted harness versions, each beating the prior on Factory Eval with no per-task regressions.

### Phase 5. Graduated autonomy (month 6 onward)
- Risk tiers decide human gates:
  - **Tier 0** (docs, tests, internal tooling): dark factory, merge on Judge pass.
  - **Tier 1** (product features): human approves spec and samples merged PRs.
  - **Tier 2** (security, data, money, prod infra): human reviews every merge.
- Expand twins. Add a second and third repo. Revisit Agent Teams for peer messaging between workers.

---

## 8. Risks and guardrails

- **Regulated environment.** Build this on personal or open-source repos first. Do not point it at firm code, data, or infrastructure without your firm's approval of the tooling, the model endpoint, and data handling. The plan assumes no firm data leaves approved boundaries.
- **Reward hacking.** Agents will game visible tests. Mitigation: holdouts, separate Judge lineage, escaped-defect tracking, read-only eval.
- **Twin drift.** Twins diverge from the real service. Mitigation: periodic contract tests of twin vs real service in staging.
- **Cost blowup.** Parallel agents burn tokens fast (Carlini's run was ~$20K). Mitigation: per-task budgets in the dispatcher, ledger alerts, cheaper models for execution.
- **Spec quality becomes the bottleneck.** Garbage in, confidently wrong software out. Mitigation: Intake agent interrogates specs (use `/spec` or `grill-me` style), scenarios written before code.
- **Unreviewed code you do not understand.** Mitigation: Librarian publishes a weekly architecture digest; you read that instead of diffs.
- **Uncertain claims.** Several results above (StrongDM level 5, Cursor's browser, throughput numbers) are self-reported. The plan does not depend on any of them being true; each phase gate measures your own numbers.

---

## 9. Next actions

1. **Pick the pilot repo.** Personal, tested, with one external dependency worth twinning.
2. **Approve option B** (Claude Code native, grow into Agent SDK).
3. **Kick off Phase 0**: constitution, initializer skill, `feature_list.json`, hooks, ledger. About one week of evenings.

---

## Sources

- StrongDM, [The StrongDM Software Factory](https://www.strongdm.com/blog/the-strongdm-software-factory-building-software-with-ai); Simon Willison, [How StrongDM's AI team build serious software](https://simonw.substack.com/p/how-strongdms-ai-team-build-serious)
- Simon Willison on Dan Shapiro, [The Five Levels](https://simonwillison.net/2026/Jan/28/the-five-levels/)
- Steve Yegge's Gas Town: [heise](https://heise.de/-11178824), [Cloud Native Now](https://cloudnativenow.com/features/gas-town-what-kubernetes-for-ai-coding-agents-actually-looks-like/)
- Anthropic, [Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic, [Building a C compiler with parallel Claudes](https://anthropic.com/engineering/building-c-compiler); [InfoQ](https://www.infoq.com/news/2026/02/claude-built-c-compiler)
- Cursor, [Scaling agents](https://cursor.com/blog/scaling-agents)
- Geoffrey Huntley, [everything is a ralph loop](https://ghuntley.com/loop/)
- Every, [Compound Engineering](https://every.to/compound-engineering/); Will Larson, [Learning from Every's Compound Engineering](https://lethain.com/everyinc-compound-engineering/)
- Sakana AI, [Darwin Gödel Machine](https://sakana.ai/dgm/); [arXiv 2505.22954](https://arxiv.org/abs/2505.22954v2)
- Claude Code docs, [glossary (agent teams, subagents)](https://code.claude.com/docs/en/glossary)
