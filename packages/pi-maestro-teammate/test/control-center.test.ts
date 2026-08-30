import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import {
  TeammateControlCenter,
  showModelMappingOverlay,
  type ControlCenterActiveAgent,
} from "../src/tui/model-mapping-overlay.ts";
import type { AgentConfig } from "../src/agents/agents.ts";
import type { ModelRoutingState } from "../src/models/model-routing.ts";
import type { RemoteConfigState } from "../src/remote/config.ts";
import { REMOTE_CONFIG_VERSION } from "../src/remote/types.ts";

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
    askBeforeDispatch: false,
    requestedProfile: "fast",
  };
}

function makeCenter(overrides: Partial<ConstructorParameters<typeof TeammateControlCenter>[0]> = {}) {
  const closed: unknown[] = [];
  const saved: Array<{ taskType: string; model: string | null }> = [];
  const savedThinking: Array<{ taskType: string; thinking: string | null }> = [];
  const savedRoleRules: Array<{ role: string; rules: unknown }> = [];
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
    saveRoleRules: (role, rules) => savedRoleRules.push({ role, rules }),
    ...overrides,
  });
  return { center, closed, saved, savedThinking, savedRoleRules };
}

function remoteState(): RemoteConfigState {
  return {
    global: {
      version: REMOTE_CONFIG_VERSION,
      hosts: {
        "linux-a": {
          host: "linux-a.example",
          user: "dev",
          port: 22,
          hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
      targets: {
        "linux-a/pi": {
          host: "linux-a",
          cwd: "/srv/project",
          driver: "pi-rpc",
          command: ["pi"],
        },
      },
      workspaces: {},
    },
    project: { version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {}, workspaces: {} },
    config: {
      version: REMOTE_CONFIG_VERSION,
      hosts: {
        "linux-a": {
          host: "linux-a.example",
          user: "dev",
          port: 22,
          hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
      targets: {
        "linux-a/pi": {
          host: "linux-a",
          cwd: "/srv/project",
          driver: "pi-rpc",
          command: ["pi"],
        },
      },
      workspaces: {},
    },
  };
}

test("connections tab renders the pane and forwards pane actions with scope", () => {
  const { center, closed } = makeCenter({ initialTab: "connections", remoteState: remoteState() });
  const wide = center.render(100).join("\n");
  assert.match(wide, /Connections/);
  assert.match(wide, /\[global ●\]/);
  assert.match(wide, /\[H\] linux-a/);
  assert.match(wide, /\[T\] linux-a\/pi/);
  assert.match(wide, /pi-rpc · \/srv\/project/);

  center.handleInput("n");
  assert.deepEqual(closed[0], { kind: "remote-new-host", scope: "global" });

  center.handleInput("N");
  assert.deepEqual(closed[1], { kind: "remote-new-target", scope: "global" });

  center.handleInput("\t");
  const afterTab = center.render(100).join("\n");
  assert.match(afterTab, /Connections 2/);
  assert.match(afterTab, /\[Active 2\]/);
});

test("connections tab without remote state falls back to the standard list view", () => {
  const { center } = makeCenter({ initialTab: "connections" });
  const wide = center.render(100).join("\n");
  assert.match(wide, /Connections 0/);
  assert.match(wide, /Active/);
});

test("connections keeps the stable roles-to-active tab order and zh-CN label", () => {
  const { center } = makeCenter({ initialTab: "roles" });
  center.handleInput("\x1b[C");
  assert.match(center.render(100).join("\n"), /\[Connections 0\]/);
  center.handleInput("\x1b[C");
  assert.match(center.render(100).join("\n"), /\[Active 2\]/);

  const localized = makeCenter({ initialTab: "connections", locale: "zh-CN" }).center;
  assert.match(localized.render(100).join("\n"), /\[连接 0\]/);
});

test("active detail shows the resolved working location", () => {
  const { center } = makeCenter({
    initialTab: "active",
    activeAgents: [{ ...active("worker-1"), cwd: "D:/workspace/project" }],
  });
  const wide = center.render(100).join("\n");
  assert.match(wide, /Location · D:\/workspace\/project/);
});

test("active detail defaults the location label for agents without a cwd", () => {
  const { center } = makeCenter({ initialTab: "active", activeAgents: [active("worker-1")] });
  const wide = center.render(100).join("\n");
  assert.match(wide, /Location · current workspace/);
});

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

test("arrow navigation switches tabs and opens settings with cursor actions", () => {
  const { center } = makeCenter();
  assert.match(center.render(100).join("\n"), /\[Routing 7\]/);
  center.handleInput("\x1b[C");
  assert.match(center.render(100).join("\n"), /\[Roles 2\]/);
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  assert.match(center.render(100).join("\n"), /@reviewer › Settings/);
  center.handleInput("\x1b[B");
  center.handleInput("\x1b[C");
  assert.match(center.render(100).join("\n"), /@reviewer › Model/);
  center.handleInput("\x1b");
  assert.match(center.render(100).join("\n"), /@reviewer › Settings/);
  center.handleInput("\x1b[C");
  assert.match(center.render(100).join("\n"), /@reviewer › Type/);
  center.handleInput("\x1b[D");
  assert.match(center.render(100).join("\n"), /@reviewer › Settings/);
  center.handleInput("\x1b");
  assert.match(center.render(100).join("\n"), /\[Roles 2\]/);
  center.handleInput("\x1b[D");
  assert.match(center.render(100).join("\n"), /\[Routing 7\]/);
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
  assert.match(kittyNavigation.render(90).join("\n"), /Analysis › Settings/);
  kittyNavigation.handleInput("\x1b[C");
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
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.match(picker, new RegExp(level));
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

test("thinking picker shows the full depth range and never restricts levels by model", () => {
  const openai = makeCenter({
    config: { version: 2, mappings: { explore: "openai/gpt-5" }, thinkingLevels: {} },
  }).center;
  openai.handleInput("\x1b[1;5C");
  openai.handleInput("\x1b[B");
  const openaiPicker = openai.render(90).join("\n");
  assert.match(openaiPicker, /off/);
  assert.match(openaiPicker, /minimal/);
  assert.match(openaiPicker, /medium/);
  assert.match(openaiPicker, /high/);
  assert.match(openaiPicker, /xhigh/);
  assert.match(openaiPicker, /max/);
  assert.doesNotMatch(openaiPicker, /does not support this level/);
  assert.doesNotMatch(openaiPicker, /! unavailable/);

  const anthropic = makeCenter({
    config: { version: 2, mappings: { explore: "anthropic/sonnet" }, thinkingLevels: {} },
  }).center;
  anthropic.handleInput("\x1b[1;5C");
  const anthropicPicker = anthropic.render(90).join("\n");
  assert.match(anthropicPicker, /off/);
  assert.match(anthropicPicker, /xhigh/);
  assert.match(anthropicPicker, /max/);
});

test("persisted thinking depth beyond declared capabilities stays selectable and saves", async () => {
  const { center, savedThinking } = makeCenter({
    config: {
      version: 2,
      mappings: { explore: "openai/gpt-5" },
      thinkingLevels: { explore: "xhigh" },
    },
  });
  center.handleInput("\x1b[1;5C");
  assert.match(center.render(90).join("\n"), /xhigh/);
  assert.match(center.render(90).join("\n"), /max/);
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedThinking, [{ taskType: "explore", thinking: "xhigh" }]);
  assert.match(center.render(90).join("\n"), /Saved · explore thinking → xhigh/);
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
  center.handleInput("\r");
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved.slice(), [{ taskType: "explore", model: "anthropic/sonnet" }]);
  assert.match(center.render(90).join("\n"), /Saved/);
});

test("model and thinking routing are independently selectable settings", async () => {
  const { center, saved, savedThinking } = makeCenter();
  center.handleInput("\r"); // Settings
  assert.match(center.render(90).join("\n"), /Explore › Settings/);
  center.handleInput("\r"); // Model
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(saved.slice(), [{ taskType: "explore", model: "anthropic/sonnet" }]);
  const settings = center.render(90).join("\n");
  assert.match(settings, /Explore › Settings/);
  assert.match(settings, /Saved · explore model → anthropic\/sonnet/);

  center.handleInput("\x1b[B"); // Thinking
  center.handleInput("\r");
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
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(center.render(90).join("\n"), /Save failed.*read-only project/);
  assert.match(center.render(90).join("\n"), /Explore › Model/);
  center.handleInput("\x1b");
  assert.match(center.render(90).join("\n"), /Explore › Settings/);
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

test("roles tab exposes independently selectable type, model, and thinking settings", async () => {
  const { center, savedRoleRules } = makeCenter({ initialTab: "roles" });
  center.handleInput("\r");
  const settings = center.render(100).join("\n");
  assert.match(settings, /@planner › Settings/);
  assert.match(settings, /Type/);
  assert.match(settings, /Model override/);
  assert.match(settings, /Thinking override/);
  for (let width = 1; width <= 120; width++) {
    assert.ok(center.render(width).every((line) => visibleWidth(line) <= width));
  }

  center.handleInput("\x1b[B"); // Model override
  center.handleInput("\x1b[C");
  assert.match(center.render(100).join("\n"), /@planner › Model/);
  center.handleInput("\x1b[B");
  center.handleInput("\x1b[B"); // openai/gpt-5 (models sort alphabetically)
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedRoleRules, [{ role: "planner", rules: { model: "openai/gpt-5" } }]);
  assert.match(center.render(100).join("\n"), /@planner › Settings/);

  center.handleInput("\x1b[B");
  center.handleInput("\x1b[B"); // Thinking override
  center.handleInput("\r");
  assert.match(center.render(100).join("\n"), /@planner › Thinking/);
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedRoleRules, [
    { role: "planner", rules: { model: "openai/gpt-5" } },
    { role: "planner", rules: { model: "openai/gpt-5", thinking: "off" } },
  ]);
  assert.match(center.render(100).join("\n"), /Saved · @planner thinking → off/);
});

test("Ctrl+O opens the per-role circuit editor and preset Enter saves the policy", async () => {
  const { center, savedRoleRules } = makeCenter({ initialTab: "roles" });
  center.handleInput("\x0f"); // Ctrl+O
  const editor = center.render(100).join("\n");
  assert.match(editor, /@planner › Circuit/);
  assert.match(editor, /default · 3 failures \/ 60s/);
  assert.match(editor, /strict · 2 failures \/ 30s/);
  assert.match(editor, /lenient · 5 failures \/ 300s/);
  assert.match(editor, /custom/);
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedRoleRules, [
    { role: "planner", rules: { circuit: { threshold: 2, cooldownMs: 30_000 } } },
  ]);
  assert.match(center.render(100).join("\n"), /Saved · @planner circuit → 2 failures \/ 30s/);
});

test("circuit editor accepts custom threshold/cooldown input and rejects invalid drafts", async () => {
  const { center, savedRoleRules } = makeCenter({ initialTab: "roles" });
  center.handleInput("\x0f");
  center.handleInput("\x1b[B");
  center.handleInput("\x1b[B");
  center.handleInput("\x1b[B"); // custom
  center.handleInput("\r");
  assert.match(center.render(100).join("\n"), /threshold\/cooldown \(e\.g\. 4\/120\)/);
  center.handleInput("4/120");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedRoleRules, [
    { role: "planner", rules: { circuit: { threshold: 4, cooldownMs: 120_000 } } },
  ]);

  const invalid = makeCenter({ initialTab: "roles" }).center;
  invalid.handleInput("\x0f");
  invalid.handleInput("\x1b[B");
  invalid.handleInput("\x1b[B");
  invalid.handleInput("\x1b[B");
  invalid.handleInput("\r");
  invalid.handleInput("0/30");
  invalid.handleInput("\r");
  assert.match(invalid.render(100).join("\n"), /Invalid circuit/);
  invalid.handleInput("\x1b");
  assert.doesNotMatch(invalid.render(100).join("\n"), /Invalid circuit/);
});

test("Ctrl+F opens the per-role fallback editor and saves the chain as role rules", async () => {
  const { center, savedRoleRules } = makeCenter({ initialTab: "roles" });
  center.handleInput("\x06"); // Ctrl+F
  assert.match(center.render(100).join("\n"), /@planner › Fallback/);
  center.handleInput("\x1b[B"); // openai/gpt-5 (models sort alphabetically)
  center.handleInput(" ");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedRoleRules, [{ role: "planner", rules: { fallbackModels: ["openai/gpt-5"] } }]);
  assert.match(center.render(100).join("\n"), /Saved fallbacks · openai\/gpt-5/);
});

test("roles tab shows configured role model and circuit policy from the active profile", () => {
  const state = profileState();
  state.global.profiles.fast.roleMappings = {
    planner: { model: "openai/gpt-5", circuit: { threshold: 4, cooldownMs: 120_000 } },
  };
  const { center } = makeCenter({ state, initialTab: "roles" });
  const view = center.render(100).join("\n");
  assert.match(view, /@planner.*openai\/gpt-5/);
  assert.match(view, /Effective model · openai\/gpt-5/);
  assert.match(view, /Circuit · 4 failures \/ 120s/);
  assert.match(view, /Enter settings/);
});

test("Ctrl+N creates a custom agent type, normalizes case, and selects it in routing", async () => {
  const created: string[] = [];
  const { center } = makeCenter({ saveCustomType: (taskType) => created.push(taskType) });
  center.handleInput("\x0e"); // Ctrl+N
  assert.match(center.render(100).join("\n"), /type identifier \(e\.g\. security-audit\)/);
  for (let width = 1; width <= 120; width++) {
    assert.ok(center.render(width).every((line) => visibleWidth(line) <= width));
  }
  center.handleInput("Security-Audit");
  center.handleInput("\r");
  assert.match(center.render(100).join("\n"), /Keywords for security-audit/);
  center.handleInput("\r"); // empty keywords: skip
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(created, ["security-audit"]);
  const view = center.render(100).join("\n");
  assert.match(view, /Created custom type security-audit/);
  assert.match(view, /Security Audit/);
  assert.doesNotMatch(view, /type identifier/);
});

test("custom type creation rejects invalid, built-in, and duplicate identifiers", async () => {
  const created: string[] = [];
  const invalid = makeCenter({ saveCustomType: (taskType) => created.push(taskType) }).center;
  invalid.handleInput("\x0e");
  invalid.handleInput("no spaces");
  invalid.handleInput("\r");
  assert.match(invalid.render(100).join("\n"), /Invalid type/);

  const builtin = makeCenter({ saveCustomType: (taskType) => created.push(taskType) }).center;
  builtin.handleInput("\x0e");
  builtin.handleInput("explore");
  builtin.handleInput("\r");
  assert.match(builtin.render(100).join("\n"), /Cannot register a built-in type/);
  assert.deepEqual(created, [] as string[]);

  const duplicate = makeCenter({
    saveCustomType: (taskType: string) => created.push(taskType),
    config: { version: 2, mappings: { "security-audit": null }, thinkingLevels: {} },
  }).center;
  duplicate.handleInput("\x0e");
  duplicate.handleInput("security-audit");
  duplicate.handleInput("\r");
  assert.match(duplicate.render(100).join("\n"), /already exists/);
  assert.deepEqual(created, [] as string[]);
});

test("Ctrl+D deletes a custom agent type and its routing entries", async () => {
  const deleted: string[] = [];
  const { center } = makeCenter({
    deleteCustomType: (taskType) => deleted.push(taskType),
    config: {
      version: 2,
      mappings: { "security-audit": "openai/gpt-5" },
      fallbackMappings: { "security-audit": ["anthropic/sonnet"] },
      thinkingLevels: { "security-audit": "high" },
      roleMappings: { planner: { model: "openai/gpt-5", taskType: "security-audit" } },
    },
  });
  center.handleInput("audit");
  center.handleInput("\x04"); // Ctrl+D
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(deleted, ["security-audit"]);
  const view = center.render(100).join("\n");
  assert.match(view, /Deleted custom type security-audit/);
  assert.doesNotMatch(view, /Security Audit/);
  for (let index = 0; index < "audit".length; index++) center.handleInput("\x7f");
  center.handleInput("\x1b[C");
  const roleView = center.render(100).join("\n");
  assert.match(roleView, /Type · unassigned \/ inferred/);
  assert.match(roleView, /Role model override · openai\/gpt-5/);
});

test("Ctrl+D refuses to delete built-in types", async () => {
  const { center } = makeCenter();
  center.handleInput("\x04"); // Ctrl+D on the first built-in routing entry
  assert.match(center.render(100).join("\n"), /Built-in types cannot be deleted/);
});
test("custom type creation accepts comma-separated trigger keywords", async () => {
  const created: Array<{ taskType: string; meta?: unknown }> = [];
  const { center } = makeCenter({
    saveCustomType: (taskType, meta) => created.push({ taskType, meta }),
  });
  center.handleInput("\x0e"); // Ctrl+N
  center.handleInput("security-audit");
  center.handleInput("\r");
  center.handleInput("audit, Security Evidence");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(created, [{
    taskType: "security-audit",
    meta: { keywords: ["audit", "security evidence"] },
  }]);
  assert.match(center.render(100).join("\n"), /Keywords \u00b7 audit, security evidence/);
});

test("Ctrl+E edits and clears trigger keywords for the selected type", async () => {
  const saved: Array<{ taskType: string; meta: unknown }> = [];
  const { center } = makeCenter({
    saveTypeMeta: (taskType, meta) => saved.push({ taskType, meta }),
    config: { version: 2, mappings: {}, thinkingLevels: {} },
  });
  center.handleInput("\x05"); // Ctrl+E on explore
  assert.match(center.render(100).join("\n"), /Keywords for explore/);
  center.handleInput("definition lookup, call sites");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved.slice(), [{ taskType: "explore", meta: { keywords: ["definition lookup", "call sites"] } }]);
  assert.match(center.render(100).join("\n"), /Saved keywords for explore/);
  assert.match(center.render(100).join("\n"), /Keywords \u00b7 definition lookup, call sites/);

  // Empty draft clears the keywords.
  const cleared = makeCenter({
    saveTypeMeta: (taskType, meta) => saved.push({ taskType, meta }),
    config: {
      version: 2,
      mappings: {},
      thinkingLevels: {},
      typeMeta: { explore: { keywords: ["definition lookup"] } },
    },
  }).center;
  cleared.handleInput("\x05");
  for (let index = 0; index < "definition lookup".length; index++) cleared.handleInput("\x7f");
  cleared.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved[1], { taskType: "explore", meta: { keywords: null } });
  assert.match(cleared.render(100).join("\n"), /Cleared keywords for explore/);
  assert.doesNotMatch(cleared.render(100).join("\n"), /Keywords \u00b7/);
});


