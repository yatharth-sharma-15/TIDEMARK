import { cfg } from './config.js';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function heuristicSummary(added, removed) {
  if (!added.length && !removed.length) return 'No text changes.';
  const bits = [];
  if (added.length) bits.push(`${added.length} line${added.length > 1 ? 's' : ''} added`);
  if (removed.length) bits.push(`${removed.length} removed`);
  let s = bits.join(', ') + '.';
  if (added[0]) s += ` New: “${clip(added[0], 110)}”`;
  else if (removed[0]) s += ` Gone: “${clip(removed[0], 110)}”`;
  return s;
}

/** One-line summary. Uses the Anthropic API when ANTHROPIC_API_KEY is set, otherwise a heuristic. */
export async function summarize(name, added, removed) {
  const fallback = heuristicSummary(added, removed);
  if (!cfg.anthropicKey || (!added.length && !removed.length)) return fallback;
  try {
    const prompt =
      `A monitored web page "${name}" changed. Write ONE plain sentence (max 25 words) saying what changed, ` +
      `for a person deciding whether to look. No preamble.\n\nAdded lines:\n${added.slice(0, 30).map((l) => '+ ' + clip(l, 200)).join('\n') || '(none)'}\n\n` +
      `Removed lines:\n${removed.slice(0, 30).map((l) => '- ' + clip(l, 200)).join('\n') || '(none)'}`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: 120, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) return fallback;
    const data = await r.json();
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim();
    return text ? clip(text, 240) : fallback;
  } catch {
    return fallback;
  }
}
