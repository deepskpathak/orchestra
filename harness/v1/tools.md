If your prompt mentions `orchestra atlas`, a code graph of the repo is available through Bash (L2):

- `orchestra atlas find <symbol-or-path>`: where a symbol or file lives.
- `orchestra atlas neighbors <file>`: what the file imports and what imports it.
- `orchestra atlas impact <file-or-symbol>`: callers and importers that a change could affect, plus related tests.
- `orchestra atlas tests <file>`: test files that import the file.

Use it before editing a shared file to find callers, and before finishing to find the tests to run. Output is a capped tree; a line marked `(stale: read the file)` changed in your worktree, so read the file instead of trusting the graph. Impact notes such as "callers not updated" are advisory hints, not requirements.
