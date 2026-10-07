// background.js — Pi Browser Bridge service worker
//
// WebSocket client that connects back to the pi-maestro-flow agent. New
// installations discover every 127.0.0.1:19222..19231 listener. NONE uses
// nonce/ready (not authorization); paired credentials require explicit approval.
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

const READY_PROTOCOL = 'probe-ready-v1';
const CREDENTIALS_KEY = 'pi_bridge_credentials_v1';
const CUSTOM_PORTS_KEY = 'pi_bridge_custom_ports_v1';
const JOURNAL_KEY = 'pi_bridge_resources_v1';
const connections = new Map(); // port -> record; never replace a live peer
const tabLeases = new Map(); // physical Chrome tabId -> generation-owned lease
const resourceLanes = new Map(); // tab:<id> or global -> running operation
const quarantineTabs = new Set();
let quarantineGlobal = false;
let journalFailed = false;
let browserSessionId = null;
let journalTail = Promise.resolve();
let resourceRecovery = null;
let discoveryRunning = false;
let pairingInstallationId = '';
const operationQueue = [];

function live(record) {
  return connections.get(record.port) === record && record.socket.readyState === WebSocket.OPEN;
}
function ready(record) { return live(record) && record.status === 'connected'; }
function send(record, frame) {
  if (!ready(record)) return;
  try { record.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); } catch (_) {}
}
function setStatus(record, value) { record.status = value; }

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
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535) ports.push(configuredPort);
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
  const stored = await chrome.storage.local.get([CREDENTIALS_KEY]);
  const entries = Array.isArray(stored[CREDENTIALS_KEY]) ? stored[CREDENTIALS_KEY] : [];
  await chrome.storage.local.set({
    [CREDENTIALS_KEY]: [...entries.filter((entry) => entry.installationId !== credentials.installationId), credentials],
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
  const adoptions = [];
  // Only opener evidence attributes a new tab; never collect another Pi's tab.
  const onCreated = (tab) => {
    if (tab.openerTabId !== tabId) return;
    newTabIds.add(tab.id);
    const adoption = assignCreatedTab(msg, tab.id);
    adoption.catch(() => {});
    adoptions.push(adoption);
  };
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
        await detachDebugger(tabId);
        if (cdpRes.exceptionDetails) {
          const desc = cdpRes.exceptionDetails.exception?.description || 'CDP error';
          res = { ok: false, error: desc };
        } else {
          res = cdpRes.result?.value ?? { ok: true, data: undefined };
        }
      } catch (cdpErr) {
        try { await detachDebugger(tabId); } catch (_) {}
        res = { ok: false, error: 'CDP fallback failed: ' + (cdpErr.message || cdpErr) };
      }
    }
    if (newTabIds.size === 0) await new Promise((r) => setTimeout(r, 200));
    await Promise.all(adoptions);
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

async function detachDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); }
  catch (error) {
    // A failed cleanup cannot establish that the debugger is safe to reuse.
    quarantineTabs.add(tabId);
    await persistResources().catch(() => {});
    throw error;
  }
}

