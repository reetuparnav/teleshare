'use strict';
/**
 * Watch Party server.
 *
 * - Serves the static client from ./public
 * - Runs a WebSocket hub at /ws that owns the authoritative playback state per room.
 *
 * Sync model: the server stores {playing, position, updatedAt} where updatedAt is the
 * server's clock. Every client estimates the server clock (NTP-style ping/pong) and
 * computes where playback *should* be right now, then nudges its player toward that.
 * Each state change bumps a version number so stale or duplicated updates are ignored.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHAT_HISTORY = 200;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 15000;
const MAX_MSG_BYTES = 8 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- helpers ----------
const now = () => Date.now();
const newId = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  // strip control chars, collapse whitespace at the ends
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
}

function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/);
      if (m) return m[2];
    }
  } catch (_) { /* fallthrough */ }
  return null;
}

function classifyUrl(raw) {
  const url = cleanText(raw, 2048);
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const yt = youtubeId(url);
  if (yt && /^[A-Za-z0-9_-]{6,20}$/.test(yt)) return { kind: 'youtube', url, videoId: yt };
  return { kind: 'file', url };
}

// ---------- rooms ----------
/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(id) {
    this.id = id;
    this.clients = new Set();
    this.chat = [];
    this.goneIds = new Set();
    this.emptySince = now();
    this.state = {
      media: null, // {kind, url, videoId?}
      playing: false,
      position: 0, // seconds, at updatedAt
      updatedAt: now(), // server ms
      rate: 1,
      version: 0,
      by: null,
    };
  }

  /** Where playback is right now according to the server. */
  currentPosition(at = now()) {
    const s = this.state;
    return s.playing ? s.position + ((at - s.updatedAt) / 1000) * s.rate : s.position;
  }

  members() {
    return [...this.clients].map((c) => ({ id: c.id, name: c.name }));
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c !== except && c.ws.readyState === 1) c.ws.send(data);
    }
  }

  setState(patch, byClient) {
    Object.assign(this.state, patch, {
      updatedAt: now(),
      version: this.state.version + 1,
      by: byClient ? byClient.name : null,
    });
    this.broadcast({ t: 'state', state: this.state });
  }

  addChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.broadcast({ t: 'chat', msg });
  }

  system(text) {
    this.addChat({ id: newId(12), system: true, text, ts: now() });
  }
}

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) { r = new Room(id); rooms.set(id, r); }
  return r;
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);

  if (p === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (p === '/api/new-room') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ room: newId(8) }));
  }
  // Room links (/r/abc123) and the root both serve the app shell.
  if (p === '/' || p.startsWith('/r/')) p = '/index.html';

  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws) => {
  const client = { ws, id: null, name: null, room: null, chatTimes: [] };

  const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const fail = (text) => send({ t: 'error', text });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;

    // Clock sync works before joining.
    if (m.t === 'ping') return send({ t: 'pong', c: m.c, s: now() });

    if (m.t === 'join') {
      const roomId = cleanText(m.room, 32);
      if (!ROOM_RE.test(roomId)) return fail('Invalid room code.');
      if (client.room) leave(client);
      client.id = /^[A-Za-z0-9_-]{6,32}$/.test(m.clientId || '') ? m.clientId : newId(12);
      client.name = cleanText(m.name, 32) || 'Guest-' + client.id.slice(0, 4);
      const room = getRoom(roomId);

      // Same browser tab reconnecting (or a second tab with the same id): drop the stale socket
      // so we never show ghost members.
      for (const other of room.clients) {
        if (other.id === client.id) { room.clients.delete(other); try { other.ws.close(4000, 'replaced'); } catch (_) {} }
      }
      const isRejoin = m.rejoin === true;
      room.clients.add(client);
      room.emptySince = null;
      client.room = room;

      send({
        t: 'welcome',
        you: { id: client.id, name: client.name },
        room: room.id,
        state: room.state,
        chat: room.chat,
        members: room.members(),
        serverTime: now(),
      });
      room.broadcast({ t: 'members', members: room.members() });
      if (!isRejoin) room.system(`${client.name} joined`);
      else if (room.goneIds.has(client.id)) room.system(`${client.name} is back`);
      room.goneIds.delete(client.id);
      return;
    }

    const room = client.room;
    if (!room) return fail('Join a room first.');

    switch (m.t) {
      case 'load': {
        let media = classifyUrl(m.url);
        if (!media) return fail('That doesn\'t look like a valid http(s) video link.');
        // From the browser extension: the video plays on a website (Netflix, etc.), not in our player.
        if (m.page === true) {
          media = { kind: 'page', url: media.url, title: cleanText(m.title, 120) || new URL(media.url).hostname };
        }
        const startAt = media.kind === 'page' && isFiniteNum(m.position) && m.position >= 0 ? m.position : 0;
        const startPlaying = media.kind === 'page' && m.playing === true;
        room.setState({ media, playing: startPlaying, position: startAt, rate: 1 }, client);
        room.system(media.kind === 'page' ? `${client.name} started watching ${media.title}` : `${client.name} loaded a new video`);
        break;
      }
      case 'control': {
        if (!room.state.media) return;
        // Drop controls aimed at a video that is no longer loaded (e.g. a click racing a new load).
        if (m.mediaUrl && m.mediaUrl !== room.state.media.url) return;
        const pos = isFiniteNum(m.position) && m.position >= 0 ? m.position : room.currentPosition();
        if (m.action === 'play') room.setState({ playing: true, position: pos }, client);
        else if (m.action === 'pause') room.setState({ playing: false, position: pos }, client);
        else if (m.action === 'seek') room.setState({ position: pos }, client);
        else if (m.action === 'rate' && isFiniteNum(m.rate) && m.rate >= 0.25 && m.rate <= 2) {
          room.setState({ position: room.currentPosition(), rate: m.rate }, client);
        }
        break;
      }
      case 'ended': {
        // A client reached the end of the video: pause everyone at that point so the room
        // doesn't keep "playing" past the end forever.
        if (room.state.playing && isFiniteNum(m.position) && room.state.media && m.mediaUrl === room.state.media.url) {
          room.setState({ playing: false, position: m.position }, null);
        }
        break;
      }
      case 'chat': {
        const text = cleanText(m.text, 500);
        if (!text) return;
        const t = now();
        client.chatTimes = client.chatTimes.filter((x) => t - x < 5000);
        if (client.chatTimes.length >= 8) return fail('Slow down a little.');
        client.chatTimes.push(t);
        // Client-provided id lets the sender dedupe its optimistic copy and lets retries after a
        // reconnect be idempotent.
        const id = /^[A-Za-z0-9_-]{6,32}$/.test(m.id || '') ? m.id : newId(12);
        if (room.chat.some((c) => c.id === id)) return;
        room.addChat({ id, from: client.id, name: client.name, text, ts: t });
        break;
      }
      case 'rename': {
        const name = cleanText(m.name, 32);
        if (!name || name === client.name) return;
        const old = client.name;
        client.name = name;
        room.broadcast({ t: 'members', members: room.members() });
        room.system(`${old} is now ${name}`);
        break;
      }
    }
  });

  ws.on('close', () => leave(client));
  ws.on('error', () => {});
});

