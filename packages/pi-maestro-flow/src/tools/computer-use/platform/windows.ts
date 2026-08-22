import type { CapabilityMap } from "../types.ts";
import { capabilityAvailable, capabilityUnavailable } from "./index.ts";
import { BaseDesktopAdapter, explicitPermissions, optionalRequire, type AdapterOptions } from "./base.ts";

function windowsCapabilities(options: AdapterOptions): CapabilityMap {
  const load = options.requireOptional ?? optionalRequire;
  const screenshot = load("screenshot-desktop") !== undefined;
  const activeWin = load("active-win") !== undefined;
  return {
    screen_capture: screenshot ? { state: "degraded", provider: "screenshot-desktop", reason: "Provider availability is known; protected/blank frames remain errors", errorCode: "CAPTURE_RESTRICTED" } : capabilityUnavailable("screenshot-desktop is not installed"),
    window_capture: capabilityUnavailable("No verified PrintWindow or window capture bridge is configured", "Configure a signed Windows capture bridge."),
    window_list: activeWin ? capabilityAvailable("active-win") : capabilityUnavailable("active-win is not installed"),
    window_control: capabilityUnavailable("No verified foreground activation bridge is configured"),
    accessibility: capabilityUnavailable("No verified UI Automation bridge is configured", "Configure a signed UIA bridge using a fixed argv contract."),
    input: capabilityUnavailable("No verified Windows input bridge is configured"),
    keyboard: capabilityUnavailable("No verified Windows keyboard bridge is configured"),
    clipboard: capabilityUnavailable("No verified Windows clipboard bridge is configured"),
    ocr: capabilityUnavailable("Vision is provided by the separate computer-use vision service", "Supply an image to the vision service."),
    detect: capabilityUnavailable("OmniParser is unverified_missing; no detector is claimed"),
  };
}

/** Windows adapter with explicit client-origin/DPI contracts and fail-closed native actions. */
export class WindowsDesktopAdapter extends BaseDesktopAdapter {
  constructor(options: AdapterOptions = {}) {
    super("win32", "windows", windowsCapabilities(options), options);
  }

  async permissions(signal?: AbortSignal) {
    if (this.hooks.permissions) return super.permissions(signal);
    return explicitPermissions({
      screen_capture: { state: "unknown", reason: "Windows capture permission is not separately probeable; provider must verify the frame." },
      accessibility: { state: "unknown", reason: "UI Automation bridge is not configured." },
      input: { state: "unknown", reason: "Windows input bridge is not configured." },
      window_control: { state: "unknown", reason: "Foreground activation bridge is not configured." },
    }, "Windows native permission probes are unavailable");
  }
}

export function createWindowsAdapter(options: AdapterOptions = {}): WindowsDesktopAdapter {
  return new WindowsDesktopAdapter(options);
}
