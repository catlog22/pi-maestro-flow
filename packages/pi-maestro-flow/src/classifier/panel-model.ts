import { randomUUID } from "node:crypto";
import { getPiFeatureOwner, type JsonValue, type SettingsChange, type SettingsContextV1, type SettingsSnapshot } from "pi-maestro-settings-core/v1";
import type { ClassifierSettingsProvider } from "./settings-provider.ts";
import { probeClassifierRuntime, type ClassifierRuntimeReadiness } from "pi-maestro-teammate/v1/classify";

export interface PanelModelOption { reference: string; label: string }
export interface PanelModelCatalog { options: PanelModelOption[]; unavailable?: string }
/** Only authenticated native typed candidates; never infer classifier type from names. */
export async function classifierModelCatalog(hostVersion: string, registry: unknown, signal?: AbortSignal): Promise<PanelModelCatalog> {
  const host = registry as {
    getAvailableOfType?: (type: "classifier", provider?: string, options?: { signal?: AbortSignal }) => Promise<readonly { provider: string; id: string; name?: string }[]>;
    getModelOfType?: unknown; classify?: unknown;
  } | undefined;
  const capable = !!host && typeof host.getAvailableOfType === "function" && typeof host.getModelOfType === "function" && typeof host.classify === "function";
  if (getPiFeatureOwner(hostVersion, capable) !== "native" || !capable) {
    return { options: [], unavailable: "Classifier model picker unavailable: host lacks the native authenticated classifier API (requires Pi >=0.99). Existing configuration is preserved." };
  }
  try {
    const models = await host!.getAvailableOfType!("classifier", undefined, { signal });
    if (signal?.aborted) throw new Error("Panel cancelled");
    const options = modelOptions(models);
    return { options, ...(!options.length ? { unavailable: "No authenticated classifier models available." } : {}) };
  } catch (error) {
    return { options: [], unavailable: `Classifier model catalog unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
/** Re-query authenticated catalogs/readiness only; never configure/reset or replace a pin. */
export async function refreshClassifierPanelModels(hostVersion: string, registry: unknown, signal?: AbortSignal, reload = true): Promise<{ classifierModels: PanelModelCatalog; llmModels: PanelModelCatalog; readiness: ClassifierRuntimeReadiness }> {
  const refresh = registry as { refresh?: (options: { signal?: AbortSignal; allowNetwork: boolean }) => Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }> };
  if (reload && typeof refresh?.refresh === "function") {
    // Reload model definitions only; do not force provider discovery or write configuration.
    const result = await refresh.refresh({ signal, allowNetwork: false });
    signal?.throwIfAborted();
    if (result.aborted) throw new Error("Model refresh aborted; existing catalogs/pins preserved.");
    if (result.errors.size) throw new Error(`Model refresh failed: ${[...result.errors].map(([provider, error]) => `${provider}: ${error.message}`).join("; ")}`);
  }
  const classifierModels = await classifierModelCatalog(hostVersion, registry, signal);
  signal?.throwIfAborted();
  let llmModels: PanelModelCatalog;
  try {
    const host = registry as { getAvailable(): readonly { provider: string; id: string; name?: string }[] };
    const options = modelOptions(host.getAvailable());
    llmModels = { options, ...(!options.length ? { unavailable: "No authenticated LLM models available." } : {}) };
  } catch (error) { llmModels = { options: [], unavailable: `LLM catalog unavailable: ${String(error)}` }; }
  const readiness = await probeClassifierRuntime(signal);
  signal?.throwIfAborted();
  return { classifierModels, llmModels, readiness };
}
export function modelOptions(models: readonly { provider: string; id: string; name?: string }[]): PanelModelOption[] {
  return [...new Map(models.map(model => {
    const reference = `${model.provider}/${model.id}`;
    return [reference, { reference, label: model.name ? `${reference} · ${model.name}` : reference }] as const;
  })).values()];
}
export function configuredPanelValues(snapshot: SettingsSnapshot): Record<string, JsonValue> {
  return Object.fromEntries(snapshot.effective.values.map(value => {
    const configured = snapshot.configured.values.find(entry => entry.key === value.key);
    // Env-overridden effective values must never become configured drafts.
    const fallback = value.key === "classifier.enabled" ? false : value.key === "classifier.endpoint" ? "auto" : value.key === "classifier.model" ? "" : value.value;
    return [value.key, configured?.state === "set" ? configured.value! : value.source === "runtime" ? fallback : value.value];
  }));
}
export function panelChanges(before: Record<string, JsonValue>, after: Record<string, JsonValue>): SettingsChange[] {
  return Object.entries(after).filter(([key, value]) => value !== before[key]).map(([key, value]) => ({ operation: "set", scope: "project", key, value }));
}
/** Same provider/lock/CAS/live-apply path as the settings shell; lifecycle checked after lock waits. */
export async function saveClassifierPanel(
  provider: ClassifierSettingsProvider, context: SettingsContextV1, snapshot: SettingsSnapshot,
  changes: readonly SettingsChange[], assertFresh: () => void, allowInvalid = false,
): Promise<SettingsSnapshot> {
  assertFresh();
  const invalid = snapshot.configured.values.find(value => value.state === "invalid");
  if (invalid && !allowInvalid) throw new Error(`Classifier configuration is invalid: ${invalid.messageKey ?? "unreadable file"}; repair it before saving.`);
  const transactionId = randomUUID();
  let token: string | undefined;
  try {
    const prepared = await provider.prepare!({ context, transactionId, changes, expectedRevisions: snapshot.configured.resources });
    token = prepared.prepareToken;
    assertFresh();
    if (!prepared.prepared || !token) throw new Error(prepared.validation.conflicts?.length ? "classifier.json revision conflict; close and reopen the panel." : `Classifier save rejected: ${prepared.validation.issues.map(issue => issue.messageKey).join(", ")}`);
    // Publication is synchronous; cancellation during lock release cannot undo this commit.
    const result = await provider.commit!({ context, transactionId, prepareToken: token });
    return result.snapshot;
  } finally {
    if (token) await provider.abort!({ context, transactionId, prepareToken: token });
  }
}
