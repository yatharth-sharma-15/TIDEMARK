import express from 'express';
import rateLimit from 'express-rate-limit';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { db } from './db.js';
import { normalizeUrl, assertPublicUrl } from './ssrf.js';
import { startWorker } from './worker.js';
import { scanForPicker, closeBrowser } from './checker.js';
import { textDiff, screenshotDiff } from './diff.js';
import { robotsAllows } from './robots.js';
import { validDiscordWebhook } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use('/shots', express.static(path.join(cfg.dataDir, 'shots'), { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---------------- helpers ---------------- */
const J = (s) => { try { return JSON.parse(s); } catch { return []; } };
const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function ownerAuth(req, _res, next) {
  const k = req.get('x-owner-key') || req.query.k;
  if (!/^[\w-]{16,64}$/.test(k || '')) return next(httpError(401, 'Missing workspace key.'));
  req.owner = k;
  next();
}

function owned(req) {
  const m = db.prepare('SELECT * FROM monitors WHERE id=? AND owner=?').get(req.params.id, req.owner);
  if (!m) throw httpError(404, 'Monitor not found.');
  return m;
}

function publicMonitor(m) {
  const latest = m.current_snapshot ? db.prepare('SELECT id, summary, created_at FROM snapshots WHERE id=?').get(m.current_snapshot) : null;
  const versions = db.prepare('SELECT COUNT(*) c FROM snapshots WHERE monitor_id=?').get(m.id).c;
  return {
    id: m.id, name: m.name, url: m.url, interval_min: m.interval_min, sensitivity: m.sensitivity,
    ignore_selectors: J(m.ignore_selectors), watch_selectors: J(m.watch_selectors), keywords: J(m.keywords),
    email: m.email || '', telegram_chat: m.telegram_chat || '', discord_webhook: m.discord_webhook || '',
    digest: !!m.digest, paused: !!m.paused,
    status: m.paused ? 'paused' : m.status, last_error: m.last_error,
    last_checked: m.last_checked, last_changed: m.last_changed, next_run: m.next_run,
    versions, latest_summary: latest?.summary || null, created_at: m.created_at,
  };
}

function checkSelectors(list, label) {
  if (!Array.isArray(list)) throw httpError(400, `${label} must be a list.`);
  const out = [];
  for (const raw of list.slice(0, 20)) {
    const s = String(raw).trim();
    if (!s) continue;
    if (s.length > 300) throw httpError(400, `${label}: selector is too long.`);
    try { cheerio.load('<div></div>')(s); } catch { throw httpError(400, `${label}: “${s}” is not a valid CSS selector.`); }
    out.push(s);
  }
  return out;
}

async function validate(body, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 80) throw httpError(400, 'Give the monitor a name (up to 80 characters).');
    out.name = name;
  }
  if (!partial || has('url')) {
    let url;
    try { url = normalizeUrl(body.url); } catch (e) { throw httpError(400, e.message); }
    try { await assertPublicUrl(url); } catch (e) { throw httpError(400, e.message); }
    out.url = url;
  }
  if (!partial || has('interval_min')) {
    const n = Math.round(Number(body.interval_min ?? 60));
    if (!(n >= cfg.minIntervalMin && n <= cfg.maxIntervalMin)) throw httpError(400, 'Check interval must be between 15 minutes and 24 hours.');
    out.interval_min = n;
  }
  if (!partial || has('sensitivity')) {
    const s = body.sensitivity ?? 'medium';
    if (!['low', 'medium', 'high'].includes(s)) throw httpError(400, 'Sensitivity must be low, medium or high.');
    out.sensitivity = s;
  }
  if (!partial || has('ignore_selectors')) out.ignore_selectors = JSON.stringify(checkSelectors(body.ignore_selectors ?? [], 'Ignore regions'));
  if (!partial || has('watch_selectors')) out.watch_selectors = JSON.stringify(checkSelectors(body.watch_selectors ?? [], 'Watch regions'));
  if (!partial || has('keywords')) {
    const k = (Array.isArray(body.keywords) ? body.keywords : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
    if (k.some((x) => x.length > 60)) throw httpError(400, 'Keywords can be up to 60 characters.');
    out.keywords = JSON.stringify(k);
  }
  if (!partial || has('email')) {
    const e = String(body.email ?? '').trim();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, 'That email address does not look right.');
    out.email = e || null;
  }
  if (!partial || has('telegram_chat')) {
    const t = String(body.telegram_chat ?? '').trim();
    if (t && !/^(-?\d{1,20}|@\w{4,})$/.test(t)) throw httpError(400, 'Telegram chat ID should be a number (or @channelname).');
    out.telegram_chat = t || null;
  }
  if (!partial || has('discord_webhook')) {
    const d = String(body.discord_webhook ?? '').trim();
    if (d && !validDiscordWebhook(d)) throw httpError(400, 'Enter a Discord webhook URL (https://discord.com/api/webhooks/…).');
    out.discord_webhook = d || null;
  }
  if (!partial || has('digest')) out.digest = body.digest ? 1 : 0;
  return out;
}

/* ---------------- API ---------------- */
const api = express.Router();
api.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
api.use(ownerAuth);

api.get('/monitors', (req, res) => {
  const rows = db.prepare('SELECT * FROM monitors WHERE owner=? ORDER BY created_at DESC').all(req.owner);
  res.json(rows.map(publicMonitor));
});

api.post('/monitors', wrap(async (req, res) => {
  const count = db.prepare('SELECT COUNT(*) c FROM monitors WHERE owner=?').get(req.owner).c;
  if (count >= cfg.maxMonitorsPerOwner) throw httpError(400, `You can monitor up to ${cfg.maxMonitorsPerOwner} pages.`);
  const v = await validate(req.body);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO monitors(id, owner, name, url, interval_min, sensitivity, ignore_selectors, watch_selectors, keywords,
       email, telegram_chat, discord_webhook, digest, next_run, created_at)
     VALUES(@id, @owner, @name, @url, @interval_min, @sensitivity, @ignore_selectors, @watch_selectors, @keywords,
       @email, @telegram_chat, @discord_webhook, @digest, @now, @now)`
  ).run({ id, owner: req.owner, now: Date.now(), ...v });
  res.status(201).json(publicMonitor(db.prepare('SELECT * FROM monitors WHERE id=?').get(id)));
}));

api.patch('/monitors/:id', wrap(async (req, res) => {
  const m = owned(req);
  const v = await validate(req.body, true);
  if (req.body.paused !== undefined) v.paused = req.body.paused ? 1 : 0;
  // A change to what is watched invalidates the old baseline: re-learn it.
  const resets = ['url', 'sensitivity', 'ignore_selectors', 'watch_selectors'].some((k) => v[k] !== undefined && v[k] !== m[k]);
  const keys = Object.keys(v);
  if (keys.length) {
    db.prepare(`UPDATE monitors SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run({ ...v, id: m.id });
  }
  if (resets) {
    db.prepare(`UPDATE monitors SET current_snapshot=NULL, last_raw_hash=NULL, volatile='[]', status='pending', last_error=NULL, fail_count=0, next_run=? WHERE id=?`).run(Date.now(), m.id);
  } else if (v.interval_min || v.paused === 0) {
    db.prepare('UPDATE monitors SET next_run=? WHERE id=?').run(Date.now(), m.id);
  }
  res.json(publicMonitor(db.prepare('SELECT * FROM monitors WHERE id=?').get(m.id)));
}));

