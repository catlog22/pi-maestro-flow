import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DataManagerRegistry,
  executeDataManagerCommand,
  registerDataManagerCommand,
  type ManagedDataSource,
} from "../src/tools/data-manager.ts";

function source(deletions: string[]): ManagedDataSource {
  return {
    id: "example",
    label: "Example data",
    async load() {
      return {
        sourceId: "example",
        label: "Example data",
        scope: "Current workspace",
        totalBytes: 12,
        capacity: { used: 1, limit: 5 },
        items: [{
          id: "item-1",
          title: "First item",
          detail: "Resource: example://item-1",
          sizeBytes: 12,
          updatedAt: "2026-08-12T10:00:00.000Z",
        }],
      };
    },
    async delete(_cwd, itemId) {
      deletions.push(itemId);
      return true;
    },
  };
}

function harness(confirm = true) {
  const notifications: Array<{ message: string; type: string }> = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const ctx = {
    cwd: "D:/workspace",
    ui: {
      notify(message: string, type: string) { notifications.push({ message, type }); },
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return confirm;
      },
      async select() { return undefined; },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, confirmations };
}

function registry(deletions: string[]): DataManagerRegistry {
  const value = new DataManagerRegistry();
  value.register(source(deletions));
  return value;
}

test("data manager lists registered source occupancy", async () => {
  const h = harness();
  await executeDataManagerCommand("list", h.ctx, registry([]));
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0]!.message, /Example data · 1\/5 items · 12 B · Current workspace/);
});

test("data manager shows source items", async () => {
  const h = harness();
  await executeDataManagerCommand("show example", h.ctx, registry([]));
  assert.match(h.notifications[0]!.message, /First item · 12 B · 2026-08-12 10:00:00 · item-1/);
});

test("data manager deletes only after explicit confirmation", async () => {
  const cancelled: string[] = [];
  const cancelHarness = harness(false);
  await executeDataManagerCommand("delete example item-1", cancelHarness.ctx, registry(cancelled));
  assert.deepEqual(cancelled, []);
  assert.equal(cancelHarness.confirmations.length, 1);

  const approved: string[] = [];
  const approveHarness = harness(true);
  await executeDataManagerCommand("delete example item-1", approveHarness.ctx, registry(approved));
  assert.deepEqual(approved, ["item-1"]);
  assert.match(approveHarness.notifications.at(-1)?.message ?? "", /Deleted item-1/);
});

test("data manager registers the user command", () => {
  const commands = new Map<string, unknown>();
  registerDataManagerCommand({
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
  } as unknown as ExtensionAPI, registry([]));
  assert.ok(commands.has("data-manager"));
});

test("data manager rejects duplicate source ids", () => {
  const value = registry([]);
  assert.throws(() => value.register(source([])), /already registered/);
});
