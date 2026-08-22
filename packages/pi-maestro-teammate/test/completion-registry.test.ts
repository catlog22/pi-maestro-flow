import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_DURABILITY_REGISTRY_KEY,
  getCompletionDurabilityRegistry,
  type CompletionDurabilityProvider,
} from "../src/public/v1/completion-durability.ts";

function provider(label: string): CompletionDurabilityProvider {
  return {
    async beginDispatch(seed) {
      return { dispatchId: seed.dispatchId, reservationId: seed.reservationId, deliveryGroupId: `${seed.deliveryGroupId}:${label}` };
    },
    async requireNotification() {},
    async stagePublication() {},
    async commitPublication() {},
    async finalizeDelivery() { throw new Error("unused"); },
    async listRecoverable() { return []; },
    async acknowledgeApplied() {},
    async abandonDispatch() {},
    async prune() {},
  };
}

test("completion durability registry is shared by the same root globals", () => {
  const root = {};
  const first = getCompletionDurabilityRegistry(root);
  const second = getCompletionDurabilityRegistry(root);
  assert.equal(first, second);
  assert.equal((root as Record<PropertyKey, unknown>)[COMPLETION_DURABILITY_REGISTRY_KEY], first);
});

test("register publishes generations and disposal only clears its own provider", () => {
  const registry = getCompletionDurabilityRegistry({});
  const snapshots: Array<{ generation: number; current: CompletionDurabilityProvider | undefined }> = [];
  const unsubscribe = registry.subscribe((snapshot) => snapshots.push({ generation: snapshot.generation, current: snapshot.provider }));
  const first = provider("first");
  const second = provider("second");

  const disposeFirst = registry.register(first);
  const disposeSecond = registry.register(second);
  disposeFirst();
  assert.equal(registry.current(), second);
  disposeSecond();
  disposeSecond();
  assert.equal(registry.current(), undefined);
  unsubscribe();

  assert.deepEqual(snapshots.map((entry) => entry.generation), [0, 1, 2, 3]);
  assert.equal(snapshots[1]?.current, first);
  assert.equal(snapshots[2]?.current, second);
  assert.equal(snapshots[3]?.current, undefined);
});

test("late subscribers immediately observe the current provider", () => {
  const registry = getCompletionDurabilityRegistry({});
  const current = provider("current");
  registry.register(current);
  let observed: CompletionDurabilityProvider | undefined;
  registry.subscribe((snapshot) => { observed = snapshot.provider; })();
  assert.equal(observed, current);
});
