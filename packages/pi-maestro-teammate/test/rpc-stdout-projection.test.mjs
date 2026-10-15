import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { projectRpcEvent, projectRpcWrite, installRpcStdoutProjection } from "../src/runs/rpc-stdout-projection.mjs";
import { createUtf8LineDecoder, EXECUTION_BUFFER_LIMITS } from "../src/runs/execution-infra.ts";
import { runSingleAttempt, attemptRecoveryFacts } from "../src/runs/pi-subprocess-attempt.ts";

const image = () => ({ type: "image", mimeType: "image/png", data: "A".repeat(2_200_000) });
const line = (event) => `${JSON.stringify(event)}\n`;
const assistant = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
const tool = () => ({ role: "toolResult", toolName: "read", isError: false, content: [image()] });

function decode(text) {
  const decoder = createUtf8LineDecoder(EXECUTION_BUFFER_LIMITS.transcriptBytes * 4);
  const bytes = Buffer.from(text);
  const lines = [];
  for (let start = 0; start < bytes.length; start += 65536) lines.push(...decoder.write(bytes.subarray(start, start + 65536)));
  lines.push(...decoder.end());
  return lines.map((value) => JSON.parse(value));
}

test("multi-image turn_end and agent_end survive the unchanged 4 MiB wire limit", () => {
  const tools = Array.from({ length: 4 }, tool);
  for (const event of [
    { type: "turn_end", message: assistant, toolResults: tools },
    { type: "agent_end", willRetry: false, messages: [...tools, assistant] },
  ]) {
    const original = line(event);
    assert.ok(Buffer.byteLength(original) > 8_000_000);
    const projected = projectRpcWrite(original);
    assert.ok(Buffer.byteLength(projected) < 2000);
    const [parsed] = decode(projected);
    assert.equal(parsed.type, event.type);
    assert.deepEqual(parsed.message ?? parsed.messages.at(-1), assistant);
    assert.equal((parsed.toolResults ?? parsed.messages.slice(0, -1)).length, 4);
    assert.ok(tools.every((result) => result.content[0].data.length === 2_200_000));
  }
});

test("individual image telemetry is projected without changing errors, text or structured data", () => {
  const structured = { type: "image", data: "schema-owned payload" };
  const event = {
    type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: true,
    args: structured,
    result: { content: [{ type: "text", text: "warning" }, image()], details: structured },
  };
  const parsed = projectRpcEvent(event);
  assert.equal(parsed.isError, true);
  assert.equal(parsed.toolCallId, "read-1");
  assert.equal(parsed.args, structured);
  assert.equal(parsed.result.details, structured);
  assert.equal(parsed.result.content[0], event.result.content[0]);
  assert.match(parsed.result.content[1].text, /2200000 encoded bytes/);
  assert.equal(event.result.content[1].type, "image");
  assert.equal(projectRpcEvent({ type: "tool_execution_update", partialResult: tool() }).partialResult.content[0].type, "text");
  assert.equal(projectRpcEvent({ type: "message_end", message: tool() }).message.content[0].type, "text");
});

test("structured output payloads and malformed writes are never sanitized away", () => {
  const payload = { value: "x".repeat(300_000), type: "image", data: "arbitrary schema value" };
  const event = { type: "tool_execution_end", toolName: "structured_output", result: { details: payload } };
  assert.deepEqual(JSON.parse(projectRpcWrite(line(event))), event);
  for (const value of ['broken "image"\n', '{"type":"image"', '{"x":"image"}\n']) {
    assert.equal(projectRpcWrite(value), value);
  }
  const buffer = Buffer.from('broken "image"\n');
  assert.equal(projectRpcWrite(buffer), buffer);
});

test("text-only, details and argument telemetry is bounded before framing", () => {
  const large = "界😀\n\u0000".repeat(500_000);
  const events = [
    { type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { replacement: large } },
    { type: "tool_execution_update", toolCallId: "read-1", parentToolCallId: "outer-1", complete: false, partialResult: { content: [{ type: "text", text: large }], details: { raw: large } } },
    { type: "tool_execution_end", toolCallId: "search-1", toolName: "search", isError: true, result: { content: [{ type: "text", text: large }], details: { raw: large } } },
    ...["message_start", "message_end"].map((type) => ({ type, message: { role: "toolResult", toolCallId: "search-1", content: [{ type: "text", text: large }], details: { raw: large } } })),
    ...["text_delta", "thinking_delta", "toolcall_delta"].map((type) => ({ type: "message_update", assistantMessageEvent: { type, delta: large, partial: { role: "assistant", content: [{ type: "text", text: large }] } } })),
    { type: "message_update", assistantMessageEvent: { type: "text_end", content: large } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: large, thinkingSignature: large }, { type: "text", text: large }] } },
    { type: "tool_result", toolCallId: "legacy-1", content: large },
    { type: "error", error: `provider error: ${large}`, errorMessage: large },
    { type: "message_update", assistantMessageEvent: { type: "error", error: { role: "assistant", errorMessage: large, content: [{ type: "text", text: large }] } } },
  ];
  for (const event of events) {
    const original = line(event);
    const projected = projectRpcWrite(original);
    assert.ok(Buffer.byteLength(projected) < 1_048_576, event.type);
    const [parsed] = decode(projected);
    assert.equal(parsed.type, event.type);
    assert.equal(parsed.toolCallId, event.toolCallId);
    assert.equal(parsed.parentToolCallId, event.parentToolCallId);
    assert.equal(parsed.complete, event.complete);
    assert.equal(parsed.isError, event.isError);
    assert.equal(projected.includes("�"), false, "Unicode must not be split");
    assert.match(projected, /telemetry|Telemetry/);
    assert.equal(line(event), original, "projection must not mutate original model/session payloads");
  }
});

