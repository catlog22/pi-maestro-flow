import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto, randomUUID } from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import { BrowserBridgeServer } from '../src/tools/browser/bridge-server.ts';

const source = readFileSync(new URL('../optional/browser-bridge/background.js', import.meta.url), 'utf8');
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await sleep(); }
  throw new Error('condition not reached');
}
function gate() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function event() { const listeners = new Set(); return { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f), emit: (...args) => { for (const f of listeners) f(...args); } }; }
function harness({ storage = {}, session = {}, api = () => {}, socketClass, ports = [] } = {}) {
  const tabs = new Map([[1, { id: 1, url: 'https://one.example' }], [2, { id: 2, url: 'https://two.example' }], [3, { id: 3, url: 'https://three.example' }]]);
  const writes = [], calls = [], created = event(), removed = event(), alarms = event(), messages = event();
  let nextTab = 10;
  class OfflineSocket { static OPEN = 1; constructor() { throw new Error('offline VM: no live ports'); } }
  const chrome = {
    storage: {
      local: { setAccessLevel: async () => {}, get: async (keys) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])), set: async (value) => { writes.push(structuredClone(value)); Object.assign(storage, structuredClone(value)); } },
      session: { get: async () => ({ ...session }), set: async (value) => { Object.assign(session, value); } },
    },
    tabs: {
      query: async () => [...tabs.values()],
      get: async (id) => { if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return tabs.get(id); },
      create: async (opts) => { const tab = { id: nextTab++, url: 'about:blank', ...opts }; tabs.set(tab.id, tab); created.emit(tab); calls.push(['create', tab.id]); return tab; },
      update: async (id, opts) => { calls.push(['update', id]); Object.assign(tabs.get(id), opts); return tabs.get(id); },
      remove: async (id) => { calls.push(['remove', id]); tabs.delete(id); removed.emit(id); },
      sendMessage: async () => {}, onCreated: created, onUpdated: event(), onRemoved: removed,
    },
    debugger: { attach: async ({ tabId }) => { calls.push(['attach', tabId]); }, sendCommand: async ({ tabId }, method) => { calls.push(['cdp', tabId, method]); return { value: tabId }; }, detach: async ({ tabId }) => { calls.push(['detach', tabId]); } },
    scripting: { executeScript: async ({ target }) => { calls.push(['exec', target.tabId]); return [{ result: { ok: true, data: target.tabId } }]; } },
    cookies: { getAll: async () => [], set: async (details) => { calls.push(['cookies.set']); return details; }, remove: async () => ({}) },
    management: { getAll: async () => [], setEnabled: async () => { calls.push(['management']); } },
    contentSettings: { automaticDownloads: { set: async () => { calls.push(['contentSettings']); } } },
    declarativeNetRequest: { updateDynamicRules: async () => { calls.push(['dnr']); } },
    windows: { update: async () => {} },
    alarms: { create() {}, onAlarm: alarms },
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: () => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/', onMessage: messages, onStartup: event(), onInstalled: event(), reload() {} },
  };
  api(chrome, { tabs, calls, created, removed });
  // Even accidental config ports cannot reach live listeners: real WS wrapper is allowlisted.
  const context = vm.createContext({ chrome, WebSocket: socketClass || OfflineSocket, crypto: webcrypto, TextEncoder, btoa, console, setTimeout, clearTimeout });
  const scoped = ports.length ? source.replace(/^const DEFAULT_WS_PORT = \d+;/m, `const DEFAULT_WS_PORT = ${ports[0]};`).replace(/^const DISCOVERY_LAST_PORT = \d+;/m, `const DISCOVERY_LAST_PORT = ${ports[0]};`) : source;
  vm.runInContext(scoped, context);
  vm.runInContext(`globalThis.testApi = {
    start: () => startup, discover: connectWS, snapshot: statusSnapshot, recover: recoverResources,
    add(port, generation = 1, instance = crypto.randomUUID()) {
      const frames = [];
      const record = { port, socket: { readyState: 1, send: (frame) => frames.push(JSON.parse(frame)) }, status: 'connected',
        credentials: [], commands: new Map(), localId: crypto.randomUUID(), mode: 'none', identity: { installationId: crypto.randomUUID(), serverInstanceId: instance, generation, authMode: 'none', authenticated: false } };
      connections.set(port, record); return { record, frames };
    },
    execute: executeTrackedCommand, cancel: cancelTrackedCommand,
    disconnect(record) { record.socket.readyState = 3; disconnectRecord(record); },
    stop() { for (const record of connections.values()) { clearTimeout(record.timeout); try { record.socket.close(); } catch (_) {} } },
  };`, context);
  const bridge = context.testApi;
  return { bridge, chrome, tabs, calls, writes, storage, session, created, removed, alarms, messages };
}
const owner = (id) => ({ namespace: 'test', ownerId: id });
async function enqueue(h, peer, payload) {
  const id = payload.id || randomUUID();
  await h.bridge.execute(peer.record, { ...payload, id, connection: peer.record.identity });
  return id;
}
async function terminal(peer, id) {
  await until(() => peer.frames.some((frame) => frame.id === id && ['result', 'error'].includes(frame.type)));
  return peer.frames.find((frame) => frame.id === id && ['result', 'error'].includes(frame.type));
}
async function command(h, peer, payload) { return terminal(peer, await enqueue(h, peer, payload)); }
async function claimed(h, peer, tabId, name = 'a') {
  const reply = await command(h, peer, { cmd: 'claim', tabId, owner: owner(name) });
  assert.equal(reply.type, 'result', JSON.stringify(reply));
  return reply.data.lease;
}

