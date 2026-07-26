import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../agents/agents.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { type ModelRoutingConfig, type TeammateTaskType } from "../models/model-routing.ts";
import { type TeammateThinkingLevel } from "../shared/thinking.ts";
type ControlCenterTab = "routing" | "roles" | "active";
export interface ControlCenterActiveAgent {
    correlationId: string;
    agent: string;
    name?: string;
    status: "pending" | "running" | "retrying" | "sleeping" | "completed" | "failed";
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
    availableModels: readonly TeammateModelCapability[];
    agents: readonly AgentConfig[];
    activeAgents: readonly ControlCenterActiveAgent[];
    config: ModelRoutingConfig;
    theme: ControlCenterTheme;
    initialTab?: ControlCenterTab;
    requestRender: () => void;
    close: (action: ControlCenterAction | null) => void;
    saveMapping?: (taskType: TeammateTaskType, model: string | null) => void;
    saveThinking?: (taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null) => void;
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
    private lastWidth;
    private config;
    private readonly models;
    private readonly modelCapabilities;
    private readonly agents;
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
    private handleModelInput;
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
