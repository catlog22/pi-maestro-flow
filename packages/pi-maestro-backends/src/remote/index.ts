/**
 * The remote-workers backend and the port its host must supply.
 *
 * No default export: this backend is constructed with the host's manager, so
 * the registry resolves it through the in-process branch of its loader rather
 * than by importing this module and narrowing a module namespace.
 */

export { createRemoteBackend, type RemoteManagerFactory } from "./backend.ts";
export { foldRemoteOutcome, type RemoteOutcomeInput } from "./outcome.ts";
export type {
  RemoteDriverId,
  RemoteInputMode,
  RemoteRunCancelResult,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunInputResult,
  RemoteRunSnapshot,
  RemoteStartedRun,
  RemoteStatus,
  RemoteWorkerManagerLike,
  RemoteWorkerStartRequest,
  RemoteWorkerWaitOptions,
} from "./types.ts";
