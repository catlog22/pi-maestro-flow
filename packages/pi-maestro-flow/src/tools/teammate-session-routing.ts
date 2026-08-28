import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine } from "../quiet-render.ts";
import {
  TEAMMATE_TASK_TYPES,
  loadModelRoutingConfig,
  refreshModelRegistry,
  saveSessionModelRoutingOverrides,
  type ModelRoutingRules,
  type TeammateThinkingLevel,
} from "pi-maestro-teammate/v1/model-routing";

// TeammateTaskType is a runtime string union exported alongside
// TEAMMATE_TASK_TYPES; the v1 barrel re-exports both. Fall back to the literal
// set so a missing named export never breaks the tool at module load.
const TASK_TYPES: readonly string[] = (TEAMMATE_TASK_TYPES as readonly string[] | undefined) ?? [
  "explore",
  "analysis",
  "debug",
  "planning",
  "development",
  "review",
  "testing",
];

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isKnownTaskType(value: string): boolean {
  return TASK_TYPES.includes(value);
}

export const TeammateSessionRoutingParams = Type.Object({
  mappings: Type.Optional(Type.Record(
    Type.String({ description: "taskType: explore | analysis | debug | planning | development | review | testing" }),
    Type.Union([
      Type.String({ description: "canonical teammate model registration id (e.g. maestro-openai/gpt-5.6-sol)" }),
      Type.Null({ description: "clear the session override for this taskType, falling back to project/global config" }),
    ]),
    { description: "taskType → model overrides for this session. null clears one entry." },
  )),
  fallbackModels: Type.Optional(Type.Record(
    Type.String({ description: "taskType" }),
    Type.Union([
      Type.Array(Type.String(), { description: "ordered fallback model ids tried after the primary fails" }),
      Type.Null({ description: "clear the session fallback override for this taskType" }),
    ]),
    { description: "taskType → fallback model chain for this session" },
  )),
  thinkingLevels: Type.Optional(Type.Record(
    Type.String({ description: "taskType" }),
    Type.Union([
      Type.String({ description: "off | minimal | low | medium | high | xhigh | max" }),
      Type.Null({ description: "clear the session thinking override for this taskType" }),
    ]),
    { description: "taskType → thinking depth for this session" },
  )),
  clear: Type.Optional(Type.Boolean({
    description: "When true, drop ALL session overrides for this session (ignore mappings/fallbackModels/thinkingLevels). Use to reset before reconfiguring or at session end.",
  })),
});

