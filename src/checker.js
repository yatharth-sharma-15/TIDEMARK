import { chromium } from 'playwright';
import { cfg } from './config.js';
import { assertPublicUrl } from './ssrf.js';

let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  }
  return browser;
}
export async function closeBrowser() {
  try { await browser?.close(); } catch { /* ignore */ }
}

const MAX_SHOT_HEIGHT = 6000;

/** Loads a public page in headless Chromium. Every sub-request is re-checked against the SSRF guard. */
export async function renderPage(url, { screenshot = true, timeoutMs = 30_000 } = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: cfg.userAgent,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  try {
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      try {
        await assertPublicUrl(req.url());
      } catch {
        return route.abort('blockedbyclient');
      }
      if (req.resourceType() === 'media') return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
    const html = await page.content();
    let png = null;
    if (screenshot) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 900);
      png = await page.screenshot({
        type: 'png',
        fullPage: true,
        ...(height > MAX_SHOT_HEIGHT ? { clip: { x: 0, y: 0, width: 1280, height: MAX_SHOT_HEIGHT } } : {}),
      });
    }
    return {
      status: resp?.status() ?? 0,
      headers: resp?.headers() ?? {},
      html,
      title: await page.title().catch(() => ''),
      finalUrl: page.url(),
      png,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ---------- is it a change, an outage, or a block? ---------- */
const CHALLENGE_RE =
  /captcha|verify (?:that )?you(?:'| a)re (?:a )?human|are you a robot|unusual traffic|checking your browser|just a moment|attention required|access denied|request blocked|pardon our interruption/i;
const CHALLENGE_MARKUP = /g-recaptcha|h-captcha|cf-chl|cf-turnstile|px-captcha|datadome/i;

export class CheckError extends Error {
  constructor(message, { kind = 'error', retryable = true, retryAfterMs = 0 } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Returns null when the page is a normal, readable page.
 * Otherwise returns {kind:'blocked'|'error', message, retryable, retryAfterMs}.
 * Blocks and outages are never stored as page versions, so they cannot raise "changed" alerts.
 */
export function classifyResponse({ status, html, title = '', headers = {} }, text) {
  const head = `${title}\n${text.slice(0, 3000)}`;
  const looksLikeChallenge = CHALLENGE_RE.test(head) && text.length < 2500;
  const challengeMarkup = CHALLENGE_MARKUP.test(html) && text.length < 2500;

  if (status === 429) {
    const ra = Number(headers['retry-after']);
    return { kind: 'blocked', message: 'Rate limited by the site (HTTP 429).', retryable: true, retryAfterMs: Number.isFinite(ra) ? Math.min(ra * 1000, 3_600_000) : 300_000 };
  }
  if (status === 401 || status === 403 || looksLikeChallenge || challengeMarkup) {
    return { kind: 'blocked', message: looksLikeChallenge || challengeMarkup ? 'The site showed a CAPTCHA or bot check.' : `The site refused access (HTTP ${status}).`, retryable: false };
  }
  if (status === 404 || status === 410) return { kind: 'error', message: `Page not found (HTTP ${status}).`, retryable: false };
  if (status >= 500 || status === 0) return { kind: 'error', message: `The site is unavailable (HTTP ${status || 'no response'}).`, retryable: true };
  if (status >= 400) return { kind: 'error', message: `Unexpected response (HTTP ${status}).`, retryable: false };
  return null;
}

/* ---------- visual picker support ---------- */
export async function scanForPicker(url) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, userAgent: cfg.userAgent, serviceWorkers: 'block' });
  try {
    await ctx.route('**/*', async (route) => {
      try { await assertPublicUrl(route.request().url()); } catch { return route.abort('blockedbyclient'); }
      return route.continue();
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const scan = await page.evaluate((maxH) => {
      const esc = (s) => CSS.escape(s);
      const uniqueId = (el) => el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll('#' + esc(el.id)).length === 1;
      const path = (el) => {
        const parts = [];
        let cur = el;
        let anchored = false;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
          if (uniqueId(cur)) { parts.unshift('#' + esc(cur.id)); anchored = true; break; }
          let part = cur.tagName.toLowerCase();
          const cls = [...cur.classList].filter((c) => /^[a-zA-Z][\w-]{0,30}$/.test(c) && !/\d{3,}/.test(c)).slice(0, 2);
          if (cls.length) part += '.' + cls.map(esc).join('.');
          const same = [...cur.parentElement.children].filter((s) => s.tagName === cur.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
          parts.unshift(part);
          cur = cur.parentElement;
        }
        if (!anchored) parts.unshift('body');
        return parts.join(' > ');
      };
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'BR', 'HTML', 'BODY']);
      const docH = Math.min(document.documentElement.scrollHeight, maxH);
      const out = [];
      for (const el of document.body.querySelectorAll('*')) {
        if (skip.has(el.tagName) || out.length >= 800) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + scrollX, y = r.top + scrollY;
        if (r.width < 24 || r.height < 14 || y > docH || r.width * r.height > 1280 * docH * 0.92) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const text = (el.innerText || '').trim();
        if (!text && el.tagName !== 'IMG') continue;
        out.push({ sel: path(el), x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(Math.min(r.height, docH - y)), tag: el.tagName.toLowerCase(), text: text.slice(0, 60) });
      }
      return { elements: out, height: docH };
    }, MAX_SHOT_HEIGHT);
    const png = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: true, clip: undefined, ...(scan.height >= MAX_SHOT_HEIGHT ? { fullPage: false, clip: { x: 0, y: 0, width: 1280, height: MAX_SHOT_HEIGHT } } : {}) });
    return { image: `data:image/jpeg;base64,${png.toString('base64')}`, width: 1280, height: scan.height, elements: scan.elements };
  } finally {
    await ctx.close().catch(() => {});
  }
}
