// W4.5 Mutation score. Pure mutant generation and score math, plus a runner whose IO is injected.

export interface Mutant {
  file: string;
  line: number;
  op: string; // e.g. "=== -> !=="
  source: string; // full mutated source, differs from the original by exactly one operator
}

export interface MutantResult {
  file: string;
  line: number;
  op: string;
  killed: boolean;
}

export interface MutationScore {
  total: number;
  killed: number;
  survived: number;
  score: number;
  floor: number;
  pass: boolean;
}

const SWAPS: Record<string, string> = { '===': '!==', '!==': '===', '<=': '<', '>=': '>', '&&': '||', '||': '&&', true: 'false', false: 'true' };
const IDENT = /[A-Za-z0-9_$]/;

interface Site {
  at: number;
  from: string;
  to: string;
}

// Finds operator sites outside comments and string literals, in source order.
function sites(src: string): Site[] {
  const out: Site[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (three === '===' || three === '!==') {
      out.push({ at: i, from: three, to: SWAPS[three] });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push({ at: i, from: two, to: SWAPS[two] });
      i += 2;
      continue;
    }
    if (two === '<=' || two === '>=') {
      out.push({ at: i, from: two, to: SWAPS[two] });
      i += 2;
      continue;
    }
    if (c === '<' && d !== '<') out.push({ at: i, from: '<', to: '<=' });
    else if (c === '>' && d !== '>' && src[i - 1] !== '=' && src[i - 1] !== '-' && src[i - 1] !== '>') out.push({ at: i, from: '>', to: '>=' });
    else if (c === '+' && d !== '+' && d !== '=' && src[i - 1] !== '+') out.push({ at: i, from: '+', to: '-' });
    else if (c === '-' && d !== '-' && d !== '=' && d !== '>' && src[i - 1] !== '-') out.push({ at: i, from: '-', to: '+' });
    else if (IDENT.test(c) && !IDENT.test(src[i - 1] ?? ' ')) {
      let j = i;
      while (j < n && IDENT.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'true' || word === 'false') out.push({ at: i, from: word, to: SWAPS[word] });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

// Deterministic: mutants come in source order; past `max` they are thinned at even strides so the
// whole file stays represented.
export function generateMutants(source: string, file: string, max: number): Mutant[] {
  if (max <= 0) return [];
  let all = sites(source);
  if (all.length > max) all = Array.from({ length: max }, (_, k) => all[Math.floor((k * all.length) / max)]);
  return all.map((s) => ({
    file,
    line: source.slice(0, s.at).split('\n').length,
    op: `${s.from} -> ${s.to}`,
    source: source.slice(0, s.at) + s.to + source.slice(s.at + s.from.length),
  }));
}

// No mutants is vacuously fine: score 1, passes, so an empty change never fails a run.
export function mutationScore(results: { killed: boolean }[], floor: number): MutationScore {
  const total = results.length;
  const killed = results.filter((r) => r.killed).length;
  const score = total === 0 ? 1 : killed / total;
  return { total, killed, survived: total - killed, score: Math.round(score * 1000) / 1000, floor, pass: score >= floor };
}

export interface MutationDeps {
  files: string[]; // source files changed by the run
  max: number;
  commands: string[]; // test command plus scenario checks; a mutant is killed when any fails
  read: (file: string) => string;
  write: (file: string, content: string) => void;
  exec: (command: string) => { ok: boolean };
}

export interface MutationRun {
  results: MutantResult[];
  skipped?: string;
  unreadable?: string[]; // files that could not be read (for example deleted); only they are left out
}

const failsAny = (deps: MutationDeps): boolean => {
  for (const cmd of deps.commands) {
    try {
      if (!deps.exec(cmd).ok) return true;
    } catch {
      return true; // an exec that throws counts as a failing check
    }
  }
  return false;
};

export function runMutation(deps: MutationDeps): MutationRun {
  if (deps.commands.length === 0) return { results: [], skipped: 'no test command or scenario checks to kill mutants with' };
  if (failsAny(deps)) return { results: [], skipped: 'checks already fail without mutation' };
  const results: MutantResult[] = [];
  const unreadable: string[] = [];
  let budget = deps.max;
  for (const file of deps.files) {
    if (budget <= 0) break;
    let original: string;
    try {
      original = deps.read(file);
    } catch {
      unreadable.push(file); // one bad file must not disable the whole gate
      continue;
    }
    for (const m of generateMutants(original, file, budget)) {
      let killed: boolean;
      try {
        deps.write(file, m.source);
        killed = failsAny(deps);
      } finally {
        deps.write(file, original);
      }
      results.push({ file, line: m.line, op: m.op, killed });
    }
    budget = deps.max - results.length;
  }
  return unreadable.length ? { results, unreadable } : { results };
}
