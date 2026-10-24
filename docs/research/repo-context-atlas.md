# Repo Context for Agents: Should Orchestra Add a Knowledge Graph or Agentic RAG?

**A companion to [Closing the Gaps](closing-the-gaps.md).** Describes Orchestra 0.6.1 (`package.json`). Written 2026-10-24. Reports no new experiments. Sources are tagged [V] opened and read, or [S] seen in search results or second-hand only. References continue the numbering of `closing-the-gaps.md` (from [92]).

## TL;DR

- **Yes, but not a vector DB and not an LLM-built knowledge graph.** Build a small, deterministic, commit-keyed **code map** ("Repo Atlas"): files, symbols, imports, references and tests as a graph, ranked per goal, with a token budget. Agents get a tiny map up front and **pull** more on demand through a query command (agentic retrieval over the graph).
- **Why it fits Orchestra specifically:** today every worker, every repair attempt and every judge re-explores the same commit from scratch. One shared index amortises that exploration across up to 2N to 6N agent sessions per run.
- **Expected effect (from outside evidence, unproven for Orchestra):** fewer turns and tokens (roughly 10% to 30%), a few points better localization and resolve rates on multi-file work. Generic repo overviews can make things *worse*, so injected context must be small and task-specific.
- **Where it goes on the roadmap:** a new workstream **W9 Repo context** (issue #56), built after M2 (it needs the bench to prove itself) and before W6.1, because W6.1's file footprints and W6.2's batching both need the same graph. Instrumentation can start now as part of W2.6.

## 1 The problem in Orchestra today

What agents get as repo context (as of 0.6.1):

| Role | Context today | Where |
|---|---|---|
| Planner | First 300 lines of `git ls-files` (alphabetical, truncated), plus Read/Grep/Glob | `plannerPrompt()` in `src/conductor.ts`, `trackedFiles()` in `src/git.ts` |
| Worker | No repo context at all. Goal, task, acceptance criteria, other task titles, lessons | `workerPrompt()` in `src/conductor.ts` |
| Judge | The diff, test output, scenarios, plus Read/Grep/Glob/Bash | `judgePrompt()` call in `src/conductor.ts` |

**Consequences**
- **Repeated exploration.** Each worker cold-starts: lists files, greps, reads. A repair attempt repeats it. The judge repeats it again. Same commit, same discoveries, paid for each time.
- **Weak planning signal on large repos.** "First 300 files" is arbitrary. On a big repo the planner sees `a*` to `c*` and must grep for the rest.
- **No shared notion of footprint.** Tasks have no declared files or symbols, so W6.1 (conflict-aware planning) has nothing to work with yet.
- **Lessons are retrieved by domain and role only** (`formatLearnings()` in `src/learnings.ts`), not by the code the task touches.

## 2 Key terms

- **RAG (retrieval-augmented generation):** fetch relevant text and put it in the prompt before the model answers.
- **Agentic RAG / agentic retrieval:** the model decides what to fetch, with tools, over several steps (grep, read, query), instead of one up-front retrieval.
- **Code knowledge graph:** nodes are directories, files, classes, functions; edges are contains, imports, calls/references, inherits, tests.
- **Repo map:** a compressed, ranked outline of a repo (paths plus signatures) that fits a token budget.
- **Context rot:** model accuracy drops as the prompt grows, even with irrelevant filler [100].

Visual analogy: today each worker walks into a new city with no map and asks for directions on every corner. A repo map is the tourist map at the station. The query tool is a local guide you can call. A vector database is a pile of photos of street corners you hope match where you are going.

## 3 What the evidence says

### 3.1 Structure-aware retrieval helps, modestly, and most on multi-file work

- **RepoGraph** (line-level def/ref graph, k-hop ego-graph retrieval) added about 2 to 2.7 points of SWE-bench Lite resolve rate across four frameworks (for example Agentless 27.33% to 29.67%, SWE-agent 18.33% to 20.33%). **Cost went up** in every case, by 5% to 30% (more tokens in the prompt) [92, V].
- **LocAgent** (heterogeneous graph: dir/file/class/function nodes; contain/import/invoke/inherit edges; BM25 over entity names) reached 94% file-level Acc@5 on SWE-bench Lite. Feeding its localization into Agentless raised Pass@10 from 33.6% to 37.6% (about 12% relative). Index build takes seconds. Ablations: entity search mattered most; **a tree-shaped output format beat JSON and DOT** for LLMs [93, V].
- **"Code Isn't Memory"** (SuperCoder, 2026) is the most relevant controlled study: same agent with and without a structural index (call graph plus BM25 plus embeddings), Claude Opus 4.7, three seeds, n of about 80 paired tasks, Go/Java/Python [94, V].
  - Resolve 41.9% to 50.4% (p = 0.003). Localization acc@5 44% to 85%.
  - Turns 36 to 28, tokens down about 9%, cost per solve $2.84 to $2.30.
  - Biggest gain on tasks touching 3 or more files. Versus a grep-only harness (OpenCode) the gains were **not significant**.
- **CodexGraph** lets the agent write graph-database queries over a code graph; competitive on SWE-bench and CrossCodeEval [95, V, abstract only].

### 3.2 Precision beats recall for anything you inject

- **CodeGrep** (RL-trained grep/glob/read retriever) handed a downstream agent a file list: resolve +1.2 points, 19% fewer tokens, 15% fewer rounds. **Low-precision retrieval (BM25) made the agent worse**; embeddings (Jina) were neutral; only the high-precision retriever cut cost [96, V].
- **Evaluating AGENTS.md** (ETH Zurich, ICLR 2026): LLM-generated repo context files **lowered** success (about 0.5 to 2 points) and **raised cost about 20% to 23%**. Developer-written files helped about 4 points but still raised cost. Repo overviews in particular were not useful. Recommendation: keep context files minimal [97, V].
- **Context rot** (Chroma, 18 models): performance falls with input length alone, and distractors make it worse [100, V].

**Implication:** a big static "here is the whole architecture" dump would likely cost more and help less. Inject a small, task-specific slice and let the agent pull the rest.

### 3.3 Agentic search versus indexes: industry is split, and hybrids win

- **Against indexes:** Claude Code ships Glob, Grep and LSP tools, no vector tool [107, S]. Cline does not index by design: indexes go stale, chunking breaks code, and embeddings are a second copy of sensitive code [101, V]. Sourcegraph Cody replaced embeddings with search [108, S]. Anthropic's Agent SDK guidance: start with agentic search; semantic search is faster but less accurate and harder to maintain [51].
- **For indexes:** Cursor reports semantic search raised answer accuracy about 12.5% on average and helped most on 1,000+ file repos, and that **grep plus semantic search together** gave the best outcomes [102, V].
- **Anthropic's context engineering guidance** favours just-in-time retrieval with lightweight identifiers (paths, queries), optionally a hybrid with a small amount loaded up front, plus sub-agents that return condensed summaries [99, V].
- **Repo maps:** Aider's map parses with tree-sitter, builds a file graph from shared symbols, ranks with personalised PageRank (files in play weigh more), and binary-searches to fit a default budget of 1,024 tokens [98, V, secondary description].

### 3.4 Off-the-shelf code-graph tools (self-reported, treat as claims)

- **codegraph** (tree-sitter, SQLite + FTS5, file watcher, one MCP tool): claims 62% fewer tokens, 88% fewer tool calls, 44% lower cost over 7 repos, one question per repo, 4 runs per arm. It also reports about 80% *more* retrieval context resident by session end [103, V].
- **code-review-graph** (tree-sitter, SQLite, blast-radius tools): claims 35x to 358x reduction versus the whole corpus, a baseline its author calls an upper bound no agent pays [104, V].
- Both need native parsers and npm or Python dependencies. That rules them out as core Orchestra components, though a user could plug one in as an MCP server.

### 3.5 Graph RAG and memory graphs

- **Microsoft GraphRAG** builds a graph with LLM extraction, which is expensive to index; LazyGraphRAG defers that work to query time to cut cost [105, S].
- **Zep/Graphiti** (temporal knowledge graph for agent memory) improved LongMemEval accuracy by up to 18.5% and cut latency about 90% versus baselines [106, V]. Relevant to Orchestra's *lessons*, not to code lookup.
- **Agentic RAG survey** frames the space (single-agent, multi-agent, graph-based agentic RAG) [109, S].

**Implication:** for *code*, structure is already in the source, so parse it; don't pay an LLM to extract it. LLM-built graphs fit unstructured memory (lessons, run history), and even there ACE's "context collapse" warning applies [45].

## 4 Options considered

| Option | Cheaper | Faster | More accurate | Zero-dep fit | Verdict |
|---|---|---|---|---|---|
| A. Status quo (agents grep) | No | No | Baseline | Yes | Keep as fallback |
| B. Bigger file list / static overview in prompt | Worse (+20% cost [97]) | No | No | Yes | **Reject** |
| C. Vector DB / embeddings | Mixed | Yes | Mixed [96][102][110] | No (model + store) | **Reject for core** |
| D. LLM-built knowledge graph (GraphRAG style) | No (indexing cost) | Mixed | Unproven for code | No | **Reject for code** |
| E. Deterministic code graph + ranked map + pull tool | Likely [94][96] | Yes [94] | Likely, esp. multi-file [93][94] | **Yes** (regex parse, optional `ctags`) | **Recommend** |
| F. External MCP code graph (codegraph, Serena) | Claimed | Claimed | Claimed | Optional only | Allow as user opt-in |
| G. Evidence-linked lesson graph (lessons ↔ files ↔ runs) | Some | Some | Plausible [106] | Yes (JSON) | **Later**, after W3.7 |

**Recommendation: E now (after M2), G later, F as documented opt-in.**

## 5 Proposed design: Repo Atlas (W9)

### 5.1 Four layers, each opt-in and separately ablatable

| Layer | What | Who gets it | Budget |
|---|---|---|---|
| **L0 Map** | Ranked, tree-format outline: paths, exported symbols and signatures, seeded by goal terms (personalised PageRank) | Planner prefix (replaces "first 300 files"); worker prefix (goal-level map, same for all workers in a run) | ~1,024 tokens default |
| **L1 Task pack** | For each task's declared footprint: signatures, 1-hop callers/importers, related tests, files changed on integration since run start | Worker body (task-specific, not cached) | ~1,500 tokens |
| **L2 Query tool** | `orchestra atlas find|neighbors|impact|tests` via Bash, tree-format output, staleness-marked | Workers and judge, pulled on demand | Per call cap |
| **L3 Lesson graph** (later) | Lessons linked to files/symbols and runs, with evidence and timestamps; retrieve by touched code | Planner and worker lesson sections | Uses existing `RETRIEVAL_BUDGET` |

### 5.2 Building the graph without dependencies

- **New module** `src/atlas.ts` (plus `test/atlas.test.ts`). Pure TypeScript, `node:fs`, `node:child_process` for git.
- **Nodes:** dir, file, symbol (function, class, method, type, exported const). **Edges:** contains, imports, references (name match, scoped by imports), tests (test file imports or names a source file).
- **Extractors:** small regex extractors for TS/JS, Python, Go, Java, Rust; file-level fallback for others. If `universal-ctags` is on PATH, shell out for better symbols (same detect-and-degrade pattern as `srt` in W5.1). No npm package.
- **Keyed by commit SHA**, stored at `.orchestra/atlas/<sha>.json`. Incremental rebuild from the nearest cached SHA using `git diff --name-only`. Build once per run at the integration base, so every worktree shares it.
- **Staleness:** worktrees diverge from the indexed SHA. L2 output marks any file in `git status` of the calling worktree as "modified since index, read the file".

### 5.3 Prompt placement (keeps the cache warm)

- Workers share a byte-identical prefix today (`BuiltPrompt.prefix`). The **L0 map goes in that prefix**, built from the run-start commit, so it stays identical across workers even as integration advances.
- **Anything that changes per task or per merge goes in the body:** the L1 pack and a "changed on integration since run start" list. This follows W6.4 cache discipline [78].
- Planner output schema (`PLAN_SCHEMA`) gains an optional `footprint: { files: string[]; symbols?: string[] }` per task. This is the **same field W6.1 needs**, so W9 and W6.1 share one data structure.

### 5.4 Integrity and safety (non-negotiable)

- **Exclusions:** the atlas never indexes `.orchestra/` (holdout, scenarios, evals, archive), `.env*` or the guard's secret patterns. Reuse the lists in `src/guard.ts` rather than duplicating them. Regression test: a holdout file never appears in any atlas output.
- **P1 frozen scorer:** atlas code and exclusions are outside `EVOLVABLE_FILES`. The evolver may edit how `tools.md` describes the query tool, but cannot change what is indexed. The frozen scorer (W1.1) never consumes atlas output.
- **P2:** impact analysis is advisory. It can add a repair note ("callers of `foo` not updated") but never gates a merge on its own.
- **Clean-room evals (W1.5):** eval replays rebuild the atlas from the case's base commit and run with **L3 off**, so lessons and memory cannot leak solutions across trials.
- **Judge independence:** the judge does not get the worker's L1 pack by default (fresh-context review [52]). It may call L2.
- **Off by default:** `context.atlas: { enabled: false, mapTokens: 1024, packs: false, tool: false }` in `DEFAULT_PROJECT_CONFIG` (`src/store.ts`).

### 5.5 Cheaper, faster, more accurate: where each gain comes from

- **Cheaper:** fewer exploratory turns per worker, repair and judge; a stable map in the cached prefix; footprints that let W6.1 avoid conflicts (conflicts cost whole repair cycles).
- **Faster:** fewer turns per session (about 22% in [94]); fewer merge conflicts; footprint-disjoint batches for W6.2.
- **More accurate:** better localization on multi-file tasks [93][94]; callers and tests surfaced before editing; lessons retrieved by the code being touched (L3).

## 6 How we will know it works (ties to M2)

**Instrument first (can ship inside W2.6, no behaviour change):**
- Per role: turns, input and cache tokens, cost (already in the ledger), and exploration share (Read/Grep/Glob calls) if the stream output exposes tool-use counts. Check `src/agent.ts` stream parsing before promising this; otherwise use turns.
- **Footprint accuracy:** precision and recall of planned footprint versus files actually changed (free from git).

**Ablation arms on `orchestra bench` (W2.4), paired, 3 repeats:** off; L0; L0+L1; L0+L1+L2. Report cost next to success.

**Hypotheses**
- **H6 (cost):** L0+L1 cuts worker tokens per accepted merge by at least 15%, with success non-inferior within 2 points.
- **H7 (localization):** planner footprint recall of at least 80% at file level with the atlas, versus a no-atlas planner.
- **H8 (no harm):** with the atlas on, the injected-context arm does not raise cost the way generic context files did [97]. If it does, cut `mapTokens` before anything else.

Effect sizes from outside work (a few points of success, 10% to 30% of tokens) need on the order of 100+ paired cases to confirm (see section 7 of `closing-the-gaps.md`). Smaller results get reported as unproven.

## 7 Sequencing on the roadmap

Tracked on GitHub as **#56 W9 Repo context** (a sub-issue of M6, #17).

| Phase | Issue | Items | When | Depends on |
|---|---|---|---|---|
| W9.0 Instrument | #57 (M2) | Exploration and footprint metrics | Inside M2 (W2.6, #29) | Nothing |
| W9.1 Atlas core + L0 map | #58 | `src/atlas.ts`, `orchestra atlas build` and `stats`, planner map | After M2 bench exists | #24, #25, #57 |
| W9.2 Footprints + L1 packs | #59 | `footprint` in plan schema, worker packs | With or just before W6.1 (#47) | #58 |
| W9.3 L2 query tool + impact | #60 | `orchestra atlas find`, `neighbors`, `impact`, `tests`; `tools.md` guidance | After W9.2 shows a gain | #59 |
| W9.4 L3 lesson graph | #61 | Evidence-linked lessons by file/symbol | After W3.7 lesson hygiene | #36, #23 |
| W9.5 External inputs | #62 | `ctags`, graphify `graph.json`, MCP opt-in docs (codegraph, Serena) | After W9.1 | #58 |

**Why not earlier:** M1 Integrity is still first. Adding context tooling before the bench means any gain is unmeasurable, and the plan's rule is to optimise only what M2 shows is slow or costly.

## 8 Risks and open questions

- **Regex extraction misses things** (dynamic imports, decorators, generated code). Mitigation: file-level fallback, optional `ctags`, and agents can always grep.
- **Injected context can hurt** [97][100]. Mitigation: small budgets, task-specific packs, ablate every layer.
- **Index staleness inside worktrees.** Mitigation: SHA keys, staleness marks, incremental rebuild.
- **Leakage into evals** via L3. Mitigation: L3 off in clean-room trials; W3.2 leakage audit covers lessons.
- **Evidence quality.** The strongest study [94] is one model, n of about 80, and its cross-harness gains were not significant. Tool benchmarks [103][104] are self-reported. No study covers TypeScript-heavy repos well.

## 9 Roadmap housekeeping

- The plan is tracked as GitHub issues: milestone parents M1 to M6 (#12 to #17), workstream items W0.1 to W8.1 (#18 to #55), and W9 (#56 to #62).
- The Roadmap board view (project 3, view 4) showed items only up to #45 when checked; #46 to #62 may need adding to the board.

## 10 References (continuing from `closing-the-gaps.md`)

92. Ouyang et al., *RepoGraph: Enhancing AI Software Engineering with Repository-level Code Graph*, ICLR 2025. https://arxiv.org/abs/2410.14684 [V]
93. Chen et al., *LocAgent: Graph-Guided LLM Agents for Code Localization*, ACL 2025. https://arxiv.org/abs/2503.09089 [V]
94. SuperAGI Research, *Code Isn't Memory: A Structural Codebase Index Inside a Coding Agent*, 2026. https://arxiv.org/abs/2606.22417 [V]
95. Liu et al., *CodexGraph: Bridging LLMs and Code Repositories via Code Graph Databases*, NAACL 2025. https://arxiv.org/abs/2408.03910 [V, abstract]
96. *CodeGrep: An RL-Trained Retrieval Agent for LLM Coding Agents*, 2026. https://arxiv.org/abs/2608.05886 [V, partial]
97. Gloaguen et al., *Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?*, ICLR 2026. https://arxiv.org/abs/2602.11988 [V]
98. Agent Patterns, *Repository Map Pattern: AST + PageRank for Dynamic Code Context* (describes Aider's repo map). https://www.agentpatterns.ai/context-engineering/repository-map-pattern/ [V, secondary]
99. Anthropic, *Effective context engineering for AI agents*. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents [V]
100. Chroma Research, *Context Rot*. https://trychroma.com/research/context-rot [V]
101. Cline, *Why Cline doesn't index your codebase*. https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing [V]
102. Cursor, *Improving agent with semantic search*. https://cursor.com/blog/semsearch [V]
103. codegraph (colbymchenry). https://github.com/colbymchenry/codegraph [V, self-reported benchmarks]
104. code-review-graph (tirth8205). https://github.com/tirth8205/code-review-graph [V, self-reported benchmarks]
105. Microsoft Research, *LazyGraphRAG: Setting a new standard for quality and cost*. https://www.microsoft.com/en-us/research/blog/lazygraphrag/ [S]
106. Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*, 2025. https://arxiv.org/abs/2501.13956 [V, abstract]
107. Claude Code docs, *Tools reference*. https://code.claude.com/docs/en/tools-reference [S]
108. Sourcegraph, *Cody FAQ* (embeddings replaced by search). https://sourcegraph.com/docs/cody/faq [S]
109. Singh et al., *Agentic Retrieval-Augmented Generation: A Survey on Agentic RAG*, 2025. https://arxiv.org/abs/2501.09136 [S]
110. *CORE-Bench: A Comprehensive Benchmark for Code Retrieval in the Era of Agentic Coding*, EMNLP 2026. https://aclanthology.org/2026.emnlp-main.1604/ [V, abstract]
111. Serena (oraios), LSP-based semantic retrieval and editing MCP toolkit. https://github.com/oraios/serena [S]

## 11 Addendum (2026-10-24): build or reuse?

**Decision: build a thin core inside Orchestra, borrow designs, and accept external graphs as optional input.** Don't add a graph DB or a graph library.

| Tool | What it is | Fit for Orchestra |
|---|---|---|
| **graphify** (Graphify-Labs, MIT/Apache-2.0) [112, V] | Python, tree-sitter for about 40 languages, deterministic offline code extraction, optional LLM pass for docs, incremental `--update`, outputs `graph.json`, optional MCP server | **Optional input adapter**: read its `graph.json` when present. Not a dependency (Python runtime) |
| **context-compiler** (Emmimal, MIT) [113, V] | Pure-stdlib Python, three passes: import/symbol resolution up to 2 hops, skeletonise reachable files to signatures, assemble a budgeted prompt. Reports 69% to 74% prompt reduction on small repos | **Borrow the algorithm** for L1 task packs. Python-only, 10 commits, too young to depend on |
| **codegraph**, **code-review-graph** [103][104] | tree-sitter plus SQLite, MCP tools, blast radius | User opt-in MCP servers, documented, never required |
| **Aider repo map** [98] | tree-sitter tags plus personalised PageRank under a token budget | **Borrow the ranking** for L0 |
| **LocAgent** [93] | Graph schema and three tools (search entity, traverse graph, retrieve entity), tree-format output | **Borrow the schema and tool shape** for L2 |
| Graph DBs (Neo4j, FalkorDB) and graph libraries | Servers or npm packages | **Not needed.** Repo graphs are small; BFS and PageRank are short pure functions |

**Storage:** start with JSON keyed by commit SHA in `.orchestra/atlas/`. Built-in `node:sqlite` (no npm dependency) includes FTS5 (checked in Node 22 on the linked machine) but is still flagged experimental before Node 25.7 and prints an `ExperimentalWarning` [114, V]. Revisit if JSON load time becomes a problem on large repos.

**Parsing:** regex extractors in TypeScript; use `universal-ctags` when found on PATH; ingest graphify's `graph.json` when found. All three feed the same node and edge types.

112. Graphify Labs, *graphify*. https://github.com/Graphify-Labs/graphify [V]
113. Alexander, *context-compiler*, and *Coding agents don't need bigger context windows, they need a context compiler* (Towards Data Science). https://github.com/Emmimal/context-compiler/ [V]
114. Node.js docs, *SQLite* (`node:sqlite`, v25.9.0). https://nodejs.org/api/sqlite.html [V]
