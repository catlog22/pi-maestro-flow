import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import net from 'node:net';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';

const directory = mkdtempSync(join(tmpdir(), 'pi-manager-lease-'));
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
process.env.PI_BROWSER_BRIDGE_DIR = directory;
process.env.PI_BROWSER_BRIDGE_PORT = String(port);
process.env.PI_BROWSER_BRIDGE_AUTH_MODE = 'none';
const { browserBridge } = await import('../src/tools/browser/bridge-server.ts');
const { BrowserManager } = await import('../src/tools/browser/manager.ts');
const { TeammateBrowserBroker } = await import('../src/teammate/browser-broker.ts');
const source = readFileSync(new URL('../optional/browser-bridge/background.js', import.meta.url), 'utf8');
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 400; i++) { if (predicate()) return; await sleep(); } throw new Error('condition not reached'); }
function gate() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function event() { const listeners = new Set(); return { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f), emit: (...args) => { for (const f of listeners) f(...args); } }; }
async function extension(api = () => {}) {
  await browserBridge.start();
  const tabs = new Map([[1, { id: 1, url: 'https://one.example/', title: 'One' }], [2, { id: 2, url: 'https://two.example/', title: 'Two' }], [3, { id: 3, url: 'https://three.example/', title: 'Three' }]]);
  const calls = [], wire = [], storage = {}, session = {}, sockets = [], timers = new Set();
  const created = event(), removed = event();
  let nextTab = 10;
  const chrome = {
    storage: {
      local: { setAccessLevel: async () => {}, get: async (keys) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])), set: async (value) => { Object.assign(storage, structuredClone(value)); } },
      session: { get: async () => ({ ...session }), set: async (value) => { Object.assign(session, value); } },
    },
    tabs: {
      query: async () => [...tabs.values()], get: async (id) => { calls.push(['get', id]); if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return tabs.get(id); },
      create: async (opts) => { const tab = { id: nextTab++, url: 'about:blank', ...opts }; tabs.set(tab.id, tab); created.emit(tab); calls.push(['create', tab.id]); return tab; },
      update: async (id, opts) => { calls.push(['update', id]); Object.assign(tabs.get(id), opts); return tabs.get(id); },
      remove: async (id) => { calls.push(['remove', id]); tabs.delete(id); removed.emit(id); },
      sendMessage: async () => {}, onCreated: created, onUpdated: event(), onRemoved: removed,
    },
    debugger: { attach: async ({ tabId }) => { calls.push(['attach', tabId]); }, sendCommand: async ({ tabId }, method) => { calls.push(['cdp', tabId, method]); return { tabId }; }, detach: async ({ tabId }) => { calls.push(['detach', tabId]); } },
    scripting: { executeScript: async ({ target }) => { calls.push(['exec', target.tabId]); return [{ result: { ok: true, data: target.tabId } }]; } },
    cookies: { getAll: async () => [], set: async (details) => { calls.push(['cookies.set']); return details; }, remove: async () => ({}) },
    management: { getAll: async () => [] }, contentSettings: {}, declarativeNetRequest: {}, windows: { update: async () => {} },
    alarms: { create() {}, onAlarm: event() },
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: () => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/', onMessage: event(), onStartup: event(), onInstalled: event(), reload() {} },
  };
  api(chrome, { tabs, calls, created });
  class ScopedSocket extends WebSocket {
    constructor(url) { if (url !== `ws://127.0.0.1:${port}`) throw new Error('test listener only'); super(url); sockets.push(this); this.on('message', (raw) => { const frame = JSON.parse(raw.toString()); if (frame.cmd) wire.push(frame); }); }
  }
  const context = vm.createContext({ chrome, WebSocket: ScopedSocket, crypto: webcrypto, TextEncoder, btoa, console,
    setTimeout: (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; }, clearTimeout: (id) => { timers.delete(id); clearTimeout(id); } });
  vm.runInContext(source.replace(/^const DEFAULT_WS_PORT = \d+;/m, `const DEFAULT_WS_PORT = ${port};`).replace(/^const DISCOVERY_LAST_PORT = \d+;/m, `const DISCOVERY_LAST_PORT = ${port};`), context);
  vm.runInContext('globalThis.testApi = { startup: () => startup, snapshot: statusSnapshot };', context);
  await context.testApi.startup();
  await until(() => browserBridge.isConnected() && browserBridge.tabs().length === 3);
  return { tabs, calls, wire, snapshot: () => context.testApi.snapshot(), async stop() { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.terminate(); await until(() => !browserBridge.isConnected()); await browserBridge.shutdown(); } };
}
const open = (manager, name, target) => manager.open({ name, target, channel: 'extension', cwd: process.cwd(), timeoutMs: 1500 });
const run = (manager, name, code, timeout = 1500) => manager.run(name, code, process.cwd(), undefined, timeout);

