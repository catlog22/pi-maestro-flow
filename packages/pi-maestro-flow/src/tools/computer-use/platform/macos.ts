import type { CapabilityMap } from "../types.ts";
import { capabilityAvailable, capabilityUnavailable } from "./index.ts";
import { BaseDesktopAdapter, explicitPermissions, optionalRequire, type AdapterOptions } from "./base.ts";

function macosCapabilities(options: AdapterOptions): CapabilityMap {
  const load = options.requireOptional ?? optionalRequire;
  const screenshot = load("screenshot-desktop") !== undefined;
  const activeWin = load("active-win") !== undefined;
  return {
    screen_capture: screenshot ? { state: "degraded", provider: "screenshot-desktop", reason: "Screen Recording permission and protected windows must be probed", errorCode: "PERMISSION_REQUIRED" } : capabilityUnavailable("screenshot-desktop is not installed"),
    window_capture: capabilityUnavailable("No verified CGWindowList capture bridge is configured", "Configure a signed Screen Recording bridge."),
    window_list: activeWin ? capabilityAvailable("active-win") : capabilityUnavailable("active-win is not installed"),
    window_control: capabilityUnavailable("No verified Accessibility activation bridge is configured"),
    accessibility: capabilityUnavailable("Accessibility permission/AX bridge is not configured", "Grant Accessibility permission to the checked-in AX bridge, then re-probe."),
    input: capabilityUnavailable("No verified CoreGraphics input bridge is configured"),
    keyboard: capabilityUnavailable("No verified macOS keyboard bridge is configured"),
    clipboard: capabilityUnavailable("No verified NSPasteboard bridge is configured"),
    ocr: capabilityUnavailable("Vision is provided by the separate computer-use vision service"),
    detect: capabilityUnavailable("OmniParser is unverified_missing; no detector is claimed"),
  };
}

/** macOS adapter. Retina transforms are supplied by display probes/hooks; no guessed scale is used. */
export class MacOSDesktopAdapter extends BaseDesktopAdapter {
  constructor(options: AdapterOptions = {}) {
    super("darwin", "aqua", macosCapabilities(options), options);
  }

  async permissions(signal?: AbortSignal) {
    if (this.hooks.permissions) return super.permissions(signal);
    return explicitPermissions({
      screen_capture: { state: "unknown", reason: "Screen Recording permission requires a verified CGWindowList probe." },
      accessibility: { state: "unknown", reason: "Accessibility permission requires a verified AX probe." },
      input: { state: "unknown", reason: "CoreGraphics input bridge is not configured." },
      window_control: { state: "unknown", reason: "AX activation bridge is not configured." },
    }, "macOS Accessibility and Screen Recording permissions are not verified");
  }
}

export const MacDesktopAdapter = MacOSDesktopAdapter;

export function createMacOSAdapter(options: AdapterOptions = {}): MacOSDesktopAdapter {
  return new MacOSDesktopAdapter(options);
}

export const createMacosAdapter = createMacOSAdapter;
