import { randomUUID } from "node:crypto";
import type { Page } from "puppeteer-core";

export interface BrowserVideoChapterOptions {
  title: string;
  description?: string;
  duration?: number;
}

export interface BrowserVideoActionOptions {
  duration?: number;
  position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
  cursor?: "pointer" | "none";
}

type ActionOptions = Required<BrowserVideoActionOptions>;
type Point = { x: number; y: number; width?: number; height?: number };
type DecorationCommand =
  | { kind: "install"; options: ActionOptions }
  | { kind: "remove" }
  | { kind: "action"; label: string; point?: Point }
  | { kind: "end" }
  | { kind: "chapter"; title: string; description?: string }
  | { kind: "frames" }
  | { kind: "fade" }
  | { kind: "removeChapter" };

// This function runs both in the current document and as a new-document script.
function decorate(id: string, command: DecorationCommand): void | Promise<void> {
  if (window !== window.top) return;
  type State = {
    root: HTMLDivElement;
    shadow: ShadowRoot;
    options?: ActionOptions;
    listeners: Array<[string, EventListener]>;
    timer?: ReturnType<typeof setTimeout>;
    active: number;
    cleanup(): void;
  };
  const store = window as unknown as Record<string, State | undefined>;
  let state = store[id];
  if (command.kind === "remove") {
    state?.cleanup();
    delete store[id];
    return;
  }
  if (command.kind === "install" && state) {
    state.cleanup();
    delete store[id];
    state = undefined;
  }
  if (!state && (command.kind === "install" || command.kind === "chapter")) {
    const root = document.createElement("div");
    root.id = id;
    root.setAttribute("data-browser-video-presentation", "");
    root.setAttribute("aria-hidden", "true");
    root.inert = true;
    root.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;pointer-events:none!important;";
    const shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host,*{box-sizing:border-box;pointer-events:none!important}
      .label{position:absolute;max-width:calc(100% - 48px);padding:12px 18px;border-radius:10px;background:rgba(15,23,42,.94);color:white;font:600 18px/1.4 system-ui,sans-serif;box-shadow:0 4px 24px #0005;opacity:0;transition:opacity 100ms}
      .target{position:absolute;border:3px solid #60a5fa;border-radius:8px;background:#60a5fa22;opacity:0;transition:left 120ms,top 120ms,width 120ms,height 120ms,opacity 100ms}
      .cursor{position:absolute;left:0;top:0;width:20px;height:28px;background:white;clip-path:polygon(0 0,0 90%,28% 67%,47% 100%,65% 91%,47% 59%,84% 59%);filter:drop-shadow(1px 1px 2px black);opacity:0;transition:transform 160ms ease-out}
      .ripple{position:absolute;width:34px;height:34px;margin:-17px;border:3px solid #60a5fa;border-radius:50%;opacity:0}
      .ripple.pulse{animation:pulse 450ms ease-out}@keyframes pulse{from{opacity:1;transform:scale(.4)}to{opacity:0;transform:scale(2)}}
      .chapter{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:48px;background:rgba(15,23,42,.68);backdrop-filter:blur(12px);color:white;opacity:0;transition:opacity 140ms ease-in-out;font-family:system-ui,sans-serif}
      .chapter h1{font-size:clamp(28px,6vw,64px);line-height:1.15;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
      .chapter p{font-size:clamp(18px,2.6vw,30px);line-height:1.5;max-width:900px;margin:24px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
    `;
    shadow.append(style);
    const mount = () => { if (!root.isConnected) document.documentElement?.append(root); };
    const listeners: Array<[string, EventListener]> = [["DOMContentLoaded", mount]];
    document.addEventListener("DOMContentLoaded", mount, { once: true });
    state = { root, shadow, listeners, active: 0, cleanup() {
      clearTimeout(this.timer);
      for (const [name, listener] of this.listeners) document.removeEventListener(name, listener, true);
      document.removeEventListener("DOMContentLoaded", mount);
      this.root.remove();
    } };
    store[id] = state;
    mount();
  }
  if (!state) return;
  const current = state;
  const get = (name: string) => current.shadow.querySelector<HTMLDivElement>(`.${name}`);
  const hide = () => { for (const name of ["label", "target", "cursor"]) { const node = get(name); if (node) node.style.opacity = "0"; } };
  const show = (label: string | undefined, point?: Point, pulse = false) => {
    if (!current.options) return;
    clearTimeout(current.timer);
    const callout = get("label")!;
    if (label) callout.textContent = label;
    callout.style.opacity = "1";
    const highlight = get("target")!;
    const cursor = get("cursor")!;
    if (point) {
      highlight.style.left = `${point.x - (point.width ?? 20) / 2}px`;
      highlight.style.top = `${point.y - (point.height ?? 20) / 2}px`;
      highlight.style.width = `${point.width ?? 20}px`;
      highlight.style.height = `${point.height ?? 20}px`;
      highlight.style.opacity = "1";
      cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
      cursor.style.opacity = current.options.cursor === "pointer" ? "1" : "0";
      if (pulse) {
        const ripple = get("ripple")!;
        ripple.style.left = `${point.x}px`; ripple.style.top = `${point.y}px`;
        ripple.classList.remove("pulse");
        void ripple.offsetWidth;
        ripple.classList.add("pulse");
      }
    }
    current.timer = setTimeout(hide, current.options.duration);
  };
  if (command.kind === "install") {
    current.options = command.options;
    for (const name of ["label", "target", "cursor", "ripple"]) {
      const node = document.createElement("div"); node.className = name; current.shadow.append(node);
    }
    const label = get("label")!;
    const [vertical, horizontal] = command.options.position.split("-");
    label.style[vertical === "bottom" ? "bottom" : "top"] = "24px";
    if (horizontal === "left") label.style.left = "24px";
    else if (horizontal === "right") label.style.right = "24px";
    else { label.style.left = "50%"; label.style.transform = "translateX(-50%)"; }
    const labels: Record<string, string> = { pointermove: "Move pointer", pointerdown: "Click", click: "Click", keydown: "Press key", input: "Type", focusin: "Focus" };
    for (const name of Object.keys(labels)) {
      const listener: EventListener = (event) => {
        const target = event.composedPath()[0];
        let point: Point | undefined;
        if (target instanceof Element) {
          const box = target.getBoundingClientRect();
          point = { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height };
        }
        if (event instanceof PointerEvent && name === "pointermove") point = { x: event.clientX, y: event.clientY };
        show(current.active ? undefined : labels[name], point, name === "click" || name === "pointerdown");
      };
      document.addEventListener(name, listener, true);
      current.listeners.push([name, listener]);
    }
  } else if (command.kind === "action") {
    current.active++;
    show(command.label, command.point);
  } else if (command.kind === "end") {
    current.active = Math.max(0, current.active - 1);
    clearTimeout(current.timer);
    if (current.options) current.timer = setTimeout(hide, current.options.duration);
  } else if (command.kind === "chapter") {
    get("chapter")?.remove();
    const card = document.createElement("div"); card.className = "chapter";
    const title = document.createElement("h1"); title.textContent = command.title; card.append(title);
    if (command.description !== undefined) { const description = document.createElement("p"); description.textContent = command.description; card.append(description); }
    current.shadow.append(card);
  } else if (command.kind === "frames") {
    return new Promise<void>((resolve) => requestAnimationFrame(() => {
      const card = get("chapter"); if (card) card.style.opacity = "1";
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  } else if (command.kind === "fade") {
    const card = get("chapter"); if (card) card.style.opacity = "0";
  } else if (command.kind === "removeChapter") {
    get("chapter")?.remove();
    if (!current.options) { current.cleanup(); delete store[id]; }
  }
}

function optionsObject(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Browser video options must be an object.");
}
function duration(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2_147_483_647) throw new TypeError("Browser video duration must be a finite non-negative millisecond value.");
  return value;
}
function interrupted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
async function bounded<T>(work: Promise<T>, signal: AbortSignal | undefined, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupt = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason ?? new DOMException("Browser video operation aborted.", "AbortError"));
    timer = setTimeout(() => reject(new Error("Browser video presentation timed out.")), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try { return await Promise.race([work, interrupt]); }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Browser video operation aborted.", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class BrowserVideoPresentation {
  readonly #page: Page;
  readonly #id = `pi-browser-video-${randomUUID()}`;
  #script?: string;
  #removingScript?: Promise<void>;
  #enabled = false;
  #disposed = false;
  #chapter?: AbortController;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(page: Page) { this.#page = page; }

  #serialize(work: () => Promise<void>): Promise<void> {
    const operation = this.#pending.then(work);
    this.#pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #send(command: DecorationCommand, signal?: AbortSignal): Promise<void> {
    interrupted(signal);
    if (this.#page.isClosed()) return;
    try { await bounded(this.#page.evaluate(decorate, this.#id, command), signal, 5000); interrupted(signal); }
    catch (error) {
      // A departing document takes its overlay/listeners with it; the init script owns the next one.
      if (!this.#page.isClosed() && !/Execution context was destroyed|Cannot find context|Target closed|Session closed/.test(String(error))) throw error;
    }
  }

  async #removeScript(signal?: AbortSignal): Promise<void> {
    const id = this.#script;
    if (!id) return;
    if (!this.#page.isClosed()) {
      this.#removingScript ??= this.#page.removeScriptToEvaluateOnNewDocument(id);
      await bounded(this.#removingScript, signal, 5000);
    }
    this.#removingScript = undefined;
    if (this.#script === id) this.#script = undefined;
  }

  showActions(options: BrowserVideoActionOptions = {}, signal?: AbortSignal): Promise<void> {
    optionsObject(options);
    const positions = ["top-left", "top", "top-right", "bottom-left", "bottom", "bottom-right"];
    if (options.position !== undefined && !positions.includes(options.position)) throw new TypeError("Invalid browser video action position.");
    if (options.cursor !== undefined && options.cursor !== "pointer" && options.cursor !== "none") throw new TypeError("Invalid browser video action cursor.");
    const normalized: ActionOptions = { duration: duration(options.duration, 500), position: options.position ?? "top-right", cursor: options.cursor ?? "pointer" };
    return this.#serialize(async () => {
      interrupted(signal);
      if (this.#disposed) throw new Error("Browser video presentation is disposed.");
      if (this.#chapter) throw new Error("Cannot change action decorations during a chapter.");
      await bounded(this.#page.bringToFront(), signal, 5000);
      interrupted(signal);
      this.#enabled = false;
      await this.#removeScript(signal);
      interrupted(signal);
      const command: DecorationCommand = { kind: "install", options: normalized };
      const installing = this.#page.evaluateOnNewDocument(decorate, this.#id, command);
      let script: Awaited<typeof installing>;
      try { script = await bounded(installing, signal, 5000); }
      catch (error) {
        void installing.then((late) => this.#page.removeScriptToEvaluateOnNewDocument(late.identifier))
          .catch((failure) => console.warn(`[browser] Late video overlay cleanup failed: ${String(failure)}`));
        throw error;
      }
      this.#script = script.identifier;
      interrupted(signal);
      await this.#send({ kind: "install", options: normalized }, signal);
      interrupted(signal);
      this.#enabled = true;
    });
  }

  hideActions(signal?: AbortSignal): Promise<void> {
    return this.#serialize(async () => {
      interrupted(signal);
      this.#enabled = false;
      this.#chapter?.abort();
      await this.#send({ kind: "remove" }, signal);
      await this.#removeScript(signal);
      interrupted(signal);
    });
  }

  async chapter(options: BrowserVideoChapterOptions, signal?: AbortSignal): Promise<void> {
    optionsObject(options);
    if (typeof options.title !== "string" || !options.title.trim()) throw new TypeError("Browser video chapter title must be a non-empty string.");
    if (options.description !== undefined && typeof options.description !== "string") throw new TypeError("Browser video chapter description must be a string.");
    const milliseconds = duration(options.duration, 2000);
    interrupted(signal);
    await this.#pending;
    if (this.#disposed) throw new Error("Browser video presentation is disposed.");
    if (this.#chapter) throw new Error("A browser video chapter is already showing.");
    const controller = new AbortController();
    this.#chapter = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      await bounded(this.#page.bringToFront(), combined, 5000);
      await bounded(this.#send({ kind: "chapter", title: options.title, description: options.description }), combined, 5000);
      await bounded(this.#send({ kind: "frames" }), combined, 5000);
      await delay(milliseconds, combined);
      await bounded(this.#send({ kind: "fade" }), combined, 5000);
      await delay(150, combined);
    } finally {
      await this.#send({ kind: "removeChapter" });
      this.#chapter = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#chapter?.abort();
    await this.hideActions();
  }

  wrapApis<TPage extends object, TTab extends object>(page: TPage, tab: TTab, signal?: AbortSignal): { page: TPage; tab: TTab } {
    const objects = new WeakMap<object, object>();
    const actionMethods = new Set(["click", "hover", "fill", "type", "select", "focus", "press", "tap", "down", "up", "move", "wheel", "drag", "dragAndDrop", "dragEnter", "dragOver", "drop", "touchStart", "touchMove", "touchEnd", "sendCharacter", "insertText", "cdpClick", "clickNode", "typeNode", "autofillRelease", "scrollIntoView", "uploadFile"]);
    const self = this;
    const wrap = <T extends object>(target: T, kind: string): T => {
      const existing = objects.get(target);
      if (existing) return existing as T;
      const methods = new Map<PropertyKey, { original: unknown; wrapped: unknown }>();
      const proxy = new Proxy(target, { get(object, property) {
        const value: unknown = Reflect.get(object, property, object);
        if (["keyboard", "mouse", "touchscreen"].includes(String(property)) && value && typeof value === "object") return wrap(value, String(property));
        if (typeof value !== "function") return value;
        const cached = methods.get(property);
        if (cached?.original === value) return cached.wrapped;
        const name = String(property);
        const wrapped = (...args: unknown[]) => {
          const cdp = name === "cdp" && typeof args[0] === "string" && args[0].startsWith("Input.");
          if (!self.#enabled || (!actionMethods.has(name) && !cdp)) return Reflect.apply(value, object, args);
          return (async () => {
            interrupted(signal);
            const point = await self.#point(kind, name, args, tab);
            interrupted(signal);
            // Labels deliberately omit arguments: keys, typed text and selectors can contain credentials.
            const label = cdp ? String(args[0]).replace(/^Input\./, "") : `${kind === "page" || kind === "tab" ? "" : `${kind} `}${name}`;
            await self.#send({ kind: "action", label, point });
            try { return await Reflect.apply(value, object, args); }
            finally { await self.#send({ kind: "end" }); }
          })();
        };
        methods.set(property, { original: value, wrapped });
        return wrapped;
      } });
      objects.set(target, proxy);
      return proxy;
    };
    return { page: wrap(page, "page"), tab: wrap(tab, "tab") };
  }

  async #point(kind: string, method: string, args: unknown[], tab: object): Promise<Point | undefined> {
    if (method === "cdp") {
      const params = args[1];
      if (params && typeof params === "object") {
        const record = params as Record<string, unknown>;
        if (typeof record.x === "number" && typeof record.y === "number") return { x: record.x, y: record.y };
        const points = record.touchPoints;
        if (Array.isArray(points) && points[0] && typeof points[0].x === "number" && typeof points[0].y === "number") return { x: points[0].x, y: points[0].y };
      }
      return undefined;
    }
    if ((kind === "mouse" || kind === "touchscreen" || method === "cdpClick") && typeof args[0] === "number" && typeof args[1] === "number") return { x: args[0], y: args[1] };
    if (kind === "keyboard" || ["press", "typeNode", "clickNode"].includes(method)) return undefined;
    const selector = args[0];
    let handle;
    if (kind === "tab" && typeof selector === "number" && typeof Reflect.get(tab, "id") === "function") handle = await Reflect.apply(Reflect.get(tab, "id"), tab, [selector]);
    else if ((kind === "page" || kind === "tab") && typeof selector === "string") {
      const normalized = selector.replace(/^p-(text|xpath|pierce|aria)\//, "$1/");
      handle = await this.#page.$(normalized);
    }
    if (!handle) return undefined;
    try {
      const box = await handle.boundingBox();
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height } : undefined;
    } finally { await handle.dispose(); }
  }
}
