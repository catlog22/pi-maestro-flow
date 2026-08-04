import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import {
  TeammateControlCenter,
  type ControlCenterActiveAgent,
} from "../src/tui/model-mapping-overlay.ts";
import type { AgentConfig } from "../src/agents/agents.ts";
import type { ModelRoutingState } from "../src/models/model-routing.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

function assertNoInjectedControls(line: string): void {
  assert.doesNotMatch(line, /[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f-\x9f]/);
  assert.doesNotMatch(line, /\x1b(?!\[0m)/);
}

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

function profileState(overridesEnabled = false): ModelRoutingState {
  return {
    global: {
      version: 3,
      defaultProfile: "balanced",
      profiles: {
        balanced: {
          name: "Balanced",
          mappings: { explore: "openai/gpt-5" },
          fallbackMappings: { explore: ["anthropic/sonnet"] },
          thinkingLevels: { explore: "medium" },
        },
        fast: {
          name: "Fast",
          mappings: { explore: "missing/fast" },
          thinkingLevels: { explore: "low" },
        },
      },
    },
    project: {
      version: 3,
      activeProfile: "fast",
      applyOverrides: overridesEnabled,
      overrides: { mappings: { explore: "anthropic/sonnet" }, thinkingLevels: {} },
    },
    config: {
      version: 3,
      profileId: "fast",
      profileName: "Fast",
      projectOverridesEnabled: overridesEnabled,
      mappings: { explore: overridesEnabled ? "anthropic/sonnet" : "missing/fast" },
      thinkingLevels: { explore: "low" },
    },
    requestedProfile: "fast",
  };
}

function makeCenter(overrides: Partial<ConstructorParameters<typeof TeammateControlCenter>[0]> = {}) {
  const closed: unknown[] = [];
  const saved: Array<{ taskType: string; model: string | null }> = [];
  const savedThinking: Array<{ taskType: string; thinking: string | null }> = [];
  const center = new TeammateControlCenter({
    cwd: "C:\\tmp\\project",
    availableModels: [
      { id: "openai/gpt-5", reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high"] },
      { id: "anthropic/sonnet", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] },
    ],
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

test("control center derives custom routing types from discovered agents", () => {
  const specialist = { ...agent("security-specialist"), taskType: "security-audit" };
  const { center } = makeCenter({ agents: [agent("planner"), specialist] });
  center.handleInput("audit");
  const view = center.render(100).join("\n");
  assert.match(view, /Routing 8/);
  assert.match(view, /Security Audit/);
  assert.match(view, /security-specialist/);
});

test("control center accepts cross-platform Enter and Escape encodings", () => {
  for (const enter of ["\x1bOM", "\x1b[13u", "\x1b[57414u"]) {
    const { center } = makeCenter();
    center.handleInput(enter);
    assert.match(center.render(90).join("\n"), /Explore/);
    assert.match(center.render(90).join("\n"), /Esc\/← back/);
  }

  for (const escape of ["\x1b[27u", "\x1b[27;1;27~"]) {
    const { center, closed } = makeCenter();
    center.handleInput("\r");
    center.handleInput(escape);
    assert.equal(closed.length, 0);
    assert.match(center.render(90).join("\n"), /Routing 7/);
    center.handleInput(escape);
    assert.equal(closed.length, 1);
  }

  const kittyText = makeCenter().center;
  kittyText.handleInput("\x1b[116u");
  const filtered = kittyText.render(90).join("\n");
  assert.match(filtered, /Testing/);
  assert.doesNotMatch(filtered, /\[116u/);
  kittyText.handleInput("\x1b[127u");
  assert.match(kittyText.render(90).join("\n"), /Routing 7/);

  const kittyNavigation = makeCenter().center;
  kittyNavigation.handleInput("\x1b[1;1B");
  kittyNavigation.handleInput("\x1b[13u");
  assert.match(kittyNavigation.render(90).join("\n"), /Analysis › Model/);

  const kittyTabs = makeCenter().center;
  kittyTabs.handleInput("\x1b[9u");
  assert.match(kittyTabs.render(90).join("\n"), /\[Roles 2\]/);
  kittyTabs.handleInput("\x1b[9;2u");
  assert.match(kittyTabs.render(90).join("\n"), /\[Routing 7\]/);

  const rapidEscape = makeCenter();
  rapidEscape.center.handleInput("\r");
  rapidEscape.center.handleInput("\x1b");
  rapidEscape.center.handleInput("\x1b");
  assert.equal(rapidEscape.closed.length, 1);
});

test("thinking routing supports inherit, all Pi levels, save errors, and narrow widths", async () => {
  const { center, savedThinking } = makeCenter();
  center.handleInput("\x1b[1;5C");
  const picker = center.render(90).join("\n");
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh / max"]) assert.match(picker, new RegExp(level));
  assert.match(picker, /inherit \/ Pi default/);
  for (let width = 1; width <= 120; width++) {
    assert.ok(center.render(width).every((line) => visibleWidth(line) <= width));
  }
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
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
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(failed.render(90).join("\n"), /Save failed.*thinking read-only/);
  assert.match(failed.render(90).join("\n"), /Thinking/);
  failed.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(retried, [null]);

  const inherited = makeCenter({
    config: { version: 2, mappings: {}, thinkingLevels: { explore: "high" } },
  });
  inherited.center.handleInput("\x1b[1;5C");
  for (let index = 0; index < 5; index++) inherited.center.handleInput("\x1b[A");
  inherited.center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
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

test("control center removes terminal controls from every untrusted display path", async () => {
  const state = profileState();
  state.global.profiles.fast.name = "\x1b[2JFast\nforged";
  state.config.profileName = "\x1b]52;c;payload\x07Fast";
  const unsafeAgent = {
    ...agent("unsafe\x1b[2Jrole"),
    description: "line one\nline two\x1b]52;c;payload\x07",
    model: "model\x1b[2J",
  };
  const unsafeActive = {
    ...active("run\x1b[2J"),
    agent: "worker\nforged",
    name: "name\x1b]52;c;payload\x07",
  };
  const { center } = makeCenter({
    state,
    initialTab: "profiles",
    agents: [unsafeAgent],
    activeAgents: [unsafeActive],
    availableModels: [{ id: "provider/unsafe\x1b[2J", reasoning: true, thinkingLevels: ["low"] }],
  });
  const rendered: string[] = [];
  rendered.push(...center.render(100));
  center.handleInput("\t");
  rendered.push(...center.render(100));
  center.handleInput("\t");
  rendered.push(...center.render(100));
  center.handleInput("\t");
  rendered.push(...center.render(100));
  for (const line of rendered) assertNoInjectedControls(line);

  const failed = makeCenter({
    saveMapping: () => { throw new Error("failed\n\x1b]52;c;payload\x07"); },
  }).center;
  failed.handleInput("\r");
  failed.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  for (const line of failed.render(100)) assertNoInjectedControls(line);
});

test("thinking picker shows the full depth range and marks model capability limits", () => {
  const openai = makeCenter({
    config: { version: 2, mappings: { explore: "openai/gpt-5" }, thinkingLevels: {} },
  }).center;
  openai.handleInput("\x1b[1;5C");
  openai.handleInput("\x1b[B");
  const openaiPicker = openai.render(90).join("\n");
  assert.match(openaiPicker, /off/);
  assert.match(openaiPicker, /minimal/);
  assert.match(openaiPicker, /high/);
  assert.match(openaiPicker, /xhigh \/ max/);
  assert.match(openaiPicker, /does not support this level/);
  assert.match(openaiPicker, /! unavailable/);

  const anthropic = makeCenter({
    config: { version: 2, mappings: { explore: "anthropic/sonnet" }, thinkingLevels: {} },
  }).center;
  anthropic.handleInput("\x1b[1;5C");
  const anthropicPicker = anthropic.render(90).join("\n");
  assert.match(anthropicPicker, /off/);
  assert.match(anthropicPicker, /xhigh \/ max/);
});

test("unsupported persisted thinking remains visible but cannot be saved", async () => {
  const { center, savedThinking } = makeCenter({
    config: {
      version: 2,
      mappings: { explore: "openai/gpt-5" },
      thinkingLevels: { explore: "xhigh" },
    },
  });
  center.handleInput("\x1b[1;5C");
  assert.match(center.render(90).join("\n"), /does not support this level/);
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedThinking, []);
  assert.match(center.render(90).join("\n"), /Unsupported/);
});

test("model routing is reversible and saves inline", async () => {
  const { center, closed, saved } = makeCenter();
  center.handleInput("\r");
  assert.match(center.render(90).join("\n"), /Explore/);
  const narrowEditor = center.render(32);
  assert.ok(narrowEditor.every((line) => visibleWidth(line) <= 32));
  assert.match(narrowEditor.join("\n"), /Explore/);
  center.handleInput("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed.length, 0);
  assert.match(center.render(90).join("\n"), /Routing 7/);

  center.handleInput("\r");
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, [{ taskType: "explore", model: "anthropic/sonnet" }]);
  assert.match(center.render(90).join("\n"), /Saved/);
});

test("model routing continues into thinking depth for the associated model", async () => {
  const { center, saved, savedThinking } = makeCenter();
  center.handleInput("\r");
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(saved, [{ taskType: "explore", model: "anthropic/sonnet" }]);
  const thinkingPicker = center.render(90).join("\n");
  assert.match(thinkingPicker, /Explore › Thinking/);
  assert.match(thinkingPicker, /Saved model · choose thinking depth for anthropic\/sonnet/);
  assert.match(thinkingPicker, /xhigh \/ max/);

  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedThinking, [{ taskType: "explore", thinking: "off" }]);
  assert.match(center.render(90).join("\n"), /Saved · explore thinking → off/);
});

test("model routing keeps the editor open when persistence fails", async () => {
  const { center } = makeCenter({
    saveMapping: () => { throw new Error("read-only project"); },
  });
  center.handleInput("\r");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(center.render(90).join("\n"), /Save failed.*read-only project/);
  center.handleInput("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(center.render(90).join("\n"), /Routing 7/);
});

test("profiles tab exposes global state and returns a reversible management action", () => {
  const { center, closed } = makeCenter({ state: profileState(), initialTab: "profiles" });
  const view = center.render(100).join("\n");
  assert.match(view, /Profiles 2/);
  assert.match(view, /Balanced/);
  assert.match(view, /default/);
  assert.match(view, /Enter manage/);
  assert.match(view, /Project overrides · ○ preserved \/ disabled/);
  for (let width = 1; width <= 120; width++) {
    assert.ok(center.render(width).every((line) => visibleWidth(line) <= width));
  }
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  assert.deepEqual(closed, [{ kind: "manage-profile", profileId: "fast", profileQuery: "", tab: "profiles" }]);
});

test("routing edits the active global Profile while surfacing runtime project overrides", () => {
  const { center } = makeCenter({ state: profileState(true) });
  const routing = center.render(100).join("\n");
  assert.match(routing, /Fast · overrides on/);
  assert.match(routing, /missing\/fast/);
  assert.match(routing, /Fallbacks · none/);
  assert.match(routing, /Project overrides are active at runtime/);
  center.handleInput("\r");
  assert.match(center.render(100).join("\n"), /missing\/fast.*active/);
});

test("attach overlay accepts pasted messages and keeps a focused tab visible", async () => {
  const now = Date.now();
  const first = {
    agent: "worker", name: "agent-1", correlationId: "agent-1", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0,
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
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(sent, ["pasted teammate message"]);
  } finally {
    overlay.dispose();
  }
});

test("attach overlay keeps the composer and recovery footer visible across height budgets", () => {
  const now = Date.now();
  const progress = Array.from({ length: 8 }, (_, taskIndex) => ({
    agent: "worker",
    name: `agent-${taskIndex + 1}`,
    correlationId: `agent-${taskIndex + 1}`,
    taskIndex,
    dependencies: [],
    status: taskIndex < 3 ? "running" as const : "pending" as const,
    recentTools: [{ name: "exec", status: "running" as const }],
    lastMessage: `stream ${taskIndex + 1}`,
  }));
  const parent = {
    agent: "graph", name: "parent", correlationId: "parent", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0, progress,
  };
  const runs = new Map([[parent.correlationId, parent]]);
  const overlay = new AttachOverlay(
    parent,
    () => {},
    () => runs,
    async () => ({ ok: true, message: "Queued" }),
  );
  try {
    overlay.setProgress(parent.correlationId, progress);
    overlay.setActiveTools(parent.correlationId, Array.from({ length: 6 }, (_, index) => ({
      name: `tool-${index + 1}`,
      status: "running" as const,
      startedAt: now,
    })));
    overlay.setStreamingText(
      parent.correlationId,
      Array.from({ length: 12 }, (_, index) => `output line ${index + 1}`).join("\n"),
    );
    overlay.handleInput("\r");
    overlay.handleInput("draft message");

    for (const height of [6, 8, 12, 16, 20, 28, 38]) {
      const lines = overlay.render(80, height);
      assert.ok(lines.length <= height, `height ${height}: rendered ${lines.length} rows`);
      assert.match(lines.join("\n"), /draft message/, `height ${height}: composer hidden`);
      assert.match(lines.join("\n"), /Esc back/, `height ${height}: recovery footer hidden`);
    }
  } finally {
    overlay.dispose();
  }
});

test("attach overlay preserves manual scroll position while new logs arrive", () => {
  const now = Date.now();
  const parent = {
    agent: "worker", name: "parent", correlationId: "parent", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0,
  };
  const runs = new Map([[parent.correlationId, parent]]);
  const overlay = new AttachOverlay(parent, () => {}, () => runs);
  try {
    for (let index = 1; index <= 20; index++) {
      overlay.appendLog(parent.correlationId, `log line ${index}`, "output");
    }
    assert.match(overlay.render(80, 20).join("\n"), /log line 20/);

    for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[A");
    assert.doesNotMatch(overlay.render(80, 20).join("\n"), /log line 20/);

    overlay.appendLog(parent.correlationId, "log line 21", "output");
    const afterRefresh = overlay.render(80, 20).join("\n");
    assert.doesNotMatch(afterRefresh, /log line 21/);
    assert.match(afterRefresh, /log line 17/);
  } finally {
    overlay.dispose();
  }
});
