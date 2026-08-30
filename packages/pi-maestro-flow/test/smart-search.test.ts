import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildSearchProviderUnavailableMessage } from "../src/tools/web-access/gemini-search.ts";
import { applyProviderHeaders } from "../src/tools/web-access/openai-search.ts";
import {
  SmartSearchParams,
  buildSmartSearchArgs,
  createSmartSearchRunner,
  createSmartSearchTool,
  registerSmartSearch,
  type SmartSearchRunOptions,
  type SmartSearchRunner,
} from "../src/tools/smart-search.ts";

test("OpenAI direct requests apply Pi ProviderHeaders overrides after generated defaults", () => {
  assert.deepEqual(applyProviderHeaders({
    Authorization: "Bearer generated",
    "Content-Type": "application/json",
    "X-Delete": "generated",
  }, {
    authorization: null,
    "content-type": "application/custom",
    "x-custom": "custom",
    "x-delete": null,
  }), {
    "content-type": "application/custom",
    "x-custom": "custom",
  });
  assert.deepEqual(applyProviderHeaders({ Authorization: "Bearer generated" }, undefined), {
    Authorization: "Bearer generated",
  });
});

test("search provider unavailable message lists supported channels and free options", () => {
  const message = buildSearchProviderUnavailableMessage("D:/config/web-search.json");
  assert.match(message, /Available search channels \(free options included\)/);
  assert.match(message, /Free, no key: AnySearch/);
  assert.match(message, /Free account: Gemini Web/);
  assert.match(message, /Free tier: SERPdive krill/);
  assert.match(message, /Self-hosted: SearXNG/);
  assert.match(message, /OpenAI\/Codex, Brave, Parallel, Tavily, Perplexity, Exa, and Gemini API/);
  assert.match(message, /D:\/config\/web-search\.json/);
});

class FakeRunner implements SmartSearchRunner {
  calls: Array<{ args: readonly string[]; options: SmartSearchRunOptions }> = [];
  result = { stdout: JSON.stringify({ ok: true, content: "answer" }), stderr: "", exitCode: 0 };

  async run(args: readonly string[], options: SmartSearchRunOptions) {
    this.calls.push({ args, options });
    return this.result;
  }
}

test("smart_search schema exposes the four supported modes", () => {
  const mode = SmartSearchParams.properties.mode as unknown as { enum: string[] };
  assert.deepEqual(mode.enum, ["search", "research", "fetch", "route"]);
});

test("Smart Search registration exposes the tool and /smart-search config command", async () => {
  const tools: string[] = [];
  const commands = new Map<string, { handler(args: string, ctx: never): Promise<void> }>();
  const opened: string[] = [];
  registerSmartSearch({
    registerTool(tool) { tools.push(tool.name); },
    registerCommand(name, command) { commands.set(name, command as never); },
  } as never, {
    runner: new FakeRunner(),
    async showConfig(ctx) { opened.push((ctx as { cwd?: string }).cwd ?? ""); },
  });

  assert.deepEqual(tools, ["smart_search"]);
  assert.ok(commands.has("smart-search"));
  await commands.get("smart-search")!.handler("config", {
    cwd: "D:/workspace",
    ui: { notify() {} },
  } as never);
  assert.deepEqual(opened, ["D:/workspace"]);
});

