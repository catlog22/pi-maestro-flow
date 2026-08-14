import assert from "node:assert/strict";
import test from "node:test";
import {
  RunCliAdapter,
  type RunCliResult,
  type RunCliRunner,
} from "../src/session/cli-adapter.ts";

const structuredCapabilities = {
  schema_version: "maestro-capabilities/1.0",
  cli_version: "1.4.0",
  session_schema_writes: ["session/1.3", "session/2.0"],
  execution_schema_writes: ["execution/1.0"],
  run_response_writes: ["run-response/1.0", "run-response/1.1", "run-response/1.2"],
  features: {
    execution_generation: true,
    core_execution_lease: true,
    execution_handoff: true,
    session_statusless: false,
    legacy_session_aliases: true,
    artifact_compatibility_v1: true,
    atomic_run_complete_seal: true,
    generation_scoped_seal_receipts: true,
  },
};

// Session/Run minimal-state (plan B v3) core: v2 lease/generation retired,
// the v3 capability set advertised as a unit, execution_lease and
// operation_registry explicitly false (architecture doc section 15).
const v3StructuredCapabilities = {
  schema_version: "maestro-capabilities/1.0",
  cli_version: "2.0.0",
  session_schema_writes: ["session/3.0"],
  execution_schema_writes: [],
  run_response_writes: ["run-response/1.1", "run-response/1.2"],
  features: {
    execution_generation: false,
    core_execution_lease: false,
    execution_handoff: false,
    session_statusless: false,
    legacy_session_aliases: false,
    session_run_minimal_v3: true,
    entity_revision_cas: true,
    participant_identity: true,
    request_receipts_v2: true,
    execution_lease: false,
    operation_registry: false,
    artifact_compatibility_v1: true,
    atomic_run_complete_seal: true,
    generation_scoped_seal_receipts: true,
  },
};

const COMPLETE_V3_SUPPORT = {
  session_run_minimal_v3: true,
  entity_revision_cas: true,
  participant_identity: true,
  request_receipts_v2: true,
  execution_lease_retired: true,
  operation_registry_retired: true,
  session_3_writer: true,
  no_execution_writes: true,
  response_12: true,
  v2_features_retired: true,
};

const NO_V3_SUPPORT = {
  session_run_minimal_v3: false,
  entity_revision_cas: false,
  participant_identity: false,
  request_receipts_v2: false,
  execution_lease_retired: false,
  operation_registry_retired: false,
  session_3_writer: false,
  no_execution_writes: false,
  response_12: false,
  v2_features_retired: false,
};

test("CLI adapter treats a validated structured capability result as authoritative", async () => {
  const calls: string[][] = [];
  const adapter = new RunCliAdapter("D:/workspace", fakeRunner(calls, (args) => {
    switch (args.join(" ")) {
      case "capabilities --json":
        return ok(args, JSON.stringify(structuredCapabilities));
      case "run --help":
        return ok(args, "Commands:\n  brief\n  check\n");
      case "session --help":
        return ok(args, "Commands:\n  next\n");
      case "plan --help":
        return ok(args, "Commands:\n  publish\n");
      default:
        throw new Error(`unexpected fake command: ${args.join(" ")}`);
    }
  }));

  const capabilities = await adapter.capabilities();
  assert.equal(capabilities.mode, "structured");
  assert.equal(capabilities.structured?.cli_version, "1.4.0");
  assert.deepEqual(capabilities.support, {
    execution_generation: true,
    core_execution_lease: true,
    "run-response/1.1": true,
    "run-response/1.2": true,
    artifact_compatibility_v1: true,
    atomic_run_complete_seal: true,
    generation_scoped_seal_receipts: true,
  });
  assert.deepEqual([...capabilities.commands], ["brief", "check", "next"]);
  assert.equal(await adapter.supportsExecutionGeneration(), true);
  assert.equal(await adapter.supportsCoreExecutionLease(), true);
  assert.equal(await adapter.supportsRunResponseV11(), true);
  assert.equal(await adapter.supportsRunResponseV12(), true);
  assert.equal(await adapter.supportsArtifactCompatibility(), true);
  assert.equal(await adapter.supportsNewMutations(), true);
  // v2-only core: no v3 keys broadcast, so the v2 protocol is selected.
  // It still declares run-response/1.2 (a shared response schema).
  assert.deepEqual(capabilities.v3, { ...NO_V3_SUPPORT, response_12: true });
  assert.equal(capabilities.protocol, "execution-v2");
  assert.equal(await adapter.supportsSessionRunMinimalV3(), false);
  assert.equal(calls.filter((call) => call.join(" ") === "capabilities --json").length, 1);
});

