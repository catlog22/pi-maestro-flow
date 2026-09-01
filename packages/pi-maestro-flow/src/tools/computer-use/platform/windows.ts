import { setTimeout as delay } from "node:timers/promises";
import { cropPng, detectBlankFrame, inspectPng } from "../artifacts.ts";
import { ComputerUseError, type CapabilityMap, type CapturedFrame, type ControlNode, type DisplayInfo, type Permissions, type PhysicalPoint, type PhysicalRect, type PointerActionResult, type WindowInfo } from "../types.ts";
import type { AccessibilityAdapter, AccessibilityQuery, CaptureRequest, FindControlQuery, KeyboardRequest, PointerRequest, TypeRequest, WindowQuery } from "./types.ts";
import { BaseDesktopAdapter, explicitPermissions, optionalRequire, normalizeRect, numberProperty, record, stringProperty, type AdapterOptions, type NativeHooks } from "./base.ts";
import { capabilityAvailable, capabilityUnavailable } from "./index.ts";
import { runBridgeProcess } from "./bridge-process.ts";
import { resolvePackageOrWorkspaceResource } from "../../../resources/maestro-package.ts";

interface WindowsRuntime {
  readonly platform: "win32" | "darwin" | "linux";
  readonly activeWin: unknown;
  readonly screenshot: unknown;
  readonly windowManager: unknown;
  readonly nut: unknown;
  readonly bridgeScript?: string;
  readonly pythonExecutable: string;
}

interface BridgeEnvelope {
  ok?: unknown;
  [key: string]: unknown;
}

function objectLike(value: unknown): Record<string, unknown> | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function") ? value as Record<string, unknown> : undefined;
}

function property(value: unknown, key: string): unknown {
  return objectLike(value)?.[key];
}

function method(value: unknown, key: string, ...args: unknown[]): unknown {
  const candidate = property(value, key);
  if (typeof candidate !== "function") return undefined;
  return (candidate as (...values: unknown[]) => unknown).apply(value, args);
}

function hasMethod(value: unknown, key: string): boolean {
  return typeof property(value, key) === "function";
}

function moduleValue(value: unknown, key: string): unknown {
  const nested = property(value, key);
  return nested ?? value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && typeof property(value, "then") === "function");
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorFor(capability: "screen_capture" | "window_capture" | "window_list" | "window_control" | "accessibility" | "input" | "keyboard" | "clipboard", message: string, code: "DEPENDENCY_UNAVAILABLE" | "CAPTURE_RESTRICTED" | "INVALID_IMAGE" | "WINDOW_NOT_FOUND" | "FOREGROUND_NOT_VERIFIED" | "STALE_CONTROL_REF" = "DEPENDENCY_UNAVAILABLE"): ComputerUseError {
  return new ComputerUseError({ code, message, capability, retryable: false, remediation: "Install/probe the supported native provider and re-check computer-use capabilities." });
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ComputerUseError({ code: "ABORTED", message: "Computer-use operation was aborted", retryable: false });
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "binary"));
  throw errorFor("screen_capture", "Capture provider returned unsupported data", "CAPTURE_RESTRICTED");
}

function finiteRect(rect: PhysicalRect): PhysicalRect {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw errorFor("input", "Physical rectangle must have finite positive dimensions", "INVALID_IMAGE");
  }
  return rect;
}

function normalizeWindow(value: unknown): WindowInfo | null {
  const object = record(value);
  if (!object) return null;
  const bounds = normalizeRect(object.bounds ?? object.position);
  if (!bounds) return null;
  const owner = record(object.owner);
  const idValue = object.id ?? object.windowId ?? object.handle;
  if (typeof idValue !== "string" && typeof idValue !== "number") return null;
  return {
    id: String(idValue),
    title: stringProperty(object, "title") ?? "",
    app: stringProperty(object, "app") ?? stringProperty(owner, "name") ?? "",
    pid: numberProperty(object, "pid") ?? numberProperty(owner, "processId") ?? null,
    active: object.active === true,
    minimized: typeof object.minimized === "boolean" ? object.minimized : null,
    bounds,
    clientBounds: normalizeRect(object.clientBounds),
  };
}

function matchesWindow(window: WindowInfo, query?: WindowQuery): boolean {
  if (!query) return true;
  return (query.title === undefined || window.title.includes(query.title))
    && (query.app === undefined || window.app.includes(query.app))
    && (query.visibleOnly !== true || window.minimized !== true);
}

function managerObject(runtime: WindowsRuntime): unknown {
  return moduleValue(runtime.windowManager, "windowManager");
}

function managerWindows(runtime: WindowsRuntime): unknown[] {
  const raw = method(managerObject(runtime), "getWindows");
  return Array.isArray(raw) ? raw : [];
}