test("smart_search builds mode-specific package CLI arguments", () => {
  assert.deepEqual(buildSmartSearchArgs({
    mode: "search", query: "latest TypeScript", platform: "Reuters", model: "model-id",
    extra_sources: 3, validation: "strict", fallback: "off", providers: "exa,tavily", timeout: 90,
  }), [
    "search", "latest TypeScript", "--format", "json", "--platform", "Reuters", "--model", "model-id",
    "--extra-sources", "3", "--validation", "strict", "--fallback", "off", "--providers", "exa,tavily", "--timeout", "90",
  ]);
  assert.deepEqual(buildSmartSearchArgs({
    mode: "research", query: "compare APIs", budget: "deep", evidence_dir: "D:/evidence", fallback: "auto",
  }), ["research", "compare APIs", "--format", "json", "--budget", "deep", "--evidence-dir", "D:/evidence", "--fallback", "auto"]);
  assert.deepEqual(buildSmartSearchArgs({ mode: "fetch", query: "https://example.com", timeout: 90 }), [
    "fetch", "https://example.com", "--format", "json",
  ]);
  assert.deepEqual(buildSmartSearchArgs({ mode: "route", query: "React API docs", validation: "balanced", router_mode: "rules" }), [
    "route", "React API docs", "--format", "json", "--validation", "balanced", "--router-mode", "rules",
  ]);
});

test("smart_search executes an injected runner and returns parsed JSON", async () => {
  const runner = new FakeRunner();
  const tool = createSmartSearchTool(runner);
  const result = await tool.execute("search", {
    mode: "search", query: "  evidence query  ", max_output_bytes: 4_096,
  }, undefined, undefined, { cwd: "D:/workspace" } as never);

  assert.deepEqual(result.details?.result, { ok: true, content: "answer" });
  assert.equal(result.content[0]?.type, "text");
  assert.deepEqual(runner.calls[0]?.args, ["search", "evidence query", "--format", "json"]);
  assert.equal(runner.calls[0]?.options.cwd, "D:/workspace");
  assert.equal(runner.calls[0]?.options.maxOutputBytes, 4_096);
  assert.equal(runner.calls[0]?.options.timeoutMs, 90_000);

  await tool.execute(
    "route",
    { mode: "route", query: "route query", timeout: 7 },
    undefined,
    undefined,
    { cwd: "D:/workspace" } as never,
  );
  assert.equal(runner.calls[1]?.options.timeoutMs, 7_000);
});

test("smart_search composes caller cancellation into the one dispatch signal", async () => {
  const controller = new AbortController();
  let dispatchSignal: AbortSignal | undefined;
  const runner: SmartSearchRunner = {
    run(_args, options) {
      dispatchSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    },
  };
  const execution = createSmartSearchTool(runner).execute(
    "research", { mode: "research", query: "topic" }, controller.signal, undefined, { cwd: "D:/workspace" } as never,
  );
  assert.notEqual(dispatchSignal, controller.signal);
  controller.abort();
  await assert.rejects(() => execution, { name: "AbortError" });
  assert.equal(dispatchSignal?.aborted, true);
});

test("smart_search reuses its caller/deadline signal for CLI config fallback", async () => {
  let cliSignal: AbortSignal | undefined;
  let nativeSignal: AbortSignal | undefined;
  const runner: SmartSearchRunner = {
    async run(_args, options) {
      cliSignal = options.signal;
      return { stdout: "", stderr: JSON.stringify({ error_type: "config_error" }), exitCode: 2 };
    },
  };
  const tool = createSmartSearchTool(runner, {
    nativeSearch: (async (options: { signal?: AbortSignal }) => {
      nativeSignal = options.signal;
      return { results: [] } as never;
    }) as never,
  });

  const result = await tool.execute(
    "fallback", { mode: "search", query: "topic" }, undefined, undefined, { cwd: "D:/workspace" } as never,
  );
  assert.ok(cliSignal);
  assert.equal(nativeSignal, cliSignal);
  assert.deepEqual(result.details?.result, { results: [] });
});

test("smart_search host deadline covers an injected native dispatch", async () => {
  let nativeSignal: AbortSignal | undefined;
  const tool = createSmartSearchTool(new FakeRunner(), {
    nativeSearch: (async (options: { signal?: AbortSignal }) => {
      nativeSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    }) as never,
  });

  await assert.rejects(
    () => tool.execute(
      "deadline", { mode: "search", query: "topic", native: true, timeout: 1 },
      undefined, undefined, { cwd: "D:/workspace" } as never,
    ),
    (error: unknown) => error instanceof Error
      && error.name === "TimeoutError"
      && /timed out after 1000ms/.test(error.message),
  );
  assert.equal(nativeSignal?.aborted, true);
});