// Focused behavior cases are selectable independently with --test-name-pattern.
test('resources competing owners reject same tab, same owner serializes, different tabs parallel', async () => {
  const gates = new Map([[1, gate()], [2, gate()]]);
  const h = harness({ api: (chrome, { calls }) => { chrome.debugger.sendCommand = async ({ tabId }) => { calls.push(['cdp', tabId]); await gates.get(tabId).promise; return { tabId }; }; } });
  await h.bridge.start();
  const a = h.bridge.add(1), b = h.bridge.add(2);
  const lease = await claimed(h, a, 1);
  const first = await enqueue(h, a, { cmd: 'cdp', tabId: 1, method: 'Runtime.evaluate', owner: owner('a'), lease });
  await until(() => h.calls.some((call) => call[0] === 'cdp'));
  const busy = await command(h, b, { cmd: 'cdp', tabId: 1, method: 'Runtime.evaluate' });
  assert.match(busy.error, /tab_busy/);
  const serial = await enqueue(h, a, { cmd: 'cdp', tabId: 1, method: 'Runtime.evaluate', owner: owner('a'), lease });
  const parallel = await enqueue(h, b, { cmd: 'cdp', tabId: 2, method: 'Runtime.evaluate' });
  await until(() => h.calls.filter((call) => call[0] === 'cdp').length === 2);
  assert.equal(h.bridge.snapshot().resources.queued, 1);
  gates.get(2).resolve(); await terminal(b, parallel);
  gates.get(1).resolve(); await terminal(a, first); await terminal(a, serial);
  assert.equal(h.calls.filter((call) => call[0] === 'cdp' && call[1] === 1).length, 2);
});

test('resources secondary adapters and legacy commands cannot bypass leases; batch reserves all or none', async () => {
  const h = harness(); await h.bridge.start(); const a = h.bridge.add(1), b = h.bridge.add(2);
  await claimed(h, a, 2);
  const payloads = [
    { cmd: 'exec', tabId: 2, code: '1' }, { cmd: 'cdp', tabId: 2, method: 'Page.navigate' },
    { cmd: 'cookies', tabId: 2, method: 'get' }, { cmd: 'tabs', tabId: 2, method: 'get' },
    { cmd: 'tabs', tabId: 2, method: 'update', url: 'https://changed.example' },
    { cmd: 'tabs', tabId: 2, method: 'switch' }, { cmd: 'tabs', tabId: 2, method: 'close' },
    { cmd: 'tabs', method: 'create', openerTabId: 2 },
    { cmd: 'batch', commands: [{ cmd: 'tabs', method: 'update', tabId: 1, url: 'https://first.example' }, { cmd: 'cdp', tabId: 2, method: 'Runtime.evaluate' }] },
  ];
  for (const payload of payloads) assert.match((await command(h, b, payload)).error, /tab_busy/);
  assert.deepEqual(h.calls, []);
  assert.ok(!h.bridge.snapshot().resources.leases.some((entry) => entry.tabId === 1), 'batch first target is not partially reserved');
  const dynamic = await command(h, b, { cmd: 'batch', commands: [{ cmd: 'tabs', method: 'create' }, { cmd: 'cdp', tabId: '$0.id', method: 'Runtime.evaluate' }] });
  assert.match(dynamic.error, /deterministic/); assert.deepEqual(h.calls, []);
  assert.equal((await command(h, b, { cmd: 'tabs', method: 'query' })).type, 'result', 'query observes without ownership');
  const lease = await claimed(h, b, 1, 'b');
  assert.equal((await command(h, b, { cmd: 'batch', owner: owner('b'), leases: [{ tabId: 1, lease }], commands: [{ cmd: 'cdp', tabId: 1, method: 'Runtime.evaluate' }, { cmd: 'tabs', tabId: 1, method: 'get' }] })).type, 'result');
});