test("aggregate budgets include escaped text and many individually small tool arguments", () => {
  const events = [
    { type: "agent_end", willRetry: false, messages: Array.from({ length: 100 }, () => ({ role: "toolResult", content: [{ type: "text", text: "x".repeat(50_000) }] })).concat(assistant) },
    { type: "turn_end", message: assistant, toolResults: Array.from({ length: 100 }, () => ({ role: "toolResult", content: [{ type: "text", text: "\u0000".repeat(10_000) }] })) },
    { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: Array.from({ length: 400 }, (_, index) => ({ type: "toolCall", id: `call-${index}`, name: "edit", arguments: { text: "x".repeat(16_000) } })) } },
  ];
  for (const event of events) {
    assert.ok(Buffer.byteLength(line(event)) > 4_194_304);
    const projected = projectRpcWrite(line(event));
    assert.ok(Buffer.byteLength(projected) < 1_048_576);
    const [parsed] = decode(projected);
    assert.equal(parsed.willRetry, event.willRetry);
    if (event.messages) assert.deepEqual(parsed.messages.at(-1), assistant);
    if (event.toolResults) assert.ok(parsed.toolResults.length > 0);
    if (event.message?.content[0]?.type === "toolCall") {
      assert.equal(parsed.message.content.length, 400);
      assert.equal(parsed.message.content.at(-1).id, "call-399");
    }
  }
});

test("history and content eviction is explicit and retains lifecycle evidence", () => {
  const event = {
    type: "agent_end", willRetry: false,
    messages: [assistant, ...Array.from({ length: 300 }, (_, index) => ({ role: "toolResult", toolCallId: `tool-${index}`, content: [{ type: "text", text: "ok" }] }))],
  };
  const projected = projectRpcEvent(event);
  assert.equal(projected.messages[0], assistant);
  assert.equal(projected.messages.at(-1).toolCallId, "tool-299");
  assert.ok(projected.teammateTelemetry.omittedMessages > 0);
  assert.equal(projected.messages.length + projected.teammateTelemetry.omittedMessages, event.messages.length);
  const content = projectRpcEvent({ type: "message_end", message: { role: "assistant", content: Array.from({ length: 300 }, () => ({ type: "text", text: "ok" })) } });
  assert.equal(content.message.content.length, 128);
  assert.equal(content.message.teammateTelemetry.omittedContentBlocks, 172);
});

test("user input matching and structured submission values remain exact", () => {
  const value = "😀\n".repeat(100_000);
  const args = { answer: value, data: { type: "image", data: "schema-owned" } };
  for (const event of [
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: value }] } },
    { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "schema-1", name: "structured_output", arguments: args }] } },
    { type: "tool_execution_start", toolCallId: "schema-1", toolName: "structured_output", args },
    { type: "tool_execution_end", toolCallId: "schema-1", toolName: "structured_output", result: { content: [{ type: "text", text: "Structured output saved." }], details: args } },
  ]) {
    assert.deepEqual(JSON.parse(projectRpcWrite(line(event))), event);
  }
});

test("stdout projection preserves callback, encoding and backpressure", () => {
  const calls = [];
  const stream = { write(...args) { calls.push({ receiver: this, args }); return false; } };
  installRpcStdoutProjection(stream);
  const callback = () => {};
  assert.equal(stream.write(line({ type: "message_end", message: tool() }), "utf8", callback), false);
  assert.equal(calls[0].receiver, stream);
  assert.equal(calls[0].args[1], "utf8");
  assert.equal(calls[0].args[2], callback);
  assert.ok(Buffer.byteLength(calls[0].args[0]) < 500);
  assert.equal(stream.write("plain\n", callback), false);
  assert.equal(calls[1].args[1], callback);
});

