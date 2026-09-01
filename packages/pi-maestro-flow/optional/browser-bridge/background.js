// background.js — Pi Browser Bridge service worker
//
// WebSocket client that connects back to the pi-maestro-flow agent. New
// installations discover only 127.0.0.1:19222..19231, require a protocol-marked
// pairing challenge, and persist credentials only after explicit approval.
// Legacy manual port/token configuration remains supported.
// Routes agent commands to chrome.* APIs:
//   exec | cdp | cookies | tabs | management | contentSettings | dnr | batch
//
// MV3 keepalive: chrome.alarms probes/reconnects while disconnected and pings
// while connected (under the ~30s service-worker timeout). Modeled on the
// GenericAgent tmwd_cdp_bridge extension but trimmed to pi's needs.

const DEFAULT_WS_PORT = 19222;
const DISCOVERY_LAST_PORT = 19231;
const DISCOVERY_TIMEOUT_MS = 750;
const BRIDGE_PROTOCOL = 'pi-browser-bridge/v1';
const HMAC_AUTH_PROTOCOL = 'challenge-hmac-sha256-v1';
const STORAGE_PORT_KEY = 'pi_ws_port';
const STORAGE_TOKEN_KEY = 'pi_ws_token';
const STORAGE_INSTALLATION_KEY = 'pi_ws_installation_id';

let ws = null;
let status = 'disconnected';
let wsPort = DEFAULT_WS_PORT;
let wsToken = '';
let serverInstallationId = '';
let authenticated = false;
let pairing = null;
let connectionAttempt = 0;
let pairingInstallationId = '';

function ownsAttempt(socket, attempt, expectedStatus) {
  return ws === socket
    && attempt === connectionAttempt
    && socket.readyState === WebSocket.OPEN
    && status === expectedStatus;
}

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

async function restrictCredentialStorage() {
  try {
    // Content scripts run in untrusted page contexts. Keep the bridge token
    // available only to trusted extension pages and the service worker.
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (_) {
    // Older Chromium builds may not expose setAccessLevel. The handshake still
    // fails closed; the popup can report an unconfigured/failed connection.
  }
}

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_PORT_KEY, STORAGE_TOKEN_KEY, STORAGE_INSTALLATION_KEY]);
    const p = Number(stored[STORAGE_PORT_KEY]);
    const token = typeof stored[STORAGE_TOKEN_KEY] === 'string' ? stored[STORAGE_TOKEN_KEY].trim() : '';
    const installationId = typeof stored[STORAGE_INSTALLATION_KEY] === 'string' ? stored[STORAGE_INSTALLATION_KEY].trim() : '';
    return {
      port: Number.isInteger(p) && p > 0 && p <= 65535 ? p : DEFAULT_WS_PORT,
      token: /^[A-Za-z0-9_-]{32,}$/.test(token) ? token : '',
      installationId: isInstallationId(installationId) ? installationId : '',
    };
  } catch {
    return { port: DEFAULT_WS_PORT, token: '', installationId: '' };
  }
}

