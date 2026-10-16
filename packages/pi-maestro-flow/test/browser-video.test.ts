import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { BrowserVideoRecording, type BrowserVideoPage } from "../src/tools/browser/video.ts";

type FakeRecorder = PassThrough & { stop(): Promise<void> };

function makeRecorder(payload = Buffer.from("webm fixture bytes")) {
  const recorder = new PassThrough() as FakeRecorder;
  let stopCalls = 0;
  recorder.stop = async () => {
    stopCalls++;
    if (!recorder.destroyed && !recorder.writableEnded) recorder.end(payload);
  };
  return { recorder, get stopCalls() { return stopCalls; } };
}

function makePage(recorder: FakeRecorder = makeRecorder().recorder) {
  const screencastOptions: Record<string, unknown>[] = [];
  const page: BrowserVideoPage = {
    async screencast(options) {
      screencastOptions.push({ ...options });
      return recorder;
    },
  };
  return { page, screencastOptions };
}

async function makeTempDir(t: { after(callback: () => unknown): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-video-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("relative recordings flush a persistent WebM artifact and stop idempotently without overwriting", async (t) => {
  const cwd = await makeTempDir(t);
  const payload = Buffer.from("complete deterministic WebM bytes");
  const fake = makeRecorder(payload);
  const { page, screencastOptions } = makePage(fake.recorder);
  const recording = await BrowserVideoRecording.start(page, cwd, { filename: "captures/session.webm" });
  const filename = path.resolve(cwd, "captures/session.webm");

  assert.equal(recording.info.path, filename);
  assert.equal(recording.info.mimeType, "video/webm");
  assert.equal(recording.info.recording, true);
  assert.equal(recording.info.bytes, undefined);

  const firstStop = recording.stop();
  assert.strictEqual(recording.stop(), firstStop, "concurrent stop calls share the same completion");
  const [first, second] = await Promise.all([firstStop, recording.stop()]);
  assert.deepEqual(first, { path: filename, mimeType: "video/webm", recording: false, bytes: payload.length });
  assert.deepEqual(second, first);
  assert.deepEqual(recording.info, first);
  assert.equal(fake.stopCalls, 1);
  assert.deepEqual(await fs.readFile(filename), payload, "stop resolves only after the file data is flushed");
  assert.equal((await fs.stat(filename)).size, payload.length, "the artifact remains on disk after stop");

  await assert.rejects(
    BrowserVideoRecording.start(page, cwd, { filename: "captures/session.webm" }),
    (error) => (error as NodeJS.ErrnoException).code === "EEXIST",
    "starting a recording must not overwrite an existing artifact",
  );
  assert.equal(screencastOptions.length, 1, "the rejected overwrite must not start a second screencast");
  assert.deepEqual(await fs.readFile(filename), payload);
});

test("video size forwards bounds and returns the encoder's normalized dimensions", async (t) => {
  const cwd = await makeTempDir(t);
  const fake = makeRecorder();
  Object.assign(fake.recorder, { size: { width: 320, height: 240 } });
  const { page, screencastOptions } = makePage(fake.recorder);
  const video = await BrowserVideoRecording.start(page, cwd, { size: { width: 321, height: 241 } });
  assert.deepEqual(screencastOptions[0].size, { width: 321, height: 241 });
  assert.deepEqual(video.info.size, { width: 320, height: 240 });
  assert.deepEqual((await video.stop()).size, { width: 320, height: 240 });
  for (const size of [{ width: 1, height: 10 }, { width: 2.5, height: 10 }]) {
    await assert.rejects(BrowserVideoRecording.start(page, cwd, { size }), /size/);
  }
  await assert.rejects(BrowserVideoRecording.start(page, cwd, { size: { width: 10, height: 10 }, scale: 1 }), /cannot be combined/);
});

test("default recording names are unique WebM files within the requested working directory", async (t) => {
  const cwd = await makeTempDir(t);
  const { page } = makePage();
  const recording = await BrowserVideoRecording.start(page, cwd);

  assert.equal(path.dirname(recording.info.path), cwd);
  assert.match(path.basename(recording.info.path), /^video-\d+-[0-9a-f-]{36}\.webm$/);
  assert.equal(recording.info.mimeType, "video/webm");
  const result = await recording.stop();
  assert.equal(result.recording, false);
  assert.ok((result.bytes ?? 0) > 0);
  await fs.access(result.path);
});

test("filename, fps, and scale are strictly validated at runtime before screencast", async (t) => {
  const cwd = await makeTempDir(t);
  const { page, screencastOptions } = makePage();
  const invalidOptions: Array<{ options: unknown; message: RegExp }> = [
    { options: { filename: "" }, message: /filename/ },
    { options: { filename: " \t " }, message: /filename/ },
    { options: { filename: 12 }, message: /filename/ },
    { options: { filename: "capture.mp4" }, message: /\.webm/ },
    { options: { fps: 0 }, message: /fps/ },
    { options: { fps: 61 }, message: /fps/ },
    { options: { fps: 29.97 }, message: /fps/ },
    { options: { fps: "30" }, message: /fps/ },
    { options: { scale: 0 }, message: /scale/ },
    { options: { scale: 4.01 }, message: /scale/ },
    { options: { scale: Number.NaN }, message: /scale/ },
    { options: { scale: "1" }, message: /scale/ },
  ];

  for (const { options, message } of invalidOptions) {
    await assert.rejects(BrowserVideoRecording.start(page, cwd, options as never), message);
  }
  assert.deepEqual(screencastOptions, [], "invalid runtime values must be rejected before starting the recorder");
});

test("screencast receives normalized options and a relative ffmpeg executable path", async (t) => {
  const cwd = await makeTempDir(t);
  const fake = makeRecorder();
  const { page, screencastOptions } = makePage(fake.recorder);
  const recording = await BrowserVideoRecording.start(page, cwd, {
    filename: "capture.webm",
    fps: 24,
    scale: 0.75,
    ffmpegPath: "tools/ffmpeg.exe",
  });

  assert.deepEqual(screencastOptions[0], {
    format: "webm",
    fps: 24,
    scale: 0.75,
    ffmpegPath: path.resolve(cwd, "tools/ffmpeg.exe"),
  });
  await recording.stop();
});

test("a screencast start failure removes its empty artifact and explains the FFmpeg requirement", async (t) => {
  const cwd = await makeTempDir(t);
  const filename = path.resolve(cwd, "nested/failed.webm");
  const cause = new Error("spawn ffmpeg ENOENT");
  const page: BrowserVideoPage = {
    async screencast() { throw cause; },
  };

  await assert.rejects(BrowserVideoRecording.start(page, cwd, { filename: "nested/failed.webm" }), (error) => {
    assert.match((error as Error).message, /could not start/i);
    assert.match((error as Error).message, /FFmpeg/i);
    assert.equal((error as Error & { cause?: unknown }).cause, cause);
    return true;
  });
  await assert.rejects(fs.stat(filename), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("an encoder stop rejection destroys the stream and settles file cleanup", async (t) => {
  const cwd = await makeTempDir(t);
  const failure = new Error("encoder shutdown failed");
  const { recorder } = makeRecorder();
  recorder.stop = async () => { throw failure; };
  const warnings: string[] = [];
  t.mock.method(console, "warn", (text: string) => { warnings.push(text); });
  const recording = await BrowserVideoRecording.start(makePage(recorder).page, cwd);
  await assert.rejects(recording.stop(), (error) => error === failure);
  assert.equal(recorder.destroyed, true);
  assert.equal(recording.info.recording, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(warnings.some((text) => text.includes(failure.message)));
});

test("recording and destination-write errors are reported without unhandled promises", async (t) => {
  const cwd = await makeTempDir(t);
  const unhandled: unknown[] = [];
  const warnings: string[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

  try {
    const recorderFailure = new Error("simulated recorder failure");
    const recorderFake = makeRecorder();
    const recorderPage = makePage(recorderFake.recorder).page;
    const recordingFailure = await BrowserVideoRecording.start(recorderPage, cwd, { filename: "recorder-error.webm" });
    recorderFake.recorder.destroy(recorderFailure);
    await assert.rejects(recordingFailure.stop(), (error) => error === recorderFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(warnings.some((message) => message.includes(recorderFailure.message)), "recording failure is surfaced to diagnostics");
    assert.equal(recorderFake.stopCalls, 1, "a failed recording stops its encoder");

    const destinationFailure = new Error("simulated destination write failure");
    const writerFake = makeRecorder();
    const probeHandle = await fs.open(path.join(cwd, "writer-prototype-probe"), "wx");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalCreateWriteStream = fileHandlePrototype.createWriteStream;
    t.mock.method(fileHandlePrototype, "createWriteStream", function (this: object, ...args: unknown[]) {
      const stream = originalCreateWriteStream.apply(this, args);
      process.nextTick(() => stream.destroy(destinationFailure));
      return stream;
    });
    const writerPage = makePage(writerFake.recorder).page;
    const writingFailure = await BrowserVideoRecording.start(writerPage, cwd, { filename: "writer-error.webm" });
    await assert.rejects(writingFailure.stop(), (error) => error === destinationFailure, "destination failures must reject stop");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(warnings.some((message) => message.includes(destinationFailure.message)), "destination-write failure is surfaced to diagnostics");
    assert.equal(writerFake.stopCalls, 1, "a destination-write failure stops its encoder");
    assert.deepEqual(unhandled, [], "internal cleanup must handle its asynchronous stop rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
