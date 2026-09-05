import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { NewContextController } from "../compaction/new-context.ts";
import { NEW_CONTEXT_MAX_CARRY_FORWARD_BYTES } from "../compaction/new-context.ts";
import { toolCallLine, toolResultCard, type QuietTheme } from "../quiet-render.ts";
import { TODO_MAX_RESOURCE_URIS, TODO_MAX_RESOURCE_URI_BYTES } from "./todo-contract.ts";
import type { FlowToolResult } from "./tool-result.ts";

export const NewContextParams = Type.Object({
  carryForward: Type.Optional(Type.String({
    maxLength: NEW_CONTEXT_MAX_CARRY_FORWARD_BYTES,
    description: "Optional bounded instruction or fact to carry into the deterministic recovery capsule.",
  })),
  resourceUris: Type.Optional(Type.Array(Type.String({
    minLength: 1,
    maxLength: TODO_MAX_RESOURCE_URI_BYTES,
  }), {
    maxItems: TODO_MAX_RESOURCE_URIS,
    description: "Durable references to include in the recovery capsule.",
  })),
}, { additionalProperties: false });

export interface NewContextToolDetails {
  requestId?: number;
  scheduled: boolean;
  coalesced?: boolean;
  error?: string;
}

function result(text: string, details: NewContextToolDetails, isError = false): FlowToolResult {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function inputSummary(params: { carryForward?: string; resourceUris?: string[] }): string {
  const parts = ["schedule"];
  if (params.carryForward?.trim()) parts.push(`${Buffer.byteLength(params.carryForward, "utf8")}B carry-forward`);
  if (params.resourceUris?.length) {
    parts.push(`${params.resourceUris.length} resource${params.resourceUris.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function sanitizeNewContextRenderText(value: string, maximum = 240): string {
  const cleaned = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned.length > maximum ? `${cleaned.slice(0, maximum - 1)}…` : cleaned;
}

function resultText(result: FlowToolResult): string {
  const block = result.content.find((item) => item.type === "text" && "text" in item);
  return block && "text" in block ? sanitizeNewContextRenderText(block.text) : "";
}

function renderNewContextResult(
  toolResult: FlowToolResult,
  expanded: boolean,
  theme: QuietTheme,
  params: { carryForward?: string; resourceUris?: string[] },
) {
  const details = toolResult.details as NewContextToolDetails | undefined;
  const isError = toolResult.isError === true || details?.scheduled === false;
  const requestLabel = details?.requestId === undefined ? "" : `#${details.requestId}`;
  const state = details?.coalesced ? "updated" : "scheduled";
  const capsuleParts = ["recovery capsule"];
  if (params.carryForward?.trim()) {
    capsuleParts.push(`${Buffer.byteLength(params.carryForward, "utf8")}B carry-forward`);
  }
  if (params.resourceUris?.length) {
    capsuleParts.push(`${params.resourceUris.length} resource${params.resourceUris.length === 1 ? "" : "s"}`);
  }

  if (isError) {
    const message = sanitizeNewContextRenderText(
      resultText(toolResult) || details?.error || "Context reset could not be scheduled.",
    );
    return toolResultCard(theme, {
      name: "new context",
      ok: false,
      arg: "schedule",
      summary: "failed",
      groups: [[
        `${theme.fg("error", "! blocked")}      context reset`,
        theme.fg("dim", message),
      ]],
      maxBodyRows: expanded ? undefined : 3,
    });
  }

  const status = details?.coalesced ? "request updated" : "pending";
  const taskRow = `${theme.fg("warning", `○ ${status}`)}${requestLabel ? `      ${theme.fg("accent", requestLabel)}` : ""}  context reset`;
  const timingRow = theme.fg("dim", `  after current turn settles · ${capsuleParts.join(" · ")}`);
  const groups = [[taskRow, timingRow]];
  if (expanded) {
    const message = resultText(toolResult);
    if (message) groups.push([theme.fg("dim", message)]);
  }
  return toolResultCard(theme, {
    name: "new context",
    ok: true,
    arg: "schedule",
    summary: requestLabel ? `${requestLabel} ${state}` : state,
    groups,
  });
}

export function createNewContextTool(
  controller: NewContextController,
  actorId: string,
): ToolDefinition<typeof NewContextParams> {
  return {
    name: "new_context",
    label: "New Context",
    description: `Schedule a deterministic same-session context reset at agent settlement.

This makes no model summarization call. The next context contains a bounded recovery capsule built from authoritative Todo, Goal, Plan, Workflow, checkpoint, and resource state. Automatic compaction is unchanged. Use this primarily at a completed Todo checkpoint: late auto-prune recommends a reset, while critical pressure makes it a priority before the next Todo. Do not interrupt active Todo work merely because pressure rises. Requires compaction.newContext.enabled=true.`,
    promptSnippet: "Schedule a deterministic same-session context reset without model summarization",
    promptGuidelines: [
      "Use New Context as the primary semantic reset at a durable Todo completion checkpoint when the next phase is loosely coupled. Pressure determines urgency, not whether the checkpoint is safe: late auto-prune recommends reset and critical prioritizes it before the next Todo.",
      "During active Todo work, do not interrupt the task merely because pressure rises. Automatic compaction remains the capacity-safety fallback until the next safe Todo checkpoint and whenever it is already pending.",
      "Put live progress and the exact next action in Todo.context before resetting; attach durable references through resourceUris.",
      "A Todo pressure advisory arrives only after its completion-form advance has committed. Inspect the task activated in that same result, then call this standalone tool only if a next phase exists, persisted state is sufficient, and no messages are pending; otherwise continue or settle. Never treat the advisory as a retroactive transition or carry it to an unrelated Todo.",
      "Do not emit or infer pressure-driven reminders without a Todo completion checkpoint. Standalone use remains explicit and must not be triggered by token pressure alone.",
    ],
    parameters: NewContextParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const receipt = controller.schedule({
          source: "tool",
          actorId,
          carryForward: params.carryForward,
          resourceUris: params.resourceUris,
        }, ctx);
        return result(
          receipt.coalesced
            ? `New-context request ${receipt.requestId} updated; it will run after the current turn settles.`
            : `New-context request ${receipt.requestId} scheduled for the end of the current turn.`,
          { requestId: receipt.requestId, scheduled: true, coalesced: receipt.coalesced },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result(message, { scheduled: false, error: message }, true);
      }
    },
    renderShell: "self",
    renderCall(params, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "new context", inputSummary(params));
    },
    renderResult(toolResult, options, theme, ctx) {
      if (options.isPartial) return new Text("", 0, 0);
      return renderNewContextResult(toolResult, options.expanded, theme, ctx.args);
    },
  };
}

export function registerNewContextTool(
  pi: ExtensionAPI,
  controller: NewContextController,
  actorId: string,
): void {
  pi.registerTool(createNewContextTool(controller, actorId) as never);
}
