import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerTeammateExtension from "../src/extension/index.ts";
import { setQuietMode } from "../src/quiet-state.ts";

// pi renders /resume history BEFORE emitting session_start, so the
// Cockpit-driven quiet mirror (cockpit:ui-ownership -> setQuietMode) is still
// false when every historical tool component first renders. The host
// ToolExecutionComponent addChild()s renderCall/renderResult return values
// unchecked and only catches throws, so a renderer returning undefined escapes
// into Box.render (child.render on undefined) and kills pi with an
// uncaughtException. Every auxiliary tool renderer must therefore be total in
// both quiet modes.

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

afterEach(() => setQuietMode(false, "check"));

type LooseRenderer = {
  renderCall?: (args: Record<string, unknown>, theme: unknown, context: unknown) => { render(width: number): string[] } | undefined;
  renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render(width: number): string[] } | undefined;
};

function registerAuxTools(): Map<string, ToolDefinition> {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
  const tools = new Map<string, ToolDefinition>();
  const events = { on: () => () => {}, emit() {} };
  const pi = new Proxy({
    events,
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });
  const savedChild = process.env.PI_TEAMMATE_CHILD;
  const savedLegacyObservationTools = process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS;
  delete process.env.PI_TEAMMATE_CHILD;
  process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS = "1";
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI);
  } finally {
    if (savedChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = savedChild;
    if (savedLegacyObservationTools === undefined) delete process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS;
    else process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS = savedLegacyObservationTools;
  }
  return tools;
}

test("auxiliary tool renderers return a Component in both quiet modes (resume contract)", () => {
  const tools = registerAuxTools();
  const cases: Array<{ name: string; args: Record<string, unknown>; result: unknown }> = [
    {
      name: "teammate-send",
      args: { to: "worker", message: "ping", mode: "follow_up" },
      result: {
        content: [{ type: "text", text: "Message queued after current turn for \"worker\"." }],
        details: { delivered: true },
      },
    },
    {
      name: "teammate-watch",
      args: { name: "worker", lines: 20 },
      result: {
        content: [{ type: "text", text: "output line" }],
        details: { output: ["output line"] },
      },
    },
    {
      name: "teammate-wait",
      args: { name: "worker" },
      result: {
        content: [{ type: "text", text: "settled" }],
        details: { status: "completed", output: ["settled"] },
      },
    },
    {
      name: "observe",
      args: { action: "wait", targets: [{ kind: "teammate", id: "worker" }, { kind: "bash_bg", id: "bg-1" }] },
      result: {
        content: [{ type: "text", text: "2 targets: all" }],
        details: {
          output: ["2 targets: all"],
          result: {
            action: "wait",
            reason: "all",
            durationMs: 12,
            observations: [
              { target: { kind: "teammate", id: "worker" }, found: true, nativeStatus: "completed", phase: "settled", waitStatus: "completed", summary: "done", updatedAt: 1 },
              { target: { kind: "bash_bg", id: "bg-1" }, found: true, nativeStatus: "completed", phase: "settled", waitStatus: "completed", summary: "done", updatedAt: 1 },
            ],
          },
        },
      },
    },
    {
      name: "teammate-monitor",
      args: { action: "status", targets: ["worker"] },
      result: {
        content: [{ type: "text", text: "snapshot" }],
        details: { output: ["snapshot"] },
      },
    },
  ];

  for (const quiet of [false, true]) {
    setQuietMode(quiet, "check");
    for (const { name, args, result } of cases) {
      const tool = tools.get(name) as (ToolDefinition & LooseRenderer) | undefined;
      assert.ok(tool, `${name} must be registered`);

      // Resume shape: completed call (isPartial false) with a persisted result.
      const callComponent = tool.renderCall?.(args, theme, { args, isPartial: false });
      assert.equal(
        typeof callComponent?.render,
        "function",
        `${name} renderCall must return a TUI Component when quiet=${quiet}`,
      );
      callComponent?.render(80);

      const resultComponent = tool.renderResult?.(result, { expanded: false, isPartial: false }, theme, { args, isPartial: false });
      assert.equal(
        typeof resultComponent?.render,
        "function",
        `${name} renderResult must return a TUI Component when quiet=${quiet}`,
      );
      resultComponent?.render(80);

      // Live streaming shape: partial args, partial result.
      const partialCall = tool.renderCall?.(args, theme, { args, isPartial: true });
      assert.equal(
        typeof partialCall?.render,
        "function",
        `${name} renderCall (streaming) must return a TUI Component when quiet=${quiet}`,
      );
      partialCall?.render(80);

      const partialResult = tool.renderResult?.(result, { expanded: false, isPartial: true }, theme, { args, isPartial: true });
      assert.equal(
        typeof partialResult?.render,
        "function",
        `${name} renderResult (streaming) must return a TUI Component when quiet=${quiet}`,
      );
    }
  }
});

test("non-quiet fallback mirrors the host default rendering instead of hiding output", () => {
  setQuietMode(false, "check");
  const tools = registerAuxTools();
  const send = tools.get("teammate-send") as (ToolDefinition & LooseRenderer) | undefined;
  assert.ok(send);

  const call = send.renderCall?.({ to: "worker", mode: "steer" }, theme, { args: {}, isPartial: true });
  assert.deepEqual(call?.render(80).map((line) => line.trimEnd()), ["teammate-send"]);

  const result = send.renderResult?.(
    { content: [{ type: "text", text: "Message interrupted + injected for \"worker\"." }], details: { delivered: true } },
    { expanded: false, isPartial: false },
    theme,
    { args: {}, isPartial: false },
  );
  assert.deepEqual(result?.render(80).map((line) => line.trimEnd()), ["Message interrupted + injected for \"worker\"."]);

  const empty = send.renderResult?.(
    { content: [], details: { delivered: false } },
    { expanded: false, isPartial: false },
    theme,
    { args: {}, isPartial: false },
  );
  assert.equal(typeof empty?.render, "function");
  assert.deepEqual(empty?.render(80), []);
});

test("quiet mode renders auxiliary communication as a structured card", () => {
  setQuietMode(true, "check");
  const tools = registerAuxTools();
  const send = tools.get("teammate-send") as (ToolDefinition & LooseRenderer) | undefined;
  assert.ok(send);
  const result = send.renderResult?.(
    { content: [{ type: "text", text: "delivered" }], details: { delivered: true } },
    { expanded: false, isPartial: false },
    theme,
    { args: {}, isPartial: false },
  );
  const lines = result?.render(80) ?? [];
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /^╭─ ✓ teammate-send · @\? · steer · delivered$/);
  assert.equal(lines[1], "│ delivered");
  assert.match(lines[2] ?? "", /^╰─/);
});

test("auxiliary renderers never leak the quiet-only undefined through an as-never cast", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /renderQuietTeammateAux\([\s\S]{0,220}?\) as never/,
    "renderQuietTeammateAux returns undefined outside quiet mode; tool slots must fall back to a Component",
  );
});
