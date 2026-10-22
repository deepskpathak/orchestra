// Pure renderers for the interactive terminal dashboard: (state, data, opts) -> one frame.
// A frame is always exactly `rows` lines, each exactly `width` visible columns.

import type { OrchestraEvent, Run, Task } from '../types.ts';
import { bar, clock, counts, eventLine, fit, paint, phases, ROLE_STYLE, SPIN, STATUS_ICON, visible, type Style } from './render.ts';
import { KEYMAP, DRAWER_TABS, type TuiState } from './state.ts';

export interface RunSummary {
  id: string;
  goal: string;
  status: string;
  kind?: string;
  startedAt?: number;
  endedAt: number | null;
  costUsd: number;
  satisfaction: number | null;
  tasks: number;
  merged: number;
}

export interface TaskDetailData {
  diff: string | null;
  logs: { name: string; tail: string }[];
}

export interface FrameData {
  run: Run | null; // run shown on the board screen
  runs: RunSummary[]; // newest first
  events: OrchestraEvent[];
  detail?: TaskDetailData | null; // for the selected task, when the drawer is open
  maxAttempts?: number;
  passThreshold?: number;
}

export interface FrameOpts {
  width: number;
  rows: number;
  now: number;
  color: boolean;
  frame: number;
}

type Painter = ReturnType<typeof paint>;

const COLUMNS: { title: string; statuses: Task['status'][]; style: Style }[] = [
  { title: 'Queued', statuses: ['pending'], style: 'gray' },
  { title: 'Building', statuses: ['running', 'repair'], style: 'cyan' },
  { title: 'Verifying', statuses: ['judging'], style: 'magenta' },
  { title: 'Merging', statuses: ['merging'], style: 'blue' },
  { title: 'Done', statuses: ['merged'], style: 'green' },
  { title: 'Failed', statuses: ['failed', 'blocked'], style: 'red' },
];
const CARD_H = 3;

export function renderFrame(state: TuiState, data: FrameData, o: FrameOpts): string {
  const width = Math.max(1, Math.floor(o.width));
  const rows = Math.max(1, Math.floor(o.rows));
  const c = paint(o.color);
  const run = state.screen === 'board' ? data.run : null;
  const lines: string[] = [];

  const head = state.screen === 'board' ? header(run, data, width, o, c) : runsHeader(data, width, c);
  const foot = footer(state, data, run, width, c);
  const bodyH = Math.max(0, rows - head.length - 1);
  let body: string[];
  if (state.helpOpen) body = helpOverlay(bodyH, width, c);
  else if (state.screen === 'runs') body = runList(state, data, bodyH, width, o, c);
  else if (!run) body = [c('gray', ' no run selected, press r for the run list')];
  else if (state.drawerOpen && run.tasks.length) body = drawer(state, data, run, bodyH, width, c);
  else body = boardBody(state, data, run, bodyH, width, o, c);

  lines.push(...head, ...body.slice(0, bodyH));
  while (lines.length < rows - 1) lines.push('');
  lines.length = Math.min(lines.length, rows - 1);
  if (rows >= 1) lines.push(foot);
  return lines.slice(0, rows).map((l) => fit(l, width)).join('\n');
}

// ---------- chrome ----------

function header(run: Run | null, data: FrameData, width: number, o: FrameOpts, c: Painter): string[] {
  if (!run) return [c(['bold', 'cyan'], ' ♫ ORCHESTRA')];
  const elapsed = (run.endedAt ?? o.now) - run.startedAt;
  const statusStyle: Style = run.status === 'done' ? 'green' : run.status === 'failed' ? 'red' : 'cyan';
  const l1 =
    c(['bold', 'cyan'], ` ♫ ORCHESTRA ${run.id}`) +
    c('gray', ` harness ${run.harness}${run.kind === 'eval' ? ' [eval]' : ''}`) +
    `  ${c('bold', clock(elapsed))}  ${c('bold', `$${run.costUsd.toFixed(2)}`)}  ${c(statusStyle, run.status.toUpperCase())}`;
  const k = counts(run);
  const l3 =
    ` ${bar(k.total ? k.merged / k.total : 0, Math.min(24, Math.max(6, Math.floor(width / 5))), c)} ${k.merged}/${k.total}  ` +
    `${c('green', `✓${k.merged}`)} ${c('cyan', `●${k.active}`)} ${c('yellow', `⟳${k.repair}`)} ${c('red', `✗${k.failed}`)}  ${c('dim', run.goal)}`;
  void data;
  return [l1, ' ' + phases(run, c), l3];
}

