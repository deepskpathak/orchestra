// `orchestra` command line. Thin layer over conductor / evolve / render.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeRunner, preflight, type Runner } from './agent.ts';
import { importGrades, readBenchRows, renderCalibration, storeCalibration, writeSample } from './calibration.ts';
import { loadArms, summarize, renderSummary, runBench, verifyOracles } from './bench.ts';
import { runGoal } from './conductor.ts';
import { explorationMetrics, renderExploration } from './exploration.ts';
import { collectOutcomes, renderOutcomes } from './outcomes.ts';
import { evolutionDue, evolve, harvest, listEvals, metrics } from './evolve.ts';
import { fakeRunner } from './fake.ts';
import { excludeOrchestra } from './git.ts';
import { guardMain } from './guard.ts';
import { GLOBAL, listDomains, readLearnings } from './learnings.ts';
import { PACKAGE_ROOT, currentVersion, packageVersion, listVersions, promote, readArchive, seedHarness } from './harness.ts';
import { DEFAULT_PROJECT_CONFIG, Store, findRepoRoot } from './store.ts';
import { serve } from './web/server.ts';
import { startTui } from './tui/app.ts';
import { compactLine, renderDashboard, renderStats, renderStatusLine } from './tui/render.ts';
import type { Run } from './types.ts';

const HELP = `♫ orchestra: self-improving multi-agent software factory on Claude Code

Usage:
  orchestra init                 Set up .orchestra/ in the current git repo
  orchestra run "<goal>"         Plan, build, verify, merge, learn (live dashboard on a TTY)
      --detach                   Run in the background; follow with \`orchestra watch\`
      --no-evolve                Skip the automatic evolution check after the run
      --serve                    Also serve the web dashboard while the run is live
  orchestra serve [--port N]     Web dashboard on localhost (default 4317), read-only
  orchestra serve --tui [runId]  Interactive terminal dashboard (no browser, opens no port); alias: orchestra tui
  orchestra watch [runId]        Full-screen live dashboard (q to quit)
  orchestra status [runId]       One-shot board of the current or given run
  orchestra stats                Factory health per harness version, plus the eval infra failure rate
  orchestra evolve               Propose, evaluate (clean-room, interleaved), and maybe promote a better harness;
                                 prints the infra failure rate of the eval replays
  orchestra learnings [--domain <slug>]
                                 Show what the factory has learned (all, or one domain; "global" for cross-domain lessons)
  orchestra bench                Run the fixed benchmark suite: arms x goals x repeats, hidden checks, JSONL + summary
      --arms a,b --goals g1,g2 --repeats N   Choose arms (default bench/arms.json), goals and repeats per goal
      --suite <dir>              Use another suite directory (default: the bundled bench/)
      --report                   Summarise all stored bench results, with judge agreement and kappa per harness version
      --verify-oracles           Check that every goal's oracle passes its own hidden check (exit 1 otherwise)
  orchestra bench calibrate --sample N [--seed S]
                                 Write a stratified sample of verdicts (near-threshold and split votes oversampled) to
                                 .orchestra/bench/calibration/sample.jsonl for human grading
  orchestra bench calibrate --import <file>
                                 Import human grades (id + humanPass) and report human-judge kappa
  orchestra evals                List Factory Eval cases
  orchestra --version            Print the installed Orchestra version
  orchestra promote <vN>         Promote a harness version (also used for rollback)
  orchestra doctor               Check Claude CLI and headless auth
  orchestra demo                 Simulated run in a temp repo (no tokens spent)
  orchestra statusline           Statusline command for Claude Code (reads JSON on stdin)

Env: ORCHESTRA_RUNNER=fake uses the simulator instead of real Claude sessions.`;

function runner(): Runner {
  return process.env.ORCHESTRA_RUNNER === 'fake' ? fakeRunner({ stepMs: Number(process.env.ORCHESTRA_FAKE_STEP_MS ?? 150) }) : claudeRunner;
}

function storeOrDie(cwd = process.cwd()): Store {
  const root = findRepoRoot(cwd);
  if (!root) die('Not inside a git repository.');
  const store = new Store(root);
  if (!store.exists()) die('Orchestra is not initialised here. Run `orchestra init`.');
  return store;
}

function die(msg: string): never {
  process.stderr.write(`orchestra: ${msg}\n`);
  process.exit(1);
}

const isTTY = () => Boolean(process.stdout.isTTY);
const width = () => Math.min(process.stdout.columns || 100, 140);

// ---------- commands ----------

