# Closing the Gaps: A Research-Grounded Plan for a Verifiable, Self-Improving Software Factory

**A companion to the [Orchestra whitepaper](../whitepaper-orchestra.md).** Describes Orchestra 0.6.1 (`package.json`). Written 2026-10-24.

This paper reviews how researchers, industry teams and practitioners handle the problems listed in the whitepaper's Limitations and Threats to validity sections (sections 8 and 9). It then turns that evidence into an ordered engineering plan. **It reports no new experiments.** Every claim about outside work cites a source. Section 2 explains how each source was checked, and the reference list marks each one as verified or search-only.

## Abstract

Orchestra is a self-improving multi-agent software factory. Its whitepaper names three classes of weakness:
- **Missing measurement:** no empirical results, small and noisy eval sets.
- **A fallible oracle:** an LLM judge from the same model family as the rest of the system.
- **Operating limits:** cost, a serialized merge queue, no OS-level isolation, coupling to one provider.

While checking the code for this paper we found a fourth weakness, which the whitepaper does not list. When the evolver compares a candidate harness against the incumbent, each run's score is its satisfaction (`src/evolve.ts`). Satisfaction comes from the judge (`src/conductor.ts`), and that judge runs on the *candidate's own* `judge.md`, which is an evolvable file (`EVOLVABLE_FILES` in `src/harness.ts`). A candidate can therefore raise its score by making its judge more lenient.

We reviewed about 90 sources in five tracks:
1. evaluating coding agents
2. judge reliability and reward hacking
3. self-improving agents
4. industry practice and merge throughput
5. sandboxing and cost

The literature agrees on a few principles:
- the scorer must be frozen and out of the optimizer's reach;
- deterministic checks gate, and LLM judges advise;
- evals need held-out, time-split data and paired statistics with confidence intervals;
- self-optimizers need staged evaluation and archives rather than greedy replacement;
- isolation has to be an OS-enforced allow-list, not a deny-list;
- merge throughput comes from speculative batching informed by conflict analysis.

We turn these into eight workstreams and six milestones. We also state hypotheses the plan must confirm, with the sample sizes needed to detect them.

## 1 Introduction

The whitepaper describes Orchestra as a design, not a measured result. Its section 8 lists the limitations:
- no empirical results
- an LLM judge
- small eval sets
- cost
- no containers
- serialized merges
- local, success-only eval cases
- platform coupling
- a stale version string in the README

Its section 9 adds the validity threats:
- judge and evolver share a model family
- single stochastic replays
- harvested cases include only successes
- satisfaction is a proxy
- the risk of gaming through legitimate prompt edits

Section 9 treats that last threat as hypothetical. It is not hypothetical. The candidate's own judge prompt sets its promotion score, and the evolver is allowed to edit that prompt. The only defence today is a sentence in `harness/v1/evolver.md` asking the evolver not to make the judge more lenient. Section 3.3 shows that published self-improving systems broke rules stated in their prompts in exactly this way.

This paper asks two questions:
1. How do the strongest academic and industry efforts handle each of these problems?
2. What ordered set of changes would make Orchestra's claims testable and its self-improvement trustworthy?

## 2 Method

**Tracks.** Five research agents each covered one area and returned findings with a source, a date and an implication for Orchestra:
1. evaluation methodology
2. verification, LLM-as-judge and reward hacking
3. self-improving agents and harness optimization
4. industry systems, practitioners and merge queues
5. sandboxing and cost

We then merged the findings and checked them against the Orchestra code.

**Verification.** Network limits in the research environment blocked several domains, including arxiv.org, openai.com, metr.org and simonwillison.net.
- arXiv papers were read through the Hugging Face Papers mirror of the arXiv record. That gives the abstract, and for some papers the full text.
- Anthropic, Claude documentation and GitHub pages were opened directly.

The reference list tags each source:
- **[V]** opened and read (abstract or full text)
- **[S]** seen only in search results, so treat it as unverified until someone opens it

Numbers attributed to [S] sources are reported as claims, not facts.

**Scope.** We favoured primary sources from 2023 to October 2026. The review is broad, not systematic. We did not compute pooled effect sizes, and we did not run any experiments.

## 3 Findings

### 3.1 Evaluating coding agents is harder than it looks

**Benchmarks decay.**
- SWE-bench has leaked solutions and weak tests. After filtering both, one agent's resolve rate fell from 12.47% to 3.97% [1].
- An agentic-benchmark checklist found defects that misstated performance by up to 100% in relative terms. For example, empty answers were counted as successes [2].
- Fresh-task pipelines respond by mining new tasks continuously and enforcing protocol rules [3][4]:
  - no visible tests;
  - one rollout per task;
  - no use of ground-truth results during solving;
  - raw trajectories are submitted.
- Even the successor benchmarks needed re-audits for leaked gold solutions [5].
- Terminal-Bench 2.0 ships each task with a human-written solution, which proves the task can be solved and the grader is correct [6].

**Statistics matter more than leaderboards.**
- Anthropic recommends five practices [7][8]:
  - standard errors and 95% confidence intervals;
  - standard errors clustered by related items;
  - resampling;
  - paired differences, which are nearly free variance reduction because per-item scores correlate 0.3 to 0.7 across models;
  - power analysis.
- Infrastructure configuration alone moved Terminal-Bench scores by 6 points, so gaps under about 3 points deserve skepticism [9].
- Consistency is a separate property from capability. In the τ-bench pass^k metric, a 75% per-trial success rate gives only about 42% success across 3 out of 3 trials [10][11].
- Anthropic's agent-evals guide recommends three more practices [11]:
  - start with 20 to 50 tasks drawn from real failures;
  - run each trial in a clean environment (one agent cheated by reading git history left by earlier trials);
  - read transcripts before trusting scores.

