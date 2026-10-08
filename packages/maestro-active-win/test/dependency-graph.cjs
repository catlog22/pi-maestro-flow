const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const consumer = path.resolve(process.argv[2]);
const lock = JSON.parse(fs.readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'));
const semver = require(path.join(consumer, 'node_modules/semver'));
const tariffs = [];
for (const [location, entry] of Object.entries(lock.packages)) {
	if (/(^|\/)node_modules\/tar$/.test(location)) {
		assert.ok(semver.gte(entry.version, '7.5.22'), `${location}: vulnerable tar ${entry.version}`);
		tariffs.push({location, version: entry.version});
	}
	assert.ok(!/(^|\/)node_modules\/(inflight|rimraf|glob|npmlog|are-we-there-yet|gauge)$/.test(location), `Legacy install chain: ${location}`);
}
assert.ok(tariffs.length > 0);
const versions = {};
for (const [name, wanted] of Object.entries({'@mapbox/node-pre-gyp': '2.0.3', 'node-gyp': '12.4.0'})) {
	const manifest = JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
	assert.equal(manifest.version, wanted);
	versions[name] = manifest.version;
}
const addon = JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules/node-addon-api/package.json'), 'utf8'));
assert.ok(semver.satisfies(addon.version, '^8.0.0'));
console.log(JSON.stringify({consumer, versions, nodeAddonApi: addon.version, tar: tariffs, legacyInstallChain: false}, null, 2));
