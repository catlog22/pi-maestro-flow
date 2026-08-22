import { createRequire } from "node:module";
import { detectBlankFrame, inspectPng, readBoundedPng } from "../artifacts.ts";
import { clientToScreenPhysical } from "../coordinates.ts";
import { ComputerUseError, type Capabilities, type CapabilityMap, type CapabilityName, type CapturedFrame, type ControlNode, type DisplayInfo, type ImageInfo, type Permissions, type PhysicalPoint, type PhysicalRect, type PointerActionResult, type WindowInfo } from "../types.ts";
import type { AccessibilityAdapter, AccessibilityQuery, CaptureRequest, DesktopAdapter, FindControlQuery, ImageRequest, InputAdapter, KeyboardRequest, PermissionAdapter, PointerRequest, TypeRequest, WindowQuery } from "./types.ts";
import { capability, capabilityAvailable, capabilityUnavailable, createCapabilities } from "./index.ts";

export interface NativeHooks {
  listWindows?: (query?: WindowQuery, signal?: AbortSignal) => Promise<WindowInfo[]>;
  activate?: (windowId: string, signal?: AbortSignal) => Promise<{ window: WindowInfo; foregroundVerified: boolean }>;
  displays?: (signal?: AbortSignal) => Promise<DisplayInfo[]>;
  capture?: (request: CaptureRequest, signal?: AbortSignal) => Promise<CapturedFrame>;
  pointer?: (request: PointerRequest, resolvedPoint: PhysicalPoint, signal?: AbortSignal) => Promise<PointerActionResult>;
  press?: (request: KeyboardRequest, signal?: AbortSignal) => Promise<{ keys: readonly string[]; foregroundVerified: boolean }>;
  type?: (request: TypeRequest, signal?: AbortSignal) => Promise<{ characters: number; foregroundVerified: boolean }>;
  paste?: (request: TypeRequest, signal?: AbortSignal) => Promise<{ characters: number; clipboardRestored: boolean; foregroundVerified: boolean }>;
  permissions?: (signal?: AbortSignal) => Promise<Permissions>;
  accessibility?: AccessibilityAdapter;
  shutdown?: () => Promise<void>;
}

export interface AdapterOptions {
  /** Test-only platform override; production routing uses process.platform. */
  platform?: "win32" | "darwin" | "linux";
  session?: "x11" | "wayland" | "aqua" | "windows" | "unknown";
  env?: NodeJS.ProcessEnv;
  requireOptional?: (name: string) => unknown;
  hooks?: NativeHooks;
  capabilities?: CapabilityMap;
}

export function optionalRequire(name: string): unknown {
  try {
    return createRequire(import.meta.url)(name) as unknown;
  } catch {
    return undefined;
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function functionProperty(value: unknown, key: string): ((...args: unknown[]) => unknown) | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "function" ? candidate as (...args: unknown[]) => unknown : undefined;
}

export function numberProperty(value: unknown, key: string): number | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

export function stringProperty(value: unknown, key: string): string | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function normalizeRect(value: unknown): PhysicalRect | null {
  const object = record(value);
  if (!object) return null;
  const x = numberProperty(object, "x") ?? numberProperty(object, "left");
  const y = numberProperty(object, "y") ?? numberProperty(object, "top");
  const width = numberProperty(object, "width") ?? (numberProperty(object, "right") !== undefined && x !== undefined ? numberProperty(object, "right")! - x : undefined);
  const height = numberProperty(object, "height") ?? (numberProperty(object, "bottom") !== undefined && y !== undefined ? numberProperty(object, "bottom")! - y : undefined);
  if ([x, y, width, height].some((entry) => entry === undefined) || width! < 0 || height! < 0) return null;
  return { x: x!, y: y!, width: width!, height: height! };
}

function pngFrame(bytes: Uint8Array, backend: string, source: "screen" | "window" | "region", origin: PhysicalPoint, windowId?: string): CapturedFrame {
  if (bytes.byteLength < 8) throw new ComputerUseError({ code: "CAPTURE_RESTRICTED", message: "Capture provider returned no PNG frame", capability: source === "screen" ? "screen_capture" : "window_capture", retryable: false });
  // Importing the validator here keeps all provider outputs bounded before consumers see them.
  const metadata = readPngHeader(bytes);
  return {
    image: { mimeType: "image/png", width: metadata.width, height: metadata.height, origin, coordinateSpace: source === "window" ? "window_client_physical" : "screen_physical", source, backend, ...(windowId ? { windowId } : {}) },
    bytes,
    capturedAt: Date.now(),
  };
}

function readPngHeader(bytes: Uint8Array): { width: number; height: number } {
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71 || bytes[24] === undefined) throw new ComputerUseError({ code: "INVALID_IMAGE", message: "Capture provider did not return a PNG", retryable: false });
  const width = bytes[16]! * 0x1000000 + (bytes[17]! << 16) + (bytes[18]! << 8) + bytes[19]!;
  const height = bytes[20]! * 0x1000000 + (bytes[21]! << 16) + (bytes[22]! << 8) + bytes[23]!;
  if (width < 1 || height < 1) throw new ComputerUseError({ code: "CAPTURE_RESTRICTED", message: "Capture provider returned an empty PNG", retryable: false });
  return { width, height };
}

