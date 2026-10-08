/** Host-only, in-process observation of actual local Pi subprocess boundaries.
 * No child-supplied actor ID, copied Todo snapshot, progress/token inference or remote substitute.
 */
export interface TeammateHostBoundary {
  correlationId: string;
  incarnation: string;
  /** Host-monotonic process incarnation; late events from replaced children are older. */
  sequence: number;
  parentSessionFile?: string;
  runtimeGeneration: number;
  event: Readonly<Record<string, unknown>>;
  /** Native steer only. Never wakes an offline runtime or aborts a tool. */
  steer(message: string): boolean;
}
type Observer = (boundary: TeammateHostBoundary) => void;
const key = Symbol.for("pi-maestro-teammate.host-boundary-observers.v1");
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Observer> };
const observers = globals[key] ??= new Map<string, Observer>();
const sequenceKey = Symbol.for("pi-maestro-teammate.host-boundary-sequence.v1");
const sequenceGlobals = globalThis as typeof globalThis & { [sequenceKey]?: number };
/** @internal allocated by the actual subprocess producer, never a child envelope. */
export function nextTeammateHostSequence(): number {
  return sequenceGlobals[sequenceKey] = (sequenceGlobals[sequenceKey] ?? 0) + 1;
}
export function registerTeammateHostObserver(owner: string, observer: Observer): () => void {
  if (!owner.trim()) throw new Error("Host observer owner is required");
  if (!observers.has(owner) && observers.size >= 64) throw new Error("Host observer registry is full");
  observers.set(owner, observer);
  return () => { if (observers.get(owner) === observer) observers.delete(owner); };
}
/** @internal Producer boundary; observers cannot interfere with execution. */
export function publishTeammateHostBoundary(boundary: TeammateHostBoundary): void {
  for (const observer of observers.values()) {
    try { observer(boundary); } catch { /* passive supervision must not break execution */ }
  }
}
