import * as cheerio from 'cheerio';
import crypto from 'node:crypto';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- DOM-level noise ---------- */
const ALWAYS_REMOVE = [
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'link', 'meta', 'head',
  '[hidden]', '[aria-hidden="true"]', '[style*="display:none"]', '[style*="display: none"]',
];
const ADS = [
  'ins.adsbygoogle', '[id^="google_ads"]', '[class~="ad"]', '[class~="ads"]', '[class~="advert"]',
  '[class*="advert"]', '[class*="sponsor"]', '[id*="advert"]', '[data-ad]', '[data-ad-slot]',
  '[data-google-query-id]', '[aria-label*="dvertisement" i]',
];
const BANNERS = ['[class*="cookie"]', '[id*="cookie"]', '[class*="consent"]', '[id*="consent"]', '[class*="gdpr"]'];
const ROTATING = ['[class*="carousel"]', '[class*="slider"]', '[class*="swiper"]', '[class*="rotator"]', '[class*="ticker"]', '[class*="marquee"]'];
const BLOCKS = 'p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,header,footer,nav,main,aside,ul,ol,table,blockquote,pre,dt,dd,form,figure,figcaption,option,hr';

/* ---------- text-level noise ---------- */
const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const TOKEN_RES = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b[0-9a-f]{16,}\b/gi,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g,
];
const TIME_RES = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?(?:\s?(?:UTC|GMT|IST|EST|EDT|PST|PDT|CET|BST))?\b/gi,
  new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}(?:,?\\s+\\d{4})?\\b`, 'gi'),
  /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\.\d{1,2}\.\d{4})\b/g,
  /\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi,
  /\b(?:just now|yesterday|today|tomorrow|a moment ago)\b/gi,
  /(?:©|\(c\)|copyright)\s*\d{4}(?:\s*[-–]\s*\d{4})?/gi,
];
const COUNTER_RE =
  /\b\d[\d,.]*[kKmM]?\+?\s?(?:views?|likes?|comments?|shares?|visitors?|users?|online|readers?|followers?|downloads?|votes?|points?|people|watching|reads?)\b/gi;

export function normalizeLine(line, sensitivity = 'medium') {
  let s = line.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (const re of TOKEN_RES) s = s.replace(re, '‹id›');
  if (sensitivity !== 'high') {
    s = s.replace(COUNTER_RE, '‹count›');
    for (const re of TIME_RES) s = s.replace(re, '‹time›');
  }
  return s;
}

function safeRemove($, sel) {
  try { $(sel).remove(); } catch { /* invalid selector – ignore */ }
}

/** Returns normalised, de-noised page text, one logical line per block element. */
export function extractText(html, { ignore = [], watch = [], sensitivity = 'medium' } = {}) {
  const $ = cheerio.load(html);
  ALWAYS_REMOVE.forEach((s) => safeRemove($, s));
  if (sensitivity !== 'high') [...ADS, ...BANNERS, ...ROTATING].forEach((s) => safeRemove($, s));
  ignore.forEach((s) => safeRemove($, s));

  $('br').replaceWith('\n');
  $(BLOCKS).prepend('\n').append('\n');
  $('td,th').append(' ');

  let raw;
  if (watch.length) {
    const parts = [];
    for (const sel of watch) {
      try { $(sel).each((_, el) => parts.push($(el).text())); } catch { /* ignore bad selector */ }
    }
    raw = parts.join('\n');
  } else {
    raw = $('body').length ? $('body').text() : $.root().text();
  }
  const lines = raw.split('\n').map((l) => normalizeLine(l, sensitivity)).filter(Boolean);
  return { text: lines.join('\n'), lines };
}

/* ---------- line multiset helpers ---------- */
const countLines = (text) => {
  const m = new Map();
  for (const l of text.split('\n')) if (l) m.set(l, (m.get(l) || 0) + 1);
  return m;
};

export function multisetDiff(aText, bText) {
  const a = countLines(aText);
  const b = countLines(bText);
  const added = [];
  const removed = [];
  for (const [l, c] of b) for (let i = 0; i < c - (a.get(l) || 0); i++) added.push(l);
  for (const [l, c] of a) for (let i = 0; i < c - (b.get(l) || 0); i++) removed.push(l);
  return { added, removed };
}

export const stabilize = (text, unstableSet) =>
  unstableSet.size ? text.split('\n').filter((l) => !unstableSet.has(l)).join('\n') : text;

/** Sensitivity decides how big a change must be before it counts. */
export function isSignificant({ added, removed }, prevLineCount, sensitivity) {
  const n = added.length + removed.length;
  if (n === 0) return false;
  if (sensitivity === 'high') return true;
  const chars = added.join('').length + removed.join('').length;
  if (sensitivity === 'low') return n >= 4 || n / Math.max(prevLineCount, 1) >= 0.1;
  return chars >= 3;
}
