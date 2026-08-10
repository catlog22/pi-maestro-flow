import type { InFlightExpert } from "./types.ts";
/** Read current in-flight experts (P6 observability). */
export declare function getInFlight(cwd?: string, statePath?: string): InFlightExpert[];
/** Append or replace in-flight entries by id. */
export declare function trackInFlight(entries: Array<Partial<InFlightExpert> & {
    id?: string;
    name?: string;
    agent?: string;
}>, opts?: {
    cwd?: string;
    statePath?: string;
    stage?: string;
}): InFlightExpert[];
/**
 * Remove settled experts from in-flight (MV-04).
 * 1) Exact match: id / correlationId / name (all matching entries).
 * 2) Agent fallback: only for keys not satisfied by exact match, remove at most
 *    ONE entry per agent key (avoids wiping parallel same-agent tasks).
 */
export declare function settleInFlight(keys: string | string[], opts?: {
    cwd?: string;
    statePath?: string;
}): InFlightExpert[];
export declare function clearInFlight(cwd?: string, opts?: {
    statePath?: string;
}): InFlightExpert[];
