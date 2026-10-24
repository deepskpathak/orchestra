export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest) {
      positional.push(a);
    } else if (a === '--') {
      rest = true;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}
