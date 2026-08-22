import type {
  Capabilities,
  CapabilityName,
  ControlNode,
  CapturedFrame,
  DetectResult,
  DisplayInfo,
  ImageInfo,
  Permissions,
  PhysicalPoint,
  PhysicalRect,
  PointerActionResult,
  WindowInfo,
} from "../types.ts";

export interface WindowQuery {
  visibleOnly?: boolean;
  title?: string;
  app?: string;
}

export interface CaptureRequest {
  source: "screen" | "window" | "region";
  windowId?: string;
  region?: PhysicalRect;
  displayId?: string;
}

export interface ImageRequest {
  path: string;
}

export interface InputTarget {
  windowId: string;
  point: PhysicalPoint;
  coordinateSpace: "screen_physical" | "window_client_physical";
  allowOutsideWindow?: boolean;
}

export interface PointerRequest extends InputTarget {
  action: "click" | "double_click" | "right_click" | "move";
  durationMs?: number;
}

export interface KeyboardRequest {
  windowId: string;
  keys: readonly string[];
}

export interface TypeRequest {
  windowId: string;
  text: string;
  intervalMs?: number;
}

export interface AccessibilityQuery {
  windowId: string;
  maxDepth?: number;
  includeOffscreen?: boolean;
}

export interface FindControlQuery {
  windowId: string;
  query: string;
  enabledOnly?: boolean;
  maxResults?: number;
}

export interface AccessibilityAdapter {
  readonly name: string;
  uiTree(request: AccessibilityQuery, signal?: AbortSignal): Promise<{ snapshotId: string; controls: ControlNode[] }>;
  findControl(request: FindControlQuery, signal?: AbortSignal): Promise<{ snapshotId: string; matches: ControlNode[] }>;
  pressControl(windowId: string, controlRef: string, signal?: AbortSignal): Promise<{ method: "semantic" | "physical_fallback"; control: ControlNode }>;
}

export interface CaptureAdapter {
  readonly name: string;
  capture(request: CaptureRequest, signal?: AbortSignal): Promise<CapturedFrame>;
  readImage(request: ImageRequest, signal?: AbortSignal): Promise<{ image: ImageInfo; bytes: Uint8Array }>;
}

export interface WindowAdapter {
  listWindows(query?: WindowQuery, signal?: AbortSignal): Promise<WindowInfo[]>;
  activate(windowId: string, signal?: AbortSignal): Promise<{ window: WindowInfo; foregroundVerified: boolean }>;
  displays(signal?: AbortSignal): Promise<DisplayInfo[]>;
}

export interface InputAdapter {
  pointer(request: PointerRequest, signal?: AbortSignal): Promise<PointerActionResult>;
  press(request: KeyboardRequest, signal?: AbortSignal): Promise<{ keys: readonly string[]; foregroundVerified: boolean }>;
  type(request: TypeRequest, signal?: AbortSignal): Promise<{ characters: number; foregroundVerified: boolean }>;
  paste(request: TypeRequest, signal?: AbortSignal): Promise<{ characters: number; clipboardRestored: boolean; foregroundVerified: boolean }>;
}

export interface VisionAdapter {
  ocr(frame: CapturedFrame, options?: { enhance?: boolean; langs?: readonly string[] }, signal?: AbortSignal): Promise<import("../types.ts").OcrResult>;
  detect(frame: CapturedFrame, options?: { mode?: "match" | "crop"; confidence?: number }, signal?: AbortSignal): Promise<DetectResult>;
}

export interface PermissionAdapter {
  permissions(signal?: AbortSignal): Promise<Permissions>;
}

export interface DesktopAdapter extends WindowAdapter, CaptureAdapter, InputAdapter, PermissionAdapter {
  readonly platform: import("../types.ts").PlatformId;
  readonly session: import("../types.ts").SessionType;
  readonly capabilities: Capabilities;
  readonly accessibility?: AccessibilityAdapter;
  readonly vision?: VisionAdapter;
  shutdown?(): Promise<void>;
}

export interface CapabilityProbe {
  capability: CapabilityName;
  probe(signal?: AbortSignal): Promise<import("../types.ts").CapabilityStatus>;
}