async function handleCdp(msg) {
  const tabId = msg.tabId;
  if (!tabId) return { ok: false, error: 'cdp requires tabId' };
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    const result = await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params || {});
    await detachDebugger(tabId);
    return { ok: true, data: result };
  } catch (e) {
    try { await detachDebugger(tabId); } catch (_) {}
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
      await assignCreatedTab(msg, tab.id);
      return { ok: true, data: { ...tabData(tab), lease: tabLeases.get(tab.id)?.lease } };
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
    if (msg.method === 'reload') return { ok: false, error: 'worker reload requires explicit extension UI; no delayed untracked reload' };
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
      c._operation = msg._operation;
      if (c.cmd === 'cookies') R.push(await handleCookies(c));
      else if (c.cmd === 'tabs') R.push(await handleTabs(c));
      else if (c.cmd === 'cdp') {
        const tabId = c.tabId || msg.tabId;
        if (attached !== tabId) {
          if (attached) { try { await detachDebugger(attached); } catch (_) {} attached = null; }
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
        R.push(await dispatch(c));
      }
    }
    if (attached) await detachDebugger(attached);
    return { ok: true, results: R };
  } catch (e) {
    if (attached) { try { await detachDebugger(attached); } catch (_) {} }
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

// Journal contains only resource identifiers, never requests/code/cookies/results.
// Serialize snapshots at write time so late terminal cleanup cannot erase newer work.
function ensureResourceRecovery() {
  if (!resourceRecovery) resourceRecovery = (async () => {
    await restrictCredentialStorage();
    try { await recoverResources(); } catch (_) { journalFailed = true; }
  })();
  return resourceRecovery;
}
function persistResources() { return ensureResourceRecovery().then(writeResourceSnapshot); }
function writeResourceSnapshot() {
  const write = journalTail.then(async () => {
    const tabs = [...new Set([...tabLeases.keys(), ...quarantineTabs])];
    const global = quarantineGlobal || resourceLanes.has('global');
    const creating = [...resourceLanes.values()].some((operation) => operation.resources.creating);
    await chrome.storage.local.set({ [JOURNAL_KEY]: { version: 1, tabs, global, creating, browserSessionId } });
  });
  journalTail = write.catch(() => { journalFailed = true; });
  return write;
}
async function recoverResources() {
  if (chrome.storage.session) {
    const session = await chrome.storage.session.get(['pi_bridge_browser_session']);
    browserSessionId = session.pi_bridge_browser_session;
    if (!isInstallationId(browserSessionId)) {
      browserSessionId = globalThis.crypto.randomUUID();
      await chrome.storage.session.set({ pi_bridge_browser_session: browserSessionId });
    }
  }
  const stored = await chrome.storage.local.get([JOURNAL_KEY]);
  const journal = stored[JOURNAL_KEY];
  if (!journal) return;
  if (journal.version !== 1 || !Array.isArray(journal.tabs) || typeof journal.global !== 'boolean') {
    quarantineGlobal = true;
    throw new Error('invalid resource journal; browser restart required');
  }
  // storage.session survives worker restarts but is cleared by a browser restart.
  // Missing/unverifiable session evidence never clears an unknown global mutation.
  const browserRestarted = isInstallationId(journal.browserSessionId)
    && browserSessionId && journal.browserSessionId !== browserSessionId;
  quarantineGlobal = journal.global && !browserRestarted;
  for (const id of journal.tabs) {
    if (!Number.isInteger(id) || id <= 0) { quarantineGlobal = true; continue; }
    // Only an authoritative absent-tab check permits forgetting a lost operation.
    try { await chrome.tabs.get(id); quarantineTabs.add(id); }
    catch (error) {
      if (!/No tab with id|Invalid tab ID|tab not found/i.test(error.message || '')) quarantineTabs.add(id);
    }
  }
  // A popup created by a lost execution can be recovered from opener evidence.
  const tabs = await chrome.tabs.query({});
  // A lost create may not have journaled its new ID yet; none can be guessed safe.
  if (journal.creating && !browserRestarted) for (const tab of tabs) quarantineTabs.add(tab.id);
  let added;
  do {
    added = false;
    for (const tab of tabs) if (quarantineTabs.has(tab.openerTabId) && !quarantineTabs.has(tab.id)) {
      quarantineTabs.add(tab.id); added = true;
    }
  } while (added);
  await writeResourceSnapshot();
}
function sameIdentity(a, b) {
  return Boolean(a && b) && ['installationId', 'serverInstanceId', 'generation', 'authMode', 'authenticated']
    .every((key) => a[key] === b[key]);
}
function ownerKey(owner) {
  if (!owner || typeof owner.namespace !== 'string' || typeof owner.ownerId !== 'string'
    || !owner.namespace || !owner.ownerId || owner.namespace.length > 256 || owner.ownerId.length > 256) throw new Error('invalid owner');
  return JSON.stringify([owner.namespace, owner.ownerId]);
}
function sameLease(a, b) {
  return Boolean(a && b) && ['namespace', 'ownerId', 'serverInstanceId', 'generation', 'claimId'].every((key) => a[key] === b[key]);
}
function operationOwner(record, request) {
  const owner = request.owner || (request.cmd === 'release' ? request.lease : null)
    || { namespace: 'legacy-socket', ownerId: record.localId };
  return { owner: { namespace: owner.namespace, ownerId: owner.ownerId }, key: ownerKey(owner) };
}
function leaseFor(operation, tabId, owned = false) {
  if (quarantineTabs.has(tabId)) throw new Error('resource_quarantined: tab ' + tabId);
  const current = tabLeases.get(tabId);
  if (current) {
    if (current.record !== operation.record || current.ownerKey !== operation.ownerKey || current.draining) throw new Error('tab_busy: ' + tabId);
    return current;
  }
  const lease = { ...operation.owner, serverInstanceId: operation.record.identity.serverInstanceId,
    generation: operation.record.identity.generation, claimId: globalThis.crypto.randomUUID() };
  const entry = { record: operation.record, ownerKey: operation.ownerKey, lease, owned, draining: false };
  tabLeases.set(tabId, entry);
  operation.added.push(tabId);
  return entry;
}
function targetResources(request) {
  const tabs = new Set();
  let global = false;
  let creating = false;
  const target = (id) => {
    if (!Number.isInteger(id) || id <= 0) throw new Error('deterministic tabId required (dynamic batch targets unsupported)');
    tabs.add(id);
  };
  const inspect = (msg) => {
    if (msg.cmd === 'batch') {
      if (!Array.isArray(msg.commands) || !msg.commands.length || msg.commands.length > 128) throw new Error('invalid batch');
      for (const child of msg.commands) {
        if (!child || child.cmd === 'batch') throw new Error('nested batch unsupported');
        inspect({ ...child, tabId: child.tabId === undefined ? msg.tabId : child.tabId });
      }
      return;
    }
    if (['claim', 'release', 'exec', 'cdp'].includes(msg.cmd)) target(msg.tabId);
    if (msg.cmd === 'cdp') {
      // Target can mutate tabs outside this reservation; reject rather than guess.
      if (/^Target\./.test(msg.method || '')) throw new Error('browser-wide CDP target mutation unsupported');
      if (/^(Browser|Storage)\./.test(msg.method || '')
        || /^Network\.(setCookie|setCookies|deleteCookies|clearBrowserCookies|clearBrowserCache)$/.test(msg.method || '')) global = true;
    }
    if (msg.cmd === 'tabs') {
      if (msg.method === 'create') { global = true; creating = true; if (msg.openerTabId !== undefined) target(msg.openerTabId); }
      else if (!msg.method || msg.method === 'query') { /* observational only */ }
      else { target(msg.tabId); if (msg.method === 'switch' || msg.properties?.active || msg.updateProperties?.active || msg.active) global = true; }
      const opener = msg.updateProperties?.openerTabId ?? msg.properties?.openerTabId ?? msg.openerTabId;
      if (opener !== undefined) target(opener);
    }
    if (msg.cmd === 'cookies') {
      if (msg.tabId !== undefined) target(msg.tabId);
      if (msg.method && msg.method !== 'get') global = true;
    }
    if (msg.cmd === 'contentSettings' || msg.cmd === 'dnr' || (msg.cmd === 'management' && msg.method !== 'list')) global = true;
    if (!['claim', 'release', 'exec', 'cdp', 'tabs', 'cookies', 'contentSettings', 'dnr', 'management'].includes(msg.cmd)) throw new Error('unknown cmd: ' + msg.cmd);
  };
  inspect(request);
  return { tabs: [...tabs].sort((a, b) => a - b), global, creating };
}
function reserveOperation(operation) {
  const resources = targetResources(operation.request);
  if (resources.global && quarantineGlobal) throw new Error('resource_quarantined: global; browser restart required');
  operation.resources = resources;
  // Validate every target before making ANY reservations or invoking Chrome.
  for (const id of resources.tabs) {
    if (quarantineTabs.has(id)) throw new Error('resource_quarantined: tab ' + id);
    const entry = tabLeases.get(id);
    if (entry && (entry.record !== operation.record || entry.ownerKey !== operation.ownerKey || entry.draining || entry.releasing)) throw new Error('tab_busy: ' + id);
    const offered = operation.request.leases?.find((item) => item.tabId === id)?.lease
      || (operation.request.tabId === id ? operation.request.lease : null);
    if (operation.request.cmd === 'release' && (!entry || !sameLease(entry.lease, offered))) throw new Error('stale_lease');
    if (offered && (!entry || !sameLease(entry.lease, offered))) throw new Error('stale_lease');
    // Explicit-owner mutations must use a claim, except claim/create and their deterministic opener targets.
    if (operation.request.owner && operation.request.cmd !== 'claim'
      && !(operation.request.cmd === 'tabs' && operation.request.method === 'create')
      && !offered) throw new Error('lease_required: ' + id);
  }
  for (const id of resources.tabs) leaseFor(operation, id);
  if (operation.request.cmd === 'release') tabLeases.get(operation.request.tabId).releasing = operation;
  operation.keys = resources.tabs.map((id) => 'tab:' + id);
  if (resources.global) operation.keys.push('global');
}
async function assignCreatedTab(request, id) {
  const operation = request._operation;
  if (!operation) throw new Error('uncoordinated tab creation');
  leaseFor(operation, id, true);
  operation.created.add(id);
  const key = 'tab:' + id;
  if (!operation.keys.includes(key)) {
    if (resourceLanes.has(key)) throw new Error('tab_busy: ' + id);
    operation.keys.push(key);
    resourceLanes.set(key, operation);
  }
  try { await persistResources(); } // before result publication
  catch (error) { await retireUnpublishedTabs(operation, [id]); throw error; }
}
async function retireUnpublishedTabs(operation, ids = [...operation.created]) {
  for (const id of ids) {
    const entry = tabLeases.get(id);
    if (!entry || entry.record !== operation.record || entry.ownerKey !== operation.ownerKey || !entry.owned) continue;
    entry.draining = true;
    quarantineTabs.add(id);
    try {
      await chrome.tabs.remove(id);
      quarantineTabs.delete(id);
      if (tabLeases.get(id) === entry) tabLeases.delete(id);
      operation.created.delete(id);
    } catch (_) {
      // The pre-dispatch create intent keeps even an unjournaled ID isolated on restart.
      quarantineGlobal = true;
    }
  }
}
async function dispatchOperation(operation) {
  const request = { ...operation.request, _operation: operation };
  if (request.cmd === 'claim') {
    await chrome.tabs.get(request.tabId);
    return { ok: true, data: { tabId: request.tabId, lease: tabLeases.get(request.tabId).lease } };
  }
  if (request.cmd === 'release') {
    // Queued behind all work on this tab; borrowed release never closes it.
    const entry = tabLeases.get(request.tabId);
    if (request.close === true) {
      if (!entry.owned) throw new Error('borrowed_tab_close_denied');
      await chrome.tabs.remove(request.tabId);
    }
    if (tabLeases.get(request.tabId) === entry) tabLeases.delete(request.tabId);
    return { ok: true, data: { tabId: request.tabId, released: true } };
  }
  const response = await dispatch(request);
  const adopt = async (reply, origin) => {
    for (const tab of reply?.newTabs || []) {
      const entry = leaseFor(operation, tab.id, true);
      tab.lease = entry.lease;
    }
    if (origin.cmd === 'tabs' && origin.method === 'close' && reply?.ok) {
      const entry = tabLeases.get(origin.tabId);
      if (entry?.record === operation.record && entry.ownerKey === operation.ownerKey) tabLeases.delete(origin.tabId);
    }
  };
  if (request.cmd === 'batch') {
    for (let i = 0; i < (response.results || []).length; i++) await adopt(response.results[i], { ...request.commands[i], tabId: request.commands[i].tabId ?? request.tabId });
  } else await adopt(response, request);
  return response;
}
function forgetAdded(operation) {
  const release = tabLeases.get(operation.request.tabId);
  if (release?.releasing === operation) delete release.releasing;
  for (const id of operation.added) {
    const entry = tabLeases.get(id);
    if (entry?.record === operation.record && entry.ownerKey === operation.ownerKey
      && !operationQueue.some((other) => other !== operation && !other.stopped && other.resources?.tabs.includes(id))
      && !resourceLanes.has('tab:' + id)) tabLeases.delete(id);
  }
}
function cancelTrackedCommand(record, id) {
  const operation = record.commands.get(id);
  const stopped = Boolean(operation && !operation.started);
  if (stopped) {
    operation.stopped = true;
    record.commands.delete(id);
    forgetAdded(operation);
    void persistResources().catch(() => {});
    pumpQueue();
  }
  send(record, { type: 'cancel_ack', id, stopped });
}
async function drainLeases(record) {
  while (record.drain) await record.drain;
  const drain = (async () => {
    let changed = false;
    for (const [id, entry] of tabLeases) {
      if (entry.record !== record) continue;
      changed = true;
      entry.draining = true;
      if (resourceLanes.has('tab:' + id)) continue;
      // Owned tabs are retired only after the creating/running operation terminates.
      if (entry.owned && !entry.removed) {
        try { await chrome.tabs.remove(id); }
        catch (_) { quarantineTabs.add(id); }
      }
      if (tabLeases.get(id) === entry) tabLeases.delete(id);
    }
    if (changed) await persistResources();
  })();
  record.drain = drain;
  try { await drain; } finally { if (record.drain === drain) record.drain = null; }
}
function disconnectRecord(record) {
  record.status = 'disconnected';
  for (const operation of record.commands.values()) {
    if (!operation.started) { operation.stopped = true; forgetAdded(operation); record.commands.delete(operation.request.id); }
  }
  for (const entry of tabLeases.values()) if (entry.record === record) entry.draining = true;
  void drainLeases(record).catch(() => {});
  pumpQueue();
  scheduleProbe();
}
function pumpQueue() {
  for (let i = 0; i < operationQueue.length;) {
    const operation = operationQueue[i];
    if (operation.stopped) { operationQueue.splice(i, 1); continue; }
    const priorConflict = operationQueue.slice(0, i).some((prior) => prior.keys.some((key) => operation.keys.includes(key)));
    if (priorConflict || operation.keys.some((key) => resourceLanes.has(key))) { i++; continue; }
    operationQueue.splice(i, 1);
    for (const key of operation.keys) resourceLanes.set(key, operation);
    void runOperation(operation);
  }
}
async function runOperation(operation) {
  const { record, request } = operation;
  try {
    // Holding lanes is not dispatch: a failed journal or cancel still stops safely.
    await persistResources();
    if (operation.stopped || !ready(record)) return;
    if (journalFailed) throw new Error('resource_journal_failed');
    operation.started = true;
    const response = await dispatchOperation(operation);
    operation.success = response.ok;
    await persistResources();
    send(record, serializeBridgeResponse(request, response));
  } catch (error) {
    if (!operation.started) forgetAdded(operation);
    else await retireUnpublishedTabs(operation);
    send(record, { type: 'error', id: request.id, error: error.message || String(error) });
  } finally {
    for (const key of operation.keys) if (resourceLanes.get(key) === operation) resourceLanes.delete(key);
    for (const id of operation.resources.tabs.concat(operation.added)) {
      const entry = tabLeases.get(id);
      if (entry?.record === record && entry.removed && !resourceLanes.has('tab:' + id)) tabLeases.delete(id);
    }
    if (record.commands.get(request.id) === operation) record.commands.delete(request.id);
    if (!operation.started || operation.stopped || (request.cmd === 'claim' && !operation.success) || request.cmd === 'release') forgetAdded(operation);
    if (!ready(record)) await drainLeases(record).catch(() => {});
    await persistResources().catch(() => {});
    pumpQueue();
  }
}
async function executeTrackedCommand(record, request) {
  await ensureResourceRecovery();
  if (!ready(record)) return;
  if (record.commands.has(request.id)) { send(record, { type: 'error', id: request.id, error: 'duplicate browser-bridge command id' }); return; }
  if (!sameIdentity(request.connection, record.identity)) { send(record, { type: 'error', id: request.id, error: 'stale_connection' }); return; }
  if (journalFailed) { send(record, { type: 'error', id: request.id, error: 'resource_journal_failed' }); return; }
  if (operationQueue.length >= 128 || record.commands.size >= 128) { send(record, { type: 'error', id: request.id, error: 'queue_full' }); return; }
  const operation = { record, request, started: false, stopped: false, added: [], created: new Set() };
  try {
    const owner = operationOwner(record, request);
    operation.owner = owner.owner;
    operation.ownerKey = owner.key;
    reserveOperation(operation);
  } catch (error) { forgetAdded(operation); send(record, { type: 'error', id: request.id, error: error.message }); return; }
  record.commands.set(request.id, operation);
  operationQueue.push(operation);
  send(record, { type: 'ack', id: request.id });
  setTimeout(pumpQueue, 0); // immediate cancel really is undispatched
}

function extensionProposal() {
  const origin = typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : 'chrome-extension://pi-browser-bridge';
  if (!pairingInstallationId) pairingInstallationId = globalThis.crypto.randomUUID();
  return { origin, installationId: pairingInstallationId };
}
function parseNoneChallenge(data, record) {
  if (data.type !== 'bridge_challenge' || data.protocol !== READY_PROTOCOL || data.authMode !== 'none' || data.authenticated !== false
    || data.clientNonce !== record.clientNonce || !/^[A-Za-z0-9_-]{22,86}$/.test(data.serverNonce || '')
    || !isInstallationId(data.installationId) || !isInstallationId(data.serverInstanceId) || data.port !== record.port
    || !Number.isSafeInteger(data.generation) || data.generation <= 0 || data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 30_000
    || !data.capabilities?.includes('owner-lease-v1')) return null;
  return data;
}
function transportIdentity(data) {
  return { installationId: data.installationId, serverInstanceId: data.serverInstanceId,
    generation: data.generation, authMode: data.authMode, authenticated: data.authenticated };
}
async function publishTabs(record, type = 'tabs_update') {
  if (!ready(record)) return;
  const tabs = (await chrome.tabs.query({})).filter((tab) => isScriptable(tab.url));
  send(record, { type, tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })) });
}
async function acceptRecord(record, data) {
  if (!live(record)) return;
  record.identity = transportIdentity(data);
  record.status = 'connected';
  clearTimeout(record.timeout);
  await publishTabs(record, 'ext_ready');
  if (ready(record)) scheduleKeepalive();
}
function connectCandidate(port, credentials, mode = 'none') {
  const existing = connections.get(port);
  if (existing && existing.socket.readyState <= WebSocket.OPEN) return;
  let socket;
  try { socket = new WebSocket(`ws://127.0.0.1:${port}`); } catch (_) { return; }
  const record = { port, socket, mode, credentials, status: 'connecting', commands: new Map(), localId: globalThis.crypto.randomUUID(),
    clientNonce: createClientNonce(), challenge: null, pairing: null, identity: null };
  connections.set(port, record);
  record.timeout = setTimeout(() => { if (live(record) && !ready(record) && !record.pairing) socket.close(1000, 'discovery timeout'); }, DISCOVERY_TIMEOUT_MS);
  socket.onopen = () => {
    if (!live(record)) return;
    socket.send(JSON.stringify(mode === 'pairing'
      ? { type: 'pairing_request', protocol: BRIDGE_PROTOCOL, ...extensionProposal() }
      : { type: 'bridge_probe', protocol: READY_PROTOCOL, authMode: mode, clientNonce: record.clientNonce }));
  };
  socket.onmessage = async (event) => {
    if (!live(record)) return;
    let data;
    try { data = JSON.parse(event.data); } catch (_) { socket.close(1002, 'invalid frame'); return; }
    if (ready(record)) {
      if (data.type === 'cancel' && typeof data.id === 'string') cancelTrackedCommand(record, data.id);
      else if (typeof data.id === 'string' && data.id && data.cmd) void executeTrackedCommand(record, data);
      return;
    }
    try {
      if (mode === 'none') {
        // Explicit mode mismatch permits a NEW paired socket, never a failed-proof downgrade.
        if (data.type === 'auth_error' && /auth mode mismatch/.test(data.error || '')) {
          record.retryMode = credentials.length ? 'paired' : 'pairing';
          socket.close(); return;
        }
        if (!record.challenge) {
          const challenge = parseNoneChallenge(data, record);
          if (!challenge) throw new Error('invalid NONE challenge');
          record.challenge = challenge;
          socket.send(JSON.stringify({ type: 'bridge_ready', protocol: READY_PROTOCOL, authMode: 'none', clientNonce: record.clientNonce,
            serverNonce: challenge.serverNonce, installationId: challenge.installationId, serverInstanceId: challenge.serverInstanceId, generation: challenge.generation }));
          return;
        }
        if (data.type !== 'bridge_ready' || data.protocol !== READY_PROTOCOL || data.port !== port
          || !sameIdentity(transportIdentity(data), transportIdentity(record.challenge))) throw new Error('invalid ready identity');
        await acceptRecord(record, data);
      } else if (mode === 'paired') {
        if (!record.challenge) {
          const challenge = parseAuthChallenge(data, port, record.clientNonce, '');
          if (!challenge) throw new Error('invalid paired challenge');
          const credential = credentials.find((entry) => entry.installationId === challenge.installationId)
            || credentials.find((entry) => !entry.installationId && entry.port === port);
          if (!credential) { record.retryMode = 'pairing'; socket.close(); return; }
          record.challenge = challenge;
          const proof = await createAuthProof(credential.token, challenge);
          if (!live(record) || record.status !== 'connecting' || challenge.expiresAt <= Date.now()) return;
          socket.send(JSON.stringify({ type: 'auth_proof', protocol: HMAC_AUTH_PROTOCOL, ...challenge, expiresAt: undefined, proof }));
          return;
        }
        if (!parseAuthenticatedHello(data, port, record.challenge.installationId) || data.authMode !== 'paired' || data.authenticated !== true
          || !isInstallationId(data.serverInstanceId) || data.generation !== record.challenge.generation) throw new Error('invalid paired hello');
        await acceptRecord(record, data);
      } else {
        if (!record.pairing) {
          record.pairing = parsePairingChallenge(data, port);
          if (!record.pairing) throw new Error('invalid pairing challenge');
          record.status = 'pairing-pending';
          clearTimeout(record.timeout);
          return;
        }
        const approved = parsePairingApproval(data, record.pairing);
        if (!approved) throw new Error('invalid pairing approval');
        record.status = 'saving-credentials';
        // Credential writes serialize with each other (and resource writes), preserving all installations.
        const saved = journalTail.then(() => storeApprovedCredentials(data, record.pairing));
        journalTail = saved.catch(() => {});
        await saved;
        if (!live(record) || record.status !== 'saving-credentials') return;
        record.credentials = [...credentials.filter((entry) => entry.installationId !== approved.installationId), approved];
        record.retryMode = 'paired';
        socket.close(1000, 'credentials stored; reconnecting');
      }
    } catch (error) {
      record.error = String(data.type === 'auth_error' ? data.error || 'handshake rejected' : error.message || error).slice(0, 256);
      record.failureStatus = /peer.*(busy|selected)|already.*connected/i.test(record.error) ? 'peer-busy' : 'auth-failed';
      socket.close(1008, 'invalid handshake or storage failure');
    }
  };
  socket.onclose = () => {
    clearTimeout(record.timeout);
    disconnectRecord(record);
    if (record.failureStatus) record.status = record.failureStatus;
    if (connections.get(port) !== record) return;
    if (record.retryMode) connectCandidate(port, record.credentials, record.retryMode);
  };
  socket.onerror = () => { try { socket.close(); } catch (_) {} };
}
async function connectWS() {
  await ensureResourceRecovery();
  if (discoveryRunning) return;
  discoveryRunning = true;
  try {
    const config = await loadConfig();
    const stored = await chrome.storage.local.get([CREDENTIALS_KEY, CUSTOM_PORTS_KEY]);
    const credentials = (Array.isArray(stored[CREDENTIALS_KEY]) ? stored[CREDENTIALS_KEY] : [])
      .filter((entry) => entry && (isInstallationId(entry.installationId) || entry.installationId === '')
        && /^[A-Za-z0-9_-]{32,}$/.test(entry.token || '') && Number.isInteger(entry.port) && entry.port > 0 && entry.port <= 65535);
    // Migrate the legacy tuple without overwriting any separately paired installation.
    if (config.token && !credentials.some((entry) => entry.installationId === config.installationId && entry.token === config.token)) {
      credentials.push(config);
      await chrome.storage.local.set({ [CREDENTIALS_KEY]: credentials });
    }
    const extra = Array.isArray(stored[CUSTOM_PORTS_KEY]) ? stored[CUSTOM_PORTS_KEY] : [];
    const ports = [...new Set([...candidatePorts(config.port, Boolean(config.token)), ...credentials.map((entry) => entry.port), ...extra])];
    for (const port of ports) if (Number.isInteger(port) && port > 0 && port <= 65535) connectCandidate(port, credentials);
  } finally { discoveryRunning = false; scheduleProbe(); }
}
let startup = null;
function startBridge() {
  if (startup) return startup;
  startup = (async () => {
    await ensureResourceRecovery();
    await connectWS();
  })();
  return startup;
}
function statusSnapshot() {
  const records = [...connections.values()];
  const connected = records.filter(ready);
  const pending = records.find((record) => record.pairing && live(record));
  return { ok: true, data: connected.length ? 'connected' : pending ? 'pairing-pending' : 'disconnected',
    port: connected[0]?.port || pending?.port || DEFAULT_WS_PORT,
    configured: records.some((record) => record.credentials.length > 0),
    installationId: connected[0]?.identity?.installationId,
    pairing: pending?.pairing || undefined,
    connections: records.map((record) => ({ port: record.port, status: record.status, ready: ready(record),
      authMode: record.identity?.authMode || record.mode, authenticated: record.identity?.authenticated === true && ready(record),
      connection: record.identity, pairing: live(record) ? record.pairing : null, inFlight: record.commands.size, error: record.error })),

    resources: { leases: [...tabLeases].map(([tabId, entry]) => ({ tabId, lease: entry.lease, owned: entry.owned, draining: entry.draining })),
      queued: operationQueue.filter((operation) => !operation.stopped).length, running: new Set(resourceLanes.values()).size,
      quarantine: { tabIds: [...quarantineTabs], global: quarantineGlobal }, journalFailed } };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Advanced writes are popup-only; status is intentionally a credential-free projection.
  if (message?.cmd === 'status') { sendResponse(statusSnapshot()); return false; }
  if (message?.cmd !== 'bridge_configure') return false;
  const trusted = !sender?.tab && (!sender?.url || sender.url.startsWith(chrome.runtime.getURL('')));
  if (!trusted) { sendResponse({ ok: false, error: 'trusted extension page required' }); return false; }
  const ports = message.ports;
  if (!Array.isArray(ports) || ports.length > 32 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    sendResponse({ ok: false, error: 'invalid ports' }); return false;
  }
  void chrome.storage.local.set({ [CUSTOM_PORTS_KEY]: [...new Set(ports)] }).then(connectWS)
    .then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pi-self-reload') { chrome.runtime.reload(); return; }
  if (alarm.name === 'pi-ws-keepalive') {
    for (const record of connections.values()) if (ready(record)) send(record, { type: 'ping' });
    scheduleKeepalive();
  }
  if (alarm.name === 'pi-ws-probe' || alarm.name === 'pi-ws-keepalive') await connectWS();
});
chrome.runtime.onStartup.addListener(startBridge);
chrome.runtime.onInstalled.addListener(startBridge); // no unjournaled browser-global DNR mutation
function sendTabsUpdate() { for (const record of connections.values()) void publishTabs(record).catch(() => {}); }
chrome.tabs.onUpdated.addListener((_, info) => { if (info.status === 'complete') sendTabsUpdate(); });
chrome.tabs.onRemoved.addListener((id) => {
  quarantineTabs.delete(id);
  const entry = tabLeases.get(id);
  if (entry) entry.removed = true;
  if (entry && !resourceLanes.has('tab:' + id)) tabLeases.delete(id);
  void persistResources().catch(() => {});
  sendTabsUpdate();
});
chrome.tabs.onCreated.addListener(sendTabsUpdate);
startBridge();
