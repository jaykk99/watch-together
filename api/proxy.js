// Vercel serverless function: fetches a page server-side, strips common ad/tracker
// tags and popup redirects, and serves it back same-origin so it can be embedded
// (bypassing X-Frame-Options / frame-ancestors) and so the client can sandbox it.
// This is a lightweight filter, not a full ad blocker — see README "Known limits".
//
// Open-proxy guardrails:
//  - SSRF: blocks private/loopback/link-local/multicast/reserved/documentation
//    IPv4 ranges in every encoding (dotted, octal, hex, decimal), plus the
//    final URL after redirect chains.
//  - Rate limit: 60 requests/minute per client IP (per warm instance), 429
//    with Retry-After when exceeded.

const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googletagservices.com', 'adnxs.com',
  'amazon-adsystem.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'media.net', 'propellerads.com', 'popads.net',
  'popcash.net', 'adskeeper.com', 'mgid.com', 'revcontent.com', 'exoclick.com',
  'juicyads.com', 'trafficjunky.net', 'adsterra.com', 'adform.net', 'bidswitch.net',
  'yieldmo.com', 'smartadserver.com', 'adcolony.com', 'moatads.com', 'scorecardresearch.com',
];
const AD_INLINE_RE = /adsbygoogle|propellerads|exoclick|popads|popcash|juicyads|trafficjunky|adsterra|window\.open\(\s*['"]https?:\/\//i;

// ---------- SSRF guards ----------
function numFromPart(p) {
  // inet_aton style: 0x.. = hex, 0.. = octal, else decimal
  if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
  if (/^0[0-9]+$/.test(p)) return parseInt(p, 8);
  if (/^[0-9]+$/.test(p)) return parseInt(p, 10);
  return NaN;
}

// Normalize any IPv4-ish hostname to 4 octets (BSD inet_aton rules), or null.
export function normalizeIpv4(host) {
  const h = host.toLowerCase();
  const parts = h.split('.');
  if (parts.length === 1 && /^[0-9]+$/.test(parts[0])) {
    const n = Number(parts[0]);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (parts.length === 1 && /^0x[0-9a-f]+$/i.test(parts[0])) {
    const n = parseInt(parts[0], 16);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (parts.length < 2 || parts.length > 4) return null;
  const nums = parts.map(numFromPart);
  if (nums.some(n => !Number.isInteger(n) || n < 0)) return null;
  let n;
  if (parts.length === 2) {
    if (nums[0] > 255 || nums[1] > 0xffffff) return null;
    n = nums[0] * 0x1000000 + nums[1];
  } else if (parts.length === 3) {
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xffff) return null;
    n = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2];
  } else {
    if (nums.some(x => x > 255)) return null;
    n = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3];
  }
  if (n > 0xffffffff) return null;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function inCidr(o, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  return (ip & mask) === (base & mask);
}

export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || /(^|\.)localhost$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return true; // IPv6 unique-local / link-local
  if (h === '::1' || h === '::') return true;
  const o = normalizeIpv4(h);
  if (!o) return false; // not an IP literal — a public DNS name is the caller's risk only insofar as DNS; redirects re-checked
  return (
    inCidr(o, 0x00000000, 8) ||   // 0.0.0.0/8 (this network)
    inCidr(o, 0x0a000000, 8) ||   // 10.0.0.0/8
    inCidr(o, 0x64400000, 10) ||  // 100.64.0.0/10 CGNAT
    inCidr(o, 0x7f000000, 8) ||   // 127.0.0.0/8 loopback
    inCidr(o, 0xa9fe0000, 16) ||  // 169.254.0.0/16 link-local
    inCidr(o, 0xac100000, 12) ||  // 172.16.0.0/12
    inCidr(o, 0xc0000000, 24) ||  // 192.0.0.0/24
    inCidr(o, 0xc0000200, 24) ||  // 192.0.2.0/24 documentation
    inCidr(o, 0xc0586300, 24) ||  // 192.88.99.0/24 (deprecated 6to4 relay)
    inCidr(o, 0xc0a80000, 16) ||  // 192.168.0.0/16
    inCidr(o, 0xc6120000, 15) ||  // 198.18.0.0/15 benchmarking
    inCidr(o, 0xc6336400, 24) ||  // 198.51.100.0/24 documentation
    inCidr(o, 0xcb007100, 24) ||  // 203.0.113.0/24 documentation
    inCidr(o, 0xe0000000, 4) ||   // 224.0.0.0/4 multicast
    inCidr(o, 0xf0000000, 4)      // 240.0.0.0/4 reserved
  );
}

export function isAdUrl(rawUrl, base) {
  try {
    const host = new URL(rawUrl, base).hostname.toLowerCase();
    return AD_HOSTS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

export function stripAds(html, base) {
  html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (m, src) => isAdUrl(src, base) ? '' : m);
  html = html.replace(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => AD_INLINE_RE.test(body) ? '' : m);
  html = html.replace(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>/gi, (m, src) => isAdUrl(src, base) ? '' : m);
  html = html.replace(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi, (m, src) => isAdUrl(src, base) ? '' : m);
  html = html.replace(/<ins\b[^>]*\bclass=["'][^"']*adsbygoogle[^"']*["'][^>]*>[\s\S]*?<\/ins>/gi, '');
  html = html.replace(/<meta\b[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');
  html = html.replace(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  return html;
}

function injectHead(html, base) {
  const baseTag = `<base href="${base.replace(/"/g, '&quot;')}">`;
  const css = '<style>[class*="ad-banner"],[class*="ad-container"],[id*="ad-banner"],[id*="ad-container"],[class*="popup-ad"],[id*="popup-ad"],ins.adsbygoogle{display:none!important}</style>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, m => m + baseTag + css);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, m => m + `<head>${baseTag}${css}</head>`);
  return `<head>${baseTag}${css}</head>${html}`;
}

// ---------- rate limiting (per warm instance, per client IP) ----------
export const RATE_MAX = 60;            // requests
export const RATE_WINDOW_MS = 60_000; // per minute
const buckets = new Map(); // ip -> number[] timestamps

export function rateLimitCheck(ip) {
  const now = Date.now();
  let arr = buckets.get(ip);
  if (!arr) { arr = []; buckets.set(ip, arr); }
  while (arr.length && now - arr[0] > RATE_WINDOW_MS) arr.shift();
  if (arr.length >= RATE_MAX) return false; // rejected
  arr.push(now);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) buckets.delete(k);
      if (buckets.size < 4000) break;
    }
  }
  return true; // allowed
}

function clientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const first = String(fwd || '').split(',')[0].trim();
  return first || (req.headers && req.headers['x-real-ip']) || (req.socket && req.socket.remoteAddress) || 'unknown';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('GET only');
  }
  if (!rateLimitCheck(clientIp(req))) {
    res.setHeader('Retry-After', '30');
    return res.status(429).send('Too many requests — slow down and try again in a bit.');
  }

  const target = req.query.url;
  if (!target || typeof target !== 'string') return res.status(400).send('Missing url');
  if (target.length > 2048) return res.status(400).send('URL too long');
  let u;
  try { u = new URL(target); } catch { return res.status(400).send('Bad url'); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).send('Only http/https allowed');
  if (isPrivateHost(u.hostname)) return res.status(400).send('Blocked host');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(u.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);
    const ct = r.headers.get('content-type') || '';
    try { if (isPrivateHost(new URL(r.url).hostname)) return res.status(400).send('Blocked host'); } catch { return res.status(502).send('Bad redirect'); }
    if (!ct.includes('text/html')) {
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      return res.status(r.status).send(buf);
    }
    let html = await r.text();
    if (html.length > 15_000_000) return res.status(502).send('Page too large to proxy');
    const finalUrl = r.url || u.toString();
    html = stripAds(html, finalUrl);
    html = injectHead(html, finalUrl);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).send('Could not load that page: ' + String((e && e.message) || e).slice(0, 200));
  }
}
