import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeammateBrowserBroker } from "../src/teammate/browser-broker.ts";
import { browserManager } from "../src/tools/browser/manager.ts";
import type {
  BrowserManagerLike,
  BrowserOpenOptions,
  BrowserRunOutput,
  BrowserTabInfo,
} from "../src/tools/browser/manager.ts";

class FakeBrowserManager implements BrowserManagerLike {
  readonly opened = new Map<string, BrowserOpenOptions>();
  readonly closed: string[] = [];
  closeBarrier?: Promise<void>;

  async open(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    this.opened.set(options.name, options);
    return {
      name: options.name,
      kind: "headless",
      url: options.url ?? "about:blank",
      title: "test",
      reused: false,
    };
  }

  async run(name: string): Promise<BrowserRunOutput> {
    if (!this.opened.has(name)) throw new Error(`No tab named ${name}`);
    return { displays: [], returnValue: undefined, screenshots: [], url: "about:blank" };
  }

  async close(name: string): Promise<boolean> {
    await this.closeBarrier;
    const existed = this.opened.delete(name);
    if (existed) this.closed.push(name);
    return existed;
  }

  async closeAll(): Promise<number> {
    const names = [...this.opened.keys()];
    for (const name of names) await this.close(name);
    return names.length;
  }
}

const ctx = { cwd: "D:/workspace" } as ExtensionContext;

function request(actorId: string, input: Record<string, unknown>, signal?: AbortSignal) {
  return {
    toolName: "browser",
    input,
    actor: { correlationId: actorId, agent: "general" },
    ...(signal ? { signal } : {}),
  };
}

test("teammate browser broker runs in root manager with actor-scoped tab names", async () => {
  const manager = new FakeBrowserManager();
  const broker = new TeammateBrowserBroker(manager);
  const controller = new AbortController();

  await broker.execute(request("actor-a", { action: "open", name: "main", url: "https://a.test" }, controller.signal), ctx);
  await broker.execute(request("actor-b", { action: "open", name: "main", url: "https://b.test" }), ctx);

  assert.deepEqual([...manager.opened.keys()], [
    "teammate:actor-a:main",
    "teammate:actor-b:main",
  ]);
  assert.equal(manager.opened.get("teammate:actor-a:main")?.signal, controller.signal);

  await broker.execute(request("actor-a", { action: "close", all: true }), ctx);
  assert.deepEqual(manager.closed, ["teammate:actor-a:main"]);
  assert.equal(manager.opened.has("teammate:actor-b:main"), true);

  assert.equal(await broker.closeActor("actor-b"), 1);
  assert.equal(manager.opened.size, 0);
});

test("teammate browser broker rejects requests without a trusted actor", async () => {
  const broker = new TeammateBrowserBroker(new FakeBrowserManager());
  const result = await broker.execute(request("unknown", { action: "open" }), ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /trusted correlation id/i);
});

test("default teammate browser manager is isolated from the root browser manager", async () => {
  const broker = new TeammateBrowserBroker();
  assert.notEqual(broker.manager, browserManager);
  await broker.closeAll();
});

test("actor cleanup waits for physical browser disposal", async () => {
  const manager = new FakeBrowserManager();
  const broker = new TeammateBrowserBroker(manager);
  await broker.execute(request("actor-a", { action: "open", name: "main" }), ctx);

  let release!: () => void;
  manager.closeBarrier = new Promise<void>((resolve) => { release = resolve; });
  let settled = false;
  const cleanup = broker.closeActor("actor-a").then((count) => {
    settled = true;
    return count;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  assert.equal(await cleanup, 1);
  assert.equal(settled, true);
});
