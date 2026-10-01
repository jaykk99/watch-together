/* Watch Together shared room kit: Supabase realtime, codes, names, chat, roster, reactions. */
(function () {
  'use strict';
  var SB_URL = 'https://fhbqxujlnqlmzvulrdxt.supabase.co';
  var SB_KEY = 'sb_publishable_adcZmpDjIVXM1qB5UYS-Dg_iZeGh2uT';
  var sb = window.supabase.createClient(SB_URL, SB_KEY, { realtime: { params: { eventsPerSecond: 25 } } });

  function $(id) { return document.getElementById(id); }
  function rnd(n) { return Math.floor(Math.random() * n); }

  var AV_COLORS = ['#7c5cff', '#2ec4b6', '#ff8c42', '#ff5c7a', '#4da3ff', '#b15cff', '#2ecc71', '#ffb020'];
  function colorFor(name) {
    var h = 0, s = String(name || '?');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AV_COLORS[h % AV_COLORS.length];
  }

  // ---------- toasts ----------
  function toast(msg, kind) {
    var box = $('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 400); }, 2600);
  }

  // ---------- display name ----------
  function getName() { return (localStorage.getItem('wt-name') || '').trim(); }
  function setName(n) { localStorage.setItem('wt-name', String(n || '').trim().slice(0, 24)); }
  function displayName() { return getName() || ('Guest-' + (1000 + rnd(9000))); }

  // ---------- room codes ----------
  function isHostKey(k) { return k.indexOf('host-') === 0; }
  async function allocCode(prefix) {
    for (var i = 0; i < 10; i++) {
      var c = String(1000 + rnd(9000));
      var probe = sb.channel(prefix + '-' + c, { config: { presence: { key: 'probe-' + Math.random().toString(36).slice(2) } } });
      var taken = await new Promise(function (res) {
        var done = false;
        function finish(v) { if (!done) { done = true; res(v); } }
        function check() { var s = probe.presenceState(); finish(Object.keys(s).some(isHostKey)); }
        probe.on('presence', { event: 'sync' }, check);
        probe.subscribe(function (st) {
          if (st === 'SUBSCRIBED') setTimeout(check, 700);
          else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') finish(true);
        });
      });
      await sb.removeChannel(probe);
      if (!taken) return c;
    }
    throw new Error('no free code');
  }

  // ---------- room session ----------
  // handlers: onState(payload) | onHello() | onPresence(peers) | onChat(msg) | onReact(r) | onPeerJoin(peer) | onPeerLeave(peer)
  // Resolves once SUBSCRIBED + presence tracked; rejects on channel error/timeout.
  function openRoomStrict(opts) {
    var prefix = opts.prefix, code = opts.code, role = opts.role, h = opts.handlers || {};
    var name = displayName();
    var myKey = role + '-' + Math.random().toString(36).slice(2, 9);
    var ch = sb.channel(prefix + '-' + code, { config: { broadcast: { self: false }, presence: { key: myKey } } });
    var known = {};
    var session;
    function peers() {
      var st = ch ? ch.presenceState() : {}, out = [];
      Object.keys(st).forEach(function (k) {
        var meta = (st[k] && st[k][0]) || {};
        out.push({ key: k, role: meta.role || (isHostKey(k) ? 'host' : 'viewer'), name: meta.name || 'Guest', self: k === myKey });
      });
      out.sort(function (a, b) {
        if (a.role !== b.role) return a.role === 'host' ? -1 : 1;
        return a.self ? -1 : b.self ? 1 : 0;
      });
      return out;
    }
    function syncPresence() {
      var list = peers();
      var map = {};
      list.forEach(function (p) { map[p.key] = p; });
      list.forEach(function (p) { if (!p.self && !known[p.key] && h.onPeerJoin) h.onPeerJoin(p); });
      Object.keys(known).forEach(function (k) { if (!map[k] && h.onPeerLeave) h.onPeerLeave(known[k]); });
      known = map;
      if (h.onPresence) h.onPresence(list);
    }
    ch.on('broadcast', { event: 'state' }, function (m) { if (h.onState) h.onState(m.payload); });
    ch.on('broadcast', { event: 'hello' }, function () { if (h.onHello) h.onHello(); });
    ch.on('broadcast', { event: 'chat' }, function (m) { if (h.onChat) h.onChat(m.payload); });
    ch.on('broadcast', { event: 'react' }, function (m) { if (h.onReact) h.onReact(m.payload); });
    ch.on('presence', { event: 'sync' }, syncPresence);
    ch.on('presence', { event: 'join' }, syncPresence);
    ch.on('presence', { event: 'leave' }, syncPresence);
    session = {
      channel: ch, code: code, role: role, name: name,
      send: function (event, payload) { if (ch) ch.send({ type: 'broadcast', event: event, payload: payload || {} }); },
      peers: peers,
      leave: async function () { if (ch) { await sb.removeChannel(ch); ch = null; } },
    };
    return new Promise(function (res, rej) {
      ch.subscribe(function (st) {
        if (st === 'SUBSCRIBED') {
          ch.track({ role: role, name: name }).then(function () { syncPresence(); res(session); }).catch(rej);
        } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') rej(new Error('connect'));
      });
    });
  }

  // ---------- chat + roster UI helpers ----------
  function fmtTime(ts) {
    var d = new Date(ts), h = d.getHours(), m = ('0' + d.getMinutes()).slice(-2);
    var ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    return h + ':' + m + ap;
  }
  function addChat(listEl, emptyEl, msg, meName) {
    if (emptyEl) emptyEl.classList.add('hide');
    var li = document.createElement('li');
    var me = msg.from === meName;
    if (me) li.className = 'me';
    var who = document.createElement('span'); who.className = 'who';
    who.textContent = me ? 'You' : msg.from;
    var ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = fmtTime(msg.ts || Date.now());
    who.appendChild(ts);
    var body = document.createElement('div'); body.textContent = String(msg.text || '').slice(0, 500);
    li.appendChild(who); li.appendChild(body);
    listEl.appendChild(li);
    while (listEl.children.length > 80) listEl.removeChild(listEl.firstChild);
    listEl.scrollTop = listEl.scrollHeight;
  }
  function renderRoster(listEl, countEl, peersList) {
    listEl.innerHTML = '';
    peersList.forEach(function (p) {
      var li = document.createElement('li');
      var av = document.createElement('span'); av.className = 'avatar';
      av.style.background = colorFor(p.name);
      av.textContent = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      var nm = document.createElement('span'); nm.textContent = p.self ? p.name + ' (you)' : p.name;
      li.appendChild(av); li.appendChild(nm);
      if (p.role === 'host') { var tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'HOST'; li.appendChild(tag); }
      listEl.appendChild(li);
    });
    if (countEl) countEl.textContent = peersList.length ? '(' + peersList.length + ')' : '';
  }
  function bindChat(session, listEl, emptyEl, inputEl, sendBtn) {
    function send() {
      var text = inputEl.value.trim();
      if (!text) return;
      var msg = { from: session.name, text: text.slice(0, 500), ts: Date.now() };
      session.send('chat', msg);
      addChat(listEl, emptyEl, msg, session.name);
      inputEl.value = '';
    }
    sendBtn.onclick = send;
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
  }
  function floatReact(stageEl, emoji) {
    var s = document.createElement('div');
    s.className = 'freact'; s.textContent = emoji;
    s.style.left = (8 + rnd(80)) + '%'; s.style.top = '55%';
    stageEl.appendChild(s);
    setTimeout(function () { s.remove(); }, 1700);
  }
  function bindReacts(session, stageEl, container) {
    var EMOJIS = ['😂', '❤️', '😮', '👏', '🔥'];
    EMOJIS.forEach(function (e) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = e;
      b.setAttribute('aria-label', 'react ' + e);
      b.onclick = function () { session.send('react', { from: session.name, emoji: e }); floatReact(stageEl, e); };
      container.appendChild(b);
    });
  }

  // ---------- misc ----------
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(function () { return true; }).catch(function () { return fallback(); });
    }
    return Promise.resolve(fallback());
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e) { return false; }
    }
  }
  function inviteLink(code) { return location.origin + location.pathname + '?room=' + code; }
  function prefillFromQuery(inputEl) {
    try {
      var m = new URLSearchParams(location.search).get('room');
      if (m && /^\d{4}$/.test(m)) { inputEl.value = m; return true; }
    } catch (e) {}
    return false;
  }
  function bindFullscreen(btn, stageEl, videoEl) {
    function isFs() { return document.fullscreenElement || document.webkitFullscreenElement; }
    btn.onclick = async function () {
      if (!isFs()) {
        if (videoEl && videoEl.webkitEnterFullscreen && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
          try { videoEl.webkitEnterFullscreen(); return; } catch (e) {}
        }
        try { await (stageEl.requestFullscreen ? stageEl.requestFullscreen() : stageEl.webkitRequestFullscreen()); } catch (e) { return; }
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {});
      } else {
        if (screen.orientation && screen.orientation.unlock) try { screen.orientation.unlock(); } catch (e) {}
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
    };
  }

  window.WT = {
    sb: sb, $: $, toast: toast,
    getName: getName, setName: setName, displayName: displayName,
    allocCode: allocCode, openRoom: openRoomStrict,
    addChat: addChat, renderRoster: renderRoster, bindChat: bindChat,
    floatReact: floatReact, bindReacts: bindReacts,
    copyText: copyText, inviteLink: inviteLink, prefillFromQuery: prefillFromQuery,
    bindFullscreen: bindFullscreen,
  };
})();
