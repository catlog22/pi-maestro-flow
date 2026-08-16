import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable } from "@earendil-works/pi-tui";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { type TeammateThinkingLevel } from "../shared/thinking.ts";
import { type SupportedSettingsLocale } from "./locale.ts";
/** One dispatch task shown in the ask overlay (post-routing resolution). */
export interface ModelAskTask {
    agent: string;
    name?: string;
    /** Resolved model id; undefined means inherit the main session's model. */
    model?: string;
    /** Resolved thinking level; undefined means inherit the Pi default. */
    thinking?: TeammateThinkingLevel;
    /** Resolved working directory; undefined means the session default. */
    cwd?: string;
    prompt: string;
}
/**
 * Per-task override chosen by the user. Absent fields keep the original
 * resolution; `null` explicitly restores inherit (clears the resolved value).
 */
export interface ModelAskOverride {
    model?: string | null;
    thinking?: TeammateThinkingLevel | null;
    /** `null` restores the default workspace; `remote:<id>` references a configured target. */
    cwd?: string | null;
}
export interface ModelAskResult {
    confirmed: boolean;
    /** Index-aligned with the tasks passed in; undefined keeps the task as-is. */
    overrides: Array<ModelAskOverride | undefined>;
}
/** Configured remote target offered as a dispatch location (Monitor mode). */
export interface ModelAskRemoteLocation {
    id: string;
    driver: string;
    host: string;
    cwd: string;
}
interface ModelAskOverlayOptions {
    tasks: readonly ModelAskTask[];
    availableModels: readonly TeammateModelCapability[];
    /** Main session model id, shown as the inherit target when known. */
    sessionModel?: string;
    /** Current workspace shown as the default location (ctx.cwd). */
    defaultCwd?: string;
    /** Configured remote targets offered when Monitor mode is active. */
    remoteLocations?: readonly ModelAskRemoteLocation[];
    /** Whether remote locations may be selected (Monitor mode active). */
    monitorActive?: boolean;
    locale?: SupportedSettingsLocale;
}
interface AskTheme {
    fg(role: string, text: string): string;
    bold(text: string): string;
}
/** Compact dispatch-time confirm overlay: pick model provider + thinking. */
export declare class ModelAskOverlay implements Component, Focusable {
    focused: boolean;
    private mode;
    private readonly tasks;
    private readonly models;
    private readonly sessionModel?;
    private readonly t;
    private readonly localeDisposer;
    private readonly overrides;
    private cursor;
    private modelQuery;
    private modelCursor;
    private thinkingCursor;
    private locationCursor;
    private locationInput;
    private locationSubmode;
    private locationConfirmPath;
    private statusText;
    private readonly defaultCwd?;
    private readonly remoteLocations;
    private readonly monitorActive;
    private readonly theme;
    private readonly requestRender;
    private readonly close;
    constructor(theme: AskTheme, options: ModelAskOverlayOptions, requestRender: () => void, close: (result: ModelAskResult) => void);
    invalidate(): void;
    dispose(): void;
    private filteredModels;
    private confirm;
    private selectTask;
    private selectThinking;
    private selectLocation;
    private applyLocation;
    private effectiveCwd;
    private locationOptions;
    private handleLocationInput;
    private handleLocationPathInput;
    private locationLabel;
    private applyModel;
    private applyThinking;
    handleInput(data: string): void;
    private filteredModelEntries;
    private handleModelInput;
    private moveModelCursor;
    private handleThinkingInput;
    private thinkingOptions;
    private renderTasks;
    private renderModelPicker;
    private renderThinkingPicker;
    private renderLocationPicker;
    private effectiveModel;
    render(width: number): string[];
    private width;
    private frame;
}
/** Ask the user to confirm or adjust model provider/thinking before dispatch. */
export declare function showModelAskOverlay(ctx: ExtensionContext, options: ModelAskOverlayOptions): Promise<ModelAskResult | null>;
export {};
