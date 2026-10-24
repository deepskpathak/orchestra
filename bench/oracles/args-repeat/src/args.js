function setFlag(flags, name, value) {
  if (!(name in flags)) flags[name] = value;
  else if (Array.isArray(flags[name])) flags[name].push(value);
  else flags[name] = [flags[name], value];
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) setFlag(flags, a.slice(2), true);
      else setFlag(flags, a.slice(2, eq), a.slice(eq + 1));
    } else if (a.startsWith('-') && a.length > 1) {
      setFlag(flags, a.slice(1), true);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}