function windowHandle(value: unknown): string | undefined {
  const id = property(value, "id");
  return typeof id === "number" || typeof id === "string" ? String(id) : undefined;
}

function findManagedWindow(runtime: WindowsRuntime, id: string): unknown {
  return managerWindows(runtime).find((candidate) => windowHandle(candidate) === id);
}

function activeWindowId(runtime: WindowsRuntime): string | undefined {
  const active = method(runtime.activeWin, "activeWindowSync");
  const activeObject = record(active);
  const activeId = activeObject?.id ?? activeObject?.windowId ?? activeObject?.handle;
  if (typeof activeId === "number" || typeof activeId === "string") return String(activeId);
  const managed = method(managerObject(runtime), "getActiveWindow");
  return windowHandle(managed);
}

async function foregroundVerified(runtime: WindowsRuntime, windowId: string): Promise<boolean> {
  const activeId = activeWindowId(runtime);
  return activeId === windowId;
}

function nativeProviderCapabilities(options: AdapterOptions, bridgeEnabled = true, platform: "win32" | "darwin" | "linux" = "win32"): { activeWin: boolean; screenshot: boolean; windowManager: boolean; nut: boolean; bridge: boolean } {
  const load = options.requireOptional ?? optionalRequire;
  const activeWin = load("active-win");
  const screenshot = load("screenshot-desktop");
  const windowManagerModule = platform === "linux" ? undefined : load("node-window-manager");
  const windowManager = managerObject({ activeWin: undefined, screenshot: undefined, windowManager: windowManagerModule, nut: undefined, pythonExecutable: "", platform });
  const nut = load("@nut-tree-fork/nut-js");
  const nutMouse = property(nut, "mouse");
  const nutKeyboard = property(nut, "keyboard");
  const nutClipboard = property(nut, "clipboard");
  return {
    activeWin: hasMethod(activeWin, "openWindows"),
    screenshot: typeof screenshot === "function" || hasMethod(screenshot, "default"),
    windowManager: hasMethod(windowManager, "getWindows") && (hasMethod(windowManager, "getActiveWindow") || hasMethod(windowManager, "getMonitors")),
    nut: hasMethod(nutMouse, "setPosition") && hasMethod(nutMouse, "getPosition") && (hasMethod(nutMouse, "leftClick") || hasMethod(nutMouse, "click")) && hasMethod(nutKeyboard, "pressKey") && hasMethod(nutKeyboard, "type") && hasMethod(nutClipboard, "setContent") && hasMethod(nutClipboard, "getContent"),
    bridge: bridgeEnabled && resolvePackageOrWorkspaceResource(["optional", "computer-use-windows-bridge.py"]) !== undefined,
  };
}

function windowsCapabilities(options: AdapterOptions, bridgeEnabled = true, capabilitiesOverride?: CapabilityMap, platform: "win32" | "darwin" | "linux" = "win32"): CapabilityMap {
  if (capabilitiesOverride) return capabilitiesOverride;
  const providers = nativeProviderCapabilities(options, bridgeEnabled, platform);
  return {
    screen_capture: providers.screenshot ? { state: "degraded", provider: "screenshot-desktop", reason: "Provider availability is known; protected or blank frames remain errors", errorCode: "CAPTURE_RESTRICTED" } : capabilityUnavailable("screenshot-desktop is not installed"),
    window_capture: providers.screenshot && platform === "win32" && providers.bridge
      ? { state: "degraded", provider: "screenshot-desktop+bounded-png-crop", reason: "Window capture requires a verified Windows client-bounds probe" }
      : capabilityUnavailable("Verified client bounds are required for window capture; use screen/region capture instead"),
    window_list: providers.activeWin ? capabilityAvailable("active-win") : capabilityUnavailable("active-win is not installed or openWindows is unavailable"),
    window_control: providers.windowManager ? capabilityAvailable("node-window-manager") : capabilityUnavailable("node-window-manager is not installed or foreground APIs are unavailable"),
    accessibility: providers.bridge
      ? { state: "degraded", provider: "pywinauto-uia", reason: "The checked-in bridge is available; Python dependency and UIA access are probed per operation" }
      : bridgeEnabled ? capabilityUnavailable("The checked-in Windows UIA bridge is missing") : capabilityUnavailable("No platform accessibility bridge is configured"),
    input: providers.nut ? capabilityAvailable("@nut-tree-fork/nut-js") : capabilityUnavailable("@nut-tree-fork/nut-js mouse provider is unavailable"),
    keyboard: providers.nut ? capabilityAvailable("@nut-tree-fork/nut-js") : capabilityUnavailable("@nut-tree-fork/nut-js keyboard provider is unavailable"),
    clipboard: providers.nut ? capabilityAvailable("@nut-tree-fork/nut-js") : capabilityUnavailable("@nut-tree-fork/nut-js clipboard provider is unavailable"),
    ocr: capabilityUnavailable("Vision is provided by the separate computer-use vision service", "Supply an image to the vision service."),
    detect: capabilityUnavailable("OmniParser is unverified_missing; no detector is claimed"),
  };
}

