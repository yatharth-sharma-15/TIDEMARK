import { cfg } from './config.js';

const cache = new Map();
const TOKEN = 'tidemarkbot';

export function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'disallow' || key === 'allow') && cur) {
      cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && TOKEN.includes(a)));
  const pick = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return pick.flatMap((g) => g.rules);
}

function patternToRegex(p) {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc.replace(/\\\$$/, '$'));
}

export function isAllowed(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!r.path) continue; // empty Disallow = allow all
    if (patternToRegex(r.path).test(pathAndQuery)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}

export async function robotsAllows(urlStr) {
  const u = new URL(urlStr);
  let ent = cache.get(u.origin);
  if (!ent || ent.exp < Date.now()) {
    let rules = [];
    try {
      const r = await fetch(`${u.origin}/robots.txt`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
        headers: { 'user-agent': cfg.userAgent },
      });
      if (r.ok) rules = parseRobots((await r.text()).slice(0, 200_000));
    } catch { /* no robots.txt reachable = allowed */ }
    ent = { rules, exp: Date.now() + 3_600_000 };
    cache.set(u.origin, ent);
  }
  return isAllowed(ent.rules, u.pathname + u.search);
}
