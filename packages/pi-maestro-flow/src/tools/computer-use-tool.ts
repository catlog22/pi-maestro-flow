import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import {
  computerUseManager,
  type ComputerUseManagerLike,
  type ComputerUseStatus,
} from "./computer-use/manager.ts";
import { errorInfo, type CapturedFrame, type PhysicalRect } from "./computer-use/types.ts";
import { getSopRegistry, SOP_INDEX_EXTRAS, SOP_INDEX_HEADERS } from "./sop/sop-registry-singleton.ts";

const ACTIONS = [
  "guide", "capabilities", "status", "permissions", "list_windows", "activate", "screenshot", "ocr", "detect",
  "ui_tree", "find_control", "press_control", "click", "double_click", "right_click", "move", "drag", "press",
  "type", "paste", "find_block",
] as const;
type ComputerUseAction = typeof ACTIONS[number];

const ComputerUseAction = Type.Unsafe<ComputerUseAction>({
  type: "string",
  enum: [...ACTIONS],
  description: "Desktop action. Call guide first, then use observe-act-verify for physical computer control.",
});
const Source = Type.Unsafe<"screen" | "window" | "region" | "image">({ type: "string", enum: ["screen", "window", "region", "image"] });
const Region = Type.Object({
  x: Type.Number({ description: "Physical screen x origin" }),
  y: Type.Number({ description: "Physical screen y origin" }),
  width: Type.Number({ minimum: 1 }),
  height: Type.Number({ minimum: 1 }),
}, { additionalProperties: false });

/** The broad object is paired with action-specific allOf requirements and runtime checks below. */
export const ComputerUseParams = Type.Object({
  action: ComputerUseAction,
  topic: Type.Optional(Type.String({ description: "SOP topic for guide; omit for the registry index" })),
  source: Type.Optional(Source),
  path: Type.Optional(Type.String({ minLength: 1, description: "PNG path for image vision input" })),
  template_path: Type.Optional(Type.String({ minLength: 1, description: "PNG template path for find_block" })),
  window_id: Type.Optional(Type.String({ minLength: 1, description: "Target window id from list_windows" })),
  display_id: Type.Optional(Type.String()),
  region: Type.Optional(Region),
  visible_only: Type.Optional(Type.Boolean()),
  title: Type.Optional(Type.String()),
  app: Type.Optional(Type.String()),
  query: Type.Optional(Type.String({ minLength: 1, description: "Control query for find_control" })),
  control_ref: Type.Optional(Type.String({ minLength: 1, description: "Fresh control ref from ui_tree/find_control" })),
  max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  include_offscreen: Type.Optional(Type.Boolean()),
  enabled_only: Type.Optional(Type.Boolean()),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  x: Type.Optional(Type.Number({ description: "Physical x or client-relative x" })),
  y: Type.Optional(Type.Number({ description: "Physical y or client-relative y" })),
  to_x: Type.Optional(Type.Number()),
  to_y: Type.Optional(Type.Number()),
  coordinate_space: Type.Optional(Type.Unsafe<"screen_physical" | "window_client_physical">({ type: "string", enum: ["screen_physical", "window_client_physical"] })),
  allow_outside_window: Type.Optional(Type.Boolean()),
  allow_destructive: Type.Optional(Type.Boolean()),
  target_context: Type.Optional(Type.Unsafe<"desktop" | "local_game" | "network_game">({ type: "string", enum: ["desktop", "local_game", "network_game"] })),
  duration_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 120_000 })),
  keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 })),
  text: Type.Optional(Type.String({ maxLength: 100_000 })),
  interval_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 10_000 })),
  enhance: Type.Optional(Type.Boolean()),
  langs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })),
  mode: Type.Optional(Type.Unsafe<"match" | "crop">({ type: "string", enum: ["match", "crop"] })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  iou_threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000, description: "Bounded operation timeout in milliseconds" })),
}, {
  additionalProperties: false,
  allOf: [
    { if: { properties: { action: { const: "guide" } }, required: ["action"] }, then: { not: { required: ["source"] } } },
    { if: { properties: { action: { enum: ["screenshot", "ocr", "detect", "find_block"] } }, required: ["action"] }, then: { required: ["source"] } },
    { if: { properties: { action: { enum: ["screenshot", "find_block"] } }, required: ["action"] }, then: { not: { properties: { source: { const: "image" } } } } },
    { if: { properties: { source: { const: "window" } }, required: ["source"] }, then: { required: ["window_id"] } },
    { if: { properties: { source: { const: "region" } }, required: ["source"] }, then: { required: ["region"] } },
    { if: { properties: { source: { const: "image" } }, required: ["source"] }, then: { required: ["path"] } },
    { if: { properties: { action: { enum: ["activate", "ui_tree", "find_control", "press_control", "click", "double_click", "right_click", "move", "drag", "press", "type", "paste"] } }, required: ["action"] }, then: { required: ["window_id"] } },
    { if: { properties: { action: { enum: ["click", "double_click", "right_click", "move", "drag"] } }, required: ["action"] }, then: { required: ["x", "y"] } },
    { if: { properties: { action: { const: "drag" } }, required: ["action"] }, then: { required: ["to_x", "to_y"] } },
    { if: { properties: { action: { const: "press_control" } }, required: ["action"] }, then: { required: ["control_ref"] } },
    { if: { properties: { action: { const: "find_control" } }, required: ["action"] }, then: { required: ["query"] } },
    { if: { properties: { action: { const: "press" } }, required: ["action"] }, then: { required: ["keys"] } },
    { if: { properties: { action: { enum: ["type", "paste"] } }, required: ["action"] }, then: { required: ["text"] } },
    { if: { properties: { action: { const: "find_block" } }, required: ["action"] }, then: { required: ["template_path"] } },
  ],
} as Record<string, unknown>);

