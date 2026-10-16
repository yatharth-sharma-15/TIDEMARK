import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemark-'));
process.env.RESPECT_ROBOTS = 'false';
process.env.DOMAIN_MIN_GAP_MS = '0';
process.env.STABILIZE_DELAY_MS = '0';
process.env.ALLOW_PRIVATE_HOSTS = 'true';

const { db } = await import('../src/db.js');
const { _setRenderer, _tick, _idle } = await import('../src/worker.js');

const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
let calls = 0;
let reply = { status: 200, html: '' };
_setRenderer(async (_url, opts = {}) => {
  calls++;
  const r = typeof reply === 'function' ? reply() : reply;
  return { status: r.status, headers: {}, html: r.html, title: '', finalUrl: _url, png: opts.screenshot === false ? null : png };
});

const body = (inner) => `<html><body>${inner}</body></html>`;
const LONG = '<p>Welcome to the store. We sell widgets, gadgets and many other things for your home.</p>';

function addMonitor(over = {}) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO monitors(id, owner, name, url, interval_min, sensitivity, next_run, created_at, keywords)
    VALUES(?,?,?,?,?,?,0,?,?)`).run(id, 'o'.repeat(20), over.name || 'T', over.url || 'http://shop.test/p', 15, over.sensitivity || 'medium', Date.now(), JSON.stringify(over.keywords || []));
  return id;
}
async function run() {
  db.prepare('UPDATE monitors SET next_run=0 WHERE paused=0').run();
  for (let i = 0; i < 10; i++) { // drain: concurrency is limited, so one tick may not reach every group
    await _tick();
    await _idle();
    const due = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE state='queued' AND run_at<=?`).get(Date.now()).c;
    const pending = db.prepare('SELECT COUNT(*) c FROM monitors WHERE paused=0 AND next_run=0').get().c;
    if (!due && !pending) break;
  }
}
const reset = () => { db.prepare('DELETE FROM monitors').run(); };
const snaps = (id) => db.prepare('SELECT * FROM snapshots WHERE monitor_id=? ORDER BY id').all(id);
const alerts = (id, kind) => db.prepare('SELECT * FROM alerts WHERE monitor_id=? AND kind=?').all(id, kind);
const mon = (id) => db.prepare('SELECT * FROM monitors WHERE id=?').get(id);

test('baseline, noise-only changes, real change, and no duplicate alerts', async () => {
  reset();
  const id = addMonitor();
  reply = { status: 200, html: body(`${LONG}<p>Price: $19</p><p>5 minutes ago</p><p>100 views</p>`) };
  await run();
  assert.equal(snaps(id).length, 1);
  assert.equal(snaps(id)[0].baseline, 1);
  assert.equal(mon(id).status, 'ok');

  reply = { status: 200, html: body(`${LONG}<p>Price: $19</p><p>9 minutes ago</p><p>140 views</p>`) };
  await run();
  assert.equal(snaps(id).length, 1, 'timestamp/counter noise must not create a version');

  reply = { status: 200, html: body(`${LONG}<p>Price: $24</p><p>9 minutes ago</p><p>140 views</p>`) };
  await run();
  assert.equal(snaps(id).length, 2);
  assert.equal(alerts(id, 'change').length, 1);

  await run(); // same content again
  assert.equal(snaps(id).length, 2);
  assert.equal(alerts(id, 'change').length, 1, 'no duplicate alert');
  assert.ok(mon(id).last_changed);
});

test('rotating content that differs on every load never alerts', async () => {
  reset();
  const id = addMonitor({ url: 'http://rotating.test/' });
  reply = () => ({ status: 200, html: body(`${LONG}<p>Tip of the moment: ${Math.random().toString(36).slice(2)} is great</p><p>Stable footer line</p>`) });
  await run();
  await run();
  await run();
  assert.equal(snaps(id).length, 1);
  assert.equal(alerts(id, 'change').length, 0);
});

test('CAPTCHA and outages are not page changes', async () => {
  reset();
  const id = addMonitor({ url: 'http://guarded.test/' });
  reply = { status: 200, html: body(LONG) };
  await run();
  assert.equal(snaps(id).length, 1);

  reply = { status: 200, html: body('<h1>Verify you are human</h1><div class="g-recaptcha"></div>') };
  await run();
  assert.equal(mon(id).status, 'blocked');
  assert.equal(snaps(id).length, 1);

  reply = { status: 503, html: 'Service Unavailable' };
  await run();
  assert.equal(snaps(id).length, 1);
  const job = db.prepare('SELECT * FROM jobs WHERE monitor_id=?').get(id);
  assert.ok(job && job.attempts === 1, 'transient outage is retried with backoff');
  assert.equal(alerts(id, 'change').length, 0);
});

test('200 watchers of one URL cost one page load', async () => {
  reset();
  const ids = Array.from({ length: 5 }, (_, i) => addMonitor({ url: 'http://popular.test/', name: 'W' + i }));
  reply = { status: 200, html: body(LONG) };
  calls = 0;
  await run();
  assert.ok(calls <= 2, `expected at most 2 renders (1 + stabilising reload), got ${calls}`);
  ids.forEach((id) => assert.equal(snaps(id).length, 1));
});

test('keyword-only alerts keep the version but stay quiet without a match', async () => {
  reset();
  const id = addMonitor({ url: 'http://kw.test/', keywords: ['sale'] });
  reply = { status: 200, html: body(`${LONG}<p>Shipping: free</p>`) };
  await run();
  reply = { status: 200, html: body(`${LONG}<p>Shipping: paid</p>`) };
  await run();
  assert.equal(snaps(id).length, 2);
  assert.equal(alerts(id, 'change').length, 0);
  reply = { status: 200, html: body(`${LONG}<p>Shipping: paid</p><p>Summer sale starts</p>`) };
  await run();
  assert.equal(alerts(id, 'change').length, 1);
});
