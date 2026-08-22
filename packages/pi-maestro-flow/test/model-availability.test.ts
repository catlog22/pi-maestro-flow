import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createModelAvailabilityTool, registerModelAvailability } from "../src/tools/model-availability.ts";
import { loadCliToolsConfig } from "../src/providers/cli-tools-loader.ts";
import {
  forgetBackendRegistryConfigSync,
} from "pi-maestro-teammate/src/public/v1/backends.ts";
import { sharedModelHealthCoordinator } from "pi-maestro-teammate/src/public/v1/retry.ts";
import { REMOTE_MODEL_SESSION_UNAVAILABLE_REASON } from "pi-maestro-teammate/src/public/v1/model-routing.ts";
import {
  TEAMMATE_MODEL_SESSION_EVENT,
  TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION,
  TEAMMATE_MODEL_SESSION_QUERY_EVENT,
} from "pi-maestro-teammate/src/public/v1/events.ts";

function mockContext(models: Array<{ provider: string; id: string }>): ExtensionContext {
  return {
    cwd: process.cwd(),
    modelRegistry: { getAvailable: () => models },
  } as unknown as ExtensionContext;
}

function modelAvailabilityTool(
  options: Parameters<typeof createModelAvailabilityTool>[0] = {},
): ReturnType<typeof createModelAvailabilityTool> {
  return createModelAvailabilityTool({ loadDelegateConfig: () => null, ...options });
}

