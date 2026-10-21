// Tests for assets/sync.js — pure sync math. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const syncPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sync.js');
// sync.js is a browser UMD bundle; load it through a CJS shim so tests stay pure-node.
const shimModule = { exports: {} };
new Function('module', 'exports', 'self', fs.readFileSync(syncPath, 'utf8'))(shimModule, shimModule.exports, undefined);
const S = shimModule.exports;

test('projectTarget: paused state returns exact t (no projection)', () => {
  const s = { t: 42.5, at: 1000, paused: true, rate: 1 };
  assert.equal(S.projectTarget(s, 5000), 42.5);
});

test('projectTarget: playing state advances by elapsed * rate', () => {
  const s = { t: 10, at: 1000, paused: false, rate: 1 };
  assert.equal(S.projectTarget(s, 3000), 12); // 2s elapsed
});

test('projectTarget: respects playback rate', () => {
  const s = { t: 10, at: 1000, paused: false, rate: 2 };
  assert.equal(S.projectTarget(s, 2000), 12); // 1s * 2x
});

test('projectTarget: legacy fudge when at is missing', () => {
  const s = { t: 10, paused: false, rate: 1 };
  assert.equal(S.projectTarget(s, 999999), 10.15);
});

test('projectTarget: clamps very stale snapshots at 10s projection', () => {
  const s = { t: 10, at: 0, paused: false, rate: 1 };
  assert.equal(S.projectTarget(s, 3600_000), 20);
});

test('projectTarget: future at (clock skew) does not go backwards', () => {
  const s = { t: 10, at: 5000, paused: false, rate: 1 };
  assert.equal(S.projectTarget(s, 1000), 10);
});

test('correctionDecision: large drift -> hard seek', () => {
  const d = S.correctionDecision(3.1, 1);
  assert.equal(d.action, 'hard');
  assert.equal(d.rate, 1);
  const d2 = S.correctionDecision(-5, 1);
  assert.equal(d2.action, 'hard');
});

test('correctionDecision: boundary at HARD_SEEK_S is not hard', () => {
  assert.equal(S.correctionDecision(2.5, 1).action, 'nudge-down');
});

test('correctionDecision: ahead -> nudge down (slow down)', () => {
  const d = S.correctionDecision(1.2, 1);
  assert.equal(d.action, 'nudge-down');
  assert.ok(Math.abs(d.rate - 0.94) < 1e-9);
});

test('correctionDecision: behind -> nudge up (speed up)', () => {
  const d = S.correctionDecision(-1.2, 1);
  assert.equal(d.action, 'nudge-up');
  assert.ok(Math.abs(d.rate - 1.06) < 1e-9);
});

test('correctionDecision: nudge preserves host base rate', () => {
  const d = S.correctionDecision(-1.2, 1.5);
  assert.ok(Math.abs(d.rate - 1.5 * 1.06) < 1e-9);
});

test('correctionDecision: small drift -> ok', () => {
  const d = S.correctionDecision(0.3, 1);
  assert.equal(d.action, 'ok');
  assert.equal(d.rate, 1);
});

test('correctionDecision: boundary at NUDGE_S is ok', () => {
  assert.equal(S.correctionDecision(0.6, 1).action, 'ok');
  assert.equal(S.correctionDecision(-0.6, 1).action, 'ok');
});

test('snapshot: captures time/at/paused/rate plus extras', () => {
  const fake = { currentTime: 33.3, paused: false, playbackRate: 1 };
  const before = Date.now();
  const s = S.snapshot(fake, { src: 'x.mp4' });
  const after = Date.now();
  assert.equal(s.t, 33.3);
  assert.equal(s.paused, false);
  assert.equal(s.rate, 1);
  assert.equal(s.src, 'x.mp4');
  assert.ok(s.at >= before && s.at <= after);
});

test('snapshot: handles missing playbackRate', () => {
  const s = S.snapshot({ currentTime: 1, paused: true });
  assert.equal(s.rate, 1);
});

test('statusText: paused', () => {
  assert.deepEqual(S.statusText({ action: 'ok', drift: 0 }, true), { cls: '', text: 'paused by host' });
});

test('statusText: in sync shows delta', () => {
  const st = S.statusText({ action: 'ok', drift: 0.25 }, false);
  assert.equal(st.cls, 'ok');
  assert.equal(st.text, 'in sync · Δ0.3s');
});

test('statusText: catching up shows delta', () => {
  const st = S.statusText({ action: 'nudge-up', drift: -1.22 }, false);
  assert.equal(st.cls, '');
  assert.equal(st.text, 'catching up · Δ1.2s');
});

test('round trip: project then correct converges', () => {
  // Host at t=100 playing; viewer 1s behind -> nudge-up; viewer 5s ahead -> hard.
  const host = { t: 100, at: 1000, paused: false, rate: 1 };
  const target = S.projectTarget(host, 1000); // exactly 100
  assert.equal(target, 100);
  assert.equal(S.correctionDecision(99 - target, 1).action, 'nudge-up');
  assert.equal(S.correctionDecision(105 - target, 1).action, 'hard');
  assert.equal(S.correctionDecision(100.2 - target, 1).action, 'ok');
});
