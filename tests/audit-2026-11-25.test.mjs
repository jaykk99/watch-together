// Audit tests 2026-11-25 — fixes for the Nov 24 read-only audit findings:
//   1. SSRF bypass via IPv4-mapped / expanded IPv6 forms
//   2. Unbounded response-body buffering (DoS)
//   3. Redirect hops to private hosts were requested, only the final URL checked
//   4. Octal mis-parse in numFromPart ('08' -> 0)
//   5. stripAds missed spaced / unquoted src attributes
// Run: node tests/audit-2026-11-25.test.mjs (also wired into npm test)
import assert from 'node:assert/strict';
import { isPrivateHost, normalizeIpv4, parseIpv6, stripAds, readCappedBody, MAX_BODY_BYTES, MAX_REDIRECTS } from '../api/proxy.js';
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

// --- 1. IPv6 SSRF: mapped / expanded / range forms must block ---
const v6blocked = [
  '::ffff:127.0.0.1', '::ffff:0a00:0001', '::ffff:a9fe:a9fe', // mapped dotted + hex
  '0:0:0:0:0:ffff:7f00:1', '::ffff:7f00:1', '::ffff:7f00:0001',
  '::127.0.0.1', // IPv4-compatible form
  '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', // expanded ::1 / ::
  'febf::1', 'fe81::1', 'fe80::1', // fe80::/10, not just fe80: exactly
  'fc00::1', 'fdff::1', // fc00::/7
  'ff02::1', 'ff00::1', // ff00::/8 multicast
  '2001:db8::1', // documentation
  '[::ffff:127.0.0.1]', // brackets, as URL.hostname yields them
];
for (const h of v6blocked) t(`blocks ${h}`, () => assert.equal(isPrivateHost(h), true));
for (const h of ['::ffff:0808:0808', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888', '8.8.8.8', 'example.com']) {
  t(`allows ${h}`, () => assert.equal(isPrivateHost(h), false));
}
t('parseIpv6 expands ::ffff:127.0.0.1', () => assert.deepEqual(parseIpv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]));
t('parseIpv6 expands 0:0:0:0:0:0:0:1', () => assert.deepEqual(parseIpv6('0:0:0:0:0:0:0:1'), [0, 0, 0, 0, 0, 0, 0, 1]));
t('parseIpv6 rejects double ::', () => assert.equal(parseIpv6('1::2::3'), null));
t('parseIpv6 rejects non-IPv6 hostname', () => assert.equal(parseIpv6('example.com'), null));

// --- 4. octal mis-parse: invalid octal digits fail closed ---
t('numFromPart: 08 is not silently 0', () => assert.equal(normalizeIpv4('08.0.0.1'), null));
t('blocks 08.0.0.1 (fail closed)', () => assert.equal(isPrivateHost('08.0.0.1'), true));
t('blocks 09.1.2.3 (fail closed)', () => assert.equal(isPrivateHost('09.1.2.3'), true));
t('blocks 999.999.999.999 (fail closed)', () => assert.equal(isPrivateHost('999.999.999.999'), true));
t('valid octal still works', () => assert.deepEqual(normalizeIpv4('0177.0.0.1'), [127, 0, 0, 1]));

// --- 5. stripAds: spaced / unquoted src ---
t('strips ad script with spaced src', () => {
  const out = stripAds('<script src = "https://pagead2.googlesyndication.com/x.js"></scr' + 'ipt>', 'https://x.com/');
  assert.ok(!out.includes('googlesyndication'), 'spaced ad src removed');
});
t('strips ad script with unquoted src', () => {
  const out = stripAds('<script src=https://pagead2.googlesyndication.com/x.js></scr' + 'ipt>', 'https://x.com/');
  assert.ok(!out.includes('googlesyndication'), 'unquoted ad src removed');
});
t('keeps normal script with spaced/unquoted src', () => {
  const out = stripAds('<script src = "/app.js"></scr' + 'ipt><script src=/lib.js></scr' + 'ipt>', 'https://x.com/');
  assert.ok(out.includes('/app.js') && out.includes('/lib.js'), 'normal scripts kept');
});
t('strips ad iframe with unquoted src', () => {
  const out = stripAds('<iframe src=https://ads.adnxs.com/a.html></iframe>', 'https://x.com/');
  assert.ok(!out.includes('adnxs'), 'unquoted ad iframe removed');
});

