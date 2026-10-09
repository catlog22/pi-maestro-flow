import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { FileFinderApi, InitOptions } from "@ff-labs/fff-node";
import { createFffProcessFinder, type FffFinder, type CreateFffFinder } from "../src/tools/fff-process.ts";

const exec = promisify(execFile);
const fixture = new URL("./fixtures/fff-process-worker.mjs", import.meta.url);
const loader = new URL("./fixtures/fff-process-parent-loader.mjs", import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function create(options: InitOptions, workerPath?: string | URL, requestTimeoutMs = 10_000,
  runtimeOptions: Parameters<typeof createFffProcessFinder>[1] = {}): FffFinder {
  const result = createFffProcessFinder(options, { workerPath, requestTimeoutMs, ...runtimeOptions });
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.value;
}
async function metadata(finder: FffFinder) {
  const result = await finder.fileSearch("meta");
  assert.ok(result.ok);
  return JSON.parse(result.value.items[0].relativePath) as {
    pid: number; execArgv: string[]; nodeOptions?: string; options: InitOptions; calls: number;
  };
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await sleep(20);
  assert.ok(predicate(), description);
}

// Compile-time contract: unmodified injected native/synchronous fake finders fit.
const acceptsNative = (finder: FileFinderApi): FffFinder => finder;
const acceptsFactory = (factory: (options: InitOptions) => ReturnType<CreateFffFinder>): CreateFffFinder => factory;
void acceptsNative;
void acceptsFactory;

test("persistent real child scans and paginates grep, glob and fileSearch", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "fff-process-native-"));
  await mkdir(join(root, "src"));
  await Promise.all(["alpha.ts", "beta.ts", "gamma.ts"].map((name) =>
    writeFile(join(root, "src", name), `export const PROCESS_NEEDLE_${name[0]} = true;\n`)));
  const finder = create({ basePath: root }); // Preserve native mmap/content-index/watch defaults.
  try {
    const scan = await finder.waitForScan(10_000);
    assert.deepEqual(scan, { ok: true, value: true });
    const search = await finder.fileSearch("alpha", { pageSize: 1 });
    assert.ok(search.ok);
    assert.equal(search.value.items[0].fileName, "alpha.ts");
    const firstGlob = await finder.glob("**/*.ts", { pageSize: 1, pageIndex: 0 });
    const nextGlob = await finder.glob("**/*.ts", { pageSize: 1, pageIndex: 1 });
    assert.ok(firstGlob.ok && nextGlob.ok);
    assert.equal(firstGlob.value.totalMatched, 3);
    assert.notEqual(firstGlob.value.items[0].relativePath, nextGlob.value.items[0].relativePath);
    const files = new Set<string>();
    let cursor;
    let pages = 0;
    do {
      const page = await finder.grep("PROCESS_NEEDLE", { pageSize: 1, cursor, smartCase: false });
      assert.ok(page.ok);
      page.value.items.forEach((item) => files.add(item.fileName));
      cursor = page.value.nextCursor;
      if (cursor) {
        assert.equal(cursor.__brand, "GrepCursor");
        assert.equal(typeof cursor._offset, "number");
      }
      assert.ok(++pages <= 5, "pagination must terminate");
    } while (cursor);
    assert.deepEqual([...files].sort(), ["alpha.ts", "beta.ts", "gamma.ts"]);
    assert.equal(finder.isDestroyed, false);
  } finally {
    await finder.destroy();
    assert.equal(finder.isDestroyed, true);
    await rm(root, { recursive: true, force: true });
  }
});

