import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayAuditSink } from "../src/gateway/audit.ts";
import { GatewayControlDispatcher } from "../src/gateway/control-dispatcher.ts";

test("control dispatcher audits allowed, denied, and failed actions without request payloads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-control-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "audit", "gateway.jsonl");
  let sequence = 0;
  const dispatcher = new GatewayControlDispatcher({
    audit: new GatewayAuditSink(path),
    requestId: () => `control-${++sequence}`,
    now: () => 100,
    handlers: {
      pair: (data) => ({ id: "pair-safe", accepted: Boolean(data) }),
      "pair-revoke": () => ({ revoked: true }),
      stop: () => ({ accepted: true }),
      "tunnel-start": () => ({ status: "running" }),
      "workspace-register": () => {
        const error = new Error("raw-command --token secret-must-not-be-logged") as Error & { code: string };
        error.code = "workspace_denied";
        throw error;
      },
    },
  });
  const secret = "secret-token-and-message";
  assert.deepEqual(await dispatcher.dispatch("pair", { token: secret, prompt: secret, message: secret, command: secret }), { id: "pair-safe", accepted: true });
  assert.deepEqual(await dispatcher.dispatch("pair-revoke", { id: secret }), { revoked: true });
  assert.deepEqual(await dispatcher.dispatch("tunnel-start", { argv: secret }), { status: "running" });
  assert.deepEqual(await dispatcher.dispatch("stop", { message: secret }), { accepted: true });
  await assert.rejects(() => dispatcher.dispatch("workspace-register", { path: secret }), /secret-must-not-be-logged/u);
  await assert.rejects(() => dispatcher.dispatch("tunnel-stop", { argv: secret }), /unavailable/u);

  const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => [record.tool, record.action, record.outcome, record.code]), [
    ["control", "pair", "allowed", undefined],
    ["control", "pair-revoke", "allowed", undefined],
    ["control", "tunnel-start", "allowed", undefined],
    ["control", "stop", "allowed", undefined],
    ["control", "workspace-register", "denied", "workspace_denied"],
    ["control", "tunnel-stop", "denied", "control_unavailable"],
  ]);
  assert.doesNotMatch(JSON.stringify(records), /secret-token|raw-command|prompt|message|argv/u);
});
