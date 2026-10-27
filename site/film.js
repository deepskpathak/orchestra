/* Orchestra explainer film.
   Every frame is a pure function of time t (seconds), so play, pause,
   scrubbing and chapter jumps all just call render(t). No video file. */
(function () {
  'use strict';

  const DURATION = 62;
  const C = {
    ink: '#08070c', ink2: '#14111d', ink3: '#1d1928', line: '#2c2639',
    ivory: '#f3ead8', muted: '#a99fb8', brass: '#e8b04a', brass2: '#f6d28b',
    crimson: '#d9534a', teal: '#4fd1a5', sky: '#6cb6ff', violet: '#a98bff'
  };
  const SERIF = "Fraunces, Georgia, serif";
  const SANS = "Inter, system-ui, sans-serif";
  const MONO = "'JetBrains Mono', ui-monospace, monospace";

  const CHAPTERS = [
    { t: 0, name: 'Goal', label: 'You bring a goal' },
    { t: 6, name: 'Plan', label: 'Score + holdout' },
    { t: 15, name: 'Build', label: 'Parallel worktrees' },
    { t: 25, name: 'Verify', label: 'Judge + repair' },
    { t: 35, name: 'Merge', label: 'Serialized queue' },
    { t: 43, name: 'Learn', label: 'Lessons recorded' },
    { t: 50, name: 'Evolve', label: 'Measured promotion' }
  ];

  const CAPTIONS = [
    [0, 6, 'You give Orchestra a goal, in plain language.'],
    [6, 10.5, 'The planner writes the score: a task graph with dependencies and criteria.'],
    [10.5, 15, 'It also writes hidden scenarios. Only the judge ever sees them.'],
    [15, 20, 'Each task builds in its own git worktree. Your checkout is never touched.'],
    [20, 25, 'Dependent tasks wait. T3 starts the moment T1 is done.'],
    [25, 29.5, 'The judge scores each diff against criteria and hidden scenarios.'],
    [29.5, 35, 'A reject is not the end. It becomes repair notes for a fresh try.'],
    [35, 43, 'A merge queue lands tasks one at a time, testing after each merge.'],
    [43, 50, 'The librarian turns repairs into lessons. The next run starts smarter.'],
    [50, 55, 'The evolver proposes a better harness. A frozen scorer compares both.'],
    [55, 58, 'Measured gain? Promote. No gain? No promotion.'],
    [58, 62.1, 'Orchestra. You bring the goal. The factory plays it.']
  ];

  const TASKS = [
    { id: 'T1', title: 'JSON serializer', color: C.sky },
    { id: 'T2', title: 'Parse --json flag', color: C.violet },
    { id: 'T3', title: 'Wire into export', color: C.teal },
    { id: 'T4', title: 'Docs + changelog', color: C.brass }
  ];
  const GOAL = 'orchestra run "Add a --json flag to the export command"';

  // ---------- math helpers ----------
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = x => (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const p = (t, a, b) => ease(clamp((t - a) / (b - a)));
  const lin = (t, a, b) => clamp((t - a) / (b - a));
  const lerp = (a, b, k) => a + (b - a) * k;
  const win = (t, a, b, f = .6) => Math.min(p(t, a, a + f), 1 - p(t, b - f, b));
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = n => n.toFixed(2);

  // ---------- svg helpers ----------
  const txt = (x, y, s, o = {}) =>
    `<text x="${x}" y="${y}" fill="${o.fill || C.ivory}" font-family="${o.font || SANS}" font-size="${o.size || 16}" font-weight="${o.weight || 400}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.italic ? ' font-style="italic"' : ''}${o.opacity != null ? ` opacity="${o.opacity}"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''}>${esc(s)}</text>`;
  const rect = (x, y, w, h, o = {}) =>
    `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" rx="${o.r ?? 10}" fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw || 1.5}"` : ''}${o.opacity != null ? ` opacity="${o.opacity}"` : ''}${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
  const circ = (x, y, r, o = {}) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw || 1.5}"` : ''}${o.opacity != null ? ` opacity="${o.opacity}"` : ''}/>`;
  const g = (inner, o = {}) =>
    `<g${o.opacity != null ? ` opacity="${clamp(o.opacity)}"` : ''}${o.tf ? ` transform="${o.tf}"` : ''}>${inner}</g>`;

  function icon(x, y, r, glyph, color, k = 1) {
    return g(
      circ(x, y, r + 10, { fill: color, opacity: .12 }) +
      circ(x, y, r, { fill: C.ink2, stroke: color, sw: 2 }) +
      txt(x, y + r * .36, glyph, { fill: color, size: r * 1.05, anchor: 'middle', font: SERIF }),
      { opacity: k, tf: `translate(${x} ${y}) scale(${lerp(.6, 1, k)}) translate(${-x} ${-y})` }
    );
  }

  // ---------- persistent chrome ----------
  function costAt(t) {
    const pts = [[0, 0], [6, 0], [15, .38], [25, 1.62], [35, 2.71], [43, 2.98], [50, 3.21], [58, 4.12]];
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) return lerp(pts[i - 1][1], pts[i][1], lin(t, pts[i - 1][0], pts[i][0]));
    }
    return 4.12;
  }

  function chrome(t) {
    let s = '';
    // backdrop staff lines
    for (let i = 0; i < 5; i++) {
      const y = 470 + i * 12;
      s += `<line x1="0" x2="960" y1="${y}" y2="${y}" stroke="${C.line}" stroke-width="1" opacity=".5"/>`;
    }
    const k = p(t, .3, 1.2) * (1 - p(t, 58, 58.8));
    if (k <= 0) return s;
    const phases = ['PLAN', 'BUILD', 'VERIFY', 'MERGE', 'LEARN', 'EVOLVE'];
    const starts = [6, 15, 25, 35, 43, 50, 58];
    let bar = rect(0, 0, 960, 64, { r: 0, fill: C.ink2, opacity: .9 }) +
      `<line x1="0" x2="960" y1="64" y2="64" stroke="${C.line}"/>` +
      txt(28, 40, '♫ ORCHESTRA', { fill: C.brass, font: SERIF, size: 20, weight: 600, ls: 1 });
    phases.forEach((ph, i) => {
      const x = 222 + i * 92;
      const done = t >= starts[i + 1];
      const active = t >= starts[i] && !done;
      const col = active ? C.brass : done ? C.teal : C.muted;
      const mark = done ? '✓' : active ? '▶' : '·';
      if (active) bar += rect(x - 10, 20, 84, 28, { r: 14, fill: C.brass, opacity: .14 });
      bar += txt(x, 39, `${mark} ${ph}`, { fill: col, font: MONO, size: 12.5, weight: active ? 600 : 400 });
    });
    bar += txt(932, 39, '$' + fmt(costAt(t)), { fill: C.ivory, font: MONO, size: 14, anchor: 'end' });
    bar += txt(932, 86, 'illustrative run', { fill: C.muted, font: MONO, size: 10.5, anchor: 'end', opacity: .7 });
    return s + g(bar, { opacity: k });
  }

  // ---------- scenes ----------
  function sceneGoal(t) {
    const k = win(t, 0, 6.4, .7);
    if (k <= 0) return '';
    const typed = Math.floor(GOAL.length * lin(t, 1.2, 4.2));
    const blink = Math.floor(t * 2.2) % 2 === 0;
    const rise = (1 - p(t, 0, .9)) * 20;
    let s = txt(480, 170 + rise, 'Every piece of software starts with a goal.', { anchor: 'middle', font: SERIF, size: 30, italic: true, fill: C.ivory, opacity: p(t, .2, 1.2) });
    s += rect(120, 220 + rise, 720, 110, { r: 14, fill: '#0f0d15', stroke: C.line });
    s += circ(146, 242 + rise, 5, { fill: '#ff5f57' }) + circ(162, 242 + rise, 5, { fill: '#febc2e' }) + circ(178, 242 + rise, 5, { fill: '#28c840' });
    s += txt(150, 292 + rise, '$ ', { fill: C.teal, font: MONO, size: 17 });
    s += txt(172, 292 + rise, GOAL.slice(0, typed) + (blink || typed < GOAL.length ? '▍' : ''), { fill: C.ivory, font: MONO, size: 17 });
    const enter = p(t, 4.6, 5.2);
    if (enter > 0) s += txt(480, 380, '↵  enter', { anchor: 'middle', fill: C.brass, font: MONO, size: 14, opacity: enter * (1 - p(t, 5.6, 6)) });
    return g(s, { opacity: k });
  }

  const NOTE_X = [270, 390, 510, 630];
  const NOTE_Y = [270, 250, 230, 290];

  function scenePlan(t) {
    const k = win(t, 6, 15.4, .6);
    if (k <= 0) return '';
    let s = '';
    // goal chip
    s += rect(200, 92, 560, 36, { r: 18, fill: C.ink3, stroke: C.line });
    s += txt(480, 115, 'Goal: Add a --json flag to the export command', { anchor: 'middle', font: MONO, size: 13, fill: C.brass2 });
    // planner
    s += icon(110, 260, 34, '𝄞', C.brass, p(t, 6.3, 7.2));
    s += txt(110, 330, 'planner', { anchor: 'middle', font: MONO, size: 13, fill: C.brass, opacity: p(t, 6.6, 7.3) });
    // staff
    const staffK = p(t, 7, 8.2);
    for (let i = 0; i < 5; i++) {
      const y = 220 + i * 20;
      s += `<line x1="190" x2="${lerp(190, 690, staffK)}" y1="${y}" y2="${y}" stroke="${C.muted}" stroke-width="1" opacity=".45"/>`;
    }
    // dependency arc T1 -> T3
    const dep = p(t, 9.8, 10.6);
    if (dep > 0) {
      const len = 330;
      s += `<path d="M ${NOTE_X[0]} ${NOTE_Y[0] - 20} Q ${(NOTE_X[0] + NOTE_X[2]) / 2} 150 ${NOTE_X[2]} ${NOTE_Y[2] - 20}" fill="none" stroke="${C.teal}" stroke-width="2" stroke-dasharray="6 6" stroke-dashoffset="${len * (1 - dep)}" opacity=".85"/>`;
      s += txt((NOTE_X[0] + NOTE_X[2]) / 2, 176, 'T3 needs T1', { anchor: 'middle', font: MONO, size: 11.5, fill: C.teal, opacity: dep });
    }
    // notes
    TASKS.forEach((task, i) => {
      const nk = p(t, 7.8 + i * .5, 8.5 + i * .5);
      if (nk <= 0) return;
      const x = NOTE_X[i], y = NOTE_Y[i] - (1 - nk) * 30;
      s += g(
        `<ellipse cx="${x}" cy="${y}" rx="15" ry="11" transform="rotate(-20 ${x} ${y})" fill="${task.color}"/>` +
        `<line x1="${x + 13}" x2="${x + 13}" y1="${y - 4}" y2="${y - 56}" stroke="${task.color}" stroke-width="3"/>` +
        txt(x, 358, task.id, { anchor: 'middle', font: MONO, size: 14, weight: 600, fill: task.color }) +
        txt(x, 378, task.title, { anchor: 'middle', size: 12.5, fill: C.muted }),
        { opacity: nk }
      );
    });
    // holdout card
    const hk = p(t, 10.6, 11.6);
    if (hk > 0) {
      const x = 726, y = 180 + (1 - hk) * 20;
      let card = rect(x, y, 200, 200, { r: 14, fill: '#1a1218', stroke: C.crimson, sw: 1.5 });
      card += txt(x + 100, y + 44, '🔒', { anchor: 'middle', size: 26 });
      card += txt(x + 100, y + 74, 'HIDDEN SCENARIOS', { anchor: 'middle', font: MONO, size: 12, weight: 600, fill: C.crimson, ls: 1 });
      ['given', 'when', 'then'].forEach((w, i) => {
        card += txt(x + 18, y + 106 + i * 24, w, { font: MONO, size: 11.5, fill: C.muted });
        card += rect(x + 66, y + 96 + i * 24, 110 - i * 14, 10, { r: 5, fill: C.muted, opacity: .3 });
      });
      card += txt(x + 100, y + 186, 'workers can’t read this', { anchor: 'middle', size: 12, italic: true, fill: C.ivory, opacity: .8 });
      s += g(card, { opacity: hk });
      // the eye that cannot see
      const ek = p(t, 12.2, 12.8);
      if (ek > 0) s += txt(706, 290, '⛔', { anchor: 'middle', size: 18, opacity: ek });
    }
    return g(s, { opacity: k });
  }

  const LANES = [
    { i: 0, a: 15.6, b: 20.0 },
    { i: 1, a: 16.0, b: 23.4 },
    { i: 2, a: 20.4, b: 24.4, wait: true },
    { i: 3, a: 16.4, b: 21.4 }
  ];

  function sceneBuild(t) {
    const k = win(t, 15, 25.4, .6);
    if (k <= 0) return '';
    let s = txt(60, 122, 'Each task in its own git worktree', { font: SERIF, size: 22, italic: true, fill: C.ivory, opacity: p(t, 15.2, 16) });
    s += txt(900, 122, 'your checkout: untouched ✓', { anchor: 'end', font: MONO, size: 12, fill: C.teal, opacity: p(t, 16.4, 17.2) });
    LANES.forEach((L, row) => {
      const task = TASKS[L.i];
      const y = 160 + row * 70;
      const lk = p(t, 15.2 + row * .2, 15.9 + row * .2);
      const prog = lin(t, L.a, L.b);
      const waiting = L.wait && t < L.a;
      let lane = rect(60, y, 840, 52, { r: 12, fill: C.ink2, stroke: C.line });
      lane += txt(80, y + 23, task.id, { font: MONO, size: 15, weight: 600, fill: task.color });
      lane += txt(80, y + 41, task.title, { size: 11.5, fill: C.muted });
      lane += txt(230, y + 31, `orchestra/r42/${task.id.toLowerCase()}`, { font: MONO, size: 11.5, fill: C.muted, opacity: .8 });
      lane += rect(420, y + 21, 340, 10, { r: 5, fill: C.ink3 });
      lane += rect(420, y + 21, 340 * prog, 10, { r: 5, fill: task.color });
      if (prog > 0 && prog < 1) {
        const bob = Math.sin(t * 9 + row) * 3;
        lane += txt(420 + 340 * prog, y + 16 + bob, '♪', { anchor: 'middle', size: 16, fill: task.color, font: SERIF });
      }
      let status, col;
      if (waiting) { status = '⇠ waits on T1'; col = C.muted; }
      else if (prog <= 0) { status = 'queued'; col = C.muted; }
      else if (prog < 1) { status = 'building'; col = C.brass; }
      else { status = '✓ built'; col = C.teal; }
      lane += txt(880, y + 31, status, { anchor: 'end', font: MONO, size: 12.5, fill: col });
      s += g(lane, { opacity: lk * (waiting ? .55 : 1) });
    });
    // unlock flash when T1 finishes
    const fl = win(t, 20, 21.4, .3);
    if (fl > 0) s += txt(480, 456, 'T1 done → T3 unblocked', { anchor: 'middle', font: MONO, size: 14, fill: C.teal, opacity: fl });
    return g(s, { opacity: k });
  }

  const VERDICTS = [
    { i: 0, at: 26.0, score: .89 },
    { i: 1, at: 27.6, score: .41, fail: true, retryAt: 32.2, retryScore: .86 },
    { i: 2, at: 30.6, score: .88 },
    { i: 3, at: 26.8, score: .92 }
  ];

  function sceneVerify(t) {
    const k = win(t, 25, 35.4, .6);
    if (k <= 0) return '';
    let s = icon(480, 150, 34, '⚖', C.crimson, p(t, 25.2, 26));
    s += txt(530, 140, 'judge', { font: MONO, size: 13, fill: C.crimson, opacity: p(t, 25.5, 26.2) });
    s += txt(530, 160, 'criteria + 🔒 scenarios', { font: MONO, size: 11.5, fill: C.muted, opacity: p(t, 25.5, 26.2) });
    VERDICTS.forEach((v, col) => {
      const task = TASKS[v.i];
      const x = 60 + col * 215, y = 222;
      const ck = p(t, 25.3 + col * .15, 26 + col * .15);
      const judged = t >= v.at;
      const retrying = v.fail && t >= v.at + 1.8 && t < v.retryAt;
      const repaired = v.fail && t >= v.retryAt;
      const failed = v.fail && judged && !repaired && !retrying && t >= v.at + .6;
      const score = repaired ? v.retryScore * p(t, v.retryAt, v.retryAt + .6) : judged && !retrying ? v.score * p(t, v.at, v.at + .6) : 0;
      const settled = repaired ? t >= v.retryAt + .6 : judged && !retrying && t >= v.at + .6;
      const pass = settled && (!v.fail || repaired);
      const edge = pass ? C.teal : failed ? C.crimson : retrying ? C.brass : C.line;
      let card = rect(x, y, 195, 150, { r: 14, fill: C.ink2, stroke: edge, sw: judged ? 2 : 1.5 });
      card += txt(x + 18, y + 32, task.id, { font: MONO, size: 16, weight: 600, fill: task.color });
      card += txt(x + 18, y + 52, task.title, { size: 12, fill: C.muted });
      card += txt(x + 177, y + 32, repaired || retrying ? 'try 2' : 'try 1', { anchor: 'end', font: MONO, size: 11.5, fill: C.muted });
      card += rect(x + 18, y + 78, 159, 10, { r: 5, fill: C.ink3 });
      card += rect(x + 18, y + 78, 159 * score, 10, { r: 5, fill: pass ? C.teal : failed ? C.crimson : C.brass });
      // pass threshold marker
      card += `<line x1="${x + 18 + 159 * .75}" x2="${x + 18 + 159 * .75}" y1="${y + 72}" y2="${y + 94}" stroke="${C.ivory}" stroke-width="1.5" opacity=".5"/>`;
      card += txt(x + 18, y + 116, judged && !retrying ? fmt(score) : retrying ? 'repairing…' : 'awaiting judge', { font: MONO, size: 13, fill: retrying ? C.brass : C.ivory });
      if (pass) card += txt(x + 177, y + 116, '✓ PASS', { anchor: 'end', font: MONO, size: 13, weight: 600, fill: C.teal });
      if (failed) card += txt(x + 177, y + 116, '✗ REJECT', { anchor: 'end', font: MONO, size: 13, weight: 600, fill: C.crimson });
      if (pass) card += txt(x + 18, y + 138, '🔒 scenarios 3/3', { font: MONO, size: 11, fill: C.muted });
      if (failed) card += txt(x + 18, y + 138, 'ignores --out path', { font: MONO, size: 11, fill: C.crimson });
      s += g(card, { opacity: ck });
      // beam from judge to card when judged
      const beam = win(t, v.at - .4, v.at + .5, .2) + (v.fail ? win(t, v.retryAt - .4, v.retryAt + .5, .2) : 0);
      if (beam > 0) s += `<line x1="480" y1="190" x2="${x + 97}" y2="${y}" stroke="${C.crimson}" stroke-width="2" opacity="${clamp(beam) * .7}"/>`;
    });
    // repair loop for T2
    const rk = win(t, 29.2, 33.6, .5);
    if (rk > 0) {
      const x = 60 + 215 + 97;
      s += g(
        `<path d="M ${x + 60} 388 C ${x + 60} 440, ${x - 60} 440, ${x - 60} 388" fill="none" stroke="${C.brass}" stroke-width="2" stroke-dasharray="5 5"/>` +
        `<path d="M ${x - 66} 396 L ${x - 60} 384 L ${x - 52} 396" fill="none" stroke="${C.brass}" stroke-width="2"/>` +
        txt(x, 458, 'repair notes → fresh worker, try 2', { anchor: 'middle', font: MONO, size: 12.5, fill: C.brass }),
        { opacity: rk }
      );
    }
    return g(s, { opacity: k });
  }

  const MERGES = [
    { i: 0, at: 36.0, x: 260 },
    { i: 3, at: 37.8, x: 410 },
    { i: 1, at: 39.6, x: 560 },
    { i: 2, at: 41.4, x: 710 }
  ];

  function sceneMerge(t) {
    const k = win(t, 35, 43.4, .6);
    if (k <= 0) return '';
    let s = txt(60, 122, 'One at a time, tests after every merge', { font: SERIF, size: 22, italic: true, opacity: p(t, 35.2, 36) });
    const lineK = p(t, 35.2, 36.2);
    s += `<line x1="110" x2="${lerp(110, 870, lineK)}" y1="320" y2="320" stroke="${C.brass}" stroke-width="3"/>`;
    s += circ(110, 320, 10, { fill: C.ink, stroke: C.muted, sw: 3 });
    s += txt(110, 356, 'main', { anchor: 'middle', font: MONO, size: 12.5, fill: C.muted });
    s += txt(870, 300, 'orchestra/r42/integration', { anchor: 'end', font: MONO, size: 12.5, fill: C.brass, opacity: lineK });
    // queue
    const waiting = MERGES.filter(m => t < m.at);
    waiting.forEach((m, qi) => {
      const task = TASKS[m.i];
      const x = 300 + qi * 90;
      s += g(rect(x, 170, 70, 32, { r: 16, fill: C.ink3, stroke: task.color }) +
        txt(x + 35, 191, task.id, { anchor: 'middle', font: MONO, size: 13, weight: 600, fill: task.color }), { opacity: p(t, 35.4, 36) });
    });
    if (waiting.length) s += txt(290, 191, 'queue', { anchor: 'end', font: MONO, size: 12, fill: C.muted, opacity: p(t, 35.4, 36) });
    MERGES.forEach(m => {
      const task = TASKS[m.i];
      const mk = p(t, m.at, m.at + .7);
      if (mk <= 0) return;
      const y = lerp(186, 320, mk);
      s += circ(m.x, y, 12, { fill: task.color });
      s += txt(m.x, y - 22, task.id, { anchor: 'middle', font: MONO, size: 13, weight: 600, fill: task.color });
      const tk = p(t, m.at + .8, m.at + 1.2);
      if (tk > 0) {
        s += g(rect(m.x - 46, 344, 92, 26, { r: 13, fill: C.teal, opacity: .14 }) +
          txt(m.x, 362, 'tests ✓', { anchor: 'middle', font: MONO, size: 12.5, fill: C.teal }), { opacity: tk });
      }
    });
    const done = p(t, 42.2, 42.8);
    if (done > 0) s += txt(480, 430, 'Ready to review: git log main..orchestra/r42/integration', { anchor: 'middle', font: MONO, size: 13.5, fill: C.ivory, opacity: done });
    return g(s, { opacity: k });
  }

  const LESSONS = [
    'Check --out path handling when adding an output format',
    'Run export tests with --silent to keep logs short',
    'Add the CHANGELOG line under [Unreleased]'
  ];

  function sceneLearn(t) {
    const k = win(t, 43, 50.4, .6);
    if (k <= 0) return '';
    let s = icon(150, 280, 36, '✎', C.teal, p(t, 43.2, 44));
    s += txt(150, 352, 'librarian', { anchor: 'middle', font: MONO, size: 13, fill: C.teal, opacity: p(t, 43.5, 44.2) });
    const bk = p(t, 43.6, 44.4);
    s += g(
      rect(300, 140, 600, 290, { r: 16, fill: C.ink2, stroke: C.line }) +
      txt(324, 176, '.orchestra/learnings/cli.json', { font: MONO, size: 13, fill: C.brass }) +
      txt(876, 176, 'domain: cli', { anchor: 'end', font: MONO, size: 12, fill: C.muted }) +
      `<line x1="300" x2="900" y1="194" y2="194" stroke="${C.line}"/>`,
      { opacity: bk }
    );
    LESSONS.forEach((l, i) => {
      const at = 44.6 + i * 1.4;
      const lk = p(t, at, at + .7);
      if (lk <= 0) return;
      const y = 236 + i * 64;
      // particle flying from librarian to slot
      const fly = lin(t, at - .6, at + .2);
      if (fly > 0 && fly < 1) {
        s += circ(lerp(190, 330, fly), lerp(280, y - 6, fly), 5, { fill: C.teal, opacity: 1 - fly * .4 });
      }
      s += g(
        txt(324, y, '+ ' + l, { font: SANS, size: 15, fill: C.ivory }) +
        txt(340, y + 22, `evidence: r42/${['T2', 'T1', 'T4'][i]} · hits 0`, { font: MONO, size: 11, fill: C.muted }),
        { opacity: lk, tf: `translate(${(1 - lk) * 20} 0)` }
      );
    });
    const nk = p(t, 48.6, 49.2);
    if (nk > 0) s += txt(600, 462, 'Read by the planner and workers on the next run', { anchor: 'middle', font: SERIF, size: 18, italic: true, fill: C.ivory, opacity: nk });
    return g(s, { opacity: k });
  }

  function sceneEvolve(t) {
    const k = win(t, 50, 58.4, .6);
    if (k <= 0) return '';
    let s = icon(120, 270, 36, '∞', C.violet, p(t, 50.2, 51));
    s += txt(120, 342, 'evolver', { anchor: 'middle', font: MONO, size: 13, fill: C.violet, opacity: p(t, 50.5, 51.2) });
    s += txt(560, 116, 'Factory Eval: replay past goals on both harnesses', { anchor: 'middle', font: SERIF, size: 20, italic: true, opacity: p(t, 50.4, 51.2) });
    // frozen scorer badge
    const fk = p(t, 51, 51.6);
    s += g(rect(470, 138, 180, 30, { r: 15, fill: C.sky, opacity: .14 }) +
      txt(560, 158, '❄ frozen scorer', { anchor: 'middle', font: MONO, size: 12.5, fill: C.sky }), { opacity: fk });
    const base = 400, maxH = 190;
    const bars = [
      { x: 360, label: 'v1 · incumbent', score: .81, col: C.muted, at: 51.6 },
      { x: 660, label: 'v2 · candidate', score: .87, col: C.violet, at: 52.4 }
    ];
    s += `<line x1="270" x2="850" y1="${base}" y2="${base}" stroke="${C.line}" stroke-width="2" opacity="${fk}"/>`;
    bars.forEach(b => {
      const bk = p(t, b.at, b.at + 1.8);
      const h = maxH * b.score * bk;
      s += g(
        rect(b.x - 55, base - h, 110, h, { r: 8, fill: b.col, opacity: .85 }) +
        txt(b.x, base - h - 12, fmt(b.score * bk), { anchor: 'middle', font: MONO, size: 16, weight: 600, fill: C.ivory }) +
        txt(b.x, base + 24, b.label, { anchor: 'middle', font: MONO, size: 12.5, fill: C.muted }),
        { opacity: p(t, b.at - .3, b.at + .2) }
      );
    });
    // promotion stamp
    const sk = p(t, 55, 55.5);
    if (sk > 0) {
      const sc = lerp(1.6, 1, sk);
      s += g(
        rect(-110, -28, 220, 56, { r: 10, fill: C.ink, stroke: C.teal, sw: 3 }) +
        txt(0, 8, 'PROMOTED ✓', { anchor: 'middle', font: MONO, size: 22, weight: 600, fill: C.teal, ls: 2 }),
        { opacity: sk, tf: `translate(500 238) rotate(-8) scale(${sc})` }
      );
      s += txt(560, 458, 'measured gain +0.06 · rollback any time: orchestra promote v1', { anchor: 'middle', font: MONO, size: 12.5, fill: C.ivory, opacity: p(t, 55.6, 56.2) });
    }
    return g(s, { opacity: k });
  }

  function sceneEnd(t) {
    const k = p(t, 58.2, 59.2);
    if (k <= 0) return '';
    let s = rect(0, 0, 960, 540, { r: 0, fill: C.ink, opacity: k });
    s += `<radialGradient id="eg" cx="50%" cy="100%" r="70%"><stop offset="0" stop-color="${C.brass}" stop-opacity=".28"/><stop offset="1" stop-color="${C.brass}" stop-opacity="0"/></radialGradient>`;
    s += rect(0, 0, 960, 540, { r: 0, fill: 'url(#eg)', opacity: k });
    const rise = (1 - k) * 20;
    s += txt(480, 222 + rise, '♫', { anchor: 'middle', size: 58, fill: C.brass, font: SERIF, opacity: k });
    s += txt(480, 292 + rise, 'Orchestra', { anchor: 'middle', size: 62, fill: C.ivory, font: SERIF, weight: 500, opacity: k });
    s += txt(480, 336 + rise, 'You bring the goal. The factory plays it.', { anchor: 'middle', size: 22, italic: true, fill: C.brass2, font: SERIF, opacity: p(t, 59, 60) });
    s += txt(480, 392 + rise, 'github.com/deepskpathak/orchestra', { anchor: 'middle', size: 14, fill: C.muted, font: MONO, opacity: p(t, 59.6, 60.6) });
    return s;
  }

  function frame(t) {
    return rect(0, 0, 960, 540, { r: 0, fill: C.ink }) +
      chrome(t) + sceneGoal(t) + scenePlan(t) + sceneBuild(t) + sceneVerify(t) +
      sceneMerge(t) + sceneLearn(t) + sceneEvolve(t) + sceneEnd(t);
  }

  // ---------- player ----------
  function init() {
    const player = document.getElementById('player');
    if (!player) return;
    const stage = document.getElementById('stage');
    const titleNodes = stage.innerHTML; // keep <title> and <desc> for a11y
    const caption = document.getElementById('caption');
    const scrub = document.getElementById('scrub');
    const fill = document.getElementById('scrub-fill');
    const knob = document.getElementById('scrub-knob');
    const time = document.getElementById('time');
    const playBtn = document.getElementById('ctl-play');
    const bigPlay = document.getElementById('big-play');
    const ccBtn = document.getElementById('ctl-cc');
    const marks = document.getElementById('scrub-marks');
    const chapterList = document.getElementById('chapters');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let t = 0, playing = false, last = 0, raf = 0, poster = true, autoplayed = false;
    const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    CHAPTERS.forEach((ch, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<b>${i + 1}. ${ch.name}</b>${ch.label}`;
      b.addEventListener('click', () => { seek(ch.t + .01); play(); });
      li.appendChild(b);
      chapterList.appendChild(li);
      if (i > 0) {
        const m = document.createElement('i');
        m.style.left = (ch.t / DURATION * 100) + '%';
        marks.appendChild(m);
      }
    });
    const chapterBtns = chapterList.querySelectorAll('button');

    function draw() {
      const shown = poster ? 18.6 : t;
      stage.innerHTML = titleNodes + frame(shown);
      const cap = poster ? null : CAPTIONS.find(c => t >= c[0] && t < c[1]);
      caption.textContent = cap ? cap[2] : '';
      const pct = (t / DURATION) * 100;
      fill.style.width = pct + '%';
      knob.style.left = pct + '%';
      time.textContent = `${mmss(t)} / ${mmss(DURATION)}`;
      scrub.setAttribute('aria-valuenow', Math.round(t));
      scrub.setAttribute('aria-valuetext', `${mmss(t)} of ${mmss(DURATION)}`);
      let active = 0;
      CHAPTERS.forEach((c, i) => { if (t >= c.t) active = i; });
      chapterBtns.forEach((b, i) => b.classList.toggle('active', !poster && i === active));
      player.classList.toggle('show-big', !playing && (poster || t >= DURATION));
    }

    function tick(now) {
      if (!playing) return;
      const dt = Math.min(.1, (now - last) / 1000);
      last = now;
      t += dt;
      if (t >= DURATION) { t = DURATION; pause(); }
      draw();
      if (playing) raf = requestAnimationFrame(tick);
    }
    function play() {
      if (playing) return;
      if (t >= DURATION) t = 0;
      poster = false;
      playing = true;
      player.classList.add('playing');
      player.classList.remove('show-big');
      playBtn.setAttribute('aria-label', 'Pause');
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
    function pause() {
      playing = false;
      cancelAnimationFrame(raf);
      player.classList.remove('playing');
      playBtn.setAttribute('aria-label', 'Play');
      draw();
    }
    function seek(s) { poster = false; t = clamp(s, 0, DURATION); draw(); }
    const toggle = () => (playing ? pause() : play());

    playBtn.addEventListener('click', toggle);
    bigPlay.addEventListener('click', play);
    stage.addEventListener('click', toggle);
    ccBtn.addEventListener('click', () => {
      const on = ccBtn.getAttribute('aria-pressed') !== 'true';
      ccBtn.setAttribute('aria-pressed', String(on));
      player.classList.toggle('no-cc', !on);
    });

    // scrubbing
    let dragging = false, wasPlaying = false;
    const posToTime = e => {
      const r = scrub.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width) * DURATION;
    };
    scrub.addEventListener('pointerdown', e => {
      dragging = true; wasPlaying = playing; pause();
      scrub.setPointerCapture(e.pointerId);
      seek(posToTime(e));
    });
    scrub.addEventListener('pointermove', e => { if (dragging) seek(posToTime(e)); });
    scrub.addEventListener('pointerup', () => { dragging = false; if (wasPlaying) play(); });
    scrub.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { seek(t + 5); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { seek(t - 5); e.preventDefault(); }
      else if (e.key === 'Home') { seek(0); e.preventDefault(); }
      else if (e.key === 'End') { seek(DURATION); e.preventDefault(); }
      else if (e.key === ' ' || e.key === 'Enter') { toggle(); e.preventDefault(); }
    });

    // autoplay once when the film scrolls into view (skipped for reduced motion)
    if (!reduced && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (en.isIntersecting && en.intersectionRatio > .6 && !autoplayed) { autoplayed = true; play(); }
          if (!en.isIntersecting && playing) pause();
        });
      }, { threshold: [0, .6] });
      io.observe(player);
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

    // repaint once fonts are ready so SVG text uses them
    draw();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);

    window.OrchestraFilm = { seek, play, pause, frame, DURATION };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
