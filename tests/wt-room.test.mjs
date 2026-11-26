// Tests for the 2026-11-25 18:53 audit fixes — run: node --test tests/wt-room.test.mjs
// Covers: single-part octal SSRF guard, HTML error-status passthrough,
// unquoted ad/meta attributes in stripAds, subtitle-clear sync, and the
// allocCode probe missing a promoted host (viewer- key, host role in meta).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivateHost, normalizeIpv4, stripAds } from '../api/proxy.js';
import handler from '../api/proxy.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- load assets/wt.js with browser stubs (top-level, runs first) ----------
// wt.js captures `sb` at load, so the fake channel factory is a mutable
// holder the allocCode test below can point at its own presence states.
let channelImpl = () => { throw new Error('no fake channel installed'); };
{
  const store = new Map();
  const fakeSb = {
    channel: (name, opts) => channelImpl(name, opts),
    removeChannel: async () => {},
  };
  globalThis.window = { supabase: { createClient: () => fakeSb } };
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {}, setAttribute() {} }),
    body: { appendChild() {} },
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); },
  };
  // (navigator is only used inside bindFullscreen/copyText, never hit here)
  new Function(fs.readFileSync(path.join(dir, '..', 'assets', 'wt.js'), 'utf8'))();
}
const WT = globalThis.window.WT;

// ---------- Bug 1: single-part leading-zero is octal to the URL parser ----------
// WHATWG: new URL('http://017700000001/').hostname === '127.0.0.1'.
// The old guard parsed the single part as decimal (Number) and missed it.
test('guard: single-part octal 017700000001 is loopback', () => {
  assert.deepEqual(normalizeIpv4('017700000001'), [127, 0, 0, 1]);
  assert.equal(isPrivateHost('017700000001'), true);
});
test('guard: single-part octal maps to the right address', () => {
  // 01234567 octal = 342391 = 0.5.57.119, still in 0.0.0.0/8 (blocked either
  // way before, but the old code checked the WRONG address 0.18.214.135).
  assert.deepEqual(normalizeIpv4('01234567'), [0, 5, 57, 119]);
  assert.equal(isPrivateHost('01234567'), true);
});
test('guard: single-part decimal without leading zero unchanged', () => {
  assert.deepEqual(normalizeIpv4('2130706433'), [127, 0, 0, 1]);
  assert.equal(isPrivateHost('2130706433'), true);
  assert.equal(isPrivateHost('134744072'), false); // 8.8.8.8 decimal
});

// ---------- Bug 2: upstream HTML error status must not be masked as 200 ----------
function fakeResp(status, body, url) {
  return {
    status, url,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  };
}
function mockRes() {
  const r = { headers: {}, statusCode: 0, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}
function mockReq(url, ip) {
  return { method: 'GET', query: { url }, headers: { 'x-forwarded-for': ip }, socket: {} };
}

test('proxy: upstream 404 HTML passes through as 404, not 200', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResp(404, '<html><body>Not found</body></html>', 'https://example.com/missing');
  try {
    const res = mockRes();
    await handler(mockReq('https://example.com/missing', '9.9.9.101'), res);
    assert.equal(res.statusCode, 404);
    assert.ok(String(res.body).includes('<base href="https://example.com/missing'), 'base tag still injected');
  } finally { globalThis.fetch = realFetch; }
});
test('proxy: upstream 500 HTML passes through as 500', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResp(500, '<html><body>boom</body></html>', 'https://example.com/err');
  try {
    const res = mockRes();
    await handler(mockReq('https://example.com/err', '9.9.9.102'), res);
    assert.equal(res.statusCode, 500);
  } finally { globalThis.fetch = realFetch; }
});
test('proxy: upstream 200 HTML still returns 200', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResp(200, '<html><body>hi</body></html>', 'https://example.com/');
  try {
    const res = mockRes();
    await handler(mockReq('https://example.com/', '9.9.9.103'), res);
    assert.equal(res.statusCode, 200);
  } finally { globalThis.fetch = realFetch; }
});