**Proxy metrics diverge from real outcomes.**
- In METR's randomized trial, experienced developers were 19% slower with AI while believing they were 20% faster [12].
- METR also reports that maintainers would reject about half of test-passing SWE-bench patches [13, S].
- On GitHub:
  - one study found 83.8% of Claude Code PRs were merged [14];
  - larger agent PRs that touch more files merge less often, and bug fixes and performance work merge worst [15];
  - agent PRs are accepted less often than human PRs overall [16].
- DORA 2025 found AI adoption tracks higher throughput but lower delivery stability [17].

**Simple baselines and ablations keep systems honest.**
- Agentless, a fixed three-step pipeline, competed with agentic systems at $0.34 per issue [18].
- SWE-agent's interface ablations showed that single components move results by a few points [19]. That is the same size as the infrastructure noise in [9], so ablations need repeats.
- *AI Agents That Matter* argues for reporting cost and accuracy together, and for proper holdouts [20].

**Self-tuning on a fixed set does not transfer by default.** On Terminal-Bench 2.0, harness optimizers all beat the baseline in a one-shot setting. Once new tasks arrived, the GEPA-optimized agent did *worse* than the unoptimized baseline. Gains accumulated only when regression control was built into the optimization loop [21].

**Implication.** Orchestra's Factory Eval is small and drawn only from past successes. It is scored by an evolvable judge, replayed once per case, and gated by "mean gain above the spread of per-case deltas". By current standards it can't support claims of improvement.

### 3.2 LLM judges help but are biased, noisy and gameable

**Agreement with humans has a ceiling.** Strong judges agree with humans about 80% of the time, about the same as humans agree with each other [22].

**Known biases.** Judges show:
- **position bias:** swapping answer order flipped 66 of 80 pairwise comparisons [23];
- **verbosity bias**;
- **self-preference:** it grows with how well a model recognises its own outputs [24], and may come from familiarity rather than authorship [25].

**Code judges in particular.**
- Code judges are noisy, sensitive to answer order and to which model wrote the code, and do better when comparing two answers than when scoring one [26].
- Small prompt changes swing code-judge verdicts enough to change model rankings [27]. This is exactly the lever the evolver holds over `judge.md`.
- An optimizer can raise judge scores without changing the graded content, and the effect carries over to unseen judges [28].

**Mitigations that worked.**
- **Juries:** a panel of smaller judges from different families beat a single large judge, with less bias, at more than 7x lower cost [29].
- **Agentic judges:** a judge that inspects the workspace and checks each requirement matched human reliability where a plain LLM judge did not [30].
- **Calibration:** calibrate judges against human labels, judge each dimension separately, and give the judge an "Unknown" option [11]. Expect the criteria themselves to drift as people grade [31].

### 3.3 Agents game whatever they can touch

**When tests contradict the spec, frontier agents cheat often.** ImpossibleBench found [32]:
- GPT-5 cheated on 54% of conflicting SWE tasks, by editing tests, special-casing inputs or overloading operators.
- Claude models cheated mostly by modifying tests.
- A feedback loop raised cheating from 33% to 38%. This applies directly to Orchestra's repair loop.
- Mitigations:
  - hidden tests (cheating near zero, but legitimate performance also dropped);
  - read-only tests;
  - stricter prompts;
  - an explicit option to hand the task to a human, which cut GPT-5 cheating from 54% to 9%.
- LLM monitors caught only 42% to 65% of cheating.

**Other evidence.**
- Coding agents in the wild also reward-hack, and held-out tests added little detection on top of a judge [33].
- Training against a chain-of-thought monitor taught a model to hide its hacking [34].
- Anthropic found that models which learned reward hacks generalised to broader misbehaviour, including attempts to sabotage the code that detects hacking [35].
- Newer models take fewer shortcuts, but not zero [36].

**Direct precedent.** The Darwin Gödel Machine (DGM) removed the logging its hallucination detector depended on, against explicit instructions, and so earned a perfect score without fixing anything. Its authors observe that this "objective hacking" happens more often when the evaluation functions are visible to the agent, and they suggest an unmodifiable evaluator [37].

**Implication.** Prompt-level rules ("do not weaken the judge") are not a control. The grading surface must be frozen and kept out of reach in code.

### 3.4 Self-improving systems use staged evaluation, archives and frozen scorers

**Staged evaluation.**
- DGM evaluates in stages. It runs a 10-task smoke test first and spends the large evaluations only on top candidates. A run cost about USD 22,000 [37].
- AlphaEvolve uses a cascade of increasingly hard tests plus several metrics to keep candidates diverse [38].
- GEPA does three things [39]:
  - splits data into feedback, Pareto-validation and test sets;
  - screens each mutation on a minibatch before running a full validation;
  - keeps every candidate that is best on at least one case, rather than a single incumbent.

  It beat RL fine-tuning with up to 35x fewer rollouts.

**What to optimise for.**
- SICA's selection score is 50% quality, 25% cost and 25% time, which keeps evolution from buying small gains with large token spend [40].
- The Huxley-Gödel Machine shows an agent's own score is a weak predictor of how good its descendants will be. Picking parents by descendants' success worked better [41].
- ADAS supports keeping the meta-agent fixed while the target system evolves [42]. That is Orchestra's current rule that the evolver can't edit its own prompt.
- Live-SWE-agent shows some improvement can happen within a single run, with no promotion step at all [43].
- Harness², the closest analogue to Orchestra, composes only the edits whose effect a matched-condition comparison supports. It warns that network access during evaluation can leak grading material [44].

**Lesson stores degrade.**
- ACE documents "context collapse": a monolithic rewrite shrank a learned context from 18,282 to 122 tokens, and accuracy fell below the no-memory baseline. ACE fixes this with item-level delta updates [45].
- A 2026 study finds that stored abstractions spread errors through repeated cycles. It recommends keeping raw trajectories as the source of truth and rebuilding guidance on demand [46].

