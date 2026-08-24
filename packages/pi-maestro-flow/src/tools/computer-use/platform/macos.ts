import { capabilityUnavailable } from "./index.ts";
import { NativeDesktopAdapter } from "./windows.ts";
import { optionalRequire, type AdapterOptions } from "./base.ts";

/** macOS native adapter. Screen Recording and Accessibility remain OS-permission gated. */
export class MacOSDesktopAdapter extends NativeDesktopAdapter {
  constructor(options: AdapterOptions = {}) {
    const load = options.requireOptional ?? optionalRequire;
    const screenshotInstalled = load("screenshot-desktop") !== undefined;
    super("darwin", "aqua", {
      ...options,
      capabilities: {
        ...options.capabilities,
        screen_capture: options.capabilities?.screen_capture ?? (screenshotInstalled ? { state: "degraded", provider: "screenshot-desktop", reason: "Screen Recording permission and protected windows must be probed", errorCode: "PERMISSION_REQUIRED" } : capabilityUnavailable("screenshot-desktop is not installed")),
      },
    }, false);
  }
}

export const MacDesktopAdapter = MacOSDesktopAdapter;

export function createMacOSAdapter(options: AdapterOptions = {}): MacOSDesktopAdapter {
  return new MacOSDesktopAdapter(options);
}

export const createMacosAdapter = createMacOSAdapter;
