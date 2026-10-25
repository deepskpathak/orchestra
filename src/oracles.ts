// Independent oracle primitives (W4.4): pure functions, no IO beyond injected functions.
// The conductor wires these up later; nothing here touches git, the filesystem or an agent.

// ---- seeded PRNG and generators ----

export type Rng = () => number; // uniform in [0, 1)

// mulberry32: small, fast, deterministic for a given 32-bit seed.
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Gen<T> {
  generate(rng: Rng): T;
  shrink(value: T): T[]; // simpler candidates, simplest first
}

export function intGen(min = -100, max = 100): Gen<number> {
  return {
    generate: (rng) => min + Math.floor(rng() * (max - min + 1)),
    shrink: (n) => {
      const target = min <= 0 && max >= 0 ? 0 : min;
      const out: number[] = [];
      if (n === target) return out;
      out.push(target);
      let delta = Math.trunc((n - target) / 2);
      while (delta !== 0) {
        out.push(n - delta);
        delta = Math.trunc(delta / 2);
      }
      const step = n > target ? n - 1 : n + 1;
      if (!out.includes(step)) out.push(step);
      return out;
    },
  };
}

export function stringGen(maxLen = 12, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 '): Gen<string> {
  return {
    generate: (rng) => {
      const len = Math.floor(rng() * (maxLen + 1));
      let s = '';
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
      return s;
    },
    shrink: (s) => (s.length === 0 ? [] : ['', s.slice(0, Math.floor(s.length / 2)), s.slice(1), s.slice(0, -1)].filter((c, i, a) => c.length < s.length && a.indexOf(c) === i)),
  };
}

export function arrayGen<T>(item: Gen<T>, maxLen = 8): Gen<T[]> {
  return {
    generate: (rng) => {
      const len = Math.floor(rng() * (maxLen + 1));
      return Array.from({ length: len }, () => item.generate(rng));
    },
    shrink: (arr) => {
      const out: T[][] = [];
      if (arr.length === 0) return out;
      out.push([]);
      if (arr.length > 1) out.push(arr.slice(0, Math.floor(arr.length / 2)));
      for (let i = 0; i < arr.length; i++) out.push([...arr.slice(0, i), ...arr.slice(i + 1)]);
      for (let i = 0; i < arr.length; i++) {
        for (const s of item.shrink(arr[i]!)) out.push([...arr.slice(0, i), s, ...arr.slice(i + 1)]);
      }
      return out;
    },
  };
}

export function oneOfGen<T>(values: T[]): Gen<T> {
  if (values.length === 0) throw new Error('oneOfGen needs at least one value');
  return {
    generate: (rng) => values[Math.floor(rng() * values.length)]!,
    shrink: (v) => {
      const i = values.indexOf(v);
      return i > 0 ? [values[0]!] : [];
    },
  };
}

export interface PropertyResult<T = unknown> {
  passed: boolean;
  seed: number;
  runs: number; // runs executed before stopping
  counterexample?: T; // shrunk
  original?: T; // as first generated
  shrinkSteps?: number;
  error?: string; // set when the property threw
}

// A property fails when it returns false or throws.
function holds<T>(prop: (v: T) => boolean, v: T): { ok: boolean; error?: string } {
  try {
    return { ok: prop(v) !== false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function checkProperty<T>(prop: (v: T) => boolean, gen: Gen<T>, runs = 100, seed = 1): PropertyResult<T> {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    const value = gen.generate(rng);
    const first = holds(prop, value);
    if (first.ok) continue;
    let current = value;
    let error = first.error;
    let steps = 0;
    let progressed = true;
    while (progressed && steps < 1000) {
      progressed = false;
      for (const cand of gen.shrink(current)) {
        const r = holds(prop, cand);
        if (!r.ok) {
          current = cand;
          error = r.error;
          steps++;
          progressed = true;
          break;
        }
      }
    }
    const res: PropertyResult<T> = { passed: false, seed, runs: i + 1, counterexample: current, original: value, shrinkSteps: steps };
    if (error !== undefined) res.error = error;
    return res;
  }
  return { passed: true, seed, runs };
}

// ---- differential runs ----

export interface RunOutput {
  stdout: string;
  exit: number;
}

export interface DifferentialMismatch {
  input: string;
  base: RunOutput;
  head: RunOutput;
}

export interface DifferentialResult {
  passed: boolean;
  total: number;
  mismatches: DifferentialMismatch[];
}

// Compares behaviour on the base commit and on head. Inputs where behaviour was meant to change
// are the caller's business: pass only inputs that must stay unchanged.
export function differential(
  runOnBase: (input: string) => RunOutput,
  runOnHead: (input: string) => RunOutput,
  inputs: string[],
): DifferentialResult {
  const mismatches: DifferentialMismatch[] = [];
  for (const input of inputs) {
    const base = runOnBase(input);
    const head = runOnHead(input);
    if (base.stdout !== head.stdout || base.exit !== head.exit) mismatches.push({ input, base, head });
  }
  return { passed: mismatches.length === 0, total: inputs.length, mismatches };
}

// ---- worker-owned tests ----

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(file: string, globs: string[]): boolean {
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => globToRegExp(g).test(f));
}

// Test files the worker added or modified (any changed file matching a test glob).
export function workerOwnedTests(changedFiles: string[], testGlobs: string[]): string[] {
  return changedFiles.filter((f) => matchesAnyGlob(f, testGlobs));
}

// Files allowed to grade the worker: everything except what the worker touched.
export function gradingTestFiles(all: string[], workerOwned: string[]): string[] {
  const owned = new Set(workerOwned.map((f) => f.replace(/^\.\//, '')));
  return all.filter((f) => !owned.has(f.replace(/^\.\//, '')));
}

// ---- combined verdict ----

export interface IndependentTestResult {
  passed: boolean;
  files: string[]; // must exclude worker-owned tests
  detail?: string;
}

export interface OracleResults {
  property?: PropertyResult[];
  differential?: DifferentialResult;
  independent?: IndependentTestResult;
}

export interface OracleVerdict {
  pass: boolean;
  issues: string[];
  checked: number; // how many oracle kinds contributed
}

const show = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

// Passes only if at least one oracle ran and none failed. No oracle means no evidence, so no pass.
export function oracleVerdict(results: OracleResults): OracleVerdict {
  const issues: string[] = [];
  let checked = 0;
  if (results.property && results.property.length > 0) {
    checked++;
    results.property.forEach((p, i) => {
      if (!p.passed) issues.push(`property ${i + 1} failed (seed ${p.seed}): counterexample ${show(p.counterexample)}${p.error ? ` (${p.error})` : ''}`);
    });
  }
  if (results.differential) {
    checked++;
    const d = results.differential;
    for (const m of d.mismatches) issues.push(`differential mismatch on input ${show(m.input)}: base exit ${m.base.exit}, head exit ${m.head.exit}`);
  }
  if (results.independent) {
    checked++;
    if (results.independent.files.length === 0) issues.push('independent tests: no grading files supplied');
    else if (!results.independent.passed) issues.push(`independent tests failed${results.independent.detail ? `: ${results.independent.detail}` : ''}`);
  }
  if (checked === 0) issues.push('no oracle results supplied');
  return { pass: issues.length === 0, issues, checked };
}
