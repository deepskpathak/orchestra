---
name: stats
description: Show Orchestra factory health per harness version (first-pass yield, satisfaction, cost per merged task, eval scores) and what the factory has learned.
allowed-tools: Bash(orchestra *)
---

Run `orchestra stats --plain` and `orchestra learnings`. Show the stats table verbatim in a code block. Then summarise in up to four bullets: is the factory improving (trend across versions), current harness and why it was promoted, top learnings, and the weakest metric to watch.
