import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiServer, startGuiServer } from "../src/gui/gui-server.ts";
import { registerStateRoutes } from "../src/gui/gui-state.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindGuiStartupIfCurrent, guiContextForGeneration } from "../src/gui/index.ts";
import { GUI_DISCOVERY_FILENAME, type GuiDiscoveryFile, type GuiServerHandle } from "../src/gui/types.ts";

interface JsonResp {
  status: number;
  body: any;
}

async function requestJson(
  port: number,
  path: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<JsonResp> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let payload: string | undefined;
  if (init.body !== undefined) {
    payload = JSON.stringify(init.body);
    headers["Content-Type"] = "application/json";
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: payload,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Connect to the SSE stream and collect events until `count` events or timeout. */
function collectSse(
  port: number,
  token: string,
  count: number,
  opts: { lastEventId?: string; timeoutMs?: number } = {},
): Promise<Array<{ id: string; event: string; data: any }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ id: string; event: string; data: any }> = [];
    const headers: Record<string, string> = {};
    if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;
    const req = http.get(
      { host: "127.0.0.1", port, path: `/events?session=${token}`, headers },
      (res) => {
        let buffer = "";
        let current: Partial<{ id: string; event: string; data: string }> = {};
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.startsWith(":")) continue; // comment / heartbeat
            if (line === "") {
              if (current.data !== undefined) {
                events.push({
                  id: current.id ?? "",
                  event: current.event ?? "message",
                  data: JSON.parse(current.data),
                });
                if (events.length >= count) {
                  req.destroy();
                  resolve(events);
                  return;
                }
              }
              current = {};
              continue;
            }
            const colon = line.indexOf(":");
            const field = colon >= 0 ? line.slice(0, colon) : line;
            const value = colon >= 0 ? line.slice(colon + 1).trimStart() : "";
            if (field === "id") current.id = value;
            else if (field === "event") current.event = value;
            else if (field === "data") current.data = value;
          }
        });
        res.on("error", () => resolve(events));
      },
    );
    req.on("error", reject);
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, opts.timeoutMs ?? 2000);
  });
}

test("gui-server: health requires a valid token", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-server-"));
  const server = await startGuiServer({ sessionId: "sess-1", cwd, writeDiscovery: false });
  try {
    const ok = await requestJson(server.port, "/health", { token: server.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.result.healthy, true);
    assert.equal(ok.body.result.sessionId, "sess-1");

    const noToken = await requestJson(server.port, "/health");
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.ok, false);

    const badToken = await requestJson(server.port, "/health", { token: "wrong" });
    assert.equal(badToken.status, 403);

    const queryToken = await fetch(`http://127.0.0.1:${server.port}/health?session=${server.token}`);
    assert.equal(queryToken.status, 200);
  } finally {
    server.close("test-done");
  }
});

test("gui-server: SSE delivers pushed events and replays via Last-Event-ID", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-server-"));
  const server = await startGuiServer({ sessionId: "sess-2", cwd, writeDiscovery: false });
  try {
    const live = collectSse(server.port, server.token, 1);
    // Give the client a moment to connect before pushing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.pushEvent("todo.updated", { revision: 7 });
    const events = await live;
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "todo.updated");
    assert.deepEqual(events[0].data, { revision: 7 });
    const firstId = events[0].id;

    // Push a second event, then reconnect with Last-Event-ID = firstId; expect only the second.
    server.pushEvent("goal.changed", { phase: "run" });
    const replayed = await collectSse(server.port, server.token, 1, { lastEventId: firstId });
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].event, "goal.changed");
    assert.deepEqual(replayed[0].data, { phase: "run" });
  } finally {
    server.close("test-done");
  }
});

