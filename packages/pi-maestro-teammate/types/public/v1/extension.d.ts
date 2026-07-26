/**
 * Version 1 public extension helpers.
 *
 * The three values below are genuine runtime entry points — a host that runs
 * `runTeammate` itself must relay child permission/question requests back to
 * the human — so importing this subpath necessarily loads the extension entry
 * point (~23 modules, plus `@earendil-works/pi-tui` and `cross-spawn`). That
 * cost is the caller's to opt into: it is *not* imposed on
 * `pi-maestro-teammate/v1/types`, `/v1/events`, `/v1/retry` or the other
 * narrow subpaths, and `test/public-api-surface.test.ts` keeps it that way.
 *
 * `TeammateDirectChildRequestHandlerOptions` is re-exported with `export type`
 * and is therefore erased — it contributes nothing to a consumer's graph.
 */
export { createTeammateDirectChildRequestHandler, handleChildInteractionRequest, handleChildRpcUiRequest, } from "../../extension/index.ts";
export type { TeammateDirectChildRequestHandlerOptions } from "../../extension/index.ts";
