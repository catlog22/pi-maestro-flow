/**
 * The DeepSeek Harness backend.
 *
 * The default export is what a registration document's `module` resolves to:
 * the backend wired to the real SDK driver. Without it the registry loads this
 * module, finds no backend-shaped export, and rejects the registration — so a
 * deployment could name this module in `.pi/teammate-backends.json` and never
 * reach the runtime.
 *
 * The SDK client loads with the driver on first run, not with this module. A
 * host that only reads the capability table or the configuration fields — the
 * settings shell does exactly that, on every session — would otherwise pay for
 * a transport it never opens.
 */

import { createDshBackend } from "./backend.ts";

export {
  createDshBackend,
  DSH_CONFIG_FIELDS,
  type DshDriverFactory,
  type DshDriverOptions,
  type DshHarnessDriver,
} from "./backend.ts";

/**
 * Display text for the `dsh.*` keys this backend's `configFields` carry.
 *
 * Re-exported here because a host that registers this backend reads its fields
 * from this module: taking the wording from anywhere else lets a registration
 * ship fields whose keys have no text.
 */
export { DSH_SETTINGS_CATALOGS } from "./catalog.ts";

/** The registerable backend: capability table plus the SDK-backed driver. */
export default createDshBackend(async (config, options) => {
  const { createDshDriver } = await import("./driver.ts");
  return createDshDriver(config, options);
});
