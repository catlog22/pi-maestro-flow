import {
  ComputerUseError,
  type Capabilities,
  type CapabilityMap,
  type CapabilityName,
  type CapabilityState,
  type CapabilityStatus,
  type ComputerUseErrorCode,
  type PlatformId,
  type SessionType,
} from "../types.ts";
import { WindowsDesktopAdapter } from "./windows.ts";
import { MacOSDesktopAdapter } from "./macos.ts";
import { LinuxDesktopAdapter } from "./linux.ts";

export type { DesktopAdapter, AccessibilityAdapter, CaptureAdapter, CapabilityProbe, FindControlQuery, InputAdapter, PermissionAdapter, WindowAdapter, VisionAdapter } from "./types.ts";
export type { AdapterOptions, NativeHooks } from "./base.ts";
export { runBridgeProcess, type BridgeCommand, type BridgeProcessOptions, type BridgeProcessResult } from "./bridge-process.ts";

const WAYLAND_REASON = "Wayland does not provide a universal global window/input/capture contract; use a tested compositor or portal capability.";
const WAYLAND_REMEDIATION = "Use an X11 session or a compositor-specific portal/backend, then re-probe capabilities.";

/** Shared structured diagnostic for every capability that cannot be claimed on Wayland. */
export const WAYLAND_RESTRICTED: Readonly<CapabilityStatus> = Object.freeze({
  state: "restricted",
  reason: WAYLAND_REASON,
  remediation: WAYLAND_REMEDIATION,
  errorCode: "WAYLAND_RESTRICTED",
});

export const WAYLAND_RESTRICTED_ERROR_CODE: ComputerUseErrorCode = "WAYLAND_RESTRICTED";

export function waylandRestrictedError(capability?: CapabilityName, details?: Record<string, unknown>): ComputerUseError {
  return new ComputerUseError({
    code: "WAYLAND_RESTRICTED",
    message: capability ? `${capability} is restricted on Wayland` : "This computer-use operation is restricted on Wayland",
    ...(capability ? { capability } : {}),
    retryable: false,
    remediation: WAYLAND_REMEDIATION,
    ...(details ? { details } : {}),
  });
}

export const RESTRICTED_WAYLAND_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "screen_capture",
  "window_capture",
  "window_list",
  "window_control",
  "accessibility",
  "input",
  "keyboard",
  "clipboard",
]);

export function waylandCapabilities(overrides: CapabilityMap = {}): Capabilities {
  const features: CapabilityMap = { ...overrides };
  for (const capability of RESTRICTED_WAYLAND_CAPABILITIES) features[capability] = { ...WAYLAND_RESTRICTED };
  // OCR/detect can still operate on an explicitly supplied image artifact.
  features.ocr = overrides.ocr ?? { state: "available", provider: "image-only" };
  features.detect = overrides.detect ?? { state: "available", provider: "image-only" };
  return createCapabilities("linux", "wayland", features);
}

export function createCapabilities(
  platform: PlatformId,
  session: SessionType,
  features: CapabilityMap = {},
): Capabilities {
  return { platform, session, features: { ...features } };
}

export function mergeCapabilities(base: Capabilities, extra: CapabilityMap): Capabilities {
  return createCapabilities(base.platform, base.session, { ...base.features, ...extra });
}

export function capability(
  state: CapabilityState,
  provider?: string,
  reason?: string,
  remediation?: string,
  errorCode?: ComputerUseErrorCode,
): CapabilityStatus {
  return {
    state,
    ...(provider ? { provider } : {}),
    ...(reason ? { reason } : {}),
    ...(remediation ? { remediation } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export function capabilityAvailable(provider?: string): CapabilityStatus {
  return capability("available", provider);
}

export function capabilityUnavailable(reason: string, remediation?: string, errorCode: ComputerUseErrorCode = "DEPENDENCY_UNAVAILABLE"): CapabilityStatus {
  return capability("unavailable", undefined, reason, remediation, errorCode);
}

export function capabilityRestricted(reason: string, remediation?: string, errorCode: ComputerUseErrorCode = "WAYLAND_RESTRICTED"): CapabilityStatus {
  return capability("restricted", undefined, reason, remediation, errorCode);
}

export function assertCapability(
  capabilities: Capabilities,
  name: CapabilityName,
): asserts capabilities is Capabilities & { features: CapabilityMap & Record<CapabilityName, CapabilityStatus> } {
  const status = capabilities.features[name];
  if (status?.state === "available" || status?.state === "degraded") return;
  if (status?.errorCode === "WAYLAND_RESTRICTED" || capabilities.session === "wayland") {
    throw waylandRestrictedError(name, { platform: capabilities.platform, session: capabilities.session });
  }
  throw new ComputerUseError({
    code: status?.errorCode ?? "DEPENDENCY_UNAVAILABLE",
    message: status?.reason ?? `${name} capability is unavailable`,
    capability: name,
    retryable: false,
    ...(status?.remediation ? { remediation: status.remediation } : {}),
  });
}

export function isWayland(platform: PlatformId, session: SessionType): boolean {
  return platform === "linux" && session === "wayland";
}

export { WindowsDesktopAdapter, NativeDesktopAdapter, createWindowsAdapter } from "./windows.ts";
export { MacOSDesktopAdapter, MacDesktopAdapter, createMacOSAdapter, createMacosAdapter } from "./macos.ts";
export { LinuxDesktopAdapter, createLinuxAdapter, createLinuxDesktopAdapter, detectLinuxSession } from "./linux.ts";
export type { AdapterOptions as DesktopAdapterOptions } from "./base.ts";

/** Route to the host adapter without loading optional native packages at module evaluation time. */
export function createDesktopAdapter(options: import("./base.ts").AdapterOptions = {}): import("./types.ts").DesktopAdapter {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return new WindowsDesktopAdapter(options);
  if (platform === "darwin") return new MacOSDesktopAdapter(options);
  if (platform === "linux") return new LinuxDesktopAdapter(options);
  throw new ComputerUseError({ code: "UNSUPPORTED_PLATFORM", message: `Unsupported desktop platform: ${platform}`, retryable: false });
}

/** Alias used by callers that treat routing as capability probing. */
export const createPlatformAdapter = createDesktopAdapter;
