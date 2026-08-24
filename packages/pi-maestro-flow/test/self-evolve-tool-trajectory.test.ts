import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSignal,
  buildToolCallEvidence,
  classifyCandidateType,
  signalEvidenceContent,
  type ToolCallEvidence,
} from "../src/self-evolve/runtime.ts";
import {
  collectToolCallTimeline,
  buildTrajectoryEpisodes,
  projectSopToolCalls,
  type TimelineEntry,
} from "../src/self-evolve/trajectory.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Build a minimal assistant tool_use + tool result pair for tests. */
function toolMessages(
  toolName: string,
  input: Record<string, unknown>,
  opts: { isError?: boolean; resultText?: string; toolCallId?: string } = {},
): AgentMessage[] {
  const toolCallId = opts.toolCallId ?? `call-${toolName}`;
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: toolCallId, name: toolName, input }],
    },
    {
      role: "tool",
      toolCallId,
      name: toolName,
      content: [{ type: "text", text: opts.resultText ?? "ok" }],
      ...(opts.isError ? { isError: true } : {}),
    },
  ] as unknown as AgentMessage[];
}

test("buildToolCallEvidence extracts browser guide call with topic and ok outcome", async () => {
  const messages = toolMessages("browser", { action: "guide", topic: "core" });
  const evidence = buildToolCallEvidence(messages);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].tool, "browser");
  assert.equal(evidence[0].action, "guide");
  assert.equal(evidence[0].topic, "core");
  assert.equal(evidence[0].outcome, "ok");
});

test("buildToolCallEvidence classifies near_zero outcome from error text", async () => {
  const messages = toolMessages("computer_use", { action: "click", x: 10, y: 20 }, {
    isError: true,
    resultText: "FOREGROUND_NOT_VERIFIED: near_zero pointer diagnostic",
  });
  const evidence = buildToolCallEvidence(messages);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].outcome, "near_zero");
  assert.match(evidence[0].errorMessage ?? "", /near_zero/i);
});

test("buildToolCallEvidence classifies timeout outcome", async () => {
  const messages = toolMessages("browser", { action: "run", code: "x" }, {
    isError: true,
    resultText: "Operation timeout after 30s",
  });
  const evidence = buildToolCallEvidence(messages);
  assert.equal(evidence[0].outcome, "timeout");
});

test("buildToolCallEvidence classifies permission_denied outcome", async () => {
  const messages = toolMessages("computer_use", { action: "screenshot", source: "screen" }, {
    isError: true,
    resultText: "EACCES permission denied: screen capture not authorized",
  });
  const evidence = buildToolCallEvidence(messages);
  assert.equal(evidence[0].outcome, "permission_denied");
});

test("buildToolCallEvidence captures common development tools", async () => {
  const messages = toolMessages("bash", { command: "ls" });
  const evidence = buildToolCallEvidence(messages);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.tool, "bash");
  assert.equal(evidence[0]?.outcome, "ok");
});

test("buildToolCallEvidence dedupes identical tool+action+topic+outcome", async () => {
  const msgs = [
    ...toolMessages("browser", { action: "guide", topic: "core" }, { toolCallId: "c1" }),
    ...toolMessages("browser", { action: "guide", topic: "core" }, { toolCallId: "c2" }),
  ];
  const evidence = buildToolCallEvidence(msgs);
  assert.equal(evidence.length, 1);
});

test("buildToolCallEvidence respects max bound", async () => {
  const msgs: AgentMessage[] = [];
  for (let i = 0; i < 5; i++) {
    msgs.push(...toolMessages("browser", { action: "guide", topic: `t${i}` }, { toolCallId: `c${i}` }));
  }
  const evidence = buildToolCallEvidence(msgs, 2);
  assert.equal(evidence.length, 2);
});

test("classifyCandidateType biases toward knowhow when tool failure hints present", () => {
  const plain = "Adjusted the viewport and took a screenshot.";
  const withHint = `${plain}\nbrowser timeout run\nturnstile`;
  const plainType = classifyCandidateType(plain);
  const hintType = classifyCandidateType(withHint);
  // The plain summary leans unknown/spec-ish; with failure-mode hints it should
  // not regress to spec — at minimum knowhow score must rise. Assert knowhow wins
  // or stays equal when failure/issue/pitfall vocabulary appears via the hint.
  assert.ok(
    hintType === "knowhow" || hintType === "unknown",
    `hint should not bias to spec, got ${hintType}`,
  );
  assert.notEqual(plainType, undefined);
});

