import { altKey } from "pi-maestro-settings-core/v1";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isQuietMode, setQuietMode } from "../src/quiet-state.ts";
import {
  auxToolCallFallback,
  auxToolResultFallback,
  renderCompletionOutboxMessage,
  renderMonitorResult,
  renderObserveResult,
  renderQuietTeammateAux,
  renderTeammateCompletionFallbackMessage,
  renderTeammateCompletionMessage,
  renderTeammateStalledMessage,
  renderTeammateCall,
  renderTeammateListCall,
  renderTeammateListResult,
  renderTeammateResult,
  renderTeammateSendResult,
} from "../src/tui/render.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, SingleResult } from "../src/shared/types.ts";

/** `altKey` escaped for use inside a regular expression: `+` is a metacharacter. */
const altRe = (key: string): string => altKey(key).replaceAll("+", "\\+");

// Identity theme strips color so assertions read the plain text the quiet
// renderer emits (two spaces + glyph + name + rest).
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

afterEach(() => setQuietMode(false, "check"));

function okResult(): SingleResult {
  return {
    agent: "scout",
    name: "inspection",
    task: "inspect",
    exitCode: 0,
    messages: [{ role: "assistant", content: "complete output" }],
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "test-model",
    correlationId: "scout-correlation",
    durationMs: 1000,
  };
}

function failedResult(): SingleResult {
  return {
    ...okResult(),
    exitCode: 1,
    messages: [{ role: "assistant", content: "boom error line\nstack trace noise" }],
  };
}

test("quiet flag mirror flips with setQuietMode", () => {
  setQuietMode(true);
  assert.equal(isQuietMode(), true);
  setQuietMode(false);
  assert.equal(isQuietMode(), false);
});

test("quiet auxiliary teammate surfaces use lifecycle rows without message bodies", () => {
  setQuietMode(true);
  const cases = [
    ["teammate-started", "@parent spawned @child", "success"],
    ["teammate-send", "@child · follow_up", "running"],
    ["teammate-wait", "completed", "success"],
    ["teammate-watch", "inspected", "success"],
    ["teammate-monitor", "status @child", "success"],
    ["observe", "all · 2/2 settled", "success"],
  ] as const;

  for (const [name, rest, status] of cases) {
    const rendered = renderQuietTeammateAux(name, rest, status, theme as never)?.render(100);
    assert.equal(rendered?.length, 1);
    assert.match(rendered?.[0] ?? "", new RegExp(name));
    assert.ok((rendered?.[0] ?? "").includes(rest));
  }

  setQuietMode(false);
  assert.equal(renderQuietTeammateAux("teammate-send", "SECRET_MESSAGE", "running", theme as never), undefined);
});

test("auxiliary tool fallbacks are total Components mirroring host default rendering", () => {
  const call = auxToolCallFallback("teammate-send", theme as never);
  assert.equal(typeof call.render, "function");
  assert.deepEqual(call.render(80).map((line) => line.trimEnd()), ["teammate-send"]);

  const result = auxToolResultFallback({
    content: [{ type: "text", text: "Message delivered." }, { type: "text", text: "Second line." }],
  } as never, theme as never);
  assert.deepEqual(result.render(80).map((line) => line.trimEnd()), ["Message delivered.", "Second line."]);

  const empty = auxToolResultFallback({ content: [] } as never, theme as never);
  assert.equal(typeof empty.render, "function");
  assert.deepEqual(empty.render(80), []);
});