class UnavailableAccessibility implements AccessibilityAdapter {
  readonly name: string;
  constructor(private readonly reason: string) { this.name = "unavailable"; }
  uiTree(_request: AccessibilityQuery, _signal?: AbortSignal): Promise<{ snapshotId: string; controls: ControlNode[] }> { return Promise.reject(this.error("accessibility")); }
  findControl(_request: FindControlQuery, _signal?: AbortSignal): Promise<{ snapshotId: string; matches: ControlNode[] }> { return Promise.reject(this.error("accessibility")); }
  pressControl(_windowId: string, _controlRef: string, _signal?: AbortSignal): Promise<{ method: "semantic" | "physical_fallback"; control: ControlNode }> { return Promise.reject(this.error("accessibility")); }
  private error(capability: "accessibility"): ComputerUseError { return new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: this.reason, capability, retryable: false }); }
}

export abstract class BaseDesktopAdapter implements DesktopAdapter {
  readonly platform: "win32" | "darwin" | "linux";
  readonly session: "x11" | "wayland" | "aqua" | "windows" | "unknown";
  readonly name = "computer-use-platform";
  readonly capabilities: Capabilities;
  readonly accessibility?: AccessibilityAdapter;
  protected readonly hooks: NativeHooks;
  protected readonly requireOptional: (name: string) => unknown;

  constructor(platform: "win32" | "darwin" | "linux", session: "x11" | "wayland" | "aqua" | "windows" | "unknown", capabilities: CapabilityMap, options: AdapterOptions) {
    this.platform = platform;
    this.session = session;
    this.capabilities = createCapabilities(this.platform, this.session, { ...capabilities, ...options.capabilities });
    this.hooks = options.hooks ?? {};
    this.requireOptional = options.requireOptional ?? optionalRequire;
    this.accessibility = this.hooks.accessibility ?? new UnavailableAccessibility("Accessibility provider is unavailable or permission is not granted");
  }

  async listWindows(query?: WindowQuery, signal?: AbortSignal): Promise<WindowInfo[]> {
    if (this.hooks.listWindows) return this.hooks.listWindows(query, signal);
    const activeWin = this.requireOptional("active-win");
    const list = functionProperty(activeWin, "openWindows");
    if (!list) throw this.unavailable("window_list", "active-win openWindows export is unavailable");
    const raw = await list() as unknown;
    if (!Array.isArray(raw)) throw this.unavailable("window_list", "active-win returned an invalid window list");
    return raw.map((item) => normalizeWindow(item)).filter((item): item is WindowInfo => item !== null).filter((item) => matchesWindow(item, query));
  }

  async activate(windowId: string, signal?: AbortSignal): Promise<{ window: WindowInfo; foregroundVerified: boolean }> {
    if (this.hooks.activate) return this.hooks.activate(windowId, signal);
    throw this.unavailable("window_control", `No verified window activation provider for ${windowId}`);
  }

