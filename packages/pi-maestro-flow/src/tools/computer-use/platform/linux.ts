import { spawnSync } from "node:child_process";
import type { CapabilityMap, ComputerUseErrorInfo, DisplayInfo, Permissions, PointerActionResult, PhysicalPoint, WindowInfo } from "../types.ts";
import { ComputerUseError } from "../types.ts";
import { waylandCapabilities, waylandRestrictedError } from "./index.ts";
import { runBridgeProcess } from "./bridge-process.ts";
import { NativeDesktopAdapter } from "./windows.ts";
import type { AdapterOptions } from "./base.ts";
import type { AccessibilityAdapter, CaptureRequest, KeyboardRequest, PointerRequest, TypeRequest, WindowQuery } from "./types.ts";

function xdotoolCapability(): { state: "degraded" | "unavailable"; provider?: string; reason: string; errorCode?: "DEPENDENCY_UNAVAILABLE" } {
  try {
    const probe = spawnSync("xdotool", ["--version"], { stdio: "ignore", shell: false, windowsHide: true, timeout: 750 });
    if (probe.status === 0) return { state: "degraded", provider: "xdotool", reason: "X11 activation uses a fixed argv command and active-win foreground verification" };
  } catch {
    // The capability remains unavailable when the system executable is absent.
  }
  return { state: "unavailable", reason: "xdotool is not installed; X11 foreground activation is unavailable", errorCode: "DEPENDENCY_UNAVAILABLE" };
}

function restrictedAccessibility(): AccessibilityAdapter {
  const fail = async (): Promise<never> => { throw waylandRestrictedError("accessibility", { session: "wayland" }); };
  return {
    name: "wayland-restricted",
    uiTree: fail,
    findControl: fail,
    pressControl: fail,
  };
}
export function detectLinuxSession(env: NodeJS.ProcessEnv = process.env): "x11" | "wayland" | "unknown" {
  const session = (env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (session === "wayland" || Boolean(env.WAYLAND_DISPLAY)) return "wayland";
  if (session === "x11" || Boolean(env.DISPLAY)) return "x11";
  return "unknown";
}

/** Linux uses the shared native providers on X11; Wayland stays explicitly restricted. */
export class LinuxDesktopAdapter extends NativeDesktopAdapter {
  constructor(options: AdapterOptions = {}) {
    const session = options.session === "wayland" || options.session === "x11" || options.session === "unknown"
      ? options.session
      : detectLinuxSession(options.env ?? process.env);
    const restrictions: CapabilityMap | undefined = session === "wayland" ? waylandCapabilities().features : undefined;
    const capabilities = session === "wayland"
      ? options.capabilities
      : { ...options.capabilities, window_control: options.capabilities?.window_control ?? xdotoolCapability() };
    const hooks = session === "wayland" ? { ...options.hooks, accessibility: restrictedAccessibility() } : options.hooks;
    super("linux", session, { ...options, capabilities, hooks }, false, restrictions);
  }

  private ensureGlobalAllowed(): void {
    if (this.session === "wayland") throw waylandRestrictedError(undefined, { session: this.session });
  }

  override async listWindows(query?: WindowQuery, signal?: AbortSignal): Promise<WindowInfo[]> {
    this.ensureGlobalAllowed();
    return super.listWindows(query, signal);
  }

  override async activate(windowId: string, signal?: AbortSignal): Promise<{ window: WindowInfo; foregroundVerified: boolean }> {
    this.ensureGlobalAllowed();
    if (this.session !== "x11") return super.activate(windowId, signal);
    try {
      await runBridgeProcess(
        { executable: "xdotool", argv: ["windowactivate", "--sync", windowId] },
        { signal, timeoutMs: 2_000, maxStdoutBytes: 16 * 1024, maxStderrBytes: 64 * 1024 },
      );
    } catch (error) {
      if (error instanceof ComputerUseError) {
        const info: ComputerUseErrorInfo = {
          code: error.code,
          message: error.message,
          capability: "window_control",
          retryable: error.retryable,
          ...(error.remediation ? { remediation: error.remediation } : {}),
          ...(error.details ? { details: error.details } : {}),
        };
        throw new ComputerUseError(info);
      }
      throw new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: `xdotool window activation failed: ${error instanceof Error ? error.message : String(error)}`, capability: "window_control", retryable: false });
    }
    const windows = await super.listWindows({}, signal);
    const window = windows.find((candidate) => candidate.id === windowId);
    if (!window) throw new ComputerUseError({ code: "WINDOW_NOT_FOUND", message: `Window not found after xdotool activation: ${windowId}`, capability: "window_list", retryable: false });
    return { window, foregroundVerified: window.active };
  }

  override async displays(signal?: AbortSignal): Promise<DisplayInfo[]> {
    this.ensureGlobalAllowed();
    return super.displays(signal);
  }

  override async capture(request: CaptureRequest, signal?: AbortSignal) {
    this.ensureGlobalAllowed();
    return super.capture(request, signal);
  }

  override async pointer(request: PointerRequest, signal?: AbortSignal): Promise<PointerActionResult> {
    this.ensureGlobalAllowed();
    return super.pointer(request, signal);
  }

  async drag(request: PointerRequest & { to: PhysicalPoint }, signal?: AbortSignal): Promise<PointerActionResult> {
    this.ensureGlobalAllowed();
    return super.drag(request, signal);
  }

  override async press(request: KeyboardRequest, signal?: AbortSignal): Promise<{ keys: readonly string[]; foregroundVerified: boolean }> {
    this.ensureGlobalAllowed();
    return super.press(request, signal);
  }

  override async type(request: TypeRequest, signal?: AbortSignal): Promise<{ characters: number; foregroundVerified: boolean }> {
    this.ensureGlobalAllowed();
    return super.type(request, signal);
  }

  override async paste(request: TypeRequest, signal?: AbortSignal): Promise<{ characters: number; clipboardRestored: boolean; foregroundVerified: boolean }> {
    this.ensureGlobalAllowed();
    return super.paste(request, signal);
  }

  override async permissions(signal?: AbortSignal): Promise<Permissions> {
    if (this.session === "wayland") throw waylandRestrictedError("input", { session: this.session });
    const permissions = await super.permissions(signal);
    const activation = xdotoolCapability();
    return activation.state === "degraded"
      ? { ...permissions, window_control: { state: "unknown", reason: "xdotool is installed; active-win verifies the foreground window after activation." } }
      : permissions;
  }
}

export function createLinuxAdapter(options: AdapterOptions = {}): LinuxDesktopAdapter {
  return new LinuxDesktopAdapter(options);
}

export const createLinuxDesktopAdapter = createLinuxAdapter;