test("completion and stalled custom messages render bounded full-width cards", () => {
  const details: Details = { mode: "single", results: [okResult()] };
  const completionComponent = renderTeammateCompletionMessage(
    "raw completion body",
    details,
    false,
    theme as never,
  );
  const collapsed = completionComponent.render(80);
  assert.match(collapsed[0], /^╭ ✓ teammate-complete · 1 result · completed.*╮$/);
  assert.match(collapsed.join("\n"), /@inspection.*done/);
  assert.doesNotMatch(collapsed.join("\n"), /complete output/, "collapsed completion hides message bodies");
  assert.ok(collapsed.every((line) => visibleWidth(line) === 79));
  assert.deepEqual(completionComponent.render(1), [], "width one must not occupy the autowrap column");

  const expanded = renderTeammateCompletionMessage(
    "raw completion body",
    details,
    true,
    theme as never,
  ).render(80);
  assert.match(expanded.join("\n"), /complete output/);

  const failedComponent = renderTeammateCompletionMessage(
    "failure body",
    { mode: "single", results: [failedResult()] },
    false,
    theme as never,
  );
  const failed = failedComponent.render(80);
  assert.match(failed[0], /^╭ ✕ teammate-complete · 1 result · 1 failed.*╮$/);
  const failedNarrow = failedComponent.render(24);
  assert.match(failedNarrow[0], /^╭ ✕ teammate-complet/);
  assert.ok(failedNarrow.every((line) => visibleWidth(line) === 23));

  const replayed = renderCompletionOutboxMessage(
    `restored\tresult\u001b[31m ${"detail".repeat(700)}\nFull result: agent://publication`,
    { replayed: true, resources: ["agent://publication"] },
    false,
    theme as never,
  ).render(80);
  assert.match(replayed[0], /^╭ ✓ teammate-complete · replayed · 1 publication.*╮$/);
  assert.doesNotMatch(replayed.join(""), /\x1b\[31m/);
  assert.ok(replayed.length <= 10, "collapsed outbox completion is capped at 8 body rows plus borders");
  assert.ok(replayed.every((line) => visibleWidth(line) === 79));

  const fallbackComponent = renderTeammateCompletionFallbackMessage(
    `Agent failed\t\u001b[31m ${"failure".repeat(700)}`,
    false,
    theme as never,
  );
  const fallback = fallbackComponent.render(24);
  assert.match(fallback[0], /^╭ ✕ teammate-complet/);
  assert.doesNotMatch(fallback.join(""), /\x1b\[31m/);
  assert.ok(fallback.length <= 10);
  assert.ok(fallback.every((line) => visibleWidth(line) === 23));
  assert.deepEqual(fallbackComponent.render(1), []);

  const stalled = renderTeammateStalledMessage(
    "agent\tstalled\u001b[31m",
    { name: "worker", agent: "general", mode: "single", diagnosis: { status: "stalled" } },
    true,
    theme as never,
  ).render(80);
  assert.match(stalled[0], /^╭ ✕ teammate-stalled · @worker · general · single.*╮$/);
  assert.match(stalled.join("\n"), /status stalled/);
  assert.doesNotMatch(stalled.join(""), /[\r\n\t\x00-\x1f\x7f]/);
  assert.ok(stalled.every((line) => visibleWidth(line) === 79));
});

test("quiet single-task call leaves all rendering to the result component", () => {
  setQuietMode(true);
  const rendered = renderTeammateCall({ agent: "general", name: "ping", prompt: "reply pong" }, theme as never, { expanded: true }).render(80);
  assert.deepEqual(rendered, []);
});

test("quiet multi-task call leaves all rendering to the result component", () => {
  setQuietMode(true);
  const rendered = renderTeammateCall({
    tasks: [
      { agent: "explorer", name: "pkgs", prompt: "inspect packages" },
      { agent: "general", name: "summary", prompt: "summarize {pkgs}" },
    ],
    background: false,
  }, theme as never, { expanded: true }).render(80);
  assert.deepEqual(rendered, []);
});

test("quiet streaming progress keeps agent and child trees but hides stream content", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "general",
        name: "focus",
        correlationId: "focus-agent",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        lastMessage: "SECRET_TAIL_TEXT that must not leak in quiet mode",
        recentTools: [{ name: "read", status: "running" }],
      }],
      childCalls: [{
        agent: "reviewer",
        name: "review",
        correlationId: "review-child",
        parentCorrelationId: "focus-agent",
        parentName: "focus",
        status: "running",
        lastMessage: "CHILD_SECRET_TAIL",
        recentTools: [{ name: "bash", status: "running" }],
      }],
    },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 3);
  assert.match(rendered[0], /running/);
  assert.match(rendered[1], /@focus/);
  assert.match(rendered[2], /└─.*@review.*child agent/);
  assert.doesNotMatch(rendered.join("\n"), /using|streaming|SECRET_TAIL_TEXT|CHILD_SECRET_TAIL/);
  assert.doesNotMatch(rendered.join("\n"), new RegExp(`${altRe("R")}`));
});

