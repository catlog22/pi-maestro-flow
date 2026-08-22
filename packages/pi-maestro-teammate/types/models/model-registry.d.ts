import type { BackendRegistration, TeammateExecutionMode } from "pi-maestro-backend-core/v1/registry";
import type { CliToolsConfig } from "../cli-tools/cli-tools-config.ts";
import type { TeammateThinkingLevel } from "../shared/thinking.ts";
import { type AvailableModelEntry } from "./model-catalog.ts";
export type ModelSelectorV2 = {
    kind: "adapter-model";
    value: string;
} | {
    kind: "deployment-default";
} | {
    kind: "fixed";
};
export interface ModelRegistrationCapabilitiesV2 {
    reasoning?: boolean;
    thinkingLevels?: readonly TeammateThinkingLevel[];
    input?: readonly ("text" | "image")[];
}
export interface ModelRegistrationV2 {
    modelId: string;
    deployment: string;
    selector: ModelSelectorV2;
    deploymentDefault?: boolean;
    displayName?: string;
    capabilities?: ModelRegistrationCapabilitiesV2;
}
export interface ModelRegistryCompatibilityV1 {
    version: 1;
    hostModelsDeployment?: string;
    teammateCliToolsProjection?: {
        enabled: boolean;
    };
    modelAliases?: Record<string, string>;
    backendAliases?: Record<string, string>;
    remoteLocations?: Record<string, string>;
}
export interface ModelRegistryManifestV2 {
    version: 2;
    mode: "model-registry";
    default: string;
    defaultModel: string;
    backends: Record<string, BackendRegistration>;
    models: Record<string, ModelRegistrationV2>;
    compatibility?: ModelRegistryCompatibilityV1;
}
export interface ProjectionIdentity {
    revision: number;
    hash: string;
}
export type ModelRegistryHarness = "pi" | "dsh" | "acp" | "adapter-owned";
export type ModelRegistryTransport = {
    kind: "local-process";
    protocol: "pi-rpc" | "json-rpc-stdio" | "acp";
} | {
    kind: "acp-direct-ssh";
    protocol: "acp";
} | {
    kind: "dsh-direct-ssh";
    protocol: "json-rpc-stdio";
} | {
    kind: "remote-worker";
    gateway: "ssh";
    protocol: "remote/2";
    driver: "pi-rpc" | "acp";
} | {
    kind: "adapter-owned";
};
export type ModelSelectionSupport = "native" | "unsupported" | "unknown";
export interface ModelRuntimeDescriptor {
    harness: ModelRegistryHarness;
    transport: ModelRegistryTransport;
    modelSelection: ModelSelectionSupport;
    resolvable: boolean;
    unavailableReason?: string;
}
export interface InternalModelCatalogRoute {
    modelRegistrationId: string;
    modelId: string;
    deploymentId: string;
    displayName?: string;
    capabilities?: ModelRegistrationCapabilitiesV2;
    deploymentDefault: boolean;
    runtime: ModelRuntimeDescriptor;
}
export interface ModelDispatchRoute {
    modelRegistrationId: string;
    modelId: string;
    deploymentId: string;
    selector: ModelSelectorV2;
    deploymentDefault: boolean;
    displayName?: string;
    capabilities?: ModelRegistrationCapabilitiesV2;
}
export interface ModelDeploymentRoute {
    deploymentId: string;
    registration: BackendRegistration;
    runtime: ModelRuntimeDescriptor;
}
export interface DiscoveryCatalogProjection extends ProjectionIdentity {
    defaultModel: string;
    entries: readonly InternalModelCatalogRoute[];
    diagnostics: readonly string[];
}
export interface DispatchAuthorityProjection extends ProjectionIdentity {
    registryVersion: ModelRegistryManifestV2["version"];
    defaultDeployment: string;
    defaultModel: string;
    routesByRegistrationId: ReadonlyMap<string, ModelDispatchRoute>;
    deploymentsById: ReadonlyMap<string, ModelDeploymentRoute>;
    modelAliases: ReadonlyMap<string, string>;
    backendAliases: ReadonlyMap<string, string>;
    remoteLocations: ReadonlyMap<string, string>;
    diagnostics: readonly string[];
}
export interface CompiledModelRegistryPair {
    discovery: DiscoveryCatalogProjection;
    dispatch: DispatchAuthorityProjection;
}
export interface ModelRegistryCompileInputs {
    hostModels?: readonly AvailableModelEntry[];
    cliToolsConfig?: CliToolsConfig | null;
    /** Sanitized failures from optional projection sources. */
    diagnostics?: readonly string[];
    previousIdentity?: ProjectionIdentity;
}
export declare function parseModelRegistryManifest(raw: string, path?: string): ModelRegistryManifestV2;
export declare function deriveModelRuntimeDescriptor(deploymentId: string, registration: BackendRegistration): ModelRuntimeDescriptor;
export declare function compileModelRegistryManifest(manifest: ModelRegistryManifestV2, inputs?: ModelRegistryCompileInputs): CompiledModelRegistryPair;
export declare function isModelRegistryMode(mode: TeammateExecutionMode | undefined): mode is "model-registry";