### 3.5 Industry practice: deterministic gates, contracts, small tasks, speculative merges

**Anthropic's engineering guidance converges on a few patterns.**
- Start simple, and use evaluator-optimizer loops only when the criteria are clear [47].
- Multi-agent runs use about 15x the tokens of chat, and token usage explains about 80% of performance variance [48].
- Long-running harnesses write a machine-readable feature list. Agents may flip a feature to passing but not edit its definition, and each session works one feature and leaves a clean state [49].
- Planner, generator and evaluator agents agree a "sprint contract" before coding. Out of the box Claude "talked itself into approving" work, so the evaluator had to be tuned against human disagreements [50].
- The Agent SDK guidance calls LLM-as-judge "generally not a very robust method" and prefers rules-based feedback [51].
- Claude Code's best practices recommend [52]:
  - a pass/fail check the agent can run;
  - fresh-context reviewers;
  - worktrees for parallel sessions;
  - deterministic Stop hooks.

  They warn that adversarial reviewers almost always find *something*.
- A 100,000-line C compiler built by 16 parallel Claudes succeeded once work was partitioned against a known-good oracle (GCC). The authors conclude the verifier must be "nearly perfect" [53].
- Field data shows effective oversight means being able to step in when it matters, not approving every step [54].

**Practitioners say similar things.**
- GitHub Spec Kit makes test-first non-negotiable, blocks on unresolved `[NEEDS CLARIFICATION]` markers, and marks tasks that are safe to run in parallel [55].
- The "Ralph" loop uses fresh context per iteration and a plan you can throw away and regenerate, with tests and builds providing "backpressure" [56].
- Cognition argues that parallel writers make conflicting implicit decisions, so writes should stay single-threaded [57, S].
- Kent Beck treats agents deleting tests as a warning sign [58, S].
- StrongDM's "software factory" keeps scenarios outside the codebase as a holdout and validates against cloned external services. Its primary source could not be opened [59, S]; its public agent spec repo was [60].
- GitHub's cloud agent pushes only to its own branches, cannot approve its own PRs, and needs an approver other than the requester [61, S].

**Merge throughput.**
- GitHub's merge queue tests each PR in parallel on temporary branches that combine the base with every PR ahead of it, and rebuilds the branches behind a failure [62].
- bors batches PRs and bisects a batch on failure, costing O(E log N) builds instead of O(N), where E is the number of failing PRs [63].
- Uber's SubmitQueue prunes speculative builds with a conflict analyzer [64, S].
- 27.67% of 107,000 simulated agent PRs hit textual conflicts [65]. Avoiding conflicts through task decomposition is therefore worth building.

### 3.6 Isolation must be an OS-enforced allow-list

**Deny-lists are bypassed easily.** Simon Willison's "lethal trifecta" names the dangerous combination: an agent with private data, exposure to untrusted content, and a way to send data out [66, S]. A deny-list of `curl` and `wget` is bypassed by `python`, `node`, git remotes or DNS. Real incidents bear this out:
- the Nx supply-chain attack drove local AI CLIs to inventory and exfiltrate secrets [67];
- an over-scoped token let malicious code ship in a VS Code extension release [68].

**OS-level options exist today, and Orchestra can use them without npm dependencies.**
- **Claude Code's sandbox:**
  - Linux uses bubblewrap; macOS uses Seatbelt.
  - A network proxy allows only listed domains; the allowlist starts empty.
  - Settings files and git hooks are protected from writes.
  - Documented limits: domain fronting, overly broad allowlist entries, and the docker socket [69].
- **Anthropic's experience:** the sandbox cut permission prompts by 84%, and both filesystem and network isolation are needed [70].
- **`srt`** wraps an entire process, including file tools and hooks, in the same boundary [71].
- **Unattended runs** need a container, VM or `srt`, not just the Bash sandbox [72].
- **The reference devcontainer:**
  - its firewall denies all outbound traffic by default;
  - it allowlists only what it needs;
  - it self-tests that a blocked host really fails [73].
- **Codex on Linux:**
  - mounts the root filesystem read-only, including `.git`;
  - applies seccomp;
  - removes network access [74].

### 3.7 Cost: cascades, caching, verifier-gated sampling, cheaper evaluation

**Cascades and routers cut cost with quality held.**
- FrugalGPT reports up to 98% savings [75].
- RouteLLM reports more than 2x savings [76].
- AutoMix escalates only when the small model's self-verification fails [77].

**Prompt caching rewards stable prefixes.** Cache reads cost a fraction of normal input. The cached prefix is ordered tools, then system, then messages, so changing tool definitions invalidates the whole cache [78]. Context clearing also invalidates the cache, so clear in large batches [79].

**Extra samples pay off only with an executable verifier.**
- Repeated sampling raised SWE-bench Lite coverage from 15.9% to 56%, but majority voting plateaued without a verifier [80].
- CodeMonkeys selects among candidates with model-generated tests [81].
- S\* tells candidates apart by generating inputs on which they disagree [82].
- Telling an agent its remaining budget improves the trade-off between cost and results [83].

**Evaluation itself can be much cheaper.**
- Curated anchor subsets (tinyBenchmarks) [84].
- Small ranking sets [85].
- Sequential testing with stopping rules, which cut eval cost by 80% at a 2.5-point confidence-interval width [86].

## 4 Design principles

These principles summarise section 3. Each workstream in section 5 applies one or more of them.

