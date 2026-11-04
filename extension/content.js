/* Teleshare extension content script.
 *
 * Finds the main <video> on the page (Netflix, Prime, Disney+, YouTube, Vimeo, any site),
 * connects to a Teleshare server, and keeps that video in sync with the room.
 *
 * Telling the user's clicks apart from the site's own behaviour is the hard part on someone
 * else's player. We only treat a play/pause/seek as the user's if (a) there was a real
 * (isTrusted) click or key press in the last moment, and (b) it disagrees with the room.
 * Site autoplay, buffering pauses and our own corrections therefore never broadcast,
 * which is what prevents the "everyone keeps pausing each other" loops.
 */
(() => {
  'use strict';
  if (window.top !== window || window.__teleshare) return; // top frame only, once
  window.__teleshare = true;

  const DEFAULT_SERVER = 'http://localhost:3000';
  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(location.hostname);
  const HARD_DRIFT = IS_NETFLIX ? 1.5 : 1.0;
  const SEEK_COOLDOWN = IS_NETFLIX ? 2500 : 1200;
  const USER_INPUT_WINDOW = 1500;

  const safe = (fn, fb = null) => { try { return fn(); } catch (_) { return fb; } };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const randId = (n = 12) => {
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
  };
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0; s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };
  // Identifies "the same video page", ignoring tracking params (Netflix adds ?trackId=…).
  // YouTube keeps the video in ?v=, so that one param counts.
  const pageKey = (url) => safe(() => {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    return u.origin + u.pathname.replace(/\/+$/, '') + (v ? '?v=' + v : '');
  }, url);
  const cleanUrl = () => location.href.split('#')[0];

  // ------------------------------------------------------------ settings & session
  let settings = { server: DEFAULT_SERVER, name: '' };
  const SESSION_KEY = 'teleshare.session';
  let session = null; // { room, server, start? }
  let clientId = safe(() => sessionStorage.getItem('teleshare.clientId'));
  if (!clientId) { clientId = randId(); safe(() => sessionStorage.setItem('teleshare.clientId', clientId)); }

  function saveSession() { safe(() => (session ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)) : sessionStorage.removeItem(SESSION_KEY))); }
  function normServer(s) { s = String(s || '').trim().replace(/\/+$/, ''); return /^https?:\/\/[^/]+/.test(s) ? s : DEFAULT_SERVER; }

  // ------------------------------------------------------------ clock
  const clock = {
    offset: 0, samples: [],
    now() { return Date.now() + this.offset; },
    onPong(c, s) {
      const rtt = Date.now() - c; if (!(rtt >= 0 && rtt < 10000)) return;
      const off = s - (c + rtt / 2);
      if (this.samples.length && Math.abs(off - this.offset) > 1000) this.samples = [];
      this.samples.push({ rtt, off }); if (this.samples.length > 12) this.samples.shift();
      this.offset = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
    },
  };

  // ------------------------------------------------------------ room state
  let me = { id: clientId, name: '' };
  let state = null;
  let members = [];
  const chatIds = new Set();
  const pendingChat = new Map();
  let everJoined = false;

  const expectedAt = (s, at) => (!s ? 0 : s.playing ? s.position + ((at - s.updatedAt) / 1000) * (s.rate || 1) : s.position);
  const expected = () => expectedAt(state, clock.now());
  const roomMatchesPage = () => !!(state && state.media && state.media.kind === 'page' && pageKey(state.media.url) === pageKey(cleanUrl()));

  // ------------------------------------------------------------ connection
  const conn = {
    ws: null, joined: false, attempt: 0, timer: null, pingTimer: null, lastMsg: 0,
    connect() {
      clearTimeout(this.timer);
      if (!session || (this.ws && this.ws.readyState <= 1)) return;
      let ws;
      try { ws = new WebSocket(session.server.replace(/^http/, 'ws') + '/ws'); }
      catch (e) { ui.status('bad', 'Bad server address'); return; }
      this.ws = ws;
      ui.status('wait', this.attempt ? 'Reconnecting…' : 'Connecting…');
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.lastMsg = Date.now();
        for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 120);
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.watchdog(), 4000);
        ws.send(JSON.stringify({ t: 'join', room: session.room, name: settings.name, clientId, rejoin: everJoined }));
      };
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        this.lastMsg = Date.now();
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        onMessage(m);
      };
      ws.onclose = (e) => { if (this.ws === ws) this.dropped(e.code); };
      ws.onerror = () => {};
    },
    dropped(code) {
      this.ws = null; this.joined = false; clearInterval(this.pingTimer);
      if (!session) return;
      if (code === 4000) { ui.status('bad', 'Opened in another tab'); return; }
      const delay = Math.min(10000, 500 * 2 ** this.attempt) * (0.6 + Math.random() * 0.4);
      this.attempt++;
      ui.status('bad', 'Reconnecting…');
      this.timer = setTimeout(() => this.connect(), delay);
    },
    ping() { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', c: Date.now() })); },
    watchdog() {
      if (Date.now() - this.lastMsg > 12000) { const ws = this.ws; safe(() => ws.close()); this.dropped(1006); return; }
      this.ping();
    },
    send(msg) { if (this.ws && this.ws.readyState === 1 && this.joined) { this.ws.send(JSON.stringify(msg)); return true; } return false; },
    close() { clearTimeout(this.timer); clearInterval(this.pingTimer); const ws = this.ws; this.ws = null; this.joined = false; safe(() => ws.close()); },
    nudge() { if (!session) return; if (!this.ws) { this.attempt = 0; this.connect(); } else if (this.ws.readyState === 1) this.watchdog(); },
  };
  window.addEventListener('online', () => conn.nudge());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { conn.nudge(); tick(); } });

  function onMessage(m) {
    switch (m.t) {
      case 'pong': clock.onPong(m.c, m.s); break;
      case 'welcome': {
        conn.joined = true; conn.attempt = 0; everJoined = true; me = m.you;
        ui.status('ok', 'Connected');
        applyState(m.state, true);
        members = m.members; ui.members();
        for (const msg of m.chat) addChat(msg);
        for (const [id, text] of pendingChat) { if (chatIds.has(id)) pendingChat.delete(id); else conn.send({ t: 'chat', id, text }); }
        // Starting a party from this tab: the room adopts this page and where we are in it.
        if (session.start) {
          session.start = false; saveSession();
          const v = video;
          conn.send({ t: 'load', page: true, url: cleanUrl(), title: pageTitle(), position: v ? v.currentTime : 0, playing: v ? !v.paused : false });
        }
        break;
      }
      case 'state': applyState(m.state, false); break;
      case 'members': members = m.members; ui.members(); break;
      case 'chat': addChat(m.msg); break;
      case 'error': ui.toast(m.text); break;
    }
  }

  function pageTitle() {
    const t = document.title.replace(/\s*[-|–]\s*(Netflix|YouTube|Prime Video|Disney\+|Max|Hulu|Vimeo)\s*$/i, '').trim();
    return (t || location.hostname).slice(0, 120);
  }

  function applyState(next, force) {
    if (!next) return;
    if (!force && state && next.version < state.version) return;
    const prev = state;
    state = next;
    if (prev && !force && next.by && next.by !== me.name && roomMatchesPage()) {
      if (prev.playing !== next.playing) ui.toast(`${next.by} ${next.playing ? 'pressed play' : 'paused'}`);
      else if (Math.abs(expectedAt(prev, next.updatedAt) - next.position) > 1.5) ui.toast(`${next.by} jumped to ${fmt(next.position)}`);
    }
    const mediaChanged = !!prev && !force && (prev.media && prev.media.url) !== (next.media && next.media.url);
    // Auto-follow when someone switches the party to a new page, or when we just arrived from an
    // invite. Never when we navigated away ourselves (that would yank us back).
    followMedia(mediaChanged || !!session.follow);
    if (session.follow && force) { session.follow = false; saveSession(); }
    seekCooldownUntil = 0;
    tick();
  }

  // The room is watching something on a different page: follow it if we can.
  function followMedia(autoFollow) {
    ui.banner(null);
    if (!state || !state.media) { ui.banner('Nothing is playing yet. Press play on a video and use “Bring everyone here”.', 'here'); return; }
    if (state.media.kind !== 'page') {
      ui.banner('This party is using a video on the Teleshare website.', 'open', session.server + '/r/' + session.room);
      return;
    }
    if (roomMatchesPage()) return;
    const target = new URL(state.media.url);
    if (target.origin === location.origin && autoFollow) {
      ui.banner(`Following the party to “${state.media.title}”…`);
      // Session is kept in sessionStorage, so the reload rejoins automatically.
      setTimeout(() => { if (state && state.media && !roomMatchesPage()) location.assign(state.media.url); }, 1200);
    } else {
      ui.banner(`The party is watching “${state.media.title}”${target.origin === location.origin ? '' : ' on ' + target.hostname}.`, 'open', state.media.url + '#teleshare=' + session.room + '&server=' + encodeURIComponent(session.server));
    }
  }

  // ------------------------------------------------------------ the page's video
  let video = null;
  let blocked = false;
  let seekCooldownUntil = 0;
  let ourSeekAt = 0;
  let recentHardSeeks = [];
  let lastDrift = 0;
  let lastUserInput = 0;
  let playPending = false;

  // Real user input only (isTrusted). Synthetic events from the site's own scripts don't count.
  for (const type of ['pointerdown', 'pointerup', 'keydown', 'click']) {
    window.addEventListener(type, (e) => { if (e.isTrusted) lastUserInput = Date.now(); }, true);
  }
  const userJustActed = (ms = USER_INPUT_WINDOW) => Date.now() - lastUserInput < ms;

  function findVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 120 && r.height > 80) { best = v; bestArea = area; }
    }
    return best;
  }

  const onPlay = () => {
    if (!session || !roomMatchesPage() || !state) return;
    if (!state.playing && userJustActed()) act('play', video.currentTime);
  };
  const onPause = () => {
    if (!session || !roomMatchesPage() || !state || video.ended) return;
    if (state.playing && userJustActed()) act('pause', video.currentTime);
  };
  const onSeeked = () => {
    if (!session || !roomMatchesPage() || !state) return;
    if (Date.now() - ourSeekAt < 1500) return; // our own correction landing
    if (Math.abs(video.currentTime - expected()) > 1 && userJustActed(3000)) act('seek', video.currentTime);
  };
  const onEnded = () => {
    if (state && state.playing && roomMatchesPage()) conn.send({ t: 'ended', position: video.duration, mediaUrl: state.media.url });
  };

  function bindVideo(v) {
    if (v === video) return;
    if (video) {
      video.removeEventListener('play', onPlay); video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked); video.removeEventListener('ended', onEnded);
    }
    video = v;
    if (v) {
      v.addEventListener('play', onPlay); v.addEventListener('pause', onPause);
      v.addEventListener('seeked', onSeeked); v.addEventListener('ended', onEnded);
    }
    ui.refresh();
  }
  let lastUrl = cleanUrl();
  setInterval(() => {
    if (session || document.querySelector('video')) bindVideo(findVideo());
    if (cleanUrl() !== lastUrl) { lastUrl = cleanUrl(); if (session && conn.joined) followMedia(false); }
  }, 1000);

  function seekTo(t) {
    ourSeekAt = Date.now();
    if (IS_NETFLIX) window.postMessage({ __teleshare: 'nf-seek', ms: t * 1000 }, '*');
    else video.currentTime = t;
  }
  function setRate(r) {
    if (IS_NETFLIX) return; // Netflix's player doesn't tolerate rate changes; seeks only.
    if (Math.abs(video.playbackRate - r) > 0.001) safe(() => { video.playbackRate = r; });
  }
  function tryPlay() {
    if (playPending) return;
    playPending = true;
    const p = safe(() => video.play());
    if (p && p.then) p.then(() => { playPending = false; setBlocked(false); }, (e) => { playPending = false; if (e && e.name === 'NotAllowedError') setBlocked(true); });
    else playPending = false;
  }
  function setBlocked(b) { if (blocked !== b) { blocked = b; ui.refresh(); } }

  function hardSeek(t) {
    const n = Date.now();
    seekTo(t);
    seekCooldownUntil = n + SEEK_COOLDOWN;
    recentHardSeeks = recentHardSeeks.filter((x) => n - x < 30000);
    recentHardSeeks.push(n);
    if (recentHardSeeks.length >= 5) { ui.toast('Your connection is struggling to keep up.'); recentHardSeeks = []; }
  }

  function tick() {
    ui.syncLabel();
    if (!session || !video || !state || !roomMatchesPage() || video.readyState < 1) return;
    const n = Date.now();
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    let target = expected();
    if (dur > 0) target = clamp(target, 0, Math.max(0, dur - 0.1));
    const baseRate = state.rate || 1;

    if (!state.playing) {
      if (!video.paused) video.pause();
      setRate(baseRate);
      if (Math.abs(video.currentTime - target) > 0.5 && n > seekCooldownUntil) hardSeek(target);
      lastDrift = 0;
      return;
    }
    if (dur > 0 && expected() >= dur - 0.1) return;
    if (video.paused) {
      if (blocked) return;
      if (Math.abs(video.currentTime - target) > 0.5 && n > seekCooldownUntil) hardSeek(target);
      tryPlay();
      return;
    }
    if (video.seeking || video.readyState < 3 || n < seekCooldownUntil) return; // let it buffer / land
    const drift = video.currentTime - target;
    lastDrift = drift;
    if (Math.abs(drift) > HARD_DRIFT) { hardSeek(target + 0.1); setRate(baseRate); }
    else if (Math.abs(drift) > 0.05) setRate(baseRate * (1 - clamp(drift * 0.5, -0.08, 0.08)));
    else setRate(baseRate);
  }
  setInterval(tick, 250);

  function act(action, position) {
    if (!state || !state.media) return;
    if (!conn.joined) { ui.toast('Offline. Reconnecting…'); return; }
    const pos = Math.max(0, position);
    state = Object.assign({}, state, { position: pos, updatedAt: clock.now() },
      action === 'play' ? { playing: true } : action === 'pause' ? { playing: false } : {});
    seekCooldownUntil = 0;
    conn.send({ t: 'control', action, position: pos, mediaUrl: state.media.url });
  }

  function bringEveryoneHere() {
    if (!video) { ui.toast('No video found on this page yet.'); return; }
    conn.send({ t: 'load', page: true, url: cleanUrl(), title: pageTitle(), position: video.currentTime, playing: !video.paused });
  }

  // ------------------------------------------------------------ chat
  function addChat(msg) {
    if (chatIds.has(msg.id)) return;
    chatIds.add(msg.id);
    const el = ui.chatItem(msg.id);
    if (el) { el.classList.remove('pending'); pendingChat.delete(msg.id); return; }
    ui.chat(msg, false);
  }
  function sendChat(text) {
    const id = randId();
    pendingChat.set(id, text);
    ui.chat({ id, from: me.id, name: me.name, text }, true);
    conn.send({ t: 'chat', id, text });
  }

  // ------------------------------------------------------------ party lifecycle
  async function loadSettings() {
    let s = {};
    try { s = await chrome.storage.sync.get(['server', 'name']); } catch (_) { /* extension reloaded; keep defaults */ }
    settings.server = normServer(s && s.server);
    settings.name = ((s && s.name) || '').slice(0, 32);
  }

  function startParty(opts) {
    leaveParty(true);
    session = { room: opts.room || randId(8), server: normServer(opts.server || settings.server), start: !!opts.start, follow: !!opts.follow };
    saveSession();
    everJoined = false; state = null; members = []; chatIds.clear(); pendingChat.clear();
    ui.mount(); ui.clearChat(); ui.open(true);
    conn.attempt = 0;
    conn.connect();
  }

  function leaveParty(quiet) {
    if (!session) return;
    conn.close();
    session = null; state = null; saveSession();
    setBlocked(false);
    if (video) setRate(1);
    ui.unmount();
    if (!quiet) ui.toast('Left the party');
  }

  const inviteLink = () => (session ? session.server + '/r/' + session.room : null);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    (async () => {
      await loadSettings();
      if (msg.cmd === 'start') startParty({ start: true, server: msg.server });
      else if (msg.cmd === 'join') startParty({ room: msg.room, server: msg.server, follow: true });
      else if (msg.cmd === 'leave') leaveParty();
      else if (msg.cmd === 'rename' && session && msg.name) conn.send({ t: 'rename', name: msg.name });
      reply({
        active: !!session, room: session && session.room, server: session && session.server,
        invite: inviteLink(), hasVideo: !!(video || findVideo()), connected: conn.joined,
      });
    })();
    return true;
  });

  // ------------------------------------------------------------ sidebar UI (shadow DOM)
  const ui = (() => {
    let host = null, root = null, isOpen = true, toastTimer = null;
    const $ = (sel) => root && root.querySelector(sel);
    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .wrap { position: fixed; top: 0; right: 0; height: 100vh; z-index: 2147483647; display: flex; align-items: flex-start; pointer-events: none; }
      .tab { pointer-events: auto; margin-top: 30vh; background: #4d6ef0; color: #fff; border: 0; border-radius: 10px 0 0 10px; padding: 10px 8px; cursor: pointer; font-size: 15px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
      .panel { pointer-events: auto; width: 300px; height: 100vh; background: rgba(17,19,24,.96); color: #e8eaf0; border-left: 1px solid #2a2f3a; display: flex; flex-direction: column; font-size: 14px; }
      .panel[hidden] { display: none; }
      .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2a2f3a; }
      .hd b { flex: 1; font-size: 15px; }
      button { font: inherit; color: inherit; background: #1f232c; border: 1px solid #2a2f3a; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
      button:hover { border-color: #6c8cff; }
      button.primary { background: #4d6ef0; border-color: #4d6ef0; color: #fff; }
      .st { display: flex; align-items: center; gap: 6px; padding: 8px 12px 0; font-size: 12px; color: #8a92a6; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #f5b942; }
      .st.ok .dot { background: #3ecf8e; } .st.bad .dot { background: #f2555a; }
      .sync { margin-left: auto; color: #3ecf8e; } .sync.warn { color: #f5b942; }
      .banner { margin: 10px 12px 0; padding: 10px; background: #1f232c; border: 1px solid #2a2f3a; border-radius: 8px; font-size: 13px; line-height: 1.4; }
      .banner button, .banner a { margin-top: 8px; display: inline-block; }
      .banner a { color: #fff; background: #4d6ef0; padding: 6px 10px; border-radius: 8px; text-decoration: none; }
      .unblock { margin: 10px 12px 0; }
      .h { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8a92a6; padding: 12px 12px 6px; }
      .mem { list-style: none; margin: 0; padding: 0 12px 8px; display: flex; flex-wrap: wrap; gap: 6px; }
      .mem li { background: #1f232c; border-radius: 999px; padding: 2px 9px; font-size: 12px; }
      .log { list-style: none; margin: 0; padding: 4px 12px; flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #2a2f3a; }
      .log li { line-height: 1.35; overflow-wrap: anywhere; }
      .log li.sys { color: #8a92a6; font-size: 12px; font-style: italic; }
      .log li.pending { opacity: .55; }
      .who { font-weight: 600; margin-right: 6px; }
      form { display: flex; gap: 6px; padding: 10px 12px 14px; }
      input { flex: 1; min-width: 0; font: inherit; color: #e8eaf0; background: #1f232c; border: 1px solid #2a2f3a; border-radius: 8px; padding: 8px 10px; outline: none; }
      input:focus { border-color: #6c8cff; }
      .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: rgba(20,22,28,.94); color: #e8eaf0; border: 1px solid #2a2f3a; padding: 7px 14px; border-radius: 999px; font-size: 14px; pointer-events: none; }
      .toast[hidden] { display: none; }
    `;
    const HTML = `
      <div class="wrap">
        <button class="tab" title="Teleshare">📺 <span class="cnt">0</span></button>
        <div class="panel">
          <div class="hd"><b>📺 Teleshare</b><button class="invite" title="Copy invite link">🔗 Invite</button><button class="close" title="Hide">✕</button></div>
          <div class="st"><span class="dot"></span><span class="sttext">Connecting…</span><span class="sync"></span></div>
          <div class="banner" hidden></div>
          <button class="unblock primary" hidden>▶ Click to sync playback</button>
          <div class="h">Watching <span class="cnt">0</span></div>
          <ul class="mem"></ul>
          <ol class="log"></ol>
          <form><input maxlength="500" placeholder="Say something…" /><button type="submit">Send</button></form>
          <div style="padding:0 12px 12px"><button class="leave">Leave party</button></div>
        </div>
      </div>
      <div class="toast" hidden></div>`;

    function colorFor(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 70% 70%)`; }

    function placeHost() {
      if (!host) return;
      // In fullscreen only the fullscreen element is visible, so move the sidebar inside it.
      const fs = document.fullscreenElement;
      const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
      if (host.parentNode !== parent) parent.appendChild(host);
    }
    document.addEventListener('fullscreenchange', placeHost);

    return {
      mount() {
        if (host) return;
        host = document.createElement('teleshare-sidebar');
        root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${CSS}</style>${HTML}`;
        // Keep typing in our chat box from triggering the site's keyboard shortcuts.
        for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => e.stopPropagation());
        $('.tab').onclick = () => this.open(true);
        $('.close').onclick = () => this.open(false);
        $('.leave').onclick = () => leaveParty();
        $('.unblock').onclick = () => { setBlocked(false); if (video) { seekTo(expected()); tryPlay(); } };
        $('.invite').onclick = async () => {
          const link = inviteLink();
          try { await navigator.clipboard.writeText(link); this.toast('Invite link copied'); }
          catch (_) { window.prompt('Copy this invite link:', link); }
        };
        $('form').onsubmit = (e) => {
          e.preventDefault();
          const t = $('input').value.trim();
          if (t) { sendChat(t); $('input').value = ''; }
        };
        placeHost();
        this.open(isOpen);
      },
      unmount() { if (host) host.remove(); host = root = null; },
      open(b) { isOpen = b; if (!root) return; $('.panel').hidden = !b; $('.tab').hidden = b; },
      status(kind, text) {
        if (!root) return;
        $('.st').className = 'st' + (kind === 'ok' ? ' ok' : kind === 'bad' ? ' bad' : '');
        $('.sttext').textContent = text;
      },
      banner(text, action, href) {
        if (!root) return;
        const b = $('.banner');
        b.hidden = !text; b.textContent = '';
        if (!text) return;
        b.append(document.createTextNode(text));
        if (action === 'here' || (action === 'open' && video)) {
          const btn = document.createElement('button');
          btn.className = 'primary'; btn.textContent = 'Bring everyone here'; btn.onclick = bringEveryoneHere;
          b.append(document.createElement('br'), btn);
        }
        if (action === 'open' && href) {
          const a = document.createElement('a');
          a.href = href; a.textContent = 'Go there'; a.target = '_self';
          b.append(document.createElement('br'), a);
        }
      },
      refresh() {
        if (!root) return;
        $('.unblock').hidden = !blocked;
        if (session && conn.joined) followMedia();
      },
      syncLabel() {
        if (!root) return;
        const el = $('.sync');
        if (!state || !roomMatchesPage() || !state.playing || !video) { el.textContent = ''; return; }
        if (blocked) { el.textContent = 'not playing'; el.className = 'sync warn'; }
        else if (Math.abs(lastDrift) < 0.3) { el.textContent = 'in sync'; el.className = 'sync'; }
        else { el.textContent = (lastDrift > 0 ? '+' : '−') + Math.abs(lastDrift).toFixed(1) + 's'; el.className = 'sync warn'; }
      },
      members() {
        if (!root) return;
        const ul = $('.mem'); ul.textContent = '';
        for (const m of members) {
          const li = document.createElement('li');
          li.textContent = m.name + (m.id === me.id ? ' (you)' : '');
          li.style.color = colorFor(m.id);
          ul.appendChild(li);
        }
        for (const c of root.querySelectorAll('.cnt')) c.textContent = String(members.length);
      },
      chatItem(id) { return root && [...root.querySelectorAll('.log li')].find((li) => li.dataset.id === id); },
      clearChat() { if (root) $('.log').textContent = ''; },
      chat(msg, pending) {
        if (!root) return;
        const log = $('.log');
        const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
        const li = document.createElement('li');
        li.dataset.id = msg.id;
        if (msg.system) { li.className = 'sys'; li.textContent = msg.text; }
        else {
          if (pending) li.className = 'pending';
          const who = document.createElement('span');
          who.className = 'who'; who.textContent = msg.name; who.style.color = colorFor(msg.from);
          li.append(who, document.createTextNode(msg.text));
        }
        log.appendChild(li);
        while (log.children.length > 300) log.firstChild.remove();
        if (near || pending) log.scrollTop = log.scrollHeight;
        if (!isOpen && !msg.system && !pending) this.toast(`${msg.name}: ${msg.text.slice(0, 80)}`);
      },
      toast(text) {
        if (!root) return;
        const t = $('.toast');
        t.textContent = text; t.hidden = false;
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
      },
    };
  })();

  // ------------------------------------------------------------ boot
  (async () => {
    await loadSettings();
    // Invite links look like https://site/watch/123#teleshare=ROOM&server=https%3A%2F%2Fserver
    const hash = new URLSearchParams(location.hash.slice(1));
    const fromHash = hash.get('teleshare');
    if (fromHash && /^[A-Za-z0-9_-]{3,32}$/.test(fromHash)) {
      history.replaceState(history.state, '', cleanUrl()); // keep the site's own router happy
      startParty({ room: fromHash, server: hash.get('server') || settings.server, follow: true });
      return;
    }
    const saved = safe(() => JSON.parse(sessionStorage.getItem(SESSION_KEY)));
    if (saved && saved.room) { startParty({ room: saved.room, server: saved.server }); everJoined = true; } // a reload is a rejoin
  })();
})();