export function init(cwd = process.cwd(), quiet = false): Store {
  const root = findRepoRoot(cwd);
  if (!root || !existsSync(join(root, '.git'))) die('Run inside a git repository (git init first).');
  const store = new Store(root);
  if (!store.exists()) store.writeJson('config.json', { ...DEFAULT_PROJECT_CONFIG, testCommand: detectTestCommand(root) });
  seedHarness(store);
  excludeOrchestra(root);
  if (!quiet) {
    const cfg = store.config();
    console.log(`♫ orchestra initialised in ${root}/.orchestra`);
    console.log(`  harness      ${currentVersion(store)}`);
    console.log(`  test command ${cfg.testCommand ?? '(none detected; set testCommand in .orchestra/config.json)'}`);
    console.log(`  concurrency  ${cfg.concurrency}, run budget $${cfg.runBudgetUsd}`);
  }
  return store;
}

export function detectTestCommand(root: string): string | null {
  const has = (f: string) => existsSync(join(root, f));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return has('bun.lockb') || has('bun.lock') ? 'bun run test' : 'npm test --silent';
    } catch {
      return null;
    }
  }
  if (has('gradlew')) return './gradlew test --quiet';
  if (has('pom.xml')) return 'mvn -q test';
  if (has('deps.edn')) return 'clojure -X:test';
  if (has('project.clj')) return 'lein test';
  if (has('Cargo.toml')) return 'cargo test --quiet';
  if (has('go.mod')) return 'go test ./...';
  if (has('pyproject.toml') || has('pytest.ini')) return 'pytest -q';
  return null;
}

async function cmdRun(args: string[]): Promise<void> {
  const detach = args.includes('--detach');
  const noEvolve = args.includes('--no-evolve');
  const withWeb = args.includes('--serve');
  const goal = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!goal) die('Usage: orchestra run "<goal>"');
  const store = storeOrDie();

  if (detach) {
    const log = store.path('daemon.log');
    const fd = openSync(log, 'a');
    const child = spawn(process.execPath, [join(PACKAGE_ROOT, 'bin', 'orchestra.ts'), 'run', goal, ...(noEvolve ? ['--no-evolve'] : [])], {
      cwd: store.root,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.unref();
    console.log(`♫ orchestra run started in background (pid ${child.pid}).`);
    console.log(`  live dashboard: orchestra watch | orchestra serve    snapshot: orchestra status    log: ${log}`);
    return;
  }

  const web = withWeb ? await serve({ store }) : null;
  if (web) console.log(`♫ web dashboard: ${web.url}`);
  const r = runner();
  const live = isTTY() ? liveScreen() : null;
  let printed = 0;
  let latest: Run | null = null;
  const tick = setInterval(() => {
    if (!latest) return;
    if (live) live.draw(latest, store);
    else printed = printNewEvents(store, latest, printed);
  }, live ? 120 : 400);

  const run = await runGoal({ store, runner: r, goal, onUpdate: (u) => (latest = u) });
  clearInterval(tick);
  latest = run;
  if (live) live.close(run, store);
  else printNewEvents(store, run, printed);

  const c = harvest(store, run);
  if (c) console.log(`♫ harvested run into Factory Eval (${listEvals(store).length} cases)`);
  console.log(summary(run));
  await web?.close();

  if (!noEvolve && evolutionDue(store)) {
    console.log('♫ evolution due: improving the harness…');
    const out = await evolve(store, r, (m) => console.log(`  ${m}`));
    console.log(`♫ evolve: ${out.promoted ? `promoted ${out.candidate}` : `kept ${out.incumbent}`} (${out.reason})`);
  }
  process.exitCode = run.status === 'done' ? 0 : 1;
}

export function summary(run: Run): string {
  const merged = run.tasks.filter((t) => t.status === 'merged').length;
  const lines = [
    `♫ run ${run.id} ${run.status.toUpperCase()}: ${merged}/${run.tasks.length} tasks merged, satisfaction ${(run.satisfaction ?? 0).toFixed(2)}, cost $${run.costUsd.toFixed(2)}`,
  ];
  const human = run.tasks.filter((t) => t.status === 'needs_human');
  const failed = run.tasks.filter((t) => t.status === 'failed').length;
  const blocked = run.tasks.filter((t) => t.status === 'blocked').length;
  if (human.length || failed || blocked) lines.push(`  ${failed} failed, ${blocked} blocked, ${human.length} need a human`);
  for (const t of human) lines.push(`  ? ${t.id} needs a human: ${t.humanReason ?? 'no reason recorded'}`);
  if (run.error) lines.push(`  ${run.error}`);
  if (merged && run.integrationBranch) lines.push(`  review: git log --oneline ${run.baseRef?.slice(0, 8)}..${run.integrationBranch}`, `  land:   git merge ${run.integrationBranch}`);
  return lines.join('\n');
}

function printNewEvents(store: Store, run: Run, from: number): number {
  const evs = store.events(run.id);
  for (const e of evs.slice(from)) {
    const l = compactLine(e, run.startedAt);
    if (l) console.log(l);
  }
  return evs.length;
}

function liveScreen() {
  let frame = 0;
  process.stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
  const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.on('exit', restore);
  return {
    draw(run: Run, store: Store) {
      const out = renderDashboard(run, store.events(run.id), { width: width(), now: Date.now(), color: true, frame: frame++, maxEvents: 10 });
      process.stdout.write('\x1b[H\x1b[2J' + out + '\n');
    },
    close(run: Run, store: Store) {
      restore();
      process.removeListener('exit', restore);
      console.log(renderDashboard(run, store.events(run.id), { width: width(), now: Date.now(), color: true, frame: 0, maxEvents: 10 }));
    },
  };
}

function resolveRun(store: Store, id?: string): Run | null {
  const rid = id ?? store.currentRunId();
  return rid ? store.loadRun(rid) : null;
}

async function cmdWatch(args: string[]): Promise<void> {
  const store = storeOrDie();
  const id = args[0];
  let frame = 0;
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const quit = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.exit(0);
  };
  process.on('SIGINT', quit);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      const k = d.toString();
      if (k === 'q' || k === '\x03') quit();
    });
  }
  const draw = () => {
    const run = resolveRun(store, id);
    const body = run
      ? renderDashboard(run, store.events(run.id), { width: width(), now: Date.now(), color: true, frame: frame++, maxEvents: Math.max(6, (process.stdout.rows || 40) - 22 - (run.tasks.length + run.active.length)) })
      : renderStats(metrics(store), readArchive(store), currentVersion(store), true) + '\n\nNo run yet. Start one with: orchestra run "<goal>"';
    process.stdout.write('\x1b[H\x1b[2J' + body + '\n\x1b[90m  q to quit · refreshing live\x1b[0m');
  };
  draw();
  setInterval(draw, 150);
}

