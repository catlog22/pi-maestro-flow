/** The single registration and dispatch source for every Gateway transport. */
import type { GatewayPrincipal, GatewayResult, GatewayTool, GatewayToolName } from "./contracts.ts";
import { GATEWAY_RESULT_SCHEMA, GATEWAY_STATE_VERSION } from "./contracts.ts";
import type { ExecService } from "./services/exec-service.ts";
import type { FileService } from "./services/file-service.ts";
import type { HostService } from "./services/host-service.ts";
import type { JobService } from "./services/job-service.ts";
import type { GatewayTeammateService } from "./services/teammate-service.ts";
import type { GatewaySessionService } from "./services/session-service.ts";
import type { GatewayTodoService } from "./services/todo-service.ts";
import type { GatewayMonitorService, GatewayMonitorStreamContext } from "./services/monitor-service.ts";
import type { WorkspaceService } from "./services/workspace-service.ts";
import type { BoardService } from "./services/board-service.ts";
import type { GatewayHandoffService } from "./services/handoff-service.ts";
import type { GatewaySkillService } from "./services/skill-service.ts";
import type { GatewayMaestroCliService } from "./services/maestro-cli-service.ts";
import { GATEWAY_HANDOFF_WRITE_SCHEMA } from "./handoff-contracts.ts";
import {
  GATEWAY_HANDOFF_GET_REQUEST_SCHEMA,
  GATEWAY_HANDOFF_LIST_REQUEST_SCHEMA,
  GATEWAY_HANDOFF_SEARCH_REQUEST_SCHEMA,
} from "./handoff-record-contracts.ts";
import { GATEWAY_SKILL_LIST_REQUEST_SCHEMA, GATEWAY_SKILL_LOAD_REQUEST_SCHEMA } from "./skill-contracts.ts";
import {
  GATEWAY_MAESTRO_LOAD_REQUEST_SCHEMA,
  GATEWAY_MAESTRO_SEARCH_REQUEST_SCHEMA,
  GATEWAY_MAESTRO_STAGE_REQUEST_SCHEMA,
} from "./maestro-cli-contracts.ts";

export type GatewayToolArguments = Record<string, unknown>;
export interface GatewayToolRequestContext { stream?: GatewayMonitorStreamContext; }
export type GatewayToolHandler = (principal: GatewayPrincipal, args: GatewayToolArguments, signal?: AbortSignal, context?: GatewayToolRequestContext) => GatewayResult<unknown> | Promise<GatewayResult<unknown>>;
export interface GatewayCatalogEntry extends Omit<GatewayTool, "name"> { name: GatewayToolName; handler: GatewayToolHandler; }
export interface GatewayCatalogServices {
  workspace: WorkspaceService;
  board: BoardService;
  host: HostService;
  exec: ExecService;
  job: JobService;
  file: FileService;
  teammate: GatewayTeammateService;
  session: GatewaySessionService;
  todo: GatewayTodoService;
  monitor: GatewayMonitorService;
  handoff: GatewayHandoffService;
  skill: GatewaySkillService;
  maestroCli: GatewayMaestroCliService;
}

type Schema = Record<string, unknown>;
const string = (extra: Schema = {}): Schema => ({ type: "string", ...extra });
const integer = (extra: Schema = {}): Schema => ({ type: "integer", ...extra });
const boolean: Schema = { type: "boolean" };
const stringArray: Schema = { type: "array", items: { type: "string" } };
const requestId: Schema = string({ minLength: 1, maxLength: 256 });
const path: Schema = string({ minLength: 1, maxLength: 4096 });

function action(action: string, properties: Schema = {}, required: string[] = []): Schema {
  return {
    type: "object",
    properties: { action: { const: action }, requestId, ...properties },
    required: ["action", ...required],
    additionalProperties: false,
  };
}
function actions(...schemas: Schema[]): Schema { return { type: "object", oneOf: schemas }; }

