import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SkillRuntime } from "../src/skills/skill-runtime.ts";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { SkillCache } from "../src/skills/skill-cache.ts";
import {
  loadSkillConfig,
  renderSkillConfigDefaults,
} from "../src/skills/skill-config.ts";
import {
  TodoSkillLoadError,
  TodoSkillLoader,
} from "../src/skills/skill-loader.ts";

test("SkillCache applies LRU eviction and shares in-flight work", async () => {
  const cache = new SkillCache<number>(2);
  let releases = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = cache.getOrCreate("shared", async () => {
    releases += 1;
    await gate;
    return 1;
  });
  const second = cache.getOrCreate("shared", async () => 2);
  release?.();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(releases, 1);
  assert.equal(cache.stats().singleFlightHits, 1);

  cache.set("second", 2);
  assert.equal(cache.get("shared"), 1);
  cache.set("third", 3);
  assert.equal(cache.get("second"), undefined);
  assert.equal(cache.stats().evictions, 1);
});

test("SkillCache also evicts by configured weight", () => {
  const cache = new SkillCache<string>(10, { maxWeight: 5, measure: (value) => value.length });
  cache.set("a", "123");
  cache.set("b", "456");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), "456");
  assert.equal(cache.stats().weight, 3);

  cache.set("oversized", "123456");
  assert.equal(cache.get("oversized"), undefined);
  assert.equal(cache.get("b"), "456");
  assert.equal(cache.stats().weight, 3);
});

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

test("loadSkillConfig preserves the enabled toggle from global and project configs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-config-enabled-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    skills: { alpha: { params: {}, enabled: true }, beta: { params: {}, enabled: true } },
  }));
  await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    skills: { alpha: { params: {}, enabled: false }, gamma: { params: {}, enabled: true } },
  }));

  try {
    const { config } = await loadSkillConfig(projectDir, agentDir);
    // project wins over global for the same skill
    assert.equal(config.skills.alpha.enabled, false);
    // global-only toggle survives
    assert.equal(config.skills.beta.enabled, true);
    // project-only toggle survives
    assert.equal(config.skills.gamma.enabled, true);
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
    const repeated = await loader.load({ name: "demo" });
    const differentContext = await loader.load({ name: "demo" }, "different context");
    assert.equal(reloads, 1);
    assert.match(first.prompt, /REQUIRED CONTENT/);
    assert.doesNotMatch(first.prompt, /depth: standard/);
    assert.match(second.prompt, /depth: standard/);
    assert.equal(second.cacheHit, false);
    assert.equal(repeated.cacheHit, true);
    assert.equal(repeated.cacheStatus, "hit");
    assert.equal(repeated.compiledKey, second.compiledKey);
    assert.equal(differentContext.compiledKey, second.compiledKey);
    assert.equal(differentContext.cacheHit, true);
    assert.ok(differentContext.totalBytes > repeated.totalBytes);
    assert.ok(loader.getCacheStats().compiled.hits >= 2);
    assert.ok(loader.getCacheStats().raw.hits >= 2);
    assert.equal(Object.isFrozen(repeated), true);
    assert.equal(Object.isFrozen(repeated.requiredFiles), true);
    assert.deepEqual(first.requiredFiles, [join(skillDir, "required.md")]);
    assert.deepEqual(first.deferredFiles, [join(skillDir, "later.md")]);

    await writeFile(join(skillDir, "required.md"), "UPDATED REQUIRED CONTENT");
    const requiredChanged = await loader.load({ name: "demo" });
    assert.notEqual(requiredChanged.requiredReadingHash, repeated.requiredReadingHash);
    assert.notEqual(requiredChanged.compiledKey, repeated.compiledKey);
    assert.match(requiredChanged.prompt, /UPDATED REQUIRED CONTENT/);

    await writeFile(skillPath, `---
name: demo
description: demo skill
---
# Demo changed
<required_reading>
@required.md
</required_reading>
`);
    const contentChanged = await loader.load({ name: "demo" });
    assert.notEqual(contentChanged.contentHash, requiredChanged.contentHash);
    assert.notEqual(contentChanged.compiledKey, requiredChanged.compiledKey);
    assert.match(contentChanged.prompt, /# Demo changed/);

    await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
      version: "1.0.0",
      skills: { demo: { params: { depth: "thorough" } } },
    }));
    const configChanged = await loader.load({ name: "demo" });
    assert.notEqual(configChanged.configHash, contentChanged.configHash);
    assert.notEqual(configChanged.compiledKey, contentChanged.compiledKey);
    assert.match(configChanged.prompt, /depth: thorough/);

    await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
      version: "1.0.0",
      skills: {},
      limits: { maxFileBytes: 8, maxTotalBytes: 8192 },
    }));
    await assert.rejects(
      loader.load({ name: "demo" }),
      (error: unknown) => error instanceof TodoSkillLoadError && error.code === "E_SKILL_BUDGET_EXCEEDED",
    );
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

