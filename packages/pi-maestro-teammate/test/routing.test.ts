import assert from "node:assert/strict";
import test from "node:test";
import { resolveReplyTo } from "../src/shared/routing.ts";

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