const commandFields: Schema = {
  command: string(), argv: { ...stringArray, minItems: 1 }, args: stringArray,
  cwd: path, workspace: path, workspaceId: string({ minLength: 1, maxLength: 256 }), timeoutMs: integer({ minimum: 1 }),
  maxOutputBytes: integer({ minimum: 1 }), env: { type: "object", additionalProperties: { type: "string" } }, readonly: boolean,
};
const fileBase: Schema = { workspace: path, workspaceId: string({ minLength: 1, maxLength: 256 }), path };
const editOperation: Schema = {
  type: "object",
  properties: { oldText: string(), newText: string(), replaceAll: boolean },
  required: ["oldText", "newText"], additionalProperties: false,
};
const cursor: Schema = { oneOf: [integer({ minimum: 0 }), string({ minLength: 1 })] };
const boundedIds = (maxItems = 256): Schema => ({ type: "array", items: string({ minLength: 1, maxLength: 128 }), maxItems, uniqueItems: true });
const workspaceFields: Schema = {
  workspaceId: string({ minLength: 1, maxLength: 256 }),
  workspace: path,
  workspacePath: path,
  path,
};
function workspaceAction(name: string, properties: Schema = {}, required: string[] = []): Schema {
  return {
    ...action(name, { ...workspaceFields, ...properties }, required),
    anyOf: [
      { required: ["workspaceId"] },
      { required: ["workspace"] },
      { required: ["workspacePath"] },
      { required: ["path"] },
    ],
  };
}

