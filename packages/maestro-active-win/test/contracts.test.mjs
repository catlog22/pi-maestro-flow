import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, '.verification', 'upstream', 'package');
const original = JSON.parse(await readFile(path.join(upstream, 'package.json'), 'utf8'));
const fork = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const provenance = JSON.parse(await readFile(path.join(root, 'UPSTREAM.json'), 'utf8'));

async function files(directory, prefix = '') {
	const result = [];
	for (const entry of await readdir(directory, {withFileTypes: true})) {
		const relative = path.join(prefix, entry.name);
		if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), relative));
		else result.push(relative);
	}
	return result.sort();
}

test('immutable registry tarball matches both pinned digests', async () => {
	const archive = await readFile(path.join(root, '.verification', 'upstream', 'active-win-9.0.0.tgz'));
	assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, provenance.integrity);
	assert.equal(createHash('sha1').update(archive).digest('hex'), provenance.shasum);
	assert.equal(original.name, provenance.name);
	assert.equal(original.version, provenance.version);
});

test('every upstream source, typing, license and binary is byte-identical', async () => {
	const names = (await files(upstream)).filter(name => name !== 'package.json');
	assert.equal(names.length, 12);
	for (const name of names) {
		assert.deepEqual(await readFile(path.join(root, name)), await readFile(path.join(upstream, name)), name);
	}
});

test('manifest has only the approved compatibility/security delta', () => {
	const expected = structuredClone(original);
	expected.name = '@dyw1234/active-win';
	expected.version = '9.0.1';
	expected.engines.node = '>=22.19.0';
	expected.binary.remote_path = 'v9.0.0';
	expected.optionalDependencies['@mapbox/node-pre-gyp'] = '2.0.3';
	expected.optionalDependencies['node-gyp'] = '12.4.0';
	expected.peerDependencies['node-gyp'] = '^12.4.0';
	expected.dependencies = {tar: '^7.5.22'};
	delete expected.devDependencies['node-pre-gyp-github'];
	expected.scripts.test = 'node --test test/contracts.test.mjs';
	expected.scripts['test-ci'] = expected.scripts.test;
	expected.files.push('UPSTREAM.json', 'PROVENANCE.md');
	assert.deepEqual(fork, expected);
	assert.equal(fork.main, './index.js');
	assert.equal(fork.optionalDependencies['node-addon-api'], '^8.0.0');
	assert.equal(fork.peerDependenciesMeta['node-gyp'].optional, true);
	assert.equal('overrides' in fork, false);
});

test('all shipped JavaScript parses on the actual Node runner', async () => {
	for (const file of ['index.js', 'lib/windows.js', 'lib/linux.js', 'lib/macos.js']) {
		const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {encoding: 'utf8'});
		assert.equal(result.status, 0, result.stderr);
	}
});