test("gui-server: SSE flush coalesces same-name client events to the latest frame", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-server-coalesce-"));
  const server = await startGuiServer({ sessionId: "sess-coalesce", cwd, writeDiscovery: false });
  try {
    const live = collectSse(server.port, server.token, 2, { timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    server.pushEvent("tool.progress", { sequence: 1 });
    server.pushEvent("goal.changed", { phase: "run" });
    server.pushEvent("tool.progress", { sequence: 2 });

    const events = await live;
    assert.deepEqual(
      events.map(({ event, data }) => ({ event, data })),
      [
        { event: "goal.changed", data: { phase: "run" } },
        { event: "tool.progress", data: { sequence: 2 } },
      ],
    );
    assert.ok(Number(events[0].id) < Number(events[1].id), "flushed event ids stay chronological");
  } finally {
    server.close("test-done");
  }
});

test("gui-server: route registry handles GET, POST, path params, and 404", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-server-"));
  const server = await startGuiServer({ sessionId: "sess-3", cwd, writeDiscovery: false });
  try {
    server.registerRoute("GET", "/tools", () => ({ result: [{ name: "todo" }] }));
    server.registerRoute("GET", "/state/:sub", (req) => ({ result: { sub: req.params.sub } }));
    server.registerRoute("POST", "/tools/:name", (req) => {
      if (req.body?.args === undefined) return { error: "args required", code: "bad_request" };
      return { result: { invoked: req.params.name, args: req.body.args } };
    });

    const list = await requestJson(server.port, "/tools", { token: server.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.result, [{ name: "todo" }]);

    const sub = await requestJson(server.port, "/state/goal", { token: server.token });
    assert.equal(sub.status, 200);
    assert.deepEqual(sub.body.result, { sub: "goal" });

    const invoke = await requestJson(server.port, "/tools/todo", {
      method: "POST",
      token: server.token,
      body: { args: { action: "list" } },
    });
    assert.equal(invoke.status, 200);
    assert.deepEqual(invoke.body.result, { invoked: "todo", args: { action: "list" } });

    const invokeNoToken = await requestJson(server.port, "/tools/todo", {
      method: "POST",
      body: { token: "wrong", args: {} },
    });
    assert.equal(invokeNoToken.status, 403);

    const badInvoke = await requestJson(server.port, "/tools/todo", {
      method: "POST",
      token: server.token,
      body: {},
    });
    assert.equal(badInvoke.status, 400);
    assert.equal(badInvoke.body.ok, false);

    const missing = await requestJson(server.port, "/nope", { token: server.token });
    assert.equal(missing.status, 404);
  } finally {
    server.close("test-done");
  }
});

test("gui-server: writes and removes the discovery file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-server-"));
  const server = await startGuiServer({ sessionId: "sess-4", cwd });
  const discoveryPath = join(cwd, ".workflow", GUI_DISCOVERY_FILENAME);
  try {
    assert.ok(server.discoveryPath, "discoveryPath should be set");
    assert.equal(server.discoveryPath, discoveryPath);
    const raw = await readFile(discoveryPath, "utf-8");
    const discovery = JSON.parse(raw) as GuiDiscoveryFile;
    assert.equal(discovery.version, 1);
    assert.ok(discovery.ownerToken);
    assert.equal(discovery.port, server.port);
    assert.equal(discovery.token, server.token);
    assert.equal(discovery.sessionId, "sess-4");
    assert.equal(discovery.pid, process.pid);
    assert.ok(discovery.url.includes(`session=${server.token}`));
    assert.ok(discovery.eventsUrl.includes("/events"));
    assert.deepEqual(
      (await readdir(join(cwd, ".workflow"))).sort(),
      [GUI_DISCOVERY_FILENAME],
      "atomic publication must not leave temporary files",
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(join(cwd, ".workflow"))).mode & 0o777, 0o700);
      assert.equal((await stat(discoveryPath)).mode & 0o777, 0o600);
    }
  } finally {
    server.close("test-done");
  }
  // Discovery file is removed asynchronously on close.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(async () => access(discoveryPath));
});

test("gui-server: an old close cannot remove a replacement discovery owner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-server-owner-"));
  const first = await startGuiServer({ sessionId: "first", cwd });
  const second = await startGuiServer({ sessionId: "second", cwd });
  const discoveryPath = join(cwd, ".workflow", GUI_DISCOVERY_FILENAME);
  try {
    const replacement = JSON.parse(await readFile(discoveryPath, "utf8")) as GuiDiscoveryFile;
    assert.equal(replacement.ownerToken, JSON.parse(await readFile(second.discoveryPath!, "utf8")).ownerToken);
    assert.equal(replacement.sessionId, "second");

    first.close("stale-close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterStaleClose = JSON.parse(await readFile(discoveryPath, "utf8")) as GuiDiscoveryFile;
    assert.equal(afterStaleClose.ownerToken, replacement.ownerToken);
    assert.equal(afterStaleClose.sessionId, "second");
  } finally {
    first.close("done");
    second.close("done");
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(async () => access(discoveryPath));
});

