import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildViewingRenderState,
  createViewingEntryComponent,
  renderViewingEntry,
  TEAMMATE_VIEW_CUSTOM_TYPE,
  VIEWING_BODY_MAX_CHARS,
  VIEWING_TOOL_MAX_LINES,
  type ViewingEntryContext,
} from "../src/tui/viewing-entry.ts";
import type { ProgressPalette } from "../src/tui/progress-tree.ts";

/** Real ANSI palette — codes have zero visible width, so width math stays correct. */
const palette: ProgressPalette = {
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  accent: (s) => `\x1b[36m${s}\x1b[39m`,
  running: (s) => `\x1b[33m${s}\x1b[39m`,
  success: (s) => `\x1b[32m${s}\x1b[39m`,
  error: (s) => `\x1b[31m${s}\x1b[39m`,
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
};

function context(overrides: Partial<ViewingEntryContext> = {}): ViewingEntryContext {
  return {
    data: {
      correlationId: "cid-1",
      agent: "explorer",
      name: "search",
      status: "running",
      streamingText: "Scanning for auth middleware…",
      toolLines: [{ name: "rg", status: "completed" }, { name: "read", status: "running" }],
      toolCount: 2,
      inputTokens: 1200,
      outputTokens: 3400,
      durationMs: 12_000,
    },
    ...overrides,
  };
}

test("TEAMMATE_VIEW_CUSTOM_TYPE is namespaced", () => {
  assert.equal(TEAMMATE_VIEW_CUSTOM_TYPE, "pi-teammate-view");
});

test("renderViewingEntry: header carries identity, status, and meta", () => {
  const lines = renderViewingEntry(buildViewingRenderState(context()), 80, palette);
  assert.match(lines[0], /@search/);
  assert.match(lines[0], /\(explorer\)/);
  // running tone → warning (yellow) ANSI.
  assert.match(lines[0], /\x1b\[33mrunning\x1b\[39m/);
  assert.match(lines[0], /12s/);
  assert.match(lines[0], /2 tools/);
  assert.match(lines[0], /in 1.2k\/out 3.4k/);
});

test("renderViewingEntry: completed status renders with success tone", () => {
  const state = buildViewingRenderState(context({
    data: { ...context().data, status: "completed", streamingText: "" },
  }));
  const header = renderViewingEntry(state, 80, palette)[0];
  assert.match(header, /\x1b\[32msleeping · completed\x1b\[39m/);
});

test("renderViewingEntry: body is the streaming markdown text", () => {
  const lines = renderViewingEntry(buildViewingRenderState(context()), 80, palette);
  // The body must contain the agent text verbatim (no prefix, no wrap marker).
  assert.ok(lines.some((line) => line.includes("Scanning for auth middleware")));
});

test("buildViewingRenderState: live data wins while active, snapshot otherwise", () => {
  const live = {
    status: "sleeping",
    startedAt: Date.now() - 5000,
    streamingText: "live text",
    toolLines: [{ name: "edit", status: "running" }],
    switches: ["@search", "@build"],
    activeIndex: 0,
    canSend: true,
  };
  const activeState = buildViewingRenderState(context({ live }));
  assert.equal(activeState.active, true);
  assert.equal(activeState.bodyText, "live text");
  assert.equal(activeState.status, "sleeping");
  assert.deepEqual(activeState.switches, ["@search", "@build"]);
  assert.equal(activeState.activeIndex, 0);
  assert.equal(activeState.canSend, true);

  const frozenState = buildViewingRenderState(context());
  assert.equal(frozenState.active, false);
  assert.equal(frozenState.bodyText, "Scanning for auth middleware…");
  assert.equal(frozenState.status, "running");
  assert.equal(frozenState.switches, undefined);
  assert.equal(frozenState.canSend, false);
});

test("renderViewingEntry: switcher row shows only while live with >1 agent", () => {
  const live = {
    status: "running",
    streamingText: "x",
    switches: ["@search", "@build"],
    activeIndex: 1,
    canSend: true,
  };
  const activeLines = renderViewingEntry(buildViewingRenderState(context({ live })), 80, palette);
  assert.ok(activeLines.some((line) => line.includes("@search") && line.includes("@build")));
  assert.ok(activeLines.some((line) => line.includes("\x1b[36m▸\x1b[39m") && line.includes("@build")));
  // Only one switchable agent → no switcher row.
  const single = renderViewingEntry(
    buildViewingRenderState(context({ live: { ...live, switches: ["@search"], activeIndex: 0 } })),
    80,
    palette,
  );
  assert.ok(!single.some((line) => line.includes("▸")));
  // Frozen entries never render the switcher row.
  const frozen = renderViewingEntry(buildViewingRenderState(context()), 80, palette);
  assert.ok(!frozen.some((line) => line.includes("▸")));
});

test("renderViewingEntry: tool lines render with status markers, capped", () => {
  const many = Array.from({ length: VIEWING_TOOL_MAX_LINES + 4 }, (_, i) => ({
    name: `tool-${i}`,
    status: "completed" as const,
  }));
  const state = buildViewingRenderState(context({ live: { status: "running", streamingText: "x", toolLines: many, canSend: true } }));
  const lines = renderViewingEntry(state, 80, palette);
  const toolLines = lines.filter((line) => /tool-\d+/.test(line));
  assert.equal(toolLines.length, VIEWING_TOOL_MAX_LINES);
  assert.ok(toolLines.every((line) => line.includes("\x1b[32m✓\x1b[39m")));
});

test("renderViewingEntry: footer hints appear only while live", () => {
  const live = { status: "running", streamingText: "x", canSend: true };
  const activeLines = renderViewingEntry(buildViewingRenderState(context({ live })), 80, palette);
  assert.ok(activeLines.some((line) => line.includes("Esc main")));
  const frozen = renderViewingEntry(buildViewingRenderState(context()), 80, palette);
  assert.ok(!frozen.some((line) => line.includes("Esc main")));
});

test("buildViewingRenderState: body is capped to the max length", () => {
  const long = "y".repeat(VIEWING_BODY_MAX_CHARS + 500);
  const state = buildViewingRenderState(context({ live: { status: "running", streamingText: long, canSend: true } }));
  assert.ok(state.bodyText.length <= VIEWING_BODY_MAX_CHARS);
});

test("createViewingEntryComponent: no rendered line exceeds the width (crash regression)", () => {
  const state = context({
    data: {
      ...context().data,
      streamingText: `${"x".repeat(400)}\nsecond line ${"y".repeat(300)}`,
      toolLines: [{ name: "VeryLongToolName".repeat(4), status: "running" }],
    },
    live: {
      status: "running",
      streamingText: `${"x".repeat(400)}\nsecond line ${"y".repeat(300)}`,
      toolLines: [
        { name: "VeryLongToolName".repeat(4), status: "running" },
        { name: "read", status: "completed" },
      ],
      switches: ["@cockpit-verify", "@teammate-verify", "@cross-review", "@teammate"],
      activeIndex: 3,
      canSend: true,
    },
  });
  const component = createViewingEntryComponent(() => buildViewingRenderState(state), palette);
  for (const width of [40, 80, 92, 120, 200]) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `@ ${width}: ${visibleWidth(line)} > ${width}`);
    }
  }
});

test("buildViewingRenderState: live duration grows from startedAt", () => {
  const startedAt = Date.now() - 65_000;
  const state = buildViewingRenderState(context({ live: { status: "running", startedAt, canSend: true } }));
  assert.ok(state.durationMs! >= 60_000);
  assert.ok(state.durationMs! < 70_000);
});