function createRuntime(options: AdapterOptions, bridgeEnabled = true, platform: "win32" | "darwin" | "linux" = "win32"): WindowsRuntime {
  const load = options.requireOptional ?? optionalRequire;
  return {
    platform,
    activeWin: load("active-win"),
    screenshot: load("screenshot-desktop"),
    windowManager: platform === "linux" ? undefined : load("node-window-manager"),
    nut: load("@nut-tree-fork/nut-js"),
    bridgeScript: bridgeEnabled ? resolvePackageOrWorkspaceResource(["optional", "computer-use-windows-bridge.py"]) : undefined,
    pythonExecutable: options.env?.PI_COMPUTER_USE_PYTHON?.trim() || "python",
  };
}

async function listWindows(runtime: WindowsRuntime, query?: WindowQuery, signal?: AbortSignal): Promise<WindowInfo[]> {
  abortIfNeeded(signal);
  const result = method(runtime.activeWin, "openWindows");
  if (!isPromiseLike(result) && !Array.isArray(result)) throw errorFor("window_list", "active-win openWindows export is unavailable");
  const raw = await result as unknown;
  if (!Array.isArray(raw)) throw errorFor("window_list", "active-win returned an invalid window list");
  const currentId = activeWindowId(runtime);
  const windows: WindowInfo[] = [];
  for (const [index, item] of raw.entries()) {
    abortIfNeeded(signal);
    const normalized = normalizeWindow(item);
    if (!normalized) continue;
    const id = normalized.id;
    const clientBounds = normalized.clientBounds ?? (/^\d+$/.test(id) ? await bridgeWindowBounds(runtime, id, signal) : null);
    const window = { ...normalized, clientBounds, active: currentId ? currentId === id : normalized.active || index === 0 };
    if (matchesWindow(window, query)) windows.push(window);
  }
  return windows;
}

async function activateWindow(runtime: WindowsRuntime, windowId: string, signal?: AbortSignal): Promise<{ window: WindowInfo; foregroundVerified: boolean }> {
  abortIfNeeded(signal);
  const target = findManagedWindow(runtime, windowId);
  if (!target) throw errorFor("window_control", `Window not found: ${windowId}`, "WINDOW_NOT_FOUND");
  method(target, "show");
  method(target, "restore");
  if (hasMethod(target, "bringToTop")) method(target, "bringToTop");
  else if (hasMethod(target, "focus")) method(target, "focus");
  await wait(50, signal);
  const verified = await foregroundVerified(runtime, windowId);
  const windows = await listWindows(runtime, {}, signal);
  const window = windows.find((candidate) => candidate.id === windowId);
  if (!window) throw errorFor("window_list", `Activated window disappeared: ${windowId}`, "WINDOW_NOT_FOUND");
  return { window: { ...window, active: verified || window.active }, foregroundVerified: verified };
}

async function displays(runtime: WindowsRuntime, signal?: AbortSignal): Promise<DisplayInfo[]> {
  abortIfNeeded(signal);
  const screenshotDisplays = method(runtime.screenshot, "listDisplays");
  const resolvedDisplays = isPromiseLike(screenshotDisplays) ? await screenshotDisplays : screenshotDisplays;
  const rawDisplays: unknown[] = Array.isArray(resolvedDisplays) ? resolvedDisplays : [];
  const managerMonitors = method(managerObject(runtime), "getMonitors");
  const monitors = Array.isArray(managerMonitors) ? managerMonitors : [];
  const result: DisplayInfo[] = [];
  const count = Math.max(rawDisplays.length, monitors.length);
  for (let index = 0; index < count; index++) {
    const raw = record(rawDisplays[index]);
    const monitor = monitors[index];
    const monitorBounds = normalizeRect(method(monitor, "getBounds"));
    const scale = asNumber(method(monitor, "getScaleFactor")) ?? 1;
    const logicalBounds = monitorBounds;
    const bounds = logicalBounds ? { x: Math.round(logicalBounds.x * scale), y: Math.round(logicalBounds.y * scale), width: Math.round(logicalBounds.width * scale), height: Math.round(logicalBounds.height * scale) } : normalizeRect(raw?.bounds ?? (raw && typeof raw.width === "number" && typeof raw.height === "number" ? { x: raw.offsetX ?? 0, y: raw.offsetY ?? 0, width: raw.width, height: raw.height } : undefined));
    if (!bounds) continue;
    const idValue = raw?.id ?? raw?.name ?? index;
    if (typeof idValue !== "string" && typeof idValue !== "number") continue;
    result.push({ id: String(idValue), bounds, ...(monitor && method(monitor, "isPrimary") === true || raw?.primary === true || index === 0 ? { primary: true } : {}), ...(scale !== 1 ? { logicalToPhysicalScale: scale, scale } : {}) });
  }
  if (result.length > 0) return result;
  const screen = property(runtime.nut, "screen");
  const width = await numericScreenValue(screen, "width");
  const height = await numericScreenValue(screen, "height");
  if (width !== undefined && height !== undefined) return [{ id: "primary", bounds: { x: 0, y: 0, width, height }, primary: true }];
  throw errorFor("screen_capture", "No verified physical display bounds are available");
}

