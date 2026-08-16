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
export declare class MonitorToolExposureController {
    #private;
    constructor(pi: ExtensionAPI, variants: MonitorToolVariants);
    get active(): boolean;
    get generation(): number;
    capture(): MonitorCommunicationCapture | undefined;
    isCurrent(capture: MonitorCommunicationCapture | undefined): capture is MonitorCommunicationCapture;
    enter(): MonitorCommunicationCapture;
    exit(): void;
    syncInactive(): void;
}
export {};
