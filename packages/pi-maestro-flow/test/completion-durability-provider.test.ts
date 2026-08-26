import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { CompletionDispatchSeed, CompletionResource } from "pi-maestro-teammate/v1";
import { FlowCompletionDurabilityProvider } from "../src/teammate/completion-durability-provider.ts";
import { readCompletionManifestFile } from "../src/teammate/completion-manifest.ts";
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

test("finalize reconciles a readable staged publication before delivery", async () => {
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
    assert.equal(await persistAgentOutputChecked(
      resource.correlationId,
      resource.name,
      resource.agent,
      "full result",
      cwd,
      resource.publicationId,
    ), "stored");

    const intent = await provider.finalizeDelivery({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "done",
      resources: [{
        ...resource,
        correlationId: "caller-rewritten-correlation",
        summary: "caller-rewritten-summary",
        outcome: "failed",
      }],
      finalizedAt: 1_030,
    });
    assert.deepEqual(intent.resources, [resource], "the staged manifest owns immutable resource metadata");
    assert.deepEqual(await provider.listRecoverable(seed.target), [intent]);
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

test("fully committed open manifest deterministically finalizes after restart", async () => {
  await fixture(async ({ provider, outputRoot, cwd, seed, resource }) => {
    await provider.beginDispatch(seed);
    await provider.requireNotification({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      requiredAt: 3_000,
    });
    await provider.stagePublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      resource,
      stagedAt: 3_010,
    });
    await persistAgentOutputChecked(
      resource.correlationId,
      resource.name,
      resource.agent,
      "restart result",
      cwd,
      resource.publicationId,
    );
    await provider.commitPublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      publicationId: resource.publicationId,
      committedAt: 3_020,
    });

    const restarted = new FlowCompletionDurabilityProvider(outputRoot);
    const recovered = await restarted.listRecoverable(seed.target);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.summary, resource.summary);
    assert.equal(recovered[0]?.outcome, resource.outcome);
    assert.equal(recovered[0]?.finalizedAt, 3_020);
    assert.deepEqual(recovered[0]?.resources, [resource]);
    assert.deepEqual(await restarted.listRecoverable(seed.target), recovered, "recovery is idempotent");
  });
});

test("ambiguous partially committed open manifest remains open", async () => {
  await fixture(async ({ provider, outputRoot, cwd, seed, resource }) => {
    const graphSeed = { ...seed, expectedTasks: [resource.correlationId, "missing-correlation"] };
    await provider.beginDispatch(graphSeed);
    await provider.requireNotification({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "graph",
      requiredAt: 4_000,
    });
    await provider.stagePublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      resource,
      stagedAt: 4_010,
    });
    await persistAgentOutputChecked(resource.correlationId, resource.name, resource.agent, "partial", cwd, resource.publicationId);
    await provider.commitPublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      publicationId: resource.publicationId,
      committedAt: 4_020,
    });
    assert.deepEqual(await new FlowCompletionDurabilityProvider(outputRoot).listRecoverable(seed.target), []);
  });
});

