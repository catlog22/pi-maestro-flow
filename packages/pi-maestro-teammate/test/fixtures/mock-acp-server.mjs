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

// A second axis, so a client driving more than one selector is exercised. No
// `thought_level` option is advertised on purpose: an agent that bakes
// reasoning depth into its model values publishes nothing there, and a client
// must report that axis as empty rather than inventing one.
const MODE_OPTIONS = [
  { value: "agent", name: "Agent" },
  { value: "plan", name: "Plan" },
];

/** Values this server was actually put on, by config id. */
const selected = {};

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
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: MODEL_OPTIONS[0].value,
            options: MODEL_OPTIONS,
          },
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: MODE_OPTIONS[0].value,
            options: MODE_OPTIONS,
          },
        ],
      },
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    const { configId, value } = message.params;
    const available = configId === "model" ? MODEL_OPTIONS : configId === "mode" ? MODE_OPTIONS : undefined;
    if (!available || !available.some((option) => option.value === value)) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown option ${configId}=${value}` } });
      return;
    }
    selected[configId] = value;
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
            text: `hello from mock acp (${message.params.prompt}) `
              + `model=${selected.model ?? "unset"} mode=${selected.mode ?? "unset"}`,
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
