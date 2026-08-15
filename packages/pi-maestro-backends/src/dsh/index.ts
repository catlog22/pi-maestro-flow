/**
 * The DeepSeek Harness backend.
 *
 * The backend and its SDK driver are separate entry points so a consumer that
 * only needs the capability table or configuration rules never loads the SDK.
 */

export { createDshBackend, type DshDriverFactory, type DshHarnessDriver } from "./backend.ts";
export { createDshDriver } from "./driver.ts";