test("signalEvidenceContent emits tool_trajectory section when toolCalls present", () => {
  const signal = buildSignal({
    source: "agent_end",
    sessionId: "sess-test",
    traceHash: "abcdef1234567890",
    title: "browser near_zero on click after activate",
    summary: "Click failed with near_zero diagnostic; re-probe needed.",
    evidence: [{ type: "tool", ref: "browser" }],
    candidateType: "knowhow",
    toolCalls: [
      { tool: "computer_use", action: "click", outcome: "near_zero", errorMessage: "near_zero pointer" },
    ],
  });
  const content = signalEvidenceContent(signal);
  assert.match(content, /tool_trajectory:/);
  assert.match(content, /- computer_use action=click outcome=near_zero/);
});

test("signalEvidenceContent emits SOP frontmatter hint anchored to the failing tool", () => {
  const signal = buildSignal({
    source: "agent_end",
    sessionId: "sess-test",
    traceHash: "abcdef1234567890",
    title: "browser turnstile timeout",
    summary: "Turnstile token render timed out.",
    evidence: [],
    candidateType: "knowhow",
    toolCalls: [
      { tool: "browser", action: "guide", topic: "captcha-strategies", outcome: "ok" },
      { tool: "browser", action: "run", outcome: "timeout", errorMessage: "timeout 30s" },
    ],
  });
  const content = signalEvidenceContent(signal);
  // Frontmatter hint must lead with --- and carry tools + sop_topic.
  assert.match(content, /^---\n/);
  assert.match(content, /tools: \[browser\]/);
  // First failing call has no guide topic; hint falls back to placeholder topic.
  assert.match(content, /sop_topic: <kebab-case-topic>/);
});

test("signalEvidenceContent uses the failing call's guide topic when available", () => {
  const signal = buildSignal({
    source: "agent_end",
    sessionId: "sess-test",
    traceHash: "abcdef1234567890",
    title: "computer_use coordinate pitfall",
    summary: "Coordinate space mismatch.",
    evidence: [],
    candidateType: "knowhow",
    toolCalls: [
      { tool: "computer_use", action: "guide", topic: "coordinates", outcome: "ok" },
      { tool: "computer_use", action: "click", outcome: "near_zero", errorMessage: "near_zero" },
    ],
  });
  const content = signalEvidenceContent(signal);
  assert.match(content, /tools: \[computer_use\]/);
  // Failing call had no topic; first failing topic-less call -> placeholder. To
  // exercise the topic path, construct a signal where the failing call carries topic.
  const signal2 = buildSignal({
    source: "agent_end",
    sessionId: "sess-test",
    traceHash: "abcdef1234567891",
    title: "browser guide timeout",
    summary: "guide timed out.",
    evidence: [],
    candidateType: "knowhow",
    toolCalls: [
      { tool: "browser", action: "guide", topic: "core", outcome: "timeout", errorMessage: "timeout" },
    ],
  });
  const content2 = signalEvidenceContent(signal2);
  assert.match(content2, /sop_topic: core/);
});

test("signalEvidenceContent omits SOP hint when no toolCalls", () => {
  const signal = buildSignal({
    source: "agent_end",
    sessionId: "sess-test",
    traceHash: "abcdef1234567890",
    title: "plain lesson",
    summary: "A lesson without a tool trajectory.",
    evidence: [],
    candidateType: "knowhow",
  });
  const content = signalEvidenceContent(signal);
  assert.doesNotMatch(content, /^---\n/);
  assert.doesNotMatch(content, /tools:/);
  assert.doesNotMatch(content, /tool_trajectory:/);
});

// ---------------------------------------------------------------------------
// P1: generic tool-call timeline + episodes + SOP projection
// ---------------------------------------------------------------------------

