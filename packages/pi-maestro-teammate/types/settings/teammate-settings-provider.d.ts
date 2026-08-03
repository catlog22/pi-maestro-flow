import { type SettingsProviderV1 } from "pi-maestro-settings-core/v1";
import { type TeammateTaskType } from "../shared/task-types.ts";
declare const PROVIDER_ID = "pi-maestro-teammate";
interface SettingsEventBus {
    on(event: string, handler: (payload: unknown) => void): void | (() => void);
    emit(event: string, payload: unknown): void;
}
export interface TeammateSettingsProvider extends SettingsProviderV1 {
    readonly providerId: typeof PROVIDER_ID;
    readonly instanceId: string;
}
export interface TeammateSettingsProviderOptions {
    getGlobalPath?: () => string;
    getProjectPath?: (cwd: string) => string;
    discoverTaskTypes?: (cwd: string) => readonly TeammateTaskType[];
    discoverRoles?: (cwd: string) => readonly string[];
    openLegacySettings?: () => Promise<void> | void;
}
export declare function createTeammateSettingsProvider(options?: TeammateSettingsProviderOptions): TeammateSettingsProvider;
export declare function registerTeammateSettingsProvider(events: SettingsEventBus, provider: TeammateSettingsProvider): () => void;
export {};