export type ComputerUseParamsType = Static<typeof ComputerUseParams>;

export interface ComputerUseToolDetails {
  action: ComputerUseAction;
  result?: unknown;
  error?: ReturnType<typeof errorInfo>;
  image?: { mimeType: string; width: number; height: number; bytes: number; source: string };
}

const POINTER_ACTIONS = new Set(["click", "double_click", "right_click", "move", "drag"]);
const VISION_ACTIONS = new Set(["ocr", "detect"]);
const SOURCE_ACTIONS = new Set(["screenshot", "ocr", "detect", "find_block"]);

export function createComputerUseTool(manager: ComputerUseManagerLike = computerUseManager): ToolDefinition<typeof ComputerUseParams, ComputerUseToolDetails> {
  return {
    name: "computer_use",
    label: "Computer Use",
    description: "Observe and control the physical desktop through a serialized, fail-closed ComputerUseManager. Use computer_use { action: \"guide\" } before desktop operations. Coordinates are physical pixels; activate and verify foreground state, then observe-act-verify. Near-zero diagnostics latch input until a fresh probe. Wayland, permissions, network-game software input, and unavailable native providers remain restricted.",
    promptSnippet: "Use computer_use for bounded physical desktop observation and input. Call action=guide first, then capabilities/permissions and an observe action. Coordinates are physical screen pixels or verified window-client pixels; activate, act, and verify. Stop on near-zero, timeout, permission, Wayland, stale-control, or foreground errors.",
    promptGuidelines: [
      "Before desktop operations, call computer_use action=guide; load core for the observe-act-verify loop, coordinates for physical/client-origin/DPI rules, safety for destructive and near-zero stops, and platform for permissions/Wayland/provider limits.",
      "Use capabilities and permissions before assuming screen capture, accessibility, input, or window control. Use list_windows/screenshot/ocr/detect/ui_tree/find_control to observe, then activate before input.",
      "Coordinates are physical pixels. window_client_physical is resolved from the verified client origin (ClientToScreen), never the outer window bounds. Windows DPI and macOS Retina scaling can change logical coordinates.",
      "Never retry a near-zero, timeout, foreground, stale-control, permission, Wayland, or network-game failure blindly. Destructive input requires allow_destructive=true.",
    ],
    parameters: ComputerUseParams,
    executionMode: "sequential",
    async execute(_id, rawParams, signal, _onUpdate, ctx): Promise<AgentToolResult<ComputerUseToolDetails>> {
      const validation = validateComputerUseParams(rawParams as unknown);
      if (validation) return failure("unknown", validation);
      const params = rawParams as ComputerUseParamsType;
      const action = params.action as ComputerUseAction;
      try {
        if (action === "guide") {
          const registry = getSopRegistry(ctx.cwd);
          await registry.ensureLoaded();
          const topic = stringValue(params.topic);
          if (!topic) {
            const text = registry.renderIndex("computer_use", SOP_INDEX_HEADERS.computer_use, SOP_INDEX_EXTRAS.computer_use);
            return success(text, { action, result: text });
          }
          const doc = registry.get("computer_use", topic);
          if (!doc) return failure(action, `Unknown SOP topic ${JSON.stringify(topic)}. Available: ${registry.topics("computer_use").join(", ")}.`);
          return success(doc.body, { action, result: doc.body });
        }
        const options = { signal, timeoutMs: params.timeout_ms };
        let result: unknown;
        switch (action) {
          case "capabilities": result = await manager.capabilities(options); break;
          case "status": result = await manager.status(options); break;
          case "permissions": result = await manager.permissions(options); break;
          case "list_windows": result = await manager.listWindows({ visibleOnly: params.visible_only, title: params.title, app: params.app }, options); break;
          case "activate": result = await manager.activate(params.window_id!, options); break;
          case "screenshot": {
            const frame = await manager.screenshot({ source: params.source as "screen" | "window" | "region", window_id: params.window_id, region: params.region as PhysicalRect | undefined, display_id: params.display_id, ...options });
            return frameResult(action, frame);
          }
          case "ocr": result = await manager.ocr({ source: params.source as "image" | "screen" | "window" | "region", path: params.path, window_id: params.window_id, region: params.region as PhysicalRect | undefined, display_id: params.display_id, enhance: params.enhance, langs: params.langs, mode: params.mode, confidence: params.confidence, iou_threshold: params.iou_threshold, ...options }); break;
          case "detect": result = await manager.detect({ source: params.source as "image" | "screen" | "window" | "region", path: params.path, window_id: params.window_id, region: params.region as PhysicalRect | undefined, display_id: params.display_id, enhance: params.enhance, langs: params.langs, mode: params.mode, confidence: params.confidence, iou_threshold: params.iou_threshold, ...options }); break;
          case "ui_tree": result = await manager.uiTree({ windowId: params.window_id!, maxDepth: params.max_depth, includeOffscreen: params.include_offscreen, ...options }); break;
          case "find_control": result = await manager.findControl({ windowId: params.window_id!, query: params.query!, enabledOnly: params.enabled_only, maxResults: params.max_results, ...options }); break;
          case "press_control": result = await manager.pressControl({ window_id: params.window_id!, control_ref: params.control_ref!, allow_destructive: params.allow_destructive, target_context: params.target_context, ...options }); break;
          case "click": result = await manager.click({ window_id: params.window_id!, x: params.x!, y: params.y!, coordinate_space: params.coordinate_space, allow_outside_window: params.allow_outside_window, allow_destructive: params.allow_destructive, target_context: params.target_context, duration_ms: params.duration_ms, ...options }); break;
          case "double_click": result = await manager.doubleClick({ window_id: params.window_id!, x: params.x!, y: params.y!, coordinate_space: params.coordinate_space, allow_outside_window: params.allow_outside_window, allow_destructive: params.allow_destructive, target_context: params.target_context, duration_ms: params.duration_ms, ...options }); break;
          case "right_click": result = await manager.rightClick({ window_id: params.window_id!, x: params.x!, y: params.y!, coordinate_space: params.coordinate_space, allow_outside_window: params.allow_outside_window, allow_destructive: params.allow_destructive, target_context: params.target_context, duration_ms: params.duration_ms, ...options }); break;
          case "move": result = await manager.move({ window_id: params.window_id!, x: params.x!, y: params.y!, coordinate_space: params.coordinate_space, allow_outside_window: params.allow_outside_window, allow_destructive: params.allow_destructive, target_context: params.target_context, duration_ms: params.duration_ms, ...options }); break;
          case "drag": result = await manager.drag({ window_id: params.window_id!, x: params.x!, y: params.y!, to_x: params.to_x!, to_y: params.to_y!, coordinate_space: params.coordinate_space, allow_outside_window: params.allow_outside_window, allow_destructive: params.allow_destructive, target_context: params.target_context, duration_ms: params.duration_ms, ...options }); break;
          case "press": result = await manager.press({ window_id: params.window_id!, keys: params.keys!, allow_destructive: params.allow_destructive, target_context: params.target_context, ...options }); break;
          case "type": result = await manager.type({ window_id: params.window_id!, text: params.text!, interval_ms: params.interval_ms, allow_destructive: params.allow_destructive, target_context: params.target_context, ...options }); break;
          case "paste": result = await manager.paste({ window_id: params.window_id!, text: params.text!, interval_ms: params.interval_ms, allow_destructive: params.allow_destructive, target_context: params.target_context, ...options }); break;
          case "find_block": result = await manager.findBlock({ template_path: params.template_path!, source: params.source as "screen" | "window" | "region", window_id: params.window_id, region: params.region as PhysicalRect | undefined, threshold: params.threshold, ...options }); break;
          default: return failure(action, `Unsupported computer_use action ${JSON.stringify(action)}.`);
        }
        if (isFailureEnvelope(result)) return failure(action, result.error);
        const text = formatResult(result);
        return success(text, { action, result });
      } catch (error) {
        return failure(action, errorInfo(error));
      }
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "?");
      const target = args.window_id ? ` ${String(args.window_id).slice(0, 32)}` : "";
      return toolCallLine(theme, "computer_use", `${action}${target}`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const action = String(ctx.args.action ?? "?");
      const details = result.details as ComputerUseToolDetails | undefined;
      const isError = (result as { isError?: boolean }).isError === true;
      const detail = result.content.filter((item) => item.type === "text").map((item) => "text" in item ? item.text : "").join("\n");
      return toolResultLine(theme, { name: "computer_use", ok: !isError, arg: action, summary: resultSummary(result), expanded: opts.expanded, detail });
    },
  };
}