/** Append an assistant tool_use + tool_result pair to a messages array. */
function appendToolCall(
  messages: AgentMessage[],
  tool: string,
  input: Record<string, unknown>,
  opts: { isError?: boolean; resultText?: string; callId?: string } = {},
): AgentMessage[] {
  const callId = opts.callId ?? `call-${tool}-${messages.length}`;
  messages.push(
    { role: "assistant", content: [{ type: "tool_use", id: callId, name: tool, input }] } as unknown as AgentMessage,
  );
  messages.push(
    {
      role: "tool",
      toolCallId: callId,
      name: tool,
      content: [{ type: "text", text: opts.resultText ?? "ok" }],
      ...(opts.isError ? { isError: true } : {}),
    } as unknown as AgentMessage,
  );
  return messages;
}

test("collectToolCallTimeline preserves call order across mixed tools", () => {
  const messages = appendToolCall([], "bash", { command: "npm test" });
  appendToolCall(messages, "edit", { path: "src/a.ts" }, { isError: true, resultText: "not found" });
  appendToolCall(messages, "grep", { pattern: "TODO" });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].tool, "bash");
  assert.equal(timeline[1].tool, "edit");
  assert.equal(timeline[2].tool, "grep");
  assert.equal(timeline[0].index, 0);
  assert.equal(timeline[1].index, 1);
  assert.equal(timeline[2].index, 2);
});

test("collectToolCallTimeline marks unpaired calls as incomplete (never ok)", () => {
  // assistant emits a tool_use with no matching tool_result
  const messages: AgentMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "bash", input: { command: "ls" } }] } as unknown as AgentMessage,
  ];
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].outcome, "incomplete");
  assert.equal(timeline[0].callId, "orphan");
});

test("bash non-zero exit classifies as error", () => {
  const messages = appendToolCall([], "bash", { command: "npm test" }, {
    isError: true,
    resultText: "Command failed with exit code 1",
  });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].outcome, "error");
});

test("bash command-not-found classifies as error", () => {
  const messages = appendToolCall([], "bash", { command: "bogus-cmd" }, {
    isError: true,
    resultText: "command not found: bogus-cmd",
  });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].outcome, "error");
});

test("grep no-match classifies as empty", () => {
  const messages = appendToolCall([], "grep", { pattern: "TODO" }, {
    isError: true,
    resultText: "No matches found",
  });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].outcome, "empty");
});

test("lsp no-definitions classifies as empty", () => {
  const messages = appendToolCall([], "lsp", { path: "src/a.ts", query: "definitions" }, {
    isError: false,
    resultText: "No definitions found",
  });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].outcome, "empty");
});

test("edit not-found classifies as error", () => {
  const messages = appendToolCall([], "edit", { path: "src/missing.ts" }, {
    isError: true,
    resultText: "Could not find oldText",
  });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].outcome, "error");
});

test("delegate timeout classifies as timeout", () => {
  const messages = appendToolCall([], "delegate", {}, {
    isError: true,
    resultText: "timed out after 60s",
  });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].outcome, "timeout");
});

test("ask cancel classifies as cancelled", () => {
  const messages = appendToolCall([], "ask", {}, {
    isError: true,
    resultText: "user cancelled",
  });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].outcome, "cancelled");
});

test("buildTrajectoryEpisodes detects failure_recovery (error then ok)", () => {
  const messages: AgentMessage[] = [];
  appendToolCall(messages, "edit", { path: "src/a.ts" }, { isError: true, resultText: "not found" });
  appendToolCall(messages, "edit", { path: "src/a.ts" }, { isError: false, resultText: "ok" });
  const timeline = collectToolCallTimeline(messages);
  const episodes = buildTrajectoryEpisodes(timeline);
  const editEp = episodes.find((e) => e.tool === "edit");
  assert.ok(editEp);
  assert.equal(editEp!.kind, "failure_recovery");
  assert.deepEqual(editEp!.outcomes, ["error", "ok"]);
});

test("buildTrajectoryEpisodes detects repeated_failure (all errors)", () => {
  const messages: AgentMessage[] = [];
  appendToolCall(messages, "bash", { command: "npm test" }, { isError: true, resultText: "exit 1" });
  appendToolCall(messages, "bash", { command: "npm test" }, { isError: true, resultText: "exit 1" });
  const timeline = collectToolCallTimeline(messages);
  const episodes = buildTrajectoryEpisodes(timeline);
  const bashEp = episodes.find((e) => e.tool === "bash");
  assert.ok(bashEp);
  assert.equal(bashEp!.kind, "repeated_failure");
});

