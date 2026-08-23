import { clientToScreenPhysical } from "./coordinates.ts";
import {
  ComputerUseError,
  errorInfo,
  type Capabilities,
  type CapturedFrame,
  type ControlNode,
  type DetectResult,
  type DetectResultEnvelope,
  type ImageInfo,
  type OcrResult,
  type OcrResultEnvelope,
  type Permissions,
  type PhysicalPoint,
  type PhysicalRect,
  type PointerActionResult,
  type WindowInfo,
} from "./types.ts";
import { createDesktopAdapter } from "./platform/index.ts";
import { createVisionService } from "../../computer-use/vision/worker.ts";
import type {
  AccessibilityQuery,
  CaptureRequest,
  DesktopAdapter,
  FindControlQuery,
  KeyboardRequest,
  PointerRequest,
  TypeRequest,
  WindowQuery,
} from "./platform/types.ts";

export interface ManagerOperationOptions {
  signal?: AbortSignal;
  deadline?: number;
  timeoutMs?: number;
}
export type TargetContext = "desktop" | "local_game" | "network_game";
export interface ComputerUseStatus { queue_depth: number; active_action?: string; latched_windows: string[]; worker_state: "available" | "unavailable" | "unknown"; models: "unverified" | "available" | "unavailable"; }
export interface PointerInput extends ManagerOperationOptions { window_id: string; x: number; y: number; coordinate_space?: "screen_physical" | "window_client_physical"; allow_outside_window?: boolean; allow_destructive?: boolean; target_context?: TargetContext; duration_ms?: number; }
export interface DragInput extends PointerInput { to_x: number; to_y: number; }
export interface KeyboardInput extends ManagerOperationOptions { window_id: string; keys: readonly string[]; allow_destructive?: boolean; target_context?: TargetContext; }
export interface TextInput extends ManagerOperationOptions { window_id: string; text: string; interval_ms?: number; allow_destructive?: boolean; target_context?: TargetContext; }
export interface ScreenshotInput extends ManagerOperationOptions { source: "screen" | "window" | "region"; window_id?: string; region?: PhysicalRect; display_id?: string; }
export interface VisionInput extends Omit<ScreenshotInput, "source"> { source: "image" | "screen" | "window" | "region"; path?: string; enhance?: boolean; langs?: readonly string[]; mode?: "match" | "crop"; confidence?: number; iou_threshold?: number; }
export interface ControlInput extends ManagerOperationOptions { window_id: string; control_ref: string; allow_destructive?: boolean; target_context?: TargetContext; }
export interface FindBlockInput extends ManagerOperationOptions { template_path: string; source: "screen" | "window" | "region"; window_id?: string; region?: PhysicalRect; threshold?: number; }
export interface FindBlockResult { found: boolean; confidence: number; bbox?: [number, number, number, number]; center?: PhysicalPoint; image?: ImageInfo; }

export interface ComputerUseManagerLike {
  capabilities(options?: ManagerOperationOptions): Promise<Capabilities>;
  status(options?: ManagerOperationOptions): Promise<ComputerUseStatus>;
  permissions(options?: ManagerOperationOptions): Promise<Permissions>;
  listWindows(query?: WindowQuery, options?: ManagerOperationOptions): Promise<{ windows: WindowInfo[] }>;
  activate(windowId: string, options?: ManagerOperationOptions): Promise<{ window: WindowInfo; foreground_verified: boolean }>;
  screenshot(input: ScreenshotInput): Promise<CapturedFrame>;
  ocr(input: VisionInput): Promise<OcrResultEnvelope>;
  detect(input: VisionInput): Promise<DetectResultEnvelope>;
  uiTree(input: AccessibilityQuery & ManagerOperationOptions): Promise<{ snapshotId: string; controls: ControlNode[] }>;
  findControl(input: FindControlQuery & ManagerOperationOptions): Promise<{ snapshotId: string; matches: ControlNode[] }>;
  pressControl(input: ControlInput): Promise<{ method: "semantic" | "physical_fallback"; control: ControlNode }>;
  click(input: PointerInput): Promise<PointerActionResult>;
  doubleClick(input: PointerInput): Promise<PointerActionResult>;
  rightClick(input: PointerInput): Promise<PointerActionResult>;
  move(input: PointerInput): Promise<PointerActionResult>;
  drag(input: DragInput): Promise<PointerActionResult>;
  press(input: KeyboardInput): Promise<{ keys: readonly string[]; foregroundVerified: boolean }>;
  type(input: TextInput): Promise<{ characters: number; foregroundVerified: boolean }>;
  paste(input: TextInput): Promise<{ characters: number; clipboardRestored: boolean; foregroundVerified: boolean }>;
  findBlock(input: FindBlockInput): Promise<FindBlockResult>;
  shutdown(): Promise<void>;
}

