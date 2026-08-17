// Minimal ACP NDJSON server used by test/local-acp.test.ts to exercise the
// local ACP execution backend end to end. Reads JSON-RPC lines from stdin and
// replies with initialize / session/new / session/prompt handling.

import * as readline from "node:readline";

const PROTOCOL_VERSION = 1;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const sessions = new Set();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        agentCapabilities: { sessionCapabilities: {} },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    const sessionId = `mock-session-${sessions.size + 1}`;
    sessions.add(sessionId);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    const { sessionId } = message.params;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `hello from mock acp (${message.params.prompt})` },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 } },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unhandled: ${message.method}` } });
});