test("options are unchanged and child does not inherit loader/inspector flags", async () => {
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--inspect=0 --require=nonexistent-module";
  const options = { basePath: "fixture", aiMode: true, cacheBudgetMaxFiles: 15 };
  let finder: FffFinder;
  try { finder = create(options, fixture); }
  finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
  try {
    const first = await metadata(finder);
    const second = await metadata(finder);
    assert.notEqual(first.pid, process.pid);
    assert.equal(first.pid, second.pid, "finder retains the same child across calls");
    assert.deepEqual(first.execArgv, []);
    assert.equal(first.nodeOptions, undefined);
    assert.deepEqual(first.options, options);
    assert.ok(second.calls > first.calls);
    const cursor = { _offset: 42, __brand: "GrepCursor" as const };
    const grep = await finder.grep("echo", { cursor });
    assert.ok(grep.ok);
    assert.deepEqual(grep.value.nextCursor, cursor);
  } finally { await finder.destroy(); }
});

test("worker crash rejects every pending request and a new finder still works", async () => {
  const finder = create({ basePath: "fixture" }, fixture);
  const { pid } = await metadata(finder);
  const hung = Promise.resolve(finder.grep("hang"));
  const crash = Promise.resolve(finder.grep("crash"));
  await Promise.all([
    assert.rejects(hung, /FFF worker (exited|disconnected)/),
    assert.rejects(crash, /FFF worker (exited|disconnected)/),
  ]);
  assert.equal(finder.isDestroyed, true);
  await assert.rejects(Promise.resolve(finder.fileSearch("later")), /FFF worker/);
  await finder.closed;
  await waitUntil(() => !alive(pid), "crashed child must be reaped");
  const root = await mkdtemp(join(tmpdir(), "fff-after-crash-"));
  await writeFile(join(root, "replacement.ts"), "const REPLACEMENT_NEEDLE = true;\n");
  const replacement = create({ basePath: root });
  try {
    assert.deepEqual(await replacement.waitForScan(), { ok: true, value: true });
    const result = await replacement.grep("REPLACEMENT_NEEDLE");
    assert.ok(result.ok);
    assert.equal(result.value.items[0].fileName, "replacement.ts");
  } finally {
    await replacement.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("destroy rejects requests, kills the owned child and prohibits later publication", async () => {
  const finder = create({ basePath: "fixture" }, fixture);
  const { pid } = await metadata(finder);
  const pending = Promise.resolve(finder.grep("hang"));
  const rejection = assert.rejects(pending, /FFF finder destroyed/);
  const cleanup = finder.destroy();
  assert.equal(finder.destroy(), cleanup, "concurrent destruction is single-flight");
  await cleanup;
  await finder.closed;
  await rejection;
  assert.equal(finder.isDestroyed, true);
  await assert.rejects(Promise.resolve(finder.glob("*")), /FFF finder destroyed/);
  await waitUntil(() => !alive(pid), "destroyed child must be reaped");
});

test("destroy during initialization settles callers without unhandled init rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "fff-destroy-init-"));
  const pidFile = join(root, "worker.pid");
  const finder = create({ basePath: "hang-init", logFilePath: pidFile }, fixture);
  const pending = finder.waitForScan();
  const rejection = assert.rejects(pending, /FFF finder destroyed/);
  try {
    await waitUntil(() => existsSync(pidFile), "initialization must begin before destroy");
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(alive(pid));
    await finder.destroy();
    await rejection;
    assert.equal(finder.isDestroyed, true);
    await waitUntil(() => !alive(pid), "initializing child must be reaped");
    // Also destroy an eagerly initialized finder which has never been queried.
    const unused = create({ basePath: "hang-init" }, fixture);
    await unused.destroy();
    await sleep(50);
  } finally {
    await finder.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("first SIGKILL refusal retries and destroy waits for real close", async () => {
  const before = new Set(process.listeners("exit"));
  let attempts = 0;
  const finder = create({ basePath: "fixture" }, fixture, 10_000, {
    killChild: (child) => ++attempts === 1 ? false : child.kill("SIGKILL"),
  });
  const hooks = process.listeners("exit").filter((hook) => !before.has(hook));
  assert.equal(hooks.length, 1);
  let confirmed = false;
  assert.ok(finder.closed, "real proxy always supplies closed");
  void finder.closed.then(() => { confirmed = true; });
  try {
    await metadata(finder);
    const cleanup = finder.destroy();
    assert.equal(finder.destroy(), cleanup);
    assert.equal(finder.isDestroyed, true);
    assert.equal(confirmed, false);
    assert.ok(process.listeners("exit").includes(hooks[0]));
    await cleanup;
    assert.equal(confirmed, true);
    assert.equal(attempts, 2);
    assert.ok(!process.listeners("exit").includes(hooks[0]));
  } finally { await finder.destroy(); }
});

test("permanent kill refusal reports cleanup failure, retains ownership, and explicit destroy retries", async () => {
  const before = new Set(process.listeners("exit"));
  let refuse = true;
  let attempts = 0;
  const finder = create({ basePath: "fixture" }, fixture, 10_000, {
    killChild: (child) => {
      attempts++;
      if (refuse) throw new Error("injected kill refusal");
      return child.kill("SIGKILL");
    },
  });
  const hooks = process.listeners("exit").filter((hook) => !before.has(hook));
  assert.equal(hooks.length, 1);
  let confirmed = false;
  assert.ok(finder.closed);
  void finder.closed.then(() => { confirmed = true; });
  try {
    await metadata(finder);
    const pending = Promise.resolve(finder.grep("hang"));
    const rejection = assert.rejects(pending, (error: AggregateError) => {
      assert.match(error.message, /FFF finder destroyed/);
      assert.match(error.message, /cleanup failed.*close not confirmed.*injected kill refusal/);
      assert.equal(error.errors.length, 2);
      return true;
    });
    const started = Date.now();
    const cleanup = finder.destroy();
    assert.equal(finder.destroy(), cleanup);
    await assert.rejects(Promise.resolve(cleanup), /cleanup failed.*close not confirmed/);
    await rejection;
    assert.ok(Date.now() - started < 2_000, "reclamation must be bounded");
    assert.equal(attempts, 3);
    assert.equal(finder.isDestroyed, true, "destroyed does not claim closure");
    await sleep(30);
    assert.equal(confirmed, false, "cleanup deadline never resolves closed");
    assert.ok(process.listeners("exit").includes(hooks[0]));
    await assert.rejects(Promise.resolve(finder.glob("*")), /FFF finder destroyed[\s\S]*cleanup failed/);
    refuse = false;
    await finder.destroy();
    await finder.closed;
    assert.equal(confirmed, true);
    assert.equal(attempts, 4);
    assert.ok(!process.listeners("exit").includes(hooks[0]));
  } finally {
    refuse = false;
    await finder.destroy();
  }
});

test("timeout cleanup refusal preserves original cause and settles unused initialization", async () => {
  let refuse = true;
  const finder = create({ basePath: "fixture" }, fixture, 10_000, {
    killChild: (child) => refuse ? false : child.kill("SIGKILL"),
  });
  const unused = create({ basePath: "hang-init" }, fixture, 100, {
    killChild: (child) => refuse ? false : child.kill("SIGKILL"),
  });
  try {
    await metadata(finder);
    await assert.rejects(Promise.resolve(finder.grep("hang", { timeBudgetMs: 50 })),
      /request timed out.*grep[\s\S]*cleanup failed.*SIGKILL refused/);
    await assert.rejects(unused.waitForScan(), /request timed out.*init[\s\S]*cleanup failed/);
  } finally {
    refuse = false;
    await Promise.all([finder.destroy(), unused.destroy()]);
    await Promise.all([finder.closed, unused.closed]);
  }
});

test("close before explicit destroy removes hook and never signals an exited child", async () => {
  const before = new Set(process.listeners("exit"));
  let attempts = 0;
  const finder = create({ basePath: "fixture" }, fixture, 10_000, {
    killChild: (child) => { attempts++; return child.kill("SIGKILL"); },
  });
  const hooks = process.listeners("exit").filter((hook) => !before.has(hook));
  try {
    await metadata(finder);
    await assert.rejects(Promise.resolve(finder.grep("crash")), /FFF worker/);
    await finder.closed;
    const atClose = attempts;
    await finder.destroy();
    await finder.destroy();
    assert.equal(attempts, atClose, "close forbids any subsequent kill");
    assert.ok(!process.listeners("exit").includes(hooks[0]));
  } finally { await finder.destroy(); }
});

test("successful kill and exit cannot publish reclamation before close confirmation", async () => {
  const before = new Set(process.listeners("exit"));
  let releaseClose: (() => void) | undefined;
  let attempts = 0;
  const finder = create({ basePath: "fixture" }, fixture, 10_000, {
    forkChild: (path, args, options) => {
      const child = fork(path, args, options);
      const emit = child.emit.bind(child);
      child.emit = (event: string | symbol, ...values: unknown[]) => {
        if (event === "close") {
          releaseClose = () => { emit(event, ...values); };
          return true;
        }
        return emit(event, ...values);
      };
      return child;
    },
    killChild: (child) => { attempts++; return child.kill("SIGKILL"); },
  });
  const hooks = process.listeners("exit").filter((hook) => !before.has(hook));
  let confirmed = false;
  assert.ok(finder.closed);
  void finder.closed.then(() => { confirmed = true; });
  try {
    await metadata(finder);
    await assert.rejects(Promise.resolve(finder.destroy()), /cleanup failed.*close not confirmed/);
    assert.equal(attempts, 1, "exit forbids kill retries even before close");
    assert.equal(confirmed, false);
    assert.ok(process.listeners("exit").includes(hooks[0]));
    assert.ok(releaseClose, "real child closed, but delivery was deliberately withheld");
    releaseClose();
    await finder.closed;
    await finder.destroy();
    assert.equal(attempts, 1);
    assert.ok(!process.listeners("exit").includes(hooks[0]));
  } finally {
    releaseClose?.();
    await finder.destroy();
  }
});

test("close-first event ordering fences calls without signaling an already closed child", async () => {
  let terminate: (() => void) | undefined;
  let attempts = 0;
  const finder = create({ basePath: "fixture" }, fixture, 10_000, {
    forkChild: (path, args, options) => {
      const child = fork(path, args, options);
      const emit = child.emit.bind(child);
      // Simulate close delivery without earlier exit/disconnect stop callbacks.
      child.emit = (event: string | symbol, ...values: unknown[]) => event === "exit" || event === "disconnect"
        ? false : emit(event, ...values);
      terminate = () => { child.kill("SIGKILL"); };
      return child;
    },
    killChild: (child) => { attempts++; return child.kill("SIGKILL"); },
  });
  try {
    await metadata(finder);
    assert.equal(finder.isDestroyed, false);
    terminate!();
    await finder.closed;
    assert.equal(finder.isDestroyed, true);
    await assert.rejects(Promise.resolve(finder.glob("*")), /FFF worker closed/);
    await finder.destroy();
    assert.equal(attempts, 0);
  } finally { await finder.destroy(); }
});

test("synchronous fork failure and asynchronous spawn failure settle without retained ownership", async () => {
  const failed = createFffProcessFinder({ basePath: "fixture" }, {
    forkChild: () => { throw new Error("injected fork failure"); },
  });
  assert.deepEqual(failed, { ok: false, error: "FFF worker could not start: Error: injected fork failure" });
  const before = new Set(process.listeners("exit"));
  const finder = create({ basePath: "fixture" }, fixture, 10_000, {
    forkChild: (path, args, options) => fork(path, args, {
      ...options, execPath: join(tmpdir(), `fff-no-executable-${process.pid}`),
    }),
  });
  const hooks = process.listeners("exit").filter((hook) => !before.has(hook));
  try {
    await assert.rejects(finder.waitForScan(), /FFF worker (error|send failed)/);
    await finder.destroy();
    await finder.closed;
    assert.equal(finder.isDestroyed, true);
    assert.ok(!process.listeners("exit").includes(hooks[0]));
  } finally { await finder.destroy(); }
});

test("request timeout fails all pending work and kills the persistent child", async () => {
  const finder = create({ basePath: "fixture" }, fixture);
  const { pid } = await metadata(finder);
  await assert.rejects(Promise.resolve(finder.grep("hang", { timeBudgetMs: 300 })), /request timed out.*grep/);
  assert.equal(finder.isDestroyed, true);
  await finder.closed;
  await waitUntil(() => !alive(pid), "timed-out child must be reaped");
});

test("caller scan/grep budgets bound IPC waiting, including unfinished initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "fff-budget-init-"));
  const pidFile = join(root, "worker.pid");
  const initializing = create({ basePath: "hang-init", logFilePath: pidFile }, fixture);
  try {
    // Ensure an early scan reply is possible while init itself remains pending.
    await waitUntil(() => existsSync(pidFile), "initialization must start before the scan budget probe");
    const started = Date.now();
    await assert.rejects(initializing.waitForScan(100), /request timed out.*waitForScan/);
    assert.ok(Date.now() - started < 1_500, "scan budget must not wait for the adapter hard timeout");
    assert.equal(initializing.isDestroyed, true);
  } finally {
    await initializing.destroy();
    await rm(root, { recursive: true, force: true });
  }
  const scanning = create({ basePath: "fixture" }, fixture);
  try {
    await metadata(scanning);
    const started = Date.now();
    await assert.rejects(Promise.resolve(scanning.grep("hang", { timeBudgetMs: 100 })), /request timed out.*grep/);
    assert.ok(Date.now() - started < 1_500, "grep budget must bound a blocked native operation");
    assert.equal(scanning.isDestroyed, true);
  } finally { await scanning.destroy(); }
});

test("initialization timeout is observed even if factory result is never queried", async () => {
  const finder = create({ basePath: "hang-init" }, fixture, 300);
  await waitUntil(() => finder.isDestroyed, "unused initialization must time out");
  await assert.rejects(finder.waitForScan(), /request timed out.*init/);
  await finder.closed;
});

test("init failure, missing worker and invalid native base settle deterministically", async () => {
  for (const [options, path, pattern] of [
    [{ basePath: "fail-init" }, fixture, /initialization failed.*injected initialization failure/],
    [{ basePath: "fixture" }, new URL("./fixtures/fff-does-not-exist.mjs", import.meta.url), /FFF worker/],
    [{ basePath: join(tmpdir(), `fff-missing-${process.pid}-${Date.now()}`) }, undefined, /initialization failed/],
  ] as const) {
    const finder = create(options, path);
    try {
      await assert.rejects(finder.waitForScan(1_000), pattern);
      assert.equal(finder.isDestroyed, true);
    } finally { await finder.destroy(); }
  }
});

test("scan failures preserve native Result; disconnect rejects outstanding requests", async () => {
  const failedScan = create({ basePath: "scan-failure" }, fixture);
  try {
    assert.deepEqual(await failedScan.waitForScan(), { ok: false, error: "injected scan failure" });
  } finally { await failedScan.destroy(); }
  const finder = create({ basePath: "fixture" }, fixture);
  const { pid } = await metadata(finder);
  await assert.rejects(Promise.resolve(finder.grep("disconnect")), /disconnected/);
  assert.equal(finder.isDestroyed, true);
  await finder.closed;
  await waitUntil(() => !alive(pid), "disconnected child must be reaped");
});

test("stderr diagnostic capture is bounded", async () => {
  const finder = create({ basePath: "fixture" }, fixture);
  await metadata(finder);
  await assert.rejects(Promise.resolve(finder.grep("stderr-crash")), (error: Error) => {
    assert.match(error.message, /diagnostic-tail/);
    assert.ok(error.message.length < 8_400);
    return true;
  });
  assert.equal(finder.isDestroyed, true);
  await finder.closed;
});

test("plain real worker exits when its parent disconnects", async () => {
  const child = fork(new URL("../bin/fff-worker.mjs", import.meta.url), [], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  child.disconnect();
  try {
    await Promise.race([exit, sleep(5_000).then(() => { throw new Error("worker orphaned on disconnect"); })]);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
});

test("packaged layout works in a fresh Node parent with native/Pi imports forbidden", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "fff-process-packed-"));
  try {
    // No package lifecycle scripts or full packed-consumer suite: only these two
    // published files and their actual runtime dependency closure are exercised.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = await exec(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
      cwd: packageRoot, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    const [manifest] = JSON.parse(packed.stdout);
    for (const path of ["src/tools/fff-process.ts", "bin/fff-worker.mjs"]) {
      assert.ok(manifest.files.some((file: { path: string }) => file.path === path), `${path} must be published`);
    }
    // Relative archive/destination also work with Git-for-Windows tar, which
    // otherwise interprets a drive-letter colon as a remote archive host.
    await exec("tar", ["-xf", manifest.filename, "-C", ".",
      "package/package.json", "package/src/tools/fff-process.ts", "package/bin/fff-worker.mjs"], { cwd: root, timeout: 10_000 });
    const staged = join(root, "package");
    const seen = new Set<string>();
    async function copyRuntime(name: string, from: string): Promise<void> {
      if (seen.has(name)) return;
      const require = createRequire(join(from, "package.json"));
      let pkgPath: string;
      try { pkgPath = require.resolve(`${name}/package.json`); }
      catch {
        // fff-node is import-only, so use its public ESM entry for package root.
        if (name !== "@ff-labs/fff-node") throw new Error(`Cannot resolve installed runtime dependency ${name}`);
        pkgPath = fileURLToPath(new URL("../../package.json", import.meta.resolve("@ff-labs/fff-node")));
      }
      seen.add(name);
      const source = dirname(pkgPath);
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      const target = join(staged, "node_modules", name);
      await cp(source, target, { recursive: true, dereference: true });
      for (const dependency of Object.keys(pkg.dependencies ?? {})) await copyRuntime(dependency, source);
      for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
        if (existsSync(join(source, "node_modules", dependency)) || (() => {
          try { require.resolve(`${dependency}/package.json`); return true; } catch { return false; }
        })()) await copyRuntime(dependency, source);
      }
    }
    await copyRuntime("@ff-labs/fff-node", packageRoot);
    assert.ok(!existsSync(join(staged, "node_modules", "@earendil-works")));
    const source = readFileSync(join(staged, "src/tools/fff-process.ts"), "utf8");
    assert.match(source, /import type .* from "@ff-labs\/fff-node"/);
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "workspace", "packed.ts"), "const PACKED_PROCESS_NEEDLE = true;\n");
    const entry = pathToFileURL(join(staged, "src/tools/fff-process.ts")).href;
    const code = `
      import assert from 'node:assert/strict';
      const {createFffProcessFinder} = await import(${JSON.stringify(entry)});
      const created = createFffProcessFinder({basePath: ${JSON.stringify(join(root, "workspace"))}});
      assert.ok(created.ok);
      const finder = created.value;
      try {
        assert.deepEqual(await finder.waitForScan(10000), {ok:true,value:true});
        const result = await finder.grep('PACKED_PROCESS_NEEDLE');
        assert.ok(result.ok);
        assert.equal(result.value.items[0].fileName, 'packed.ts');
        console.log('PACKAGED_NATIVE_ISOLATION_OK');
      } finally {await finder.destroy();}
    `;
    const fresh = await exec(process.execPath, ["--experimental-transform-types", "--loader", loader.href,
      "--input-type=module", "--eval", code], { cwd: root, timeout: 20_000 });
    assert.match(fresh.stdout, /PACKAGED_NATIVE_ISOLATION_OK/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