interface VisionLike {
  ocr(input: unknown, options?: Record<string, unknown>, signal?: AbortSignal): Promise<OcrResult | { ok: false; code: string; diagnostic: string; engine: string }>;
  detect(input: unknown, options?: Record<string, unknown>, signal?: AbortSignal): Promise<DetectResult | { ok: false; code: string; diagnostic: string; engine: string }>;
  shutdown?(): Promise<void>;
}
function createManagerVision(): VisionLike {
  const service = createVisionService();
  return {
    async ocr(input, options = {}, signal) {
      const frame = asCapturedFrame(input);
      const raw = await service.ocr(frameToVisionInput(frame), {
        enhance: options.enhance === true ? true : undefined,
        langs: Array.isArray(options.langs) ? options.langs.map(String) : undefined,
        signal,
      });
      if (isVisionFailure(raw)) return raw;
      return {
        image: frame.image,
        text: raw.text,
        lines: raw.lines.map((line) => ({ bbox: line.bbox, polygon: rectanglePolygon(line.bbox), text: line.text, confidence: line.confidence })),
        engine: { name: "rapidocr-onnx", bundle: "rapidocr_onnxruntime@1.2.3", version: "1.2.3" },
        timingMs: { det: 0, cls: 0, rec: 0, total: 0 },
      };
    },
    async detect(input, options = {}, signal) {
      const frame = asCapturedFrame(input);
      const raw = await service.detect(frameToVisionInput(frame), {
        mode: options.mode === "crop" ? "crop" : "match",
        confidence: typeof options.confidence === "number" ? options.confidence : undefined,
        iouThreshold: typeof options.iouThreshold === "number" ? options.iouThreshold : undefined,
        signal,
      });
      if (isVisionFailure(raw)) return raw;
      return {
        image: frame.image,
        mode: raw.mode,
        items: raw.items,
        engines: { icon: "omniparser-v2 (manifest-gated)", ocr: "rapidocr-onnx" },
      };
    },
    shutdown: () => service.shutdown(),
  };
}

function asCapturedFrame(input: unknown): CapturedFrame {
  if (!input || typeof input !== "object" || !("image" in input) || !("bytes" in input)) throw new ComputerUseError({ code: "INVALID_IMAGE", message: "Vision input is not a captured frame", capability: "ocr", retryable: false });
  return input as CapturedFrame;
}

function frameToVisionInput(frame: CapturedFrame) {
  return {
    data: frame.bytes,
    metadata: {
      width: frame.image.width,
      height: frame.image.height,
      channels: 4 as const,
      pixelFormat: "rgba" as const,
      sourceFormat: "png" as const,
      origin: frame.image.origin,
    },
  };
}

function rectanglePolygon(bbox: [number, number, number, number]): Array<[number, number]> {
  return [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]];
}
interface ManagerHooks { vision?: VisionLike; findBlock?: (input: FindBlockInput, signal?: AbortSignal) => Promise<FindBlockResult>; }

const MAX_TEXT_LENGTH = 100_000;
const DIAGNOSTIC_REGION = 32;

/** A process-wide serialized desktop authority. */
export class ComputerUseManager implements ComputerUseManagerLike {
  private static tail: Promise<void> = Promise.resolve();
  private static queued = 0;
  private static activeAction: string | undefined;
  private readonly latchedWindows = new Set<string>();
  private readonly snapshots = new Map<string, Map<string, ControlNode>>();
  private readonly vision?: VisionLike;
  private readonly findBlockHook?: ManagerHooks["findBlock"];
  private closed = false;

