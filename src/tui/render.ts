// Terminal rendering. Pure functions from state to strings so they are testable and
// reusable by `watch` (full-screen), `status` (one-shot board), and the statusline.

import type { ArchiveEntry } from '../harness.ts';
import type { VersionMetrics } from '../evolve.ts';
import type { OrchestraEvent, Role, Run, Task, TaskStatus } from '../types.ts';

export interface RenderOpts {
  width: number;
  now: number;
  color: boolean;
  frame: number; // animation tick for spinners
  maxEvents?: number;
}

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  inverse: '\x1b[7m',
} as const;
export type Style = keyof typeof CODES;

export function paint(on: boolean) {
  return (style: Style | Style[], s: string): string => {
    if (!on) return s;
    const styles = Array.isArray(style) ? style : [style];
    return styles.map((x) => CODES[x]).join('') + s + CODES.reset;
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export const visible = (s: string): number => [...s.replace(ANSI, '')].length;

export function fit(s: string, width: number): string {
  const len = visible(s);
  if (len <= width) return s + ' '.repeat(width - len);
  // Truncate by visible characters while keeping escape codes intact.
  let out = '';
  let n = 0;
  for (let i = 0; i < s.length && n < width - 1; ) {
    const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out += ch;
    i += ch.length;
    n++;
  }
  return out + '…' + (s.includes('\x1b[') ? CODES.reset : '');
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function bar(frac: number, width: number, c: ReturnType<typeof paint>, style: Style = 'green'): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  return c(style, '█'.repeat(full)) + c('gray', '░'.repeat(width - full));
}

export function sparkline(values: number[]): string {
  const ticks = '▁▂▃▄▅▆▇█';
  if (!values.length) return '';
  const max = Math.max(...values, 1e-9);
  return values.map((v) => ticks[Math.min(7, Math.floor((v / max) * 7.999))]).join('');
}

export const STATUS_ICON: Record<TaskStatus, [string, Style]> = {
  pending: ['◌', 'gray'],
  running: ['●', 'cyan'],
  judging: ['◆', 'magenta'],
  repair: ['⟳', 'yellow'],
  merging: ['⇢', 'blue'],
  merged: ['✓', 'green'],
  failed: ['✗', 'red'],
  needs_human: ['?', 'yellow'],
  blocked: ['⊘', 'red'],
};

export const ROLE_STYLE: Record<Role, Style> = {
  planner: 'blue',
  worker: 'cyan',
  judge: 'magenta',
  librarian: 'green',
  evolver: 'yellow',
};

export function counts(run: Run) {
  const by = (s: TaskStatus[]) => run.tasks.filter((t) => s.includes(t.status)).length;
  return {
    total: run.tasks.length,
    merged: by(['merged']),
    active: by(['running', 'judging', 'merging']),
    repair: by(['repair']),
    failed: by(['failed', 'blocked']),
    needsHuman: by(['needs_human']),
    pending: by(['pending']),
  };
}

export function phases(run: Run, c: ReturnType<typeof paint>): string {
  const k = counts(run);
  const hasJudge = run.active.some((a) => a.role === 'judge');
  const hasWorker = run.active.some((a) => a.role === 'worker');
  const merging = run.tasks.some((t) => t.status === 'merging');
  const state: [string, boolean, boolean][] = [
    ['PLAN', run.status === 'planning', run.status !== 'planning'],
    ['BUILD', hasWorker, run.status !== 'planning' && !hasWorker && k.pending + k.repair === 0],
    ['VERIFY', hasJudge, ['compounding', 'done'].includes(run.status)],
    ['MERGE', merging, ['compounding', 'done'].includes(run.status)],
    ['LEARN', run.status === 'compounding', run.status === 'done' && run.kind === 'goal'],
  ];
  return state
    .map(([name, active, done]) => (active ? c(['bold', 'cyan'], `▶ ${name}`) : done ? c('green', `✓ ${name}`) : c('gray', `· ${name}`)))
    .join(c('gray', '  ─  '));
}

export function renderDashboard(run: Run, events: OrchestraEvent[], o: RenderOpts): string {
  const c = paint(o.color);
  const W = Math.max(60, o.width);
  const inner = W - 4;
  const lines: string[] = [];
  const row = (s = '') => lines.push(c('gray', '│ ') + fit(s, inner) + c('gray', ' │'));
  const rule = (title: string) => {
    const t = ` ${title} `;
    lines.push(c('gray', '├─') + c('bold', t) + c('gray', '─'.repeat(Math.max(0, W - 3 - visible(t))) + '┤'));
  };

  const elapsed = (run.endedAt ?? o.now) - run.startedAt;
  const title = ` ♫ ORCHESTRA  ${run.id}  harness ${run.harness}${run.kind === 'eval' ? '  [eval]' : ''} `;
  const right = ` ${clock(elapsed)} `;
  lines.push(c('gray', '╭─') + c(['bold', 'cyan'], title) + c('gray', '─'.repeat(Math.max(0, W - 4 - visible(title) - visible(right)))) + c('bold', right) + c('gray', '─╮'));

  row(`${c('bold', 'Goal')} ${run.goal}`);
  row(phases(run, c));
  const k = counts(run);
  const frac = k.total ? k.merged / k.total : 0;
  const statusStyle: Style = run.status === 'done' ? 'green' : run.status === 'failed' ? 'red' : run.status === 'awaiting_approval' ? 'yellow' : 'cyan';
  row(
    `${bar(frac, Math.min(30, Math.floor(inner / 4)), c)} ${k.merged}/${k.total}  ` +
      `${c('green', `✓${k.merged}`)} ${c('cyan', `●${k.active}`)} ${c('yellow', `⟳${k.repair}`)} ${c('red', `✗${k.failed}`)}${k.needsHuman ? ` ${c('yellow', `?${k.needsHuman}`)}` : ''}  ` +
      `${c('bold', `$${run.costUsd.toFixed(2)}`)}  ${c(statusStyle, run.status.toUpperCase())}` +
      (run.satisfaction !== undefined ? `  sat ${c('bold', run.satisfaction.toFixed(2))}` : ''),
  );

  if (run.mutation) {
    const m = run.mutation;
    row(m.skipped || m.score === undefined ? `mutation ${c('gray', `skipped (${m.skipped ?? 'no score'})`)}` : `mutation ${c(m.pass ? 'green' : 'red', m.score.toFixed(2))} (${m.killed}/${m.total} killed, floor ${m.floor})`);
  }

  rule(`Agents (${run.active.length})`);
  if (!run.active.length) row(c('gray', run.endedAt ? 'all agents finished' : 'waiting…'));
  for (const [i, a] of run.active.entries()) {
    const spin = c(ROLE_STYLE[a.role], SPIN[(o.frame + i) % SPIN.length]);
    const who = c(ROLE_STYLE[a.role], a.role.padEnd(9));
    const task = (a.task ?? '').padEnd(4);
    const meta = c('gray', `${a.model} · ${a.tools} tools · ${clock(o.now - a.startedAt)}`);
    const action = a.lastAction.startsWith('says:') ? c('dim', a.lastAction.slice(5).trim()) : a.lastAction;
    row(`${spin} ${who} ${c('bold', task)} ${meta}  ${action}`);
  }

  rule('Tasks');
  if (!run.tasks.length) row(c('gray', run.status === 'planning' ? 'planner is drafting the task graph…' : 'no tasks'));
  for (const t of run.tasks) row(taskRow(t, c, o));

  rule('Events');
  const evs = events.filter((e) => e.kind !== 'agent.action').slice(-(o.maxEvents ?? 8));
  for (const e of evs) row(eventLine(e, run.startedAt, c));
  if (!evs.length) row(c('gray', 'no events yet'));
  if (run.endedAt && run.integrationBranch && run.kind === 'goal') {
    rule('Next');
    row(`Review: ${c('bold', `git log --oneline ${run.baseRef?.slice(0, 8) ?? 'HEAD'}..${run.integrationBranch}`)}`);
    row(`Land:   ${c('bold', `git merge ${run.integrationBranch}`)}`);
  }
  if (run.error) row(c('red', `error: ${run.error}`));
  lines.push(c('gray', '╰' + '─'.repeat(W - 2) + '╯'));
  return lines.join('\n');
}

function taskRow(t: Task, c: ReturnType<typeof paint>, o: RenderOpts): string {
  const [icon, style] = STATUS_ICON[t.status];
  const live = ['running', 'judging', 'merging'].includes(t.status) ? c(style, SPIN[o.frame % SPIN.length]) : c(style, icon);
  const score = t.verdict ? `${bar(t.verdict.score, 8, c, t.verdict.pass ? 'green' : 'yellow')} ${t.verdict.score.toFixed(2)}` : c('gray', '░░░░░░░░ ----');
  const deps = t.deps.length ? c('gray', ` ⇠ ${t.deps.join(',')}`) : '';
  const tries = c('gray', `try ${t.attempts || '-'}`);
  const status = c(style, t.status.padEnd(8));
  return `${live} ${c('bold', t.id.padEnd(4))} ${status} ${score}  ${tries}  ${c('gray', `$${t.costUsd.toFixed(2)}`)}  ${t.title}${deps}`;
}

export function eventLine(e: OrchestraEvent, start: number, c: ReturnType<typeof paint>): string {
  const style: Style =
    e.kind === 'task.merged' || e.kind === 'learn'
      ? 'green'
      : e.kind === 'task.failed'
        ? 'red'
        : e.kind === 'task.needs_human' || e.kind === 'task.repair'
          ? 'yellow'
          : e.kind === 'task.verdict'
            ? 'magenta'
            : e.kind === 'evolve'
              ? 'yellow'
              : e.kind.startsWith('run')
                ? 'cyan'
                : 'gray';
  return `${c('gray', clock(e.t - start))} ${c(style, e.msg)}`;
}

// Single line for non-TTY progress (e.g. when Claude Code runs `orchestra run` via Bash).
export function compactLine(e: OrchestraEvent, start: number): string | null {
  if (e.kind === 'agent.action') return null;
  return `[orchestra ${clock(e.t - start)}] ${e.msg}`;
}

// Claude Code statusline: short, colored, at most two lines.
export function renderStatusLine(run: Run | null, info: { harness: string; satisfaction?: number; color: boolean; frame: number }): string {
  const c = paint(info.color);
  const brand = c(['bold', 'cyan'], '♫ orchestra');
  if (!run || run.endedAt) {
    const last = run ? ` · last ${run.status === 'done' ? c('green', 'done') : c('red', run.status)} sat ${(run.satisfaction ?? 0).toFixed(2)}` : '';
    return `${brand} ${c('gray', `idle · harness ${info.harness}`)}${last}`;
  }
  const k = counts(run);
  const spin = c('cyan', SPIN[info.frame % SPIN.length]);
  const agents = run.active.map((a) => c(ROLE_STYLE[a.role], `${a.role[0].toUpperCase()}${a.task ? ':' + a.task : ''}`)).join(' ');
  return `${brand} ${spin} ${run.status} ${bar(k.total ? k.merged / k.total : 0, 10, c)} ${k.merged}/${k.total} ${c('yellow', `⟳${k.repair}`)} ${c('red', `✗${k.failed}`)} $${run.costUsd.toFixed(2)} ${agents}`;
}

export function renderStats(m: VersionMetrics[], archive: ArchiveEntry[], current: string, color: boolean): string {
  const c = paint(color);
  const out: string[] = [];
  out.push(c(['bold', 'cyan'], '♫ ORCHESTRA · factory health by harness version'));
  out.push('');
  out.push(c('bold', 'version  runs  tasks  1st-pass  satisfaction        $/merged  eval   status'));
  for (const a of [...archive].sort((x, y) => Number(x.version.slice(1)) - Number(y.version.slice(1)))) {
    const mm = m.find((x) => x.version === a.version);
    const cur = a.version === current ? c(['bold', 'green'], '◀ current') : '';
    const st = a.status === 'promoted' ? c('green', a.status) : a.status === 'rejected' ? c('red', a.status) : c('gray', a.status);
    out.push(
      [
        a.version.padEnd(8),
        String(mm?.runs ?? 0).padStart(4),
        String(mm?.tasks ?? 0).padStart(6),
        `${((mm?.firstPassYield ?? 0) * 100).toFixed(0)}%`.padStart(9),
        ` ${bar(mm?.satisfaction ?? 0, 10, c)} ${(mm?.satisfaction ?? 0).toFixed(2)}`,
        `$${(mm?.costPerMerged ?? 0).toFixed(2)}`.padStart(9),
        (a.evalScore === null ? '  -  ' : a.evalScore.toFixed(3)).padStart(6),
        ` ${st} ${cur}`,
      ].join(' '),
    );
    if (a.rationale && a.rationale !== 'seed') out.push(c('gray', `         ↳ ${a.rationale.slice(0, 110)}`));
  }
  out.push('');
  out.push(
    'cache hit ratio     ' +
      (m.map((x) => `${x.version} ${x.cacheHitRatio == null ? 'n/a' : `${(x.cacheHitRatio * 100).toFixed(0)}%`}`).join('  ') || 'n/a'),
  );
  if (m.length > 1) {
    out.push('');
    out.push(`satisfaction trend  ${c('green', sparkline(m.map((x) => x.satisfaction)))}`);
    out.push(`first-pass trend    ${c('cyan', sparkline(m.map((x) => x.firstPassYield)))}`);
  }
  return out.join('\n');
}
