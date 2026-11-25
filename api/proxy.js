// Vercel serverless function: fetches a page server-side, strips common ad/tracker
// tags and popup redirects, and serves it back same-origin so it can be embedded
// (bypassing X-Frame-Options / frame-ancestors) and so the client can sandbox it.
// This is a lightweight filter, not a full ad blocker — see README "Known limits".
//
// Open-proxy guardrails:
//  - SSRF: blocks private/loopback/link-local/multicast/reserved/documentation
//    IPv4 ranges in every encoding (dotted, octal, hex, decimal) and IPv6
//    forms (mapped ::ffff:a.b.c.d, expanded loopback, fe80::/10, fc00::/7,
//    ff00::/8), and re-checks EVERY redirect hop before it is requested.
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
  // inet_aton style: 0x.. = hex, 0.. = octal, else decimal.
  // A leading-0 part containing 8/9 is NOT valid octal (parseInt('08', 8) === 0
  // would silently rewrite it) — return NaN so the caller fails closed.
  if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
  if (/^0[0-9]+$/.test(p)) return NaN;
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

function isPrivateIpv4(o) {
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

// Parse an IPv6 literal (brackets already stripped) into 8 16-bit groups, or null.
// Handles :: compression and a trailing dotted-quad IPv4 tail (::ffff:127.0.0.1).
export function parseIpv6(host) {
  let h = host;
  let tail = null;
  if (h.includes('.')) {
    const lastColon = h.lastIndexOf(':');
    if (lastColon === -1) return null;
    const quad = normalizeIpv4(h.slice(lastColon + 1));
    if (!quad) return null;
    tail = [(quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    h = h.slice(0, lastColon);
  }
  const dbl = h.indexOf('::');
  let left = [], right = [];
  if (dbl !== -1) {
    if (h.indexOf('::', dbl + 2) !== -1) return null;
    if (dbl > 0) left = h.slice(0, dbl).split(':');
    if (dbl + 2 < h.length) right = h.slice(dbl + 2).split(':');
  } else {
    left = h.split(':');
  }
  const groups = [...left, ...right];
  if (groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const need = 8 - (tail ? 2 : 0);
  const leftNums = left.map(g => parseInt(g, 16));
  const rightNums = right.map(g => parseInt(g, 16));
  if (dbl === -1) {
    if (leftNums.length !== need) return null;
    return tail ? [...leftNums, ...tail] : leftNums;
  }
  const zeros = need - leftNums.length - rightNums.length;
  if (zeros < 1) return null;
  return [...leftNums, ...Array(zeros).fill(0), ...rightNums, ...(tail || [])];
}

// A hostname that looks like an IPv4 literal (numeric/hex dotted parts) but
// failed to parse — block it rather than treating it as a DNS name.
function looksLikeIpv4Literal(h) {
  const parts = h.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every(p => /^(0x[0-9a-f]+|0[0-9]+|[0-9]+)$/i.test(p));
}

export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || /(^|\.)localhost$/.test(h)) return true;
  const v6 = parseIpv6(h);
  if (v6) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms:
    // the embedded IPv4 address decides.
    if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && (v6[5] === 0xffff || v6[5] === 0)) {
      return isPrivateIpv4([(v6[6] >>> 8) & 255, v6[6] & 255, (v6[7] >>> 8) & 255, v6[7] & 255]);
    }
    if (v6.every(x => x === 0)) return true; // ::
    if (v6.slice(0, 7).every(x => x === 0) && v6[7] === 1) return true; // ::1
    if ((v6[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((v6[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((v6[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (v6[0] === 0x2001 && v6[1] === 0x0db8) return true; // 2001:db8::/32 documentation
    return false;
  }
  if (h.includes(':')) return true; // colon but not valid IPv6 — fail closed
  const o = normalizeIpv4(h);
  if (!o) return looksLikeIpv4Literal(h); // not an IP literal — a public DNS name is the caller's risk; redirects re-checked
  return isPrivateIpv4(o);
}

export function isAdUrl(rawUrl, base) {
  try {
    const host = new URL(rawUrl, base).hostname.toLowerCase();
    return AD_HOSTS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

// src= with optional whitespace around = and a quoted or unquoted value:
//   src="..." | src='...' | src=...
// Groups: 1 = double-quoted, 2 = single-quoted, 3 = unquoted.
const SRC_ATTR = String.raw`src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))`;
function srcFromGroups(dq, sq, uq) { return dq || sq || uq || ''; }

export function stripAds(html, base) {
  html = html.replace(new RegExp(`<script\\b[^>]*\\b${SRC_ATTR}[^>]*>\\s*<\\/script>`, 'gi'), (m, dq, sq, uq) => isAdUrl(srcFromGroups(dq, sq, uq), base) ? '' : m);
  html = html.replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => AD_INLINE_RE.test(body) ? '' : m);
  html = html.replace(new RegExp(`<iframe\\b[^>]*\\b${SRC_ATTR}[^>]*>[\\s\\S]*?<\\/iframe>`, 'gi'), (m, dq, sq, uq) => isAdUrl(srcFromGroups(dq, sq, uq), base) ? '' : m);
  html = html.replace(new RegExp(`<iframe\\b[^>]*\\b${SRC_ATTR}[^>]*\\/?>`, 'gi'), (m, dq, sq, uq) => isAdUrl(srcFromGroups(dq, sq, uq), base) ? '' : m);
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

// ---------- bounded fetch ----------
// Bodies are streamed with a hard cap instead of buffered whole: a multi-GB
// response used to OOM the function (arrayBuffer()/text() with no limit).
export const MAX_BODY_BYTES = 15_000_000;
export const MAX_REDIRECTS = 5;

// Read a fetch Response body up to MAX_BODY_BYTES; returns null when the
// body is larger (checked via Content-Length first, then while streaming).
export async function readCappedBody(r) {
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return null;
  const body = r.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > MAX_BODY_BYTES ? null : buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { try { await reader.cancel(); } catch {} return null; }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

// Fetch with redirects followed manually so EVERY hop is checked against the
// SSRF guard before it is requested (fetch's built-in follow only lets the
// final URL be checked, so an intermediate hop to a private host still fired).
async function fetchChecked(startUrl, init, signal) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await fetch(current.toString(), { ...init, redirect: 'manual', signal });
    if (r.status < 300 || r.status >= 400) return r;
    const loc = r.headers.get('location');
    if (!loc) return r;
    if (hop === MAX_REDIRECTS) return null; // too many redirects
    let next;
    try { next = new URL(loc, current); } catch { return null; }
    if (!/^https?:$/.test(next.protocol)) return null;
    if (isPrivateHost(next.hostname)) return 'blocked';
    current = next;
  }
  return null;
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
    const r = await fetchChecked(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, controller.signal);
    clearTimeout(timer);
    if (r === 'blocked') return res.status(400).send('Blocked host');
    if (r === null) return res.status(502).send('Bad redirect');
    const ct = r.headers.get('content-type') || '';
    try { if (isPrivateHost(new URL(r.url).hostname)) return res.status(400).send('Blocked host'); } catch { return res.status(502).send('Bad redirect'); }
    const buf = await readCappedBody(r);
    if (buf === null) return res.status(502).send('Page too large to proxy');
    if (!ct.includes('text/html')) {
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      return res.status(r.status).send(buf);
    }
    const finalUrl = r.url || u.toString();
    let html = stripAds(buf.toString('utf-8'), finalUrl);
    html = injectHead(html, finalUrl);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).send('Could not load that page: ' + String((e && e.message) || e).slice(0, 200));
  }
}
