import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { serve, API_SCHEMA } from '../src/web/server.ts';
import { tempRepo } from './helpers.ts';
import type { OrchestraEvent, Run } from '../src/types.ts';

function seed() {
  const store = tempRepo();
  const run: Run = { id: 'r1', goal: 'g', harness: 'v1', kind: 'goal', status: 'running', startedAt: 1, tasks: [], costUsd: 0.5, active: [] };
  store.saveRun(run);
  const ev: OrchestraEvent = { t: 2, run: 'r1', kind: 'run.start', msg: 'Run started: g' };
  store.event(ev);
  return store;
}

const get = (url: string, host?: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(url);
    request({ host: u.hostname, port: u.port, path: u.pathname, headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on('error', reject)
      .end();
  });

test('serves page, run list and info; rejects foreign host and bad ids', async () => {
  const web = await serve({ store: seed(), port: 4400 });
  try {
    assert.equal((await get(web.url + '/')).status, 200);
    const runs = JSON.parse((await get(web.url + '/api/runs')).body);
    assert.equal(runs.schema, API_SCHEMA);
    assert.equal(runs.runs[0].id, 'r1');
    assert.equal(JSON.parse((await get(web.url + '/api/info')).body).current, 'r1');
    assert.equal((await get(web.url + '/api/runs', 'evil.example.com')).status, 403);
    assert.equal((await get(web.url + '/api/runs/..%2f..%2fetc/stream')).status, 404);
    assert.equal((await get(web.url + '/api/runs/nope/tasks/T1')).status, 404);
  } finally {
    await web.close();
  }
});

test('stream sends snapshot then only new events', async () => {
  const store = seed();
  const web = await serve({ store, port: 4420 });
  try {
    const msgs: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const u = new URL(web.url + '/api/runs/r1/stream');
      const req = request({ host: u.hostname, port: u.port, path: u.pathname }, (res) => {
        res.on('data', (d) => {
          for (const m of String(d).matchAll(/^data: (.*)$/gm)) msgs.push(JSON.parse(m[1]));
          if (msgs.length === 1) store.event({ t: 3, run: 'r1', kind: 'log', msg: 'second' });
          if (msgs.length === 2) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
      req.end();
    });
    assert.equal(msgs[0].reset, true);
    assert.equal(msgs[0].events.length, 1);
    assert.equal(msgs[1].reset, false);
    assert.deepEqual(msgs[1].events.map((e: OrchestraEvent) => e.msg), ['second']);
  } finally {
    await web.close();
  }
});

test('page script parses and loads nothing from outside localhost', async () => {
  const { PAGE } = await import('../src/web/page.ts');
  const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.doesNotMatch(PAGE, /<script[^>]+src=|<link[^>]+href=|@import|url\(\s*['"]?https?:/i);
  assert.doesNotMatch(PAGE.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ''), /https?:\/\//);
});

test('task drawer renders the contrast pick with escaped reasons, and info is unchanged', async () => {
  const { PAGE } = await import('../src/web/page.ts');
  assert.match(PAGE, /Picked ' \+ ct\.picked \+ ' over ' \+ other/);
  assert.match(PAGE, /Neither attempt passed/);
  assert.match(PAGE, /esc\(ct\.reasons\)/);
  assert.doesNotMatch(PAGE, /ct\.reasons\s*\+\s*'<\/p>/); // reasons never injected raw
  const web = await serve({ store: seed(), port: 4441 });
  try {
    const info = JSON.parse((await get(web.url + '/api/info')).body);
    assert.equal(info.contrast, undefined);
    assert.equal(info.current, 'r1');
    assert.equal(typeof info.maxAttempts, 'number');
  } finally {
    await web.close();
  }
});

test('info exposes harness retry and pass limits', async () => {
  const web = await serve({ store: seed(), port: 4440 });
  try {
    const info = JSON.parse((await get(web.url + '/api/info')).body);
    assert.equal(typeof info.maxAttempts, 'number');
    assert.equal(typeof info.passThreshold, 'number');
  } finally {
    await web.close();
  }
});
