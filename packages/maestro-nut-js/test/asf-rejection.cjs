const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const requireConsumer = createRequire(path.join(process.env.NUT_STAGING_CONSUMER, 'package.json'));
const requireNut = createRequire(requireConsumer.resolve('@nut-tree-fork/nut-js'));
const { Jimp } = requireNut('jimp');
(async () => {
  const fileType = await import(pathToFileURL(requireNut.resolve('file-type')).href);
  // Header object followed by an unknown GUID with a non-advancing size (CVE path).
  for (const size of [0n, 1n, 23n, 24n, 0xffffffffffffffffn]) {
    const buffer = Buffer.alloc(80);
    Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex').copy(buffer);
    buffer.writeBigUInt64LE(80n, 16);
    buffer.writeUInt32LE(1, 24);
    buffer.writeBigUInt64LE(size, 46);
    const started = performance.now();
    const type = await fileType.fileTypeFromBuffer(buffer);
    await assert.rejects(Jimp.read(buffer), /MIME|Mime type|End-Of-Stream|size|length/i);
    console.log(`ASF object size=${size}: parser=${JSON.stringify(type)}; Jimp rejected in ${(performance.now() - started).toFixed(1)}ms`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
