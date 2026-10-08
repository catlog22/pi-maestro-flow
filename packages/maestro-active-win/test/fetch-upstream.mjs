import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(await readFile(path.join(root, 'UPSTREAM.json'), 'utf8'));
const destination = path.join(root, '.verification', 'upstream');
await mkdir(destination, {recursive: true});
const archive = path.join(destination, 'active-win-9.0.0.tgz');
let bytes;
try {
	bytes = await readFile(archive);
} catch (error) {
	if (error.code !== 'ENOENT') throw error;
	const response = await fetch(provenance.tarball);
	assert.equal(response.status, 200);
	bytes = Buffer.from(await response.arrayBuffer());
}
assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, provenance.integrity);
assert.equal(createHash('sha1').update(bytes).digest('hex'), provenance.shasum);
await writeFile(archive, bytes);
const result = spawnSync('tar', ['-xzf', path.basename(archive)], {cwd: destination, encoding: 'utf8'});
assert.equal(result.status, 0, result.stderr || result.error?.message);
console.log(JSON.stringify({tarball: provenance.tarball, integrity: provenance.integrity, archive, extracted: path.join(destination, 'package')}, null, 2));