api.delete('/monitors/:id', (req, res) => {
  const m = owned(req);
  db.prepare('DELETE FROM monitors WHERE id=?').run(m.id);
  res.status(204).end();
});

api.post('/monitors/:id/check', (req, res) => {
  const m = owned(req);
  if (m.last_checked && Date.now() - m.last_checked < 60_000) throw httpError(429, 'Checked less than a minute ago.');
  if (!db.prepare('SELECT 1 FROM jobs WHERE monitor_id=?').get(m.id)) {
    db.prepare(`INSERT INTO jobs(monitor_id, run_at, state) VALUES(?,?,'queued')`).run(m.id, Date.now());
  }
  res.status(202).json({ queued: true });
});

api.get('/monitors/:id/snapshots', (req, res) => {
  const m = owned(req);
  const rows = db.prepare(
    `SELECT id, summary, added, removed, baseline, created_at, shot FROM snapshots WHERE monitor_id=? ORDER BY id DESC`
  ).all(m.id);
  res.json(rows);
});

function pair(req, m) {
  const get = (id) => db.prepare('SELECT * FROM snapshots WHERE id=? AND monitor_id=?').get(Number(id), m.id);
  const a = get(req.query.from);
  const b = get(req.query.to);
  if (!a || !b) throw httpError(404, 'Version not found. It may have been pruned.');
  return [a, b];
}

