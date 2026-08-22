/** Platform-neutral contracts for the standalone computer-use surface. */

export type PlatformId = "win32" | "darwin" | "linux";
export type SessionType = "x11" | "wayland" | "aqua" | "windows" | "unknown";
export type CoordinateSpace = "screen_physical" | "window_client_physical" | "image";
export type ImageSource = "screen" | "window" | "region" | "image";

export interface PhysicalPoint {
  x: number;
  y: number;
}

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: string;
  bounds: PhysicalRect;
  /** Logical display origin, when the platform exposes one. */
  logicalOrigin?: PhysicalPoint;
  /** Logical pixels per physical pixel (Windows DPI / macOS Retina scale). */
  logicalToPhysicalScale?: number;
  /** Short alias accepted by coordinate adapters. */
  scale?: number;
  primary?: boolean;
}

export interface ImageInfo {
  /** A private temporary path when the image was materialized. */
  path?: string;
  mimeType: "image/png";
  width: number;
  height: number;
  /** Physical screen origin of image (0,0 for an image-only source). */
  origin: PhysicalPoint;
  coordinateSpace: CoordinateSpace;
  source: ImageSource;
  backend: string;
  windowId?: string;
  displayId?: string;
  sizeBytes?: number;
}

export interface CapturedFrame {
  image: ImageInfo;
  /** PNG bytes are preferred; path is retained only for bounded artifact handoff. */
  bytes: Uint8Array;
  capturedAt: number;
  window?: WindowInfo;
  clientBounds?: PhysicalRect;
}

export interface WindowInfo {
  id: string;
  title: string;
  app: string;
  pid: number | null;
  active: boolean;
  minimized: boolean | null;
  bounds: PhysicalRect;
  clientBounds: PhysicalRect | null;
  displayId?: string;
}

export interface ControlNode {
  ref: string;
  windowId: string;
  role: string;
  name: string | null;
  title: string | null;
  identifier: string | null;
  value: string | number | boolean | null;
  enabled: boolean | null;
  focused: boolean | null;
  offscreen: boolean | null;
  bounds: PhysicalRect | null;
  actions: string[];
}

export type CapabilityName =
  | "screen_capture"
  | "window_capture"
  | "window_list"
  | "window_control"
  | "accessibility"
  | "input"
  | "keyboard"
  | "clipboard"
  | "ocr"
  | "detect";

export type CapabilityState = "available" | "degraded" | "restricted" | "unavailable" | "unknown";

export interface CapabilityStatus {
  state: CapabilityState;
  provider?: string;
  reason?: string;
  remediation?: string;
  errorCode?: ComputerUseErrorCode;
}

export type CapabilityMap = Partial<Record<CapabilityName, CapabilityStatus>>;

export interface Capabilities {
  platform: PlatformId;
  session: SessionType;
  features: CapabilityMap;
}

export type PermissionName = "screen_capture" | "accessibility" | "input" | "window_control";
export type PermissionState = "granted" | "denied" | "prompt" | "unknown";

export interface PermissionStatus {
  state: PermissionState;
  reason?: string;
  remediation?: string;
}

export interface Permissions {
  screen_capture: PermissionStatus;
  accessibility: PermissionStatus;
  input: PermissionStatus;
  window_control: PermissionStatus;
}

export type CapabilityReport = Capabilities;

export type PermissionReport = Permissions;

export interface OcrLine {
  bbox: [number, number, number, number];
  polygon: Array<[number, number]>;
  text: string;
  confidence: number;
}

export interface OcrResult {
  image: ImageInfo;
  text: string;
  lines: OcrLine[];
  engine: { name: string; bundle: string; version: string };
  timingMs: { det: number; cls: number; rec: number; total: number };
}

export interface DetectItem {
  bbox: [number, number, number, number];
  type: "icon" | "text";
  label: string | null;
  confidence: number;
}

export interface DetectResult {
  image: ImageInfo;
  mode: "match" | "crop";
  items: DetectItem[];
  engines: { icon: string; ocr: string };
}

