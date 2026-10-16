import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";
import type { Page } from "puppeteer-core";
import { CDPSessionEvent } from "puppeteer-core/internal/api/CDPSession.js";
import { createCdpVideoPage } from "../src/tools/browser/video-recorder.ts";

class Session extends EventEmitter {
  calls: Array<{ method: string; params: unknown }> = [];
  detaches = 0;
  failMethod?: string;
  async send(method: string, params?: unknown) {
    this.calls.push({ method, params });
    if (method === this.failMethod) throw new Error(`failed ${method}`);
    return method === "Page.captureScreenshot" ? { data: Buffer.from("initial-jpeg").toString("base64") } : {};
  }
  async detach() { this.detaches++; }
  frame(index: number) {
    this.emit("Page.screencastFrame", { sessionId: index, data: Buffer.from(`jpeg-${index}`).toString("base64") });
  }
}

class Encoder extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  frames: Buffer[] = [];
  hold = false;
  release?: () => void;
  killed = false;
  exited = false;
  stdin = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      this.frames.push(Buffer.from(chunk));
      if (this.hold) this.release = done;
      else done();
    },
    final: (done) => {
      this.stdout.end(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      done();
      queueMicrotask(() => this.exit(0));
    },
  });
  exit(code: number) {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
  kill() { this.killed = true; queueMicrotask(() => this.exit(1)); return true; }
}

function fixture(t: test.TestContext, viewport: { width: number; height: number } | null = { width: 800, height: 600 }) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const session = new Session();
  const encoder = new Encoder();
  let milliseconds = 0;
  let evaluations = 0;
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  const spawnEncoder = ((command: string, args: readonly string[], options: unknown) => {
    calls.push({ command, args, options });
    process.nextTick(() => encoder.emit("spawn"));
    return encoder;
  }) as unknown as typeof spawn;
  const source = {
    viewport: () => viewport,
    evaluate: async () => { evaluations++; return { width: 640, height: 360 }; },
    createCDPSession: async () => session,
    setViewport: () => { throw new Error("recording must not resize the page"); },
  } as unknown as Pick<Page, "viewport" | "evaluate" | "createCDPSession">;
  const page = createCdpVideoPage(source, { spawn: spawnEncoder, now: () => milliseconds });
  return {
    page, session, encoder, source, calls,
    advance: (value: number) => { milliseconds = value; },
    evaluations: () => evaluations,
  };
}