test("routing tab offers a visible + New custom type entry that opens creation", () => {
  const { center } = makeCenter();
  const view = center.render(100).join("\n");
  assert.match(view, /\+ New custom type/);
  assert.match(view, /Ctrl\+N/);
  center.handleInput("\x1b[B"); // move down 7 times to reach the entry
  for (let index = 0; index < 6; index++) center.handleInput("\x1b[B");
  center.handleInput("\r");
  assert.match(center.render(100).join("\n"), /type identifier \(e\.g\. security-audit\)/);
});

test("Ctrl+T assigns a task type to a role via cursor selection", async () => {
  const savedRoleRules: Array<{ role: string; rules: unknown }> = [];
  const { center } = makeCenter({
    initialTab: "roles",
    saveRoleRules: (role, rules) => savedRoleRules.push({ role, rules }),
  });
  center.handleInput("\x14"); // Ctrl+T
  const picker = center.render(100).join("\n");
  assert.match(picker, /@planner › Type/);
  assert.match(picker, /auto \/ agent frontmatter/);
  assert.match(picker, /Explore/);
  center.handleInput("\x1b[B"); // explore
  center.handleInput("\x1b[B"); // analysis
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedRoleRules, [{ role: "planner", rules: { taskType: "analysis" } }]);
  assert.match(center.render(100).join("\n"), /Saved · @planner type → analysis/);
});

