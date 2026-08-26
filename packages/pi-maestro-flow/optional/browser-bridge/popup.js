// popup.js — show bridge status and let the user set the WS port (persisted to
// chrome.storage.local key "pi_ws_port"). Saving triggers a reconnect attempt.
const statusEl = document.getElementById('status');
const portEl = document.getElementById('port');
const saveBtn = document.getElementById('save');
const STORAGE_PORT_KEY = 'pi_ws_port';
const DEFAULT_PORT = 19222;

function portLabel(s) {
  return { connected: '已连接', connecting: '重连中', disconnected: '断开' }[s] || s;
}

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ cmd: 'status' });
    statusEl.textContent = '状态: ' + (resp?.ok ? portLabel(resp.data) : '断开');
    statusEl.style.color = resp?.data === 'connected' ? '#16a34a' : '#dc2626';
  } catch {
    statusEl.textContent = '状态: 断开';
  }
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'pi_bridge_status') refreshStatus();
});

chrome.storage.local.get(STORAGE_PORT_KEY).then((stored) => {
  const p = Number(stored[STORAGE_PORT_KEY]);
  portEl.value = Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT;
});

saveBtn.addEventListener('click', async () => {
  const p = Number(portEl.value);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    statusEl.textContent = '端口无效';
    return;
  }
  await chrome.storage.local.set({ [STORAGE_PORT_KEY]: p });
  // Force reconnect by reloading the service worker (simplest cross-MV3 approach).
  chrome.runtime.reload();
});

refreshStatus();
