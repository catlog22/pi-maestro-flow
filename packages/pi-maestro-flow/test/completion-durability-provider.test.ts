import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompletionDispatchSeed, CompletionResource } from "pi-maestro-teammate/v1";
import { FlowCompletionDurabilityProvider } from "../src/teammate/completion-durability-provider.ts";
import { persistAgentOutputChecked } from "../src/teammate/agent-output-store.ts";

async function fixture(run: (input: {
  provider: FlowCompletionDurabilityProvider;
  outputRoot: string;
  cwd: string;
  seed: CompletionDispatchSeed;
  resource: CompletionResource;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "flow-completion-provider-"));
  const outputRoot = join(root, "outputs");
  const cwd = join(root, "workspace");
  const previous = process.env.PI_AGENT_OUTPUT_ROOT;
  process.env.PI_AGENT_OUTPUT_ROOT = outputRoot;
  const seed: CompletionDispatchSeed = {
    dispatchId: "dispatch-one",
    deliveryGroupId: "group-one",
    reservationId: "reservation-one",
    mode: "single",
    target: { workspaceId: "workspace-one", sessionId: "session-one" },
    replyTarget: "main",
    originCwd: cwd,
    expectedTasks: ["correlation-one"],
    createdAt: 1_000,
  };
  const resource: CompletionResource = {
    correlationId: "correlation-one",
    publicationId: "publication-one",
    uri: "agent://publication-one",
    originCwd: cwd,
    name: "worker",
    agent: "general",
    summary: "done",
    outcome: "completed",
  };
  try {
    await run({ provider: new FlowCompletionDurabilityProvider(outputRoot), outputRoot, cwd, seed, resource });
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_OUTPUT_ROOT;
    else process.env.PI_AGENT_OUTPUT_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("provider pins an immutable publication before finalizing a recoverable intent", async () => {
  await fixture(async ({ provider, cwd, seed, resource }) => {
    await provider.beginDispatch(seed);
    await provider.requireNotification({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      requiredAt: 1_010,
    });
    await provider.stagePublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      resource,
      stagedAt: 1_020,
    });
    await assert.rejects(() => provider.commitPublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      publicationId: resource.publicationId,
      committedAt: 1_030,
    }), /not readable/);

    assert.equal(await persistAgentOutputChecked(
      resource.correlationId,
      resource.name,
      resource.agent,
      "full result",
      cwd,
      resource.publicationId,
    ), "stored");
    await provider.commitPublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      publicationId: resource.publicationId,
      committedAt: 1_040,
    });
    const intent = await provider.finalizeDelivery({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "done",
      resources: [resource],
      finalizedAt: 1_050,
    });
    assert.match(intent.deliveryId, /^[a-f0-9]{64}$/);
    assert.deepEqual(await provider.listRecoverable(seed.target), [intent]);

    await provider.acknowledgeApplied({
      deliveryId: intent.deliveryId,
      dispatchId: seed.dispatchId,
      target: seed.target,
      contentRevision: intent.contentRevision,
      appliedAt: 1_060,
    });
    assert.deepEqual(await provider.listRecoverable(seed.target), []);
  });
});

test("a new provider instance reconciles a staged publication after restart", async () => {
  await fixture(async ({ provider, outputRoot, cwd, seed, resource }) => {
    await provider.beginDispatch(seed);
    await provider.requireNotification({ dispatchId: seed.dispatchId, reservationId: seed.reservationId, kind: "single", requiredAt: 2_000 });
    await provider.stagePublication({ dispatchId: seed.dispatchId, reservationId: seed.reservationId, resource, stagedAt: 2_010 });
    await persistAgentOutputChecked(resource.correlationId, resource.name, resource.agent, "result", cwd, resource.publicationId);

    const restarted = new FlowCompletionDurabilityProvider(outputRoot);
    await restarted.commitPublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      publicationId: resource.publicationId,
      committedAt: 2_020,
    });
    const intent = await restarted.finalizeDelivery({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "done",
      resources: [resource],
      finalizedAt: 2_030,
    });
    assert.equal((await restarted.listRecoverable(seed.target))[0]?.deliveryId, intent.deliveryId);
  });
});

test("open and abandoned manifests never synthesize completion", async () => {
  await fixture(async ({ provider, seed }) => {
    await provider.beginDispatch(seed);
    assert.deepEqual(await provider.listRecoverable(seed.target), []);
    await provider.abandonDispatch({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      reason: "cancelled before spawn",
      abandonedAt: 2_000,
    });
    assert.deepEqual(await provider.listRecoverable(seed.target), []);
  });
});
