import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  type Component,
  type Focusable,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentConfig, AgentSource } from "../agents/agents.ts";
import type { ModelCircuitSnapshot } from "../models/model-circuit-breaker.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import {
  TEAMMATE_TASK_TYPE_META,
  clearProjectModelRoutingOverrides,
  createAndActivateGlobalModelRoutingProfile,
  deleteGlobalModelRoutingProfile,
  discoverRoutingTaskTypes,
  loadModelRoutingState,
  promoteProjectModelRoutingOverrides,
  renameGlobalModelRoutingProfile,
  saveGlobalProfileModelMapping,
  saveGlobalProfileThinkingLevel,
  saveProjectFallbackMapping,
  setDefaultGlobalModelRoutingProfile,
  setProjectActiveModelRoutingProfile,
  setProjectModelRoutingOverridesEnabled,
  type ModelRoutingConfig,
  type ModelRoutingProfile,
  type ModelRoutingRules,
  type ModelRoutingState,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import { TEAMMATE_THINKING_LEVELS, type TeammateThinkingLevel } from "../shared/thinking.ts";
import {
  BracketedPasteDecoder,
  removeLastGrapheme,
  sanitizeSingleLineInput,
  type DecodedInputToken,
} from "./input-text.ts";

export type ControlCenterTab = "profiles" | "routing" | "roles" | "active";

export interface ControlCenterActiveAgent {
  correlationId: string;
  agent: string;
  name?: string;
  status: "pending" | "running" | "retrying" | "sleeping" | "completed" | "failed" | "terminated";
  startedAt: number;
  inboxCount: number;
  taskCount: number;
}

interface ControlCenterTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export type ControlCenterAction =
  | { kind: "open-agent"; correlationId: string; tab: ControlCenterTab }
  | { kind: "reload"; tab: ControlCenterTab }
  | { kind: "manage-profile"; profileId: string; profileQuery: string; tab: ControlCenterTab };

export interface TeammateControlCenterOptions {
  agents?: readonly AgentConfig[];
  activeAgents?: readonly ControlCenterActiveAgent[];
  modelHealth?: readonly ModelCircuitSnapshot[];
  onOpenAgent?: (correlationId: string) => Promise<void>;
  globalFilePath?: string;
}

interface LegacyControlCenterConfig extends ModelRoutingRules {
  version: 2 | 3;
  profileId?: string;
  profileName?: string;
  projectOverridesEnabled?: boolean;
}

interface TeammateControlCenterParams {
  cwd: string;
  availableModels: readonly TeammateModelCapability[];
  agents: readonly AgentConfig[];
  activeAgents: readonly ControlCenterActiveAgent[];
  state?: ModelRoutingState;
  config?: LegacyControlCenterConfig;
  theme: ControlCenterTheme;
  initialTab?: ControlCenterTab;
  initialProfileId?: string;
  initialProfileQuery?: string;
  initialStatusText?: string;
  initialStatusTone?: "dim" | "success" | "error";
  initialSaving?: boolean;
  readOnly?: boolean;
  globalFilePath?: string;
  requestRender: () => void;
  close: (action: ControlCenterAction | null) => void;
  saveMapping?: (taskType: TeammateTaskType, model: string | null) => void;
  saveThinking?: (taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null) => void;
  saveFallbacks?: (taskType: TeammateTaskType, models: string[] | null) => void;
  modelHealth?: readonly ModelCircuitSnapshot[];
}

const SOURCE_ORDER: Record<AgentSource, number> = { project: 0, user: 1, builtin: 2 };
const TAB_ORDER: ControlCenterTab[] = ["profiles", "routing", "roles", "active"];
const TAB_LABELS: Record<ControlCenterTab, string> = {
  profiles: "Profiles",
  routing: "Routing",
  roles: "Roles",
  active: "Active",
};

