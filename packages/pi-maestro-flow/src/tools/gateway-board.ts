import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type, type Static } from "typebox";
import { createGatewayLocalClient } from "../gateway/local-client.ts";
import { resultSummary, toolCallLine, toolResultLine } from "../quiet-render.ts";
import type { FlowToolResult } from "./tool-result.ts";

export const GATEWAY_BOARD_ACTIONS = [
  "create", "list", "get", "update", "claim", "renew", "release", "takeover",
  "attach-endpoint", "detach-endpoint", "bind-session", "link-plan", "transition", "observe",
] as const;

type GatewayBoardAction = typeof GATEWAY_BOARD_ACTIONS[number];
const action = Type.Unsafe<GatewayBoardAction>({ type: "string", enum: [...GATEWAY_BOARD_ACTIONS] });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const stringArray = (maxItems: number, maxLength: number) => Type.Array(Type.String({ minLength: 1, maxLength }), { maxItems, uniqueItems: true });

export const GatewayBoardParams = Type.Object({
  action,
  taskId: Type.Optional(id),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 64 * 1024 }), Type.Null()])),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 8 * 1024 }), { maxItems: 32 })),
  priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("urgent")])),
  labels: Type.Optional(stringArray(32, 128)),
  dependencyIds: Type.Optional(stringArray(256, 128)),
  completionPolicy: Type.Optional(Type.Object({
    requireLinkedTodosCompleted: Type.Boolean(),
    requireReview: Type.Boolean(),
  }, { additionalProperties: false })),
  status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("active"), Type.Literal("blocked"), Type.Literal("completed"), Type.Literal("cancelled")])),
  phase: Type.Optional(Type.Union([Type.Literal("intake"), Type.Literal("planning"), Type.Literal("execution"), Type.Literal("review")])),
  orphaned: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  claimGeneration: Type.Optional(Type.Integer({ minimum: 1 })),
  leaseTtlMs: Type.Optional(Type.Integer({ minimum: 1 })),
  sessionId: Type.Optional(id),
  memberId: Type.Optional(id),
  todoIds: Type.Optional(stringArray(256, 128)),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4 * 1024 })),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
  resourceUris: Type.Optional(stringArray(16, 2048)),
}, { additionalProperties: false });

export interface GatewayBoardToolDetails {
  action: GatewayBoardAction;
  ok: boolean;
  taskId?: string;
  workspacePath: string;
  piSessionId: string;
}

export interface GatewayBoardCaller {
  call(args: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal }): Promise<CallToolResult>;
}

const defaultCaller: GatewayBoardCaller = {
  async call(args, options) {
    return createGatewayLocalClient({ cwd: options.cwd }).call("board", args, options.signal);
  },
};

const readonlyActions = new Set<GatewayBoardAction>(["list", "get", "observe"]);
const endpointActions = new Set<GatewayBoardAction>(["attach-endpoint", "detach-endpoint"]);

export function createGatewayBoardTool(caller: GatewayBoardCaller = defaultCaller): ToolDefinition<typeof GatewayBoardParams, GatewayBoardToolDetails> {
  return {
    name: "board",
    label: "Board",
    description: "Operate the workspace-shared Gateway Board through authenticated local IPC. Workspace, request IDs, operation IDs, and Pi endpoint identity are host-injected; supply expectedRevision for mutations.",
    promptSnippet: "Use board to publish, join, claim, plan, transition, and observe workspace-level shared work across Pi and Web endpoints.",
    promptGuidelines: [
      "Read a task revision before mutating it; every mutation is CAS-fenced by expectedRevision.",
      "Use attach-endpoint/detach-endpoint for this Pi session. The host supplies its session ID and endpoint kind; never invent identity fields.",
      "Endpoint bindings describe participation only. Use claim/renew/release/takeover for the single execution owner.",
    ],
    parameters: GatewayBoardParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<GatewayBoardToolDetails>> {
      const piSessionId = ctx.sessionManager.getSessionId();
      if (!piSessionId?.trim()) throw new Error("Current Pi session identity is unavailable");
      const requestId = randomUUID();
      const args: Record<string, unknown> = {
        ...params,
        workspacePath: ctx.cwd,
        requestId,
        ...(readonlyActions.has(params.action) ? {} : { operationId: randomUUID() }),
        ...(endpointActions.has(params.action) ? { endpointId: piSessionId } : {}),
      };
      const response = await caller.call(args, { cwd: ctx.cwd, signal });
      const text = response.content.find((item) => item.type === "text" && typeof item.text === "string");
      const output = text?.type === "text" ? text.text : JSON.stringify(response.structuredContent ?? response);
      const details: GatewayBoardToolDetails = {
        action: params.action,
        ok: response.isError !== true,
        ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
        workspacePath: ctx.cwd,
        piSessionId,
      };
      return {
        content: [{ type: "text", text: output }],
        details,
        ...(response.isError === true ? { isError: true } : {}),
      } as FlowToolResult<GatewayBoardToolDetails>;
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "board", `${String(args.action ?? "?")}${args.taskId ? ` ${String(args.taskId)}` : ""}`);
    },
    renderResult(result, options, theme, ctx) {
      if (options.isPartial) return new Text("", 0, 0);
      const text = result.content.find((item) => item.type === "text");
      const detail = text && "text" in text ? text.text : "";
      return toolResultLine(theme, {
        name: "board",
        ok: !ctx.isError,
        arg: `${String(ctx.args.action ?? "?")}${ctx.args.taskId ? ` ${String(ctx.args.taskId)}` : ""}`,
        summary: resultSummary(result),
        expanded: options.expanded,
        detail,
      });
    },
  };
}

export function registerGatewayBoardTool(pi: ExtensionAPI, caller?: GatewayBoardCaller): void {
  pi.registerTool(createGatewayBoardTool(caller));
}

export type GatewayBoardToolParams = Static<typeof GatewayBoardParams>;
