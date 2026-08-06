import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SettingsChange, SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { createHooksSettingsProvider } from "../src/settings/hooks-settings-provider.ts";

const context: SettingsContextV1 = { cwd: "/project", locale: "en" };

function harness(initial?: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "hooks-provider-"));
  const configPath = join(directory, "project", ".pi", "hooks.json");
  mkdirSync(join(directory, "project", ".pi"), { recursive: true });
  if (initial) writeFileSync(configPath, JSON.stringify(initial, null, 2));
  const provider = createHooksSettingsProvider({ getConfigPath: () => configPath });
  const ctx = { ...context, cwd: join(directory, "project") };
  return { provider, configPath, directory, context: ctx };
}

function setChange(key: string, value: unknown): SettingsChange {
  return { operation: "set", key, scope: "project", value };
}

test("hooks provider describes the installed-hooks list", async () => {
  const { provider, directory } = harness();
  try {
    const description = await provider.describe({ context });
    assert.equal(description.id, "pi-maestro-flow-hooks");
    const entries = description.settings.find((s) => s.key === "hooks.entries")!;
    assert.equal(entries.editor.kind, "list-crud");
    assert.ok(entries.editor.itemFields?.some((f) => f.key === "event" && f.editor.kind === "enum"));
    assert.ok(entries.editor.itemFields?.some((f) => f.key === "command" && f.editor.kind === "text"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hooks read flattens matcher groups into items", async () => {
  const { provider, directory } = harness({
    $schema: "https://example.com/hooks.schema.json",
    hooks: {
      SessionStart: [{ matcher: "session-*", hooks: [{ type: "command", command: "echo start", timeout: 600 }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo tool", timeout: 600 }] }],
    },
  });
  try {
    const snapshot = await provider.read({ context });
    const items = snapshot.effective.values.find((e) => e.key === "hooks.entries")?.value as Array<Record<string, unknown>>;
    assert.equal(items.length, 2);
    assert.equal(items[0]?.event, "SessionStart");
    assert.equal(items[0]?.matcher, "session-*");
    assert.equal(items[0]?.command, "echo start");
    assert.equal(items[1]?.command, "echo tool");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hooks prepare+commit writes the flattened items back to hooks.json preserving schema", async () => {
  const { provider, configPath, directory } = harness({
    $schema: "https://example.com/hooks.schema.json",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo start", timeout: 600 }] }] },
  });
  try {
    const prepared = await provider.prepare!({
      context,
      transactionId: "h1",
      changes: [setChange("hooks.entries", [
        { event: "SessionStart", matcher: "session-*", command: "echo start2" },
        { event: "Stop", matcher: "", command: "echo stop" },
      ])],
    });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "h1", prepareToken: prepared.prepareToken! });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    assert.equal(raw.$schema, "https://example.com/hooks.schema.json", "schema preserved");
    assert.deepEqual(raw.hooks.SessionStart, [{ matcher: "session-*", hooks: [{ type: "command", command: "echo start2", timeout: 600 }] }]);
    assert.deepEqual(raw.hooks.Stop, [{ hooks: [{ type: "command", command: "echo stop", timeout: 600 }] }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hooks validation rejects unknown keys and non-project scopes", async () => {
  const { provider, directory } = harness();
  try {
    const unknown = await provider.validate({ context, transactionId: "h2", changes: [setChange("hooks.nope", 1)] });
    assert.equal(unknown.valid, false);
    const badScope = await provider.validate({ context, transactionId: "h2", changes: [{ operation: "set", key: "hooks.entries", scope: "global", value: [] }] });
    assert.equal(badScope.valid, false);
    const ok = await provider.validate({ context, transactionId: "h2", changes: [setChange("hooks.entries", [])] });
    assert.equal(ok.valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