test("quiet in-flight rows stay stable while live telemetry changes", () => {
  setQuietMode(true);
  const render = (toolCount: number, inputTokens: number, outputTokens: number, durationMs: number) => renderTeammateResult({
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "reviewer",
        name: "review",
        correlationId: "review-agent",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        toolCount,
        inputTokens,
        outputTokens,
        durationMs,
      }],
      childCalls: [{
        agent: "explorer",
        name: "nested",
        correlationId: "nested-agent",
        parentCorrelationId: "review-agent",
        status: "running",
        inputTokens,
        outputTokens,
        durationMs,
      }],
    },
  }, { expanded: false }, theme as never).render(160);

  const first = render(3, 12_500, 315, 13_000);
  const second = render(15, 51_900, 1_100, 77_000);

  assert.deepEqual(second, first);
  assert.doesNotMatch(first.join("\n"), /3 tools|12\.5k|315|13s/);
});

test("quiet streaming progress leaves the final terminal column empty", () => {
  setQuietMode(true, "dot");
  const now = Date.now();
  const width = 80;
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{
        agent: "scholar-ralph-executor",
        name: "scholar-ralph-executor",
        correlationId: "125d198c-live",
        taskIndex: 0,
        dependencies: [],
        status: "running",
        startedAt: new Date(now - 65_000).toISOString(),
        toolCount: 15,
        inputTokens: 377_100,
        outputTokens: 8_000,
        cacheReadTokens: 128,
        cacheWriteTokens: 0,
        lastActivityAt: now,
      }],
    },
  }, { expanded: false }, theme as never).render(width);

  assert.equal(rendered.length, 2);
  assert.ok(Math.max(...rendered.map(visibleWidth)) <= width - 1);
  for (const line of rendered) assert.ok(visibleWidth(line) < width);
});

test("quiet streaming progress retains a structural row on a narrow viewport", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      results: [],
      progress: [{ agent: "general", name: "focus", correlationId: "focus-agent", taskIndex: 0, dependencies: [], status: "running" }],
    },
  }, { expanded: false }, theme as never).render(15);
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /^\s*…\s+teammate/);
  assert.match(rendered[1], /^•\s+1/);
});

test("teammate-list call and result own mutually exclusive unbacked phases", () => {
  setQuietMode(true);
  const call = renderTeammateListCall({ view: "active" }, theme as never, { isPartial: true }).render(80);
  const settledCall = renderTeammateListCall({ view: "active" }, theme as never, { isPartial: false }).render(80);
  const partialResult = renderTeammateListResult({
    content: [{ type: "text", text: "@worker running" }],
    details: { agents: [] },
  }, { isPartial: true }, theme as never).render(80);
  const result = renderTeammateListResult({
    content: [{ type: "text", text: "@worker running" }],
    details: { agents: [{
      agent: "general",
      name: "worker",
      correlationId: "worker-correlation",
      status: "running",
      durationMs: 5_000,
      idleMs: 1_000,
      inboxSize: 0,
      phase: "prompting",
      resolvedModel: "test-model",
    }] },
  }, { isPartial: false }, theme as never, { view: "active" }).render(80);

  assert.match(call[0], /teammate-list active/);
  assert.deepEqual(settledCall, []);
  assert.deepEqual(partialResult, []);
  assert.match(result[0], /^╭ ✓ teammate-list · active · 1 item.*─╮$/);
  assert.match(result[1], /^│ ● @worker · running\s+│$/);
  assert.match(result[2], /^│ role general · id worker-c\s+│$/);
  assert.match(result[3], /^│ active 5s · phase prompting\s+│$/);
  assert.match(result[4], /^│ model test-model\s+│$/);
  assert.match(result.at(-1) ?? "", /^╰─+╯$/);
  assert.ok(result.every((line) => visibleWidth(line) === 79), "card must leave the terminal's final column empty");

  const narrow = renderTeammateListResult({
    content: [{ type: "text", text: "@worker running" }],
    details: { agents: [{ agent: "general", name: "worker", correlationId: "worker-correlation", status: "running" }] },
  }, { isPartial: false }, theme as never, { view: "active" }).render(24);
  assert.ok(narrow.every((line) => visibleWidth(line) === 23), "narrow cards must not trigger terminal autowrap");
  assert.match(narrow[0], /^╭.*╮$/);
  assert.match(narrow.at(-1) ?? "", /^╰─+╯$/);

  setQuietMode(false);
  const fallback = renderTeammateListResult({
    content: [{ type: "text", text: "@worker running" }],
    details: { agents: [{ name: "worker" }] },
  }, { isPartial: false }, theme as never, { view: "active" }).render(80);
  assert.deepEqual(fallback, ["@worker running"]);
});

