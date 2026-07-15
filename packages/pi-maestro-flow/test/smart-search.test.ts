import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  SmartSearchParams,
  buildSmartSearchArgs,
  createSmartSearchRunner,
  createSmartSearchTool,
  registerSmartSearch,
  type SmartSearchRunOptions,
  type SmartSearchRunner,
} from "../src/tools/smart-search.ts";

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
});

test("smart_search forwards AbortSignal and normalizes abort failures", async () => {
  const controller = new AbortController();
  const runner: SmartSearchRunner = {
    run(_args, options) {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  };
  const execution = createSmartSearchTool(runner).execute(
    "research", { mode: "research", query: "topic" }, controller.signal, undefined, { cwd: "D:/workspace" } as never,
  );
  controller.abort();
  await assert.rejects(() => execution, { name: "AbortError" });
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
    const mode = process.argv[2];
    if (mode === "large") process.stdout.write("x".repeat(4096));
    else if (mode === "wait") setTimeout(() => process.stdout.write("{}"), 30000);
    else process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));
  `);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const runner = createSmartSearchRunner(() => wrapperPath);
  const completed = await runner.run(["search", "query"], { cwd: directory, maxOutputBytes: 4_096 });
  assert.deepEqual(JSON.parse(completed.stdout), { argv: ["search", "query"] });
  await assert.rejects(() => runner.run(["large"], { cwd: directory, maxOutputBytes: 1_024 }), /exceeded 1024 bytes/);

  const controller = new AbortController();
  const pending = runner.run(["wait"], { cwd: directory, signal: controller.signal, maxOutputBytes: 4_096 });
  controller.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
});
