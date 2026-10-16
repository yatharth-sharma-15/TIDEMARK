import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText, multisetDiff, isSignificant, normalizeLine } from '../src/noise.js';

const page = (body) => `<html><head><title>x</title><script>var a=1</script></head><body>${body}</body></html>`;

test('timestamps, counters and tokens are normalised away', () => {
  const a = extractText(page('<p>Updated 5 minutes ago</p><p>12,345 views</p><p>Session 9f86d081884c7d659a2feaa0c55ad015</p><p>Price: $19</p>')).text;
  const b = extractText(page('<p>Updated 9 minutes ago</p><p>12,399 views</p><p>Session 1b4f0e9851971998e732078544c96b36</p><p>Price: $19</p>')).text;
  assert.equal(a, b);
});

test('a real change survives the filter', () => {
  const a = extractText(page('<p>Price: $19</p>')).text;
  const b = extractText(page('<p>Price: $24</p>')).text;
  assert.notEqual(a, b);
  const d = multisetDiff(a, b);
  assert.deepEqual(d.added, ['Price: $24']);
  assert.deepEqual(d.removed, ['Price: $19']);
});

test('version numbers are not mistaken for dates', () => {
  assert.equal(normalizeLine('Release 1.2.3', 'medium'), 'Release 1.2.3');
  assert.notEqual(normalizeLine('Release 1.2.3', 'medium'), normalizeLine('Release 1.2.4', 'medium'));
});

test('ads, scripts, ignore selectors and rotating banners are dropped', () => {
  const html = page('<div class="ad">Buy now</div><div class="hero-carousel">Slide 4</div><div id="chat">Live chat</div><p>Real text</p>');
  assert.equal(extractText(html, { ignore: ['#chat'] }).text, 'Real text');
});

test('watch selectors limit the text to the chosen region', () => {
  const html = page('<div id="a">Alpha</div><div id="b">Beta</div>');
  assert.equal(extractText(html, { watch: ['#b'] }).text, 'Beta');
});

test('block elements become separate lines', () => {
  assert.equal(extractText(page('<h1>Title</h1><p>One</p><p>Two</p>')).text, 'Title\nOne\nTwo');
});

test('sensitivity thresholds', () => {
  const one = { added: ['new line'], removed: [] };
  assert.equal(isSignificant(one, 100, 'high'), true);
  assert.equal(isSignificant(one, 100, 'medium'), true);
  assert.equal(isSignificant(one, 100, 'low'), false);
  assert.equal(isSignificant({ added: ['a', 'b', 'c', 'd'], removed: [] }, 100, 'low'), true);
  assert.equal(isSignificant({ added: [], removed: [] }, 100, 'high'), false);
});
