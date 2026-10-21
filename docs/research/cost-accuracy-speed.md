# Making Orchestra cheaper, more accurate and faster

Research notes and a ranked backlog. Written 2026-10-21. Claims marked **(preprint)** are
self-reported by their authors and were read from abstracts only. Claims marked **(measured)**
come from Orchestra's own ledger and runs.

## What the literature says

| Theme | Finding | Source |
|---|---|---|
| Multi-agent cost | Agents use about 4x the tokens of chat, multi-agent about 15x. Token usage alone explained 80% of variance in one eval. Coding is a weaker fit for multi-agent than breadth-first research. | [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) |
| Multi-agent value | Multi-agent frameworks often show small gains over single-agent. Failures cluster in system design, inter-agent misalignment and task verification. | [Cemri et al., MAST](https://arxiv.org/abs/2503.13657) |
| Keep it simple | Prefer the simplest workflow that works. Evaluator-optimizer pays off only with clear criteria. Tool and interface design deserves prompt-level care. | [Anthropic, building effective agents](https://www.anthropic.com/engineering/building-effective-agents) |
| Effort scaling | Put explicit effort rules in prompts (1 agent and a few calls for simple work, more only when needed) to stop over-spawning. | Anthropic, multi-agent research system (above) |
| Long-running harnesses | Fresh session per feature, a JSON feature list agents may only flip to passing, a progress file, git commits, and end-to-end checks before marking done. | [Anthropic, effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) |
| Prompt caching | Reads cost 0.05x to 0.1x of base input depending on model, 5-minute writes 1.25x, 1-hour writes 2x. Cache hierarchy is tools, then system, then messages. Anything volatile placed early (timestamps, per-run text) kills hits. | [Claude API docs, prompt caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) |
| Routing and cascades | Try a cheap model first and escalate on low confidence (FrugalGPT, RouteLLM). Per-step routing inside an agent trajectory beat per-query routers in one ICML 2026 paper **(preprint)**. | [Routing and cascading survey](https://arxiv.org/pdf/2603.04445), [AgentRouter](https://icml.cc/virtual/2026/75165) |
| Verification as a scaling axis | Finer-grained scores, repeated evaluation and splitting criteria each raised verifier accuracy. Logit-weighted scoring needs token probabilities, which `claude -p` does not expose. | [LLM-as-a-Verifier](https://arxiv.org/abs/2607.05391) **(preprint)** |
| Test-driven judging | Synthesizing tests and simulating execution let a small judge match much larger models on code correctness **(preprint)**. | [MCTS-Judge](https://arxiv.org/abs/2502.12468) |
| Self-improvement | Archive of agents, branch from any member, validate every change empirically, sandbox and keep humans in the loop. SWE-bench 20% to 50% in the original run. | [Darwin Godel Machine](https://arxiv.org/abs/2505.22954) |
| Eval size | Start with about 20 cases. Large effects show up in small samples, small effects do not. | Anthropic, multi-agent research system (above) |

## What Orchestra's own data says (measured)

Single-task run, harness v1: planner $0.74, worker $0.13, judge $0.65, librarian $0.03.
Opus roles (planner and judge) are about 90% of the cost. The worker is the cheap part.

Failure seen in production: on a docs task the judge hit its $1 budget before returning a
verdict. The task was scored 0.00 and failed three times. About $4 of correct worker output
was thrown away and a dependent task was blocked. The evolver found the same cause and
proposed a fix, but the eval gate rejected it with a gain of -0.010. With 2 to 3 eval cases a
gain that small is noise, so the gate was not able to decide either way.

## Ranked backlog

Ordered by expected value per unit of effort. Items 1 to 5 are small and independent enough
to run through Orchestra itself.

1. **A judge must always return a verdict.** On budget exhaustion or crash, retry the judge
   once (alone, without redoing the worker), then fail with an actionable issue. Never score
   a worker 0.00 for a judge failure. Saves the largest measured waste.
2. **Record cache and token usage in the ledger.** Add input, output, cache-read and
   cache-write tokens per session and show cache hit ratio in `orchestra stats`. Every later
   cost decision depends on this. Measure before optimising.
3. **Stable-prefix prompts.** Order every role prompt from most stable to most volatile
   (role rules, learnings, repo file list, then goal, task and diff). Parallel workers and
   repair attempts then share a cacheable prefix. Check the benefit with item 2 before
   claiming savings, since Claude Code controls its own cache breakpoints.
4. **Tiered judging.** Run a cheaper judge model first. Escalate to the strong judge only when
   tests fail, the score is within a margin of the pass threshold, or the cheap judge reports
   low confidence. Config-driven and off by default until the eval shows no accuracy loss.
5. **Variance-aware promotion gate.** Refuse to promote a harness when fewer than N eval
   cases exist (default 5), and require the gain to exceed the observed run-to-run spread, not
   a fixed 0.02. Stops both false promotions and false rejections.
6. **Per-criterion judging.** Score each acceptance criterion separately, then aggregate.
   Supported by the verifier-scaling results and gives repair notes that are easier to act on.
7. **Planner fast path.** For small, single-file goals skip decomposition and run one worker
   plus one judge. The planner is $0.74 of a $1.54 run. Needs an eval case set first.
8. **Model-agnostic roles.** Replace literal model names in harness config with tiers
   (strong, balanced, fast) mapped per provider, and a small capability table (context size,
   cache minimum, price). Makes the harness portable across models and runners.
9. **Progress file for repair attempts.** Pass the previous attempt's diff summary and judge
   issues in a structured file, as in Anthropic's long-running harness guidance.
10. **Deterministic checks before any LLM judge.** Lint, type check, and "tests added for new
    logic" as cheap gates ahead of the judge.

## Not recommended

- Logit-weighted verification: not available through `claude -p`.
- More agents or debate rounds: MAST and the Anthropic cost data point the other way for
  coding work.
- Raising every role to the strongest model: moves cost the wrong way for this goal.

## Caveats

Several figures above come from preprints and conference listings read as abstracts.
Verify against the full papers before quoting them. Pricing and cache minimums change, so
re-read the caching docs before tuning for them.
