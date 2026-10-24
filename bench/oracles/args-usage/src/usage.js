export function formatUsage({ name, description, options = [] }) {
  const lines = [`Usage: ${name} [options]`];
  if (description) lines.push(description);
  lines.push('', 'Options:');
  const w = Math.max(0, ...options.map((o) => o.flag.length + 2));
  for (const o of options) {
    const def = o.default === undefined ? '' : ` (default: ${o.default})`;
    lines.push(`  ${('--' + o.flag).padEnd(w)}  ${o.desc}${def}`);
  }
  return lines.join('\n');
}
