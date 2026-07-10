import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  loadSkillConfig,
  renderSkillConfigDefaults,
} from "../src/skills/skill-config.ts";
import {
  TodoSkillLoadError,
  TodoSkillLoader,
} from "../src/skills/skill-loader.ts";

test("skill-config merges global, project, and explicit task args", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-config-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    skills: { demo: { params: { depth: "standard", mode: "global" } } },
    limits: { maxFileBytes: 4096, maxTotalBytes: 8192 },
  }));
  await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    skills: { demo: { params: { mode: "project", review: true } } },
  }));

  try {
    const { config } = await loadSkillConfig(projectDir, agentDir);
    assert.deepEqual(config.skills.demo.params, {
      depth: "standard",
      mode: "project",
      review: true,
    });
    const rendered = renderSkillConfigDefaults("demo", config.skills.demo, "--depth deep");
    assert.match(rendered ?? "", /mode: project/);
    assert.match(rendered ?? "", /review: true/);
    assert.doesNotMatch(rendered ?? "", /depth: standard/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader caches discovery and inlines required reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-loader-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const skillDir = join(projectDir, ".pi", "skills", "demo");
  await mkdir(skillDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(join(skillDir, "required.md"), "REQUIRED CONTENT");
  await writeFile(skillPath, `---
name: demo
description: demo skill
---
# Demo
<required_reading>
@required.md
</required_reading>
<deferred_reading>
@later.md
</deferred_reading>
`);
  await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    skills: { demo: { params: { depth: "standard" } } },
  }));

  let reloads = 0;
  const skill = {
    name: "demo",
    description: "demo skill",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  } satisfies Skill;
  const resourceLoader = {
    async reload() { reloads += 1; },
    getSkills() { return { skills: [skill], diagnostics: [] }; },
  };
  const loader = new TodoSkillLoader({ cwd: projectDir, agentDir, resourceLoader });

  try {
    const first = await loader.load({ name: "demo", args: "--depth deep" }, "inline context");
    const second = await loader.load({ name: "demo" });
    assert.equal(reloads, 1);
    assert.match(first.prompt, /REQUIRED CONTENT/);
    assert.doesNotMatch(first.prompt, /depth: standard/);
    assert.match(second.prompt, /depth: standard/);
    assert.deepEqual(first.requiredFiles, [join(skillDir, "required.md")]);
    assert.deepEqual(first.deferredFiles, [join(skillDir, "later.md")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader discovers project skills through Pi DefaultResourceLoader", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-native-discovery-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const skillDir = join(projectDir, ".pi", "skills", "native-demo");
  await mkdir(skillDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---
name: native-demo
description: native discovery
---
# Native discovery
`);

  try {
    const loader = new TodoSkillLoader({ cwd: projectDir, agentDir });
    const loaded = await loader.load({ name: "native-demo" });
    assert.match(loaded.prompt, /# Native discovery/);
    assert.equal(loaded.filePath, join(skillDir, "SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader refreshes once on miss and reports budget/config failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-loader-errors-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  let reloads = 0;
  const resourceLoader = {
    async reload() { reloads += 1; },
    getSkills() { return { skills: [], diagnostics: [] }; },
  };
  const loader = new TodoSkillLoader({ cwd: projectDir, agentDir, resourceLoader });

  try {
    await assert.rejects(
      loader.load({ name: "missing" }),
      (error: unknown) => error instanceof TodoSkillLoadError && error.code === "E_SKILL_NOT_FOUND",
    );
    assert.equal(reloads, 2);

    await writeFile(join(projectDir, ".pi", "skill-config.json"), "{broken");
    await assert.rejects(loader.validateContext("x"), /E_SKILL_CONFIG_INVALID/);

    await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
      version: "1.0.0",
      skills: {},
      limits: { maxFileBytes: 8, maxTotalBytes: 8 },
    }));
    await assert.rejects(
      loader.validateContext("context too large"),
      (error: unknown) => error instanceof TodoSkillLoadError && error.code === "E_SKILL_BUDGET_EXCEEDED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
