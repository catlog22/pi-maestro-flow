import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelCircuitBreaker } from "pi-maestro-teammate/v1/retry";
import {
  consumeModelFailoverSettlement,
  getGlobalModelFailoverPath,
  getProjectModelFailoverPath,
  loadModelFailoverConfig,
  registerModelFailover,
  snapshotModelFailoverSettlement,
} from "../src/providers/model-failover.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

class TrackingModelCircuitBreaker extends ModelCircuitBreaker {
  readonly acquiredModels: string[] = [];

  override acquireCandidate(model: string) {
    this.acquiredModels.push(model);
    return super.acquireCandidate(model);
  }
}

function harness(
  cwd: string,
  breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 }),
  options: {
    multimodal?: string[];
    visionAnalyzer?: any;
    hasPendingMessages?: boolean;
    signal?: AbortSignal;
    sendMessageError?: Error;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const commands: string[] = [];
  const selected: string[] = [];
  const notifications: string[] = [];
  const sentMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  const handoffs: Array<{
    message: { customType: string; content: string; display: boolean; details?: unknown };
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }> = [];
  const multimodal = new Set(options.multimodal ?? []);
  const models = [
    { provider: "provider", id: "primary", input: multimodal.has("provider/primary") ? ["text", "image"] : ["text"] },
    { provider: "provider", id: "backup", input: multimodal.has("provider/backup") ? ["text", "image"] : ["text"] },
    { provider: "provider", id: "last", input: multimodal.has("provider/last") ? ["text", "image"] : ["text"] },
  ];
  const ctx = {
    cwd,
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
    },
    hasPendingMessages: () => options.hasPendingMessages ?? false,
    signal: options.signal,
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
    sendUserMessage(content: string, messageOptions?: { deliverAs?: string }) {
      sentMessages.push({ content, options: messageOptions });
    },
    sendMessage(
      message: { customType: string; content: string; display: boolean; details?: unknown },
      messageOptions?: { triggerTurn?: boolean; deliverAs?: string },
    ) {
      if (options.sendMessageError) throw options.sendMessageError;
      handoffs.push({ message, options: messageOptions });
    },
  } as unknown as ExtensionAPI;

  registerModelFailover(pi, {
    breaker,
    homeDir: path.join(cwd, "home"),
    visionAgentDir: path.join(cwd, "home", ".pi", "agent"),
    ...(options.visionAnalyzer ? { visionAnalyzer: options.visionAnalyzer } : {}),
  });
  const emit = async (event: string, payload: any = {}) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
    return result;
  };
  const flushScheduledHandoff = async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  return { breaker, commands, ctx, emit, flushScheduledHandoff, handoffs, notifications, selected, sentMessages };
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

