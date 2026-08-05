import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { createSkillsSettingsProvider } from "../src/settings/skills-settings-provider.ts";

interface Harness {
  provider: ReturnType<typeof createSkillsSettingsProvider>;
  projectDir: string;
  agentDir: string;
  context: SettingsContextV1;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "skills-settings-e2e-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await writeSkill(projectDir, "team-one");
  await writeSkill(projectDir, "solo");
  const provider = createSkillsSettingsProvider({
    getProjectPath: () => projectDir,
    getAgentDir: () => agentDir,
  });
  return { provider, projectDir, agentDir, context: { cwd: projectDir, locale: "en" } };
}

test("skills settings read surfaces every skill with enabled state and overview rows", async () => {
  const { provider, context } = await harness();
  const snapshot = await provider.read({ context });

  const items = snapshot.effective.values.find((entry) => entry.key === "skills.enabled")?.value as Array<Record<string, unknown>>;
  const teamOne = items.find((item) => item.name === "team-one");
  const solo = items.find((item) => item.name === "solo");
  assert.ok(teamOne && solo, "project skills are listed alongside any user-level skills");
  assert.equal(teamOne.enabled, true, "skills resolve as enabled by default");
  assert.equal(teamOne.disableModelInvocation, false);
  assert.equal(solo.enabled, true);

  const rows = snapshot.effective.values.find((entry) => entry.key === "skills.overview")?.value as Array<Record<string, unknown>>;
  assert.ok(rows.some((row) => row.labelKey === "skills.overview.total" && row.value === String(items.length)));
  assert.ok(rows.some((row) => row.labelKey === "skills.overview.enabled" && /^\d+\/\d+$/.test(String(row.value))));
  assert.ok(rows.some((row) => row.labelKey === "skills.overview.file"));
  assert.ok(rows.some((row) => row.labelKey === "skills.overview.package"));
});

test("skills settings validates that every item has a non-empty name", async () => {
  const { provider, context } = await harness();
  const invalid = await provider.validate!({
    context,
    transactionId: "tx-skills-1",
    changes: [
      { operation: "set", key: "skills.enabled", scope: "global", value: [
        { enabled: true },
        { name: "", enabled: true },
      ] },
    ],
  });
  assert.equal(invalid.valid, false);

  const valid = await provider.validate!({
    context,
    transactionId: "tx-skills-1",
    changes: [
      { operation: "set", key: "skills.enabled", scope: "global", value: [
        { name: "team-one", enabled: true },
        { name: "solo", enabled: false },
      ] },
    ],
  });
  assert.equal(valid.valid, true);
});

test("skills settings commit writes enablement and model invocation into project skill config", async () => {
  const { provider, projectDir, context } = await harness();
  await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    skills: { "team-one": { params: { tone: "brief" }, updated: "2026-07-23" } },
    groups: { favorites: { skills: ["team-one"] } },
  }));

  const transactionId = "tx-skills-2";
  const prepared = await provider.prepare!({
    context,
    transactionId,
    changes: [
      { operation: "set", key: "skills.enabled", scope: "global", value: [
        { name: "team-one", enabled: false, disableModelInvocation: true },
        { name: "solo", enabled: true, disableModelInvocation: false },
      ] },
    ],
    expectedRevisions: [],
  });
  assert.equal(prepared.prepared, true);
  const committed = await provider.commit!({ context, transactionId, prepareToken: transactionId });
  assert.ok(committed.changedKeys.includes("skills.enabled"));

  const config = JSON.parse(await readFile(join(projectDir, ".pi", "skill-config.json"), "utf8")) as {
    version: string;
    groups: Record<string, unknown>;
    skills: Record<string, { enabled?: boolean; "disable-model-invocation"?: boolean; params?: unknown; updated?: string }>;
  };
  assert.equal(config.version, "1.0.0");
  assert.equal(config.skills["team-one"]?.enabled, false);
  assert.equal(config.skills["team-one"]?.["disable-model-invocation"], true);
  assert.deepEqual(config.skills["team-one"]?.params, { tone: "brief" }, "existing skill config fields are preserved");
  assert.equal(config.skills["team-one"]?.updated, "2026-07-23");
  assert.equal(config.skills["solo"]?.enabled, true);
  assert.equal(config.skills["solo"]?.["disable-model-invocation"], false);
  assert.deepEqual(config.groups, { favorites: { skills: ["team-one"] } }, "groups are preserved");
});

test("skills settings rollback restores the previous project skill config", async () => {
  const { provider, projectDir, context } = await harness();
  await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    skills: { "team-one": { params: { tone: "brief" } } },
  }));

  const transactionId = "tx-skills-3";
  await provider.prepare!({
    context,
    transactionId,
    changes: [
      { operation: "set", key: "skills.enabled", scope: "global", value: [
        { name: "team-one", enabled: false, disableModelInvocation: true },
      ] },
    ],
    expectedRevisions: [],
  });
  await provider.commit!({ context, transactionId, prepareToken: transactionId });
  const written = JSON.parse(await readFile(join(projectDir, ".pi", "skill-config.json"), "utf8")) as {
    skills: Record<string, { enabled?: boolean }>;
  };
  assert.equal(written.skills["team-one"]?.enabled, false);

  const rolledBack = await provider.rollback!({
    context,
    transactionId,
    prepareToken: transactionId,
    committedRevisions: [],
  });
  assert.equal(rolledBack.rolledBack, true);
  const restored = JSON.parse(await readFile(join(projectDir, ".pi", "skill-config.json"), "utf8")) as {
    skills: Record<string, { enabled?: boolean; params?: unknown }>;
  };
  assert.equal(restored.skills["team-one"]?.enabled, undefined, "enabled field is removed on rollback");
  assert.deepEqual(restored.skills["team-one"]?.params, { tone: "brief" });
});

async function writeSkill(projectDir: string, name: string): Promise<void> {
  const directory = join(projectDir, ".pi", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---
name: ${name}
description: ${name} description
---
# ${name}
`);
}
