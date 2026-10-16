# Tidemark

**Live demo:** https://tidemark-5zgu.onrender.com

A website change detector. Add a public page and Tidemark loads it in a real browser on a schedule, throws away the noise (clocks, counters, ads, rotating banners, random tokens) and alerts you only when something meaningful changed.

Every version keeps the page text and a screenshot, so you can compare any two versions as a text diff, a highlighted screenshot diff, or side by side.

## Features

| Requirement | Where |
| --- | --- |
| Add URL, name, interval (15 min to 24 h), headless Chromium | `src/server.js`, `src/checker.js` (Playwright) |
| Scheduler, job queue, timeouts, retries, public pages only | `src/worker.js`, `src/ssrf.js` |
| Text + screenshot per check, new version only when the content hash changes | `src/worker.js` |
| Noise filtering plus sensitivity (low / medium / high) | `src/noise.js` |
| Visual picker for watch / ignore regions (saved as CSS selectors) | `scanForPicker()` + `public/app.js` |
| Text diff, highlighted screenshot diff, side by side | `src/diff.js` |
| Email, Telegram, Discord alerts with summary and diff link, no duplicates, daily digest | `src/notify.js`, `alerts` table (`UNIQUE(monitor_id, dedupe_key)`) |
| Per-page version timeline and dashboard (last checked, last changed, OK / error / blocked) | `public/` |
| Bonus: keyword-only alerts, AI one-line summaries, per-page RSS feed | `worker.js`, `summary.js`, `/feed/:id.xml` |

The answers to the four design questions (outage vs change, 200 watchers, pages that differ on every load, not hammering sites) are in **[docs/DESIGN.md](docs/DESIGN.md)**.

## Run locally

Requires Node 22+.

```bash
npm install            # also downloads Chromium
cp .env.example .env   # optional, everything has a default
npm start              # http://localhost:3000
npm test
```

Local development against pages on your own machine (normally blocked by the SSRF guard):

```bash
ALLOW_PRIVATE_HOSTS=true npm start
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | Used for links inside alerts |
| `DATA_DIR` | `./data` | SQLite database and screenshots |
| `WORKER_CONCURRENCY` | `2` | Parallel page loads. Use `1` on small instances |
| `DOMAIN_MIN_GAP_MS` | `10000` | Minimum gap between requests to one host |
| `RESPECT_ROBOTS` | `true` | Obey robots.txt |
| `MAX_MONITORS_PER_OWNER` | `25` | Per-workspace cap |
| `SMTP_URL`, `MAIL_FROM` | none | Email alerts, e.g. `smtps://user:pass@smtp.host:465` |
| `TELEGRAM_BOT_TOKEN` | none | Create a bot with @BotFather; users enter their chat ID |
| `DIGEST_HOUR_UTC` | `3` | When daily digests go out |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | none | Optional one-line AI summaries (falls back to a built-in summary) |

Discord needs no server setup: each monitor stores its own webhook URL.

## Put it on GitHub

```bash
cd tidemark
git init
git add .
git commit -m "Tidemark: website change detector"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Create the empty repository on github.com first (no README, no .gitignore). `.gitignore` already keeps `node_modules`, `data` and `.env` out of the repo.

## Deploy on Render

1. Push to GitHub (above).
2. In Render choose **New > Blueprint** and select the repo. `render.yaml` creates a Docker web service with a 5 GB disk at `/data`.
3. Set `BASE_URL` to your Render URL, plus any alert settings.

Notes: the disk needs a paid instance; on the free tier the database resets on every deploy. Chromium needs about 1 GB of RAM, so if the service restarts under load, pick a larger instance or keep `WORKER_CONCURRENCY=1`.

## Project layout

```
src/
  server.js    REST API, RSS, static files
  worker.js    scheduler, queue, check pipeline, alerts, digest
  checker.js   Playwright rendering, outage/CAPTCHA classification, picker scan
  noise.js     DOM and text noise filtering, sensitivity rules
  diff.js      text diff, screenshot diff
  notify.js    email / Telegram / Discord delivery
  ssrf.js      public-URL enforcement
  robots.js    robots.txt parsing
public/        dashboard (vanilla JS, no build step)
tests/         node:test suite (noise, diffs, SSRF, robots, full check pipeline)
```

## Privacy and etiquette

Monitor only pages you are allowed to access. Tidemark identifies itself in its User-Agent, honours robots.txt and spaces out requests, but you are responsible for what you point it at.