test("communication and Monitor results use bounded structured cards", () => {
  setQuietMode(true);
  const sent = renderTeammateSendResult({
    content: [{ type: "text", text: "Message queued for worker." }],
    details: { delivered: true },
  }, { isPartial: false, expanded: false }, theme as never, { to: "worker", mode: "follow_up" }).render(80);
  assert.match(sent[0], /^╭ ✓ teammate-send · @worker · follow_up · delivered.*╮$/);
  assert.match(sent[1], /^│ Message queued for worker\.\s+│$/);
  assert.ok(sent.every((line) => visibleWidth(line) === 79));

  const failedSent = renderTeammateSendResult({
    content: [{ type: "text", text: "Delivery rejected." }],
    details: { delivered: true },
  }, { isPartial: false, expanded: false }, theme as never, { to: "worker", mode: "steer" }, true).render(80);
  assert.match(failedSent[0], /^╭ ✕ teammate-send · @worker · steer · delivery failed.*╮$/);

  const observed = renderObserveResult({
    content: [{ type: "text", text: "2 targets: snapshot" }],
    details: {
      output: ["2 targets: snapshot", "teammate:a\trunning\tworking", "bash_bg:b\tcompleted\tdone"],
      result: {
        action: "status",
        reason: "snapshot",
        observations: [
          { target: { kind: "teammate", id: "a" }, nativeStatus: "running", summary: "working", phase: "prompting" },
          { target: { kind: "bash_bg", id: "b" }, nativeStatus: "completed", summary: "done" },
        ],
      },
    },
  }, { isPartial: false, expanded: false }, theme as never).render(80);
  assert.match(observed[0], /^╭ ✓ observe · status · 2 targets · snapshot.*╮$/);
  assert.ok(observed.some((line) => /^│ ● teammate:a · running\s+│$/.test(line)));
  assert.ok(observed.some((line) => /^│ ✓ bash_bg:b · completed\s+│$/.test(line)));
  assert.ok(observed.some((line) => /^├─+┤$/.test(line)));
  assert.ok(observed.every((line) => visibleWidth(line) === 79));

  const monitored = renderMonitorResult({
    content: [{ type: "text", text: "MONITOR list ok · 1 window\n· · owner:abc · running" }],
    details: {
      action: "list",
      status: "ok",
      windows: [{
        target: "owner:abc",
        window: {
          window: { name: "worker-a", lifecycle: { status: "running" } },
          work: { status: "active" },
          attention: [],
        },
        timeline: [{
          group: "activity",
          entries: [{ at: 1_000, label: "FULL TIMELINE DETAIL", detail: "expanded" }],
        }],
      }],
    },
  }, { isPartial: false, expanded: true }, theme as never).render(80);
  assert.match(monitored[0], /^╭ ✓ monitor · list · ok · 1 window.*╮$/);
  assert.ok(monitored.some((line) => /^│ ● worker-a · running\s+│$/.test(line)));
  assert.ok(monitored.some((line) => /^│ target owner:abc\s+│$/.test(line)));
  assert.ok(monitored.some((line) => line.includes("FULL TIMELINE DETAIL · expanded")));
  assert.ok(monitored.every((line) => visibleWidth(line) === 79));
  assert.match(monitored.at(-1) ?? "", /^╰─+╯$/);

  const windows = renderTeammateListResult({
    content: [{ type: "text", text: "window" }],
    details: { agents: [{ kind: "window", displayName: "peer", status: "running", target: "owner:peer", agentCount: 1, contextPressure: 42 }] },
  }, { isPartial: false }, theme as never, { view: "windows" }).render(80);
  assert.ok(windows.some((line) => line.includes("1 agent · context 42%")));
  assert.doesNotMatch(windows.join("\n"), /4200%/);
});

test("quiet completed single result is one concise named line without its message body", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "complete output" }],
    details: { mode: "single", results: [okResult()] },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /✓/);
  assert.match(rendered[0], /@inspection/);
  assert.match(rendered[0], /\(scout\)/);
  assert.match(rendered[0], /done/);
  assert.match(rendered[0], /30 tokens/);
  assert.doesNotMatch(rendered[0], /teammate|1\/1/);
  assert.doesNotMatch(rendered.join("\n"), new RegExp(`complete output|${altRe("R")}`));
});

