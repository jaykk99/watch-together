/**
 * Pages Function: watch-together proxy (moved from api/proxy.js, Vercel).
 * Same behaviour, Workers runtime: fetches a page server-side, strips
 * common ad/tracker tags and popup redirects, serves it back same-origin
 * so it can be embedded in the sandboxed iframe. No secrets, no env vars.
 *
 * Guardrails live in api/proxy.js (shared pure helpers): SSRF blocking of
 * private/loopback/link-local/reserved hosts in every IP encoding, final
 * URL re-checked after redirects, 60 req/min per client IP -> 429.
 */

import { isPrivateHost, stripAds, injectHead, rateLimitCheck } from '../../api/proxy.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 15_000_000;

function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const fwd = request.headers.get('x-forwarded-for');
  const first = String(fwd || '').split(',')[0].trim();
  return first || 'unknown';
}

function text(body, status, extraHeaders) {
  return new Response(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(extraHeaders || {}),
    },
  });
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== 'GET') {
    return text('GET only', 405, { Allow: 'GET' });
  }
  if (!rateLimitCheck(clientIp(request))) {
    return text('Too many requests — slow down and try again in a bit.', 429, {
      'Retry-After': '30',
    });
  }

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return text('Missing url', 400);
  if (target.length > 2048) return text('URL too long', 400);
  let u;
  try {
    u = new URL(target);
  } catch {
    return text('Bad url', 400);
  }
  if (!/^https?:$/.test(u.protocol)) return text('Only http/https allowed', 400);
  if (isPrivateHost(u.hostname)) return text('Blocked host', 400);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);
    const ct = r.headers.get('content-type') || '';
    let finalHost;
    try {
      finalHost = new URL(r.url).hostname;
    } catch {
      return text('Bad redirect', 502);
    }
    if (isPrivateHost(finalHost)) return text('Blocked host', 400);
    if (!ct.includes('text/html')) {
      const buf = await r.arrayBuffer();
      return new Response(buf, {
        status: r.status,
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Type': ct || 'application/octet-stream',
        },
      });
    }
    let html = await r.text();
    if (html.length > MAX_HTML_BYTES) return text('Page too large to proxy', 502);
    const finalUrl = r.url || u.toString();
    html = injectHead(stripAds(html, finalUrl), finalUrl);
    return text(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  } catch (e) {
    clearTimeout(timer);
    return text(
      'Could not load that page: ' + String((e && e.message) || e).slice(0, 200),
      502
    );
  }
}
