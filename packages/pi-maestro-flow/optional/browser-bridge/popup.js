// popup.js — zero-config discovery/pairing status with legacy manual settings.
const statusEl = document.getElementById('status');
const pairingEl = document.getElementById('pairing');
const pairingCodeEl = document.getElementById('pairing-code');
const pairingRequestEl = document.getElementById('pairing-request');
const portEl = document.getElementById('port');
const tokenEl = document.getElementById('token');
const saveBtn = document.getElementById('save');
const STORAGE_PORT_KEY = 'pi_ws_port';
const STORAGE_TOKEN_KEY = 'pi_ws_token';
const STORAGE_INSTALLATION_KEY = 'pi_ws_installation_id';
const DEFAULT_PORT = 19222;

function statusLabel(value) {
  return {
    connected: '已认证连接',
    discovering: '正在自动发现（19222–19231）',
    'pairing-pending': '已发现，等待配对确认',
    'saving-credentials': '正在安全保存凭证',
    connecting: '正在认证连接',
    disconnected: '已断开，将自动重试',
    'not-found': '未发现 Pi 服务，将自动重试',
    'pairing-failed': '配对失败，请等待新的配对码',
    'auth-failed': '认证失败（可在高级设置中检查旧版 token）',
  }[value] || value;
}

function statusColor(value) {
  if (value === 'connected') return '#16a34a';
  if (['discovering', 'pairing-pending', 'saving-credentials', 'connecting'].includes(value)) return '#d97706';
  return '#dc2626';
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ cmd: 'status' });
    const state = response?.ok ? response.data : 'disconnected';
    statusEl.textContent = '状态: ' + statusLabel(state);
    statusEl.style.color = statusColor(state);
    const pending = response?.pairing;
    if (state === 'pairing-pending' && pending?.requestId && pending?.code) {
      pairingEl.style.display = 'block';
      pairingCodeEl.textContent = pending.code;
      pairingRequestEl.textContent = `requestId: ${pending.requestId} · port: ${pending.port}`;
    } else {
      pairingEl.style.display = 'none';
      pairingCodeEl.textContent = '';
      pairingRequestEl.textContent = '';
    }
  } catch {
    statusEl.textContent = '状态: 后台服务不可用';
    statusEl.style.color = '#dc2626';
    pairingEl.style.display = 'none';
  }
}

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
  // Manual override intentionally clears any auto-paired server identity so the
  // legacy port/token path can authenticate a different installation.
  await chrome.storage.local.set({
    [STORAGE_PORT_KEY]: port,
    [STORAGE_TOKEN_KEY]: token,
    [STORAGE_INSTALLATION_KEY]: '',
  });
  chrome.runtime.reload();
});

refreshStatus();
const refreshTimer = setInterval(refreshStatus, 750);
window.addEventListener('unload', () => clearInterval(refreshTimer), { once: true });
