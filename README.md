# Teleshare

Watch videos with friends, in sync, with a shared chat. Paste a YouTube link or a direct
video file URL (`.mp4`, `.webm`, …), send the invite link, and everyone's playback stays together.

## Run it

Requires Node.js 18+.

```bash
npm install
npm start            # http://localhost:3000  (set PORT to change)
npm test             # protocol tests
```

**Put it online (free):** [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/reetuparnav/teleshare)
Sign in with GitHub, click **Deploy**, and you get an address like `https://teleshare-xxxx.onrender.com`.
Put that address in the extension's Settings → Server (and in `DEFAULT_SERVER` in
`extension/content.js` and `extension/popup.js` if you want it to be the default). The free plan sleeps after 15 minutes
without visitors, so the first person to join may wait about a minute while it wakes up.

To watch with friends who aren't on your network, deploy it anywhere that runs Node and allows
WebSockets (Render, Railway, Fly.io, a VPS). For a quick test, run
`cloudflared tunnel --url http://localhost:3000` and share that URL.

## Browser extension (Netflix, Prime Video, Disney+, any site)

The `extension/` folder is a Chrome extension (also works in Edge, Brave, Arc, Opera). It syncs
the video on whatever site you're on, using the same server, with a chat sidebar on the page.

**Install (until it's published to the Chrome Web Store):**
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension` folder.
3. Click the Teleshare icon in the toolbar, open **Settings**, and enter your name and the
   server address (for example your deployed `https://teleshare.example.com`). Everyone in a
   party must reach the same server, so `localhost` only works for testing on one machine.

**Use it:**
1. Open the episode or video, press play, click the Teleshare icon and choose **Start a party on this tab**.
2. Click **🔗 Invite** in the sidebar and send the link. Friends open it, click
   **Open it with the Teleshare extension**, and land on the same video already in sync.
3. Use the site's own play, pause and seek controls as usual. Everyone follows.
4. For the next episode, go to it and click **Bring everyone here** in the sidebar. Everyone
   else's tab follows automatically.

Each viewer needs their own account for the streaming site. Teleshare only syncs, it never
shares the stream.

**How the extension avoids the classic bugs:** a play, pause or seek only counts as yours if it
follows a real click or key press and disagrees with the room. The site's own autoplay,
buffering pauses and Teleshare's corrections are never broadcast, so nobody gets paused by a
ghost. Videos inside embedded players from other sites (common on anime and aggregator sites)
are found and synced too: the page and the embed talk through the extension, so the site
can't forge those messages. On Netflix, seeks go through Netflix's own player API, because setting the video time
directly crashes Netflix's player (error M7375).

## How it works

- `server.js` serves the web app and runs a WebSocket hub at `/ws`. Each room has one
  authoritative playback state: `{media, playing, position, updatedAt, rate, version}`.
- Each browser estimates the server's clock with ping/pong (keeping the lowest-latency sample),
  computes where the video *should* be right now, and steers its player there.

## Bugs it's designed to avoid

| Common watch-party bug | What Teleshare does |
| --- | --- |
| Play/pause "ping-pong" loops between viewers | Only clicks on Teleshare's own controls send commands. Changes the app makes to the player never echo back. |
| Slowly drifting apart | Every 250 ms the client compares itself to the room clock. Small drift is fixed by speeding up or slowing down by up to 8%, which you won't notice. Big drift (over 1 s) gets one seek. |
| Endless seeking / stutter on slow connections | A cooldown after every seek, and no corrections while the player is buffering. If it still can't keep up, the viewer is told. |
| Out-of-order or stale updates | Every state change has a version number. Older versions are ignored. |
| Disconnects silently break the party | App-level heartbeats detect dead connections in about 12 s. Reconnect uses backoff with jitter and kicks in immediately when the network comes back or the tab wakes. On reconnect the full state and chat history are re-sent. |
| Messages lost while offline | Chat appears instantly (dimmed until delivered), is retried after reconnect, and is de-duplicated by id on the server. |
| Ghost members after a refresh | Each tab has a stable id. A reconnect replaces the old connection instead of adding a duplicate. Brief blips don't spam "left/joined". |
| Late joiners start in the wrong place | Joiners get the live position, computed from the server clock. |
| Browser blocks autoplay, viewer silently falls behind | Shown as "Click to join playback". One click puts them back in sync. |
| Empty room keeps "playing" | When the last person leaves, the room pauses where it was. |

## Limits of this MVP

- The website player handles YouTube and direct video links. Streaming services need the extension.
- Hardware media keys (headphone buttons) aren't recognised as your action, so the room reverts them.
- Not yet tested against live Netflix/Prime/Disney+ pages (only against a stand-in site with a strict security policy).
- Rooms live in memory. Restarting the server clears them.
- Anyone in a room can control playback. There's no host-only mode yet.
- Direct video links must allow range requests (all normal hosts/CDNs do) for seeking to work.