  constructor(private readonly adapter: DesktopAdapter, hooks: ManagerHooks = {}) {
    this.vision = hooks.vision ?? adapter.vision as unknown as VisionLike;
    this.findBlockHook = hooks.findBlock;
  }
  capabilities(options: ManagerOperationOptions = {}): Promise<Capabilities> { return this.enqueue("capabilities", options, async () => this.adapter.capabilities); }
  status(_options: ManagerOperationOptions = {}): Promise<ComputerUseStatus> { return Promise.resolve({ queue_depth: ComputerUseManager.queued, ...(ComputerUseManager.activeAction ? { active_action: ComputerUseManager.activeAction } : {}), latched_windows: [...this.latchedWindows], worker_state: this.vision ? "available" : "unavailable", models: this.vision ? "unverified" : "unavailable" }); }
  permissions(options: ManagerOperationOptions = {}): Promise<Permissions> { return this.enqueue("permissions", options, signal => this.adapter.permissions(signal)); }
  listWindows(query: WindowQuery = {}, options: ManagerOperationOptions = {}): Promise<{ windows: WindowInfo[] }> { return this.enqueue("list_windows", options, async signal => ({ windows: await this.adapter.listWindows(query, signal) })); }
  activate(windowId: string, options: ManagerOperationOptions = {}): Promise<{ window: WindowInfo; foreground_verified: boolean }> { return this.enqueue("activate", options, async signal => { const result = await this.adapter.activate(this.requireWindowId(windowId), signal); if (!result.foregroundVerified) throw this.foregroundError(windowId); this.latchedWindows.delete(windowId); return { window: result.window, foreground_verified: true }; }); }
  screenshot(input: ScreenshotInput): Promise<CapturedFrame> { return this.enqueue("screenshot", input, async signal => { this.assertScreenshotInput(input); const frame = await this.adapter.capture({ source: input.source, windowId: input.window_id, region: input.region, displayId: input.display_id }, signal); if (input.window_id) this.latchedWindows.delete(input.window_id); else this.latchedWindows.clear(); return frame; }); }

  ocr(input: VisionInput): Promise<OcrResultEnvelope> { return this.enqueue("ocr", input, async signal => { const frame = await this.captureVisionInput(input, signal); const vision = this.requireVision("ocr"); const raw = await vision.ocr(frame, { enhance: input.enhance, langs: input.langs }, signal); if (isVisionFailure(raw)) return { ok: false, error: new ComputerUseError({ code: visionCode(raw.code), message: raw.diagnostic, capability: "ocr", retryable: false, details: { engine: raw.engine } }).toJSON() }; return { ok: true, result: translateOcr(raw, frame) }; }); }
  detect(input: VisionInput): Promise<DetectResultEnvelope> { return this.enqueue("detect", input, async signal => { const frame = await this.captureVisionInput(input, signal); const vision = this.requireVision("detect"); const raw = await vision.detect(frame, { mode: input.mode, confidence: input.confidence, iouThreshold: input.iou_threshold }, signal); if (isVisionFailure(raw)) return { ok: false, error: new ComputerUseError({ code: visionCode(raw.code), message: raw.diagnostic, capability: "detect", retryable: false, details: { engine: raw.engine } }).toJSON() }; if (frame.image.windowId) this.latchedWindows.delete(frame.image.windowId); return { ok: true, result: translateDetect(raw, frame) }; }); }