test('resources equal request IDs isolate results and queued/started cancellation', async () => {
  const g = gate();
  const h = harness({ api: (chrome) => { chrome.debugger.sendCommand = async () => { await g.promise; return { done: true }; }; } });
  await h.bridge.start(); const a = h.bridge.add(1), b = h.bridge.add(2);
  const first = await enqueue(h, a, { id: 'same', cmd: 'cdp', tabId: 1, method: 'Runtime.evaluate' });
  await until(() => h.calls.some((call) => call[0] === 'attach'));
  await enqueue(h, b, { id: 'same', cmd: 'tabs', tabId: 2, method: 'update', url: 'https://cancel.example' });
  h.bridge.cancel(b.record, 'same');
  h.bridge.cancel(a.record, 'same');
  assert.equal(b.frames.find((frame) => frame.type === 'cancel_ack').stopped, true);
  assert.equal(a.frames.find((frame) => frame.type === 'cancel_ack').stopped, false);
  g.resolve(); await terminal(a, first); await sleep(20);
  assert.ok(!b.frames.some((frame) => frame.type === 'result'));
  assert.ok(!h.calls.some((call) => call[0] === 'update'));
  assert.ok(h.calls.some((call) => call[0] === 'detach'), 'started cancel keeps debugger cleanup');
});

test('resources disconnect keeps started lanes through debugger cleanup; reconnect reverse interleaving cannot steal or erase', async () => {
  const g = gate(), detach = gate();
  const h = harness({ api: (chrome, { calls }) => {
    chrome.debugger.sendCommand = async () => { await g.promise; return {}; };
    chrome.debugger.detach = async ({ tabId }) => { calls.push(['detach-enter', tabId]); await detach.promise; calls.push(['detach-terminal', tabId]); };
  } });
  await h.bridge.start(); const old = h.bridge.add(1), other = h.bridge.add(2);
  await enqueue(h, old, { cmd: 'cdp', tabId: 1, method: 'Runtime.evaluate' });
  await until(() => h.calls.some((call) => call[0] === 'attach'));
  await enqueue(h, old, { id: 'queued', cmd: 'tabs', tabId: 1, method: 'update', url: 'https://never.example' });
  h.bridge.disconnect(old.record);
  const fresh = h.bridge.add(1, 2, old.record.identity.serverInstanceId);
  assert.match((await command(h, fresh, { cmd: 'claim', tabId: 1, owner: owner('fresh') })).error, /tab_busy/);
  const newLease = await claimed(h, fresh, 2, 'fresh');
  assert.equal((await command(h, other, { cmd: 'tabs', tabId: 3, method: 'get' })).type, 'result');
  g.resolve(); await until(() => h.calls.some((call) => call[0] === 'detach-enter'));
  assert.match((await command(h, fresh, { cmd: 'claim', tabId: 1, owner: owner('fresh') })).error, /tab_busy/);
  detach.resolve(); await until(() => !h.bridge.snapshot().resources.leases.some((entry) => entry.tabId === 1));
  await claimed(h, fresh, 1, 'fresh');
  assert.ok(h.bridge.snapshot().resources.leases.some((entry) => entry.tabId === 2 && entry.lease.claimId === newLease.claimId));
  assert.ok(!old.frames.some((frame) => frame.type === 'result'));
  assert.ok(!h.calls.some((call) => call[0] === 'update'));
});

