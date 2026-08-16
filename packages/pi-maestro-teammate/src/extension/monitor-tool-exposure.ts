import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface MonitorCommunicationCapture {
  generation: number;
}

type AnyMonitorToolDefinition = ToolDefinition<any, any, any>;

export interface MonitorToolVariants {
  local: readonly AnyMonitorToolDefinition[];
  monitor: readonly AnyMonitorToolDefinition[];
  exclusiveNames: readonly string[];
}

/**
 * Switches model-facing tool contracts without granting cross-window authority
 * until Monitor admission is complete. Execute paths must still check capture().
 */
export class MonitorToolExposureController {
  readonly #pi: ExtensionAPI;
  readonly #local: readonly AnyMonitorToolDefinition[];
  readonly #monitor: readonly AnyMonitorToolDefinition[];
  readonly #sharedNames: readonly string[];
  readonly #exclusiveNames: readonly string[];
  #active = false;
  #generation = 0;
  #variant: "local" | "monitor" | undefined;
  #restoreShared: Map<string, boolean> | undefined;

  constructor(pi: ExtensionAPI, variants: MonitorToolVariants) {
    const localNames = variants.local.map((tool) => tool.name);
    const monitorNames = variants.monitor.map((tool) => tool.name);
    if (new Set(localNames).size !== localNames.length
      || localNames.length !== monitorNames.length
      || localNames.some((name) => !monitorNames.includes(name))) {
      throw new Error("Monitor local and active tool variants must define the same unique tool names.");
    }
    const exclusiveNames = [...new Set(variants.exclusiveNames)];
    if (exclusiveNames.some((name) => localNames.includes(name))) {
      throw new Error("Monitor-exclusive tools must not overlap shared tool variants.");
    }
    this.#pi = pi;
    this.#local = variants.local;
    this.#monitor = variants.monitor;
    this.#sharedNames = localNames;
    this.#exclusiveNames = exclusiveNames;
    this.#register("local");
  }

  get active(): boolean {
    return this.#active;
  }

  get generation(): number {
    return this.#generation;
  }

  capture(): MonitorCommunicationCapture | undefined {
    return this.#active ? { generation: this.#generation } : undefined;
  }

  isCurrent(capture: MonitorCommunicationCapture | undefined): capture is MonitorCommunicationCapture {
    return capture !== undefined && this.#active && capture.generation === this.#generation;
  }

  enter(): MonitorCommunicationCapture {
    if (this.#active) return { generation: this.#generation };
    const current = this.#pi.getActiveTools();
    const restoreShared = new Map(this.#sharedNames.map((name) => [name, current.includes(name)]));
    this.#register("monitor");
    this.#pi.setActiveTools(addNames(current, [...this.#sharedNames, ...this.#exclusiveNames]));
    this.#restoreShared = restoreShared;
    this.#active = true;
    this.#generation++;
    return { generation: this.#generation };
  }

  exit(): void {
    const wasActive = this.#active;
    this.#active = false;
    if (wasActive) this.#generation++;
    this.#register("local");

    let activeTools = this.#pi.getActiveTools().filter((name) => !this.#exclusiveNames.includes(name));
    const restoreShared = this.#restoreShared;
    if (restoreShared) {
      activeTools = activeTools.filter((name) => !this.#sharedNames.includes(name));
      activeTools = addNames(
        activeTools,
        this.#sharedNames.filter((name) => restoreShared.get(name) === true),
      );
    }
    this.#pi.setActiveTools(activeTools);
    this.#restoreShared = undefined;
  }

  syncInactive(): void {
    if (this.#active) return;
    this.#register("local");
    const current = this.#pi.getActiveTools();
    const next = current.filter((name) => !this.#exclusiveNames.includes(name));
    if (next.length !== current.length) this.#pi.setActiveTools(next);
  }

  #register(variant: "local" | "monitor"): void {
    if (this.#variant === variant) return;
    const definitions = variant === "local" ? this.#local : this.#monitor;
    for (const tool of definitions) this.#pi.registerTool(tool);
    this.#variant = variant;
  }
}

function addNames(current: readonly string[], names: readonly string[]): string[] {
  const next = [...current];
  const seen = new Set(next);
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    next.push(name);
  }
  return next;
}
