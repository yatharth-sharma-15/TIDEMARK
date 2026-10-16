import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { db, getMeta, setMeta } from './db.js';
import { renderPage, classifyResponse, CheckError } from './checker.js';
import { extractText, multisetDiff, stabilize, isSignificant, sha } from './noise.js';
import { summarize } from './summary.js';
import { robotsAllows } from './robots.js';
import { channelsOf, deliver } from './notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new CheckError('The check timed out.', { retryable: true })), ms))]);
const jitter = (ms) => Math.round(ms * (0.9 + Math.random() * 0.2)); // spread load, avoid thundering herd
const J = (s) => { try { return JSON.parse(s); } catch { return []; } };

let active = 0;
let ticking = false;
let render = renderPage; // seam for tests
export const _setRenderer = (fn) => { render = fn; };
export const _tick = () => tick();
export const _idle = async () => { while (active > 0) await sleep(10); };

/* =============== politeness: one request slot per host every DOMAIN_MIN_GAP_MS =============== */
const hostSlots = new Map();
function reserveHost(host) {
  const now = Date.now();
  const slot = Math.max(now, (hostSlots.get(host) || 0) + cfg.domainGapMs);
  hostSlots.set(host, slot);
  if (hostSlots.size > 5000) hostSlots.clear();
  return slot - now;
}

/* =============== scheduler =============== */
export function startWorker() {
  tick();
  setInterval(tick, 5000);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    db.prepare(`UPDATE jobs SET state='queued', locked_at=NULL WHERE state='running' AND locked_at < ?`).run(now - 180_000);
    db.prepare(
      `INSERT INTO jobs(monitor_id, run_at, state)
       SELECT id, ?, 'queued' FROM monitors m
       WHERE paused=0 AND next_run<=? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.monitor_id=m.id)`
    ).run(now, now);
    while (active < cfg.concurrency) {
      const group = claimGroup();
      if (!group) break;
      active++;
      runGroup(group)
        .catch((e) => console.error('group failed', e))
        .finally(() => { active--; });
    }
    await sendPendingAlerts();
    await maybeDigest();
    housekeeping();
  } catch (e) {
    console.error('tick failed', e);
  } finally {
    ticking = false;
  }
}

/** Claims one due job plus every other due job for the same URL: 200 watchers = 1 page load. */
function claimGroup() {
  const now = Date.now();
  const first = db.prepare(
    `SELECT j.id, m.url FROM jobs j JOIN monitors m ON m.id=j.monitor_id
     WHERE j.state='queued' AND j.run_at<=? ORDER BY j.run_at LIMIT 1`
  ).get(now);
  if (!first) return null;
  const jobs = db.prepare(
    `SELECT j.* FROM jobs j JOIN monitors m ON m.id=j.monitor_id
     WHERE j.state='queued' AND j.run_at<=? AND m.url=?`
  ).all(now, first.url);
  const mark = db.prepare(`UPDATE jobs SET state='running', locked_at=? WHERE id=?`);
  jobs.forEach((j) => mark.run(now, j.id));
  return { url: first.url, jobs };
}

async function runGroup({ url, jobs }) {
  const items = [];
  for (const job of jobs) {
    const m = db.prepare('SELECT * FROM monitors WHERE id=?').get(job.monitor_id);
    if (m) items.push({ job, m });
    else db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
  }
  if (!items.length) return;

  try {
    if (cfg.respectRobots && !(await robotsAllows(url))) {
      throw new CheckError('The site’s robots.txt asks bots not to visit this page.', { kind: 'blocked', retryable: false });
    }
    const wait = reserveHost(new URL(url).hostname);
    if (wait > 45_000) { // host is busy: put everything back instead of holding a worker
      const later = db.prepare(`UPDATE jobs SET state='queued', locked_at=NULL, run_at=? WHERE id=?`);
      items.forEach(({ job }) => later.run(Date.now() + wait, job.id));
      return;
    }
    if (wait > 0) await sleep(wait);

    const first = await withTimeout(render(url), cfg.jobTimeoutMs);
    const ctx = {
      first,
      shotFile: null,
      _second: null,
      second() { // lazy, shared by every monitor in the group
        this._second ??= (async () => { await sleep(cfg.stabilizeDelayMs); return withTimeout(render(url, { screenshot: false }), cfg.jobTimeoutMs); })();
        return this._second;
      },
    };
    for (const { job, m } of items) {
      try {
        await evaluate(m, ctx);
        finishOk(job, m);
      } catch (e) {
        handleFailure(job, m, e);
      }
    }
  } catch (e) {
    for (const { job, m } of items) handleFailure(job, m, e);
  }
}