  async displays(signal?: AbortSignal): Promise<DisplayInfo[]> {
    if (this.hooks.displays) return this.hooks.displays(signal);
    const screenshot = this.requireOptional("screenshot-desktop");
    const list = functionProperty(screenshot, "listDisplays");
    if (!list) throw this.unavailable("screen_capture", "screenshot-desktop listDisplays export is unavailable");
    const raw = await list() as unknown;
    if (!Array.isArray(raw)) throw this.unavailable("screen_capture", "screenshot-desktop returned an invalid display list");
    const displays = raw.map((item, index) => normalizeDisplay(item, index)).filter((item): item is DisplayInfo => item !== null);
    if (displays.length !== raw.length) throw this.unavailable("screen_capture", "Display provider did not expose physical bounds");
    return displays;
  }

  async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CapturedFrame> {
    if (this.hooks.capture) return this.hooks.capture(request, signal);
    if (request.source !== "screen") throw new ComputerUseError({ code: "CAPTURE_RESTRICTED", message: "Verified native window/region capture is not available", capability: "window_capture", retryable: false, remediation: "Install and probe a platform-specific capture bridge." });
    const screenshot = this.requireOptional("screenshot-desktop");
    const capture = typeof screenshot === "function" ? screenshot : functionProperty(screenshot, "default");
    if (!capture) throw this.unavailable("screen_capture", "screenshot-desktop capture export is unavailable");
    const raw = await capture({ format: "png" }) as unknown;
    const bytes = toBytes(raw);
    const frame = pngFrame(bytes, "screenshot-desktop", "screen", { x: 0, y: 0 });
    const metadata = inspectPng(bytes, { maxBytes: 16 * 1024 * 1024 });
    if (detectBlankFrame(bytes, { maxBytes: 16 * 1024 * 1024 }).blank) throw new ComputerUseError({ code: "BLANK_FRAME", message: "Capture provider returned a blank frame", capability: "screen_capture", retryable: true });
    if (metadata.width !== frame.image.width || metadata.height !== frame.image.height) throw new ComputerUseError({ code: "INVALID_IMAGE", message: "Capture provider returned inconsistent PNG metadata", retryable: false });
    return frame;
  }

  async readImage(request: ImageRequest, _signal?: AbortSignal): Promise<{ image: ImageInfo; bytes: Uint8Array }> {
    const bytes = await readBoundedPng(request.path);
    const header = readPngHeader(bytes);
    return { bytes, image: { path: request.path, mimeType: "image/png", width: header.width, height: header.height, origin: { x: 0, y: 0 }, coordinateSpace: "image", source: "image", backend: "file" } };
  }

  async pointer(request: PointerRequest, signal?: AbortSignal): Promise<PointerActionResult> {
    const resolved = await this.resolvePoint(request);
    if (!this.hooks.pointer) throw this.unavailable("input", "No verified native pointer provider is configured");
    return this.hooks.pointer(request, resolved, signal);
  }
  async press(request: KeyboardRequest, signal?: AbortSignal): Promise<{ keys: readonly string[]; foregroundVerified: boolean }> {
    if (!this.hooks.press) throw this.unavailable("keyboard", "No verified native keyboard provider is configured");
    return this.hooks.press(request, signal);
  }
  async type(request: TypeRequest, signal?: AbortSignal): Promise<{ characters: number; foregroundVerified: boolean }> {
    if (!this.hooks.type) throw this.unavailable("keyboard", "No verified native text provider is configured");
    return this.hooks.type(request, signal);
  }
  async paste(request: TypeRequest, signal?: AbortSignal): Promise<{ characters: number; clipboardRestored: boolean; foregroundVerified: boolean }> {
    if (!this.hooks.paste) throw this.unavailable("clipboard", "No verified clipboard provider is configured");
    return this.hooks.paste(request, signal);
  }
  async permissions(signal?: AbortSignal): Promise<Permissions> {
    if (this.hooks.permissions) return this.hooks.permissions(signal);
    return unknownPermissions("No platform permission probe is configured");
  }
  async shutdown(): Promise<void> { await this.hooks.shutdown?.(); }

