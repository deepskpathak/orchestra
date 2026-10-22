// Interactive terminal dashboard loop: raw stdin -> parseKeys -> reduce -> renderFrame.
// Read-only and local: it only reads the store; no HTTP server, no network listener.

import { harnessLimits, listRunSummaries, taskDetail } from '../dashboard-data.ts';
import type { Store } from '../store.ts';
import type { Run } from '../types.ts';
import { renderFrame, type FrameData, type TaskDetailData } from './screens.ts';
import { initialState, normalize, parseKeys, reduce, type TuiCtx, type TuiState } from './state.ts';

export const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l';
export const LEAVE_SCREEN = '\x1b[?25h\x1b[?1049l';

export interface TuiInput {
  on(ev: 'data', fn: (chunk: Buffer | string) => void): unknown;
  removeListener(ev: 'data', fn: (chunk: Buffer | string) => void): unknown;
  setEncoding?(enc: BufferEncoding): unknown;
  setRawMode?(raw: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface TuiOutput {
  write(s: string): unknown;
  columns?: number;
  rows?: number;
  on?(ev: 'resize', fn: () => void): unknown;
  removeListener?(ev: 'resize', fn: () => void): unknown;
}

export interface TuiOpts {
  store: Store;
  stdin: TuiInput;
  stdout: TuiOutput;
  runId?: string; // pin a run; otherwise follow the current one
  pollMs?: number;
  color?: boolean;
  handleProcessSignals?: boolean; // SIGTERM/uncaught errors; on for the CLI
}

const DETAIL_REFRESH_MS = 1500;

/** Runs until the user quits (q / Ctrl-C), SIGTERM, or an error; always restores the terminal. */
export function startTui(o: TuiOpts): Promise<void> {
  const { store, stdin, stdout } = o;
  const pollMs = Math.min(250, Math.max(150, o.pollMs ?? 200));
  const color = o.color ?? !process.env.NO_COLOR;
  const limits = harnessLimits(store);

  let state: TuiState = initialState(o.runId ?? store.currentRunId());
  if (o.runId) state = { ...state, follow: false };
  let ctx: TuiCtx = { runIds: [], taskIds: [] };
  let lastFrame = '';
  let detail: { key: string; at: number; data: TaskDetailData | null } | null = null;
  let failedPolls = 0;

  const size = () => ({ width: Math.max(20, stdout.columns || 100), rows: Math.max(5, stdout.rows || 30) });

  function refreshCtx(): Run | null {
    const runIds = store.listRuns().slice().reverse();
    const current = store.currentRunId();
    if (state.follow && current && current !== state.runId) {
      state = { ...state, runId: current, screen: 'board', taskIndex: 0, drawerOpen: false, drawerScroll: 0 };
    }
    const run = state.runId ? store.loadRun(state.runId) : null;
    ctx = { runIds, taskIds: run?.tasks.map((t) => t.id) ?? [], currentRunId: current };
    state = normalize(state, ctx);
    return run;
  }

  function drawerDetail(run: Run | null): TaskDetailData | null {
    const taskId = state.drawerOpen && run ? ctx.taskIds[state.taskIndex] : undefined;
    if (!run || !taskId) return null;
    const key = `${run.id}/${taskId}`;
    const now = Date.now();
    if (!detail || detail.key !== key || now - detail.at > DETAIL_REFRESH_MS) {
      const d = taskDetail(store, run.id, taskId);
      detail = { key, at: now, data: d ? { diff: d.diff, logs: d.logs } : null };
    }
    return detail.data;
  }

  function draw(): void {
    const run = refreshCtx();
    const data: FrameData = {
      run,
      runs: state.screen === 'runs' ? listRunSummaries(store) : [],
      events: run ? store.events(run.id) : [],
      detail: drawerDetail(run),
      ...limits,
    };
    const { width, rows } = size();
    const frame = renderFrame(state, data, { width, rows, now: Date.now(), color, frame: Math.floor(Date.now() / 120) });
    if (frame === lastFrame) return;
    lastFrame = frame;
    stdout.write('\x1b[H' + frame.split('\n').join('\r\n'));
  }

  return new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    const onResize = () => {
      lastFrame = '';
      guarded(draw);
    };
    const onData = (chunk: Buffer | string) => {
      guarded(() => {
        for (const key of parseKeys(chunk.toString())) {
          const r = reduce(state, key, ctx);
          state = r.state;
          if (r.quit) return finish();
        }
        draw();
      });
    };
    const onSigterm = () => finish();
    const onUncaught = (err: Error) => finish(err);
    const onExit = () => restoreTerminal();

    let restored = false;
    function restoreTerminal(): void {
      if (restored) return;
      restored = true;
      try {
        stdin.setRawMode?.(false);
      } finally {
        stdout.write(LEAVE_SCREEN);
      }
    }

    function finish(err?: Error): void {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      stdin.removeListener('data', onData);
      stdout.removeListener?.('resize', onResize);
      if (o.handleProcessSignals) {
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('SIGWINCH', onResize);
        process.removeListener('uncaughtException', onUncaught);
        process.removeListener('exit', onExit);
      }
      try {
        restoreTerminal();
        stdin.pause?.();
      } catch (e) {
        err ??= e as Error;
      }
      if (err) reject(err);
      else resolve();
    }

    // A poll can race a writer mid-file; tolerate one bad read, fail on repeats.
    function guarded(fn: () => void): void {
      if (done) return;
      try {
        fn();
        failedPolls = 0;
      } catch (e) {
        if (++failedPolls >= 3) finish(e as Error);
      }
    }

    try {
      stdout.write(ENTER_SCREEN);
      stdin.setEncoding?.('utf8');
      stdin.setRawMode?.(true);
      stdin.resume?.();
      stdin.on('data', onData);
      stdout.on?.('resize', onResize);
      if (o.handleProcessSignals) {
        process.on('SIGTERM', onSigterm);
        process.on('SIGWINCH', onResize);
        process.on('uncaughtException', onUncaught);
        process.on('exit', onExit);
      }
      draw();
      timer = setInterval(() => guarded(draw), pollMs);
    } catch (e) {
      finish(e as Error);
    }
  });
}
