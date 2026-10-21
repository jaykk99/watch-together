/* Watch Together sync math — pure functions, no DOM. Tested by tests/sync.test.mjs.
 *
 * The host broadcasts state snapshots {t, at, paused, rate, src, ...} where
 * `t` is the host's video time at wall-clock `at` (Date.now() ms). Viewers
 * project where the host is NOW and correct their own drift:
 *   - |drift| > HARD_SEEK_S  -> hard seek to target
 *   - |drift| > NUDGE_S      -> nudge playbackRate up/down to converge
 *   - otherwise              -> in sync
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.WTSync = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var HARD_SEEK_S = 2.5;   // beyond this, hard-seek (was the old magic number)
  var NUDGE_S = 0.6;       // beyond this, playback-rate nudge
  var NUDGE_RATE = 0.06;   // +/-6% playback rate nudge

  // Where is the host's video now, given a snapshot taken at `state.at`?
  // Falls back to the legacy fixed fudge when `at` is missing.
  function projectTarget(state, nowMs) {
    var t = Number(state.t) || 0;
    if (state.paused) return t;
    var rate = Number(state.rate) || 1;
    if (typeof state.at === 'number' && isFinite(state.at)) {
      var elapsed = Math.max(0, (nowMs - state.at) / 1000);
      // Clamp: a very stale snapshot should not project absurdly far ahead.
      if (elapsed > 10) elapsed = 10;
      return t + elapsed * rate;
    }
    return t + 0.15; // legacy: half-RTT estimate
  }

  // Decide what a viewer should do about `drift = myTime - target`.
  // Returns { action: 'hard' | 'nudge-down' | 'nudge-up' | 'ok', rate, drift }.
  function correctionDecision(drift, baseRate) {
    baseRate = Number(baseRate) || 1;
    var ad = Math.abs(drift);
    if (ad > HARD_SEEK_S) return { action: 'hard', rate: baseRate, drift: drift };
    if (ad > NUDGE_S) {
      return drift > 0
        ? { action: 'nudge-down', rate: baseRate * (1 - NUDGE_RATE), drift: drift }
        : { action: 'nudge-up', rate: baseRate * (1 + NUDGE_RATE), drift: drift };
    }
    return { action: 'ok', rate: baseRate, drift: drift };
  }

  // Build a host snapshot. `video` is an HTMLVideoElement (or a stub in tests).
  function snapshot(video, extra) {
    var s = {
      t: video.currentTime || 0,
      at: Date.now(),
      paused: !!video.paused,
      rate: video.playbackRate || 1,
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) s[k] = extra[k];
      }
    }
    return s;
  }

  // Human-readable sync status for the UI pill.
  function statusText(decision, paused) {
    if (paused) return { cls: '', text: 'paused by host' };
    var ad = Math.abs(decision.drift).toFixed(1);
    if (decision.action === 'ok') return { cls: 'ok', text: 'in sync · Δ' + ad + 's' };
    if (decision.action === 'hard' || decision.action.indexOf('nudge') === 0)
      return { cls: '', text: 'catching up · Δ' + ad + 's' };
    return { cls: '', text: 'syncing…' };
  }

  return {
    HARD_SEEK_S: HARD_SEEK_S,
    NUDGE_S: NUDGE_S,
    NUDGE_RATE: NUDGE_RATE,
    projectTarget: projectTarget,
    correctionDecision: correctionDecision,
    snapshot: snapshot,
    statusText: statusText,
  };
});