  protected unavailable(capability: "screen_capture" | "window_capture" | "window_list" | "window_control" | "accessibility" | "input" | "keyboard" | "clipboard", message: string): ComputerUseError {
    return new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message, capability, retryable: false, remediation: "Install/probe a supported native provider and re-check capabilities." });
  }

  private async resolvePoint(request: PointerRequest): Promise<PhysicalPoint> {
    if (request.coordinateSpace === "screen_physical") return finitePoint(request.point);
    const windows = await this.listWindows({});
    const window = windows.find((candidate) => candidate.id === request.windowId);
    if (!window) throw new ComputerUseError({ code: "WINDOW_NOT_FOUND", message: `Window not found: ${request.windowId}`, capability: "window_list", retryable: false });
    if (!window.clientBounds) throw new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: "Client bounds are unavailable; refusing to use outer window bounds as client origin", capability: "window_control", retryable: false });
    const resolved = clientToScreenPhysical(request.point, { x: window.clientBounds.x, y: window.clientBounds.y });
    if (!request.allowOutsideWindow && (resolved.x < window.clientBounds.x || resolved.y < window.clientBounds.y || resolved.x >= window.clientBounds.x + window.clientBounds.width || resolved.y >= window.clientBounds.y + window.clientBounds.height)) {
      throw new ComputerUseError({ code: "INVALID_COORDINATE", message: "Point is outside the window client bounds", capability: "input", retryable: false });
    }
    return finitePoint(resolved);
  }
}

function finitePoint(point: PhysicalPoint): PhysicalPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new ComputerUseError({ code: "INVALID_COORDINATE", message: "Pointer coordinates must be finite", capability: "input", retryable: false });
  return { x: point.x, y: point.y };
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "binary"));
  throw new ComputerUseError({ code: "CAPTURE_RESTRICTED", message: "Capture provider returned unsupported data", capability: "screen_capture", retryable: false });
}

function normalizeWindow(value: unknown): WindowInfo | null {
  const object = record(value);
  if (!object) return null;
  const bounds = normalizeRect(object["bounds"] ?? object["position"]);
  if (!bounds) return null;
  const clientBounds = normalizeRect(object["clientBounds"]);
  const owner = record(object["owner"]);
  const pid = numberProperty(object, "pid") ?? numberProperty(owner, "processId") ?? null;
  const idValue = object["id"] ?? object["windowId"] ?? object["handle"];
  const id = typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : undefined;
  if (!id) return null;
  return { id, title: stringProperty(object, "title") ?? "", app: stringProperty(object, "app") ?? stringProperty(owner, "name") ?? "", pid, active: object["active"] === true, minimized: typeof object["minimized"] === "boolean" ? object["minimized"] : null, bounds, clientBounds };
}

function normalizeDisplay(value: unknown, index: number): DisplayInfo | null {
  const object = record(value);
  const bounds = normalizeRect(object?.["bounds"] ?? object?.["workArea"]);
  const idValue = object?.["id"] ?? object?.["name"] ?? index;
  if (!bounds || (typeof idValue !== "string" && typeof idValue !== "number")) return null;
  return { id: String(idValue), bounds, ...(object?.["primary"] === true ? { primary: true } : {}) };
}

function matchesWindow(window: WindowInfo, query?: WindowQuery): boolean {
  if (!query) return true;
  return (query.title === undefined || window.title.includes(query.title)) && (query.app === undefined || window.app.includes(query.app)) && (query.visibleOnly !== true || window.minimized !== true);
}

export function unknownPermissions(reason: string): Permissions {
  const status = { state: "unknown" as const, reason };
  return { screen_capture: status, accessibility: status, input: status, window_control: status };
}

export function explicitPermissions(statuses: Partial<Permissions>, reason: string): Permissions {
  const unknown = unknownPermissions(reason);
  return { ...unknown, ...statuses };
}

export function unavailableCapabilities(names: readonly CapabilityName[], provider: string): CapabilityMap {
  const result: CapabilityMap = {};
  for (const name of names) result[name] = capabilityUnavailable(`${provider} is not available`);
  return result;
}

export function availableOrDegraded(packageName: string, requireOptional: (name: string) => unknown, capabilityName: "screen_capture" | "window_list"): ReturnType<typeof capability> {
  return requireOptional(packageName) === undefined ? capabilityUnavailable(`${packageName} is not installed`) : capability(capabilityName === "screen_capture" ? "degraded" : "available", packageName, capabilityName === "screen_capture" ? "Capture is provider-dependent and must be probed before use" : undefined);
}

export function capabilitySet(platform: "win32" | "darwin" | "linux", session: "x11" | "wayland" | "aqua" | "windows" | "unknown", names: CapabilityMap): Capabilities {
  return createCapabilities(platform, session, names);
}