function printableInput(data: string): string {
  // 拒绝转义序列（方向键 / 功能键），避免 sanitize 后 `[A` 等残渣混入文本。
  if (data.startsWith("\x1b")) return "";
  return decodeKittyPrintable(data) ?? sanitizeSingleLineInput(data);
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function displayText(value: unknown): string {
  return sanitizeSingleLineInput(String(value));
}

function padToWidth(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "", true);
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function activeStatus(status: ControlCenterActiveAgent["status"]): { icon: string; label: string; tone: string } {
  if (status === "pending") return { icon: "○", label: "Pending", tone: "dim" };
  if (status === "failed") return { icon: "✗", label: "Failed", tone: "error" };
  if (status === "retrying") return { icon: "↻", label: "Retrying", tone: "warning" };
  if (status === "sleeping") return { icon: "◉", label: "Sleeping", tone: "warning" };
  if (status === "completed") return { icon: "✓", label: "Done", tone: "dim" };
  return { icon: "■", label: "Running", tone: "success" };
}

function rulesFromProfile(profile: ModelRoutingProfile): ModelRoutingRules {
  return {
    mappings: { ...profile.mappings },
    ...(profile.fallbackMappings ? {
      fallbackMappings: Object.fromEntries(Object.entries(profile.fallbackMappings).map(([taskType, models]) => [
        taskType,
        Array.isArray(models) ? [...models] : models,
      ])),
    } : {}),
    thinkingLevels: { ...profile.thinkingLevels },
  };
}

function stateFromLegacyConfig(config?: LegacyControlCenterConfig): ModelRoutingState {
  const profileId = config?.profileId ?? "default";
  const profileName = config?.profileName ?? "Default";
  const profile: ModelRoutingProfile = {
    name: profileName,
    mappings: { ...config?.mappings },
    ...(config?.fallbackMappings ? { fallbackMappings: { ...config.fallbackMappings } } : {}),
    thinkingLevels: { ...config?.thinkingLevels },
  };
  return {
    global: { version: 3, defaultProfile: profileId, profiles: { [profileId]: profile } },
    project: { version: 3, activeProfile: profileId, applyOverrides: false, overrides: { mappings: {}, thinkingLevels: {} } },
    config: {
      version: 3,
      profileId,
      profileName,
      projectOverridesEnabled: config?.projectOverridesEnabled ?? false,
      ...rulesFromProfile(profile),
    },
    requestedProfile: profileId,
  };
}

function ruleCount(profile: ModelRoutingProfile): number {
  return new Set([
    ...Object.keys(profile.mappings),
    ...Object.keys(profile.fallbackMappings ?? {}),
    ...Object.keys(profile.thinkingLevels),
  ]).size;
}

function hasRoutingRules(rules: ModelRoutingRules): boolean {
  return Object.keys(rules.mappings).length > 0
    || Object.keys(rules.fallbackMappings ?? {}).length > 0
    || Object.keys(rules.thinkingLevels).length > 0;
}

export class TeammateControlCenter implements Component, Focusable {
  focused = false;
  private tab: ControlCenterTab;
  private modelTaskType: TeammateTaskType | null = null;
  private editorKind: "model" | "thinking" | "fallback" = "model";
  private readonly queries: Record<ControlCenterTab, string> = { profiles: "", routing: "", roles: "", active: "" };
  private modelQuery = "";
  private readonly selected: Record<ControlCenterTab, number> = { profiles: 0, routing: 0, roles: 0, active: 0 };
  private modelSelected = 0;
  private saving = false;
  private statusText = "";
  private statusTone: "dim" | "success" | "error" = "dim";
  private readonly pasteDecoder = new BracketedPasteDecoder();
  private pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWidth = 80;
  private readonly state: ModelRoutingState;
  private config: ModelRoutingConfig;
  private readonly profileIds: string[];
  private readonly models: string[];
  private readonly modelCapabilities: Map<string, TeammateModelCapability>;
  private readonly health = new Map<string, ModelCircuitSnapshot>();
  private fallbackDraft: string[] = [];
  private readonly agents: AgentConfig[];
  private readonly taskTypes: TeammateTaskType[];
  private readonly activeAgents: ControlCenterActiveAgent[];

  constructor(private readonly params: TeammateControlCenterParams) {
    this.tab = params.initialTab ?? "routing";
    this.queries.profiles = sanitizeSingleLineInput(params.initialProfileQuery ?? "");
    this.saving = params.initialSaving ?? false;
    this.statusText = displayText(params.initialStatusText ?? "");
    this.statusTone = params.initialStatusTone ?? "dim";
    this.state = params.state ?? stateFromLegacyConfig(params.config);
    const activeProfile = this.state.global.profiles[this.state.config.profileId];
    const activeRules = rulesFromProfile(activeProfile);
    this.config = {
      version: 3,
      profileId: this.state.config.profileId,
      profileName: activeProfile.name,
      projectOverridesEnabled: this.state.project.applyOverrides,
      ...activeRules,
    };
    this.profileIds = Object.keys(this.state.global.profiles).sort((left, right) =>
      this.state.global.profiles[left].name.localeCompare(this.state.global.profiles[right].name),
    );
    const focusedProfileId = params.initialProfileId ?? this.config.profileId;
    const focusedProfileIndex = this.filteredProfileIds().indexOf(focusedProfileId);
    if (focusedProfileIndex >= 0) this.selected.profiles = focusedProfileIndex;
    this.modelCapabilities = new Map(params.availableModels.map((model) => [model.id, model]));
    for (const entry of params.modelHealth ?? []) this.health.set(entry.model, entry);
    this.models = [...this.modelCapabilities.keys()].sort((left, right) => left.localeCompare(right));
    this.agents = [...params.agents].sort((left, right) =>
      SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.name.localeCompare(right.name)
    );
    const discoveredTaskTypes = discoverRoutingTaskTypes(params.cwd, this.agents, this.config);
    const profileTaskTypes = [
      ...Object.keys(activeProfile.mappings),
      ...Object.keys(activeProfile.fallbackMappings ?? {}),
      ...Object.keys(activeProfile.thinkingLevels),
    ];
    this.taskTypes = [...new Set([...discoveredTaskTypes, ...profileTaskTypes])];
    this.activeAgents = [...params.activeAgents].sort((left, right) =>
      left.status.localeCompare(right.status) || left.startedAt - right.startedAt
    );
  }

  invalidate(): void {}

  dispose(): void {
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
  }

  handleInput(data: string): void {
    if (this.saving && !this.modelTaskType) return;
    if (this.lastWidth < 20) {
      if (matchesKey(data, Key.escape)) {
        if (this.modelTaskType) this.handleModelInput(data);
        else this.params.close(null);
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.handleDecodedInput(data);
      this.params.requestRender();
      return;
    }
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
    for (const token of this.pasteDecoder.feed(data)) this.dispatchDecodedToken(token);
    if (this.pasteDecoder.hasPending()) {
      this.pasteFlushTimer = setTimeout(() => {
        this.pasteFlushTimer = undefined;
        for (const token of this.pasteDecoder.flushPending()) this.dispatchDecodedToken(token);
        this.params.requestRender();
      }, 16);
    }
    this.params.requestRender();
  }

  private dispatchDecodedToken(token: DecodedInputToken): void {
    if (token.kind === "paste") {
      if (this.modelTaskType) {
        this.modelQuery += token.text;
        this.modelSelected = 0;
      } else {
        this.queries[this.tab] += token.text;
        this.selected[this.tab] = 0;
      }
      this.statusText = "";
      return;
    }
    this.handleDecodedInput(token.text);
  }

  private handleDecodedInput(data: string): void {
    if (this.modelTaskType) {
      this.handleModelInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.params.close(null);
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.switchTab(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.switchTab(-1);
      return;
    }
    if (matchesKey(data, Key.up) || (matchesKey(data, "k") && !this.queries[this.tab])) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || (matchesKey(data, "j") && !this.queries[this.tab])) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      const query = this.queries[this.tab];
      if (query) {
        this.queries[this.tab] = removeLastGrapheme(query);
        this.selected[this.tab] = 0;
        this.statusText = "";
        this.params.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.activateSelection();
      return;
    }
    if (matchesKey(data, Key.ctrl("right")) && this.tab === "routing") {
      this.activateThinkingSelection();
      return;
    }
    if (matchesKey(data, Key.ctrl("f")) && this.tab === "routing") {
      this.activateFallbackSelection();
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

  render(width: number): string[] {
    const w = Math.max(1, Math.min(width, 112));
    this.lastWidth = w;
    if (w < 24 || (this.modelTaskType && w < 40)) return [this.renderCompact(w)];
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
    if (this.params.readOnly && this.tab !== "active") {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    if (this.tab === "profiles") {
      const profileId = this.filteredProfileIds()[this.selected.profiles];
      if (!profileId) return;
      this.params.close({
        kind: "manage-profile",
        profileId,
        profileQuery: this.queries.profiles,
        tab: this.tab,
      });
      return;
    }
    if (this.tab === "routing") {
      const item = this.filteredTaskTypes()[this.selected.routing];
      if (!item) return;
      this.modelTaskType = item;
      this.editorKind = "model";
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

  private activateThinkingSelection(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const item = this.filteredTaskTypes()[this.selected.routing];
    if (!item) return;
    this.modelTaskType = item;
    this.editorKind = "thinking";
    this.modelQuery = "";
    this.modelSelected = this.thinkingItems(item).findIndex((entry) => entry.active);
    if (this.modelSelected < 0) this.modelSelected = 0;
    this.statusText = "";
    this.params.requestRender();
  }

  private activateFallbackSelection(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const item = this.filteredTaskTypes()[this.selected.routing];
    if (!item) return;
    this.modelTaskType = item;
    this.editorKind = "fallback";
    this.fallbackDraft = [...(this.config.fallbackMappings?.[item] ?? [])];
    this.modelQuery = "";
    this.modelSelected = 0;
    this.statusText = "";
    this.params.requestRender();
  }

  private handleModelInput(data: string): void {
    if (this.saving) return;
    if (this.editorKind === "fallback") {
      this.handleFallbackInput(data);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.modelTaskType = null;
      this.modelQuery = "";
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    const items = this.filteredEditorItems();
    if (matchesKey(data, Key.up) || (matchesKey(data, "k") && !this.modelQuery)) {
      this.modelSelected = clampIndex(this.modelSelected - 1, items.length);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || (matchesKey(data, "j") && !this.modelQuery)) {
      this.modelSelected = clampIndex(this.modelSelected + 1, items.length);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.modelQuery) {
        this.modelQuery = removeLastGrapheme(this.modelQuery);
        this.modelSelected = 0;
        this.params.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const taskType = this.modelTaskType;
      const item = items[this.modelSelected];
      if (!taskType || !item) return;
      if (this.editorKind === "thinking" && item.unavailable) {
        this.statusTone = "error";
        this.statusText = `Unsupported · ${item.detail}`;
        this.params.requestRender();
        return;
      }
      this.saving = true;
      this.statusTone = "dim";
      this.statusText = `Saving ${this.taskTypeMeta(taskType).label}…`;
      this.params.requestRender();
      this.persistenceTimer = setTimeout(() => {
        this.persistenceTimer = undefined;
        try {
          const editorKind = this.editorKind;
          const value = item.value === "__auto__" ? null : item.value;
          if (editorKind === "thinking") {
            const thinking = value as TeammateThinkingLevel | null;
            if (this.params.saveThinking) this.params.saveThinking(taskType, thinking);
            else saveGlobalProfileThinkingLevel(this.params.cwd, this.config.profileId, taskType, thinking, this.params.globalFilePath);
            this.config.thinkingLevels[taskType] = thinking;
          } else {
            if (this.params.saveMapping) this.params.saveMapping(taskType, value);
            else saveGlobalProfileModelMapping(this.params.cwd, this.config.profileId, taskType, value, this.params.globalFilePath);
            this.config.mappings[taskType] = value;
          }
          this.saving = false;
          this.statusTone = "success";
          if (editorKind === "model" && value) {
            this.editorKind = "thinking";
            this.modelSelected = this.thinkingItems(taskType).findIndex((entry) => entry.active);
            if (this.modelSelected < 0) this.modelSelected = 0;
            this.statusText = `Saved model · choose thinking depth for ${value}`;
          } else {
            this.statusText = `Saved · ${taskType} ${editorKind} → ${value ?? (editorKind === "thinking" ? "inherit / Pi default" : "auto / agent default")}`;
            this.modelTaskType = null;
          }
          this.modelQuery = "";
          this.params.requestRender();
        } catch (error) {
          this.saving = false;
          this.statusTone = "error";
          this.statusText = `Save failed · ${error instanceof Error ? error.message : String(error)}`;
          this.params.requestRender();
        }
      }, 16);
      return;
    }
    const input = printableInput(data);
    if (input) {
      this.modelQuery += input;
      this.modelSelected = 0;
      this.params.requestRender();
    }
  }

  private handleFallbackInput(data: string): void {
    if (this.saving) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.modelTaskType = null;
      this.fallbackDraft = [];
      this.modelQuery = "";
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    const items = this.filteredEditorItems();
    if (matchesKey(data, Key.up) || (matchesKey(data, "k") && !this.modelQuery)) {
      this.modelSelected = clampIndex(this.modelSelected - 1, items.length);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || (matchesKey(data, "j") && !this.modelQuery)) {
      this.modelSelected = clampIndex(this.modelSelected + 1, items.length);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("up"))) {
      this.reorderFallback(-1);
      return;
    }
    if (matchesKey(data, Key.ctrl("down"))) {
      this.reorderFallback(1);
      return;
    }
    if (matchesKey(data, Key.space) || data === " ") {
      this.toggleFallbackItem();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.commitFallback();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.modelQuery) {
        this.modelQuery = removeLastGrapheme(this.modelQuery);
        this.modelSelected = 0;
        this.params.requestRender();
      }
      return;
    }
    const input = printableInput(data);
    if (input) {
      this.modelQuery += input;
      this.modelSelected = 0;
      this.params.requestRender();
    }
  }

  private fallbackItems(taskType: TeammateTaskType): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
  }> {
    const chain = this.fallbackDraft;
    const items: Array<{
      value: string;
      label: string;
      detail: string;
      active: boolean;
      unavailable: boolean;
    }> = [];
    for (const model of chain) {
      const authenticated = this.models.includes(model);
      items.push({
        value: model,
        label: model,
        detail: authenticated
          ? this.fallbackItemDetail(model, chain.indexOf(model) + 1)
          : "Not authenticated in this session",
        active: true,
        unavailable: !authenticated,
      });
    }
    for (const model of this.models.filter((candidate) => !chain.includes(candidate))) {
      items.push({
        value: model,
        label: model,
        detail: this.fallbackItemDetail(model, -1),
        active: false,
        unavailable: false,
      });
    }
    return items;
  }

  private fallbackItemDetail(model: string, priority: number): string {
    const circuit = this.circuitNote(model);
    if (priority < 0) return ["Not in fallback chain", circuit].filter(Boolean).join(" · ");
    return ["Fallback priority " + String(priority), circuit].filter(Boolean).join(" · ");
  }

  private circuitNote(model: string): string {
    const health = this.health.get(model);
    if (!health || health.state === "CLOSED") return "";
    const detail = health.state === "OPEN" ? "circuit open · skipped" : "circuit half-open · probing";
    return health.consecutiveFailures > 0 ? `${detail} (${health.consecutiveFailures} failures)` : detail;
  }

  private editorLabel(): string {
    if (this.editorKind === "fallback") return "Fallback";
    if (this.editorKind === "thinking") return "Thinking";
    return "Model";
  }

  private toggleFallbackItem(): void {
    const taskType = this.modelTaskType;
    const item = this.filteredEditorItems()[this.modelSelected];
    if (!taskType || !item) return;
    const index = this.fallbackDraft.indexOf(item.value);
    if (index >= 0) this.fallbackDraft.splice(index, 1);
    else this.fallbackDraft.push(item.value);
    this.modelSelected = this.fallbackItems(taskType).findIndex((entry) => entry.value === item.value);
    if (this.modelSelected < 0) this.modelSelected = 0;
    this.statusText = "";
    this.params.requestRender();
  }

  private reorderFallback(direction: -1 | 1): void {
    const taskType = this.modelTaskType;
    const item = this.filteredEditorItems()[this.modelSelected];
    if (!taskType || !item) return;
    const index = this.fallbackDraft.indexOf(item.value);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= this.fallbackDraft.length) return;
    [this.fallbackDraft[index], this.fallbackDraft[target]] = [this.fallbackDraft[target], this.fallbackDraft[index]];
    this.modelSelected = this.fallbackItems(taskType).findIndex((entry) => entry.value === item.value);
    if (this.modelSelected < 0) this.modelSelected = 0;
    this.params.requestRender();
  }

  private commitFallback(): void {
    const taskType = this.modelTaskType;
    if (!taskType) return;
    this.saving = true;
    this.statusTone = "dim";
    this.statusText = `Saving ${this.taskTypeMeta(taskType).label} fallbacks…`;
    this.params.requestRender();
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      try {
        const models = this.fallbackDraft.length > 0 ? [...this.fallbackDraft] : null;
        if (this.params.saveFallbacks) this.params.saveFallbacks(taskType, models);
        else saveProjectFallbackMapping(this.params.cwd, taskType, models, this.params.globalFilePath);
        this.config.fallbackMappings = { ...(this.config.fallbackMappings ?? {}), [taskType]: models };
        this.saving = false;
        this.statusTone = "success";
        this.statusText = models ? `Saved fallbacks · ${models.join(", ")}` : "Saved fallbacks · none";
        this.modelTaskType = null;
        this.fallbackDraft = [];
        this.modelQuery = "";
        this.params.requestRender();
      } catch (error) {
        this.saving = false;
        this.statusTone = "error";
        this.statusText = `Save failed · ${error instanceof Error ? error.message : String(error)}`;
        this.params.requestRender();
      }
    }, 16);
  }

  private taskTypeMeta(taskType: TeammateTaskType): { label: string; roles: string; description: string } {
    const known = TEAMMATE_TASK_TYPE_META[taskType];
    if (known) return known;
    const roles = this.agents
      .filter((agent) => agent.taskType === taskType)
      .map((agent) => agent.name)
      .join(" / ");
    const label = taskType
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ");
    return {
      label: label || taskType,
      roles: roles || "custom agent",
      description: "Custom agent task routing",
    };
  }

  private filteredProfileIds(): string[] {
    const query = this.queries.profiles.toLowerCase();
    if (!query) return [...this.profileIds];
    return this.profileIds.filter((profileId) => {
      const profile = this.state.global.profiles[profileId];
      const models = [
        ...Object.values(profile.mappings),
        ...Object.values(profile.fallbackMappings ?? {}).flatMap((entry) => entry ?? []),
      ].filter((entry): entry is string => typeof entry === "string");
      return `${profileId} ${profile.name} ${models.join(" ")}`.toLowerCase().includes(query);
    });
  }

  private filteredTaskTypes(): TeammateTaskType[] {
    const query = this.queries.routing.toLowerCase();
    if (!query) return [...this.taskTypes];
    return this.taskTypes.filter((taskType) => {
      const meta = this.taskTypeMeta(taskType);
      const mapping = this.config.mappings[taskType] ?? "auto";
      const thinking = this.config.thinkingLevels[taskType] ?? "inherit";
      return `${taskType} ${meta.label} ${meta.roles} ${meta.description} ${mapping} ${thinking}`.toLowerCase().includes(query);
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
    if (this.tab === "profiles") return this.filteredProfileIds();
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
        detail: [
          model === configured ? `Current ${taskType} mapping` : "Authenticated in this session",
          this.circuitNote(model),
        ].filter(Boolean).join(" · "),
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

  private thinkingItems(taskType: TeammateTaskType) {
    const configured = this.config.thinkingLevels[taskType];
    const routedModel = this.config.mappings[taskType];
    const capability = routedModel ? this.modelCapabilities.get(routedModel) : undefined;
    const supported = capability?.thinkingLevels;
    const items = [{
      value: "__auto__",
      label: "inherit / Pi default",
      detail: "Use explicit task, top-level, agent frontmatter, or Pi default thinking",
      active: !configured,
      unavailable: false,
    }, ...TEAMMATE_THINKING_LEVELS
      .map((thinking) => ({
        value: thinking,
        label: thinking === "xhigh" ? "xhigh / max" : thinking,
        detail: supported && !supported.includes(thinking)
          ? `${routedModel} does not support this level`
          : thinking === configured
            ? `Current ${taskType} thinking depth`
            : routedModel
              ? `Supported by ${routedModel}`
              : "Model-dependent; select a routed model for exact capabilities",
        active: thinking === configured,
        unavailable: !!supported && !supported.includes(thinking),
      }))];
    return items;
  }

  private filteredEditorItems() {
    if (!this.modelTaskType) return [];
    const items = this.editorKind === "thinking"
      ? this.thinkingItems(this.modelTaskType)
      : this.editorKind === "fallback"
        ? this.fallbackItems(this.modelTaskType)
        : this.modelItems(this.modelTaskType);
    const query = this.modelQuery.toLowerCase();
    return query ? items.filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(query)) : items;
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
    const items = this.filteredEditorItems();
    this.modelSelected = clampIndex(this.modelSelected, items.length);
    const meta = this.taskTypeMeta(taskType);
    const rows: string[] = [
      truncateToWidth(
        `${this.params.theme.fg("accent", this.params.theme.bold("Teammate Control Center"))} ${this.params.theme.fg("dim", "›")} ${this.params.theme.bold(displayText(meta.label))} ${this.params.theme.fg("dim", `› ${this.editorLabel()} (${displayText(meta.roles)})`)}`,
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
        ? this.params.theme.fg("error", `! unavailable${item.active ? " · active" : ""}`)
        : item.active
          ? this.params.theme.fg("success", "✓ active")
          : this.params.theme.fg("dim", "available");
      rows.push(truncateToWidth(`${prefix} ${this.params.theme.bold(displayText(item.label))} ${this.params.theme.fg("dim", "·")} ${state}`, inner, "…"));
      if (index === this.modelSelected && inner >= 44) {
        rows.push(truncateToWidth(`  ${this.params.theme.fg("muted", displayText(item.detail))}`, inner, "…"));
      }
    }
    if (items.length === 0) {
      rows.push(this.params.theme.fg("warning", "□ No matching options · Backspace clears the filter"));
    }
    if (this.statusText) rows.push(this.statusLine(inner));
      rows.push(truncateToWidth(
        this.editorKind === "fallback"
          ? `${this.params.theme.fg("dim", "Esc/←")} back ${this.params.theme.fg("dim", "· Space")} toggle ${this.params.theme.fg("dim", "· Ctrl+↑↓")} order ${this.params.theme.fg("dim", "· Enter")} save ${this.params.theme.fg("dim", "· type")} filter`
          : `${this.params.theme.fg("dim", "Esc/←")} back ${this.params.theme.fg("dim", "· Enter")} save ${this.params.theme.fg("dim", "· ↑↓")} select ${this.params.theme.fg("dim", "· type")} filter`,
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

  private unavailableModels(profile: ModelRoutingProfile): string[] {
    const configured = [
      ...Object.values(profile.mappings),
      ...Object.values(profile.fallbackMappings ?? {}).flatMap((entry) => entry ?? []),
    ].filter((entry): entry is string => typeof entry === "string");
    return [...new Set(configured.filter((model) => !this.modelCapabilities.has(model)))];
  }

  private itemLine(item: unknown, selected: boolean, width: number): string {
    const prefix = selected ? this.params.theme.fg("accent", "▸") : " ";
    if (this.tab === "profiles") {
      const profileId = item as string;
      const profile = this.state.global.profiles[profileId];
      const active = profileId === this.config.profileId;
      const isDefault = profileId === this.state.global.defaultProfile;
      const states = [active ? "active" : "", isDefault ? "default" : ""].filter(Boolean).join(" · ");
      const suffix = states ? ` · ${states}` : ` · ${ruleCount(profile)} routes`;
      return truncateToWidth(`${prefix} ${this.params.theme.bold(displayText(profile.name))} ${this.params.theme.fg("dim", suffix)}`, width, "…");
    }
    if (this.tab === "routing") {
      const taskType = item as TeammateTaskType;
      const meta = this.taskTypeMeta(taskType);
      const mapping = this.config.mappings[taskType] ?? "auto";
      const thinking = this.config.thinkingLevels[taskType] ?? "inherit";
      return truncateToWidth(`${prefix} ${this.params.theme.bold(displayText(meta.label))} ${this.params.theme.fg("dim", `· ${displayText(mapping)} · think ${displayText(thinking)}`)}`, width, "…");
    }
    if (this.tab === "roles") {
      const agent = item as AgentConfig;
      return truncateToWidth(`${prefix} @${this.params.theme.bold(displayText(agent.name))} ${this.params.theme.fg("dim", `[${displayText(agent.source)}]`)}`, width, "…");
    }
    const agent = item as ControlCenterActiveAgent;
    const status = activeStatus(agent.status);
    const name = agent.name ?? agent.correlationId.slice(0, 8);
    return truncateToWidth(
      `${prefix} ${this.params.theme.fg(status.tone, status.icon)} ${this.params.theme.bold(`${displayText(agent.agent)}/${displayText(name)}`)} ${this.params.theme.fg("dim", status.label)}`,
      width,
      "…",
    );
  }

  private detailLines(width: number): string[] {
    const lines: string[] = [];
    if (this.tab === "profiles") {
      const profileId = this.filteredProfileIds()[this.selected.profiles];
      if (!profileId) return [this.emptyState()];
      const profile = this.state.global.profiles[profileId];
      const unavailable = this.unavailableModels(profile);
      lines.push(this.params.theme.bold(displayText(profile.name)));
      lines.push(this.params.theme.fg("muted", `ID · ${displayText(profileId)}`));
      lines.push(this.params.theme.fg("dim", `Routes · ${ruleCount(profile)} · unavailable ${unavailable.length}`));
      lines.push(this.params.theme.fg("dim", `State · ${profileId === this.config.profileId ? "active in this project" : "inactive"}`));
      lines.push(this.params.theme.fg("dim", `Global default · ${profileId === this.state.global.defaultProfile ? "yes" : "no"}`));
      lines.push(this.params.theme.fg("dim", "Config · ~/.pi/agent/teammate-models.json"));
      if (unavailable.length > 0) lines.push(this.params.theme.fg("warning", `Unavailable · ${unavailable.map(displayText).join(", ")}`));
      if (hasRoutingRules(this.state.project.overrides)) {
        lines.push(this.params.theme.fg(
          this.state.project.applyOverrides ? "warning" : "dim",
          `Project overrides · ${this.state.project.applyOverrides ? "enabled" : "preserved / disabled"}`,
        ));
      }
      if (this.state.missingProfile) lines.push(this.params.theme.fg("warning", `Missing selection · ${displayText(this.state.missingProfile)}`));
    } else if (this.tab === "routing") {
      const taskType = this.filteredTaskTypes()[this.selected.routing];
      if (!taskType) return [this.emptyState()];
      const meta = this.taskTypeMeta(taskType);
      const mapping = this.config.mappings[taskType] ?? "auto / agent default";
      lines.push(this.params.theme.bold(displayText(meta.label)));
      lines.push(this.params.theme.fg("muted", `Roles · ${displayText(meta.roles)}`));
      lines.push(...wrapTextWithAnsi(displayText(meta.description), Math.max(1, width)).slice(0, 3));
      lines.push(this.params.theme.fg("dim", `Model · ${displayText(mapping)}`));
      lines.push(this.params.theme.fg("dim", `Fallbacks · ${this.config.fallbackMappings?.[taskType]?.map(displayText).join(", ") || "none"}`));
      const unhealthy = (this.config.fallbackMappings?.[taskType] ?? [])
        .map((model) => ({ model, health: this.health.get(model) }))
        .filter((entry): entry is { model: string; health: ModelCircuitSnapshot } =>
          !!entry.health && entry.health.state !== "CLOSED");
      if (unhealthy.length > 0) {
        lines.push(this.params.theme.fg("warning", `Circuit · ${unhealthy.map((entry) => `${displayText(entry.model)} ${entry.health.state}`).join(", ")}`));
      }
      lines.push(this.params.theme.fg("dim", `Thinking · ${displayText(this.config.thinkingLevels[taskType] ?? "inherit / Pi default")}`));
      lines.push(this.params.theme.fg("dim", `Profile · ${displayText(this.config.profileName)} · global`));
      if (this.state.project.applyOverrides) lines.push(this.params.theme.fg("warning", "Project overrides are active at runtime"));
    } else if (this.tab === "roles") {
      const agent = this.filteredRoles()[this.selected.roles];
      if (!agent) return [this.emptyState()];
      lines.push(`@${this.params.theme.bold(displayText(agent.name))} ${this.params.theme.fg("dim", `[${displayText(agent.source)}]`)}`);
      lines.push(...wrapTextWithAnsi(normalizedText(displayText(agent.description)), Math.max(1, width)).slice(0, 3));
      lines.push(this.params.theme.fg("dim", `Model · ${displayText(agent.model ?? "auto / routed")}`));
      lines.push(this.params.theme.fg("dim", `Context · ${displayText(agent.defaultContext ?? "fresh")} · prompt ${displayText(agent.systemPromptMode)}`));
      lines.push(this.params.theme.fg("dim", `Tools · ${agent.tools?.map(displayText).join(", ") ?? "default"}`));
    } else {
      const agent = this.filteredActiveAgents()[this.selected.active];
      if (!agent) return [this.emptyState()];
      const status = activeStatus(agent.status);
      const uptime = Math.max(0, Math.round((Date.now() - agent.startedAt) / 1000));
      lines.push(`${this.params.theme.fg(status.tone, status.icon)} ${this.params.theme.bold(displayText(agent.name ?? agent.agent))} · ${status.label}`);
      lines.push(this.params.theme.fg("muted", `Role · ${displayText(agent.agent)}`));
      lines.push(this.params.theme.fg("dim", `Uptime · ${uptime}s · inbox ${agent.inboxCount} · tasks ${agent.taskCount}`));
      lines.push(this.params.theme.fg("dim", `ID · ${displayText(agent.correlationId.slice(0, 12))}`));
      lines.push(this.params.theme.fg("muted", "Enter opens the existing collaboration view"));
    }
    return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }

  private emptyState(): string {
    if (this.queries[this.tab]) return this.params.theme.fg("warning", "□ No matches · Backspace clears the filter");
    if (this.tab === "profiles") return this.params.theme.fg("warning", "□ No model Profiles available");
    if (this.tab === "roles") return this.params.theme.fg("warning", "□ No teammate roles discovered · add .pi/agents/*.md");
    if (this.tab === "active") return this.params.theme.fg("dim", "□ No active teammates · Esc closes the control center");
    return this.params.theme.fg("warning", "□ No routing entries available");
  }

  private headerLine(width: number): string {
    const active = this.activeAgents.filter((agent) => agent.status !== "completed").length;
    const override = this.state.project.applyOverrides ? " · overrides on" : "";
    return truncateToWidth(
      `${this.params.theme.fg("accent", this.params.theme.bold("Teammate Control Center"))} ${this.params.theme.fg("dim", `· ${displayText(this.config.profileName)}${override} · ${this.agents.length} roles · ${active} active`)}`,
      width,
      "…",
    );
  }

  private tabLine(width: number): string {
    const labels = TAB_ORDER.map((tab) => {
      const count = tab === "profiles"
        ? this.profileIds.length
        : tab === "routing"
          ? this.taskTypes.length
          : tab === "roles"
            ? this.agents.length
            : this.activeAgents.length;
      const label = `${TAB_LABELS[tab]} ${count}`;
      return tab === this.tab
        ? this.params.theme.fg("accent", this.params.theme.bold(`[${label}]`))
        : this.params.theme.fg("dim", label);
    });
    return truncateToWidth(labels.join("  "), width, "…");
  }

  private filterLine(width: number, query: string, count: number): string {
    const marker = this.focused ? CURSOR_MARKER : "";
    const queryText = query ? `${displayText(query)}${marker}` : `${marker}${this.params.theme.fg("dim", "type to filter")}`;
    return truncateToWidth(`${this.params.theme.fg("accent", "›")} ${queryText} ${this.params.theme.fg("dim", `· ${count} shown`)}`, width, "…");
  }

  private statusLine(width: number): string {
    return truncateToWidth(this.params.theme.fg(this.statusTone, displayText(this.statusText)), width, "…");
  }

  private footerLine(width: number): string {
    if (this.params.readOnly) {
      return this.params.theme.fg("warning", truncateToWidth("Enter retry load · Esc close · navigation is read-only", width, "…"));
    }
    const action = this.tab === "profiles"
      ? "Enter manage"
      : this.tab === "routing"
        ? "Enter model + thinking · Ctrl+→ thinking · Ctrl+F fallback"
        : this.tab === "active"
          ? "Enter open"
          : "";
    const segments = ["Esc close", action, "↑↓ select", "Tab/←→ view", "type filter"];
    let footer = "";
    for (const segment of segments.filter(Boolean)) {
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
    const status = this.statusText ? `${displayText(this.statusText)} · ` : "";
    if (this.modelTaskType) {
      const item = this.filteredEditorItems()[this.modelSelected];
      return truncateToWidth(
        `${status}Esc back · ${displayText(this.taskTypeMeta(this.modelTaskType).label)} · ${displayText(item?.label ?? this.editorKind)}`,
        width,
        "…",
      );
    }
    const item = this.currentItems()[this.selected[this.tab]];
    const label = item ? this.itemLine(item, true, Math.max(1, width)) : `${TAB_LABELS[this.tab]} empty`;
    const action = this.params.readOnly ? "Enter retry · " : "Esc close · ";
    return truncateToWidth(`${status}${action}${label}`, width, "…");
  }
}

interface ProfileOperationResult {
  message: string;
  focusProfileId?: string | null;
}

interface ProfilePersistenceOutcome extends ProfileOperationResult {
  ok: boolean;
  error?: string;
}

async function showProfilePersistenceStatus(
  ctx: ExtensionContext,
  availableModels: readonly TeammateModelCapability[],
  options: TeammateControlCenterOptions,
  state: ModelRoutingState,
  profileId: string,
  profileQuery: string,
  savingText: string,
  operation: () => ProfileOperationResult,
): Promise<ProfilePersistenceOutcome | null> {
  return ctx.ui.custom<ProfilePersistenceOutcome | null>((tui, theme, _keybindings, done) => {
    let settled = false;
    const finish = (outcome: ProfilePersistenceOutcome | null): void => {
      if (settled) return;
      settled = true;
      done(outcome);
    };
    const controlCenter = new TeammateControlCenter({
      cwd: ctx.cwd,
      availableModels,
      agents: options.agents ?? [],
      activeAgents: options.activeAgents ?? [],
      state,
      theme,
      initialTab: "profiles",
      initialProfileId: profileId,
      initialProfileQuery: profileQuery,
      initialStatusText: `Saving · ${savingText}`,
      initialStatusTone: "dim",
      initialSaving: true,
      modelHealth: options.modelHealth,
      globalFilePath: options.globalFilePath,
      requestRender: () => tui.requestRender(),
      close: () => finish(null),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startOperation = (): void => {
      if (timer || settled) return;
      timer = setTimeout(() => {
        try {
          finish({ ok: true, ...operation() });
        } catch (error) {
          finish({
            ok: false,
            message: savingText,
            error: displayText(error instanceof Error ? error.message : String(error)),
          });
        }
      }, 16);
    };
    return {
      render: (width: number) => {
        const lines = controlCenter.render(width);
        startOperation();
        return lines;
      },
      handleInput: (data: string) => controlCenter.handleInput(data),
      invalidate: () => controlCenter.invalidate(),
      dispose: () => {
        if (timer) clearTimeout(timer);
        controlCenter.dispose();
        finish(null);
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
  });
}

export async function showModelMappingOverlay(
  ctx: ExtensionContext,
  availableModels: readonly TeammateModelCapability[],
  options: TeammateControlCenterOptions = {},
): Promise<void> {
  let initialTab: ControlCenterTab = "routing";
  let initialProfileId: string | undefined;
  let initialProfileQuery = "";
  let initialStatusText = "";
  let initialStatusTone: "dim" | "success" | "error" = "dim";
  let lastState: ModelRoutingState | undefined;
  while (true) {
    let state: ModelRoutingState;
    let usingFallback = false;
    try {
      state = loadModelRoutingState(ctx.cwd, options.globalFilePath);
      lastState = state;
    } catch (error) {
      if (!lastState) throw error;
      state = lastState;
      usingFallback = true;
      initialStatusTone = "error";
      initialStatusText = `Save failed · ${displayText(error instanceof Error ? error.message : String(error))}`;
    }
    const action = await ctx.ui.custom<ControlCenterAction | null>((tui, theme, _keybindings, done) => {
      const controlCenter = new TeammateControlCenter({
        cwd: ctx.cwd,
        availableModels,
        agents: options.agents ?? [],
        activeAgents: options.activeAgents ?? [],
        state,
        theme,
        initialTab,
        initialProfileId,
        initialProfileQuery,
        initialStatusText,
        initialStatusTone,
        readOnly: usingFallback,
        modelHealth: options.modelHealth,
        globalFilePath: options.globalFilePath,
        requestRender: () => tui.requestRender(),
        close: done,
      });
      return {
        render: (width: number) => controlCenter.render(width),
        handleInput: (data: string) => controlCenter.handleInput(data),
        invalidate: () => controlCenter.invalidate(),
        dispose: () => {
          controlCenter.dispose();
          done(null);
        },
      };
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
    });

    if (!action) return;
    initialTab = action.tab;
    if (action.kind === "open-agent") {
      if (options.onOpenAgent) await options.onOpenAgent(action.correlationId);
      continue;
    }
    if (action.kind === "reload") continue;

    initialProfileId = action.profileId;
    initialProfileQuery = action.profileQuery;
    initialStatusText = "";
    initialStatusTone = "dim";
    const profile = state.global.profiles[action.profileId];
    if (!profile) {
      ctx.ui.notify(`Profile ${displayText(action.profileId)} no longer exists.`, "warning");
      continue;
    }
    const choices: Array<{ key: string; label: string }> = [];
    if (action.profileId !== state.config.profileId) choices.push({ key: "activate", label: "Activate in this project" });
    choices.push(
      { key: "create", label: "Create empty Profile" },
      { key: "duplicate", label: "Duplicate this Profile" },
      { key: "rename", label: "Rename this Profile" },
    );
    if (action.profileId !== state.global.defaultProfile) {
      choices.push(
        { key: "default", label: "Set as global default" },
        { key: "delete", label: "Delete this Profile" },
      );
    }
    if (hasRoutingRules(state.project.overrides)) {
      choices.push({
        key: state.project.applyOverrides ? "disable-overrides" : "restore-overrides",
        label: state.project.applyOverrides ? "Disable project overrides" : "Restore project overrides",
      });
      choices.push(
        { key: "promote-overrides", label: "Promote project overrides to a Profile" },
        { key: "clear-overrides", label: "Clear preserved project overrides" },
      );
    }

    const selected = await ctx.ui.select(`Profile · ${displayText(profile.name)}`, choices.map((choice) => choice.label));
    const operation = choices.find((choice) => choice.label === selected)?.key;
    if (!operation) continue;

    let savingText = "Profile";
    let persistOperation: (() => ProfileOperationResult) | undefined;
    if (operation === "activate") {
      savingText = `Activating ${displayText(profile.name)}`;
      persistOperation = () => {
        setProjectActiveModelRoutingProfile(ctx.cwd, action.profileId, options.globalFilePath);
        return { message: `Activated ${displayText(profile.name)} for this project`, focusProfileId: action.profileId };
      };
    } else if (operation === "create" || operation === "duplicate") {
      const name = await ctx.ui.input(
        operation === "create" ? "New teammate model Profile" : `Duplicate ${displayText(profile.name)}`,
        operation === "create" ? "Profile name" : `${displayText(profile.name)} copy`,
      );
      if (!name?.trim()) continue;
      savingText = operation === "create" ? "Creating Profile" : `Duplicating ${displayText(profile.name)}`;
      persistOperation = () => {
        const created = createAndActivateGlobalModelRoutingProfile(
          ctx.cwd,
          name,
          operation === "duplicate" ? action.profileId : undefined,
          options.globalFilePath,
        );
        return {
          message: `Created and activated ${displayText(name.trim())}`,
          focusProfileId: created.changedProfileId,
        };
      };
    } else if (operation === "rename") {
      const name = await ctx.ui.input(`Rename ${displayText(profile.name)}`, displayText(profile.name));
      if (!name?.trim()) continue;
      savingText = `Renaming ${displayText(profile.name)}`;
      persistOperation = () => {
        renameGlobalModelRoutingProfile(ctx.cwd, action.profileId, name, options.globalFilePath);
        return { message: `Renamed Profile to ${displayText(name.trim())}`, focusProfileId: action.profileId };
      };
    } else if (operation === "default") {
      savingText = `Setting ${displayText(profile.name)} as default`;
      persistOperation = () => {
        setDefaultGlobalModelRoutingProfile(ctx.cwd, action.profileId, options.globalFilePath);
        return { message: `${displayText(profile.name)} is now the global default`, focusProfileId: action.profileId };
      };
    } else if (operation === "delete") {
      const confirmed = await ctx.ui.confirm(
        `Delete ${displayText(profile.name)}?`,
        "Other projects using this Profile will fall back to the global default.",
      );
      if (!confirmed) continue;
      savingText = `Deleting ${displayText(profile.name)}`;
      persistOperation = () => {
        deleteGlobalModelRoutingProfile(ctx.cwd, action.profileId, options.globalFilePath);
        return { message: `Deleted ${displayText(profile.name)}`, focusProfileId: null };
      };
    } else if (operation === "disable-overrides" || operation === "restore-overrides") {
      const enabled = operation === "restore-overrides";
      savingText = `${enabled ? "Restoring" : "Disabling"} project overrides`;
      persistOperation = () => {
        setProjectModelRoutingOverridesEnabled(ctx.cwd, enabled, options.globalFilePath);
        return { message: `Project overrides ${enabled ? "restored" : "disabled"}`, focusProfileId: action.profileId };
      };
    } else if (operation === "promote-overrides") {
      const name = await ctx.ui.input("Promote project overrides", "Profile name");
      if (!name?.trim()) continue;
      savingText = "Promoting project overrides";
      persistOperation = () => {
        const promoted = promoteProjectModelRoutingOverrides(ctx.cwd, name, options.globalFilePath);
        return {
          message: `Promoted overrides to ${displayText(name.trim())} and activated it`,
          focusProfileId: promoted.changedProfileId,
        };
      };
    } else if (operation === "clear-overrides") {
      const confirmed = await ctx.ui.confirm(
        "Clear project overrides?",
        "This permanently removes the preserved project-specific routing values.",
      );
      if (!confirmed) continue;
      savingText = "Clearing project overrides";
      persistOperation = () => {
        clearProjectModelRoutingOverrides(ctx.cwd, options.globalFilePath);
        return { message: "Cleared project routing overrides", focusProfileId: action.profileId };
      };
    }
    if (!persistOperation) continue;

    const outcome = await showProfilePersistenceStatus(
      ctx,
      availableModels,
      options,
      state,
      action.profileId,
      initialProfileQuery,
      savingText,
      persistOperation,
    );
    if (!outcome) continue;
    if (outcome.ok) {
      if (outcome.focusProfileId === null) initialProfileId = undefined;
      else if (outcome.focusProfileId) initialProfileId = outcome.focusProfileId;
      initialStatusTone = "success";
      initialStatusText = `Saved · ${displayText(outcome.message)}`;
      ctx.ui.notify(`${displayText(outcome.message)}.`, "info");
    } else {
      initialStatusTone = "error";
      initialStatusText = `Save failed · ${displayText(outcome.error ?? "Unknown persistence error")}`;
      ctx.ui.notify(initialStatusText, "error");
    }
  }
}
