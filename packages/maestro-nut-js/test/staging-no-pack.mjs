// Source-copy staging only: NO npm pack, tarball creation, publication or root install.
// Local file links stand in for unpublished aliases; this is NOT registry validation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const packages = path.resolve(here, '../..');
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'nut-source-staging-'));
console.log(`STAGING ONLY (unpublished aliases replaced by source-directory file links): ${consumer}`);
const keys = ['shared', 'provider-interfaces', 'nut-js'];
const dirs = ['maestro-nut-shared', 'maestro-nut-provider-interfaces', 'maestro-nut-js'];
const fixtures = keys.map(key => path.join(consumer, 'fixtures', key));
for (let i = 0; i < keys.length; i++) {
  fs.cpSync(path.join(packages, dirs[i]), fixtures[i], { recursive: true, filter: source => !source.includes('node_modules') });
  const manifestPath = path.join(fixtures[i], 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  delete manifest.devDependencies;
  for (let j = 0; j < i; j++) {
    const key = `@nut-tree-fork/${keys[j]}`;
    if (manifest.dependencies[key]) manifest.dependencies[key] = `file:${fixtures[j].split(path.sep).join('/')}`;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
  private: true, name: 'nut-source-staging-only', version: '0.0.0',
  dependencies: Object.fromEntries(keys.map((key, i) => [`@nut-tree-fork/${key}`, `file:${fixtures[i].split(path.sep).join('/')}`])),
  devDependencies: { typescript: '5.9.3', '@types/node': '22.19.0' }
}, null, 2));
const env = { ...process.env, NUT_STAGING_CONSUMER: consumer };
function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: consumer, env, encoding: 'utf8', timeout: 300000, ...options });
  console.log(result.stdout || '');
  if (result.stderr) console.error(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error || result.status}`);
  return result.stdout;
}
// npm.cmd must be invoked through cmd.exe on Windows; args are generated locally.
function npm(args) {
  if (process.platform === 'win32') return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ' + args.join(' ')]);
  return run('npm', args);
}
npm(['install', '--foreground-scripts', '--ignore-scripts=false', '--prefer-offline']);
const tsc = path.join(consumer, 'node_modules/typescript/bin/tsc');
function hashes(dir) {
  const result = {};
  function visit(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) visit(file);
      else result[path.relative(dir, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  visit(dir);
  return JSON.stringify(result);
}
for (let i = 0; i < fixtures.length; i++) {
  const expected = hashes(path.join(packages, dirs[i], 'dist'));
  fs.rmSync(path.join(fixtures[i], 'dist'), { recursive: true, force: true });
  run(process.execPath, [tsc, '-p', fixtures[i]]);
  if (hashes(path.join(fixtures[i], 'dist')) !== expected) throw new Error(`Non-reproducible dist: ${keys[i]}`);
  console.log(`PASS: ${keys[i]} source rebuild is byte-identical to checked-in dist`);
}
run(process.execPath, ['--test', path.join(here, 'security-compat.test.cjs')]);
fs.copyFileSync(path.join(here, 'consumer-types.ts'), path.join(consumer, 'consumer-types.ts'));
run(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'ES2018', '--module', 'Node16', '--moduleResolution', 'Node16', '--esModuleInterop', '--types', 'node', 'consumer-types.ts']);
npm(['ls', '--all']);
for (const name of ['jimp', 'file-type', '@dyw1234/nut-shared', '@dyw1234/nut-provider-interfaces']) npm(['explain', name]);
const lock = JSON.parse(fs.readFileSync(path.join(consumer, 'package-lock.json')));
for (const [key, entry] of Object.entries(lock.packages)) {
  if (key.endsWith('/jimp') && entry.version !== '1.6.1') throw new Error(`Old Jimp: ${key}`);
  if (key.endsWith('/file-type') && entry.version !== '21.3.4') throw new Error(`Unexpected file-type: ${key}`);
  if (entry.name === '@nut-tree-fork/shared' || entry.name === '@nut-tree-fork/provider-interfaces') throw new Error(`Original fork leaked: ${key}`);
  if (entry.version === '4.2.6' && /shared|provider-interfaces|nut-js/.test(key)) throw new Error(`Old closure node: ${key}`);
}
npm(['audit', '--omit=dev']);
console.log(`PASS: no old shared/Jimp/file-type leak; audit clean. STAGING ONLY: ${consumer}`);
console.log('NO pack performed. Packed-content and final registry-alias validation remain unverified.');