test("actual Node preload projects RPC writes but leaves tool subprocesses alone", () => {
  const preload = new URL("../src/runs/rpc-stdout-projection.mjs", import.meta.url).href;
  const script = 'process.stdout.write(JSON.stringify({type:"message_end",message:{role:"toolResult",content:[{type:"image",data:"A".repeat(2200000)}]}})+"\\n")';
  const env = { ...process.env, PI_TEAMMATE_CHILD: "1" };
  const projected = spawnSync(process.execPath, ["--import", preload, "-e", script, "--", "--mode", "rpc"], { env, encoding: "utf8", maxBuffer: 3_000_000 });
  assert.equal(projected.status, 0, projected.stderr);
  assert.match(projected.stdout, /image omitted/);
  const untouched = spawnSync(process.execPath, ["--import", preload, "-e", script], { env, encoding: "utf8", maxBuffer: 3_000_000 });
  assert.equal(untouched.status, 0, untouched.stderr);
  assert.equal(JSON.parse(untouched.stdout).message.content[0].data.length, 2_200_000);
});

test("actual Node preload bounds text-only RPC events without intercepting ordinary tool output", () => {
  const preload = new URL("../src/runs/rpc-stdout-projection.mjs", import.meta.url).href;
  const script = 'process.stdout.write(JSON.stringify({type:"tool_execution_end",toolCallId:"search-1",toolName:"search",result:{content:[{type:"text",text:"x".repeat(4300000)}]}})+"\\n")';
  const env = { ...process.env, PI_TEAMMATE_CHILD: "1" };
  const projected = spawnSync(process.execPath, ["--import", preload, "-e", script, "--", "--mode", "rpc"], { env, encoding: "utf8", maxBuffer: 5_000_000 });
  assert.equal(projected.status, 0, projected.stderr);
  assert.ok(Buffer.byteLength(projected.stdout) < 1_048_576);
  assert.match(projected.stdout, /telemetry truncated/);
  assert.equal(JSON.parse(projected.stdout).toolCallId, "search-1");
  const untouched = spawnSync(process.execPath, ["--import", preload, "-e", script], { env, encoding: "utf8", maxBuffer: 5_000_000 });
  assert.equal(untouched.status, 0, untouched.stderr);
  assert.equal(JSON.parse(untouched.stdout).result.content[0].text.length, 4_300_000);
});

test("decoder reports overflow once before newline and preserves preceding event order", () => {
  const seen = [];
  const decoder = createUtf8LineDecoder(16, (info) => seen.push(info), (value) => seen.push(value));
  assert.deepEqual(decoder.write(Buffer.from('first\n{"type":"large","data":"')), []);
  assert.equal(seen[0], "first");
  assert.equal(seen[1].maxBytes, 16);
  assert.ok(seen[1].receivedBytes > 16);
  assert.match(seen[1].prefix, /large/);
  decoder.write(Buffer.from("x".repeat(100)));
  assert.equal(seen.length, 2);
  decoder.write(Buffer.from('"}\nnext\n'));
  assert.equal(seen.at(-1), "next");
  decoder.write(Buffer.from("y".repeat(17)));
  assert.equal(seen.filter((entry) => typeof entry === "object").length, 2);
});

const agentConfig = { name: "general", description: "test", systemPromptMode: "append", systemPrompt: "test", source: "builtin", filePath: "general.md", tools: ["read"] };
async function attempt(emit) {
  const stdout = new PassThrough();
  const child = new EventEmitter();
  let killed = false;
  let nodeOptions;
  let settled;
  const outcomes = [];
  Object.assign(child, {
    stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false, exitCode: null, signalCode: null,
    kill() {
      killed = true;
      child.exitCode = 1;
      queueMicrotask(() => { child.emit("exit", 1, null); child.emit("close", 1, null); });
      return true;
    },
  });
  const result = await runSingleAttempt(
    { agent: "general", task: "test", timeoutMs: 2000 }, agentConfig, process.cwd(), randomUUID(), "caller", Date.now(), undefined,
    {
      childPiVersion: "0.87.0",
      spawnChildProcess(_command, _args, options) {
        nodeOptions = options.env.NODE_OPTIONS;
        queueMicrotask(() => emit(stdout));
        return child;
      },
      onTurnComplete(value) { settled = value; outcomes.push(value); },
    },
  );
  return { result, child, stdout, nodeOptions, outcomes, get killed() { return killed; }, get settled() { return settled; } };
}