export interface OcrSuccessEnvelope {
  ok: true;
  result: OcrResult;
}

export interface DetectSuccessEnvelope {
  ok: true;
  result: DetectResult;
}

export interface ComputerUseFailureEnvelope {
  ok: false;
  error: ComputerUseErrorInfo;
}

export type OcrResultEnvelope = OcrSuccessEnvelope | ComputerUseFailureEnvelope;
export type DetectResultEnvelope = DetectSuccessEnvelope | ComputerUseFailureEnvelope;

export interface PointerVerification {
  changedPixels: number;
  totalPixels: number;
  changePercent: number;
  verdict: "changed" | "near_zero" | "unavailable";
  foregroundChanged: boolean;
  requiresReprobe: boolean;
}

export interface PointerActionResult {
  resolvedPoint: PhysicalPoint;
  foregroundVerified: boolean;
  verification: PointerVerification;
}

export type ComputerUseErrorCode =
  | "INVALID_COORDINATE"
  | "INVALID_IMAGE"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "ARTIFACT_CLEANUP_FAILED"
  | "BLANK_FRAME"
  | "CAPTURE_RESTRICTED"
  | "DEPENDENCY_UNAVAILABLE"
  | "PERMISSION_REQUIRED"
  | "WAYLAND_RESTRICTED"
  | "UNSUPPORTED_PLATFORM"
  | "UNSUPPORTED_HARDWARE_INPUT"
  | "STALE_CONTROL_REF"
  | "WINDOW_NOT_FOUND"
  | "FOREGROUND_NOT_VERIFIED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_INTEGRITY_FAILED"
  | "ABORTED"
  | "TIMEOUT"
  | "INTERNAL";

export interface ComputerUseErrorInfo {
  code: ComputerUseErrorCode;
  message: string;
  capability?: CapabilityName;
  retryable: boolean;
  remediation?: string;
  details?: Record<string, unknown>;
}

export class ComputerUseError extends Error implements ComputerUseErrorInfo {
  readonly name = "ComputerUseError";
  readonly code: ComputerUseErrorCode;
  readonly capability?: CapabilityName;
  readonly retryable: boolean;
  readonly remediation?: string;
  readonly details?: Record<string, unknown>;

  constructor(info: ComputerUseErrorInfo);
  constructor(code: ComputerUseErrorCode, message: string, options?: Omit<Partial<ComputerUseErrorInfo>, "code" | "message">);
  constructor(infoOrCode: ComputerUseErrorInfo | ComputerUseErrorCode, message?: string, options: Omit<Partial<ComputerUseErrorInfo>, "code" | "message"> = {}) {
    const info: ComputerUseErrorInfo = typeof infoOrCode === "string"
      ? { code: infoOrCode, message: message ?? infoOrCode, retryable: options.retryable ?? false, ...options }
      : infoOrCode;
    super(info.message);
    this.code = info.code;
    this.capability = info.capability;
    this.retryable = info.retryable;
    this.remediation = info.remediation;
    this.details = info.details;
  }

  toJSON(): ComputerUseErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.capability ? { capability: this.capability } : {}),
      retryable: this.retryable,
      ...(this.remediation ? { remediation: this.remediation } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function computerUseError(info: ComputerUseErrorInfo): ComputerUseError {
  return new ComputerUseError(info);
}

export function isComputerUseError(value: unknown): value is ComputerUseError {
  return value instanceof ComputerUseError
    || (typeof value === "object" && value !== null
      && (value as { name?: unknown }).name === "ComputerUseError"
      && typeof (value as { code?: unknown }).code === "string");
}

export function errorInfo(error: unknown, fallbackCode: ComputerUseErrorCode = "INTERNAL"): ComputerUseErrorInfo {
  if (isComputerUseError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.capability ? { capability: error.capability } : {}),
      retryable: error.retryable,
      ...(error.remediation ? { remediation: error.remediation } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
