import path from 'node:path';

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const cfg = {
  port: num(process.env.PORT, 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${num(process.env.PORT, 3000)}`).replace(/\/$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  concurrency: num(process.env.WORKER_CONCURRENCY, 2),
  domainGapMs: num(process.env.DOMAIN_MIN_GAP_MS, 10000),
  respectRobots: process.env.RESPECT_ROBOTS !== 'false',
  maxMonitorsPerOwner: num(process.env.MAX_MONITORS_PER_OWNER, 25),
  stabilizeDelayMs: num(process.env.STABILIZE_DELAY_MS, 4000),
  maxAttempts: 3,
  retryDelaysMs: [30_000, 120_000, 600_000],
  jobTimeoutMs: 60_000,
  minIntervalMin: 15,
  maxIntervalMin: 1440,
  retainSnapshots: 60,
  digestHourUtc: num(process.env.DIGEST_HOUR_UTC, 3),
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'Tidemark <alerts@localhost>',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  userAgent: 'Mozilla/5.0 (compatible; TidemarkBot/1.0; +https://github.com/your-name/tidemark)',
};
