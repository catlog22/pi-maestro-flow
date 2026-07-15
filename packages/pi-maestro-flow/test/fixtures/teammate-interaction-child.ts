import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPermissionController } from "../../src/permissions/controller.ts";
import { executeAsk } from "../../src/tools/ask.ts";

const ctx = {
  mode: "rpc",
  hasUI: true,
  cwd: process.cwd(),
  ui: {
    notify() {},
    async select() { throw new Error("child RPC UI must not be used"); },
    async input() { throw new Error("child RPC UI must not be used"); },
  },
} as unknown as ExtensionContext;
const call = { toolName: "bash", input: { command: "npm test" } };
const controller = createPermissionController();
const block = await controller.authorize(call, ctx, "dontAsk");
const permission = { allowed: block === undefined, input: call.input, reason: block?.reason };

const question = await executeAsk({
  questions: [{
      header: "Deploy",
      question: "Which strategy?",
      options: [{ label: "Preset" }, { label: "Custom" }],
  }],
}, ctx);

await new Promise<void>((resolve, reject) => {
  if (!process.send) {
    reject(new Error("IPC is not available in the teammate fixture."));
    return;
  }
  process.send({ type: "fixture_result", permission, question: question.details }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
process.disconnect?.();
