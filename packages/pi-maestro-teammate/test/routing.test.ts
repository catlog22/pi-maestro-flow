import assert from "node:assert/strict";
import test from "node:test";
import { resolveReplyTo, resolveAgentCompletionTarget, formatLocalAgentMessage } from "../src/shared/routing.ts";
import { applyModelRouting } from "../src/models/model-routing.ts";

test("reply routing defaults missing protocol versions to v2 caller semantics", () => {
  assert.equal(resolveReplyTo({ name: "named" }), "caller");
  assert.equal(resolveReplyTo({ protocol_version: 2, name: "named" }), "caller");
});

test("reply routing preserves explicit v1 and explicit target behavior", () => {
  assert.equal(resolveReplyTo({ protocol_version: 1, name: "named" }), "main");
  assert.equal(resolveReplyTo({ protocol_version: 1 }), "caller");
  assert.equal(resolveReplyTo({ protocol_version: 1, name: "named", reply_to: "caller" }), "caller");
  assert.equal(resolveReplyTo({ protocol_version: 2, reply_to: "main" }), "main");
});

test("resolveAgentCompletionTarget reads stored reply_to with v2 defaults", () => {
  assert.equal(resolveAgentCompletionTarget({ replyTo: "main", name: "worker" }), "main");
  assert.equal(resolveAgentCompletionTarget({ name: "worker" }), "caller");
  assert.equal(resolveAgentCompletionTarget({ replyTo: "caller" }), "caller");
});

test("formatLocalAgentMessage wraps local payloads with sender identity", () => {
  const formatted = formatLocalAgentMessage({
    message: "please review",
    messageKind: "coordination",
    senderLabel: "@reviewer",
    replyToSelector: "reviewer#abc12345",
  });
  assert.match(formatted, /\[teammate:coordination\] from @reviewer/);
  assert.match(formatted, /Reply with teammate-send to "reviewer#abc12345"/);
  assert.match(formatted, /please review$/);
});

test("applyModelRouting preserves top-level maxNestingDepth", () => {
  const routed = applyModelRouting(
    { tasks: [{ prompt: "inspect" }], maxNestingDepth: 0 },
    process.cwd(),
    [],
  );
  assert.equal(routed.maxNestingDepth, 0);

  // Omitted stays omitted: the default is applied at dispatch time.
  const plain = applyModelRouting({ tasks: [{ prompt: "inspect" }] }, process.cwd(), []);
  assert.equal(plain.maxNestingDepth, undefined);
});

test("applyModelRouting preserves per-task maxNestingDepth", () => {
  const routed = applyModelRouting(
    { tasks: [{ prompt: "inspect", maxNestingDepth: 0 }], maxNestingDepth: 1 },
    process.cwd(),
    [],
  );
  assert.equal(routed.tasks[0].maxNestingDepth, 0);
  assert.equal(routed.maxNestingDepth, 1);

  const plain = applyModelRouting({ tasks: [{ prompt: "inspect" }] }, process.cwd(), []);
  assert.equal(plain.tasks[0].maxNestingDepth, undefined);
});
