// Vercel serverless function: fetches a page server-side, strips common ad/tracker
// tags and popup redirects, and serves it back same-origin so it can be embedded
// (bypassing X-Frame-Options / frame-ancestors) and so the client can sandbox it.
// This is a lightweight filter, not a full ad blocker — see README "Known limits".

const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googletagservices.com', 'adnxs.com',
  'amazon-adsystem.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'media.net', 'propellerads.com', 'popads.net',
  'popcash.net', 'adskeeper.com', 'mgid.com', 'revcontent.com', 'exoclick.com',
  'juicyads.com', 'trafficjunky.net', 'adsterra.com', 'adform.net', 'bidswitch.net',
  'yieldmo.com', 'smartadserver.com', 'adcolony.com', 'moatads.com', 'scorecardresearch.com',
];
const AD_INLINE_RE = /adsbygoogle\.push|propellerads|exoclick|popads|popcash|juicyads|trafficjunky|adsterra|window\.open\(\s*['"]https?:\/\//i;
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return true; // IPv6 unique-local / link-local
  return false;
}

function isAdUrl(rawUrl, base) {
  try {
    const host = new URL(rawUrl, base).hostname.toLowerCase();
    return AD_HOSTS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

function stripAds(html, base) {
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).send('GET only');

  const target = req.query.url;
  if (!target || typeof target !== 'string') return res.status(400).send('Missing url');
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
      },
    });
    clearTimeout(timer);
    const ct = r.headers.get('content-type') || '';
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
