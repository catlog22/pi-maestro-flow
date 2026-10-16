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
const { createBrowserTool } = await import('../src/tools/browser-tool.ts');
const { browserSessionScopes } = await import('../src/tools/browser/session-scope.ts');
const source = readFileSync(new URL('../optional/browser-bridge/background.js', import.meta.url), 'utf8');
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 400; i++) { if (await predicate()) return; await sleep(); } throw new Error('condition not reached'); }
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
    const beforeVideo = h.wire.length;
    await assert.rejects(a.startVideo('same-name', process.cwd(), {}, undefined, 1000), /not supported on the extension channel[\s\S]*no channel was changed/);
    await assert.rejects(a.stopVideo('same-name', undefined, 1000), /not supported on the extension channel/);
    await assert.rejects(a.videoChapter('same-name', { title: 'Chapter' }, undefined, 1000), /not supported on the extension channel/);
    await assert.rejects(a.videoShowActions('same-name', {}, undefined, 1000), /not supported on the extension channel/);
    await assert.rejects(a.videoHideActions('same-name', undefined, 1000), /not supported on the extension channel/);
    assert.equal(h.wire.length, beforeVideo, 'unsupported video must not dispatch bridge commands');
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

test('interrupted local run reopens in place and late adapters cannot affect the next round', async () => {
  const h = await extension(); const manager = new BrowserManager();
  const key = `piBrowserRecovery-${webcrypto.randomUUID()}`;
  const resume = gate(); const late = gate();
  globalThis[key] = { resume: resume.promise, complete: late.resolve, error: null };
  try {
    await manager.open({ name: 'owned', url: 'https://owned.example/', channel: 'extension', cwd: process.cwd(), timeoutMs: 1500 });
    const claimId = h.snapshot().resources.leases.find((item) => item.tabId === 10).lease.claimId;
    await assert.rejects(run(manager, 'owned', `const state = globalThis[${JSON.stringify(key)}]; await state.resume; try { await page.goto('https://late.example/'); } catch (error) { state.error = error.name; } finally { state.complete(); }`, 30), /timed out/);
    const status = (await manager.status()).namedTabs[0];
    assert.equal(status.state, 'needs_revalidation'); assert.equal(status.pendingCommands, 0);
    await assert.rejects(run(manager, 'owned', 'return 1;'), /reopen it to revalidate/);
    await manager.open({ name: 'owned', channel: 'extension', cwd: process.cwd(), timeoutMs: 1500 });
    assert.equal(h.tabs.get(10).url, 'https://owned.example/');
    assert.equal(h.snapshot().resources.leases.find((item) => item.tabId === 10).lease.claimId, claimId);
    assert.equal((await run(manager, 'owned', 'return await page.evaluate(() => 1);')).returnValue, 10);
    resume.resolve(); await late.promise;
    assert.equal(globalThis[key].error, 'AbortError');
    assert.ok(!h.calls.some((call) => call[0] === 'update' && call[1] === 10));
    assert.equal((await manager.status()).namedTabs[0].state, 'ready');
  } finally { resume.resolve(); await manager.closeAll(); delete globalThis[key]; await h.stop(); }
});

test('interrupted remote run reopens only after real terminal and does not block another tab', async () => {
  const command = gate(), detach = gate();
  const h = await extension((chrome, { calls }) => {
    chrome.debugger.sendCommand = async ({ tabId }) => { calls.push(['cdp-start', tabId]); if (tabId === 1) await command.promise; return { tabId }; };
    chrome.debugger.detach = async ({ tabId }) => { calls.push(['detach-start', tabId]); if (tabId === 1) await detach.promise; };
  });
  const a = new BrowserManager(), b = new BrowserManager();
  try {
    await open(a, 'main', 'one.example'); await open(b, 'main', 'two.example');
    const running = run(a, 'main', "return await tab.cdp('Runtime.evaluate');", 60);
    await until(() => h.calls.some((call) => call[0] === 'cdp-start' && call[1] === 1));
    assert.equal((await a.status()).namedTabs[0].state, 'busy');
    await assert.rejects(open(a, 'main', 'one.example'), /is busy/);
    await assert.rejects(running, /timed out/);
    const status = (await a.status()).namedTabs[0];
    assert.equal(status.state, 'draining'); assert.equal(status.pendingCommands, 1); assert.equal(status.drainingCommands, 1);
    await assert.rejects(open(a, 'main', 'one.example'), /is draining/);
    assert.equal((await run(b, 'main', "return await tab.cdp('Runtime.evaluate');")).returnValue.tabId, 2);
    command.resolve(); await until(() => h.calls.some((call) => call[0] === 'detach-start' && call[1] === 1));
    await assert.rejects(open(a, 'main', 'one.example'), /is draining/);
    detach.resolve(); await until(async () => (await a.status()).namedTabs[0].state === 'needs_revalidation');
    await open(a, 'main', 'one.example');
    assert.equal((await run(a, 'main', "return await tab.cdp('Runtime.evaluate');")).returnValue.tabId, 1);
    await assert.rejects(open(b, 'other', 'one.example'), /tab_busy/);
  } finally { command.resolve(); detach.resolve(); await a.closeAll(); await b.closeAll(); await h.stop(); }
});

