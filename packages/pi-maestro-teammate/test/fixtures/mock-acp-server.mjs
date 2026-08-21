// Minimal ACP NDJSON server used by test/local-acp.test.ts to exercise the
// local ACP execution backend end to end. Reads JSON-RPC lines from stdin and
// replies with initialize / session/new / session/prompt handling.

import * as readline from "node:readline";

const PROTOCOL_VERSION = 1;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const sessions = new Set();

// Advertised so a client can exercise model selection. The two entries share no
// name, so a request naming one by name resolves to exactly one value — the
// case that proves the client reports what the agent settled on rather than the
// string it was handed.
const MODEL_OPTIONS = [
  { value: "mock-fast[effort=low]", name: "Mock Fast" },
  { value: "mock-deep[effort=high]", name: "Mock Deep" },
];

/** Values this server was actually put on, newest last. */
const selectedModels = [];

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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId,
        configOptions: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: MODEL_OPTIONS[0].value,
          options: MODEL_OPTIONS,
        }],
      },
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    const { configId, value } = message.params;
    if (configId !== "model" || !MODEL_OPTIONS.some((option) => option.value === value)) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown option ${configId}=${value}` } });
      return;
    }
    selectedModels.push(value);
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    const { sessionId } = message.params;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        // Echoes the selection so the transcript proves the agent ran under it,
        // independently of what the client reports having selected.
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `hello from mock acp (${message.params.prompt}) model=${selectedModels.at(-1) ?? "unset"}`,
          },
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