test("quiet completed result keeps named progress rows without completed message bodies", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "complete output" }],
    details: {
      mode: "single",
      results: [okResult()],
      progress: [{
        agent: "scout",
        name: "inspection",
        correlationId: "scout-correlation",
        taskIndex: 0,
        dependencies: [],
        status: "completed",
        durationMs: 1000,
        inputTokens: 10,
        outputTokens: 20,
      }],
    },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /@inspection.*\(scout\)/);
  assert.doesNotMatch(rendered.join("\n"), /complete output/);
});

test("quiet completed graph is an unbacked one-line-per-agent list with dependencies", () => {
  setQuietMode(true);
  const first = okResult();
  const second = { ...okResult(), agent: "reviewer", name: "review", correlationId: "review-correlation" };
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "graph",
      results: [first, second],
      progress: [
        { agent: "scout", name: "inspection", correlationId: first.correlationId, taskIndex: 0, dependencies: [], status: "completed" },
        { agent: "reviewer", name: "review", correlationId: second.correlationId, taskIndex: 1, dependencies: [0], status: "completed" },
      ],
    },
  }, { expanded: true }, theme as never).render(160);
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /@inspection.*\(scout\)/);
  assert.match(rendered[1], /@review.*\(reviewer\).*← result #1/);
  assert.doesNotMatch(rendered.join("\n"), /teammate|2\/2 done/);
});

test("quiet completed graph trusts results over lifecycle-pending progress snapshots", () => {
  setQuietMode(true);
  const first = okResult();
  const second = { ...okResult(), agent: "reviewer", name: "review", correlationId: "review-correlation" };
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "parallel",
      results: [first, second],
      // executeGraph rewrites lifecycle-pending tasks back to "running" for the
      // live admission gate; the terminal quiet row must show the real outcome.
      progress: [
        { agent: "scout", name: "inspection", correlationId: first.correlationId, taskIndex: 0, dependencies: [], status: "running", resultReadyAt: Date.now() },
        { agent: "reviewer", name: "review", correlationId: second.correlationId, taskIndex: 1, dependencies: [], status: "running", resultReadyAt: Date.now() },
      ],
    },
  }, { expanded: false }, theme as never).render(160);
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /◉ sleeping · completed @inspection/);
  assert.match(rendered[1], /◉ sleeping · completed @review/);
  assert.doesNotMatch(rendered.join("\n"), /running|result ready/);
});

test("quiet completed graph marks failed results even when the snapshot is still running", () => {
  setQuietMode(true);
  const failed = failedResult();
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "boom" }],
    details: {
      mode: "parallel",
      results: [failed],
      progress: [
        { agent: "scout", name: "inspection", correlationId: failed.correlationId, taskIndex: 0, dependencies: [], status: "running" },
      ],
    },
  }, { expanded: false }, theme as never).render(160);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /◉ sleeping · failed @inspection/);
  assert.match(rendered[0], /boom error line/);
  assert.doesNotMatch(rendered[0], /running/);
});

test("quiet single background ack keeps a running mark instead of a false completion", () => {
  setQuietMode(true);
  const ack: AgentToolResult<Details> = {
    content: [{ type: "text", text: "■ @ping running in background. Use teammate-wait to settle." }],
    details: { mode: "single", results: [] },
  };
  const rendered = renderTeammateResult(ack, { expanded: false }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /^\s*…\s+teammate @ping running in background/);
  assert.doesNotMatch(rendered[0], /✓|child agents/);
});

test("quiet rejected dispatch shows a failure mark, not a success", () => {
  setQuietMode(true);
  // pi attaches isError to tool results at runtime; the declared type does not
  // carry it, so the cast keeps the literal honest without an excess property.
  const rejection = {
    content: [{ type: "text", text: "Teammate agent budget exhausted: 8 agents are already live" }],
    isError: true,
    details: { mode: "single", results: [] },
  } as AgentToolResult<Details>;
  const rendered = renderTeammateResult(rejection, { expanded: false }, theme as never).render(120);
  assert.match(rendered[0], /✕ teammate Teammate agent budget exhausted/);
  assert.doesNotMatch(rendered[0], /✓|child agents/);
});

test("quiet failed result keeps an agent row and a single error summary", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "boom error line" }],
    details: { mode: "single", results: [failedResult()] },
  }, { expanded: true }, theme as never).render(120);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /✕/);
  assert.match(rendered[0], /@inspection/);
  assert.match(rendered[0], /failed/);
  assert.match(rendered[0], /boom error line/);
  assert.doesNotMatch(rendered.join("\n"), /stack trace noise/);
});

