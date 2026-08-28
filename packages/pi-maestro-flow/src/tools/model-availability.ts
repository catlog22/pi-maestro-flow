import { randomUUID } from "node:crypto";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getEnabledTools,
  loadCliToolsConfig,
  probeCliToolCommand,
  sshHostConfigOf,
} from "../providers/cli-tools-loader.ts";
import { probeSshCliExecutable } from "pi-maestro-teammate/v1/acp-cli";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine } from "../quiet-render.ts";
import {
  modelRegistrationAvailabilityDiagnostics,
  refreshModelRegistry,
  type ModelRegistrationAvailabilityDiagnostic,
} from "pi-maestro-teammate/v1/model-routing";
import { modelRegistryPairSync } from "pi-maestro-teammate/v1/backends";
import { sharedModelHealthCoordinator } from "pi-maestro-teammate/v1/retry";
import {
  TEAMMATE_MODEL_SESSION_EVENT,
  TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION,
  TEAMMATE_MODEL_SESSION_QUERY_EVENT,
  type TeammateModelSessionEventV1,
} from "pi-maestro-teammate/v1/events";

export const ModelAvailabilityParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Optional substring to filter model/tool names" })),
});

interface DelegateToolView {
  name: string;
  /** local: spawned on this machine; ssh: exec'd on the configured host. */
  mode: "local" | "ssh";
  /** ssh mode host; empty for local tools. */
  host: string;
  /** Backend reachability (probe). */
  status: "ok" | "missing";
  command: string;
}

export interface ModelRegistryAvailabilityView {
  mode: "model-registry";
  version: 2;
  revision: number;
  default_model: string;
  registrations: ModelRegistrationAvailabilityDiagnostic[];
}

export interface ModelAvailabilityDetails {
  teammate_models: string[];
  delegate_tools: DelegateToolView[];
  delegate_fallback: DelegateToolView[];
  delegate_config_path: string | null;
  /** Additive v2 diagnostics; null preserves the old-mode result shape. */
  model_registry: ModelRegistryAvailabilityView | null;
}

interface ModelSessionAuthority {
  isChild: boolean;
  hasCurrentRootMonitorAuthority: boolean;
}

export interface ModelAvailabilityToolOptions {
  sessionAuthority?: () => ModelSessionAuthority;
  loadDelegateConfig?: typeof loadCliToolsConfig;
  probeSshExecutable?: typeof probeSshCliExecutable;
}

function modelId(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as { provider?: unknown; id?: unknown };
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!provider || !id) return null;
  return `${provider}/${id}`;
}