test("attached images prefer a healthy multimodal fallback", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-vision-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup", "provider/last"] } });
    let delegated = 0;
    const runtime = harness(cwd, undefined, {
      multimodal: ["provider/last"],
      visionAnalyzer: async () => { delegated += 1; return { text: "unused", model: "helper/vision", cached: false }; },
    });
    await runtime.emit("session_start");
    const result = await runtime.emit("before_agent_start", {
      prompt: "inspect",
      images: [{ type: "image", data: Buffer.from("image").toString("base64"), mimeType: "image/png" }],
    });
    assert.equal(result, undefined);
    assert.deepEqual(runtime.selected, ["provider/last"]);
    assert.equal(delegated, 0);
    assert.match(runtime.notifications[0] ?? "", /multimodal provider\/last/);
    await runtime.emit("session_shutdown");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("blocked multimodal attached-image candidates delegate without touching healthy text fallbacks", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-vision-blocked-"));
  try {
    writeProjectConfig(cwd, {
      enabled: false,
      fallbackModels: { "provider/primary": ["provider/backup", "provider/last"] },
    });
    const breaker = new TrackingModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    const blocked = breaker.acquireCandidate("provider/last");
    assert.equal(blocked.allowed, true);
    if (blocked.allowed) breaker.recordRetryableFailure(blocked);
    breaker.acquiredModels.length = 0;

    let delegated = 0;
    const runtime = harness(cwd, breaker, {
      multimodal: ["provider/last"],
      visionAnalyzer: async () => {
        delegated += 1;
        return { text: "Delegated image context.", model: "helper/vision", cached: false };
      },
    });
    await runtime.emit("session_start");
    const result = await runtime.emit("before_agent_start", {
      prompt: "inspect",
      images: [{ type: "image", data: Buffer.from("image").toString("base64"), mimeType: "image/png" }],
    }) as { message?: { content?: string } };

    assert.equal(delegated, 1);
    assert.match(result.message?.content ?? "", /Delegated image context/);
    assert.deepEqual(breaker.acquiredModels, ["provider/last"]);
    assert.deepEqual(runtime.selected, []);
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/primary"), undefined);
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/backup"), undefined);
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/last")?.halfOpenTrialInProgress, false);
    await runtime.emit("session_shutdown");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("attached images inject delegated analysis when the configured chain is text-only", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-helper-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup"] } });
    let delegated = 0;
    const runtime = harness(cwd, undefined, {
      visionAnalyzer: async () => { delegated += 1; return { text: "A disabled checkbox is visible.", model: "helper/vision", cached: false }; },
    });
    await runtime.emit("session_start");
    const result = await runtime.emit("before_agent_start", {
      prompt: "inspect",
      images: [{ type: "image", data: Buffer.from("image").toString("base64"), mimeType: "image/png" }],
    }) as { message?: { customType?: string; content?: string; display?: boolean } };
    assert.equal(delegated, 1);
    assert.equal(result.message?.customType, "maestro-vision-analysis");
    assert.equal(result.message?.display, false);
    assert.match(result.message?.content ?? "", /disabled checkbox/);
    assert.deepEqual(runtime.selected, []);
    await runtime.emit("session_shutdown");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agent_end is observational and retry exhaustion falls back only after settlement", async () => {
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

    assert.deepEqual(runtime.selected, []);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(runtime.sentMessages.length, 0);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "CLOSED");

    await runtime.emit("agent_settled");
    assert.deepEqual(runtime.selected, ["provider/backup"]);
    assert.equal(runtime.sentMessages.length, 0);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");

    const arbitration = snapshotModelFailoverSettlement();
    assert.equal(arbitration?.outcome, "fallback-scheduled");
    assert.equal(arbitration?.fallbackModel, "provider/backup");

    // A duplicate old-run settlement cannot enqueue another fallback handoff
    // while the post-settlement macrotask owns the pending recovery.
    await runtime.emit("agent_settled");
    assert.equal(runtime.handoffs.length, 0);

    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 1);
    assert.deepEqual(runtime.handoffs[0]?.options, { triggerTurn: true });
    assert.match(runtime.handoffs[0]?.message.content ?? "", /Retry the original user request/);
    assert.equal(consumeModelFailoverSettlement("stale-id"), undefined);
    assert.equal(consumeModelFailoverSettlement(arbitration?.recoveryId)?.outcome, "fallback-scheduled");
    assert.equal(snapshotModelFailoverSettlement(), undefined);

    // Hidden custom triggerTurn does not emit before_agent_start; the handoff
    // macrotask already transferred the fallback acquisition to this run.
    await runtime.emit("turn_start", { turnIndex: 1 });
    await runtime.emit("message_end", {
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    });
    await runtime.emit("agent_settled");
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "CLOSED");
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "success");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fallback-only quota exhaustion advances the chain at settlement", async () => {
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
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "402: Insufficient Balance" }],
    });

    assert.deepEqual(runtime.selected, []);
    assert.equal(runtime.handoffs.length, 0);
    await runtime.emit("agent_settled");
    assert.deepEqual(runtime.selected, ["provider/backup"]);
    assert.equal(runtime.sentMessages.length, 0);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "fallback-scheduled");
    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("no fallback chain configured: implicit candidates advance one settled run at a time", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: {} });
    const runtime = harness(cwd);
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });
    await runtime.emit("turn_start", { turnIndex: 0 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider returned error: 500" }],
    });

    assert.deepEqual(runtime.selected, []);
    await runtime.emit("agent_settled");
    assert.deepEqual(runtime.selected, ["provider/backup"]);
    assert.equal(runtime.handoffs.length, 0);
    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 1);

    // Hidden custom triggerTurn starts the selected fallback without a
    // before_agent_start event.
    await runtime.emit("turn_start", { turnIndex: 1 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider returned error: 500" }],
    });
    assert.deepEqual(runtime.selected, ["provider/backup"]);
    await runtime.emit("agent_settled");
    assert.deepEqual(runtime.selected, ["provider/backup", "provider/last"]);
    assert.equal(runtime.handoffs.length, 1);
    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a bare terminated transport error schedules fallback only after settlement", async () => {
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
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Error: terminated" }],
    });

    assert.deepEqual(runtime.selected, []);
    await runtime.emit("agent_settled");
    assert.deepEqual(runtime.selected, ["provider/backup"]);
    assert.equal(runtime.sentMessages.length, 0);
    assert.equal(runtime.handoffs.length, 0);
    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("scheduled fallback handoff is inert after shutdown or supersession", async () => {
  for (const invalidate of ["shutdown", "supersede"] as const) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-model-failover-${invalidate}-`));
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
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }],
      });
      await runtime.emit("agent_settled");
      assert.equal(runtime.handoffs.length, 0);

      if (invalidate === "shutdown") await runtime.emit("session_shutdown");
      else await runtime.emit("before_agent_start", { prompt: "new user request" });
      await runtime.flushScheduledHandoff();

      assert.equal(runtime.handoffs.length, 0);
      if (invalidate === "supersede") await runtime.emit("session_shutdown");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("synchronous scheduled handoff failure releases fallback and publishes failed arbitration", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-send-failure-"));
  try {
    writeProjectConfig(cwd, {
      enabled: true,
      fallbackModels: { "provider/primary": ["provider/backup"] },
    });
    const runtime = harness(cwd, undefined, { sendMessageError: new Error("send failed") });
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });
    await runtime.emit("turn_start", { turnIndex: 0 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }],
    });
    await runtime.emit("agent_settled");

    assert.equal(runtime.handoffs.length, 0);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "fallback-scheduled");
    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "failed");
    assert.match(snapshotModelFailoverSettlement()?.failure ?? "", /send failed/);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "CLOSED");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a successful native retry supersedes an earlier agent_end failure", async () => {
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
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }],
    });
    await runtime.emit("after_provider_response", { status: 200, headers: {} });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    });
    await runtime.emit("agent_settled");

    assert.deepEqual(runtime.selected, []);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(runtime.sentMessages.length, 0);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "CLOSED");
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "success");
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
    assert.equal(runtime.sentMessages.length, 0);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "CLOSED");
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "failed");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_shutdown releases the active acquisition so the circuit does not leak", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: {} });
    const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    const runtime = harness(cwd, breaker);
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });
    await runtime.emit("turn_start", { turnIndex: 0 });

    // Shut down without agent_settled — the acquisition must still be released.
    await runtime.emit("session_shutdown");

    // The primary circuit should remain CLOSED (released, not recorded as failure).
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "CLOSED");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("open circuit with no healthy fallback emits a warning notification", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    writeProjectConfig(cwd, {
      enabled: true,
      fallbackModels: { "provider/primary": ["provider/backup"] },
    });
    const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    // Open both primary and backup circuits.
    const p = breaker.acquireCandidate("provider/primary");
    if (p.allowed) breaker.recordRetryableFailure(p);
    const b = breaker.acquireCandidate("provider/backup");
    if (b.allowed) breaker.recordRetryableFailure(b);
    const runtime = harness(cwd, breaker);

    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });

    // No model could be selected — a warning must be emitted.
    assert.equal(runtime.selected.length, 0);
    assert.ok(
      runtime.notifications.some((n) => /no healthy fallback/i.test(n) && /continuing with the current model/i.test(n)),
      `Expected a no-fallback warning, got: ${JSON.stringify(runtime.notifications)}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("completed tool effects block a fresh fallback replay after settlement", async () => {
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
    await runtime.emit("tool_execution_start", { toolCallId: "tool-1", toolName: "write", args: {} });
    await runtime.emit("tool_execution_end", { toolCallId: "tool-1", toolName: "write", result: {}, isError: false });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider overloaded: 503" }],
    });

    assert.deepEqual(runtime.selected, []);
    await runtime.emit("agent_settled");
    assert.deepEqual(runtime.selected, []);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");
    assert.deepEqual(snapshotModelFailoverSettlement()?.replayFence.completedTools, ["write"]);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "replay-blocked");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("unknown tool effects block fallback replay", async () => {
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
    await runtime.emit("tool_execution_start", { toolCallId: "tool-unknown", toolName: "bash", args: {} });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }],
    });
    await runtime.emit("agent_settled");

    assert.deepEqual(runtime.selected, []);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "replay-blocked");
    assert.match(snapshotModelFailoverSettlement()?.replayFence.blockedReason ?? "", /could not be confirmed/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancellation wins settlement arbitration without charging or falling back", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    writeProjectConfig(cwd, {
      enabled: true,
      fallbackModels: { "provider/primary": ["provider/backup"] },
    });
    const controller = new AbortController();
    const runtime = harness(cwd, undefined, { signal: controller.signal });
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });
    await runtime.emit("turn_start", { turnIndex: 0 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }],
    });
    controller.abort();
    await runtime.emit("agent_settled");

    assert.deepEqual(runtime.selected, []);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "CLOSED");
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "cancelled");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("image-triggered multimodal switch restores the original model on settle", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-restore-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup", "provider/last"] } });
    const runtime = harness(cwd, undefined, {
      multimodal: ["provider/last"],
      visionAnalyzer: async () => ({ text: "unused", model: "helper/vision", cached: false }),
    });
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", {
      prompt: "inspect",
      images: [{ type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), mimeType: "image/png" }],
    });
    assert.deepEqual(runtime.selected, ["provider/last"]);
    await runtime.emit("turn_start", { turnIndex: 0 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    });
    await runtime.emit("agent_settled");
    // The multimodal switch must be undone after the turn settles.
    assert.deepEqual(runtime.selected, ["provider/last", "provider/primary"]);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("attached images with vision delegation disabled do not auto-analyze", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-vision-off-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup"] } });
    const visionDir = path.join(cwd, "home", ".pi", "agent");
    fs.mkdirSync(visionDir, { recursive: true });
    fs.writeFileSync(path.join(visionDir, "vision-delegation.json"), JSON.stringify({ enabled: false }));
    let delegated = 0;
    const runtime = harness(cwd, undefined, {
      visionAnalyzer: async () => { delegated += 1; return { text: "unused", model: "helper/vision", cached: false }; },
    });
    await runtime.emit("session_start");
    const result = await runtime.emit("before_agent_start", {
      prompt: "inspect",
      images: [{ type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), mimeType: "image/png" }],
    });
    assert.equal(delegated, 0);
    assert.equal(result, undefined);
    await runtime.emit("session_shutdown");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