const WORKSPACE_GET_SCHEMA: Schema = {
  ...action("get", {
    workspaceId: string({ minLength: 1, maxLength: 256 }),
    id: string({ minLength: 1, maxLength: 256 }),
    workspace: path,
    path,
  }),
  anyOf: [
    { required: ["workspaceId"] },
    { required: ["id"] },
    { required: ["workspace"] },
    { required: ["path"] },
  ],
};
const WORKSPACE_SCHEMA = actions(
  action("list", { cursor: integer({ minimum: 0 }), limit: integer({ minimum: 1, maximum: 256 }) }),
  WORKSPACE_GET_SCHEMA,
);
const completionPolicy: Schema = {
  type: "object",
  properties: { requireLinkedTodosCompleted: boolean, requireReview: boolean },
  required: ["requireLinkedTodosCompleted", "requireReview"],
  additionalProperties: false,
};
const boardMutationFields: Schema = {
  taskId: string({ minLength: 1, maxLength: 128 }),
  expectedRevision: integer({ minimum: 0 }),
  operationId: string({ minLength: 1, maxLength: 128 }),
};
const boardTaskFields: Schema = {
  title: string({ minLength: 1, maxLength: 16384 }),
  description: string({ minLength: 1, maxLength: 65536 }),
  acceptanceCriteria: { type: "array", items: string({ minLength: 1, maxLength: 8192 }), maxItems: 32 },
  priority: { enum: ["low", "normal", "high", "urgent"] },
  labels: { type: "array", items: string({ minLength: 1, maxLength: 128 }), maxItems: 32, uniqueItems: true },
  dependencyIds: boundedIds(),
  completionPolicy,
};
const BOARD_UPDATE_SCHEMA: Schema = {
  ...workspaceAction("update", { ...boardMutationFields, ...boardTaskFields, description: { oneOf: [boardTaskFields.description, { type: "null" }] } }, ["taskId", "expectedRevision", "operationId"]),
  allOf: [{ anyOf: ["title", "description", "acceptanceCriteria", "priority", "labels", "dependencyIds", "completionPolicy"].map((field) => ({ required: [field] })) }],
};
const BOARD_CLAIM_SCHEMA: Schema = {
  ...workspaceAction("claim", { ...boardMutationFields, leaseTtlMs: integer({ minimum: 1 }), sessionId: string({ minLength: 1, maxLength: 128 }), memberId: string({ minLength: 1, maxLength: 128 }) }, ["taskId", "expectedRevision", "operationId"]),
  allOf: [{ anyOf: [{ not: { anyOf: [{ required: ["sessionId"] }, { required: ["memberId"] }] } }, { required: ["sessionId", "memberId"] }] }],
};
const BOARD_TRANSITION_SCHEMA: Schema = {
  ...workspaceAction("transition", {
    ...boardMutationFields,
    status: { enum: ["open", "active", "blocked", "completed", "cancelled"] },
    phase: { enum: ["intake", "planning", "execution", "review"] },
    claimGeneration: integer({ minimum: 1 }),
    summary: string({ minLength: 1, maxLength: 16384 }),
    resourceUris: { type: "array", items: string({ minLength: 1, maxLength: 2048 }), maxItems: 16, uniqueItems: true },
    handoff: GATEWAY_HANDOFF_WRITE_SCHEMA,
  }, ["taskId", "expectedRevision", "operationId"]),
  allOf: [{ anyOf: [{ required: ["status"] }, { required: ["phase"] }] }],
};
const BOARD_SCHEMA = actions(
  workspaceAction("create", { ...boardMutationFields, ...boardTaskFields }, ["title", "expectedRevision", "operationId"]),
  workspaceAction("list", { status: { enum: ["open", "active", "blocked", "completed", "cancelled"] }, phase: { enum: ["intake", "planning", "execution", "review"] }, orphaned: boolean, limit: integer({ minimum: 1, maximum: 4096 }) }),
  workspaceAction("get", { taskId: boardMutationFields.taskId }, ["taskId"]),
  BOARD_UPDATE_SCHEMA,
  BOARD_CLAIM_SCHEMA,
  workspaceAction("renew", { ...boardMutationFields, claimGeneration: integer({ minimum: 1 }), leaseTtlMs: integer({ minimum: 1 }) }, ["taskId", "expectedRevision", "operationId", "claimGeneration"]),
  workspaceAction("release", { ...boardMutationFields, claimGeneration: integer({ minimum: 1 }) }, ["taskId", "expectedRevision", "operationId", "claimGeneration"]),
  workspaceAction("takeover", { ...boardMutationFields, leaseTtlMs: integer({ minimum: 1 }), reason: string({ minLength: 1, maxLength: 4096 }) }, ["taskId", "expectedRevision", "operationId", "reason"]),
  workspaceAction("attach-endpoint", { ...boardMutationFields, endpointId: string({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }) }, ["taskId", "expectedRevision", "operationId", "endpointId"]),
  workspaceAction("detach-endpoint", { ...boardMutationFields, endpointId: string({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }) }, ["taskId", "expectedRevision", "operationId", "endpointId"]),
  workspaceAction("bind-session", { ...boardMutationFields, sessionId: string({ minLength: 1, maxLength: 128 }), memberId: string({ minLength: 1, maxLength: 128 }), claimGeneration: integer({ minimum: 1 }) }, ["taskId", "expectedRevision", "operationId", "sessionId", "memberId", "claimGeneration"]),
  workspaceAction("link-plan", { ...boardMutationFields, sessionId: string({ minLength: 1, maxLength: 128 }), todoIds: boundedIds(), claimGeneration: integer({ minimum: 1 }) }, ["taskId", "expectedRevision", "operationId", "sessionId", "todoIds", "claimGeneration"]),
  workspaceAction("handoff", { ...boardMutationFields, handoff: GATEWAY_HANDOFF_WRITE_SCHEMA }, ["taskId", "expectedRevision", "operationId", "handoff"]),
  BOARD_TRANSITION_SCHEMA,
  workspaceAction("search", { query: string({ minLength: 1, maxLength: 4096 }), status: { enum: ["open", "active", "blocked", "completed", "cancelled"] }, phase: { enum: ["intake", "planning", "execution", "review"] }, limit: integer({ minimum: 1, maximum: 4096 }) }, ["query"]),
  workspaceAction("observe", { cursor: integer({ minimum: 0 }), limit: integer({ minimum: 1, maximum: 512 }) }),
);
const HOST_SCHEMA = actions(action("describe"), action("status"), action("test"));
const EXEC_SCHEMA = actions(action("run", commandFields));
const JOB_SCHEMA = actions(
  action("start", commandFields), action("list"),
  action("status", { id: string({ minLength: 1 }) }, ["id"]),
  action("logs", { id: string({ minLength: 1 }), cursor: integer({ minimum: 0 }), stdoutOffset: integer({ minimum: 0 }), stderrOffset: integer({ minimum: 0 }), limit: integer({ minimum: 1 }), maxBytes: integer({ minimum: 1 }) }, ["id"]),
  action("stdin", { id: string({ minLength: 1 }), data: { oneOf: [string(), { type: "object" }] } }, ["id", "data"]),
  action("cancel", { id: string({ minLength: 1 }) }, ["id"]),
);
const FILE_SCHEMA = actions(
  action("list", { ...fileBase, maxResults: integer({ minimum: 1 }) }),
  action("stat", fileBase, ["path"]), action("read", { ...fileBase, encoding: { enum: ["utf8", "base64"] } }, ["path"]),
  action("write", { ...fileBase, content: { oneOf: [string(), { type: "object" }] }, encoding: { enum: ["utf8", "base64"] }, overwrite: boolean }, ["path", "content"]),
  action("edit", { ...fileBase, content: { oneOf: [string(), { type: "object" }] }, expectedSha256: string({ pattern: "^[a-fA-F0-9]{64}$" }), expectedHash: string({ pattern: "^[a-fA-F0-9]{64}$" }), edits: { type: "array", items: editOperation }, oldText: string(), newText: string(), replaceAll: boolean }, ["path"]),
  action("find", { ...fileBase, pattern: string(), name: string(), maxResults: integer({ minimum: 1 }), maxDepth: integer({ minimum: 0 }), includeDirectories: boolean }),
  action("grep", { ...fileBase, query: string(), pattern: string(), regex: boolean, maxResults: integer({ minimum: 1 }), maxBytes: integer({ minimum: 1 }) }),
  action("transfer", { workspace: path, workspaceId: string({ minLength: 1, maxLength: 256 }), source: path, from: path, destination: path, to: path, mode: { enum: ["copy", "move"] }, overwrite: boolean }),
  action("realpath", fileBase),
);
const mutationFields: Schema = { sessionId: string({ minLength: 1, maxLength: 128 }), memberId: string({ minLength: 1, maxLength: 128 }), expectedSessionRevision: integer({ minimum: 0 }), operationId: string({ minLength: 1, maxLength: 128 }) };
const todoIds: Schema = { type: "array", items: string({ minLength: 1, maxLength: 128 }), maxItems: 32, uniqueItems: true };
const SESSION_CREATE_SCHEMA: Schema = {
  ...action("create", { sessionId: string({ minLength: 1, maxLength: 128 }), workspaceId: string({ minLength: 1, maxLength: 256 }), workspacePath: path, ownerId: string({ minLength: 1, maxLength: 128 }), leaseTtlMs: integer({ minimum: 1 }), expectedSessionRevision: integer({ minimum: 0 }), operationId: string({ minLength: 1, maxLength: 128 }) }, ["ownerId", "expectedSessionRevision", "operationId"]),
  anyOf: [{ required: ["workspaceId"] }, { required: ["workspacePath"] }],
};
const SESSION_SCHEMA = actions(
  SESSION_CREATE_SCHEMA,
  action("get", { sessionId: mutationFields.sessionId, memberId: mutationFields.memberId }, ["sessionId", "memberId"]),
  action("list", { memberId: mutationFields.memberId, limit: integer({ minimum: 1, maximum: 256 }) }, ["memberId"]),
  action("join", { ...mutationFields, joiningMemberId: string({ minLength: 1, maxLength: 128 }), joiningPrincipalId: string({ minLength: 1, maxLength: 256 }), role: { enum: ["owner", "agent", "web", "observer"] }, capabilities: stringArray, leaseTtlMs: integer({ minimum: 1 }) }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "joiningMemberId", "joiningPrincipalId", "role"]),
  action("renew", { ...mutationFields, expectedGeneration: integer({ minimum: 1 }), leaseTtlMs: integer({ minimum: 1 }) }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "expectedGeneration", "leaseTtlMs"]),
  action("leave", { ...mutationFields, leavingMemberId: string({ minLength: 1, maxLength: 128 }), expectedGeneration: integer({ minimum: 1 }) }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "expectedGeneration"]),
  action("handoff", { ...mutationFields, handoff: GATEWAY_HANDOFF_WRITE_SCHEMA }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "handoff"]),
  action("close", { ...mutationFields, handoff: GATEWAY_HANDOFF_WRITE_SCHEMA }, ["sessionId", "memberId", "expectedSessionRevision", "operationId"]),
  action("start-pi", { sessionId: mutationFields.sessionId, memberId: mutationFields.memberId, operationId: mutationFields.operationId, prompt: string({ minLength: 1, maxLength: 32768 }), todoIds, agent: string({ minLength: 1, maxLength: 128 }) }, ["sessionId", "memberId", "operationId", "prompt"]),
);
const TODO_SCHEMA = actions(
  action("create", { ...mutationFields, todoId: string({ minLength: 1, maxLength: 128 }), subject: string({ minLength: 1, maxLength: 16384 }), description: string({ maxLength: 65536 }), dependencyIds: { ...todoIds, maxItems: 256 } }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "subject"]),
  action("update", { ...mutationFields, todoId: string({ minLength: 1, maxLength: 128 }), subject: string({ minLength: 1, maxLength: 16384 }), description: { oneOf: [string({ maxLength: 65536 }), { type: "null" }] }, dependencyIds: { ...todoIds, maxItems: 256 } }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "todoId"]),
  action("list", { sessionId: mutationFields.sessionId, memberId: mutationFields.memberId }, ["sessionId", "memberId"]),
  action("get", { sessionId: mutationFields.sessionId, memberId: mutationFields.memberId, todoId: string({ minLength: 1, maxLength: 128 }) }, ["sessionId", "memberId", "todoId"]),
  ...["delete", "claim", "release"].map((name) => action(name, { ...mutationFields, todoId: string({ minLength: 1, maxLength: 128 }) }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "todoId"])),
  action("advance", { ...mutationFields, todoId: string({ minLength: 1, maxLength: 128 }), status: { enum: ["pending", "blocked", "completed", "cancelled"] } }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "todoId", "status"]),
);
const monitorBase: Schema = { sessionId: mutationFields.sessionId, memberId: mutationFields.memberId };
const MONITOR_SCHEMA = actions(
  action("list", monitorBase, ["sessionId", "memberId"]),
  action("observe", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128, description: "Execution handle returned by session.start-pi as taskId or monitorHandle." }), cursor, limit: integer({ minimum: 1, maximum: 512 }) }, ["sessionId", "memberId", "handle"]),
  action("wait", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128, description: "Execution handle returned by session.start-pi as taskId or monitorHandle." }), timeoutMs: integer({ minimum: 1 }) }, ["sessionId", "memberId", "handle"]),
  action("message", { ...monitorBase, operationId: mutationFields.operationId, handle: string({ minLength: 1, maxLength: 128, description: "Execution handle returned by session.start-pi as taskId or monitorHandle." }), message: string({ minLength: 1, maxLength: 65536 }), mode: { enum: ["steer", "follow_up", "interrupt"] } }, ["sessionId", "memberId", "operationId", "handle", "message"]),
  action("cancel", { ...monitorBase, operationId: mutationFields.operationId, handle: string({ minLength: 1, maxLength: 128, description: "Execution handle returned by session.start-pi as taskId or monitorHandle." }), reason: string({ maxLength: 512 }) }, ["sessionId", "memberId", "operationId", "handle"]),
  action("result", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128, description: "Execution handle returned by session.start-pi as taskId or monitorHandle." }), cursor, limit: integer({ minimum: 1, maximum: 512 }) }, ["sessionId", "memberId", "handle"]),
  action("subscribe", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128 }), cursor }, ["sessionId", "memberId", "handle"]),
  action("unsubscribe", { ...monitorBase, subscriptionId: string({ minLength: 1, maxLength: 128 }) }, ["sessionId", "memberId", "subscriptionId"]),
);
const teammateOutputSchema: Schema = { type: "object", maxProperties: 256 };
const teammateTask: Schema = {
  type: "object",
  properties: {
    prompt: string({ minLength: 1, maxLength: 65536 }),
    description: string({ maxLength: 16384 }),
    agent: string({ minLength: 1, maxLength: 128 }),
    taskType: string({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9._-]*$" }),
    name: string({ minLength: 1, maxLength: 128 }),
    dependsOn: boundedIds(32),
    context: { enum: ["fresh", "fork"] },
    model: string({ minLength: 1, maxLength: 256 }),
    fallbackModels: { type: "array", items: string({ minLength: 1, maxLength: 256 }), maxItems: 16, uniqueItems: true },
    thinking: { enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    cwd: path,
    outputSchema: teammateOutputSchema,
    timeoutMs: integer({ minimum: 1 }),
    maxNestingDepth: integer({ minimum: 0, maximum: 2 }),
    background: boolean,
    todo: { oneOf: [string({ minLength: 1, maxLength: 128 }), boundedIds(32)] },
    briefing: { type: "array", items: string({ minLength: 1, maxLength: 2048 }), maxItems: 32 },
  },
  required: ["prompt"],
  additionalProperties: false,
};
const teammateParamFields: Schema = {
  tasks: { type: "array", items: teammateTask, minItems: 1, maxItems: 32 },
  mode: { enum: ["default", "expert"] },
  agent: string({ minLength: 1, maxLength: 128 }),
  taskType: string({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9._-]*$" }),
  reply_to: { enum: ["caller", "main"] },
  background: boolean,
  context: { enum: ["fresh", "fork"] },
  model: string({ minLength: 1, maxLength: 256 }),
  fallbackModels: { type: "array", items: string({ minLength: 1, maxLength: 256 }), maxItems: 16, uniqueItems: true },
  thinking: { enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  cwd: path,
  timeoutMs: integer({ minimum: 1 }),
  outputSchema: teammateOutputSchema,
  concurrency: integer({ minimum: 1, maximum: 32 }),
  concurrencyWaitMs: integer({ minimum: 1 }),
  maxAgents: integer({ minimum: 1, maximum: 32 }),
  maxNestingDepth: integer({ minimum: 0, maximum: 2 }),
  steeringMode: { enum: ["all", "one-at-a-time"] },
};
const teammateParams: Schema = { type: "object", properties: teammateParamFields, required: ["tasks"], additionalProperties: false };
const teammateOptions: Schema = {
  type: "object",
  properties: { enableRetryBackoff: boolean, inheritModel: string({ minLength: 1, maxLength: 256 }) },
  additionalProperties: false,
};
const TEAMMATE_START_SCHEMA: Schema = {
  ...action("start", {
    ...teammateParamFields,
    params: teammateParams,
    prompt: string({ minLength: 1, maxLength: 65536 }),
    objective: string({ minLength: 1, maxLength: 65536 }),
    task: string({ minLength: 1, maxLength: 65536 }),
    workspace: path,
    workspacePath: path,
    workspaceId: string({ minLength: 1, maxLength: 256 }),
    options: teammateOptions,
    runOptions: teammateOptions,
  }),
  anyOf: [{ required: ["params"] }, { required: ["tasks"] }, { required: ["prompt"] }, { required: ["task"] }],
};
const TEAMMATE_SCHEMA = actions(
  TEAMMATE_START_SCHEMA,
  action("list", { cursor, limit: integer({ minimum: 1 }) }),
  action("observe", { taskId: string(), cursor, afterCursor: cursor, limit: integer({ minimum: 1 }) }),
  action("wait", { taskId: string(), timeoutMs: integer({ minimum: 1 }) }),
  action("send", { taskId: string(), taskCorrelationId: string(), message: string(), mode: { enum: ["steer", "follow_up", "interrupt"] } }, ["message"]),
  action("cancel", { taskId: string(), reason: string() }),
  action("result", { taskId: string(), cursor, afterCursor: cursor, limit: integer({ minimum: 1 }) }),
);
const HANDOFF_SCHEMA = actions(
  GATEWAY_HANDOFF_LIST_REQUEST_SCHEMA as unknown as Schema,
  GATEWAY_HANDOFF_GET_REQUEST_SCHEMA as unknown as Schema,
  GATEWAY_HANDOFF_SEARCH_REQUEST_SCHEMA as unknown as Schema,
);
const SKILL_SCHEMA = actions(
  GATEWAY_SKILL_LIST_REQUEST_SCHEMA as unknown as Schema,
  GATEWAY_SKILL_LOAD_REQUEST_SCHEMA as unknown as Schema,
);
const MAESTRO_CLI_SCHEMA = actions(
  GATEWAY_MAESTRO_SEARCH_REQUEST_SCHEMA as unknown as Schema,
  GATEWAY_MAESTRO_LOAD_REQUEST_SCHEMA as unknown as Schema,
  GATEWAY_MAESTRO_STAGE_REQUEST_SCHEMA as unknown as Schema,
);

function entry(name: GatewayToolName, description: string, inputSchema: Schema, handler: GatewayToolHandler, options: Pick<GatewayTool, "executionMode" | "mutating" | "readonly">): GatewayCatalogEntry {
  const readonly = options.readonly === true;
  return {
    version: GATEWAY_STATE_VERSION,
    name,
    description,
    inputSchema,
    outputSchema: structuredClone(GATEWAY_RESULT_SCHEMA) as unknown as Schema,
    annotations: {
      readOnlyHint: readonly,
      destructiveHint: !readonly,
      idempotentHint: readonly,
      openWorldHint: !readonly,
    },
    kind: name,
    capability: `gateway.${name}`,
    requiredCapabilities: [`gateway.${name}`],
    ...options,
    handler,
  };
}

export class GatewayCatalog {
  private readonly entries = new Map<GatewayToolName, GatewayCatalogEntry>();
  constructor(services: GatewayCatalogServices) {
    this.register(entry("workspace", "Discover principal-authorized workspaces by stable ID without exposing owner credentials.", WORKSPACE_SCHEMA, (principal, args) => services.workspace.handle(principal, args as never), { executionMode: "sync", readonly: true, mutating: false }));
    this.register(entry("board", "Use the exact Board actions create, list, get, update, claim, renew, release, takeover, attach-endpoint, detach-endpoint, bind-session, link-plan, handoff, transition, search, and observe. create publishes work; session membership is handled by session.join. handoff stores resumable content and completed tasks snapshot it under result.handoff; search matches task and completion handoff content.", BOARD_SCHEMA, (principal, args) => services.board.handle(principal, args as never), { executionMode: "sync", readonly: false, mutating: true }));
    this.register(entry("host", "Describe, inspect, or test the machine running the Gateway.", HOST_SCHEMA, (principal, args) => services.host.handle({ ...args, principal } as never), { executionMode: "sync", readonly: true, mutating: false }));
    this.register(entry("exec", "Run one bounded argv-based command in an authorized workspace.", EXEC_SCHEMA, (principal, args) => services.exec.handle({ ...args, principal } as never), { executionMode: "sync", readonly: false, mutating: true }));
    this.register(entry("job", "Start and control bounded asynchronous commands and cursor-addressed logs.", JOB_SCHEMA, (principal, args) => services.job.handle({ ...args, principal } as never), { executionMode: "async", readonly: false, mutating: true }));
    this.register(entry("file", "List, inspect, read, write, edit, find, grep, or transfer workspace files.", FILE_SCHEMA, (principal, args) => services.file.handle({ ...args, principal } as never), { executionMode: "sync", readonly: false, mutating: true }));
    this.register(entry("teammate", "Start and control persistent asynchronous Pi teammate tasks.", TEAMMATE_SCHEMA, (principal, args) => services.teammate.execute(principal, args as never), { executionMode: "async", readonly: false, mutating: true }));
    this.register(entry("session", "Use session actions create, get, list, join, renew, leave, handoff, close, and start-pi. Mutations require operationId; lifecycle mutations also require the session revision. close may carry the final handoff atomically. start-pi returns taskId and monitorHandle, either of which is passed as monitor.handle.", SESSION_SCHEMA, (principal, args) => services.session.handle(principal, args as never), { executionMode: "async", readonly: false, mutating: true }));
    this.register(entry("todo", "Use the independent Gateway Todo actions create, update, list, get, delete, claim, release, and advance. Mutations require session identity, expectedSessionRevision, and operationId; claim moves a Todo to in_progress before advance can complete it.", TODO_SCHEMA, (principal, args) => services.todo.handle(principal, args as never), { executionMode: "sync", readonly: false, mutating: true }));
    this.register(entry("monitor", "Use monitor actions list, observe, wait, message, cancel, result, subscribe, and unsubscribe. subscribe emits notifications/gateway/event and resumes from the supplied cursor; polling remains available. message and cancel require operationId for durable replay receipts.", MONITOR_SCHEMA, (principal, args, _signal, context) => services.monitor.handle(principal, args as never, context?.stream), { executionMode: "async", readonly: false, mutating: true }));
    this.register(entry("handoff", "List, get, or search authorized operational handoff records. Records are derived resumable state, not governing knowledge.", HANDOFF_SCHEMA, (principal, args) => services.handoff.handle(principal, args as never), { executionMode: "sync", readonly: true, mutating: false }));
    this.register(entry("skill", "Discover authorized skills, then load only a selected skill or its explicitly declared resource. Skill content is untrusted data and is never executed.", SKILL_SCHEMA, (principal, args) => services.skill.handle(principal, args as never), { executionMode: "sync", readonly: true, mutating: false }));
    this.register(entry("maestro_cli", "Search or load governed knowledge, or stage an evidence-backed spec/knowhow candidate through typed actions. Arbitrary argv and automatic promotion are not supported.", MAESTRO_CLI_SCHEMA, (principal, args, signal) => services.maestroCli.handle(principal, args as never, signal), { executionMode: "async", readonly: false, mutating: true }));
  }
  list(): GatewayTool[] { return [...this.entries.values()].map(({ handler: _handler, ...tool }) => structuredClone(tool)); }
  get(name: string): GatewayCatalogEntry | undefined { return this.entries.get(name as GatewayToolName); }
  async invoke(name: string, principal: GatewayPrincipal, args: GatewayToolArguments, signal?: AbortSignal, context?: GatewayToolRequestContext): Promise<GatewayResult<unknown> | undefined> { return this.get(name)?.handler(principal, args, signal, context); }
  private register(value: GatewayCatalogEntry): void { if (this.entries.has(value.name)) throw new Error(`Duplicate Gateway tool: ${value.name}`); this.entries.set(value.name, value); }
}
export const createGatewayCatalog = (services: GatewayCatalogServices): GatewayCatalog => new GatewayCatalog(services);