test("role detail shows the assigned type and auto restores the agent frontmatter type", async () => {
  const savedRoleRules: Array<{ role: string; rules: unknown }> = [];
  const { center } = makeCenter({
    initialTab: "roles",
    saveRoleRules: (role, rules) => savedRoleRules.push({ role, rules }),
  });
  assert.match(center.render(100).join("\n"), /Type · unassigned \/ inferred/);
  center.handleInput("\x14"); // Ctrl+T
  center.handleInput("\r"); // auto restores
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(savedRoleRules, [{ role: "planner", rules: { taskType: null } }]);
});

test("type settings assign multiple roles with cursor toggles", async () => {
  const saved: Array<{ taskType: string; roles: readonly string[] }> = [];
  const { center } = makeCenter({
    saveTypeRoles: (taskType, roles) => saved.push({ taskType, roles: [...roles] }),
  });
  center.handleInput("\r"); // Explore settings
  for (let index = 0; index < 3; index++) center.handleInput("\x1b[B"); // Roles
  center.handleInput("\x1b[C");
  const picker = center.render(100).join("\n");
  assert.match(picker, /Explore › Roles/);
  assert.match(picker, /@planner/);
  assert.match(picker, /@reviewer/);
  center.handleInput(" ");
  center.handleInput("\x1b[B");
  center.handleInput(" ");
  center.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, [{ taskType: "explore", roles: ["planner", "reviewer"] }]);
  assert.match(center.render(100).join("\n"), /Saved roles · @planner, @reviewer/);
  assert.match(center.render(100).join("\n"), /@planner, @reviewer/);

  center.handleInput("\x1b");
  center.handleInput("\x1b[C"); // Roles tab
  const roleView = center.render(100).join("\n");
  assert.match(roleView, /Type · explore/);
});

