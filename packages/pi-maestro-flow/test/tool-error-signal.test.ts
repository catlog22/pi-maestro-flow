import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  installReturnedToolErrorBridge,
  type FlowToolResult,
} from "../src/tools/tool-result.ts";

test("returned tool errors become canonical tool-result errors without changing the result", async () => {
  const tools: ToolDefinition[] = [];
  const handlers: Array<(event: { toolCallId: string }) => unknown> = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    on(event: string, handler: (event: { toolCallId: string }) => unknown) {
      if (event === "tool_result") handlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  installReturnedToolErrorBridge(pi);

  const details = { reason: "rejected" };
  let result: FlowToolResult = {
    content: [{ type: "text", text: "failed" }],
    details,
    isError: true,
  };
  pi.registerTool({
    name: "returned-error",
    label: "Returned Error",
    description: "test",
    parameters: Type.Object({}),
    async execute() {
      return result;
    },
  });

  assert.equal(tools.length, 1);
  assert.equal(handlers.length, 1);
  const wrapped = tools[0]!;
  const actual = await wrapped.execute(
    "failed-call",
    {},
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  assert.strictEqual(actual, result);
  assert.strictEqual(actual.details, details);
  assert.equal(await handlers[0]!({ toolCallId: "other-call" }), undefined);
  assert.deepEqual(await handlers[0]!({ toolCallId: "failed-call" }), { isError: true });
  assert.equal(await handlers[0]!({ toolCallId: "failed-call" }), undefined);

  result = { content: [{ type: "text", text: "ok" }], details: { ok: true } };
  await wrapped.execute("successful-call", {}, undefined, undefined, {} as ExtensionContext);
  assert.equal(await handlers[0]!({ toolCallId: "successful-call" }), undefined);
});
