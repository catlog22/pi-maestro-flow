import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { probeInstallStatus, INSTALL_ITEMS } from '../src/install/install-items.ts';

function popup(connections) {
  const messages = [], reads = [], writes = [], elements = new Map(); let reloads = 0;
  function element() { return { value: '', textContent: '', style: {}, children: [], listeners: new Map(), append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, addEventListener(name, fn) { this.listeners.set(name, fn); } }; }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const chrome = {
    runtime: { sendMessage: async (message) => { messages.push(message); return message.cmd === 'status' ? { ok: true, connections } : { ok: true }; }, reload() { reloads++; } },
    storage: { local: { get: async (keys) => { reads.push(keys); return { pi_ws_port: 19222, pi_ws_token: 'NEVER-RENDER-THIS-TOKEN', pi_bridge_custom_ports_v1: [22000] }; }, set: async (value) => { writes.push(value); } } },
  };
  vm.runInNewContext(readFileSync(new URL('../optional/browser-bridge/popup.js', import.meta.url), 'utf8'), { document, chrome, window: { addEventListener() {} }, setInterval() {}, clearInterval() {}, console });
  return { elements, messages, reads, writes, reloads: () => reloads };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('T3 popup lists every live listener/mode, NONE hides pairing and custom ports require no token or reload', async () => {
  const h = popup([
    { port: 19222, status: 'connected', ready: true, authMode: 'none', authenticated: false },
    { port: 22000, status: 'pairing-pending', ready: false, authMode: 'paired', authenticated: false, pairing: { requestId: 'paired-request', code: '123456' } },
    { port: 22001, status: 'pairing-pending', ready: false, authMode: 'none', pairing: { requestId: 'not-paired', code: '999999' } },
    { port: 22002, status: 'connected', ready: true, authMode: 'paired', authenticated: true },
  ]);
  await settle();
  const rows = h.elements.get('connections').children;
  assert.equal(rows.length, 4);
  assert.match(rows[0].children[0].textContent, /19222.*NONE.*无授权/); assert.equal(rows[0].children.length, 1);
  assert.match(rows[1].children[1].textContent, /123456.*paired-request/); assert.equal(rows[2].children.length, 1);
  assert.match(rows[3].children[0].textContent, /22002.*已认证连接/);
  assert.equal(h.elements.get('token').value, '');
  assert.ok(h.reads.every((keys) => !keys.includes('pi_ws_token')));
  h.elements.get('port').value = '22000, 22003, 22000';
  await h.elements.get('save').listeners.get('click')();
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.find((message) => message.cmd === 'bridge_configure'))), { cmd: 'bridge_configure', ports: [22000, 22003] });
  assert.equal(h.writes.length, 0); assert.equal(h.reloads(), 0);
});

test('T3 popup preserves explicit legacy paired recovery but never rehydrates historical credentials', async () => {
  const h = popup([]); await settle();
  h.elements.get('port').value = '22000'; h.elements.get('token').value = 'x'.repeat(43);
  await h.elements.get('save').listeners.get('click')();
  assert.equal(h.writes[0].pi_ws_port, 22000); assert.equal(h.writes[0].pi_ws_token, 'x'.repeat(43));
  assert.equal(h.writes[0].pi_ws_installation_id, ''); assert.equal(h.reloads(), 1); assert.equal(h.elements.get('token').value, '');
});

test('T3 install probe selects mode-specific historical evidence, never credentials/port as NONE readiness', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-mode-history-'));
  const previousDirectory = process.env.PI_BROWSER_BRIDGE_DIR, previousMode = process.env.PI_BROWSER_BRIDGE_AUTH_MODE;
  process.env.PI_BROWSER_BRIDGE_DIR = directory;
  const write = (name, data) => writeFileSync(join(directory, name), JSON.stringify(data));
  try {
    process.env.PI_BROWSER_BRIDGE_AUTH_MODE = 'none';
    write('browser-bridge.json', { version: 1, port: 19222, token: 'x'.repeat(43) });
    write('browser-bridge.verified', { version: 1, port: 19222, protocol: 'challenge-hmac-sha256-v1', verifiedAt: new Date().toISOString() });
    assert.equal(probeInstallStatus('browser-bridge'), 'not-installed');
    writeFileSync(join(directory, 'browser-bridge.port'), '19222');
    assert.equal(probeInstallStatus('browser-bridge'), 'not-installed');
    process.env.PI_BROWSER_BRIDGE_AUTH_MODE = 'paired'; assert.equal(probeInstallStatus('browser-bridge'), 'installed');
    process.env.PI_BROWSER_BRIDGE_AUTH_MODE = 'none';
    mkdirSync(join(directory, 'browser-bridge.none'));
    const serverInstanceId = randomUUID(), installationId = randomUUID();
    const marker = { version: 1, protocol: 'probe-ready-v1', authMode: 'none', authenticated: false, serverInstanceId, installationId, generation: 1, port: 22000, readyAt: new Date().toISOString() };
    write(`browser-bridge.none/${serverInstanceId}.ready.json`, { ...marker, authenticated: true });
    assert.equal(probeInstallStatus('browser-bridge'), 'partial');
    write(`browser-bridge.none/${serverInstanceId}.ready.json`, marker);
    assert.equal(probeInstallStatus('browser-bridge'), 'installed');
    rmSync(join(directory, 'browser-bridge.verified'));
    process.env.PI_BROWSER_BRIDGE_AUTH_MODE = 'paired'; assert.equal(probeInstallStatus('browser-bridge'), 'not-installed');
    process.env.PI_BROWSER_BRIDGE_AUTH_MODE = 'bad'; assert.equal(probeInstallStatus('browser-bridge'), 'unknown');
    const prompt = INSTALL_ITEMS.find((item) => item.id === 'browser-bridge').promptIntro;
    assert.match(prompt, /none 无需 token 或配对/); assert.match(prompt, /历史就绪证据，不是实时连接/);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_BROWSER_BRIDGE_DIR; else process.env.PI_BROWSER_BRIDGE_DIR = previousDirectory;
    if (previousMode === undefined) delete process.env.PI_BROWSER_BRIDGE_AUTH_MODE; else process.env.PI_BROWSER_BRIDGE_AUTH_MODE = previousMode;
    rmSync(directory, { recursive: true, force: true });
  }
});