test('successful run fences late secondary claims before a later run starts', async () => {
  const h = await extension(); const manager = new BrowserManager();
  const key = `piBrowserLate-${webcrypto.randomUUID()}`; const late = gate(); const resume = gate();
  globalThis[key] = { resume: resume.promise, complete: late.resolve, error: null };
  try {
    await open(manager, 'main', 'one.example');
    await run(manager, 'main', `const state = globalThis[${JSON.stringify(key)}]; const pages = await browser.pages(); void state.resume.then(async () => { try { await pages[1].title(); } catch (error) { state.error = error.name; } finally { state.complete(); } }); return true;`);
    await run(manager, 'main', 'return true;');
    resume.resolve(); await late.promise;
    assert.equal(globalThis[key].error, 'AbortError');
    assert.ok(!h.wire.some((frame) => frame.cmd === 'claim' && frame.tabId === 2));
    assert.equal((await manager.status()).namedTabs[0].state, 'ready');
  } finally { resume.resolve(); await manager.closeAll(); delete globalThis[key]; await h.stop(); }
});

test('failed revalidation stays fenced and a replacement connection cannot revive an old binding', async () => {
  let rejectGet = false;
  let h = await extension((chrome) => {
    const get = chrome.tabs.get;
    chrome.tabs.get = async (id) => { if (rejectGet) throw new Error('injected tab read failure'); return get(id); };
  });
  const manager = new BrowserManager(), replacement = new BrowserManager(); const abort = new AbortController();
  try {
    await open(manager, 'main', 'one.example');
    const running = manager.run('main', 'await wait(100);', process.cwd(), abort.signal, 1500);
    abort.abort(); await assert.rejects(running, /aborted/);
    rejectGet = true;
    await assert.rejects(open(manager, 'main', 'one.example'), /injected tab read failure/);
    assert.equal((await manager.status()).namedTabs[0].state, 'needs_revalidation');
    await assert.rejects(run(manager, 'main', 'return 1;'), /is draining/);
    rejectGet = false;
    await h.stop();
    assert.equal((await manager.status()).namedTabs[0].state, 'disconnected');
    h = await extension();
    await assert.rejects(open(manager, 'main', 'one.example'), /generation mismatch/);
    assert.equal((await manager.status()).namedTabs[0].state, 'disconnected');
    assert.equal(h.snapshot().resources.leases.length, 0);
    await open(replacement, 'fresh', 'one.example');
    const freshClaim = h.snapshot().resources.leases[0].lease.claimId;
    assert.equal(await manager.closeAll(), 1);
    assert.equal(manager.has('main'), false);
    assert.equal(h.snapshot().resources.leases[0].lease.claimId, freshClaim);
  } finally { abort.abort(); await replacement.closeAll(); await h.stop(); await manager.closeAll(); }
});

test('failed physical disposal retains the named binding and closeAll reports failure until retry', async () => {
  let refuseRemove = true;
  const h = await extension((chrome) => {
    const remove = chrome.tabs.remove;
    chrome.tabs.remove = async (id) => { if (refuseRemove) throw new Error('injected remove failure'); return remove(id); };
  });
  const manager = new BrowserManager();
  try {
    await manager.open({ name: 'owned', url: 'https://owned.example/', channel: 'extension', cwd: process.cwd(), timeoutMs: 1500 });
    await assert.rejects(manager.close('owned'), /injected remove failure/);
    assert.equal(manager.has('owned'), true); assert.equal(h.tabs.has(10), true);
    assert.equal((await manager.status()).namedTabs[0].state, 'closed');
    await assert.rejects(run(manager, 'owned', 'return 1;'), /aborted/);
    await assert.rejects(manager.closeAll(), /ownership is retained for retry/);
    assert.equal(manager.has('owned'), true); assert.equal(h.tabs.has(10), true);
    refuseRemove = false;
    assert.equal(await manager.closeAll(), 1);
    assert.equal(manager.has('owned'), false); assert.equal(h.tabs.has(10), false);
    assert.equal(h.snapshot().resources.leases.length, 0);
  } finally { refuseRemove = false; await manager.closeAll(); await h.stop(); }
});