test("role assigned type shows the type model ahead of its role model override", () => {
  const { center } = makeCenter({
    initialTab: "roles",
    config: {
      version: 2,
      mappings: { analysis: "openai/gpt-5" },
      thinkingLevels: { analysis: "high" },
      roleMappings: {
        planner: { taskType: "analysis", model: "anthropic/sonnet", thinking: "low" },
      },
    },
  });
  const detail = center.render(100).join("\n");
  assert.match(detail, /Type · analysis/);
  assert.match(detail, /Effective model · openai\/gpt-5 · type analysis/);
  assert.match(detail, /Role model override · anthropic\/sonnet/);

  center.handleInput("\r");
  const settings = center.render(100).join("\n");
  assert.match(settings, /Type.*configured/);
  assert.match(settings, /analysis · routes to openai\/gpt-5/);
  center.handleInput("\x1b[B");
  assert.match(center.render(100).join("\n"), /anthropic\/sonnet · fallback behind analysis/);
});

function registryDocument(): Record<string, unknown> {
  return {
    version: 2,
    mode: "model-registry",
    default: "local",
    defaultModel: "fast-model",
    backends: { local: { module: "pi-subprocess" } },
    models: {
      "fast-model": {
        modelId: "provider/fast",
        deployment: "local",
        selector: { kind: "adapter-model", value: "provider/fast" },
        deploymentDefault: true,
      },
    },
  };
}

