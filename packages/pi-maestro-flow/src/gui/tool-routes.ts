import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Check, Convert } from "typebox/value";
import type { GuiPermissionGateway, GuiServerHandle } from "./types.ts";
import { getGuiTool, listGuiTools } from "./gui-registry.ts";

export interface GuiToolView {
  name: string;
  description: string;
  /** TypeBox schema; serializes to JSON Schema (symbols are non-enumerable). */
  parameters: unknown;
  sourceInfo: unknown;
  /** True when the UCL registry holds an `execute` for this tool. */
  guiCallable: boolean;
  mutating: boolean;
  owner: string;
}

export interface ToolRouteDeps {
  /** Host-level tool catalog (schema + source); typically `() => pi.getAllTools()`. */
  listAllTools: () => ToolInfo[];
  /** Permission gateway; when present, POST /tools/:name is registered. */
  gateway?: GuiPermissionGateway;
  /** Live session context for tool execution; refreshed per session. */
  getCtx?: () => ExtensionContext | undefined;
  /** Max concurrent in-flight invokes before returning 429 (default 16). */
  maxConcurrentInvokes?: number;
}

interface SerializedToolResult {
  content: unknown;
  details: unknown;
  terminate?: boolean;
}

const AUTHORIZATION_ABORTED = Symbol("authorization-aborted");

