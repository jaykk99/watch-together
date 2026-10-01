// Tests for api/proxy.js — run: node tests/proxy.test.mjs
import assert from 'node:assert/strict';
import { isPrivateHost, normalizeIpv4, isAdUrl, stripAds, rateLimitCheck, RATE_MAX } from '../api/proxy.js';
import handler from '../api/proxy.js';

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok  -', name); }
  catch (e) { console.error('FAIL-', name, '\n     ', e.message); process.exitCode = 1; }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('ok  -', name); }
  catch (e) { console.error('FAIL-', name, '\n     ', e.message); process.exitCode = 1; }
}

// --- SSRF host checks ---
const blocked = [
  '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0x7F.0.0.1', '0177.0.0.1',
  '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254',
  '0.0.0.0', '224.0.0.1', '240.0.0.1', '100.64.0.1', '192.0.2.1', '198.51.100.7',
  '203.0.113.9', '198.18.0.1', 'localhost', 'LOCALHOST', 'foo.localhost', '::1', '[::1]',
  '0x0a000001', '3232235777', // 10.0.0.1 and 192.168.1.1 as decimals
];
const allowed = ['8.8.8.8', '1.1.1.1', 'example.com', '93.184.216.34'];
for (const h of blocked) t(`blocks ${h}`, () => assert.equal(isPrivateHost(h), true));
for (const h of allowed) t(`allows ${h}`, () => assert.equal(isPrivateHost(h), false));
t('normalizeIpv4 dotted', () => assert.deepEqual(normalizeIpv4('127.0.0.1'), [127, 0, 0, 1]));
t('normalizeIpv4 decimal', () => assert.deepEqual(normalizeIpv4('2130706433'), [127, 0, 0, 1]));
t('normalizeIpv4 hex', () => assert.deepEqual(normalizeIpv4('0x7f000001'), [127, 0, 0, 1]));
t('normalizeIpv4 octal', () => assert.deepEqual(normalizeIpv4('0177.0.0.1'), [127, 0, 0, 1]));
t('normalizeIpv4 short form', () => assert.deepEqual(normalizeIpv4('127.1'), [127, 0, 0, 1]));
t('normalizeIpv4 rejects junk', () => assert.equal(normalizeIpv4('example.com'), null));

// --- ad stripping ---
t('strips ad script src', () => {
  const out = stripAds('<script src="https://pagead2.googlesyndication.com/x.js"></scr' + 'ipt><script src="/app.js"></scr' + 'ipt>', 'https://x.com/');
  assert.ok(!out.includes('googlesyndication'), 'ad script removed');
  assert.ok(out.includes('/app.js'), 'normal script kept');
});
t('strips inline ad loaders', () => {
  const out = stripAds('<script>(adsbygoogle=window.adsbygoogle||[]).push({})</scr' + 'ipt>', 'https://x.com/');
  assert.ok(!out.includes('adsbygoogle'), 'inline ad code removed');
});
t('strips meta refresh', () => {
  const out = stripAds('<meta http-equiv="refresh" content="0;url=https://evil.com">', 'https://x.com/');
  assert.ok(!out.includes('refresh'), 'meta refresh removed');
});
t('isAdUrl matches ad hosts', () => {
  assert.equal(isAdUrl('https://ads.adnxs.com/a.js', 'https://x.com/'), true);
  assert.equal(isAdUrl('https://cdn.example.com/a.js', 'https://x.com/'), false);
});

// --- handler behavior with mocked req/res ---
function mockReq(method, query, ip) {
  return { method, query, headers: { 'x-forwarded-for': ip || '9.9.9.9' }, socket: {} };
}
function mockRes() {
  const r = { headers: {}, statusCode: 0, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

await ta('POST -> 405 with Allow: GET', async () => {
  const res = mockRes();
  await handler(mockReq('POST', {}, '9.9.9.10'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['allow'], 'GET');
});

await ta('missing url -> 400', async () => {
  const res = mockRes();
  await handler(mockReq('GET', {}, '9.9.9.11'), res);
  assert.equal(res.statusCode, 400);
});

await ta('SSRF decimal-encoded loopback -> 400', async () => {
  const res = mockRes();
  await handler(mockReq('GET', { url: 'http://2130706433/admin' }, '9.9.9.12'), res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /Blocked host/);
});

await ta('non-http scheme -> 400', async () => {
  const res = mockRes();
  await handler(mockReq('GET', { url: 'file:///etc/passwd' }, '9.9.9.13'), res);
  assert.equal(res.statusCode, 400);
});

await ta('rate limit: 60 ok, 61st -> 429', async () => {
  const ip = '9.9.9.14';
  let last = null;
  for (let i = 0; i < RATE_MAX + 1; i++) {
    const res = mockRes();
    await handler(mockReq('GET', {}, ip), res);
    last = res;
  }
  assert.equal(last.statusCode, 429);
  assert.ok(last.headers['retry-after'], 'Retry-After header set');
});

await ta('rateLimitCheck is per-IP', async () => {
  for (let i = 0; i < RATE_MAX; i++) assert.equal(rateLimitCheck('10.99.0.1'), true);
  assert.equal(rateLimitCheck('10.99.0.1'), false);
  assert.equal(rateLimitCheck('10.99.0.2'), true, 'different IP unaffected');
});

await ta('live fetch example.com -> 200 html', async () => {
  const res = mockRes();
  await handler(mockReq('GET', { url: 'https://example.com/' }, '9.9.9.15'), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(String(res.body).includes('<base href="https://example.com/'), 'base tag injected');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

console.log(`\n${pass} tests passed${process.exitCode ? ' (with failures)' : ''}`);