test("two real fresh-process manifest writer failures recover the latest generation and later success cleans remnants", async () => {
  await fixture(async ({ provider, outputRoot, cwd, seed, resource }) => {
    await provider.beginDispatch(seed);
    await persistAgentOutputChecked(resource.correlationId, resource.name, resource.agent, "replacement", cwd, resource.publicationId);
    const buckets = await readdir(outputRoot);
    const manifestDir = join(outputRoot, buckets[0]!, ".completion-intents");
    const manifestName = (await readdir(manifestDir)).find((name) => name.endsWith(".json"))!;
    const manifestPath = join(manifestDir, manifestName);
    const moduleUrl = pathToFileURL(resolve("src/teammate/completion-durability-provider.ts")).href;
    const runInterruptedWriter = (operation: string) => spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--input-type=module", "-e", [
        `const { FlowCompletionDurabilityProvider } = await import(${JSON.stringify(moduleUrl)});`,
        `const provider = new FlowCompletionDurabilityProvider(${JSON.stringify(outputRoot)});`,
        "try {",
        `  ${operation}`,
        "  process.exitCode = 2;",
        "} catch (error) {",
        "  if (!String(error).includes('Injected completion persistence failure')) { console.error(error); process.exitCode = 3; }",
        "  else process.exitCode = 86;",
        "}",
      ].join("\n")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_AGENT_OUTPUT_ROOT: outputRoot,
          PI_TEST_COMPLETION_FAIL_AT: "manifest:after-new-to-canonical",
        },
        encoding: "utf8",
      },
    );

    const first = runInterruptedWriter(`await provider.requireNotification(${JSON.stringify({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      requiredAt: 5_000,
    })});`);
    assert.equal(first.status, 86, first.stderr);
    const second = runInterruptedWriter(`await provider.stagePublication(${JSON.stringify({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      resource,
      stagedAt: 5_010,
    })});`);
    assert.equal(second.status, 86, second.stderr);

    const interruptedRemnants = (await readdir(manifestDir)).filter((name) =>
      name.startsWith(`${manifestName}.replace-`)
      && (name.endsWith(".new") || name.endsWith(".bak")));
    assert.ok(interruptedRemnants.length >= 2, "both public writer generations left recoverable remnants");
    const recovered = await readCompletionManifestFile(manifestPath);
    assert.equal(recovered?.notificationRequired, true);
    assert.equal(recovered?.published.length, 1);
    assert.equal(recovered?.published[0]?.publicationId, resource.publicationId, "the second writer generation wins");

    const restarted = new FlowCompletionDurabilityProvider(outputRoot);
    await restarted.commitPublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      publicationId: resource.publicationId,
      committedAt: 5_020,
    });
    const finalized = await restarted.finalizeDelivery({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "replacement",
      resources: [resource],
      finalizedAt: 5_030,
    });
    assert.equal((await restarted.listRecoverable(seed.target))[0]?.deliveryId, finalized.deliveryId);
    assert.deepEqual(
      (await readdir(manifestDir)).filter((name) => name.startsWith(`${manifestName}.replace-`)
        && (name.endsWith(".new") || name.endsWith(".bak"))),
      [],
      "a later successful public mutation removes every older replacement remnant",
    );
  });
});

test("strict manifest quarantine never follows symlinks or reads oversized contents", async () => {
  await fixture(async ({ provider, outputRoot, seed }) => {
    await provider.beginDispatch(seed);
    const bucket = (await readdir(outputRoot))[0]!;
    const manifestDir = join(outputRoot, bucket, ".completion-intents");
    const manifestName = (await readdir(manifestDir)).find((name) => name.endsWith(".json"))!;
    const manifestPath = join(manifestDir, manifestName);
    const external = join(outputRoot, "external-oversized.json");
    await writeFile(external, Buffer.alloc(256 * 1024 + 1, 0x61));
    await unlink(manifestPath);
    await symlink(external, manifestPath, process.platform === "win32" ? "file" : undefined);

    assert.deepEqual(await new FlowCompletionDurabilityProvider(outputRoot).listRecoverable(seed.target), []);
    assert.equal((await readFile(external)).byteLength, 256 * 1024 + 1, "external symlink target is untouched");
    assert.ok((await readdir(manifestDir)).some((name) => name.includes(".quarantine")), "symlink entry was quarantined");

    await writeFile(manifestPath, Buffer.alloc(256 * 1024 + 1, 0x62));
    assert.deepEqual(await new FlowCompletionDurabilityProvider(outputRoot).listRecoverable(seed.target), []);
    assert.ok((await readdir(manifestDir)).filter((name) => name.includes(".quarantine")).length >= 2);
  });
});

