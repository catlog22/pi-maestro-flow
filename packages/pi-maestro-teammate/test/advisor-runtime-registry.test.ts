import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  ensureAdvisorCommandRegistered,
  getAdvisorRuntimeOwner,
  registerAdvisorRuntime,
} from "../src/supervision/advisor-runtime.ts";

function uniqueId(name: string): string {
  return `test/${name}/${Date.now()}/${Math.random()}`;
}

function candidate(id: string, priority: number, events: boolean[] = []) {
  return {
    id,
    priority,
    handleCommand() {},
    onOwnershipChanged(owned: boolean) {
      events.push(owned);
    },
  };
}

test("higher-priority advisor runtime wins in either registration order and release restores fallback", () => {
  for (const highFirst of [false, true]) {
    const lowEvents: boolean[] = [];
    const highEvents: boolean[] = [];
    const lowId = uniqueId(`low-${highFirst}`);
    const highId = uniqueId(`high-${highFirst}`);
    const first = highFirst
      ? registerAdvisorRuntime(candidate(highId, 100, highEvents))
      : registerAdvisorRuntime(candidate(lowId, 10, lowEvents));
    const second = highFirst
      ? registerAdvisorRuntime(candidate(lowId, 10, lowEvents))
      : registerAdvisorRuntime(candidate(highId, 100, highEvents));
    const highLease = highFirst ? first : second;
    const lowLease = highFirst ? second : first;

    assert.equal(getAdvisorRuntimeOwner(), highId);
    assert.equal(highLease.isOwner(), true);
    assert.equal(lowLease.isOwner(), false);

    highLease.release();
    assert.equal(getAdvisorRuntimeOwner(), lowId);
    assert.equal(lowLease.isOwner(), true);
    lowLease.release();

    assert.equal(highEvents.at(-1), false);
    assert.equal(lowEvents.at(-1), false);
  }
});

test("same-id replacement invalidates the old lease and stale release cannot remove the new generation", () => {
  const id = uniqueId("replace");
  const oldEvents: boolean[] = [];
  const newEvents: boolean[] = [];
  const oldLease = registerAdvisorRuntime(candidate(id, 50, oldEvents));
  const newLease = registerAdvisorRuntime(candidate(id, 50, newEvents));

  assert.equal(oldLease.isOwner(), false);
  assert.equal(newLease.isOwner(), true);
  assert.deepEqual(oldEvents, [true, false]);
  assert.deepEqual(newEvents, [true]);

  oldLease.release();
  assert.equal(getAdvisorRuntimeOwner(), id);
  assert.equal(newLease.isOwner(), true);
  newLease.release();
});

test("advisor command registers once per host and dynamically routes to the current owner", async () => {
  const calls: string[] = [];
  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let registrations = 0;
  const notices: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) {
      assert.equal(name, "advisor");
      registrations++;
      commandHandler = options.handler;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    ui: { notify(message: string) { notices.push(message); } },
  } as unknown as ExtensionCommandContext;

  ensureAdvisorCommandRegistered(pi);
  ensureAdvisorCommandRegistered(pi);
  assert.equal(registrations, 1);
  assert.ok(commandHandler);

  await commandHandler("status", ctx);
  assert.deepEqual(notices, ["Advisor runtime is unavailable."]);

  const lowId = uniqueId("command-low");
  const highId = uniqueId("command-high");
  const lowLease = registerAdvisorRuntime({
    id: lowId,
    priority: 10,
    handleCommand(args) { calls.push(`low:${args}`); },
  });
  await commandHandler("one", ctx);

  const highLease = registerAdvisorRuntime({
    id: highId,
    priority: 100,
    handleCommand(args) { calls.push(`high:${args}`); },
  });
  await commandHandler("two", ctx);

  assert.deepEqual(calls, ["low:one", "high:two"]);
  highLease.release();
  lowLease.release();
});