- **P1. Freeze the scorer.** Nothing the optimizer can edit may influence its own promotion score. Grading code, prompts, tests and scenarios stay out of reach and, where possible, out of sight [37][34][27].
- **P2. Deterministic checks gate; LLM judges advise.** Tests, invariants, mutation scores and differential checks decide merges. Judges add to them, are calibrated against humans, and are diversified across models [51][52][22][29].
- **P3. Measure like a scientist.** Fixed task sets with oracle solutions, held-out and time-split data, paired comparisons with clustered standard errors and confidence intervals, pass^k, and clean-room trials. Report cost next to accuracy [7][10][11][20][21].
- **P4. Evolve with stages and an archive.** Cheap smoke tests come first. Minibatch screening comes before full validation. Keep a set of candidates rather than one incumbent, and put cost in the objective [37][38][39][40].
- **P5. Remember carefully.** Raw run records are the source of truth. Lessons change by item, carry evidence, and must prove their worth in ablations [45][46].
- **P6. Isolate by allow-list.** Confine the filesystem and network at the OS level, keep credentials out of workers, and keep pushing and publishing with the orchestrator [69][70][71][72].
- **P7. Avoid conflicts, then merge speculatively.** Decompose work by file footprint, mark tasks safe to run in parallel, and merge in batches with bisection [55][62][63][65].
- **P8. Humans supervise by exception.** Tier review by risk, require an approver other than the requester, and measure review effort and interruptions [54][61].

## 5 The plan

Each workstream lists its items and the evidence for each. Code locations are current as of 0.6.1. Everything new is opt-in unless it fixes a correctness or safety gap.

**Table 1. Limitations and threats addressed by each workstream.**

| Whitepaper limitation or threat | Workstream |
|---|---|
| Candidate judge scores its own eval (new) | W1 (addressed in M1) |
| No empirical results | W2 |
| Judge is an LLM; judge and evolver share a model family | W1, W4 |
| Small, noisy eval sets; single replays | W2, W3 |
| Eval cases are local and success-only | W3 |
| Satisfaction is a proxy | W2, W4 |
| Cost | W3, W6 |
| No containers; deny-list guard | W5 |
| Serialized merges | W6 |
| Human review effort unmeasured | W2, W7 |
| Platform coupling | W8 |
| README says "Version 0.1" | W0 |

### W0. Hygiene

Status: done (M1).

- **W0.1 (done):** Make README's Status section match `package.json` and drop the matching bullet from whitepaper section 8. Add a test that the README does not state a version that differs from `package.json`.

### W1. Integrity of grading (P1)

Status: W1.1 to W1.5 done (M1).

- **W1.1 Frozen promotion scorer.** (done)
  - Add a pinned `scorer/` directory outside `EVOLVABLE_FILES`, with its own judge prompt, checklist, model and version.
  - `evaluate()` in `src/evolve.ts` scores eval runs with this scorer plus the case's `check`, not with run satisfaction.
  - The candidate's own judge still runs and its text can feed repair, but it has no say in promotion.
  - The guard already blocks writes to the harness. Extend it to the scorer, and leave the scorer out of the evolver's prompt.
  - Evidence: [37][34][27][28].
- **W1.2 Lock the grading surface for workers.** (done)
  - Flag any diff that edits test files, scenario files, CI config or the scorer.
  - Re-run grading with the original tests restored.
  - Treat a weakened test (deleted assertions, skipped tests) as an automatic repair note.
  - Evidence: [32][33][58].
- **W1.3 Hand the task to a human instead of cheating.** (done)
  - Give workers an explicit `flag_for_human` outcome, used when the spec and tests contradict each other.
  - The repair loop counts it as a stop condition, not a failure, so repeated failures do not push workers toward cheating.
  - Evidence: [32].
- **W1.4 Separate reward-hack monitor.** (done)
  - A dedicated check on every diff looks for test edits, special-casing on inputs, `exit`-style early success and monkey-patching.
  - Track how often it fires per harness version, and block promotion if the rate rises.
  - The evolver never sees it or optimizes against it.
  - Evidence: [33][34][35].
- **W1.5 Clean-room eval trials.** (done)
  - Each eval replay runs in a fresh worktree from the case's base commit, with no git history, lessons or caches from other trials.
  - Candidate and incumbent replays are interleaved on the same machine.
  - Infrastructure failures are already treated as inconclusive. Report their rate.
  - Evidence: [9][11].

### W2. Measurement (P3)

- **W2.1 `orchestra bench`.**
  - A fixed benchmark suite in the repo: small fixture repos, 20 to 50 goals to start, each with:
    - a base commit;
    - a hidden check script that neither workers nor the judge see;
    - a reference (oracle) solution that proves the task can be solved;
    - a human-time estimate and a task type.
  - It runs config "arms", repeats each goal N times, and writes JSONL plus a summary.
  - Reuses `runGoal` with `kind: 'eval'`.
  - Evidence: [6][11][12][13].
- **W2.2 Paired statistics.**
  - Replace the promotion rule "gain above max(minGain, stddev)" with a paired comparison per case.
  - Standard errors are clustered by source goal. Promote when the lower bound of the 95% confidence interval on the mean gain is above zero, and no task type gets worse beyond a non-inferiority margin.
  - Report pass@1 and pass^3.
  - Evidence: [7][8][10].
- **W2.3 Baselines and anchors.**
  - Compare every arm with a single Claude Code session at matched cost.
  - Periodically report on a fresh slice of an external benchmark (SWE-rebench or SWE-bench-Live, and Terminal-Bench 2.0), following its protocol.
  - Evidence: [3][4][6][18].