test("Todo loader rejects skills configured for explicit user invocation only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-manual-skill-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const skillDir = join(projectDir, ".pi", "skills", "manual");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(skillPath, `---
name: manual
description: manual only
---
# Manual
`);
  await writeFile(join(projectDir, ".pi", "skill-config.json"), JSON.stringify({
    version: "1.0.0",
    skills: { manual: { "disable-model-invocation": true } },
  }));
  const skill = {
    name: "manual",
    description: "manual only",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  } satisfies Skill;
  const loader = new TodoSkillLoader({
    cwd: projectDir,
    agentDir,
    resourceLoader: {
      async reload() {},
      getSkills() { return { skills: [skill], diagnostics: [] }; },
    },
  });

  try {
    await assert.rejects(
      loader.load({ name: "manual" }),
      (error: unknown) =>
        error instanceof TodoSkillLoadError && error.code === "E_SKILL_MODEL_INVOCATION_DISABLED",
    );
    const restored = await loader.load(
      { name: "manual" },
      "",
      { allowModelInvocationDisabled: true },
    );
    assert.equal(restored.name, "manual");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runtimeFixture(t: TestContext, bodies: string[], sharedReading?: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-stack-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills: Skill[] = [];
  await mkdir(join(root, ".pi"), { recursive: true });
  if (sharedReading !== undefined) await writeFile(join(root, "shared.md"), sharedReading);
  for (const [index, body] of bodies.entries()) {
    const name = `skill-${index}`;
    const filePath = join(root, `${name}.md`);
    await writeFile(filePath, `---\nname: ${name}\ndescription: budget fixture\n---\n${body}`);
    skills.push({
      name,
      description: "budget fixture",
      filePath,
      baseDir: root,
      sourceInfo: {} as Skill["sourceInfo"],
      disableModelInvocation: false,
    });
  }
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills, diagnostics: [] }) },
  });
  return {
    loader,
    runtime: new SkillRuntime(loader),
    setBudget: (maxTotalBytes: number) => writeFile(join(root, ".pi", "skill-config.json"), JSON.stringify({
      version: "1.0.0",
      limits: { maxFileBytes: maxTotalBytes, maxTotalBytes },
    })),
  };
}

const budgetError = (error: unknown): boolean =>
  error instanceof TodoSkillLoadError && error.code === "E_SKILL_BUDGET_EXCEEDED";

test("skill runtime rejects a combined stack even when each skill fits the budget", async (t) => {
  const { loader, runtime, setBudget } = await runtimeFixture(t, ["a".repeat(2048), "b".repeat(2048)]);
  await setBudget(3000);
  await loader.load({ name: "skill-0" });
  await loader.load({ name: "skill-1" });
  await assert.rejects(runtime.activate([
    { name: "skill-0", role: "primary" },
    { name: "skill-1", role: "support" },
  ]), budgetError);
});

test("skill runtime budgets UTF-8 context and rendered wrappers at the exact boundary", async (t) => {
  const { runtime, setBudget } = await runtimeFixture(t, ["任务🙂"]);
  const bindings = [{ name: "skill-0", role: "primary" }] as const;
  const context = "当前进度🙂";
  const activation = await runtime.activate(bindings, context);
  const totalBytes = Buffer.byteLength(context + activation.prompt, "utf8");
  await setBudget(totalBytes);
  const exact = await runtime.activate(bindings, context);
  assert.equal(exact.prompt, activation.prompt);
  await setBudget(totalBytes - 1);
  await assert.rejects(runtime.activate(bindings, context), budgetError);
});

test("skill runtime counts shared required reading and task context only once in the final budget", async (t) => {
  const reading = "共享内容".repeat(500);
  const body = "<required_reading>\n@shared.md\n</required_reading>";
  const { runtime, setBudget } = await runtimeFixture(t, [body, body], reading);
  const bindings = [
    { name: "skill-0", role: "primary" },
    { name: "skill-1", role: "support" },
  ] as const;
  const context = "执行进度".repeat(100);
  const initial = await runtime.activate(bindings, context);
  const totalBytes = Buffer.byteLength(context + initial.prompt, "utf8");
  assert.equal(initial.prompt.split(reading).length - 1, 1);
  assert.ok(initial.bindings.reduce((sum, binding) => sum + binding.totalBytes, 0) > totalBytes);
  await setBudget(totalBytes);
  const bounded = await runtime.activate(bindings, context);
  assert.equal(bounded.prompt, initial.prompt);
});
