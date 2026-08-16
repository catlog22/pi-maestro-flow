import assert from "node:assert/strict";
import test from "node:test";
import type {
  BackendCapabilities,
  ResolvedBackendConfig,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";
import { resolveBackendConfig } from "pi-maestro-backends";

const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native",
  forkContext: "unsupported",
  modelSelection: "native",
  thinkingLevel: "unsupported",
  todoBinding: "emulated",
  toolFilter: "unsupported",
  steer: "emulated",
  followUp: "native",
  abort: "emulated",
};

function backend(overrides: Partial<TeammateBackend> = {}): TeammateBackend {
  return {
    name: "dsh",
    protocolVersion: 1,
    capabilities: () => CAPABILITIES,
    recoveryShape: "in-context-continuation",
    start: () => {
      throw new Error("not started in these tests");
    },
    ...overrides,
  };
}

const DSH_FIELDS = [
  {
    key: "profile",
    kind: "enum" as const,
    labelKey: "dsh.profile",
    options: [
      { value: "auto", labelKey: "dsh.profile.auto" },
      { value: "headless", labelKey: "dsh.profile.headless" },
      { value: "jsonrpc", labelKey: "dsh.profile.jsonrpc" },
    ],
    default: "auto",
  },
  { key: "command", kind: "text" as const, labelKey: "dsh.command", default: "dsh-jsonrpc-agent" },
  { key: "cordisConfig", kind: "path" as const, labelKey: "dsh.cordisConfig", required: true },
];

/** Resolves `auto` to a concrete profile. */
function resolveDsh(values: Record<string, string | number | boolean | readonly string[]>): ResolvedBackendConfig {
  if (values.profile !== "auto") return { values, errors: [] };
  return { values: { ...values, profile: "jsonrpc" }, errors: [] };
}

test("a backend accepting no configuration rejects any key it is given", () => {
  const resolved = resolveBackendConfig(backend(), { profile: "headless" });
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /accepts no configuration/);
});

test("declared fields without resolveConfig are a registration error, not skipped validation", () => {
  const resolved = resolveBackendConfig(backend({ configFields: DSH_FIELDS }), {
    cordisConfig: "/etc/dsh/cordis.yml",
  });
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /implements no resolveConfig/);
});

test("an unknown key names the known keys instead of being ignored", () => {
  const resolved = resolveBackendConfig(
    backend({ configFields: DSH_FIELDS, resolveConfig: resolveDsh }),
    { cordisConfig: "/etc/dsh/cordis.yml", profil: "headless" },
  );
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /no setting "profil"/);
  assert.match(resolved.errors[0]!, /profile, command, cordisConfig/);
});

test("an out-of-range enum value lists what was allowed", () => {
  const resolved = resolveBackendConfig(
    backend({ configFields: DSH_FIELDS, resolveConfig: resolveDsh }),
    { cordisConfig: "/etc/dsh/cordis.yml", profile: "tui" },
  );
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /expected one of auto \| headless \| jsonrpc, got "tui"/);
});

test("a required field with no value and no default is rejected", () => {
  const resolved = resolveBackendConfig(
    backend({ configFields: DSH_FIELDS, resolveConfig: resolveDsh }),
    {},
  );
  assert.deepEqual(resolved.errors, ['backend "dsh" requires setting "cordisConfig"']);
});

test("defaults apply and auto resolves to a concrete value at registration", () => {
  const resolved = resolveBackendConfig(
    backend({ configFields: DSH_FIELDS, resolveConfig: resolveDsh }),
    { cordisConfig: "/etc/dsh/cordis.yml" },
  );
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.values.command, "dsh-jsonrpc-agent");
  // Resolution happens once, here — not as a `?? default` inside start(), which
  // would leave the effective mode knowable only by re-deriving it.
  assert.equal(resolved.values.profile, "jsonrpc");
});

test("an explicit profile is passed through unresolved", () => {
  const resolved = resolveBackendConfig(
    backend({ configFields: DSH_FIELDS, resolveConfig: resolveDsh }),
    { cordisConfig: "/etc/dsh/cordis.yml", profile: "headless" },
  );
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.values.profile, "headless");
});

test("type mismatches are reported per field", () => {
  const resolved = resolveBackendConfig(
    backend({
      configFields: [
        { key: "timeoutMs", kind: "integer", labelKey: "t" },
        { key: "verbose", kind: "boolean", labelKey: "v" },
        { key: "args", kind: "string-list", labelKey: "a" },
      ],
      resolveConfig: (values) => ({ values, errors: [] }),
    }),
    { timeoutMs: 1.5, verbose: "yes", args: ["--x", 3] as unknown as readonly string[] },
  );
  assert.equal(resolved.errors.length, 3);
  assert.match(resolved.errors[0]!, /expected an integer, got 1.5/);
  assert.match(resolved.errors[1]!, /expected a boolean, got string/);
  assert.match(resolved.errors[2]!, /expected every item to be a string/);
});
