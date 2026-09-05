/** Shared Gateway runtime used by local IPC and every HTTP MCP session. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayConfig } from "./config.ts";
import { loadGatewayConfig } from "./config.ts";
import type { GatewayPrincipal, GatewayResult } from "./contracts.ts";
import { GATEWAY_PROTOCOL_VERSION } from "./contracts.ts";
import { GatewayCatalog } from "./catalog.ts";
import { GatewayAuditSink } from "./audit.ts";
import { GatewayPolicy } from "./policy.ts";
import { gatewayError } from "./result.ts";
import { validateGatewayValue } from "./validation.ts";
import { gatewayJobsRoot, gatewaySessionsRoot, gatewayTasksRoot } from "./state-paths.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import { ExecService } from "./services/exec-service.ts";
import { FileService } from "./services/file-service.ts";
import { HostService } from "./services/host-service.ts";
import { JobService } from "./services/job-service.ts";
import { GatewayTeammateService, type GatewayTeammatePort } from "./services/teammate-service.ts";
import { SessionStore } from "./session-store.ts";
import { GatewayTodoStore } from "./todo-store.ts";
import { GatewaySessionService } from "./services/session-service.ts";
import { GatewayTodoService } from "./services/todo-service.ts";
import { GatewayMonitorService } from "./services/monitor-service.ts";

export interface GatewayRuntimeOptions {
  config?: GatewayConfig;
  configPath?: string;
  cwd?: string;
  workspaceRegistry?: WorkspaceRegistry;
  teammatePort?: GatewayTeammatePort;
}

export class GatewayRuntime {
  readonly config: GatewayConfig;
  readonly cwd: string;
  readonly registry: WorkspaceRegistry;
  readonly policy: GatewayPolicy;
  readonly host: HostService;
  readonly exec: ExecService;
  readonly job: JobService;
  readonly file: FileService;
  readonly teammate: GatewayTeammateService;
  readonly sessionStore: SessionStore;
  readonly todoStore: GatewayTodoStore;
  readonly session: GatewaySessionService;
  readonly todo: GatewayTodoService;
  readonly monitor: GatewayMonitorService;
  readonly catalog: GatewayCatalog;
  readonly audit: GatewayAuditSink;
  private closed = false;

  private constructor(config: GatewayConfig, options: GatewayRuntimeOptions) {
    this.config = config;
    this.cwd = options.cwd ?? process.cwd();
    this.registry = options.workspaceRegistry ?? new WorkspaceRegistry({
      path: config.state.workspaceRegistryPath,
      maxEntries: config.limits.maxWorkspaceCount,
      maxTtlMs: config.limits.maxLeaseTtlMs,
    });
    this.policy = new GatewayPolicy({
      workspaceRoot: this.cwd,
      workspaces: config.workspaces,
      registry: this.registry,
      limits: config.limits,
    });
    const stateRoot = config.state.rootDir;
    const jobsRoot = stateRoot ? join(stateRoot, "jobs") : gatewayJobsRoot(this.cwd);
    const taskJournalPath = stateRoot ? join(stateRoot, "tasks", "journal.json") : join(gatewayTasksRoot(this.cwd), "journal.json");
    const sessionsRoot = config.state.sessionsRoot ?? (stateRoot ? join(stateRoot, "sessions") : gatewaySessionsRoot(this.cwd));
    this.host = new HostService();
    this.exec = new ExecService({
      policy: this.policy,
      workspaceRoot: this.cwd,
      commandPolicy: config.security.commands,
      maxOutputBytes: config.limits.maxOutputBytes,
    });
    this.job = new JobService({
      policy: this.policy,
      workspaceRoot: this.cwd,
      commandPolicy: config.security.commands,
      jobsRoot,
      maxOutputBytes: config.limits.maxOutputBytes,
      retentionMs: config.retention.jobsMs,
    });
    this.file = new FileService({
      policy: this.policy,
      workspaceRoot: this.cwd,
      security: config.security.files,
    });
    this.teammate = new GatewayTeammateService({
      port: options.teammatePort,
      policy: this.policy,
      baseCwd: this.cwd,
      journalPath: taskJournalPath,
      journalOptions: { maxTasks: config.limits.maxTasks },
      maxResultBytes: config.limits.maxOutputBytes,
      taskRetentionMs: config.retention.tasksMs,
      resultRetentionMs: config.retention.resultsMs,
      maxEvents: 512,
      maxEventBytes: Math.min(1024 * 1024, config.limits.maxOutputBytes),
    });
    this.sessionStore = new SessionStore({ cwd: this.cwd, sessionsRoot, maxLeaseTtlMs: config.limits.maxLeaseTtlMs });
    this.todoStore = new GatewayTodoStore(this.sessionStore);
    this.session = new GatewaySessionService({ store: this.sessionStore, todos: this.todoStore, teammate: this.teammate, authMode: config.auth.mode, policy: this.policy });
    this.todo = new GatewayTodoService({ store: this.todoStore, sessions: this.sessionStore, authMode: config.auth.mode });
    this.monitor = new GatewayMonitorService({ sessions: this.sessionStore, teammate: this.teammate, authMode: config.auth.mode });
    this.catalog = new GatewayCatalog({
      host: this.host,
      exec: this.exec,
      job: this.job,
      file: this.file,
      teammate: this.teammate,
      session: this.session,
      todo: this.todo,
      monitor: this.monitor,
    });
    this.audit = new GatewayAuditSink(config.logging.auditFile);
  }

  static async create(options: GatewayRuntimeOptions = {}): Promise<GatewayRuntime> {
    const config = options.config ?? await loadGatewayConfig(options.configPath);
    return new GatewayRuntime(config, options);
  }

  async call(name: string, args: unknown, principal: GatewayPrincipal): Promise<GatewayResult<unknown>> {
    const startedAt = Date.now();
    const suppliedRequestId = args && typeof args === "object" && !Array.isArray(args) && typeof (args as Record<string, unknown>).requestId === "string"
      ? String((args as Record<string, unknown>).requestId)
      : undefined;
    const requestId = suppliedRequestId && suppliedRequestId.length <= 256 ? suppliedRequestId : randomUUID();
    const failure = (code: string, message: string): GatewayResult<unknown> => gatewayError({ code, message }, { requestId, principalId: principal.id });
    let result: GatewayResult<unknown>;
    try {
      if (this.closed) result = failure("gateway_closed", "Gateway runtime is closed");
      else {
        const tool = this.catalog.get(name);
        if (!tool) result = failure("tool_not_found", `Unknown Gateway tool: ${name}`);
        else if (!args || typeof args !== "object" || Array.isArray(args)) result = failure("invalid_arguments", "Gateway tool arguments must be an object");
        else {
          const parsed = validateGatewayValue<Record<string, unknown>>(tool.inputSchema, args, `${name} arguments`);
          this.policy.checkRequest(parsed);
          result = await this.policy.withConcurrency("request", async () => {
            const serviceResult = await tool.handler(principal, parsed);
            const attributed = { ...serviceResult, meta: { ...serviceResult.meta, principalId: principal.id } } as GatewayResult<unknown>;
            this.policy.checkOutput(attributed);
            return attributed;
          });
        }
      }
    } catch (error) {
      const declaredCode = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : undefined;
      const code = error && typeof error === "object" && (error as { name?: unknown }).name === "GatewayValidationError"
        ? "invalid_arguments" : declaredCode ?? "internal_error";
      result = failure(code, error instanceof Error ? error.message : String(error));
    }
    const deniedCodes = new Set(["policy_denied", "file_denied", "command_denied", "confirmation_required", "invalid_arguments", "invalid_principal"]);
    await this.audit.write({
      requestId: result.meta.requestId,
      principal,
      tool: name,
      action: args && typeof args === "object" && !Array.isArray(args) && typeof (args as Record<string, unknown>).action === "string" ? String((args as Record<string, unknown>).action) : undefined,
      outcome: result.ok ? "allowed" : deniedCodes.has(result.error?.code ?? "") ? "denied" : "error",
      code: result.error?.code,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  createMcpServer(principal: GatewayPrincipal): Server {
    const server = new Server(
      { name: "pi-maestro-gateway", version: String(GATEWAY_PROTOCOL_VERSION) },
      { capabilities: { tools: {} }, instructions: "Use the fixed host, exec, job, file, teammate, session, todo, and monitor tools. Tool results are versioned GatewayResult envelopes." },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.catalog.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await this.call(request.params.name, request.params.arguments ?? {}, principal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(result.ok ? {} : { isError: true }),
      };
    });
    return server;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([this.job.shutdown(), this.teammate.shutdown()]);
  }
}

export const createGatewayRuntime = (options?: GatewayRuntimeOptions): Promise<GatewayRuntime> => GatewayRuntime.create(options);
