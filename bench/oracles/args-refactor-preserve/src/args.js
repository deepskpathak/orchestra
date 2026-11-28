export function tokenize(argv) {
  return argv.map((a) => {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      return eq === -1 ? { kind: 'long', name: a.slice(2) } : { kind: 'long', name: a.slice(2, eq), value: a.slice(eq + 1) };
    }
    if (a.startsWith('-') && a.length > 1) return { kind: 'short', name: a.slice(1) };
    return { kind: 'positional', value: a };
  });
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const t of tokenize(argv)) {
    if (t.kind === 'positional') positional.push(t.value);
    else flags[t.name] = t.kind === 'long' && t.value !== undefined ? t.value : true;
  }
  return { flags, positional };
}
