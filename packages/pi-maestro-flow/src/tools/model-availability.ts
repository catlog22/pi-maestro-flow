import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getEnabledTools, loadCliToolsConfig } from "../providers/cli-tools-loader.ts";

export const ModelAvailabilityParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Optional substring to filter model/tool names" })),
});

interface DelegateToolView {
  name: string;
  primaryModel: string;
  tags: string[];
}

export interface ModelAvailabilityDetails {
  teammate_models: string[];
  delegate_tools: DelegateToolView[];
  delegate_fallback: DelegateToolView[];
  delegate_config_path: string | null;
}

const DELEGATE_USAGE_DOC = "D:\\maestro2\\workflows\\delegate-usage.md";

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
  const tools = getEnabledTools(config).map(({ name, config: toolConfig }) => ({
    name,
    primaryModel: toolConfig.primaryModel ?? "",
    tags: toolConfig.tags ?? [],
  }));
  return { tools, path: "~/.maestro/cli-tools.json" };
}

// A delegate tool is directly covered by a teammate model when some teammate
// id is namespaced under the tool name or matches its primaryModel. Anything
// else is only reachable through `maestro delegate --to <name>`.
function computeFallback(teammateModels: string[], delegateTools: DelegateToolView[]): DelegateToolView[] {
  const lowerModels = teammateModels.map((model) => model.toLowerCase());
  return delegateTools.filter((tool) => {
    const prefix = `${tool.name.toLowerCase()}/`;
    const primary = tool.primaryModel.toLowerCase();
    return !lowerModels.some(
      (model) => model.startsWith(prefix) || (primary !== "" && model.includes(primary)),
    );
  });
}

function matchesFilter(value: string, filter: string): boolean {
  return value.toLowerCase().includes(filter.toLowerCase());
}

export function createModelAvailabilityTool(): ToolDefinition<typeof ModelAvailabilityParams, ModelAvailabilityDetails> {
  return {
    name: "model-availability",
    label: "Model Availability",
    description: `Check which models are reachable for delegated work, across two sources:

- **teammate_models**: pi's own authenticated models (the same set shown in <available_teammate_models>), selectable via the teammate tool's model field.
- **delegate_tools**: CLI tools enabled in the Maestro delegate config (~/.maestro/cli-tools.json), reachable via the bash CLI \`maestro delegate "<PROMPT>" --to <tool>\`.
- **delegate_fallback**: enabled delegate tools that are NOT directly available as teammate models — route these through \`maestro delegate --to <name>\`.

When to use:
- A user explicitly requests a specific external model (codex, gemini, claude, opencode) — call this first to see whether it is a teammate model or a delegate-only fallback.
- Before routing work to an external CLI endpoint, to confirm the tool is enabled.

When NOT to use:
- For ordinary delegation where any capable model suffices — use the teammate tool directly.

Pitfall: the \`--to <tool>\` flag is mandatory to target a delegate tool. A bare \`maestro delegate codex\` treats "codex" as the prompt and falls back to the first enabled tool. Full contract: ${DELEGATE_USAGE_DOC}.`,
    promptSnippet: "Check reachable teammate models + Maestro delegate CLI tools before routing to a specific external model (codex/gemini/claude).",
    promptGuidelines: [
      "When a user explicitly requests an external model (codex, gemini, claude, opencode) that is NOT in <available_teammate_models>, call model-availability to confirm it is enabled, then route via bash: maestro delegate \"<PROMPT>\" --to <tool> --mode analysis.",
      "The --to flag is mandatory. A bare `maestro delegate codex` sends \"codex\" as the prompt to the first enabled tool. See D:\\maestro2\\workflows\\delegate-usage.md.",
    ],
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
      const teammateModels = listTeammateModels(ctx);
      steps.push(`Found ${teammateModels.length} authenticated teammate model(s).`);
      emit({ teammate_models: teammateModels });
      if (signal?.aborted) throw new Error("Tool execution aborted.");

      steps.push("Reading Maestro delegate config (~/.maestro/cli-tools.json)…");
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
        ? delegateTools.filter((tool) => matchesFilter(tool.name, filter) || matchesFilter(tool.primaryModel, filter))
        : delegateTools;
      const filteredFallback = filter
        ? fallback.filter((tool) => matchesFilter(tool.name, filter) || matchesFilter(tool.primaryModel, filter))
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            teammate_models: filteredTeammate,
            delegate_tools: filteredDelegate,
            delegate_fallback: filteredFallback,
            delegate_config_path: configPath,
            hint: `${fallbackHint} The --to flag is mandatory; a bare \`maestro delegate codex\` treats "codex" as the prompt. Contract: ${DELEGATE_USAGE_DOC}.`,
          }, null, 2),
        }],
        details,
      } as AgentToolResult<ModelAvailabilityDetails>;
    },
    renderCall(args, theme) {
      const filter = args.filter ? ` ${theme.fg("accent", `"${String(args.filter)}"`)}` : "";
      return singleLine(`${theme.fg("toolTitle", theme.bold("model-availability"))}${filter}`);
    },
    renderResult(result, _opts, theme) {
      const details = result.details as ModelAvailabilityDetails | undefined;
      const tm = details?.teammate_models?.length ?? 0;
      const dt = details?.delegate_tools?.length ?? 0;
      const fb = details?.delegate_fallback?.length ?? 0;
      const fallbackNote = fb > 0 ? theme.fg("accent", ` · ${fb} delegate-only`) : "";
      return singleLine(`${theme.fg("success", "✓")} ${theme.fg("muted", `${tm} teammate models · ${dt} delegate tools`)}${fallbackNote}`);
    },
  };
}

function renderProgress(steps: string[], details: Partial<ModelAvailabilityDetails>): string {
  const lines: string[] = steps.map((step, index) => `${index + 1}. ${step}`);
  if (details.teammate_models?.length) {
    lines.push(`   teammate_models: ${details.teammate_models.join(", ")}`);
  }
  if (details.delegate_tools?.length) {
    lines.push(`   delegate_tools: ${details.delegate_tools.map((tool) => `${tool.name}${tool.primaryModel ? ` (${tool.primaryModel})` : ""}`).join(", ")}`);
  }
  if (details.delegate_fallback?.length) {
    lines.push(`   delegate_fallback: ${details.delegate_fallback.map((tool) => tool.name).join(", ")}`);
  }
  return lines.join("\n");
}

export function registerModelAvailability(pi: ExtensionAPI): void {
  pi.registerTool(createModelAvailabilityTool());
}
