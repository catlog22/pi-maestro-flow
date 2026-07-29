import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelCircuitBreaker } from "pi-maestro-teammate/v1/retry";
import {
  getGlobalModelFailoverPath,
  getProjectModelFailoverPath,
  loadModelFailoverConfig,
  registerModelFailover,
} from "../src/providers/model-failover.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function harness(cwd: string, breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 })) {
  const handlers = new Map<string, Handler[]>();
  const commands: string[] = [];
  const selected: string[] = [];
  const notifications: string[] = [];
  const models = [
    { provider: "provider", id: "primary" },
    { provider: "provider", id: "backup" },
    { provider: "provider", id: "last" },
  ];
  const ctx = {
    cwd,
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
    },
    ui: {
      notify(message: string) { notifications.push(message); },
    },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand(name: string) { commands.push(name); },
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async setModel(model: { provider: string; id: string }) {
      selected.push(`${model.provider}/${model.id}`);
      (ctx as unknown as { model: typeof model }).model = model;
      return true;
    },
  } as unknown as ExtensionAPI;

  registerModelFailover(pi, { breaker, homeDir: path.join(cwd, "home") });
  const emit = async (event: string, payload: any = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  };
  return { breaker, commands, ctx, emit, notifications, selected };
}

function writeProjectConfig(cwd: string, value: unknown): void {
  fs.mkdirSync(path.dirname(getProjectModelFailoverPath(cwd)), { recursive: true });
  fs.writeFileSync(getProjectModelFailoverPath(cwd), JSON.stringify(value));
}

test("model failover registers both settings and health commands", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    const runtime = harness(cwd);
    assert.deepEqual(runtime.commands, ["model-failover", "model-health"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("model failover config merges global and project chains without accepting malformed models", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  const home = path.join(cwd, "home");
  try {
    fs.mkdirSync(path.dirname(getGlobalModelFailoverPath(home)), { recursive: true });
    fs.writeFileSync(getGlobalModelFailoverPath(home), JSON.stringify({
      enabled: true,
      fallbackModels: {
        "provider/primary": ["provider/global", "provider/global", "invalid"],
        "provider/cleared": ["provider/global"],
        invalid: ["provider/nope"],
      },
    }));
    writeProjectConfig(cwd, {
      fallbackModels: {
        "provider/primary": ["provider/project"],
        "provider/cleared": [],
        "provider/other": ["provider/backup"],
      },
    });

    assert.deepEqual(loadModelFailoverConfig(cwd, home), {
      enabled: true,
      fallbackModels: {
        "provider/primary": ["provider/project"],
        "provider/cleared": [],
        "provider/other": ["provider/backup"],
      },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("retryable agent failure switches model before Pi performs its own continuation", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    writeProjectConfig(cwd, {
      enabled: true,
      fallbackModels: {
        "provider/primary": ["provider/backup", "provider/last"],
      },
    });
    const runtime = harness(cwd);
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });
    await runtime.emit("turn_start", { turnIndex: 0 });
    await runtime.emit("after_provider_response", { status: 503, headers: {} });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider overloaded: 503" }],
    });

    assert.deepEqual(runtime.selected, ["provider/backup"]);
    assert.match(runtime.notifications[0] ?? "", /retrying with provider\/backup/);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");

    await runtime.emit("turn_start", { turnIndex: 1 });
    await runtime.emit("message_end", {
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    });
    await runtime.emit("agent_settled");
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "CLOSED");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an already open primary circuit selects a configured fallback before the turn starts", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    writeProjectConfig(cwd, {
      enabled: true,
      fallbackModels: { "provider/primary": ["provider/backup"] },
    });
    const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    const primary = breaker.acquireCandidate("provider/primary");
    assert.equal(primary.allowed, true);
    if (primary.allowed) breaker.recordRetryableFailure(primary);
    const runtime = harness(cwd, breaker);

    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });

    assert.deepEqual(runtime.selected, ["provider/backup"]);
    assert.match(runtime.notifications[0] ?? "", /circuit open/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("non-retryable authentication failures do not switch or poison model health", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    writeProjectConfig(cwd, {
      enabled: true,
      fallbackModels: { "provider/primary": ["provider/backup"] },
    });
    const runtime = harness(cwd);
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });
    await runtime.emit("turn_start", { turnIndex: 0 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Unauthorized: invalid API key" }],
    });
    await runtime.emit("agent_settled");

    assert.deepEqual(runtime.selected, []);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "CLOSED");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
