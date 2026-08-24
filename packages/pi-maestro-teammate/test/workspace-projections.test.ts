import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerWorkspaceProjectionProvider,
  getWorkspaceProjectionProvider,
  listWorkspaceProjectionProviders,
  collectWorkspaceProjections,
  markAllWorkspaceProjectionsDirty,
  registerWorkspaceProjectionDirtyListener,
} from "../src/public/v1/workspace-projections.ts";

const disposers: Array<() => void> = [];

function cleanup(): void {
  for (const dispose of disposers) dispose();
  disposers.length = 0;
}
afterEach(cleanup);

test("registers and unregisters a provider", () => {
  const reg = registerWorkspaceProjectionProvider({
    kind: "todo",
    snapshot: () => [{ kind: "todo", data: { id: "1" } }],
  });
  disposers.push(reg.dispose);
  assert.ok(getWorkspaceProjectionProvider("todo"));
  assert.equal(listWorkspaceProjectionProviders().length, 1);
  reg.dispose();
  assert.equal(getWorkspaceProjectionProvider("todo"), undefined);
  assert.equal(listWorkspaceProjectionProviders().length, 0);
});

test("collectWorkspaceProjections merges items from all providers", () => {
  disposers.push(
    registerWorkspaceProjectionProvider({
      kind: "todo",
      snapshot: () => [{ kind: "todo", data: { id: "1" } }],
    }).dispose,
  );
  disposers.push(
    registerWorkspaceProjectionProvider({
      kind: "goal",
      snapshot: () => [{ kind: "goal", data: { name: "g1" } }],
    }).dispose,
  );
  const items = collectWorkspaceProjections();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.kind).sort(), ["goal", "todo"]);
});

test("skips items whose kind does not match the provider kind", () => {
  disposers.push(
    registerWorkspaceProjectionProvider({
      kind: "todo",
      snapshot: () => [
        { kind: "todo", data: { ok: true } },
        { kind: "spoofed", data: { bad: true } },
      ],
    }).dispose,
  );
  const items = collectWorkspaceProjections();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "todo");
});

test("drops a provider whose snapshot throws", () => {
  disposers.push(
    registerWorkspaceProjectionProvider({
      kind: "broken",
      snapshot: () => {
        throw new Error("boom");
      },
    }).dispose,
  );
  disposers.push(
    registerWorkspaceProjectionProvider({
      kind: "good",
      snapshot: () => [{ kind: "good", data: 1 }],
    }).dispose,
  );
  const messages: string[] = [];
  const items = collectWorkspaceProjections((m) => messages.push(m));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "good");
  assert.ok(messages.some((m) => m.includes("broken")));
});

test("rejects an empty/invalid kind as a no-op disposer", () => {
  const reg = registerWorkspaceProjectionProvider({ kind: "", snapshot: () => [] });
  assert.equal(reg.kind, "");
  assert.equal(listWorkspaceProjectionProviders().length, 0);
  reg.dispose();
});

test("markAllWorkspaceProjectionsDirty calls each provider hook", () => {
  let todoDirty = 0;
  let goalDirty = 0;
  disposers.push(
    registerWorkspaceProjectionProvider({
      kind: "todo",
      snapshot: () => [],
      markDirty: () => {
        todoDirty += 1;
      },
    }).dispose,
  );
  disposers.push(
    registerWorkspaceProjectionProvider({
      kind: "goal",
      snapshot: () => [],
      markDirty: () => {
        goalDirty += 1;
      },
    }).dispose,
  );
  markAllWorkspaceProjectionsDirty();
  assert.equal(todoDirty, 1);
  assert.equal(goalDirty, 1);
});

test("registration markDirty and disposal notify the owner publisher bridge", () => {
  let dirty = 0;
  disposers.push(registerWorkspaceProjectionDirtyListener(() => {
    dirty += 1;
  }));
  const registration = registerWorkspaceProjectionProvider({
    kind: "todo",
    snapshot: () => [],
  });
  disposers.push(registration.dispose);

  registration.markDirty();
  assert.equal(dirty, 1);
  registration.dispose();
  assert.equal(dirty, 2);
});

test("replaces an existing provider with the same kind", () => {
  const r1 = registerWorkspaceProjectionProvider({
    kind: "todo",
    snapshot: () => [{ kind: "todo", data: "v1" }],
  });
  disposers.push(r1.dispose);
  const r2 = registerWorkspaceProjectionProvider({
    kind: "todo",
    snapshot: () => [{ kind: "todo", data: "v2" }],
  });
  disposers.push(r2.dispose);
  const items = collectWorkspaceProjections();
  assert.equal(items.length, 1);
  assert.equal(items[0].data, "v2");
  // Disposing r2 should remove the current provider; r1's dispose is stale.
  r2.dispose();
  assert.equal(getWorkspaceProjectionProvider("todo"), undefined);
});