async function numericScreenValue(screen: unknown, key: string): Promise<number | undefined> {
  const value = method(screen, key);
  const resolved = isPromiseLike(value) ? await value : value;
  return asNumber(resolved);
}

async function capture(runtime: WindowsRuntime, request: CaptureRequest, signal?: AbortSignal): Promise<CapturedFrame> {
  abortIfNeeded(signal);
  const screenshot = typeof runtime.screenshot === "function" ? runtime.screenshot : property(runtime.screenshot, "default");
  if (typeof screenshot !== "function") throw errorFor("screen_capture", "screenshot-desktop capture export is unavailable");
  const requestedWindow = request.source === "window" && request.windowId ? (await listWindows(runtime, {}, signal)).find((candidate) => candidate.id === request.windowId) : undefined;
  if (request.source === "window" && !requestedWindow) throw errorFor("window_list", `Window not found: ${request.windowId ?? ""}`, "WINDOW_NOT_FOUND");
  if (request.source === "window" && !requestedWindow?.clientBounds) throw errorFor("window_capture", "Client bounds are unavailable; refusing to label an outer-window crop as a client capture");
  const requestedRegion = request.source === "region" ? finiteRect(request.region as PhysicalRect) : requestedWindow?.clientBounds;
  let availableDisplays: DisplayInfo[] = [];
  try { availableDisplays = await displays(runtime, signal); } catch (error) { if (request.source !== "screen") throw error; }
  const display = chooseDisplay(availableDisplays, request.displayId, requestedRegion ?? undefined);
  if (request.displayId && !display) throw errorFor("screen_capture", `Display not found: ${request.displayId}`);
  const screenOption = display && display.id !== "primary" ? (runtime.platform === "darwin" && /^\d+$/.test(display.id) ? Number(display.id) : display.id) : undefined;
  const raw = await (screenshot as (...args: unknown[]) => unknown)({ format: "png", ...(screenOption !== undefined ? { screen: screenOption } : {}) });
  const fullBytes = toBytes(raw);
  const fullHeader = inspectPng(fullBytes, { maxBytes: 16 * 1024 * 1024 });
  if (detectBlankFrame(fullBytes, { maxBytes: 16 * 1024 * 1024 }).blank) throw new ComputerUseError({ code: "BLANK_FRAME", message: "Capture provider returned a blank frame", capability: "screen_capture", retryable: true });
  const origin = display?.bounds ? { x: display.bounds.x, y: display.bounds.y } : { x: 0, y: 0 };
  if (!requestedRegion) return { image: { mimeType: "image/png", width: fullHeader.width, height: fullHeader.height, origin, coordinateSpace: "screen_physical", source: "screen", backend: "screenshot-desktop", ...(display ? { displayId: display.id } : {}) }, bytes: fullBytes, capturedAt: Date.now() };
  const crop = { x: requestedRegion.x - origin.x, y: requestedRegion.y - origin.y, width: requestedRegion.width, height: requestedRegion.height };
  const cropped = cropPng(fullBytes, crop);
  const header = inspectPng(cropped, { maxBytes: 16 * 1024 * 1024 });
  const source = request.source;
  return {
    image: { mimeType: "image/png", width: header.width, height: header.height, origin: { x: requestedRegion.x, y: requestedRegion.y }, coordinateSpace: source === "window" ? "window_client_physical" : "screen_physical", source, backend: "screenshot-desktop+bounded-png-crop", ...(request.windowId ? { windowId: request.windowId } : {}), ...(display ? { displayId: display.id } : {}) },
    bytes: cropped,
    capturedAt: Date.now(),
    ...(requestedWindow ? { window: requestedWindow, ...(requestedWindow.clientBounds ? { clientBounds: requestedWindow.clientBounds } : {}) } : {}),
  };
}

