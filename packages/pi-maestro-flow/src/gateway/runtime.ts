/** Shared Gateway runtime used by local IPC and every HTTP MCP session. */
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayConfig } from "./config.ts";
import { loadGatewayConfig } from "./config.ts";
import type { GatewayPrincipal, GatewayResult, GatewayToolName } from "./contracts.ts";
import { GATEWAY_DEFAULT_LIMITS, GATEWAY_PROTOCOL_VERSION } from "./contracts.ts";
import { GATEWAY_MONITOR_STREAM_FEATURE, type GatewayEventNotification } from "./event-contracts.ts";
import { GatewayEventStream } from "./event-stream.ts";
import { GatewayCatalog, type GatewayToolRequestContext } from "./catalog.ts";
import { GatewayAuditSink } from "./audit.ts";
import { GatewayObserver } from "./observability.ts";
import { GatewayPolicy, GatewayPolicyError } from "./policy.ts";
import { GatewayPairingStore } from "./pairing-store.ts";
import { gatewayError } from "./result.ts";
import { validateGatewayValue } from "./validation.ts";
import { gatewayHandoffRoot, gatewayJobsRoot, gatewayMaestroReceiptRoot, gatewayOperationReceiptRoot, gatewaySessionsRoot, gatewayTasksRoot } from "./state-paths.ts";
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
import { WorkspaceService } from "./services/workspace-service.ts";
import { BoardService } from "./services/board-service.ts";
import { GatewaySkillPolicy } from "./skill-policy.ts";
import { GatewaySkillService } from "./services/skill-service.ts";
import { GatewayHandoffRecordStore } from "./handoff-record-store.ts";
import { GatewayHandoffService } from "./services/handoff-service.ts";
import { GatewayMaestroReceiptStore } from "./maestro-cli-receipt-store.ts";
import { GatewayOperationReceiptStore } from "./operation-receipt-store.ts";
import { GatewayMaestroCliService, type GatewayMaestroStageBinding } from "./services/maestro-cli-service.ts";
import type { RunCliRunner } from "../session/cli-adapter.ts";
import { GATEWAY_MCP_INSTRUCTIONS } from "./prompt-guidance.ts";
import { principalHasGatewayAction } from "./capabilities.ts";

export interface GatewayRuntimeOptions {
  config?: GatewayConfig;
  configPath?: string;
  cwd?: string;
  workspaceRegistry?: WorkspaceRegistry;
  teammatePort?: GatewayTeammatePort;
  pairingStore?: GatewayPairingStore;
  operationReceiptStore?: GatewayOperationReceiptStore;
  warningSink?: (message: string) => void;
  maestroRunner?: RunCliRunner;
  maestroEnvironment?: NodeJS.ProcessEnv;
  resolveMaestroStageBinding?: (input: { workspacePath: string; workflowSessionId?: string; runId?: string }) => Promise<GatewayMaestroStageBinding | undefined>;
}

const READ_ACTIONS: Partial<Record<GatewayToolName, ReadonlySet<string>>> = {
  workspace: new Set(["list", "get"]),
  board: new Set(["list", "get", "search", "observe"]),
  host: new Set(["describe", "status", "test"]),
  job: new Set(["list", "status", "logs"]),
  file: new Set(["list", "stat", "read", "find", "grep", "realpath"]),
  teammate: new Set(["list", "observe", "wait", "result"]),
  session: new Set(["get", "list", "events"]),
  todo: new Set(["list", "get"]),
  monitor: new Set(["list", "observe", "wait", "result", "subscribe", "unsubscribe"]),
  handoff: new Set(["list", "get", "search"]),
  skill: new Set(["list", "load"]),
  maestro_cli: new Set(["search", "load"]),
};

export class GatewayRuntime {
  readonly config: GatewayConfig;
  readonly cwd: string;
  readonly registry: WorkspaceRegistry;
  readonly policy: GatewayPolicy;
  readonly pairingStore: GatewayPairingStore;
  readonly workspace: WorkspaceService;
  readonly host: HostService;
  readonly exec: ExecService;
  readonly job: JobService;
  readonly file: FileService;
  readonly teammate: GatewayTeammateService;
  readonly sessionStore: SessionStore;
  readonly todoStore: GatewayTodoStore;
  readonly operationReceipts: GatewayOperationReceiptStore;
  readonly session: GatewaySessionService;
  readonly todo: GatewayTodoService;
  readonly board: BoardService;
  readonly handoffRecords: GatewayHandoffRecordStore;
  readonly handoff: GatewayHandoffService;
  readonly skill: GatewaySkillService;
  readonly maestroReceipts: GatewayMaestroReceiptStore;
  readonly maestroCli: GatewayMaestroCliService;
  readonly monitor: GatewayMonitorService;
  readonly eventStream: GatewayEventStream;
  readonly catalog: GatewayCatalog;
  readonly audit: GatewayAuditSink;
  readonly observer: GatewayObserver;
  private readonly warningSink: (message: string) => void;
  private phase: "running" | "quiescing" | "closed" = "running";
  private activeRequests = 0;
  private readonly drainWaiters = new Set<() => void>();
  private warnedOpenMutation = false;

