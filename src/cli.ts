// `orchestra` command line. Thin layer over conductor / evolve / render.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeRunner, preflight, type Runner } from './agent.ts';
import { importGrades, readBenchRows, renderCalibration, storeCalibration, writeSample } from './calibration.ts';
import { ABLATION_ARMS, SINGLE_SESSION_ARM, ablationTable, defaultReference, loadArms, referenceError, renderAblationTable, summarize, renderSummary, runBench, verifyOracles } from './bench.ts';
import { atlasStats, loadOrBuildAtlas } from './atlas.ts';
import { runGoal } from './conductor.ts';
import { explorationMetrics, renderExploration } from './exploration.ts';
import { collectOutcomes, renderOutcomes } from './outcomes.ts';
import { evaluate, evolutionDue, evolve, harvest, listEvals, metrics, resolveSplits } from './evolve.ts';
import { DEFAULT_RATIOS } from './evalsets.ts';
import { REGRESSION_TAG, auditCases, buildAddedCase, buildHarvestedCase, filterByTags, formatFindings } from './evalcases.ts';
import { fakeRunner } from './fake.ts';
import { commitExists, excludeOrchestra, fixDiff, tryGit } from './git.ts';
import { guardMain } from './guard.ts';
import { GLOBAL, lessonAblation, listDomains, readAllLearnings, readLearnings } from './learnings.ts';
import { validNetwork } from './container.ts';
import { detectSandbox, type SandboxBackend } from './sandbox.ts';
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
      --sandbox auto|srt|claude|off
                                 OS-sandbox workers (writes only to the worktree and temp, no credential reads,
                                 network limited to the model API plus sandbox.allowedHosts). Default off
      --sandbox docker           Opt-in container backend for untrusted repos: docker run --rm --network=none.
                                 Needs docker; --network=none also blocks the model API (see docs/isolation.md)
      --sandbox-image <image>    Image for --sandbox docker (default orchestra-worker:latest; must contain claude)
      --sandbox-network <net>    Docker network for --sandbox docker (default none, which also blocks the model API)
      --gvisor                   With --sandbox docker, add --runtime=runsc
      --unattended               Refuse to start unless a sandbox backend (srt, bwrap+socat or sandbox-exec) is
                                 available; strips push and publish tokens from agent env
  orchestra serve [--port N]     Web dashboard on localhost (default 4317), read-only
  orchestra serve --tui [runId]  Interactive terminal dashboard (no browser, opens no port); alias: orchestra tui
  orchestra watch [runId]        Full-screen live dashboard (q to quit)
  orchestra status [runId]       One-shot board of the current or given run
  orchestra stats                Factory health per harness version, plus the eval infra failure rate
  orchestra evolve               Propose, evaluate (clean-room, interleaved), and maybe promote a better harness;
                                 prints the infra failure rate of the eval replays
  orchestra learnings [--domain <slug>]
                                 Show what the factory has learned (all, or one domain; "global" for cross-domain lessons)
  orchestra atlas build          Build or incrementally refresh the Repo Atlas code graph for HEAD (.orchestra/atlas/<sha>.json)
  orchestra atlas stats          Show file, symbol and edge counts of the atlas for HEAD (builds it if missing)
                                 Both work regardless of context.atlas.enabled; the atlas never indexes .orchestra/, .env* or secrets
  orchestra bench                Run the fixed benchmark suite: arms x goals x repeats, hidden checks, JSONL + summary
      --arms a,b --goals g1,g2 --repeats N   Choose arms (default bench/arms.json), goals and repeats per goal
      --suite <dir>              Use another suite directory (default: the bundled bench/)
      --ablations                Run the built-in arms full, -scenarios, -repair, -learnings, -contrastive, -evolver plus a matched-cost single-session baseline
      --reference <arm>          Reference arm for the paired table (default full, else the first arm run); also applies to --report
      --report                   Summarise all stored bench results, with judge agreement and kappa per harness version
      --verify-oracles           Check that every goal's oracle passes its own hidden check (exit 1 otherwise)
  orchestra bench calibrate --sample N [--seed S]
                                 Write a stratified sample of verdicts (near-threshold and split votes oversampled) to
                                 .orchestra/bench/calibration/sample.jsonl for human grading
  orchestra bench calibrate --import <file>
                                 Import human grades (id + humanPass) and report human-judge kappa
  orchestra evals [list]         List Factory Eval cases (--regression or --tag <t> to filter)
  orchestra evals add "<goal>"   Add a case: --base <ref> (default HEAD) --check <cmd> --id <id> --tag <t> --regression --reference <ref>
  orchestra evals add --from-run <runId> --fix <commit>
                                 Harvest a failed or low-satisfaction goal; the human fix (diff base..commit) becomes the reference
  orchestra evals audit          Scan cases and lessons for solution leakage (exit 1 with findings; 0 when clean, empty or uninitialised)
  orchestra evals ablation       Replay the locked holdout with and without learnings and report the paired delta and CI
  orchestra --version            Print the installed Orchestra version
  orchestra promote <vN>         Promote a harness version (also used for rollback)
  orchestra doctor               Check Claude CLI and headless auth
  orchestra demo                 Simulated run in a temp repo (no tokens spent)
  orchestra statusline           Statusline command for Claude Code (reads JSON on stdin)

