import type { AvailableModelEntry } from "./model-catalog.ts";
import type {
  DiscoveryCatalogProjection,
  InternalModelCatalogRoute,
} from "./model-registry.ts";

/** Safe to surface without including target, transport, or credential details. */
export const REMOTE_MODEL_SESSION_UNAVAILABLE_REASON =
  "Remote model routes are available only from the active root Monitor session.";
export const UNRESOLVABLE_MODEL_REGISTRATION_REASON =
  "The registered model deployment cannot be resolved by this host.";
export const INVALID_MODEL_REGISTRATION_ID_REASON =
  "The model registration id is not a provider/model specifier.";
export const UNHEALTHY_MODEL_REGISTRATION_REASON =
  "The registered model route is temporarily unhealthy.";

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
export function modelRegistrationAvailabilityDiagnostics(
  discovery: DiscoveryCatalogProjection,
  availability: ModelSessionAvailability,
): ModelRegistrationAvailabilityDiagnostic[] {
  return discovery.entries.map((route) => {
    const hasCatalogId = catalogParts(route.modelRegistrationId) !== undefined;
    const sessionReason = sessionUnavailableReason(route, availability);
    const health = availability.health?.(route) ?? { healthy: true };
    const unavailableReason = !route.runtime.resolvable
      ? UNRESOLVABLE_MODEL_REGISTRATION_REASON
      : sessionReason
        ?? (!hasCatalogId
          ? INVALID_MODEL_REGISTRATION_ID_REASON
          : !health.healthy
            ? UNHEALTHY_MODEL_REGISTRATION_REASON
            : undefined);
    return {
      registrationId: route.modelRegistrationId,
      modelId: route.modelId,
      deploymentId: route.deploymentId,
      deploymentDefault: route.deploymentDefault,
      harness: route.runtime.harness,
      transport: route.runtime.transport.kind,
      modelSelection: route.runtime.modelSelection,
      registered: true,
      resolvable: route.runtime.resolvable,
      sessionAvailable: sessionReason === undefined && hasCatalogId,
      healthy: health.healthy,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
    };
  });
}

function catalogParts(modelRegistrationId: string): { provider: string; id: string } | undefined {
  const separator = modelRegistrationId.indexOf("/");
  if (separator <= 0 || separator === modelRegistrationId.length - 1) return undefined;
  return {
    provider: modelRegistrationId.slice(0, separator),
    id: modelRegistrationId.slice(separator + 1),
  };
}

function sessionUnavailableReason(
  route: InternalModelCatalogRoute,
  availability: ModelSessionAvailability,
): string | undefined {
  if (route.runtime.transport.kind !== "remote-worker") return undefined;
  return availability.isChild || !availability.hasCurrentRootMonitorAuthority
    ? REMOTE_MODEL_SESSION_UNAVAILABLE_REASON
    : undefined;
}

function minimalCatalogEntry(route: InternalModelCatalogRoute): AvailableModelEntry | undefined {
  const parts = catalogParts(route.modelRegistrationId);
  if (!parts) return undefined;
  const capabilities = route.capabilities;
  return {
    ...parts,
    ...(route.displayName === undefined ? {} : { name: route.displayName }),
    ...(capabilities?.reasoning === undefined ? {} : { reasoning: capabilities.reasoning }),
    ...(capabilities?.input === undefined ? {} : { input: [...capabilities.input] }),
  };
}

/**
 * Project only routes that pass every discovery gate. The result deliberately
 * contains no selector, deployment configuration, transport target, or secret.
 */
export function projectSessionModelCatalog(
  discovery: DiscoveryCatalogProjection,
  availability: ModelSessionAvailability,
): SessionModelCatalogProjection {
  const entries: AvailableModelEntry[] = [];
  const diagnostics = [...discovery.diagnostics];

  for (const route of discovery.entries) {
    if (!route.runtime.resolvable) {
      diagnostics.push(
        `Model registration "${route.modelRegistrationId}" is unavailable because its deployment is not resolvable.`,
      );
      continue;
    }

    const unavailable = sessionUnavailableReason(route, availability);
    if (unavailable !== undefined) {
      diagnostics.push(unavailable);
      continue;
    }

    const health = availability.health?.(route) ?? { healthy: true };
    if (!health.healthy) {
      diagnostics.push(
        health.unavailableReason
          ?? `Model registration "${route.modelRegistrationId}" is unavailable because its route is unhealthy.`,
      );
      continue;
    }

    const entry = minimalCatalogEntry(route);
    if (!entry) {
      diagnostics.push(
        `Model registration "${route.modelRegistrationId}" is unavailable because its id is not a provider/model specifier.`,
      );
      continue;
    }
    entries.push(entry);
  }

  return { entries, diagnostics: [...new Set(diagnostics)] };
}