function runsHeader(data: FrameData, width: number, c: Painter): string[] {
  void width;
  return [c(['bold', 'cyan'], ` ♫ ORCHESTRA  runs (${data.runs.length})`), c('gray', ' newest first')];
}

const HINT_LABELS = ['move', 'open', 'back', 'view', 'tools', 'runs', 'help', 'quit'];

function footer(state: TuiState, data: FrameData, run: Run | null, width: number, c: Painter): string {
  const live = state.screen === 'board' ? Boolean(run && !run.endedAt) : data.runs.some((r) => r.endedAt === null);
  const badge = live ? c(['bold', 'green'], '● LIVE') : c('gray', '○ ENDED');
  const hints = HINT_LABELS.map((l) => KEYMAP.find((k) => k.label === l))
    .filter((k): k is (typeof KEYMAP)[number] => Boolean(k))
    .map((k) => `${c('bold', k.keys.split(' ')[0]!.replace('Ctrl-C', 'q'))} ${k.label}`)
    .join(c('gray', ' · '));
  const left = ' ' + hints;
  const room = width - visible(badge) - 1;
  return fit(left, Math.max(0, room)) + ' ' + badge;
}

// ---------- run list ----------

function runList(state: TuiState, data: FrameData, h: number, width: number, o: FrameOpts, c: Painter): string[] {
  if (!data.runs.length) return [c('gray', ' no runs yet, start one with `orchestra run`')];
  const win = window(state.runIndex, data.runs.length, h);
  return data.runs.slice(win, win + h).map((r, j) => {
    const sel = win + j === state.runIndex;
    const st: Style = r.status === 'done' ? 'green' : r.status === 'failed' ? 'red' : 'cyan';
    const sat = r.satisfaction === null ? '----' : r.satisfaction.toFixed(2);
    const plain =
      `${sel ? '▶' : ' '} ${r.id}  ${r.status.padEnd(11)} ${`${r.merged}/${r.tasks}`.padStart(5)}  ${`$${r.costUsd.toFixed(2)}`.padStart(7)}  sat ${sat}  ${r.goal}`;
    void o; void width;
    if (sel) return c(['inverse', 'bold'], plain);
    return `  ${r.id}  ${c(st, r.status.padEnd(11))} ${`${r.merged}/${r.tasks}`.padStart(5)}  ${`$${r.costUsd.toFixed(2)}`.padStart(7)}  sat ${sat}  ${c('dim', r.goal)}`;
  });
}

// First visible index so that `sel` is inside a window of `h` items.
function window(sel: number, len: number, h: number): number {
  if (len <= h) return 0;
  return Math.max(0, Math.min(len - h, sel - Math.floor(h / 2)));
}

// ---------- help ----------

function helpOverlay(h: number, width: number, c: Painter): string[] {
  const keyW = Math.max(...KEYMAP.map((k) => k.keys.length));
  const out = [c(['bold', 'cyan'], ' Keyboard help') + c('gray', '  (? or Esc to close)'), ''];
  for (const k of KEYMAP) out.push(` ${c('bold', k.keys.padEnd(keyW))}  ${k.action}`);
  void width;
  return out.slice(0, h);
}

// ---------- board / flow ----------