test("smart_search rejects non-zero exits and invalid JSON", async () => {
  const runner = new FakeRunner();
  const tool = createSmartSearchTool(runner);
  const ctx = { cwd: "D:/workspace" } as never;
  runner.result = { stdout: "", stderr: "missing config", exitCode: 3 };
  await assert.rejects(() => tool.execute("route", { mode: "route", query: "query" }, undefined, undefined, ctx), /exit code 3: missing config/);
  runner.result = { stdout: "not-json", stderr: "", exitCode: 0 };
  await assert.rejects(() => tool.execute("route", { mode: "route", query: "query" }, undefined, undefined, ctx), /invalid JSON/);
});

test("SmartSearch node runner uses an injected wrapper, caps output, and aborts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-smart-search-"));
  const wrapperPath = path.join(directory, "wrapper.cjs");
  await fs.writeFile(wrapperPath, `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const mode = process.argv[2];
    if (mode === "large") process.stdout.write("x".repeat(4096));
    else if (mode === "wait") setTimeout(() => process.stdout.write("{}"), 30000);
    else if (mode === "tree" || mode === "exit-tree") {
      const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      fs.writeFileSync(process.argv[3], String(descendant.pid));
      if (mode === "tree") setInterval(() => {}, 1000);
      else {
        descendant.unref();
        process.stdout.write("{}");
      }
    } else process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));
  `);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const runner = createSmartSearchRunner(() => wrapperPath);
  const completed = await runner.run(["search", "query"], { cwd: directory, maxOutputBytes: 4_096 });
  assert.deepEqual(JSON.parse(completed.stdout), { argv: ["search", "query"] });
  await assert.rejects(() => runner.run(["large"], { cwd: directory, maxOutputBytes: 1_024 }), /exceeded 1024 bytes/);

  await assert.rejects(
    () => runner.run(["wait"], { cwd: directory, maxOutputBytes: 4_096, timeoutMs: 30 }),
    /timed out after 30ms/,
  );

  const normalPidFile = path.join(directory, "normal-descendant.pid");
  let normalDescendantPid: number | undefined;
  try {
    const normal = await runner.run(["exit-tree", normalPidFile], {
      cwd: directory,
      maxOutputBytes: 4_096,
      timeoutMs: 5_000,
    });
    normalDescendantPid = Number(await waitForFile(normalPidFile));
    assert.equal(normal.exitCode, 0, normal.stderr);
    assert.equal(isProcessRunning(normalDescendantPid), false, "normal success must reclaim a parent-first-exit descendant");
  } finally {
    if (normalDescendantPid && isProcessRunning(normalDescendantPid)) {
      try { process.kill(normalDescendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }

  const controller = new AbortController();
  const pending = runner.run(["wait"], { cwd: directory, signal: controller.signal, maxOutputBytes: 4_096 });
  controller.abort();
  await assert.rejects(() => pending, { name: "AbortError" });

  const pidFile = path.join(directory, "descendant.pid");
  let descendantPid: number | undefined;
  try {
    const treeController = new AbortController();
    const tree = runner.run(["tree", pidFile], {
      cwd: directory,
      signal: treeController.signal,
      maxOutputBytes: 4_096,
      timeoutMs: 5_000,
    });
    descendantPid = Number(await waitForFile(pidFile));
    assert.equal(isProcessRunning(descendantPid), true);
    treeController.abort();
    await assert.rejects(() => tree, { name: "AbortError" });
    assert.equal(await waitForProcessExit(descendantPid, 2_000), true, "descendant must be gone before abort settles");
  } finally {
    if (descendantPid && isProcessRunning(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
