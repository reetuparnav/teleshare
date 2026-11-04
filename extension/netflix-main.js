// Runs in Netflix's own page context. Setting video.currentTime directly makes Netflix's player
// crash (error M7375), so seeks go through Netflix's internal player API instead.
(() => {
  'use strict';
  function nfPlayer() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const id = ids.find((x) => x.startsWith('watch')) || ids[ids.length - 1];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch (_) { return null; }
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__teleshare !== 'nf-seek') return;
    const p = nfPlayer();
    if (p && Number.isFinite(e.data.ms)) p.seek(Math.max(0, Math.round(e.data.ms)));
  });
})();
