// popup.js — show authenticated bridge status and configure the WS port/token.
// Both values are stored in chrome.storage.local; background.js restricts that
// storage area to trusted extension contexts and authenticates before commands.
const statusEl = document.getElementById('status');
const portEl = document.getElementById('port');
const tokenEl = document.getElementById('token');
const saveBtn = document.getElementById('save');
const STORAGE_PORT_KEY = 'pi_ws_port';
const STORAGE_TOKEN_KEY = 'pi_ws_token';
const DEFAULT_PORT = 19222;

function statusLabel(value) {
  return {
    connected: '已认证连接',
    authenticating: '认证中',
    connecting: '重连中',
    disconnected: '断开',
    unconfigured: '未配置 token',
    'auth-failed': '认证失败（检查 token）',
  }[value] || value;
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ cmd: 'status' });
    const state = response?.ok ? response.data : 'disconnected';
    statusEl.textContent = '状态: ' + statusLabel(state);
    statusEl.style.color = state === 'connected' ? '#16a34a' : state === 'authenticating' || state === 'connecting' ? '#d97706' : '#dc2626';
  } catch {
    statusEl.textContent = '状态: 断开';
    statusEl.style.color = '#dc2626';
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'pi_bridge_status') refreshStatus();
});

chrome.storage.local.get([STORAGE_PORT_KEY, STORAGE_TOKEN_KEY]).then((stored) => {
  const port = Number(stored[STORAGE_PORT_KEY]);
  portEl.value = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
  tokenEl.value = typeof stored[STORAGE_TOKEN_KEY] === 'string' ? stored[STORAGE_TOKEN_KEY] : '';
});

saveBtn.addEventListener('click', async () => {
  const port = Number(portEl.value);
  const token = tokenEl.value.trim();
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    statusEl.textContent = '端口无效';
    return;
  }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    statusEl.textContent = 'Token 无效：请完整复制配置文件中的 token';
    return;
  }
  await chrome.storage.local.set({ [STORAGE_PORT_KEY]: port, [STORAGE_TOKEN_KEY]: token });
  // Reload is the simplest reliable way to replace an MV3 worker WebSocket.
  chrome.runtime.reload();
});

refreshStatus();
