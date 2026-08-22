import * as fs from "node:fs";
import * as path from "node:path";
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
import type { ModelCircuitPolicy, ModelCircuitSnapshot } from "../models/model-circuit-breaker.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { DEFAULT_MANIFEST_PATH } from "../models/cli.ts";
import {
  buildModelList,
  renderLegacyUpgradeSkeleton,
  type ModelListResult,
} from "../models/cli-list.ts";
import {
  TEAMMATE_TASK_TYPES,
  TEAMMATE_TASK_TYPE_META,
  clearProjectModelRoutingOverrides,
  createAndActivateGlobalModelRoutingProfile,
  deleteGlobalModelRoutingProfile,
  deleteGlobalProfileCustomType,
  discoverRoutingTaskTypes,
  loadModelRoutingState,
  parseTeammateTaskType,
  promoteProjectModelRoutingOverrides,
  renameGlobalModelRoutingProfile,
  saveGlobalProfileModelMapping,
  saveGlobalProfileRoleMapping,
  saveGlobalProfileTypeRoles,
  saveGlobalProfileThinkingLevel,
  saveGlobalProfileCustomType,
  saveGlobalProfileTypeMeta,
  saveProjectFallbackMapping,
  setDefaultGlobalModelRoutingProfile,
  setGlobalAskBeforeDispatch,
  setProjectActiveModelRoutingProfile,
  setProjectModelRoutingOverridesEnabled,
  type ModelRoutingConfig,
  type ModelRoutingProfile,
  type ModelRoutingRoleRules,
  type ModelRoutingRules,
  type ModelRoutingState,
  type ModelRoutingTypeMeta,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import { TEAMMATE_THINKING_LEVELS, type TeammateThinkingLevel } from "../shared/thinking.ts";
import {
  BracketedPasteDecoder,
  removeLastGrapheme,
  sanitizeSingleLineInput,
  type DecodedInputToken,
} from "./input-text.ts";
import {
  createTuiTranslator,
  onTuiLocaleChange,
  type SupportedSettingsLocale,
  type TuiTranslationKey,
  type TuiTranslator,
} from "./locale.ts";
import {
  RemoteConfigPane,
  type RemotePaneAction,
  type RemotePaneDeployments,
  type RemotePaneScope,
} from "./remote-config-pane.ts";
import {
  wizardDeploymentAdd,
  wizardDeploymentEdit,
  wizardLegacyUpgrade,
  wizardRemoteHost,
  wizardRemoteTarget,
  type WizardUi,
} from "./connection-wizards.ts";
import {
  loadRemoteConfigState,
  replaceRemoteConfigStores,
  type RemoteConfigState,
} from "../remote/config.ts";

export type ControlCenterTab = "profiles" | "routing" | "roles" | "connections" | "active";

export interface ControlCenterActiveAgent {
  correlationId: string;
  agent: string;
  name?: string;
  status: "pending" | "running" | "retrying" | "sleeping" | "completed" | "failed" | "terminated";
  startedAt: number;
  inboxCount: number;
  taskCount: number;
  /** Resolved working directory of the run, when known. */
  cwd?: string;
}

interface ControlCenterTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export type ControlCenterAction =
  | { kind: "open-agent"; correlationId: string; tab: ControlCenterTab }
  | { kind: "reload"; tab: ControlCenterTab }
  | { kind: "manage-profile"; profileId: string; profileQuery: string; tab: ControlCenterTab }
  | RemotePaneAction;

export interface TeammateControlCenterOptions {
  agents?: readonly AgentConfig[];
  activeAgents?: readonly ControlCenterActiveAgent[];
  modelHealth?: readonly ModelCircuitSnapshot[];
  onOpenAgent?: (correlationId: string) => Promise<void>;
  /** Remote configuration state for the Connections tab. */
  remoteState?: RemoteConfigState;
  /** Precomputed model-registry projection for the connections pane. */
  deployments?: RemotePaneDeployments;
  /** Probe a remote target (SSH handshake + protocol initialize); result text is already redacted. */
  onTestRemote?: (targetId: string, signal: AbortSignal) => Promise<string>;
  remoteTestTimeoutMs?: number;
  /** Reload the extension's model catalog after registry writes or explicit reloads. */
  refreshModelCatalog?: () => readonly TeammateModelCapability[];
  globalFilePath?: string;
  locale?: SupportedSettingsLocale;
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
  remoteState?: RemoteConfigState;
  deployments?: RemotePaneDeployments;
  onTestRemote?: (targetId: string, signal: AbortSignal) => Promise<string>;
  remoteTestTimeoutMs?: number;
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
  saveRoleRules?: (role: string, rules: ModelRoutingRoleRules | null) => void;
  saveTypeRoles?: (taskType: TeammateTaskType, roles: readonly string[]) => void;
  saveCustomType?: (taskType: TeammateTaskType, meta?: ModelRoutingTypeMeta | null) => void;
  deleteCustomType?: (taskType: TeammateTaskType) => void;
  saveTypeMeta?: (taskType: TeammateTaskType, meta: ModelRoutingTypeMeta | null) => void;
  modelHealth?: readonly ModelCircuitSnapshot[];
  locale?: SupportedSettingsLocale;
}

const SOURCE_ORDER: Record<AgentSource, number> = { package: 0, project: 1, user: 2, builtin: 3 };
const TAB_ORDER: ControlCenterTab[] = ["profiles", "routing", "roles", "connections", "active"];

function tabLabel(tab: ControlCenterTab, t: TuiTranslator): string {
  return t(`model.tab.${tab}` as TuiTranslationKey);
}

/** Sentinel routing-list entry that opens the custom-type creation flow. */
const NEW_CUSTOM_TYPE_ENTRY = "__new_custom_type__";

const CIRCUIT_DEFAULT_THRESHOLD = 3;
const CIRCUIT_DEFAULT_COOLDOWN_MS = 60_000;

interface CircuitPreset {
  value: string;
  labelKey: "model.circuit.strict" | "model.circuit.lenient";
  detailKey: "model.circuit.strictDetail" | "model.circuit.lenientDetail";
  policy: ModelCircuitPolicy;
}

const CIRCUIT_PRESETS: readonly CircuitPreset[] = [
  {
    value: "strict",
    labelKey: "model.circuit.strict",
    detailKey: "model.circuit.strictDetail",
    policy: { threshold: 2, cooldownMs: 30_000 },
  },
  {
    value: "lenient",
    labelKey: "model.circuit.lenient",
    detailKey: "model.circuit.lenientDetail",
    policy: { threshold: 5, cooldownMs: 300_000 },
  },
];

function circuitDisplayText(
  circuit: ModelCircuitPolicy | null | undefined,
  t: TuiTranslator,
): string {
  if (!circuit) {
    return t("model.circuit.default", {
      threshold: CIRCUIT_DEFAULT_THRESHOLD,
      seconds: Math.round(CIRCUIT_DEFAULT_COOLDOWN_MS / 1000),
    });
  }
  const threshold = circuit.threshold ?? CIRCUIT_DEFAULT_THRESHOLD;
  const seconds = Math.round((circuit.cooldownMs ?? CIRCUIT_DEFAULT_COOLDOWN_MS) / 1000);
  return t("model.circuit.value", { threshold, seconds });
}

function circuitDraftText(circuit: ModelCircuitPolicy | null | undefined): string {
  if (!circuit) return "";
  const threshold = circuit.threshold ?? CIRCUIT_DEFAULT_THRESHOLD;
  const cooldownSeconds = Math.round((circuit.cooldownMs ?? CIRCUIT_DEFAULT_COOLDOWN_MS) / 1000);
  return `${threshold}/${cooldownSeconds}`;
}

function parseCircuitDraft(draft: string): ModelCircuitPolicy | null {
  const match = /^(\d{1,2})(?:\/(\d{1,5}))?$/.exec(draft);
  if (!match) return null;
  const threshold = Number(match[1]);
  if (threshold < 1) return null;
  const policy: ModelCircuitPolicy = { threshold };
  if (match[2] !== undefined) policy.cooldownMs = Number(match[2]) * 1000;
  return policy;
}

function parseKeywordsDraft(draft: string): string[] {
  return [...new Set(draft.split(",").map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
}

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

function activeStatus(
  status: ControlCenterActiveAgent["status"],
  t: TuiTranslator,
): { icon: string; label: string; tone: string } {
  if (status === "pending") return { icon: "○", label: t("model.status.pending"), tone: "dim" };
  if (status === "failed") return { icon: "✗", label: t("model.status.failed"), tone: "error" };
  if (status === "retrying") return { icon: "↻", label: t("model.status.retrying"), tone: "warning" };
  if (status === "sleeping") return { icon: "◉", label: t("model.status.sleeping"), tone: "warning" };
  if (status === "completed") return { icon: "✓", label: t("model.status.done"), tone: "dim" };
  return { icon: "■", label: t("model.status.running"), tone: "success" };
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
    ...(profile.roleMappings ? { roleMappings: { ...profile.roleMappings } } : {}),
    ...(profile.typeMeta ? { typeMeta: { ...profile.typeMeta } } : {}),
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
    ...(config?.roleMappings ? { roleMappings: { ...config.roleMappings } } : {}),
    ...(config?.typeMeta ? { typeMeta: { ...config.typeMeta } } : {}),
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
    askBeforeDispatch: false,
    requestedProfile: profileId,
  };
}

function ruleCount(profile: ModelRoutingProfile): number {
  return new Set([
    ...Object.keys(profile.mappings),
    ...Object.keys(profile.fallbackMappings ?? {}),
    ...Object.keys(profile.thinkingLevels),
    ...Object.keys(profile.roleMappings ?? {}),
    ...Object.keys(profile.typeMeta ?? {}),
  ]).size;
}

function hasRoutingRules(rules: ModelRoutingRules): boolean {
  return Object.keys(rules.mappings).length > 0
    || Object.keys(rules.fallbackMappings ?? {}).length > 0
    || Object.keys(rules.thinkingLevels).length > 0
    || Object.keys(rules.roleMappings ?? {}).length > 0
    || Object.keys(rules.typeMeta ?? {}).length > 0;
}

export class TeammateControlCenter implements Component, Focusable {
  focused = false;
  private tab: ControlCenterTab;
  private modelTaskType: TeammateTaskType | null = null;
  private modelRole: string | null = null;
  private editorKind: "menu" | "model" | "thinking" | "fallback" | "circuit" | "type" | "roles" = "menu";
  private circuitCustomMode = false;
  private readonly roleAssignmentDraft = new Set<string>();
  private customTypeInput = false;
  private customTypeDraft = "";
  private keywordsInput: { kind: "create" | "edit"; taskType: TeammateTaskType } | null = null;
  private keywordsDraft = "";
  private readonly queries: Record<ControlCenterTab, string> = { profiles: "", routing: "", roles: "", connections: "", active: "" };
  private modelQuery = "";
  private readonly selected: Record<ControlCenterTab, number> = { profiles: 0, routing: 0, roles: 0, connections: 0, active: 0 };
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
  private taskTypes: TeammateTaskType[];
  private readonly activeAgents: ControlCenterActiveAgent[];
  private readonly remotePane: RemoteConfigPane | undefined;
  private readonly t: TuiTranslator;
  private readonly localeDisposer: () => void;

  constructor(private readonly params: TeammateControlCenterParams) {
    this.t = createTuiTranslator(params.locale);
    this.localeDisposer = params.locale === undefined
      ? onTuiLocaleChange(() => {
          this.statusText = "";
          params.requestRender();
        })
      : () => {};
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
      ...Object.keys(activeProfile.typeMeta ?? {}),
      ...Object.values(activeProfile.roleMappings ?? {}).flatMap((rules) => rules?.taskType ? [rules.taskType] : []),
    ];
    this.taskTypes = [...new Set([...discoveredTaskTypes, ...profileTaskTypes])];
    this.activeAgents = [...params.activeAgents].sort((left, right) =>
      left.status.localeCompare(right.status) || left.startedAt - right.startedAt
    );
    this.remotePane = params.remoteState
      ? new RemoteConfigPane({
          state: params.remoteState,
          ...(params.deployments === undefined ? {} : { deployments: params.deployments }),
          theme: params.theme as unknown as { fg(role: string, text: string): string; bold(text: string): string },
          t: this.t,
          requestRender: () => params.requestRender(),
          close: (action) => params.close(action),
          onTest: params.onTestRemote ?? (() => Promise.resolve("")),
          ...(params.remoteTestTimeoutMs === undefined ? {} : { testTimeoutMs: params.remoteTestTimeoutMs }),
        })
      : undefined;
  }

  invalidate(): void {}

  dispose(): void {
    this.localeDisposer();
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.remotePane?.dispose();
  }

  handleInput(data: string): void {
    if (this.saving && !this.modelTaskType && !this.modelRole) return;
    if (this.lastWidth < 20) {
      if (matchesKey(data, Key.escape)) {
        if (this.modelTaskType || this.modelRole) this.handleModelInput(data);
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
    if (this.tab === "connections" && this.remotePane) {
      const text = token.kind === "paste" ? token.text : token.text;
      if (matchesKey(text, Key.tab)
        || matchesKey(text, Key.shift("tab"))
        || matchesKey(text, Key.left)
        || matchesKey(text, Key.right)) {
        this.handleDecodedInput(text);
        return;
      }
      this.remotePane.handleInput(text);
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    if (token.kind === "paste") {
      if (this.keywordsInput) {
        this.keywordsDraft += token.text;
      } else if (this.customTypeInput) {
        this.customTypeDraft += token.text;
      } else if (this.modelTaskType || this.modelRole) {
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
    if (this.tab === "connections" && this.remotePane) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
        this.switchTab(1);
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
        this.switchTab(-1);
        return;
      }
      this.remotePane.handleInput(data);
      this.params.requestRender();
      return;
    }
    if (this.keywordsInput) {
      this.handleKeywordsInput(data);
      return;
    }
    if (this.customTypeInput) {
      this.handleCustomTypeInput(data);
      return;
    }
    if (this.modelTaskType || this.modelRole) {
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
    if (matchesKey(data, Key.ctrl("right")) && this.tab === "roles") {
      this.activateRoleThinkingSelection();
      return;
    }
    if (matchesKey(data, Key.ctrl("f")) && this.tab === "roles") {
      this.activateRoleFallbackSelection();
      return;
    }
    if (matchesKey(data, Key.ctrl("o")) && this.tab === "roles") {
      this.activateRoleCircuitSelection();
      return;
    }
    if (matchesKey(data, Key.ctrl("t")) && this.tab === "roles") {
      this.activateRoleTypeSelection();
      return;
    }
    if (matchesKey(data, Key.ctrl("n")) && this.tab === "routing") {
      this.startCustomTypeInput();
      return;
    }
    if (matchesKey(data, Key.ctrl("e")) && this.tab === "routing") {
      this.startTypeMetaEdit();
      return;
    }
    if (matchesKey(data, Key.ctrl("d")) && this.tab === "routing") {
      this.deleteSelectedCustomType();
      return;
    }
    if (matchesKey(data, Key.ctrl("a")) && this.tab === "routing") {
      this.toggleAskBeforeDispatch();
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
    if (this.tab === "connections" && this.remotePane) return this.remotePane.render(w);
    const editing = !this.keywordsInput && !this.customTypeInput && (this.modelTaskType ?? this.modelRole);
    if (w < 24 || (editing && w < 40)) return [this.renderCompact(w)];
    return editing ? this.renderModels(w) : this.renderMain(w);
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
      if (item === NEW_CUSTOM_TYPE_ENTRY) {
        this.startCustomTypeInput();
        return;
      }
      this.modelTaskType = item;
      this.modelRole = null;
      this.editorKind = "menu";
      this.modelQuery = "";
      this.modelSelected = 0;
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    if (this.tab === "roles") {
      const agent = this.filteredRoles()[this.selected.roles];
      if (!agent) return;
      this.modelRole = agent.name;
      this.modelTaskType = null;
      this.editorKind = "menu";
      this.modelQuery = "";
      this.modelSelected = 0;
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

  private activateRoleThinkingSelection(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const agent = this.filteredRoles()[this.selected.roles];
    if (!agent) return;
    this.modelRole = agent.name;
    this.editorKind = "thinking";
    this.modelQuery = "";
    this.modelSelected = this.roleThinkingItems(agent.name).findIndex((entry) => entry.active);
    if (this.modelSelected < 0) this.modelSelected = 0;
    this.statusText = "";
    this.params.requestRender();
  }

  private activateRoleFallbackSelection(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const agent = this.filteredRoles()[this.selected.roles];
    if (!agent) return;
    this.modelRole = agent.name;
    this.editorKind = "fallback";
    this.fallbackDraft = [...(this.roleRules(agent.name)?.fallbackModels ?? [])];
    this.modelQuery = "";
    this.modelSelected = 0;
    this.statusText = "";
    this.params.requestRender();
  }

  private activateRoleCircuitSelection(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const agent = this.filteredRoles()[this.selected.roles];
    if (!agent) return;
    this.modelRole = agent.name;
    this.editorKind = "circuit";
    this.circuitCustomMode = false;
    this.modelQuery = "";
    this.modelSelected = this.circuitItems(agent.name).findIndex((entry) => entry.active);
    if (this.modelSelected < 0) this.modelSelected = 0;
    this.statusText = "";
    this.params.requestRender();
  }

  private activateRoleTypeSelection(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const agent = this.filteredRoles()[this.selected.roles];
    if (!agent) return;
    this.modelRole = agent.name;
    this.editorKind = "type";
    this.modelQuery = "";
    this.modelSelected = this.roleTypeItems(agent.name).findIndex((entry) => entry.active);
    if (this.modelSelected < 0) this.modelSelected = 0;
    this.statusText = "";
    this.params.requestRender();
  }

  private settingsMenuItems(): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
  }> {
    const role = this.modelRole;
    const taskType = this.modelTaskType;
    if (role) {
      const rules = this.roleRules(role);
      const agent = this.agents.find((candidate) => candidate.name === role);
      const assignedType = rules?.taskType ?? agent?.taskType;
      const typeModel = assignedType ? this.config.mappings[assignedType] : undefined;
      return [
        {
          value: "type",
          label: this.t("model.setting.type"),
          detail: assignedType
            ? `${assignedType}${typeModel
                ? ` · ${this.t("model.route.routesTo", { model: typeModel })}`
                : ` · ${this.t("model.route.notPinned")}`}`
            : this.t("model.route.frontmatter"),
          active: Boolean(rules?.taskType),
          unavailable: false,
        },
        {
          value: "model",
          label: this.t("model.setting.modelOverride"),
          detail: rules?.model
            ? `${rules.model}${assignedType && typeModel ? ` · ${this.t("model.route.behindType", { type: assignedType })}` : ""}`
            : assignedType && typeModel
              ? this.t("model.route.inheritType", { value: typeModel })
              : this.t("model.route.inheritModel"),
          active: Boolean(rules?.model),
          unavailable: false,
        },
        {
          value: "thinking",
          label: this.t("model.setting.thinkingOverride"),
          detail: rules?.thinking
            ? `${rules.thinking}${assignedType && this.config.thinkingLevels[assignedType]
                ? ` · ${this.t("model.route.behindType", { type: assignedType })}`
                : ""}`
            : assignedType && this.config.thinkingLevels[assignedType]
              ? this.t("model.route.inheritType", { value: this.config.thinkingLevels[assignedType]! })
              : this.t("model.route.inheritThinking"),
          active: Boolean(rules?.thinking),
          unavailable: false,
        },
        {
          value: "fallback",
          label: this.t("model.setting.fallbackOverride"),
          detail: rules?.fallbackModels?.length
            ? `${rules.fallbackModels.join(" → ")}${assignedType && this.config.fallbackMappings?.[assignedType]?.length
                ? ` · ${this.t("model.route.behindType", { type: assignedType })}`
                : ""}`
            : assignedType && this.config.fallbackMappings?.[assignedType]?.length
              ? this.t("model.route.inheritType", { value: this.config.fallbackMappings[assignedType]!.join(" → ") })
              : this.t("common.none"),
          active: Boolean(rules?.fallbackModels?.length),
          unavailable: false,
        },
        {
          value: "circuit",
          label: this.t("model.setting.circuit"),
          detail: circuitDisplayText(rules?.circuit, this.t),
          active: Boolean(rules?.circuit),
          unavailable: false,
        },
      ];
    }
    if (!taskType) return [];
    const assignedRoles = this.assignedRoles(taskType);
    const keywords = this.config.typeMeta?.[taskType]?.keywords ?? [];
    return [
      {
        value: "model",
        label: this.t("model.setting.model"),
        detail: this.config.mappings[taskType] ?? this.t("model.route.autoMain"),
        active: Boolean(this.config.mappings[taskType]),
        unavailable: false,
      },
      {
        value: "thinking",
        label: this.t("model.setting.thinking"),
        detail: this.config.thinkingLevels[taskType] ?? this.t("model.route.inheritThinking"),
        active: Boolean(this.config.thinkingLevels[taskType]),
        unavailable: false,
      },
      {
        value: "fallback",
        label: this.t("model.setting.fallbacks"),
        detail: this.config.fallbackMappings?.[taskType]?.length
          ? this.config.fallbackMappings[taskType]!.join(" → ")
          : this.t("common.none"),
        active: Boolean(this.config.fallbackMappings?.[taskType]?.length),
        unavailable: false,
      },
      {
        value: "roles",
        label: this.t("model.setting.roles"),
        detail: assignedRoles.length > 0
          ? assignedRoles.map((name) => `@${name}`).join(", ")
          : this.t("model.route.noneAssigned"),
        active: assignedRoles.length > 0,
        unavailable: false,
      },
      {
        value: "keywords",
        label: this.t("model.setting.keywords"),
        detail: keywords.length > 0 ? keywords.join(", ") : this.t("common.none"),
        active: keywords.length > 0,
        unavailable: false,
      },
    ];
  }

  private assignedRoles(taskType: TeammateTaskType): string[] {
    return this.agents
      .filter((agent) => this.roleRules(agent.name)?.taskType === taskType)
      .map((agent) => agent.name);
  }

  private openSelectedSetting(): void {
    const target = this.settingsMenuItems()[this.modelSelected]?.value;
    const role = this.modelRole;
    const taskType = this.modelTaskType;
    if (!target || (!role && !taskType)) return;
    this.modelQuery = "";
    this.statusText = "";
    if (target === "keywords" && taskType) {
      this.keywordsInput = { kind: "edit", taskType };
      this.keywordsDraft = (this.config.typeMeta?.[taskType]?.keywords ?? []).join(", ");
      this.params.requestRender();
      return;
    }
    this.editorKind = target as "model" | "thinking" | "fallback" | "circuit" | "type" | "roles";
    if (target === "fallback") {
      this.fallbackDraft = role
        ? [...(this.roleRules(role)?.fallbackModels ?? [])]
        : [...(this.config.fallbackMappings?.[taskType as TeammateTaskType] ?? [])];
      this.modelSelected = 0;
    } else if (target === "roles" && taskType) {
      this.roleAssignmentDraft.clear();
      for (const name of this.assignedRoles(taskType)) this.roleAssignmentDraft.add(name);
      this.modelSelected = 0;
    } else {
      const items = this.filteredEditorItems();
      this.modelSelected = items.findIndex((entry) => entry.active);
      if (this.modelSelected < 0) this.modelSelected = 0;
    }
    this.params.requestRender();
  }

  private returnToSettingsMenu(): void {
    this.editorKind = "menu";
    this.modelQuery = "";
    this.circuitCustomMode = false;
    this.roleAssignmentDraft.clear();
    this.modelSelected = 0;
    this.params.requestRender();
  }

  private roleAssignmentItems(taskType: TeammateTaskType): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
  }> {
    return this.agents.map((agent) => {
      const currentType = this.roleRules(agent.name)?.taskType ?? agent.taskType;
      return {
        value: agent.name,
        label: `@${agent.name}`,
        detail: currentType
          ? this.t("model.role.currentType", { type: currentType })
          : this.t("model.role.noType", { source: agent.source }),
        active: this.roleAssignmentDraft.has(agent.name),
        unavailable: false,
      };
    });
  }

  private roleTypeItems(role: string): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
  }> {
    const configured = this.roleRules(role)?.taskType;
    const agent = this.agents.find((candidate) => candidate.name === role);
    const declared = agent?.taskType;
    const items: Array<{
      value: string;
      label: string;
      detail: string;
      active: boolean;
      unavailable: boolean;
    }> = [{
      value: "__auto__",
      label: this.t("model.role.autoFrontmatter"),
      detail: declared
        ? this.t("model.role.declaredType", { type: declared })
        : this.t("model.role.promptInference"),
      active: !configured,
      unavailable: false,
    }];
    for (const taskType of this.taskTypes) {
      const meta = this.taskTypeMeta(taskType);
      items.push({
        value: taskType,
        label: meta.label,
        detail: taskType,
        active: configured === taskType,
        unavailable: false,
      });
    }
    return items;
  }

  private roleRules(role: string): ModelRoutingRoleRules | undefined {
    const rules = this.config.roleMappings?.[role];
    return rules && rules !== null ? rules : undefined;
  }

  private editorTargetLabel(): string {
    if (this.modelRole) return `@${this.modelRole}`;
    if (this.modelTaskType) return this.taskTypeMeta(this.modelTaskType).label;
    return "…";
  }

  private handleModelInput(data: string): void {
    if (this.saving) return;
    if (this.editorKind === "fallback") {
      this.handleFallbackInput(data);
      return;
    }
    if (this.editorKind === "roles") {
      this.handleRoleAssignmentInput(data);
      return;
    }
    if (this.editorKind === "circuit" && this.circuitCustomMode) {
      this.handleCircuitCustomInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.editorKind === "menu") {
        this.modelTaskType = null;
        this.modelRole = null;
        this.circuitCustomMode = false;
        this.roleAssignmentDraft.clear();
        this.modelQuery = "";
        this.statusText = "";
        this.params.requestRender();
      } else {
        this.returnToSettingsMenu();
      }
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (this.editorKind === "menu") {
        this.modelTaskType = null;
        this.modelRole = null;
        this.modelQuery = "";
        this.statusText = "";
        this.params.requestRender();
      } else {
        this.returnToSettingsMenu();
      }
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
    if (matchesKey(data, Key.enter) || (this.editorKind === "menu" && matchesKey(data, Key.right))) {
      if (this.editorKind === "menu") {
        this.openSelectedSetting();
        return;
      }
      const taskType = this.modelTaskType;
      const role = this.modelRole;
      const item = items[this.modelSelected];
      if ((!taskType && !role) || !item) return;
      if (this.editorKind === "circuit" && item.value === "__custom__") {
        this.circuitCustomMode = true;
        this.modelQuery = circuitDraftText(role ? this.roleRules(role)?.circuit : undefined);
        this.statusText = "";
        this.params.requestRender();
        return;
      }
      this.saving = true;
      this.statusTone = "dim";
      this.statusText = this.t("model.saving", { target: this.editorTargetLabel() });
      this.params.requestRender();
      this.persistenceTimer = setTimeout(() => {
        this.persistenceTimer = undefined;
        try {
          const editorKind = this.editorKind;
          if (role) {
            const existing = this.roleRules(role) ?? {};
            let rules: ModelRoutingRoleRules;
            let savedText: string;
            if (editorKind === "thinking") {
              const thinking = item.value === "__auto__" ? null : item.value as TeammateThinkingLevel;
              rules = { ...existing, thinking };
              savedText = thinking ?? this.t("model.route.inheritThinking");
            } else if (editorKind === "type") {
              const taskType = item.value === "__auto__" ? null : item.value;
              rules = { ...existing, taskType };
              savedText = taskType ?? this.t("model.role.autoFrontmatter");
            } else if (editorKind === "circuit") {
              const circuit = item.value === "__auto__"
                ? null
                : (item as { policy?: ModelCircuitPolicy }).policy ?? null;
              rules = { ...existing, circuit };
              savedText = circuitDisplayText(circuit, this.t);
            } else {
              const model = item.value === "__auto__" ? null : item.value;
              rules = { ...existing, model };
              savedText = model ?? this.t("model.route.autoMain");
            }
            if (this.params.saveRoleRules) this.params.saveRoleRules(role, rules);
            else saveGlobalProfileRoleMapping(this.params.cwd, this.config.profileId, role, rules, this.params.globalFilePath);
            this.config.roleMappings = { ...(this.config.roleMappings ?? {}), [role]: rules };
            this.saving = false;
            this.statusTone = "success";
            this.statusText = this.t("model.saved", {
              target: `@${role}`,
              kind: this.editorSaveLabel(),
              value: savedText,
            });
            this.returnToSettingsMenu();
            return;
          }
          const value = item.value === "__auto__" ? null : item.value;
          if (editorKind === "thinking") {
            const thinking = value as TeammateThinkingLevel | null;
            if (this.params.saveThinking) this.params.saveThinking(taskType as TeammateTaskType, thinking);
            else saveGlobalProfileThinkingLevel(this.params.cwd, this.config.profileId, taskType as TeammateTaskType, thinking, this.params.globalFilePath);
            this.config.thinkingLevels[taskType as TeammateTaskType] = thinking;
          } else {
            if (this.params.saveMapping) this.params.saveMapping(taskType as TeammateTaskType, value);
            else saveGlobalProfileModelMapping(this.params.cwd, this.config.profileId, taskType as TeammateTaskType, value, this.params.globalFilePath);
            this.config.mappings[taskType as TeammateTaskType] = value;
          }
          this.saving = false;
          this.statusTone = "success";
          this.statusText = this.t("model.saved", {
            target: taskType as TeammateTaskType,
            kind: this.editorSaveLabel(),
            value: value ?? (editorKind === "thinking"
              ? this.t("model.route.inheritThinking")
              : this.t("model.route.autoMain")),
          });
          this.returnToSettingsMenu();
        } catch (error) {
          this.saving = false;
          this.statusTone = "error";
          this.statusText = this.t("model.saveFailed", {
            message: error instanceof Error ? error.message : String(error),
          });
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

  private handleRoleAssignmentInput(data: string): void {
    if (this.saving) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.returnToSettingsMenu();
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
    if (matchesKey(data, Key.space) || data === " ") {
      const item = items[this.modelSelected];
      if (!item) return;
      if (this.roleAssignmentDraft.has(item.value)) this.roleAssignmentDraft.delete(item.value);
      else this.roleAssignmentDraft.add(item.value);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.commitRoleAssignments();
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

  private commitRoleAssignments(): void {
    const taskType = this.modelTaskType;
    if (!taskType || this.saving) return;
    this.saving = true;
    this.statusTone = "dim";
    this.statusText = this.t("model.savingRoles", { type: taskType });
    this.params.requestRender();
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      try {
        const roleMappings = { ...(this.config.roleMappings ?? {}) };
        const requestedRoles = [...this.roleAssignmentDraft];
        const changes: Array<{ role: string; rules: ModelRoutingRoleRules }> = [];
        for (const agent of this.agents) {
          const existing = this.roleRules(agent.name) ?? {};
          const assigned = existing.taskType === taskType;
          const requested = this.roleAssignmentDraft.has(agent.name);
          if (assigned === requested) continue;
          const rules: ModelRoutingRoleRules = { ...existing, taskType: requested ? taskType : null };
          changes.push({ role: agent.name, rules });
          roleMappings[agent.name] = rules;
        }
        if (this.params.saveTypeRoles) {
          this.params.saveTypeRoles(taskType, requestedRoles);
        } else if (this.params.saveRoleRules) {
          for (const change of changes) this.params.saveRoleRules(change.role, change.rules);
        } else {
          saveGlobalProfileTypeRoles(this.params.cwd, this.config.profileId, taskType, requestedRoles, this.params.globalFilePath);
        }
        this.config.roleMappings = roleMappings;
        this.saving = false;
        this.statusTone = "success";
        const assignedNames = [...this.roleAssignmentDraft];
        this.statusText = this.t("model.savedRoles", {
          roles: assignedNames.length > 0
            ? assignedNames.map((name) => `@${name}`).join(", ")
            : this.t("common.none"),
        });
        this.returnToSettingsMenu();
      } catch (error) {
        this.saving = false;
        this.statusTone = "error";
        this.statusText = this.t("model.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.params.requestRender();
      }
    }, 16);
  }

  private handleCircuitCustomInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.circuitCustomMode = false;
      this.modelQuery = "";
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.commitCircuitCustom();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.modelQuery) {
        this.modelQuery = removeLastGrapheme(this.modelQuery);
        this.statusText = "";
        this.params.requestRender();
      }
      return;
    }
    const input = printableInput(data);
    if (input && /^[0-9/]*$/.test(input)) {
      this.modelQuery += input;
      this.statusText = "";
      this.params.requestRender();
    }
  }

  private commitCircuitCustom(): void {
    const role = this.modelRole;
    if (!role || this.saving) return;
    const policy = parseCircuitDraft(this.modelQuery.trim());
    if (!policy) {
      this.statusTone = "error";
      this.statusText = this.t("model.invalidCircuit");
      this.params.requestRender();
      return;
    }
    this.saving = true;
    this.statusTone = "dim";
    this.statusText = this.t("model.savingCircuit", { role });
    this.params.requestRender();
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      try {
        const existing = this.roleRules(role) ?? {};
        const rules = { ...existing, circuit: policy };
        if (this.params.saveRoleRules) this.params.saveRoleRules(role, rules);
        else saveGlobalProfileRoleMapping(this.params.cwd, this.config.profileId, role, rules, this.params.globalFilePath);
        this.config.roleMappings = { ...(this.config.roleMappings ?? {}), [role]: rules };
        this.saving = false;
        this.statusTone = "success";
        this.statusText = this.t("model.savedCircuit", {
          role,
          value: circuitDisplayText(policy, this.t),
        });
        this.returnToSettingsMenu();
      } catch (error) {
        this.saving = false;
        this.statusTone = "error";
        this.statusText = this.t("model.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.params.requestRender();
      }
    }, 16);
  }

  private startCustomTypeInput(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    this.customTypeInput = true;
    this.customTypeDraft = "";
    this.statusText = "";
    this.params.requestRender();
  }

  private handleCustomTypeInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.customTypeInput = false;
      this.customTypeDraft = "";
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.commitCustomType();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.customTypeDraft) {
        this.customTypeDraft = removeLastGrapheme(this.customTypeDraft);
        this.statusText = "";
        this.params.requestRender();
      }
      return;
    }
    const input = printableInput(data);
    if (input) {
      this.customTypeDraft += input;
      this.statusText = "";
      this.params.requestRender();
    }
  }

  private commitCustomType(): void {
    if (this.saving) return;
    const taskType = parseTeammateTaskType(this.customTypeDraft);
    if (!taskType) {
      this.statusTone = "error";
      this.statusText = this.t("model.invalidType");
      this.params.requestRender();
      return;
    }
    if ((TEAMMATE_TASK_TYPES as readonly string[]).includes(taskType)) {
      this.statusTone = "error";
      this.statusText = this.t("model.builtinType", { type: taskType });
      this.params.requestRender();
      return;
    }
    if (this.taskTypes.includes(taskType)) {
      this.statusTone = "error";
      this.statusText = this.t("model.typeExists", { type: taskType });
      this.params.requestRender();
      return;
    }
    // Step 2: optional trigger keywords (comma-separated).
    this.customTypeInput = false;
    this.keywordsInput = { kind: "create", taskType };
    this.keywordsDraft = "";
    this.statusText = "";
    this.params.requestRender();
  }

  private handleKeywordsInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.keywordsInput = null;
      this.keywordsDraft = "";
      this.customTypeDraft = "";
      this.statusText = "";
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.commitKeywords();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.keywordsDraft) {
        this.keywordsDraft = removeLastGrapheme(this.keywordsDraft);
        this.statusText = "";
        this.params.requestRender();
      }
      return;
    }
    const input = printableInput(data);
    if (input) {
      this.keywordsDraft += input;
      this.statusText = "";
      this.params.requestRender();
    }
  }

  private commitKeywords(): void {
    const target = this.keywordsInput;
    if (!target || this.saving) return;
    const keywords = parseKeywordsDraft(this.keywordsDraft);
    const meta: ModelRoutingTypeMeta = keywords.length > 0 ? { keywords } : { keywords: null };
    this.saving = true;
    this.statusTone = "dim";
    this.statusText = target.kind === "create"
      ? this.t("model.savingCustomType", { type: target.taskType })
      : this.t("model.savingKeywords", { type: target.taskType });
    this.params.requestRender();
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      try {
        if (target.kind === "create") {
          if (this.params.saveCustomType) this.params.saveCustomType(target.taskType, meta);
          else saveGlobalProfileCustomType(this.params.cwd, this.config.profileId, target.taskType, meta, this.params.globalFilePath);
          this.config.mappings[target.taskType] = null;
          if (keywords.length > 0) {
            this.config.typeMeta = { ...(this.config.typeMeta ?? {}), [target.taskType]: { keywords } };
          }
          this.refreshTaskTypes();
          this.queries.routing = "";
          const index = this.taskTypes.indexOf(target.taskType);
          if (index >= 0) this.selected.routing = index;
          this.statusText = this.t("model.createdType", { type: target.taskType });
        } else {
          if (this.params.saveTypeMeta) this.params.saveTypeMeta(target.taskType, meta);
          else saveGlobalProfileTypeMeta(this.params.cwd, this.config.profileId, target.taskType, meta, this.params.globalFilePath);
          const next = this.config.typeMeta ?? {};
          if (keywords.length > 0) next[target.taskType] = { keywords };
          else delete next[target.taskType];
          this.config.typeMeta = next;
          this.statusText = keywords.length > 0
            ? this.t("model.savedKeywords", { type: target.taskType })
            : this.t("model.clearedKeywords", { type: target.taskType });
        }
        this.keywordsInput = null;
        this.keywordsDraft = "";
        this.saving = false;
        this.statusTone = "success";
        this.params.requestRender();
      } catch (error) {
        this.saving = false;
        this.statusTone = "error";
        this.statusText = this.t("model.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.params.requestRender();
      }
    }, 16);
  }

  private startTypeMetaEdit(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const taskType = this.filteredTaskTypes()[this.selected.routing];
    if (!taskType || taskType === NEW_CUSTOM_TYPE_ENTRY) return;
    this.keywordsInput = { kind: "edit", taskType };
    this.keywordsDraft = (this.config.typeMeta?.[taskType]?.keywords ?? []).join(", ");
    this.statusText = "";
    this.params.requestRender();
  }

  private deleteSelectedCustomType(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const taskType = this.filteredTaskTypes()[this.selected.routing];
    if (!taskType || taskType === NEW_CUSTOM_TYPE_ENTRY) return;
    if ((TEAMMATE_TASK_TYPES as readonly string[]).includes(taskType)) {
      this.statusTone = "error";
      this.statusText = this.t("model.builtinDelete");
      this.params.requestRender();
      return;
    }
    this.saving = true;
    this.statusTone = "dim";
    this.statusText = this.t("model.deleting", { type: this.taskTypeMeta(taskType).label });
    this.params.requestRender();
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      try {
        if (this.params.deleteCustomType) this.params.deleteCustomType(taskType);
        else deleteGlobalProfileCustomType(this.params.cwd, this.config.profileId, taskType, this.params.globalFilePath);
        delete this.config.mappings[taskType];
        if (this.config.fallbackMappings) delete this.config.fallbackMappings[taskType];
        if (this.config.thinkingLevels) delete this.config.thinkingLevels[taskType];
        if (this.config.typeMeta) delete this.config.typeMeta[taskType];
        if (this.config.roleMappings) {
          for (const [role, rules] of Object.entries(this.config.roleMappings)) {
            if (rules?.taskType === taskType) this.config.roleMappings[role] = { ...rules, taskType: null };
          }
        }
        const declaredByAgent = this.agents.some((agent) => agent.taskType === taskType);
        this.refreshTaskTypes();
        this.selected.routing = clampIndex(this.selected.routing, this.filteredTaskTypes().length);
        this.saving = false;
        this.statusTone = "success";
        this.statusText = declaredByAgent
          ? this.t("model.resetType", { type: taskType })
          : this.t("model.deletedType", { type: taskType });
        this.params.requestRender();
      } catch (error) {
        this.saving = false;
        this.statusTone = "error";
        this.statusText = this.t("model.deleteFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.params.requestRender();
      }
    }, 16);
  }

  private refreshTaskTypes(): void {
    this.taskTypes = discoverRoutingTaskTypes(this.params.cwd, this.agents, this.config);
  }

  private editorSaveLabel(): string {
    if (this.editorKind === "thinking") return this.t("model.kind.thinking");
    if (this.editorKind === "circuit") return this.t("model.kind.circuit");
    if (this.editorKind === "type") return this.t("model.kind.type");
    return this.t("model.kind.model");
  }

  private handleFallbackInput(data: string): void {
    if (this.saving) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.fallbackDraft = [];
      this.returnToSettingsMenu();
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

  private fallbackItems(_target: string): Array<{
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
          : this.t("model.notAuthenticated"),
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
    if (priority < 0) return [this.t("model.notInFallback"), circuit].filter(Boolean).join(" · ");
    return [this.t("model.fallbackPriority", { priority }), circuit].filter(Boolean).join(" · ");
  }

  private circuitNote(model: string): string {
    const health = this.health.get(model);
    if (!health || health.state === "CLOSED") return "";
    const detail = health.state === "OPEN"
      ? this.t("model.circuitOpen")
      : this.t("model.circuitHalfOpen");
    return health.consecutiveFailures > 0
      ? this.t("model.circuitFailures", { detail, count: health.consecutiveFailures })
      : detail;
  }

  private editorLabel(): string {
    if (this.editorKind === "menu") return this.t("model.editor.settings");
    if (this.editorKind === "fallback") return this.t("model.editor.fallback");
    if (this.editorKind === "thinking") return this.t("model.editor.thinking");
    if (this.editorKind === "circuit") return this.t("model.editor.circuit");
    if (this.editorKind === "type") return this.t("model.editor.type");
    if (this.editorKind === "roles") return this.t("model.editor.roles");
    return this.t("model.editor.model");
  }

  private toggleFallbackItem(): void {
    const taskType = this.modelTaskType;
    const role = this.modelRole;
    const item = this.filteredEditorItems()[this.modelSelected];
    if ((!taskType && !role) || !item) return;
    const index = this.fallbackDraft.indexOf(item.value);
    if (index >= 0) this.fallbackDraft.splice(index, 1);
    else this.fallbackDraft.push(item.value);
    this.modelSelected = this.fallbackItems(role ?? (taskType as TeammateTaskType)).findIndex((entry) => entry.value === item.value);
    if (this.modelSelected < 0) this.modelSelected = 0;
    this.statusText = "";
    this.params.requestRender();
  }

  private reorderFallback(direction: -1 | 1): void {
    const taskType = this.modelTaskType;
    const role = this.modelRole;
    const item = this.filteredEditorItems()[this.modelSelected];
    if ((!taskType && !role) || !item) return;
    const index = this.fallbackDraft.indexOf(item.value);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= this.fallbackDraft.length) return;
    [this.fallbackDraft[index], this.fallbackDraft[target]] = [this.fallbackDraft[target], this.fallbackDraft[index]];
    this.modelSelected = this.fallbackItems(role ?? (taskType as TeammateTaskType)).findIndex((entry) => entry.value === item.value);
    if (this.modelSelected < 0) this.modelSelected = 0;
    this.params.requestRender();
  }

  private commitFallback(): void {
    const taskType = this.modelTaskType;
    const role = this.modelRole;
    if (!taskType && !role) return;
    this.saving = true;
    this.statusTone = "dim";
    this.statusText = this.t("model.savingFallbacks", { target: this.editorTargetLabel() });
    this.params.requestRender();
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      try {
        const models = this.fallbackDraft.length > 0 ? [...this.fallbackDraft] : null;
        if (role) {
          const existing = this.roleRules(role) ?? {};
          const rules = { ...existing, fallbackModels: models };
          if (this.params.saveRoleRules) this.params.saveRoleRules(role, rules);
          else saveGlobalProfileRoleMapping(this.params.cwd, this.config.profileId, role, rules, this.params.globalFilePath);
          this.config.roleMappings = { ...(this.config.roleMappings ?? {}), [role]: rules };
        } else if (taskType) {
          if (this.params.saveFallbacks) this.params.saveFallbacks(taskType, models);
          else saveProjectFallbackMapping(this.params.cwd, taskType, models, this.params.globalFilePath);
          this.config.fallbackMappings = { ...(this.config.fallbackMappings ?? {}), [taskType]: models };
        }
        this.saving = false;
        this.statusTone = "success";
        this.statusText = this.t("model.savedFallbacks", {
          models: models ? models.join(", ") : this.t("common.none"),
        });
        this.fallbackDraft = [];
        this.returnToSettingsMenu();
      } catch (error) {
        this.saving = false;
        this.statusTone = "error";
        this.statusText = this.t("model.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.params.requestRender();
      }
    }, 16);
  }

  private taskTypeMeta(taskType: TeammateTaskType): { label: string; roles: string; description: string } {
    const known = TEAMMATE_TASK_TYPE_META[taskType];
    if (known) {
      return {
        ...known,
        label: this.t(`task.${taskType}.label` as TuiTranslationKey),
        description: this.t(`task.${taskType}.description` as TuiTranslationKey),
      };
    }
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
      roles: roles || this.t("model.customAgent"),
      description: this.t("model.customDescription"),
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
    const types = query
      ? this.taskTypes.filter((taskType) => {
        const meta = this.taskTypeMeta(taskType);
        const mapping = this.config.mappings[taskType] ?? "auto";
        const thinking = this.config.thinkingLevels[taskType] ?? "inherit";
        return `${taskType} ${meta.label} ${meta.roles} ${meta.description} ${mapping} ${thinking}`.toLowerCase().includes(query);
      })
      : [...this.taskTypes];
    const customTypeSearch = `${this.t("model.customTypeSearch")} new custom type`.toLowerCase();
    if (!query || customTypeSearch.includes(query)) types.push(NEW_CUSTOM_TYPE_ENTRY as TeammateTaskType);
    return types;
  }

  private filteredRoles(): AgentConfig[] {
    const query = this.queries.roles.toLowerCase();
    if (!query) return this.agents;
    return this.agents.filter((agent) => {
      const rules = this.roleRules(agent.name);
      const circuit = rules?.circuit;
      return `${agent.name} ${agent.description} ${agent.source} ${agent.taskType ?? ""} ${agent.model ?? ""} ${rules?.taskType ?? ""} ${rules?.model ?? ""} ${(rules?.fallbackModels ?? []).join(" ")} ${rules?.thinking ?? ""} ${circuit ? `${circuit.threshold ?? CIRCUIT_DEFAULT_THRESHOLD} ${Math.round((circuit.cooldownMs ?? CIRCUIT_DEFAULT_COOLDOWN_MS) / 1000)}` : ""} ${(agent.tools ?? []).join(" ")}`
        .toLowerCase()
        .includes(query);
    });
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

  private modelPickerItems(configured: string | undefined, ownerLabel: string): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
  }> {
    const items = [{
      value: "__auto__",
      label: this.t("model.autoPicker"),
      detail: this.t("model.autoPickerDetail"),
      active: !configured,
      unavailable: false,
    }];
    for (const model of this.models) {
      items.push({
        value: model,
        label: model,
        detail: [
          model === configured
            ? this.t("model.currentModel", { owner: ownerLabel })
            : this.t("model.authenticated"),
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
        detail: this.t("model.configuredUnavailable"),
        active: true,
        unavailable: true,
      });
    }
    return items;
  }

  private modelItems(taskType: TeammateTaskType): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
  }> {
    return this.modelPickerItems(this.config.mappings[taskType] ?? undefined, taskType);
  }

  private roleModelItems(role: string): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
  }> {
    return this.modelPickerItems(this.roleRules(role)?.model ?? undefined, `@${role}`);
  }

  private thinkingPickerItems(configured: TeammateThinkingLevel | undefined, routedModel: string | undefined, ownerLabel: string) {
    const items = [{
      value: "__auto__",
      label: this.t("model.route.inheritThinking"),
      detail: this.t("model.thinkingAutoDetail"),
      active: !configured,
      unavailable: false,
    }, ...TEAMMATE_THINKING_LEVELS
      .map((thinking) => ({
        value: thinking,
        label: thinking === "xhigh" ? "xhigh / max" : thinking,
        detail: thinking === configured
          ? this.t("model.currentThinking", { owner: ownerLabel })
          : routedModel
            ? this.t("model.appliesModel", { model: routedModel })
            : this.t("model.appliesRouted"),
        active: thinking === configured,
        // Thinking depth is never restricted by model capability; the child
        // Pi host clamps to its provider-specific boundary if needed.
        unavailable: false,
      }))];
    return items;
  }

  private thinkingItems(taskType: TeammateTaskType) {
    return this.thinkingPickerItems(
      this.config.thinkingLevels[taskType] ?? undefined,
      this.config.mappings[taskType] ?? undefined,
      taskType,
    );
  }

  private roleThinkingItems(role: string) {
    const rules = this.roleRules(role);
    return this.thinkingPickerItems(rules?.thinking ?? undefined, rules?.model ?? undefined, `@${role}`);
  }

  private circuitItems(role: string): Array<{
    value: string;
    label: string;
    detail: string;
    active: boolean;
    unavailable: boolean;
    policy?: ModelCircuitPolicy;
  }> {
    const configured = this.roleRules(role)?.circuit;
    const matchesPreset = (policy: ModelCircuitPolicy): boolean =>
      (configured?.threshold ?? CIRCUIT_DEFAULT_THRESHOLD) === (policy.threshold ?? CIRCUIT_DEFAULT_THRESHOLD)
      && (configured?.cooldownMs ?? CIRCUIT_DEFAULT_COOLDOWN_MS) === (policy.cooldownMs ?? CIRCUIT_DEFAULT_COOLDOWN_MS);
    const items: Array<{
      value: string;
      label: string;
      detail: string;
      active: boolean;
      unavailable: boolean;
      policy?: ModelCircuitPolicy;
    }> = [{
      value: "__auto__",
      label: this.t("model.circuit.defaultPicker", {
        threshold: CIRCUIT_DEFAULT_THRESHOLD,
        seconds: Math.round(CIRCUIT_DEFAULT_COOLDOWN_MS / 1000),
      }),
      detail: this.t("model.circuitShared"),
      active: !configured,
      unavailable: false,
    }];
    for (const preset of CIRCUIT_PRESETS) {
      items.push({
        value: preset.value,
        label: this.t(preset.labelKey),
        detail: this.t(preset.detailKey),
        active: configured !== undefined && configured !== null && matchesPreset(preset.policy),
        unavailable: false,
        policy: preset.policy,
      });
    }
    items.push({
      value: "__custom__",
      label: configured
        ? this.t("model.circuitCustomValue", { value: circuitDisplayText(configured, this.t) })
        : this.t("model.circuitCustom"),
      detail: this.t("model.circuitPrompt"),
      active: configured !== undefined && configured !== null && !CIRCUIT_PRESETS.some((preset) => matchesPreset(preset.policy)),
      unavailable: false,
    });
    return items;
  }

  private filteredEditorItems() {
    const role = this.modelRole;
    const taskType = this.modelTaskType;
    if (!role && !taskType) return [];
    const items = this.editorKind === "menu"
      ? this.settingsMenuItems()
      : this.editorKind === "thinking"
        ? (role ? this.roleThinkingItems(role) : this.thinkingItems(taskType as TeammateTaskType))
        : this.editorKind === "fallback"
          ? this.fallbackItems(role ?? (taskType as TeammateTaskType))
          : this.editorKind === "circuit"
            ? this.circuitItems(role as string)
            : this.editorKind === "type"
              ? this.roleTypeItems(role as string)
              : this.editorKind === "roles"
                ? this.roleAssignmentItems(taskType as TeammateTaskType)
                : (role ? this.roleModelItems(role) : this.modelItems(taskType as TeammateTaskType));
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
    if (this.keywordsInput) {
      const marker = this.focused ? CURSOR_MARKER : "";
      const draft = this.keywordsDraft
        ? `${displayText(this.keywordsDraft)}${marker}`
        : `${marker}${this.params.theme.fg("dim", this.t("model.keywordsPlaceholder"))}`;
      rows.push(`${this.params.theme.fg("accent", "›")} ${draft}`);
      rows.push(this.params.theme.fg("dim", "─".repeat(inner)));
      rows.push(this.params.theme.fg("muted", this.t("model.keywordsHelp", {
        type: displayText(this.keywordsInput.taskType),
      })));
      if (this.statusText) rows.push(this.statusLine(inner));
      rows.push(truncateToWidth(
        this.t("model.keywordsFooter"),
        inner,
        "…",
      ));
      return this.frame(rows, width);
    }
    if (this.customTypeInput) {
      const marker = this.focused ? CURSOR_MARKER : "";
      const draft = this.customTypeDraft
        ? `${displayText(this.customTypeDraft)}${marker}`
        : `${marker}${this.params.theme.fg("dim", this.t("model.typePlaceholder"))}`;
      rows.push(`${this.params.theme.fg("accent", "›")} ${draft}`);
      rows.push(this.params.theme.fg("dim", "─".repeat(inner)));
      rows.push(this.params.theme.fg("muted", this.t("model.newTypeHelp")));
      if (this.statusText) rows.push(this.statusLine(inner));
      rows.push(truncateToWidth(
        this.t("model.newTypeFooter"),
        inner,
        "…",
      ));
      return this.frame(rows, width);
    }
    rows.push(this.filterLine(inner, this.queries[this.tab], items.length));
    rows.push(this.params.theme.fg("dim", "─".repeat(inner)));
    if (this.tab === "routing") {
      rows.push(this.askToggleLine(inner));
      rows.push(this.params.theme.fg("dim", "─".repeat(inner)));
    }

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
    const role = this.modelRole;
    if (!taskType && !role) return this.renderMain(width);
    const inner = width - 2;
    const items = this.filteredEditorItems();
    this.modelSelected = clampIndex(this.modelSelected, items.length);
    const meta = taskType ? this.taskTypeMeta(taskType) : undefined;
    const roleAgent = role ? this.agents.find((agent) => agent.name === role) : undefined;
    const headerSub = role
      ? (roleAgent?.description ?? this.t("model.customRole"))
      : displayText(meta?.roles ?? "");
    const headerLabel = role ? `@${displayText(role)}` : displayText(meta?.label ?? "");
    const rows: string[] = [
      truncateToWidth(
        `${this.params.theme.fg("accent", this.params.theme.bold(this.t("model.title")))} ${this.params.theme.fg("dim", "›")} ${this.params.theme.bold(headerLabel)} ${this.params.theme.fg("dim", `› ${this.editorLabel()} (${displayText(headerSub)})`)}`,
        inner,
        "…",
      ),
      this.filterLine(inner, this.modelQuery, this.editorKind === "circuit" && this.circuitCustomMode ? 0 : items.length),
      this.params.theme.fg("dim", "─".repeat(inner)),
    ];
    if (this.editorKind === "circuit" && this.circuitCustomMode) {
      const marker = this.focused ? CURSOR_MARKER : "";
      const draft = this.modelQuery
        ? `${displayText(this.modelQuery)}${marker}`
        : `${marker}${this.params.theme.fg("dim", this.t("model.circuitPrompt"))}`;
      rows.push(truncateToWidth(`${this.params.theme.fg("accent", "›")} ${draft}`, inner, "…"));
      if (this.statusText) rows.push(this.statusLine(inner));
      rows.push(truncateToWidth(
        this.t("model.circuitCustomFooter"),
        inner,
        "…",
      ));
      return this.frame(rows, width);
    }
    const terminalRows = Math.max(12, process.stdout?.rows ?? 30);
    const listRows = Math.max(4, Math.min(12, terminalRows - 10));
    const start = Math.max(0, Math.min(Math.max(0, items.length - listRows), this.modelSelected - Math.floor(listRows / 2)));
    const visible = items.slice(start, start + listRows);
    for (let offset = 0; offset < visible.length; offset++) {
      const index = start + offset;
      const item = visible[offset];
      const prefix = index === this.modelSelected ? this.params.theme.fg("accent", "▸") : " ";
      const state = this.editorKind === "menu"
        ? item.active
          ? this.params.theme.fg("success", this.t("model.state.configured"))
          : this.params.theme.fg("dim", this.t("model.state.inherited"))
        : this.editorKind === "roles"
          ? item.active
            ? this.params.theme.fg("success", this.t("model.state.assigned"))
            : this.params.theme.fg("dim", this.t("model.state.available"))
          : item.unavailable
            ? this.params.theme.fg("error", this.t("model.state.unavailable", {
                active: item.active ? ` · ${this.t("common.active")}` : "",
              }))
            : item.active
              ? this.params.theme.fg("success", this.t("model.state.active"))
              : this.params.theme.fg("dim", this.t("model.state.available"));
      rows.push(truncateToWidth(`${prefix} ${this.params.theme.bold(displayText(item.label))} ${this.params.theme.fg("dim", "·")} ${state}`, inner, "…"));
      if (index === this.modelSelected && inner >= 44) {
        rows.push(truncateToWidth(`  ${this.params.theme.fg("muted", displayText(item.detail))}`, inner, "…"));
      }
    }
    if (items.length === 0) {
      rows.push(this.params.theme.fg("warning", this.t("model.noOptions")));
    }
    if (this.statusText) rows.push(this.statusLine(inner));
    rows.push(truncateToWidth(
      this.editorKind === "fallback"
        ? this.t("model.footer.fallback")
        : this.editorKind === "roles"
          ? this.t("model.footer.roles")
          : this.editorKind === "menu"
            ? this.t("model.footer.menu")
            : this.t("model.footer.editor"),
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
      const states = [
        active ? this.t("common.active") : "",
        isDefault ? this.t("common.default") : "",
      ].filter(Boolean).join(" · ");
      const suffix = states
        ? ` · ${states}`
        : ` ${this.t("model.profileRoutes", { count: ruleCount(profile) })}`;
      return truncateToWidth(`${prefix} ${this.params.theme.bold(displayText(profile.name))} ${this.params.theme.fg("dim", suffix)}`, width, "…");
    }
    if (this.tab === "routing") {
      const taskType = item as TeammateTaskType;
      if (taskType === NEW_CUSTOM_TYPE_ENTRY) {
        return truncateToWidth(`${prefix} ${this.params.theme.fg("accent", this.params.theme.bold(this.t("model.newType")))} ${this.params.theme.fg("dim", "· Ctrl+N")}`, width, "…");
      }
      const meta = this.taskTypeMeta(taskType);
      const mapping = this.config.mappings[taskType] ?? "auto";
      const thinking = this.config.thinkingLevels[taskType] ?? "inherit";
      return truncateToWidth(`${prefix} ${this.params.theme.bold(displayText(meta.label))} ${this.params.theme.fg("dim", this.t("model.routingRow", {
        model: displayText(mapping),
        thinking: displayText(thinking),
      }))}`, width, "…");
    }
    if (this.tab === "roles") {
      const agent = item as AgentConfig;
      const roleRules = this.roleRules(agent.name);
      const taskType = roleRules?.taskType ?? agent.taskType;
      const typeModel = taskType ? this.config.mappings[taskType] : undefined;
      const model = typeModel ?? roleRules?.model ?? agent.model;
      const route = [taskType, model].filter(Boolean).map(displayText).join(" → ");
      const suffix = route ? ` · ${route}` : "";
      return truncateToWidth(`${prefix} @${this.params.theme.bold(displayText(agent.name))} ${this.params.theme.fg("dim", `[${displayText(agent.source)}]${suffix}`)}`, width, "…");
    }
    const agent = item as ControlCenterActiveAgent;
    const status = activeStatus(agent.status, this.t);
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
      lines.push(this.params.theme.fg("muted", this.t("model.profileId", { id: displayText(profileId) })));
      lines.push(this.params.theme.fg("dim", this.t("model.profileRouteCount", {
        count: ruleCount(profile),
        unavailable: unavailable.length,
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.profileState", {
        state: profileId === this.config.profileId
          ? this.t("model.profileActive")
          : this.t("model.profileInactive"),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.globalDefault", {
        value: profileId === this.state.global.defaultProfile ? this.t("model.yes") : this.t("model.no"),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.configPath")));
      if (unavailable.length > 0) {
        lines.push(this.params.theme.fg("warning", this.t("model.unavailableModels", {
          models: unavailable.map(displayText).join(", "),
        })));
      }
      if (hasRoutingRules(this.state.project.overrides)) {
        const applied = this.state.project.applyOverrides;
        lines.push(this.params.theme.fg(
          applied ? "warning" : "dim",
          this.t("model.projectOverrides", {
            state: applied ? this.t("model.overridesEnabled") : this.t("model.overridesDisabled"),
          }),
        ));
      }
      if (this.state.missingProfile) {
        lines.push(this.params.theme.fg("warning", this.t("model.missingSelection", {
          profile: displayText(this.state.missingProfile),
        })));
      }
    } else if (this.tab === "routing") {
      const taskType = this.filteredTaskTypes()[this.selected.routing];
      if (!taskType) return [this.emptyState()];
      if (taskType === NEW_CUSTOM_TYPE_ENTRY) {
        lines.push(this.params.theme.bold(this.t("model.newType")));
        lines.push(this.params.theme.fg("muted", this.t("model.newTypeDetail")));
        lines.push(this.params.theme.fg("dim", this.t("model.newTypeKeywords")));
        lines.push(this.params.theme.fg("dim", this.t("model.newTypeOpen")));
        return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
      }
      const meta = this.taskTypeMeta(taskType);
      const mapping = this.config.mappings[taskType] ?? this.t("model.route.autoMain");
      const assignedRoles = this.assignedRoles(taskType);
      lines.push(this.params.theme.bold(displayText(meta.label)));
      lines.push(this.params.theme.fg("muted", this.t("model.suggestedRoles", {
        roles: displayText(meta.roles),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.assignedRoles", {
        roles: assignedRoles.length > 0
          ? assignedRoles.map((name) => `@${displayText(name)}`).join(", ")
          : this.t("common.none"),
      })));
      lines.push(...wrapTextWithAnsi(displayText(meta.description), Math.max(1, width)).slice(0, 3));
      lines.push(this.params.theme.fg("dim", this.t("model.modelValue", { model: displayText(mapping) })));
      lines.push(this.params.theme.fg("dim", this.t("model.fallbackValues", {
        models: this.config.fallbackMappings?.[taskType]?.map(displayText).join(", ") || this.t("common.none"),
      })));
      const unhealthy = (this.config.fallbackMappings?.[taskType] ?? [])
        .map((model) => ({ model, health: this.health.get(model) }))
        .filter((entry): entry is { model: string; health: ModelCircuitSnapshot } =>
          !!entry.health && entry.health.state !== "CLOSED");
      if (unhealthy.length > 0) {
        lines.push(this.params.theme.fg("warning", this.t("model.circuitValue", {
          value: unhealthy.map((entry) => `${displayText(entry.model)} ${entry.health.state}`).join(", "),
        })));
      }
      lines.push(this.params.theme.fg("dim", this.t("model.thinkingValue", {
        thinking: displayText(this.config.thinkingLevels[taskType] ?? this.t("model.route.inheritThinking")),
      })));
      const keywords = this.config.typeMeta?.[taskType]?.keywords;
      if (keywords && keywords.length > 0) {
        lines.push(this.params.theme.fg("dim", this.t("model.keywordsValue", {
          keywords: keywords.map(displayText).join(", "),
        })));
      }
      lines.push(this.params.theme.fg("dim", this.t("model.profileValue", {
        profile: displayText(this.config.profileName),
      })));
      if (!(TEAMMATE_TASK_TYPES as readonly string[]).includes(taskType)) {
        const declaredByAgent = this.agents.some((agent) => agent.taskType === taskType);
        lines.push(this.params.theme.fg("dim", declaredByAgent
          ? this.t("model.agentDeclared")
          : this.t("model.customTypeDelete")));
      }
      lines.push(this.params.theme.fg("dim", this.t("model.editKeywords")));
      if (this.state.project.applyOverrides) {
        lines.push(this.params.theme.fg("warning", this.t("model.overridesRuntime")));
      }
    } else if (this.tab === "roles") {
      const agent = this.filteredRoles()[this.selected.roles];
      if (!agent) return [this.emptyState()];
      lines.push(`@${this.params.theme.bold(displayText(agent.name))} ${this.params.theme.fg("dim", `[${displayText(agent.source)}]`)}`);
      lines.push(...wrapTextWithAnsi(normalizedText(displayText(agent.description)), Math.max(1, width)).slice(0, 3));
      const roleRules = this.roleRules(agent.name);
      const assignedType = roleRules?.taskType ?? agent.taskType;
      const typeModel = assignedType ? this.config.mappings[assignedType] : undefined;
      const typeFallbacks = assignedType ? this.config.fallbackMappings?.[assignedType] : undefined;
      const typeThinking = assignedType ? this.config.thinkingLevels[assignedType] : undefined;
      const effectiveModel = typeModel ?? roleRules?.model ?? agent.model;
      const effectiveFallbacks = typeFallbacks ?? roleRules?.fallbackModels;
      const effectiveThinking = typeThinking ?? roleRules?.thinking ?? agent.thinking;
      const modelSource = typeModel
        ? this.t("model.source.type", { type: assignedType! })
        : roleRules?.model
          ? this.t("model.source.roleOverride")
          : agent.model
            ? this.t("model.source.frontmatter")
            : this.t("model.source.runtime");
      const fallbackSource = typeFallbacks
        ? this.t("model.source.type", { type: assignedType! })
        : roleRules?.fallbackModels
          ? this.t("model.source.roleOverride")
          : this.t("common.none");
      const thinkingSource = typeThinking
        ? this.t("model.source.type", { type: assignedType! })
        : roleRules?.thinking
          ? this.t("model.source.roleOverride")
          : agent.thinking
            ? this.t("model.source.frontmatter")
            : this.t("model.source.piDefault");
      const modelForCircuit = effectiveModel;
      lines.push(this.params.theme.fg("dim", this.t("model.typeValue", {
        type: displayText(assignedType ?? this.t("model.unassignedInferred")),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.effectiveModel", {
        model: displayText(effectiveModel ?? this.t("model.autoRouted")),
        source: displayText(modelSource),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.roleModel", {
        model: displayText(roleRules?.model ?? this.t("common.none")),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.effectiveFallbacks", {
        models: displayText(effectiveFallbacks?.join(", ") ?? this.t("common.none")),
        source: displayText(fallbackSource),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.effectiveThinking", {
        thinking: displayText(effectiveThinking ?? this.t("model.inheritValue")),
        source: displayText(thinkingSource),
      })));
      const circuit = roleRules?.circuit;
      const healthNote = modelForCircuit ? this.circuitNote(modelForCircuit) : "";
      lines.push(this.params.theme.fg("dim", this.t("model.circuitValue", {
        value: `${circuitDisplayText(circuit, this.t)}${healthNote ? ` · ${displayText(healthNote)}` : ""}`,
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.context", {
        context: displayText(agent.defaultContext ?? "fresh"),
        prompt: displayText(agent.systemPromptMode),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.tools", {
        tools: agent.tools?.map(displayText).join(", ") ?? this.t("common.default"),
      })));
    } else {
      const agent = this.filteredActiveAgents()[this.selected.active];
      if (!agent) return [this.emptyState()];
      const status = activeStatus(agent.status, this.t);
      const uptime = Math.max(0, Math.round((Date.now() - agent.startedAt) / 1000));
      lines.push(`${this.params.theme.fg(status.tone, status.icon)} ${this.params.theme.bold(displayText(agent.name ?? agent.agent))} · ${status.label}`);
      lines.push(this.params.theme.fg("muted", this.t("model.role", { role: displayText(agent.agent) })));
      lines.push(this.params.theme.fg("dim", this.t("model.uptime", {
        seconds: uptime,
        inbox: agent.inboxCount,
        tasks: agent.taskCount,
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.location", {
        location: displayText(agent.cwd ?? this.t("model.locationDefault")),
      })));
      lines.push(this.params.theme.fg("dim", this.t("model.profileId", {
        id: displayText(agent.correlationId.slice(0, 12)),
      })));
      lines.push(this.params.theme.fg("muted", this.t("model.openCollaboration")));
    }
    return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }

  private emptyState(): string {
    if (this.queries[this.tab]) return this.params.theme.fg("warning", this.t("model.noMatches"));
    if (this.tab === "profiles") return this.params.theme.fg("warning", this.t("model.noProfiles"));
    if (this.tab === "roles") return this.params.theme.fg("warning", this.t("model.noRoles"));
    if (this.tab === "active") return this.params.theme.fg("dim", this.t("model.noActive"));
    return this.params.theme.fg("warning", this.t("model.noRouting"));
  }

  private headerLine(width: number): string {
    const active = this.activeAgents.filter((agent) => agent.status !== "completed").length;
    const override = this.state.project.applyOverrides ? this.t("model.overridesOn") : "";
    return truncateToWidth(
      `${this.params.theme.fg("accent", this.params.theme.bold(this.t("model.title")))} ${this.params.theme.fg("dim", this.t("model.headerMeta", {
        profile: displayText(this.config.profileName),
        override,
        roles: this.agents.length,
        active,
      }))}`,
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
            : tab === "connections"
              ? this.remoteCount()
              : this.activeAgents.length;
      const label = `${tabLabel(tab, this.t)} ${count}`;
      return tab === this.tab
        ? this.params.theme.fg("accent", this.params.theme.bold(`[${label}]`))
        : this.params.theme.fg("dim", label);
    });
    return truncateToWidth(labels.join("  "), width, "…");
  }

  private remoteCount(): number {
    const state = this.params.remoteState;
    if (!state) return 0;
    const deployments = this.params.deployments;
    const deploymentCount = deployments?.kind === "registry" ? deployments.rows.length : deployments ? 1 : 0;
    return deploymentCount
      + Object.keys(state.global.hosts).length
      + Object.keys(state.global.targets).length
      + Object.keys(state.project.hosts).length
      + Object.keys(state.project.targets).length;
  }

  private filterLine(width: number, query: string, count: number): string {
    const marker = this.focused ? CURSOR_MARKER : "";
    const queryText = query
      ? `${displayText(query)}${marker}`
      : `${marker}${this.params.theme.fg("dim", this.t("model.filterPlaceholder"))}`;
    return truncateToWidth(`${this.params.theme.fg("accent", "›")} ${queryText} ${this.params.theme.fg("dim", this.t("model.filterShown", { count }))}`, width, "…");
  }

  private statusLine(width: number): string {
    return truncateToWidth(this.params.theme.fg(this.statusTone, displayText(this.statusText)), width, "…");
  }

  /** Routing tab toggle row: ask the user to pick model provider before dispatch. */
  private askToggleLine(width: number): string {
    const enabled = this.state.askBeforeDispatch;
    const check = enabled
      ? this.params.theme.fg("success", "✓")
      : this.params.theme.fg("dim", " ");
    const label = enabled ? this.t("model.askToggleOn") : this.t("model.askToggleOff");
    const hint = this.params.theme.fg("dim", this.t("model.askToggleHint"));
    return truncateToWidth(`${check} ${label} ${hint}`, width, "…");
  }

  private toggleAskBeforeDispatch(): void {
    if (this.params.readOnly) {
      this.params.close({ kind: "reload", tab: this.tab });
      return;
    }
    const enabled = !this.state.askBeforeDispatch;
    try {
      setGlobalAskBeforeDispatch(enabled, this.params.globalFilePath);
      this.state.askBeforeDispatch = enabled;
      this.statusTone = "success";
      this.statusText = this.t(enabled ? "model.askToggleEnabled" : "model.askToggleDisabled");
    } catch (error) {
      this.statusTone = "error";
      this.statusText = this.t("model.saveFailed", {
        message: displayText(error instanceof Error ? error.message : String(error)),
      });
    }
    this.params.requestRender();
  }

  private footerLine(width: number): string {
    if (this.params.readOnly) {
      return this.params.theme.fg("warning", truncateToWidth(this.t("model.readOnlyFooter"), width, "…"));
    }
    const action = this.tab === "profiles"
      ? this.t("model.footer.manage")
      : this.tab === "routing"
        ? this.t("model.footer.routing")
        : this.tab === "roles"
          ? this.t("model.footer.role")
          : this.tab === "active"
            ? this.t("model.footer.open")
            : "";
    const segments = [
      this.t("model.footer.close"),
      action,
      this.t("model.footer.cursor"),
      this.t("model.footer.tabs"),
      this.t("model.footer.filter"),
    ];
    let footer = "";
    for (const segment of segments.filter(Boolean)) {
      const next = footer ? `${footer} · ${segment}` : segment;
      if (visibleWidth(next) > width) break;
      footer = next;
    }
    return this.params.theme.fg("dim", footer || this.t("model.footer.close"));
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
    if (this.keywordsInput) {
      return truncateToWidth(
        `${status}${this.t("model.compactKeywords", {
          type: displayText(this.keywordsInput.taskType),
          keywords: displayText(this.keywordsDraft || this.t("model.commaSeparated")),
        })}`,
        width,
        "…",
      );
    }
    if (this.customTypeInput) {
      return truncateToWidth(
        `${status}${this.t("model.compactNewType", {
          type: displayText(this.customTypeDraft || this.t("model.typeIdentifier")),
        })}`,
        width,
        "…",
      );
    }
    if (this.modelTaskType || this.modelRole) {
      const item = this.filteredEditorItems()[this.modelSelected];
      const title = this.modelRole
        ? `@${displayText(this.modelRole)}`
        : displayText(this.taskTypeMeta(this.modelTaskType as TeammateTaskType).label);
      return truncateToWidth(
        `${status}${this.t("model.compactBack", {
          title,
          item: displayText(item?.label ?? this.editorLabel()),
        })}`,
        width,
        "…",
      );
    }
    const item = this.currentItems()[this.selected[this.tab]];
    const label = item
      ? this.itemLine(item, true, Math.max(1, width))
      : this.t("model.compactEmpty", { tab: tabLabel(this.tab, this.t) });
    const action = this.params.readOnly
      ? `${this.t("model.compactRetry")} `
      : `${this.t("model.footer.close")} · `;
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
    const t = createTuiTranslator(options.locale);
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
      initialStatusText: t("model.savingMessage", { target: savingText }),
      initialStatusTone: "dim",
      initialSaving: true,
      modelHealth: options.modelHealth,
      globalFilePath: options.globalFilePath,
      locale: options.locale,
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

interface ConnectionManifestSnapshot {
  filePath: string;
  manifestRaw?: string;
  result?: ModelListResult;
  deployments?: RemotePaneDeployments;
}

function loadConnectionManifestSnapshot(cwd: string): ConnectionManifestSnapshot {
  const filePath = path.resolve(cwd, DEFAULT_MANIFEST_PATH);
  let manifestRaw: string;
  try {
    manifestRaw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { filePath };
    throw error;
  }
  const result = buildModelList(manifestRaw, filePath, { legacyPreviewHook: () => {} });
  return {
    filePath,
    manifestRaw,
    result,
    deployments: result.kind === "registry"
      ? {
          kind: "registry",
          rows: result.rows,
          defaultModel: result.defaultModel,
          diagnostics: result.diagnostics,
        }
      : { kind: "legacy" },
  };
}

export async function showModelMappingOverlay(
  ctx: ExtensionContext,
  availableModels: readonly TeammateModelCapability[],
  options: TeammateControlCenterOptions = {},
): Promise<void> {
  const t = createTuiTranslator(options.locale);
  let catalogModels = availableModels;
  let connectionManifest: ConnectionManifestSnapshot;
  try {
    connectionManifest = loadConnectionManifestSnapshot(ctx.cwd);
  } catch (error) {
    connectionManifest = { filePath: path.resolve(ctx.cwd, DEFAULT_MANIFEST_PATH) };
    ctx.ui.notify(t("connections.registryLoadFailed", {
      message: displayText(error instanceof Error ? error.message : String(error)),
    }), "error");
  }
  let initialTab: ControlCenterTab = "routing";
  let initialProfileId: string | undefined;
  let initialProfileQuery = "";
  let initialStatusText = "";
  let initialStatusTone: "dim" | "success" | "error" = "dim";
  let lastState: ModelRoutingState | undefined;
  let remoteState: RemoteConfigState | undefined;
  if (options.remoteState) {
    try {
      remoteState = loadRemoteConfigState(ctx.cwd, options.globalFilePath);
    } catch (error) {
      initialStatusTone = "error";
      initialStatusText = t("remote.loadFailed", {
        message: displayText(error instanceof Error ? error.message : String(error)),
      });
    }
  }
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
      initialStatusText = t("model.saveFailed", {
        message: displayText(error instanceof Error ? error.message : String(error)),
      });
    }
    const action = await ctx.ui.custom<ControlCenterAction | null>((tui, theme, _keybindings, done) => {
      const controlCenter = new TeammateControlCenter({
        cwd: ctx.cwd,
        availableModels: catalogModels,
        agents: options.agents ?? [],
        activeAgents: options.activeAgents ?? [],
        state,
        remoteState,
        ...(connectionManifest.deployments === undefined
          ? options.deployments === undefined ? {} : { deployments: options.deployments }
          : { deployments: connectionManifest.deployments }),
        onTestRemote: options.onTestRemote,
        remoteTestTimeoutMs: options.remoteTestTimeoutMs,
        theme,
        initialTab,
        initialProfileId,
        initialProfileQuery,
        initialStatusText,
        initialStatusTone,
        readOnly: usingFallback,
        modelHealth: options.modelHealth,
        globalFilePath: options.globalFilePath,
        locale: options.locale,
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
    if (isRemotePaneAction(action)) {
      initialTab = "connections";
      const outcome = await handleConnectionPaneAction(ctx, options, remoteState, connectionManifest, action, t);
      initialStatusText = outcome.message;
      initialStatusTone = outcome.ok ? "success" : "error";
      if (outcome.reloadRemote) {
        try {
          remoteState = loadRemoteConfigState(ctx.cwd, options.globalFilePath);
        } catch (error) {
          initialStatusTone = "error";
          initialStatusText = t("remote.loadFailed", {
            message: displayText(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      if (outcome.ok && (outcome.reloadRemote || outcome.reloadCatalog)) {
        try {
          if (outcome.reloadCatalog) {
            catalogModels = options.refreshModelCatalog?.() ?? catalogModels;
          }
          connectionManifest = loadConnectionManifestSnapshot(ctx.cwd);
        } catch (error) {
          initialStatusTone = "error";
          initialStatusText = t("connections.registryLoadFailed", {
            message: displayText(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      continue;
    }
    initialTab = action.tab;
    if (action.kind === "open-agent") {
      if (options.onOpenAgent) await options.onOpenAgent(action.correlationId);
      continue;
    }
    if (action.kind === "reload") {
      try {
        catalogModels = options.refreshModelCatalog?.() ?? catalogModels;
        connectionManifest = loadConnectionManifestSnapshot(ctx.cwd);
      } catch (error) {
        initialStatusTone = "error";
        initialStatusText = t("connections.registryLoadFailed", {
          message: displayText(error instanceof Error ? error.message : String(error)),
        });
      }
      continue;
    }

    initialProfileId = action.profileId;
    initialProfileQuery = action.profileQuery;
    initialStatusText = "";
    initialStatusTone = "dim";
    const profile = state.global.profiles[action.profileId];
    if (!profile) {
      ctx.ui.notify(t("model.profileMissing", { profile: displayText(action.profileId) }), "warning");
      continue;
    }
    const choices: Array<{ key: string; label: string }> = [];
    if (action.profileId !== state.config.profileId) {
      choices.push({ key: "activate", label: t("model.profile.activate") });
    }
    choices.push(
      { key: "create", label: t("model.profile.create") },
      { key: "duplicate", label: t("model.profile.duplicate") },
      { key: "rename", label: t("model.profile.rename") },
    );
    if (action.profileId !== state.global.defaultProfile) {
      choices.push(
        { key: "default", label: t("model.profile.default") },
        { key: "delete", label: t("model.profile.delete") },
      );
    }
    if (hasRoutingRules(state.project.overrides)) {
      choices.push({
        key: state.project.applyOverrides ? "disable-overrides" : "restore-overrides",
        label: state.project.applyOverrides
          ? t("model.profile.disableOverrides")
          : t("model.profile.restoreOverrides"),
      });
      choices.push(
        { key: "promote-overrides", label: t("model.profile.promoteOverrides") },
        { key: "clear-overrides", label: t("model.profile.clearOverrides") },
      );
    }

    const selected = await ctx.ui.select(
      t("model.profile.menuTitle", { profile: displayText(profile.name) }),
      choices.map((choice) => choice.label),
    );
    const operation = choices.find((choice) => choice.label === selected)?.key;
    if (!operation) continue;

    let savingText = t("model.tab.profiles");
    let persistOperation: (() => ProfileOperationResult) | undefined;
    if (operation === "activate") {
      savingText = t("model.profile.activating", { profile: displayText(profile.name) });
      persistOperation = () => {
        setProjectActiveModelRoutingProfile(ctx.cwd, action.profileId, options.globalFilePath);
        return {
          message: t("model.profile.activated", { profile: displayText(profile.name) }),
          focusProfileId: action.profileId,
        };
      };
    } else if (operation === "create" || operation === "duplicate") {
      const name = await ctx.ui.input(
        operation === "create"
          ? t("model.profile.newTitle")
          : t("model.profile.duplicateTitle", { profile: displayText(profile.name) }),
        operation === "create"
          ? t("model.profile.name")
          : t("model.profile.copy", { profile: displayText(profile.name) }),
      );
      if (!name?.trim()) continue;
      savingText = operation === "create"
        ? t("model.profile.creating")
        : t("model.profile.duplicating", { profile: displayText(profile.name) });
      persistOperation = () => {
        const created = createAndActivateGlobalModelRoutingProfile(
          ctx.cwd,
          name,
          operation === "duplicate" ? action.profileId : undefined,
          options.globalFilePath,
        );
        return {
          message: t("model.profile.created", { profile: displayText(name.trim()) }),
          focusProfileId: created.changedProfileId,
        };
      };
    } else if (operation === "rename") {
      const name = await ctx.ui.input(
        t("model.profile.renameTitle", { profile: displayText(profile.name) }),
        displayText(profile.name),
      );
      if (!name?.trim()) continue;
      savingText = t("model.profile.renaming", { profile: displayText(profile.name) });
      persistOperation = () => {
        renameGlobalModelRoutingProfile(ctx.cwd, action.profileId, name, options.globalFilePath);
        return {
          message: t("model.profile.renamed", { profile: displayText(name.trim()) }),
          focusProfileId: action.profileId,
        };
      };
    } else if (operation === "default") {
      savingText = t("model.profile.settingDefault", { profile: displayText(profile.name) });
      persistOperation = () => {
        setDefaultGlobalModelRoutingProfile(ctx.cwd, action.profileId, options.globalFilePath);
        return {
          message: t("model.profile.isDefault", { profile: displayText(profile.name) }),
          focusProfileId: action.profileId,
        };
      };
    } else if (operation === "delete") {
      const confirmed = await ctx.ui.confirm(
        t("model.profile.deleteTitle", { profile: displayText(profile.name) }),
        t("model.profile.deleteDetail"),
      );
      if (!confirmed) continue;
      savingText = t("model.profile.deleting", { profile: displayText(profile.name) });
      persistOperation = () => {
        deleteGlobalModelRoutingProfile(ctx.cwd, action.profileId, options.globalFilePath);
        return {
          message: t("model.profile.deleted", { profile: displayText(profile.name) }),
          focusProfileId: null,
        };
      };
    } else if (operation === "disable-overrides" || operation === "restore-overrides") {
      const enabled = operation === "restore-overrides";
      savingText = enabled
        ? t("model.profile.restoringOverrides")
        : t("model.profile.disablingOverrides");
      persistOperation = () => {
        setProjectModelRoutingOverridesEnabled(ctx.cwd, enabled, options.globalFilePath);
        return {
          message: t("model.profile.overridesState", {
            state: enabled ? t("model.profile.restored") : t("model.profile.disabled"),
          }),
          focusProfileId: action.profileId,
        };
      };
    } else if (operation === "promote-overrides") {
      const name = await ctx.ui.input(t("model.profile.promoteTitle"), t("model.profile.name"));
      if (!name?.trim()) continue;
      savingText = t("model.profile.promoting");
      persistOperation = () => {
        const promoted = promoteProjectModelRoutingOverrides(ctx.cwd, name, options.globalFilePath);
        return {
          message: t("model.profile.promoted", { profile: displayText(name.trim()) }),
          focusProfileId: promoted.changedProfileId,
        };
      };
    } else if (operation === "clear-overrides") {
      const confirmed = await ctx.ui.confirm(
        t("model.profile.clearTitle"),
        t("model.profile.clearDetail"),
      );
      if (!confirmed) continue;
      savingText = t("model.profile.clearing");
      persistOperation = () => {
        clearProjectModelRoutingOverrides(ctx.cwd, options.globalFilePath);
        return { message: t("model.profile.cleared"), focusProfileId: action.profileId };
      };
    }
    if (!persistOperation) continue;

    const outcome = await showProfilePersistenceStatus(
      ctx,
      catalogModels,
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
      initialStatusText = t("model.savedMessage", { message: displayText(outcome.message) });
      ctx.ui.notify(t("model.notification", { message: displayText(outcome.message) }), "info");
    } else {
      initialStatusTone = "error";
      initialStatusText = t("model.saveFailed", {
        message: displayText(outcome.error ?? t("model.persistence.unknown")),
      });
      ctx.ui.notify(initialStatusText, "error");
    }
  }
}

// ---------------------------------------------------------------------------
// Connection pane actions
// ---------------------------------------------------------------------------

interface ConnectionPaneOutcome {
  ok: boolean;
  message: string;
  reloadRemote: boolean;
  reloadCatalog: boolean;
}

const REMOTE_ACTION_KINDS = new Set([
  "connection-edit-deployment",
  "connection-add-deployment",
  "connection-upgrade-legacy",
  "remote-new-host",
  "remote-edit-host",
  "remote-new-target",
  "remote-edit-target",
  "remote-delete-host",
  "remote-delete-target",
]);

function isRemotePaneAction(action: ControlCenterAction): action is RemotePaneAction {
  return REMOTE_ACTION_KINDS.has(action.kind);
}

function remoteScopeStores(state: RemoteConfigState, scope: RemotePaneScope) {
  if (scope === "global") {
    return {
      global: {
        version: state.global.version,
        hosts: { ...state.global.hosts },
        targets: { ...state.global.targets },
      },
      project: state.project,
    };
  }
  return {
    global: state.global,
    project: {
      version: state.project.version,
      hosts: { ...state.project.hosts },
      targets: { ...state.project.targets },
    },
  };
}

function findHostInState(state: RemoteConfigState, hostId: string) {
  return state.global.hosts[hostId] ?? (state.project.hosts[hostId] ?? undefined);
}

function findTargetInState(state: RemoteConfigState, targetId: string) {
  return state.global.targets[targetId] ?? (state.project.targets[targetId] ?? undefined);
}

function wizardUi(ctx: ExtensionContext, t: TuiTranslator): WizardUi {
  return {
    t,
    input: (prompt, initial) => ctx.ui.input(prompt, initial),
    select: (prompt, choices) => ctx.ui.select(prompt, [...choices]),
    confirm: (prompt) => ctx.ui.confirm(prompt, ""),
    write: (text) => ctx.ui.notify(displayText(text), "info"),
  };
}

function wizardOutcome(
  outcome: { ok: boolean; message?: string; reloadCatalog?: boolean } | { cancelled: true },
): ConnectionPaneOutcome {
  if ("cancelled" in outcome) {
    return { ok: true, message: "", reloadRemote: false, reloadCatalog: false };
  }
  return {
    ok: outcome.ok,
    message: outcome.message ?? "",
    reloadRemote: false,
    reloadCatalog: outcome.reloadCatalog === true,
  };
}

async function handleConnectionPaneAction(
  ctx: ExtensionContext,
  options: TeammateControlCenterOptions,
  state: RemoteConfigState | undefined,
  manifest: ConnectionManifestSnapshot,
  action: RemotePaneAction,
  t: TuiTranslator,
): Promise<ConnectionPaneOutcome> {
  const ui = wizardUi(ctx, t);
  try {
    switch (action.kind) {
      case "connection-edit-deployment": {
        if (manifest.result?.kind !== "registry" || manifest.manifestRaw === undefined) {
          return { ok: false, message: t("connections.registryRequired"), reloadRemote: false, reloadCatalog: false };
        }
        const row = manifest.result.rows.find((candidate) => candidate.registrationId === action.registrationId);
        if (!row) {
          return {
            ok: false,
            message: t("connections.registrationMissing", { id: displayText(action.registrationId) }),
            reloadRemote: false,
            reloadCatalog: false,
          };
        }
        return wizardOutcome(await wizardDeploymentEdit(ui, {
          filePath: manifest.filePath,
          manifestRaw: manifest.manifestRaw,
          rows: [row],
        }));
      }
      case "connection-add-deployment":
        return wizardOutcome(await wizardDeploymentAdd(ui, {
          filePath: manifest.filePath,
          manifestRaw: manifest.manifestRaw,
        }));
      case "connection-upgrade-legacy": {
        if (manifest.result?.kind !== "legacy") {
          return { ok: false, message: t("connections.legacyRequired"), reloadRemote: false, reloadCatalog: false };
        }
        const skeleton = renderLegacyUpgradeSkeleton(manifest.result.parsed, manifest.filePath);
        return wizardOutcome(await wizardLegacyUpgrade(ui, skeleton, manifest.filePath));
      }
      case "remote-new-host":
      case "remote-edit-host": {
        if (!state) return unavailableRemoteState(t);
        const hostId = action.kind === "remote-edit-host" ? action.hostId : undefined;
        const outcome = await wizardRemoteHost(ui, {
          state,
          scope: action.scope,
          cwd: ctx.cwd,
          globalFilePath: options.globalFilePath,
          ...(hostId === undefined ? {} : { id: hostId, current: findHostInState(state, hostId) }),
          persist: (cwd, expected, next, globalFilePath) => {
            replaceRemoteConfigStores(cwd, expected, next, globalFilePath);
          },
        });
        return { ...outcome, reloadCatalog: false };
      }
      case "remote-new-target":
      case "remote-edit-target": {
        if (!state) return unavailableRemoteState(t);
        const targetId = action.kind === "remote-edit-target" ? action.targetId : undefined;
        const outcome = await wizardRemoteTarget(ui, {
          state,
          scope: action.scope,
          cwd: ctx.cwd,
          globalFilePath: options.globalFilePath,
          ...(targetId === undefined ? {} : { id: targetId, current: findTargetInState(state, targetId) }),
          persist: (cwd, expected, next, globalFilePath) => {
            replaceRemoteConfigStores(cwd, expected, next, globalFilePath);
          },
        });
        return { ...outcome, reloadCatalog: false };
      }
      case "remote-delete-host": {
        if (!state) return unavailableRemoteState(t);
        const confirmed = await ctx.ui.confirm(t("remote.deleteHostTitle", { id: displayText(action.hostId) }), "");
        if (!confirmed) return { ok: true, message: "", reloadRemote: false, reloadCatalog: false };
        const stores = remoteScopeStores(state, action.scope);
        if (action.scope === "project") stores.project.hosts[action.hostId] = null;
        else delete stores.global.hosts[action.hostId];
        await persistRemoteStores(ctx, options, state, stores);
        return {
          ok: true,
          message: t("remote.hostDeleted", { id: displayText(action.hostId) }),
          reloadRemote: true,
          reloadCatalog: false,
        };
      }
      case "remote-delete-target": {
        if (!state) return unavailableRemoteState(t);
        const confirmed = await ctx.ui.confirm(t("remote.deleteTargetTitle", { id: displayText(action.targetId) }), "");
        if (!confirmed) return { ok: true, message: "", reloadRemote: false, reloadCatalog: false };
        const stores = remoteScopeStores(state, action.scope);
        if (action.scope === "project") stores.project.targets[action.targetId] = null;
        else delete stores.global.targets[action.targetId];
        await persistRemoteStores(ctx, options, state, stores);
        return {
          ok: true,
          message: t("remote.targetDeleted", { id: displayText(action.targetId) }),
          reloadRemote: true,
          reloadCatalog: false,
        };
      }
      default:
        return {
          ok: false,
          message: t("connections.unknownAction"),
          reloadRemote: false,
          reloadCatalog: false,
        };
    }
  } catch (error) {
    return {
      ok: false,
      message: t("connections.saveFailed", {
        message: displayText(error instanceof Error ? error.message : String(error)),
      }),
      reloadRemote: false,
      reloadCatalog: false,
    };
  }
}

function unavailableRemoteState(t: TuiTranslator): ConnectionPaneOutcome {
  return {
    ok: false,
    message: t("remote.loadFailed", { message: t("connections.stateUnavailable") }),
    reloadRemote: false,
    reloadCatalog: false,
  };
}

async function persistRemoteStores(
  ctx: ExtensionContext,
  options: TeammateControlCenterOptions | undefined,
  state: RemoteConfigState,
  stores: { global: RemoteConfigState["global"]; project: RemoteConfigState["project"] },
): Promise<void> {
  const expected = {
    global: { ...state.global, hosts: { ...state.global.hosts }, targets: { ...state.global.targets } },
    project: { ...state.project, hosts: { ...state.project.hosts }, targets: { ...state.project.targets } },
  };
  replaceRemoteConfigStores(ctx.cwd, expected, stores, options?.globalFilePath);
}