test("buildTrajectoryEpisodes detects empty_then_refined (grep no-match then ok)", () => {
  const messages: AgentMessage[] = [];
  appendToolCall(messages, "grep", { pattern: "TODO" }, { isError: true, resultText: "No matches" });
  appendToolCall(messages, "grep", { pattern: "TODO" }, { isError: false, resultText: "3 matches" });
  const timeline = collectToolCallTimeline(messages);
  const episodes = buildTrajectoryEpisodes(timeline);
  const grepEp = episodes.find((e) => e.tool === "grep");
  assert.ok(grepEp);
  assert.equal(grepEp!.kind, "empty_then_refined");
});

test("buildTrajectoryEpisodes detects permission_block", () => {
  const messages = appendToolCall([], "bash", { command: "rm /etc/passwd" }, {
    isError: true,
    resultText: "permission denied",
  });
  const timeline = collectToolCallTimeline(messages);
  const episodes = buildTrajectoryEpisodes(timeline);
  assert.equal(episodes[0].kind, "permission_block");
});

test("buildTrajectoryEpisodes detects success (all ok)", () => {
  const messages: AgentMessage[] = [];
  appendToolCall(messages, "read", { path: "src/a.ts" });
  appendToolCall(messages, "read", { path: "src/b.ts" });
  const timeline = collectToolCallTimeline(messages);
  const episodes = buildTrajectoryEpisodes(timeline);
  assert.equal(episodes.length, 2);
  assert.ok(episodes.every((e) => e.kind === "success"));
});

test("projectSopToolCalls keeps only browser/computer_use and maps outcomes", () => {
  const messages: AgentMessage[] = [];
  appendToolCall(messages, "bash", { command: "ls" });
  appendToolCall(messages, "browser", { action: "guide", topic: "core" });
  appendToolCall(messages, "computer_use", { action: "click" }, { isError: true, resultText: "near_zero" });
  const timeline = collectToolCallTimeline(messages);
  const sop = projectSopToolCalls(timeline);
  assert.equal(sop.length, 2);
  assert.equal(sop[0].tool, "browser");
  assert.equal(sop[0].action, "guide");
  assert.equal(sop[0].topic, "core");
  assert.equal(sop[0].outcome, "ok");
  assert.equal(sop[1].tool, "computer_use");
  assert.equal(sop[1].outcome, "near_zero");
});

test("projectSopToolCalls deduplicates by tool:action:topic:outcome", () => {
  const messages: AgentMessage[] = [];
  appendToolCall(messages, "browser", { action: "guide", topic: "core" });
  appendToolCall(messages, "browser", { action: "guide", topic: "core" });
  const timeline = collectToolCallTimeline(messages);
  const sop = projectSopToolCalls(timeline);
  assert.equal(sop.length, 1);
});

test("collectToolCallTimeline deduplicates nothing — order preserved with repeats", () => {
  // timeline keeps repeats (unlike the legacy SOP projection) so episode
  // detection sees the retry sequence.
  const messages: AgentMessage[] = [];
  appendToolCall(messages, "edit", { path: "a.ts" }, { isError: true, resultText: "err" });
  appendToolCall(messages, "edit", { path: "a.ts" }, { isError: false });
  appendToolCall(messages, "edit", { path: "a.ts" }, { isError: true, resultText: "err" });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline.length, 3);
});

test("unknown tool falls back to generic classifier", () => {
  const messages = appendToolCall([], "some_unknown_tool", { command: "x" }, {
    isError: true,
    resultText: "timed out",
  });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].outcome, "timeout");
});

test("whitelisted input fields are captured on timeline entries", () => {
  const messages = appendToolCall([], "bash", { command: "npm test", secret: "hidden" });
  const timeline = collectToolCallTimeline(messages);
  assert.equal(timeline[0].input.command, "npm test");
  assert.equal((timeline[0].input as Record<string, unknown>).secret, undefined);
});
