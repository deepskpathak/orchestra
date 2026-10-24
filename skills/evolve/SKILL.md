---
name: evolve
description: Force an Orchestra self-improvement cycle. The evolver proposes a harness variant, it is scored on the Factory Eval against the current harness, and promoted only on a measured gain with no regressions.
disable-model-invocation: true
allowed-tools: Bash(orchestra *)
---

1. Run `orchestra evals`. If there are no eval cases, explain that evals are harvested automatically from successful runs (satisfaction 0.8 or higher) and that evolution will create a candidate but cannot score it yet. Ask whether to proceed.
2. Run `orchestra evolve` with the Bash tool using `run_in_background: true` (evaluation reruns past goals and can take a while and cost tokens).
3. When it finishes, run `orchestra stats --plain`, show it in a code block, and explain the outcome: candidate version, rationale, scores, promoted or rejected and why. Mention `orchestra promote <vN>` for rollback.
Note: the output ends with the eval infra failure rate for the incumbent and candidate (replays are clean-room and interleaved). A non-zero rate means the comparison was inconclusive, so suggest rerunning once the usage limit or network issue clears.

Note: if `evolve.candidates` in `.orchestra/config.json` is above 1, the cycle proposes several variants, screens them cheaply, and composes the survivors before the full evaluation. Mention which version was composed from which parents.