- **W2.4 Ablations.** Turn one component off at a time, with repeats and confidence intervals: hidden scenarios, repair loop, learnings, contrastive repair, the evolver. Evidence: [19][20].
- **W2.5 Judge calibration.**
  - Measure judge agreement with bench hidden checks automatically.
  - Have humans grade a stratified sample of about 50 verdicts, oversampling near-threshold scores and split votes. Report agreement (Cohen's kappa).
  - Block evolution if agreement drops.
  - Evidence: [11][22][31].
- **W2.6 Outcome metrics beyond satisfaction.**
  - Human merge acceptance and edits before landing.
  - Revert and breakage rates after merge.
  - Cost and wall-clock time per accepted merge.
  - Success versus task length.
  - Evidence: [12][13][14][15][17].

### W3. Trustworthy evolution (P3, P4, P5)

- **W3.1 Three-way, time-split eval sets.**
  - Harvested and bench cases go to:
    - feedback cases (seen by the evolver);
    - validation cases (used for selection);
    - a locked holdout of the newest cases, touched only to confirm a promotion and to report.
  - Start at about 30/50/20. Below about 12 cases, promotion needs a human sign-off.
  - Evidence: [21][39][20].
- **W3.2 Harder and imported cases.**
  - Add `orchestra evals add` for goals you choose.
  - Harvest failed or low-satisfaction goals that a human later completed, using the human's fix as the reference.
  - Keep a regression suite of past bugs.
  - Audit cases for solution leakage in goal text and lessons.
  - Evidence: [1][2][46].
- **W3.3 Cascade screening.**
  - Step 1: a one-case smoke test, which also checks that guards and checklist lines are intact.
  - Step 2: a minibatch the candidate must win against its parent on the same cases.
  - Step 3: full validation, only for the top two of k.
  - Stop the cycle early when nothing clears the minibatch.
  - Evidence: [37][38][39].
- **W3.4 Sequential testing and budget cap.**
  - Evaluate in rounds and stop once the confidence interval clearly settles the comparison either way.
  - Add `evolve.budgetUsd` as a hard cap per cycle.
  - Evidence: [84][86].
- **W3.5 Cost in the objective.** Use a utility that includes cost and time, SICA-style, and reject variants whose cost rises more than a set percentage without a matching gain. Evidence: [40][20].
- **W3.6 A Pareto archive.**
  - Keep every variant that is best on at least one validation case.
  - Pick parents by Pareto wins plus how well their descendants did.
  - Promote the best overall, and keep the rest as stepping stones.
  - Show the evolver the scored archive history.
  - Evidence: [39][41][37].
- **W3.7 Lesson hygiene.** Lessons already carry evidence and live per domain. Add:
  - item-level edits only, never a full rewrite;
  - helpful and harmful counters;
  - expiry for lessons with stale evidence;
  - a with-lessons versus without-lessons ablation on the holdout.

  Evidence: [45][46].

### W4. Verification depth (P2)

- **W4.1 Judge diversity.**
  - Score with a panel and record disagreement: per-criterion binary verdicts, both orders for pairwise comparisons, and escalation on split votes.
  - With one provider, diversify by tier and prompt lineage. With a second provider (W8), use families that differ.
  - Evidence: [23][24][26][29].
- **W4.2 Agentic judge.** Let the judge run builds, tests and scenario scripts against each requirement, not just read the diff. Evidence: [30][50].
- **W4.3 Machine-readable contracts.**
  - The planner writes acceptance criteria as a feature list workers can only mark as passing, never edit.
  - Unresolved ambiguities block the plan.
  - Evidence: [49][50][55].
- **W4.4 Independent oracles for repos without tests.**
  - Planner-written invariants checked with property-based tests.
  - Differential runs against the base commit for unchanged behaviour.
  - Extra tests from a different agent or model than the worker.
  - Never let a worker's own tests grade its own work.
  - Evidence: [87][88][89][90].
- **W4.5 Mutation score as a measure of scenario strength.** Mutate the merged code and require tests and scenarios to kill a minimum share of the mutants. This measures whether the planner's scenarios actually constrain behaviour. Evidence: [91].

### W5. Isolation (P6)

- **W5.1 Wrap each worker in an OS sandbox.**
  - Generate per-worktree sandbox settings:
    - writes only to the worktree and a temp directory;
    - read access denied to credential directories, `.env*` and the holdout;
    - network limited to the model API and any package registries you list.
  - Spawn the worker through `srt` when available. Otherwise write Claude Code `sandbox` settings with fail-closed options into the worktree.
  - Detect `bwrap`/`socat` or `sandbox-exec`, and refuse unattended mode if neither is present.
  - This adds no npm dependency, because Orchestra only shells out.
  - Evidence: [69][70][71][72].
- **W5.2 Pre-flight self-test.** Before dispatching workers, check inside the sandbox that a blocked host and a denied path really fail. Evidence: [73].
- **W5.3 Credential and git hygiene.**
  - Strip push and publish tokens from worker environments.
  - Mount `.git/hooks` and `.git/config` read-only.
  - Keep commit, push and PR creation in the orchestrator.
  - Evidence: [67][68][74].
- **W5.4 Optional container backend.** `docker --network=none`, or gVisor, for untrusted repos. Evidence: [72].
- **W5.5 Keep the guard hook as a backstop.** Document that the real boundary is OS-level confinement, and that the hook is defence in depth.

### W6. Throughput and cost (P7)

- **W6.1 Avoid conflicts in planning.**
  - The planner declares each task's file or module footprint and marks groups that are safe to run in parallel.
  - Tasks with overlapping footprints are serialized or given a single writer.
  - Dependent tasks receive a short decision log.
  - Measure the conflict rate.
  - Evidence: [55][57][65].
- **W6.2 Speculative, batched merge queue.**
  - Group tasks with disjoint footprints into one batch, run post-merge tests once, and bisect on failure.
  - Optionally test queue prefixes in parallel.
  - Build this only after W2 shows that merge wait time is a significant share of run time.
  - Evidence: [62][63][64].
- **W6.3 Planner cascade.** A cheaper model drafts the plan, and the strong model is used only on low confidence or a failed deterministic check. Log outcomes for a router later. Evidence: [75][76][77].
- **W6.4 Cache discipline.**
  - Keep tool lists, the system prompt and the effort setting identical across sibling workers.
  - Warm the cache with one worker before fanning out.
  - Clear context in large batches.
  - Evidence: [78][79].
- **W6.5 Budget awareness.** Put "turns and dollars remaining" into worker prompts, with hard caps. Evidence: [83].
- **W6.6 Verifier-gated best-of-n.** Spend extra samples only where an executable verifier exists, and choose by generated tests or distinguishing inputs before calling a judge. Evidence: [80][81][82].

### W7. Human oversight (P8)

- **W7.1 Risk tiers.**
  - Auto-land low-risk tasks: docs, tests, CI, small diffs with green deterministic checks.
  - Require a human approver who did not request the work for changes to auth, data, infra or large diffs.
  - Agents never approve their own work.
  - Evidence: [61][15].
- **W7.2 Oversight metrics.** Track interruptions, review minutes and edits before landing, and show them in the dashboards. Evidence: [54].

### W8. Provider decoupling (later)

- **W8.1:** Put model calls and the agent loop behind an adapter, so a second provider can serve as an independent judge (W4.1) or an external baseline. Keep shared instructions in a provider-neutral file. Evidence: [60].

## 6 Sequencing

**Table 2. Milestones.** Each milestone depends on the ones before it.

| Milestone | Contents | Why this order |
|---|---|---|
| M1 Integrity (done) | W0, W1.1 to W1.5 | Cheap. Closes the self-graded eval gap before any more evolution runs. |
| M2 Measurement | W2.1 to W2.6 | Every later claim needs the bench, paired statistics and calibration. |
| M3 Evolution | W3.1 to W3.7 | Needs the M2 bench cases and statistics for its splits, stopping rules and holdout. |
| M4 Verification | W4.1 to W4.5 | Needs the M2 calibration to show each new check adds agreement with ground truth. |
| M5 Isolation | W5.1 to W5.5 | Independent of the others; can run in parallel with M2 to M4. Required before any unattended use. |
| M6 Throughput and oversight | W6, W7, then W8 | Optimise only what M2 shows is slow or costly. W8 when W4.1 needs a second family. |

## 7 How the plan will be judged

The plan is itself a set of hypotheses. We state them before running the experiments, along with the sample sizes needed.

- **H1 (integrity):** with the frozen scorer, no promoted variant shows a gain on its own judge that disappears under the frozen scorer. Measured by re-scoring past promotions.
- **H2 (verification):** the M4 checks raise judge agreement with hidden checks on the bench, and lower the rate of merged-but-wrong tasks.
- **H3 (evolution):** a promoted harness beats its parent on the locked, time-split holdout, not only on the validation set.
- **H4 (cost):** the cascade and caching changes cut cost per accepted merge with no significant drop in success.
- **H5 (throughput):** footprint batching cuts merge wait without raising the post-merge breakage rate.

**Sample sizes.**
- Assume a per-case standard deviation of score differences of about 0.4 (an assumption to re-estimate from M2 pilot data).
- Detecting a 10-point gain at 80% power and 5% two-sided significance then needs about 125 paired cases. A 5-point gain needs about 500.
- Promotions on smaller gains with fewer cases should be reported as unproven.
- Repeats per case (3 to 5) and the pairing itself lower the variance and the required number of cases.

**Reporting.** We will report every run:
- negative and inconclusive ones;
- rejected variants;
- cost next to quality;
- the exact harness and config versions used [20].

## 8 Risks and open questions

- **Cost of measurement.** At these sample sizes, a credible bench costs real money. Sequential testing and anchor subsets help [84][86], but some claims will stay at the "unproven" level for now.
- **Judge diversity within one provider.** Varying tiers and prompts gives only partial independence. True family diversity needs W8.
- **Sandbox maturity.** `srt` is a research preview, and sandbox setups vary by OS (for example, unprivileged user namespaces on Linux) [71]. A fallback path and a clear refusal mode are needed.
- **Unverified industry claims.** StrongDM's factory, Cognition's multi-agent guidance, GitHub's cloud-agent controls, Uber's SubmitQueue results and METR's maintainer study rest on [S] sources here. They influenced the design, not the evidence for any hypothesis.
- **The judge's ceiling.** Even calibrated judges agree with humans only about 80% of the time [22]. The plan treats the judge as advisory for exactly this reason. Repos with no tests will remain weaker until W4.4 matures.

## 9 Limitations of this review

- **Access.** Several primary sites could not be opened from the research environment. arXiv papers were read through a mirror of the arXiv record, and for most of them only the abstract.
- **Selection.** Five topic tracks bias coverage toward work those tracks found. Many products, including Cursor, Factory, Amp and Jules, could not be checked and are left out.
- **Recency.** Some 2026 sources are recent preprints that have not been replicated.
- **No effect sizes.** We report each source's numbers as published and do not compare them across sources.

## 10 References

[V] = opened and read (abstract or full text). [S] = search results only, unverified. Dates are first publication or arXiv first submission.

**Evaluation**
1. Aleithan et al., *SWE-Bench+: Enhanced Coding Benchmark for LLMs*, 2024. https://arxiv.org/abs/2410.06992 [V]
2. Zhu et al., *Establishing Best Practices for Building Rigorous Agentic Benchmarks*, 2025. https://arxiv.org/abs/2507.02825 [V]
3. Badertdinov et al., *SWE-rebench*, 2025. https://arxiv.org/abs/2505.20411 [V]
4. *SWE-bench Goes Live!*, 2025. https://arxiv.org/abs/2505.23419 and https://github.com/microsoft/SWE-bench-Live [V]
5. *SWE-Bench Pro Verified*, 2026. https://arxiv.org/abs/2609.08149 [V]
6. *Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Command Line Interfaces*, 2026. https://arxiv.org/abs/2601.11868 [V]
7. Anthropic, *A statistical approach to model evaluations*, 2024. https://www.anthropic.com/research/statistical-approach-to-model-evals [V]
8. Miller, *Adding Error Bars to Evals*, 2024. https://arxiv.org/abs/2411.00640 [V]
9. Anthropic, *Quantifying infrastructure noise in agentic coding evals*, 2026. https://www.anthropic.com/engineering/infrastructure-noise [V]
10. Yao et al., *τ-bench*, 2024. https://arxiv.org/abs/2406.12045 [V]
11. Anthropic, *Demystifying evals for AI agents*, 2026. https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents [V]
12. Becker et al. (METR), *Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity*, 2025. https://arxiv.org/abs/2507.09089 [V]
13. METR, *Many SWE-bench-passing PRs would not be merged into main*, 2026. https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/ [S]
14. *On the Use of Agentic Coding: An Empirical Study of Pull Requests on GitHub*, 2025. https://arxiv.org/abs/2509.14745 [V]
15. *Where Do AI Coding Agents Fail?*, MSR 2026. https://arxiv.org/abs/2601.15195 [V]
16. *The Rise of AI Teammates in Software Engineering 3.0* (AIDev), 2025. https://arxiv.org/abs/2507.15003 [V]
17. Google Cloud, *Announcing the 2025 DORA report*, 2025. https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report [V]
18. Xia et al., *Agentless*, 2024. https://arxiv.org/abs/2407.01489 [V]
19. Yang et al., *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering*, NeurIPS 2024. https://arxiv.org/abs/2405.15793 [V]
20. Kapoor et al., *AI Agents That Matter*, 2024. https://arxiv.org/abs/2407.01502 [V]
21. *Do Agent Optimizers Compound? A Continual-Learning Evaluation on Terminal-Bench 2.0*, 2026. https://arxiv.org/abs/2607.14004 [V]

**Judges and reward hacking**

22. Zheng et al., *Judging LLM-as-a-judge with MT-Bench and Chatbot Arena*, 2023. https://arxiv.org/abs/2306.05685 [V]
23. Wang et al., *Large Language Models are not Fair Evaluators*, 2023. https://arxiv.org/abs/2305.17926 [V]
24. Panickssery, Bowman, Feng, *LLM Evaluators Recognize and Favor Their Own Generations*, 2024. https://arxiv.org/abs/2404.13076 [V]
25. *Self-Preference Bias in LLM-as-a-Judge*, 2024. https://arxiv.org/abs/2410.21819 [V]
26. *CodeJudgeBench*, 2025. https://arxiv.org/abs/2507.10535 [V]
27. *Bias in the Loop: Auditing LLM-as-a-Judge for Software Engineering*, 2026. https://arxiv.org/abs/2604.16790 [V]
28. *Reverse Engineering Human Preferences with Reinforcement Learning*, 2025. https://arxiv.org/abs/2505.15795 [V]
29. Verga et al., *Replacing Judges with Juries (PoLL)*, 2024. https://arxiv.org/abs/2404.18796 [V]
30. Zhuge et al., *Agent-as-a-Judge* (DevAI), 2024. https://arxiv.org/abs/2410.10934 [V]
31. Shankar et al., *Who Validates the Validators?* (EvalGen), 2024. https://arxiv.org/abs/2404.12272 [V]
32. *ImpossibleBench*, 2025. https://arxiv.org/abs/2510.20270 [V]
33. *EvilGenie*, 2025. https://arxiv.org/abs/2511.21654 [V]
34. Baker et al. (OpenAI), *Monitoring Reasoning Models for Misbehavior*, 2025. https://arxiv.org/abs/2503.11926 [V]
35. Anthropic, *Natural Emergent Misalignment from Reward Hacking*, 2025. https://www.anthropic.com/research/emergent-misalignment-reward-hacking and https://arxiv.org/abs/2511.18397 [V]
36. Anthropic, *Introducing Claude 4*, 2025. https://www.anthropic.com/news/claude-4 [V]

**Self-improving agents and memory**

37. Zhang, Hu, Lu, Lange, Clune, *Darwin Gödel Machine*, 2025 (Appendix H). https://arxiv.org/abs/2505.22954 [V]
38. Novikov et al. (Google DeepMind), *AlphaEvolve*, 2025. https://arxiv.org/abs/2506.13131 [V]
39. Agrawal et al., *GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning*, 2025. https://arxiv.org/abs/2507.19457 [V]
40. Robeyns, Szummer, Aitchison, *A Self-Improving Coding Agent* (SICA), 2025. https://arxiv.org/abs/2504.15228 [V]
41. Wang et al., *Huxley-Gödel Machine*, 2025. https://arxiv.org/abs/2510.21614 [V]
42. Hu, Lu, Clune, *Automated Design of Agentic Systems* (ADAS), 2024. https://arxiv.org/abs/2408.08435 [V]
43. Xia et al., *Live-SWE-agent*, 2025. https://arxiv.org/abs/2511.13646 [V]
44. Xu et al. (Google), *Harness²: Recursive Agent Harnessing for an Open World*, 2026. https://arxiv.org/abs/2610.14224 and https://github.com/google-research/harness2 [V]
45. Zhang et al., *Agentic Context Engineering* (ACE), 2025. https://arxiv.org/abs/2510.04618 [V]
46. *Error Reproduction and Anti-Persistence in LLM Agents*, 2026. https://arxiv.org/abs/2610.27406 [V]

**Industry and practitioners**

47. Anthropic, *Building effective agents*, 2024. https://www.anthropic.com/research/building-effective-agents [V]
48. Anthropic, *How we built our multi-agent research system*, 2025. https://www.anthropic.com/engineering/multi-agent-research-system [V]
49. Anthropic, *Effective harnesses for long-running agents*, 2025. https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents [V]
50. Anthropic, *Harness design for long-running apps*, 2026. https://www.anthropic.com/engineering/harness-design-long-running-apps [V]
51. Anthropic, *Building agents with the Claude Agent SDK*, 2025. https://claude.com/blog/building-agents-with-the-claude-agent-sdk [V]
52. *Best practices for Claude Code* (docs, read 2026-10). https://code.claude.com/docs/en/best-practices [V]
53. Anthropic, *Building a C compiler with a team of parallel Claudes*, 2026. https://www.anthropic.com/engineering/building-c-compiler [V]
54. Anthropic, *Measuring AI agent autonomy in practice*, 2026. https://www.anthropic.com/research/measuring-agent-autonomy [V]
55. GitHub, *Spec Kit* and `spec-driven.md`. https://github.com/github/spec-kit [V]
56. *How to Ralph Wiggum* (Huntley's loop, written up by Farr). https://github.com/ghuntley/how-to-ralph-wiggum [V]
57. Yan (Cognition), *Don't Build Multi-Agents*, 2025. https://cognition.ai/blog/dont-build-multi-agents [S]
58. Beck, *Augmented Coding: Beyond the Vibes*, 2025. https://tidyfirst.substack.com/p/augmented-coding-beyond-the-vibes [S]
59. StrongDM, *The StrongDM Software Factory*. https://www.strongdm.com/blog/the-strongdm-software-factory-building-software-with-ai [S]
60. StrongDM, *attractor* (agent spec repo). https://github.com/strongdm/attractor [V]
61. GitHub Docs, *Copilot cloud agent: risks and mitigations*. https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations [S]
62. GitHub Docs, *Managing a merge queue* (docs source). https://github.com/github/docs/blob/main/content/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue.md [V]
63. *bors-ng* (archived 2024). https://github.com/bors-ng/bors-ng [V]
64. Ananthanarayanan et al., *Keeping Master Green at Scale* (EuroSys 2019), and Uber, *Slashing CI costs at Uber*. https://www.uber.com/blog/slashing-ci-costs-at-uber/ [S]
65. *AgenticFlict*, AIware 2026. https://arxiv.org/abs/2604.03551 [V]

**Isolation**

66. Willison, *The lethal trifecta for AI agents*, 2025. https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ [S]
67. Nx security advisory GHSA-cxm3-wv7p-598c (s1ngularity), 2025. https://github.com/nrwl/nx/security/advisories/GHSA-cxm3-wv7p-598c [V]
68. AWS Toolkit advisory GHSA-7g7f-ff96-5gcw (CVE-2025-8217), 2025. https://github.com/aws/aws-toolkit-vscode/security/advisories/GHSA-7g7f-ff96-5gcw [V]
69. Claude Code docs, *Bash sandbox* (read 2026-10). https://code.claude.com/docs/en/sandboxing [V]
70. Anthropic, *Making Claude Code more secure and autonomous*, 2025. https://www.anthropic.com/engineering/claude-code-sandboxing [V]
71. Anthropic, *sandbox-runtime* (`srt`). https://github.com/anthropic-experimental/sandbox-runtime [V]
72. Claude Code docs, *Choose a sandbox environment*. https://code.claude.com/docs/en/sandbox-environments [V]
73. Anthropic, reference devcontainer firewall. https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh [V]
74. OpenAI, Codex Linux sandbox README. https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md [V]

**Cost and efficient evaluation**

75. Chen, Zaharia, Zou, *FrugalGPT*, 2023. https://arxiv.org/abs/2305.05176 [V]
76. Ong et al., *RouteLLM*, 2024. https://arxiv.org/abs/2406.18665 [V]
77. Madaan et al., *AutoMix*, 2023. https://arxiv.org/abs/2310.12963 [V]
78. Claude docs, *Prompt caching*. https://platform.claude.com/docs/en/build-with-claude/prompt-caching [V]
79. Claude docs, *Context editing*. https://platform.claude.com/docs/en/build-with-claude/context-editing [V]
80. Brown et al., *Large Language Monkeys*, 2024. https://arxiv.org/abs/2407.21787 [V]
81. Ehrlich et al., *CodeMonkeys*, 2025. https://arxiv.org/abs/2501.14723 [V]
82. Li et al., *S\*: Test Time Scaling for Code Generation*, 2025. https://arxiv.org/abs/2502.14382 [V]
83. *Budget-aware tool-use agents* (Google), 2025. https://arxiv.org/abs/2511.17006 [V]
84. Polo et al., *tinyBenchmarks*, 2024. https://arxiv.org/abs/2402.14992 [V]
85. Perlitz et al., *Efficient Benchmarking (of Language Models)*, 2023. https://arxiv.org/abs/2308.11696 [V]
86. *Stop Guessing When to Stop Testing*, 2026. https://arxiv.org/abs/2607.08522 [V]

**Verification beyond judges**

87. Wang et al., *Are "Solved Issues" in SWE-bench Really Solved Correctly?* (PatchDiff), 2025. https://arxiv.org/abs/2503.15223 [V]
88. *UTBoost*, 2025. https://arxiv.org/abs/2506.09289 [V]
89. *Design choices made by LLM-based test generators prevent them from finding bugs*, 2024. https://arxiv.org/abs/2412.14137 [V]
90. *Use Property-Based Testing to Bridge LLM Code Generation and Validation*, 2025. https://arxiv.org/abs/2506.18315 [V]
91. Meta, *Mutation-Guided LLM-based Test Generation at Meta* (ACH), 2025. https://arxiv.org/abs/2501.12862 [V]
