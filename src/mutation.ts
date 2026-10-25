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
  invalid?: boolean; // the mutant did not parse or compile; says nothing about the tests, so it is not scored
}

export interface MutationScore {
  total: number;
  killed: number;
  survived: number;
  invalid?: number; // mutants excluded from total because they did not compile (present only when > 0)
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

// The scanner is a heuristic, not a parser. When unsure it skips a site (a missed mutant only lowers
// coverage); a mutant that still does not compile is classified invalid by the runner and left out of the score.
const GENERIC_CHAR = /[\w$.,[\] |&?:{}'"()=*-]/;
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);

// Index just past the `>` closing a generic argument list opened at `at`, or -1 when it does not look like one
// (a comparison such as `i<n; i++` has no type-like run ending in a matching `>`).
function genericEnd(src: string, at: number): number {
  let depth = 0;
  for (let j = at; j < src.length && j - at <= 200; j++) {
    const ch = src[j];
    if (ch === '=' && src[j + 1] === '>') {
      j++;
      continue;
    }
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0) return j + 1;
    } else if (!GENERIC_CHAR.test(ch) || (ch === '&' && src[j + 1] === '&') || (ch === '|' && src[j + 1] === '|')) return -1;
  }
  return -1;
}

// Index just past the JSX opening or closing tag starting at `at`, or -1.
function jsxTagEnd(src: string, at: number): number {
  let braces = 0;
  for (let j = at + 1; j < src.length && j - at <= 2000; j++) {
    const ch = src[j];
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (braces === 0 && (ch === '"' || ch === "'")) {
      const close = src.indexOf(ch, j + 1);
      if (close < 0 || src.slice(j, close).includes('\n')) return -1;
      j = close;
    } else if (braces === 0 && ch === '>') return j + 1;
    else if (ch === ';' && braces === 0) return -1;
  }
  return -1;
}

