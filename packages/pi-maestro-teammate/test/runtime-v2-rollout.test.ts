import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { RuntimeEventDraftV2, RuntimeEventV2 } from "../src/runtime-v2/contracts.ts";
import { parseRuntimeV2RolloutMode } from "../src/runtime-v2/rollout.ts";
import { createRuntimeV2ShadowSink, RuntimeV2ShadowSink } from "../src/runtime-v2/shadow.ts";

const draft = {
  version: 2,
  revision: 1,
  streamId: "stream-a",
  actor: { version: 2, revision: 1, workspaceId: "workspace-a", actorKind: "remote", actorId: "run-a", generation: 1 },
  occurredAt: 10,
  kind: "tool.started",
  toolCallId: "tool-a",
  toolName: "read",
} satisfies RuntimeEventDraftV2;

test("Runtime V2 rollout parser defaults and fails closed to disabled", () => {
  assert.equal(parseRuntimeV2RolloutMode(undefined), "disabled");
  assert.equal(parseRuntimeV2RolloutMode("disabled"), "disabled");
  assert.equal(parseRuntimeV2RolloutMode("invalid"), "disabled");
  assert.equal(parseRuntimeV2RolloutMode(" SHADOW "), "shadow");
});

test("disabled sink performs only the authoritative v1 append", () => {
  let adapted = false;
  const sink = new RuntimeV2ShadowSink();
  const result = sink.appendAfterV1(() => "v1", () => {
    adapted = true;
    return [draft];
  });
  assert.equal(result, "v1");
  assert.equal(adapted, false);
});

test("shadow sink writes after v1 and swallows advisory failures", () => {
  const order: string[] = [];
  const errors: unknown[] = [];
  const journal = {
    append(_event: RuntimeEventDraftV2): RuntimeEventV2 {
      order.push("shadow");
      throw new Error("shadow disk failure");
    },
  };
  const sink = new RuntimeV2ShadowSink({ mode: "shadow", journal, onError: (error) => errors.push(error) });
  const result = sink.appendAfterV1(() => {
    order.push("v1");
    return 42;
  }, () => [draft]);
  assert.equal(result, 42);
  assert.deepEqual(order, ["v1", "shadow"]);
  assert.equal(errors.length, 1);
});

test("a v1 append failure prevents shadow adaptation and propagates unchanged", () => {
  let adapted = false;
  const sink = new RuntimeV2ShadowSink({
    mode: "shadow",
    journal: { append: () => { throw new Error("must not run"); } },
  });
  assert.throws(() => sink.appendAfterV1(() => { throw new Error("v1 failed"); }, () => {
    adapted = true;
    return [draft];
  }), /v1 failed/);
  assert.equal(adapted, false);
});

test("factory creates no shadow directory while rollout is disabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-v2-disabled-"));
  try {
    const sink = createRuntimeV2ShadowSink({ stateDirectory: root, env: {} });
    assert.equal(sink.mode, "disabled");
    assert.equal(fs.existsSync(path.join(root, "runtime-v2-shadow")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