test('resources create publishes assigned owner lease; release borrowed stays open and owned close waits terminal', async () => {
  const g = gate();
  const h = harness({ api: (chrome) => { chrome.debugger.sendCommand = async () => { await g.promise; return {}; }; } });
  await h.bridge.start(); const a = h.bridge.add(1), b = h.bridge.add(2);
  const created = await command(h, a, { cmd: 'tabs', method: 'create', url: 'https://owned.example', owner: owner('a') });
  const { id, lease } = created.data;
  assert.ok(lease?.claimId);
  assert.ok(h.storage.pi_bridge_resources_v1.tabs.includes(id));
  assert.match((await command(h, b, { cmd: 'claim', tabId: id, owner: owner('b') })).error, /tab_busy/);
  const running = await enqueue(h, a, { cmd: 'cdp', tabId: id, method: 'Runtime.evaluate', owner: owner('a'), lease });
  await until(() => h.calls.some((call) => call[0] === 'attach'));
  const closing = await enqueue(h, a, { cmd: 'release', tabId: id, lease, close: true });
  await sleep(20); assert.ok(h.tabs.has(id));
  assert.match((await command(h, a, { cmd: 'tabs', tabId: id, method: 'get', owner: owner('a'), lease })).error, /tab_busy/);
  g.resolve(); await terminal(a, running); await terminal(a, closing); assert.ok(!h.tabs.has(id));
  const borrowed = await claimed(h, a, 1);
  assert.equal((await command(h, a, { cmd: 'release', tabId: 1, lease: borrowed })).type, 'result');
  assert.ok(h.tabs.has(1)); await claimed(h, b, 1, 'b');
});

test('resources disconnect during create retires late owned tab, queued cancel never dispatches', async () => {
  const g = gate();
  const h = harness({ api: (chrome) => { const create = chrome.tabs.create; chrome.tabs.create = async (opts) => { await g.promise; return create(opts); }; } });
  await h.bridge.start(); const old = h.bridge.add(1);
  await enqueue(h, old, { cmd: 'tabs', method: 'create', owner: owner('old') });
  await until(() => h.bridge.snapshot().resources.running === 1);
  await sleep(10); h.bridge.disconnect(old.record);
  const fresh = h.bridge.add(1, 2, old.record.identity.serverInstanceId);
  const next = await enqueue(h, fresh, { cmd: 'tabs', method: 'create', owner: owner('fresh') });
  g.resolve(); const reply = await terminal(fresh, next);
  await until(() => h.calls.some((call) => call[0] === 'remove' && call[1] === 10));
  assert.ok(!old.frames.some((frame) => frame.type === 'result'));
  assert.ok(h.tabs.has(reply.data.id));
  assert.ok(h.bridge.snapshot().resources.leases.some((entry) => entry.tabId === reply.data.id));
});

test('resources global mutations share lane across cookies management contentSettings DNR and batch', async () => {
  const g = gate();
  const h = harness({ api: (chrome, { calls }) => { chrome.cookies.set = async () => { calls.push(['cookies.set']); await g.promise; return {}; }; } });
  await h.bridge.start(); const a = h.bridge.add(1), b = h.bridge.add(2);
  const running = await enqueue(h, a, { cmd: 'cookies', method: 'set', url: 'https://example.org', cookies: [{ name: 'n', value: 'v' }] });
  await until(() => h.calls.some((call) => call[0] === 'cookies.set'));
  const waiting = [];
  for (const payload of [{ cmd: 'management', method: 'disable', extId: 'x' }, { cmd: 'contentSettings' }, { cmd: 'dnr', method: 'enable' }, { cmd: 'batch', commands: [{ cmd: 'cookies', method: 'set', url: 'https://example.org', cookies: [{ name: 'n', value: 'v' }] }] }]) waiting.push(await enqueue(h, b, payload));
  await sleep(20); assert.deepEqual(h.calls.map((call) => call[0]), ['cookies.set']);
  assert.equal((await command(h, b, { cmd: 'tabs', method: 'query' })).type, 'result');
  assert.equal(h.storage.pi_bridge_resources_v1.global, true);
  g.resolve(); await terminal(a, running); for (const id of waiting) await terminal(b, id);
  await until(() => !h.storage.pi_bridge_resources_v1.global);
  assert.deepEqual(h.calls.map((call) => call[0]), ['cookies.set', 'management', 'contentSettings', 'dnr', 'cookies.set']);
});