function chooseDisplay(displays: DisplayInfo[], displayId: string | undefined, region: PhysicalRect | undefined): DisplayInfo | undefined {
  if (displayId) return displays.find((display) => display.id === displayId);
  if (region) {
    const center = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
    return displays.find((display) => center.x >= display.bounds.x && center.x < display.bounds.x + display.bounds.width && center.y >= display.bounds.y && center.y < display.bounds.y + display.bounds.height);
  }
  return displays.find((display) => display.primary) ?? displays[0];
}

function nutPart(runtime: WindowsRuntime, key: string): unknown {
  return property(runtime.nut, key);
}

function buttonValue(runtime: WindowsRuntime, name: "LEFT" | "RIGHT"): unknown {
  return property(property(runtime.nut, "Button"), name);
}

function keyValue(runtime: WindowsRuntime, name: string): unknown {
  const keyEnum = property(runtime.nut, "Key");
  const normalized = name.trim().toLowerCase().replace(/[ _-]/g, "");
  const aliases: Record<string, string> = {
    esc: "Escape", escape: "Escape", enter: "Enter", return: "Return", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete",
    ctrl: "LeftControl", control: "LeftControl", shift: "LeftShift", alt: "LeftAlt", option: "LeftAlt", win: "LeftWin", windows: "LeftWin", cmd: "LeftCmd", command: "LeftCmd",
    left: "Left", right: "Right", up: "Up", down: "Down", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End", insert: "Insert",
  };
  const canonical = aliases[normalized] ?? (normalized.length === 1 ? normalized.toUpperCase() : `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`);
  const value = property(keyEnum, canonical);
  if (typeof value !== "number") throw errorFor("keyboard", `Unsupported key: ${name}`, "DEPENDENCY_UNAVAILABLE");
  return value;
}

function expandKeys(keys: readonly string[]): string[] {
  return keys.flatMap((key) => key.split("+").map((part) => part.trim()).filter(Boolean));
}

function pointFrom(value: unknown): PhysicalPoint | null {
  const object = record(value);
  const x = asNumber(object?.x);
  const y = asNumber(object?.y);
  return x !== undefined && y !== undefined ? { x, y } : null;
}

