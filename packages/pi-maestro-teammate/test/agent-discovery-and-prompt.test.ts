import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatAgentCatalog,
  listAgentSummaries,
  resolveAgent,
  type AgentConfig,
} from "../src/agents/agents.ts";
import {
  buildTeammateToolDescription,
  default as registerTeammateExtension,
  TEAMMATE_PROMPT_GUIDELINES,
  TEAMMATE_PROMPT_SNIPPET,
} from "../src/extension/index.ts";
import { buildPiArgs } from "../src/runs/execution.ts";

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

test("project teammate roles are discovered and injected into tool metadata", () => {
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
    const specialist = summaries.find((agent) => agent.name === "specialist");
    assert.deepEqual(specialist, {
      name: "specialist",
      description: "Project-specific specialist for catalog injection",
      source: "project",
    });

    const catalog = formatAgentCatalog(project);
    assert.match(catalog, /specialist \[project\]: Project-specific specialist/);

    const description = buildTeammateToolDescription(project);
    assert.match(description, /Available teammate roles/);
    assert.match(description, /specialist \[project\]/);
    assert.doesNotMatch(description, /Act as the project specialist/);
  } finally {
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

test("frontmatter defaults flow through discovery into child Pi arguments", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-frontmatter-"));
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "delegate.md"), `---
name: delegate
description: Delegate defaults
---

Delegate prompt.
`);
  fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker defaults
inheritSkills: true
---

Worker prompt.
`);

  try {
    const delegate = resolveAgent(project, "delegate");
    assert.ok(delegate);
    const delegateArgs = buildPiArgs(delegate, { agent: "delegate" }, "delegate.md");
    assert.equal(delegateArgs.includes("--append-system-prompt"), true);
    assert.equal(delegateArgs.includes("--no-context-files"), false);
    assert.equal(delegateArgs.includes("--no-skills"), true);

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
  try {
    assert.equal(resolveAgent(project, "valid")?.thinking, "high");
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
  process.env.PI_TEAMMATE_CHILD = "1";
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
    const teammate = tools.get("teammate");
    assert.ok(teammate);
    assert.deepEqual(teammate.promptGuidelines, TEAMMATE_PROMPT_GUIDELINES);

    assert.equal(sessionStartHandlers.length, 1);
    sessionStartHandlers[0]({}, {
      cwd: project,
      sessionManager: {
        getSessionId: () => "child-session",
        getSessionFile: () => path.join(project, "session.jsonl"),
      },
    });

    const refreshed = tools.get("teammate");
    assert.match(String(refreshed?.description), /proxy-specialist \[project\]/);
    assert.equal(refreshed?.promptSnippet, TEAMMATE_PROMPT_SNIPPET);
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
    assert.equal(sessionStartHandlers.length, 1);

    const context = (cwd: string) => ({
      cwd,
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

    sessionStartHandlers[0]({}, context(secondProject));
    const second = tools.get("teammate");
    assert.match(String(second?.description), /root-beta \[project\]/);
    assert.doesNotMatch(String(second?.description), /root-alpha \[project\]/);
    assert.equal(second?.promptSnippet, TEAMMATE_PROMPT_SNIPPET);
    assert.equal(typeof second?.execute, "function");
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    fs.rmSync(firstProject, { recursive: true, force: true });
    fs.rmSync(secondProject, { recursive: true, force: true });
  }
});