test("dot symbol mode applies to teammate running, success, and failure rows", () => {
  setQuietMode(true, "dot");
  const call = renderTeammateCall({ agent: "general", prompt: "inspect" }, theme as never).render(80);
  assert.deepEqual(call, []);

  const success = renderTeammateResult({
    content: [{ type: "text", text: "complete output" }],
    details: { mode: "single", results: [okResult()] },
  }, { expanded: false }, theme as never).render(80);
  assert.match(success[0], /^\s*●\s+@inspection/);

  const failure = renderTeammateResult({
    content: [{ type: "text", text: "boom error line" }],
    details: { mode: "single", results: [failedResult()] },
  }, { expanded: false }, theme as never).render(80);
  assert.match(failure[0], /^\s*!\s+@inspection/);
});

test("auxiliary teammate surfaces are wired to quiet rows or shared result cards", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  for (const name of ["teammate-started", "teammate-wait", "teammate-watch", "teammate-monitor"]) {
    assert.match(source, new RegExp(`renderQuietTeammateAux\\(\\"${name}\\"`));
  }
  assert.equal((source.match(/return renderTeammateSendCall\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderTeammateSendResult\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderObserveCall\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderObserveResult\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderMonitorResult\(/g) ?? []).length, 1);
  assert.equal((source.match(/renderTeammateSendResult\(result, options, theme, context\.args, context\.isError\)/g) ?? []).length, 2);
  assert.equal((source.match(/renderTeammateListResult\(result, options, theme, context\.args, context\.isError\)/g) ?? []).length, 3);
  assert.equal((source.match(/renderObserveResult\(result, options, theme, context\.isError\)/g) ?? []).length, 2);
  assert.equal((source.match(/renderMonitorResult\(result, options, theme, context\.isError\)/g) ?? []).length, 1);
  assert.equal((source.match(/return renderTeammateCompletionFallbackMessage\(/g) ?? []).length, 1);
  assert.equal((source.match(/return renderTeammateCompletionMessage\(/g) ?? []).length, 1);
  assert.equal((source.match(/return renderTeammateStalledMessage\(/g) ?? []).length, 1);
  assert.match(source, /registerMessageRenderer\([\s\S]*?"teammate-stalled"/);
});

test("remaining inline auxiliary renderers make call and result phases mutually exclusive", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.equal((source.match(/if \(context\.isPartial === false\) return new Text\("", 0, 0\);/g) ?? []).length, 6);
  assert.equal((source.match(/if \(options\.isPartial\) return new Text\("", 0, 0\);/g) ?? []).length, 5);
});

test("auxiliary teammate tools use a self render shell in root and nested registrations", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  for (const name of ["teammate-send", "teammate-watch", "teammate-wait", "observe", "teammate-monitor"]) {
    assert.equal(
      (source.match(new RegExp(`name: \"${name}\",\\r?\\n\\s+label: \"[^\"]*\",\\r?\\n\\s+renderShell: \"self\",`, "g")) ?? []).length,
      2,
      `${name} should declare renderShell: "self" in both root and nested registrations`,
    );
  }
});

test("root and nested self-rendered teammate tools share renderers", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.equal((source.match(/return renderTeammateCall\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderTeammateResult\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderTeammateListCall\(/g) ?? []).length, 3);
  assert.equal((source.match(/return renderTeammateListResult\(/g) ?? []).length, 3);
  assert.equal((source.match(/return renderTeammateSendCall\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderTeammateSendResult\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderObserveCall\(/g) ?? []).length, 2);
  assert.equal((source.match(/return renderObserveResult\(/g) ?? []).length, 2);
});

// Uniqueness guard (not a behaviour test): the ownership event is the single
// wire that drives the teammate quiet mirror. This regex breaks if the
// setQuietMode(...) call is removed from the COCKPIT_UI_OWNERSHIP_EVENT handler
// or stops reading payload.quiet, so the mirror cannot silently drift off the
// shared cockpit event. Behaviour (flag -> rendering) is covered above.
test("ownership handler is the unique wire for the teammate quiet mirror", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.events\.on\(COCKPIT_UI_OWNERSHIP_EVENT[\s\S]*?setQuietMode\([\s\S]*?quiet[\s\S]*?===\s*true/);
});
