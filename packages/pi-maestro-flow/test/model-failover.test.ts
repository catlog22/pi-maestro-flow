import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { classifyRetryError, ModelCircuitBreaker } from "pi-maestro-teammate/v1/retry";
import {
  consumeModelFailoverSettlement,
  FAILOVER_TERMINAL_EVENT,
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
    /** When set, pi.setModel emits a model_select event synchronously, mirroring pi-core. */
    emitModelSelectOnSet?: boolean;
    /** Overrides the source of the synthesized model_select event (defaults to "set"). */
    modelSelectSource?: "set" | "cycle" | "restore";
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
  const eventSubscribers = new Map<string, Array<(data: unknown) => void>>();
  const emittedEvents: Array<{ channel: string; data: unknown }> = [];
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
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const list = eventSubscribers.get(channel) ?? [];
        list.push(handler);
        eventSubscribers.set(channel, list);
        return () => {
          eventSubscribers.set(channel, (eventSubscribers.get(channel) ?? []).filter((candidate) => candidate !== handler));
        };
      },
      emit(channel: string, data: unknown) {
        emittedEvents.push({ channel, data });
        for (const handler of eventSubscribers.get(channel) ?? []) handler(data);
      },
    },
    async setModel(model: { provider: string; id: string }) {
      selected.push(`${model.provider}/${model.id}`);
      const previous = (ctx as unknown as { model: { provider: string; id: string } }).model;
      (ctx as unknown as { model: typeof model }).model = model;
      if (options.emitModelSelectOnSet) {
        // Emulate pi-core's _emitModelSelect firing inside setModel: the
        // model_select handler runs while the extension's guardedSetModel
        // wrapper is still on the stack, so the manual-reset guard is active.
        const event = { type: "model_select", model, previousModel: previous, source: options.modelSelectSource ?? "set" };
        for (const handler of handlers.get("model_select") ?? []) await handler(event, ctx);
      }
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
  return { breaker, commands, ctx, emit, emittedEvents, flushScheduledHandoff, handoffs, notifications, selected, sentMessages };
}

function writeProjectConfig(cwd: string, value: unknown): void {
  fs.mkdirSync(path.dirname(getProjectModelFailoverPath(cwd)), { recursive: true });
  fs.writeFileSync(getProjectModelFailoverPath(cwd), JSON.stringify(value));
}

