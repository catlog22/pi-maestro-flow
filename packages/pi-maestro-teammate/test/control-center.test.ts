import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import {
  TeammateControlCenter,
  type ControlCenterActiveAgent,
} from "../src/tui/model-mapping-overlay.ts";
import type { AgentConfig } from "../src/agents/agents.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

function agent(name: string, source: AgentConfig["source"] = "project"): AgentConfig {
  return {
    name,
    description: `${name} description`,
    source,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    systemPrompt: "hidden prompt",
    model: name === "reviewer" ? "anthropic/sonnet" : undefined,
    tools: ["read"],
    filePath: `/tmp/${name}.md`,
  };
}

function active(id: string, status: ControlCenterActiveAgent["status"] = "running"): ControlCenterActiveAgent {
  return {
    correlationId: id,
    agent: "worker",
    name: id,
    status,
    startedAt: Date.now() - 2_000,
    inboxCount: 1,
    taskCount: 2,
  };
}

function makeCenter(overrides: Partial<ConstructorParameters<typeof TeammateControlCenter>[0]> = {}) {
  const closed: unknown[] = [];
  const saved: Array<{ taskType: string; model: string | null }> = [];
  const savedThinking: Array<{ taskType: string; thinking: string | null }> = [];
  const center = new TeammateControlCenter({
    cwd: "C:\\tmp\\project",
    availableModels: ["openai/gpt-5", "anthropic/sonnet"],
    agents: [agent("planner"), agent("reviewer", "builtin")],
    activeAgents: [active("worker-1"), active("worker-2", "sleeping")],
    config: { version: 2, mappings: {}, thinkingLevels: {} },
    theme,
    requestRender: () => {},
    close: (value) => closed.push(value),
    saveMapping: (taskType, model) => saved.push({ taskType, model }),
    saveThinking: (taskType, thinking) => savedThinking.push({ taskType, thinking }),
    ...overrides,
  });
  return { center, closed, saved, savedThinking };
}

test("control center keeps roles, routing and active collaboration visible", () => {
  const { center } = makeCenter({ initialTab: "roles" });
  const wide = center.render(100).join("\n");
  assert.match(wide, /Teammate Control Center/);
  assert.match(wide, /Roles 2/);
  assert.match(wide, /@planner/);
  assert.match(wide, /planner description/);

  center.handleInput("\t");
  const activeView = center.render(100).join("\n");
  assert.match(activeView, /Active 2/);
  assert.match(activeView, /worker-1/);

  const narrow = center.render(40).join("\n");
  assert.match(narrow, /Teammate Control Center|Teammates/);
});

test("thinking routing supports inherit, all Pi levels, save errors, and narrow widths", async () => {
  const { center, savedThinking } = makeCenter();
  center.handleInput("\x1b[1;5C");
  const picker = center.render(90).join("\n");
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) assert.match(picker, new RegExp(level));
  assert.match(picker, /inherit \/ Pi default/);
  for (let width = 1; width <= 120; width++) {
    assert.ok(center.render(width).every((line) => visibleWidth(line) <= width));
  }
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(savedThinking, [{ taskType: "explore", thinking: "off" }]);

  let attempts = 0;
  const retried: Array<string | null> = [];
  const failed = makeCenter({
    saveThinking: (_taskType, thinking) => {
      attempts++;
      if (attempts === 1) throw new Error("thinking read-only");
      retried.push(thinking);
    },
  }).center;
  failed.handleInput("\x1b[1;5C");
  failed.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(failed.render(90).join("\n"), /Save failed.*thinking read-only/);
  assert.match(failed.render(90).join("\n"), /Thinking/);
  failed.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(retried, [null]);

  const inherited = makeCenter({
    config: { version: 2, mappings: {}, thinkingLevels: { explore: "high" } },
  });
  inherited.center.handleInput("\x1b[1;5C");
  for (let index = 0; index < 5; index++) inherited.center.handleInput("\x1b[A");
  inherited.center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(inherited.savedThinking, [{ taskType: "explore", thinking: null }]);
});

test("routing filter still accepts t-prefixed text and every view fits widths 1 through 120", () => {
  const main = makeCenter().center;
  main.handleInput("t");
  assert.doesNotMatch(main.render(90).join("\n"), /› Thinking/);
  main.handleInput("esting");
  assert.match(main.render(90).join("\n"), /Testing/);
  for (let width = 1; width <= 120; width++) {
    assert.ok(main.render(width).every((line) => visibleWidth(line) <= width));
  }

  const model = makeCenter().center;
  model.handleInput("\r");
  for (let width = 1; width <= 120; width++) {
    assert.ok(model.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("model routing is reversible and saves inline", async () => {
  const { center, closed, saved } = makeCenter();
  center.handleInput("\r");
  assert.match(center.render(90).join("\n"), /Explore/);
  const narrowEditor = center.render(32);
  assert.ok(narrowEditor.every((line) => visibleWidth(line) <= 32));
  assert.match(narrowEditor.join("\n"), /Explore/);
  center.handleInput("\x1b");
  assert.equal(closed.length, 0);
  assert.match(center.render(90).join("\n"), /Routing 7/);

  center.handleInput("\r");
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, [{ taskType: "explore", model: "anthropic/sonnet" }]);
  assert.match(center.render(90).join("\n"), /Saved/);
});

test("model routing keeps the editor open when persistence fails", async () => {
  const { center } = makeCenter({
    saveMapping: () => { throw new Error("read-only project"); },
  });
  center.handleInput("\r");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(center.render(90).join("\n"), /Save failed.*read-only project/);
  center.handleInput("\x1b");
  assert.match(center.render(90).join("\n"), /Routing 7/);
});

test("attach overlay accepts pasted messages and keeps a focused tab visible", async () => {
  const now = Date.now();
  const first = {
    agent: "worker", name: "agent-1", correlationId: "agent-1", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, sleepMs: 0,
  };
  const runs = new Map<string, typeof first>();
  for (let index = 1; index <= 12; index++) {
    const item = { ...first, agent: "worker", name: `agent-${index}`, correlationId: `agent-${index}` };
    runs.set(item.correlationId, item);
  }
  const sent: string[] = [];
  const overlay = new AttachOverlay(
    first,
    () => {},
    () => runs,
    async (_id, message) => { sent.push(message); return { ok: true, message: "Queued" }; },
  );
  try {
    for (let index = 0; index < 11; index++) overlay.handleInput("\x1b[C");
    assert.match(overlay.render(40, 16).join("\n"), /agent-12/);
    overlay.handleInput("\r");
    overlay.handleInput("pasted teammate message");
    assert.match(overlay.render(80, 16).join("\n"), /pasted teammate message/);
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ["pasted teammate message"]);
  } finally {
    overlay.dispose();
  }
});
