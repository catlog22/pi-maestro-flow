import type { AvailableModelEntry } from "./model-catalog.ts";
import type { DiscoveryCatalogProjection, InternalModelCatalogRoute } from "./model-registry.ts";
/** Safe to surface without including target, transport, or credential details. */
export declare const REMOTE_MODEL_SESSION_UNAVAILABLE_REASON = "Remote model routes are available only from the active root Monitor session.";
export declare const UNRESOLVABLE_MODEL_REGISTRATION_REASON = "The registered model deployment cannot be resolved by this host.";
export declare const INVALID_MODEL_REGISTRATION_ID_REASON = "The model registration id is not a provider/model specifier.";
export declare const UNHEALTHY_MODEL_REGISTRATION_REASON = "The registered model route is temporarily unhealthy.";
export interface ModelRouteHealth {
    healthy: boolean;
    /** Must already be safe for operator-facing diagnostics. */
    unavailableReason?: string;
}
export interface ModelSessionAvailability {
    isChild: boolean;
    hasCurrentRootMonitorAuthority: boolean;
    health?: (route: InternalModelCatalogRoute) => ModelRouteHealth;
}
export interface SessionModelCatalogProjection {
    entries: AvailableModelEntry[];
    diagnostics: string[];
}
/** Secret-free identity, topology, and four-gate availability for one route. */
export interface ModelRegistrationAvailabilityDiagnostic {
    registrationId: string;
    modelId: string;
    deploymentId: string;
    deploymentDefault: boolean;
    harness: InternalModelCatalogRoute["runtime"]["harness"];
    transport: InternalModelCatalogRoute["runtime"]["transport"]["kind"];
    modelSelection: InternalModelCatalogRoute["runtime"]["modelSelection"];
    registered: true;
    resolvable: boolean;
    sessionAvailable: boolean;
    healthy: boolean;
    unavailableReason?: string;
}
/**
 * Project every registered route for diagnostics, including unavailable ones.
 * No deployment config, adapter selector, transport target, or raw failure is
 * copied into the result.
 */
export declare function modelRegistrationAvailabilityDiagnostics(discovery: DiscoveryCatalogProjection, availability: ModelSessionAvailability): ModelRegistrationAvailabilityDiagnostic[];
/**
 * Project only routes that pass every discovery gate. The result deliberately
 * contains no selector, deployment configuration, transport target, or secret.
 */
export declare function projectSessionModelCatalog(discovery: DiscoveryCatalogProjection, availability: ModelSessionAvailability): SessionModelCatalogProjection;