test('T3 NONE manager reports live readiness not authentication or stale history; opaque entries compete on real tabs', async () => {
  const h = await extension(); const a = new BrowserManager(), b = new BrowserManager();
  try {
    const status = (await a.status()).bridge;
    assert.equal(status.authMode, 'none'); assert.equal(status.transportReady, true); assert.equal(status.transportConnected, true);
    assert.equal(status.authenticatedConnected, false); assert.equal(status.state, 'connected'); assert.equal(status.tabCount, 3); assert.deepEqual(status.pendingPairings, []);
    assert.ok(status.serverInstanceId); assert.ok(status.connectionGeneration);
    await open(a, 'same-name', 'one.example');
    const oldOwner = h.wire.find((frame) => frame.cmd === 'claim').owner;
    assert.notEqual(oldOwner.ownerId, 'same-name');
    await assert.rejects(open(b, 'same-name', 'one.example'), /tab_busy/);
    assert.equal(h.tabs.has(1), true);
    await a.close('same-name');
    await open(b, 'same-name', 'one.example');
    const claims = h.wire.filter((frame) => frame.cmd === 'claim');
    assert.notEqual(claims.at(-1).owner.ownerId, oldOwner.ownerId);
    await b.closeAll();
    assert.ok(h.wire.some((frame) => frame.cmd === 'release' && frame.close === false));
    assert.equal(h.tabs.has(1), true);
    await h.stop();
    const offline = (await a.status()).bridge;
    assert.equal(offline.transportReady, false); assert.equal(offline.authenticatedConnected, false); assert.equal(offline.tabCount, 0);
  } finally { await a.closeAll(); await b.closeAll(); await h.stop(); }
});

test('T3 secondary adapters lazily single-flight claim targets, batch carries lease, close releases extras', async () => {
  const h = await extension(); const a = new BrowserManager(), b = new BrowserManager();
  try {
    await open(a, 'a', 'one.example'); await open(b, 'b', 'two.example');
    await assert.rejects(run(a, 'a', "const pages = await browser.pages(); return await pages[1].evaluate(() => 1);"), /tab_busy/);
    assert.ok(!h.calls.some((call) => call[0] === 'exec' && call[1] === 2));
    await b.closeAll();
    const result = await run(a, 'a', "const pages = await browser.pages(); await Promise.all([pages[1].title(), pages[1].evaluate(() => 1)]); await pages[1].goto('https://two.example/changed'); return await tab.cdpBatch([{method:'Runtime.evaluate',params:{expression:'1'}},{method:'Runtime.evaluate',params:{expression:'$0.tabId'}}]);");
    assert.equal(result.returnValue.length, 2);
    const secondClaims = h.wire.filter((frame) => frame.cmd === 'claim' && frame.tabId === 2 && frame.owner.ownerId === h.wire.find((frame) => frame.cmd === 'claim').owner.ownerId);
    assert.equal(secondClaims.length, 2, 'one rejected competition plus one successful single-flight claim');
    const batch = h.wire.find((frame) => frame.cmd === 'batch'); assert.ok(batch.lease.claimId); assert.equal(batch.owner.ownerId, batch.lease.ownerId);
    await a.closeAll();
    assert.equal(h.snapshot().resources.leases.length, 0); assert.equal(h.tabs.has(2), true);
    await open(b, 'b', 'two.example'); await b.closeAll();
  } finally { await a.closeAll(); await b.closeAll(); await h.stop(); }
});

test('T3 existing broker actor prefix isolates equal names and actor close leaves other real lease intact', async () => {
  const h = await extension(); const manager = new BrowserManager(); const broker = new TeammateBrowserBroker(manager);
  const request = (id, input) => ({ toolName: 'browser', input, actor: { correlationId: id, agent: 'general' } });
  const ctx = { cwd: process.cwd() };
  try {
    const one = await broker.execute(request('one', { action: 'open', name: 'main', app: { channel: 'extension', target: 'one.example' } }), ctx);
    const two = await broker.execute(request('two', { action: 'open', name: 'main', app: { channel: 'extension', target: 'two.example' } }), ctx);
    assert.ok(!one.isError && !two.isError);
    assert.deepEqual((await manager.status()).namedTabs.map((tab) => tab.name), ['teammate:one:main', 'teammate:two:main']);
    assert.equal(await broker.closeActor('one'), 1);
    assert.equal(h.snapshot().resources.leases.length, 1); assert.equal(h.snapshot().resources.leases[0].tabId, 2);
    const twoStatus = await broker.execute(request('two', { action: 'status' }), ctx);
    assert.equal(twoStatus.details.status.bridge.authenticatedConnected, false);
    assert.equal(twoStatus.details.status.bridge.transportReady, true);
    assert.equal(twoStatus.details.status.namedTabs[0].name, 'main');
  } finally { await broker.closeAll(); await h.stop(); }
});