async function ensureMousePosition(mouse: unknown, expected: PhysicalPoint): Promise<void> {
  if (!hasMethod(mouse, "getPosition")) throw errorFor("input", "nut-js mouse.getPosition is unavailable");
  let observed: PhysicalPoint | null;
  try {
    observed = pointFrom(await callAsync(mouse, "getPosition"));
  } catch (error) {
    throw errorFor("input", `Mouse position verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!observed || Math.abs(observed.x - expected.x) > 1 || Math.abs(observed.y - expected.y) > 1) {
    throw errorFor("input", `Mouse provider did not reach the requested physical point; expected (${expected.x},${expected.y}), observed ${observed ? `(${observed.x},${observed.y})` : "unknown"}`, "FOREGROUND_NOT_VERIFIED");
  }
}

async function pointer(runtime: WindowsRuntime, request: PointerRequest, point: PhysicalPoint, signal?: AbortSignal): Promise<PointerActionResult> {
  abortIfNeeded(signal);
  const mouse = nutPart(runtime, "mouse");
  if (!hasMethod(mouse, "setPosition")) throw errorFor("input", "nut-js mouse.setPosition is unavailable");
  await callAsync(mouse, "setPosition", { x: point.x, y: point.y });
  await ensureMousePosition(mouse, point);
  if (request.action === "click") {
    if (!hasMethod(mouse, "leftClick") && !hasMethod(mouse, "click")) throw errorFor("input", "nut-js left-click provider is unavailable");
    await callAsync(mouse, hasMethod(mouse, "leftClick") ? "leftClick" : "click");
  } else if (request.action === "double_click") {
    if (!hasMethod(mouse, "doubleClick")) throw errorFor("input", "nut-js double-click provider is unavailable");
    await callAsync(mouse, "doubleClick");
  } else if (request.action === "right_click") {
    if (!hasMethod(mouse, "rightClick")) throw errorFor("input", "nut-js right-click provider is unavailable");
    await callAsync(mouse, "rightClick");
  }
  await ensureMousePosition(mouse, point);
  return { resolvedPoint: point, foregroundVerified: await foregroundVerified(runtime, request.windowId), verification: unavailableVerification() };
}

async function press(runtime: WindowsRuntime, request: KeyboardRequest): Promise<{ keys: readonly string[]; foregroundVerified: boolean }> {
  const keyboard = nutPart(runtime, "keyboard");
  if (!hasMethod(keyboard, "pressKey")) throw errorFor("keyboard", "nut-js keyboard.pressKey is unavailable");
  const values = expandKeys(request.keys).map((key) => keyValue(runtime, key));
  await callAsync(keyboard, "pressKey", ...values);
  return { keys: request.keys, foregroundVerified: await foregroundVerified(runtime, request.windowId) };
}

async function releaseKeys(runtime: WindowsRuntime, _windowId: string, keys: readonly string[]): Promise<void> {
  const keyboard = nutPart(runtime, "keyboard");
  if (!hasMethod(keyboard, "releaseKey")) return;
  const values = expandKeys(keys).map((key) => keyValue(runtime, key));
  await callAsync(keyboard, "releaseKey", ...values);
}

async function typeText(runtime: WindowsRuntime, request: TypeRequest): Promise<{ characters: number; foregroundVerified: boolean }> {
  const keyboard = nutPart(runtime, "keyboard");
  if (!hasMethod(keyboard, "type")) throw errorFor("keyboard", "nut-js keyboard.type is unavailable");
  const config = record(property(keyboard, "config"));
  const previousDelay = asNumber(config?.autoDelayMs);
  if (config && request.intervalMs !== undefined && Number.isFinite(request.intervalMs) && request.intervalMs >= 0) config.autoDelayMs = request.intervalMs;
  try {
    await callAsync(keyboard, "type", request.text);
  } finally {
    if (config && previousDelay !== undefined) config.autoDelayMs = previousDelay;
  }
  return { characters: request.text.length, foregroundVerified: await foregroundVerified(runtime, request.windowId) };
}

async function pasteText(runtime: WindowsRuntime, request: TypeRequest): Promise<{ characters: number; clipboardRestored: boolean; foregroundVerified: boolean }> {
  const clipboard = nutPart(runtime, "clipboard");
  const keyboard = nutPart(runtime, "keyboard");
  if (!hasMethod(clipboard, "getContent") || !hasMethod(clipboard, "setContent") || !hasMethod(keyboard, "pressKey") || !hasMethod(keyboard, "releaseKey")) throw errorFor("clipboard", "nut-js clipboard or keyboard provider is unavailable");
  const previous = await callAsync(clipboard, "getContent");
  if (typeof previous !== "string") throw errorFor("clipboard", "Clipboard provider did not return restorable text");
  await callAsync(clipboard, "setContent", request.text);
  let restored = false;
  try {
    await callAsync(keyboard, "pressKey", keyValue(runtime, runtime.platform === "darwin" ? "cmd" : "ctrl"), keyValue(runtime, "v"));
    await callAsync(keyboard, "releaseKey", keyValue(runtime, "v"), keyValue(runtime, runtime.platform === "darwin" ? "cmd" : "ctrl"));
  } finally {
    await callAsync(clipboard, "setContent", previous).then(() => { restored = true; });
  }
  return { characters: request.text.length, clipboardRestored: restored, foregroundVerified: await foregroundVerified(runtime, request.windowId) };
}

function unavailableVerification(): PointerActionResult["verification"] {
  return { changedPixels: 0, totalPixels: 0, changePercent: 0, verdict: "unavailable", foregroundChanged: true, requiresReprobe: false };
}

async function callAsync(value: unknown, key: string, ...args: unknown[]): Promise<unknown> {
  const result = method(value, key, ...args);
  return isPromiseLike(result) ? result : result;
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  await delay(milliseconds);
  abortIfNeeded(signal);
}

async function bridgeWindowBounds(runtime: WindowsRuntime, windowId: string, signal?: AbortSignal): Promise<PhysicalRect | null> {
  try {
    const payload = await runBridgeJson(runtime, "window", ["--hwnd", windowId], signal);
    return normalizeRect(payload.clientBounds);
  } catch (error) {
    if (error instanceof ComputerUseError && error.code === "ABORTED") throw error;
    return null;
  }
}

async function runBridgeJson(runtime: WindowsRuntime, action: string, args: readonly string[], signal?: AbortSignal): Promise<BridgeEnvelope> {
  if (!runtime.bridgeScript) throw errorFor("accessibility", "Windows UIA bridge script is not packaged");
  const result = await runBridgeProcess({ executable: runtime.pythonExecutable, argv: [runtime.bridgeScript, "--action", action, ...args] }, { signal, timeoutMs: action === "ui-tree" ? 10_000 : 5_000, maxStdoutBytes: 8 * 1024 * 1024, maxStderrBytes: 256 * 1024 });
  const lines = Buffer.from(result.stdout).toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const raw = lines.at(-1);
  if (!raw) throw errorFor("accessibility", "Windows UIA bridge returned no JSON output");
  let payload: BridgeEnvelope;
  try { payload = JSON.parse(raw) as BridgeEnvelope; } catch (error) { throw errorFor("accessibility", `Windows UIA bridge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (payload.ok !== true) throw bridgeFailure(payload);
  return payload;
}

function bridgeFailure(payload: BridgeEnvelope): ComputerUseError {
  const code = asString(payload.code) ?? "UIA_OPERATION_FAILED";
  const message = asString(payload.message) ?? "Windows UIA bridge operation failed";
  if (code === "STALE_CONTROL_REF") return errorFor("accessibility", message, "STALE_CONTROL_REF");
  if (code === "INVALID_INPUT") return errorFor("accessibility", message);
  return errorFor("accessibility", message);
}

function normalizeControl(value: unknown): ControlNode | null {
  const object = record(value);
  if (!object || typeof object.ref !== "string" || typeof object.windowId !== "string") return null;
  const rawValue = object.value;
  const controlValue = typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean" ? rawValue : null;
  const actions = Array.isArray(object.actions) ? object.actions.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    ref: object.ref,
    windowId: object.windowId,
    role: asString(object.role) ?? "unknown",
    name: asString(object.name) ?? null,
    title: asString(object.title) ?? null,
    identifier: asString(object.identifier) ?? null,
    value: controlValue,
    enabled: typeof object.enabled === "boolean" ? object.enabled : null,
    focused: typeof object.focused === "boolean" ? object.focused : null,
    offscreen: typeof object.offscreen === "boolean" ? object.offscreen : null,
    bounds: normalizeRect(object.bounds),
    actions,
  };
}

class WindowsAccessibility implements AccessibilityAdapter {
  readonly name = "pywinauto-uia";
  private readonly runtime: WindowsRuntime;

  constructor(runtime: WindowsRuntime) {
    this.runtime = runtime;
  }

  async uiTree(request: AccessibilityQuery, signal?: AbortSignal): Promise<{ snapshotId: string; controls: ControlNode[] }> {
    const args = ["--hwnd", requireNumericWindowId(request.windowId), "--max-depth", String(Math.min(32, Math.max(0, request.maxDepth ?? 8))), ...(request.includeOffscreen ? ["--include-offscreen"] : [])];
    const payload = await runBridgeJson(this.runtime, "ui-tree", args, signal);
    const controls = Array.isArray(payload.controls) ? payload.controls.map(normalizeControl).filter((control): control is ControlNode => control !== null) : [];
    return { snapshotId: asString(payload.snapshotId) ?? `uia-${Date.now()}`, controls };
  }

  async findControl(request: FindControlQuery, signal?: AbortSignal): Promise<{ snapshotId: string; matches: ControlNode[] }> {
    const tree = await this.uiTree({ windowId: request.windowId, maxDepth: 12 }, signal);
    const query = request.query.trim().toLowerCase();
    const matches = tree.controls.filter((control) => {
      if (request.enabledOnly && control.enabled !== true) return false;
      return [control.name, control.title, control.identifier, control.role, control.ref, control.value === null ? null : String(control.value)].filter(Boolean).some((value) => value!.toLowerCase().includes(query));
    }).slice(0, Math.max(1, Math.min(200, request.maxResults ?? 50)));
    return { snapshotId: tree.snapshotId, matches };
  }

  async pressControl(windowId: string, controlRef: string, signal?: AbortSignal): Promise<{ method: "semantic" | "physical_fallback"; control: ControlNode }> {
    const tree = await this.uiTree({ windowId }, signal);
    const control = tree.controls.find((candidate) => candidate.ref === controlRef);
    if (!control) throw new ComputerUseError({ code: "STALE_CONTROL_REF", message: `Control reference is stale or unknown: ${controlRef}`, capability: "accessibility", retryable: false });
    const payload = await runBridgeJson(this.runtime, "press-control", ["--hwnd", requireNumericWindowId(windowId), "--ref", controlRef], signal);
    const methodName = payload.method === "physical_fallback" ? "physical_fallback" : "semantic";
    return { method: methodName, control };
  }
}

function requireNumericWindowId(windowId: string): string {
  if (!/^\d+$/.test(windowId)) throw errorFor("accessibility", `Windows UIA requires a numeric HWND, got ${windowId}`);
  return windowId;
}

function createHooks(runtime: WindowsRuntime, options: AdapterOptions): NativeHooks {
  return {
    ...options.hooks,
    listWindows: options.hooks?.listWindows ?? ((query, signal) => listWindows(runtime, query, signal)),
    activate: options.hooks?.activate ?? ((windowId, signal) => activateWindow(runtime, windowId, signal)),
    displays: options.hooks?.displays ?? ((signal) => displays(runtime, signal)),
    capture: options.hooks?.capture ?? ((request, signal) => capture(runtime, request, signal)),
    pointer: options.hooks?.pointer ?? ((request, point, signal) => pointer(runtime, request, point, signal)),
    press: options.hooks?.press ?? ((request) => press(runtime, request)),
    type: options.hooks?.type ?? ((request) => typeText(runtime, request)),
    paste: options.hooks?.paste ?? ((request) => pasteText(runtime, request)),
    accessibility: options.hooks?.accessibility ?? (runtime.bridgeScript ? new WindowsAccessibility(runtime) : undefined),
  };
}

/** Windows adapter with physical-coordinate, client-origin, and fail-closed native provider contracts. */
export class WindowsDesktopAdapter extends BaseDesktopAdapter {
  private readonly runtime: WindowsRuntime;

  constructor(
    options: AdapterOptions = {},
    platform: "win32" | "darwin" | "linux" = "win32",
    session: "x11" | "wayland" | "aqua" | "windows" | "unknown" = "windows",
    bridgeEnabled = platform === "win32",
    capabilitiesOverride?: CapabilityMap,
  ) {
    const runtime = createRuntime(options, bridgeEnabled, platform);
    super(platform, session, windowsCapabilities(options, bridgeEnabled, capabilitiesOverride, platform), { ...options, hooks: createHooks(runtime, options) });
    this.runtime = runtime;
  }

  async drag(request: PointerRequest & { to: PhysicalPoint }, signal?: AbortSignal): Promise<PointerActionResult> {
    const mouse = nutPart(this.runtime, "mouse");
    const left = buttonValue(this.runtime, "LEFT");
    if (!hasMethod(mouse, "setPosition") || !hasMethod(mouse, "pressButton") || !hasMethod(mouse, "releaseButton") || typeof left !== "number") throw errorFor("input", "nut-js drag provider is unavailable");
    await callAsync(mouse, "setPosition", request.point);
    await callAsync(mouse, "pressButton", left);
    try {
      await callAsync(mouse, "setPosition", request.to);
      return { resolvedPoint: request.point, foregroundVerified: await foregroundVerified(this.runtime, request.windowId), verification: unavailableVerification() };
    } finally {
      await callAsync(mouse, "releaseButton", left);
      abortIfNeeded(signal);
    }
  }

  async releaseKeys(_windowId: string, keys: readonly string[]): Promise<void> {
    await releaseKeys(this.runtime, _windowId, keys);
  }

  async releasePointer(_windowId: string): Promise<void> {
    // Drag releases its own button in a finally block; this hook is intentionally idempotent.
  }

  async permissions(signal?: AbortSignal): Promise<Permissions> {
    if (this.hooks.permissions) return super.permissions(signal);
    const providers = nativeProviderCapabilities({ requireOptional: this.requireOptional }, this.runtime.bridgeScript !== undefined, this.platform);
    const platformName = this.platform === "win32" ? "Windows" : this.platform === "darwin" ? "macOS" : "Linux";
    const accessibilityReason = providers.bridge
      ? "UI Automation access is probed per bridge operation."
      : this.platform === "win32" ? "The checked-in Windows UIA bridge is unavailable." : "No platform accessibility bridge is configured.";
    return explicitPermissions({
      screen_capture: { state: providers.screenshot ? "unknown" : "denied", reason: providers.screenshot ? `${platformName} capture is provider-dependent; the next frame validates access.` : "screenshot-desktop is not installed." },
      accessibility: { state: "unknown", reason: accessibilityReason },
      input: { state: providers.nut ? "unknown" : "denied", reason: providers.nut ? `${platformName} input provider is installed; foreground and policy checks remain required.` : "@nut-tree-fork/nut-js is not installed." },
      window_control: { state: providers.windowManager ? "unknown" : "denied", reason: providers.windowManager ? "Foreground activation is verified after each activation." : `${platformName} window activation provider is not installed.` },
    }, `${platformName} permission state is validated at the provider boundary`);
  }
}

export class NativeDesktopAdapter extends WindowsDesktopAdapter {
  constructor(
    platform: "win32" | "darwin" | "linux",
    session: "x11" | "wayland" | "aqua" | "windows" | "unknown",
    options: AdapterOptions = {},
    bridgeEnabled = false,
    capabilitiesOverride?: CapabilityMap,
  ) {
    super(options, platform, session, bridgeEnabled, capabilitiesOverride);
  }
}

export function createWindowsAdapter(options: AdapterOptions = {}): WindowsDesktopAdapter {
  return new WindowsDesktopAdapter(options);
}
