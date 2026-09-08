/** Governed typed Gateway facade over the external Maestro CLI. */
import { createHash, randomUUID } from "node:crypto";
import type { GatewayMaestroCliSecurityConfig } from "../config.ts";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import type { GatewayMaestroCliRequest, GatewayMaestroReceiptV1 } from "../maestro-cli-contracts.ts";
import {
  GatewayMaestroReceiptConflictError,
  GatewayMaestroReceiptStore,
} from "../maestro-cli-receipt-store.ts";
import type { GatewayPolicy } from "../policy.ts";
import { principalKey } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { workspaceIdForPath } from "../state-paths.ts";
import {
  KnowledgeCliAdapter,
  type KnowledgeLoadResult,
  type KnowledgeSearchResult,
} from "../../knowledge/cli-adapter.ts";
import { defaultRunner, type RunCliRunner } from "../../session/cli-adapter.ts";

export interface GatewayMaestroHandoffReader {
  search(principal: GatewayPrincipal, input: { workspaceId: string; query: string; limit: number }): Promise<unknown[]>;
  load(principal: GatewayPrincipal, input: { workspaceId: string; id: string }): Promise<unknown>;
}

export interface GatewayMaestroStageBinding {
  workflowSessionId?: string;
  runId?: string;
  /** Host-owned knowledge-execution-authority/1.0 descriptor. */
  executionAuthorityFile: string;
}

export interface GatewayMaestroCliServiceOptions {
  policy: GatewayPolicy;
  security: GatewayMaestroCliSecurityConfig;
  receipts: GatewayMaestroReceiptStore;
  runner?: RunCliRunner;
  handoffs?: GatewayMaestroHandoffReader;
  maxOutputBytes?: number;
  timeoutMs?: number;
  /** Optional host-controlled sanitized CLI environment. */
  environment?: NodeJS.ProcessEnv;
  /** Host-controlled validation boundary for external Maestro workflow identity. */
  resolveStageBinding?: (input: { workspacePath: string; workflowSessionId?: string; runId?: string }) => Promise<GatewayMaestroStageBinding | undefined>;
}

type SearchRequest = Extract<GatewayMaestroCliRequest, { action: "search" }>;
type LoadRequest = Extract<GatewayMaestroCliRequest, { action: "load" }>;
type StageRequest = Extract<GatewayMaestroCliRequest, { action: "stage" }>;

export class GatewayMaestroCliService {
  private readonly versionChecks = new Map<string, Promise<void>>();

  constructor(private readonly options: GatewayMaestroCliServiceOptions) {}

  async handle(principal: GatewayPrincipal, request: GatewayMaestroCliRequest, signal?: AbortSignal): Promise<GatewayResult<unknown>> {
    const resultOptions = { requestId: request.requestId ?? randomUUID(), principalId: principalKey(principal) };
    try {
      if (!this.options.security.enabled) throw new MaestroCliServiceError("maestro_cli is disabled", "maestro_cli_disabled");
      const workspacePath = await this.options.policy.assertWorkspace(principal, request.workspaceId);
      const canonicalWorkspaceId = workspaceIdForPath(workspacePath);
      if (canonicalWorkspaceId !== request.workspaceId) throw new MaestroCliServiceError("workspace identity mismatch", "not_found");
      switch (request.action) {
        case "search": {
          this.requirePermission(this.options.security.allowSearch, "search");
          if ((request.source ?? "knowledge") !== "handoff") await this.ensureSupported(workspacePath, signal);
          const adapter = new KnowledgeCliAdapter(workspacePath, this.boundRunner());
          return gatewayOk(await this.search(principal, adapter, request, signal), resultOptions);
        }
        case "load": {
          this.requirePermission(this.options.security.allowLoad, "load");
          if ((request.source ?? "knowledge") !== "handoff") await this.ensureSupported(workspacePath, signal);
          const adapter = new KnowledgeCliAdapter(workspacePath, this.boundRunner());
          return gatewayOk(await this.load(principal, adapter, request, signal), resultOptions);
        }
        case "stage": {
          this.requirePermission(this.options.security.allowStage, "stage");
          await this.ensureSupported(workspacePath, signal);
          const adapter = new KnowledgeCliAdapter(workspacePath, this.boundRunner());
          return gatewayOk(await this.stage(adapter, workspacePath, request, signal), resultOptions);
        }
      }
    } catch (error) {
      const code = error instanceof MaestroCliServiceError
        ? error.code
        : error instanceof GatewayMaestroReceiptConflictError
          ? "operation_conflict"
          : "maestro_cli_failed";
      return gatewayError({ code, message: boundedError(error), retryable: code === "maestro_cli_uncertain" }, resultOptions);
    }
  }