test('T3 owned close and caller timeout wait real debugger cleanup terminal', async () => {
  const g = gate(), detach = gate();
  const h = await extension((chrome, { calls }) => {
    chrome.debugger.sendCommand = async () => { calls.push(['cdp-start']); await g.promise; return {}; };
    chrome.debugger.detach = async () => { calls.push(['detach-start']); await detach.promise; calls.push(['detach-done']); };
  });
  const a = new BrowserManager();
  try {
    await a.open({ name: 'owned', url: 'https://owned.example/', channel: 'extension', cwd: process.cwd(), timeoutMs: 1500 });
    const running = run(a, 'owned', "return await tab.cdp('Runtime.evaluate');", 60);
    await until(() => h.calls.some((call) => call[0] === 'cdp-start'));
    await assert.rejects(running, /timed out/);
    assert.equal((await a.status()).bridge.drainingCommands, 1);
    let closed = false; const closing = a.close('owned').then(() => { closed = true; });
    await sleep(20); assert.equal(closed, false); assert.equal(h.tabs.has(10), true);
    g.resolve(); await until(() => h.calls.some((call) => call[0] === 'detach-start'));
    assert.equal(h.tabs.has(10), true); detach.resolve(); await closing;
    assert.equal(h.tabs.has(10), false); assert.ok(h.wire.some((frame) => frame.cmd === 'release' && frame.close && frame.lease.claimId));
  } finally { g.resolve(); detach.resolve(); await a.closeAll(); await h.stop(); }
});

test('T3 late created tab terminal is retired after interrupted open and global cookie lane is wired', async () => {
  const createGate = gate(); const cookieGate = gate(); let createStarted = false;
  const h = await extension((chrome, { calls }) => {
    const create = chrome.tabs.create; chrome.tabs.create = async (opts) => { createStarted = true; await createGate.promise; return create(opts); };
    chrome.cookies.set = async (details) => { calls.push(['cookie-start', details.name]); if (details.name === 'first') await cookieGate.promise; return details; };
  });
  const a = new BrowserManager(), b = new BrowserManager();
  try {
    const opening = a.open({ name: 'late', url: 'https://late.example/', channel: 'extension', cwd: process.cwd(), timeoutMs: 60 }).then(() => null, (error) => error);
    await until(() => createStarted); await sleep(90);
    createGate.resolve(); assert.match((await opening).message, /timed out/);
    await until(() => !h.tabs.has(10));
    assert.equal(h.snapshot().resources.leases.length, 0);
    await open(a, 'a', 'one.example'); await open(b, 'b', 'two.example');
    const first = run(a, 'a', "return await tab.cookies.set({name:'first',value:'1',domain:'example.com'});");
    await until(() => h.calls.some((call) => call[0] === 'cookie-start'));
    const second = run(b, 'b', "return await tab.cookies.set({name:'second',value:'2',domain:'example.com'});");
    await sleep(20); assert.equal(h.calls.filter((call) => call[0] === 'cookie-start').length, 1);
    cookieGate.resolve(); await first; await second;
    assert.ok(h.wire.filter((frame) => frame.cmd === 'cookies').every((frame) => frame.owner && frame.lease && frame.connection.authenticated === false));
  } finally { createGate.resolve(); cookieGate.resolve(); await a.closeAll(); await b.closeAll(); await h.stop(); }
});

test('T3 manager owns only proven opener newTabs and releases descendants without touching unrelated tabs', async () => {
  const h = await extension((chrome, { tabs, calls, created }) => {
    chrome.scripting.executeScript = async ({ target }) => {
      calls.push(['exec', target.tabId]);
      const proven = { id: 20, url: 'https://child.example/', openerTabId: target.tabId };
      const unrelated = { id: 21, url: 'https://unrelated.example/' };
      tabs.set(20, proven); tabs.set(21, unrelated); created.emit(proven); created.emit(unrelated);
      return [{ result: { ok: true, data: true } }];
    };
  });
  const manager = new BrowserManager();
  try {
    await open(manager, 'parent', 'one.example');
    const result = await run(manager, 'parent', 'return await page.evaluate(() => true);');
    assert.deepEqual(result.newTabs, [{ url: 'https://child.example/' }]);
    assert.ok(h.snapshot().resources.leases.some((entry) => entry.tabId === 20 && entry.owned));
    assert.ok(!h.snapshot().resources.leases.some((entry) => entry.tabId === 21));
    await manager.closeAll();
    assert.equal(h.tabs.has(1), true); assert.equal(h.tabs.has(20), false); assert.equal(h.tabs.has(21), true);
  } finally { await manager.closeAll(); await h.stop(); }
});

test.after(async () => { await browserBridge.shutdown(); rmSync(directory, { recursive: true, force: true }); });
