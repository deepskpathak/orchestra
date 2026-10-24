// Single-file dashboard page. Vanilla JS, no external scripts or fonts (regulated environment:
// nothing may load from a CDN). The client code avoids template literals so this stays one string,
// and must never contain a dollar sign followed by a brace (String.raw would interpolate it).
//
// Layout: a run hero (progress ring, pipeline stepper, status mix), a Trello-style task board with
// SVG dependency wires (Board view groups by status, Flow view groups by dependency depth), live agent
// lanes, an activity feed, and a slide-in drawer with verdict, diff and logs for one task.

export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orchestra Board</title>
<style>
:root {
  --bg: #f5f4f0; --panel: #ffffff; --col: #ecebe5; --ink: #1d1d1b; --mute: #6c6b66; --faint: #a6a59f; --line: #e2e1db;
  --accent: #5b5bd6; --ok: #17845a; --run: #2f6fdf; --judge: #8250df; --warn: #c27803; --bad: #d1453b; --idle: #9b9a94;
  --shadow: 0 1px 2px rgba(25, 25, 15, .06), 0 2px 8px rgba(25, 25, 15, .05);
  --shadow-hi: 0 8px 24px rgba(25, 25, 15, .12), 0 2px 6px rgba(25, 25, 15, .08);
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111113; --panel: #1b1b1f; --col: #161619; --ink: #ececf1; --mute: #9d9da6; --faint: #66666f; --line: #2b2b31;
    --accent: #8b8bf5; --ok: #4cc38a; --run: #6ea8ff; --judge: #b693f7; --warn: #f0b14a; --bad: #ff7d70; --idle: #74747d;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 2px 8px rgba(0, 0, 0, .25);
    --shadow-hi: 0 10px 28px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .35);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #111113; --panel: #1b1b1f; --col: #161619; --ink: #ececf1; --mute: #9d9da6; --faint: #66666f; --line: #2b2b31;
  --accent: #8b8bf5; --ok: #4cc38a; --run: #6ea8ff; --judge: #b693f7; --warn: #f0b14a; --bad: #ff7d70; --idle: #74747d;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 2px 8px rgba(0, 0, 0, .25);
  --shadow-hi: 0 10px 28px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .35);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 14px/1.45 var(--sans); -webkit-font-smoothing: antialiased; }
button, select { font: inherit; color: inherit; }
code { font-family: var(--mono); font-size: 12px; background: color-mix(in srgb, var(--ink) 7%, transparent); padding: 1px 5px; border-radius: 4px; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.muted { color: var(--mute); }

/* tones: every status and role maps to one colour token */
.t-idle { --tone: var(--idle); } .t-run { --tone: var(--run); } .t-judge { --tone: var(--judge); }
.t-warn { --tone: var(--warn); } .t-ok { --tone: var(--ok); } .t-bad { --tone: var(--bad); } .t-accent { --tone: var(--accent); }

/* ---- top bar ---- */
.top { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
.top-in { max-width: 1440px; margin: 0 auto; padding: 10px 20px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: .01em; margin-right: auto; }
.logo { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: #fff; font-size: 15px; background: linear-gradient(135deg, var(--accent), var(--judge)); box-shadow: var(--shadow); }
.brand small { font-weight: 500; color: var(--mute); }
.ctrls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--mute); padding: 4px 10px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); }
.conn i { width: 7px; height: 7px; border-radius: 50%; background: var(--idle); }
.conn.live i { background: var(--ok); box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); animation: ping 2s infinite; }
.conn.bad i { background: var(--warn); }
select, .btn { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; box-shadow: var(--shadow); }
select { max-width: min(380px, 70vw); text-overflow: ellipsis; }
.btn { cursor: pointer; line-height: 1.2; }
.btn.icon { display: grid; place-items: center; width: 34px; height: 32px; padding: 0; }
.btn:hover, select:hover { border-color: color-mix(in srgb, var(--ink) 25%, var(--line)); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

main { max-width: 1440px; margin: 0 auto; padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
main > *, .duo > * { min-width: 0; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
.ph { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 14px 16px 0; }
.ph h2 { font-size: 13px; margin: 0; font-weight: 650; letter-spacing: .02em; }
.ph .sp { flex: 1; }
.count { font-size: 11px; font-weight: 600; color: var(--mute); background: color-mix(in srgb, var(--ink) 6%, transparent); border-radius: 999px; padding: 1px 8px; }

/* ---- hero ---- */
.hero { display: grid; grid-template-columns: 1fr auto; gap: 18px 28px; padding: 20px 22px; }
.eyebrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--mute); }
.goal { font-size: 22px; line-height: 1.25; font-weight: 700; margin: 10px 0 14px; letter-spacing: -.01em; overflow-wrap: anywhere; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; }
.stat { background: color-mix(in srgb, var(--ink) 4%, transparent); border-radius: 10px; padding: 6px 12px; min-width: 92px; }
.stat > span { display: block; font-size: 11px; color: var(--mute); text-transform: uppercase; letter-spacing: .06em; }
.stat b { font-size: 16px; font-variant-numeric: tabular-nums; }
.ring-wrap { position: relative; width: 132px; height: 132px; align-self: center; }
.ring { width: 132px; height: 132px; }
.ring circle { fill: none; stroke-width: 10; }
.ring .bg { stroke: color-mix(in srgb, var(--ink) 7%, transparent); }
.ring .flight { stroke: color-mix(in srgb, var(--run) 35%, transparent); stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
.ring .fg { stroke: var(--ok); stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
.ring-label { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
.ring-label b { font-size: 26px; font-weight: 750; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.ring-label span { font-size: 11px; color: var(--mute); }
.hero-foot { grid-column: 1 / -1; display: grid; gap: 14px; }
.alert { border-radius: 10px; padding: 8px 12px; font-size: 13px; background: color-mix(in srgb, var(--tone) 12%, transparent); color: var(--tone); }
.alert code { color: var(--ink); }

/* pipeline stepper */
.stepper { display: flex; align-items: center; gap: 0; overflow-x: auto; padding: 2px 0; }
.step { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 650; letter-spacing: .06em; color: var(--faint); white-space: nowrap; }
.step .node { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; border: 2px solid var(--line); background: var(--panel); }
.step.done { color: var(--ink); } .step.done .node { background: var(--ok); border-color: var(--ok); color: #fff; }
.step.active { color: var(--run); } .step.active .node { border-color: var(--run); box-shadow: 0 0 0 0 color-mix(in srgb, var(--run) 50%, transparent); animation: ping 1.6s infinite; }
.step.active .node::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--run); }
.link { flex: 1 0 24px; height: 2px; min-width: 24px; margin: 0 10px; background: var(--line); border-radius: 1px; }
.link.done { background: var(--ok); }

/* status mix */
.mix { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, var(--ink) 6%, transparent); }
.mix i { display: block; height: 100%; background: var(--tone); transition: width .5s ease; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--mute); margin-top: 8px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 8px; height: 8px; border-radius: 3px; background: var(--tone); }
.legend b { color: var(--ink); font-variant-numeric: tabular-nums; }

/* ---- board ---- */
.seg-ctl { display: inline-flex; background: color-mix(in srgb, var(--ink) 6%, transparent); border-radius: 9px; padding: 3px; }
.seg-ctl button { border: 0; background: transparent; padding: 4px 12px; border-radius: 7px; cursor: pointer; color: var(--mute); font-size: 12px; font-weight: 600; }
.seg-ctl button[aria-pressed="true"] { background: var(--panel); color: var(--ink); box-shadow: var(--shadow); }
.wire-key { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--mute); }
.wire-key span { display: inline-flex; align-items: center; gap: 6px; }
.wire-key svg { width: 22px; height: 6px; }
.board { overflow-x: auto; padding: 14px 16px 18px; scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch; }
.board-in { position: relative; min-width: 100%; width: max-content; }
.cols { display: flex; gap: 34px; align-items: flex-start; }
.col { flex: 1 0 236px; max-width: 360px; background: var(--col); border-radius: 14px; padding: 10px; scroll-snap-align: start; transition: flex-basis .3s ease; }
.col.is-empty { flex: 0 0 140px; }
.col-h { display: flex; align-items: center; gap: 8px; padding: 2px 4px 10px; font-size: 12px; font-weight: 650; }
.col-h .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); }
.col-h .sub { margin-left: auto; font-weight: 500; color: var(--mute); font-size: 11px; }
.col-body { display: flex; flex-direction: column; gap: 12px; min-height: 64px; }
.col-body:empty::before { content: "Nothing here"; display: grid; place-items: center; height: 64px; font-size: 12px; color: var(--faint); border: 1.5px dashed var(--line); border-radius: 10px; }
.wires { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 1; overflow: visible; }
.wire { fill: none; stroke-width: 1.7; stroke: var(--faint); opacity: .8; transition: opacity .2s, stroke-width .2s; }
.wire.wait { stroke-dasharray: 4 5; }
.wire.ok { stroke: var(--ok); }
.wire.live { stroke: var(--run); stroke-dasharray: 6 6; animation: dash .9s linear infinite; }
.wire.bad { stroke: var(--bad); stroke-dasharray: 2 5; }
.mk { stroke: none; }
.mk.wait { fill: var(--faint); } .mk.ok { fill: var(--ok); } .mk.live { fill: var(--run); } .mk.bad { fill: var(--bad); }