  uiTree(input: AccessibilityQuery & ManagerOperationOptions): Promise<{ snapshotId: string; controls: ControlNode[] }> { return this.enqueue("ui_tree", input, async signal => { const accessibility = this.requireAccessibility(); const result = await accessibility.uiTree({ windowId: input.windowId, maxDepth: input.maxDepth, includeOffscreen: input.includeOffscreen }, signal); this.rememberSnapshot(result.snapshotId, result.controls); this.latchedWindows.delete(input.windowId); return result; }); }
  findControl(input: FindControlQuery & ManagerOperationOptions): Promise<{ snapshotId: string; matches: ControlNode[] }> { return this.enqueue("find_control", input, async signal => { const accessibility = this.requireAccessibility(); const result = await accessibility.findControl({ windowId: input.windowId, query: input.query, enabledOnly: input.enabledOnly, maxResults: input.maxResults }, signal); this.rememberSnapshot(result.snapshotId, result.matches); this.latchedWindows.delete(input.windowId); return result; }); }
  pressControl(input: ControlInput): Promise<{ method: "semantic" | "physical_fallback"; control: ControlNode }> { return this.enqueue("press_control", input, async signal => { this.assertInputPolicy(input); this.assertInputNotLatched(input.window_id); const known = this.knownControl(input.control_ref); if (!known || known.windowId !== input.window_id) throw this.staleControlError(input.control_ref); if (!input.allow_destructive && isDestructiveControl(known)) throw this.invalidInput("Destructive control requires allow_destructive=true"); await this.activateAndVerify(input.window_id, signal); const accessibility = this.requireAccessibility(); const current = await accessibility.uiTree({ windowId: input.window_id }, signal); const control = current.controls.find(candidate => candidate.ref === known.ref); if (!control) throw this.staleControlError(input.control_ref); return accessibility.pressControl(input.window_id, control.ref, signal); }); }

  click(input: PointerInput): Promise<PointerActionResult> { return this.pointer("click", input); }
  doubleClick(input: PointerInput): Promise<PointerActionResult> { return this.pointer("double_click", input); }
  rightClick(input: PointerInput): Promise<PointerActionResult> { return this.pointer("right_click", input); }
  move(input: PointerInput): Promise<PointerActionResult> { return this.pointer("move", input, false); }
  drag(input: DragInput): Promise<PointerActionResult> { return this.enqueue("drag", input, async signal => { this.assertInputPolicy(input); this.assertInputNotLatched(input.window_id); const target = await this.resolveInputTarget(input, signal); const to = this.resolvePoint(input.to_x, input.to_y, target.window, input.coordinate_space, input.allow_outside_window === true); const drag = (this.adapter as DesktopAdapter & { drag?: (request: PointerRequest & { to: PhysicalPoint }, signal?: AbortSignal) => Promise<PointerActionResult> }).drag; if (!drag) throw this.unavailable("input", "No verified native drag provider is configured"); try { const result = await drag.call(this.adapter, { action: "move", windowId: target.window.id, point: target.point, coordinateSpace: "screen_physical", allowOutsideWindow: true, durationMs: input.duration_ms, to }, signal); if (!result.foregroundVerified) throw this.foregroundError(target.window.id); if (result.verification?.verdict === "near_zero") this.latchedWindows.add(target.window.id); return { ...result, resolvedPoint: target.point, foregroundVerified: true }; } finally { await this.releasePointer(target.window.id, signal); } }); }

  press(input: KeyboardInput): Promise<{ keys: readonly string[]; foregroundVerified: boolean }> { return this.enqueue("press", input, async signal => { this.assertInputPolicy(input); this.assertInputNotLatched(input.window_id); if (input.keys.length === 0) throw this.invalidInput("keys must not be empty"); if (!input.allow_destructive && isDestructiveKeys(input.keys)) throw this.invalidInput("Destructive key chords require allow_destructive=true"); await this.activateAndVerify(input.window_id, signal); const request: KeyboardRequest = { windowId: input.window_id, keys: input.keys }; try { const result = await this.adapter.press(request, signal); if (!result.foregroundVerified) throw this.foregroundError(input.window_id); return result; } finally { await this.releaseKeys(input.window_id, input.keys, signal); } }); }
  type(input: TextInput): Promise<{ characters: number; foregroundVerified: boolean }> { return this.enqueue("type", input, async signal => { this.assertText(input.text); this.assertInputPolicy(input); this.assertInputNotLatched(input.window_id); await this.activateAndVerify(input.window_id, signal); const result = await this.adapter.type({ windowId: input.window_id, text: input.text, intervalMs: input.interval_ms }, signal); if (!result.foregroundVerified) throw this.foregroundError(input.window_id); return result; }); }
  paste(input: TextInput): Promise<{ characters: number; clipboardRestored: boolean; foregroundVerified: boolean }> { return this.enqueue("paste", input, async signal => { this.assertText(input.text); this.assertInputPolicy(input); this.assertInputNotLatched(input.window_id); await this.activateAndVerify(input.window_id, signal); const result = await this.adapter.paste({ windowId: input.window_id, text: input.text, intervalMs: input.interval_ms }, signal); if (!result.foregroundVerified) throw this.foregroundError(input.window_id); return result; }); }
  findBlock(input: FindBlockInput): Promise<FindBlockResult> { return this.enqueue("find_block", input, async signal => { this.assertScreenshotInput(input); if (!this.findBlockHook) throw this.unavailable("screen_capture", "No verified find-block provider is configured"); return this.findBlockHook(input, signal); }); }

