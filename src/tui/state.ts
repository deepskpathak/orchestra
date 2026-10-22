// Pure navigation state for the interactive terminal dashboard. No I/O: the serve loop
// feeds parseKeys() output into reduce() and renders the resulting state.

export type Screen = 'runs' | 'board';
export type View = 'board' | 'flow';
export type DrawerTab = 'detail' | 'diff' | 'logs';

export const DRAWER_TABS: readonly DrawerTab[] = ['detail', 'diff', 'logs'];
const PAGE = 10;

export interface TuiState {
  screen: Screen;
  view: View;
  runId: string | null; // run shown on the board screen
  runIndex: number; // highlighted row on the run list
  taskIndex: number;
  drawerOpen: boolean;
  drawerTab: DrawerTab;
  drawerScroll: number;
  showToolCalls: boolean;
  helpOpen: boolean;
  follow: boolean; // keep tracking the current run
}

export interface TuiCtx {
  runIds: string[]; // newest-first, as listed on the run screen
  taskIds: string[]; // tasks of the selected run
  currentRunId?: string | null; // run to jump to when following
}

export interface ReduceResult {
  state: TuiState;
  quit: boolean;
}

export const initialState = (runId: string | null = null): TuiState => ({
  screen: runId ? 'board' : 'runs',
  view: 'board',
  runId,
  runIndex: 0,
  taskIndex: 0,
  drawerOpen: false,
  drawerTab: 'detail',
  drawerScroll: 0,
  showToolCalls: false,
  helpOpen: false,
  follow: true,
});

/** Single source of truth for the help overlay and the footer hints. */
export const KEYMAP: ReadonlyArray<{ keys: string; label: string; action: string }> = [
  { keys: '↑ ↓ ← → h j k l', label: 'move', action: 'Move selection' },
  { keys: 'Enter', label: 'open', action: 'Open task drawer, or open a run from the run list' },
  { keys: 'Esc', label: 'back', action: 'Close drawer/help, or go back to the run list' },
  { keys: 'Tab', label: 'tab', action: 'Cycle drawer tabs (detail, diff, logs)' },
  { keys: 'v', label: 'view', action: 'Toggle Board / Flow view' },
  { keys: 't', label: 'tools', action: 'Toggle tool calls in the event feed' },
  { keys: 'r', label: 'runs', action: 'Open the run list' },
  { keys: 'f', label: 'follow', action: 'Re-follow the current run' },
  { keys: 'PgUp PgDn g G', label: 'scroll', action: 'Scroll the drawer (g top, G bottom)' },
  { keys: '?', label: 'help', action: 'Toggle this help' },
  { keys: 'q Ctrl-C', label: 'quit', action: 'Quit' },
];

const clamp = (n: number, len: number): number => Math.max(0, Math.min(n, len - 1));

/** Re-clamp selection against the data currently available (call after data refreshes too). */
export function normalize(s: TuiState, ctx: TuiCtx): TuiState {
  const taskIndex = clamp(s.taskIndex, ctx.taskIds.length);
  const runIndex = clamp(s.runIndex, ctx.runIds.length);
  const drawerOpen = s.drawerOpen && ctx.taskIds.length > 0;
  if (taskIndex === s.taskIndex && runIndex === s.runIndex && drawerOpen === s.drawerOpen) return s;
  return { ...s, taskIndex, runIndex, drawerOpen };
}

