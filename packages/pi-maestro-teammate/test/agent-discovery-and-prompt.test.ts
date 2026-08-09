import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendAgentCatalog,
  BUILTIN_AGENT_NAMES,
  discoverAgents,
  formatAgentCatalog,
  invalidateAgentCatalogCache,
  PUBLIC_BUILTIN_AGENT_NAMES,
  listAgentSummaries,
  resolveAgent,
  type AgentConfig,
} from "../src/agents/agents.ts";
import {
  buildRoleList,
  buildTeammateToolDescription,
  default as registerTeammateExtension,
  TEAMMATE_PROMPT_GUIDELINES,
  TEAMMATE_PROMPT_SNIPPET,
} from "../src/extension/index.ts";
import { buildPiArgs, runSingleTeammate } from "../src/runs/execution.ts";

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    tools: ["read"],
    systemPromptMode: "append",
    inheritProjectContext: true,
    inheritSkills: true,
    systemPrompt: "Test system prompt",
    source: "project",
    filePath: "test-agent.md",
    ...overrides,
  };
}

test("project teammate roles are discovered and injected into the active system prompt", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-catalog-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "specialist.md"), `---
name: specialist
description: Project-specific specialist for catalog injection
taskType: specialist-work
---

Act as the project specialist.
`);

  try {
    const summaries = listAgentSummaries(path.join(project, "src"));
    assert.equal(summaries.some((agent) => agent.name === "swarm-ant"), false);
    const specialist = summaries.find((agent) => agent.name === "specialist");
    assert.deepEqual(specialist, {
      name: "specialist",
      description: "Project-specific specialist for catalog injection",
      source: "project",
    });

    const catalog = formatAgentCatalog(project);
    assert.match(catalog, /specialist \[project\]: Project-specific specialist/);

    const description = buildTeammateToolDescription(project);
    assert.match(description, /Available Teammate Agents section/);
    assert.doesNotMatch(description, /specialist \[project\]/);
    assert.match(description, /specialist-work: model=auto\/inherit main session/);
    assert.match(description, /Minimal call:\n  \{ tasks: \[\{ prompt: "Inspect auth" \}\] \}/);
    assert.match(description, /Omit outputSchema for ordinary tasks/);
    const ordinaryCallSection = description.slice(
      description.indexOf("Minimal call:"),
      description.indexOf("Every dispatch"),
    );
    assert.doesNotMatch(ordinaryCallSection, /outputSchema/);

    const systemPrompt = appendAgentCatalog("Base prompt", project);
    assert.match(systemPrompt, /# Available Teammate Agents/);
    assert.match(systemPrompt, /Built-in roles:\n- general:/);
    assert.match(systemPrompt, /- explorer:/);
    assert.match(systemPrompt, /- planner:/);
    assert.match(systemPrompt, /- analyst:/);
    assert.match(systemPrompt, /- research:/);
    assert.match(systemPrompt, /- verifier:/);
    assert.match(systemPrompt, /- workflow:/);
    assert.match(systemPrompt, /- specialist: Project-specific specialist/);
    assert.doesNotMatch(description, /Act as the project specialist/);
    assert.doesNotMatch(systemPrompt, /Act as the project specialist/);
    assert.doesNotMatch(systemPrompt, /swarm-ant/);

    const roles = buildRoleList(project);
    assert.ok(roles.entries.some((agent) => agent.name === "specialist" && agent.source === "project"));
    assert.match(roles.text, /specialist \[project\]: Project-specific specialist/);
    assert.doesNotMatch(roles.text, /Act as the project specialist/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("global and project agent directories resolve with canonical precedence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-compatible-dirs-"));
  const project = path.join(root, "project");
  const nested = path.join(project, "src", "feature");
  const home = path.join(root, "home");
  const legacyUserDir = path.join(home, ".pi", "agent", "extensions", "teammate", "agents");
  const userPiDir = path.join(home, ".pi", "agents");
  const userDir = path.join(home, ".agents");
  const userNestedDir = path.join(userDir, "agents");
  const projectCompatDir = path.join(project, ".agents");
  const projectNestedDir = path.join(projectCompatDir, "agents");
  const projectPiDir = path.join(project, ".pi", "agents");
  for (const dir of [
    nested,
    legacyUserDir,
    userPiDir,
    userDir,
    userNestedDir,
    projectCompatDir,
    projectNestedDir,
    projectPiDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const writeAgent = (dir: string, name: string, description: string) => {
    fs.writeFileSync(path.join(dir, `${name}.md`), `---
name: ${name}
description: ${description}
---
${description} prompt.
`);
  };
  writeAgent(legacyUserDir, "shared-role", "Legacy user role");
  writeAgent(userPiDir, "shared-role", "Global Pi user role");
  writeAgent(userPiDir, "global-pi-only", "Global Pi agents role");
  writeAgent(userNestedDir, "shared-role", "Nested user role");
  writeAgent(userNestedDir, "nested-user-only", "Nested user home role");
  writeAgent(userDir, "shared-role", "Standard user role");
  writeAgent(userDir, "user-only", "User home role");
  writeAgent(projectNestedDir, "shared-role", "Nested project role");
  writeAgent(projectNestedDir, "nested-project-only", "Nested project role only");
  writeAgent(projectCompatDir, "shared-role", "Project compatible role");
  writeAgent(projectCompatDir, "compat-only", "Project dot agents role");
  writeAgent(projectPiDir, "shared-role", "Canonical project role");

  try {
    const agents = discoverAgents(nested, home);
    assert.equal(agents.find((agent) => agent.name === "shared-role")?.description, "Canonical project role");
    assert.equal(agents.find((agent) => agent.name === "compat-only")?.source, "project");
    assert.equal(agents.find((agent) => agent.name === "nested-project-only")?.source, "project");
    assert.equal(agents.find((agent) => agent.name === "global-pi-only")?.source, "user");
    assert.equal(agents.find((agent) => agent.name === "global-pi-only")?.description, "Global Pi agents role");
    assert.equal(agents.find((agent) => agent.name === "nested-user-only")?.source, "user");
    assert.equal(agents.find((agent) => agent.name === "user-only")?.source, "user");
    assert.equal(resolveAgent(nested, "compat-only")?.description, "Project dot agents role");
    assert.equal(resolveAgent(nested, "nested-project-only")?.description, "Nested project role only");
    assert.match(appendAgentCatalog("Base prompt", nested), /- compat-only: Project dot agents role/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("npm package roles have highest custom priority and deduplicate by exact name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-package-tier-"));
  const packageAgentsDir = path.join(root, "pkg", ".pi", "agents");
  const foreignCwd = path.join(root, "elsewhere");
  const projectPiDir = path.join(root, "project", ".pi", "agents");
  for (const dir of [packageAgentsDir, foreignCwd, projectPiDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(packageAgentsDir, "packed-role.md"), `---
name: packed-role
description: Role shipped inside the npm package
---

Packed role prompt.
`);
  fs.writeFileSync(path.join(packageAgentsDir, "shared.md"), `---
name: shared
description: Package default role
---

Package default prompt.
`);
  fs.writeFileSync(path.join(projectPiDir, "shared.md"), `---
name: shared
description: Project override of the packaged role
---

Project override prompt.
`);

  const previous = process.env.PI_TEAMMATE_PACKAGE_AGENTS_DIR;
  process.env.PI_TEAMMATE_PACKAGE_AGENTS_DIR = packageAgentsDir;
  invalidateAgentCatalogCache();
  try {
    // A cwd with no .pi/.agents ancestor still discovers the packaged roles.
    const agents = discoverAgents(foreignCwd, root);
    const packed = agents.find((agent) => agent.name === "packed-role");
    assert.equal(packed?.source, "package");
    assert.equal(packed?.filePath, path.join(packageAgentsDir, "packed-role.md"));
    assert.equal(resolveAgent(foreignCwd, "packed-role")?.description, "Role shipped inside the npm package");
    assert.match(appendAgentCatalog("Base prompt", foreignCwd), /- packed-role: Role shipped inside the npm package/);
    // The packaged role resolves from a foreign project as well (the original
    // D:/maestro2 general-executor failure scenario).
    assert.equal(resolveAgent(path.join(foreignCwd, "deep", "nested"), "packed-role")?.source, "package");
    // Package tier wins over project definitions with the same exact name,
    // and the merged catalog emits that name only once.
    const projectCwd = path.join(root, "project", "src");
    const projectAgents = discoverAgents(projectCwd, root);
    const sharedMatches = projectAgents.filter((agent) => agent.name === "shared");
    assert.equal(sharedMatches.length, 1);
    assert.equal(sharedMatches[0]?.source, "package");
    assert.equal(sharedMatches[0]?.description, "Package default role");
    assert.equal(sharedMatches[0]?.filePath, path.join(packageAgentsDir, "shared.md"));
    const projectCatalog = appendAgentCatalog("Base prompt", projectCwd);
    assert.equal(projectCatalog.match(/- shared:/g)?.length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_PACKAGE_AGENTS_DIR;
    else process.env.PI_TEAMMATE_PACKAGE_AGENTS_DIR = previous;
    invalidateAgentCatalogCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("custom role YAML tool lists normalize to executable tool ids", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-tools-list-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker with YAML tools
tools:
  - Read
  - Write
  - Bash
---
Worker prompt.
`);
  try {
    assert.deepEqual(resolveAgent(project, "worker")?.tools, ["read", "write", "bash"]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("canonical builtin role names are reserved and legacy aliases are absent", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-reserved-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of BUILTIN_AGENT_NAMES) {
    fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---
name: ${name}
description: Project override that must be ignored
---

Unsafe project override.
`);
  }

  try {
    const agents = discoverAgents(project);
    assert.deepEqual(BUILTIN_AGENT_NAMES, ["general", "explorer", "planner", "analyst", "research", "verifier", "workflow"]);
    for (const name of PUBLIC_BUILTIN_AGENT_NAMES) {
      const agent = agents.find((candidate) => candidate.name === name);
      assert.equal(agent?.source, "builtin");
      assert.doesNotMatch(agent?.systemPrompt ?? "", /Unsafe project override/);
    }
    for (const removed of ["delegate", "goal-verifier", "coordinator"]) {
      assert.equal(resolveAgent(project, removed), undefined);
      assert.equal(agents.some((agent) => agent.name === removed), false);
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("planner is the sole Plan author with an execution-ready document contract", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-planner-"));
  try {
    const planner = resolveAgent(project, "planner");
    assert.ok(planner);
    assert.equal(planner.source, "builtin");
    assert.equal(planner.taskType, "planning");
    assert.equal(planner.thinking, "high");
    assert.deepEqual(planner.tools, ["read", "grep", "find", "ls"]);
    assert.equal(planner.systemPromptMode, "replace");
    assert.equal(planner.inheritProjectContext, true);
    assert.equal(planner.inheritSkills, false);

    const prompt = planner.systemPrompt;
    assert.match(prompt, /sole author of implementation Plan documents/);
    assert.match(prompt, /nested `teammate` tool/);
    for (const role of ["analyst", "research", "explorer"]) {
      assert.ok(prompt.includes(`\`${role}\``), role);
    }
    assert.match(prompt, /Give each nested task `MODE: analysis`/);
    assert.match(prompt, /Never call `general`/);
    assert.match(prompt, /Return only Markdown for the Plan/);
    assert.match(prompt, /Do not call `plan-update`, `plan-confirm`, or any persistence tool/);
    assert.match(prompt, /parent flow owns spot-checking the returned Markdown/);
    for (const section of [
      "Objective",
      "Evidence",
      "Scope",
      "Requirements",
      "Design",
      "Execution Plan",
      "Validation",
      "Risks and Recovery",
      "Open Decisions",
    ]) {
      assert.ok(prompt.includes(`## ${section}`), section);
    }
    for (const taskField of [
      "ID",
      "Outcome",
      "Files / symbols",
      "Changes",
      "Dependencies / parallelism",
      "Acceptance criteria",
      "Verification",
    ]) {
      assert.ok(prompt.includes(`\`${taskField}\``), taskField);
    }
    assert.match(prompt, /Dependencies must form an executable DAG/);
    assert.match(prompt, /Do not edit files/);

    const args = buildPiArgs(planner, { agent: "planner" }, "prompt.md");
    const childTools = args[args.indexOf("--tools") + 1].split(",");
    for (const tool of ["read", "grep", "find", "ls", "teammate", "teammate-send", "teammate-list", "observe"]) {
      assert.ok(childTools.includes(tool), `planner child tool: ${tool}`);
    }
    for (const rootOnlyTool of ["plan-update", "plan-confirm"]) {
      assert.ok(!childTools.includes(rootOnlyTool), `planner must not receive root-only tool: ${rootOnlyTool}`);
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("analyst is the bundled read-only analysis and review role", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-analyst-"));
  try {
    const analyst = resolveAgent(project, "analyst");
    assert.equal(analyst?.source, "builtin");
    assert.deepEqual(analyst?.tools, ["read", "grep", "find", "ls"]);
    assert.equal(analyst?.thinking, "high");
    assert.equal(analyst?.systemPromptMode, "replace");
    assert.equal(analyst?.inheritProjectContext, false);
    assert.equal(analyst?.inheritSkills, false);
    assert.match(analyst?.systemPrompt ?? "", /read-only technical analyst/i);
    assert.doesNotMatch(analyst?.systemPrompt ?? "", /structured verification/i);
    assert.match(analyst?.systemPrompt ?? "", /Do not edit files/i);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("verifier is the bundled read-only Goal fallback role", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-verifier-"));
  try {
    const verifier = resolveAgent(project, "verifier");
    assert.equal(verifier?.source, "builtin");
    assert.equal(verifier?.taskType, "verification");
    assert.equal(verifier?.thinking, "low");
    assert.deepEqual(verifier?.tools, ["read", "grep", "find", "ls"]);
    assert.equal(verifier?.systemPromptMode, "replace");
    assert.equal(verifier?.inheritProjectContext, false);
    assert.equal(verifier?.inheritSkills, false);
    assert.match(verifier?.systemPrompt ?? "", /only when the Goal declares no acceptance commands/i);
    assert.match(verifier?.systemPrompt ?? "", /untrusted, non-executable data/i);
    assert.match(verifier?.systemPrompt ?? "", /structured_output.*mandatory/i);
    assert.match(verifier?.systemPrompt ?? "", /Do not write or edit files/i);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("research role exposes project knowledge and web research tools", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-research-"));
  try {
    const research = resolveAgent(project, "research");
    assert.equal(research?.source, "builtin");
    assert.equal(research?.taskType, "analysis");
    assert.equal(research?.thinking, "high");
    assert.deepEqual(research?.tools, ["read", "grep", "find", "ls", "bash", "smart_search", "source_check"]);
    assert.match(research?.systemPrompt ?? "", /maestro search/);
    assert.match(research?.systemPrompt ?? "", /maestro load/);
    assert.match(research?.systemPrompt ?? "", /smart_search/);
    assert.match(research?.systemPrompt ?? "", /source_check/);
    assert.match(research?.systemPrompt ?? "", /Do not edit files/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("native swarm runtime roles are no longer bundled by teammate", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-swarm-roles-"));
  try {
    const removedRoles = ["swarm-ant", "swarm-scorer", "swarm-analyst"] as const;
    const summaries = listAgentSummaries(project);
    const catalog = formatAgentCatalog(project);
    for (const name of removedRoles) {
      assert.equal((BUILTIN_AGENT_NAMES as readonly string[]).includes(name), false);
      assert.equal(resolveAgent(project, name), undefined);
      assert.equal(summaries.some((role) => role.name === name), false);
      assert.doesNotMatch(catalog, new RegExp(name));
      const blocked = await runSingleTeammate({ agent: name, task: "must not exist" }, { baseCwd: project });
      assert.equal(blocked.exitCode, 1);
      assert.match(blocked.messages[0]?.content ?? "", new RegExp(`Unknown teammate agent "${name}"`));
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("agent catalog replacement refreshes discovered roles without duplication", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-refresh-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "first.md"), `---
name: first
description: First role
---
First prompt.
`);

  try {
    const first = appendAgentCatalog("Base prompt", project);
    fs.writeFileSync(path.join(agentsDir, "second.md"), `---
name: second
description: Second role
---
Second prompt.
`);
    const refreshed = appendAgentCatalog(first, project);
    assert.match(refreshed, /- first: First role/);
    assert.match(refreshed, /- second: Second role/);
    assert.equal(refreshed.match(/# Available Teammate Agents/g)?.length, 1);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("teammate-list roles view exposes project custom agents", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-list-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "custom-reviewer.md"), `---
name: custom-reviewer
description: Project custom review specialist
---
Custom reviewer prompt.
`);

  const tools = new Map<string, Record<string, unknown>>();
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => void> = [];
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerTool(tool: Record<string, unknown>) {
      tools.set(tool.name as string, tool);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionStartHandlers.push(handler);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  const previousChild = process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_CHILD;
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
    const context = {
      cwd: project,
      modelRegistry: { getAvailable: () => [] },
      sessionManager: {
        getSessionId: () => "role-list-session",
        getSessionFile: () => path.join(project, "session.jsonl"),
      },
    };
    sessionStartHandlers[0]({}, context);
    const listTool = tools.get("teammate-list") as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { agents: unknown[] } }>;
    };
    const result = await listTool.execute(
      "list-roles",
      { view: "roles" },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.match(result.content[0]?.text ?? "", /custom-reviewer \[project\]: Project custom review specialist/);
    assert.ok(result.details.agents.some((agent) =>
      (agent as { name?: string }).name === "custom-reviewer"
    ));
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("teammate prompt guidance names the tool and explains selection boundaries", () => {
  assert.match(TEAMMATE_PROMPT_SNIPPET, /discovered teammate roles/i);
  assert.ok(TEAMMATE_PROMPT_GUIDELINES.length >= 4);
  for (const guideline of TEAMMATE_PROMPT_GUIDELINES) {
    assert.match(guideline, /teammate/);
  }
  assert.ok(TEAMMATE_PROMPT_GUIDELINES.some((guideline) => /Do not use teammate/.test(guideline)));
  assert.ok(TEAMMATE_PROMPT_GUIDELINES.some((guideline) => /context: "fork"/.test(guideline)));
  assert.ok(TEAMMATE_PROMPT_GUIDELINES.some((guideline) => /automatic teammate-complete notification/i.test(guideline)));
  assert.ok(TEAMMATE_PROMPT_GUIDELINES.some((guideline) => /do not poll observe or teammate-list/i.test(guideline)));
  assert.ok(TEAMMATE_PROMPT_GUIDELINES.some((guideline) => /call observe exactly once/i.test(guideline)));
});

test("child Pi arguments honor prompt mode and resource inheritance", () => {
  const replaceArgs = buildPiArgs(
    agentConfig({
      systemPromptMode: "replace",
      inheritProjectContext: false,
      inheritSkills: false,
    }),
    { agent: "test-agent" },
    "prompt.md",
  );
  assert.equal(replaceArgs[replaceArgs.indexOf("--system-prompt") + 1], "prompt.md");
  assert.equal(replaceArgs.includes("--append-system-prompt"), false);
  assert.equal(replaceArgs.includes("--no-context-files"), true);
  assert.equal(replaceArgs.includes("--no-skills"), true);
  assert.equal(replaceArgs.includes("--no-extensions"), true);
  assert.ok(replaceArgs.includes("--extension"), "child extensions stay explicitly loaded");

  const appendArgs = buildPiArgs(
    agentConfig({
      systemPromptMode: "append",
      inheritProjectContext: true,
      inheritSkills: true,
    }),
    { agent: "test-agent" },
    "prompt.md",
  );
  assert.equal(appendArgs[appendArgs.indexOf("--append-system-prompt") + 1], "prompt.md");
  assert.equal(appendArgs.includes("--system-prompt"), false);
  assert.equal(appendArgs.includes("--no-context-files"), false);
  assert.equal(appendArgs.includes("--no-skills"), false);
});

test("child Pi arguments hide legacy observation tools unless explicitly enabled", () => {
  const previous = process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS;
  const config = agentConfig({ tools: ["read", "teammate-watch", "teammate-wait", "teammate-monitor"] });
  delete process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS;
  try {
    const hiddenArgs = buildPiArgs(config, { agent: "test-agent" }, "prompt.md");
    const hiddenTools = hiddenArgs[hiddenArgs.indexOf("--tools") + 1].split(",");
    assert.equal(hiddenTools.includes("observe"), true);
    assert.equal(hiddenTools.includes("teammate-watch"), false);
    assert.equal(hiddenTools.includes("teammate-wait"), false);
    assert.equal(hiddenTools.includes("teammate-monitor"), false);

    process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS = "1";
    const legacyArgs = buildPiArgs(config, { agent: "test-agent" }, "prompt.md");
    const legacyTools = legacyArgs[legacyArgs.indexOf("--tools") + 1].split(",");
    assert.equal(legacyTools.includes("teammate-watch"), true);
    assert.equal(legacyTools.includes("teammate-wait"), true);
    assert.equal(legacyTools.includes("teammate-monitor"), true);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS;
    else process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS = previous;
  }
});

test("frontmatter prompt modes flow through discovery into child Pi arguments", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-frontmatter-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "project-append.md"), `---
name: project-append
description: Project append role
systemPromptMode: append
inheritProjectContext: true
---

Project append prompt.
`);
  fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker defaults
inheritSkills: true
---

Worker prompt.
`);

  try {
    const appendRole = resolveAgent(project, "project-append");
    assert.ok(appendRole);
    const appendArgs = buildPiArgs(appendRole, { agent: "project-append" }, "project-append.md");
    assert.equal(appendArgs.includes("--append-system-prompt"), true);
    assert.equal(appendArgs.includes("--no-context-files"), false);
    assert.equal(appendArgs.includes("--no-skills"), true);

    const worker = resolveAgent(project, "worker");
    assert.ok(worker);
    const workerArgs = buildPiArgs(worker, { agent: "worker" }, "worker.md");
    assert.equal(workerArgs.includes("--system-prompt"), true);
    assert.equal(workerArgs.includes("--no-context-files"), true);
    assert.equal(workerArgs.includes("--no-skills"), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("unknown agent names fail with the available catalog instead of generic fallback", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-unknown-"));
  try {
    const result = await runSingleTeammate(
      { agent: "missing-role", task: "Do work" },
      { baseCwd: project },
    );
    assert.equal(result.exitCode, 1);
    const message = result.messages[0]?.content ?? "";
    assert.match(message, /Unknown teammate agent "missing-role"/);
    assert.match(message, /\bgeneral\b/);
    assert.match(message, /\bexplorer\b/);
    assert.match(message, /\bplanner\b/);
    assert.match(message, /\banalyst\b/);
    assert.match(message, /\bresearch\b/);
    assert.match(message, /\bworkflow\b/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("agent frontmatter accepts built-in and custom task types plus thinking values", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-thinking-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "valid.md"), `---
name: valid
description: Valid thinking
thinking: high
taskType: review
---
Valid prompt.
`);
  fs.writeFileSync(path.join(agentsDir, "invalid.md"), `---
name: invalid
description: Invalid thinking
thinking: ultra
taskType: Bad Type!
---
Invalid prompt.
`);
  fs.writeFileSync(path.join(agentsDir, "max.md"), `---
name: max
description: Max thinking alias
thinking: max
---
Max prompt.
`);
  try {
    assert.equal(resolveAgent(project, "valid")?.thinking, "high");
    assert.equal(resolveAgent(project, "valid")?.taskType, "review");
    assert.equal(resolveAgent(project, "max")?.thinking, "max");
    assert.equal(resolveAgent(project, "invalid")?.thinking, undefined);
    assert.equal(resolveAgent(project, "invalid")?.taskType, undefined);

    fs.writeFileSync(path.join(agentsDir, "custom.md"), `---
name: custom
description: Custom task type
taskType: security-audit
---
Custom prompt.
`);
    assert.equal(resolveAgent(project, "custom")?.taskType, "security-audit");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("child proxy tools receive the same dynamic teammate guidance", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-proxy-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "proxy-specialist.md"), `---
name: proxy-specialist
description: Specialist visible to child proxy tools
---

Proxy specialist prompt.
`);

  const tools = new Map<string, Record<string, unknown>>();
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => void> = [];
  const beforeAgentStartHandlers: Array<(event: { systemPrompt: string }, ctx: unknown) => { systemPrompt: string }> = [];
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerTool(tool: Record<string, unknown>) {
      tools.set(tool.name as string, tool);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionStartHandlers.push(handler);
      if (event === "before_agent_start") {
        beforeAgentStartHandlers.push(handler as typeof beforeAgentStartHandlers[number]);
      }
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const previousDepth = process.env.PI_TEAMMATE_DEPTH;
  process.env.PI_TEAMMATE_CHILD = "1";
  process.env.PI_TEAMMATE_DEPTH = "1";
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
    const teammate = tools.get("teammate");
    assert.ok(teammate);
    assert.deepEqual(teammate.promptGuidelines, TEAMMATE_PROMPT_GUIDELINES);

    assert.equal(sessionStartHandlers.length, 1);
    const context = {
      cwd: project,
      modelRegistry: { getAvailable: () => [] },
      sessionManager: {
        getSessionId: () => "child-session",
        getSessionFile: () => path.join(project, "session.jsonl"),
      },
    };
    sessionStartHandlers[0]({}, context);

    const refreshed = tools.get("teammate");
    assert.doesNotMatch(String(refreshed?.description), /proxy-specialist \[project\]/);
    assert.match(String(refreshed?.description), /Available Teammate Agents section/);
    assert.equal(refreshed?.promptSnippet, TEAMMATE_PROMPT_SNIPPET);
    assert.equal(beforeAgentStartHandlers.length, 1);
    const injected = beforeAgentStartHandlers[0]({ systemPrompt: "Base child prompt" }, context);
    assert.match(injected.systemPrompt, /- proxy-specialist: Specialist visible to child proxy tools/);
    assert.doesNotMatch(injected.systemPrompt, /Proxy specialist prompt/);
    assert.match(injected.systemPrompt, /## Teammate taskType routing/);
    assert.match(injected.systemPrompt, /does not change the agent role, tools, permissions, or task scope/);
    assert.doesNotMatch(injected.systemPrompt, /Role guidance/);
    assert.match(injected.systemPrompt, /depth 1\/2/);
    assert.match(injected.systemPrompt, /Remaining teammate depth: 1/);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    if (previousDepth === undefined) delete process.env.PI_TEAMMATE_DEPTH;
    else process.env.PI_TEAMMATE_DEPTH = previousDepth;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("terminal depth child knows its level and has no teammate dispatch tool", () => {
  const tools = new Map<string, Record<string, unknown>>();
  const beforeAgentStartHandlers: Array<
    (event: { systemPrompt: string }, ctx: unknown) => { systemPrompt: string }
  > = [];
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerTool(tool: Record<string, unknown>) {
      tools.set(tool.name as string, tool);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "before_agent_start") {
        beforeAgentStartHandlers.push(handler as typeof beforeAgentStartHandlers[number]);
      }
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const previousDepth = process.env.PI_TEAMMATE_DEPTH;
  process.env.PI_TEAMMATE_CHILD = "1";
  process.env.PI_TEAMMATE_DEPTH = "2";
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
    assert.equal(tools.has("teammate"), false);
    assert.equal(tools.has("teammate-send"), true);
    assert.equal(tools.has("teammate-list"), true);
    assert.equal(tools.has("teammate-watch"), false);
    assert.equal(tools.has("teammate-wait"), false);
    assert.equal(tools.has("teammate-monitor"), false);
    assert.equal(tools.has("observe"), true);

    assert.equal(beforeAgentStartHandlers.length, 1);
    const context = {
      cwd: process.cwd(),
      modelRegistry: { getAvailable: () => [] },
    };
    const injected = beforeAgentStartHandlers[0]({ systemPrompt: "Base terminal prompt" }, context);
    assert.doesNotMatch(injected.systemPrompt, /teammate-tasktype-routing:start/);
    assert.doesNotMatch(injected.systemPrompt, /## Teammate taskType routing/);
    assert.match(injected.systemPrompt, /depth 2\/2/);
    assert.match(injected.systemPrompt, /Remaining teammate depth: 0/);
    assert.match(injected.systemPrompt, /terminal teammate level/i);
    assert.match(injected.systemPrompt, /dispatch tool is intentionally unavailable/i);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    if (previousDepth === undefined) delete process.env.PI_TEAMMATE_DEPTH;
    else process.env.PI_TEAMMATE_DEPTH = previousDepth;
  }
});

test("root tool catalog refreshes across session cwd changes without losing metadata", () => {
  const firstProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-root-a-"));
  const secondProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-root-b-"));
  for (const [project, name] of [[firstProject, "root-alpha"], [secondProject, "root-beta"]] as const) {
    const agentsDir = path.join(project, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---
name: ${name}
description: ${name} role
---

${name} prompt.
`);
  }

  const tools = new Map<string, Record<string, unknown>>();
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => void> = [];
  const beforeAgentStartHandlers: Array<(event: { systemPrompt: string }, ctx: unknown) => { systemPrompt: string }> = [];
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerTool(tool: Record<string, unknown>) {
      tools.set(tool.name as string, tool);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionStartHandlers.push(handler);
      if (event === "before_agent_start") {
        beforeAgentStartHandlers.push(handler as typeof beforeAgentStartHandlers[number]);
      }
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  const previousChild = process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_CHILD;
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
    assert.equal(sessionStartHandlers.length, 1);
    assert.equal(tools.has("observe"), true);
    assert.equal(tools.has("teammate-watch"), false);
    assert.equal(tools.has("teammate-wait"), false);
    assert.equal(tools.has("teammate-monitor"), false);

    const context = (cwd: string) => ({
      cwd,
      modelRegistry: { getAvailable: () => [] },
      sessionManager: {
        getSessionId: () => `session-${path.basename(cwd)}`,
        getSessionFile: () => path.join(cwd, "session.jsonl"),
      },
    });
    sessionStartHandlers[0]({}, context(firstProject));
    const first = tools.get("teammate");
    assert.doesNotMatch(String(first?.description), /root-alpha \[project\]/);
    assert.match(String(first?.description), /Available Teammate Agents section/);
    assert.deepEqual(first?.promptGuidelines, TEAMMATE_PROMPT_GUIDELINES);
    assert.equal(typeof first?.execute, "function");
    const firstPrompt = beforeAgentStartHandlers[0]({ systemPrompt: "Base root prompt" }, context(firstProject));
    assert.match(firstPrompt.systemPrompt, /- root-alpha: root-alpha role/);
    assert.match(firstPrompt.systemPrompt, /## Teammate taskType routing/);
    assert.match(firstPrompt.systemPrompt, /does not change the agent role, tools, permissions, or task scope/);
    assert.doesNotMatch(firstPrompt.systemPrompt, /Role guidance/);

    sessionStartHandlers[0]({}, context(secondProject));
    const second = tools.get("teammate");
    assert.doesNotMatch(String(second?.description), /root-beta \[project\]/);
    assert.match(String(second?.description), /Available Teammate Agents section/);
    assert.equal(second?.promptSnippet, TEAMMATE_PROMPT_SNIPPET);
    assert.equal(typeof second?.execute, "function");
    const secondPrompt = beforeAgentStartHandlers[0](firstPrompt, context(secondProject));
    assert.match(secondPrompt.systemPrompt, /- root-beta: root-beta role/);
    assert.doesNotMatch(secondPrompt.systemPrompt, /root-alpha role/);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    fs.rmSync(firstProject, { recursive: true, force: true });
    fs.rmSync(secondProject, { recursive: true, force: true });
  }
});