Env: ORCHESTRA_RUNNER=fake uses the simulator instead of real Claude sessions.
     ORCHESTRA_SANDBOX_DETECT=none|srt|claude|docker overrides sandbox detection (tests and CI).`;

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

const SANDBOX_MODES = ['auto', 'srt', 'claude', 'docker', 'off'];

interface SandboxProbe {
  backend: SandboxBackend; // what `auto` would pick
  srt: boolean;
  claude: boolean; // Claude Code's built-in sandbox can run
  docker?: boolean; // docker CLI is on PATH (only used by --sandbox docker, never by auto)
  reason: string;
}

// ORCHESTRA_SANDBOX_DETECT=none|srt|claude is a test and CI hook that replaces probing the machine.
export function probeSandbox(env: Record<string, string | undefined> = process.env): SandboxProbe {
  const forced = env.ORCHESTRA_SANDBOX_DETECT;
  if (forced === 'docker') return { backend: 'none', srt: false, claude: false, docker: true, reason: 'ORCHESTRA_SANDBOX_DETECT=docker' };
  if (forced === 'none') return { backend: 'none', srt: false, claude: false, reason: 'ORCHESTRA_SANDBOX_DETECT=none' };
  if (forced === 'srt') return { backend: 'srt', srt: true, claude: false, reason: 'ORCHESTRA_SANDBOX_DETECT=srt' };
  if (forced === 'claude') return { backend: 'claude', srt: false, claude: true, reason: 'ORCHESTRA_SANDBOX_DETECT=claude' };
  const which = (c: string) => spawnSync('which', [c], { stdio: 'ignore' }).status === 0;
  const d = detectSandbox({ platform: process.platform, which });
  const claude = process.platform === 'darwin' ? d.available.includes('sandbox-exec') : d.available.includes('bwrap') && d.available.includes('socat');
  return { backend: d.backend, srt: d.available.includes('srt'), claude, docker: which('docker'), reason: d.reason };
}

// Resolves --sandbox / --unattended into the conductor option. Dies (exit 1) before any agent call
// when a requested backend is missing or unattended mode has nothing to confine workers with.
export function resolveSandbox(
  args: string[],
  probe: SandboxProbe = probeSandbox(),
): { backend: 'srt' | 'claude' | 'docker' | null; unattended: boolean; image?: string; gvisor?: boolean; network?: string } {
  const unattended = args.includes('--unattended');
  const mode = flag(args, '--sandbox') ?? (unattended ? 'auto' : 'off');
  if (!SANDBOX_MODES.includes(mode)) die(`--sandbox must be one of: ${SANDBOX_MODES.join(', ')} (got "${mode}")`);
  const need = 'Install srt (sandbox-runtime), or bwrap and socat (Linux), or use macOS sandbox-exec';
  if (unattended && mode === 'off') die(`--unattended needs a sandbox, but --sandbox is off. ${need}.`);
  if (mode === 'off') return { backend: null, unattended };
  if (mode === 'docker') {
    if (!probe.docker) die('--sandbox docker requested but docker was not found on PATH. Install docker (or use --sandbox srt|claude).');
    const network = flag(args, '--sandbox-network');
    if (network !== undefined && !validNetwork(network)) die(`--sandbox-network must be a docker network name or mode (got "${network}")`);
    return { backend: 'docker', unattended, image: flag(args, '--sandbox-image'), gvisor: args.includes('--gvisor'), ...(network !== undefined ? { network } : {}) };
  }
  if (mode === 'srt' || mode === 'claude') {
    if (!(mode === 'srt' ? probe.srt : probe.claude)) die(`--sandbox ${mode} requested but it is not available (${probe.reason}). ${need}.`);
    return { backend: mode, unattended };
  }
  if (probe.backend === 'none') {
    if (unattended) die(`--unattended refuses to start without a sandbox backend (${probe.reason}). ${need}.`);
    console.error(`orchestra: warning: --sandbox auto found no backend (${probe.reason}); workers run unsandboxed.`);
    return { backend: null, unattended };
  }
  return { backend: probe.backend, unattended };
}

// Positionals that make up the goal. The value-taking flags are removed together with their value by
// position, so a goal word that happens to equal a flag value ("turn off the cache --sandbox off") stays.
export function goalFromArgs(args: string[]): string {
  const valueFlags = new Set(['--sandbox', '--sandbox-image', '--sandbox-network']);
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) i++;
    else if (!args[i].startsWith('--')) words.push(args[i]);
  }
  return words.join(' ').trim();
}

async function cmdRun(args: string[]): Promise<void> {
  const detach = args.includes('--detach');
  const noEvolve = args.includes('--no-evolve');
  const withWeb = args.includes('--serve');
  const sandboxVal = flag(args, '--sandbox');
  const imageVal = flag(args, '--sandbox-image');
  const networkVal = flag(args, '--sandbox-network');
  const goal = goalFromArgs(args);
  if (!goal) die('Usage: orchestra run "<goal>"');
  const store = storeOrDie();
  const iso = resolveSandbox(args);

  if (detach) {
    const log = store.path('daemon.log');
    const fd = openSync(log, 'a');
    const child = spawn(process.execPath, [join(PACKAGE_ROOT, 'bin', 'orchestra.ts'), 'run', goal, ...(noEvolve ? ['--no-evolve'] : []), ...(sandboxVal ? ['--sandbox', sandboxVal] : []), ...(imageVal ? ['--sandbox-image', imageVal] : []), ...(networkVal ? ['--sandbox-network', networkVal] : []), ...(args.includes('--gvisor') ? ['--gvisor'] : []), ...(iso.unattended ? ['--unattended'] : [])], {
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

  const run = await runGoal({
    store,
    runner: r,
    goal,
    onUpdate: (u) => (latest = u),
    sandbox: iso.backend ? { backend: iso.backend, allowedHosts: store.config().sandbox?.allowedHosts, image: iso.image, gvisor: iso.gvisor, network: iso.network } : undefined,
    unattended: iso.unattended,
  });
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
  if (run.mutation) lines.push(`  mutation score ${run.mutation.score.toFixed(2)} (${run.mutation.killed}/${run.mutation.total} killed, floor ${run.mutation.floor}, ${run.mutation.pass ? 'pass' : 'below floor'})`);
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

const ATLAS_USAGE = 'Usage: orchestra atlas build | orchestra atlas stats';

function cmdAtlas(args: string[]): void {
  const sub = args[0];
  if (sub !== 'build' && sub !== 'stats') die(sub ? `unknown atlas subcommand "${sub}". ${ATLAS_USAGE}` : ATLAS_USAGE);
  const root = findRepoRoot(process.cwd());
  if (!root) die('Not inside a git repository.');
  let sha: string;
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    die('No commits yet. Commit something first; the atlas is keyed by commit.');
  }
  const atlas = loadOrBuildAtlas(root, sha);
  const st = atlasStats(atlas);
  const edges = Object.entries(st.edges).map(([k, n]) => `${k} ${n}`).join(', ');
  if (sub === 'build') {
    console.log(`♫ atlas ${join(root, '.orchestra', 'atlas', `${atlas.sha}.json`)}`);
    console.log(`  ${st.files} files, ${st.symbols} symbols, ${edges}`);
    return;
  }
  console.log(`atlas for ${atlas.sha.slice(0, 8)}`);
  console.log(`  files    ${st.files}`);
  console.log(`  symbols  ${st.symbols}`);
  console.log(`  dirs     ${st.dirs}`);
  console.log(`  edges    ${edges}`);
  const langs = Object.entries(st.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ');
  console.log(`  languages ${langs || '(none)'}`);
}

const EVALS_SUBCOMMANDS = ['list', 'add', 'harvest', 'audit', 'ablation'];

// `--flag value` and bare `--flag` parsing for the evals subcommands; positionals are returned in order.
function parseEvalsArgs(args: string[], valued: string[]): { flags: Map<string, string[]>; positional: string[] } {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (valued.includes(name)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) die(`--${name} needs a value`);
      flags.set(name, [...(flags.get(name) ?? []), v]);
    } else flags.set(name, [...(flags.get(name) ?? []), '']);
  }
  return { flags, positional };
}

async function cmdEvalsRouter(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub.startsWith('--')) return cmdEvals(args);
  switch (sub) {
    case 'list': return cmdEvals(args.slice(1));
    case 'add':
    case 'harvest': return cmdEvalsAdd(args.slice(1), sub === 'harvest');
    case 'audit': return cmdEvalsAudit();
    case 'ablation': return cmdEvalsAblation();
    default: die(`unknown evals subcommand "${sub}". Known: ${EVALS_SUBCOMMANDS.join(', ')}`);
  }
}

function cmdEvals(args: string[]): void {
  const store = storeOrDie();
  const { flags } = parseEvalsArgs(args, ['tag']);
  for (const f of flags.keys()) if (f !== 'tag' && f !== 'regression') die(`unknown option --${f} for evals list. Known: --tag <t>, --regression`);
  const tags = [...(flags.get('tag') ?? []), ...(flags.has('regression') ? [REGRESSION_TAG] : [])];
  const all = listEvals(store);
  const cases = filterByTags(all, tags);
  if (!all.length) console.log('No Factory Eval cases yet. Runs with satisfaction >= 0.8 are harvested automatically; add your own with `orchestra evals add "<goal>"`.');
  else if (!cases.length) console.log(`No Factory Eval cases tagged ${tags.join(', ')}.`);
  for (const c of cases) console.log(`${c.id}  base ${c.base.slice(0, 8)}  check ${c.check ?? '-'}${c.tags?.length ? `  tags ${c.tags.join(',')}` : ''}\n  ${c.goal}`);
}

// add "<goal>" [--base ref] [--check cmd] [--id id] [--tag t] [--regression] [--reference ref]
// add --from-run <runId> --fix <commit>   (human-fix harvest; `harvest` is an alias)
function cmdEvalsAdd(args: string[], harvestAlias: boolean): void {
  const store = storeOrDie();
  const { flags, positional } = parseEvalsArgs(args, ['base', 'check', 'id', 'tag', 'reference', 'from-run', 'fix']);
  const known = ['base', 'check', 'id', 'tag', 'reference', 'from-run', 'fix', 'regression'];
  for (const f of flags.keys()) if (!known.includes(f)) die(`unknown option --${f} for evals add`);
  const one = (n: string) => flags.get(n)?.[flags.get(n)!.length - 1];
  const root = store.root;
  const existing = listEvals(store).map((c) => c.id);
  const fromRun = one('from-run');
  const fix = one('fix');
  let c;
  try {
    if (fromRun || fix || harvestAlias) {
      if (!fromRun || !fix) die('Harvest needs both --from-run <runId> and --fix <commit>');
      if (positional.length) die('Harvest takes no goal; the goal comes from the run');
      const run = store.loadRun(fromRun);
      if (!run) die(`No run ${fromRun} in this repo`);
      if (!commitExists(root, fix)) die(`Fix commit "${fix}" does not exist in this repo`);
      c = buildHarvestedCase(run, fix, (b, f) => fixDiff(root, b, f), store.config().testCommand, existing, Date.now());
    } else {
      const goal = positional.join(' ');
      const baseRef = one('base') ?? 'HEAD';
      const resolved = tryGit(root, 'rev-parse', '--verify', `${baseRef}^{commit}`);
      if (!resolved.ok) die(`Base "${baseRef}" is not a commit in this repo`);
      c = buildAddedCase({ goal, base: resolved.out, check: one('check') ?? store.config().testCommand ?? null, id: one('id'), tags: flags.get('tag'), regression: flags.has('regression'), reference: one('reference') }, existing, Date.now());
    }
  } catch (err) {
    die((err as Error).message);
  }
  const leaks = auditCases([c]);
  if (leaks.length) die(`Refusing to add ${c.id}: it leaks its own solution.\n${formatFindings(leaks)}`);
  store.writeJson(`evals/${c.id}.json`, c);
  console.log(`♫ added eval case ${c.id}  base ${c.base.slice(0, 8)}${c.tags?.length ? `  tags ${c.tags.join(',')}` : ''}`);
}

// Solution-leakage audit over the case set and the learnings. Exit 0 when clean, empty or not initialised
// (CI runs this in a fresh checkout where .orchestra does not exist); exit 1 with the findings listed.
function cmdEvalsAudit(): void {
  const root = findRepoRoot(process.cwd());
  const store = root ? new Store(root) : null;
  if (!store?.exists()) {
    console.log('Orchestra is not initialised here, so there are no eval cases to audit. Nothing to do (exit 0).');
    return;
  }
  const cases = listEvals(store);
  if (!cases.length) {
    console.log('No eval cases to audit.');
    return;
  }
  const lessons = Object.values(readAllLearnings(store)).flat();
  const findings = auditCases(cases, lessons);
  if (!findings.length) {
    console.log(`Audited ${cases.length} eval case${cases.length === 1 ? '' : 's'} and ${lessons.length} lesson${lessons.length === 1 ? '' : 's'}: no solution leakage found.`);
    return;
  }
  console.log(`Solution leakage found in ${new Set(findings.map((f) => f.caseId)).size} of ${cases.length} eval cases:\n${formatFindings(findings)}`);
  process.exitCode = 1;
}

// With-lessons versus without-lessons on the locked holdout. Costs two replays per holdout case.
async function cmdEvalsAblation(): Promise<void> {
  const store = storeOrDie();
  const cfg = store.config().evolve.splits;
  const { holdout } = resolveSplits(store, listEvals(store), cfg ? { feedback: cfg.feedback, validation: cfg.validation, holdout: cfg.holdout } : DEFAULT_RATIOS);
  if (!holdout.length) {
    console.log('No holdout cases yet, so there is nothing to ablate. Harvested evals fill the holdout over time (orchestra evals).');
    return;
  }
  const version = currentVersion(store);
  const run = runner();
  const score = async (c: (typeof holdout)[number], learnings: boolean): Promise<number> => {
    const r = await evaluate(store, run, version, [c], undefined, undefined, { learnings });
    if (r.inconclusive) die(`Ablation stopped on ${c.id}: ${r.inconclusive}`);
    return r.detail[c.id] ?? 0;
  };
  const res = await lessonAblation((c) => score(holdout.find((h) => h.id === c.id)!, true), (c) => score(holdout.find((h) => h.id === c.id)!, false), holdout);
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x));
  console.log(`Lesson ablation on ${res.n} holdout case${res.n === 1 ? '' : 's'} (harness ${version})`);
  for (const c of res.cases) console.log(`  ${c.id}  with ${f(c.withLessons)}  without ${f(c.withoutLessons)}  delta ${f(c.delta)}`);
  console.log(`mean delta ${f(res.meanDelta)}  95% CI [${f(res.ci[0])}, ${f(res.ci[1])}]  => lessons ${res.verdict === 'helps' ? 'help' : res.verdict === 'hurts' ? 'hurt' : 'show no clear effect'}`);
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

// Value of `--name value`. A present flag must be followed by a value, not by another flag or the end of argv.
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${name} needs a value`);
  return v;
}