.card { position: relative; z-index: 2; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px 10px 14px; box-shadow: var(--shadow); cursor: pointer; transition: box-shadow .2s, border-color .2s, opacity .2s, transform .2s; overflow: hidden; }
.card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--tone); }
.card:hover { box-shadow: var(--shadow-hi); border-color: color-mix(in srgb, var(--tone) 40%, var(--line)); }
.card.live { border-color: color-mix(in srgb, var(--tone) 45%, var(--line)); }
.card.sel { box-shadow: 0 0 0 2px var(--accent), var(--shadow-hi); }
.card.enter { animation: pop .35s cubic-bezier(.2, .8, .2, 1); }
.c-top { display: flex; align-items: center; gap: 8px; }
.tid { font: 600 11px var(--mono); color: var(--mute); background: color-mix(in srgb, var(--ink) 6%, transparent); padding: 1px 6px; border-radius: 5px; }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 650; color: var(--tone); background: color-mix(in srgb, var(--tone) 13%, transparent); padding: 2px 8px 2px 7px; border-radius: 999px; white-space: nowrap; }
.pill i { width: 6px; height: 6px; border-radius: 50%; background: var(--tone); }
.pill.pulse i { animation: blink 1.2s ease-in-out infinite; }
.c-top .retry { margin-left: auto; font-size: 11px; color: var(--warn); font-weight: 600; }
.c-title { font-weight: 600; margin: 8px 0 10px; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.track { display: flex; gap: 4px; }
.track .seg { flex: 1; height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--ink) 9%, transparent); }
.track .seg.done { background: var(--ok); }
.track .seg.bad { background: var(--bad); }
.track .seg.now { background: linear-gradient(90deg, var(--tone), color-mix(in srgb, var(--tone) 30%, transparent), var(--tone)); background-size: 200% 100%; animation: flow 1.4s linear infinite; }
.track-l { display: flex; justify-content: space-between; font-size: 10px; color: var(--faint); margin-top: 4px; letter-spacing: .04em; text-transform: uppercase; }
.c-agent { display: flex; align-items: center; gap: 7px; margin-top: 9px; padding: 5px 8px; border-radius: 8px; background: color-mix(in srgb, var(--tone) 9%, transparent); font-size: 12px; min-width: 0; }
.c-agent b { color: var(--tone); font-weight: 650; }
.act { font-family: var(--mono); font-size: 11.5px; color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.c-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 11.5px; color: var(--mute); }
.c-foot .sp { flex: 1; }
.deps { display: inline-flex; gap: 3px; align-items: center; flex-wrap: wrap; }
.dep { font: 600 10.5px var(--mono); padding: 0 5px; border-radius: 4px; color: var(--tone); background: color-mix(in srgb, var(--tone) 12%, transparent); }
.score { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; color: var(--tone); }
.score svg { width: 16px; height: 16px; transform: rotate(-90deg); }
.score circle { fill: none; stroke-width: 3; }
.score .bg { stroke: color-mix(in srgb, var(--ink) 10%, transparent); }
.score .fg { stroke: var(--tone); stroke-linecap: round; }
.board.focus .card { opacity: .35; }
.board.focus .card.rel { opacity: 1; }
.board.focus .card.hot { box-shadow: 0 0 0 2px var(--tone), var(--shadow-hi); }
.board.focus .wire { opacity: .1; }
.board.focus .wire.rel { opacity: 1; stroke-width: 2.6; }
.empty-board { padding: 40px 16px; text-align: center; color: var(--mute); }
.empty-board b { display: block; color: var(--ink); font-size: 15px; margin-bottom: 4px; }

