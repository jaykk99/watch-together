// Tests for functions/api/proxy.js (Pages Function port of api/proxy.js).
// Run: node --test tests/pages-proxy.test.mjs  (or npm test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/proxy.js';

let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`; // TEST-NET-3, public per isPrivateHost

const req = (url, { method = 'GET', ip = freshIp() } = {}) =>
  new Request(url, { method, headers: { 'cf-connecting-ip': ip } });

function stubFetch(response) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => response;
  return () => {
    globalThis.fetch = orig;
  };
}

function fakeResponse({ url = 'https://example.com/page', status = 200, contentType = 'text/html; charset=utf-8', body = '<html><head></head><body>hi</body></html>' } = {}) {
  return {
    url,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

test('non-GET returns 405 with Allow: GET', async () => {
  const res = await onRequest({ request: req('https://wt.pages.dev/api/proxy?url=https://example.com/', { method: 'POST' }), env: {} });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET');
});

test('missing url returns 400', async () => {
  const res = await onRequest({ request: req('https://wt.pages.dev/api/proxy'), env: {} });
  assert.equal(res.status, 400);
});

test('private host is blocked before any fetch', async () => {
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error('should not fetch'); };
  try {
    const res = await onRequest({ request: req('https://wt.pages.dev/api/proxy?url=http://127.0.0.1/'), env: {} });
    assert.equal(res.status, 400);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('redirect landing on a private host is blocked', async () => {
  const restore = stubFetch(fakeResponse({ url: 'http://169.254.169.254/latest/meta-data/' }));
  try {
    const res = await onRequest({ request: req('https://wt.pages.dev/api/proxy?url=https://example.com/'), env: {} });
    assert.equal(res.status, 400);
  } finally {
    restore();
  }
});

test('HTML is ad-stripped and gets a base tag', async () => {
  const restore = stubFetch(fakeResponse({
    body: '<html><head></head><body><script src="https://pagead2.googlesyndication.com/x.js"></script><p>ok</p></body></html>',
  }));
  try {
    const res = await onRequest({ request: req('https://wt.pages.dev/api/proxy?url=https://example.com/page'), env: {} });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /text\/html/);
    const html = await res.text();
    assert.ok(!html.includes('googlesyndication'), 'ad script removed');
    assert.ok(html.includes('<base href="https://example.com/page">'), 'base tag injected');
    assert.ok(html.includes('<p>ok</p>'), 'content kept');
  } finally {
    restore();
  }
});

test('non-HTML passes through with its content type', async () => {
  const restore = stubFetch(fakeResponse({ contentType: 'image/png', body: 'PNGDATA' }));
  try {
    const res = await onRequest({ request: req('https://wt.pages.dev/api/proxy?url=https://example.com/a.png'), env: {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/png');
    assert.equal(await res.text(), 'PNGDATA');
  } finally {
    restore();
  }
});

test('rate limit: 61st request from one IP is 429', async () => {
  const ip = freshIp();
  const restore = stubFetch(fakeResponse());
  try {
    let last;
    for (let i = 0; i < 61; i++) {
      last = await onRequest({ request: req('https://wt.pages.dev/api/proxy?url=https://example.com/', { ip }), env: {} });
    }
    assert.equal(last.status, 429);
    assert.equal(last.headers.get('Retry-After'), '30');
  } finally {
    restore();
  }
});

test('upstream failure is an honest 502', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom'); };
  try {
    const res = await onRequest({ request: req('https://wt.pages.dev/api/proxy?url=https://example.com/'), env: {} });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Could not load that page/);
  } finally {
    globalThis.fetch = orig;
  }
});
