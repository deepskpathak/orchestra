# Making Orchestra LLM-agnostic (W8 plan)

Status: proposal. Extends W8.1 in `docs/research/closing-the-gaps.md`.

## TL;DR

- Orchestra does not call an LLM API. It drives an **agent runtime** (`claude -p`). The runtime supplies the tool loop, file edits, permission rules, the guard hook, the sandbox, JSON-schema output, budget caps and cost reporting.
- So "LLM-agnostic" really means **agent-runtime agnostic**, plus a model layer under it. Swapping a model name is the easy 10%.
- A seam exists (`ModelProvider` in `src/provider.ts`, tiers in `src/models.ts`), but it is thin and partly bypassed.
- Recommended path: clean up the seam with no behaviour change, move safety and cost controls into the orchestrator, then add a **native agent loop over an OpenAI-compatible API for read-only roles first** (planner, judge, librarian, evolver). That unlocks cross-family judges (the stated W4.1 driver) at the lowest risk. Workers on non-Claude runtimes come after.

## Key terms

- **Agent runtime:** the program that runs one agent session (tool loop + model). Today: Claude Code.
- **Provider:** who serves the model (Anthropic, OpenAI, Google, OpenRouter, Ollama, vLLM, LiteLLM).
- **Adapter:** Orchestra code that turns one `AgentRequest` into a session on some runtime and returns a normalized `AgentResult`.
- **Capability descriptor:** what an adapter can do natively (hooks, schema output, budget cap, cost report, sandbox, caching). Orchestra fills the gaps itself or refuses to run.

## Where Orchestra is coupled to Claude today

| # | Area | Coupling | Where |
|---|---|---|---|
| 1 | Session launch | `claude -p` flags: `--append-system-prompt`, `--json-schema`, `--max-budget-usd`, `--max-turns`, `--permission-mode`, `--setting-sources`, `--no-session-persistence`, `--permission-prompts none` | `src/agent.ts:96` |
| 2 | Event stream | Parses Claude `stream-json` (`assistant`/`tool_use`/`result`, multi-segment results after background tasks) | `src/agent.ts:202` onward, `src/exploration.ts` `countToolUse` |
| 3 | Tool vocabulary | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, `WebFetch` and patterns like `Bash(git push:*)` in role policies and defaults | `src/conductor.ts:804,1217-1219,1336-1338,1444-1446`, `src/store.ts:13-15`, `src/sandbox.ts:96` |
| 4 | Guard | Enforced as a Claude Code `PreToolUse` hook passed via `--settings`. `decide()` itself is pure and reusable | `src/agent.ts:86`, `src/guard.ts` |
| 5 | Cost and budget | Cost comes from `total_cost_usd`; budget enforced by `--max-budget-usd`. No price table (deliberately) | `src/agent.ts`, `src/models.ts` |
| 6 | Token semantics | `cacheReadShare` assumes Anthropic's split of input / cache-read / cache-write | `src/cost.ts`, `src/conductor.ts:677` |
| 7 | Model names | Literals `opus`/`sonnet`/`haiku` in defaults and configs | `harness/v1/config.json`, `scorer/config.json`, `src/store.ts:18` |
| 8 | Provider naming | Two `provider` keys (harness and project) and two vocabularies: `claude` in `provider.ts`, `anthropic` in `models.ts` | `src/types.ts:214,293`, `src/provider.ts:15`, `src/models.ts:9` |
| 9 | Bypassed seam | Only `Conductor.call` uses `ModelProvider`. `evolve`, `bench`, `scorer` and the CLI take a raw `Runner` | `src/conductor.ts:1911`, `src/evolve.ts`, `src/bench.ts`, `src/scorer.ts`, `src/cli.ts:107` |
| 10 | Sandbox | `claude` backend is Claude Code's own sandbox; the preflight probe shells out to `claude` | `src/sandbox.ts:12,330`, `src/cli.ts:166` |
| 11 | Container | Image must contain `claude`; `--network=none` blocks the model API | `src/container.ts:3,10` |
| 12 | Doctor | Preflight hard-codes `claude` and `haiku` | `src/agent.ts:315` |
| 13 | Metrics | Exploration stats read `toolCounts.Read/Grep/Glob` | `src/exploration.ts:82` |
| 14 | Prompts | Mostly neutral, but mention `Bash` and the atlas "through Bash" | `harness/v1/*.md` |
| 15 | Packaging | Claude Code plugin, skills, statusline, README "built on Claude Code" | `.claude-plugin/`, `skills/`, `README.md` |

Good news: the domain core (conductor state machine, git worktrees, merge queue, learnings, evolve statistics, guard rules, atlas) is already runtime-neutral.

## Design

### 1. Adapter contract

Keep `AgentRequest` / `AgentResult` as the single contract, but make every field neutral and add a capability descriptor:

