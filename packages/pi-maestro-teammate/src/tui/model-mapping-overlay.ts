import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  type Component,
  type Focusable,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentConfig, AgentSource } from "../agents/agents.ts";
import {
  TEAMMATE_TASK_TYPES,
  TEAMMATE_TASK_TYPE_META,
  getProjectModelRoutingPath,
  loadModelRoutingConfig,
  saveProjectModelMapping,
  type ModelRoutingConfig,
  type TeammateTaskType,
} from "../models/model-routing.ts";

type ControlCenterTab = "routing" | "roles" | "active";

export interface ControlCenterActiveAgent {
  correlationId: string;
  agent: string;
  name?: string;
  status: "running" | "sleeping" | "completed";
  startedAt: number;
  inboxCount: number;
  taskCount: number;
}

interface ControlCenterTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

interface ControlCenterAction {
  kind: "open-agent";
  correlationId: string;
  tab: ControlCenterTab;
}

export interface TeammateControlCenterOptions {
  agents?: readonly AgentConfig[];
  activeAgents?: readonly ControlCenterActiveAgent[];
  onOpenAgent?: (correlationId: string) => Promise<void>;
}

interface TeammateControlCenterParams {
  cwd: string;
  availableModels: readonly string[];
  agents: readonly AgentConfig[];
  activeAgents: readonly ControlCenterActiveAgent[];
  config: ModelRoutingConfig;
  theme: ControlCenterTheme;
  initialTab?: ControlCenterTab;
  requestRender: () => void;
  close: (action: ControlCenterAction | null) => void;
  saveMapping?: (taskType: TeammateTaskType, model: string | null) => void;
}

const SOURCE_ORDER: Record<AgentSource, number> = { project: 0, user: 1, builtin: 2 };
const TAB_ORDER: ControlCenterTab[] = ["routing", "roles", "active"];
const TAB_LABELS: Record<ControlCenterTab, string> = {
  routing: "Routing",
  roles: "Roles",
  active: "Active",
};

