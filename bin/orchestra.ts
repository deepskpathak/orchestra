#!/usr/bin/env node
// Entry point. Node >= 23.6 runs TypeScript directly (type stripping), so there is no build step.
import { main } from '../src/cli.ts';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`orchestra: ${err?.stack ?? err}\n`);
  process.exit(1);
});
