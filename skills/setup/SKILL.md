---
name: setup
description: Set up Orchestra in this repo and optionally wire the live Orchestra statusline into Claude Code.
disable-model-invocation: true
allowed-tools: Bash(orchestra *) Read
---

1. Run `orchestra init` and show the result. If no test command was detected, ask the user for one and write it to `testCommand` in `.orchestra/config.json`.
2. Run `orchestra doctor` and report whether headless Claude auth works. If not, tell the user to run `claude` in a terminal and `/login`.
3. Offer the statusline. It must be configured in the user's own settings (plugins cannot ship one). Show this snippet for `~/.claude/settings.json` and ask before editing that file:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "${CLAUDE_PLUGIN_ROOT}/bin/orchestra statusline",
       "refreshInterval": 2
     }
   }
   ```

   Write the absolute path that `${CLAUDE_PLUGIN_ROOT}` resolves to above, not the variable. If the user already has a statusLine, do not overwrite it; explain how to combine them instead.
4. Tell the user the three ways to watch: `orchestra watch` (full-screen live dashboard in any terminal), the statusline, and `/orchestra:status` in chat.