test("fresh-process manifest recovery is table-driven across every replacement boundary", async () => {
  for (const boundary of [
    "after-write",
    "after-file-sync",
    "after-close",
    "after-canonical-to-backup",
    "after-new-to-canonical",
    "after-directory-sync",
    "after-backup-cleanup",
  ] as const) {
    await fixture(async ({ provider, outputRoot, cwd, seed, resource }) => {
      await provider.beginDispatch(seed);
      await provider.requireNotification({
        dispatchId: seed.dispatchId,
        reservationId: seed.reservationId,
        kind: "single",
        requiredAt: 6_000,
      });
      await provider.stagePublication({
        dispatchId: seed.dispatchId,
        reservationId: seed.reservationId,
        resource,
        stagedAt: 6_010,
      });
      await persistAgentOutputChecked(resource.correlationId, resource.name, resource.agent, "boundary", cwd, resource.publicationId);
      await provider.commitPublication({
        dispatchId: seed.dispatchId,
        reservationId: seed.reservationId,
        publicationId: resource.publicationId,
        committedAt: 6_020,
      });
      const finalized = await provider.finalizeDelivery({
        dispatchId: seed.dispatchId,
        reservationId: seed.reservationId,
        kind: "single",
        outcome: "completed",
        summary: `boundary-${boundary}`,
        resources: [resource],
        finalizedAt: 6_030,
      });
      const modulePath = pathToFileURL(resolve("src/teammate/completion-durability-provider.ts")).href;
      const acknowledgeScript = [
        `const { FlowCompletionDurabilityProvider } = await import(${JSON.stringify(modulePath)});`,
        `const provider = new FlowCompletionDurabilityProvider(${JSON.stringify(outputRoot)});`,
        `await provider.acknowledgeApplied(${JSON.stringify({
          deliveryId: finalized.deliveryId,
          dispatchId: seed.dispatchId,
          target: seed.target,
          contentRevision: finalized.contentRevision,
          appliedAt: 6_040,
        })});`,
      ].join("\n");
      const crashed = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", acknowledgeScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_AGENT_OUTPUT_ROOT: outputRoot,
          PI_TEST_COMPLETION_FAIL_AT: `manifest:${boundary}`,
          PI_TEST_COMPLETION_CRASH: "1",
        },
        encoding: "utf8",
      });
      assert.equal(crashed.status, 86, `${boundary}: ${crashed.stderr}`);

      const readScript = [
        `const { FlowCompletionDurabilityProvider } = await import(${JSON.stringify(modulePath)});`,
        `const provider = new FlowCompletionDurabilityProvider(${JSON.stringify(outputRoot)});`,
        `const recovered = await provider.listRecoverable(${JSON.stringify(seed.target)});`,
        `if (recovered.length > 1) process.exit(2);`,
        `if (recovered.length === 1 && recovered[0].deliveryId !== ${JSON.stringify(finalized.deliveryId)}) process.exit(3);`,
      ].join("\n");
      const reader = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", readScript], {
        cwd: process.cwd(),
        env: { ...process.env, PI_AGENT_OUTPUT_ROOT: outputRoot },
        encoding: "utf8",
      });
      assert.equal(reader.status, 0, `${boundary}: ${reader.stderr}`);
    });
  }
});

test("finalize remains recoverable when post-commit backup cleanup throws", async () => {
  await fixture(async ({ provider, outputRoot, cwd, seed, resource }) => {
    await provider.beginDispatch(seed);
    await provider.requireNotification({ dispatchId: seed.dispatchId, reservationId: seed.reservationId, kind: "single", requiredAt: 7_000 });
    await provider.stagePublication({ dispatchId: seed.dispatchId, reservationId: seed.reservationId, resource, stagedAt: 7_010 });
    await persistAgentOutputChecked(resource.correlationId, resource.name, resource.agent, "post-commit", cwd, resource.publicationId);
    await provider.commitPublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      publicationId: resource.publicationId,
      committedAt: 7_020,
    });

    process.env.PI_TEST_COMPLETION_FAIL_AT = "manifest:after-backup-cleanup";
    try {
      await assert.rejects(() => provider.finalizeDelivery({
        dispatchId: seed.dispatchId,
        reservationId: seed.reservationId,
        kind: "single",
        outcome: "completed",
        summary: "post-commit",
        resources: [resource],
        finalizedAt: 7_030,
      }), /Injected completion persistence failure/);
    } finally {
      delete process.env.PI_TEST_COMPLETION_FAIL_AT;
    }

    const recovered = await new FlowCompletionDurabilityProvider(outputRoot).listRecoverable(seed.target);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.summary, "post-commit");
  });
});