  async shutdown(): Promise<void> { if (this.closed) return; this.closed = true; await this.enqueue("shutdown", {}, async () => { await this.vision?.shutdown?.(); await this.adapter.shutdown?.(); }); }

  private pointer(action: PointerRequest["action"], input: PointerInput, verify = true): Promise<PointerActionResult> { return this.enqueue(action, input, async signal => { this.assertInputPolicy(input); const target = await this.resolveInputTarget(input, signal); if (this.latchedWindows.has(target.window.id)) throw new ComputerUseError({ code: "FOREGROUND_NOT_VERIFIED", message: "Input is latched after a near-zero diagnostic; re-probe with screenshot, detect, ui_tree, or activate", capability: "input", retryable: false, details: { windowId: target.window.id, requiresReprobe: true } }); const request: PointerRequest = { action, windowId: target.window.id, point: target.point, coordinateSpace: "screen_physical", allowOutsideWindow: true, durationMs: input.duration_ms }; const before = verify ? await this.captureDiagnostic(target.point, target.window, signal) : undefined; const result = await this.adapter.pointer(request, signal); if (!result.foregroundVerified) throw this.foregroundError(target.window.id); const after = verify ? await this.captureDiagnostic(target.point, target.window, signal) : undefined; const verification = compareDiagnostic(before, after, result.verification); const finalResult = { ...result, resolvedPoint: target.point, foregroundVerified: true, verification }; if (verify && verification.verdict === "near_zero") this.latchedWindows.add(target.window.id); return finalResult; }); }