async function cmdTui(args: string[]): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    die('the terminal dashboard needs an interactive terminal (stdin and stdout must be a TTY). Use `orchestra status` for a one-shot board or `orchestra watch` for a live view.');
  }
  const store = storeOrDie();
  const runId = args.find((a) => !a.startsWith('--'));
  if (runId && !store.loadRun(runId)) die(`unknown run "${runId}".`);
  try {
    await startTui({ store, stdin: process.stdin, stdout: process.stdout, runId, handleProcessSignals: true });
  } catch (e) {
    die(`terminal dashboard failed: ${(e as Error).message}`);
  }
  process.exit(0);
}

async function cmdServe(args: string[]): Promise<void> {
  if (args.includes('--tui')) return cmdTui(args.filter((a) => a !== '--tui'));
  const store = storeOrDie();
  const i = args.indexOf('--port');
  const port = i >= 0 ? Number(args[i + 1]) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) die('Usage: orchestra serve [--port N]');
  const web = await serve({ store, port });
  console.log(`♫ orchestra dashboard: ${web.url}  (read-only, 127.0.0.1 only, ctrl-c to stop)`);
  process.on('SIGINT', () => void web.close().then(() => process.exit(0)));
}

function cmdStatus(args: string[]): void {
  const store = storeOrDie();
  const color = args.includes('--color') || (isTTY() && !args.includes('--plain'));
  const run = resolveRun(store, args.find((a) => !a.startsWith('--')));
  if (!run) {
    console.log(`♫ orchestra idle · harness ${currentVersion(store)} · no runs yet`);
    return;
  }
  console.log(renderDashboard(run, store.events(run.id), { width: width(), now: Date.now(), color, frame: Math.floor(Date.now() / 120), maxEvents: 12 }));
}

function cmdStats(args: string[]): void {
  const store = storeOrDie();
  const color = args.includes('--color') || (isTTY() && !args.includes('--plain'));
  console.log(renderStats(metrics(store), readArchive(store), currentVersion(store), color));
  console.log(`\nFactory Eval cases: ${listEvals(store).length}   versions: ${listVersions(store).join(', ')}`);
  const rates = readArchive(store).filter((a) => a.evalInfraRate !== undefined);
  if (rates.length) console.log(`Eval infra failure rate: ${rates.map((a) => `${a.version} ${(a.evalInfraRate! * 100).toFixed(0)}%`).join('   ')}`);
  console.log(`\n${renderOutcomes(collectOutcomes(store))}`);
  console.log(`\n${renderExploration(explorationMetrics(store.ledgerRows()))}`);
  console.log(`\n${renderCalibration(storeCalibration(store))}`);
}