test('resources worker restart quarantines lost tabs descendants/global; absent/removed only recovery; storage failure never dispatches', async () => {
  const storage = { pi_bridge_resources_v1: { version: 1, tabs: [1, 99], global: true } };
  const h = harness({ storage, api: (_chrome, { tabs }) => { tabs.set(4, { id: 4, openerTabId: 1, url: 'https://child.example' }); } });
  await h.bridge.start(); const a = h.bridge.add(1);
  assert.deepEqual([...h.bridge.snapshot().resources.quarantine.tabIds].sort(), [1, 4]);
  assert.match((await command(h, a, { cmd: 'tabs', method: 'get', tabId: 1 })).error, /resource_quarantined/);
  assert.match((await command(h, a, { cmd: 'dnr', method: 'enable' })).error, /browser restart required/);
  assert.equal((await command(h, a, { cmd: 'tabs', method: 'query' })).type, 'result');
  h.tabs.delete(1); h.removed.emit(1); await claimed(h, a, 2);
  assert.ok(!h.bridge.snapshot().resources.quarantine.tabIds.includes(1));
  assert.equal(h.bridge.snapshot().resources.quarantine.global, true);
  const failed = harness(); await failed.bridge.start(); const b = failed.bridge.add(1);
  failed.chrome.storage.local.set = async () => { throw new Error('disk full'); };
  assert.match((await command(failed, b, { cmd: 'tabs', tabId: 1, method: 'update', url: 'https://never.example' })).error, /disk full/);
  assert.deepEqual(failed.calls, []); assert.equal(failed.bridge.snapshot().resources.journalFailed, true);
  assert.equal(failed.bridge.snapshot().resources.running, 0);
});

test('resources journal recovery gates alarms popup commands and tab-removal writes', async () => {
  const entered = gate(), recovery = gate();
  const storage = { pi_bridge_resources_v1: { version: 1, tabs: [1], global: true } };
  let attempts = 0;
  class OfflineSocket { static OPEN = 1; constructor() { attempts++; throw new Error('offline VM'); } }
  const h = harness({ storage, socketClass: OfflineSocket, api: (chrome) => {
    const get = chrome.storage.local.get;
    chrome.storage.local.get = async (keys) => {
      if (keys.includes('pi_bridge_resources_v1')) { entered.resolve(); await recovery.promise; }
      return get(keys);
    };
  } });
  await entered.promise;
  const peer = h.bridge.add(1);
  const pending = command(h, peer, { cmd: 'tabs', tabId: 1, method: 'update', url: 'https://never.example' });
  h.alarms.emit({ name: 'pi-ws-probe' });
  let configured = false;
  h.messages.emit({ cmd: 'bridge_configure', ports: [19222] }, { url: h.chrome.runtime.getURL('popup.html') }, () => { configured = true; });
  h.removed.emit(3);
  await sleep(20);
  assert.equal(attempts, 0, 'reconnect must wait for journal recovery');
  assert.equal(configured, false);
  assert.deepEqual(h.calls, []);
  assert.ok(!h.writes.some((write) => write.pi_bridge_resources_v1), 'removal event cannot erase an unread journal');
  recovery.resolve();
  await h.bridge.start();
  assert.match((await pending).error, /resource_quarantined/);
  await until(() => configured && attempts > 0);
  assert.ok(h.storage.pi_bridge_resources_v1.tabs.includes(1));
  assert.equal(h.bridge.snapshot().resources.quarantine.global, true);
});