  private async captureVisionInput(input: VisionInput, signal: AbortSignal): Promise<CapturedFrame> { if (input.source === "image") { if (!input.path) throw this.invalidInput("path is required for image vision input"); const loaded = await this.adapter.readImage({ path: input.path }, signal); return { image: loaded.image, bytes: loaded.bytes, capturedAt: Date.now() }; } this.assertScreenshotInput(input); return this.adapter.capture({ source: input.source, windowId: input.window_id, region: input.region, displayId: input.display_id }, signal); }
  private async resolveInputTarget(input: PointerInput, signal: AbortSignal): Promise<{ window: WindowInfo; point: PhysicalPoint }> { const windowId = this.requireWindowId(input.window_id); const activated = await this.activateAndVerify(windowId, signal); return { window: activated.window, point: this.resolvePoint(input.x, input.y, activated.window, input.coordinate_space, input.allow_outside_window === true) }; }
  private resolvePoint(x: number, y: number, window: WindowInfo, space: PointerInput["coordinate_space"], allowOutside: boolean): PhysicalPoint { if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ComputerUseError({ code: "INVALID_COORDINATE", message: "Pointer coordinates must be finite", capability: "input", retryable: false }); const point = space === "window_client_physical" ? window.clientBounds ? clientToScreenPhysical({ x, y }, { x: window.clientBounds.x, y: window.clientBounds.y }) : (() => { throw new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: "Client bounds are unavailable; refusing to use outer window bounds as client origin", capability: "window_control", retryable: false }); })() : { x, y }; if (!allowOutside && !inside(point, window.clientBounds ?? window.bounds)) throw new ComputerUseError({ code: "INVALID_COORDINATE", message: "Point is outside the target window bounds", capability: "input", retryable: false }); return point; }
  private async activateAndVerify(windowId: string, signal: AbortSignal): Promise<{ window: WindowInfo; foregroundVerified: boolean }> { const result = await this.adapter.activate(this.requireWindowId(windowId), signal); if (!result.foregroundVerified) throw this.foregroundError(windowId); const windows = await this.adapter.listWindows({}, signal); const current = windows.find(window => window.id === windowId); if (!current || !current.active) throw this.foregroundError(windowId); return { window: current, foregroundVerified: true }; }
  private async captureDiagnostic(point: PhysicalPoint, window: WindowInfo, signal: AbortSignal): Promise<Uint8Array | undefined> { const bounds = window.clientBounds ?? window.bounds; const region: PhysicalRect = { x: Math.max(bounds.x, Math.floor(point.x - 16)), y: Math.max(bounds.y, Math.floor(point.y - 16)), width: 32, height: 32 }; try { return (await this.adapter.capture({ source: "region", region, windowId: window.id }, signal)).bytes; } catch (error) { if (signal.aborted) throw error; return undefined; } }
  private rememberSnapshot(snapshotId: string, controls: ControlNode[]): void { this.snapshots.set(snapshotId, new Map(controls.map(control => [control.ref, control]))); if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!); }
  private knownControl(ref: string): ControlNode | undefined { for (const controls of this.snapshots.values()) { const control = controls.get(ref); if (control) return control; } return undefined; }

  private enqueue<T>(action: string, options: ManagerOperationOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> { if (this.closed && action !== "shutdown") return Promise.reject(new ComputerUseError({ code: "INTERNAL", message: "Computer-use manager is shut down", retryable: false })); const controller = new AbortController(); const signal = combineSignal(options.signal, options.deadline, options.timeoutMs, controller); ComputerUseManager.queued++; let started = false; let settled = false; let resolveOuter!: (value: T | PromiseLike<T>) => void; let rejectOuter!: (reason?: unknown) => void; const outer = new Promise<T>((resolve, reject) => { resolveOuter = resolve; rejectOuter = reject; }); const cancelQueued = () => { if (!started && !settled) { settled = true; ComputerUseManager.queued--; rejectOuter(abortFailure(signal)); } }; const execute = async () => { if (settled || signal.aborted) { cancelQueued(); return; } started = true; ComputerUseManager.queued--; ComputerUseManager.activeAction = action; try { resolveOuter(await run(signal)); } catch (error) { rejectOuter(normalizeAbort(error, signal)); } finally { if (ComputerUseManager.activeAction === action) ComputerUseManager.activeAction = undefined; settled = true; } }; const next = ComputerUseManager.tail.then(execute, execute).then(() => undefined, () => undefined); ComputerUseManager.tail = next; signal.addEventListener("abort", cancelQueued, { once: true }); if (signal.aborted) cancelQueued(); return outer; }

  private assertInputNotLatched(windowId: string): void { if (this.latchedWindows.has(windowId)) throw new ComputerUseError({ code: "FOREGROUND_NOT_VERIFIED", message: "Input is latched after a near-zero diagnostic; re-probe with screenshot, detect, ui_tree, or activate", capability: "input", retryable: false, details: { windowId, requiresReprobe: true } }); }
  private requireVision(capability: "ocr" | "detect"): VisionLike { if (!this.vision) throw this.unavailable(capability, "Shared vision service is unavailable"); return this.vision; }
  private requireAccessibility() { if (!this.adapter.accessibility) throw this.unavailable("accessibility", "Accessibility provider is unavailable"); return this.adapter.accessibility; }
  private assertScreenshotInput(input: { source: string; window_id?: string; region?: PhysicalRect }): void { if (input.source === "window" && !input.window_id) throw this.invalidInput("window_id is required for window capture"); if (input.source === "region" && !input.region) throw this.invalidInput("region is required for region capture"); }
  private assertInputPolicy(input: { window_id: string; target_context?: TargetContext; allow_destructive?: boolean }): void { this.requireWindowId(input.window_id); if (input.target_context === "network_game") throw new ComputerUseError({ code: "UNSUPPORTED_HARDWARE_INPUT", message: "Software input into network-game targets is disabled; use an approved hardware input path", capability: "input", retryable: false }); }
  private assertText(text: string): void { if (text.includes("\0")) throw this.invalidInput("text must not contain NUL bytes"); if (text.length > MAX_TEXT_LENGTH) throw this.invalidInput(`text exceeds ${MAX_TEXT_LENGTH} characters`); }
  private requireWindowId(windowId: string): string { if (!windowId || windowId.includes("\0")) throw this.invalidInput("window_id is required and must not contain NUL bytes"); return windowId; }
  private invalidInput(message: string): ComputerUseError { return new ComputerUseError({ code: "INTERNAL", message, retryable: false, details: { kind: "invalid_input" } }); }
  private unavailable(capability: "input" | "accessibility" | "ocr" | "detect" | "screen_capture", message: string): ComputerUseError { return new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message, capability, retryable: false }); }
  private foregroundError(windowId: string): ComputerUseError { return new ComputerUseError({ code: "FOREGROUND_NOT_VERIFIED", message: `Target window ${windowId} is not foreground`, capability: "window_control", retryable: false }); }
  private staleControlError(ref: string): ComputerUseError { return new ComputerUseError({ code: "STALE_CONTROL_REF", message: `Control reference is stale or unknown: ${ref}`, capability: "accessibility", retryable: false }); }
  private async releaseKeys(windowId: string, keys: readonly string[], signal: AbortSignal): Promise<void> { await (this.adapter as DesktopAdapter & { releaseKeys?: (windowId: string, keys: readonly string[], signal?: AbortSignal) => Promise<void> }).releaseKeys?.(windowId, keys, signal); }
  private async releasePointer(windowId: string, signal: AbortSignal): Promise<void> { await (this.adapter as DesktopAdapter & { releasePointer?: (windowId: string, signal?: AbortSignal) => Promise<void> }).releasePointer?.(windowId, signal); }
}