test("CLI adapter negotiates the complete Session/Run minimal-state (v3) capability set as a unit", async () => {
  const adapter = new RunCliAdapter("D:/workspace", async (args) => {
    if (args.join(" ") === "capabilities --json") return ok(args, JSON.stringify(v3StructuredCapabilities));
    if (args.join(" ") === "run --help") return ok(args, "Commands:\n  brief\n  check\n");
    if (args.join(" ") === "session --help") return ok(args, "Commands:\n  open\n  complete\n");
    return fail(args, "unknown command");
  });

  const capabilities = await adapter.capabilities();
  assert.equal(capabilities.mode, "structured");
  assert.deepEqual(capabilities.v3, COMPLETE_V3_SUPPORT);
  assert.equal(capabilities.protocol, "session-run-v3");
  assert.equal(await adapter.supportsSessionRunMinimalV3(), true);
  assert.equal(await adapter.protocol(), "session-run-v3");
  // The retired v2 protocol must not be negotiated against a v3 core.
  assert.deepEqual(capabilities.support, {
    execution_generation: false,
    core_execution_lease: false,
    "run-response/1.1": true,
    "run-response/1.2": true,
    artifact_compatibility_v1: true,
    atomic_run_complete_seal: true,
    generation_scoped_seal_receipts: true,
  });
  assert.equal(await adapter.supportsNewMutations(), false);
});

test("CLI adapter fails the v3 protocol closed when any capability of the set is missing or contradictory", async (t) => {
  const fixtures = [
    {
      name: "request_receipts_v2 absent",
      features: (features: Record<string, boolean>) => {
        const { request_receipts_v2: _, ...rest } = features;
        return rest;
      },
      expectFlag: (v3: Record<string, boolean>) => assert.equal(v3.request_receipts_v2, false),
    },
    {
      name: "execution_lease key absent (core predates the v3 contract)",
      features: (features: Record<string, boolean>) => {
        const { execution_lease: _, ...rest } = features;
        return rest;
      },
      expectFlag: (v3: Record<string, boolean>) => assert.equal(v3.execution_lease_retired, false),
    },
    {
      name: "execution_lease still advertised as true",
      features: (features: Record<string, boolean>) => ({ ...features, execution_lease: true }),
      expectFlag: (v3: Record<string, boolean>) => assert.equal(v3.execution_lease_retired, false),
    },
    {
      name: "operation_registry still advertised as true",
      features: (features: Record<string, boolean>) => ({ ...features, operation_registry: true }),
      expectFlag: (v3: Record<string, boolean>) => assert.equal(v3.operation_registry_retired, false),
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const capabilitiesJson = JSON.stringify({
        ...v3StructuredCapabilities,
        features: fixture.features({ ...v3StructuredCapabilities.features }),
      });
      const adapter = new RunCliAdapter("D:/workspace", async (args) => {
        if (args.join(" ") === "capabilities --json") return ok(args, capabilitiesJson);
        if (args.join(" ") === "run --help") return ok(args, "Commands:\n  brief\n");
        return fail(args, "unknown command");
      });
      const capabilities = await adapter.capabilities();
      assert.equal(capabilities.mode, "structured");
      fixture.expectFlag(capabilities.v3 as unknown as Record<string, boolean>);
      // Incomplete v3 set and no v2 support: mutations must fail closed.
      assert.equal(capabilities.protocol, "fail-closed");
      assert.equal(await adapter.supportsSessionRunMinimalV3(), false);
      assert.equal(await adapter.supportsNewMutations(), false);
    });
  }
});

test("CLI adapter reports explicit legacy compatibility when capabilities is an old-CLI missing command", async () => {
  const calls: string[][] = [];
  const adapter = new RunCliAdapter("D:/workspace", fakeRunner(calls, (args) => {
    switch (args.join(" ")) {
      case "capabilities --json":
        return fail(args, "[maestro] Unknown command: \"capabilities\"");
      case "run --help":
        return ok(args, "Commands:\n  brief\n  next\n  complete\n");
      case "session --help":
      case "plan --help":
        return fail(args, "unknown command");
      default:
        throw new Error(`unexpected fake command: ${args.join(" ")}`);
    }
  }));

  const capabilities = await adapter.capabilities();
  assert.equal(capabilities.mode, "legacy");
  assert.match(capabilities.diagnostic ?? "", /legacy read compatibility only/);
  assert.equal(capabilities.structured, null);
  assert.deepEqual(capabilities.support, {
    execution_generation: false,
    core_execution_lease: false,
    "run-response/1.1": false,
    "run-response/1.2": false,
    artifact_compatibility_v1: false,
    atomic_run_complete_seal: false,
    generation_scoped_seal_receipts: false,
  });
  assert.deepEqual([...capabilities.commands], ["brief", "next", "complete"]);
  assert.deepEqual(capabilities.v3, NO_V3_SUPPORT);
  assert.equal(capabilities.protocol, "fail-closed");
  assert.equal(await adapter.supportsNewMutations(), false);
});

