import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

fs.mkdirSync(path.join(cfg.dataDir, 'shots'), { recursive: true });

export const db = new Database(path.join(cfg.dataDir, 'tidemark.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_min INTEGER NOT NULL DEFAULT 60,
  sensitivity TEXT NOT NULL DEFAULT 'medium',
  ignore_selectors TEXT NOT NULL DEFAULT '[]',
  watch_selectors TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  email TEXT, telegram_chat TEXT, discord_webhook TEXT,
  digest INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  last_checked INTEGER, last_changed INTEGER,
  next_run INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  down_notified INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  current_snapshot INTEGER,
  last_raw_hash TEXT,
  volatile TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitors_owner ON monitors(owner);
CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(paused, next_run);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  text TEXT NOT NULL,
  shot TEXT,
  summary TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  baseline INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_monitor ON snapshots(monitor_id, id DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  locked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, run_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  hold INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE(monitor_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);

// Anything left "running" by a crash goes back in the queue.
db.prepare(`UPDATE jobs SET state='queued', locked_at=NULL WHERE state='running'`).run();

export const getMeta = (k) => db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v;
export const setMeta = (k, v) =>
  db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
