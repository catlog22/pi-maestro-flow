import assert from "node:assert/strict";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue, SettingsChange, SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { createClassifierSettingsProvider } from "../src/classifier/settings-provider.ts";
import type { FlowClassifierConfig } from "../src/classifier/config.ts";

const lockfile = createRequire(import.meta.url)("proper-lockfile");

const DOMAINS = [
  { name: "retry-error", modes: ["off", "shadow"] as const },
  { name: "file-value", modes: ["off", "shadow", "jev"] as const },
];

function harness(initial?: Record<string, unknown>, applied?: FlowClassifierConfig[]) {
  const directory = mkdtempSync(join(tmpdir(), "classifier-provider-"));
  const projectDir = join(directory, "project");
  const configPath = join(projectDir, ".pi", "classifier.json");
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  if (initial) writeFileSync(configPath, JSON.stringify(initial, null, 2));
  const provider = createClassifierSettingsProvider({
    getConfigPath: () => configPath,
    getDomains: () => DOMAINS.map((domain) => ({ name: domain.name, modes: [...domain.modes] })),
    apply: (config) => { applied?.push(config); },
  });
  const context: SettingsContextV1 = { cwd: projectDir, locale: "en" };
  return { provider, configPath, directory, context, applied };
}

function setChange(key: string, value: JsonValue): SettingsChange {
  return { operation: "set", key, scope: "project", value };
}

