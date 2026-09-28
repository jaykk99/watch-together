// Vercel serverless function: starts / releases a Browserbase cloud browser (ad blocker on).
// Env vars (Vercel project settings): BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, optional HOST_PIN.
const API = 'https://api.browserbase.com/v1';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.BROWSERBASE_API_KEY;
  const project = process.env.BROWSERBASE_PROJECT_ID;
  if (!key || !project) return res.status(500).json({ error: 'Server is missing BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const pin = process.env.HOST_PIN;
  if (pin && body.pin !== pin) return res.status(401).json({ error: 'pin' });

  const headers = { 'X-BB-API-Key': key, 'Content-Type': 'application/json' };

  try {
    if (body.release && body.id) {
      await fetch(`${API}/sessions/${encodeURIComponent(body.id)}`, {
        method: 'POST', headers, body: JSON.stringify({ projectId: project, status: 'REQUEST_RELEASE' })
      });
      return res.status(200).json({ ok: true });
    }

    const create = await fetch(`${API}/sessions`, {
      method: 'POST', headers,
      body: JSON.stringify({
        projectId: project,
        timeout: 7200,
        browserSettings: { blockAds: true, viewport: { width: 1280, height: 720 } }
      })
    });
    if (!create.ok) return res.status(502).json({ error: 'Browserbase: ' + (await create.text()).slice(0, 200) });
    const s = await create.json();

    const dbg = await fetch(`${API}/sessions/${s.id}/debug`, { headers });
    if (!dbg.ok) return res.status(502).json({ error: 'Could not get live view' });
    const d = await dbg.json();
    const url = d.debuggerFullscreenUrl || (d.pages && d.pages[0] && d.pages[0].debuggerFullscreenUrl);
    if (!url) return res.status(502).json({ error: 'No live view URL returned' });
    return res.status(200).json({ id: s.id, url });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