test('interrupted open retains failed provisional cleanup for closeAll retry', async () => {
  const createGate = gate(); let started = false; let refuseRemove = true;
  const h = await extension((chrome) => {
    const create = chrome.tabs.create, remove = chrome.tabs.remove;
    chrome.tabs.create = async (options) => { started = true; await createGate.promise; return create(options); };
    chrome.tabs.remove = async (id) => { if (refuseRemove) throw new Error('injected provisional remove failure'); return remove(id); };
  });
  const manager = new BrowserManager();
  try {
    const opening = manager.open({ name: 'late', url: 'https://late.example/', channel: 'extension', cwd: process.cwd(), timeoutMs: 30 }).then(() => null, (error) => error);
    await until(() => started); await sleep(40); createGate.resolve();
    const failure = await opening;
    assert.ok(failure instanceof AggregateError);
    assert.equal(h.tabs.has(10), true);
    await assert.rejects(manager.closeAll(), /cleanup failed/);
    refuseRemove = false;
    await manager.closeAll();
    assert.equal(h.tabs.has(10), false); assert.equal(h.snapshot().resources.leases.length, 0);
  } finally { createGate.resolve(); refuseRemove = false; await manager.closeAll(); await h.stop(); }
});

test('trusted host sessions keep equal names and interrupted cleanup isolated across real extension leases', async () => {
  const command = gate();
  const h = await extension((chrome, { calls }) => {
    chrome.debugger.sendCommand = async ({ tabId }) => { calls.push(['cdp-start', tabId]); if (tabId === 1) await command.promise; return { tabId }; };
  });
  const first = createBrowserTool(), second = createBrowserTool();
  const a = `session-a-${webcrypto.randomUUID()}`, b = `session-b-${webcrypto.randomUUID()}`;
  const ctx = (id) => ({ cwd: process.cwd(), sessionManager: { getSessionId: () => id } });
  const invoke = (tool, id, input, signal = new AbortController().signal) => tool.execute('integration', input, signal, undefined, ctx(id));
  const abort = new AbortController();
  try {
    assert.ok(!(await invoke(first, a, { action: 'open', app: { channel: 'extension', target: 'one.example' } })).isError);
    assert.ok(!(await invoke(second, b, { action: 'open', app: { channel: 'extension', target: 'two.example' } })).isError);
    assert.deepEqual((await invoke(second, a, { action: 'status' })).details.status.namedTabs.map((tab) => tab.name), ['main']);
    const interrupted = invoke(first, a, { action: 'run', code: "return await tab.cdp('Runtime.evaluate');" }, abort.signal);
    await until(() => h.calls.some((call) => call[0] === 'cdp-start' && call[1] === 1));
    abort.abort(); await assert.rejects(interrupted, { name: 'AbortError' });
    let closed = false;
    const cleanup = browserSessionScopes.closeSession(a).then(() => { closed = true; });
    await assert.rejects(invoke(second, a, { action: 'run', code: 'return 1;' }), /scope is shutting down/);
    const unaffected = await invoke(first, b, { action: 'run', code: 'return await page.evaluate(() => 1);' });
    assert.ok(!unaffected.isError); assert.equal(closed, false);
    command.resolve(); await cleanup;
    assert.equal(browserBridge.isConnected(), true);
    assert.equal(h.tabs.has(1), true);
    assert.deepEqual(Array.from(h.snapshot().resources.leases, (item) => item.tabId), [2]);
    assert.equal((await invoke(second, b, { action: 'status' })).details.status.namedTabs[0].state, 'ready');
    assert.ok(!(await invoke(second, a, { action: 'open', app: { channel: 'extension', target: 'one.example' } })).isError);
    assert.ok(!(await invoke(first, a, { action: 'close', all: true })).isError);
    assert.deepEqual(Array.from(h.snapshot().resources.leases, (item) => item.tabId), [2]);
  } finally { command.resolve(); abort.abort(); await browserSessionScopes.closeSession(a); await browserSessionScopes.closeSession(b); await h.stop(); }
});

test.after(async () => { await browserBridge.shutdown(); rmSync(directory, { recursive: true, force: true }); });
