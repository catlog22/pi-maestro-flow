import type { CapabilityMap, CapturedFrame, DetectResult, DisplayInfo, ImageInfo, OcrResult, Permissions, PointerActionResult, WindowInfo } from "../types.ts";
import { waylandCapabilities, waylandRestrictedError, capabilityAvailable, capabilityUnavailable } from "./index.ts";
import { BaseDesktopAdapter, optionalRequire, type AdapterOptions } from "./base.ts";
import type { CaptureRequest, ImageRequest, KeyboardRequest, PointerRequest, TypeRequest, WindowQuery } from "./types.ts";

export function detectLinuxSession(env: NodeJS.ProcessEnv = process.env): "x11" | "wayland" | "unknown" {
  const session = (env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (session === "wayland" || Boolean(env.WAYLAND_DISPLAY)) return "wayland";
  if (session === "x11" || Boolean(env.DISPLAY)) return "x11";
  return "unknown";
}

function linuxCapabilities(session: "x11" | "wayland" | "unknown", options: AdapterOptions): CapabilityMap {
  if (session === "wayland") return waylandCapabilities().features;
  const load = options.requireOptional ?? optionalRequire;
  const screenshot = load("screenshot-desktop") !== undefined;
  const activeWin = load("active-win") !== undefined;
  const x11Capture = screenshot ? { state: "degraded" as const, provider: "screenshot-desktop", reason: "Linux capture backend (ImageMagick/scrot) must be present and probed", errorCode: "CAPTURE_RESTRICTED" as const } : capabilityUnavailable("screenshot-desktop is not installed");
  return {
    screen_capture: x11Capture,
    window_capture: capabilityUnavailable("No verified X11 window capture bridge is configured"),
    window_list: activeWin ? capabilityAvailable("active-win") : capabilityUnavailable("active-win is not installed"),
    window_control: capabilityUnavailable("No verified X11 window-control bridge is configured"),
    accessibility: capabilityUnavailable("AT-SPI bridge is not configured"),
    input: capabilityUnavailable("No verified X11 input bridge is configured"),
    keyboard: capabilityUnavailable("No verified X11 keyboard bridge is configured"),
    clipboard: capabilityUnavailable("No verified X11 clipboard bridge is configured"),
    ocr: capabilityUnavailable("Vision is provided by the separate computer-use vision service"),
    detect: capabilityUnavailable("OmniParser is unverified_missing; no detector is claimed"),
  };
}

/** Linux adapter. X11 is best-effort; Wayland global operations always fail with WAYLAND_RESTRICTED. */
export class LinuxDesktopAdapter extends BaseDesktopAdapter {
  constructor(options: AdapterOptions = {}) {
    const session = options.session === "wayland" || options.session === "x11" || options.session === "unknown"
      ? options.session
      : detectLinuxSession(options.env ?? process.env);
    super("linux", session, linuxCapabilities(session, options), options);
  }

  private ensureGlobalAllowed(): void {
    if (this.session === "wayland") throw waylandRestrictedError(undefined, { session: this.session });
  }
  override async listWindows(query?: WindowQuery, signal?: AbortSignal): Promise<WindowInfo[]> { this.ensureGlobalAllowed(); return super.listWindows(query, signal); }
  override async activate(windowId: string, signal?: AbortSignal): Promise<{ window: WindowInfo; foregroundVerified: boolean }> { this.ensureGlobalAllowed(); return super.activate(windowId, signal); }
  override async displays(signal?: AbortSignal): Promise<DisplayInfo[]> { this.ensureGlobalAllowed(); return super.displays(signal); }
  override async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CapturedFrame> { this.ensureGlobalAllowed(); return super.capture(request, signal); }
  override async pointer(request: PointerRequest, signal?: AbortSignal): Promise<PointerActionResult> { this.ensureGlobalAllowed(); return super.pointer(request, signal); }
  override async press(request: KeyboardRequest, signal?: AbortSignal): Promise<{ keys: readonly string[]; foregroundVerified: boolean }> { this.ensureGlobalAllowed(); return super.press(request, signal); }
  override async type(request: TypeRequest, signal?: AbortSignal): Promise<{ characters: number; foregroundVerified: boolean }> { this.ensureGlobalAllowed(); return super.type(request, signal); }
  override async paste(request: TypeRequest, signal?: AbortSignal): Promise<{ characters: number; clipboardRestored: boolean; foregroundVerified: boolean }> { this.ensureGlobalAllowed(); return super.paste(request, signal); }
  override async permissions(signal?: AbortSignal): Promise<Permissions> {
    if (this.session === "wayland") throw waylandRestrictedError("input", { session: this.session });
    return super.permissions(signal);
  }
}

export function createLinuxAdapter(options: AdapterOptions = {}): LinuxDesktopAdapter {
  return new LinuxDesktopAdapter(options);
}

export const createLinuxDesktopAdapter = createLinuxAdapter;