// ---------- Bug 3: unquoted attribute values escape stripAds ----------
test('stripAds: unquoted meta refresh is stripped', () => {
  const out = stripAds('<meta http-equiv=refresh content="0;url=https://evil.com">', 'https://x.com/');
  assert.ok(!out.includes('refresh'), 'unquoted meta refresh removed');
});
test('stripAds: unquoted meta CSP is stripped', () => {
  const out = stripAds('<meta http-equiv=Content-Security-Policy content="default-src \'none\'">', 'https://x.com/');
  assert.ok(!out.includes('Content-Security-Policy'), 'unquoted meta CSP removed');
});
test('stripAds: unquoted adsbygoogle ins is stripped', () => {
  const out = stripAds('<ins class=adsbygoogle style="display:block"></ins>', 'https://x.com/');
  assert.ok(!out.includes('adsbygoogle'), 'unquoted adsbygoogle ins removed');
});
test('stripAds: quoted meta refresh still stripped (regression)', () => {
  const out = stripAds('<meta http-equiv="refresh" content="0;url=https://evil.com">', 'https://x.com/');
  assert.ok(!out.includes('refresh'), 'quoted meta refresh removed');
});
test('stripAds: normal meta tags are kept', () => {
  const out = stripAds('<meta name="viewport" content="width=device-width"><meta charset="utf-8">', 'https://x.com/');
  assert.ok(out.includes('viewport'), 'viewport meta kept');
  assert.ok(out.includes('charset'), 'charset meta kept');
});

// ---------- Bug 4: subtitle-clear decision (pure helper in assets/sync.js) ----------
const syncPath = path.join(dir, '..', 'assets', 'sync.js');
const shimModule = { exports: {} };
new Function('module', 'exports', 'self', fs.readFileSync(syncPath, 'utf8'))(shimModule, shimModule.exports, undefined);
const S = shimModule.exports;

test('subChanged: host clearing subtitles must apply (clear the viewer track)', () => {
  assert.equal(S.subChanged({ url: 'https://x.com/c.vtt' }, null), true);
});
test('subChanged: no subtitles anywhere is a no-op', () => {
  assert.equal(S.subChanged(null, null), false);
  assert.equal(S.subChanged(null, undefined), false);
});
test('subChanged: new subtitles apply, same subtitles do not', () => {
  assert.equal(S.subChanged(null, { url: 'https://x.com/c.vtt' }), true);
  assert.equal(S.subChanged({ url: 'https://x.com/c.vtt' }, { url: 'https://x.com/c.vtt' }), false);
  assert.equal(S.subChanged({ url: 'https://x.com/a.vtt' }, { url: 'https://x.com/b.vtt' }), true);
});

// ---------- Bug 5: allocCode probe must see a promoted host ----------
// A promoted host keeps its original `viewer-...` presence key (Supabase
// presence keys are fixed at channel creation); only its tracked meta role
// becomes 'host'. The old probe checked key prefixes only, so the code
// looked free and a second host could claim the same room.
test('presenceHasHost: promoted host (viewer key, host role) counts', () => {
  assert.equal(WT.presenceHasHost({ 'viewer-abc123': [{ role: 'host', name: 'Host' }] }), true);
});
test('presenceHasHost: original host key counts', () => {
  assert.equal(WT.presenceHasHost({ 'host-abc123': [{ role: 'host', name: 'Host' }] }), true);
});
test('presenceHasHost: viewers only do not count', () => {
  assert.equal(WT.presenceHasHost({ 'viewer-a': [{ role: 'viewer', name: 'A' }], 'viewer-b': [{ role: 'viewer', name: 'B' }] }), false);
  assert.equal(WT.presenceHasHost({}), false);
});

test('allocCode: skips a code whose only host is a promoted host', async () => {
  // Fake Supabase: room-1234 is held by a promoted host, room-5500 is free.
  const presenceByChannel = {
    'room-1234': { 'viewer-abc123': [{ role: 'host', name: 'Host' }] },
    'room-5500': {},
  };
  channelImpl = (name) => {
    let syncCb = null;
    return {
      presenceState: () => presenceByChannel[name] || {},
      on: (_ev, _filter, cb) => { syncCb = cb; },
      subscribe: (cb) => {
        setTimeout(() => { cb('SUBSCRIBED'); if (syncCb) syncCb(); }, 0);
        return undefined;
      },
    };
  };
  // Drive Math.random so allocCode tries 1234 first, then 5500.
  // Per candidate (main HEAD allocCode) it consumes: code rnd, probe key rnd.
  const seq = [0.02605, 0.5, 0.5, 0.5];
  let i = 0;
  const realRandom = Math.random;
  Math.random = () => seq[i++] ?? 0.5;
  try {
    const code = await WT.allocCode('room');
    assert.equal(code, '5500');
  } finally { Math.random = realRandom; }
});
