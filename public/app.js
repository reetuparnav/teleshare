/* Teleshare client.
 *
 * Reliability rules this file follows (each one fixes a classic watch-party bug):
 *  1. Only explicit user actions on OUR controls send play/pause/seek. Programmatic player
 *     changes never echo back to the server, so there are no feedback loops.
 *  2. The server's state is the single source of truth, versioned so stale updates are ignored.
 *  3. Position is computed from a synced clock, not from "last event + latency guesses".
 *  4. Small drift is corrected by gently changing playback speed; large drift by a single
 *     seek with a cooldown (no seek storms while buffering).
 *  5. Connection loss is detected with app-level pings, reconnects with backoff, and the full
 *     room state + chat history is re-sent on every reconnect. Unsent chat is retried.
 *  6. If the browser blocks autoplay, we say so and offer a one-click fix instead of silently
 *     falling out of sync.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };
  const local = {
    get: (k) => safe(() => localStorage.getItem(k)),
    set: (k, v) => safe(() => localStorage.setItem(k, v)),
  };
  const randId = (n = 12) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
  };
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // One id per browser tab, stable across reloads of that tab (so a refresh is a "rejoin").
  let clientId = safe(() => sessionStorage.getItem('cs.clientId'));
  if (!clientId) { clientId = randId(); safe(() => sessionStorage.setItem('cs.clientId', clientId)); }

  // ------------------------------------------------------------------ clock sync
  const clock = {
    offset: 0, rtt: 0, samples: [],
    now() { return Date.now() + this.offset; },
    onPong(c, s) {
      const t = Date.now();
      const rtt = t - c;
      if (!(rtt >= 0 && rtt < 10000)) return;
      const off = s - (c + rtt / 2);
      // A big jump means the local clock was changed (or the server restarted): start over.
      if (this.samples.length && Math.abs(off - this.offset) > 1000) this.samples = [];
      this.samples.push({ rtt, off });
      if (this.samples.length > 12) this.samples.shift();
      // The lowest-latency sample has the smallest error bound.
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      this.offset = best.off;
      this.rtt = best.rtt;
    },
  };

  // ------------------------------------------------------------------ app state
  let roomId = null;
  let me = { id: clientId, name: local.get('cs.name') || '' };
  let state = null; // authoritative room state from server (possibly optimistically patched)
  let player = null;
  let shownPageUrl = null; // media url of an extension ("page") party currently shown
  let members = [];
  const chatIds = new Set();
  const pendingChat = new Map(); // id -> text, sent but not yet confirmed by the server
  let everJoined = false;

  // ------------------------------------------------------------------ connection
  const conn = {
    ws: null, joined: false, attempt: 0, timer: null, pingTimer: null, lastPong: 0, stopped: false,

    connect() {
      if (this.stopped) return;
      clearTimeout(this.timer);
      if (this.ws && this.ws.readyState <= 1) return;
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      this.ws = ws;
      setConn('wait', this.attempt ? 'Reconnecting…' : 'Connecting…');

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.lastPong = Date.now();
        // Burst of pings for a fast initial clock estimate, then steady ones.
        for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 120);
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.watchdog(), 4000);
        ws.send(JSON.stringify({ t: 'join', room: roomId, name: me.name, clientId, rejoin: everJoined }));
      };
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        this.lastPong = Date.now();
        onMessage(m);
      };
      ws.onclose = (e) => { if (this.ws === ws) this.dropped(e.code); };
      ws.onerror = () => {};
    },

    dropped(code) {
      this.ws = null;
      this.joined = false;
      clearInterval(this.pingTimer);
      if (code === 4000) {
        // Same tab id opened elsewhere (e.g. duplicated tab). Don't fight over the seat.
        this.stopped = true;
        setConn('bad', 'Opened in another tab');
        return;
      }
      const delay = Math.min(10000, 500 * 2 ** this.attempt) * (0.6 + Math.random() * 0.4);
      this.attempt++;
      setConn('bad', 'Reconnecting…');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), delay);
    },

    ping() {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
    },

    // Half-open TCP connections (wifi switch, laptop sleep) can look "open" forever.
    // If the server hasn't answered anything for a while, force a reconnect.
    watchdog() {
      if (Date.now() - this.lastPong > 12000) { const ws = this.ws; safe(() => ws.close()); this.dropped(1006); return; }
      this.ping();
    },

    send(msg) {
      if (this.ws && this.ws.readyState === 1 && this.joined) { this.ws.send(JSON.stringify(msg)); return true; }
      return false;
    },

    // Network came back or tab woke up: skip the backoff wait.
    nudge() {
      if (this.stopped) return;
      if (!this.ws || this.ws.readyState > 1) { this.attempt = 0; this.connect(); }
      else if (this.ws.readyState === 1) this.watchdog();
    },
  };
  window.addEventListener('online', () => conn.nudge());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { conn.nudge(); tick(); } });

  function setConn(kind, text) {
    const el = $('conn');
    el.className = 'conn' + (kind === 'ok' ? ' ok' : kind === 'bad' ? ' bad' : '');
    $('connText').textContent = text;
  }

  // ------------------------------------------------------------------ messages
  function onMessage(m) {
    switch (m.t) {
      case 'pong': clock.onPong(m.c, m.s); break;
      case 'welcome': {
        conn.joined = true;
        conn.attempt = 0;
        everJoined = true;
        me = m.you;
        setConn('ok', 'Connected');
        // Always take the server's view on (re)join, even if its version is lower
        // (the server may have restarted).
        applyState(m.state, true);
        members = m.members; renderMembers();
        for (const msg of m.chat) addChat(msg);
        // Retry chat that was sent but never confirmed (server dedupes by id).
        for (const [id, text] of pendingChat) {
          if (chatIds.has(id)) pendingChat.delete(id);
          else conn.send({ t: 'chat', id, text });
        }
        break;
      }
      case 'state': applyState(m.state, false); break;
      case 'members': members = m.members; renderMembers(); break;
      case 'chat': addChat(m.msg); break;
      case 'error': toast(m.text); break;
    }
  }

  function applyState(next, force) {
    if (!next) return;
    if (!force && state && next.version < state.version) return; // stale / out of order
    const prev = state;
    state = next;

    // Announce what someone else did.
    if (prev && !force && next.by && next.by !== me.name && prev.media && next.media && prev.media.url === next.media.url) {
      if (prev.playing !== next.playing) toast(`${next.by} ${next.playing ? 'pressed play' : 'paused'} at ${fmt(next.position)}`);
      else if (Math.abs(expectedAt(prev, next.updatedAt) - next.position) > 1.5) toast(`${next.by} jumped to ${fmt(next.position)}`);
    }

    const url = next.media ? next.media.url : null;
    if ((player ? player.url : shownPageUrl) !== url) { shownPageUrl = next.media && next.media.kind === 'page' ? url : null; setMedia(next.media); }
    if (next.media && document.activeElement !== $('urlInput')) $('urlInput').value = next.media.url;
    seekCooldownUntil = 0; // a fresh authoritative state deserves an immediate correction
    tick();
  }

  // ------------------------------------------------------------------ position math
  function expectedAt(s, at) {
    if (!s) return 0;
    return s.playing ? s.position + ((at - s.updatedAt) / 1000) * (s.rate || 1) : s.position;
  }
  const expected = () => expectedAt(state, clock.now());

  // ------------------------------------------------------------------ players
  let ytApi = null;
  function loadYouTubeApi() {
    if (ytApi) return ytApi;
    ytApi = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApi = null; reject(new Error('Could not load YouTube')); };
      document.head.appendChild(s);
    });
    return ytApi;
  }

  function makeFilePlayer(media) {
    const v = $('video');
    v.hidden = false;
    v.src = media.url;
    v.load();
    let playPending = false;
    const onEnded = () => reportEnded(v.duration);
    const onError = () => toast('This video couldn\'t be loaded. The link must point directly to a video file the browser can play.', 6000);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError);
    applyVolume(v);
    return {
      kind: 'file', url: media.url,
      ready: () => v.readyState >= 1,
      time: () => v.currentTime,
      duration: () => (Number.isFinite(v.duration) ? v.duration : 0),
      paused: () => v.paused,
      buffering: () => !v.paused && v.readyState < 3,
      play() {
        if (playPending) return;
        playPending = true;
        const p = v.play();
        if (p && p.then) {
          p.then(() => { playPending = false; setBlocked(false); }, (err) => {
            playPending = false;
            if (err && err.name === 'NotAllowedError') setBlocked(true);
          });
        } else playPending = false;
      },
      pause: () => v.pause(),
      seek: (t) => { v.currentTime = t; },
      setRate: (r) => { if (Math.abs(v.playbackRate - r) > 0.001) v.playbackRate = r; },
      el: v,
      destroy() {
        v.removeEventListener('ended', onEnded);
        v.removeEventListener('error', onError);
        v.pause(); v.removeAttribute('src'); v.load(); v.hidden = true;
      },
    };
  }

  function makeYouTubePlayer(media) {
    $('ytHost').hidden = false;
    $('ytHost').innerHTML = '<div id="yt"></div>';
    let yt = null, isReady = false, destroyed = false, playRequestedAt = 0;
    const api = {
      kind: 'youtube', url: media.url,
      ready: () => isReady,
      time: () => (isReady ? yt.getCurrentTime() : 0),
      duration: () => (isReady ? yt.getDuration() || 0 : 0),
      paused: () => { if (!isReady) return true; const s = yt.getPlayerState(); return s !== 1 && s !== 3; },
      buffering: () => isReady && yt.getPlayerState() === 3,
      play() {
        if (!isReady) return;
        yt.playVideo();
        if (!playRequestedAt) playRequestedAt = Date.now();
      },
      // YouTube refuses to start without a user gesture in some browsers but doesn't tell us;
      // detect "asked to play but still unstarted" instead.
      checkBlocked() {
        if (!isReady || !playRequestedAt) return;
        const s = yt.getPlayerState();
        if (s === 1 || s === 3) { playRequestedAt = 0; setBlocked(false); }
        else if (Date.now() - playRequestedAt > 2500 && (s === -1 || s === 5)) setBlocked(true);
      },
      pause() { playRequestedAt = 0; if (isReady) yt.pauseVideo(); },
      seek: (t) => { if (isReady) yt.seekTo(t, true); },
      setRate: (r) => { if (isReady && yt.getPlaybackRate() !== r) yt.setPlaybackRate(r); },
      setVolume(vol, muted) { if (!isReady) return; yt.setVolume(Math.round(vol * 100)); muted ? yt.mute() : yt.unMute(); },
      destroy() { destroyed = true; safe(() => yt && yt.destroy()); $('ytHost').innerHTML = '<div id="yt"></div>'; $('ytHost').hidden = true; },
    };
    loadYouTubeApi().then((YT) => {
      if (destroyed) return;
      yt = new YT.Player('yt', {
        videoId: media.videoId,
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, fs: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => { if (destroyed) return; isReady = true; applyVolume(); tick(); },
          onStateChange: (e) => { if (e.data === 0) reportEnded(yt.getDuration()); tick(); },
          onError: (e) => {
            const why = { 2: 'invalid video id', 5: 'HTML5 player error', 100: 'video not found or private', 101: 'owner disabled embedding', 150: 'owner disabled embedding' }[e.data] || 'error ' + e.data;
            toast('YouTube can\'t play this here: ' + why, 6000);
          },
        },
      });
    }, () => toast('Couldn\'t reach YouTube. Check your connection or ad-blocker.', 6000));
    return api;
  }

  function setMedia(media) {
    if (player) player.destroy();
    player = null;
    setBlocked(false);
    const isPage = !!media && media.kind === 'page';
    $('empty').hidden = !!media;
    $('pageParty').hidden = !isPage;
    $('shield').hidden = !media || isPage;
    $('controls').hidden = isPage;
    if (!media) return;
    if (isPage) {
      // Playback happens on another site via the browser extension; this page is chat + a door.
      const u = new URL(media.url);
      $('pageTitle').textContent = media.title || u.hostname;
      $('pageHost').textContent = u.hostname;
      $('pageOpen').href = media.url + '#teleshare=' + encodeURIComponent(roomId) + '&server=' + encodeURIComponent(location.origin);
      return;
    }
    player = media.kind === 'youtube' ? makeYouTubePlayer(media) : makeFilePlayer(media);
  }

  function reportEnded(duration) {
    if (state && state.playing && state.media) {
      conn.send({ t: 'ended', position: Number.isFinite(duration) ? duration : expected(), mediaUrl: state.media.url });
    }
  }

  // ------------------------------------------------------------------ sync loop
  const HARD_DRIFT = { file: 1.0, youtube: 0.8 }; // seconds before we seek
  const SOFT_DRIFT = 0.05; // below this, play at normal speed
  let seekCooldownUntil = 0;
  let recentHardSeeks = [];
  let blocked = false;
  let lastDrift = 0;

  function setBlocked(b) {
    blocked = b;
    $('unblock').hidden = !b;
  }

  function hardSeek(t) {
    const n = Date.now();
    player.seek(t);
    // Give the player time to actually get there before judging drift again.
    seekCooldownUntil = n + (player.kind === 'youtube' ? 2000 : 1200);
    recentHardSeeks = recentHardSeeks.filter((x) => n - x < 30000);
    recentHardSeeks.push(n);
    if (recentHardSeeks.length >= 5) {
      toast('Your connection is struggling to keep up. Playback may stutter.', 5000);
      recentHardSeeks = [];
    }
  }

  function tick() {
    updateControls();
    if (!player || !state || !state.media || !player.ready()) return;
    const n = Date.now();
    const dur = player.duration();
    let target = expected();
    if (dur > 0) target = clamp(target, 0, Math.max(0, dur - 0.1));
    const baseRate = state.rate || 1;

    if (!state.playing) {
      if (!player.paused()) player.pause();
      player.setRate(baseRate);
      if (Math.abs(player.time() - target) > 0.3 && n > seekCooldownUntil) hardSeek(target);
      lastDrift = 0;
      return;
    }

    // Playing, but past the end of the video: just sit at the end.
    if (dur > 0 && expected() >= dur - 0.1) { if (!player.paused()) player.pause(); return; }

    if (player.paused()) {
      if (blocked) return; // waiting for the user to click "join playback"
      if (Math.abs(player.time() - target) > 0.5 && n > seekCooldownUntil) hardSeek(target);
      player.play();
      if (player.checkBlocked) player.checkBlocked();
      return;
    }
    if (player.checkBlocked) player.checkBlocked();
    if (player.buffering()) return; // don't fight a buffering player; correct once it resumes
    if (n < seekCooldownUntil) return;

    const drift = player.time() - target; // + means we're ahead
    lastDrift = drift;
    if (Math.abs(drift) > HARD_DRIFT[player.kind]) {
      hardSeek(target + (player.kind === 'youtube' ? 0.15 : 0.05));
      player.setRate(baseRate);
    } else if (player.kind === 'file' && Math.abs(drift) > SOFT_DRIFT) {
      // Catch up/slow down by up to 8% — inaudible for most content, no visible jump.
      player.setRate(baseRate * (1 - clamp(drift * 0.5, -0.08, 0.08)));
    } else {
      player.setRate(baseRate);
    }
  }
  setInterval(tick, 250);

  // ------------------------------------------------------------------ controls
  let dragging = false;

  function updateControls() {
    if (state && state.media && state.media.kind === 'page') {
      $('pageStatus').textContent = (state.playing ? 'Playing' : 'Paused') + ' at ' + fmt(expected());
    }
    const has = !!(state && state.media && state.media.kind !== 'page');
    $('playBtn').disabled = !has;
    $('seek').disabled = !has;
    $('playBtn').textContent = has && state.playing ? '❚❚' : '▶';
    const dur = player && player.ready() ? player.duration() : 0;
    const pos = has ? clamp(expected(), 0, dur || Infinity) : 0;
    $('timeDur').textContent = fmt(dur);
    if (!dragging) {
      $('seek').max = String(dur || 0);
      $('seek').value = String(pos);
      $('timeNow').textContent = fmt(pos);
    }
    const si = $('syncInfo');
    if (!has || !state.playing || !player || !player.ready()) { si.textContent = ''; si.className = 'sync'; }
    else if (blocked) { si.textContent = 'paused here'; si.className = 'sync warn'; }
    else if (Math.abs(lastDrift) < 0.3) { si.textContent = 'in sync'; si.className = 'sync'; }
    else { si.textContent = (lastDrift > 0 ? '+' : '−') + Math.abs(lastDrift).toFixed(1) + 's'; si.className = 'sync warn'; }
  }

  function act(action, position) {
    if (!state || !state.media || state.media.kind === 'page') return;
    if (!conn.joined) { toast('You\'re offline. Reconnecting…'); return; }
    let pos = position;
    if (pos == null) pos = action === 'pause' && player && player.ready() ? player.time() : expected();
    pos = Math.max(0, pos);
    // Optimistic: respond instantly. The server's echo (higher version) replaces this.
    state = Object.assign({}, state, { position: pos, updatedAt: clock.now() },
      action === 'play' ? { playing: true } : action === 'pause' ? { playing: false } : {});
    if (action === 'play' && player && player.ready()) { setBlocked(false); player.play(); } // inside the click = allowed to autoplay
    seekCooldownUntil = 0;
    tick();
    conn.send({ t: 'control', action, position: pos, mediaUrl: state.media.url });
  }

  const togglePlay = () => { if (state && state.media && state.media.kind !== 'page') act(state.playing ? 'pause' : 'play'); };
  $('playBtn').onclick = togglePlay;
  $('shield').onclick = togglePlay;
  $('seek').addEventListener('input', () => { dragging = true; $('timeNow').textContent = fmt(Number($('seek').value)); });
  $('seek').addEventListener('change', () => { dragging = false; act('seek', Number($('seek').value)); });
  $('unblock').onclick = () => { setBlocked(false); if (player) { player.seek(expected()); player.play(); } tick(); };

  // Volume is personal, never synced.
  let volume = Number(local.get('cs.vol') ?? 1);
  let muted = local.get('cs.muted') === '1';
  function applyVolume(v) {
    $('vol').value = String(volume);
    $('muteBtn').textContent = muted || volume === 0 ? '🔇' : '🔊';
    const el = v || (player && player.el);
    if (el) { el.volume = volume; el.muted = muted; }
    if (player && player.setVolume) player.setVolume(volume, muted);
  }
  $('vol').oninput = () => { volume = Number($('vol').value); muted = false; local.set('cs.vol', volume); local.set('cs.muted', '0'); applyVolume(); };
  $('muteBtn').onclick = () => { muted = !muted; local.set('cs.muted', muted ? '1' : '0'); applyVolume(); };
  $('fsBtn').onclick = () => {
    const el = document.querySelector('.stage-wrap');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  };

  document.addEventListener('keydown', (e) => {
    if ($('roomView').hidden || e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); act('seek', expected() - 10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); act('seek', expected() + 10); }
    else if (e.key === 'm') $('muteBtn').click();
    else if (e.key === 'f') $('fsBtn').click();
  });

  $('loadForm').onsubmit = (e) => {
    e.preventDefault();
    const url = $('urlInput').value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) { toast('Paste a full link starting with http:// or https://'); return; }
    if (!conn.send({ t: 'load', url })) toast('You\'re offline. Reconnecting…');
    $('urlInput').blur();
  };

  $('shareBtn').onclick = async () => {
    const link = location.origin + '/r/' + roomId;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
    catch (_) { window.prompt('Copy this invite link:', link); }
  };

  // ------------------------------------------------------------------ chat & members
  function addChat(msg) {
    if (chatIds.has(msg.id)) return;
    chatIds.add(msg.id);
    const pendingEl = document.querySelector(`#chatLog li[data-id="${msg.id}"]`);
    if (pendingEl) { pendingEl.classList.remove('pending'); pendingChat.delete(msg.id); return; }
    renderChat(msg, false);
  }

  function renderChat(msg, pending) {
    const log = $('chatLog');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const li = document.createElement('li');
    li.dataset.id = msg.id;
    li.title = new Date(msg.ts || Date.now()).toLocaleTimeString();
    if (msg.system) { li.className = 'sys'; li.textContent = msg.text; }
    else {
      if (pending) li.className = 'pending';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = msg.name;
      who.style.color = colorFor(msg.from);
      li.append(who, document.createTextNode(msg.text));
    }
    log.appendChild(li);
    while (log.children.length > 300) log.firstChild.remove();
    if (nearBottom || pending) log.scrollTop = log.scrollHeight;
  }

  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    const id = randId();
    pendingChat.set(id, text);
    renderChat({ id, from: me.id, name: me.name, text }, true); // shows instantly, dimmed until confirmed
    conn.send({ t: 'chat', id, text }); // if offline, retried on reconnect
    $('chatInput').value = '';
  };

  function colorFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 70% 70%)`;
  }

  function renderMembers() {
    const ul = $('memberList');
    ul.textContent = '';
    for (const m of members) {
      const li = document.createElement('li');
      li.textContent = m.name;
      li.style.color = colorFor(m.id);
      if (m.id === me.id) {
        li.className = 'me';
        li.title = 'Click to change your name';
        li.style.cursor = 'pointer';
        li.onclick = () => {
          const name = (window.prompt('Your name', me.name) || '').trim().slice(0, 32);
          if (name && name !== me.name) { me.name = name; local.set('cs.name', name); conn.send({ t: 'rename', name }); }
        };
      }
      ul.appendChild(li);
    }
    $('memberCount').textContent = String(members.length);
  }

  // ------------------------------------------------------------------ toast
  let toastTimer = null;
  function toast(text, ms = 3000) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ------------------------------------------------------------------ routing / landing
  const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
  const roomFromPath = () => { const m = location.pathname.match(/^\/r\/([^/?#]+)/); return m && ROOM_RE.test(m[1]) ? m[1] : null; };

  function parseCode(input) {
    const s = input.trim();
    const m = s.match(/\/r\/([A-Za-z0-9_-]{3,32})/);
    if (m) return m[1];
    return ROOM_RE.test(s) ? s : null;
  }

  function saveName() {
    const n = $('nameInput').value.trim().slice(0, 32);
    if (n) { me.name = n; local.set('cs.name', n); }
  }

  function enterRoom(id) {
    roomId = id;
    if (location.pathname !== '/r/' + id) history.pushState(null, '', '/r/' + id);
    document.title = 'Teleshare · ' + id;
    $('landing').hidden = true;
    $('roomView').hidden = false;
    conn.connect();
  }

  $('createBtn').onclick = async () => {
    saveName();
    try {
      const r = await fetch('/api/new-room', { cache: 'no-store' });
      const { room } = await r.json();
      enterRoom(room);
    } catch (_) {
      enterRoom(randId(8)); // server unreachable right now; the room is created on first join anyway
    }
  };
  $('joinForm').onsubmit = (e) => {
    e.preventDefault();
    const code = parseCode($('codeInput').value);
    if (!code) { $('landingError').textContent = 'That room code doesn\'t look right.'; $('landingError').hidden = false; return; }
    saveName();
    enterRoom(code);
  };
  window.addEventListener('popstate', () => location.reload());

  // Boot
  $('nameInput').value = me.name;
  const initial = roomFromPath();
  if (initial && me.name) enterRoom(initial);
  else {
    $('landing').hidden = false;
    if (initial) { $('codeInput').value = initial; $('nameInput').focus(); }
  }
})();