async function authorizeUntilAbort(
  authorization: Promise<{ block: true; reason: string } | undefined>,
  signal: AbortSignal,
): Promise<{ block: true; reason: string } | undefined | typeof AUTHORIZATION_ABORTED> {
  // Promise.race observes the winner only. Keep the gateway rejection handled
  // when cancellation wins before or during an uncooperative gateway call.
  void authorization.catch(() => undefined);
  if (signal.aborted) return AUTHORIZATION_ABORTED;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof AUTHORIZATION_ABORTED>((resolve) => {
    onAbort = () => resolve(AUTHORIZATION_ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([authorization, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function convertToolArguments(
  parameters: ToolDefinition["parameters"],
  rawArgs: unknown,
): Record<string, unknown> | undefined {
  try {
    const args = structuredClone(rawArgs);
    Convert(parameters, args);
    return Check(parameters, args) ? args as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function serializeToolResult(result: AgentToolResult<unknown>): SerializedToolResult {
  const out: SerializedToolResult = { content: result.content, details: result.details };
  if (result.terminate !== undefined) out.terminate = result.terminate;
  return out;
}

/**
 * Register the tool routes on the UCL server.
 * - GET /tools: discovery (schema + invocability).
 * - POST /tools/:name: invocation gated by the permission gateway.
 */
export function registerToolRoutes(server: GuiServerHandle, deps: ToolRouteDeps): void {
  server.registerRoute("GET", "/tools", () => {
    const allTools = deps.listAllTools();
    const registry = new Map(listGuiTools().map((entry) => [entry.name, entry]));

    const views: GuiToolView[] = allTools.map((tool) => {
      const entry = registry.get(tool.name);
      return {
        name: tool.name,
        description: tool.description,
        parameters: entry?.parameters ?? tool.parameters,
        sourceInfo: tool.sourceInfo,
        guiCallable: entry !== undefined,
        mutating: entry?.mutating ?? true,
        owner: entry?.owner ?? "pi-core",
      };
    });

    // Defensive: registry tools missing from the host catalog (e.g. registered late).
    const known = new Set(views.map((view) => view.name));
    for (const entry of registry.values()) {
      if (known.has(entry.name)) continue;
      views.push({
        name: entry.name,
        description: entry.description ?? "",
        parameters: entry.parameters,
        sourceInfo: undefined,
        guiCallable: true,
        mutating: entry.mutating,
        owner: entry.owner,
      });
    }

    return { result: views };
  });

  if (!deps.gateway) return;
  const gateway = deps.gateway;
  const maxConcurrent = deps.maxConcurrentInvokes ?? 16;
  let activeInvokes = 0;
  const inflight = new Map<string, AbortController>();

  server.onClose(() => {
    for (const controller of inflight.values()) controller.abort();
  });

  server.registerRoute("POST", "/cancel", (req) => {
    const invokeId = typeof req.body?.invokeId === "string" && req.body.invokeId ? req.body.invokeId : undefined;
    if (!invokeId) return { status: 400, error: "invokeId required", code: "bad_request" };
    const controller = inflight.get(invokeId);
    if (!controller) return { status: 404, error: "No in-flight invoke with that id", code: "not_found" };
    controller.abort();
    return { result: { cancelled: true, invokeId } };
  });

  server.registerRoute("POST", "/tools/:name", async (req) => {
    const name = req.params.name;
    const entry = getGuiTool(name);
    if (!entry) {
      return { status: 404, error: `Tool is not GUI-invocable: ${name}`, code: "not_invocable" };
    }
    const ctx = deps.getCtx?.();
    if (!ctx) {
      return { status: 503, error: "No active session context", code: "no_context" };
    }

    const parameters = entry.parameters ?? deps.listAllTools().find((tool) => tool.name === name)?.parameters;
    if (!parameters) {
      return { status: 503, error: `No parameter schema for GUI tool: ${name}`, code: "schema_unavailable" };
    }
    const rawArgs = req.body && Object.hasOwn(req.body, "args") ? req.body.args : {};
    const args = convertToolArguments(parameters, rawArgs);
    if (!args) {
      return { status: 400, error: "Invalid tool arguments", code: "invalid_args" };
    }

    const toolCallId = randomUUID();
    const invokeId =
      typeof req.body?.invokeId === "string" && req.body.invokeId ? req.body.invokeId : toolCallId;
    if (inflight.has(invokeId)) {
      return { status: 409, error: `Invoke id is already in flight: ${invokeId}`, code: "invoke_conflict" };
    }
    if (activeInvokes >= maxConcurrent) {
      return { status: 429, error: "Too many concurrent invokes", code: "rate_limited" };
    }

    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.raw.on("close", onClose);
    const timeoutMs = typeof req.body?.timeoutMs === "number" && req.body.timeoutMs > 0 ? req.body.timeoutMs : 0;
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    activeInvokes += 1;
    inflight.set(invokeId, controller);

    let executionStarted = false;
    let invokeOk = false;
    try {
      const authorization = gateway.authorize(name, args, controller.signal);
      const block = await authorizeUntilAbort(authorization, controller.signal);
      if (block === AUTHORIZATION_ABORTED) {
        return { status: 499, error: "Invocation cancelled", code: "cancelled" };
      }
      if (block) {
        return { status: 403, error: block.reason, code: "permission_denied" };
      }

      const currentCtx = deps.getCtx?.();
      if (!currentCtx) {
        return { status: 503, error: "No active session context", code: "no_context" };
      }
      if (currentCtx !== ctx) {
        return { status: 409, error: "Session context changed during authorization", code: "stale_context" };
      }
      if (getGuiTool(name) !== entry) {
        return { status: 409, error: `Tool registration changed during authorization: ${name}`, code: "stale_tool" };
      }
      if (!Check(parameters, args)) {
        return { status: 400, error: "Invalid tool arguments", code: "invalid_args" };
      }

      executionStarted = true;
      const result = await entry.execute(
        toolCallId,
        args as never,
        controller.signal,
        (partial) => {
          if (controller.signal.aborted) return;
          server.pushEvent("tool.progress", {
            toolCallId,
            invokeId,
            name,
            partial: serializeToolResult(partial as AgentToolResult<unknown>),
          });
        },
        currentCtx,
      );
      if (controller.signal.aborted) {
        return { status: 499, error: "Invocation cancelled", code: "cancelled" };
      }
      invokeOk = true;
      return { result: { toolCallId, invokeId, ...serializeToolResult(result as AgentToolResult<unknown>) } };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      return {
        status: cancelled ? 499 : 500,
        error: error instanceof Error ? error.message : String(error),
        code: cancelled ? "cancelled" : executionStarted ? "tool_error" : "authorization_error",
      };
    } finally {
      activeInvokes -= 1;
      if (inflight.get(invokeId) === controller) inflight.delete(invokeId);
      if (timer) clearTimeout(timer);
      req.raw.off("close", onClose);
      if (executionStarted) {
        server.pushEvent("tool.invoked", {
          toolCallId,
          invokeId,
          name,
          ok: invokeOk,
          cancelled: controller.signal.aborted,
        });
      }
    }
  });
}
