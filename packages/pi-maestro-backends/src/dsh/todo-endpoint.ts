/**
 * A loopback MCP endpoint carrying the host's todo tool into one dsh run.
 *
 * The runtime has no route to a host-implemented tool: its tool set comes from
 * its own `cordis.yml`. This endpoint is that route — one MCP server per run,
 * bound to an ephemeral 127.0.0.1 port, publishing a single tool whose raw name
 * is `todo` and whose calls are forwarded to the host broker the backend was
 * handed.
 *
 * Identity is bound here, not asked for. The actor a call runs as comes from
 * the endpoint's own per-run correlation id, and arguments are filtered to the
 * published schema before they leave this module, so a model cannot name a
 * different actor by adding a field. The URL carries a per-run token for the
 * same reason: it is the only thing that distinguishes this run's endpoint from
 * a concurrent one, so the host keeps it out of every diagnostic it writes and
 * hands it to the runtime under a name the runtime's own environment scrub
 * removes before it can reach a grandchild process — see `TODO_ENDPOINT_ENV`.
 *
 * The deployment side of this seam — the `mcp-client` entry naming this server
 * `maestro_todo` — lives in `docs/dsh-todo-bridge-deployment.md`.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** The raw tool name published here; the runtime prefixes it with its server name. */
const TOOL_NAME = "todo";

/**
 * The MCP server name a deployment must give this endpoint.
 *
 * The runtime composes the model-visible tool name as
 * `mcp__<serverName>__<rawName>`, so this is not a label: it is half of the
 * name the host has to put in the instruction it sends, and a deployment that
 * picks another one leaves the agent reading about a tool it does not have.
 */
export const TODO_SERVER_NAME = "maestro_todo";

/** What the model sees this endpoint's only tool called. */
export const TODO_PUBLIC_TOOL_NAME = `mcp__${TODO_SERVER_NAME}__${TOOL_NAME}`;

/**
 * The environment variable carrying this endpoint's URL to the runtime.
 *
 * The name is load-bearing, not cosmetic. The URL embeds the per-run bearer
 * token, and the dsh runtime hands its children a scrubbed copy of its own
 * environment: `scrubbedParentEnv()` drops every name matching
 * `/KEY|PASSWORD|SECRET|TOKEN/i` (`packages/subprocess/subprocess/src/index.ts`
 * in deepseek-harness). A name outside that pattern is inherited by every
 * `bash` grandchild the model starts, so one `env` call would copy this run's
 * credential into a transcript and let anything that reads that transcript act
 * as this teammate. The runtime process itself is spawned by the host and is
 * handed the value explicitly, so the scrub costs the bridge nothing.
 */
export const TODO_ENDPOINT_ENV = "PI_MAESTRO_TODO_MCP_SECRET_URL";

/**
 * What a teammate is allowed to do with the host's todo queue.
 *
 * Narrower than the host tool on purpose. The assigned-todo instruction sends a
 * child to read its queue and report progress, and the host's own edit check
 * already limits a teammate actor to items it owns, so the remaining actions
 * are root-facing: publishing them would spend tokens describing a route whose
 * every call the host would refuse.
 */
const ACTIONS = ["list", "get", "update"] as const;

/**
 * The published tool schema.
 *
 * Written as JSON Schema and served from the low-level request handler rather
 * than through `McpServer.registerTool`, which rejects anything that is not a
 * Zod schema or raw shape. Publishing the schema directly keeps the wire
 * contract readable here and adds no schema-library dependency to this package.
 */
const WRITABLE_FIELDS = ["status", "summary"] as const;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTIONS], description: "Which operation to run." },
    id: { type: "string", description: "Todo item id, for a single-item read or write." },
    status: { type: "string", description: "New status for the addressed item." },
    summary: { type: "string", description: "New summary for the addressed item." },
    // A list of field *names*, which is what the host tool takes: it feeds this
    // straight into a `Set` and rejects a named field whose value is absent.
    // Published as an object, the host threw `TypeError: object is not iterable`
    // out of an uncaught path, so a model obeying the published schema got an
    // internal error instead of a parameter error. The enum is the two fields
    // `ACCEPTED_KEYS` actually lets through — naming any other one here would
    // publish a write this endpoint drops before the host sees it.
    updateFields: {
      type: "array",
      items: { type: "string", enum: [...WRITABLE_FIELDS] },
      description: "Which of the fields above this update writes; optional, since a field you send is written anyway.",
    },
    filter: { type: "object", description: "Narrows which items a read returns." },
  },
  required: ["action"],
} as const;

/** Keys a call may carry; anything else is dropped before the host sees it. */
const ACCEPTED_KEYS: readonly string[] = Object.keys(INPUT_SCHEMA.properties);

const TOOL_DESCRIPTION = "Read and update the todo items assigned to you. "
  + "`list` returns your queue, `get` reads one item by id, and `update` writes status or summary back. "
  + "You act as yourself: the caller is identified by the connection, never by an argument.";

/**
 * Tell an agent it owns a queue, and how to drive it.
 *
 * Written here rather than by the host because the only part of it a host
 * cannot supply is the part that decides whether the agent finds the queue at
 * all: the model-visible tool name, which exists only where this endpoint is
 * mounted and is composed from this module's own server name. The host's Pi
 * path states the same protocol in shell-command form — `todo update <id>
 * status=in_progress` — and a runtime that has no such command reads that as an
 * invitation to go looking for one, which is what a bridged run was observed
 * doing across dozens of `bash` calls. So this states the same protocol in
 * tool-call form and says plainly that no command exists.
 *
 * @param todos - the item ids bound to this run, in priority order.
 * @returns the instruction block, ready to append to the run's prompt.
 */
