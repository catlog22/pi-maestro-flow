// content.js — status badge injected into every page so the user can see at a
// glance whether the pi bridge is connected. Isolated world (default); it only
// talks to the service worker via chrome.runtime messages and injects one DOM node.
(function () {
  if (window.self !== window.top) return; // badge lives on the top frame only
  const d = document.createElement('div');
  d.textContent = 'pi-bridge: ...';
  d.style.cssText =
    'position:fixed;bottom:8px;right:8px;background:#888;color:#fff;' +
    'padding:4px 7px;border-radius:4px;font-size:11px;font-weight:bold;' +
    'z-index:2147483647;box-shadow:0 2px 4px rgba(0,0,0,0.2);opacity:0.2;pointer-events:none;';
  const STATE = {
    connected: ['已连接', '#16a34a'],
    connecting: ['重连中', '#f59e0b'],
    disconnected: ['断开', '#dc2626'],
  };
  const render = (s) => {
    const [t, c] = STATE[s] || STATE.disconnected;
    d.textContent = 'pi-bridge: ' + t;
    d.style.background = c;
  };
  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'pi_bridge_status') render(m.data);
  });
  chrome.runtime.sendMessage({ cmd: 'status' }, (r) => render(r?.ok ? r.data : 'disconnected'));
  (document.body || document.documentElement).appendChild(d);
})();
