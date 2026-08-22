/**
 * Version 1 backend-seam surface for hosts.
 *
 * A host needs two things from this package's backend layer: the name Pi
 * registers under, and the configuration fields a settings shell should render
 * for it. Both come from the implementation rather than being restated, so a
 * new tunable appears in the shell without a second edit.
 */

export {
  PI_SUBPROCESS,
  backendRegistryConfigSync,
  dispatchRegistryForProjectionSync,
  dispatchRegistrySync,
  forgetBackendRegistryConfigSync,
  modelRegistryPairSync,
  publishedModelRegistryPairSync,
} from "../../backends/registry-host.ts";
export type { ModelRegistryProjectionInputs } from "../../backends/registry-host.ts";
export {
  compileModelRegistryManifest,
  deriveModelRuntimeDescriptor,
  isModelRegistryMode,
  parseModelRegistryManifest,
} from "../../models/model-registry.ts";
export type {
  CompiledModelRegistryPair,
  DiscoveryCatalogProjection,
  DispatchAuthorityProjection,
  InternalModelCatalogRoute,
  ModelDeploymentRoute,
  ModelDispatchRoute,
  ModelRegistrationCapabilitiesV2,
  ModelRegistrationV2,
  ModelRegistryCompatibilityV1,
  ModelRegistryHarness,
  ModelRegistryManifestV2,
  ModelRegistryTransport,
  ModelRuntimeDescriptor,
  ModelSelectorV2,
  ProjectionIdentity,
} from "../../models/model-registry.ts";
export { PI_SUBPROCESS_CONFIG_FIELDS, PI_SUBPROCESS_SETTINGS_CATALOGS } from "../../backends/pi-subprocess.ts";
export type { PiSubprocessRunExtras } from "../../backends/pi-subprocess.ts";
