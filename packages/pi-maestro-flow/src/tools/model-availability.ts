import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getEnabledTools, loadCliToolsConfig, probeCliToolCommand } from "../providers/cli-tools-loader.ts";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine } from "../quiet-render.ts";
import { refreshModelRegistry } from "pi-maestro-teammate/v1/model-routing";

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

export interface ModelAvailabilityDetails {
  teammate_models: string[];
  delegate_tools: DelegateToolView[];
  delegate_fallback: DelegateToolView[];
  delegate_config_path: string | null;
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

function listDelegateTools(): { tools: DelegateToolView[]; path: string | null } {
  const config = loadCliToolsConfig();
  if (!config) return { tools: [], path: null };
  const tools = getEnabledTools(config).map(({ name, config: toolConfig }) => {
    const command = toolConfig.command?.trim() || name;
    const probe = probeCliToolCommand(name, toolConfig);
    return {
      name,
      mode: toolConfig.mode ?? "local",
      host: toolConfig.host?.trim() ?? "",
      status: (probe.ok ? "ok" : "missing") as "ok" | "missing",
      command,
    };
  });
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

export function createModelAvailabilityTool(): ToolDefinition<typeof ModelAvailabilityParams, ModelAvailabilityDetails> {
  return {
    name: "model-availability",
    label: "Model Availability",
    description: `Check which models are reachable for delegated work, across three sources:

- **teammate_models**: pi's own authenticated models (the same set shown in <available_teammate_models>), selectable via the teammate tool's model field.
- **delegate_tools**: CLI tools enabled in teammate-cli-tools.json (~/.pi/agent + project .pi), reachable as \`cli/<tool>\` teammate models. Each entry reports backend reachability (status ok/missing): local tools are checked via which/where, ssh-mode tools run on the configured remote host. Select \`cli/<tool>\` through the teammate model field (or task-type/role routing); dispatch executes the CLI over the Agent Client Protocol (local spawn, or direct ssh exec for ssh mode).
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
          },
        } as AgentToolResult<ModelAvailabilityDetails>);
      };

      steps.push("Enumerating pi teammate models (modelRegistry.getAvailable)…");
      emit({});
      await refreshModelRegistry(ctx);
      const teammateModels = listTeammateModels(ctx);
      steps.push(`Found ${teammateModels.length} authenticated teammate model(s).`);
      emit({ teammate_models: teammateModels });
      if (signal?.aborted) throw new Error("Tool execution aborted.");

      steps.push("Reading teammate CLI tool config (teammate-cli-tools.json)…");
      emit({ teammate_models: teammateModels });
      const { tools: delegateTools, path: configPath } = listDelegateTools();
      steps.push(configPath
        ? `Enabled delegate tools: ${delegateTools.map((tool) => tool.name).join(", ") || "(none)"}.`
        : "Delegate config not found — no Maestro delegate tools available.");
      emit({ teammate_models: teammateModels, delegate_tools: delegateTools, delegate_config_path: configPath });
      if (signal?.aborted) throw new Error("Tool execution aborted.");

      steps.push("Computing delegate-only fallback (tools not reachable as teammate models)…");
      const fallback = computeFallback(teammateModels, delegateTools);
      steps.push(fallback.length > 0
        ? `Delegate-only fallback: ${fallback.map((tool) => tool.name).join(", ")} — route via \`maestro delegate --to <name>\`.`
        : "All enabled delegate tools are covered by teammate models.");
      emit({ teammate_models: teammateModels, delegate_tools: delegateTools, delegate_fallback: fallback, delegate_config_path: configPath });

      const filteredTeammate = filter
        ? teammateModels.filter((model) => matchesFilter(model, filter))
        : teammateModels;
      const filteredDelegate = filter
        ? delegateTools.filter((tool) => matchesFilter(tool.name, filter) || matchesFilter(tool.command, filter))
        : delegateTools;
      const filteredFallback = filter
        ? fallback.filter((tool) => matchesFilter(tool.name, filter) || matchesFilter(tool.command, filter))
        : fallback;

      const details: ModelAvailabilityDetails = {
        teammate_models: filteredTeammate,
        delegate_tools: filteredDelegate,
        delegate_fallback: filteredFallback,
        delegate_config_path: configPath,
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
  return lines.join("\n");
}

export function registerModelAvailability(pi: ExtensionAPI): void {
  pi.registerTool(createModelAvailabilityTool());
}
