import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerTeammateExtension from "../src/extension/index.ts";
import {
  installReturnedToolErrorBridge,
  teammateSendErrorOverride,
} from "../src/extension/tool-error-signal.ts";

test("teammate-send marks returned delivery failures without changing successful receipts", () => {
  assert.deepEqual(
    teammateSendErrorOverride("teammate-send", { delivered: false, reason: "agent-not-found" }),
    { isError: true },
  );
  assert.equal(teammateSendErrorOverride("teammate-send", { delivered: true }), undefined);
  assert.equal(teammateSendErrorOverride("teammate-send", {}), undefined);
  assert.equal(teammateSendErrorOverride("observe", { delivered: false }), undefined);
  assert.equal(teammateSendErrorOverride("teammate-send", null), undefined);
});

test("teammate returned errors become canonical errors without changing result details", async () => {
  const tools: ToolDefinition[] = [];
  const handlers: Array<(event: { toolCallId: string; toolName: string; details: unknown }) => unknown> = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    on(event: string, handler: (event: { toolCallId: string; toolName: string; details: unknown }) => unknown) {
      if (event === "tool_result") handlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  installReturnedToolErrorBridge(pi);

  const details = { mode: "single", reason: "rejected" };
  const result = {
    content: [{ type: "text" as const, text: "failed" }],
    details,
    isError: true,
  };
  pi.registerTool({
    name: "teammate-returned-error",
    label: "Teammate Returned Error",
    description: "test",
    parameters: Type.Object({}),
    async execute() {
      return result;
    },
  });

  const actual = await tools[0]!.execute(
    "failed-call",
    {},
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  assert.strictEqual(actual, result);
  assert.strictEqual(actual.details, details);
  assert.deepEqual(
    await handlers[0]!({ toolCallId: "failed-call", toolName: "teammate", details }),
    { isError: true },
  );
  assert.equal(
    await handlers[0]!({ toolCallId: "failed-call", toolName: "teammate", details }),
    undefined,
  );
});

test("teammate extension registers the error override for root and nested tool results", async () => {
  const toolResultHandlers: Array<(event: { toolName: string; details: unknown }) => unknown> = [];
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    on(event: string, handler: (event: { toolName: string; details: unknown }) => unknown) {
      if (event === "tool_result") toolResultHandlers.push(handler);
      return () => {};
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  registerTeammateExtension(pi as unknown as ExtensionAPI);

  assert.equal(toolResultHandlers.length, 1);
  assert.deepEqual(
    await toolResultHandlers[0]!({ toolName: "teammate-send", details: { delivered: false } }),
    { isError: true },
  );
  assert.equal(
    await toolResultHandlers[0]!({ toolName: "teammate-send", details: { delivered: true } }),
    undefined,
  );
});
