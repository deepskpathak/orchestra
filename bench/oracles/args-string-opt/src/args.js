export function parseArgs(argv, opts = {}) {
  const flags = {};
  const positional = [];
  const strings = new Set(opts.string ?? []);
  const value = (name, i) => {
    if (i + 1 >= argv.length) throw new Error(`option ${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1 && strings.has(a.slice(2))) flags[a.slice(2)] = value(a, i++);
      else if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('-') && a.length > 1) {
      if (strings.has(a.slice(1))) flags[a.slice(1)] = value(a, i++);
      else flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}
