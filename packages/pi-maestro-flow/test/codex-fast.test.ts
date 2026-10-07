import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Model, type OpenAICodexResponsesOptions, type StreamFunction } from "@earendil-works/pi-ai";
import registerCodexFast, { applyCodexFast, codexFastConfigPath, loadCodexFast, saveCodexFast } from "../src/providers/codex-fast.ts";
import { collectExtensionStatuses } from "../../pi-cockpit/src/extension-status.ts";
import { emptyTotals, renderFooter } from "../../pi-cockpit/src/footer.ts";
import { resolveGlyphs } from "../../pi-cockpit/src/icons.ts";

const model: Model<"openai-codex-responses"> = {
  provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol", name: "Codex test",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
};
const payload = () => ({ model: model.id, input: [], reasoning: { effort: "high" }, tools: [{ name: "read" }], instructions: "Keep this", text: { verbosity: "low" } });

type Handler = (event: { payload?: unknown; model?: ExtensionContext["model"] }, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
function harness(t: TestContext, flag = false) {
  const cwd = mkdtempSync(join(tmpdir(), "codex-fast-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const flags = new Map<string, unknown>();
  const notices: { text: string; level: string }[] = [];
  const statuses = new Map<string, string | undefined>();
  const ctx = {
    cwd, model,
    ui: {
      notify: (text: string, level: string) => notices.push({ text, level }),
      setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerFlag: (name: string, value: unknown) => flags.set(name, value),
    getFlag: () => flag,
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  registerCodexFast(pi);
  const emit = (name: string, body?: unknown) => {
    const handler = handlers.get(name);
    assert.ok(handler);
    return handler(name === "model_select" ? { model: ctx.model } : { payload: body }, ctx);
  };
  const command = (args = "") => {
    const registered = commands.get("fast");
    assert.ok(registered);
    return registered.handler(args, ctx);
  };
  return { cwd, ctx, pi, emit, command, commands, notices, statuses, flags };
}

test("only a matching Codex request is patched, preserving every other field and the original payload", () => {
  const body = payload();
  const original = structuredClone(body);
  assert.deepEqual(applyCodexFast(body, model, true), { ...original, service_tier: "priority" });
  assert.deepEqual(body, original);
  assert.equal(applyCodexFast(body, model, false), undefined);
  assert.equal(applyCodexFast(body, undefined, true), undefined);
  for (const provider of ["openai", "maestro-openai", "devin", "anthropic"]) {
    assert.equal(applyCodexFast(body, { ...model, provider }, true), undefined);
  }
  for (const api of ["openai-responses", "openai-completions", "anthropic-messages"]) {
    assert.equal(applyCodexFast(body, { ...model, api }, true), undefined);
  }
  for (const invalid of [null, [], "text", 1, {}, { model: "other", input: [] }, { model: model.id }, { model: model.id, input: "text" }]) {
    assert.equal(applyCodexFast(invalid, model, true), undefined);
  }
});

test("off never removes another extension's service tier; on explicitly requests priority", () => {
  const body = { ...payload(), service_tier: "flex" };
  assert.equal(applyCodexFast(body, model, false), undefined);
  assert.equal(body.service_tier, "flex");
  assert.deepEqual(applyCodexFast(body, model, true), { ...body, service_tier: "priority" });
});

test("configuration defaults off, saves atomically, and rejects malformed settings", (t) => {
  const h = harness(t);
  assert.equal(loadCodexFast(h.cwd), false);
  saveCodexFast(h.cwd, true);
  assert.equal(loadCodexFast(h.cwd), true);
  saveCodexFast(h.cwd, false);
  assert.equal(loadCodexFast(h.cwd), false);
  for (const invalid of ["broken-json", "null", "[]", "{}", '{"enabled":"true"}']) {
    writeFileSync(codexFastConfigPath(h.cwd), invalid);
    assert.throws(() => loadCodexFast(h.cwd));
  }
});

test("only /fast is registered; it toggles and persists without changing the model", async (t) => {
  const h = harness(t);
  assert.deepEqual([...h.commands.keys()], ["fast"]);
  assert.ok(h.flags.has("fast"));
  h.emit("session_start");
  assert.equal(h.emit("before_provider_request", payload()), undefined);
  await h.command("on");
  assert.equal(loadCodexFast(h.cwd), true);
  assert.deepEqual(h.emit("before_provider_request", payload()), { ...payload(), service_tier: "priority" });
  assert.equal(h.statuses.get("codex-fast"), "Codex Fast: on");
  await h.command("status");
  assert.match(h.notices.at(-1)!.text, /on/);
  await h.command("");
  assert.equal(loadCodexFast(h.cwd), false);
  assert.equal(h.emit("before_provider_request", payload()), undefined);
  assert.equal(h.statuses.get("codex-fast"), undefined);
  assert.equal(h.ctx.model, model);
});

test("CLI --fast is session-only, and /fast off overrides it for the current session", async (t) => {
  const h = harness(t, true);
  h.emit("session_start");
  assert.deepEqual(h.emit("before_provider_request", payload()), { ...payload(), service_tier: "priority" });
  assert.equal(loadCodexFast(h.cwd), false);
  await h.command("off");
  assert.equal(h.emit("before_provider_request", payload()), undefined);
});

test("Cockpit footer follows Fast toggle, model switches, and session config restore", async (t) => {
  const h = harness(t);
  const footer = () => renderFooter({
    model: h.ctx.model?.id ?? "no-model", thinking: "high", width: 120,
    ctxPct: 0, ctxTokens: 0, ctxWindow: 0, totals: emptyTotals(), glyphs: resolveGlyphs("ascii"),
    theme: { fg: (_color, text) => text },
    utils: { measure: (text) => text.length, clip: (text, width) => text.slice(0, width) },
    extensionStatuses: collectExtensionStatuses(new Map([...h.statuses].filter((entry): entry is [string, string] => typeof entry[1] === "string"))),
  }).join("\n");
  h.emit("session_start");
  assert.doesNotMatch(footer(), /FAST/);
  await h.command("on");
  assert.match(footer(), /gpt-5\.6-sol \| FAST \| high/);
  h.ctx.model = { ...model, provider: "openai", api: "openai-responses" };
  h.emit("model_select");
  assert.doesNotMatch(footer(), /FAST/);
  assert.equal(loadCodexFast(h.cwd), true);
  h.ctx.model = model;
  h.emit("model_select");
  assert.match(footer(), /FAST/);
  h.ctx.model = undefined;
  h.emit("session_start");
  assert.doesNotMatch(footer(), /FAST/);
  h.ctx.model = model;
  h.emit("model_select");
  assert.match(footer(), /FAST/);
  await h.command("off");
  assert.doesNotMatch(footer(), /FAST/);
});

test("CLI Fast status is hidden on a non-Codex model and restored on switching back", (t) => {
  const h = harness(t, true);
  h.ctx.model = { ...model, provider: "devin" };
  h.emit("session_start");
  assert.equal(h.statuses.get("codex-fast"), undefined);
  h.ctx.model = model;
  h.emit("model_select");
  assert.equal(h.statuses.get("codex-fast"), "Codex Fast: on");
});

test("invalid command is reported without writing config or changing mode", async (t) => {
  const h = harness(t);
  await h.command("on");
  await h.command("not-a-command");
  assert.equal(loadCodexFast(h.cwd), true);
  assert.equal(h.notices.at(-1)!.level, "warning");
});

test("session start restores config and workspace switches do not leak enabled state", async (t) => {
  const h = harness(t);
  await h.command("on");
  registerCodexFast(h.pi);
  h.emit("session_start");
  assert.deepEqual(h.emit("before_provider_request", payload()), { ...payload(), service_tier: "priority" });
  const other = mkdtempSync(join(tmpdir(), "codex-fast-other-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  h.ctx.cwd = other;
  h.emit("session_start");
  assert.equal(h.emit("before_provider_request", payload()), undefined);
});

test("bad config disables and reports once; save failure leaves the active mode unchanged", async (t) => {
  const h = harness(t);
  mkdirSync(join(h.cwd, ".pi"));
  writeFileSync(codexFastConfigPath(h.cwd), "broken");
  h.emit("session_start");
  assert.equal(h.emit("before_provider_request", payload()), undefined);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].level, "warning");
  await h.command("on");
  rmSync(codexFastConfigPath(h.cwd));
  mkdirSync(codexFastConfigPath(h.cwd));
  await h.command("off");
  assert.equal(h.notices.at(-1)!.level, "error");
  assert.match(h.notices.at(-1)!.text, /unchanged/);
  assert.deepEqual(h.emit("before_provider_request", payload()), { ...payload(), service_tier: "priority" });
});

test("request hooks use cached config rather than reading disk on each call", async (t) => {
  const h = harness(t);
  await h.command("on");
  writeFileSync(codexFastConfigPath(h.cwd), "broken");
  assert.deepEqual(h.emit("before_provider_request", payload()), { ...payload(), service_tier: "priority" });
  assert.equal(h.notices.length, 1);
});

test("package manifest registers the standalone extension and ships its source", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.pi.extensions.includes("./src/providers/codex-fast.ts"));
  assert.ok(pkg.files.includes("src/**/*.ts"));
});

test("real Pi Codex serializer produces a patchable payload for both transports without changing reasoning", async () => {
  const apiUrl = new URL("./api/openai-codex-responses.js", import.meta.resolve("@earendil-works/pi-ai"));
  const { stream }: { stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> } = await import(apiUrl.href);
  const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
  for (const transport of ["sse", "websocket"] as const) {
    let captured = false;
    const result = await stream(model, normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 0 }] }), {
      apiKey: `header.${account}.signature`, transport, reasoningEffort: "high", textVerbosity: "medium",
      onPayload(body, requestModel) {
        const patched = applyCodexFast(body, requestModel, true);
        assert.ok(patched && typeof patched === "object" && "service_tier" in patched);
        assert.equal(patched.service_tier, "priority");
        assert.ok(body && typeof body === "object" && "reasoning" in body && "text" in body);
        assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
        assert.deepEqual(body.text, { verbosity: "medium" });
        assert.deepEqual(patched, { ...body, service_tier: "priority" });
        captured = true;
        // Stop before any HTTP/WebSocket connection; this test uses no real credential or quota.
        throw new Error("captured-before-network");
      },
    }).result();
    assert.ok(captured, result.errorMessage ?? "Codex payload hook did not run");
    assert.match(result.errorMessage ?? "", /captured-before-network/);
  }
});