  private constructor(config: GatewayConfig, options: GatewayRuntimeOptions) {
    this.config = config;
    this.cwd = options.cwd ?? process.cwd();
    this.audit = new GatewayAuditSink(config.logging.auditFile);
    this.observer = new GatewayObserver(this.audit);
    this.warningSink = options.warningSink ?? ((message) => process.emitWarning(message, { code: "PI_MAESTRO_GATEWAY_OPEN_MUTATION" }));
    if (config.security.trustedFullAccess?.enabled && config.auth.mode === "open") {
      throw new Error("security.trustedFullAccess requires authenticated Gateway HTTP (auth.mode cannot be open)");
    }
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
      trustedFullAccess: {
        enabled: config.security.trustedFullAccess?.enabled ?? false,
        workspaceRoots: (config.security.trustedFullAccess?.workspaceRoots ?? []).map((root) => isAbsolute(root) ? root : resolve(this.cwd, root)),
      },
    });
    this.pairingStore = options.pairingStore ?? new GatewayPairingStore({ path: config.state.pairingPath });
    this.workspace = new WorkspaceService(this.policy, this.registry);
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
      trustedFullAccess: config.security.trustedFullAccess?.enabled ?? false,
    });
    this.job = new JobService({
      policy: this.policy,
      workspaceRoot: this.cwd,
      commandPolicy: config.security.commands,
      jobsRoot,
      maxOutputBytes: config.limits.maxOutputBytes,
      retentionMs: config.retention.jobsMs,
      trustedFullAccess: config.security.trustedFullAccess?.enabled ?? false,
    });
    this.file = new FileService({
      policy: this.policy,
      workspaceRoot: this.cwd,
      security: config.security.files,
      trustedFullAccess: config.security.trustedFullAccess?.enabled ?? false,
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
    this.operationReceipts = options.operationReceiptStore ?? new GatewayOperationReceiptStore({
      root: config.state.operationReceiptRoot ?? (stateRoot ? join(stateRoot, "operation-receipts") : gatewayOperationReceiptRoot(this.cwd)),
      observer: this.observer,
    });
    this.eventStream = new GatewayEventStream(this.teammate.eventJournal, { observer: this.observer });
    this.session = new GatewaySessionService({ store: this.sessionStore, todos: this.todoStore, teammate: this.teammate, receipts: this.operationReceipts, authMode: config.auth.mode, policy: this.policy, stream: this.eventStream });
    this.todo = new GatewayTodoService({ store: this.todoStore, sessions: this.sessionStore, authMode: config.auth.mode });
    this.board = new BoardService({
      policy: this.policy,
      sessions: this.sessionStore,
      todos: this.todoStore,
      boardRoot: config.state.boardRoot ?? (stateRoot ? join(stateRoot, "board") : undefined),
      maxTasks: config.limits.maxBoardTasks,
      maxOperations: config.limits.maxBoardOperations,
      maxEvents: config.limits.maxBoardEvents,
      maxLeaseTtlMs: config.limits.maxLeaseTtlMs,
      taskRetentionMs: config.retention.boardTasksMs,
      operationRetentionMs: config.retention.boardOperationsMs,
      eventRetentionMs: config.retention.boardEventsMs,
    });
    this.handoffRecords = new GatewayHandoffRecordStore({
      root: config.state.handoffRoot ?? (stateRoot ? join(stateRoot, "handoffs") : gatewayHandoffRoot(this.cwd)),
      maxRecords: config.limits.maxHandoffRecords ?? GATEWAY_DEFAULT_LIMITS.maxHandoffRecords,
    });
    this.handoff = new GatewayHandoffService({
      policy: this.policy,
      sessions: this.sessionStore,
      records: this.handoffRecords,
      boardStoreForWorkspace: (workspacePath) => this.board.storeForWorkspace(workspacePath),
      authMode: config.auth.mode,
    });
    this.skill = new GatewaySkillService(new GatewaySkillPolicy({
      policy: this.policy,
      security: config.security.skills,
      baseCwd: this.cwd,
      maxFiles: config.limits.maxSkillFiles ?? GATEWAY_DEFAULT_LIMITS.maxSkillFiles,
      maxFileBytes: config.limits.maxSkillFileBytes ?? GATEWAY_DEFAULT_LIMITS.maxSkillFileBytes,
      maxResponseBytes: config.limits.maxSkillResponseBytes ?? GATEWAY_DEFAULT_LIMITS.maxSkillResponseBytes,
    }));
    this.maestroReceipts = new GatewayMaestroReceiptStore(
      config.state.maestroReceiptRoot ?? (stateRoot ? join(stateRoot, "maestro-receipts") : gatewayMaestroReceiptRoot(this.cwd)),
    );
    this.maestroCli = new GatewayMaestroCliService({
      policy: this.policy,
      security: config.security.maestroCli,
      receipts: this.maestroReceipts,
      maxOutputBytes: config.limits.maxMaestroOutputBytes ?? GATEWAY_DEFAULT_LIMITS.maxMaestroOutputBytes,
      timeoutMs: config.limits.maxMaestroTimeoutMs ?? GATEWAY_DEFAULT_LIMITS.maxMaestroTimeoutMs,
      ...(options.maestroRunner === undefined ? {} : { runner: options.maestroRunner }),
      ...(options.maestroEnvironment === undefined ? {} : { environment: options.maestroEnvironment }),
      ...(options.resolveMaestroStageBinding === undefined ? {} : { resolveStageBinding: options.resolveMaestroStageBinding }),
      handoffs: {
        search: async (principal, input) => {
          const result = await this.handoff.handle(principal, { action: "search", workspaceId: input.workspaceId, query: input.query, limit: input.limit });
          if (!result.ok) throw new Error(result.error?.message ?? "handoff search failed");
          return (result.data as { records?: unknown[] } | undefined)?.records ?? [];
        },
        load: async (principal, input) => {
          const result = await this.handoff.handle(principal, { action: "get", workspaceId: input.workspaceId, id: input.id });
          if (!result.ok) throw new Error(result.error?.message ?? "handoff load failed");
          return (result.data as { record?: unknown } | undefined)?.record;
        },
      },
    });
    this.monitor = new GatewayMonitorService({ sessions: this.sessionStore, teammate: this.teammate, receipts: this.operationReceipts, authMode: config.auth.mode, stream: this.eventStream });
    this.catalog = new GatewayCatalog({
      workspace: this.workspace,
      board: this.board,
      host: this.host,
      exec: this.exec,
      job: this.job,
      file: this.file,
      teammate: this.teammate,
      session: this.session,
      todo: this.todo,
      monitor: this.monitor,
      handoff: this.handoff,
      skill: this.skill,
      maestroCli: this.maestroCli,
    });
  }

  static async create(options: GatewayRuntimeOptions = {}): Promise<GatewayRuntime> {
    const config = options.config ?? await loadGatewayConfig(options.configPath);
    const runtime = new GatewayRuntime(config, options);
    await runtime.operationReceipts.recoverInterrupted();
    return runtime;
  }

  async call(name: string, args: unknown, principal: GatewayPrincipal, signal?: AbortSignal, context?: GatewayToolRequestContext): Promise<GatewayResult<unknown>> {
    const startedAt = Date.now();
    const admittedBeforeQuiesce = this.phase === "running";
    this.activeRequests += 1;
    const suppliedRequestId = args && typeof args === "object" && !Array.isArray(args) && typeof (args as Record<string, unknown>).requestId === "string"
      ? String((args as Record<string, unknown>).requestId)
      : undefined;
    const requestId = suppliedRequestId && suppliedRequestId.length <= 256 ? suppliedRequestId : randomUUID();
    const failure = (code: string, message: string): GatewayResult<unknown> => gatewayError({ code, message }, { requestId, principalId: principal.id });
    let auditedTool = "unknown";
    let auditedAction: string | undefined;
    let result: GatewayResult<unknown>;
    try {
      if (this.phase === "closed") result = failure("gateway_closed", "Gateway runtime is closed");
      else {
        const tool = this.catalog.get(name);
        if (!tool) result = failure("tool_not_found", `Unknown Gateway tool: ${name}`);
        else {
          auditedTool = tool.name;
          if (!args || typeof args !== "object" || Array.isArray(args)) result = failure("invalid_arguments", "Gateway tool arguments must be an object");
          else {
          const parsed = validateGatewayValue<Record<string, unknown>>(tool.inputSchema, args, `${name} arguments`);
          const action = String(parsed.action);
          auditedAction = action;
          if (!admittedBeforeQuiesce && !this.isQuiesceRead(action)) {
            throw new GatewayPolicyError("Gateway is quiescing; new mutations and subscriptions are refused", "gateway_quiescing");
          }
          if (!principalHasGatewayAction(principal, tool.name, action)) {
            throw new GatewayPolicyError(`Gateway principal lacks required capability: gateway.${tool.name}.${action}`, "capability_denied");
          }
          if (this.isOpenHttpMutation(principal, tool.name, tool.mutating === true, parsed)) {
            if (this.config.auth.allowOpenMutations === false) throw new GatewayPolicyError("HTTP mutations are disabled when auth.mode=open", "open_mutation_denied");
            if (this.config.auth.allowOpenMutations === undefined && !this.warnedOpenMutation) {
              this.warnedOpenMutation = true;
              this.warningSink("HTTP mutation under auth.mode=open is using the legacy compatibility bridge; set auth.allow_open_mutations explicitly. Set false for read-only HTTP or true to acknowledge legacy mutation access.");
            }
          }
          const isMonitorWait = tool.name === "monitor" && action === "wait";
          if (isMonitorWait) parsed.timeoutMs = this.policy.normalizeMonitorWaitTimeout(parsed.timeoutMs);
          this.policy.checkRequest(parsed);
          const invoke = async (): Promise<GatewayResult<unknown>> => {
            const serviceResult = await tool.handler(principal, parsed, signal, context);
            const attributed = { ...serviceResult, meta: { ...serviceResult.meta, principalId: principal.id } } as GatewayResult<unknown>;
            this.policy.checkOutput(attributed);
            return attributed;
          };
          result = isMonitorWait
            ? await this.policy.withMonitorWait(principal, invoke)
            : await this.policy.withConcurrency("request", invoke);
          }
        }
      }
    } catch (error) {
      const declaredCode = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : undefined;
      const code = error && typeof error === "object" && (error as { name?: unknown }).name === "GatewayValidationError"
        ? "invalid_arguments" : declaredCode ?? "internal_error";
      result = failure(code, error instanceof Error ? error.message : String(error));
    }
    const deniedCodes = new Set(["policy_denied", "file_denied", "command_denied", "confirmation_required", "invalid_arguments", "invalid_principal", "capability_denied", "open_mutation_denied", "gateway_quiescing"]);
    try {
      await this.audit.write({
        requestId: result.meta.requestId,
        principal,
        tool: auditedTool,
        action: auditedAction,
        outcome: result.ok ? "allowed" : deniedCodes.has(result.error?.code ?? "") ? "denied" : "error",
        code: result.error?.code,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } finally {
      this.activeRequests -= 1;
      if (this.activeRequests === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    }
  }

  createMcpServer(principal: GatewayPrincipal): Server {
    const connectionId = randomUUID();
    const server = new Server(
      { name: "pi-maestro-gateway", version: String(GATEWAY_PROTOCOL_VERSION) },
      { capabilities: { tools: {}, experimental: { [GATEWAY_MONITOR_STREAM_FEATURE]: {} } }, instructions: GATEWAY_MCP_INSTRUCTIONS },
    );
    server.onclose = () => { this.eventStream.closeConnection(connectionId); };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.catalog.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const stream = {
        connectionId,
        write: (notification: GatewayEventNotification) => server.notification(notification as never),
      };
      const result = await this.call(request.params.name, request.params.arguments ?? {}, principal, extra.signal, { stream });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: !result.ok,
      };
    });
    return server;
  }

  private isOpenHttpMutation(principal: GatewayPrincipal, name: GatewayToolName, mutating: boolean, args: Record<string, unknown>): boolean {
    if (!mutating || this.config.auth.mode !== "open" || principal.transport !== "http") return false;
    const action = typeof args.action === "string" ? args.action : "";
    return !READ_ACTIONS[name]?.has(action);
  }

  private isQuiesceRead(action: string): boolean {
    return action === "status" || action === "result" || action === "get" || action === "logs";
  }

  get isReady(): boolean { return this.phase === "running"; }
  get isQuiescing(): boolean { return this.phase === "quiescing"; }
  get canAcceptNewSessions(): boolean { return this.phase === "running"; }
  get inFlightRequestCount(): number { return this.activeRequests; }

  /** Fence new work immediately, then wait only until the caller's absolute deadline. */
  async beginQuiesce(deadlineAt: number): Promise<boolean> {
    if (this.phase === "closed") return true;
    this.phase = "quiescing";
    this.observer.observe({ category: "lifecycle", event: "quiesce", outcome: "started" });
    if (this.activeRequests === 0) {
      this.observer.observe({ category: "lifecycle", event: "drain", outcome: "completed" });
      return true;
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      this.observer.observe({ category: "lifecycle", event: "drain", outcome: "timeout" });
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drainWaiters.delete(onDrain);
        this.observer.observe({ category: "lifecycle", event: "drain", outcome: drained ? "completed" : "timeout" });
        resolve(drained);
      };
      const onDrain = (): void => finish(true);
      const timer = setTimeout(() => finish(false), remaining);
      this.drainWaiters.add(onDrain);
    });
  }

  async close(): Promise<void> {
    if (this.phase === "closed") return;
    this.phase = "closed";
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
    await Promise.allSettled([this.job.shutdown(), this.teammate.shutdown()]);
  }
}

export const createGatewayRuntime = (options?: GatewayRuntimeOptions): Promise<GatewayRuntime> => GatewayRuntime.create(options);
