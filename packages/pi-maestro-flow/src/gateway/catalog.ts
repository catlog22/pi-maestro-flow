/** The single registration and dispatch source for every Gateway transport. */
import type { GatewayPrincipal, GatewayResult, GatewayTool, GatewayToolName } from "./contracts.ts";
import { GATEWAY_STATE_VERSION } from "./contracts.ts";
import type { ExecService } from "./services/exec-service.ts";
import type { FileService } from "./services/file-service.ts";
import type { HostService } from "./services/host-service.ts";
import type { JobService } from "./services/job-service.ts";
import type { GatewayTeammateService } from "./services/teammate-service.ts";
import type { GatewaySessionService } from "./services/session-service.ts";
import type { GatewayTodoService } from "./services/todo-service.ts";
import type { GatewayMonitorService } from "./services/monitor-service.ts";

export type GatewayToolArguments = Record<string, unknown>;
export type GatewayToolHandler = (principal: GatewayPrincipal, args: GatewayToolArguments) => GatewayResult<unknown> | Promise<GatewayResult<unknown>>;
export interface GatewayCatalogEntry extends Omit<GatewayTool, "name"> { name: GatewayToolName; handler: GatewayToolHandler; }
export interface GatewayCatalogServices { host: HostService; exec: ExecService; job: JobService; file: FileService; teammate: GatewayTeammateService; session: GatewaySessionService; todo: GatewayTodoService; monitor: GatewayMonitorService; }

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
  cwd: path, workspace: path, timeoutMs: integer({ minimum: 1 }),
  maxOutputBytes: integer({ minimum: 1 }), env: { type: "object", additionalProperties: { type: "string" } }, readonly: boolean,
};
const fileBase: Schema = { workspace: path, path };
const editOperation: Schema = {
  type: "object",
  properties: { oldText: string(), newText: string(), replaceAll: boolean },
  required: ["oldText", "newText"], additionalProperties: false,
};
const cursor: Schema = { oneOf: [integer({ minimum: 0 }), string({ minLength: 1 })] };

const HOST_SCHEMA = actions(action("describe"), action("status"), action("test"));
const EXEC_SCHEMA = actions(action("run", commandFields));
const JOB_SCHEMA = actions(
  action("start", commandFields), action("list"),
  action("status", { id: string({ minLength: 1 }) }, ["id"]),
  action("logs", { id: string({ minLength: 1 }), cursor: integer({ minimum: 0 }), limit: integer({ minimum: 1 }), maxBytes: integer({ minimum: 1 }) }, ["id"]),
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
  action("transfer", { workspace: path, source: path, from: path, destination: path, to: path, mode: { enum: ["copy", "move"] }, overwrite: boolean }),
  action("realpath", fileBase),
);
const mutationFields: Schema = { sessionId: string({ minLength: 1, maxLength: 128 }), memberId: string({ minLength: 1, maxLength: 128 }), expectedSessionRevision: integer({ minimum: 0 }), operationId: string({ minLength: 1, maxLength: 128 }) };
const todoIds: Schema = { type: "array", items: string({ minLength: 1, maxLength: 128 }), maxItems: 32, uniqueItems: true };
const SESSION_SCHEMA = actions(
  action("create", { sessionId: string({ minLength: 1, maxLength: 128 }), workspacePath: path, ownerId: string({ minLength: 1, maxLength: 128 }), leaseTtlMs: integer({ minimum: 1 }), expectedSessionRevision: integer({ minimum: 0 }), operationId: string({ minLength: 1, maxLength: 128 }) }, ["workspacePath", "ownerId", "expectedSessionRevision", "operationId"]),
  action("get", { sessionId: mutationFields.sessionId, memberId: mutationFields.memberId }, ["sessionId", "memberId"]),
  action("list", { memberId: mutationFields.memberId, limit: integer({ minimum: 1, maximum: 256 }) }, ["memberId"]),
  action("join", { ...mutationFields, joiningMemberId: string({ minLength: 1, maxLength: 128 }), joiningPrincipalId: string({ minLength: 1, maxLength: 256 }), role: { enum: ["owner", "agent", "web", "observer"] }, capabilities: stringArray, leaseTtlMs: integer({ minimum: 1 }) }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "joiningMemberId", "joiningPrincipalId", "role"]),
  action("renew", { ...mutationFields, expectedGeneration: integer({ minimum: 1 }), leaseTtlMs: integer({ minimum: 1 }) }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "expectedGeneration", "leaseTtlMs"]),
  action("leave", { ...mutationFields, leavingMemberId: string({ minLength: 1, maxLength: 128 }), expectedGeneration: integer({ minimum: 1 }) }, ["sessionId", "memberId", "expectedSessionRevision", "operationId", "expectedGeneration"]),
  action("close", mutationFields, ["sessionId", "memberId", "expectedSessionRevision", "operationId"]),
  action("start-pi", { sessionId: mutationFields.sessionId, memberId: mutationFields.memberId, prompt: string({ minLength: 1, maxLength: 32768 }), todoIds, agent: string({ minLength: 1, maxLength: 128 }) }, ["sessionId", "memberId", "prompt"]),
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
  action("observe", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128 }), cursor, limit: integer({ minimum: 1, maximum: 512 }) }, ["sessionId", "memberId", "handle"]),
  action("wait", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128 }), timeoutMs: integer({ minimum: 1 }) }, ["sessionId", "memberId", "handle"]),
  action("message", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128 }), message: string({ minLength: 1, maxLength: 65536 }), mode: { enum: ["steer", "follow_up", "interrupt"] } }, ["sessionId", "memberId", "handle", "message"]),
  action("cancel", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128 }), reason: string({ maxLength: 512 }) }, ["sessionId", "memberId", "handle"]),
  action("result", { ...monitorBase, handle: string({ minLength: 1, maxLength: 128 }), cursor, limit: integer({ minimum: 1, maximum: 512 }) }, ["sessionId", "memberId", "handle"]),
);
const TEAMMATE_SCHEMA = actions(
  action("start", { params: { type: "object" }, tasks: { type: "array" }, prompt: string(), objective: string(), task: string(), agent: string(), cwd: path, workspace: path, workspacePath: path, workspaceId: string(), options: { type: "object" }, runOptions: { type: "object" } }),
  action("list", { cursor, limit: integer({ minimum: 1 }) }),
  action("observe", { taskId: string(), cursor, afterCursor: cursor, limit: integer({ minimum: 1 }) }),
  action("wait", { taskId: string(), timeoutMs: integer({ minimum: 1 }) }),
  action("send", { taskId: string(), taskCorrelationId: string(), message: string(), mode: { enum: ["steer", "follow_up", "interrupt"] } }, ["message"]),
  action("cancel", { taskId: string(), reason: string() }),
  action("result", { taskId: string(), cursor, afterCursor: cursor, limit: integer({ minimum: 1 }) }),
);