/* =============== the actual change decision =============== */
async function evaluate(m, ctx) {
  const opts = { ignore: J(m.ignore_selectors), watch: J(m.watch_selectors), sensitivity: m.sensitivity };
  const text1 = extractText(ctx.first.html, opts).text;

  const problem = classifyResponse(ctx.first, text1);
  if (problem) throw new CheckError(problem.message, problem);
  if (text1.length < 20) throw new CheckError('No readable text was found on the page.', { retryable: true });

  const prev = m.current_snapshot ? db.prepare('SELECT * FROM snapshots WHERE id=?').get(m.current_snapshot) : null;
  const known = new Set(J(m.volatile));
  const rawHash = sha(text1);

  // Learn which lines differ between two loads seconds apart: those are rotating content, not changes.
  const learnUnstable = async () => {
    const second = await ctx.second();
    const text2 = extractText(second.html, opts).text;
    if (classifyResponse(second, text2)) return new Set(); // second load failed or was blocked: learn nothing
    const d = multisetDiff(text1, text2);
    const found = new Set([...d.added, ...d.removed]);
    if (found.size) {
      found.forEach((l) => known.add(l));
      const keep = [...known].slice(-300);
      db.prepare('UPDATE monitors SET volatile=? WHERE id=?').run(JSON.stringify(keep), m.id);
    }
    return found;
  };

  if (!prev) {
    await learnUnstable();
    const text = stabilize(text1, known);
    await createSnapshot(m, ctx, { text, rawHash, baseline: true, added: [], removed: [] });
    return;
  }

  if (text1.length < 50 && prev.text.length > 500) throw new CheckError('The page came back almost empty.', { retryable: true });
  if (rawHash === m.last_raw_hash) return; // byte-identical after noise filtering: nothing to do

  let t1 = stabilize(text1, known);
  let d = multisetDiff(stabilize(prev.text, known), t1);
  if (d.added.length || d.removed.length) {
    await learnUnstable();
    t1 = stabilize(text1, known);
    d = multisetDiff(stabilize(prev.text, known), t1);
  }
  db.prepare('UPDATE monitors SET last_raw_hash=? WHERE id=?').run(rawHash, m.id);

  const prevLines = prev.text.split('\n').length;
  if (!isSignificant(d, prevLines, m.sensitivity)) return; // below the sensitivity threshold

  await createSnapshot(m, ctx, { text: t1, rawHash, baseline: false, added: d.added, removed: d.removed });
}