export function assignedTodoInstruction(todos: readonly string[]): string {
  const ids = todos.map((id) => `#${id.replace(/^#/, "")}`).join(", ");
  return `## Assigned todo tasks

The following todo items are assigned to you, in priority order: ${ids}.

They live in the orchestrator's queue. The \`${TODO_PUBLIC_TOOL_NAME}\` tool is your only route to it — there is no todo command on your shell, so do not search for one.

- Read your queue: call \`${TODO_PUBLIC_TOOL_NAME}\` with {"action": "list"}. One item may already be active.
- Take the first item that is not done: {"action": "update", "id": "<id>", "status": "in_progress"}.
- Finish it before starting the next: {"action": "update", "id": "<id>", "status": "completed", "summary": "<one line on what you did>"}.

Work the items in the order above and keep exactly one in progress. If an item is blocked or you cannot finish it, leave it as it is and say why in your final answer.`;
}

/** What one endpoint needs to serve a run. */
export interface TodoEndpointOptions {
  /** This run's correlation id, which is the actor every call is attributed to. */
  correlationId: string;
  /** The host closure a published tool call is forwarded to. */
  proxyToolCall: (request: { toolName: string; args: unknown; correlationId: string }) => Promise<unknown>;
}

/** One run's live endpoint. */
export interface TodoEndpoint {
  /** `http://127.0.0.1:${port}/mcp?token=${token}` */
  readonly url: string;
  /**
   * Whether a client ever completed the MCP initialize handshake.
   *
   * The host reads this to tell a deployment that mounted this endpoint from
   * one whose `cordis.yml` never named it: the latter reaches settlement having
   * never connected, and is a misconfiguration rather than a run that simply
   * had no todo work to do.
   */
  sawClientConnect(): boolean;
  close(): Promise<void>;
}

/**
 * What the host broker answers with.
 *
 * The seam types `proxyToolCall` as returning `unknown` because the host owns
 * the tool result, so the fields this module forwards are narrowed here.
 */
interface HostToolResult {
  content?: unknown;
  isError?: boolean;
}

/**
 * Drop everything the published schema does not declare.
 *
 * An allow-list rather than a deny-list: the risk is a model naming a different
 * actor, and enumerating the fields it must not send would leave every field
 * nobody thought of still arriving at the host.
 *
 * @param args - the arguments as they came off the wire.
 * @returns only the declared keys, in whatever form they arrived.
 */
function accepted(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null) return {};
  const source = args as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of ACCEPTED_KEYS) {
    if (key in source) kept[key] = source[key];
  }
  return kept;
}

/** Answer a request that failed the token check, without reaching the transport. */
function refuse(res: ServerResponse): void {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Invalid session" }));
}

/**
 * Start one run's todo endpoint.
 *
 * @param options - the run's identity and the host closure calls are forwarded to.
 * @returns the live endpoint; the caller owns closing it.
 */
export async function startTodoEndpoint(options: TodoEndpointOptions): Promise<TodoEndpoint> {
  const token = randomUUID();
  let connected = false;

  const server = new Server({ name: "maestro-todo", version: "1" }, { capabilities: { tools: {} } });
  // The runtime's own statement that it finished the handshake, rather than an
  // inference from having received bytes: a client that opened a socket and
  // failed has not reached this tool.
  server.oninitialized = (): void => {
    connected = true;
  };
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await options.proxyToolCall({
      toolName: TOOL_NAME,
      args: accepted(request.params.arguments),
      // Bound to the endpoint, never read off the call: this is the whole
      // reason identity is absent from the schema.
      correlationId: options.correlationId,
    }) as HostToolResult;
    // `isError` is forwarded rather than flattened. A write the host refused
    // would otherwise read to the model as a write that succeeded, and the
    // agent would move on from an item it never actually updated. `details` has
    // no MCP counterpart and is dropped.
    return {
      content: result.content,
      ...(result.isError === true ? { isError: true } : {}),
    };
  });

  // Stateful, because a stateless transport in this SDK refuses its second
  // request outright: it is built to be constructed per request, and one run
  // holds this endpoint open across a whole conversation. The session id it
  // round-trips is the SDK's own; authority here still rests on the token.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  const http: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== token) {
      refuse(res);
      return;
    }
    void transport.handleRequest(req, res).catch(() => {
      // A transport that could not answer has already written what it could;
      // there is no second channel to report this on, and throwing out of a
      // request listener would take the host process down with it.
      if (!res.writableEnded) res.end();
    });
  });
  // Unreferenced so a run that leaked this endpoint cannot hold the host
  // process open past its work. While the run is live its own awaited work
  // keeps the loop alive, so this costs the endpoint nothing.
  http.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error): void => reject(cause);
    http.once("error", onError);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", onError);
      resolve();
    });
  });

  const address = http.address();
  if (address === null || typeof address === "string") {
    await transport.close();
    http.close();
    throw new Error("dsh todo endpoint bound no port; the host cannot tell the runtime where to reach it");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp?token=${token}`,
    sawClientConnect: () => connected,
    async close(): Promise<void> {
      await transport.close();
      // `http.close()` waits for every open connection to end, and this
      // endpoint's clients hold theirs open across a run. On the error path the
      // runtime can still be alive holding one, and then the callback below
      // never fires and the caller's reclamation never settles.
      http.closeAllConnections();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
      });
    },
  };
}
