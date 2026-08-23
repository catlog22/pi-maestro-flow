import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  proxyTeammateChildTool,
  type TeammateChildToolBrokerRequest,
  type TeammateChildToolResult,
} from "pi-maestro-teammate/v1/child-extensions";
import {
  createComputerUseTool,
  type ComputerUseToolDetails,
} from "../tools/computer-use-tool.ts";
import {
  computerUseManager,
  type ComputerUseManagerLike,
} from "../tools/computer-use/manager.ts";
import { ComputerUseError, errorInfo } from "../tools/computer-use/types.ts";

/** Root-owned authority for all child computer-use requests. */
export class TeammateComputerUseBroker {
  readonly #actors = new Set<string>();
  readonly #actorControllers = new Map<string, AbortController>();
  readonly #closedActors = new Set<string>();

  constructor(readonly manager: ComputerUseManagerLike = computerUseManager) {}

  async execute(
    request: TeammateChildToolBrokerRequest,
    ctx: ExtensionContext,
  ): Promise<TeammateChildToolResult> {
    const actorId = typeof request.actor.correlationId === "string"
      ? request.actor.correlationId.trim()
      : "";
    if (!actorId || actorId === "unknown") {
      return brokerFailure(request.input, new ComputerUseError({
        code: "INTERNAL",
        message: "Teammate computer-use request has no trusted correlation id.",
        retryable: false,
        details: { reason: "missing_actor" },
      }));
    }
    if (this.#closedActors.has(actorId)) {
      return brokerFailure(request.input, new ComputerUseError({
        code: "INTERNAL",
        message: `Teammate computer-use actor ${actorId} belongs to a completed or stale session generation.`,
        retryable: false,
        details: { reason: "stale_actor", actorId },
      }));
    }

    this.#actors.add(actorId);
    const actorController = this.#actorControllers.get(actorId) ?? new AbortController();
    this.#actorControllers.set(actorId, actorController);
    const signal = request.signal
      ? AbortSignal.any([request.signal, actorController.signal])
      : actorController.signal;
    const tool = createComputerUseTool(this.manager);
    return await tool.execute(
      `teammate-computer-use:${actorId}`,
      request.input as never,
      signal,
      undefined,
      ctx,
    ) as TeammateChildToolResult;
  }

  async closeActor(actorId: string): Promise<number> {
    const normalized = actorId.trim();
    if (!normalized || normalized === "unknown") return 0;
    this.#closedActors.add(normalized);
    this.#actorControllers.get(normalized)?.abort(new ComputerUseError({
      code: "ABORTED",
      message: "Teammate actor completed",
      retryable: true,
    }));
    this.#actorControllers.delete(normalized);
    return this.#actors.delete(normalized) ? 1 : 0;
  }

  async closeAll(): Promise<number> {
    const actors = [...this.#actors];
    for (const actor of actors) {
      this.#closedActors.add(actor);
      this.#actorControllers.get(actor)?.abort(new ComputerUseError({
        code: "ABORTED",
        message: "Teammate session ended",
        retryable: true,
      }));
    }
    this.#actors.clear();
    this.#actorControllers.clear();
    return actors.length;
  }
}

export function createTeammateChildComputerUseTool(): ToolDefinition {
  // The child only needs the schema and renderers. Its execute method below is
  // replaced with IPC, so do not even construct a local lazy manager here.
  const tool = createComputerUseTool({} as ComputerUseManagerLike);
  return {
    ...tool,
    async execute(_id, params, signal): Promise<AgentToolResult<ComputerUseToolDetails>> {
      return proxyTeammateChildTool<ComputerUseToolDetails>(
        "computer_use",
        params as unknown as Record<string, unknown>,
        signal,
      );
    },
  } as ToolDefinition;
}

function brokerFailure(
  input: Record<string, unknown>,
  error: ComputerUseError,
): TeammateChildToolResult {
  const info = errorInfo(error);
  const action = typeof input.action === "string" ? input.action : "unknown";
  return {
    content: [{ type: "text", text: JSON.stringify({ error: info }, null, 2) }],
    isError: true,
    details: { action, error: info },
  };
}
