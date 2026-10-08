// Focused real-library regression; no input events or clipboard mutations.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const consumer = process.env.NUT_STAGING_CONSUMER;
assert.ok(consumer, 'Set NUT_STAGING_CONSUMER to the isolated staging consumer');
const requireConsumer = createRequire(path.join(consumer, 'package.json'));
const nut = requireConsumer('@nut-tree-fork/nut-js');
const requireNut = createRequire(requireConsumer.resolve('@nut-tree-fork/nut-js'));
const { Jimp, intToRGBA } = requireNut('jimp');
const { Image, ColorMode, Point, RGBA, imageToJimp } = nut;
const makeImage = (data, mode = ColorMode.BGR, channels = 4) =>
  new Image(2, 1, Buffer.from(data), channels, 'fixture', channels, 2 * channels, mode, { scaleX: 2, scaleY: 1 });
const rgba = [11, 22, 33, 44, 55, 66, 77, 88];
const bgra = [33, 22, 11, 44, 77, 66, 55, 88];

test('actual default native keyboard/mouse/clipboard exports load without input', () => {
  const libnut = requireNut('@nut-tree-fork/libnut');
  for (const key of ['DefaultKeyboardAction', 'DefaultMouseAction', 'DefaultScreenAction', 'DefaultWindowAction']) {
    assert.equal(typeof libnut[key], 'function', key);
  }
  const Clipboard = requireNut('@nut-tree-fork/default-clipboard-provider').default;
  assert.equal(typeof Clipboard, 'function');
  assert.ok(nut.providerRegistry.getKeyboard() instanceof libnut.DefaultKeyboardAction);
  assert.ok(nut.providerRegistry.getMouse() instanceof libnut.DefaultMouseAction);
  assert.ok(nut.providerRegistry.getClipboard() instanceof Clipboard);
  assert.equal(typeof nut.keyboard.pressKey, 'function');
  assert.equal(typeof nut.mouse.move, 'function');
  assert.equal(typeof nut.clipboard.setContent, 'function');
});

test('real Jimp conversion copies sliced buffers, preserves alpha and expands RGB/BGR', () => {
  const backing = Buffer.from([199, ...bgra, 200]);
  const sliced = backing.subarray(1, 9);
  const image = new Image(2, 1, sliced, 4, 'slice', 4, 8);
  const jimp = imageToJimp(image);
  assert.ok(jimp instanceof Jimp);
  assert.deepEqual([...jimp.bitmap.data], rgba);
  assert.deepEqual([...backing], [199, ...bgra, 200]);
  jimp.bitmap.data[0] = 255;
  assert.equal(sliced[2], 11);
  assert.deepEqual([...imageToJimp(makeImage(rgba, ColorMode.RGB)).bitmap.data], rgba);
  const rgb = [11, 22, 33, 55, 66, 77];
  const bgr = [33, 22, 11, 77, 66, 55];
  for (const [bytes, mode] of [[rgb, ColorMode.RGB], [bgr, ColorMode.BGR]]) {
    assert.deepEqual([...imageToJimp(makeImage(bytes, mode, 3)).bitmap.data], [11, 22, 33, 255, 55, 66, 77, 255]);
  }
  assert.throws(() => imageToJimp(makeImage([1, 2])), /Buffer length/);
});

test('Image RGB/BGR round-trip and metadata/density/identity contracts', async () => {
  const image = makeImage(bgra);
  assert.equal(await image.toBGR(), image);
  const rgb = await image.toRGB();
  assert.deepEqual([...rgb.data], rgba);
  assert.equal(await rgb.toRGB(), rgb);
  const bgr = await rgb.toBGR();
  assert.deepEqual([...bgr.data], bgra);
  assert.deepEqual([...image.data], bgra);
  assert.deepEqual([...rgb.data], rgba);
  for (const converted of [rgb, bgr]) {
    for (const key of ['width', 'height', 'channels', 'id', 'bitsPerPixel', 'byteWidth']) assert.equal(converted[key], image[key]);
    assert.equal(converted.pixelDensity, image.pixelDensity);
  }
  const source = Buffer.from(rgba);
  const fromRGB = Image.fromRGBData(2, 1, source, 4, 'rgb', 4, 8);
  assert.equal(fromRGB.colorMode, ColorMode.BGR);
  assert.deepEqual([...fromRGB.data], bgra);
  assert.deepEqual([...source], rgba);
  assert.equal(makeImage(rgba).hasAlphaChannel, true);
  assert.equal(makeImage(rgba.slice(0, 6), ColorMode.RGB, 3).hasAlphaChannel, false);
});

