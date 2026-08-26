// background.js — Pi Browser Bridge service worker
//
// WebSocket client that connects back to the pi-maestro-flow agent
// (ws://127.0.0.1:<port>, default 19222, configurable via chrome.storage.local
// key "pi_ws_port"). Routes agent commands to chrome.* APIs:
//   exec | cdp | cookies | tabs | management | contentSettings | dnr | batch
//
// MV3 keepalive: chrome.alarms probes/reconnects while disconnected and pings
// while connected (under the ~30s service-worker timeout). Modeled on the
// GenericAgent tmwd_cdp_bridge extension but trimmed to pi's needs.

const DEFAULT_WS_PORT = 19222;
const STORAGE_PORT_KEY = 'pi_ws_port';

let ws = null;
let status = 'disconnected';
let wsPort = DEFAULT_WS_PORT;

function setStatus(s) {
  if (s === status) return;
  status = s;
  chrome.tabs.query({}).then((tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'pi_bridge_status', data: s }).catch(() => {});
  }).catch(() => {});
}

function scheduleProbe() {
  chrome.alarms.create('pi-ws-probe', { delayInMinutes: 0.083 }); // ~5s
}
function scheduleKeepalive() {
  chrome.alarms.create('pi-ws-keepalive', { delayInMinutes: 0.4 }); // ~24s
}

async function isServerAlive(port) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    await fetch(`http://127.0.0.1:${port}`, { signal: ctrl.signal });
    return true;
  } catch (e) {
    // A 4xx/5xx HTTP response still means the port is listening; only a
    // network error (connection refused / timeout) means the server is down.
    return e instanceof TypeError ? false : true;
  }
}

async function loadPort() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_PORT_KEY);
    const p = Number(stored[STORAGE_PORT_KEY]);
    wsPort = Number.isInteger(p) && p > 0 ? p : DEFAULT_WS_PORT;
  } catch {
    wsPort = DEFAULT_WS_PORT;
  }
}

// --- Command handlers (one per cmd field) ---

async function handleExec(msg) {
  // Execute JS in the page MAIN world via chrome.scripting; fall back to CDP
  // Runtime.evaluate for CSP-restricted pages. Returns {ok, data, newTabs}.
  const tabId = msg.tabId;
  if (!tabId) return { ok: false, error: 'exec requires tabId' };
  const newTabIds = new Set();
  const onCreated = (tab) => newTabIds.add(tab.id);
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    let res;
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (s) => eval(s),
        args: [wrapExecScript(msg.code)],
      });
      res = result[0]?.result;
      if (res === null || res === undefined) {
        res = { ok: false, error: 'executeScript returned null (possible CSP)', csp: true };
      }
    } catch (e) {
      res = { ok: false, error: e.message || String(e), csp: true };
    }
    if (res && !res.ok && res.csp) {
      // CDP fallback for CSP-restricted pages.
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        const cdpRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: wrapExecScript(msg.code, true),
          awaitPromise: true,
          returnByValue: true,
        });
        await chrome.debugger.detach({ tabId });
        if (cdpRes.exceptionDetails) {
          const desc = cdpRes.exceptionDetails.exception?.description || 'CDP error';
          res = { ok: false, error: desc };
        } else {
          res = cdpRes.result?.value ?? { ok: true, data: undefined };
        }
      } catch (cdpErr) {
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        res = { ok: false, error: 'CDP fallback failed: ' + (cdpErr.message || cdpErr) };
      }
    }
    if (newTabIds.size === 0) await new Promise((r) => setTimeout(r, 200));
    const newTabs = [];
    for (const id of newTabIds) {
      try { const t = await chrome.tabs.get(id); newTabs.push({ id: t.id, url: t.url, title: t.title }); } catch (_) {}
    }
    if (res?.ok) return { ok: true, data: res.data, newTabs };
    return { ok: false, error: res?.error || 'unknown exec error', newTabs };
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