test('resources journal post-create failure retires unpublished tabs or quarantines unknown IDs', async (t) => {
  for (const mode of ['single', 'batch', 'cleanup-failure']) await t.test(mode, async () => {
    let creates = 0;
    const h = harness({ api: (chrome, { calls }) => {
      const create = chrome.tabs.create, set = chrome.storage.local.set;
      chrome.tabs.create = async (opts) => { const tab = await create(opts); creates++; return tab; };
      chrome.storage.local.set = async (value) => {
        if (value.pi_bridge_resources_v1 && creates >= (mode === 'batch' ? 2 : 1)) throw new Error('post-create disk full');
        return set(value);
      };
      if (mode === 'cleanup-failure') chrome.tabs.remove = async (id) => { calls.push(['remove-failed', id]); throw new Error('remove unavailable'); };
    } });
    await h.bridge.start();
    const peer = h.bridge.add(1);
    const create = { cmd: 'tabs', method: 'create', owner: owner('a'), url: 'https://unpublished.example' };
    const reply = await command(h, peer, mode === 'batch' ? { cmd: 'batch', owner: owner('a'), commands: [create, create] } : create);
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /post-create disk full/);
    await until(() => h.bridge.snapshot().resources.running === 0);
    assert.equal(h.bridge.snapshot().resources.journalFailed, true);
    if (mode !== 'cleanup-failure') {
      assert.ok(!h.tabs.has(10));
      assert.ok(!h.tabs.has(11));
      assert.equal(h.bridge.snapshot().resources.leases.length, 0);
    } else {
      assert.ok(h.tabs.has(10));
      assert.ok(h.bridge.snapshot().resources.quarantine.tabIds.includes(10));
      assert.equal(h.storage.pi_bridge_resources_v1.creating, true, 'durable pre-dispatch intent covers the missing created ID');
      assert.ok(!h.storage.pi_bridge_resources_v1.tabs.includes(10));
      const restarted = harness({ storage: structuredClone(h.storage), session: h.session, api: (_chrome, { tabs }) => { tabs.set(10, h.tabs.get(10)); } });
      await restarted.bridge.start();
      const fresh = restarted.bridge.add(1);
      assert.match((await command(restarted, fresh, { cmd: 'claim', tabId: 10, owner: owner('fresh') })).error, /resource_quarantined/);
      assert.equal(restarted.bridge.snapshot().resources.quarantine.global, true);
    }
  });
});

test('resources actual journal survives worker loss; proven browser restart clears only global quarantine', async () => {
  const g = gate(), storage = {}, session = {};
  const old = harness({ storage, session, api: (chrome) => { chrome.cookies.set = async () => { await g.promise; return {}; }; } });
  await old.bridge.start(); const peer = old.bridge.add(1);
  await enqueue(old, peer, { cmd: 'cookies', method: 'set', tabId: 1, cookies: [{ name: 'n', value: 'v' }] });
  await until(() => storage.pi_bridge_resources_v1?.global === true);
  const recovered = harness({ storage: structuredClone(storage), session });
  await recovered.bridge.start();
  assert.equal(recovered.bridge.snapshot().resources.quarantine.global, true);
  assert.ok(recovered.bridge.snapshot().resources.quarantine.tabIds.includes(1));
  const restartedBrowser = harness({ storage: structuredClone(storage), session: {} });
  await restartedBrowser.bridge.start();
  assert.equal(restartedBrowser.bridge.snapshot().resources.quarantine.global, false);
  assert.ok(restartedBrowser.bridge.snapshot().resources.quarantine.tabIds.includes(1), 'existing physical IDs are not guessed safe');
  g.resolve();
});

test('resources cleanup failure quarantines debugger target; global CDP joins mutation lane and no delayed reload escapes', async () => {
  const h = harness({ api: (chrome) => { chrome.debugger.detach = async () => { throw new Error('detach unavailable'); }; } });
  await h.bridge.start(); const a = h.bridge.add(1);
  const result = await command(h, a, { cmd: 'cdp', tabId: 1, method: 'Runtime.evaluate' });
  assert.equal(result.type, 'error');
  assert.ok(h.bridge.snapshot().resources.quarantine.tabIds.includes(1));
  assert.match((await command(h, a, { cmd: 'tabs', tabId: 1, method: 'get' })).error, /resource_quarantined/);
  const reload = await command(h, a, { cmd: 'management', method: 'reload' });
  assert.match(reload.error, /explicit extension UI/);
  const g = gate();
  const shared = harness({ api: (chrome) => { chrome.cookies.set = async () => { await g.promise; return {}; }; } });
  await shared.bridge.start(); const first = shared.bridge.add(1), second = shared.bridge.add(2);
  const cookie = await enqueue(shared, first, { cmd: 'cookies', method: 'set', url: 'https://example.org', cookies: [{ name: 'n', value: 'v' }] });
  await until(() => shared.storage.pi_bridge_resources_v1?.global === true);
  const cdp = await enqueue(shared, second, { cmd: 'cdp', tabId: 2, method: 'Network.clearBrowserCookies' });
  await sleep(15); assert.ok(!shared.calls.some((call) => call[0] === 'attach'));
  g.resolve(); await terminal(first, cookie); await terminal(second, cdp);
  assert.match((await command(shared, second, { cmd: 'cdp', tabId: 3, method: 'Target.createTarget' })).error, /unsupported/);
});

