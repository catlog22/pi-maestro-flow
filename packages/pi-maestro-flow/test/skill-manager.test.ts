import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyntheticSourceInfo, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { applySkillModelInvocationConfig, registerSkillManager } from "../src/skills/skill-manager.ts";
import { SkillManagerStore } from "../src/skills/skill-manager-store.ts";
import {
  SkillManagerOverlay,
  type SkillManagerAction,
} from "../src/skills/skill-manager-tui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

test("SkillManagerStore groups by prefix and persists group switches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-manager-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await writeSkill(projectDir, "team-one");
  await writeSkill(projectDir, "team-two");
  await writeSkill(projectDir, "solo");
  await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    groups: { favorites: { skills: ["team-two"] } },
  }));

  try {
    const store = new SkillManagerStore(projectDir, agentDir);
    let snapshot = await store.load();
    assert.deepEqual(snapshot.groups.find((group) => group.name === "favorites"), {
      name: "favorites",
      custom: true,
      skills: [snapshot.skills.find((skill) => skill.name === "team-two")],
    });
    assert.deepEqual(snapshot.groups.find((group) => group.name === "team")?.skills.map((skill) => skill.name), ["team-one"]);
    assert.ok(snapshot.groups.find((group) => group.name === "其他")?.skills.some((skill) => skill.name === "solo"));

    const team = snapshot.groups.find((group) => group.name === "team");
    assert.ok(team);
    snapshot = await store.toggleGroupEnabled(team);
    assert.equal(snapshot.skills.find((skill) => skill.name === "team-one")?.enabled, false);
    assert.equal(snapshot.skills.find((skill) => skill.name === "team-two")?.enabled, true);

    const favorites = snapshot.groups.find((group) => group.name === "favorites");
    assert.ok(favorites);
    snapshot = await store.toggleGroupModelInvocation(favorites);
    assert.equal(snapshot.skills.find((skill) => skill.name === "team-two")?.disableModelInvocation, true);

    snapshot = await store.createGroup("review");
    snapshot = await store.assignSkillToGroup("solo", "review");
    assert.deepEqual(snapshot.groups.find((group) => group.name === "review")?.skills.map((skill) => skill.name), ["solo"]);
    snapshot = await store.deleteGroup("review");
    assert.deepEqual(snapshot.groups.find((group) => group.name === "其他")?.skills.map((skill) => skill.name), ["solo"]);

    const settings = JSON.parse(await readFile(join(projectDir, ".pi", "settings.json"), "utf8")) as { skills: string[] };
    assert.ok(settings.skills.some((entry) => entry.startsWith("-") && entry.replaceAll("\\", "/").endsWith("skills/team-one/SKILL.md")));
    const config = JSON.parse(await readFile(join(projectDir, ".pi", "skill-config.json"), "utf8")) as {
      skills: Record<string, { "disable-model-invocation": boolean }>;
    };
    assert.equal(config.skills["team-two"]["disable-model-invocation"], true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Skill manager TUI supports group and skill actions with explicit filtering", () => {
  const skills = [
    managedSkill("team-one"),
    managedSkill("team-two"),
  ];
  const groups = [{ name: "team", custom: false, skills }];
  let action: SkillManagerAction | undefined;
  const overlay = new SkillManagerOverlay({
    skills,
    groups,
    theme: {
      fg(_role, text) { return text; },
      bold(text) { return text; },
    },
    requestRender() {},
    done(next) { action = next; },
  });

  for (let width = 1; width <= 120; width++) {
    for (const line of overlay.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }
  overlay.handleInput(" ");
  assert.equal(action?.kind, "toggle-enabled");
  assert.equal(action?.groupName, "team");

  action = undefined;
  const filtered = new SkillManagerOverlay({
    skills,
    groups,
    theme: {
      fg(_role, text) { return text; },
      bold(text) { return text; },
    },
    requestRender() {},
    done(next) { action = next; },
  });
  filtered.handleInput("/");
  filtered.handleInput("team-two");
  assert.match(filtered.render(80).join("\n"), /team-two/);
  assert.doesNotMatch(filtered.render(80).join("\n"), /team-one/);
  filtered.handleInput("G");
  assert.equal(action, undefined, "筛选模式不能触发字母功能键");
  filtered.handleInput("\x1b");
  filtered.handleInput("\x1b[B");
  filtered.handleInput("G");
  assert.equal(action?.kind, "assign-group");
  assert.equal(action?.skillPath, skills[0].filePath);
});

test("model invocation config rewrites only the native available-skills section", () => {
  const visible = skill("visible", false);
  const manual = skill("manual", true);
  const base = `Header${formatSkillsForPrompt([visible, manual])}\nCurrent date: 2026-07-23`;
  const next = applySkillModelInvocationConfig(base, [visible, manual], {
    visible: { params: {}, "disable-model-invocation": true },
    manual: { params: {}, "disable-model-invocation": false },
  });
  assert.doesNotMatch(next, /<name>visible<\/name>/);
  assert.match(next, /<name>manual<\/name>/);
  assert.match(next, /^Header/);
  assert.match(next, /Current date:/);
});

test("Skill manager registers its TUI command and model-visibility hook", () => {
  const commands = new Set<string>();
  const events = new Set<string>();
  registerSkillManager({
    registerCommand(name: string) { commands.add(name); },
    on(name: string) { events.add(name); },
  } as unknown as Parameters<typeof registerSkillManager>[0]);
  assert.deepEqual([...commands], ["skills"]);
  assert.ok(events.has("before_agent_start"));
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

function skill(name: string, disableModelInvocation: boolean): Skill {
  const filePath = `/skills/${name}/SKILL.md`;
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: `/skills/${name}`,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "project" }),
    disableModelInvocation,
  };
}

function managedSkill(name: string) {
  return {
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    enabled: true,
    disableModelInvocation: false,
    sourceDisableModelInvocation: false,
    scope: "project" as const,
    source: "auto",
    origin: "top-level" as const,
    readOnly: false,
  };
}