async function createSnapshot(m, ctx, { text, rawHash, baseline, added, removed }) {
  if (!ctx.shotFile && ctx.first.png) {
    ctx.shotFile = `${crypto.randomUUID()}.png`;
    fs.writeFileSync(path.join(cfg.dataDir, 'shots', ctx.shotFile), ctx.first.png);
  }
  const now = Date.now();
  const summary = baseline ? 'First snapshot saved.' : await summarize(m.name, added, removed);
  const info = db.prepare(
    `INSERT INTO snapshots(monitor_id, hash, text, shot, summary, added, removed, baseline, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(m.id, sha(text), text, ctx.shotFile, summary, added.length, removed.length, baseline ? 1 : 0, now);
  const snapId = Number(info.lastInsertRowid);
  db.prepare(
    `UPDATE monitors SET current_snapshot=?, last_raw_hash=?, last_changed=CASE WHEN ?=1 THEN last_changed ELSE ? END WHERE id=?`
  ).run(snapId, rawHash, baseline ? 1 : 0, now, m.id);

  // keep the newest N versions
  db.prepare(
    `DELETE FROM snapshots WHERE monitor_id=? AND id NOT IN (SELECT id FROM snapshots WHERE monitor_id=? ORDER BY id DESC LIMIT ?)`
  ).run(m.id, m.id, cfg.retainSnapshots);

  if (baseline) return;

  // flap breaker: >=5 versions in 6 h means the page changes on (almost) every load
  const recent = db.prepare(`SELECT COUNT(*) c FROM snapshots WHERE monitor_id=? AND baseline=0 AND created_at>?`).get(m.id, now - 6 * 3600_000).c;
  if (recent >= 5) {
    m.status = 'noisy';
    db.prepare(`UPDATE monitors SET status='noisy', last_error=? WHERE id=?`).run(
      'This page changes on almost every check. Alerts are paused until it settles. Use “Pick regions” to watch only the part you care about, or lower the sensitivity.', m.id);
    createAlert(m, 'noisy', `noisy:${Math.floor(now / 21_600_000)}`, {
      title: `${m.name} is changing constantly`,
      body: 'Tidemark paused change alerts for this page because it differs on almost every load. Pick the region you care about to get useful alerts again.',
      link: `${cfg.baseUrl}/#/m/${m.id}`,
    });
    return;
  }

  // keyword-only alerts: still keep the version, but only notify on a keyword hit
  const kws = J(m.keywords);
  if (kws.length) {
    const hay = [...added, ...removed].join('\n').toLowerCase();
    if (!kws.some((k) => hay.includes(String(k).toLowerCase()))) return;
  }
  createAlert(m, 'change', `change:${snapId}`, {
    title: `${m.name} changed`,
    body: summary,
    link: `${cfg.baseUrl}/#/m/${m.id}/${snapId}`,
  }, m.digest ? 1 : 0);
}

/* =============== outcomes =============== */
function finishOk(job, m) {
  const now = Date.now();
  const cur = db.prepare('SELECT status, down_notified FROM monitors WHERE id=?').get(m.id);
  const recentChanges = db.prepare(`SELECT COUNT(*) c FROM snapshots WHERE monitor_id=? AND baseline=0 AND created_at>?`).get(m.id, now - 6 * 3600_000).c;
  const status = recentChanges >= 5 ? 'noisy' : 'ok';
  db.prepare(
    `UPDATE monitors SET status=?, last_checked=?, last_error=CASE WHEN ?='noisy' THEN last_error ELSE NULL END,
     fail_count=0, down_notified=0, next_run=? WHERE id=?`
  ).run(status, now, status, now + jitter(m.interval_min * 60_000), m.id);
  if (cur.down_notified) {
    createAlert(m, 'recovered', `recovered:${now}`, {
      title: `${m.name} is back`,
      body: 'The page is reachable again and checks have resumed.',
      link: `${cfg.baseUrl}/#/m/${m.id}`,
    });
  }
  db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
}

function handleFailure(job, m, err) {
  const e = err instanceof CheckError ? err : new CheckError(err?.message?.split('\n')[0] || 'Check failed', { retryable: true });
  const now = Date.now();
  if (e.retryable && job.attempts + 1 < cfg.maxAttempts) {
    const delay = Math.max(cfg.retryDelaysMs[job.attempts] ?? 600_000, e.retryAfterMs || 0);
    db.prepare(`UPDATE jobs SET state='queued', locked_at=NULL, attempts=attempts+1, run_at=? WHERE id=?`).run(now + delay, job.id);
    return;
  }
  const fails = (m.fail_count || 0) + 1;
  const base = m.interval_min * 60_000;
  const backoff = Math.min(base * 2 ** Math.min(fails - 1, 4), 86_400_000); // 1x,2x,4x,8x,16x capped at 24h
  const status = e.kind === 'blocked' ? 'blocked' : 'error';
  db.prepare(
    `UPDATE monitors SET status=?, last_checked=?, last_error=?, fail_count=?, next_run=? WHERE id=?`
  ).run(status, now, e.message, fails, now + jitter(Math.max(base, backoff, e.retryAfterMs || 0)), m.id);
  db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);

  // one notice after 3 failed cycles, never one per failure
  if (fails >= 3 && !m.down_notified) {
    db.prepare('UPDATE monitors SET down_notified=1 WHERE id=?').run(m.id);
    createAlert(m, status === 'blocked' ? 'blocked' : 'down', `${status}:${now}`, {
      title: status === 'blocked' ? `${m.name} is blocking checks` : `${m.name} looks unreachable`,
      body: `${e.message} This is not a page change, so no version was saved. Tidemark will keep retrying with longer gaps.`,
      link: `${cfg.baseUrl}/#/m/${m.id}`,
    });
  }
}