function entry(name: GatewayToolName, description: string, inputSchema: Schema, handler: GatewayToolHandler, options: Pick<GatewayTool, "executionMode" | "mutating" | "readonly">): GatewayCatalogEntry {
  return { version: GATEWAY_STATE_VERSION, name, description, inputSchema, kind: name, capability: `gateway.${name}`, requiredCapabilities: [], ...options, handler };
}

export class GatewayCatalog {
  private readonly entries = new Map<GatewayToolName, GatewayCatalogEntry>();
  constructor(services: GatewayCatalogServices) {
    this.register(entry("host", "Describe, inspect, or test the machine running the Gateway.", HOST_SCHEMA, (principal, args) => services.host.handle({ ...args, principal } as never), { executionMode: "sync", readonly: true, mutating: false }));
    this.register(entry("exec", "Run one bounded argv-based command in an authorized workspace.", EXEC_SCHEMA, (principal, args) => services.exec.handle({ ...args, principal } as never), { executionMode: "sync", readonly: false, mutating: true }));
    this.register(entry("job", "Start and control bounded asynchronous commands and cursor-addressed logs.", JOB_SCHEMA, (principal, args) => services.job.handle({ ...args, principal } as never), { executionMode: "async", readonly: false, mutating: true }));
    this.register(entry("file", "List, inspect, read, write, edit, find, grep, or transfer workspace files.", FILE_SCHEMA, (principal, args) => services.file.handle({ ...args, principal } as never), { executionMode: "sync", readonly: false, mutating: true }));
    this.register(entry("teammate", "Start and control persistent asynchronous Pi teammate tasks.", TEAMMATE_SCHEMA, (principal, args) => services.teammate.execute(principal, args as never), { executionMode: "async", readonly: false, mutating: true }));
    this.register(entry("session", "Create and collaborate in durable Gateway sessions, or start a monitored Pi execution.", SESSION_SCHEMA, (principal, args) => services.session.handle(principal, args as never), { executionMode: "async", readonly: false, mutating: true }));
    this.register(entry("todo", "Manage the independent durable Gateway Todo authority.", TODO_SCHEMA, (principal, args) => services.todo.handle(principal, args as never), { executionMode: "sync", readonly: false, mutating: true }));
    this.register(entry("monitor", "Observe and control session-bound Pi executions through stable cursors.", MONITOR_SCHEMA, (principal, args) => services.monitor.handle(principal, args as never), { executionMode: "async", readonly: false, mutating: true }));
  }
  list(): GatewayTool[] { return [...this.entries.values()].map(({ handler: _handler, ...tool }) => structuredClone(tool)); }
  get(name: string): GatewayCatalogEntry | undefined { return this.entries.get(name as GatewayToolName); }
  async invoke(name: string, principal: GatewayPrincipal, args: GatewayToolArguments): Promise<GatewayResult<unknown> | undefined> { return this.get(name)?.handler(principal, args); }
  private register(value: GatewayCatalogEntry): void { if (this.entries.has(value.name)) throw new Error(`Duplicate Gateway tool: ${value.name}`); this.entries.set(value.name, value); }
}
export const createGatewayCatalog = (services: GatewayCatalogServices): GatewayCatalog => new GatewayCatalog(services);
