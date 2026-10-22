// Read-only local web dashboard. Same source of truth as the TUI: run.json + events.jsonl.
// No dependencies, no outbound calls. Binds to loopback only and rejects foreign Host
// headers so a web page cannot reach it through DNS rebinding.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { git } from '../git.ts';
import { currentVersion, loadHarness } from '../harness.ts';
import type { Store } from '../store.ts';
import type { Run } from '../types.ts';
import { PAGE } from './page.ts';

// Bump when the /api payload shape changes incompatibly.
export const API_SCHEMA = 1;

export const DEFAULT_PORT = 4317;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,32}$/;
const POLL_MS = 250;
const LOG_TAIL_BYTES = 40_000;

export interface ServeOpts {
  store: Store;
  port?: number;
  host?: string;
}

export interface Serving {
  server: Server;
  url: string;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function listRunSummaries(store: Store) {
  return store
    .listRuns()
    .reverse()
    .map((id) => store.loadRun(id))
    .filter((r): r is Run => Boolean(r))
    .map((r) => ({
      id: r.id,
      goal: r.goal,
      status: r.status,
      kind: r.kind,
      harness: r.harness,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      costUsd: r.costUsd,
      satisfaction: r.satisfaction ?? null,
      tasks: r.tasks.length,
      merged: r.tasks.filter((t) => t.status === 'merged').length,
    }));
}

// Retry and pass limits of the current harness, so the board can show "try 2 of 3" and the pass line.
function harnessLimits(store: Store): { maxAttempts?: number; passThreshold?: number } {
  try {
    const { maxAttempts, passThreshold } = loadHarness(store).config;
    return { maxAttempts, passThreshold };
  } catch {
    return {}; // harness missing or unreadable: the page simply omits these
  }
}

// Task detail: verdict is already in run.json; add the branch diff and the tail of each agent log.
function taskDetail(store: Store, runId: string, taskId: string) {
  const run = store.loadRun(runId);
  const task = run?.tasks.find((t) => t.id === taskId);
  if (!run || !task) return null;
  let diff: string | null = null;
  if (task.branch && run.baseRef) {
    try {
      diff = git(store.root, 'diff', '--stat', '--patch', `${run.baseRef}...${task.branch}`).slice(0, 60_000);
    } catch {
      diff = null; // branch pruned after merge, or ref unknown
    }
  }
  const logDir = store.path('runs', runId, 'logs');
  const logs: { name: string; tail: string }[] = [];
  if (existsSync(logDir)) {
    for (const name of readdirSync(logDir).filter((f) => f.startsWith(`${taskId}-`)).sort()) {
      const text = readFileSync(`${logDir}/${name}`, 'utf8');
      logs.push({ name, tail: text.slice(-LOG_TAIL_BYTES) });
    }
  }
  return { schema: API_SCHEMA, task, diff, logs };
}

function stream(store: Store, runId: string, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  let sent = 0;
  let lastRun = '';
  const push = () => {
    const run = store.loadRun(runId);
    if (!run) return;
    const events = store.events(runId);
    const runJson = JSON.stringify(run);
    if (runJson === lastRun && events.length === sent) return;
    const fresh = events.slice(sent);
    // Full reset when the log shrank (should not happen, but a stale client must not drift).
    const reset = events.length < sent;
    res.write(`data: ${JSON.stringify({ schema: API_SCHEMA, run, events: reset ? events : fresh, reset: reset || sent === 0, total: events.length })}\n\n`);
    sent = events.length;
    lastRun = runJson;
  };
  push();
  const timer = setInterval(() => {
    try {
      push();
    } catch (err) {
      // Corrupt run.json mid-write is already guarded by atomic rename; anything else is worth surfacing.
      res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
    }
  }, POLL_MS);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(ping);
  });
}

export function handler(store: Store) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req)) return json(res, 403, { error: 'forbidden host' });
    if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length === 0) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(PAGE);
    }
    if (parts[0] !== 'api') return json(res, 404, { error: 'not found' });

    try {
      if (parts[1] === 'info' && parts.length === 2) {
        return json(res, 200, { schema: API_SCHEMA, harness: currentVersion(store), current: store.currentRunId(), repo: store.root, ...harnessLimits(store) });
      }
      if (parts[1] === 'runs' && parts.length === 2) return json(res, 200, { schema: API_SCHEMA, runs: listRunSummaries(store) });
      if (parts[1] === 'runs' && parts[2] && RUN_ID.test(parts[2])) {
        const runId = parts[2];
        if (!store.loadRun(runId)) return json(res, 404, { error: 'unknown run' });
        if (parts[3] === 'stream') return stream(store, runId, req, res);
        if (parts[3] === 'tasks' && parts[4] && TASK_ID.test(parts[4])) {
          const d = taskDetail(store, runId, parts[4]);
          return d ? json(res, 200, d) : json(res, 404, { error: 'unknown task' });
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  };
}

export async function serve(opts: ServeOpts): Promise<Serving> {
  const host = opts.host ?? '127.0.0.1';
  const first = opts.port ?? DEFAULT_PORT;
  // Try a few consecutive ports so a second repo's dashboard does not collide with the first.
  for (let port = first; port < first + 10; port++) {
    const server = createServer(handler(opts.store));
    const ok = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err)));
      server.listen(port, host, () => resolve(true));
    });
    if (ok) {
      return { server, url: `http://localhost:${port}`, close: () => new Promise((r) => {
          server.close(() => r());
          server.closeAllConnections(); // open SSE streams would otherwise keep close() pending
        }),
      };
    }
  }
  throw new Error(`No free port in ${first}..${first + 9}`);
}