export function createComputerUseManager(adapter: DesktopAdapter = createDesktopAdapter(), hooks: ManagerHooks = {}): ComputerUseManager {
  const vision = hooks.vision ?? createManagerVision();
  return new ComputerUseManager(adapter, { ...hooks, vision });
}

class LazyComputerUseManager implements ComputerUseManagerLike {
  private instance?: ComputerUseManager;
  private closed = false;

  private async get(): Promise<ComputerUseManager> {
    if (this.closed) throw new ComputerUseError({ code: "INTERNAL", message: "Computer-use manager is shut down", retryable: false });
    this.instance ??= createComputerUseManager();
    return this.instance;
  }
  capabilities(options?: ManagerOperationOptions) { return this.get().then(manager => manager.capabilities(options)); }
  status(options?: ManagerOperationOptions) { return this.get().then(manager => manager.status(options)); }
  permissions(options?: ManagerOperationOptions) { return this.get().then(manager => manager.permissions(options)); }
  listWindows(query?: WindowQuery, options?: ManagerOperationOptions) { return this.get().then(manager => manager.listWindows(query, options)); }
  activate(windowId: string, options?: ManagerOperationOptions) { return this.get().then(manager => manager.activate(windowId, options)); }
  screenshot(input: ScreenshotInput) { return this.get().then(manager => manager.screenshot(input)); }
  ocr(input: VisionInput) { return this.get().then(manager => manager.ocr(input)); }
  detect(input: VisionInput) { return this.get().then(manager => manager.detect(input)); }
  uiTree(input: AccessibilityQuery & ManagerOperationOptions) { return this.get().then(manager => manager.uiTree(input)); }
  findControl(input: FindControlQuery & ManagerOperationOptions) { return this.get().then(manager => manager.findControl(input)); }
  pressControl(input: ControlInput) { return this.get().then(manager => manager.pressControl(input)); }
  click(input: PointerInput) { return this.get().then(manager => manager.click(input)); }
  doubleClick(input: PointerInput) { return this.get().then(manager => manager.doubleClick(input)); }
  rightClick(input: PointerInput) { return this.get().then(manager => manager.rightClick(input)); }
  move(input: PointerInput) { return this.get().then(manager => manager.move(input)); }
  drag(input: DragInput) { return this.get().then(manager => manager.drag(input)); }
  press(input: KeyboardInput) { return this.get().then(manager => manager.press(input)); }
  type(input: TextInput) { return this.get().then(manager => manager.type(input)); }
  paste(input: TextInput) { return this.get().then(manager => manager.paste(input)); }
  findBlock(input: FindBlockInput) { return this.get().then(manager => manager.findBlock(input)); }
  async shutdown(): Promise<void> { this.closed = true; if (this.instance) await this.instance.shutdown(); }
}