function listTeammateModels(ctx: ExtensionContext): string[] {
  const available = ctx.modelRegistry?.getAvailable?.() ?? [];
  const ids = new Set<string>();
  for (const entry of available) {
    const id = modelId(entry);
    if (id) ids.add(id);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function modelRegistryAvailability(
  ctx: ExtensionContext,
  authority: ModelSessionAuthority,
): ModelRegistryAvailabilityView | null {
  const hostModels = ctx.modelRegistry?.getAvailable?.() ?? [];
  const workspaceRoot = typeof ctx.cwd === "string" && ctx.cwd.length > 0
    ? ctx.cwd
    : process.cwd();
  const pair = modelRegistryPairSync(workspaceRoot, { hostModels });
  if (pair === undefined) return null;
  sharedModelHealthCoordinator.reconcileProjection(pair.dispatch);
  return {
    mode: "model-registry",
    version: pair.dispatch.registryVersion,
    revision: pair.discovery.revision,
    default_model: pair.discovery.defaultModel,
    registrations: modelRegistrationAvailabilityDiagnostics(pair.discovery, {
      ...authority,
      health: (route) => ({
        healthy: sharedModelHealthCoordinator.isHealthy(route.modelRegistrationId),
      }),
    }),
  };
}

function availableRegistrationIds(registry: ModelRegistryAvailabilityView): string[] {
  return registry.registrations
    .filter((entry) => entry.registered
      && entry.resolvable
      && entry.sessionAvailable
      && entry.healthy)
    .map((entry) => entry.registrationId)
    .sort((left, right) => left.localeCompare(right));
}

async function listDelegateTools(
  cwd: string,
  options: ModelAvailabilityToolOptions,
): Promise<{ tools: DelegateToolView[]; path: string | null }> {
  const config = (options.loadDelegateConfig ?? loadCliToolsConfig)(cwd);
  if (!config) return { tools: [], path: null };
  const tools = await Promise.all(getEnabledTools(config).map(async ({ name, config: toolConfig }) => {
    const command = toolConfig.command?.trim() || name;
    const mode = toolConfig.mode ?? "local";
    let reachable: boolean;
    if (mode === "ssh") {
      const hostConfig = sshHostConfigOf(toolConfig);
      reachable = hostConfig !== null
        && (await (options.probeSshExecutable ?? probeSshCliExecutable)(hostConfig, command)).ok;
    } else {
      reachable = probeCliToolCommand(name, toolConfig).ok;
    }
    return {
      name,
      mode,
      host: toolConfig.host?.trim() ?? "",
      status: (reachable ? "ok" : "missing") as "ok" | "missing",
      command,
    };
  }));
  return { tools, path: getCliToolsConfigHint() };
}

function getCliToolsConfigHint(): string | null {
  return "~/.pi/agent/teammate-cli-tools.json (+ project .pi/teammate-cli-tools.json)";
}

// A delegate tool is directly covered by a teammate model when the catalog
// exposes `cli/<tool>` for it (reachable local tools or complete ssh configs).
// Anything else is only reachable through `maestro delegate --to <name>`.
function computeFallback(teammateModels: string[], delegateTools: DelegateToolView[]): DelegateToolView[] {
  const cliToolIds = new Set<string>();
  for (const model of teammateModels) {
    if (model.startsWith("cli/")) cliToolIds.add(model.slice("cli/".length));
  }
  return delegateTools.filter((tool) => !cliToolIds.has(tool.name));
}

function matchesFilter(value: string, filter: string): boolean {
  return value.toLowerCase().includes(filter.toLowerCase());
}

export function createModelAvailabilityTool(
  options: ModelAvailabilityToolOptions = {},
): ToolDefinition<typeof ModelAvailabilityParams, ModelAvailabilityDetails> {
  return {
    name: "model-availability",
    label: "Model Availability",
    description: `Check which models are reachable for delegated work, across model registrations and legacy sources:

- **teammate_models**: the session-available model ids selectable through the teammate tool. In model-registry mode these are canonical registration ids that passed all four gates.
- **model_registry**: secret-free registration identity/topology and registered, resolvable, sessionAvailable, healthy, and sanitized unavailableReason diagnostics. Remote routes remain listed outside Monitor with a deterministic session-unavailable reason.
- **delegate_tools**: CLI tools enabled in teammate-cli-tools.json (~/.pi/agent + the active project .pi). Local status is checked on PATH; SSH status is reported as reachable only after the remote executable probe completes. The legacy projection can expose these as cli/<tool>; model-registry mode requires an exact ACP deployment route plus compatibility.teammateCliToolsProjection.enabled.
- **delegate_fallback**: enabled delegate tools NOT available as teammate models.

Call this before routing to a specific external model (codex, gemini, claude, opencode) to confirm availability. For ordinary delegation, use the teammate tool directly.

Pitfall: the \`--to <tool>\` flag is mandatory. A bare \`maestro delegate codex\` treats "codex" as the prompt and falls back to the first enabled tool.`,
    promptSnippet: "Check reachable teammate models + Maestro delegate CLI tools before routing to a specific external model (codex/gemini/claude).",
    parameters: ModelAvailabilityParams,
    async execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<ModelAvailabilityDetails>> {
      const filter = (params.filter ?? "").trim();
      const steps: string[] = [];
      const emit = (details: Partial<ModelAvailabilityDetails>): void => {
        if (!onUpdate) return;
        onUpdate({
          content: [{ type: "text", text: renderProgress(steps, details) }],
          details: {
            teammate_models: details.teammate_models ?? [],
            delegate_tools: details.delegate_tools ?? [],
            delegate_fallback: details.delegate_fallback ?? [],
            delegate_config_path: details.delegate_config_path ?? null,
            model_registry: details.model_registry ?? null,
          },
        } as AgentToolResult<ModelAvailabilityDetails>);
      };

      steps.push("Enumerating pi teammate models (modelRegistry.getAvailable)…");
      emit({});
      await refreshModelRegistry(ctx);
      const authority = options.sessionAuthority?.() ?? {
        isChild: process.env.PI_TEAMMATE_CHILD === "1",
        hasCurrentRootMonitorAuthority: false,
      };
      const modelRegistry = modelRegistryAvailability(ctx, authority);
      const teammateModels = modelRegistry === null
        ? listTeammateModels(ctx)
        : availableRegistrationIds(modelRegistry);
      steps.push(modelRegistry === null
        ? `Found ${teammateModels.length} authenticated teammate model(s).`
        : `Found ${modelRegistry.registrations.length} registered model route(s); ${teammateModels.length} pass all availability gates.`);
      emit({ teammate_models: teammateModels, model_registry: modelRegistry });
      if (signal?.aborted) throw new Error("Tool execution aborted.");

      steps.push("Reading teammate CLI tool config (teammate-cli-tools.json)…");
      emit({ teammate_models: teammateModels, model_registry: modelRegistry });
      const { tools: delegateTools, path: configPath } = await listDelegateTools(ctx.cwd, options);
      steps.push(configPath
        ? `Enabled delegate tools: ${delegateTools.map((tool) => tool.name).join(", ") || "(none)"}.`
        : "Delegate config not found — no Maestro delegate tools available.");
      emit({
        teammate_models: teammateModels,
        delegate_tools: delegateTools,
        delegate_config_path: configPath,
        model_registry: modelRegistry,
      });
      if (signal?.aborted) throw new Error("Tool execution aborted.");

      steps.push("Computing delegate-only fallback (tools not reachable as teammate models)…");
      const fallback = computeFallback(teammateModels, delegateTools);
      steps.push(fallback.length > 0
        ? `Delegate-only fallback: ${fallback.map((tool) => tool.name).join(", ")} — route via \`maestro delegate --to <name>\`.`
        : "All enabled delegate tools are covered by teammate models.");
      emit({
        teammate_models: teammateModels,
        delegate_tools: delegateTools,
        delegate_fallback: fallback,
        delegate_config_path: configPath,
        model_registry: modelRegistry,
      });

      const filteredTeammate = filter
        ? teammateModels.filter((model) => matchesFilter(model, filter))
        : teammateModels;
      const filteredDelegate = filter
        ? delegateTools.filter((tool) => matchesFilter(tool.name, filter) || matchesFilter(tool.command, filter))
        : delegateTools;
      const filteredFallback = filter
        ? fallback.filter((tool) => matchesFilter(tool.name, filter) || matchesFilter(tool.command, filter))
        : fallback;
      const filteredModelRegistry = modelRegistry === null || !filter
        ? modelRegistry
        : {
            ...modelRegistry,
            registrations: modelRegistry.registrations.filter((entry) =>
              matchesFilter(entry.registrationId, filter)
              || matchesFilter(entry.modelId, filter)
              || matchesFilter(entry.deploymentId, filter)
              || matchesFilter(entry.harness, filter)
              || matchesFilter(entry.transport, filter)),
          };

      const details: ModelAvailabilityDetails = {
        teammate_models: filteredTeammate,
        delegate_tools: filteredDelegate,
        delegate_fallback: filteredFallback,
        delegate_config_path: configPath,
        model_registry: filteredModelRegistry,
      };

      const fallbackHint = fallback.length > 0
        ? `Delegate-only (route via \`maestro delegate --to <name>\`): ${fallback.map((tool) => tool.name).join(", ")}.`
        : "All enabled delegate tools are covered by teammate models.";
      const cliTools = delegateTools.filter((tool) => tool.status === "ok");
      const cliHint = cliTools.length > 0
        ? `Reachable CLI tools are selectable as teammate models via \`cli/<tool>\` (local spawn / ssh exec over ACP): ${cliTools.map((tool) => `cli/${tool.name}`).join(", ")}.`
        : "No reachable CLI tool backends — \`cli/<tool>\` models are unavailable until the tools are enabled in teammate-cli-tools.json.";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            teammate_models: filteredTeammate,
            delegate_tools: filteredDelegate,
            delegate_fallback: filteredFallback,
            delegate_config_path: configPath,
            model_registry: filteredModelRegistry,
            hint: `${fallbackHint} The --to flag is mandatory; a bare \`maestro delegate codex\` treats "codex" as the prompt. ${cliHint}`,
          }, null, 2),
        }],
        details,
      } as AgentToolResult<ModelAvailabilityDetails>;
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "model-availability", args.filter ? `"${String(args.filter)}"` : "");
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as ModelAvailabilityDetails | undefined;
      const tm = details?.teammate_models?.length ?? 0;
      const dt = details?.delegate_tools?.length ?? 0;
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "";
      return toolResultLine(theme, {
        name: "model-availability",
        ok: true,
        arg: ctx.args.filter ? `"${String(ctx.args.filter)}"` : "",
        summary: `${tm} teammate · ${dt} delegate`,
        expanded: opts.expanded,
        detail: text,
      });
    },
  };
}