function frameResult(action: ComputerUseAction, frame: CapturedFrame): AgentToolResult<ComputerUseToolDetails> {
  const image = { type: "image" as const, data: Buffer.from(frame.bytes).toString("base64"), mimeType: frame.image.mimeType };
  const details = { action, image: { mimeType: frame.image.mimeType, width: frame.image.width, height: frame.image.height, bytes: frame.bytes.byteLength, source: frame.image.source }, result: frame.image };
  return { content: [image, { type: "text", text: JSON.stringify(frame.image) }], details } as AgentToolResult<ComputerUseToolDetails>;
}

function success(text: string, details: ComputerUseToolDetails): AgentToolResult<ComputerUseToolDetails> {
  return { content: [{ type: "text", text }], details } as AgentToolResult<ComputerUseToolDetails>;
}

function failure(action: string, error: unknown): AgentToolResult<ComputerUseToolDetails> {
  const info = typeof error === "string" ? { code: "INTERNAL" as const, message: error, retryable: false } : isErrorInfoLike(error) ? error : errorInfo(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: info }, null, 2) }], isError: true, details: { action: action as ComputerUseAction, error: info } } as AgentToolResult<ComputerUseToolDetails>;
}

function isErrorInfoLike(value: unknown): value is ReturnType<typeof errorInfo> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string" && typeof record.retryable === "boolean";
}

