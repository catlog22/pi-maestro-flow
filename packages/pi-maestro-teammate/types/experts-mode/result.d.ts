/**
 * Qoder-like fixed completion envelope for expert/teammate results.
 * Pure formatter — callers opt in; does not rewrite all tool paths by default.
 */
export interface ExpertResultInput {
    agentId: string;
    agentName?: string;
    content: string;
    exitCode?: number;
    taskType?: string;
    /** When true, skip double-wrapping if content already has RESULT header */
    skipIfPresent?: boolean;
}
export declare function formatExpertResult(input: ExpertResultInput): string;
/** Parse agentId from an envelope if present. */
export declare function parseExpertResultAgentId(text: string): string | null;
