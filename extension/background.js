// Relays messages between the top page (which runs the party) and embedded iframes in the
// same tab. Going through the extension instead of window.postMessage means the website's
// own scripts can't fake or eavesdrop on them.
chrome.runtime.onMessage.addListener((m, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || !m) return false;
  if (m.__ts === 'up' && sender.frameId !== 0) {
    chrome.tabs.sendMessage(tabId, { __ts: 'up', frameId: sender.frameId, msg: m.msg }, { frameId: 0 }).catch(() => {});
  } else if (m.__ts === 'down' && sender.frameId === 0) {
    const out = { __ts: 'down', msg: m.msg };
    if (m.frameId === 'all') chrome.tabs.sendMessage(tabId, out).catch(() => {});
    else if (Number.isInteger(m.frameId)) chrome.tabs.sendMessage(tabId, out, { frameId: m.frameId }).catch(() => {});
  }
  return false;
});