// Integer flag with a default; rejects anything that is not a whole number (Number('abc') would be NaN).
function intFlag(args: string[], name: string, fallback: number): number {
  const v = flag(args, name);
  if (v === undefined) return fallback;
  if (!/^-?\d+$/.test(v.trim())) die(`${name} must be an integer, got "${v}"`);
  return Number(v);
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
    const size = intFlag(args, '--sample', 50);
    if (!Number.isInteger(size) || size < 1) die('--sample must be a positive integer');
    const seed = intFlag(args, '--seed', 1);
    const { file, items } = writeSample(store, size, seed);
    if (!items.length) die('no bench results yet; run `orchestra bench` first');
    console.log(`wrote ${items.length} verdict(s) to ${file}\nSet humanPass to true or false on each line, then run: orchestra bench calibrate --import <file>`);
    return;
  }
  if (args.includes('--report')) {
    const store = storeOrDie();
    const rows = readBenchRows(store);
    if (rows.length) console.log(`${renderSummary(summarize(rows))}\n`);
    // Pairs are (goal, repeat), so only the latest bench that ran the reference arm (and at least one other) is compared.
    const wanted = flag(args, '--reference');
    const eligible = (b: string) => {
      const rs = rows.filter((r) => r.bench === b);
      const ref = wanted ?? defaultReference(rs);
      return !!ref && rs.some((r) => r.arm === ref) && rs.some((r) => r.arm !== ref);
    };
    const latest = [...new Set(rows.map((r) => r.bench))].sort().reverse().find(eligible);
    if (latest) {
      const rs = rows.filter((r) => r.bench === latest);
      const ref = wanted ?? defaultReference(rs)!;
      console.log(`Ablations in ${latest} (paired versus ${ref}, 95% CI clustered by goal)\n${renderAblationTable(ablationTable(rs, ref), ref)}\n`);
    }
    console.log(renderCalibration(storeCalibration(store)));
    return;
  }
  const store = storeOrDie();
  const repeats = intFlag(args, '--repeats', 1);
  if (!Number.isInteger(repeats) || repeats < 1) die('--repeats must be a positive integer');
  const named = flag(args, '--arms')?.split(',').filter(Boolean);
  const arms = args.includes('--ablations') ? [...ABLATION_ARMS, SINGLE_SESSION_ARM] : loadArms(suite, named);
  const refErr = referenceError(flag(args, '--reference'), arms);
  if (refErr) die(refErr);
  const res = await runBench({ store, runner: runner(), suite, arms, goals, repeats, onRow: (r) => console.log(`${r.arm} ${r.goal} #${r.repeat}: ${r.checkPass ? 'pass' : 'fail'} ($${r.costUsd.toFixed(3)})`) });
  console.log(`\n${renderSummary(res.summary)}`);
  const ref = flag(args, '--reference') ?? defaultReference(res.rows);
  if (ref && (args.includes('--ablations') || arms.length > 1)) console.log(`\n${renderAblationTable(ablationTable(res.rows, ref), ref)}`);
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
    case 'atlas':
      cmdAtlas(args);
      break;
    case 'bench':
      await cmdBench(args);
      break;
    case 'evals':
      await cmdEvalsRouter(args);
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