// --- 2. readCappedBody ---
function streamResp(bodyText, contentType, contentLength) {
  const enc = new TextEncoder();
  const data = enc.encode(bodyText);
  const stream = new ReadableStream({
    start(c) { c.enqueue(data); c.close(); },
  });
  return {
    status: 200,
    url: 'https://example.com/',
    headers: new Headers({ 'content-type': contentType, ...(contentLength !== undefined ? { 'content-length': String(contentLength) } : {}) }),
    body: stream,
  };
}
await ta('readCappedBody returns small body', async () => {
  const buf = await readCappedBody(streamResp('hello', 'text/html'));
  assert.equal(buf.toString('utf-8'), 'hello');
});
await ta('readCappedBody rejects oversized Content-Length without reading', async () => {
  const buf = await readCappedBody(streamResp('tiny', 'text/html', MAX_BODY_BYTES + 1));
  assert.equal(buf, null);
});
await ta('readCappedBody aborts a stream past the cap', async () => {
  const big = 'x'.repeat(MAX_BODY_BYTES + 100);
  const buf = await readCappedBody(streamResp(big, 'application/octet-stream'));
  assert.equal(buf, null);
});

// --- handler with stubbed fetch ---
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
function stubFetch(impl) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return impl(String(url), init); };
  return { calls, restore() { globalThis.fetch = orig; } };
}
function htmlResp(url, html) {
  const enc = new TextEncoder();
  const data = enc.encode(html);
  return {
    status: 200, url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8', 'content-length': String(data.length) }),
    body: new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }),
  };
}

await ta('redirect hop to private host -> 400 and never fetched', async () => {
  const s = stubFetch(async (url) => {
    if (url === 'https://public.example/start') {
      return { status: 302, url, headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }), body: null };
    }
    throw new Error('should not fetch ' + url);
  });
  try {
    const res = mockRes();
    await handler(mockReq('GET', { url: 'https://public.example/start' }, '9.9.9.21'), res);
    assert.equal(res.statusCode, 400);
    assert.match(String(res.body), /Blocked host/);
    assert.equal(s.calls.length, 1, 'private hop never requested');
  } finally { s.restore(); }
});

await ta('redirect hop to public host followed, 200 with base tag', async () => {
  const s = stubFetch(async (url) => {
    if (url === 'https://public.example/start') {
      return { status: 302, url, headers: new Headers({ location: '/page' }), body: null };
    }
    if (url === 'https://public.example/page') return htmlResp(url, '<html><head></head><body>hi</body></html>');
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const res = mockRes();
    await handler(mockReq('GET', { url: 'https://public.example/start' }, '9.9.9.22'), res);
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.body).includes('<base href="https://public.example/page"'), 'base tag points at final URL');
    assert.equal(s.calls.length, 2);
  } finally { s.restore(); }
});

await ta('redirect loop -> 502 after max hops', async () => {
  let n = 0;
  const s = stubFetch(async (url) => {
    n++;
    return { status: 302, url, headers: new Headers({ location: 'https://public.example/hop' + n }), body: null };
  });
  try {
    const res = mockRes();
    await handler(mockReq('GET', { url: 'https://public.example/start' }, '9.9.9.23'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(s.calls.length, MAX_REDIRECTS + 1);
  } finally { s.restore(); }
});

await ta('oversized non-HTML body -> 502, never buffered', async () => {
  const s = stubFetch(async (url) => ({
    status: 200, url,
    headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': String(MAX_BODY_BYTES + 1) }),
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('tiny')); c.close(); } }),
  }));
  try {
    const res = mockRes();
    await handler(mockReq('GET', { url: 'https://public.example/big.bin' }, '9.9.9.24'), res);
    assert.equal(res.statusCode, 502);
    assert.match(String(res.body), /too large/);
  } finally { s.restore(); }
});

await ta('small HTML still proxies 200', async () => {
  const s = stubFetch(async (url) => htmlResp(url, '<html><head></head><body>ok</body></html>'));
  try {
    const res = mockRes();
    await handler(mockReq('GET', { url: 'https://public.example/' }, '9.9.9.25'), res);
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.body).includes('ok'));
  } finally { s.restore(); }
});

console.log(`\n${pass} tests passed${process.exitCode ? ' (with failures)' : ''}`);
