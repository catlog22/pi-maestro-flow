import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
export interface AdvisorRuntimeCandidate {
    id: string;
    priority: number;
    handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
    onOwnershipChanged?(owned: boolean): void;
}
export interface AdvisorRuntimeLease {
    isOwner(): boolean;
    release(): void;
}
export declare function registerAdvisorRuntime(candidate: AdvisorRuntimeCandidate): AdvisorRuntimeLease;
export declare function getAdvisorRuntimeOwner(): string | undefined;
export declare function ensureAdvisorCommandRegistered(pi: ExtensionAPI): void;