test("abandon transitions only open manifests and preserves finalized/applied intent", async () => {
  await fixture(async ({ provider, outputRoot, cwd, seed, resource }) => {
    await provider.beginDispatch(seed);
    await provider.requireNotification({ dispatchId: seed.dispatchId, reservationId: seed.reservationId, kind: "single", requiredAt: 8_000 });
    await provider.stagePublication({ dispatchId: seed.dispatchId, reservationId: seed.reservationId, resource, stagedAt: 8_010 });
    await persistAgentOutputChecked(resource.correlationId, resource.name, resource.agent, "irreversible", cwd, resource.publicationId);
    const intent = await provider.finalizeDelivery({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      outcome: "completed",
      summary: "irreversible",
      resources: [resource],
      finalizedAt: 8_020,
    });
    const abandon = {
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      reason: "late racing settle",
      abandonedAt: 8_030,
    };
    await provider.abandonDispatch(abandon);
    assert.deepEqual(await provider.listRecoverable(seed.target), [intent], "finalized state cannot roll back");

    await provider.acknowledgeApplied({
      deliveryId: intent.deliveryId,
      dispatchId: seed.dispatchId,
      target: seed.target,
      contentRevision: intent.contentRevision,
      appliedAt: 8_040,
    });
    await provider.abandonDispatch(abandon);
    assert.deepEqual(await provider.listRecoverable(seed.target), []);
    const bucket = (await readdir(outputRoot))[0]!;
    const manifestDir = join(outputRoot, bucket, ".completion-intents");
    const manifestName = (await readdir(manifestDir)).find((name) => name.endsWith(".json"))!;
    const manifest = await readCompletionManifestFile(join(manifestDir, manifestName));
    assert.equal(manifest?.state, "applied", "applied state cannot roll back");
    assert.equal(manifest?.intent?.deliveryId, intent.deliveryId);
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

test("a CJK summary over 4096 bytes is byte-truncated and never quarantined", async () => {
  await fixture(async ({ provider, outputRoot, cwd, seed }) => {
    // A multi-byte summary that exceeds 4096 bytes once staged. Previously the
    // char-based .slice(0,4096) at the write sites left a >4096-byte summary in
    // the manifest; the strict byte validator then rejected and quarantined it
    // on the next read, surfacing as "Completion dispatch manifest not found".
    const longSummary = "完成审查结果".repeat(800); // 6 CJK chars * 3 bytes * 800 = 14400 bytes
    const oversizedResource: CompletionResource = {
      correlationId: seed.expectedTasks[0]!,
      publicationId: "publication-cjk",
      uri: "agent://publication-cjk",
      originCwd: cwd,
      name: "reviewer",
      agent: "reviewer",
      summary: longSummary,
      outcome: "completed",
    };
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
      resource: oversizedResource,
      stagedAt: 1_020,
    });
    await persistAgentOutputChecked(
      oversizedResource.correlationId,
      oversizedResource.name,
      oversizedResource.agent,
      "cjk result",
      cwd,
      oversizedResource.publicationId,
    );
    await provider.commitPublication({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      publicationId: oversizedResource.publicationId,
      committedAt: 1_030,
    });
    const intent = await provider.finalizeDelivery({
      dispatchId: seed.dispatchId,
      reservationId: seed.reservationId,
      kind: "single",
      outcome: "completed",
      summary: longSummary,
      resources: [oversizedResource],
      finalizedAt: 1_050,
    });
    // The finalized intent summary and the stored resource summary must both
    // fit the byte cap; the resource summary is the manifest's own value.
    assert.ok(Buffer.byteLength(intent.summary, "utf8") <= 4096, "intent summary is byte-capped");
    assert.ok(Buffer.byteLength(intent.resources[0]!.summary, "utf8") <= 4096, "resource summary is byte-capped");

    // No quarantine file should appear in the manifest directory.
    const buckets = await readdir(outputRoot);
    const manifestDir = join(outputRoot, buckets[0]!, ".completion-intents");
    const entries = await readdir(manifestDir);
    assert.ok(!entries.some((name) => name.includes(".quarantine")), "oversized CJK summary manifest was not quarantined");

    // A fresh provider instance must still be able to locate the dispatch and
    // recover the finalized intent (this re-reads the manifest through the
    // strict parser that previously quarantined it).
    const restarted = new FlowCompletionDurabilityProvider(outputRoot);
    const recovered = await restarted.listRecoverable(seed.target);
    assert.deepEqual(recovered, [intent], "dispatch manifest survives a restart re-read");
  });
});
