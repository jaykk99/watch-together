// Vercel serverless function: drives the Browserbase cloud browser (navigate + video controls).
// Env vars: BROWSERBASE_API_KEY, optional HOST_PIN.
import { chromium } from 'playwright-core';

function videoCmd({ cmd, value }) {
  const vs = Array.from(document.querySelectorAll('video'));
  if (!vs.length) return null;
  vs.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  const v = vs[0];
  const play = () => v.play().catch(() => { v.muted = true; return v.play(); });
  return (async () => {
    if (cmd === 'toggle') { if (v.paused) await play(); else v.pause(); }
    else if (cmd === 'play') await play();
    else if (cmd === 'pause') v.pause();
    else if (cmd === 'seek') v.currentTime = Math.max(0, v.currentTime + Number(value || 0));
    else if (cmd === 'volume') { v.muted = false; v.volume = Math.min(1, Math.max(0, Number(value))); }
    return { t: v.currentTime, d: v.duration || 0, paused: v.paused, vol: v.volume };
  })();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.BROWSERBASE_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing BROWSERBASE_API_KEY' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const pin = process.env.HOST_PIN;
  if (pin && body.pin !== pin) return res.status(401).json({ error: 'pin' });
  if (!body.id || !/^[\w-]+$/.test(body.id)) return res.status(400).json({ error: 'bad session id' });

  let browser;
  try {
    browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${key}&sessionId=${body.id}`);
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    const page = pages[pages.length - 1] || await ctx.newPage();

    if (body.action === 'goto') {
      let url = String(body.url || '').trim();
      if (!url) return res.status(400).json({ error: 'no url' });
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return res.status(200).json({ ok: true, url: page.url() });
    }

    if (body.action === 'video') {
      for (const frame of page.frames()) {
        try {
          const r = await frame.evaluate(videoCmd, { cmd: body.cmd, value: body.value });
          if (r) return res.status(200).json({ ok: true, state: r });
        } catch (_) { /* frame gone or cross-context, try next */ }
      }
      return res.status(200).json({ ok: false, error: 'No video found on this page. Open the movie page and press its play button in Browse mode first.' });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}
