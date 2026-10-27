/* Orchestra site interactions. No dependencies. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- toast + copy ----------
  const toast = $('#toast');
  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }
  // Copy buttons copy commands only: comment lines and trailing comments are dropped.
  function cleanCommand(raw) {
    return raw.split('\n')
      .map(l => l.replace(/\s+#.*$/, ''))
      .filter(l => !/^\s*#/.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  $$('.copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.parentElement.querySelector('code');
      const ok = await copyText(cleanCommand(code.innerText));
      btn.textContent = ok ? 'Copied' : 'Failed';
      btn.classList.toggle('done', ok);
      showToast(ok ? 'Copied to clipboard' : 'Copy failed, select the text instead');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1500);
    });
  });
  $$('[data-copy]').forEach(el => {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    const go = async () => showToast((await copyText(el.dataset.copy)) ? 'Copied to clipboard' : 'Copy failed');
    el.addEventListener('click', go);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });

  // ---------- mobile nav ----------
  const toggle = $('.nav-toggle');
  const links = $('#nav-links');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    links.classList.toggle('open', open);
  });
  $$('a', links).forEach(a => a.addEventListener('click', () => {
    toggle.setAttribute('aria-expanded', 'false');
    links.classList.remove('open');
  }));

  // ---------- hero: floating notes on a staff ----------
  const canvas = $('#staff');
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    const glyphs = ['♩', '♪', '♫', '♬'];
    let w = 0, h = 0, dpr = 1, notes = [];
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(26, w / 50));
      notes = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * w,
        line: Math.floor(Math.random() * 9),
        speed: 10 + Math.random() * 22,
        size: 16 + Math.random() * 18,
        glyph: glyphs[i % glyphs.length],
        phase: Math.random() * Math.PI * 2,
        hue: Math.random() < .7 ? 'rgba(232,176,74,' : 'rgba(243,234,216,'
      }));
    }
    function staffY(line) {
      const top = h * .86;
      return top + line * 9;
    }
    function draw(time) {
      ctx.clearRect(0, 0, w, h);
      const top = h * .86;
      for (let i = 0; i < 5; i++) {
        const y = top + i * 18;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 24) {
          const yy = y + Math.sin(x / 180 + time / 2400 + i * .3) * 6;
          x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.strokeStyle = 'rgba(169,159,184,.13)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      notes.forEach(n => {
        const x = (n.x + (time / 1000) * n.speed) % (w + 60) - 30;
        const y = staffY(n.line) + Math.sin(x / 180 + time / 2400) * 6 + Math.sin(time / 700 + n.phase) * 3;
        const fade = Math.min(1, Math.min(x + 30, w + 30 - x) / 140);
        ctx.font = `${n.size}px Fraunces, Georgia, serif`;
        ctx.fillStyle = n.hue + (.28 * fade) + ')';
        ctx.fillText(n.glyph, x, y);
      });
    }
    let raf, visible = true;
    function loop(t) { draw(t); if (visible) raf = requestAnimationFrame(loop); }
    resize();
    window.addEventListener('resize', resize);
    if (reduced) draw(0);
    else {
      raf = requestAnimationFrame(loop);
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(([e]) => {
          visible = e.isIntersecting;
          if (visible) { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); }
        }).observe(canvas);
      }
    }
  }

  // ---------- hero: live terminal dashboard ----------
  const term = $('#term-body');
  if (term) {
    const tasks = [
      { id: 'T1', title: 'Core module', dep: '', start: 0, end: 9, fail: false },
      { id: 'T2', title: 'Config loader', dep: '', start: 1, end: 15, fail: true },
      { id: 'T3', title: 'CLI wiring', dep: '⇠ T1', start: 9, end: 17, fail: false },
      { id: 'T4', title: 'Docs + README', dep: '', start: 2, end: 11, fail: false }
    ];
    const W = 58;
    const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    const span = (cls, s) => `<span class="${cls}">${s}</span>`;
    const pad = (s, n) => (s.length > n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
    const bar = (k, n) => '█'.repeat(Math.round(k * n)) + '░'.repeat(n - Math.round(k * n));
    let step = 0;
    function render() {
      const s = step % 26;
      const stateOf = tk => {
        if (s < tk.start) return { st: 'queued', cls: 't-m', icon: '·', k: 0, tries: 1, score: '----' };
        if (s >= tk.end) return { st: 'merged', cls: 't-g', icon: '✓', k: 1, tries: tk.fail ? 2 : 1, score: tk.fail ? '0.86' : (0.84 + tk.id.charCodeAt(1) % 4 * .03).toFixed(2) };
        const mid = (tk.start + tk.end) / 2;
        if (tk.fail && s >= mid - 1 && s < mid + 1) return { st: 'repair ', cls: 't-r', icon: '⟳', k: .4, tries: 2, score: '0.41' };
        if (s >= tk.end - 2) return { st: 'judging', cls: 't-v', icon: spin[step % spin.length], k: .95, tries: tk.fail && s > mid ? 2 : 1, score: '----' };
        return { st: 'running', cls: 't-b', icon: spin[step % spin.length], k: (s - tk.start) / (tk.end - tk.start), tries: tk.fail && s > mid ? 2 : 1, score: '----' };
      };
      const states = tasks.map(stateOf);
      const merged = states.filter(x => x.st === 'merged').length;
      const running = states.filter(x => /running|judging/.test(x.st)).length;
      const repair = states.filter(x => x.st.startsWith('repair')).length;
      const phase = s < 1 ? 0 : merged === 4 ? 4 : merged > 0 ? 3 : s > 7 ? 2 : 1;
      const phases = ['PLAN', 'BUILD', 'VERIFY', 'MERGE', 'LEARN'];
      const ph = phases.map((p, i) => i < phase ? span('t-g', '✓ ' + p) : i === phase ? span('t-b', '▶ ' + p) : span('t-m', '· ' + p)).join(span('t-m', ' ─ '));
      const cost = (0.12 + s * 0.11).toFixed(2);
      const secs = String(s).padStart(2, '0');
      const status = merged === 4 ? span('t-g', 'DONE') : span('t-b', 'RUNNING');
      const vis = str => Array.from(str.replace(/<[^>]+>/g, '')).length;
      const row = content => span('t-m', '│ ') + content;
      const rule = label => span('t-m', '├─ ' + label + ' ' + '─'.repeat(Math.max(0, W - vis(label))));
      const lines = [
        span('t-m', '╭─ ') + span('t-b', '♫ ORCHESTRA') + span('t-m', ' r42 · harness v1 ' + '─'.repeat(W - 37) + ' 00:' + secs + ' ─'),
        row(span('t-m', 'Goal ') + 'Build a tiny CLI with config and docs'),
        row(ph),
        row(span('t-b', bar(merged / 4, 14)) + ` ${merged}/4  ` + span('t-g', '✓' + merged) + ' ' + span('t-b', '●' + running) + ' ' + span('t-r', '⟳' + repair) + `  $${cost}  ` + status),
        rule('Tasks')
      ];
      tasks.forEach((tk, i) => {
        const st = states[i];
        lines.push(row(`${span(st.cls, st.icon)} ${tk.id}  ${span(st.cls, pad(st.st.trim(), 8))} ${span(st.cls, bar(st.k, 8))} ${st.score}  try ${st.tries}  ${tk.title}${tk.dep && st.st === 'queued' ? ' ' + span('t-m', tk.dep) : ''}`));
      });
      lines.push(rule('Events'));
      const ev = s < 2 ? 'planner: 4 tasks, 3 hidden scenarios'
        : s < 8 ? 'worker T1: tests passing in worktree'
        : s < 9 ? 'judge T2: reject 0.41 → repair notes'
        : s < 12 ? 'merge T1 → integration, tests ✓'
        : s < 17 ? 'judge T2: pass 0.86 on try 2'
        : s < 22 ? 'librarian: 3 lessons recorded (cli)'
        : 'run complete: 4/4 merged';
      lines.push(row(span('t-s', '› ') + ev));
      lines.push(span('t-m', '╰' + '─'.repeat(W + 2)));
      term.innerHTML = lines.join('\n');
    }
    render();
    if (!reduced) setInterval(() => { step++; render(); }, 650);
  }

  // ---------- commands reference ----------
  const COMMANDS = [
    ['orchestra init', 'Set up .orchestra/ in the current git repo, seed harness v1, detect your test command.'],
    ['orchestra run "<goal>"', 'Plan, build, verify, merge, learn. Live dashboard on a TTY.'],
    ['  --detach', 'Run in the background; follow with orchestra watch.'],
    ['  --no-evolve', 'Skip the automatic evolution check after the run.'],
    ['  --serve', 'Also serve the web dashboard while the run is live.'],
    ['  --sandbox auto|srt|claude|off', 'OS-sandbox workers: writes only to the worktree and temp, no credential reads, limited network. Default off.'],
    ['  --sandbox docker', 'Container backend for untrusted repos (--network=none by default, --gvisor optional).'],
    ['  --unattended', 'Refuse to start without a sandbox backend; strips credentials from agent env.'],
    ['orchestra serve [--port N]', 'Read-only web dashboard on localhost (default 4317).'],
    ['orchestra serve --tui', 'Interactive terminal dashboard, no browser and no port (alias: orchestra tui).'],
    ['orchestra watch [runId]', 'Full-screen live dashboard (q to quit).'],
    ['orchestra status [runId]', 'One-shot board of the current or given run.'],
    ['orchestra bench', 'Fixed benchmark suite (arms × goals × repeats, hidden checks). --verify-oracles, --ablations.'],
    ['orchestra approve <runId> <taskId> --by <name>', 'Land a high-risk task held as awaiting_approval (opt-in oversight.riskTiers).'],
    ['orchestra resume <runId>', 'Finish deferred work after approval on the same run and integration branch.'],
    ['orchestra stats', 'Factory health per harness version plus outcome, oversight and throughput metrics (--json).'],
    ['orchestra evolve', 'Propose, evaluate, and maybe promote a better harness.'],
    ['orchestra learnings [--domain <slug>]', 'Show what the factory has learned in this repo.'],
    ['orchestra atlas find|neighbors|impact|tests <symbol>', 'Repo Atlas code graph queries (needs context.atlas.enabled).'],
    ['orchestra atlas build | stats', 'Build or inspect the Repo Atlas code graph for HEAD.'],
    ['orchestra evals', 'List Factory Eval cases (--regression, --tag <t>).'],
    ['orchestra evals add', 'Add a case, or harvest a failed run with --from-run <id> --fix <commit>.'],
    ['orchestra evals audit', 'Check cases and lessons for solution leakage.'],
    ['orchestra evals ablation', 'Replay the holdout with and without learnings.'],
    ['orchestra promote <vN>', 'Promote a harness version (also used for rollback).'],
    ['orchestra doctor', 'Check the Claude CLI and headless auth.'],
    ['orchestra demo', 'Simulated run in a temp repo. No tokens spent.'],
    ['orchestra statusline', 'Statusline command for Claude Code (reads JSON on stdin).']
  ];
  const table = $('#cmd-table');
  const search = $('#cmd-search');
  const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function renderCommands(q = '') {
    const needle = q.trim().toLowerCase();
    const rows = COMMANDS.filter(([c, d]) => !needle || (c + ' ' + d).toLowerCase().includes(needle));
    table.innerHTML = rows.length
      ? rows.map(([c, d]) => `<div class="cmd-row" role="listitem"><code>${escHtml(c)}</code><span>${escHtml(d)}</span></div>`).join('')
      : `<p class="cmd-empty">No command matches “${escHtml(q)}”.</p>`;
  }
  if (table) {
    renderCommands();
    search.addEventListener('input', () => renderCommands(search.value));
  }

  // ---------- tabs (WAI-ARIA pattern) ----------
  const tabs = $$('[role="tab"]');
  function selectTab(tab, focus) {
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = tabs.length - 1;
      if (j !== null) { e.preventDefault(); selectTab(tabs[j], true); }
    });
  });

  // ---------- reveal on scroll ----------
  if (!reduced && 'IntersectionObserver' in window) {
    const targets = $$('.section-head, .role, .tile, .step, .fact, .accordion details, .status-card, .player, .tabs');
    targets.forEach(el => el.classList.add('reveal'));
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: .12, rootMargin: '0px 0px -40px 0px' });
    targets.forEach((el, i) => {
      el.style.transitionDelay = (i % 5) * 60 + 'ms';
      io.observe(el);
    });
  }
})();