```ts
interface AgentAdapter {
  id: string;                       // 'claude-code', 'native-openai', 'codex-cli', ...
  capabilities: AdapterCapabilities;
  run(req: AgentRequest): Promise<AgentResult>;
  preflight(): Promise<{ ok: boolean; detail: string }>;
}

interface AdapterCapabilities {
  toolGuard: 'hook' | 'inline' | 'none';     // how decide() is enforced
  structuredOutput: 'native' | 'prompted';    // schema enforced by runtime or by Orchestra
  budgetCap: boolean;                         // runtime stops at a $ cap
  turnCap: boolean;
  reportsCost: boolean;                       // else Orchestra prices tokens
  promptCache: 'explicit' | 'automatic' | 'none';
  sandboxes: ('srt' | 'docker' | 'native')[];
  writeTools: boolean;                        // can it act as a worker?
}
```

Rules:
- The conductor checks capabilities at run start and **refuses** unsafe combinations (for example `toolGuard: 'none'` without an OS sandbox in unattended mode).
- Anything a runtime cannot do natively, Orchestra does centrally (sections 3 to 5).

### 2. Neutral tool vocabulary

- Define capability names: `read`, `search` (grep + glob), `edit`, `write`, `shell`, `web`.
- Shell deny patterns become neutral data: `{ tool: 'shell', deny: ['git push', 'curl', 'wget'] }`.
- Each adapter maps them (Claude: `Read`, `Bash(git push:*)`; native loop: its own tool names).
- Events and `toolCounts` use neutral names, so `exploration.ts` and the dashboard work for any runtime.
- Back-compat: old Claude names in `.orchestra/config.json` are mapped on load.

### 3. Guard everywhere

- `guard.decide()` stays the single rule set.
- `hook` runtimes: inject it as today.
- `inline` runtimes (native loop): call `decide()` before executing every tool call. This is stronger than a hook.
- `none` runtimes: allowed only inside srt or docker, and the run record says so.

### 4. Cost, budget and tokens owned by Orchestra

- Add a **price table** per provider and model (input, output, cache read, cache write per million tokens), with a `source` URL and `checkedAt` date. Unknown price: cost is `null` and shown as "n/a", never guessed.
- `costUsd` = runtime figure when `reportsCost`, otherwise computed from tokens.
- Budget: when the runtime has no cap, the adapter tracks spend per turn and stops the session at the cap (SIGTERM for CLIs, loop exit for native).
- Local models (Ollama, vLLM) cost $0, so also support **token and turn caps** as first-class budgets.
- Normalize token semantics: OpenAI-style "cached tokens" are a subset of input; Anthropic's are separate. Adapters convert to one definition before `cacheReadShare`.

### 5. Structured output

- `native`: pass the schema through (Claude `--json-schema`, OpenAI-style `response_format`).
- `prompted`: append the schema to the prompt, then validate centrally.
- Always validate against the schema in Orchestra, with **one repair retry** ("your JSON failed: ..."). Today `extractJson` only regex-matches the last `{...}`.

### 6. Models, tiers and per-role providers

- One vocabulary: provider ids `anthropic`, `openai`, `google`, `openrouter`, `ollama`, `openai-compatible`; adapter ids separate.
- Model refs may be **provider-qualified**: `"judge": "openai:gpt-…"`, `"worker": "anthropic:balanced"`. Unqualified keeps today's meaning.
- Extend `CAPABILITIES` per provider: tier to model, context window, cache minimum, schema support, tool-calling support.
- Replace literal defaults (`haiku` in `judgeTiers.cheapModel`, `opus` in harness/scorer configs) with tiers.
- Merge the two `provider` keys: project config chooses the default; harness may override per role.
- Use `contextTokens` from the table for atlas budgets instead of assuming 200k.

### 7. Self-improvement validity (easy to miss)

- A harness score is only meaningful **for the model set it was measured on**. Today the ledger records `model` but not `provider` or adapter.
- Add `provider` and `adapter` to `LedgerRow`, `Run` and `ActiveAgent`.
- Fingerprint the resolved role-to-model map per run. `orchestra stats` and evolve compare only runs with the same fingerprint.
- Promotion is per fingerprint. A prompt evolved on one model family must re-earn promotion on another.
- The **scorer** (`scorer/config.json`) must stay frozen and pinned to an explicit provider and model, ideally a different family from the workers.
- The evolver must not rewrite prompts toward one runtime's tool names: keep tool names out of prompts (section 8).

### 8. Prompts

- Remove runtime-specific tool names from `harness/v1/*.md` ("run a shell command" instead of "with Bash").
- Each adapter appends a short **tool glossary** (its own tool names and usage tips) as a separate system block, outside the evolvable harness.
- Keep a single provider-neutral instruction set (W8.1 already says this).

### 9. Isolation, network and secrets