test('three-channel conversions preserve buffer layout, stride, density and input data', async () => {
  const rgb = [11, 22, 33, 55, 66, 77];
  const bgr = [33, 22, 11, 77, 66, 55];
  const original = makeImage(bgr, ColorMode.BGR, 3);
  const converted = await original.toRGB();
  const restored = await converted.toBGR();
  const fromRGB = Image.fromRGBData(2, 1, Buffer.from(rgb), 3, 'rgb', 3, 6);
  assert.deepEqual([...converted.data], rgb);
  assert.deepEqual([...restored.data], bgr);
  assert.deepEqual([...fromRGB.data], bgr);
  assert.deepEqual([...original.data], bgr);
  for (const image of [converted, restored, fromRGB]) {
    assert.equal(image.data.length, 6);
    assert.equal(image.channels, 3);
    assert.equal(image.bitsPerPixel, 3);
    assert.equal(image.byteWidth, 6);
    assert.equal(image.hasAlphaChannel, false);
    assert.deepEqual([...imageToJimp(image).bitmap.data], rgba.map((v, i) => i % 4 === 3 ? 255 : v));
  }
  assert.equal(converted.pixelDensity, original.pixelDensity);
  assert.equal(restored.pixelDensity, original.pixelDensity);
  assert.equal(await converted.toRGB(), converted);
  assert.equal(await restored.toBGR(), restored);
});

test('colorAt and exact color finder preserve alpha and scale matches by density', async () => {
  const image = makeImage(bgra);
  const processor = nut.providerRegistry.getImageProcessor();
  assert.deepEqual(await processor.colorAt(Promise.resolve(image), Promise.resolve(new Point(1, 0))), new RGBA(55, 66, 77, 88));
  assert.deepEqual(intToRGBA(imageToJimp(image).getPixelColor(0, 0)), { r: 11, g: 22, b: 33, a: 44 });
  await assert.rejects(processor.colorAt(image, new Point(2, 0)), /out of bounds/);
  await assert.rejects(processor.colorAt(image, new Point(0, -1)), /out of bounds/);
  const finder = nut.providerRegistry.getColorFinder();
  const query = { haystack: image, needle: nut.pixelWithColor(new RGBA(55, 66, 77, 88)), confidence: 1 };
  const match = await finder.findMatch(query);
  assert.deepEqual(match.location, new Point(0.5, 0));
  assert.equal(match.confidence, 1);
  assert.deepEqual((await finder.findMatches(query)).map(m => m.location), [new Point(0.5, 0)]);
  const mismatch = { ...query, needle: nut.pixelWithColor(new RGBA(55, 66, 77, 255)) };
  assert.deepEqual(await finder.findMatches(mismatch), []);
  await assert.rejects(finder.findMatch(mismatch), /No match/);
  assert.deepEqual([...image.data], bgra);
});

test('real PNG read/write, public Promise<void>, local HTTP RGB and failure paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nut-image-test-'));
  const file = path.join(dir, 'roundtrip.png');
  let server;
  try {
    const original = makeImage(bgra);
    assert.equal(await nut.saveImage({ image: original, path: file }), undefined);
    const png = await fs.readFile(file);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual([...((await Jimp.read(png)).bitmap.data)], rgba);
    const loaded = await nut.loadImage(file);
    assert.deepEqual([...loaded.data], bgra);
    assert.equal(loaded.colorMode, ColorMode.BGR);
    assert.equal(loaded.channels, 4);
    assert.equal(loaded.bitsPerPixel, 4); // upstream metadata unit is retained
    assert.equal(loaded.byteWidth, 8);
    assert.deepEqual(loaded.pixelDensity, { scaleX: 1, scaleY: 1 });
    const rgbFile = path.join(dir, 'rgb.png');
    await nut.saveImage({ image: makeImage(rgba, ColorMode.RGB), path: rgbFile });
    assert.deepEqual([...((await Jimp.read(rgbFile)).bitmap.data)], rgba);
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'image/png');
      response.end(request.url === '/bad' ? Buffer.from('not an image') : png);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const fetched = await nut.fetchFromUrl(url + '/image');
    assert.equal(fetched.colorMode, ColorMode.RGB);
    assert.deepEqual([...fetched.data], rgba);
    await assert.rejects(nut.fetchFromUrl(url + '/bad'), /Failed to parse image data/);
    await assert.rejects(nut.fetchFromUrl('not-a-url'), /Failed to fetch image data/);
    await assert.rejects(nut.loadImage(path.join(dir, 'missing.png')), error => String(error).includes('Failed to load image'));
    await assert.rejects(nut.saveImage({ image: original, path: path.join(dir, 'missing', 'bad.png') }));
    assert.deepEqual([...original.data], bgra);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('malformed ASF goes through real Jimp/file-type and rejects within process bound', () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'asf-rejection.cjs')], {
    env: process.env, encoding: 'utf8', timeout: 5000
  });
  console.log(child.stdout);
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});