  private async search(
    principal: GatewayPrincipal,
    adapter: KnowledgeCliAdapter,
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<{ source: string; knowledge?: KnowledgeSearchResult; handoffs?: unknown[] }> {
    const source = request.source ?? "knowledge";
    const limit = request.limit ?? 20;
    const response: { source: string; knowledge?: KnowledgeSearchResult; handoffs?: unknown[] } = { source };
    if (source === "knowledge" || source === "all") {
      response.knowledge = await adapter.search(request.query, { kind: request.kind, limit, signal });
    }
    if (source === "handoff" || source === "all") {
      if (!this.options.handoffs) throw new MaestroCliServiceError("handoff search provider is unavailable", "unsupported_source");
      response.handoffs = await this.options.handoffs.search(principal, { workspaceId: request.workspaceId, query: request.query, limit });
    }
    return response;
  }

  private async load(
    principal: GatewayPrincipal,
    adapter: KnowledgeCliAdapter,
    request: LoadRequest,
    signal?: AbortSignal,
  ): Promise<KnowledgeLoadResult | unknown> {
    const source = request.source ?? "knowledge";
    if (source === "handoff") {
      if (!this.options.handoffs) throw new MaestroCliServiceError("handoff load provider is unavailable", "unsupported_source");
      return this.options.handoffs.load(principal, { workspaceId: request.workspaceId, id: request.id });
    }
    if (!request.kind) throw new MaestroCliServiceError("kind is required when loading knowledge", "invalid_arguments");
    return adapter.load(request.kind, request.id, { signal });
  }

  private async stage(adapter: KnowledgeCliAdapter, workspacePath: string, request: StageRequest, signal?: AbortSignal): Promise<{ receipt: GatewayMaestroReceiptV1 }> {
    if (!request.workflowSessionId && !request.runId) {
      throw new MaestroCliServiceError("stage requires an explicit workflowSessionId or runId", "workflow_identity_required");
    }
    if (!request.evidence?.length) {
      throw new MaestroCliServiceError("stage requires explicit evidence", "invalid_arguments");
    }
    if (!this.options.resolveStageBinding) {
      throw new MaestroCliServiceError("no host-controlled Maestro workflow identity resolver is configured", "workflow_identity_unavailable");
    }
    const binding = await this.options.resolveStageBinding({
      workspacePath,
      workflowSessionId: request.workflowSessionId,
      runId: request.runId,
    });
    if (!binding || (!binding.workflowSessionId && !binding.runId) || !binding.executionAuthorityFile.trim()) {
      throw new MaestroCliServiceError("Maestro workflow identity could not be validated", "workflow_identity_denied");
    }
    const payloadHash = hashStage({ ...request, workflowSessionId: binding.workflowSessionId, runId: binding.runId });
    return this.options.receipts.serialized(request.workspaceId, request.operationId, async () => {
      const existing = await this.options.receipts.get(request.workspaceId, request.operationId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new GatewayMaestroReceiptConflictError("operationId is already bound to a different stage payload");
        if (existing.state === "committed") return { receipt: existing };
        if (existing.state === "failed") throw new MaestroCliServiceError(existing.error ?? "previous stage attempt failed", "maestro_cli_failed");
        if (existing.state === "pending") {
          await this.options.receipts.settle(existing, "uncertain", { error: "stage process ended before its receipt was settled" });
        }
        throw new MaestroCliServiceError("stage outcome is uncertain and requires operator reconciliation", "maestro_cli_uncertain");
      }
      const claimed = await this.options.receipts.createPending({
        operationId: request.operationId,
        workspaceId: request.workspaceId,
        payloadHash,
      });
      const receipt = claimed.receipt;
      if (!claimed.created) {
        if (receipt.state === "committed") return { receipt };
        throw new MaestroCliServiceError("stage outcome is pending or uncertain and requires operator reconciliation", "maestro_cli_uncertain");
      }
      try {
        const staged = await adapter.stage({
          target: request.kind,
          title: request.title,
          content: request.content,
          sessionId: binding.workflowSessionId,
          runId: binding.runId,
          evidence: request.evidence,
          executionAuthorityFile: binding.executionAuthorityFile,
        }, { signal });
        const committed = await this.options.receipts.settle(receipt, "committed", { recordId: staged.candidate_id });
        return { receipt: committed };
      } catch (error) {
        const uncertain = await this.options.receipts.settle(receipt, "uncertain", { error: boundedError(error) });
        throw new MaestroCliServiceError(
          `stage outcome is uncertain and will not be retried automatically (operation ${uncertain.operationId})`,
          "maestro_cli_uncertain",
        );
      }
    });
  }

  private requirePermission(allowed: boolean, action: string): void {
    if (!allowed) throw new MaestroCliServiceError(`maestro_cli ${action} is not permitted`, "maestro_cli_denied");
  }

  private boundRunner(): RunCliRunner {
    if (this.options.runner) return this.options.runner;
    return (args, cwd, invocation = {}) => defaultRunner(args, cwd, {
      signal: invocation.signal,
      timeoutMs: this.options.timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes,
      executable: this.options.security.executable,
      environment: this.options.environment ?? gatewayCliEnvironment(process.env),
    });
  }

  private async ensureSupported(workspacePath: string, signal?: AbortSignal): Promise<void> {
    let check = this.versionChecks.get(workspacePath);
    if (!check) {
      check = (async () => {
        const result = await this.boundRunner()(["--version"], workspacePath, { signal });
        if (result.exitCode !== 0) throw new MaestroCliServiceError("Maestro CLI capability probe failed", "unsupported_cli");
        const version = extractVersion(result.stdout || result.stderr);
        if (!version) throw new MaestroCliServiceError("Maestro CLI returned no parseable version", "unsupported_cli");
        const minimum = this.options.security.minimumVersion;
        if (minimum && compareVersions(version, minimum) < 0) {
          throw new MaestroCliServiceError(`Maestro CLI ${version} is older than required ${minimum}`, "unsupported_cli");
        }
      })();
      this.versionChecks.set(workspacePath, check);
      check.catch(() => this.versionChecks.delete(workspacePath));
    }
    await check;
  }
}

class MaestroCliServiceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MaestroCliServiceError";
  }
}

function hashStage(request: StageRequest): string {
  const canonical = {
    workspaceId: request.workspaceId,
    kind: request.kind,
    title: request.title,
    content: request.content,
    workflowSessionId: request.workflowSessionId ?? null,
    runId: request.runId ?? null,
    evidence: [...(request.evidence ?? [])],
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function extractVersion(value: string): string | undefined {
  return value.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u)?.[1];
}

function compareVersions(left: string, right: string): number {
  const a = left.split(/[+-]/u, 1)[0]!.split(".").map(Number);
  const b = right.split(/[+-]/u, 1)[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function gatewayCliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "MAESTRO_PI_PACKAGE_ROOT",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (source[key] !== undefined) environment[key] = source[key];
  // Deliberately do not inherit MAESTRO_EXECUTION_AUTHORITY_FILE or arbitrary
  // caller variables; mutation authority comes from the host binding resolver.
  return environment;
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return Buffer.byteLength(text, "utf8") <= 16 * 1024 ? text : `${text.slice(0, 16 * 1024)}…`;
}
