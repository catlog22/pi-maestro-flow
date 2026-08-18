/**
 * Version 1 backend-seam surface for hosts.
 *
 * A host needs two things from this package's backend layer: the name Pi
 * registers under, and the configuration fields a settings shell should render
 * for it. Both come from the implementation rather than being restated, so a
 * new tunable appears in the shell without a second edit.
 */
export { PI_SUBPROCESS, backendRegistryConfigSync, dispatchRegistrySync, forgetBackendRegistryConfigSync, } from "../../backends/registry-host.ts";
export { PI_SUBPROCESS_CONFIG_FIELDS } from "../../backends/pi-subprocess.ts";
export type { PiSubprocessRunExtras } from "../../backends/pi-subprocess.ts";