test("description states the delegate routing pitfall once before execution", () => {
  const tool = modelAvailabilityTool();
  assert.equal((tool.description.match(/bare \`maestro delegate codex\`/g) ?? []).length, 1);
  assert.equal((tool.promptGuidelines ?? []).some((line) => /bare `maestro delegate codex`/.test(line)), false);
  assert.doesNotMatch(tool.description, /D:\\maestro2/);
});

test("registered tool queries teammate session authority through the public event contract", async () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  let registered: ReturnType<typeof createModelAvailabilityTool> | undefined;
  let queries = 0;
  const events = {
    on(event: string, handler: (payload: unknown) => void) {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(handler);
      handlers.set(event, listeners);
      return () => listeners.delete(handler);
    },
    emit(event: string, payload: unknown) {
      if (event === TEAMMATE_MODEL_SESSION_QUERY_EVENT) {
        queries++;
        const request = payload as { requestId: string };
        events.emit(TEAMMATE_MODEL_SESSION_EVENT, {
          version: TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          isChild: false,
          hasCurrentRootMonitorAuthority: true,
        });
      }
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
  const pi = {
    events,
    registerTool(tool: ReturnType<typeof createModelAvailabilityTool>) { registered = tool; },
  } as unknown as Parameters<typeof registerModelAvailability>[0];
  registerModelAvailability(pi, { loadDelegateConfig: () => null });
  assert.ok(registered);
  await registered.execute("event-wiring", {}, undefined, undefined, mockContext([]));
  assert.equal(queries, 1);
});

test("streams progressive detail updates and returns both model sources", async () => {
  const tool = modelAvailabilityTool();
  const updates: Array<AgentToolResult> = [];
  const ctx = mockContext([
    { provider: "deepseek", id: "deepseek-v4-pro" },
    { provider: "maestro-openai", id: "gpt-5.6-sol" },
  ]);

  const result = await tool.execute(
    "t1",
    {},
    undefined,
    (partial) => updates.push(partial),
    ctx,
  );

  assert.ok(updates.length >= 3, `expected progressive streaming updates, got ${updates.length}`);

  const details = result.details;
  assert.ok(details, "result should carry details");
  assert.deepEqual(details.teammate_models, [
    "deepseek/deepseek-v4-pro",
    "maestro-openai/gpt-5.6-sol",
  ]);
  assert.ok(Array.isArray(details.delegate_tools));
  assert.ok(Array.isArray(details.delegate_fallback));

  const text = result.content[0].type === "text" ? result.content[0].text : "";
  const parsed = JSON.parse(text);
  assert.ok(parsed.hint.includes("--to"), "hint must warn about the mandatory --to flag");
});

test("model-registry diagnostics retain unavailable routes without exposing deployment config", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-availability-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "teammate-backends.json"), JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "pi-local",
    defaultModel: "registry/default",
    backends: {
      "pi-local": { module: "pi-subprocess" },
      "remote-prod": {
        module: "remote-workers",
        config: { targetId: "secret-ssh-target", driver: "pi-rpc" },
      },
      "vendor-private": {
        module: "vendor/private-adapter",
        config: { token: "must-never-surface", command: "private-command" },
      },
    },
    models: {
      "registry/default": {
        modelId: "intrinsic/default",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "host/default" },
        deploymentDefault: true,
      },
      "registry/unhealthy": {
        modelId: "intrinsic/unhealthy",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "host/unhealthy" },
      },
      "remote/fixed": {
        modelId: "intrinsic/remote",
        deployment: "remote-prod",
        selector: { kind: "fixed" },
      },
      "vendor/default": {
        modelId: "intrinsic/vendor",
        deployment: "vendor-private",
        selector: { kind: "deployment-default" },
      },
    },
  }), "utf-8");
  const ctx = {
    cwd: root,
    modelRegistry: { getAvailable: () => [] },
  } as unknown as ExtensionContext;
  const tool = modelAvailabilityTool({
    sessionAuthority: () => ({ isChild: false, hasCurrentRootMonitorAuthority: false }),
  });

  try {
    await tool.execute("registry-initial", {}, undefined, undefined, ctx);
    for (let attempt = 0; attempt < 3; attempt++) {
      const acquisition = sharedModelHealthCoordinator.acquireCandidate("registry/unhealthy");
      assert.equal(acquisition.allowed, true);
      if (acquisition.allowed) sharedModelHealthCoordinator.recordFailure(acquisition, "route");
    }

    const result = await tool.execute("registry-final", {}, undefined, undefined, ctx);
    const registry = result.details?.model_registry;
    assert.ok(registry);
    assert.equal(registry.mode, "model-registry");
    assert.equal(registry.version, 2);
    assert.equal(registry.default_model, "registry/default");
    assert.deepEqual(result.details?.teammate_models, ["registry/default"]);

    const remote = registry.registrations.find((entry) => entry.registrationId === "remote/fixed");
    assert.deepEqual(remote && {
      registered: remote.registered,
      resolvable: remote.resolvable,
      sessionAvailable: remote.sessionAvailable,
      healthy: remote.healthy,
      harness: remote.harness,
      transport: remote.transport,
      unavailableReason: remote.unavailableReason,
    }, {
      registered: true,
      resolvable: true,
      sessionAvailable: false,
      healthy: true,
      harness: "pi",
      transport: "remote-worker",
      unavailableReason: REMOTE_MODEL_SESSION_UNAVAILABLE_REASON,
    });

    const vendor = registry.registrations.find((entry) => entry.registrationId === "vendor/default");
    assert.equal(vendor?.registered, true);
    assert.equal(vendor?.resolvable, false);
    assert.equal(vendor?.unavailableReason, "The registered model deployment cannot be resolved by this host.");
    const unhealthy = registry.registrations.find((entry) => entry.registrationId === "registry/unhealthy");
    assert.equal(unhealthy?.healthy, false);
    assert.equal(unhealthy?.unavailableReason, "The registered model route is temporarily unhealthy.");

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /secret-ssh-target|must-never-surface|private-command|targetId|token/);
  } finally {
    sharedModelHealthCoordinator.routeBreaker.reset("registry/unhealthy");
    forgetBackendRegistryConfigSync(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegate config is loaded from the active context cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-delegate-cwd-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const toolName = `active-workspace-${process.pid}`;
  writeFileSync(join(root, ".pi", "teammate-cli-tools.json"), JSON.stringify({
    version: "1",
    tools: { [toolName]: { enabled: true, command: process.execPath } },
  }), "utf-8");

  try {
    const loadedFrom: string[] = [];
    const tool = createModelAvailabilityTool({
      loadDelegateConfig: (cwd) => {
        loadedFrom.push(cwd ?? "");
        return loadCliToolsConfig(cwd, join(root, "missing-global-config.json"));
      },
    });
    const result = await tool.execute("delegate-cwd", {}, undefined, undefined, {
      cwd: root,
      modelRegistry: { getAvailable: () => [] },
    } as unknown as ExtensionContext);
    assert.deepEqual(loadedFrom, [root]);
    assert.ok(result.details?.delegate_tools.some((entry) => entry.name === toolName));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SSH delegate status waits for the real async probe result", async () => {
  const probed: string[] = [];
  const tool = modelAvailabilityTool({
    loadDelegateConfig: () => ({
      version: "1",
      tools: {
        reachable: {
          enabled: true,
          mode: "ssh",
          command: "agent-ok",
          host: "verified.example",
          user: "runner",
          hostKeySha256: "SHA256:verified",
        },
        unreachable: {
          enabled: true,
          mode: "ssh",
          command: "agent-missing",
          host: "missing.example",
          user: "runner",
          hostKeySha256: "SHA256:missing",
        },
      },
    }),
    probeSshExecutable: async (host, command) => {
      probed.push(`${host.host}/${command}`);
      await Promise.resolve();
      return { ok: command === "agent-ok" };
    },
  });

  const result = await tool.execute("delegate-ssh", {}, undefined, undefined, mockContext([]));
  assert.deepEqual(probed.sort(), [
    "missing.example/agent-missing",
    "verified.example/agent-ok",
  ]);
  assert.equal(result.details?.delegate_tools.find((entry) => entry.name === "reachable")?.status, "ok");
  assert.equal(result.details?.delegate_tools.find((entry) => entry.name === "unreachable")?.status, "missing");
});

test("delegate tools not namespaced under a teammate model are flagged as fallback", async () => {
  const tool = modelAvailabilityTool();
  const ctx = mockContext([{ provider: "codex", id: "gpt-5.5" }]);

  const result = await tool.execute("t2", {}, undefined, undefined, ctx);
  const details = result.details;
  assert.ok(details);

  const fallbackNames = new Set(details.delegate_fallback.map((tool) => tool.name));
  for (const delegateTool of details.delegate_tools) {
    const covered = delegateTool.name === "codex";
    if (covered) {
      assert.ok(!fallbackNames.has(delegateTool.name), "codex/ namespaced model should not be fallback");
    }
  }
});

test("filter narrows teammate models by substring", async () => {
  const tool = modelAvailabilityTool();
  const ctx = mockContext([
    { provider: "deepseek", id: "deepseek-v4-pro" },
    { provider: "maestro-openai", id: "gpt-5.6-sol" },
  ]);

  const result = await tool.execute("t3", { filter: "deepseek" }, undefined, undefined, ctx);
  assert.deepEqual(result.details?.teammate_models, ["deepseek/deepseek-v4-pro"]);
});

test("P7 documentation retains registry migration, topology, compatibility, rollback, and timeout contracts", () => {
  const documents = {
    adapter: readFileSync(new URL("../../../docs/teammate-backend-adapter-contract.md", import.meta.url), "utf-8"),
    usageEn: readFileSync(new URL("../../../docs/USAGE_EN.md", import.meta.url), "utf-8"),
    usageZh: readFileSync(new URL("../../../docs/USAGE.md", import.meta.url), "utf-8"),
    readme: readFileSync(new URL("../../pi-maestro-teammate/README.md", import.meta.url), "utf-8"),
    changelog: readFileSync(new URL("../../pi-maestro-teammate/CHANGELOG.md", import.meta.url), "utf-8"),
  };

  for (const [name, text] of Object.entries(documents)) {
    assert.match(text, /model-registry/, `${name} must name the new mode`);
    assert.match(text, /backend-registry/, `${name} must distinguish the old registry mode`);
    assert.match(text, /sessionAvailable/, `${name} must describe the session gate`);
    assert.match(text, /runTimeoutMs/, `${name} must retain the timeout workaround`);
    assert.doesNotMatch(text, /lossless re-entry|re-entry lossless|无损重进/, `${name} must not promise valid lossless v2 re-entry`);
  }
  assert.match(documents.adapter, /Topology matrix/);
  assert.match(documents.adapter, /teammateCliToolsProjection/);
  assert.match(documents.adapter, /Rollback is a one-field mode change/);
  assert.match(documents.adapter, /round-trip preservation/);
  assert.match(documents.adapter, /strict v2 parser may reject unsupported or unknown fields/);
  assert.doesNotMatch(documents.adapter, /lossless re-entry/);
  assert.match(documents.adapter, /not a model registration editor/);
  assert.match(documents.usageEn, /Roll back by changing only `mode`/);
  assert.match(documents.usageZh, /回滚只需把 `mode`/);
  assert.match(documents.changelog, /历史记录，原文保留/);
  assert.match(documents.changelog, /"mode": "backend-registry"/);
});