function cleanSession(session: Session) {
  assert.equal(session.listenerCount("Page.screencastFrame"), 0);
  assert.equal(session.listenerCount(CDPSessionEvent.Disconnected), 0);
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("static recordings use VP8, aspect-fit dimensions, 30fps wall-clock duration, and idempotent stop", async (t) => {
  const f = fixture(t);
  const recorder = await f.page.screencast({ size: { width: 320, height: 240 }, ffmpegPath: "tools/ffmpeg.exe" });
  const payload: Buffer[] = [];
  recorder.on("data", (chunk) => payload.push(chunk));
  const drained = finished(recorder);
  f.advance(1250);
  const stopped = recorder.stop();
  assert.strictEqual(recorder.stop(), stopped);
  await stopped;
  await drained;
  assert.equal(f.encoder.frames.length, 38);
  assert.ok(f.encoder.frames.every((frame) => frame.toString() === "initial-jpeg"));
  assert.deepEqual(Buffer.concat(payload), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const { command, args, options } = f.calls[0];
  assert.equal(command, "tools/ffmpeg.exe");
  assert.deepEqual(options, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(args[args.indexOf("-c:v") + 1], "libvpx");
  assert.equal(args[args.indexOf("-vcodec") + 1], "mjpeg");
  assert.equal(args[args.indexOf("-framerate") + 1], "30");
  assert.equal(args[args.indexOf("-vf") + 1], "scale=320:240");
  assert.equal(args[args.indexOf("-aspect") + 1], "320:240");
  assert.deepEqual(args.slice(-3), ["-f", "webm", "pipe:1"]);
  assert.equal(f.evaluations(), 0);
  assert.deepEqual(f.session.calls.find((call) => call.method === "Page.startScreencast")?.params, { format: "jpeg", quality: 90 });
  assert.deepEqual(f.session.calls.find((call) => call.method === "Page.captureScreenshot")?.params, { format: "jpeg", quality: 90, captureBeyondViewport: false });
  assert.equal(f.session.detaches, 1);
  cleanSession(f.session);
});

test("a frame burst is ACKed without accumulating pending stdin writes; stop preserves the idle tail", async (t) => {
  const f = fixture(t);
  const recorder = await f.page.screencast({ fps: 20 });
  recorder.resume();
  f.encoder.hold = true;
  f.session.frame(1);
  f.advance(100);
  t.mock.timers.tick(100);
  await turn();
  assert.equal(f.encoder.frames.length, 2);
  for (let index = 2; index <= 1000; index++) f.session.frame(index);
  f.advance(1000);
  const stopped = recorder.stop();
  await turn();
  assert.equal(f.encoder.frames.length, 2, "backpressure holds exactly one write");
  assert.equal(f.session.calls.filter((call) => call.method === "Page.screencastFrameAck").length, 1000);
  assert.deepEqual(f.session.calls.filter((call) => call.method === "Page.screencastFrameAck").at(-1)?.params, { sessionId: 1000 });
  f.encoder.hold = false;
  f.encoder.release!();
  await stopped;
  assert.equal(f.encoder.frames.length, 20);
  assert.equal(f.encoder.frames[1].toString(), "jpeg-1");
  assert.ok(f.encoder.frames.slice(2).every((frame) => frame.toString() === "jpeg-1000"));
  cleanSession(f.session);
});

test("clock sampling continues after a tick with no new encoder frame due", async (t) => {
  const f = fixture(t);
  const recorder = await f.page.screencast({ fps: 10 });
  recorder.resume();
  t.mock.timers.tick(100);
  await turn();
  f.advance(500);
  t.mock.timers.tick(100);
  await turn();
  assert.equal(f.encoder.frames.length, 5);
  await recorder.stop();
});

test("immediate stop writes one decodable frame and scale uses evaluated dimensions without viewport mutation", async (t) => {
  const f = fixture(t, null);
  const recorder = await f.page.screencast({ scale: 0.5 });
  recorder.resume();
  await recorder.stop();
  assert.equal(f.encoder.frames.length, 1);
  assert.equal(f.evaluations(), 1);
  assert.equal(f.calls[0].command, "ffmpeg");
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf("-vf") + 1], "scale=320:180");
  assert.equal(f.encoder.killed, false);
});

for (const [viewport, options, expected] of [
  [{ width: 800, height: 600 }, { size: { width: 321, height: 241 } }, { width: 320, height: 240 }],
  [{ width: 1920, height: 1080 }, {}, { width: 800, height: 450 }],
  [{ width: 640, height: 480 }, { size: { width: 1000, height: 1000 } }, { width: 640, height: 480 }],
] as const) {
  test(`video dimensions fit bounds and normalize to even ${expected.width}x${expected.height}`, async (t) => {
    const f = fixture(t, viewport);
    const recorder = await f.page.screencast(options);
    recorder.resume();
    assert.deepEqual(recorder.size, expected);
    assert.equal(f.calls[0].args[f.calls[0].args.indexOf("-vf") + 1], `scale=${expected.width}:${expected.height}`);
    await recorder.stop();
  });
}

test("invalid format and numeric options fail before a CDP session or encoder is started", async (t) => {
  const f = fixture(t);
  for (const options of [
    { format: "gif" }, { fps: 0 }, { fps: 61 }, { fps: 1.5 }, { scale: 0 }, { scale: 5 },
    { size: { width: 0, height: 10 } }, { size: { width: 10, height: 10 }, scale: 1 }, { ffmpegPath: " " },
  ]) await assert.rejects(f.page.screencast(options as never));
  assert.equal(f.session.calls.length, 0);
  assert.equal(f.calls.length, 0);
});

for (const method of ["Page.enable", "Page.captureScreenshot", "Page.startScreencast"]) {
  test(`a ${method} start failure detaches the owned session`, async (t) => {
    const f = fixture(t);
    f.session.failMethod = method;
    await assert.rejects(f.page.screencast({}), new RegExp(`failed ${method}`));
    assert.equal(f.calls.length, 0);
    assert.equal(f.session.detaches, 1);
    cleanSession(f.session);
  });
}

test("aborted CDP acquisition releases a late session without starting FFmpeg", async (t) => {
  const f = fixture(t);
  let release!: (value: Session) => void;
  Object.assign(f.source, { createCDPSession: () => new Promise<Session>((resolve) => { release = resolve; }) });
  const controller = new AbortController();
  const starting = f.page.screencast({ signal: controller.signal });
  const rejected = assert.rejects(starting, { name: "AbortError" });
  controller.abort();
  await rejected;
  release(f.session);
  await turn();
  assert.equal(f.session.detaches, 1);
  assert.equal(f.calls.length, 0);
});

test("aborted initial screenshot detaches the owned session even if the command never returns", async (t) => {
  const f = fixture(t);
  const send = f.session.send.bind(f.session);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  t.mock.method(f.session, "send", async (method: string, params?: unknown) => {
    if (method === "Page.captureScreenshot") { entered(); return await new Promise<never>(() => {}); }
    return send(method, params);
  });
  const controller = new AbortController();
  const starting = f.page.screencast({ signal: controller.signal });
  const rejected = assert.rejects(starting, { name: "AbortError" });
  await ready;
  controller.abort();
  await rejected;
  assert.equal(f.session.detaches, 1);
  assert.equal(f.calls.length, 0);
  cleanSession(f.session);
});

test("spawn failure is handled before any consumer attaches and cleans up CDP", async (t) => {
  const f = fixture(t);
  const missing = new Error("spawn missing-ffmpeg ENOENT");
  const page = createCdpVideoPage(f.source, {
    spawn: (() => {
      process.nextTick(() => { f.encoder.emit("error", missing); f.encoder.emit("close", -2, null); });
      return f.encoder;
    }) as unknown as typeof spawn,
  });
  await assert.rejects(page.screencast({}), (error) => error === missing);
  await turn();
  assert.equal(f.session.detaches, 1);
  cleanSession(f.session);
});

for (const code of [0, 7]) {
  test(`unexpected FFmpeg exit ${code} surfaces bounded stderr even before a consumer attaches`, async (t) => {
    const f = fixture(t);
    const recorder = await f.page.screencast({});
    f.encoder.stderr.write("x".repeat(20000) + "encoder diagnostic");
    f.encoder.exit(code);
    await turn();
    await assert.rejects(recorder.stop(), (error: Error) => {
      assert.match(error.message, new RegExp(`FFmpeg exited with code ${code}`));
      assert.ok(error.message.endsWith("encoder diagnostic"));
      assert.ok(error.message.length < 8300);
      return true;
    });
    assert.equal(recorder.destroyed, true);
    assert.equal(f.session.detaches, 1);
    cleanSession(f.session);
  });
}

for (const trigger of ["exit", "stdin", "disconnect", "destination"] as const) {
  test(`${trigger} while stdin is blocked settles stop without waiting for its callback`, { timeout: 1000 }, async (t) => {
    const f = fixture(t);
    const recorder = await f.page.screencast({ fps: 20 });
    recorder.resume();
    f.encoder.hold = true;
    f.advance(1000);
    t.mock.timers.tick(100);
    await turn();
    assert.equal(f.encoder.frames.length, 2);
    if (trigger === "exit") f.encoder.exit(9);
    if (trigger === "stdin") f.encoder.stdin.emit("error", new Error("stdin rejected frame"));
    if (trigger === "disconnect") f.session.emit(CDPSessionEvent.Disconnected);
    if (trigger === "destination") recorder.destroy(new Error("destination full"));
    await assert.rejects(recorder.stop(), /FFmpeg exited|stdin rejected|disconnected|destination full/);
    assert.equal(recorder.destroyed, true);
    if (trigger !== "exit") assert.equal(f.encoder.killed, true);
    if (trigger !== "disconnect") assert.equal(f.session.detaches, 1);
    cleanSession(f.session);
  });
}

test("ACK failure stops the encoder and removes the owned CDP listeners", async (t) => {
  const f = fixture(t);
  const recorder = await f.page.screencast({});
  recorder.resume();
  f.session.failMethod = "Page.screencastFrameAck";
  f.session.frame(1);
  await turn();
  await assert.rejects(recorder.stop(), /failed Page.screencastFrameAck/);
  assert.equal(f.encoder.killed, true);
  assert.equal(f.session.detaches, 1);
  cleanSession(f.session);
});

test("stop protocol failure still detaches and rejects instead of leaking the encoder", async (t) => {
  const f = fixture(t);
  const recorder = await f.page.screencast({});
  recorder.resume();
  f.session.failMethod = "Page.stopScreencast";
  await assert.rejects(recorder.stop(), /failed Page.stopScreencast/);
  assert.equal(f.session.detaches, 1);
  assert.equal(f.encoder.killed, true);
  cleanSession(f.session);
});