function boardBody(state: TuiState, data: FrameData, run: Run, h: number, width: number, o: FrameOpts, c: Painter): string[] {
  const agentRows = Math.min(run.active.length, 3) || 1;
  let agentsH = 1 + agentRows;
  let eventsH = 1 + Math.min(5, Math.max(1, Math.floor(h / 4)));
  let tasksH = h - agentsH - eventsH;
  if (tasksH < 5) {
    eventsH = Math.max(0, eventsH - (5 - tasksH));
    tasksH = h - agentsH - eventsH;
  }
  if (tasksH < 5) {
    agentsH = Math.max(0, agentsH - (5 - tasksH));
    tasksH = h - agentsH - eventsH;
  }
  const out: string[] = [];
  out.push(...section(`Tasks · ${state.view}`, tasksH, taskArea(state, data, run, tasksH - 1, width, o, c), width, c));
  if (agentsH) out.push(...section(`Agents (${run.active.length})`, agentsH, agentLanes(run, o, c), width, c));
  if (eventsH) out.push(...section('Events', eventsH, eventFeed(state, data, run, c), width, c));
  return out;
}

function section(title: string, h: number, body: string[], width: number, c: Painter): string[] {
  if (h <= 0) return [];
  const t = ` ${title} `;
  const rule = c('gray', '──') + c('bold', t) + c('gray', '─'.repeat(Math.max(0, width - 2 - visible(t))));
  return [rule, ...body.slice(0, h - 1)];
}

function agentLanes(run: Run, o: FrameOpts, c: Painter): string[] {
  if (!run.active.length) return [c('gray', ' ' + (run.endedAt ? 'all agents finished' : 'waiting…'))];
  return run.active.map((a, i) => {
    const spin = c(ROLE_STYLE[a.role], SPIN[(o.frame + i) % SPIN.length]!);
    const action = a.lastAction.startsWith('says:') ? c('dim', a.lastAction.slice(5).trim()) : a.lastAction;
    return ` ${spin} ${c(ROLE_STYLE[a.role], a.role.padEnd(9))} ${c('bold', (a.task ?? '').padEnd(4))} ${c('gray', `${a.tools} tools · ${clock(o.now - a.startedAt)}`)}  ${action}`;
  });
}

function eventFeed(state: TuiState, data: FrameData, run: Run, c: Painter): string[] {
  const evs = data.events.filter((e) => state.showToolCalls || e.kind !== 'agent.action');
  if (!evs.length) return [c('gray', ' no events yet')];
  return evs.slice(-8).map((e) => ' ' + eventLine(e, run.startedAt, c));
}

function taskArea(state: TuiState, data: FrameData, run: Run, h: number, width: number, o: FrameOpts, c: Painter): string[] {
  if (!run.tasks.length) return [c('gray', ' ' + (run.status === 'planning' ? 'planner is drafting the task graph…' : 'no tasks'))];
  const sel = run.tasks[state.taskIndex]?.id;
  if (state.view === 'flow') return listView(flowGroups(run), sel, run, data, h, o, c);
  if (width < 80) {
    const groups = COLUMNS.map((col) => ({ title: col.title, tasks: run.tasks.filter((t) => col.statuses.includes(t.status)) })).filter((g) => g.tasks.length);
    return listView(groups, sel, run, data, h, o, c);
  }
  return columns(sel, run, data, h, width, o, c);
}

function flowGroups(run: Run): { title: string; tasks: Task[] }[] {
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const depth = (t: Task, seen = new Set<string>()): number => {
    if (memo.has(t.id)) return memo.get(t.id)!;
    if (seen.has(t.id)) return 0; // cycle guard
    seen.add(t.id);
    const d = t.deps.length ? 1 + Math.max(...t.deps.map((id) => (byId.has(id) ? depth(byId.get(id)!, seen) : -1))) : 0;
    memo.set(t.id, d);
    return d;
  };
  const groups = new Map<number, Task[]>();
  for (const t of run.tasks) groups.set(depth(t), [...(groups.get(depth(t)) ?? []), t]);
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([d, tasks]) => ({ title: d === 0 ? 'Depth 0 · no deps' : `Depth ${d}`, tasks }));
}

function taskIcon(t: Task, o: FrameOpts, c: Painter): string {
  const [icon, style] = STATUS_ICON[t.status];
  return c(style, ['running', 'judging', 'merging'].includes(t.status) ? SPIN[o.frame % SPIN.length]! : icon);
}

