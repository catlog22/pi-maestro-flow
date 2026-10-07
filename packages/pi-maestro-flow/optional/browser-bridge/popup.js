// Popup reads live per-listener state; no credential value is ever rendered.
const statusEl = document.getElementById('status');
const connectionsEl = document.getElementById('connections');
const portEl = document.getElementById('port');
const tokenEl = document.getElementById('token');
const saveBtn = document.getElementById('save');
const CUSTOM_PORTS_KEY = 'pi_bridge_custom_ports_v1';

function statusLabel(connection) {
  if (connection.ready) return connection.authenticated ? '已认证连接' : '已连接（无授权）';
  return {
    discovering: '正在发现', 'pairing-pending': '等待配对确认',
    'saving-credentials': '正在保存凭证', connecting: '正在连接',
    disconnected: '已断开，将重试', 'not-found': '未发现服务',
    'pairing-failed': '配对失败', 'auth-failed': '认证失败',
  }[connection.status] || connection.status;
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ cmd: 'status' });
    connectionsEl.replaceChildren();
    const connections = response?.ok && Array.isArray(response.connections) ? response.connections : [];
    statusEl.textContent = connections.some((connection) => connection.ready) ? '状态: 已连接' : '状态: 正在发现 / 等待连接';
    for (const connection of connections) {
      const row = document.createElement('div');
      row.className = 'connection';
      const label = document.createElement('div');
      label.textContent = `端口 ${connection.port} · ${connection.authMode === 'none' ? 'NONE 无授权' : 'PAIRED 配对'} · ${statusLabel(connection)}`;
      label.style.color = connection.ready ? '#16a34a' : '#d97706';
      row.append(label);
      if (connection.authMode === 'paired' && connection.status === 'pairing-pending' && connection.pairing?.requestId && connection.pairing?.code) {
        const pairing = document.createElement('div');
        pairing.className = 'pairing';
        pairing.textContent = `配对码: ${connection.pairing.code} · requestId: ${connection.pairing.requestId}。使用 browser pair 确认；批准前不能执行命令。`;
        row.append(pairing);
      }
      if (connection.error) {
        const error = document.createElement('div');
        error.className = 'meta';
        error.textContent = connection.error;
        row.append(error);
      }
      connectionsEl.append(row);
    }
  } catch {
    statusEl.textContent = '状态: 后台服务不可用';
    connectionsEl.replaceChildren();
  }
}

chrome.storage.local.get([CUSTOM_PORTS_KEY, 'pi_ws_port']).then((stored) => {
  const ports = Array.isArray(stored[CUSTOM_PORTS_KEY]) ? stored[CUSTOM_PORTS_KEY] : [stored.pi_ws_port].filter(Number.isInteger);
  portEl.value = ports.join(', ');
  // Leave token empty, even when a historical paired credential exists.
});

saveBtn.addEventListener('click', async () => {
  const ports = [...new Set(portEl.value.split(/[\s,]+/).filter(Boolean).map(Number))];
  if (ports.some((port) => !Number.isInteger(port) || port <= 0 || port > 65535)) {
    statusEl.textContent = '端口无效'; return;
  }
  const token = tokenEl.value.trim();
  if (token && (!/^[A-Za-z0-9_-]{32,}$/.test(token) || ports.length !== 1)) {
    statusEl.textContent = '旧版 Token 需完整且只能指定一个端口'; return;
  }
  try {
    if (token) {
      await chrome.storage.local.set({ pi_ws_port: ports[0], pi_ws_token: token, pi_ws_installation_id: '' });
      tokenEl.value = '';
      chrome.runtime.reload();
      return;
    }
    const response = await chrome.runtime.sendMessage({ cmd: 'bridge_configure', ports });
    if (!response?.ok) throw new Error(response?.error || '配置失败');
    await refreshStatus();
  } catch (error) { statusEl.textContent = String(error.message || error); }
});

refreshStatus();
const refreshTimer = setInterval(refreshStatus, 750);
window.addEventListener('unload', () => clearInterval(refreshTimer), { once: true });