test("gui-server: discovery publication rejects symlink and non-regular destinations", async (t) => {
  const symlinkCwd = await mkdtemp(join(tmpdir(), "gui-server-symlink-"));
  const symlinkDir = join(symlinkCwd, ".workflow");
  const symlinkPath = join(symlinkDir, GUI_DISCOVERY_FILENAME);
  const targetPath = join(symlinkCwd, "target.json");
  await mkdir(symlinkDir, { mode: 0o700 });
  await writeFile(targetPath, "sentinel", "utf8");
  try {
    await symlink(targetPath, symlinkPath, "file");
  } catch (error) {
    if (isPermissionError(error)) {
      t.skip("Creating symlinks is not permitted in this environment");
      return;
    }
    throw error;
  }

  const symlinkServer = await startGuiServer({ sessionId: "symlink", cwd: symlinkCwd });
  try {
    assert.equal(symlinkServer.discoveryPath, undefined);
    assert.equal(await readFile(targetPath, "utf8"), "sentinel");
    assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
  } finally {
    symlinkServer.close("done");
  }

  const nonRegularCwd = await mkdtemp(join(tmpdir(), "gui-server-directory-"));
  const nonRegularDir = join(nonRegularCwd, ".workflow");
  const nonRegularPath = join(nonRegularDir, GUI_DISCOVERY_FILENAME);
  await mkdir(nonRegularPath, { recursive: true });
  const nonRegularServer = await startGuiServer({ sessionId: "directory", cwd: nonRegularCwd });
  try {
    assert.equal(nonRegularServer.discoveryPath, undefined);
    assert.equal((await stat(nonRegularPath)).isDirectory(), true);
  } finally {
    nonRegularServer.close("done");
  }
});

test("gui extension startup keeps new discovery across reverse completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-server-reverse-"));
  const discoveryPath = join(cwd, ".workflow", GUI_DISCOVERY_FILENAME);
  let currentGeneration = 1;
  const oldCtx = {} as ExtensionContext;
  const newCtx = {} as ExtensionContext;
  let activeCtx: ExtensionContext | undefined = oldCtx;
  let bound: GuiServerHandle | null = null;
  let staleProviderReads = 0;
  let finishOld!: () => void;
  const oldFinishGate = new Promise<void>((resolve) => { finishOld = resolve; });

  const oldServer = await createGuiServer({ sessionId: "old", cwd });
  registerStateRoutes(
    oldServer,
    {
      goal: () => {
        staleProviderReads += 1;
        return { departed: true };
      },
    },
    { getCtx: () => guiContextForGeneration(oldCtx, 1, currentGeneration, activeCtx) },
  );
  const oldCompletion = (async (): Promise<boolean> => {
    await oldFinishGate;
    await oldServer.publishDiscovery(
      () => guiContextForGeneration(oldCtx, 1, currentGeneration, activeCtx) !== undefined,
    );
    return bindGuiStartupIfCurrent(oldServer, 1, currentGeneration, (server) => {
      bound = server;
    });
  })();

  currentGeneration = 2;
  activeCtx = newCtx;
  const newServer = await createGuiServer({ sessionId: "new", cwd });
  try {
    registerStateRoutes(
      newServer,
      { goal: () => ({ current: true }) },
      { getCtx: () => guiContextForGeneration(newCtx, 2, currentGeneration, activeCtx) },
    );
    assert.equal(
      await newServer.publishDiscovery(
        () => guiContextForGeneration(newCtx, 2, currentGeneration, activeCtx) !== undefined,
      ),
      true,
    );
    assert.equal(bindGuiStartupIfCurrent(newServer, 2, currentGeneration, (server) => { bound = server; }), true);
    assert.equal(bound, newServer, "the new generation must bind before the old one finishes");

    const publishedNew = JSON.parse(await readFile(discoveryPath, "utf8")) as GuiDiscoveryFile;
    assert.equal(publishedNew.sessionId, "new");

    const staleState = await requestJson(oldServer.port, "/state", { token: oldServer.token });
    assert.equal(staleState.status, 503);
    assert.equal(staleState.body.code, "no_context");
    assert.equal(staleProviderReads, 0, "a stale route must not call departed providers");

    finishOld();
    assert.equal(await oldCompletion, false);
    assert.equal(oldServer.discoveryPath, undefined, "stale startup must not publish discovery");
    assert.equal(bound, newServer, "stale completion must not replace the current binding");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterOldClose = JSON.parse(await readFile(discoveryPath, "utf8")) as GuiDiscoveryFile;
    assert.equal(afterOldClose.ownerToken, publishedNew.ownerToken);
    assert.equal(afterOldClose.sessionId, "new");
  } finally {
    finishOld();
    oldServer.close("done");
    newServer.close("done");
  }

  // Guard the extension integration invariant: fencing precedes awaits and one
  // generation-aware context closure owns publication plus route admission.
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const start = source.slice(source.indexOf('pi.on("session_start", async'));
  assert.ok(start.indexOf("++guiLifecycleGeneration") < start.indexOf("await disposeTeammateSessionRegistrations"));
  const shutdown = source.slice(source.indexOf('pi.on("session_shutdown", async'));
  assert.ok(shutdown.indexOf("guiLifecycleGeneration += 1") < shutdown.indexOf("await disposeTeammateSessionRegistrations"));
  assert.match(source, /const getGuiCtx = \(\) => guiContextForGeneration\(/);
  assert.match(source, /getCtx:\s*getGuiCtx,\s*isCurrent:\s*\(\) => getGuiCtx\(\) !== undefined/);
});

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}