// Wrap user JS so a bare last expression / await returns its value.
function wrapExecScript(code, forCdp = false) {
  const body = `(async () => {
    try {
      const jsCode = ${JSON.stringify(code)}.trim();
      const lines = jsCode.split(/\\r?\\n/).filter((l) => l.trim());
      const lastLine = lines.length ? lines[lines.length - 1].trim() : '';
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      let r;
      function autoReturn(c) {
        const ls = c.split(/\\r?\\n/);
        let i = ls.length - 1;
        while (i >= 0 && !ls[i].trim()) i--;
        if (i < 0) return c;
        const t = ls[i].trim();
        if (/^(return |return;|return$|let |const |var |if |if\\(|for |for\\(|while |while\\(|switch|try |throw |class |function |async |import |export |\\/\\/|})/.test(t)) return c;
        ls[i] = ls[i].match(/^(\\s*)/)[1] + 'return ' + t;
        return ls.join('\\n');
      }
      if (lastLine.startsWith('return')) {
        r = await new AsyncFunction(jsCode)();
      } else {
        try {
          r = eval(jsCode);
          if (r instanceof Promise) r = await r;
        } catch (e) {
          if (e instanceof SyntaxError && (/return/i.test(e.message) || /await/i.test(e.message))) {
            r = await new AsyncFunction(autoReturn(jsCode))();
          } else throw e;
        }
      }
      return { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  })()`;
  return forCdp ? body : body;
}

async function handleCdp(msg) {
  const tabId = msg.tabId;
  if (!tabId) return { ok: false, error: 'cdp requires tabId' };
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    const result = await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params || {});
    await chrome.debugger.detach({ tabId });
    return { ok: true, data: result };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    return { ok: false, error: e.message || String(e) };
  }
}

