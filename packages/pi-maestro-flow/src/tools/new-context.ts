import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { NewContextController } from "../compaction/new-context.ts";
import { NEW_CONTEXT_MAX_CARRY_FORWARD_BYTES } from "../compaction/new-context.ts";
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
  };
}

export function registerNewContextTool(
  pi: ExtensionAPI,
  controller: NewContextController,
  actorId: string,
): void {
  pi.registerTool(createNewContextTool(controller, actorId) as never);
}