async function cmdEvolve(): Promise<void> {
  const store = storeOrDie();
  const out = await evolve(store, runner(), (m) => console.log(`♫ ${m}`));
  console.log(`♫ ${out.promoted ? `PROMOTED ${out.candidate}` : `kept ${out.incumbent}`}: ${out.reason}`);
  if (out.candidateScore !== null) console.log(`  eval: ${out.incumbent} ${out.incumbentScore} vs ${out.candidate} ${out.candidateScore}`);
  if (out.monitorFireRate) console.log(`  integrity monitor fire rate (flags per run): ${out.incumbent} ${out.monitorFireRate.incumbent.toFixed(2)}, ${out.candidate} ${out.monitorFireRate.candidate.toFixed(2)}`);
  if (out.infraFailureRate) console.log(`  infra failure rate: ${out.incumbent} ${(out.infraFailureRate.incumbent * 100).toFixed(0)}%, ${out.candidate} ${(out.infraFailureRate.candidate * 100).toFixed(0)}%`);
}

function cmdLearnings(args: string[]): void {
  const store = storeOrDie();
  const i = args.indexOf('--domain');
  if (i < 0) {
    console.log(store.readText('learnings.md', 'No learnings yet. They appear after the first completed run.'));
    return;
  }
  const domain = args[i + 1];
  if (!domain || domain.startsWith('--')) die('--domain needs a value, e.g. `orchestra learnings --domain cli`.');
  const known = listDomains(store);
  if (domain !== GLOBAL && domain !== 'global' && !known.includes(domain)) {
    die(`Unknown domain "${domain}". Known domains: ${['global', ...known].join(', ')}`);
  }
  const lessons = readLearnings(store, domain === 'global' ? GLOBAL : domain);
  if (!lessons.length) {
    console.log(`No learnings yet for domain ${domain}.`);
    return;
  }
  console.log(`## ${domain}\n`);
  for (const l of lessons) {
    const ev = l.evidence.map((e) => (e.task ? `${e.run}/${e.task}` : e.run)).join(', ');
    console.log(`- [${l.role}] ${l.lesson}\n  evidence: ${ev}; hits: ${l.hits}`);
  }
}

function cmdEvals(): void {
  const store = storeOrDie();
  const cases = listEvals(store);
  if (!cases.length) console.log('No Factory Eval cases yet. Runs with satisfaction >= 0.8 are harvested automatically.');
  for (const c of cases) console.log(`${c.id}  base ${c.base.slice(0, 8)}  check ${c.check ?? '-'}\n  ${c.goal}`);
}

function cmdPromote(args: string[]): void {
  const store = storeOrDie();
  if (!args[0]) die('Usage: orchestra promote <vN>');
  promote(store, args[0]);
  console.log(`♫ harness ${args[0]} is now current`);
}

function cmdDoctor(): void {
  const p = preflight();
  console.log(`${p.ok ? '✓' : '✗'} ${p.detail}`);
  if (!p.ok) console.log('  Fix: run `claude` in a terminal and use /login, then retry. Or use ORCHESTRA_RUNNER=fake to try the simulator.');
  const root = findRepoRoot(process.cwd());
  const store = root ? new Store(root) : null;
  console.log(`${store?.exists() ? '✓' : '·'} ${store?.exists() ? `initialised at ${store.dir}` : 'not initialised in this repo (orchestra init)'}`);
  process.exitCode = p.ok ? 0 : 1;
}

async function cmdStatusline(): Promise<void> {
  let raw = '';
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) raw += chunk;
  let cwd = process.cwd();
  try {
    const j = JSON.parse(raw || '{}');
    cwd = j.workspace?.current_dir ?? j.cwd ?? cwd;
  } catch {
    // Statusline must never crash the UI; fall back to process cwd.
  }
  const root = findRepoRoot(cwd);
  const store = root ? new Store(root) : null;
  if (!store?.exists()) {
    console.log('\x1b[90m♫ orchestra off\x1b[0m');
    return;
  }
  const run = resolveRun(store);
  console.log(renderStatusLine(run, { harness: currentVersion(store), color: true, frame: Math.floor(Date.now() / 1000) }));
}

