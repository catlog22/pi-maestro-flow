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
import { buildPiArgs, runTeammate } from "../src/runs/execution.ts";

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
    assert.match(description, /specialist \[project\]: Project-specific specialist/);

    const systemPrompt = appendAgentCatalog("Base prompt", project);
    assert.match(systemPrompt, /# Available Teammate Agents/);
    assert.match(systemPrompt, /Built-in roles:\n- delegate:/);
    assert.match(systemPrompt, /- explorer:/);
    assert.match(systemPrompt, /- workflow:/);
    assert.match(systemPrompt, /Discovered project and user roles:\n- specialist: Project-specific specialist/);
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

test(".agents and ~/.agents roles are discovered with canonical precedence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-compatible-dirs-"));
  const project = path.join(root, "project");
  const nested = path.join(project, "src", "feature");
  const home = path.join(root, "home");
  const legacyUserDir = path.join(home, ".pi", "agent", "extensions", "teammate", "agents");
  const userDir = path.join(home, ".agents");
  const projectCompatDir = path.join(project, ".agents");
  const projectPiDir = path.join(project, ".pi", "agents");
  for (const dir of [nested, legacyUserDir, userDir, projectCompatDir, projectPiDir]) {
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
  writeAgent(userDir, "shared-role", "Standard user role");
  writeAgent(userDir, "user-only", "User home role");
  writeAgent(projectCompatDir, "shared-role", "Project compatible role");
  writeAgent(projectCompatDir, "compat-only", "Project dot agents role");
  writeAgent(projectPiDir, "shared-role", "Canonical project role");

  try {
    const agents = discoverAgents(nested, home);
    assert.equal(agents.find((agent) => agent.name === "shared-role")?.description, "Canonical project role");
    assert.equal(agents.find((agent) => agent.name === "compat-only")?.source, "project");
    assert.equal(agents.find((agent) => agent.name === "user-only")?.source, "user");
    assert.equal(resolveAgent(nested, "compat-only")?.description, "Project dot agents role");
    assert.match(appendAgentCatalog("Base prompt", nested), /- compat-only: Project dot agents role/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builtin role names are reserved and coordinator remains a workflow alias", () => {
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
  fs.writeFileSync(path.join(agentsDir, "coordinator.md"), `---
name: coordinator
description: Legacy alias override that must be ignored
---
Legacy alias override.
`);

  try {
    const agents = discoverAgents(project);
    for (const name of PUBLIC_BUILTIN_AGENT_NAMES) {
      const agent = agents.find((candidate) => candidate.name === name);
      assert.equal(agent?.source, "builtin");
      assert.doesNotMatch(agent?.systemPrompt ?? "", /Unsafe project override/);
    }
    assert.equal(resolveAgent(project, "coordinator")?.name, "workflow");
    assert.equal(agents.some((agent) => agent.name === "coordinator"), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("goal verifier is a bundled read-only role with objective-scoped checks", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-goal-verifier-"));
  try {
    const verifier = resolveAgent(project, "goal-verifier");
    assert.equal(verifier?.source, "builtin");
    assert.deepEqual(verifier?.tools, ["read", "grep", "find", "ls", "bash"]);
    assert.equal(verifier?.systemPromptMode, "replace");
    assert.equal(verifier?.inheritProjectContext, false);
    assert.equal(verifier?.inheritSkills, false);
    assert.match(verifier?.systemPrompt ?? "", /broad unit-test suite/i);
    assert.match(verifier?.systemPrompt ?? "", /structured_output.*mandatory/i);
    assert.match(verifier?.systemPrompt ?? "", /missing evidence.*pass=false/i);
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
      const blocked = await runTeammate({ agent: name, task: "must not exist" }, { baseCwd: project });
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
    const result = await runTeammate(
      { agent: "missing-role", task: "Do work" },
      { baseCwd: project },
    );
    assert.equal(result.exitCode, 1);
    const message = result.messages[0]?.content ?? "";
    assert.match(message, /Unknown teammate agent "missing-role"/);
    assert.match(message, /\bdelegate\b/);
    assert.match(message, /\bexplorer\b/);
    assert.match(message, /\bworkflow\b/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("agent frontmatter accepts supported thinking and ignores invalid values", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-thinking-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "valid.md"), `---
name: valid
description: Valid thinking
thinking: high
---
Valid prompt.
`);
  fs.writeFileSync(path.join(agentsDir, "invalid.md"), `---
name: invalid
description: Invalid thinking
thinking: ultra
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
    assert.equal(resolveAgent(project, "max")?.thinking, "xhigh");
    assert.equal(resolveAgent(project, "invalid")?.thinking, undefined);
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
  process.env.PI_TEAMMATE_CHILD = "1";
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
    assert.match(String(refreshed?.description), /proxy-specialist \[project\]/);
    assert.equal(refreshed?.promptSnippet, TEAMMATE_PROMPT_SNIPPET);
    assert.equal(beforeAgentStartHandlers.length, 1);
    const injected = beforeAgentStartHandlers[0]({ systemPrompt: "Base child prompt" }, context);
    assert.match(injected.systemPrompt, /- proxy-specialist: Specialist visible to child proxy tools/);
    assert.doesNotMatch(injected.systemPrompt, /Proxy specialist prompt/);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    fs.rmSync(project, { recursive: true, force: true });
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
    assert.match(String(first?.description), /root-alpha \[project\]/);
    assert.deepEqual(first?.promptGuidelines, TEAMMATE_PROMPT_GUIDELINES);
    assert.equal(typeof first?.execute, "function");
    const firstPrompt = beforeAgentStartHandlers[0]({ systemPrompt: "Base root prompt" }, context(firstProject));
    assert.match(firstPrompt.systemPrompt, /- root-alpha: root-alpha role/);

    sessionStartHandlers[0]({}, context(secondProject));
    const second = tools.get("teammate");
    assert.match(String(second?.description), /root-beta \[project\]/);
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
