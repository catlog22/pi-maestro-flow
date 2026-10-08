// Metadata observation only: no activation, keyboard, pointer or clipboard actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');

(async () => {
	assert.equal(process.platform, 'win32', 'This test requires a real Windows host');
	const {createRequire} = require('node:module');
	const consumerRequire = createRequire(path.join(path.resolve(process.argv[2]), 'package.json'));
	const packageName = process.argv[3] || '@dyw1234/active-win';
	const modulePath = consumerRequire.resolve(packageName);
	const root = path.dirname(modulePath);
	const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const preGyp = consumerRequire('@mapbox/node-pre-gyp');
	const bindingPath = preGyp.find(path.join(root, 'package.json'));
	assert.ok(fs.existsSync(bindingPath), `Missing native binding (upstream JS otherwise silently stubs): ${bindingPath}`);
	const native = consumerRequire(bindingPath);
	assert.equal(typeof native.getActiveWindow, 'function');
	assert.equal(typeof native.getOpenWindows, 'function');
	const esm = await import(pathToFileURL(modulePath));
	const commonjs = consumerRequire(packageName);
	const names = ['activeWindow', 'activeWindowSync', 'openWindows', 'openWindowsSync'];
	assert.deepEqual(Object.keys(esm).sort(), [...names].sort());
	for (const name of names) assert.equal(typeof commonjs[name], 'function');
	function validateWindow(window) {
		if (window === undefined) return;
		assert.equal(window.platform, 'windows');
		assert.equal(typeof window.id, 'number');
		assert.equal(typeof window.title, 'string');
		assert.equal(typeof window.owner.name, 'string');
		assert.equal(typeof window.owner.processId, 'number');
		assert.equal(typeof window.owner.path, 'string');
		assert.equal(typeof window.memoryUsage, 'number');
		for (const name of ['x', 'y', 'width', 'height']) assert.equal(typeof window.bounds[name], 'number');
	}
	const options = {accessibilityPermission: false, screenRecordingPermission: false};
	const asyncActive = await esm.activeWindow(options);
	const syncActive = commonjs.activeWindowSync(options);
	validateWindow(asyncActive);
	validateWindow(syncActive);
	const asyncWindows = await esm.openWindows(options);
	const syncWindows = commonjs.openWindowsSync(options);
	assert.ok(Array.isArray(asyncWindows));
	assert.ok(Array.isArray(syncWindows));
	asyncWindows.forEach(validateWindow);
	syncWindows.forEach(validateWindow);
	console.log(JSON.stringify({node: process.version, platform: process.platform, arch: process.arch, package: `${manifest.name}@${manifest.version}`, bindingPath, bindingSha256: createHash('sha256').update(fs.readFileSync(bindingPath)).digest('hex'), exports: names, asyncWindowCount: asyncWindows.length, syncWindowCount: syncWindows.length, asyncActivePresent: !!asyncActive, syncActivePresent: !!syncActive, inputActions: 0}, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