/** Root-owned serialized desktop authority. Native providers are not constructed until the first operation. */
export const computerUseManager: ComputerUseManagerLike = new LazyComputerUseManager();

function inside(point: PhysicalPoint, rect: PhysicalRect): boolean { return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height; }
function isDestructiveKeys(keys: readonly string[]): boolean { return keys.some(key => /(^|[+\-])(alt\+f4|cmd\+q|command\+q|ctrl\+w|control\+w|ctrl\+shift\+w|control\+shift\+w|delete|backspace|kill|quit|close)(?=$|[+\-])/i.test(key.replace(/\s/g, ""))); }
function isDestructiveControl(control: ControlNode): boolean { return /\b(close|quit|exit|delete|remove|kill|terminate|shutdown|power)\b/i.test([control.role, control.name ?? "", control.title ?? "", control.identifier ?? ""].join(" ")); }
function isVisionFailure(value: unknown): value is { ok: false; code: string; diagnostic: string; engine: string } { return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false); }
function visionCode(code: string): "MODEL_UNAVAILABLE" | "MODEL_INTEGRITY_FAILED" | "INTERNAL" { return code === "MODEL_INTEGRITY_FAILED" ? code : code === "MODEL_UNAVAILABLE" ? code : "INTERNAL"; }
function translateOcr(result: OcrResult, frame: CapturedFrame): OcrResult { return { ...result, image: { ...result.image, ...frame.image, origin: frame.image.origin } }; }
function translateDetect(result: DetectResult, frame: CapturedFrame): DetectResult { return { ...result, image: { ...result.image, ...frame.image, origin: frame.image.origin } }; }
function compareDiagnostic(before: Uint8Array | undefined, after: Uint8Array | undefined, fallback: PointerActionResult["verification"]): PointerActionResult["verification"] { if (!before || !after) return fallback ?? { changedPixels: 0, totalPixels: 0, changePercent: 0, verdict: "unavailable", foregroundChanged: true, requiresReprobe: false }; const changed = before.length !== after.length || before.some((value, index) => value !== after[index]); return { changedPixels: changed ? 1 : 0, totalPixels: 1, changePercent: changed ? 100 : 0, verdict: changed ? "changed" : "near_zero", foregroundChanged: fallback?.foregroundChanged ?? true, requiresReprobe: !changed }; }
function combineSignal(parent: AbortSignal | undefined, deadline: number | undefined, timeoutMs: number | undefined, controller: AbortController): AbortSignal { const signals: AbortSignal[] = [controller.signal]; if (parent) signals.push(parent); const duration = deadline !== undefined ? Math.max(0, deadline - Date.now()) : timeoutMs; if (duration !== undefined) signals.push(AbortSignal.timeout(Math.max(0, duration))); return AbortSignal.any(signals); }
function abortFailure(signal: AbortSignal): ComputerUseError { return new ComputerUseError({ code: signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "ABORTED", message: signal.reason?.name === "TimeoutError" ? "Computer-use operation deadline exceeded" : "Computer-use operation was aborted", retryable: signal.reason?.name === "TimeoutError" }); }
function normalizeAbort(error: unknown, signal: AbortSignal): unknown { return signal.aborted ? abortFailure(signal) : (error instanceof ComputerUseError ? error : new ComputerUseError({ ...errorInfo(error), retryable: false })); }