async function handleCookies(msg) {
  try {
    let url = msg.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(msg.tabId);
      url = tab.url;
    }
    if (!url) return { ok: false, error: 'cookies requires url or tabId' };
    const origin = (url.match(/^https?:\/\/[^/]+/) || [])[0] || url;
    const all = await chrome.cookies.getAll({ url });
    let part = [];
    try { part = await chrome.cookies.getAll({ url, partitionKey: { topLevelSite: origin } }); } catch (_) {}
    const merged = [...all];
    for (const c of part) {
      if (!merged.some((x) => x.name === c.name && x.domain === c.domain)) merged.push(c);
    }
    return { ok: true, data: merged };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function handleTabs(msg) {
  try {
    if (msg.method === 'create') {
      const tab = await chrome.tabs.create({
        url: msg.url,
        active: msg.active !== undefined ? msg.active : false,
        index: msg.index,
        windowId: msg.windowId,
        openerTabId: msg.openerTabId,
      });
      return { ok: true, data: { id: tab.id, url: tab.url, title: tab.title } };
    }
    if (msg.method === 'switch') {
      const tab = await chrome.tabs.update(msg.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    const tabs = (await chrome.tabs.query({})).filter((t) => isScriptable(t.url));
    return {
      ok: true,
      data: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function handleManagement(msg) {
  try {
    if (msg.method === 'list') {
      const all = await chrome.management.getAll();
      return { ok: true, data: all.map((e) => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type, version: e.version })) };
    }
    if (msg.method === 'disable') { await chrome.management.setEnabled(msg.extId, false); return { ok: true }; }
    if (msg.method === 'enable') { await chrome.management.setEnabled(msg.extId, true); return { ok: true }; }
    if (msg.method === 'reload') { chrome.alarms.create('pi-self-reload', { when: Date.now() + 200 }); return { ok: true }; }
    return { ok: false, error: 'unknown management method: ' + msg.method };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function handleContentSettings(msg) {
  try {
    const type = msg.type || 'automaticDownloads';
    const setting = msg.setting || 'allow';
    const pattern = msg.pattern || '<all_urls>';
    await chrome.contentSettings[type].set({ primaryPattern: pattern, setting });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function handleDnr(msg) {
  // Strip CSP response headers so injected MAIN-world scripts can use eval/inline.
  // Rule id 9999 is reserved for this; toggled by install/rollback.
  try {
    if (msg.method === 'enable') {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [9999],
        addRules: [{
          id: 9999, priority: 1,
          action: { type: 'modifyHeaders', responseHeaders: [
            { header: 'content-security-policy', operation: 'remove' },
            { header: 'content-security-policy-report-only', operation: 'remove' },
          ]},
          condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] },
        }],
      });
      return { ok: true };
    }
    if (msg.method === 'disable') {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [9999] });
      return { ok: true };
    }
    return { ok: false, error: 'unknown dnr method: ' + msg.method };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function handleBatch(msg) {
  const R = [];
  let attached = null;
  const resolve$N = (params) => JSON.parse(JSON.stringify(params || {}).replace(
    /"\$(\d+)\.([^"]+)"/g,
    (_, i, path) => {
      let v = R[+i];
      if (v && typeof v === 'object' && 'data' in v) v = v.data;
      for (const k of path.split('.')) v = v == null ? undefined : v[k];
      return JSON.stringify(v);
    },
  ));
  try {
    for (const c of msg.commands) {
      if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
      if (c.cmd === 'cookies') R.push(await handleCookies(c));
      else if (c.cmd === 'tabs') R.push(await handleTabs(c));
      else if (c.cmd === 'cdp') {
        const tabId = c.tabId || msg.tabId;
        if (attached !== tabId) {
          if (attached) { try { await chrome.debugger.detach({ tabId: attached }); } catch (_) {} attached = null; }
          await chrome.debugger.attach({ tabId }, '1.3');
          attached = tabId;
        }
        try {
          R.push({ ok: true, data: await chrome.debugger.sendCommand({ tabId }, c.method, resolve$N(c.params)) });
        } catch (e) {
          R.push({ ok: false, error: e.message || String(e) });
        }
      } else if (c.cmd === 'exec') {
        R.push(await handleExec(c));
      } else {
        R.push({ ok: false, error: 'unknown cmd in batch: ' + c.cmd });
      }
    }
    if (attached) { try { await chrome.debugger.detach({ tabId: attached }); } catch (_) {} }
    return { ok: true, results: R };
  } catch (e) {
    if (attached) { try { await chrome.debugger.detach({ tabId: attached }); } catch (_) {} }
    return { ok: false, error: e.message || String(e), results: R };
  }
}

async function dispatch(msg) {
  switch (msg.cmd) {
    case 'exec': return handleExec(msg);
    case 'cdp': return handleCdp(msg);
    case 'cookies': return handleCookies(msg);
    case 'tabs': return handleTabs(msg);
    case 'management': return handleManagement(msg);
    case 'contentSettings': return handleContentSettings(msg);
    case 'dnr': return handleDnr(msg);
    case 'batch': return handleBatch(msg);
    default: return { ok: false, error: 'unknown cmd: ' + msg.cmd };
  }
}

const isScriptable = (url) => Boolean(url) && /^https?:/.test(url);

// --- WebSocket connection ---

async function connectWS() {
  if (ws && ws.readyState <= 1) return; // CONNECTING or OPEN
  await loadPort();
  ws = null;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    setStatus('connecting');
  } catch (e) {
    ws = null;
    scheduleProbe();
    return;
  }
  ws.onopen = async () => {
    setStatus('connected');
    scheduleKeepalive();
    const tabs = (await chrome.tabs.query({})).filter((t) => isScriptable(t.url));
    ws.send(JSON.stringify({
      type: 'ext_ready',
      tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
    }));
  };
  ws.onmessage = async (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'ping') return; // keepalive ping; no reply needed
    if (data.id && data.cmd) {
      try { ws.send(JSON.stringify({ type: 'ack', id: data.id })); } catch (_) {}
      try {
        const res = await dispatch(data);
        ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, ...res }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', id: data.id, error: e.message || String(e) }));
      }
    }
  };
  ws.onclose = () => {
    setStatus('disconnected');
    ws = null;
    scheduleProbe();
  };
  ws.onerror = () => { /* onclose will follow */ };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pi-self-reload') { chrome.runtime.reload(); return; }
  if (alarm.name === 'pi-ws-keepalive') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send('{"type":"ping"}'); scheduleKeepalive(); } catch (_) { ws = null; scheduleProbe(); }
    } else { ws = null; scheduleProbe(); }
    return;
  }
  if (alarm.name === 'pi-ws-probe') {
    if (ws && ws.readyState <= 1) return;
    if (await isServerAlive(wsPort)) connectWS();
    else { setStatus('disconnected'); scheduleProbe(); }
  }
});

chrome.runtime.onStartup.addListener(connectWS);
chrome.runtime.onInstalled.addListener(() => {
  // Enable CSP-stripping by default so MAIN-world exec works on strict sites.
  handleDnr({ method: 'enable' }).catch(() => {});
  connectWS();
});

// Sync the agent's tab list on navigation/close so reconnects re-bind targets.
async function sendTabsUpdate() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabs = (await chrome.tabs.query({})).filter((t) => isScriptable(t.url));
  ws.send(JSON.stringify({ type: 'tabs_update', tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })) }));
}
chrome.tabs.onUpdated.addListener((_, info) => { if (info.status === 'complete') sendTabsUpdate(); });
chrome.tabs.onRemoved.addListener(sendTabsUpdate);
chrome.tabs.onCreated.addListener(sendTabsUpdate);

connectWS();
