import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentConfig } from "../src/agents/agents.ts";
import { registerTeammateChildExtension } from "../src/runs/child-extensions.ts";
import {
  buildInheritedExtensionArgs,
  buildManagedWindowPiArgs,
  buildPiArgs,
} from "../src/runs/execution-infra.ts";

const baseAgentConfig = { tools: ["read"] } as unknown as AgentConfig;

/** Extension paths in argv order, with Windows separators normalized. */
function extensionPathsOf(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1].replaceAll("\\", "/")] : []);
}

test("managed windows disable settings discovery before loading inherited extensions", () => {
  for (const presentation of ["headless", "interactive"] as const) {
    const args = buildManagedWindowPiArgs({ objective: "o", sessionName: "mw-x", presentation });
    assert.equal(args[0], "--no-extensions");
    const extensionPaths = extensionPathsOf(args);
    assert.equal(extensionPaths.length, 1);
    assert.ok(
      extensionPaths[0].endsWith("packages/pi-maestro-teammate/src/extension/index.ts"),
      `expected the repository teammate extension, got ${extensionPaths[0]}`,
    );
  }
});

test("managed windows keep their presentation-specific argv tail", () => {
  const headless = buildManagedWindowPiArgs({
    objective: "ship it",
    sessionName: "mw-headless",
    presentation: "headless",
  });
  assert.deepEqual(headless.slice(-4), ["-p", "ship it", "--name", "mw-headless"]);

  const interactive = buildManagedWindowPiArgs({
    objective: "ship it",
    sessionName: "mw-interactive",
    presentation: "interactive",
  });
  assert.deepEqual(interactive.slice(-3), ["--name", "mw-interactive", "ship it"]);

  const forked = buildManagedWindowPiArgs({
    objective: "ship it",
    sessionName: "mw-fork",
    presentation: "headless",
    forkSessionFile: "/tmp/prior-session.jsonl",
  });
  assert.equal(forked[forked.indexOf("--fork") + 1], "/tmp/prior-session.jsonl");
  assert.ok(forked.indexOf("--fork") < forked.indexOf("-p"));
});

test("a registered parent extension reaches managed windows exactly once", () => {
  const dispose = registerTeammateChildExtension("/tmp/fake-flow-ext.ts");
  try {
    const args = buildManagedWindowPiArgs({
      objective: "o",
      sessionName: "mw-x",
      presentation: "headless",
    });
    assert.ok(extensionPathsOf(args).includes("/tmp/fake-flow-ext.ts"));

    const teammateExtension = args[args.indexOf("--extension") + 1];
    const disposeDuplicate = registerTeammateChildExtension(teammateExtension);
    try {
      const deduped = buildManagedWindowPiArgs({
        objective: "o",
        sessionName: "mw-x",
        presentation: "headless",
      });
      assert.equal(deduped.filter((arg) => arg === teammateExtension).length, 1);
    } finally {
      disposeDuplicate();
    }
  } finally {
    dispose();
  }
});

test("managed-window and teammate-child argv share one inherited extension sequence", () => {
  const dispose = registerTeammateChildExtension("/tmp/fake-flow-ext.ts", { tools: ["ask-user-question"] });
  try {
    const managedWindow = extensionPathsOf(
      buildManagedWindowPiArgs({ objective: "o", sessionName: "mw-x", presentation: "headless" }),
    );
    const teammateChild = extensionPathsOf(
      buildPiArgs(baseAgentConfig, { agent: "general" }, "prompt.md"),
    );
    assert.deepEqual(managedWindow, teammateChild);
    assert.equal(managedWindow.length, 2);
  } finally {
    dispose();
  }
});


test("inherited extension args put the primary extension first", () => {
  const dispose = registerTeammateChildExtension("/tmp/fake-flow-ext.ts");
  try {
    const args = buildInheritedExtensionArgs("/tmp/primary-ext.ts");
    assert.deepEqual(args.slice(0, 2), ["--extension", "/tmp/primary-ext.ts"]);
    assert.deepEqual(extensionPathsOf(args), ["/tmp/primary-ext.ts", "/tmp/fake-flow-ext.ts"]);
  } finally {
    dispose();
  }
});