function listView(groups: { title: string; tasks: Task[] }[], sel: string | undefined, run: Run, data: FrameData, h: number, o: FrameOpts, c: Painter): string[] {
  const all: { text: string; selected: boolean }[] = [];
  for (const g of groups) {
    all.push({ text: c('bold', ` ${g.title} (${g.tasks.length})`), selected: false });
    for (const t of g.tasks) {
      const isSel = t.id === sel;
      const agent = run.active.find((a) => a.task === t.id);
      const score = t.verdict ? t.verdict.score.toFixed(2) : '----';
      const deps = t.deps.length ? c('gray', ` ⇠ ${t.deps.join(',')}`) : '';
      const act = agent ? c('dim', ` ${agent.lastAction}`) : '';
      const body = `${taskIcon(t, o, c)} ${c('bold', t.id.padEnd(4))} ${score} ${tryText(t, data)} ${t.title}${deps}${act}`;
      all.push({ text: `${isSel ? c(['bold', 'cyan'], '▶') : ' '} ${body}`, selected: isSel });
    }
  }
  const at = Math.max(0, all.findIndex((l) => l.selected));
  const w = window(at, all.length, h);
  return all.slice(w, w + h).map((l) => l.text);
}

function tryText(t: Task, data: FrameData): string {
  return `try ${t.attempts || '-'}${data.maxAttempts ? `/${data.maxAttempts}` : ''}`;
}

function columns(sel: string | undefined, run: Run, data: FrameData, h: number, width: number, o: FrameOpts, c: Painter): string[] {
  const cw = Math.floor((width - (COLUMNS.length - 1)) / COLUMNS.length);
  const perCol = Math.max(1, Math.floor((h - 1) / CARD_H));
  const cols = COLUMNS.map((col) => {
    const tasks = run.tasks.filter((t) => col.statuses.includes(t.status));
    const at = Math.max(0, tasks.findIndex((t) => t.id === sel));
    const start = window(at, tasks.length, perCol);
    const lines = [fit(c(['bold', col.style], ` ${col.title} (${tasks.length})`), cw)];
    for (const t of tasks.slice(start, start + perCol)) lines.push(...card(t, t.id === sel, cw, run, data, o, c));
    return lines;
  });
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(cols.map((col) => fit(col[i] ?? '', cw)).join(c('gray', '│')));
  return out;
}