function writeManifest(cwd: string, document: Record<string, unknown>): string {
  const file = path.join(cwd, ".pi", "teammate-backends.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return file;
}

test("deployment edit routes through the connections wizard and refreshes the catalog", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "control-center-edit-"));
  const file = writeManifest(cwd, registryDocument());
  let overlays = 0;
  let refreshes = 0;
  let inputCalls = 0;
  const ctx = {
    cwd,
    ui: {
      custom(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          if (overlays++ === 0) {
            component.handleInput("\x1b[C");
            component.handleInput("\x1b[C");
            assert.match(component.render(100).join("\n"), /\[D\] fast-model/);
            component.handleInput("\r");
          } else {
            component.handleInput("\x1b");
          }
        });
      },
      async select(_prompt: string, choices: string[]) { return choices[0]; },
      async input() { return inputCalls++ === 0 ? "4000" : ""; },
      async confirm() { return true; },
      notify() {},
    },
  } as never;
  try {
    await showModelMappingOverlay(ctx, [], {
      remoteState: remoteState(),
      refreshModelCatalog: () => {
        refreshes += 1;
        return [{ id: "fast-model", reasoning: false }];
      },
    });
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as {
      backends: { local: { config?: Record<string, unknown> } };
    };
    assert.equal(written.backends.local.config?.firstActivityTimeoutMs, 4000);
    assert.equal(refreshes, 1);
    assert.equal(overlays, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("add deployment is reachable from the connections pane", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "control-center-add-"));
  writeManifest(cwd, registryDocument());
  let overlays = 0;
  const prompts: string[] = [];
  const ctx = {
    cwd,
    ui: {
      custom(factory: (...args: unknown[]) => { handleInput(data: string): void }) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          if (overlays++ === 0) {
            component.handleInput("\x1b[C");
            component.handleInput("\x1b[C");
            component.handleInput("a");
          } else {
            component.handleInput("\x1b");
          }
        });
      },
      async select(prompt: string) { prompts.push(prompt); return undefined; },
      async input() { return undefined; },
      async confirm() { return false; },
      notify() {},
    },
  } as never;
  try {
    await showModelMappingOverlay(ctx, [], { remoteState: remoteState() });
    assert.deepEqual(prompts, ["Backend family"]);
    assert.equal(overlays, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy registry row routes to the upgrade wizard preview", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "control-center-legacy-"));
  writeManifest(cwd, {
    version: 1,
    default: "legacy",
    backends: { legacy: { module: "pi-subprocess" } },
  });
  let overlays = 0;
  const confirmations: string[] = [];
  const ctx = {
    cwd,
    ui: {
      custom(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          if (overlays++ === 0) {
            component.handleInput("\x1b[C");
            component.handleInput("\x1b[C");
            assert.match(component.render(100).join("\n"), /Legacy registry document/);
            component.handleInput("\r");
          } else {
            component.handleInput("\x1b");
          }
        });
      },
      async select() { return undefined; },
      async input() { return undefined; },
      async confirm(prompt: string) { confirmations.push(prompt); return false; },
      notify() {},
    },
  } as never;
  try {
    await showModelMappingOverlay(ctx, [], { remoteState: remoteState() });
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0]!, /computed v2 skeleton/);
    assert.match(confirmations[0]!, /legacy file will not be changed/i);
    assert.equal(fs.existsSync(path.join(cwd, ".pi", "teammate-backends.json.upgraded.json")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