function isInstallationId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function candidatePorts(configuredPort, hasToken) {
  const ports = [];
  if (hasToken && Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535) ports.push(configuredPort);
  for (let port = DEFAULT_WS_PORT; port <= DISCOVERY_LAST_PORT; port += 1) {
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

function parsePairingChallenge(data, port, now = Date.now()) {
  if (!data || data.type !== 'pairing_challenge' || data.protocol !== BRIDGE_PROTOCOL) return null;
  if (typeof data.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.requestId)) return null;
  if (typeof data.code !== 'string' || !/^\d{6}$/.test(data.code)) return null;
  if (!Number.isSafeInteger(data.generation) || data.generation <= 0) return null;
  if (!Number.isFinite(data.expiresAt) || data.expiresAt <= now || data.expiresAt > now + 5 * 60_000) return null;
  return { requestId: data.requestId, code: data.code, generation: data.generation, expiresAt: data.expiresAt, port };
}

function parsePairingApproval(data, expected, now = Date.now()) {
  if (!expected || !data || data.type !== 'pairing_approved' || data.protocol !== BRIDGE_PROTOCOL) return null;
  if (expected.expiresAt <= now || data.expiresAt !== expected.expiresAt) return null;
  if (data.requestId !== expected.requestId || data.generation !== expected.generation || data.port !== expected.port) return null;
  if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(data.token)) return null;
  if (!isInstallationId(data.installationId)) return null;
  return { port: data.port, token: data.token, installationId: data.installationId };
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createClientNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function authTranscript(challenge) {
  return JSON.stringify([
    HMAC_AUTH_PROTOCOL,
    challenge.clientNonce,
    challenge.serverNonce,
    challenge.installationId,
    challenge.port,
    challenge.generation,
  ]);
}

function parseAuthChallenge(data, port, clientNonce, expectedInstallationId, now = Date.now()) {
  if (!data || data.type !== 'auth_challenge' || data.protocol !== HMAC_AUTH_PROTOCOL) return null;
  if (data.clientNonce !== clientNonce || typeof data.serverNonce !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(data.serverNonce)) return null;
  if (!isInstallationId(data.installationId) || (expectedInstallationId && data.installationId !== expectedInstallationId)) return null;
  if (data.port !== port || !Number.isSafeInteger(data.generation) || data.generation <= 0) return null;
  if (!Number.isFinite(data.expiresAt) || data.expiresAt <= now || data.expiresAt > now + 30_000) return null;
  return {
    clientNonce,
    serverNonce: data.serverNonce,
    installationId: data.installationId,
    port,
    generation: data.generation,
    expiresAt: data.expiresAt,
  };
}

async function createAuthProof(token, challenge) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(authTranscript(challenge)));
  return base64Url(new Uint8Array(signature));
}

function parseAuthenticatedHello(data, port, expectedInstallationId) {
  if (!data || data.type !== 'auth_ok' || data.protocol !== BRIDGE_PROTOCOL || data.port !== port) return null;
  if (!isInstallationId(data.installationId)) return null;
  if (expectedInstallationId && data.installationId !== expectedInstallationId) return null;
  return { installationId: data.installationId };
}