test("malformed stdout fails immediately without accepting a later final answer", async () => {
  const { result, killed } = await attempt((stdout) => {
    stdout.write('malformed stdout\n' + line({ type: "turn_end", message: assistant, toolResults: [] }) + line({ type: "agent_settled" }));
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.terminalStatus, "failed");
  assert.equal(killed, true);
  assert.match(result.messages.at(-1).content, /malformed JSON.*receivedBytes=16/);
  assert.equal(result.messages.some((message) => message.role === "assistant" && message.content === "done"), false);
});

test("malformed stdout after settlement fails the runtime without rewriting its published result", async () => {
  const handle = await attempt((stdout) => {
    stdout.write(line({ type: "turn_end", message: assistant, toolResults: [] })
      + line({ type: "agent_end", willRetry: false }) + line({ type: "agent_settled" }) + "malformed stdout\n");
  });
  assert.equal(handle.result.exitCode, 0);
  assert.equal(handle.result.lifecyclePending, true);
  assert.deepEqual(handle.outcomes.map((value) => value.terminalStatus), ["completed", "failed"]);
  assert.equal(handle.settled.exitCode, 1);
  assert.equal(handle.settled.wakeable, false);
  assert.equal(handle.killed, true);
  assert.match(handle.settled.messages.at(-1).content, /malformed JSON/);
});

test("oversized stdout while idle retires the child once and preserves the completed answer", async () => {
  const handle = await attempt((stdout) => {
    stdout.write(line({ type: "turn_end", message: assistant, toolResults: [] })
      + line({ type: "agent_end", willRetry: false }) + line({ type: "agent_settled" }));
  });
  assert.equal(handle.settled.terminalStatus, "completed");
  await new Promise((resolve) => setImmediate(resolve));
  handle.stdout.write('{"type":"tool_execution_end","data":"' + "x".repeat(4_194_304));
  handle.stdout.write("more corrupt stdout\n");
  assert.equal(handle.settled.terminalStatus, "failed");
  assert.equal(handle.settled.exitCode, 1);
  assert.equal(handle.killed, true);
  assert.equal(handle.outcomes.length, 2);
  assert.match(handle.settled.messages.at(-1).content, /oversized event=tool_execution_end/);
  assert.equal(handle.result.messages.at(-1).content, "done");
});

test("unprojectable oversized event fails immediately before its newline", async () => {
  const { result, killed } = await attempt((stdout) => {
    stdout.write('{"type":"tool_execution_end","data":"' + "x".repeat(4_194_304));
  });
  assert.equal(result.exitCode, 1);
  assert.equal(killed, true);
  assert.match(result.messages.at(-1).content, /oversized event=tool_execution_end, receivedBytes=\d+, limitBytes=4194304/);
});

test("oversized semantic structured arguments still fail the existing framing guard", async () => {
  const { result, killed } = await attempt((stdout) => {
    stdout.write(projectRpcWrite(line({ type: "tool_execution_start", toolName: "structured_output", toolCallId: "schema-1", args: { answer: "x".repeat(4_194_304) } })));
  });
  assert.equal(result.terminalStatus, "failed");
  assert.equal(killed, true);
  assert.match(result.messages.at(-1).content, /oversized event=tool_execution_start/);
});

test("large text-only tools complete with exact identities and no artificial replay risk", async () => {
  const original = { type: "tool_execution_end", toolCallId: "search-1", toolName: "search", isError: false, result: { content: [{ type: "text", text: "x".repeat(4_300_000) }], details: { data: "y".repeat(4_300_000) } } };
  const { result, settled, child } = await attempt((stdout) => {
    stdout.write(line({ type: "tool_execution_start", toolCallId: "search-1", toolName: "search", args: { pattern: "needle" } }));
    stdout.write(projectRpcWrite(line(original)));
    stdout.write(line({ type: "turn_end", message: assistant, toolResults: [] }));
    stdout.write(line({ type: "agent_end", willRetry: false }));
    stdout.write(line({ type: "agent_settled" }));
  });
  assert.equal(result.exitCode, 0);
  assert.equal(settled.terminalStatus, "completed");
  const facts = attemptRecoveryFacts.get(settled);
  assert.equal(facts.completedToolCount, 1);
  assert.equal(facts.inFlightToolCount, 0);
  assert.equal(facts.externalReplayRisk, false);
  assert.equal(original.result.content[0].text.length, 4_300_000);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
});

test("projected multi-image events allow final result and normal settlement", async () => {
  const { result, child, nodeOptions, settled } = await attempt((stdout) => {
    const tools = Array.from({ length: 4 }, tool);
    stdout.write(projectRpcWrite(line({ type: "turn_end", message: { ...assistant, stopReason: "toolUse" }, toolResults: tools })));
    stdout.write(line({ type: "turn_end", message: assistant, toolResults: [] }));
    stdout.write(projectRpcWrite(line({ type: "agent_end", willRetry: false, messages: [...tools, assistant] })));
    stdout.write(line({ type: "agent_settled" }));
  });
  assert.equal(result.exitCode, 0);
  assert.equal(settled.exitCode, 0);
  assert.equal(settled.terminalStatus, "completed");
  assert.match(nodeOptions, /--import=file:.*rpc-stdout-projection\.mjs/);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
});