function renderProgress(steps: string[], details: Partial<ModelAvailabilityDetails>): string {
  const lines: string[] = steps.map((step, index) => `${index + 1}. ${step}`);
  if (details.teammate_models?.length) {
    lines.push(`   teammate_models: ${details.teammate_models.join(", ")}`);
  }
  if (details.delegate_tools?.length) {
    lines.push(`   delegate_tools: ${details.delegate_tools.map((tool) => `${tool.name} (${tool.mode}${tool.host ? ` ${tool.host}` : ""})${tool.status === "missing" ? " missing" : ""}`).join(", ")}`);
  }
  if (details.delegate_fallback?.length) {
    lines.push(`   delegate_fallback: ${details.delegate_fallback.map((tool) => tool.name).join(", ")}`);
  }
  if (details.model_registry) {
    lines.push(`   model_registry: revision ${details.model_registry.revision} · ${details.model_registry.registrations.length} registration(s)`);
  }
  return lines.join("\n");
}

function queryModelSessionAuthority(pi: ExtensionAPI): ModelSessionAuthority {
  const requestId = randomUUID();
  let response: TeammateModelSessionEventV1 | undefined;
  const disposer = pi.events.on(TEAMMATE_MODEL_SESSION_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const candidate = payload as Partial<TeammateModelSessionEventV1>;
    if (candidate.version !== TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION
      || candidate.requestId !== requestId
      || typeof candidate.isChild !== "boolean"
      || typeof candidate.hasCurrentRootMonitorAuthority !== "boolean") return;
    response = candidate as TeammateModelSessionEventV1;
  });
  pi.events.emit(TEAMMATE_MODEL_SESSION_QUERY_EVENT, {
    version: TEAMMATE_MODEL_SESSION_PROTOCOL_VERSION,
    requestId,
  });
  if (typeof disposer === "function") disposer();
  return response ?? {
    isChild: process.env.PI_TEAMMATE_CHILD === "1",
    hasCurrentRootMonitorAuthority: false,
  };
}

export function registerModelAvailability(
  pi: ExtensionAPI,
  options: ModelAvailabilityToolOptions = {},
): void {
  pi.registerTool(createModelAvailabilityTool({
    ...options,
    sessionAuthority: () => queryModelSessionAuthority(pi),
  }));
}