test("model failover registers the settings command with a status subcommand", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    const runtime = harness(cwd);
    assert.deepEqual(runtime.commands, ["model-failover"]);
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
    }) as { message?: { content?: string; details?: { routes?: Array<{ route?: string; model?: string }> } } };
    assert.match(result.message?.content ?? "", /\[image:native\]/);
    assert.deepEqual(result.message?.details?.routes, [{ imageIndex: 1, route: "native", model: "provider/last" }]);
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
    }) as {
      message?: {
        customType?: string;
        content?: string;
        display?: boolean;
        details?: { kind?: string; routes?: Array<{ imageIndex?: number; route?: string; model?: string }> };
      };
    };
    assert.equal(delegated, 1);
    assert.equal(result.message?.customType, "maestro-vision-analysis");
    assert.equal(result.message?.display, false);
    assert.match(result.message?.content ?? "", /\[image:vision\]/);
    assert.match(result.message?.content ?? "", /disabled checkbox/);
    assert.equal(result.message?.details?.kind, "maestro-image-routing");
    assert.deepEqual(result.message?.details?.routes, [{ imageIndex: 1, route: "vision", model: "helper/vision" }]);
    assert.deepEqual(runtime.selected, []);
    await runtime.emit("session_shutdown");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("attached image delegation records partial failures and the per-turn limit as unread", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-image-routes-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup"] } });
    let delegated = 0;
    const runtime = harness(cwd, undefined, {
      visionAnalyzer: async () => {
        delegated += 1;
        if (delegated === 2) throw new Error("provider unavailable");
        return { text: `analysis ${delegated}`, model: "helper/vision", cached: false };
      },
    });
    const images = Array.from({ length: 6 }, (_value, index) => ({
      type: "image",
      data: Buffer.from(`image-${index}`).toString("base64"),
      mimeType: "image/png",
    }));

    const result = await runtime.emit("before_agent_start", { prompt: "inspect", images }) as {
      message?: { content?: string; details?: { routes?: Array<{ route?: string; reason?: string }> } };
    };

    assert.equal(delegated, 5);
    assert.deepEqual(result.message?.details?.routes?.map((route) => route.route), [
      "vision", "unread", "vision", "vision", "vision", "unread",
    ]);
    assert.equal(result.message?.details?.routes?.[1]?.reason, "analysis_failed");
    assert.equal(result.message?.details?.routes?.[5]?.reason, "analysis_limit");
    assert.match(result.message?.content ?? "", /Attached image 2 \[image:unread\]/);
    assert.match(result.message?.content ?? "", /Attached image 6 \[image:unread\]/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("implicit multimodal failover upgrades Vision provenance to vision+native", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-hybrid-image-route-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: {} });
    const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    const primary = breaker.acquireCandidate("provider/primary");
    assert.equal(primary.allowed, true);
    if (primary.allowed) breaker.recordRetryableFailure(primary);
    let delegated = 0;
    const runtime = harness(cwd, breaker, {
      multimodal: ["provider/last"],
      visionAnalyzer: async () => {
        delegated += 1;
        if (delegated === 2) throw new Error("vision unavailable");
        return { text: "delegated context", model: "helper/vision", cached: false };
      },
    });
    const images = [0, 1].map((index) => ({
      type: "image",
      data: Buffer.from(`image-${index}`).toString("base64"),
      mimeType: "image/png",
    }));

    const result = await runtime.emit("before_agent_start", { prompt: "inspect", images }) as {
      message?: {
        content?: string;
        details?: { routes?: Array<{ route?: string; model?: string; nativeModel?: string }> };
      };
    };

    assert.deepEqual(runtime.selected, ["provider/last"]);
    assert.deepEqual(result.message?.details?.routes, [
      { imageIndex: 1, route: "vision+native", model: "helper/vision", nativeModel: "provider/last" },
      { imageIndex: 2, route: "native", model: "provider/last" },
    ]);
    assert.match(result.message?.content ?? "", /\[image:vision\+native\]/);
    assert.match(result.message?.content ?? "", /Attached image 2 \[image:native\]/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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

test("message_end rewrites stream_read_error so native same-model retries run before fallback", async () => {
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

    // Pi's native retry classifier does not match the machine-readable
    // stream_read_error code; without a marker a single transient stream drop
    // skips same-model retries and settles straight into this failover, which
    // then switches models on the first occurrence.
    const failure = "stream_read_error: upstream response body closed";
    const rewritten = await runtime.emit("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: failure, content: [] },
    }) as { message?: { errorMessage?: string } } | undefined;
    assert.equal(rewritten?.message?.errorMessage, `${failure} (network error)`);
    assert.equal(classifyRetryError(rewritten?.message?.errorMessage), "network");
    assert.equal(isRetryableAssistantError({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "provider",
      model: "primary",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: rewritten?.message?.errorMessage,
      timestamp: 0,
    }), true);

    // Idempotent: an already-marked message passes through untouched, as do
    // successful assistant messages.
    assert.equal(await runtime.emit("message_end", { message: rewritten?.message }), undefined);
    assert.equal(await runtime.emit("message_end", {
      message: { role: "assistant", stopReason: "stop", content: [] },
    }), undefined);
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

test("completed tool effects still allow a fresh fallback replay after settlement", async () => {
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
    assert.deepEqual(runtime.selected, ["provider/backup"]);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");
    assert.deepEqual(snapshotModelFailoverSettlement()?.replayFence.completedTools, ["write"]);
    assert.equal(snapshotModelFailoverSettlement()?.replayFence.blocked, true);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "fallback-scheduled");

    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("unknown tool effects still allow a fresh fallback replay", async () => {
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

    assert.deepEqual(runtime.selected, ["provider/backup"]);
    assert.equal(runtime.handoffs.length, 0);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "fallback-scheduled");
    assert.equal(snapshotModelFailoverSettlement()?.replayFence.blocked, true);
    assert.match(snapshotModelFailoverSettlement()?.replayFence.blockedReason ?? "", /could not be confirmed/);

    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 1);
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

test("abort diagnostic on error-stopped assistant message does not switch models (bash ESC regression)", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-"));
  try {
    writeProjectConfig(cwd, {
      enabled: true,
      fallbackModels: { "provider/primary": ["provider/backup"] },
    });
    // Simulate production ordering: ctx.signal is undefined at agent_settled
    // (finishRun clears activeRun before _emitAgentSettled fires), so the
    // ctx.signal?.aborted safeguard cannot rescue a mislabelled abort.
    const runtime = harness(cwd);
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", { prompt: "work" });
    await runtime.emit("turn_start", { turnIndex: 0 });
    // A bash tool was interrupted mid-run; the provider surfaced the abort as
    // stopReason="error" with an AbortError diagnostic instead of the canonical
    // stopReason="aborted". This is the exact shape observed in production
    // failover events ("This operation was aborted" -> fallback-scheduled).
    await runtime.emit("agent_end", {
      messages: [
        { role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 100" } }] },
        { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "Command aborted" }], isError: true },
        { role: "assistant", stopReason: "error", content: [], errorMessage: "This operation was aborted" },
      ],
    });
    (runtime.ctx as unknown as { signal: AbortSignal | undefined }).signal = undefined;
    await runtime.emit("agent_settled");

    assert.deepEqual(runtime.selected, [], "abort must not switch the active model");
    assert.equal(runtime.handoffs.length, 0, "abort must not schedule a fallback handoff");
    assert.equal(
      runtime.breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state,
      "CLOSED",
      "abort must not charge the circuit",
    );
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
    }) as { message?: { content?: string; details?: { routes?: Array<{ route?: string; reason?: string }> } } };
    assert.equal(delegated, 0);
    assert.match(result.message?.content ?? "", /\[image:unread\]/);
    assert.deepEqual(result.message?.details?.routes, [{ imageIndex: 1, route: "unread", reason: "vision_disabled" }]);
    await runtime.emit("session_shutdown");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("blocked replay fence schedules a force_restart fallback intent", async () => {
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
    await runtime.emit("agent_settled");
    await runtime.flushScheduledHandoff();

    const details = runtime.handoffs[0]?.message.details as { intent?: { mode?: string } } | undefined;
    assert.equal(details?.intent?.mode, "force_restart");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("clean failure schedules a restart fallback intent", async () => {
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
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider overloaded: 503" }],
    });
    await runtime.emit("agent_settled");
    await runtime.flushScheduledHandoff();

    const details = runtime.handoffs[0]?.message.details as { intent?: { mode?: string } } | undefined;
    assert.equal(details?.intent?.mode, "restart");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("duplicate old-run settlement after handoff transfer cannot settle the fallback early", async () => {
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
    await runtime.emit("agent_settled");
    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 1);

    // The old run's settlement arrives again after the transfer but before the
    // fallback turn starts: it must be absorbed, not settle the fallback early.
    await runtime.emit("agent_settled");
    assert.equal(runtime.handoffs.length, 1);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "fallback-scheduled");
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "CLOSED");

    // The fallback turn then proceeds and settles normally.
    await runtime.emit("turn_start", { turnIndex: 1 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    });
    await runtime.emit("agent_settled");
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "success");
    assert.equal(runtime.breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "CLOSED");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("scheduled handoff failure publishes terminal event", async () => {
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
    await runtime.flushScheduledHandoff();

    assert.equal(snapshotModelFailoverSettlement()?.outcome, "failed");
    assert.equal(runtime.emittedEvents.length, 1);
    assert.equal(runtime.emittedEvents[0]?.channel, FAILOVER_TERMINAL_EVENT);
    assert.match(
      String((runtime.emittedEvents[0]?.data as { failure?: string } | undefined)?.failure ?? ""),
      /send failed/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("image-triggered multimodal success settles as success even when failover is disabled", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-vision-disabled-"));
  try {
    writeProjectConfig(cwd, {
      enabled: false,
      fallbackModels: { "provider/primary": ["provider/last"] },
    });
    const runtime = harness(cwd, undefined, { multimodal: ["provider/last"] });
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
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "success");
    assert.deepEqual(runtime.selected, ["provider/last", "provider/primary"], "original text-only model restored");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("image-triggered fallback preserves provenance and restores the original model", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-vision-fallback-"));
  try {
    writeProjectConfig(cwd, {
      enabled: true,
      fallbackModels: { "provider/primary": ["provider/last", "provider/backup"] },
    });
    const runtime = harness(cwd, undefined, { multimodal: ["provider/last", "provider/backup"] });
    await runtime.emit("session_start");
    await runtime.emit("before_agent_start", {
      prompt: "inspect",
      images: [{ type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), mimeType: "image/png" }],
    });
    // The first multimodal candidate fails retryably; the fallback advances to
    // the second multimodal candidate.
    await runtime.emit("turn_start", { turnIndex: 0 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider overloaded: 503" }],
    });
    await runtime.emit("agent_settled");
    assert.deepEqual(runtime.selected, ["provider/last", "provider/backup"]);
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "fallback-scheduled");
    await runtime.flushScheduledHandoff();
    assert.equal(runtime.handoffs.length, 1);

    // The fallback multimodal candidate succeeds; the original text-only model
    // must be restored on settle.
    await runtime.emit("turn_start", { turnIndex: 1 });
    await runtime.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    });
    await runtime.emit("agent_settled");
    assert.equal(snapshotModelFailoverSettlement()?.outcome, "success");
    assert.deepEqual(runtime.selected, ["provider/last", "provider/backup", "provider/primary"], "original text-only model restored after image fallback");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("manual model_select resets the newly selected model's open circuit", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-manual-reset-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup"] } });
    const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    // Both models have tripped their breakers: the user manually switches to
    // `backup` to force a retry, which must reset `backup`'s circuit.
    for (const model of ["provider/primary", "provider/backup"]) {
      const trialed = breaker.acquireCandidate(model);
      assert.equal(trialed.allowed, true);
      breaker.recordRetryableFailure(trialed);
    }
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "OPEN");

    const runtime = harness(cwd, breaker);
    await runtime.emit("session_start");

    // The user manually selects `backup` via the model selector (/model).
    await runtime.emit("model_select", {
      model: { provider: "provider", id: "backup" },
      previousModel: { provider: "provider", id: "primary" },
      source: "set",
    });

    assert.match(
      runtime.notifications[0] ?? "",
      /reset|重置/,
      "a reset notification is shown",
    );
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, undefined, "backup circuit cleared");
    // The OPEN `primary` circuit is untouched: only the selected model is reset.
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");

    // The next turn acquires the freshly reset `backup` directly, no auto-switch.
    (runtime.ctx as unknown as { model: { provider: string; id: string } }).model = { provider: "provider", id: "backup" };
    await runtime.emit("before_agent_start", { prompt: "work" });
    assert.deepEqual(runtime.selected, [], "current model is acquired directly, no auto-switch");
    assert.equal(
      breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state,
      "CLOSED",
      "backup is healthy and active",
    );
    await runtime.emit("session_shutdown");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("model_select with source restore does not reset the circuit", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-restore-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup"] } });
    const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    const trialed = breaker.acquireCandidate("provider/backup");
    breaker.recordRetryableFailure(trialed);
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "OPEN");

    const runtime = harness(cwd, breaker);
    await runtime.emit("session_start");
    await runtime.emit("model_select", {
      model: { provider: "provider", id: "backup" },
      previousModel: { provider: "provider", id: "primary" },
      source: "restore",
    });

    assert.equal(runtime.notifications.length, 0, "session restore is not a manual override");
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "OPEN");
    await runtime.emit("session_shutdown");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Ctrl+P cycling (source cycle) resets the selected model and stays quiet on a healthy model", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-cycle-reset-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup"] } });
    const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    const trialed = breaker.acquireCandidate("provider/backup");
    breaker.recordRetryableFailure(trialed);
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "OPEN");

    const runtime = harness(cwd, breaker);
    await runtime.emit("session_start");

    // Cycling onto a tripped model resets it and notifies.
    await runtime.emit("model_select", {
      model: { provider: "provider", id: "backup" },
      previousModel: { provider: "provider", id: "primary" },
      source: "cycle",
    });
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, undefined);
    assert.match(runtime.notifications[0] ?? "", /reset|重置/);

    // Cycling onto a model that was never tripped is a no-op: no notification.
    runtime.notifications.length = 0;
    await runtime.emit("model_select", {
      model: { provider: "provider", id: "last" },
      previousModel: { provider: "provider", id: "backup" },
      source: "cycle",
    });
    assert.equal(runtime.notifications.length, 0, "a healthy model has nothing to reset");
    await runtime.emit("session_shutdown");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("automatic failover setModel does not reset the target model's circuit", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-auto-no-reset-"));
  try {
    writeProjectConfig(cwd, { enabled: true, fallbackModels: { "provider/primary": ["provider/backup"] } });
    const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    const runtime = harness(cwd, breaker, { emitModelSelectOnSet: true });
    await runtime.emit("session_start");

    // Trip `primary`; the next turn must auto-switch to `backup`. The harness
    // emits model_select synchronously inside setModel, exactly when the
    // guardedSetModel guard is active, so the handler must NOT reset `backup`.
    (runtime.ctx as unknown as { model: { provider: string; id: string } }).model = { provider: "provider", id: "primary" };
    const trialed = breaker.acquireCandidate("provider/primary");
    breaker.recordRetryableFailure(trialed);
    await runtime.emit("before_agent_start", { prompt: "work" });
    assert.deepEqual(runtime.selected, ["provider/backup"], "auto-switched to backup");
    assert.equal(
      runtime.notifications.some((message) => /reset|重置/.test(message) && message.includes("provider/backup")),
      false,
      "the automatic switch must not emit a reset notification",
    );
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/backup")?.state, "CLOSED", "backup was acquired, never reset");
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");
    await runtime.emit("session_shutdown");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