test("classifier provider describes scalars and one enum per domain", async () => {
  const { provider, directory } = harness();
  try {
    const description = await provider.describe({ context: { cwd: "/p", locale: "en" } });
    assert.equal(description.id, "pi-maestro-flow-classifier");
    const keys = description.settings.map((setting) => setting.key);
    assert.ok(keys.includes("classifier.enabled"));
    assert.ok(keys.includes("classifier.endpoint"));
    assert.ok(keys.includes("classifier.domains.retry-error"));
    assert.ok(keys.includes("classifier.domains.file-value"));
    // retry-error is shadow-only: the editor must not offer "jev".
    const retry = description.settings.find((s) => s.key === "classifier.domains.retry-error")!;
    assert.deepEqual(retry.editor.options?.map((option) => option.value), ["off", "shadow"]);
    const fileValue = description.settings.find((s) => s.key === "classifier.domains.file-value")!;
    assert.deepEqual(fileValue.editor.options?.map((option) => option.value), ["off", "shadow", "jev"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("read reports configured vs default state", async () => {
  const { provider, directory, context } = harness({ enabled: true, domains: { "retry-error": "shadow" } });
  try {
    const snapshot = await provider.read({ context });
    const configured = snapshot.configured.values;
    assert.equal(configured.find((v) => v.key === "classifier.enabled")?.state, "set");
    assert.equal(configured.find((v) => v.key === "classifier.domains.retry-error")?.state, "set");
    assert.equal(configured.find((v) => v.key === "classifier.model")?.state, "absent");
    const effective = snapshot.effective.values;
    assert.equal(effective.find((v) => v.key === "classifier.enabled")?.value, true);
    assert.equal(effective.find((v) => v.key === "classifier.domains.retry-error")?.value, "shadow");
    assert.equal(effective.find((v) => v.key === "classifier.domains.file-value")?.value, "off");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare+commit writes classifier.json and hot-applies the config", async () => {
  const applied: FlowClassifierConfig[] = [];
  const { provider, configPath, directory, context } = harness(undefined, applied);
  try {
    const prepared = await provider.prepare!({
      context,
      transactionId: "c1",
      changes: [
        setChange("classifier.enabled", true),
        setChange("classifier.endpoint", "openrouter"),
        setChange("classifier.model", "typesafe/jev-1.13"),
        setChange("classifier.domains.retry-error", "shadow"),
      ],
    });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "c1", prepareToken: prepared.prepareToken! });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.enabled, true);
    assert.equal(raw.endpoint, "openrouter");
    assert.equal(raw.model, "typesafe/jev-1.13");
    assert.equal((raw.domains as Record<string, unknown>)["retry-error"], "shadow");
    // Live apply fired with the committed config.
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.enabled, true);
    assert.equal(applied[0]?.domains["retry-error"], "shadow");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("endpoint auto unsets the field; empty model unsets it", async () => {
  const { provider, configPath, directory, context } = harness({ endpoint: "openrouter", model: "x" });
  try {
    const prepared = await provider.prepare!({
      context,
      transactionId: "c2",
      changes: [setChange("classifier.endpoint", "auto"), setChange("classifier.model", "")],
    });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "c2", prepareToken: prepared.prepareToken! });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.endpoint, undefined);
    assert.equal(raw.model, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const before of ["missing", "empty", "configured"] as const) {
  test(`rollback restores bytes, existence and runtime: ${before}`, async () => {
    const applied: FlowClassifierConfig[] = [];
    const { provider, configPath, directory, context } = harness(before === "configured" ? { enabled: false, model: "before" } : undefined, applied);
    if (before === "empty") writeFileSync(configPath, "");
    const beforeContent = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
    try {
      const prepared = await provider.prepare!({ context, transactionId: "rollback", changes: [setChange("classifier.enabled", true), setChange("classifier.model", "after")] });
      const committed = await provider.commit!({ context, transactionId: "rollback", prepareToken: prepared.prepareToken! });
      const result = await provider.rollback!({ context, transactionId: "rollback", prepareToken: prepared.prepareToken!, committedRevisions: committed.revisions });
      assert.equal(result.rolledBack, true);
      assert.equal(existsSync(configPath), before !== "missing");
      if (beforeContent !== undefined) assert.equal(readFileSync(configPath, "utf8"), beforeContent);
      assert.equal(applied.at(-1)?.enabled, false);
      assert.equal(applied.at(-1)?.model, before === "configured" ? "before" : undefined);
      assert.equal(result.snapshot?.effective.values.find((v) => v.key === "classifier.enabled")?.value, false);
      assert.ok(!existsSync(`${configPath}.lock`));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test(`failed commit restores file and runtime: ${before}`, async () => {
    const { configPath, directory, context } = harness(before === "configured" ? { enabled: false, model: "before" } : undefined);
    if (before === "empty") writeFileSync(configPath, "");
    const beforeContent = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
    const applied: FlowClassifierConfig[] = [];
    const provider = createClassifierSettingsProvider({
      getConfigPath: () => configPath,
      apply: (config) => {
        applied.push(config);
        if (applied.length === 1) {
          assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, true);
          throw new Error("live apply failed after mutation");
        }
      },
    });
    try {
      const prepared = await provider.prepare!({ context, transactionId: "failed", changes: [setChange("classifier.enabled", true)] });
      await assert.rejects(provider.commit!({ context, transactionId: "failed", prepareToken: prepared.prepareToken! }), /live apply failed/);
      assert.equal(existsSync(configPath), before !== "missing");
      if (beforeContent !== undefined) assert.equal(readFileSync(configPath, "utf8"), beforeContent);
      assert.equal(applied.length, 2);
      assert.equal(applied[1]?.enabled, false);
      assert.equal(applied[1]?.model, before === "configured" ? "before" : undefined);
      assert.equal((await provider.rollback!({ context, transactionId: "failed", prepareToken: prepared.prepareToken!, committedRevisions: [] })).rolledBack, false);
      assert.ok(!existsSync(`${configPath}.lock`));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("restoration errors remain visible and rollback can retry runtime restoration", async () => {
  const { configPath, directory, context } = harness({ enabled: false });
  let fail = true;
  const provider = createClassifierSettingsProvider({ getConfigPath: () => configPath, apply: () => { if (fail) throw new Error("apply unavailable"); } });
  try {
    const prepared = await provider.prepare!({ context, transactionId: "retry", changes: [setChange("classifier.enabled", true)] });
    await assert.rejects(provider.commit!({ context, transactionId: "retry", prepareToken: prepared.prepareToken! }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      return true;
    });
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, false);
    fail = false;
    assert.equal((await provider.rollback!({ context, transactionId: "retry", prepareToken: prepared.prepareToken!, committedRevisions: [] })).rolledBack, true);
    assert.ok(!existsSync(`${configPath}.lock`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("partial restoration failure preserves committed bytes and permits rollback retry", async (t) => {
  const { configPath, directory, context } = harness({ enabled: false, model: "before" });
  const before = readFileSync(configPath, "utf8");
  const original = fs.writeFileSync;
  let failWrite = false;
  let failApply = true;
  const applied: FlowClassifierConfig[] = [];
  const provider = createClassifierSettingsProvider({ getConfigPath: () => configPath, apply: (config) => {
    applied.push(config);
    if (failApply) { failWrite = true; throw new Error("apply failed"); }
  } });
  t.mock.method(fs, "writeFileSync", (target: Parameters<typeof original>[0], data: Parameters<typeof original>[1], options: Parameters<typeof original>[2]) => {
    if (failWrite) {
      original(target, "{");
      throw Object.assign(new Error("partial restoration"), { code: "ENOSPC" });
    }
    return original(target, data, options);
  });
  syncBuiltinESMExports();
  try {
    const prepared = await provider.prepare!({ context, transactionId: "partial", changes: [setChange("classifier.enabled", true)] });
    await assert.rejects(provider.commit!({ context, transactionId: "partial", prepareToken: prepared.prepareToken! }), /commit and restoration failed/);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, true);
    failWrite = false;
    failApply = false;
    const result = await provider.rollback!({ context, transactionId: "partial", prepareToken: prepared.prepareToken!, committedRevisions: [] });
    assert.equal(result.rolledBack, true);
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(applied.at(-1)?.enabled, false);
    assert.deepEqual(readdirSync(join(context.cwd, ".pi")), ["classifier.json"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed runtime finalization retains committed rollback state", async () => {
  const { configPath, directory, context } = harness({ enabled: false });
  let fail = false;
  const provider = createClassifierSettingsProvider({ getConfigPath: () => configPath, apply: () => { if (fail) throw new Error("runtime failed"); } });
  try {
    const changes = [setChange("classifier.enabled", true)];
    const prepared = await provider.prepare!({ context, transactionId: "runtime", changes });
    const committed = await provider.commit!({ context, transactionId: "runtime", prepareToken: prepared.prepareToken! });
    fail = true;
    assert.throws(() => provider.applyRuntime!({ context, transactionId: "runtime", changes, snapshot: committed.snapshot }), /runtime failed/);
    fail = false;
    assert.equal((await provider.rollback!({ context, transactionId: "runtime", prepareToken: prepared.prepareToken!, committedRevisions: committed.revisions })).rolledBack, true);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("settings writes reject symlinks at prepare, commit and rollback boundaries", async () => {
  for (const phase of ["prepare", "commit", "rollback"] as const) {
    const { provider, configPath, directory, context } = harness({ enabled: false });
    const target = join(directory, "shared.json");
    const changes = [setChange("classifier.enabled", true)];
    let token: string | undefined;
    const introduceLink = () => {
      writeFileSync(target, readFileSync(configPath, "utf8"));
      rmSync(configPath);
      symlinkSync(target, configPath, "file");
    };
    try {
      if (phase === "prepare") {
        introduceLink();
        await assert.rejects(provider.prepare!({ context, transactionId: "link", changes }), /regular file/);
      } else {
        const prepared = await provider.prepare!({ context, transactionId: "link", changes });
        token = prepared.prepareToken!;
        if (phase === "commit") {
          introduceLink();
          await assert.rejects(provider.commit!({ context, transactionId: "link", prepareToken: token }), /regular file/);
        } else {
          const committed = await provider.commit!({ context, transactionId: "link", prepareToken: token });
          introduceLink();
          await assert.rejects(provider.rollback!({ context, transactionId: "link", prepareToken: token, committedRevisions: committed.revisions }), /regular file/);
        }
      }
      assert.equal(lstatSync(configPath).isSymbolicLink(), true);
      assert.equal(JSON.parse(readFileSync(target, "utf8")).enabled, phase === "rollback");
    } finally {
      if (token) await provider.abort!({ context, transactionId: "link", prepareToken: token });
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("first save creates .pi before acquiring the lock", async () => {
  const { provider, configPath, directory, context } = harness();
  rmSync(join(context.cwd, ".pi"), { recursive: true });
  try {
    const prepared = await provider.prepare!({ context, transactionId: "first", changes: [setChange("classifier.enabled", true)] });
    assert.equal(prepared.prepared, true);
    await provider.commit!({ context, transactionId: "first", prepareToken: prepared.prepareToken! });
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const withRevision of [true, false]) {
  test(`prepare rereads under lock and ${withRevision ? "rejects stale revisions" : "preserves concurrent fields"}`, async () => {
    const { provider, configPath, directory, context } = harness({ enabled: false });
    const snapshot = await provider.read({ context });
    const release = await lockfile.lock(configPath, { realpath: false });
    try {
      const pending = provider.prepare!({ context, transactionId: "contended", changes: [setChange("classifier.enabled", true)], ...(withRevision ? { expectedRevisions: snapshot.configured.resources } : {}) });
      writeFileSync(configPath, JSON.stringify({ enabled: false, model: "concurrent" }));
      // An unrelated validate must not overwrite the pending request's CAS.
      await provider.validate({ context, transactionId: "other", changes: [] });
      await release();
      const prepared = await pending;
      assert.equal(prepared.prepared, !withRevision);
      if (withRevision) {
        assert.equal(prepared.validation.conflicts?.length, 1);
        assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, false);
      } else {
        await provider.commit!({ context, transactionId: "contended", prepareToken: prepared.prepareToken! });
        assert.equal(JSON.parse(readFileSync(configPath, "utf8")).model, "concurrent");
      }
      assert.ok(!existsSync(`${configPath}.lock`));
    } finally { await release().catch(() => undefined); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("rollback before commit only cleans staging, and committed rollback respects external writes", async () => {
  const { provider, configPath, directory, context } = harness({ enabled: false });
  try {
    const prepared = await provider.prepare!({ context, transactionId: "uncommitted", changes: [setChange("classifier.enabled", true)] });
    writeFileSync(configPath, JSON.stringify({ model: "external" }));
    assert.equal((await provider.rollback!({ context, transactionId: "uncommitted", prepareToken: prepared.prepareToken!, committedRevisions: [] })).rolledBack, false);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).model, "external");
    assert.deepEqual(readdirSync(join(context.cwd, ".pi")), ["classifier.json"]);
    const next = await provider.prepare!({ context, transactionId: "committed", changes: [setChange("classifier.enabled", true)] });
    const committed = await provider.commit!({ context, transactionId: "committed", prepareToken: next.prepareToken! });
    writeFileSync(configPath, JSON.stringify({ model: "newer" }));
    assert.equal((await provider.rollback!({ context, transactionId: "committed", prepareToken: next.prepareToken!, committedRevisions: committed.revisions })).rolledBack, false);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).model, "newer");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("env effective values and provenance match commit, runtime apply and rollback without persisting overrides", async () => {
  const envKeys = ["PI_CLASSIFIER", "PI_CLASSIFIER_ENDPOINT", "PI_CLASSIFIER_MODEL"];
  const saved = envKeys.map((key) => process.env[key]);
  const applied: FlowClassifierConfig[] = [];
  const { provider, configPath, directory, context } = harness({ enabled: true, endpoint: "openrouter", model: "file" }, applied);
  try {
    process.env.PI_CLASSIFIER = "0";
    process.env.PI_CLASSIFIER_ENDPOINT = " typesafe ";
    process.env.PI_CLASSIFIER_MODEL = " env-model ";
    const snapshot = await provider.read({ context });
    for (const [key, expected, envKey] of [["classifier.enabled", false, "PI_CLASSIFIER"], ["classifier.endpoint", "typesafe", "PI_CLASSIFIER_ENDPOINT"], ["classifier.model", "env-model", "PI_CLASSIFIER_MODEL"]] as const) {
      const effective = snapshot.effective.values.find((v) => v.key === key)!;
      assert.equal(effective.value, expected);
      assert.equal(effective.source, "runtime");
      assert.equal(effective.resource?.id, `env:${envKey}`);
      assert.equal(snapshot.configured.values.find((v) => v.key === key)?.messageKey, "classifier.settings.envOverride");
    }
    assert.equal(snapshot.configured.values.find((v) => v.key === "classifier.enabled")?.value, true);
    const changes = [setChange("classifier.enabled", true), setChange("classifier.model", "new-file")];
    const prepared = await provider.prepare!({ context, transactionId: "env", changes });
    const committed = await provider.commit!({ context, transactionId: "env", prepareToken: prepared.prepareToken! });
    assert.equal(applied.at(-1)?.enabled, false);
    assert.equal(applied.at(-1)?.endpoint, "typesafe");
    assert.equal(applied.at(-1)?.model, "env-model");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).model, "new-file");
    await provider.rollback!({ context, transactionId: "env", prepareToken: prepared.prepareToken!, committedRevisions: committed.revisions });
    assert.equal(applied.at(-1)?.enabled, false);
    await provider.applyRuntime!({ context, transactionId: "runtime", changes, snapshot: committed.snapshot });
    assert.equal(applied.at(-1)?.model, "env-model");
    process.env.PI_CLASSIFIER = "1";
    const enabled = await provider.read({ context });
    assert.equal(enabled.effective.values.find((v) => v.key === "classifier.enabled")?.value, true);
    process.env.PI_CLASSIFIER_ENDPOINT = "invalid";
    process.env.PI_CLASSIFIER_MODEL = " ";
    delete process.env.PI_CLASSIFIER;
    const configured = await provider.read({ context });
    assert.equal(configured.effective.values.find((v) => v.key === "classifier.endpoint")?.source, "configured");
    assert.equal(configured.effective.values.find((v) => v.key === "classifier.model")?.value, "file");
  } finally {
    envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing and empty files have distinct revisions", async () => {
  const { provider, configPath, directory, context } = harness();
  try {
    const missing = await provider.read({ context });
    writeFileSync(configPath, "");
    const empty = await provider.read({ context });
    assert.notEqual(missing.configured.resources[0]?.etag, empty.configured.resources[0]?.etag);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("validation rejects unsupported domain modes and unknown keys", async () => {
  const { provider, directory, context } = harness();
  try {
    const unsupported = await provider.validate({
      context,
      transactionId: "c3",
      changes: [setChange("classifier.domains.retry-error", "jev")],
    });
    assert.equal(unsupported.valid, false);
    const unknown = await provider.validate({
      context,
      transactionId: "c3",
      changes: [setChange("classifier.domains.nope", "shadow")],
    });
    assert.equal(unknown.valid, false);
    const badScope = await provider.validate({
      context,
      transactionId: "c3",
      changes: [{ operation: "set", key: "classifier.enabled", scope: "global", value: true }],
    });
    assert.equal(badScope.valid, false);
    const ok = await provider.validate({
      context,
      transactionId: "c3",
      changes: [setChange("classifier.domains.retry-error", "shadow")],
    });
    assert.equal(ok.valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
