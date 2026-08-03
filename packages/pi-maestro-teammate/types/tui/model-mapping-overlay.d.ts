import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../agents/agents.ts";
import type { ModelCircuitSnapshot } from "../models/model-circuit-breaker.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { type ModelRoutingRules, type ModelRoutingState, type TeammateTaskType } from "../models/model-routing.ts";
import { type TeammateThinkingLevel } from "../shared/thinking.ts";
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
export type ControlCenterAction = {
    kind: "open-agent";
    correlationId: string;
    tab: ControlCenterTab;
} | {
    kind: "reload";
    tab: ControlCenterTab;
} | {
    kind: "manage-profile";
    profileId: string;
    profileQuery: string;
    tab: ControlCenterTab;
};
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
export declare class TeammateControlCenter implements Component, Focusable {
    private readonly params;
    focused: boolean;
    private tab;
    private modelTaskType;
    private editorKind;
    private readonly queries;
    private modelQuery;
    private readonly selected;
    private modelSelected;
    private saving;
    private statusText;
    private statusTone;
    private readonly pasteDecoder;
    private pasteFlushTimer;
    private persistenceTimer;
    private lastWidth;
    private readonly state;
    private config;
    private readonly profileIds;
    private readonly models;
    private readonly modelCapabilities;
    private readonly health;
    private fallbackDraft;
    private readonly agents;
    private readonly taskTypes;
    private readonly activeAgents;
    constructor(params: TeammateControlCenterParams);
    invalidate(): void;
    dispose(): void;
    handleInput(data: string): void;
    private dispatchDecodedToken;
    private handleDecodedInput;
    render(width: number): string[];
    private switchTab;
    private moveSelection;
    private activateSelection;
    private activateThinkingSelection;
    private activateFallbackSelection;
    private handleModelInput;
    private handleFallbackInput;
    private fallbackItems;
    private fallbackItemDetail;
    private circuitNote;
    private editorLabel;
    private toggleFallbackItem;
    private reorderFallback;
    private commitFallback;
    private taskTypeMeta;
    private filteredProfileIds;
    private filteredTaskTypes;
    private filteredRoles;
    private filteredActiveAgents;
    private currentItems;
    private modelItems;
    private thinkingItems;
    private filteredEditorItems;
    private renderMain;
    private renderModels;
    private renderListRows;
    private unavailableModels;
    private itemLine;
    private detailLines;
    private emptyState;
    private headerLine;
    private tabLine;
    private filterLine;
    private statusLine;
    private footerLine;
    private frame;
    private renderCompact;
}
export declare function showModelMappingOverlay(ctx: ExtensionContext, availableModels: readonly TeammateModelCapability[], options?: TeammateControlCenterOptions): Promise<void>;
export {};