/* ---- agents + activity ---- */
.duo { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 18px; align-items: start; }
.agents { display: grid; gap: 10px; padding: 14px 16px 16px; }
.agent { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: color-mix(in srgb, var(--tone) 4%, var(--panel)); }
.av { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font-weight: 750; color: var(--tone); background: color-mix(in srgb, var(--tone) 15%, transparent); position: relative; }
.av::after { content: ""; position: absolute; right: -2px; top: -2px; width: 9px; height: 9px; border-radius: 50%; background: var(--tone); border: 2px solid var(--panel); animation: blink 1.4s ease-in-out infinite; }
.ag-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; }
.ag-top b { text-transform: capitalize; }
.ag-top .model { font-size: 11px; color: var(--mute); }
.ag-meta { text-align: right; font-size: 11.5px; color: var(--mute); display: grid; gap: 1px; }
.ag-meta b { color: var(--ink); font-size: 13px; }
.feed-wrap { padding: 8px 6px 10px 16px; }
.feed { max-height: 420px; overflow: auto; padding-right: 10px; font-size: 13px; }
.ev { display: grid; grid-template-columns: 46px 18px minmax(0, 1fr); gap: 8px; align-items: start; padding: 5px 0; position: relative; }
.ev .t { font: 11px var(--mono); color: var(--faint); padding-top: 2px; }
.ev .ico { width: 18px; height: 18px; border-radius: 6px; display: grid; place-items: center; font-size: 10px; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); }
.ev .m { overflow-wrap: anywhere; }
.ev.minor .m { font-family: var(--mono); font-size: 11.5px; color: var(--mute); }
.chk { font-size: 12px; color: var(--mute); display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
.none { color: var(--faint); font-size: 13px; padding: 6px 0; }

/* ---- drawer ---- */
.scrim { position: fixed; inset: 0; background: rgba(10, 10, 10, .28); opacity: 0; pointer-events: none; transition: opacity .25s; z-index: 30; }
.scrim.on { opacity: 1; pointer-events: auto; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(620px, 100vw); background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow-hi); z-index: 31; transform: translateX(104%); visibility: hidden; transition: transform .3s cubic-bezier(.2, .8, .2, 1), visibility 0s .3s; display: flex; flex-direction: column; }
.drawer.on { transform: none; visibility: visible; transition: transform .3s cubic-bezier(.2, .8, .2, 1); }
.dr-head { padding: 16px 18px 12px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
.dr-row { display: flex; align-items: center; gap: 8px; }
.dr-row .x { margin-left: auto; border: 0; background: transparent; font-size: 18px; cursor: pointer; color: var(--mute); width: 32px; height: 32px; border-radius: 8px; }
.dr-row .x:hover { background: color-mix(in srgb, var(--ink) 7%, transparent); }
.dr-title { font-size: 18px; font-weight: 700; margin: 0; line-height: 1.3; overflow-wrap: anywhere; }
.dr-body { overflow: auto; padding: 16px 18px 28px; display: grid; gap: 18px; align-content: start; }
.dr-body h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--mute); margin: 0 0 8px; font-weight: 650; }
.grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.grid4 .stat { min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font-size: 12px; cursor: pointer; background: var(--panel); max-width: 100%; }
.chip:hover { border-color: var(--tone); }
.chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); flex: none; }
.chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crit { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.crit li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--ink) 3.5%, transparent); }
.crit .mark { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: var(--tone); background: color-mix(in srgb, var(--tone) 15%, transparent); }
.crit .note { display: block; color: var(--mute); font-size: 12px; margin-top: 2px; }
.verdict { border-radius: 12px; padding: 12px 14px; background: color-mix(in srgb, var(--tone) 8%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 25%, transparent); }
.verdict .vh { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-weight: 650; }
.verdict p { margin: 8px 0 0; }
.verdict ul, .plain { margin: 8px 0 0; padding-left: 18px; }
.meter { position: relative; height: 8px; border-radius: 999px; background: color-mix(in srgb, var(--ink) 8%, transparent); margin-top: 10px; }
.meter i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--tone); }
.meter s { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--ink); opacity: .5; text-decoration: none; }
details { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
summary { cursor: pointer; padding: 10px 12px; font-size: 13px; font-weight: 600; background: color-mix(in srgb, var(--ink) 3%, transparent); list-style-position: inside; }
pre { margin: 0; padding: 10px 12px; max-height: 420px; overflow: auto; font: 12px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.add { color: var(--ok); background: color-mix(in srgb, var(--ok) 8%, transparent); display: inline-block; width: 100%; }
.del { color: var(--bad); background: color-mix(in srgb, var(--bad) 8%, transparent); display: inline-block; width: 100%; }
.hunk { color: var(--accent); }
.file { color: var(--ink); font-weight: 700; }
.desc { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }

@keyframes ping { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--run) 45%, transparent); } 80%, 100% { box-shadow: 0 0 0 8px transparent; } }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
@keyframes flow { from { background-position: 200% 0; } to { background-position: 0 0; } }
@keyframes dash { to { stroke-dashoffset: -12; } }
@keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
@media (max-width: 900px) { .duo { grid-template-columns: 1fr; } }
@media (max-width: 640px) {
  .top-in, main { padding-left: 16px; padding-right: 16px; }
  .brand small { display: none; }
  .ctrls { width: 100%; flex-wrap: nowrap; }
  .ctrls select { flex: 1; min-width: 0; max-width: none; }
  .hero { grid-template-columns: 1fr; padding: 16px; }
  .ring-wrap { justify-self: start; width: 104px; height: 104px; order: -1; }
  .ring { width: 104px; height: 104px; }
  .ring-label b { font-size: 21px; }
  .goal { font-size: 18px; }
  .stat { min-width: 0; flex: 1 1 40%; }
  .board { padding: 12px; }
  .col { flex-basis: 78vw; }
  .grid4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .agent { grid-template-columns: auto minmax(0, 1fr); }
  .ag-meta { grid-column: 1 / -1; text-align: left; display: flex; gap: 12px; }
}
</style>
</head>
<body>
<header class="top"><div class="top-in">
  <div class="brand"><span class="logo">&#9835;</span>Orchestra <small id="harness"></small></div>
  <div class="ctrls">
    <span class="conn" id="conn"><i></i><span>connecting</span></span>
    <select id="runs" aria-label="Run"></select>
    <button class="btn icon" id="theme" type="button" aria-label="Toggle colour theme" title="Toggle theme"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"></circle><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"></path></svg></button>
  </div>
</div></header>

<main>
  <section class="panel hero" id="hero">
    <div>
      <div class="eyebrow" id="eyebrow"></div>
      <h1 class="goal" id="goal">Loading&hellip;</h1>
      <div class="stats" id="stats"></div>
    </div>
    <div class="ring-wrap" id="ringwrap">
      <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="bg" cx="60" cy="60" r="52"></circle>
        <circle class="flight" id="ring-flight" cx="60" cy="60" r="52" transform="rotate(-90 60 60)"></circle>
        <circle class="fg" id="ring-fg" cx="60" cy="60" r="52" transform="rotate(-90 60 60)"></circle>
      </svg>
      <div class="ring-label"><b id="ring-pct">0%</b><span id="ring-sub">no tasks</span></div>
    </div>
    <div class="hero-foot">
      <div class="stepper" id="stepper"></div>
      <div><div class="mix" id="mix"></div><div class="legend" id="legend"></div></div>
      <div id="alerts"></div>
    </div>
  </section>

  <section class="panel">
    <div class="ph">
      <h2>Task board</h2><span class="count" id="taskcount">0</span>
      <div class="seg-ctl" role="group" aria-label="Board layout">
        <button type="button" data-view="board" aria-pressed="true" title="Columns by status">Board</button>
        <button type="button" data-view="flow" aria-pressed="false" title="Columns by dependency depth">Flow</button>
      </div>
      <span class="sp"></span>
      <div class="wire-key" aria-label="Dependency arrow legend">
        <span><svg viewBox="0 0 22 6"><path d="M1 3H21" class="wire ok" style="animation:none"/></svg>dep merged</span>
        <span><svg viewBox="0 0 22 6"><path d="M1 3H21" class="wire live" style="animation:none"/></svg>dep in progress</span>
        <span><svg viewBox="0 0 22 6"><path d="M1 3H21" class="wire wait"/></svg>waiting</span>
        <span><svg viewBox="0 0 22 6"><path d="M1 3H21" class="wire bad"/></svg>dep failed</span>
      </div>
    </div>
    <div class="board" id="board"></div>
  </section>

  <div class="duo">
    <section class="panel">
      <div class="ph"><h2>Live agents</h2><span class="count" id="agentcount">0</span></div>
      <div class="agents" id="agents"></div>
    </section>
    <section class="panel">
      <div class="ph"><h2>Activity</h2><span class="sp"></span><label class="chk"><input type="checkbox" id="actions"> tool calls</label></div>
      <div class="feed-wrap"><div class="feed" id="events"></div></div>
    </section>
  </div>
</main>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-hidden="true" aria-label="Task detail">
  <div class="dr-head" id="dr-head"></div>
  <div class="dr-body" id="dr-body"></div>