export interface TeammateSessionRoutingDetails {
  session_id: string;
  file: string;
  cleared: boolean;
  effective: Array<{
    taskType: string;
    model: string | null;
    fallbacks: string[];
    thinking: string;
  }>;
  warnings: string[];
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  const sessionId = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function normalizeRulesInput(
  params: TeammateSessionRoutingInput,
  warnings: string[],
): ModelRoutingRules {
  const mappings: Record<string, string | null> = {};
  const fallbackMappings: Record<string, string[] | null> = {};
  const thinkingLevels: Record<string, TeammateThinkingLevel | null> = {};

  for (const [taskType, model] of Object.entries(params.mappings ?? {})) {
    if (!isKnownTaskType(taskType)) {
      warnings.push(`Unknown taskType "${taskType}" in mappings; skipped. Known: ${TASK_TYPES.join(", ")}`);
      continue;
    }
    if (model === null) mappings[taskType] = null;
    else if (typeof model === "string" && model.trim()) mappings[taskType] = model.trim();
  }

  for (const [taskType, models] of Object.entries(params.fallbackModels ?? {})) {
    if (!isKnownTaskType(taskType)) {
      warnings.push(`Unknown taskType "${taskType}" in fallbackModels; skipped.`);
      continue;
    }
    if (models === null) fallbackMappings[taskType] = null;
    else if (Array.isArray(models)) {
      const cleaned = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
      fallbackMappings[taskType] = cleaned;
    }
  }

  for (const [taskType, thinking] of Object.entries(params.thinkingLevels ?? {})) {
    if (!isKnownTaskType(taskType)) {
      warnings.push(`Unknown taskType "${taskType}" in thinkingLevels; skipped.`);
      continue;
    }
    if (thinking === null) {
      thinkingLevels[taskType] = null;
    } else if (typeof thinking === "string") {
      const normalized = thinking.trim().toLowerCase();
      if (VALID_THINKING.has(normalized)) thinkingLevels[taskType] = normalized as TeammateThinkingLevel;
      else warnings.push(`Invalid thinking "${thinking}" for ${taskType}; skipped. Valid: ${[...VALID_THINKING].join(", ")}`);
    }
  }

  return {
    mappings,
    ...(Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels,
  };
}

interface TeammateSessionRoutingInput {
  mappings?: Record<string, string | null> | null;
  fallbackModels?: Record<string, string[] | null> | null;
  thinkingLevels?: Record<string, string | null> | null;
  clear?: boolean;
}

function renderEffective(rules: ModelRoutingRules): TeammateSessionRoutingDetails["effective"] {
  const taskTypes = new Set<string>([
    ...Object.keys(rules.mappings ?? {}),
    ...Object.keys(rules.fallbackMappings ?? {}),
    ...Object.keys(rules.thinkingLevels ?? {}),
  ]);
  return [...taskTypes].sort().map((taskType) => ({
    taskType,
    model: rules.mappings?.[taskType] ?? null,
    fallbacks: rules.fallbackMappings?.[taskType] ?? [],
    thinking: rules.thinkingLevels?.[taskType] ?? "inherit",
  }));
}

export function createTeammateSessionRoutingTool(): ToolDefinition<
  typeof TeammateSessionRoutingParams,
  TeammateSessionRoutingDetails
> {
  return {
    name: "teammate-session-routing",
    label: "Teammate Session Routing",
    description: `Set temporary, session-scoped teammate model routing overrides that take effect on the next teammate dispatch in THIS session only. Bind to the current Pi session id automatically.

Use this when the user asks (in natural language) to change which model a task type uses for the rest of this conversation — e.g. "use gpt-5.6-sol for analysis this session", "bump explore thinking to high here". The host model (you) parses the intent and calls this tool; no manual JSON editing.

Parameters (all optional, at least one of mappings/fallbackModels/thinkingLevels/clear required):
- mappings: { taskType: "model-id" | null } — primary model per taskType; null clears one entry.
- fallbackModels: { taskType: ["id1","id2"] | null } — ordered fallback chain per taskType.
- thinkingLevels: { taskType: "off|minimal|low|medium|high|xhigh|max" | null } — thinking depth per taskType.
- clear: true — drop ALL session overrides for this session (ignores the other fields).

Known taskTypes: ${TASK_TYPES.join(", ")}.

Overrides stack on top of project (.pi/teammate-models.json) and global (~/.pi/agent/teammate-models.json) config, at the task-type mapping layer. They do NOT persist beyond this Pi session and do NOT affect other sessions or projects. A corrupted session file is ignored at read time. Verify a model id with model-availability before mapping it here.`,
    promptSnippet: "Set session-scoped teammate model routing overrides (taskType → model/thinking/fallbacks) that take effect on the next dispatch in this session only.",
    parameters: TeammateSessionRoutingParams,
    async execute(_id, params, _signal, onUpdate, ctx): Promise<AgentToolResult<TeammateSessionRoutingDetails>> {
      const warnings: string[] = [];
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) {
        throw new Error("No active Pi session id; session-scoped routing requires a live session.");
      }

      const cwd = (ctx.cwd && ctx.cwd.length > 0) ? ctx.cwd : process.cwd();

      if (params.clear === true) {
        // Clear = write empty rules, which removes the session file's effect.
        // Reusing saveSessionModelRoutingOverrides with empty rules keeps the
        // atomic write/lock protocol and leaves a clean (empty) session store.
        saveSessionModelRoutingOverrides(cwd, sessionId, { mappings: {}, thinkingLevels: {} });
        await refreshModelRegistry(ctx);
        const config = loadModelRoutingConfig(cwd, undefined, sessionId);
        const file = `.pi/teammate-models.session.${sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)}.json`;
        return {
          content: [{
            type: "text",
            text: `Cleared all session routing overrides for session ${sessionId}.\nEffective routing now falls back to project/global config.`,
          }],
          details: {
            session_id: sessionId,
            file,
            cleared: true,
            effective: renderEffective(config),
            warnings,
          },
        };
      }

      const hasInput = params.mappings || params.fallbackModels || params.thinkingLevels;
      if (!hasInput) {
        throw new Error("No overrides provided. Pass mappings, fallbackModels, thinkingLevels, or clear=true.");
      }

      const rules = normalizeRulesInput(params as TeammateSessionRoutingInput, warnings);
      const hasAnyRule = Object.keys(rules.mappings).length > 0
        || Object.keys(rules.fallbackMappings ?? {}).length > 0
        || Object.keys(rules.thinkingLevels).length > 0;
      if (!hasAnyRule) {
        throw new Error(`No valid overrides after normalization. ${warnings.join("; ") || "Check taskType names."}`);
      }

      const before = loadModelRoutingConfig(cwd, undefined, sessionId);
      saveSessionModelRoutingOverrides(cwd, sessionId, rules);
      await refreshModelRegistry(ctx);
      const after = loadModelRoutingConfig(cwd, undefined, sessionId);

      const changed: string[] = [];
      for (const taskType of Object.keys({ ...rules.mappings, ...rules.thinkingLevels, ...(rules.fallbackMappings ?? {}) })) {
        const beforeModel = before.mappings?.[taskType];
        const afterModel = after.mappings?.[taskType];
        const beforeThink = before.thinkingLevels?.[taskType];
        const afterThink = after.thinkingLevels?.[taskType];
        if (beforeModel !== afterModel || beforeThink !== afterThink) changed.push(taskType);
      }

      const file = `.pi/teammate-models.session.${sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)}.json`;
      const summary = changed.length > 0
        ? `Updated session routing for ${changed.length} taskType(s): ${changed.join(", ")}.`
        : "Session routing written (no effective change — value may equal existing config).";

      const details: TeammateSessionRoutingDetails = {
        session_id: sessionId,
        file,
        cleared: false,
        effective: renderEffective(after),
        warnings,
      };

      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `${summary}\nSession: ${sessionId}\nFile: ${file}` }],
          details,
        } as AgentToolResult<TeammateSessionRoutingDetails>);
      }

      return {
        content: [{
          type: "text",
          text: `${summary}\nSession: ${sessionId}\nFile: ${file}\n\nEffective routing (with session overrides applied):\n${renderEffective(after).map((e) => `- ${e.taskType}: model=${e.model ?? "auto/inherit"}, thinking=${e.thinking}, fallbacks=${e.fallbacks.join(",") || "none"}`).join("\n")}${warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""}`,
        }],
        details,
      };
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const parts: string[] = [];
      if (args.clear) parts.push("clear");
      if (args.mappings) parts.push(`${Object.keys(args.mappings).length} mapping(s)`);
      if (args.fallbackModels) parts.push(`${Object.keys(args.fallbackModels).length} fallback(s)`);
      if (args.thinkingLevels) parts.push(`${Object.keys(args.thinkingLevels).length} thinking`);
      return toolCallLine(theme, "teammate-session-routing", parts.join(", ") || "read");
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as TeammateSessionRoutingDetails | undefined;
      const count = details?.effective?.length ?? 0;
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "";
      return toolResultLine(theme, {
        name: "teammate-session-routing",
        ok: !ctx.isError,
        arg: ctx.args.clear ? "clear" : `${count} type(s)`,
        summary: details?.cleared ? "cleared" : `${count} type(s)`,
        expanded: opts.expanded,
        detail: text,
      });
    },
  };
}

export function registerTeammateSessionRouting(pi: ExtensionAPI): void {
  pi.registerTool(createTeammateSessionRoutingTool());
}
