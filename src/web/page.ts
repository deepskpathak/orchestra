// Single-file dashboard page. Vanilla JS, no external scripts or fonts (regulated environment:
// nothing may load from a CDN). The client code avoids template literals so this stays one string.

export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orchestra</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1c1c1a; --mute: #6b6b66; --line: #e2e2dd;
  --ok: #1a7f4b; --run: #0b6bcb; --judge: #7a3fc4; --warn: #b26a00; --bad: #c0392b; --idle: #9a9a94;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #131312; --panel: #1c1c1a; --ink: #ecece8; --mute: #9a9a94; --line: #2e2e2b;
    --ok: #4cc38a; --run: #5aa9ff; --judge: #b58cf0; --warn: #f0a93c; --bad: #ff7b6b; --idle: #6b6b66;
  }
}
:root[data-theme="dark"] {
  --bg: #131312; --panel: #1c1c1a; --ink: #ecece8; --mute: #9a9a94; --line: #2e2e2b;
  --ok: #4cc38a; --run: #5aa9ff; --judge: #b58cf0; --warn: #f0a93c; --bad: #ff7b6b; --idle: #6b6b66;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; display: grid; gap: 12px; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; }
h1 { font-size: 16px; margin: 0; letter-spacing: .02em; }
select, button { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit; }
button { cursor: pointer; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--mute); margin: 0 0 8px; font-weight: 600; }
.goal { font-size: 18px; font-weight: 600; margin: 0 0 8px; overflow-wrap: anywhere; }
.stats { display: flex; flex-wrap: wrap; gap: 6px 22px; color: var(--mute); }
.stats b { color: var(--ink); font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
.pipeline { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.stage { padding: 3px 10px; border-radius: 6px; border: 1px solid var(--line); color: var(--idle); font-size: 12px; font-weight: 600; }
.stage.active { color: var(--run); border-color: var(--run); }
.stage.done { color: var(--ok); border-color: var(--ok); }
.bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin-top: 10px; }
.bar > i { display: block; height: 100%; background: var(--ok); transition: width .3s; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--mute); font-size: 12px; font-weight: 600; }
tr.task { cursor: pointer; }
tr.task:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.s-pending { color: var(--idle); } .s-running { color: var(--run); } .s-judging { color: var(--judge); }
.s-repair { color: var(--warn); } .s-merging { color: var(--run); } .s-merged { color: var(--ok); }
.s-failed, .s-blocked { color: var(--bad); }
.s-planning, .s-compounding { color: var(--run); } .s-done { color: var(--ok); }
.r-planner { color: var(--run); } .r-worker { color: var(--run); } .r-judge { color: var(--judge); }
.r-librarian { color: var(--ok); } .r-evolver { color: var(--warn); }
.lane { display: grid; grid-template-columns: 90px 70px 1fr auto; gap: 8px; padding: 4px 0; align-items: baseline; }
.lane .act { color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12px; }
.events { font-family: var(--mono); font-size: 12px; max-height: 340px; overflow: auto; }
.ev { display: grid; grid-template-columns: 52px 1fr; gap: 8px; padding: 1px 0; }
.ev .t { color: var(--mute); }
.ev.hide { display: none; }
.detail td { background: color-mix(in srgb, var(--ink) 3%, transparent); }
.detail pre { margin: 6px 0; padding: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; max-height: 320px; overflow: auto; font: 12px/1.4 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.detail h3 { font-size: 12px; margin: 10px 0 2px; color: var(--mute); text-transform: uppercase; letter-spacing: .06em; }
.add { color: var(--ok); } .del { color: var(--bad); }
.muted { color: var(--mute); }
.empty { color: var(--mute); padding: 4px 0; }
label.chk { color: var(--mute); font-size: 12px; margin-left: 8px; }
#conn { font-size: 12px; color: var(--mute); }
@media (max-width: 640px) { .lane { grid-template-columns: 70px 1fr; } .lane .act { grid-column: 1 / -1; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>&#9835; Orchestra <span id="harness" class="muted"></span></h1>
    <div>
      <span id="conn">connecting</span>
      <select id="runs" aria-label="Run"></select>
      <button id="theme" type="button" aria-label="Toggle theme">Theme</button>
    </div>
  </header>
  <section class="card" id="summary"></section>
  <section class="card"><h2>Agents</h2><div id="agents"></div></section>
  <section class="card"><h2>Tasks</h2><div id="tasks"></div></section>
  <section class="card">
    <h2>Events <label class="chk"><input type="checkbox" id="actions"> tool actions</label></h2>
    <div class="events" id="events"></div>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = { run: null, events: [], source: null, open: {}, detail: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return h ? h + ':' + p(m % 60) + ':' + p(s % 60) : p(m) + ':' + p(s % 60);
  }
  function usd(n) { return '$' + (n || 0).toFixed(2); }
  function get(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      return r.json();
    });
  }

  // ---- theme (per-viewer convenience; page works if storage is blocked) ----
  function setTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
  }
  try { setTheme(localStorage.getItem('orchestra-theme')); } catch (e) {}
  $('theme').onclick = function () {
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var cur = document.documentElement.getAttribute('data-theme') || (dark ? 'dark' : 'light');
    var next = cur === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('orchestra-theme', next); } catch (e) {}
  };

  // ---- derived state, mirrors the TUI phases ----
  function phases(run) {
    var by = function (ss) { return run.tasks.filter(function (t) { return ss.indexOf(t.status) >= 0; }).length; };
    var pendingish = by(['pending', 'repair']);
    var hasJudge = run.active.some(function (a) { return a.role === 'judge'; });
    var hasWorker = run.active.some(function (a) { return a.role === 'worker'; });
    var merging = run.tasks.some(function (t) { return t.status === 'merging'; });
    var late = run.status === 'compounding' || run.status === 'done';
    return [
      ['PLAN', run.status === 'planning', run.status !== 'planning'],
      ['BUILD', hasWorker, run.status !== 'planning' && !hasWorker && pendingish === 0],
      ['VERIFY', hasJudge, late],
      ['MERGE', merging, late],
      ['LEARN', run.status === 'compounding', run.status === 'done' && run.kind === 'goal']
    ];
  }

  function renderSummary() {
    var run = state.run;
    if (!run) { $('summary').innerHTML = '<div class="empty">No run yet. Start one with <code>orchestra run "goal"</code>.</div>'; return; }
    var end = run.endedAt || Date.now();
    var merged = run.tasks.filter(function (t) { return t.status === 'merged'; }).length;
    var total = run.tasks.length;
    var stages = phases(run).map(function (p) {
      return '<span class="stage ' + (p[1] ? 'active' : p[2] ? 'done' : '') + '">' + (p[1] ? '&#9654; ' : p[2] ? '&#10003; ' : '') + p[0] + '</span>';
    }).join('');
    $('summary').innerHTML =
      '<p class="goal">' + esc(run.goal) + '</p>' +
      '<div class="stats">' +
      '<span class="badge s-' + esc(run.status) + '">' + esc(run.status) + '</span>' +
      '<span>run <b>' + esc(run.id) + '</b></span>' +
      '<span>harness <b>' + esc(run.harness) + '</b></span>' +
      '<span>elapsed <b>' + clock(end - run.startedAt) + '</b></span>' +
      '<span>cost <b>' + usd(run.costUsd) + '</b></span>' +
      '<span>merged <b>' + merged + '/' + total + '</b></span>' +
      (run.satisfaction != null ? '<span>satisfaction <b>' + run.satisfaction.toFixed(2) + '</b></span>' : '') +
      '</div>' +
      '<div class="pipeline">' + stages + '</div>' +
      '<div class="bar"><i style="width:' + (total ? Math.round(merged / total * 100) : 0) + '%"></i></div>' +
      (run.error ? '<p class="s-failed">' + esc(run.error) + '</p>' : '') +
      (merged && run.integrationBranch && run.status === 'done'
        ? '<p class="muted">Land: <code>git merge ' + esc(run.integrationBranch) + '</code></p>' : '');
  }

  function renderAgents() {
    var run = state.run;
    if (!run || !run.active.length) { $('agents').innerHTML = '<div class="empty">' + (run && run.status === 'done' ? 'all agents finished' : 'no agents active') + '</div>'; return; }
    $('agents').innerHTML = run.active.map(function (a) {
      return '<div class="lane"><b class="r-' + esc(a.role) + '">' + esc(a.role) + '</b>' +
        '<span class="muted">' + esc(a.task || '') + ' ' + esc(a.model) + '</span>' +
        '<span class="act" title="' + esc(a.lastAction) + '">' + esc(a.lastAction) + '</span>' +
        '<span class="num muted">' + clock(Date.now() - a.startedAt) + ' &middot; ' + a.tools + ' tools &middot; ' + usd(a.costUsd) + '</span></div>';
    }).join('');
  }

  function renderTasks() {
    var run = state.run;
    if (!run || !run.tasks.length) { $('tasks').innerHTML = '<div class="empty">no tasks yet</div>'; return; }
    var rows = run.tasks.map(function (t) {
      var v = t.verdict;
      var open = state.open[t.id];
      return '<tr class="task" data-id="' + esc(t.id) + '"><td class="s-' + esc(t.status) + '"><b>' + esc(t.id) + '</b></td>' +
        '<td class="s-' + esc(t.status) + '">' + esc(t.status) + '</td>' +
        '<td>' + esc(t.title) + '</td>' +
        '<td class="num">' + (v ? v.score.toFixed(2) : '-') + '</td>' +
        '<td class="num">' + t.attempts + '</td>' +
        '<td class="num">' + usd(t.costUsd) + '</td></tr>' +
        (open ? '<tr class="detail"><td colspan="6">' + detailHtml(t) + '</td></tr>' : '');
    }).join('');
    $('tasks').innerHTML = '<table><thead><tr><th>ID</th><th>Status</th><th>Title</th><th>Score</th><th>Try</th><th>Cost</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function diffHtml(d) {
    return d.split('\n').map(function (l) {
      var c = l.charAt(0) === '+' && l.indexOf('+++') !== 0 ? 'add' : l.charAt(0) === '-' && l.indexOf('---') !== 0 ? 'del' : '';
      return c ? '<span class="' + c + '">' + esc(l) + '</span>' : esc(l);
    }).join('\n');
  }

  function detailHtml(t) {
    var v = t.verdict, d = state.detail[t.id];
    var out = '<p class="muted">' + esc(t.description) + '</p>';
    if (t.acceptance && t.acceptance.length) out += '<h3>Acceptance</h3><ul>' + t.acceptance.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>';
    if (v) {
      out += '<h3>Verdict ' + (v.pass ? 'PASS' : 'FAIL') + ' ' + v.score.toFixed(2) + (v.testsPassed === null ? '' : v.testsPassed ? ' &middot; tests passed' : ' &middot; tests failed') + '</h3><p>' + esc(v.summary) + '</p>';
      if (v.issues && v.issues.length) out += '<ul>' + v.issues.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>';
    }
    if (t.notes && t.notes.length) out += '<h3>Repair notes</h3><ul>' + t.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    if (!d) return out + '<p class="muted">loading diff and logs&hellip;</p>';
    if (d.error) return out + '<p class="s-failed">' + esc(d.error) + '</p>';
    out += '<h3>Diff</h3>' + (d.diff ? '<pre>' + diffHtml(d.diff) + '</pre>' : '<p class="muted">not available (branch pruned or no changes)</p>');
    d.logs.forEach(function (l) { out += '<h3>' + esc(l.name) + ' (tail)</h3><pre>' + esc(l.tail) + '</pre>'; });
    return out;
  }

  function renderEvents() {
    var showActions = $('actions').checked;
    var run = state.run, t0 = run ? run.startedAt : 0;
    var evs = state.events.filter(function (e) { return showActions || e.kind !== 'agent.action'; }).slice(-250);
    var box = $('events');
    var stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.innerHTML = evs.length ? evs.map(function (e) {
      var cls = e.kind === 'task.failed' ? 's-failed' : e.kind === 'task.merged' ? 's-merged' : e.kind === 'task.repair' ? 's-repair' : e.role ? 'r-' + e.role : '';
      return '<div class="ev"><span class="t">' + clock(e.t - t0) + '</span><span class="' + cls + '">' + esc(e.msg) + '</span></div>';
    }).join('') : '<div class="empty">no events yet</div>';
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function renderAll() { renderSummary(); renderAgents(); renderTasks(); renderEvents(); }

  $('actions').onchange = renderEvents;
  $('tasks').addEventListener('click', function (ev) {
    var tr = ev.target.closest && ev.target.closest('tr.task');
    if (!tr || !state.run) return;
    var id = tr.getAttribute('data-id');
    state.open[id] = !state.open[id];
    renderTasks();
    if (state.open[id]) loadDetail(id);
  });
  function loadDetail(id) {
    var runId = state.run.id;
    get('/api/runs/' + encodeURIComponent(runId) + '/tasks/' + encodeURIComponent(id))
      .then(function (d) { state.detail[id] = d; })
      .catch(function (e) { state.detail[id] = { error: e.message }; })
      .then(function () { if (state.run && state.run.id === runId) renderTasks(); });
  }

  // 1s tick keeps elapsed clocks moving between pushes
  setInterval(function () { if (state.run && !state.run.endedAt) { renderSummary(); renderAgents(); } }, 1000);

  function connect(runId) {
    if (state.source) state.source.close();
    state.run = null; state.events = []; state.open = {}; state.detail = {};
    renderAll();
    var es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/stream');
    state.source = es;
    es.onopen = function () { $('conn').textContent = 'live'; };
    es.onerror = function () { $('conn').textContent = 'reconnecting'; };
    es.onmessage = function (m) {
      var d = JSON.parse(m.data);
      state.run = d.run;
      state.events = d.reset ? d.events : state.events.concat(d.events);
      renderSummary(); renderAgents();
      var prev = state.tasksJson, now = JSON.stringify(d.run.tasks);
      if (prev !== now) { state.tasksJson = now; renderTasks(); }
      renderEvents();
      // Refresh open task details when a task changes, so diff and logs follow the run.
      Object.keys(state.open).forEach(function (id) { if (state.open[id] && prev !== now) loadDetail(id); });
    };
  }

  function loadRuns(selectId) {
    return get('/api/runs').then(function (d) {
      var sel = $('runs');
      sel.innerHTML = d.runs.map(function (r) {
        return '<option value="' + esc(r.id) + '">' + esc(r.id) + ' &middot; ' + esc(r.status) + ' &middot; ' + esc(r.goal.slice(0, 50)) + '</option>';
      }).join('');
      if (selectId) sel.value = selectId;
      return d.runs;
    });
  }

  $('runs').onchange = function () { connect(this.value); };

  get('/api/info').then(function (info) {
    $('harness').textContent = 'harness ' + info.harness;
    return loadRuns(info.current).then(function (runs) {
      if (runs.length) connect(info.current || runs[0].id); else renderAll();
      // New runs appear while the page is open; refresh the picker and follow a newer current run.
      setInterval(function () {
        get('/api/info').then(function (i) {
          var sel = $('runs');
          if (i.current && i.current !== sel.value && !sel.querySelector('option[value="' + i.current + '"]')) {
            loadRuns(i.current).then(function () { connect(i.current); });
          }
        }).catch(function () {});
      }, 3000);
    });
  }).catch(function (e) { $('conn').textContent = 'error: ' + e.message; });
})();
</script>
</body>
</html>
`;