async function storeApprovedCredentials(data, expected, now = Date.now()) {
  const credentials = parsePairingApproval(data, expected, now);
  if (!credentials) throw new Error('invalid browser bridge pairing approval');
  await chrome.storage.local.set({
    [STORAGE_PORT_KEY]: credentials.port,
    [STORAGE_TOKEN_KEY]: credentials.token,
    [STORAGE_INSTALLATION_KEY]: credentials.installationId,
  });
  return credentials;
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

function validateJsonWireValue(value, location, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`Browser extension ${location} contains a number outside the JSON wire domain.`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`Browser extension ${location} contains unsupported ${typeof value} outside the JSON wire domain.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Browser extension ${location} contains a cycle outside the JSON wire domain.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error(`Browser extension ${location}[${index}] is not a JSON wire data property.`);
        }
        validateJsonWireValue(descriptor.value, `${location}[${index}]`, ancestors);
      }
      for (const key of ownKeys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new Error(`Browser extension ${location} contains a non-index array property outside the JSON wire domain.`);
        }
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Browser extension ${location} contains an unsupported object outside the JSON wire domain.`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new Error(`Browser extension ${location} contains a symbol key outside the JSON wire domain.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`Browser extension ${location}.${key} is not an enumerable JSON wire data property.`);
      }
      validateJsonWireValue(descriptor.value, `${location}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function serializeBridgeResponse(request, response) {
  try {
    // exec is the page.evaluate wire boundary. Validate before JSON.stringify so
    // NaN/Infinity/functions/symbols/Map/cycles cannot silently become null/{}.
    if (request.cmd === 'exec' && response?.ok) {
      validateJsonWireValue(response.data, 'evaluation result', new Set());
    }
    return JSON.stringify({ type: response.ok ? 'result' : 'error', id: request.id, ...response });
  } catch (error) {
    return JSON.stringify({
      type: 'error',
      id: request.id,
      error: error instanceof Error ? error.message : `Browser extension evaluation result is outside the JSON wire domain: ${String(error)}`,
    });
  }
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

function cookieUrl(cookie, fallbackUrl) {
  if (cookie.url) return cookie.url;
  if (cookie.domain) {
    const host = String(cookie.domain).replace(/^\./, '');
    return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
  }
  return fallbackUrl;
}

function cookieMatches(cookie, filter) {
  return (!filter?.domain || cookie.domain.includes(filter.domain)) &&
    (!filter?.name || cookie.name === filter.name);
}

async function handleCookies(msg) {
  try {
    let url = msg.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(msg.tabId);
      url = tab.url;
    }
    if (!url) return { ok: false, error: 'cookies requires url or tabId' };
    const method = msg.method || 'get';
    if (method === 'set') {
      const cookies = Array.isArray(msg.cookies) ? msg.cookies : [];
      if (cookies.length === 0) return { ok: false, error: 'cookies.set requires cookies' };
      const written = [];
      for (const source of cookies) {
        const details = {};
        for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expirationDate', 'storeId', 'partitionKey']) {
          if (source[key] !== undefined) details[key] = source[key];
        }
        details.url = cookieUrl(source, url);
        if (!details.url) return { ok: false, error: 'cookies.set requires url or domain' };
        if (source.sameSite !== undefined) {
          const sameSite = String(source.sameSite).toLowerCase();
          details.sameSite = sameSite === 'none' ? 'no_restriction' : sameSite;
        }
        if (source.expirationDate === undefined && Number.isFinite(source.expires) && source.expires > 0) {
          details.expirationDate = source.expires;
        }
        written.push(await chrome.cookies.set(details));
      }
      return { ok: true, data: written };
    }

    const origin = (url.match(/^https?:\/\/[^/]+/) || [])[0] || url;
    const all = await chrome.cookies.getAll({ url });
    let part = [];
    try { part = await chrome.cookies.getAll({ url, partitionKey: { topLevelSite: origin } }); } catch (_) {}
    const merged = [...all];
    for (const c of part) {
      const partitionSite = c.partitionKey?.topLevelSite || '';
      if (!merged.some((x) => x.name === c.name && x.domain === c.domain && (x.partitionKey?.topLevelSite || '') === partitionSite)) merged.push(c);
    }
    const filtered = merged.filter((cookie) => cookieMatches(cookie, msg.filter));
    if (method === 'get') return { ok: true, data: filtered };
    if (method === 'delete') {
      const removed = [];
      for (const cookie of filtered) {
        const details = { url: cookieUrl(cookie, url), name: cookie.name, storeId: cookie.storeId };
        if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
        removed.push(await chrome.cookies.remove(details));
      }
      return { ok: true, data: removed };
    }
    return { ok: false, error: 'unknown cookies method: ' + method };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function tabData(tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
    pinned: tab.pinned,
    muted: tab.mutedInfo?.muted,
  };
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
      return { ok: true, data: tabData(tab) };
    }
    if (msg.method === 'switch') {
      const tab = await chrome.tabs.update(msg.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    if (msg.method === 'get') {
      if (!Number.isInteger(msg.tabId)) return { ok: false, error: 'tabs.get requires tabId' };
      return { ok: true, data: tabData(await chrome.tabs.get(msg.tabId)) };
    }
    if (msg.method === 'update') {
      if (!Number.isInteger(msg.tabId)) return { ok: false, error: 'tabs.update requires tabId' };
      // Accept direct fields (consistent with create/switch) while also allowing
      // updateProperties/properties for callers that already group Chrome args.
      const source = msg.updateProperties || msg.properties || msg;
      const update = {};
      for (const key of ['url', 'active', 'highlighted', 'pinned', 'muted', 'openerTabId', 'autoDiscardable']) {
        if (source[key] !== undefined) update[key] = source[key];
      }
      if (Object.keys(update).length === 0) return { ok: false, error: 'tabs.update requires at least one update field' };
      return { ok: true, data: tabData(await chrome.tabs.update(msg.tabId, update)) };
    }
    if (msg.method === 'close') {
      if (!Number.isInteger(msg.tabId)) return { ok: false, error: 'tabs.close requires tabId' };
      await chrome.tabs.remove(msg.tabId);
      return { ok: true, data: { id: msg.tabId } };
    }
    // Missing method and explicit query remain backward compatible.
    const tabs = (await chrome.tabs.query({})).filter((t) => isScriptable(t.url));
    return { ok: true, data: tabs.map(tabData) };
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

// Command records deliberately distinguish queued from started work. A queued
// command can be stopped without fabricating a result. Browser APIs already in
// progress are generally not abortable, so cancel_ack stopped=false retains
// terminal ownership until the real result/error is sent.
const trackedCommands = new Map();

function sendCancelAcknowledgement(socket, id, stopped) {
  if (ws !== socket || !authenticated || socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify({ type: 'cancel_ack', id, stopped })); } catch (_) {}
}

function cancelTrackedCommand(socket, id) {
  const tracked = trackedCommands.get(id);
  if (!tracked || tracked.socket !== socket || tracked.started) {
    sendCancelAcknowledgement(socket, id, false);
    return;
  }
  tracked.stopped = true;
  sendCancelAcknowledgement(socket, id, true);
}

async function executeTrackedCommand(socket, request) {
  if (trackedCommands.has(request.id)) {
    try { socket.send(JSON.stringify({ type: 'error', id: request.id, error: 'duplicate browser-bridge command id' })); } catch (_) {}
    return;
  }
  const tracked = { socket, attempt: connectionAttempt, started: false, stopped: false };
  trackedCommands.set(request.id, tracked);
  try { socket.send(JSON.stringify({ type: 'ack', id: request.id })); } catch (_) {
    trackedCommands.delete(request.id);
    return;
  }

  // Yield one task so an immediate cancel can stop undispatched work. Once the
  // task begins, cancellation must not synthesize completion ahead of the real
  // browser API result/error.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (tracked.stopped || !ownsAttempt(socket, tracked.attempt, 'connected') || !authenticated) {
    if (trackedCommands.get(request.id) === tracked) trackedCommands.delete(request.id);
    return;
  }
  tracked.started = true;
  try {
    const response = await dispatch(request);
    if (ownsAttempt(socket, tracked.attempt, 'connected') && authenticated) {
      socket.send(serializeBridgeResponse(request, response));
    }
  } catch (error) {
    if (ownsAttempt(socket, tracked.attempt, 'connected') && authenticated) {
      try { socket.send(JSON.stringify({ type: 'error', id: request.id, error: error.message || String(error) })); } catch (_) {}
    }
  } finally {
    if (trackedCommands.get(request.id) === tracked) trackedCommands.delete(request.id);
  }
}

function releaseTrackedCommands(socket) {
  for (const [id, tracked] of trackedCommands) {
    if (tracked.socket !== socket) continue;
    tracked.stopped = !tracked.started;
    trackedCommands.delete(id);
  }
}

// --- WebSocket connection ---

function extensionProposal() {
  const origin = typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : 'chrome-extension://pi-browser-bridge';
  if (!pairingInstallationId) {
    pairingInstallationId = globalThis.crypto?.randomUUID?.()
      || `${chrome.runtime.id || 'pi-browser-bridge'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return { origin, installationId: pairingInstallationId };
}

function connectCandidate(port, token, expectedInstallationId, attempt) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    let accepted = false;
    let reconnectAfterApproval = false;
    let outcome = 'miss';
    let authChallenge = null;
    let clientNonce = '';
    const finish = (next) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(next);
    };
    const timeout = setTimeout(() => {
      if (accepted) return;
      try { socket?.close(1000, 'discovery timeout'); } catch (_) {}
      finish(outcome);
    }, DISCOVERY_TIMEOUT_MS);

    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      ws = socket;
    } catch (_) {
      clearTimeout(timeout);
      if (ws === socket) ws = null;
      resolve('miss');
      return;
    }

    socket.onopen = () => {
      if (ws !== socket || attempt !== connectionAttempt) {
        try { socket.close(); } catch (_) {}
        finish('miss');
        return;
      }
      try {
        // Discovery candidates receive only a fresh nonce. The stored token is
        // used locally to prove a marked challenge and is never sent on scan.
        if (token) {
          clientNonce = createClientNonce();
          setStatus('authenticating');
          socket.send(JSON.stringify({ type: 'auth_probe', protocol: HMAC_AUTH_PROTOCOL, clientNonce }));
        } else {
          socket.send(JSON.stringify({ type: 'pairing_request', protocol: BRIDGE_PROTOCOL, ...extensionProposal() }));
        }
      } catch (_) {
        try { socket.close(); } catch (_) {}
        finish('miss');
      }
    };

    socket.onmessage = async (event) => {
      if (ws !== socket || attempt !== connectionAttempt) return;
      let data;
      try { data = JSON.parse(event.data); } catch {
        try { socket.close(1002, 'invalid discovery frame'); } catch (_) {}
        finish('miss');
        return;
      }

      if (!authenticated && token) {
        if (data.type === 'auth_error') {
          outcome = 'auth-failed';
          try { socket.close(1008, 'authentication failed'); } catch (_) {}
          finish(outcome);
          return;
        }
        if (!authChallenge) {
          authChallenge = parseAuthChallenge(data, port, clientNonce, expectedInstallationId);
          if (!authChallenge) {
            try { socket.close(1002, 'unrecognized browser bridge'); } catch (_) {}
            finish('miss');
            return;
          }
          let proof;
          try {
            proof = await createAuthProof(token, authChallenge);
          } catch (error) {
            if (!ownsAttempt(socket, attempt, 'authenticating')) return;
            outcome = 'auth-failed';
            try { socket.close(1011, 'authentication proof failed'); } catch (_) {}
            finish(outcome);
            return;
          }
          if (!ownsAttempt(socket, attempt, 'authenticating')) return;
          socket.send(JSON.stringify({
            type: 'auth_proof',
            protocol: HMAC_AUTH_PROTOCOL,
            ...authChallenge,
            expiresAt: undefined,
            proof,
          }));
          return;
        }
        const hello = parseAuthenticatedHello(data, port, expectedInstallationId);
        if (!hello) {
          try { socket.close(1002, 'unrecognized browser bridge'); } catch (_) {}
          finish('miss');
          return;
        }
        accepted = true;
        const configuredPort = wsPort;
        if (expectedInstallationId && port !== configuredPort) {
          try {
            await chrome.storage.local.set({ [STORAGE_PORT_KEY]: port });
          } catch (error) {
            if (!ownsAttempt(socket, attempt, 'authenticating')) return;
            outcome = 'auth-failed';
            try { socket.close(1011, 'port persistence failed'); } catch (_) {}
            finish(outcome);
            return;
          }
          if (!ownsAttempt(socket, attempt, 'authenticating')) return;
        }
        if (!ownsAttempt(socket, attempt, 'authenticating')) return;
        authenticated = true;
        pairing = null;
        wsPort = port;
        serverInstallationId = hello.installationId;
        setStatus('connected');
        scheduleKeepalive();
        finish('accepted');
        const tabs = (await chrome.tabs.query({})).filter((t) => isScriptable(t.url));
        if (ws === socket && attempt === connectionAttempt && authenticated && status === 'connected' && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'ext_ready',
            tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
          }));
        }
        return;
      }

      if (!authenticated && !token) {
        if (!pairing) {
          const challenge = parsePairingChallenge(data, port);
          if (!challenge) {
            try { socket.close(1002, 'unrecognized browser bridge'); } catch (_) {}
            finish('miss');
            return;
          }
          pairing = challenge;
          accepted = true;
          setStatus('pairing-pending');
          finish('accepted');
          return;
        }
        setStatus('saving-credentials');
        let credentials;
        try {
          credentials = await storeApprovedCredentials(data, pairing);
        } catch (_) {
          if (!ownsAttempt(socket, attempt, 'saving-credentials')) return;
          setStatus('pairing-failed');
          try { socket.close(1011, 'credential storage failed'); } catch (_) {}
          return;
        }
        if (!ownsAttempt(socket, attempt, 'saving-credentials')) return;
        wsPort = credentials.port;
        wsToken = credentials.token;
        serverInstallationId = credentials.installationId;
        pairing = null;
        reconnectAfterApproval = true;
        setStatus('connecting');
        try { socket.close(1000, 'credentials stored; reconnecting'); } catch (_) {
          ws = null;
          setTimeout(() => { void connectWS(); }, 0);
        }
        return;
      }

      if (data.type === 'ping') return;
      if (data.type === 'cancel' && typeof data.id === 'string') {
        cancelTrackedCommand(socket, data.id);
        return;
      }
      if (typeof data.id === 'string' && data.id && data.cmd) void executeTrackedCommand(socket, data);
    };

    socket.onclose = (event) => {
      releaseTrackedCommands(socket);
      if (!settled) finish(outcome);
      if (ws !== socket || attempt !== connectionAttempt) return;
      authenticated = false;
      ws = null;
      if (pairing?.port === port) pairing = null;
      if (reconnectAfterApproval) {
        setStatus('connecting');
        setTimeout(() => { void connectWS(); }, 0);
        return;
      }
      if (accepted) {
        setStatus(event.code === 1008 ? 'auth-failed' : 'disconnected');
        scheduleProbe();
      }
    };
    socket.onerror = () => {
      if (!accepted) finish(outcome);
      try { socket.close(); } catch (_) {}
    };
  });
}

async function connectWS() {
  if (ws && ws.readyState <= 1) return; // CONNECTING or OPEN
  const attempt = ++connectionAttempt;
  const config = await loadConfig();
  if (attempt !== connectionAttempt || (ws && ws.readyState <= 1)) return;
  wsPort = config.port;
  wsToken = config.token;
  serverInstallationId = config.installationId;
  authenticated = false;
  pairing = null;
  const token = config.token;
  const expectedInstallationId = config.installationId;
  setStatus(token ? 'connecting' : 'discovering');
  let authenticationFailed = false;
  for (const port of candidatePorts(wsPort, Boolean(token))) {
    if (attempt !== connectionAttempt) return;
    const result = await connectCandidate(port, token, expectedInstallationId, attempt);
    if (result === 'accepted') return;
    if (result === 'auth-failed') authenticationFailed = true;
  }
  if (attempt !== connectionAttempt) return;
  setStatus(authenticationFailed ? 'auth-failed' : token ? 'disconnected' : 'not-found');
  scheduleProbe();
}

async function startBridge() {
  await restrictCredentialStorage();
  await connectWS();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.cmd !== 'status') return false;
  sendResponse({
    ok: true,
    data: status,
    port: wsPort,
    configured: Boolean(wsToken),
    installationId: serverInstallationId || undefined,
    pairing: pairing ? { ...pairing } : undefined,
  });
  return false;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pi-self-reload') { chrome.runtime.reload(); return; }
  if (alarm.name === 'pi-ws-keepalive') {
    if (ws && authenticated && ws.readyState === WebSocket.OPEN) {
      try { ws.send('{"type":"ping"}'); scheduleKeepalive(); } catch (_) { try { ws.close(); } catch (_) {} }
    } else {
      authenticated = false;
      scheduleProbe();
    }
    return;
  }
  if (alarm.name === 'pi-ws-probe') {
    if (ws && ws.readyState <= 1) return;
    await connectWS();
  }
});

chrome.runtime.onStartup.addListener(startBridge);
chrome.runtime.onInstalled.addListener(() => {
  // Enable CSP-stripping by default so MAIN-world exec works on strict sites.
  handleDnr({ method: 'enable' }).catch(() => {});
  startBridge();
});

// Sync the agent's tab list only after authentication, so ext_ready remains the
// first capability-bearing message and unauthenticated sockets stay inert.
async function sendTabsUpdate() {
  const socket = ws;
  const attempt = connectionAttempt;
  if (!socket || !authenticated || status !== 'connected' || socket.readyState !== WebSocket.OPEN) return;
  const tabs = (await chrome.tabs.query({})).filter((t) => isScriptable(t.url));
  if (!ownsAttempt(socket, attempt, 'connected') || !authenticated) return;
  socket.send(JSON.stringify({ type: 'tabs_update', tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })) }));
}
chrome.tabs.onUpdated.addListener((_, info) => { if (info.status === 'complete') sendTabsUpdate(); });
chrome.tabs.onRemoved.addListener(sendTabsUpdate);
chrome.tabs.onCreated.addListener(sendTabsUpdate);

startBridge();
