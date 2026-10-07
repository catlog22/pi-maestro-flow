import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { launchAttachedChrome, type BrowserOpenOptions } from "../src/tools/browser/manager.ts";

type SpawnBrowser = NonNullable<Parameters<typeof launchAttachedChrome>[3]>;

function fakeLaunch(onSpawn: (args: string[], child: ChildProcess, stderr: PassThrough) => void) {
  const child = new ChildProcess();
  const stderr = new PassThrough();
  child.stderr = stderr;
  let unrefed = false;
  child.unref = () => { unrefed = true; };
  const spawn: SpawnBrowser = (_command, args, options) => {
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
    queueMicrotask(() => onSpawn(args, child, stderr));
    return child;
  };
  return { spawn, child, stderr, unrefed: () => unrefed };
}

const options: BrowserOpenOptions = { name: "profile", cwd: process.cwd(), visible: true, timeoutMs: 1_000 };

for (const visible of [true, false]) {
  test(`profile auto-launch publishes and reads a dynamic port (visible=${visible})`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-profile-attach-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    let write: Promise<void> | undefined;
    let args: string[] = [];
    const fake = fakeLaunch((actualArgs) => {
      args = actualArgs;
      write = fs.writeFile(path.join(dir, "DevToolsActivePort"), "49152\n/devtools/browser/test\n");
    });
    const endpoint = await launchAttachedChrome("chromium", dir, { ...options, visible, args: ["--disable-gpu"] }, fake.spawn);
    await write;
    assert.deepEqual(endpoint, { port: 49152, wsPath: "/devtools/browser/test" });
    assert.ok(args.includes("--remote-debugging-port=0"));
    assert.ok(!args.includes("--remote-debugging-port=9222"));
    assert.ok(args.includes(`--user-data-dir=${dir}`));
    assert.ok(args.includes("--disable-gpu"));
    assert.equal(args.includes("--headless=new"), !visible);
    assert.equal(fake.unrefed(), true);
    assert.equal(fake.stderr.destroyed, true);
  });
}

test("profile auto-launch waits for endpoint publication after a successful Windows launcher handoff", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-profile-handoff-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let write: Promise<void> | undefined;
  const fake = fakeLaunch((_args, child) => {
    child.emit("exit", 0, null);
    write = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        fs.writeFile(path.join(dir, "DevToolsActivePort"), "49153\n/devtools/browser/handoff\n").then(resolve, reject);
      }, 20);
    });
  });
  const endpoint = await launchAttachedChrome("chrome", dir, options, fake.spawn);
  await write;
  assert.deepEqual(endpoint, { port: 49153, wsPath: "/devtools/browser/handoff" });
  assert.equal(fake.stderr.destroyed, true);
});

test("profile auto-launch reports spawn errors without masking them as a locked profile", async () => {
  const failure = Object.assign(new Error("spawn chromium ENOENT"), { code: "ENOENT" });
  const fake = fakeLaunch((_args, child) => child.emit("error", failure));
  await assert.rejects(launchAttachedChrome("chromium", os.tmpdir(), options, fake.spawn), (error: Error) => {
    assert.match(error.message, /Failed to launch chromium: spawn chromium ENOENT/);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(fake.stderr.destroyed, true);
});

test("profile auto-launch reports an early exit and browser stderr", async () => {
  const fake = fakeLaunch((_args, child, stderr) => {
    stderr.write("Browser startup denied by policy\n");
    child.emit("exit", 1, null);
  });
  await assert.rejects(launchAttachedChrome("edge", os.tmpdir(), options, fake.spawn), /browser exited with code 1[\s\S]*Browser stderr: Browser startup denied by policy/);
  assert.equal(fake.stderr.destroyed, true);
});

test("profile auto-launch explains default-directory restrictions instead of asking only to close windows", async () => {
  const fake = fakeLaunch((_args, _child, stderr) => {
    stderr.write("DevTools remote debugging requires a non-default data directory.\n");
  });
  await assert.rejects(launchAttachedChrome("chrome", os.tmpdir(), options, fake.spawn), (error: Error) => {
    assert.match(error.message, /browser rejected remote debugging/);
    assert.match(error.message, /Chrome 136\+/);
    assert.match(error.message, /closing windows does not remove that restriction/);
    assert.match(error.message, /app\.channel:"extension"/);
    assert.match(error.message, /No profile is copied or switched automatically/);
    return true;
  });
  assert.equal(fake.stderr.destroyed, true);
});

test("profile auto-launch times out without declaring that a missing endpoint proves a lock", async () => {
  const fake = fakeLaunch(() => {});
  await assert.rejects(launchAttachedChrome("edge", os.tmpdir(), { ...options, timeoutMs: 20 }, fake.spawn), (error: Error) => {
    assert.match(error.message, /no DevToolsActivePort appeared within 0\.02s after --remote-debugging-port=0/);
    assert.match(error.message, /Possible causes include/);
    assert.match(error.message, /remote debugging disabled by the browser\/policy/);
    assert.doesNotMatch(error.message, /close it and retry/);
    return true;
  });
  assert.equal(fake.stderr.destroyed, true);
});

test("profile auto-launch rejects cancellation before starting a browser", async () => {
  let spawned = false;
  const controller = new AbortController();
  controller.abort();
  const fake = fakeLaunch(() => { spawned = true; });
  await assert.rejects(launchAttachedChrome("chrome", os.tmpdir(), { ...options, signal: controller.signal }, fake.spawn), { name: "AbortError" });
  assert.equal(spawned, false);
  assert.equal(fake.unrefed(), false);
});

test("profile auto-launch cancels endpoint polling and releases its stderr pipe", async () => {
  const controller = new AbortController();
  const fake = fakeLaunch(() => controller.abort());
  await assert.rejects(launchAttachedChrome("chrome", os.tmpdir(), { ...options, signal: controller.signal }, fake.spawn), { name: "AbortError" });
  assert.equal(fake.stderr.destroyed, true);
});

for (const arg of ["--remote-debugging-port=9222", "--remote-debugging-port", "--remote-debugging-pipe"]) {
  test(`profile auto-launch rejects an incompatible discovery override: ${arg}`, async () => {
    const fake = fakeLaunch(() => assert.fail("must not spawn with incompatible arguments"));
    await assert.rejects(launchAttachedChrome("chrome", os.tmpdir(), { ...options, args: [arg] }, fake.spawn), /fixed debugging port[\s\S]*app\.channel:"cdp"/);
    assert.equal(fake.unrefed(), false);
  });
}