// Index just past a string or template literal opened at `at`. Quotes end at a bare newline so a stray
// apostrophe cannot swallow the rest of the file; templates skip `${...}` (nested strings included).
function skipQuoted(src: string, at: number): number {
  const q = src[at];
  const n = src.length;
  let i = at + 1;
  while (i < n && src[i] !== q) {
    if (src[i] === '\\') i++;
    else if (q !== '`' && src[i] === '\n') return i;
    else if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '"' || ch === "'" || ch === '`') {
          i = skipQuoted(src, i);
          continue;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return i + 1;
}

// A `/` starts a regex literal when the previous token cannot end an expression. Returns the index past
// the literal and its flags, or -1 (division) when no closing slash is found on the line.
function skipRegex(src: string, at: number): number {
  let p = at - 1;
  while (p >= 0 && /\s/.test(src[p])) p--;
  if (p >= 0) {
    if (IDENT.test(src[p])) {
      let q = p;
      while (q >= 0 && IDENT.test(src[q])) q--;
      if (!REGEX_KEYWORDS.has(src.slice(q + 1, p + 1))) return -1;
    } else if (!/[(,=:[!&|?{;+\-*%<>~^]/.test(src[p])) return -1;
  }
  let inClass = false;
  for (let j = at + 1; j < src.length && src[j] !== '\n'; j++) {
    const ch = src[j];
    if (ch === '\\') j++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let k = j + 1;
      while (k < src.length && /[a-z]/.test(src[k])) k++;
      return k;
    }
  }
  return -1;
}

// Finds operator sites outside comments, strings, regex literals, generics, shifts and JSX tags, in source order.
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
    if (c === '/') {
      const end = skipRegex(src, i);
      i = end < 0 ? i + 1 : end;
      continue;
    }
    // An apostrophe right after a word character is prose (JSX text, a comment fragment), never a string opener.
    if (c === '"' || c === '`' || (c === "'" && !IDENT.test(src[i - 1] ?? ' '))) {
      i = skipQuoted(src, i);
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
    if (two === '<<' || two === '>>') {
      // Shifts (and `<<=`, `>>>`) are not comparisons; also keeps the second angle from being read alone.
      i += 2;
      while (src[i] === '>' || src[i] === '<' || src[i] === '=') i++;
      continue;
    }
    if (c === '<') {
      const prev = src[i - 1] ?? ' ';
      if (d === '/') {
        // JSX closing tag; text before it ends in a word character, so this is checked before generics.
        const end = jsxTagEnd(src, i);
        i = end > 0 ? end : i + 1;
        continue;
      }
      if (IDENT.test(prev)) {
        // `Promise<void>`, `Map<string, number>`: skip the whole argument list; else it is a comparison.
        const end = genericEnd(src, i);
        if (end > 0) {
          i = end;
          continue;
        }
        out.push({ at: i, from: '<', to: '<=' });
      } else if (/[A-Za-z_$/>]/.test(d ?? ' ')) {
        // Type assertion, generic arrow `<T>(x) =>` or a JSX tag: not a comparison.
        const end = jsxTagEnd(src, i);
        i = end > 0 ? end : i + 1;
        continue;
      } else out.push({ at: i, from: '<', to: '<=' });
    } else if (c === '>' && d !== '>' && src[i - 1] !== '=' && src[i - 1] !== '-' && src[i - 1] !== '>' && src[i - 1] !== '/') out.push({ at: i, from: '>', to: '>=' });
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

// One plain-text line for a run's mutation result, shared by the CLI and the TUI.
export function mutationLine(m: { total: number; killed: number; floor: number; score?: number; pass?: boolean; skipped?: string }): string {
  if (m.skipped || m.score === undefined) return `skipped (${m.skipped ?? 'no score'})`;
  return `${m.score.toFixed(2)} (${m.killed}/${m.total} killed, floor ${m.floor}, ${m.pass ? 'pass' : 'below floor'})`;
}

// No mutants is vacuously fine: score 1, passes, so an empty change never fails a run. Invalid mutants
// (syntax or compile errors) are excluded, so a mutant that merely broke the build never counts as killed.
export function mutationScore(results: { killed: boolean; invalid?: boolean }[], floor: number): MutationScore {
  const valid = results.filter((r) => !r.invalid);
  const invalid = results.length - valid.length;
  const total = valid.length;
  const killed = valid.filter((r) => r.killed).length;
  const score = total === 0 ? 1 : killed / total;
  return { total, killed, survived: total - killed, ...(invalid ? { invalid } : {}), score: Math.round(score * 1000) / 1000, floor, pass: score >= floor };
}

export interface MutationDeps {
  files: string[]; // source files changed by the run
  max: number;
  commands: string[]; // test command plus scenario checks; a mutant is killed when any fails
  read: (file: string) => string;
  write: (file: string, content: string) => void;
  // May be asynchronous. `timeoutMs` is set for mutant runs (a timeout reports ok: false, which counts as killed)
  // and undefined for the baseline run, which keeps the executor's own, longer default.
  exec: (command: string, timeoutMs?: number) => { ok: boolean; tail?: string } | Promise<{ ok: boolean; tail?: string }>;
  mutantTimeoutMs?: number;
}

export interface MutationRun {
  results: MutantResult[];
  skipped?: string;
  unreadable?: string[]; // files that could not be read (for example deleted); only they are left out
}

// A failing run whose output is a parse or compile error says the mutant is broken, not that a test caught it.
const COMPILE_ERROR = /SyntaxError|ERR_INVALID_TYPESCRIPT_SYNTAX|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|error TS\d+|Transform failed|ParseError|Parsing error|Unexpected token|Unexpected identifier|Unterminated|Invalid or unexpected token/;
export const isCompileError = (tail: string | undefined): boolean => COMPILE_ERROR.test(tail ?? '');

const failsAny = async (deps: MutationDeps, timeoutMs?: number): Promise<{ failed: boolean; invalid: boolean }> => {
  for (const cmd of deps.commands) {
    try {
      const r = await deps.exec(cmd, timeoutMs);
      if (!r.ok) return { failed: true, invalid: isCompileError(r.tail) };
    } catch {
      return { failed: true, invalid: false }; // an exec that throws counts as a failing check
    }
  }
  return { failed: false, invalid: false };
};

export async function runMutation(deps: MutationDeps): Promise<MutationRun> {
  if (deps.commands.length === 0) return { results: [], skipped: 'no test command or scenario checks to kill mutants with' };
  if ((await failsAny(deps)).failed) return { results: [], skipped: 'checks already fail without mutation' };
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
      let outcome: { failed: boolean; invalid: boolean };
      try {
        deps.write(file, m.source);
        outcome = await failsAny(deps, deps.mutantTimeoutMs);
      } finally {
        deps.write(file, original);
      }
      results.push({ file, line: m.line, op: m.op, killed: outcome.failed && !outcome.invalid, ...(outcome.invalid ? { invalid: true } : {}) });
    }
    budget = deps.max - results.length;
  }
  return unreadable.length ? { results, unreadable } : { results };
}