- srt and docker already wrap any command: generalize them to wrap any adapter command, not just `claude`.
- Keep the `claude` sandbox backend as a Claude-only option.
- Per-provider egress allowlist: the sandbox must reach the model endpoint and nothing else (fixes the `--network=none` note in `container.ts`).
- Docker image per adapter, or one image with all supported CLIs.
- Env scrubbing: pass through only the active provider's key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...); keep stripping push/publish credentials. Never log keys.

### 10. Reliability

- Normalize errors into: `transient` (429, overloaded, timeout), `auth`, `budget`, `context_overflow`, `refusal`, `bad_output`, `crash`.
- Central retry with backoff for `transient` only. `context_overflow` triggers a smaller atlas pack, not a blind retry.
- Per-provider concurrency limits (rate limits differ widely), separate from `concurrency`.

### 11. Testing

- **Adapter conformance suite**: every adapter must pass the same tests (result shape, tool events, schema output, guard deny, budget stop, timeout, error mapping).
- **Recorded fixtures**: captured stream output per runtime for parser tests (as `agent-runner.test.ts` does for Claude).
- Golden test that `buildArgs` for Claude is byte-identical before and after the refactor.
- `fake.ts` emits neutral events so dashboards are tested runtime-free.
- A small bench arm per adapter in `bench/arms.json` to measure quality, cost and time across runtimes.

### 12. Product surface

- `orchestra doctor` checks every adapter referenced by config (binary, auth, a tiny call).
- `orchestra init` asks which provider to use.
- README: "works with Claude Code by default; other runtimes supported". The Claude Code plugin, skills and statusline stay as one front end.

## Options for the second runtime

| Option | What it is | Pros | Cons |
|---|---|---|---|
| A. Claude Code via gateway | Point `ANTHROPIC_BASE_URL` at LiteLLM or similar | Near-zero code | Fidelity varies; still one runtime, so not true independence; cost reporting may be wrong |
| B. Native loop, OpenAI-compatible API | Orchestra's own small tool loop (read, search, shell, edit) | One adapter covers OpenAI, Gemini-compatible endpoints, OpenRouter, Ollama, vLLM; guard inline; full control of cost and budget | Must build and maintain tools; worker quality below mature coding agents |
| C. Another coding-agent CLI | Wrap a headless CLI (Codex CLI, Gemini CLI, OpenCode, Aider, ...) | Mature worker quality | Each has its own flags, events, hook support; verify headless JSON, hooks and schema support per tool in a spike |

**Recommendation:** B for read-only roles first, then C (or extend B) for workers.

- Read-only roles only need `read`, `search` and read-only `shell`. A native loop for them is small and safe.
- That alone delivers cross-family judge panels (W4.1) and an independent scorer.
- Workers are where runtime quality matters most; choose their runtime with bench data, not up front.

## Phased plan

| Phase | Goal | Main work | Size | Exit check |
|---|---|---|---|---|
| 0 | Decide | Spike B and one C candidate; confirm current CLI capabilities from their docs | S | Decision note in this file |
| 1 | Clean seam, no behaviour change | Move Claude code to `src/adapters/claude/`; route evolve, bench, scorer, CLI through the adapter; unify provider naming; neutral tool names and events; capability descriptor | M | All tests green; golden `buildArgs` unchanged |
| 2 | Orchestrator-owned controls | Price table; computed cost; budget, turn and token caps; schema validation + repair retry; error taxonomy and retries; `provider`/`adapter` in ledger and run; model-map fingerprint | M | Fake adapter without native cap/cost passes the conformance suite |
| 3 | Second adapter (read-only roles) | Native OpenAI-compatible loop with inline guard; per-role provider refs; doctor checks | M | Judge panel with two families runs end to end; bench arm recorded |
| 4 | Workers on other runtimes | Write tools in native loop or a CLI adapter; sandbox/docker generalization; egress allowlist; env pass-through | L | Bench: success rate within an agreed margin of Claude workers, or documented gap |
| 5 | Evolve and docs | Per-fingerprint promotion; prompt de-Claude-ing; config migration; docs and README | S | Evolve refuses cross-fingerprint comparisons; docs updated |

## Open decisions

1. **First non-Claude target:** OpenAI-compatible native loop (recommended), or a specific CLI?
2. **Mixed providers in one run:** allow from Phase 3 (needed for cross-family judges) or single provider per run first?
3. **Unknown prices:** block budgeted runs, or run with cost "n/a" and token caps only?
4. **Workers without a hook-capable runtime:** require srt/docker, or allow with a warning?

## Risks

- **Quality drop on other runtimes**, especially workers. Mitigation: bench arms per adapter before recommending.
- **Silent safety regression** if a runtime lacks hooks. Mitigation: capability check refuses unsafe runs.
- **Evolve overfitting** to one model family. Mitigation: per-fingerprint promotion.
- **Price table drift.** Mitigation: `source` and `checkedAt` per entry; `doctor` warns when older than 90 days.
- **Maintenance cost** of many CLI adapters. Mitigation: prefer one native loop over many wrappers.