test("CLI adapter fails new capability support closed for malformed or unsupported structured responses", async (t) => {
  const invalidResponses = [
    { name: "malformed JSON", stdout: "{not-json" },
    {
      name: "unsupported schema",
      stdout: JSON.stringify({ ...structuredCapabilities, schema_version: "maestro-capabilities/2.0" }),
    },
    {
      name: "missing required feature",
      stdout: JSON.stringify({
        ...structuredCapabilities,
        features: { ...structuredCapabilities.features, core_execution_lease: undefined },
      }),
    },
    {
      name: "non-boolean additive feature",
      stdout: JSON.stringify({
        ...structuredCapabilities,
        features: { ...structuredCapabilities.features, future_feature: "yes" },
      }),
    },
  ];

  for (const fixture of invalidResponses) {
    await t.test(fixture.name, async () => {
      const calls: string[][] = [];
      const adapter = new RunCliAdapter("D:/workspace", fakeRunner(calls, (args) => {
        switch (args.join(" ")) {
          case "capabilities --json":
            return ok(args, fixture.stdout);
          case "run --help":
            return ok(args, "Commands:\n  brief\n  check\n");
          case "session --help":
          case "plan --help":
            return fail(args, "not installed");
          default:
            throw new Error(`unexpected fake command: ${args.join(" ")}`);
        }
      }));

      const capabilities = await adapter.capabilities();
      assert.equal(capabilities.mode, "fail-closed");
      assert.equal(capabilities.structured, null);
      assert.equal(capabilities.support.execution_generation, false);
      assert.equal(capabilities.support.core_execution_lease, false);
      assert.equal(capabilities.support["run-response/1.1"], false);
      assert.equal(capabilities.support["run-response/1.2"], false);
      assert.equal(capabilities.support.artifact_compatibility_v1, false);
      assert.deepEqual(capabilities.v3, NO_V3_SUPPORT);
      assert.equal(capabilities.protocol, "fail-closed");
      assert.deepEqual([...capabilities.commands], ["brief", "check"]);
      assert.match(capabilities.diagnostic ?? "", /capability probe returned/);
    });
  }
});

test("CLI adapter fails readiness closed for contradictory structured capabilities", async (t) => {
  const fixtures = [
    {
      name: "features and response without execution/1.0",
      capabilities: { ...structuredCapabilities, execution_schema_writes: ["execution/2.0"] },
      expected: {
        execution_generation: false,
        core_execution_lease: false,
        "run-response/1.1": true,
        "run-response/1.2": true,
        artifact_compatibility_v1: true,
        atomic_run_complete_seal: true,
        generation_scoped_seal_receipts: true,
      },
    },
    {
      name: "schemas without execution generation",
      capabilities: {
        ...structuredCapabilities,
        features: { ...structuredCapabilities.features, execution_generation: false },
      },
      expected: {
        execution_generation: false,
        core_execution_lease: true,
        "run-response/1.1": true,
        "run-response/1.2": true,
        artifact_compatibility_v1: true,
        atomic_run_complete_seal: true,
        generation_scoped_seal_receipts: true,
      },
    },
    {
      name: "execution schema and features without run-response/1.1",
      capabilities: { ...structuredCapabilities, run_response_writes: ["run-response/1.0"] },
      expected: {
        execution_generation: true,
        core_execution_lease: true,
        "run-response/1.1": false,
        "run-response/1.2": false,
        artifact_compatibility_v1: true,
        atomic_run_complete_seal: true,
        generation_scoped_seal_receipts: true,
      },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const adapter = new RunCliAdapter("D:/workspace", async (args) => {
        if (args.join(" ") === "capabilities --json") return ok(args, JSON.stringify(fixture.capabilities));
        if (args.join(" ") === "run --help") return ok(args, "Commands:\n  brief\n");
        return fail(args, "unknown command");
      });
      const capabilities = await adapter.capabilities();
      assert.deepEqual(capabilities.support, fixture.expected);
      assert.equal(await adapter.supportsNewMutations(), false);
    });
  }
});