test('resources newTabs uses opener evidence only, journals before publication, legacy batch create owns tab', async () => {
  const h = harness({ api: (chrome, { tabs, created }) => { chrome.scripting.executeScript = async () => {
    const ours = { id: 20, openerTabId: 1, url: 'https://ours.example' };
    const theirs = { id: 21, openerTabId: 2, url: 'https://theirs.example' };
    tabs.set(20, ours); tabs.set(21, theirs); created.emit(theirs); created.emit(ours);
    return [{ result: { ok: true, data: 'done' } }];
  }; } });
  await h.bridge.start(); const a = h.bridge.add(1), b = h.bridge.add(2);
  const reply = await command(h, a, { cmd: 'exec', tabId: 1, code: 'open()' });
  assert.deepEqual(Array.from(reply.newTabs, (tab) => tab.id), [20]);
  assert.ok(reply.newTabs[0].lease); assert.ok(h.storage.pi_bridge_resources_v1.tabs.includes(20));
  assert.equal((await command(h, b, { cmd: 'tabs', tabId: 21, method: 'get' })).type, 'result');
  const batch = await command(h, b, { cmd: 'batch', commands: [{ cmd: 'tabs', method: 'create', url: 'https://batch.example' }] });
  assert.ok(batch.results[0].data.lease);
});

