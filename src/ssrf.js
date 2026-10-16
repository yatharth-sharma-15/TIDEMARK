import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const cache = new Map(); // host -> expiry

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true;
}

/** Normalise a user-supplied URL: http(s) only, no credentials, no fragment, lower-case host. */
export function normalizeUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error('Enter a full URL, for example https://example.com/pricing');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https pages can be monitored.');
  if (u.username || u.password) throw new Error('URLs with a username or password are not supported. Only public pages can be monitored.');
  if (process.env.ALLOW_PRIVATE_HOSTS !== 'true' && !ALLOWED_PORTS.has(u.port)) throw new Error('Only ports 80, 443, 8080 and 8443 are allowed.');
  u.hash = '';
  return u.toString();
}

/** Throws unless the hostname resolves only to public addresses. Cached for 60 s. */
export async function assertPublicUrl(urlStr) {
  if (process.env.ALLOW_PRIVATE_HOSTS === 'true') return; // local development and tests only
  const u = new URL(urlStr);
  if (['data:', 'blob:', 'about:'].includes(u.protocol)) return;
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Blocked protocol');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Private addresses cannot be monitored.');
  }
  if ((cache.get(host) || 0) > Date.now()) return;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private addresses cannot be monitored.');
  } else {
    let addrs;
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw new Error(`Could not resolve ${host}`);
    }
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error('Private addresses cannot be monitored.');
    }
  }
  cache.set(host, Date.now() + 60_000);
  if (cache.size > 2000) cache.clear();
}