// Older cores may still broadcast retired feature keys (e.g. the removed
// execution_operation_drain experiment); the schema catchall must tolerate
// them without projecting them into support or affecting readiness.
test("CLI adapter tolerates unknown broadcast feature keys without affecting negotiated support", async () => {
  const capabilitiesWithUnknownFeatures = {
    ...structuredCapabilities,
    selected_writer: "session/2.0",
    public_extensions: { artifact_contract: "1.0" },
    features: {
      ...structuredCapabilities.features,
      execution_operation_drain: true,
      some_future_feature: false,
    },
  };
  const adapter = new RunCliAdapter("D:/workspace", async (args) => {
    if (args.join(" ") === "capabilities --json") return ok(args, JSON.stringify(capabilitiesWithUnknownFeatures));
    if (args.join(" ") === "run --help") return ok(args, "Commands:\n  brief\n");
    return fail(args, "unknown command");
  });
  const capabilities = await adapter.capabilities();
  assert.equal(capabilities.mode, "structured");
  assert.equal(capabilities.structured?.selected_writer, "session/2.0");
  assert.deepEqual(capabilities.structured?.public_extensions, { artifact_contract: "1.0" });
  assert.deepEqual(capabilities.support, {
    execution_generation: true,
    core_execution_lease: true,
    "run-response/1.1": true,
    "run-response/1.2": true,
    artifact_compatibility_v1: true,
    atomic_run_complete_seal: true,
    generation_scoped_seal_receipts: true,
  });
  assert.equal(await adapter.supportsNewMutations(), true);
});

test("machine exec returns a parseable redacted nonzero run-response with exit parity intact", async () => {
  const envelope = {
    schema_version: "run-response/1.1",
    operation: "execution-pause",
    ok: false,
    exit_code: 3,
    disposition: "control_flow",
    request_id: "request-error",
    locator: { session_id: "session-1", execution_id: "execution-1", generation: 1, run_id: "run-1" },
    fence: {
      session_identity_revision: 1,
      session_activity_revision: 2,
      execution_revision: 3,
      lease_epoch: 4,
    },
    result: null,
    next: null,
    continuation: null,
    replay: null,
    warnings: [],
    error: {
      code: "LEASE_BUSY",
      message: "CLI rejected private-argv; lease_id=private-message handoff_token=private-message-token",
      retryable: true,
      details: { lease_id: "private-detail", handoff_token: "private-detail-token", visible: true },
      recovery_command: "maestro execution attach --lease-id private-recovery",
    },
  };
  const adapter = new RunCliAdapter("D:/workspace", async (args) => ({
    argv: [...args],
    stdout: JSON.stringify(envelope),
    stderr: "lease_claim={lease_id=private-stderr}",
    exitCode: 3,
  }));

  const result = await adapter.exec(["execution", "pause", "--lease-id", "private-argv", "--json"]);
  const parsed = JSON.parse(result.stdout) as typeof envelope;
  assert.equal(result.exitCode, 3);
  assert.equal(parsed.exit_code, 3);
  assert.equal(parsed.disposition, "control_flow");
  assert.equal(parsed.error.code, "LEASE_BUSY");
  assert.equal(parsed.error.details.visible, true);
  assert.equal(result.argv[result.argv.indexOf("--lease-id") + 1], "<redacted>");
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("legacy failures and invalid machine fallbacks redact argv, stdout, stderr, and runner errors", async (t) => {
  const secrets = ["private-positional", "private-lease", "private-output", "private-token"];
  const argv = [
    "execution", "handoff", "accept", secrets[0], "--lease-id", secrets[1], "--handoff-token", secrets[3],
  ];
  const assertRedacted = async (adapter: RunCliAdapter, args: readonly string[]) => {
    await assert.rejects(adapter.exec(args), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const secret of secrets) assert.equal(message.includes(secret), false, message);
      assert.match(message, /<redacted>/);
      return true;
    });
  };

  await t.test("legacy stderr", async () => {
    await assertRedacted(new RunCliAdapter("D:/workspace", async (args) => ({
      argv: [...args], stdout: "", stderr: `CLI rejected ${secrets[1]}; lease_claim={lease_id=${secrets[2]}} handoff_token=${secrets[3]}`, exitCode: 1,
    })), argv);
  });
  await t.test("invalid machine stdout fallback", async () => {
    await assertRedacted(new RunCliAdapter("D:/workspace", async (args) => ({
      argv: [...args], stdout: `CLI rejected ${secrets[0]}; lease_claim={lease_id=${secrets[2]}} --handoff-token ${secrets[3]}`, stderr: "", exitCode: 1,
    })), [...argv, "--json"]);
  });
  await t.test("runner-thrown error", async () => {
    await assertRedacted(new RunCliAdapter("D:/workspace", async () => {
      throw new Error(`CLI rejected ${secrets[1]}; lease_id=${secrets[2]} handoff_token=${secrets[3]}`);
    }), argv);
  });
});

function fakeRunner(
  calls: string[][],
  implementation: (args: readonly string[]) => RunCliResult,
): RunCliRunner {
  return async (args) => {
    calls.push([...args]);
    return implementation(args);
  };
}

function ok(args: readonly string[], stdout: string): RunCliResult {
  return { argv: [...args], stdout, stderr: "", exitCode: 0 };
}

function fail(args: readonly string[], stderr: string): RunCliResult {
  return { argv: [...args], stdout: "", stderr, exitCode: 1 };
}