function formatResult(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n[output truncated]` : text;
}

function isFailureEnvelope(value: unknown): value is { ok: false; error: unknown } {
  return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false && "error" in value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateComputerUseParams(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "computer_use parameters must be an object.";
  const p = value as Record<string, unknown>;
  if (typeof p.action !== "string" || !(ACTIONS as readonly string[]).includes(p.action)) return `action must be one of: ${ACTIONS.join(", ")}.`;
  const action = p.action;
  if (action === "guide") {
    if (p.source !== undefined) return "guide does not accept source; use topic to load a guide document.";
    return;
  }
  if (SOURCE_ACTIONS.has(action)) {
    if (!["screen", "window", "region", "image"].includes(String(p.source))) return `${action} requires source: screen, window, region, or image.`;
    if (p.source === "image" && !stringValue(p.path)) return `${action} with source=image requires path to a PNG image.`;
    if (p.source === "window" && !stringValue(p.window_id)) return `${action} with source=window requires window_id.`;
    if (p.source === "region" && !p.region) return `${action} with source=region requires region {x,y,width,height}.`;
    if (action === "screenshot" && p.source === "image") return "screenshot accepts source=screen, window, or region; use ocr/detect for an image file.";
    if (action === "find_block" && p.source === "image") return "find_block accepts screen, window, or region source; use ocr/detect for an image file.";
  }
  if (["activate", "ui_tree", "find_control", "press_control", ...POINTER_ACTIONS, "press", "type", "paste"].includes(action) && !stringValue(p.window_id)) return `${action} requires window_id from list_windows.`;
  if (POINTER_ACTIONS.has(action)) {
    if (!finiteNumber(p.x) || !finiteNumber(p.y)) return `${action} requires finite x and y coordinates.`;
    if (action === "drag" && (!finiteNumber(p.to_x) || !finiteNumber(p.to_y))) return "drag requires finite to_x and to_y coordinates.";
  }
  if (action === "press_control" && !stringValue(p.control_ref)) return "press_control requires a fresh control_ref from ui_tree or find_control.";
  if (action === "find_control" && !stringValue(p.query)) return "find_control requires a non-empty query.";
  if (action === "press" && (!Array.isArray(p.keys) || p.keys.length === 0)) return "press requires a non-empty keys array.";
  if ((action === "type" || action === "paste") && typeof p.text !== "string") return `${action} requires text.`;
  if (action === "find_block" && !stringValue(p.template_path)) return "find_block requires template_path.";
  if (p.region !== undefined && !validRegion(p.region)) return "region requires finite x/y and positive finite width/height.";
  const timeout = p.timeout_ms;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 300_000)) return "timeout_ms must be an integer from 1 to 300000 milliseconds.";
  return;
}

function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function validRegion(value: unknown): value is PhysicalRect {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return finiteNumber(p.x) && finiteNumber(p.y) && finiteNumber(p.width) && finiteNumber(p.height) && p.width > 0 && p.height > 0;
}
