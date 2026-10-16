import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { textDiff, screenshotDiff } from '../src/diff.js';
import { isPrivateIp, normalizeUrl, assertPublicUrl } from '../src/ssrf.js';
import { parseRobots, isAllowed } from '../src/robots.js';
import { classifyResponse } from '../src/checker.js';

test('textDiff reports additions, removals and collapses long unchanged runs', () => {
  const a = ['h', ...Array.from({ length: 30 }, (_, i) => `l${i}`), 'price 10'].join('\n');
  const b = ['h', ...Array.from({ length: 30 }, (_, i) => `l${i}`), 'price 12'].join('\n');
  const d = textDiff(a, b);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.ok(d.rows.some((r) => r.t === 'gap'));
  assert.ok(d.rows.find((r) => r.t === 'add').words.some((w) => w.hl));
});

const solid = (w, h, rgb) => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) { p.data[i * 4] = rgb[0]; p.data[i * 4 + 1] = rgb[1]; p.data[i * 4 + 2] = rgb[2]; p.data[i * 4 + 3] = 255; }
  return p;
};
test('screenshotDiff handles different heights and finds differences', () => {
  const a = PNG.sync.write(solid(40, 40, [255, 255, 255]));
  const b = PNG.sync.write(solid(40, 60, [0, 0, 0]));
  const r = screenshotDiff(a, b);
  assert.ok(r.diffPixels > 0);
  assert.equal(screenshotDiff(a, a).diffPixels, 0);
});

test('private and reserved addresses are rejected', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  await assert.rejects(assertPublicUrl('http://localhost/admin'));
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'));
  assert.throws(() => normalizeUrl('ftp://example.com'));
  assert.throws(() => normalizeUrl('https://user:pw@example.com'));
  assert.equal(normalizeUrl('https://Example.com/a#frag'), 'https://example.com/a');
});

test('robots.txt rules: longest match wins, specific agent beats *', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
  assert.equal(isAllowed(rules, '/private/x'), false);
  assert.equal(isAllowed(rules, '/private/ok/page'), true);
  assert.equal(isAllowed(rules, '/public'), true);
  const specific = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: TidemarkBot\nDisallow:\n');
  assert.equal(isAllowed(specific, '/anything'), true);
});

test('outage and CAPTCHA are classified, normal pages are not', () => {
  assert.equal(classifyResponse({ status: 503, html: '', headers: {} }, 'x'.repeat(100)).kind, 'error');
  assert.equal(classifyResponse({ status: 429, html: '', headers: { 'retry-after': '120' } }, 'x').retryAfterMs, 120000);
  assert.equal(classifyResponse({ status: 200, html: '<div class="g-recaptcha"></div>', title: 'Verify', headers: {} }, 'Please verify you are human').kind, 'blocked');
  assert.equal(classifyResponse({ status: 403, html: '', headers: {} }, 'Forbidden').kind, 'blocked');
  assert.equal(classifyResponse({ status: 200, html: '<form><div class="g-recaptcha"></div></form>', title: 'Contact', headers: {} }, 'A long contact page. '.repeat(200)), null);
});