async function freePort() {
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
test('connections real dual NONE listeners, later third, same IDs and paired pending do not block healthy discovery', async () => {
  const directories = [], servers = [], allowed = new Set(), attempts = [];
  const storage = { pi_bridge_custom_ports_v1: [] };
  class ScopedSocket extends WebSocket {
    constructor(url) { const port = Number(new URL(url).port); assert.ok(allowed.has(port), 'VM attempted non-test port ' + port); attempts.push(port); super(url); }
  }
  const start = async (mode = 'none') => {
    const port = await freePort(), directory = mkdtempSync(join(tmpdir(), 'pi-extension-test-'));
    directories.push(directory);
    const server = new BrowserBridgeServer({ directory, anchorPort: port, authMode: mode });
    await server.start(); servers.push(server); allowed.add(server.listeningPort()); return server;
  };
  const one = await start(), two = await start(), paired = await start('paired');
  storage.pi_bridge_custom_ports_v1 = [two.listeningPort(), paired.listeningPort()];
  const h = harness({ storage, ports: [one.listeningPort()], socketClass: ScopedSocket });
  try {
    await h.bridge.start(); await until(() => one.isConnected() && two.isConnected() && paired.pairingRequests().length === 1);
    assert.equal(one.isAuthenticated(), false); assert.equal(two.isAuthenticated(), false);
    await until(() => h.bridge.snapshot().connections.filter((record) => record.ready).length === 2);
    const third = await start(); storage.pi_bridge_custom_ports_v1.push(third.listeningPort());
    h.alarms.emit({ name: 'pi-ws-probe' }); await until(() => third.isConnected());
    await until(() => h.bridge.snapshot().connections.filter((record) => record.ready).length === 3);
    assert.ok(attempts.includes(third.listeningPort()));
    assert.equal(storage.pi_ws_token, undefined, 'NONE never stores token');
    const handle = await one.sendTracked('tabs', { method: 'get', tabId: 1 }, 1000);
    const reply = await handle.response; assert.equal(reply.data.id, 1);
    assert.ok(!JSON.stringify(h.bridge.snapshot()).includes('pi_ws_token'));
  } finally {
    h.bridge.stop(); await sleep(30); for (const server of servers) await server.shutdown();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
});

test('connections selected healthy NONE peer is not replaced by another extension', async () => {
  const port = await freePort(), directory = mkdtempSync(join(tmpdir(), 'pi-extension-peer-test-'));
  const server = new BrowserBridgeServer({ directory, anchorPort: port, authMode: 'none' });
  await server.start();
  class ScopedSocket extends WebSocket {
    constructor(url) { assert.equal(Number(new URL(url).port), server.listeningPort()); super(url); }
  }
  const first = harness({ ports: [server.listeningPort()], socketClass: ScopedSocket });
  let second;
  try {
    await first.bridge.start(); await until(() => first.bridge.snapshot().connections.some((record) => record.ready));
    const identity = server.connectionIdentity();
    second = harness({ ports: [server.listeningPort()], socketClass: ScopedSocket });
    await second.bridge.start(); await sleep(100);
    assert.equal(server.connectionIdentity()?.generation, identity.generation, 'server must retain selected healthy peer generation');
    assert.equal(first.bridge.snapshot().connections[0].ready, true);
    assert.equal(second.bridge.snapshot().connections[0].ready, false);
    assert.equal(second.bridge.snapshot().connections[0].status, 'peer-busy');
  } finally {
    first.bridge.stop(); second?.bridge.stop(); await sleep(20); await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('connections migrate legacy credentials, preserve every installation, pair another without affecting NONE, status and advanced contract omit secrets', async () => {
  const directories = [], servers = [], allowed = new Set();
  class ScopedSocket extends WebSocket {
    constructor(url) { assert.ok(allowed.has(Number(new URL(url).port)), 'only test listeners allowed'); super(url); }
  }
  const start = async (mode = 'paired') => {
    const port = await freePort(), directory = mkdtempSync(join(tmpdir(), 'pi-extension-credential-test-'));
    directories.push(directory);
    const server = new BrowserBridgeServer({ directory, anchorPort: port, authMode: mode });
    await server.start(); servers.push(server); allowed.add(server.listeningPort());
    return { server, config: mode === 'none' ? { port: server.listeningPort() } : JSON.parse(readFileSync(join(directory, 'browser-bridge.json'), 'utf8')) };
  };
  const a = await start(), b = await start(), pending = await start(), none = await start('none');
  const storage = { pi_ws_port: a.config.port, pi_ws_token: a.config.token, pi_ws_installation_id: a.config.installationId,
    pi_bridge_credentials_v1: [{ port: b.config.port, token: b.config.token, installationId: b.config.installationId }],
    pi_bridge_custom_ports_v1: [b.config.port, pending.config.port, none.config.port] };
  const h = harness({ storage, ports: [a.config.port], socketClass: ScopedSocket });
  try {
    await h.bridge.start();
    await until(() => h.bridge.snapshot().connections.filter((record) => record.ready).length === 3 && pending.server.pairingRequests().length === 1);
    assert.equal(a.server.isAuthenticated(), true); assert.equal(b.server.isAuthenticated(), true); assert.equal(none.server.isAuthenticated(), false);
    assert.equal(storage.pi_bridge_credentials_v1.length, 2);
    const pairing = pending.server.pairingRequests()[0];
    await pending.server.approvePairing(pairing.requestId, pairing.code);
    await until(() => h.bridge.snapshot().connections.filter((record) => record.ready).length === 4);
    assert.equal(storage.pi_bridge_credentials_v1.length, 3);
    for (const original of [a.config, b.config]) assert.ok(storage.pi_bridge_credentials_v1.some((entry) => entry.installationId === original.installationId && entry.token === original.token));
    const status = h.bridge.snapshot();
    for (const credential of storage.pi_bridge_credentials_v1) assert.ok(!JSON.stringify(status).includes(credential.token));
    assert.equal(status.connections.find((record) => record.port === none.config.port).authenticated, false);
    let response;
    h.messages.emit({ cmd: 'bridge_configure', ports: [none.config.port] }, { url: h.chrome.runtime.getURL('') + 'popup.html' }, (value) => { response = value; });
    await until(() => response); assert.equal(response.ok, true);
    assert.deepEqual(storage.pi_bridge_custom_ports_v1, [none.config.port]);
    h.messages.emit({ cmd: 'bridge_configure', ports: [1234] }, { tab: { id: 1 }, url: 'https://page.example' }, (value) => { response = value; });
    assert.equal(response.ok, false);
  } finally {
    h.bridge.stop(); await sleep(30); for (const server of servers) await server.shutdown();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
});
