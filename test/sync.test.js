'use strict';
// Protocol tests: spin up the server on a random port and drive it with raw WebSocket clients.
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { server, classifyUrl } = require('../server');

let port;
test.before(() => new Promise((r) => server.listen(0, () => { port = server.address().port; r(); })));
test.after(() => new Promise((r) => server.close(r)));

function client(room, name, clientId, extra = {}) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const c = {
    ws, inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred, ms = 2000) {
      const hit = inbox.find(pred);
      if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((res, rej) => {
        const w = { pred, res: (m) => { clearTimeout(t); inbox.splice(inbox.indexOf(m), 1); res(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting')); }, ms);
        waiters.push(w);
      });
    },
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
  c.ready = new Promise((r) => ws.once('open', r)).then(() => {
    c.send({ t: 'join', room, name, clientId, ...extra });
    return c.next((m) => m.t === 'welcome');
  });
  return c;
}

test('url classification', () => {
  assert.strictEqual(classifyUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ');
  assert.strictEqual(classifyUrl('https://youtu.be/dQw4w9WgXcQ?t=3').videoId, 'dQw4w9WgXcQ');
  assert.strictEqual(classifyUrl('https://example.com/a.mp4').kind, 'file');
  assert.strictEqual(classifyUrl('javascript:alert(1)'), null);
  assert.strictEqual(classifyUrl('not a url'), null);
});

test('clock ping/pong', async () => {
  const a = client('clockroom', 'A', 'clientAAAA1');
  await a.ready;
  const c = Date.now();
  a.send({ t: 'ping', c });
  const p = await a.next((m) => m.t === 'pong');
  assert.strictEqual(p.c, c);
  assert.ok(Math.abs(p.s - Date.now()) < 1000);
  await a.close();
});

test('play/pause/seek propagate with increasing versions', async () => {
  const a = client('room1', 'Alice', 'aliceid0001');
  const b = client('room1', 'Bob', 'bobid000001');
  await Promise.all([a.ready, b.ready]);

  a.send({ t: 'load', url: 'https://example.com/movie.mp4' });
  const s1 = (await b.next((m) => m.t === 'state')).state;
  assert.strictEqual(s1.media.kind, 'file');
  assert.strictEqual(s1.playing, false);

  b.send({ t: 'control', action: 'play', position: 12.5, mediaUrl: s1.media.url });
  const s2 = (await a.next((m) => m.t === 'state' && m.state.version > s1.version)).state;
  assert.strictEqual(s2.playing, true);
  assert.strictEqual(s2.position, 12.5);
  assert.strictEqual(s2.by, 'Bob');

  a.send({ t: 'control', action: 'seek', position: 100, mediaUrl: s1.media.url });
  const s3 = (await b.next((m) => m.t === 'state' && m.state.version > s2.version)).state;
  assert.strictEqual(s3.position, 100);
  assert.strictEqual(s3.playing, true);

  a.send({ t: 'control', action: 'pause', position: 101, mediaUrl: s1.media.url });
  const s4 = (await b.next((m) => m.t === 'state' && m.state.version > s3.version)).state;
  assert.strictEqual(s4.playing, false);
  assert.ok(s4.version > s3.version);

  // A control aimed at an old video is dropped.
  a.send({ t: 'load', url: 'https://example.com/other.mp4' });
  const s5 = (await b.next((m) => m.t === 'state' && m.state.version > s4.version)).state;
  b.send({ t: 'control', action: 'play', position: 5, mediaUrl: 'https://example.com/movie.mp4' });
  await assert.rejects(b.next((m) => m.t === 'state' && m.state.version > s5.version, 400));

  await Promise.all([a.close(), b.close()]);
});

test('late joiner gets current state and chat history', async () => {
  const a = client('room2', 'Alice', 'aliceid0002');
  await a.ready;
  a.send({ t: 'load', url: 'https://youtu.be/dQw4w9WgXcQ' });
  const s = (await a.next((m) => m.t === 'state')).state;
  a.send({ t: 'control', action: 'play', position: 30, mediaUrl: s.media.url });
  await a.next((m) => m.t === 'state' && m.state.playing);
  a.send({ t: 'chat', id: 'msg0000001', text: 'hello' });
  await a.next((m) => m.t === 'chat' && m.msg.text === 'hello');

  const b = client('room2', 'Bob', 'bobid000002');
  const w = await b.ready;
  assert.strictEqual(w.state.playing, true);
  assert.strictEqual(w.state.media.videoId, 'dQw4w9WgXcQ');
  assert.ok(w.chat.some((c) => c.text === 'hello'));
  assert.strictEqual(w.members.length, 2);
  await Promise.all([a.close(), b.close()]);
});

test('chat retry with same id is not duplicated; text is sanitized', async () => {
  const a = client('room3', 'Alice', 'aliceid0003');
  await a.ready;
  a.send({ t: 'chat', id: 'dupe000001', text: '  hi <b>there</b>\u0007 ' });
  a.send({ t: 'chat', id: 'dupe000001', text: 'hi again' });
  const m = await a.next((x) => x.t === 'chat' && !x.msg.system);
  assert.strictEqual(m.msg.text, 'hi <b>there</b>'); // stored as text; client renders with textContent
  await assert.rejects(a.next((x) => x.t === 'chat' && !x.msg.system, 300));
  await a.close();
});

test('reconnect with same clientId replaces the old socket (no ghost members)', async () => {
  const a1 = client('room4', 'Alice', 'aliceid0004');
  const b = client('room4', 'Bob', 'bobid000004');
  await Promise.all([a1.ready, b.ready]);
  const closed = new Promise((r) => a1.ws.once('close', (code) => r(code)));
  const a2 = client('room4', 'Alice', 'aliceid0004', { rejoin: true });
  const w = await a2.ready;
  assert.strictEqual(await closed, 4000);
  assert.strictEqual(w.members.length, 2);
  const mem = await b.next((m) => m.t === 'members' && m.members.length === 2);
  assert.deepStrictEqual(mem.members.map((x) => x.name).sort(), ['Alice', 'Bob']);
  await Promise.all([a2.close(), b.close()]);
});

test('room pauses itself when everyone leaves', async () => {
  const a = client('room5', 'Alice', 'aliceid0005');
  await a.ready;
  a.send({ t: 'load', url: 'https://example.com/m.mp4' });
  const s = (await a.next((m) => m.t === 'state')).state;
  a.send({ t: 'control', action: 'play', position: 10, mediaUrl: s.media.url });
  await a.next((m) => m.t === 'state' && m.state.playing);
  await new Promise((r) => setTimeout(r, 300));
  await a.close();
  await new Promise((r) => setTimeout(r, 100));
  const b = client('room5', 'Bob', 'bobid000005');
  const w = await b.ready;
  assert.strictEqual(w.state.playing, false);
  assert.ok(w.state.position >= 10.2 && w.state.position < 11, `position ${w.state.position}`);
  await b.close();
});

test('rejects bad input', async () => {
  const a = client('room6', 'A', 'aaaaaaaaaa6');
  await a.ready;
  a.send({ t: 'load', url: 'file:///etc/passwd' });
  const e = await a.next((m) => m.t === 'error');
  assert.match(e.text, /valid/);
  const bad = client('../etc', 'X', 'xxxxxxxxxx6');
  bad.ready.catch(() => {}); // never welcomed
  const e2 = await bad.next((m) => m.t === 'error');
  assert.match(e2.text, /room/i);
  await Promise.all([a.close(), bad.close()]);
});