export function reduce(state: TuiState, key: string, ctx: TuiCtx): ReduceResult {
  const s = normalize(state, ctx);
  const out = (next: TuiState): ReduceResult => ({ state: normalize(next, ctx), quit: false });

  if (key === 'q' || key === 'ctrl-c') return { state: s, quit: true };
  if (key === '?') return out({ ...s, helpOpen: !s.helpOpen });
  if (s.helpOpen) return out(key === 'esc' ? { ...s, helpOpen: false } : s); // help swallows other keys

  switch (key) {
    case 'up': case 'left': case 'k': case 'h':
      return out(move(s, -1));
    case 'down': case 'right': case 'j': case 'l':
      return out(move(s, 1));
    case 'enter':
      if (s.screen === 'runs') {
        const id = ctx.runIds[s.runIndex];
        if (!id) return out(s);
        return out({ ...s, screen: 'board', runId: id, taskIndex: 0, drawerOpen: false, drawerScroll: 0, follow: id === ctx.currentRunId });
      }
      if (ctx.taskIds.length === 0) return out(s);
      return out({ ...s, drawerOpen: true, drawerScroll: 0 });
    case 'esc':
      if (s.drawerOpen) return out({ ...s, drawerOpen: false });
      if (s.screen === 'board') return out({ ...s, screen: 'runs', runIndex: Math.max(0, ctx.runIds.indexOf(s.runId ?? '')) });
      return out(s);
    case 'tab':
      if (!s.drawerOpen) return out(s);
      return out({ ...s, drawerTab: DRAWER_TABS[(DRAWER_TABS.indexOf(s.drawerTab) + 1) % DRAWER_TABS.length]!, drawerScroll: 0 });
    case 'v':
      return out({ ...s, view: s.view === 'board' ? 'flow' : 'board' });
    case 't':
      return out({ ...s, showToolCalls: !s.showToolCalls });
    case 'r':
      return out({ ...s, screen: 'runs', drawerOpen: false, runIndex: Math.max(0, ctx.runIds.indexOf(s.runId ?? '')) });
    case 'f': {
      const id = ctx.currentRunId ?? s.runId;
      return out({ ...s, follow: true, screen: id ? 'board' : s.screen, runId: id, taskIndex: id === s.runId ? s.taskIndex : 0, drawerOpen: id === s.runId ? s.drawerOpen : false });
    }
    case 'pgup': return out(scroll(s, -PAGE));
    case 'pgdn': return out(scroll(s, PAGE));
    case 'g': return out(s.drawerOpen ? { ...s, drawerScroll: 0 } : s);
    case 'G': return out(s.drawerOpen ? { ...s, drawerScroll: Infinity } : s);
    default:
      return out(s);
  }
}

function move(s: TuiState, delta: number): TuiState {
  // Manually moving off the followed run is not needed; moving tasks keeps follow as is.
  if (s.screen === 'runs') return { ...s, runIndex: s.runIndex + delta };
  return { ...s, taskIndex: s.taskIndex + delta, drawerScroll: 0 };
}

function scroll(s: TuiState, delta: number): TuiState {
  if (!s.drawerOpen) return s;
  // Upper bound is unknown here (depends on content); the renderer clamps Infinity/overshoot.
  return { ...s, drawerScroll: Math.max(0, s.drawerScroll + delta) };
}

const CSI: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', Z: 'shift-tab' };
const TILDE: Record<string, string> = { '5': 'pgup', '6': 'pgdn' };

/** Decode a raw stdin chunk into key names. Unknown escape sequences are dropped. */
export function parseKeys(buf: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const c = buf[i]!;
    if (c === '\x1b') {
      const n = buf[i + 1];
      if (n === '[' || n === 'O') {
        let j = i + 2;
        while (j < buf.length && !/[\x40-\x7e]/.test(buf[j]!)) j++; // params until final byte
        const params = buf.slice(i + 2, j);
        const fin = buf[j];
        i = j + 1;
        if (fin === '~') { const k = TILDE[params]; if (k) keys.push(k); }
        else if (fin && CSI[fin] && params === '') keys.push(CSI[fin]!);
        else if (fin && CSI[fin] && n === '[') keys.push(CSI[fin]!); // e.g. modified arrows \x1b[1;2A
        continue;
      }
      keys.push('esc');
      i++;
      continue;
    }
    i++;
    if (c === '\r' || c === '\n') keys.push('enter');
    else if (c === '\t') keys.push('tab');
    else if (c === '\x03') keys.push('ctrl-c');
    else if (c === '\x7f' || c === '\b') keys.push('backspace');
    else if (c >= ' ') keys.push(c);
  }
  return keys;
}