function leave(client) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  if (!room.clients.has(client)) return; // already replaced by a newer socket
  room.clients.delete(client);
  room.broadcast({ t: 'members', members: room.members() });
  // Grace period: a quick network blip + auto-reconnect shouldn't spam "left / joined".
  setTimeout(() => {
    if ([...room.clients].some((c) => c.id === client.id)) return;
    room.goneIds.add(client.id);
    room.system(`${client.name} left`);
  }, 5000).unref();
  if (room.clients.size === 0) {
    room.emptySince = now();
    // Nobody is watching: freeze playback so the next person doesn't land 20 minutes later.
    if (room.state.playing) {
      Object.assign(room.state, { playing: false, position: room.currentPosition(), updatedAt: now(), version: room.state.version + 1 });
    }
  }
}

// Heartbeat: detect dead connections (laptop lid closed, network dropped) so member lists stay true.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._wpAlive === false) { ws.terminate(); continue; }
    ws._wpAlive = false;
    ws.ping();
  }
  const t = now();
  for (const [id, r] of rooms) {
    if (r.clients.size === 0 && r.emptySince && t - r.emptySince > EMPTY_ROOM_TTL_MS) rooms.delete(id);
  }
}, HEARTBEAT_MS);
heartbeat.unref();
wss.on('connection', (ws) => {
  ws._wpAlive = true;
  ws.on('pong', () => { ws._wpAlive = true; });
  ws.on('message', () => { ws._wpAlive = true; });
});
wss.on('close', () => clearInterval(heartbeat));

if (require.main === module) {
  server.listen(PORT, () => console.log(`Watch Party running at http://localhost:${PORT}`));
}

module.exports = { server, rooms, classifyUrl, youtubeId };