function card(t: Task, selected: boolean, cw: number, run: Run, data: FrameData, o: FrameOpts, c: Painter): string[] {
  const agent = run.active.find((a) => a.task === t.id);
  const mark = selected ? '▶' : ' ';
  const score = t.verdict ? t.verdict.score.toFixed(2) : '----';
  const raw = [
    `${mark}${t.id} ${t.title}`,
    `  ${score} ${tryText(t, data)}`,
    `  ${agent ? agent.lastAction : t.deps.length ? `⇠ ${t.deps.join(',')}` : ''}`,
  ];
  const [, style] = STATUS_ICON[t.status];
  return raw.map((l, i) => {
    const cell = fit(i === 0 ? `${mark}${taskIcon(t, o, c)} ${t.id} ${t.title}` : l, cw);
    if (selected) return c(['inverse', 'bold'], stripAnsi(cell));
    return i === 0 ? cell : c(i === 1 ? style : 'gray', cell);
  });
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---------- drawer ----------

function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(' ')) {
      while (visible(word) > w) {
        if (line) { out.push(line); line = ''; }
        out.push([...word].slice(0, w).join(''));
        word = [...word].slice(w).join('');
      }
      if (!line) line = word;
      else if (visible(line) + 1 + visible(word) <= w) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function drawer(state: TuiState, data: FrameData, run: Run, h: number, width: number, c: Painter): string[] {
  const t = run.tasks[state.taskIndex]!;
  const w = Math.max(10, width - 4);
  const tabs = DRAWER_TABS.map((x) => (x === state.drawerTab ? c(['inverse', 'bold'], ` ${x.toUpperCase()} `) : c('gray', ` ${x} `))).join(' ');
  const title = `${c('bold', ` ${t.id}`)} ${t.title}`;
  let content: string[];
  if (state.drawerTab === 'detail') content = detailLines(t, run, data, w, c);
  else if (state.drawerTab === 'diff') content = diffLines(data, w, c);
  else content = logLines(data, w, c);
  const viewH = Math.max(0, h - 3);
  const maxOff = Math.max(0, content.length - viewH);
  const off = Math.min(maxOff, Math.max(0, state.drawerScroll));
  const more = content.length > viewH ? c('gray', ` ${off + 1}-${Math.min(content.length, off + viewH)}/${content.length}`) : '';
  const out = [fit(title, width), fit(' ' + tabs + more, width), c('gray', '─'.repeat(width))];
  out.push(...content.slice(off, off + viewH).map((l) => '  ' + l));
  return out.slice(0, h);
}

function detailLines(t: Task, run: Run, data: FrameData, w: number, c: Painter): string[] {
  const out: string[] = [];
  const [icon, style] = STATUS_ICON[t.status];
  out.push(`${c(style, `${icon} ${t.status}`)}  ${tryText(t, data)}  $${t.costUsd.toFixed(2)}`);
  out.push('', c('bold', 'Description'), ...wrap(t.description || '(none)', w));
  out.push('', c('bold', 'Acceptance criteria'));
  const results = t.verdict?.criteria ?? [];
  if (!t.acceptance.length) out.push(c('gray', '(none)'));
  for (const a of t.acceptance) {
    const r = results.find((x) => x.criterion === a);
    const mark = r ? (r.pass ? c('green', '✓ pass') : c('red', '✗ fail')) : c('gray', '· n/a ');
    const [first, ...rest] = wrap(a, w - 8);
    out.push(`${mark} ${first}`, ...rest.map((l) => '       ' + l));
    if (r?.note) out.push(...wrap(r.note, w - 8).map((l) => '       ' + c('gray', l)));
  }
  out.push('', c('bold', 'Verdict'));
  if (!t.verdict) out.push(c('gray', 'not judged yet'));
  else {
    const v = t.verdict;
    const thr = data.passThreshold;
    out.push(
      `score ${c('bold', v.score.toFixed(2))}${thr !== undefined ? ` vs pass threshold ${thr.toFixed(2)}` : ''}  ${v.pass ? c('green', 'PASS') : c('red', 'FAIL')}` +
        `  tests ${v.testsPassed === null ? 'n/a' : v.testsPassed ? 'passed' : 'failed'}`,
    );
    out.push(...wrap(v.summary, w));
    for (const i of v.issues) out.push(...wrap(`- ${i}`, w));
    if (v.judgeError) out.push(c('red', `judge error: ${v.judgeError}`));
  }
  if (t.notes.length) {
    out.push('', c('bold', 'Repair notes'));
    for (const n of t.notes) out.push(...wrap(`- ${n}`, w));
  }
  const down = run.tasks.filter((x) => x.deps.includes(t.id)).map((x) => x.id);
  out.push('', c('bold', 'Relations'), `upstream:   ${t.deps.join(', ') || 'none'}`, `downstream: ${down.join(', ') || 'none'}`);
  return out;
}

function diffLines(data: FrameData, w: number, c: Painter): string[] {
  const diff = data.detail?.diff;
  if (!diff) return [c('gray', 'no diff available (branch pruned, or task not started)')];
  return diff.split('\n').map((l) => {
    const s = [...l].slice(0, w).join('');
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')) return c('bold', s);
    if (l.startsWith('+')) return c('green', s);
    if (l.startsWith('-')) return c('red', s);
    if (l.startsWith('@@')) return c('cyan', s);
    return s;
  });
}

function logLines(data: FrameData, w: number, c: Painter): string[] {
  const logs = data.detail?.logs ?? [];
  if (!logs.length) return [c('gray', 'no agent logs for this task yet')];
  const out: string[] = [];
  for (const l of logs) {
    out.push(c(['bold', 'cyan'], `── ${l.name} ──`));
    for (const line of l.tail.split('\n').slice(-200)) out.push(...wrap(line, w));
  }
  return out;
}