</aside>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var RING = 2 * Math.PI * 52;
  var TONE = { pending: 'idle', running: 'run', repair: 'warn', judging: 'judge', merging: 'accent', merged: 'ok', failed: 'bad', blocked: 'bad', needs_human: 'warn',
    planning: 'run', compounding: 'accent', done: 'ok' };
  var LABEL = { pending: 'Queued', running: 'Building', repair: 'Repairing', judging: 'Verifying', merging: 'Merging', merged: 'Merged', failed: 'Failed', blocked: 'Blocked', needs_human: 'Needs human' };
  var ROLE_TONE = { planner: 'accent', worker: 'run', judge: 'judge', librarian: 'ok', evolver: 'warn' };
  var ACTIVE = { running: 1, repair: 1, judging: 1, merging: 1 };
  // Rough share of the pipeline a task has covered, for the in-flight arc of the ring.
  var WEIGHT = { pending: 0, blocked: 0, failed: 0, needs_human: 0, running: .25, repair: .2, judging: .55, merging: .8, merged: 1 };
  var COLS = [
    { key: 'queued', name: 'Queued', tone: 'idle', has: ['pending'] },
    { key: 'build', name: 'Building', tone: 'run', has: ['running', 'repair'] },
    { key: 'verify', name: 'Verifying', tone: 'judge', has: ['judging'] },
    { key: 'merge', name: 'Merging', tone: 'accent', has: ['merging'] },
    { key: 'done', name: 'Done', tone: 'ok', has: ['merged'] },
    { key: 'human', name: 'Needs human', tone: 'warn', has: ['needs_human'] },
    { key: 'stuck', name: 'Failed', tone: 'bad', has: ['failed', 'blocked'] }
  ];
  var MIX = [
    { name: 'Done', tone: 'ok', has: ['merged'] },
    { name: 'Merging', tone: 'accent', has: ['merging'] },
    { name: 'Verifying', tone: 'judge', has: ['judging'] },
    { name: 'Building', tone: 'run', has: ['running', 'repair'] },
    { name: 'Queued', tone: 'idle', has: ['pending'] },
    { name: 'Needs human', tone: 'warn', has: ['needs_human'] },
    { name: 'Failed', tone: 'bad', has: ['failed', 'blocked'] }
  ];
  var EV = {
    'run.start': ['&#9835;', 'accent'], 'run.end': ['&#9632;', 'accent'], plan: ['&#9671;', 'accent'],
    'task.start': ['&#9654;', 'run'], 'task.verdict': ['&#9878;', 'judge'], 'task.repair': ['&#8635;', 'warn'],
    'task.merged': ['&#10003;', 'ok'], 'task.failed': ['&#10005;', 'bad'], 'task.needs_human': ['&#63;', 'warn'], 'agent.start': ['&#9679;', 'run'],
    'agent.action': ['&#8250;', 'idle'], 'agent.end': ['&#9675;', 'idle'], learn: ['&#10022;', 'ok'], evolve: ['&#10227;', 'warn'], log: ['&#183;', 'idle']
  };

  var state = { info: {}, run: null, byId: {}, events: [], source: null, view: 'board', sel: null, detail: {},
    cards: {}, colsKey: '', hover: null, selJson: '', selTask: '', wiresKey: '', agents: {}, evKey: '', openDetails: {} };

  // ---------- helpers ----------
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
  function count(run, list) { return run.tasks.filter(function (t) { return list.indexOf(t.status) >= 0; }).length; }
  function agentFor(id) {
    var a = null;
    (state.run ? state.run.active : []).forEach(function (x) { if (x.task === id) a = x; });
    return a;
  }
  // Live clocks: any element with data-since ticks every second (data-until freezes it).
  function since(start, end) {
    return '<span class="num" data-since="' + (start || 0) + '"' + (end ? ' data-until="' + end + '"' : '') + '>' + clock((end || Date.now()) - start) + '</span>';
  }
  function tick() {
    var now = Date.now();
    document.querySelectorAll('[data-since]').forEach(function (el) {
      var s = +el.getAttribute('data-since'), u = el.getAttribute('data-until');
      if (s && !u) el.textContent = clock(now - s);
    });
  }
  function scoreRing(score, pass) {
    var c = 2 * Math.PI * 6, off = c * (1 - Math.max(0, Math.min(1, score)));
    return '<span class="score t-' + (pass ? 'ok' : 'bad') + '" title="judge score"><svg viewBox="0 0 16 16"><circle class="bg" cx="8" cy="8" r="6"></circle>' +
      '<circle class="fg" cx="8" cy="8" r="6" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"></circle></svg>' + score.toFixed(2) + '</span>';
  }

  // ---------- theme (per-viewer convenience; page works if storage is blocked) ----------
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
  try { if (localStorage.getItem('orchestra-view') === 'flow') state.view = 'flow'; } catch (e) {}

  // ---------- hero ----------
  function phases(run) {
    var pendingish = count(run, ['pending', 'repair']);
    var hasJudge = run.active.some(function (a) { return a.role === 'judge'; });
    var hasWorker = run.active.some(function (a) { return a.role === 'worker'; });
    var merging = run.tasks.some(function (t) { return t.status === 'merging'; });
    var late = run.status === 'compounding' || run.status === 'done';
    return [
      ['Plan', run.status === 'planning', run.status !== 'planning'],
      ['Build', hasWorker, run.status !== 'planning' && !hasWorker && pendingish === 0],
      ['Verify', hasJudge, late],
      ['Merge', merging, late],
      ['Learn', run.status === 'compounding', run.status === 'done' && run.kind === 'goal']
    ];
  }

  function renderHero() {
    var run = state.run;
    if (!run) {
      $('eyebrow').innerHTML = '';
      $('goal').textContent = 'No runs yet';
      $('stats').innerHTML = '<span class="muted">Start one with <code>orchestra run "your goal"</code>. This page picks it up automatically.</span>';
      $('stepper').innerHTML = ''; $('mix').innerHTML = ''; $('legend').innerHTML = ''; $('alerts').innerHTML = '';
      $('ringwrap').style.display = 'none';
      return;
    }
    $('ringwrap').style.display = '';
    // Repo-wide outcome metrics from /api/info; a null rate shows as n/a.
    function outcomeStats(o) {
      if (!o) return '';
      var p = function (x) { return x == null ? 'n/a' : Math.round(x * 100) + '%'; };
      return '<div class="stat"><span>Merge acceptance</span><b class="num">' + p(o.acceptanceRate) + '</b></div>' +
        '<div class="stat"><span>Revert rate</span><b class="num">' + p(o.revertRate) + '</b></div>' +
        '<div class="stat"><span>Cost / accepted</span><b class="num">' + (o.costPerAcceptedUsd == null ? 'n/a' : usd(o.costPerAcceptedUsd)) + '</b></div>';
    }
    var total = run.tasks.length, merged = count(run, ['merged']);
    var flight = run.tasks.reduce(function (s, t) { return s + (WEIGHT[t.status] || 0); }, 0);
    var live = !run.endedAt && run.status !== 'done' && run.status !== 'failed';
    $('eyebrow').innerHTML = '<span class="pill t-' + (TONE[run.status] || 'idle') + (live ? ' pulse' : '') + '"><i></i>' + esc(run.status) + '</span>' +
      '<span>run <b>' + esc(run.id) + '</b></span><span>&middot;</span><span>harness <b>' + esc(run.harness) + '</b></span>' +
      (run.kind === 'eval' ? '<span>&middot;</span><span>eval</span>' : '');
    $('goal').textContent = run.goal;
    $('stats').innerHTML =
      '<div class="stat"><span>Elapsed</span><b>' + since(run.startedAt, run.endedAt) + '</b></div>' +
      '<div class="stat"><span>Cost</span><b class="num">' + usd(run.costUsd) + '</b></div>' +
      '<div class="stat"><span>Agents</span><b class="num">' + run.active.length + '</b></div>' +
      '<div class="stat"><span>Merged</span><b class="num">' + merged + ' / ' + total + '</b></div>' +
      (run.satisfaction != null ? '<div class="stat"><span>Satisfaction</span><b class="num">' + run.satisfaction.toFixed(2) + '</b></div>' : '') +
      outcomeStats(state.info.outcomes);

    var pct = total ? merged / total : 0;
    $('ring-fg').setAttribute('stroke-dasharray', RING.toFixed(2));
    $('ring-fg').setAttribute('stroke-dashoffset', (RING * (1 - pct)).toFixed(2));
    $('ring-flight').setAttribute('stroke-dasharray', RING.toFixed(2));
    $('ring-flight').setAttribute('stroke-dashoffset', (RING * (1 - (total ? flight / total : 0))).toFixed(2));
    $('ring-pct').textContent = Math.round(pct * 100) + '%';
    $('ring-sub').textContent = total ? merged + ' of ' + total + ' merged' : (run.status === 'planning' ? 'planning' : 'no tasks');

    var ph = phases(run);
    $('stepper').innerHTML = ph.map(function (p, i) {
      var cls = p[1] ? 'active' : p[2] ? 'done' : '';
      return (i ? '<span class="link ' + (p[1] || p[2] ? 'done' : '') + '"></span>' : '') +
        '<span class="step ' + cls + '"><span class="node">' + (p[2] && !p[1] ? '&#10003;' : '') + '</span>' + p[0].toUpperCase() + '</span>';
    }).join('');

    // Status mix keeps one element per segment so widths animate.
    var mix = $('mix');
    if (mix.children.length !== MIX.length) mix.innerHTML = MIX.map(function (m) { return '<i class="t-' + m.tone + '" title="' + m.name + '"></i>'; }).join('');
    MIX.forEach(function (m, i) { mix.children[i].style.width = (total ? count(run, m.has) / total * 100 : 0) + '%'; });
    $('legend').innerHTML = MIX.map(function (m) {
      var n = count(run, m.has);
      return n || m.name === 'Done' ? '<span class="t-' + m.tone + '"><i></i>' + m.name + ' <b>' + n + '</b></span>' : '';
    }).join('');

    var alerts = '';
    if (run.error) alerts += '<div class="alert t-bad">' + esc(run.error) + '</div>';
    if (merged && run.integrationBranch && run.status === 'done') alerts += '<div class="alert t-ok">Ready to land: <code>git merge ' + esc(run.integrationBranch) + '</code></div>';
    $('alerts').innerHTML = alerts;
    $('alerts').style.display = alerts ? '' : 'none';
  }

  // ---------- board ----------
  function depth(run) {
    var memo = {}, byId = state.byId;
    function d(id, seen) {
      if (memo[id] != null) return memo[id];
      if (seen[id] || !byId[id]) return 0; // cycle or unknown dep
      seen[id] = 1;
      var m = 0;
      (byId[id].deps || []).forEach(function (x) { if (byId[x]) m = Math.max(m, d(x, seen) + 1); });
      seen[id] = 0;
      return (memo[id] = m);
    }
    run.tasks.forEach(function (t) { d(t.id, {}); });
    return memo;
  }

  function layout(run) {
    if (state.view === 'board') {
      return COLS.map(function (c) {
        return { key: c.key, name: c.name, tone: c.tone, ids: run.tasks.filter(function (t) { return c.has.indexOf(t.status) >= 0; }).map(function (t) { return t.id; }) };
      });
    }
    var dep = depth(run), max = 0, cols = [];
    run.tasks.forEach(function (t) { max = Math.max(max, dep[t.id] || 0); });
    for (var i = 0; i <= max; i++) cols.push({ key: 'w' + i, name: i === 0 ? 'Start' : 'Wave ' + (i + 1), tone: 'accent', ids: [] });
    run.tasks.forEach(function (t) { cols[dep[t.id] || 0].ids.push(t.id); });
    cols.forEach(function (c) {
      var done = c.ids.filter(function (id) { return state.byId[id].status === 'merged'; }).length;
      c.sub = done + '/' + c.ids.length + ' done';
      c.tone = done === c.ids.length ? 'ok' : 'accent';
    });
    return cols;
  }

  // Three pipeline segments per card: build, verify, merge.
  function steps(t) {
    var s = t.status;
    if (s === 'merged') return ['done', 'done', 'done'];
    if (s === 'merging') return ['done', 'done', 'now'];
    if (s === 'judging') return ['done', 'now', ''];
    if (s === 'running' || s === 'repair') return ['now', t.verdict ? 'bad' : '', ''];
    if (s === 'failed') return t.verdict ? ['done', 'bad', ''] : ['bad', '', ''];
    return ['', '', ''];
  }
  function trackHtml(t, labels) {
    return '<div class="track">' + steps(t).map(function (c) { return '<span class="seg ' + c + '"></span>'; }).join('') + '</div>' +
      (labels ? '<div class="track-l"><span>Build</span><span>Verify</span><span>Merge</span></div>' : '');
  }

  function cardHtml(t, ag) {
    var max = state.info.maxAttempts;
    var deps = (t.deps || []).filter(function (d) { return state.byId[d]; });
    return '<div class="c-top"><span class="tid">' + esc(t.id) + '</span>' +
      '<span class="pill' + (ACTIVE[t.status] ? ' pulse' : '') + '"><i></i>' + (LABEL[t.status] || esc(t.status)) + '</span>' +
      (t.attempts > 1 ? '<span class="retry" title="attempt ' + t.attempts + (max ? ' of ' + max : '') + '">&#8635; try ' + t.attempts + '</span>' : '') + '</div>' +
      '<div class="c-title" title="' + esc(t.title) + '">' + esc(t.title) + '</div>' +
      trackHtml(t, false) +
      (ag ? '<div class="c-agent t-' + (ROLE_TONE[ag.role] || 'run') + '"><b>' + esc(ag.role) + '</b><span class="act" data-act></span></div>' : '') +
      '<div class="c-foot">' +
      (deps.length ? '<span class="deps" title="depends on">&#8672; ' + deps.map(function (d) {
        return '<span class="dep t-' + (TONE[state.byId[d].status] || 'idle') + '">' + esc(d) + '</span>';
      }).join('') + '</span>' : '') +
      '<span class="sp"></span>' +
      (t.verdict && !t.verdict.judgeError ? scoreRing(t.verdict.score, t.verdict.pass) : '') +
      (t.startedAt ? since(t.startedAt, t.endedAt) : '') +
      '<span class="num">' + usd(t.costUsd) + '</span></div>';
  }

  function renderBoard() {
    var run = state.run, board = $('board');
    $('taskcount').textContent = run ? run.tasks.length : 0;
    if (!run || !run.tasks.length) {
      board.innerHTML = '<div class="empty-board"><b>' + (run && run.status === 'planning' ? 'Planning the task graph&hellip;' : 'No tasks yet') + '</b>' +
        (run && run.status === 'planning' ? 'Cards appear here as soon as the planner finishes.' : 'Tasks show up once a run has been planned.') + '</div>';
      state.cards = {}; state.colsKey = ''; state.wiresKey = '';
      return;
    }
    var cols = layout(run);
    // FLIP: remember where every card was before we move anything.
    var first = {};
    Object.keys(state.cards).forEach(function (id) { if (state.cards[id].isConnected) first[id] = state.cards[id].getBoundingClientRect(); });

    var key = state.view + '|' + cols.map(function (c) { return c.key; }).join(',');
    if (key !== state.colsKey) {
      board.innerHTML = '<div class="board-in" id="board-in"><svg class="wires" id="wires" aria-hidden="true"></svg><div class="cols">' + cols.map(function (c) {
        return '<div class="col t-' + c.tone + '" data-col="' + c.key + '"><div class="col-h"><span class="dot"></span><span class="nm"></span><span class="count"></span><span class="sub"></span></div><div class="col-body"></div></div>';
      }).join('') + '</div></div>';
      state.colsKey = key; state.wiresKey = '';
    }
    var seen = {};
    cols.forEach(function (c) {
      var col = board.querySelector('[data-col="' + c.key + '"]');
      col.className = 'col t-' + c.tone + (c.ids.length ? '' : ' is-empty');
      col.querySelector('.nm').textContent = c.name;
      col.querySelector('.count').textContent = c.ids.length;
      col.querySelector('.sub').textContent = c.sub || '';
      var body = col.querySelector('.col-body');
      c.ids.forEach(function (id, i) {
        var t = state.byId[id], ag = agentFor(id);
        seen[id] = 1;
        var el = state.cards[id];
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-id', id); el.setAttribute('role', 'button'); el.tabIndex = 0;
          el.addEventListener('animationend', function () { el.classList.remove('enter'); });
          state.cards[id] = el;
          if (Object.keys(first).length) el.classList.add('enter');
        }
        // Rebuild the card only when something visible changed; the agent's last action is patched in place.
        var sig = JSON.stringify([t.status, t.attempts, t.title, t.deps, t.costUsd, t.startedAt, t.endedAt, t.verdict && t.verdict.score, t.verdict && t.verdict.pass,
          ag && ag.role, (t.deps || []).map(function (d) { return state.byId[d] && state.byId[d].status; }), state.info.maxAttempts]);
        if (el._sig !== sig) { el.innerHTML = cardHtml(t, ag); el._sig = sig; }
        var cls = 'card t-' + (TONE[t.status] || 'idle') + (ACTIVE[t.status] ? ' live' : '') + (state.sel === id ? ' sel' : '') + (el.classList.contains('enter') ? ' enter' : '');
        if (el.className !== cls) el.className = cls;
        el.setAttribute('aria-label', id + ' ' + t.title + ', ' + (LABEL[t.status] || t.status));
        var act = el.querySelector('[data-act]');
        if (act && ag && act.textContent !== ag.lastAction) { act.textContent = ag.lastAction; act.title = ag.lastAction; }
        if (body.children[i] !== el) body.insertBefore(el, body.children[i] || null);
      });
    });
    Object.keys(state.cards).forEach(function (id) {
      if (!seen[id]) { state.cards[id].remove(); delete state.cards[id]; }
    });

    var moved = false;
    Object.keys(first).forEach(function (id) {
      var el = state.cards[id];
      if (!el || !el.isConnected) return;
      var a = first[id], b = el.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      moved = true;
      el.style.transition = 'none';
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      void el.offsetWidth;
      el.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1), box-shadow .2s, border-color .2s, opacity .2s';
      el.style.transform = '';
    });
    drawWires(moved ? 560 : 0);
  }

  // ---------- dependency wires ----------
  function edgeTone(src) {
    if (src.status === 'merged') return 'ok';
    if (src.status === 'failed' || src.status === 'blocked') return 'bad';
    if (ACTIVE[src.status]) return 'live';
    return 'wait';
  }

  function drawWires(ms) {
    var t0 = performance.now();
    (function frame() {
      paintWires();
      if (performance.now() - t0 < ms) requestAnimationFrame(frame);
    })();
  }

  function paintWires() {
    var inner = $('board-in'), svg = $('wires'), run = state.run;
    if (!inner || !svg || !run) return;
    var base = inner.getBoundingClientRect();
    var box = function (el) {
      var r = el.getBoundingClientRect(), l = r.left - base.left, t = r.top - base.top;
      return { l: l, r: l + r.width, t: t, cx: l + r.width / 2, cy: t + Math.min(r.height / 2, 30) };
    };
    var edges = [], outN = {}, inN = {}, outI = {}, inI = {};
    run.tasks.forEach(function (t) {
      (t.deps || []).forEach(function (d) {
        if (!state.cards[d] || !state.cards[t.id] || !state.cards[d].isConnected || !state.cards[t.id].isConnected) return;
        edges.push({ from: d, to: t.id });
        outN[d] = (outN[d] || 0) + 1; inN[t.id] = (inN[t.id] || 0) + 1;
      });
    });
    var parts = edges.map(function (e) {
      var a = box(state.cards[e.from]), b = box(state.cards[e.to]);
      // Fan multiple wires out along the card edge so they do not stack.
      var oi = outI[e.from] = (outI[e.from] || 0) + 1, ii = inI[e.to] = (inI[e.to] || 0) + 1;
      var ay = a.cy + (oi - (outN[e.from] + 1) / 2) * 8, by = b.cy + (ii - (inN[e.to] + 1) / 2) * 8;
      var d;
      if (Math.abs(a.cx - b.cx) < 12) {
        var bulge = 22 + Math.min(36, Math.abs(by - ay) / 5);
        d = 'M' + a.r + ' ' + ay + ' C' + (a.r + bulge) + ' ' + ay + ' ' + (b.r + bulge) + ' ' + by + ' ' + (b.r + 3) + ' ' + by;
      } else {
        var fwd = a.cx < b.cx, x1 = fwd ? a.r : a.l, x2 = fwd ? b.l - 3 : b.r + 3;
        var k = Math.max(28, Math.abs(x2 - x1) * 0.45) * (fwd ? 1 : -1);
        d = 'M' + x1 + ' ' + ay + ' C' + (x1 + k) + ' ' + ay + ' ' + (x2 - k) + ' ' + by + ' ' + x2 + ' ' + by;
      }
      var tone = edgeTone(state.byId[e.from]);
      return '<path class="wire ' + tone + '" data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '" d="' + d.replace(/(\.\d)\d+/g, '$1') + '" marker-end="url(#ah-' + tone + ')"></path>';
    });
    var w = inner.scrollWidth, h = inner.scrollHeight;
    var html = parts.join('');
    var key = w + 'x' + h + html;
    if (key === state.wiresKey) return; // unchanged: keep the running dash animation smooth
    state.wiresKey = key;
    svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.innerHTML = '<defs>' + ['ok', 'live', 'wait', 'bad'].map(function (k) {
      return '<marker id="ah-' + k + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="mk ' + k + '" d="M0 1L9 5L0 9z"></path></marker>';
    }).join('') + '</defs>' + html;
    applyFocus();
  }

  // Hovering or focusing a card lights up its whole dependency chain.
  function chain(id) {
    var set = {}, run = state.run;
    set[id] = 1;
    (function up(x) { ((state.byId[x] || {}).deps || []).forEach(function (d) { if (!set[d] && state.byId[d]) { set[d] = 1; up(d); } }); })(id);
    (function down(x) {
      run.tasks.forEach(function (t) { if ((t.deps || []).indexOf(x) >= 0 && !set[t.id]) { set[t.id] = 1; down(t.id); } });
    })(id);
    return set;
  }
  function applyFocus() {
    var board = $('board'), id = state.hover;
    var on = !!(id && state.run && state.byId[id]);
    board.classList.toggle('focus', on);
    var set = on ? chain(id) : {};
    Object.keys(state.cards).forEach(function (k) {
      state.cards[k].classList.toggle('rel', !!set[k]);
      state.cards[k].classList.toggle('hot', k === id && on);
    });
    board.querySelectorAll('.wire').forEach(function (p) {
      p.classList.toggle('rel', !!(set[p.getAttribute('data-from')] && set[p.getAttribute('data-to')]));
    });
  }
  function setHover(id) { if (state.hover !== id) { state.hover = id; applyFocus(); } }
  var board = $('board');
  board.addEventListener('mouseover', function (e) { var c = e.target.closest && e.target.closest('.card'); setHover(c ? c.getAttribute('data-id') : null); });
  board.addEventListener('mouseleave', function () { setHover(null); });
  board.addEventListener('focusin', function (e) { var c = e.target.closest && e.target.closest('.card'); if (c) setHover(c.getAttribute('data-id')); });
  board.addEventListener('focusout', function () { setHover(null); });
  board.addEventListener('click', function (e) { var c = e.target.closest && e.target.closest('.card'); if (c) openTask(c.getAttribute('data-id')); });
  board.addEventListener('keydown', function (e) {
    var c = e.target.closest && e.target.closest('.card');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTask(c.getAttribute('data-id')); }
  });
  window.addEventListener('resize', function () { state.wiresKey = ''; paintWires(); });
  document.querySelectorAll('.seg-ctl button').forEach(function (b) {
    b.onclick = function () {
      state.view = b.getAttribute('data-view');
      document.querySelectorAll('.seg-ctl button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      try { localStorage.setItem('orchestra-view', state.view); } catch (e) {}
      renderBoard();
    };
    b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === state.view));
  });

  // ---------- agents ----------
  function renderAgents() {
    var run = state.run, box = $('agents');
    var list = run ? run.active : [];
    $('agentcount').textContent = list.length;
    if (!list.length) {
      box.innerHTML = '<div class="none">' + (run && (run.status === 'done' || run.status === 'failed') ? 'All agents have finished.' : 'No agents active right now.') + '</div>';
      state.agents = {};
      return;
    }
    if (box.querySelector('.none')) box.innerHTML = '';
    var keep = {};
    list.forEach(function (a, i) {
      keep[a.key] = 1;
      var el = state.agents[a.key];
      if (!el) {
        el = document.createElement('div');
        el.className = 'agent t-' + (ROLE_TONE[a.role] || 'run');
        el.innerHTML = '<span class="av">' + esc(a.role.charAt(0).toUpperCase()) + '</span>' +
          '<div style="min-width:0"><div class="ag-top"><b>' + esc(a.role) + '</b>' + (a.task ? '<span class="tid">' + esc(a.task) + '</span>' : '') +
          '<span class="model">' + esc(a.model) + '</span></div><div class="act"></div></div>' +
          '<div class="ag-meta"><b>' + since(a.startedAt) + '</b><span class="tools"></span><span class="cost"></span></div>';
        state.agents[a.key] = el;
      }
      el.querySelector('.act').textContent = a.lastAction || 'starting';
      el.querySelector('.act').title = a.lastAction || '';
      el.querySelector('.tools').textContent = a.tools + ' tool' + (a.tools === 1 ? '' : 's');
      el.querySelector('.cost').textContent = usd(a.costUsd);
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    });
    Object.keys(state.agents).forEach(function (k) { if (!keep[k]) { state.agents[k].remove(); delete state.agents[k]; } });
  }

  // ---------- activity ----------
  function renderEvents() {
    var showActions = $('actions').checked;
    var run = state.run, t0 = run ? run.startedAt : 0;
    var evs = state.events.filter(function (e) { return showActions || e.kind !== 'agent.action'; }).slice(-250);
    var key = showActions + ':' + state.events.length + ':' + (run ? run.id : '');
    if (key === state.evKey) return;
    state.evKey = key;
    var box = $('events');
    var stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.innerHTML = evs.length ? evs.map(function (e) {
      var ic = EV[e.kind] || EV.log;
      var minor = e.kind === 'agent.action' || e.kind === 'log' || e.kind === 'agent.end';
      return '<div class="ev' + (minor ? ' minor' : '') + '"><span class="t">' + clock(e.t - t0) + '</span><span class="ico t-' + ic[1] + '">' + ic[0] + '</span><span class="m">' + esc(e.msg) + '</span></div>';
    }).join('') : '<div class="none">No events yet.</div>';
    if (stick) box.scrollTop = box.scrollHeight;
  }
  $('actions').onchange = function () { state.evKey = ''; renderEvents(); };

  // ---------- drawer ----------
  function openTask(id) {
    if (!state.byId[id]) return;
    state.sel = id; state.selJson = ''; state.selTask = JSON.stringify(state.byId[id]);
    $('dr-body').scrollTop = 0;
    $('drawer').classList.add('on'); $('drawer').setAttribute('aria-hidden', 'false'); $('scrim').classList.add('on');
    renderDrawer();
    loadDetail(id);
    renderBoard();
    setTimeout(function () { var x = $('dr-head').querySelector('.x'); if (x) x.focus(); }, 50);
  }
  function closeTask() {
    var id = state.sel;
    state.sel = null;
    $('drawer').classList.remove('on'); $('drawer').setAttribute('aria-hidden', 'true'); $('scrim').classList.remove('on');
    renderBoard();
    if (id && state.cards[id]) state.cards[id].focus({ preventScroll: true });
  }
  $('scrim').onclick = closeTask;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.sel) closeTask(); });
  $('drawer').addEventListener('click', function (e) {
    if (e.target.closest('.x')) return closeTask();
    var g = e.target.closest('[data-goto]');
    if (g) openTask(g.getAttribute('data-goto'));
  });
  $('drawer').addEventListener('toggle', function (e) {
    if (e.target.tagName === 'DETAILS') state.openDetails[e.target.getAttribute('data-k')] = e.target.open;
  }, true);

  function loadDetail(id) {
    var runId = state.run.id;
    get('/api/runs/' + encodeURIComponent(runId) + '/tasks/' + encodeURIComponent(id))
      .then(function (d) { state.detail[id] = d; })
      .catch(function (e) { state.detail[id] = { error: e.message }; })
      .then(function () { if (state.run && state.run.id === runId && state.sel === id) renderDrawer(); });
  }

  function diffHtml(d) {
    return d.split('\n').map(function (l) {
      if (l.indexOf('diff --git') === 0) return '<span class="file">' + esc(l) + '</span>';
      if (l.indexOf('@@') === 0) return '<span class="hunk">' + esc(l) + '</span>';
      var c = l.charAt(0) === '+' && l.indexOf('+++') !== 0 ? 'add' : l.charAt(0) === '-' && l.indexOf('---') !== 0 ? 'del' : '';
      return c ? '<span class="' + c + '">' + esc(l) + '</span>' : esc(l);
    }).join('\n');
  }
  function chipFor(id) {
    var t = state.byId[id];
    return '<button type="button" class="chip t-' + (TONE[t.status] || 'idle') + '" data-goto="' + esc(id) + '" title="' + esc(LABEL[t.status] || t.status) + '"><i></i><b>' + esc(id) + '</b><span>' + esc(t.title) + '</span></button>';
  }
  function section(title, body) { return '<section><h3>' + title + '</h3>' + body + '</section>'; }
  function fold(k, title, body, dflt) {
    var open = state.openDetails[k] != null ? state.openDetails[k] : dflt;
    return '<details data-k="' + k + '"' + (open ? ' open' : '') + '><summary>' + title + '</summary>' + body + '</details>';
  }

  function renderDrawer() {
    var t = state.sel && state.byId[state.sel];
    if (!t) { if (state.sel) closeTask(); return; }
    var ag = agentFor(t.id), v = t.verdict, d = state.detail[t.id], max = state.info.maxAttempts, thr = state.info.passThreshold;
    var dependents = state.run.tasks.filter(function (x) { return (x.deps || []).indexOf(t.id) >= 0; }).map(function (x) { return x.id; });
    var deps = (t.deps || []).filter(function (x) { return state.byId[x]; });

    $('dr-head').className = 'dr-head t-' + (TONE[t.status] || 'idle');
    $('dr-head').innerHTML = '<div class="dr-row"><span class="tid">' + esc(t.id) + '</span><span class="pill' + (ACTIVE[t.status] ? ' pulse' : '') + '"><i></i>' + (LABEL[t.status] || esc(t.status)) + '</span>' +
      '<button type="button" class="x" aria-label="Close">&#10005;</button></div>' +
      '<h2 class="dr-title">' + esc(t.title) + '</h2>' + trackHtml(t, true);

    var out = '<div class="grid4">' +
      '<div class="stat"><span>Attempt</span><b class="num">' + t.attempts + (max ? ' / ' + max : '') + '</b></div>' +
      '<div class="stat"><span>Score</span><b class="num">' + (v && !v.judgeError ? v.score.toFixed(2) : '&ndash;') + '</b></div>' +
      '<div class="stat"><span>Cost</span><b class="num">' + usd(t.costUsd) + '</b></div>' +
      '<div class="stat"><span>Time</span><b>' + (t.startedAt ? since(t.startedAt, t.endedAt) : '&ndash;') + '</b></div></div>';

    if (ag) out += '<div class="c-agent t-' + (ROLE_TONE[ag.role] || 'run') + '"><b>' + esc(ag.role) + '</b><span class="act">' + esc(ag.lastAction) + '</span><span class="num muted">' + ag.tools + ' tools</span></div>';
    if (deps.length || dependents.length) {
      out += '<div class="grid2" style="display:grid;gap:14px">' +
        (deps.length ? section('Depends on', '<div class="chips">' + deps.map(chipFor).join('') + '</div>') : '') +
        (dependents.length ? section('Unlocks', '<div class="chips">' + dependents.map(chipFor).join('') + '</div>') : '') + '</div>';
    }
    if (t.description) out += section('Description', '<p class="desc">' + esc(t.description) + '</p>');

    if (t.acceptance && t.acceptance.length) {
      var crit = (v && v.criteria) || [];
      out += section('Acceptance criteria', '<ul class="crit">' + t.acceptance.map(function (a, i) {
        var c = null;
        crit.forEach(function (x) { if (x.criterion === a) c = x; });
        if (!c && crit.length === t.acceptance.length) c = crit[i];
        var tone = c ? (c.pass ? 'ok' : 'bad') : 'idle';
        return '<li class="t-' + tone + '"><span class="mark">' + (c ? (c.pass ? '&#10003;' : '&#10005;') : (i + 1)) + '</span>' +
          '<span>' + esc(a) + (c && c.note ? '<span class="note">' + esc(c.note) + '</span>' : '') + '</span>' +
          (c ? '<span class="num muted">' + c.score.toFixed(2) + '</span>' : '<span></span>') + '</li>';
      }).join('') + '</ul>');
    }

    if (v) {
      var tone = v.judgeError ? 'warn' : v.pass ? 'ok' : 'bad';
      out += section('Judge verdict', '<div class="verdict t-' + tone + '"><div class="vh"><span class="pill"><i></i>' + (v.judgeError ? 'JUDGE ERROR' : v.pass ? 'PASS' : 'FAIL') + '</span>' +
        (v.judgeError ? '' : '<span class="num">score ' + v.score.toFixed(2) + (thr != null ? ' <span class="muted">/ needs ' + thr.toFixed(2) + '</span>' : '') + '</span>') +
        (v.testsPassed === null ? '' : '<span class="muted">' + (v.testsPassed ? '&#10003; tests passed' : '&#10005; tests failed') + '</span>') + '</div>' +
        (v.judgeError ? '' : '<div class="meter"><i style="width:' + Math.round(Math.max(0, Math.min(1, v.score)) * 100) + '%"></i>' + (thr != null ? '<s style="left:' + Math.round(thr * 100) + '%" title="pass threshold"></s>' : '') + '</div>') +
        (v.summary ? '<p>' + esc(v.summary) + '</p>' : '') +
        (v.judgeError ? '<p>' + esc(v.judgeError) + '</p>' : '') +
        (v.issues && v.issues.length ? '<ul>' + v.issues.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') + '</div>');
    }
    var ct = t.contrast;
    if (ct) {
      var side = function (k, s) {
        var sv = s && s.verdict;
        return '<li><b>' + k + '</b> <code>' + esc(s ? s.branch : '') + '</code> ' +
          (sv ? '<span class="num muted">score ' + (sv.judgeError ? 'n/a' : sv.score.toFixed(2)) + (sv.pass ? ' &middot; pass' : ' &middot; fail') + '</span>' : '<span class="muted">no verdict</span>') + '</li>';
      };
      var other = ct.picked === 'A' ? 'B' : 'A';
      out += section('Contrastive repair (attempt ' + esc(ct.attempt) + ')', '<div class="verdict t-' + (ct.picked ? 'ok' : 'bad') + '">' +
        '<p>' + (ct.picked ? 'Picked ' + ct.picked + ' over ' + other + (ct.reasons ? ' because ' + esc(ct.reasons) : '') : 'Neither attempt passed' + (ct.reasons ? ': ' + esc(ct.reasons) : '')) + '</p>' +
        '<ul class="plain">' + side('A', ct.a) + side('B', ct.b) + '</ul></div>');
    }
    if (t.notes && t.notes.length) out += section('Repair notes', '<ul class="plain">' + t.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>');

    if (!d) out += '<div class="none">Loading diff and logs&hellip;</div>';
    else if (d.error) out += '<div class="alert t-bad">' + esc(d.error) + '</div>';
    else {
      out += fold('diff', 'Diff', d.diff ? '<pre>' + diffHtml(d.diff) + '</pre>' : '<pre class="muted">Not available (branch pruned or no changes).</pre>', true);
      d.logs.forEach(function (l) { out += fold('log:' + l.name, esc(l.name) + ' <span class="muted">(tail)</span>', '<pre>' + esc(l.tail) + '</pre>', false); });
    }
    var body = $('dr-body'), top = body.scrollTop;
    body.innerHTML = out;
    body.scrollTop = top;
  }

  // ---------- wiring ----------
  function apply(run) {
    state.run = run;
    state.byId = {};
    if (run) run.tasks.forEach(function (t) { state.byId[t.id] = t; });
  }
  function renderAll() { renderHero(); renderBoard(); renderAgents(); renderEvents(); }

  setInterval(tick, 1000);

  function connect(runId) {
    if (state.source) state.source.close();
    apply(null);
    state.events = []; state.detail = {}; state.evKey = ''; state.openDetails = {};
    Object.keys(state.cards).forEach(function (k) { state.cards[k].remove(); });
    state.cards = {}; state.colsKey = ''; state.agents = {}; $('agents').innerHTML = '';
    if (state.sel) closeTask();
    renderAll();
    var es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/stream');
    state.source = es;
    var conn = function (cls, text) { $('conn').className = 'conn ' + cls; $('conn').lastChild.textContent = text; };
    es.onopen = function () { conn('live', 'live'); };
    es.onerror = function () { conn('bad', 'reconnecting'); };
    es.onmessage = function (m) {
      var d = JSON.parse(m.data);
      apply(d.run);
      state.events = d.reset ? d.events : state.events.concat(d.events);
      renderHero(); renderAgents(); renderBoard(); renderEvents();
      if (state.sel) {
        // Keep the open drawer in step with the run; refetch diff and logs when that task changes.
        var taskJson = JSON.stringify(state.byId[state.sel] || null), agJson = JSON.stringify(agentFor(state.sel));
        if (taskJson + agJson !== state.selJson) {
          var taskChanged = taskJson !== state.selTask;
          state.selJson = taskJson + agJson; state.selTask = taskJson;
          renderDrawer();
          if (taskChanged && state.byId[state.sel]) loadDetail(state.sel);
        }
      }
    };
  }

  function loadRuns(selectId) {
    return get('/api/runs').then(function (d) {
      var sel = $('runs');
      sel.innerHTML = d.runs.map(function (r) {
        return '<option value="' + esc(r.id) + '">' + esc(r.status) + ' &middot; ' + esc(r.goal.slice(0, 48)) + ' &middot; ' + r.merged + '/' + r.tasks + '</option>';
      }).join('');
      sel.style.display = d.runs.length ? '' : 'none';
      if (selectId) sel.value = selectId;
      return d.runs;
    });
  }
  $('runs').onchange = function () { connect(this.value); };

  get('/api/info').then(function (info) {
    state.info = info;
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
  }).catch(function (e) { $('conn').className = 'conn bad'; $('conn').lastChild.textContent = 'error: ' + e.message; });
})();
</script>
</body>
</html>
`;
