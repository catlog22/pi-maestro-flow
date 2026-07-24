import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDefaultSoftCompaction,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_SOFT_COMPACTION,
  readEffectiveCompactionSettings,
  readScopeCompaction,
  resolveEffectiveCompactionSettings,
  resolveProjectSettingsPath,
  resolveUserSettingsPath,
  saveCompactionPatch,
  saveCompactionScope,
  unsetCompactionField,
  validateCompactionPatch,
  validateEffectiveCompactionSettings,
} from "../src/compaction/compaction-settings.ts";

test("compaction settings use the Pi default user path when the agent directory is unset", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    assert.equal(resolveUserSettingsPath(), join(homedir(), ".pi", "agent", "settings.json"));
  } finally {
    if (previousAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("compaction settings resolve paths, precedence, and field-level sources", async () => {
  const fixture = await createFixture();
  try {
    assert.equal(resolveUserSettingsPath(), join(fixture.agentDir, "settings.json"));
    assert.equal(resolveProjectSettingsPath(fixture.projectDir), join(fixture.projectDir, ".pi", "settings.json"));
    assert.deepEqual(readEffectiveCompactionSettings(fixture.projectDir), {
      enabled: true,
      reserveTokens: DEFAULT_RESERVE_TOKENS,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      soft: { ...DEFAULT_SOFT_COMPACTION },
      source: {
        enabled: "default",
        reserveTokens: "default",
        keepRecentTokens: "default",
        soft: "default",
      },
    });

    await writeSettings(fixture.agentDir, {
      compaction: { enabled: false, reserveTokens: 24_000 },
    });
    await writeSettings(join(fixture.projectDir, ".pi"), {
      compaction: { enabled: true, keepRecentTokens: 12_000 },
    });

    assert.deepEqual(readScopeCompaction("user", fixture.projectDir), {
      enabled: false,
      reserveTokens: 24_000,
    });
    assert.deepEqual(readEffectiveCompactionSettings(fixture.projectDir), {
      enabled: true,
      reserveTokens: 24_000,
      keepRecentTokens: 12_000,
      soft: { ...DEFAULT_SOFT_COMPACTION },
      source: {
        enabled: "project",
        reserveTokens: "user",
        keepRecentTokens: "project",
        soft: "default",
      },
    });
  } finally {
    await fixture.dispose();
  }
});

test("compaction settings ignore malformed files and invalid optional fields", async () => {
  const fixture = await createFixture();
  try {
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(join(fixture.agentDir, "settings.json"), "{ malformed", "utf8");
    await writeSettings(join(fixture.projectDir, ".pi"), {
      compaction: {
        enabled: "yes",
        reserveTokens: -1,
        keepRecentTokens: Number.NaN,
      },
    });

    assert.deepEqual(readEffectiveCompactionSettings(fixture.projectDir), {
      enabled: true,
      reserveTokens: DEFAULT_RESERVE_TOKENS,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      soft: { ...DEFAULT_SOFT_COMPACTION },
      source: {
        enabled: "default",
        reserveTokens: "default",
        keepRecentTokens: "default",
        soft: "default",
      },
    });
    await assert.rejects(
      saveCompactionScope("user", fixture.projectDir, { enabled: false }),
      /Cannot safely update malformed settings file/,
    );
    assert.equal(await readFile(join(fixture.agentDir, "settings.json"), "utf8"), "{ malformed");
  } finally {
    await fixture.dispose();
  }
});

test("compaction writes preserve unknown keys and unset restores inheritance", async () => {
  const fixture = await createFixture();
  try {
    await writeSettings(fixture.agentDir, {
      theme: "night",
      compaction: {
        enabled: false,
        reserveTokens: 30_000,
        vendorOption: { retained: true },
      },
    });
    await writeSettings(join(fixture.projectDir, ".pi"), {
      model: "test-model",
      compaction: {
        reserveTokens: 10_000,
        projectOption: "keep",
      },
    });

    await saveCompactionPatch("project", fixture.projectDir, {
      enabled: true,
      keepRecentTokens: 8_000,
    });
    let project = await readJson(resolveProjectSettingsPath(fixture.projectDir));
    assert.deepEqual(project, {
      model: "test-model",
      compaction: {
        projectOption: "keep",
        hard: { reserveTokens: 10_000, keepRecentTokens: 8_000 },
        enabled: true,
      },
    });

    await unsetCompactionField("project", fixture.projectDir, "reserveTokens");
    project = await readJson(resolveProjectSettingsPath(fixture.projectDir));
    assert.deepEqual(project, {
      model: "test-model",
      compaction: {
        projectOption: "keep",
        hard: { keepRecentTokens: 8_000 },
        enabled: true,
      },
    });
    assert.equal(readEffectiveCompactionSettings(fixture.projectDir).reserveTokens, 30_000);
    assert.equal(readEffectiveCompactionSettings(fixture.projectDir).source.reserveTokens, "user");
  } finally {
    await fixture.dispose();
  }
});

test("compaction writes are atomic and serialized per settings path", async () => {
  const fixture = await createFixture();
  try {
    await Promise.all([
      saveCompactionPatch("project", fixture.projectDir, { enabled: false }),
      saveCompactionPatch("project", fixture.projectDir, { reserveTokens: 9_000 }),
      saveCompactionPatch("project", fixture.projectDir, { keepRecentTokens: 7_000 }),
    ]);

    const settingsPath = resolveProjectSettingsPath(fixture.projectDir);
    assert.deepEqual(await readJson(settingsPath), {
      compaction: {
        enabled: false,
        hard: { reserveTokens: 9_000, keepRecentTokens: 7_000 },
      },
    });
    const siblings = await readdir(join(fixture.projectDir, ".pi"));
    assert.deepEqual(siblings, ["settings.json"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    }
  } finally {
    await fixture.dispose();
  }
});

test("compaction validation separates hard errors from warnings", () => {
  assert.deepEqual(validateCompactionPatch({
    reserveTokens: 0,
    keepRecentTokens: 1.5,
  }, 100_000, 20_000), {
    errors: [
      "reserveTokens must be a positive safe integer",
      "keepRecentTokens must be a positive safe integer",
    ],
    warnings: [],
  });

  assert.deepEqual(validateCompactionPatch({
    reserveTokens: 100_000,
    keepRecentTokens: 20_000,
  }, 100_000, 20_000), {
    errors: ["reserveTokens (100000) must be less than contextWindow (100000)"],
    warnings: [],
  });

  const result = validateCompactionPatch({
    reserveTokens: 10_000,
    keepRecentTokens: 95_000,
  }, 100_000, 20_000);
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings[0] ?? "", /little compressible history/);
  assert.match(result.warnings[1] ?? "", /single response/);
  assert.match(validateCompactionPatch({ reserveTokens: 10_000 }).warnings[0] ?? "", /validation skipped/);
});

test("compaction settings read legacy flat config without migration and default the soft group", async () => {
  const fixture = await createFixture();
  try {
    await writeSettings(join(fixture.projectDir, ".pi"), {
      compaction: { reserveTokens: 18_000, keepRecentTokens: 15_000 },
    });
    const effective = readEffectiveCompactionSettings(fixture.projectDir);
    assert.equal(effective.reserveTokens, 18_000);
    assert.equal(effective.keepRecentTokens, 15_000);
    assert.deepEqual(effective.soft, { ...DEFAULT_SOFT_COMPACTION });
    assert.equal(effective.source.soft, "default");
  } finally {
    await fixture.dispose();
  }
});

test("compaction settings read nested hard and soft groups with soft sourced per scope", async () => {
  const fixture = await createFixture();
  try {
    await writeSettings(join(fixture.projectDir, ".pi"), {
      compaction: {
        hard: { reserveTokens: 22_000, keepRecentTokens: 17_000 },
        soft: { nudgeRatio: 0.6, pruneRatio: 0.75, pruneTargetRatio: 0.55 },
      },
    });
    const effective = readEffectiveCompactionSettings(fixture.projectDir);
    assert.equal(effective.reserveTokens, 22_000);
    assert.equal(effective.keepRecentTokens, 17_000);
    assert.deepEqual(effective.soft, {
      ...DEFAULT_SOFT_COMPACTION,
      nudgeRatio: 0.6,
      pruneRatio: 0.75,
      pruneTargetRatio: 0.55,
    });
    assert.equal(effective.source.soft, "project");
  } finally {
    await fixture.dispose();
  }
});

test("compaction scope writes persist the soft group and preserve it when absent", async () => {
  const fixture = await createFixture();
  try {
    await saveCompactionScope("project", fixture.projectDir, {
      reserveTokens: 12_000,
      soft: { enabled: true, nudgeRatio: 0.5, pruneRatio: 0.7, pruneTargetRatio: 0.5 },
    });
    let project = await readJson(resolveProjectSettingsPath(fixture.projectDir));
    assert.deepEqual(project, {
      compaction: {
        hard: { reserveTokens: 12_000 },
        soft: { enabled: true, nudgeRatio: 0.5, pruneRatio: 0.7, pruneTargetRatio: 0.5 },
      },
    });
    await saveCompactionScope("project", fixture.projectDir, { reserveTokens: 13_000 });
    project = await readJson(resolveProjectSettingsPath(fixture.projectDir));
    assert.deepEqual(project, {
      compaction: {
        hard: { reserveTokens: 13_000 },
        soft: { enabled: true, nudgeRatio: 0.5, pruneRatio: 0.7, pruneTargetRatio: 0.5 },
      },
    });
  } finally {
    await fixture.dispose();
  }
});

test("compaction validation rejects invalid soft ratios and ordering", () => {
  const invalid = validateCompactionPatch({
    soft: { nudgeRatio: 1.5, pruneRatio: 0.5, pruneTargetRatio: 0.9 },
  }, 100_000, 20_000);
  assert.ok(invalid.errors.includes("soft.nudgeRatio must be a number in (0, 1)"));
  assert.ok(invalid.errors.includes("soft.pruneTargetRatio (0.9) must be less than soft.pruneRatio (0.5)"));

  const ordering = validateCompactionPatch({
    soft: { nudgeRatio: 0.8, pruneRatio: 0.7 },
  }, 100_000, 20_000);
  assert.ok(ordering.errors.includes("soft.nudgeRatio (0.8) must be less than soft.pruneRatio (0.7)"));

  const valid = validateCompactionPatch({
    soft: { nudgeRatio: 0.6, pruneRatio: 0.8, pruneTargetRatio: 0.6 },
  }, 100_000, 20_000);
  assert.equal(valid.errors.length, 0);
});

test("soft signal criteria default to disabled so unresolved settings keep ratio-only behavior", () => {
  const effective = resolveEffectiveCompactionSettings({}, {});
  assert.deepEqual(effective.soft.velocity, { enabled: false, epochsToCritical: 3, minFullness: 0.7 });
  assert.deepEqual(effective.soft.cache, { enabled: false });
});

test("soft signal criteria deep-merge across user and project scopes field by field", () => {
  const effective = resolveEffectiveCompactionSettings(
    { soft: { velocity: { enabled: true } } },
    { soft: { velocity: { minFullness: 0.5 }, cache: { enabled: true } } },
  );
  // project minFullness must not clobber user-level enabled
  assert.deepEqual(effective.soft.velocity, { enabled: true, epochsToCritical: 3, minFullness: 0.5 });
  assert.deepEqual(effective.soft.cache, { enabled: true });
});

test("createDefaultSoftCompaction returns independent nested objects", () => {
  const a = createDefaultSoftCompaction();
  a.velocity.enabled = true;
  a.velocity.minFullness = 0.99;
  a.cache.enabled = true;
  const b = createDefaultSoftCompaction();
  assert.equal(b.velocity.enabled, false);
  assert.equal(b.velocity.minFullness, 0.7);
  assert.equal(b.cache.enabled, false);
  assert.equal(DEFAULT_SOFT_COMPACTION.velocity.enabled, false);
});

test("validateEffectiveCompactionSettings accepts defaults and rejects invalid merged invariants", () => {
  const ok = resolveEffectiveCompactionSettings({}, {});
  assert.equal(validateEffectiveCompactionSettings(ok).errors.length, 0);

  const bad = resolveEffectiveCompactionSettings(
    { soft: { nudgeRatio: 0.9, pruneRatio: 0.8 } },
    {},
  );
  const errors = validateEffectiveCompactionSettings(bad).errors;
  assert.ok(errors.includes("soft.nudgeRatio (0.9) must be less than soft.pruneRatio (0.8)"));
});

test("compaction validation rejects invalid velocity signal fields", () => {
  const invalid = validateCompactionPatch({
    soft: { velocity: { epochsToCritical: 0, minFullness: 1.5 } },
  });
  assert.ok(invalid.errors.includes("soft.velocity.epochsToCritical must be a positive safe integer"));
  assert.ok(invalid.errors.includes("soft.velocity.minFullness must be a number in (0, 1)"));

  const valid = validateCompactionPatch({
    soft: { velocity: { enabled: true, epochsToCritical: 3, minFullness: 0.7 } },
  });
  assert.equal(valid.errors.length, 0);
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-settings-"));
  const projectDir = join(root, "project");
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return {
    projectDir,
    agentDir,
    async dispose() {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeSettings(directory: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