/* =============== alerts =============== */
function createAlert(m, kind, dedupeKey, payload, hold = 0) {
  db.prepare(
    `INSERT OR IGNORE INTO alerts(monitor_id, dedupe_key, kind, payload, hold, created_at) VALUES(?,?,?,?,?,?)`
  ).run(m.id, dedupeKey, kind, JSON.stringify(payload), hold, Date.now());
}

async function sendPendingAlerts() {
  const rows = db.prepare(`SELECT * FROM alerts WHERE sent=0 AND hold=0 AND attempts<5 ORDER BY id LIMIT 20`).all();
  for (const a of rows) {
    const m = db.prepare('SELECT * FROM monitors WHERE id=?').get(a.monitor_id);
    if (!m || !channelsOf(m).length) { // dashboard + RSS only
      db.prepare('UPDATE alerts SET sent=1 WHERE id=?').run(a.id);
      continue;
    }
    const { delivered, error } = await deliver(m, JSON.parse(a.payload), J(a.delivered));
    if (error) db.prepare('UPDATE alerts SET attempts=attempts+1, delivered=? WHERE id=?').run(JSON.stringify(delivered), a.id);
    else db.prepare('UPDATE alerts SET sent=1, delivered=? WHERE id=?').run(JSON.stringify(delivered), a.id);
  }
}

async function maybeDigest() {
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  if (d.getUTCHours() !== cfg.digestHourUtc || getMeta('digest_day') === day) return;
  setMeta('digest_day', day);
  const rows = db.prepare(
    `SELECT a.*, m.name FROM alerts a JOIN monitors m ON m.id=a.monitor_id WHERE a.sent=0 AND a.hold=1 ORDER BY a.id`
  ).all();
  const groups = new Map();
  for (const a of rows) {
    const m = db.prepare('SELECT * FROM monitors WHERE id=?').get(a.monitor_id);
    const key = [m.owner, m.email, m.telegram_chat, m.discord_webhook].join('|');
    if (!groups.has(key)) groups.set(key, { m, items: [] });
    groups.get(key).items.push(a);
  }
  for (const { m, items } of groups.values()) {
    const body = items.map((a) => { const p = JSON.parse(a.payload); return `• ${a.name}: ${p.body}\n  ${p.link}`; }).join('\n');
    const { error } = await deliver(m, { title: `Tidemark daily digest: ${items.length} change${items.length > 1 ? 's' : ''}`, body, link: cfg.baseUrl });
    if (!error || !channelsOf(m).length) {
      const mark = db.prepare('UPDATE alerts SET sent=1 WHERE id=?');
      items.forEach((a) => mark.run(a.id));
    } else {
      const rel = db.prepare('UPDATE alerts SET hold=0 WHERE id=?'); // fall back to individual retries
      items.forEach((a) => rel.run(a.id));
    }
  }
}

let lastClean = 0;
function housekeeping() {
  const now = Date.now();
  if (now - lastClean < 3600_000) return;
  lastClean = now;
  db.prepare(`DELETE FROM alerts WHERE created_at < ? AND sent=1`).run(now - 30 * 86_400_000);
  const used = new Set(db.prepare('SELECT shot FROM snapshots WHERE shot IS NOT NULL').all().map((r) => r.shot));
  const dir = path.join(cfg.dataDir, 'shots');
  for (const f of fs.readdirSync(dir)) {
    const age = now - fs.statSync(path.join(dir, f)).mtimeMs;
    if (!used.has(f) && age > 3600_000) fs.rmSync(path.join(dir, f), { force: true });
  }
}