async function cmdDemo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-demo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@localhost', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@localhost', 'commit', '-qm', 'init'], { cwd: dir });
  const store = init(dir, true);
  store.writeJson('config.json', { ...store.config(), evolve: { ...store.config().evolve, every: 1, sample: 1 } });
  process.env.GIT_AUTHOR_NAME ??= 'demo';
  process.env.GIT_AUTHOR_EMAIL ??= 'demo@localhost';
  process.env.GIT_COMMITTER_NAME ??= 'demo';
  process.env.GIT_COMMITTER_EMAIL ??= 'demo@localhost';
  process.env.ORCHESTRA_RUNNER = 'fake';
  process.env.ORCHESTRA_FAKE_STEP_MS ??= '350';
  process.chdir(dir);
  console.log(`♫ demo repo: ${dir}`);
  await cmdRun(['Build a tiny CLI with config loading and docs']);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cmdBench(args: string[]): Promise<void> {
  const suite = flag(args, '--suite');
  const goals = flag(args, '--goals')?.split(',').filter(Boolean);
  if (args.includes('--verify-oracles')) {
    const results = verifyOracles(suite, goals);
    for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.goal}: ${r.detail}`);
    const bad = results.filter((r) => !r.ok);
    if (bad.length) die(`oracle check failed for ${bad.map((r) => r.goal).join(', ')}`);
    if (!results.length) die('no bench goals found');
    console.log(`\n${results.length} oracle(s) pass their hidden checks.`);
    return;
  }
  if (args[0] === 'calibrate') {
    const store = storeOrDie();
    const imp = flag(args, '--import');
    if (imp) {
      if (!existsSync(imp)) die(`grades file not found: ${imp}`);
      const r = importGrades(store, imp);
      console.log(`imported ${r.imported} human grade(s) (${r.total} total)\n\n${renderCalibration(storeCalibration(store))}`);
      return;
    }
    const size = Number(flag(args, '--sample') ?? 50);
    if (!Number.isInteger(size) || size < 1) die('--sample must be a positive integer');
    const seed = Number(flag(args, '--seed') ?? 1);
    const { file, items } = writeSample(store, size, seed);
    if (!items.length) die('no bench results yet; run `orchestra bench` first');
    console.log(`wrote ${items.length} verdict(s) to ${file}\nSet humanPass to true or false on each line, then run: orchestra bench calibrate --import <file>`);
    return;
  }
  if (args.includes('--report')) {
    const store = storeOrDie();
    const rows = readBenchRows(store);
    if (rows.length) console.log(`${renderSummary(summarize(rows))}\n`);
    console.log(renderCalibration(storeCalibration(store)));
    return;
  }
  const store = storeOrDie();
  const repeats = Number(flag(args, '--repeats') ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1) die('--repeats must be a positive integer');
  const arms = loadArms(suite, flag(args, '--arms')?.split(',').filter(Boolean));
  const res = await runBench({ store, runner: runner(), suite, arms, goals, repeats, onRow: (r) => console.log(`${r.arm} ${r.goal} #${r.repeat}: ${r.checkPass ? 'pass' : 'fail'} ($${r.costUsd.toFixed(3)})`) });
  console.log(`\n${renderSummary(res.summary)}`);
  console.log(`\nresults: ${join(res.dir, 'results.jsonl')}\nsummary: ${join(res.dir, 'summary.json')}`);
}

// ---------- entry ----------

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'init':
      init();
      break;
    case 'run':
      await cmdRun(args);
      break;
    case 'watch':
      await cmdWatch(args);
      break;
    case 'serve':
      await cmdServe(args);
      break;
    case 'tui':
      await cmdTui(args);
      break;
    case 'status':
      cmdStatus(args);
      break;
    case 'stats':
      cmdStats(args);
      break;
    case 'evolve':
      await cmdEvolve();
      break;
    case 'learnings':
      cmdLearnings(args);
      break;
    case 'bench':
      await cmdBench(args);
      break;
    case 'evals':
      cmdEvals();
      break;
    case 'promote':
      cmdPromote(args);
      break;
    case 'doctor':
      cmdDoctor();
      break;
    case 'demo':
      await cmdDemo();
      break;
    case 'statusline':
      await cmdStatusline();
      break;
    case 'guard':
      await guardMain();
      break;
    case '-v':
    case '--version':
      console.log(packageVersion());
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      break;
    default:
      die(`unknown command "${cmd}". See orchestra --help`);
  }
}