function printableInput(data: string): string {
  return data.replace(/[\x00-\x1f\x7f]/g, "");
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function padToWidth(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "", true);
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function activeStatus(status: ControlCenterActiveAgent["status"]): { icon: string; label: string; tone: string } {
  if (status === "sleeping") return { icon: "◉", label: "Sleeping", tone: "warning" };
  if (status === "completed") return { icon: "✓", label: "Done", tone: "dim" };
  return { icon: "■", label: "Running", tone: "success" };
}

export class TeammateControlCenter implements Component, Focusable {
  focused = false;
  private tab: ControlCenterTab;
  private modelTaskType: TeammateTaskType | null = null;
  private readonly queries: Record<ControlCenterTab, string> = { routing: "", roles: "", active: "" };
  private modelQuery = "";
  private readonly selected: Record<ControlCenterTab, number> = { routing: 0, roles: 0, active: 0 };
  private modelSelected = 0;
  private saving = false;
  private statusText = "";
  private statusTone: "dim" | "success" | "error" = "dim";
  private config: ModelRoutingConfig;
  private readonly models: string[];
  private readonly agents: AgentConfig[];
  private readonly activeAgents: ControlCenterActiveAgent[];

  constructor(private readonly params: TeammateControlCenterParams) {
    this.tab = params.initialTab ?? "routing";
    this.config = {
      version: params.config.version,
      mappings: { ...params.config.mappings },
    };
    this.models = [...new Set(params.availableModels)].sort((left, right) => left.localeCompare(right));
    this.agents = [...params.agents].sort((left, right) =>
      SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.name.localeCompare(right.name)
    );
    this.activeAgents = [...params.activeAgents].sort((left, right) =>
      left.status.localeCompare(right.status) || left.startedAt - right.startedAt
    );
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.modelTaskType) {
      this.handleModelInput(data);
      return;
    }

    if (data === "\x1b") {
      this.params.close(null);
      return;
    }
    if (data === "\t" || data === "\x1b[C") {
      this.switchTab(1);
      return;
    }
    if (data === "\x1b[Z" || data === "\x1b[D") {
      this.switchTab(-1);
      return;
    }
    if (data === "\x1b[A" || (data === "k" && !this.queries[this.tab])) {
      this.moveSelection(-1);
      return;
    }
    if (data === "\x1b[B" || (data === "j" && !this.queries[this.tab])) {
      this.moveSelection(1);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      const query = this.queries[this.tab];
      if (query) {
        this.queries[this.tab] = query.slice(0, -1);
        this.selected[this.tab] = 0;
        this.statusText = "";
        this.params.requestRender();
      }
      return;
    }
    if (data === "\r" || data === "\n") {
      this.activateSelection();
      return;
    }
    const input = printableInput(data);
    if (input) {
      this.queries[this.tab] += input;
      this.selected[this.tab] = 0;
      this.statusText = "";
      this.params.requestRender();
    }
  }

  render(width: number): readonly string[] {
    const w = Math.max(1, Math.min(width, 112));
    if (w < 24) return [this.renderCompact(w)];
    return this.modelTaskType ? this.renderModels(w) : this.renderMain(w);
  }

  private switchTab(direction: 1 | -1): void {
    const current = TAB_ORDER.indexOf(this.tab);
    this.tab = TAB_ORDER[(current + direction + TAB_ORDER.length) % TAB_ORDER.length];
    this.statusText = "";
    this.params.requestRender();
  }

  private moveSelection(delta: -1 | 1): void {
    const length = this.currentItems().length;
    this.selected[this.tab] = clampIndex(this.selected[this.tab] + delta, length);
    this.params.requestRender();
  }

  private activateSelection(): void {
    if (this.tab === "routing") {
      const item = this.filteredTaskTypes()[this.selected.routing];
      if (!item) return;
      this.modelTaskType = item;
      this.modelQuery = "";
      this.modelSelected = this.modelItems(item).findIndex((entry) => entry.active);
      if (this.modelSelected < 0) this.modelSelected = 0;
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    if (this.tab === "active") {
      const item = this.filteredActiveAgents()[this.selected.active];
      if (!item) return;
      this.params.close({ kind: "open-agent", correlationId: item.correlationId, tab: this.tab });
    }
  }

  private handleModelInput(data: string): void {
    if (this.saving) return;
    if (data === "\x1b" || data === "\x1b[D") {
      this.modelTaskType = null;
      this.modelQuery = "";
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    const items = this.filteredModelItems();
    if (data === "\x1b[A" || (data === "k" && !this.modelQuery)) {
      this.modelSelected = clampIndex(this.modelSelected - 1, items.length);
      this.params.requestRender();
      return;
    }
    if (data === "\x1b[B" || (data === "j" && !this.modelQuery)) {
      this.modelSelected = clampIndex(this.modelSelected + 1, items.length);
      this.params.requestRender();
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.modelQuery) {
        this.modelQuery = this.modelQuery.slice(0, -1);
        this.modelSelected = 0;
        this.params.requestRender();
      }
      return;
    }
    if (data === "\r" || data === "\n") {
      const taskType = this.modelTaskType;
      const item = items[this.modelSelected];
      if (!taskType || !item) return;
      this.saving = true;
      this.statusTone = "dim";
      this.statusText = `Saving ${TEAMMATE_TASK_TYPE_META[taskType].label}…`;
      this.params.requestRender();
      void Promise.resolve().then(() => {
        const model = item.value === "__auto__" ? null : item.value;
        if (this.params.saveMapping) this.params.saveMapping(taskType, model);
        else saveProjectModelMapping(this.params.cwd, taskType, model);
        this.config.mappings[taskType] = model;
        this.saving = false;
        this.statusTone = "success";
        this.statusText = `Saved · ${taskType} → ${model ?? "auto / agent default"}`;
        this.modelTaskType = null;
        this.modelQuery = "";
        this.params.requestRender();
      }).catch((error: unknown) => {
        this.saving = false;
        this.statusTone = "error";
        this.statusText = `Save failed · ${error instanceof Error ? error.message : String(error)}`;
        this.params.requestRender();
      });
      return;
    }
    const input = printableInput(data);
    if (input) {
      this.modelQuery += input;
      this.modelSelected = 0;
      this.params.requestRender();
    }
  }

  private filteredTaskTypes(): TeammateTaskType[] {
    const query = this.queries.routing.toLowerCase();
    if (!query) return [...TEAMMATE_TASK_TYPES];
    return TEAMMATE_TASK_TYPES.filter((taskType) => {
      const meta = TEAMMATE_TASK_TYPE_META[taskType];
      const mapping = this.config.mappings[taskType] ?? "auto";
      return `${taskType} ${meta.label} ${meta.roles} ${meta.description} ${mapping}`.toLowerCase().includes(query);
    });
  }

  private filteredRoles(): AgentConfig[] {
    const query = this.queries.roles.toLowerCase();
    if (!query) return this.agents;
    return this.agents.filter((agent) =>
      `${agent.name} ${agent.description} ${agent.source} ${agent.model ?? ""} ${(agent.tools ?? []).join(" ")}`
        .toLowerCase()
        .includes(query)
    );
  }

  private filteredActiveAgents(): ControlCenterActiveAgent[] {
    const query = this.queries.active.toLowerCase();
    if (!query) return this.activeAgents;
    return this.activeAgents.filter((agent) =>
      `${agent.agent} ${agent.name ?? ""} ${agent.status} ${agent.correlationId}`.toLowerCase().includes(query)
    );
  }

  private currentItems(): readonly unknown[] {
    if (this.tab === "routing") return this.filteredTaskTypes();
    if (this.tab === "roles") return this.filteredRoles();
    return this.filteredActiveAgents();
  }

  private modelItems(taskType: TeammateTaskType): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
  }> {
    const configured = this.config.mappings[taskType];
    const items = [{
      value: "__auto__",
      label: "auto / agent default",
      detail: "Use explicit task model, configured routing, or the agent default",
      active: !configured,
      unavailable: false,
    }];
    for (const model of this.models) {
      items.push({
        value: model,
        label: model,
        detail: model === configured ? `Current ${taskType} mapping` : "Authenticated in this session",
        active: model === configured,
        unavailable: false,
      });
    }
    if (configured && !this.models.includes(configured)) {
      items.push({
        value: configured,
        label: configured,
        detail: "Configured model is not authenticated in this session",
        active: true,
        unavailable: true,
      });
    }
    return items;
  }

  private filteredModelItems() {
    if (!this.modelTaskType) return [];
    const items = this.modelItems(this.modelTaskType);
    const query = this.modelQuery.toLowerCase();
    return query
      ? items.filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(query))
      : items;
  }

  private renderMain(width: number): string[] {
    const inner = width - 2;
    const items = this.currentItems();
    this.selected[this.tab] = clampIndex(this.selected[this.tab], items.length);
    const rows: string[] = [];
    rows.push(this.headerLine(inner));
    rows.push(this.tabLine(inner));
    rows.push(this.filterLine(inner, this.queries[this.tab], items.length));
    rows.push(this.params.theme.fg("dim", "─".repeat(inner)));

    const terminalRows = Math.max(14, process.stdout?.rows ?? 30);
    const listRows = Math.max(4, Math.min(10, terminalRows - 12));
    const list = this.renderListRows(items, listRows, width >= 76 ? Math.max(28, Math.floor(inner * 0.43)) : inner);
    const detail = this.detailLines(width >= 76 ? inner - Math.max(28, Math.floor(inner * 0.43)) - 1 : inner);

    if (width >= 76) {
      const listWidth = Math.max(28, Math.floor(inner * 0.43));
      const detailWidth = Math.max(12, inner - listWidth - 1);
      const height = Math.max(list.length, detail.length, listRows);
      for (let index = 0; index < height; index++) {
        rows.push(
          `${padToWidth(list[index] ?? "", listWidth)}${this.params.theme.fg("dim", "│")}${padToWidth(detail[index] ?? "", detailWidth)}`,
        );
      }
    } else {
      rows.push(...list);
      rows.push(this.params.theme.fg("dim", "─".repeat(inner)));
      rows.push(...detail.slice(0, 4));
    }

    if (this.statusText) rows.push(this.statusLine(inner));
    rows.push(this.footerLine(inner));
    return this.frame(rows, width);
  }

  private renderModels(width: number): string[] {
    const taskType = this.modelTaskType;
    if (!taskType) return this.renderMain(width);
    const inner = width - 2;
    const items = this.filteredModelItems();
    this.modelSelected = clampIndex(this.modelSelected, items.length);
    const meta = TEAMMATE_TASK_TYPE_META[taskType];
    const rows: string[] = [
      truncateToWidth(
        `${this.params.theme.fg("accent", this.params.theme.bold("Teammate Control Center"))} ${this.params.theme.fg("dim", "›")} ${this.params.theme.bold(meta.label)} ${this.params.theme.fg("dim", `(${meta.roles})`)}`,
        inner,
        "…",
      ),
      this.filterLine(inner, this.modelQuery, items.length),
      this.params.theme.fg("dim", "─".repeat(inner)),
    ];
    const terminalRows = Math.max(12, process.stdout?.rows ?? 30);
    const listRows = Math.max(4, Math.min(12, terminalRows - 10));
    const start = Math.max(0, Math.min(Math.max(0, items.length - listRows), this.modelSelected - Math.floor(listRows / 2)));
    const visible = items.slice(start, start + listRows);
    for (let offset = 0; offset < visible.length; offset++) {
      const index = start + offset;
      const item = visible[offset];
      const prefix = index === this.modelSelected ? this.params.theme.fg("accent", "▸") : " ";
      const state = item.unavailable
        ? this.params.theme.fg("error", "! unavailable")
        : item.active
          ? this.params.theme.fg("success", "✓ active")
          : this.params.theme.fg("dim", "available");
      rows.push(truncateToWidth(`${prefix} ${this.params.theme.bold(item.label)} ${this.params.theme.fg("dim", "·")} ${state}`, inner, "…"));
      if (index === this.modelSelected && inner >= 44) {
        rows.push(truncateToWidth(`  ${this.params.theme.fg("muted", item.detail)}`, inner, "…"));
      }
    }
    if (items.length === 0) {
      rows.push(this.params.theme.fg("warning", "□ No matching models · Backspace clears the filter"));
    }
    if (this.statusText) rows.push(this.statusLine(inner));
    rows.push(truncateToWidth(
      `${this.params.theme.fg("dim", "↑↓")} select ${this.params.theme.fg("dim", "· type")} filter ${this.params.theme.fg("dim", "· Enter")} save ${this.params.theme.fg("dim", "· Esc/←")} back`,
      inner,
      "…",
    ));
    return this.frame(rows, width);
  }

  private renderListRows(items: readonly unknown[], maxRows: number, width: number): string[] {
    const index = this.selected[this.tab];
    const start = Math.max(0, Math.min(Math.max(0, items.length - maxRows), index - Math.floor(maxRows / 2)));
    const visible = items.slice(start, start + maxRows);
    if (visible.length === 0) return [this.emptyState()];
    return visible.map((item, offset) => this.itemLine(item, start + offset === index, width));
  }

  private itemLine(item: unknown, selected: boolean, width: number): string {
    const prefix = selected ? this.params.theme.fg("accent", "▸") : " ";
    if (this.tab === "routing") {
      const taskType = item as TeammateTaskType;
      const meta = TEAMMATE_TASK_TYPE_META[taskType];
      const mapping = this.config.mappings[taskType] ?? "auto";
      return truncateToWidth(`${prefix} ${this.params.theme.bold(meta.label)} ${this.params.theme.fg("dim", `· ${mapping}`)}`, width, "…");
    }
    if (this.tab === "roles") {
      const agent = item as AgentConfig;
      return truncateToWidth(`${prefix} @${this.params.theme.bold(agent.name)} ${this.params.theme.fg("dim", `[${agent.source}]`)}`, width, "…");
    }
    const agent = item as ControlCenterActiveAgent;
    const status = activeStatus(agent.status);
    const name = agent.name ?? agent.correlationId.slice(0, 8);
    return truncateToWidth(
      `${prefix} ${this.params.theme.fg(status.tone, status.icon)} ${this.params.theme.bold(`${agent.agent}/${name}`)} ${this.params.theme.fg("dim", status.label)}`,
      width,
      "…",
    );
  }

  private detailLines(width: number): string[] {
    const lines: string[] = [];
    if (this.tab === "routing") {
      const taskType = this.filteredTaskTypes()[this.selected.routing];
      if (!taskType) return [this.emptyState()];
      const meta = TEAMMATE_TASK_TYPE_META[taskType];
      const mapping = this.config.mappings[taskType] ?? "auto / agent default";
      lines.push(this.params.theme.bold(meta.label));
      lines.push(this.params.theme.fg("muted", `Roles · ${meta.roles}`));
      lines.push(...wrapTextWithAnsi(meta.description, Math.max(1, width)).slice(0, 3));
      lines.push(this.params.theme.fg("dim", `Model · ${mapping}`));
      lines.push(this.params.theme.fg("dim", `Config · ${path.basename(getProjectModelRoutingPath(this.params.cwd))}`));
    } else if (this.tab === "roles") {
      const agent = this.filteredRoles()[this.selected.roles];
      if (!agent) return [this.emptyState()];
      lines.push(`@${this.params.theme.bold(agent.name)} ${this.params.theme.fg("dim", `[${agent.source}]`)}`);
      lines.push(...wrapTextWithAnsi(normalizedText(agent.description), Math.max(1, width)).slice(0, 3));
      lines.push(this.params.theme.fg("dim", `Model · ${agent.model ?? "auto / routed"}`));
      lines.push(this.params.theme.fg("dim", `Context · ${agent.defaultContext ?? "fresh"} · prompt ${agent.systemPromptMode}`));
      lines.push(this.params.theme.fg("dim", `Tools · ${agent.tools?.join(", ") ?? "default"}`));
    } else {
      const agent = this.filteredActiveAgents()[this.selected.active];
      if (!agent) return [this.emptyState()];
      const status = activeStatus(agent.status);
      const uptime = Math.max(0, Math.round((Date.now() - agent.startedAt) / 1000));
      lines.push(`${this.params.theme.fg(status.tone, status.icon)} ${this.params.theme.bold(agent.name ?? agent.agent)} · ${status.label}`);
      lines.push(this.params.theme.fg("muted", `Role · ${agent.agent}`));
      lines.push(this.params.theme.fg("dim", `Uptime · ${uptime}s · inbox ${agent.inboxCount} · tasks ${agent.taskCount}`));
      lines.push(this.params.theme.fg("dim", `ID · ${agent.correlationId.slice(0, 12)}`));
      lines.push(this.params.theme.fg("muted", "Enter opens the existing collaboration view"));
    }
    return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }

  private emptyState(): string {
    if (this.queries[this.tab]) return this.params.theme.fg("warning", "□ No matches · Backspace clears the filter");
    if (this.tab === "roles") return this.params.theme.fg("warning", "□ No teammate roles discovered · add .pi/agents/*.md");
    if (this.tab === "active") return this.params.theme.fg("dim", "□ No active teammates · Esc closes the control center");
    return this.params.theme.fg("warning", "□ No routing entries available");
  }

  private headerLine(width: number): string {
    const active = this.activeAgents.filter((agent) => agent.status !== "completed").length;
    return truncateToWidth(
      `${this.params.theme.fg("accent", this.params.theme.bold("Teammate Control Center"))} ${this.params.theme.fg("dim", `· ${this.agents.length} roles · ${active} active`)}`,
      width,
      "…",
    );
  }

  private tabLine(width: number): string {
    const labels = TAB_ORDER.map((tab) => {
      const count = tab === "routing" ? TEAMMATE_TASK_TYPES.length : tab === "roles" ? this.agents.length : this.activeAgents.length;
      const label = `${TAB_LABELS[tab]} ${count}`;
      return tab === this.tab
        ? this.params.theme.fg("accent", this.params.theme.bold(`[${label}]`))
        : this.params.theme.fg("dim", label);
    });
    return truncateToWidth(labels.join("  "), width, "…");
  }

  private filterLine(width: number, query: string, count: number): string {
    const marker = this.focused ? CURSOR_MARKER : "";
    const queryText = query ? `${query}${marker}` : this.params.theme.fg("dim", "type to filter");
    return truncateToWidth(`${this.params.theme.fg("accent", "›")} ${queryText} ${this.params.theme.fg("dim", `· ${count} shown`)}`, width, "…");
  }

  private statusLine(width: number): string {
    return truncateToWidth(this.params.theme.fg(this.statusTone, this.statusText), width, "…");
  }

  private footerLine(width: number): string {
    const action = this.tab === "routing" ? "Enter configure" : this.tab === "active" ? "Enter open" : "Enter details";
    const segments = ["Tab/←→ view", "↑↓ select", "type filter", action, "Esc close"];
    let footer = "";
    for (const segment of segments) {
      const next = footer ? `${footer} · ${segment}` : segment;
      if (visibleWidth(next) > width) break;
      footer = next;
    }
    return this.params.theme.fg("dim", footer || "Esc close");
  }

  private frame(rows: string[], width: number): string[] {
    const inner = width - 2;
    const dim = (value: string) => this.params.theme.fg("dim", value);
    return [
      dim(`╭${"─".repeat(inner)}╮`),
      ...rows.map((row) => `${dim("│")}${padToWidth(` ${row}`, inner)}${dim("│")}`),
      dim(`╰${"─".repeat(inner)}╯`),
    ];
  }

  private renderCompact(width: number): string {
    if (this.modelTaskType) {
      return truncateToWidth(`Routing › ${TEAMMATE_TASK_TYPE_META[this.modelTaskType].label} · Esc back`, width, "…");
    }
    const count = this.currentItems().length;
    return truncateToWidth(`Teammates · ${TAB_LABELS[this.tab]} ${count} · Tab view`, width, "…");
  }
}

export async function showModelMappingOverlay(
  ctx: ExtensionContext,
  availableModels: readonly string[],
  options: TeammateControlCenterOptions = {},
): Promise<void> {
  let initialTab: ControlCenterTab = "routing";
  while (true) {
    const action = await ctx.ui.custom<ControlCenterAction | null>((tui, theme, _keybindings, done) => {
      const controlCenter = new TeammateControlCenter({
        cwd: ctx.cwd,
        availableModels,
        agents: options.agents ?? [],
        activeAgents: options.activeAgents ?? [],
        config: loadModelRoutingConfig(ctx.cwd),
        theme,
        initialTab,
        requestRender: () => tui.requestRender(),
        close: done,
      });
      return controlCenter;
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
    });

    if (!action) return;
    initialTab = action.tab;
    if (action.kind === "open-agent" && options.onOpenAgent) {
      await options.onOpenAgent(action.correlationId);
    }
  }
}