api.get('/monitors/:id/diff', (req, res) => {
  const m = owned(req);
  const [a, b] = pair(req, m);
  res.json({
    from: { id: a.id, created_at: a.created_at, shot: a.shot },
    to: { id: b.id, created_at: b.created_at, shot: b.shot },
    ...textDiff(a.text, b.text),
  });
});

api.get('/monitors/:id/shotdiff', (req, res) => {
  const m = owned(req);
  const [a, b] = pair(req, m);
  if (!a.shot || !b.shot) throw httpError(404, 'No screenshot for one of these versions.');
  const read = (f) => fs.readFileSync(path.join(cfg.dataDir, 'shots', path.basename(f)));
  const out = screenshotDiff(read(a.shot), read(b.shot));
  res.set('X-Diff-Ratio', out.ratio.toFixed(5));
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('png').send(out.png);
});

// Visual picker: one headless page at a time, strictly limited.
let pickerBusy = false;
api.post('/picker', rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: true, legacyHeaders: false }), wrap(async (req, res) => {
  let url;
  try { url = normalizeUrl(req.body.url); await assertPublicUrl(url); } catch (e) { throw httpError(400, e.message); }
  if (cfg.respectRobots && !(await robotsAllows(url))) throw httpError(400, 'This site’s robots.txt asks bots not to load the page.');
  if (pickerBusy) throw httpError(429, 'Another page is loading. Try again in a few seconds.');
  pickerBusy = true;
  try {
    res.json(await scanForPicker(url));
  } catch {
    throw httpError(502, 'Could not load that page for the picker.');
  } finally {
    pickerBusy = false;
  }
}));

app.use('/api', api);

/* ---------------- RSS: the monitor id is the (unguessable) read token ---------------- */
const xml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
app.get('/feed/:id.xml', (req, res) => {
  const m = db.prepare('SELECT * FROM monitors WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).send('Not found');
  const items = db.prepare(`SELECT * FROM snapshots WHERE monitor_id=? AND baseline=0 ORDER BY id DESC LIMIT 30`).all(m.id);
  res.type('application/rss+xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(m.name)} · Tidemark</title><link>${xml(m.url)}</link>` +
    `<description>Changes detected on ${xml(m.url)}</description>` +
    items.map((s) => `<item><title>${xml(m.name)} changed</title><guid isPermaLink="false">${m.id}-${s.id}</guid>` +
      `<pubDate>${new Date(s.created_at).toUTCString()}</pubDate><link>${xml(`${cfg.baseUrl}/#/m/${m.id}/${s.id}`)}</link>` +
      `<description>${xml(s.summary)}</description></item>`).join('') +
    `</channel></rss>`
  );
});

/* ---------------- errors ---------------- */
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side.' : err.message });
});

const server = app.listen(cfg.port, () => {
  console.log(`Tidemark listening on :${cfg.port}`);
  startWorker();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
