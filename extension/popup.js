'use strict';
const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = 'http://localhost:3000';
let tabId = null;

function show(which) { for (const id of ['idle', 'active', 'unsupported']) $(id).hidden = id !== which; }
function error(text) { $('err').textContent = text || ''; $('err').hidden = !text; }

function send(msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (res) => resolve(chrome.runtime.lastError ? null : res));
  });
}

function render(status) {
  if (!status) return show('unsupported');
  if (status.active) {
    show('active');
    $('roomCode').textContent = status.room;
    $('connState').textContent = status.connected ? '' : '(connecting…)';
    $('invite').value = status.invite;
  } else {
    show('idle');
    $('videoHint').textContent = status.hasVideo ? 'Found a video on this page.' : 'No video found on this page yet. Start playing something first.';
    $('startBtn').disabled = !status.hasVideo;
  }
}

// Accepts a room code, a Teleshare link (https://server/r/CODE) or a site link with #teleshare=CODE.
function parseInvite(text) {
  const s = text.trim();
  let m = s.match(/^(https?:\/\/[^/]+)\/r\/([A-Za-z0-9_-]{3,32})/);
  if (m) return { room: m[2], server: m[1] };
  m = s.match(/[#&]teleshare=([A-Za-z0-9_-]{3,32})/);
  if (m) {
    const srv = s.match(/[#&]server=([^&]+)/);
    return { room: m[1], server: srv ? decodeURIComponent(srv[1]) : undefined };
  }
  return /^[A-Za-z0-9_-]{3,32}$/.test(s) ? { room: s } : null;
}

async function init() {
  const s = await chrome.storage.sync.get(['server', 'name']);
  $('server').value = s.server || DEFAULT_SERVER;
  $('name').value = s.name || '';
  if (!s.name) $('settings').open = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (!tab || !/^https?:/.test(tab.url || '')) return show('unsupported');
  render(await send({ cmd: 'status' }));
}

$('name').addEventListener('change', async () => {
  const name = $('name').value.trim().slice(0, 32);
  await chrome.storage.sync.set({ name });
  if (tabId != null) send({ cmd: 'rename', name });
});
$('server').addEventListener('change', async () => {
  let v = $('server').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(v)) { error('Server should look like https://your-server.example'); return; }
  error('');
  await chrome.storage.sync.set({ server: v });
});
$('startBtn').onclick = async () => {
  await chrome.storage.sync.set({ name: $('name').value.trim().slice(0, 32) });
  render(await send({ cmd: 'start' }));
};
$('joinForm').onsubmit = async (e) => {
  e.preventDefault();
  const inv = parseInvite($('code').value);
  if (!inv) { error('That invite doesn\'t look right.'); return; }
  error('');
  await chrome.storage.sync.set({ name: $('name').value.trim().slice(0, 32) });
  render(await send({ cmd: 'join', room: inv.room, server: inv.server }));
};
$('copyBtn').onclick = async () => {
  await navigator.clipboard.writeText($('invite').value);
  $('copyBtn').textContent = 'Copied';
  setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1500);
};
$('leaveBtn').onclick = async () => render(await send({ cmd: 'leave' }));

init();
