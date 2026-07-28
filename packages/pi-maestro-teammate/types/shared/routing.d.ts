/**
 * P0 reply_to routing resolution.
 *
 * Protocol version semantics:
 *   - v2 or missing (default): reply_to defaults to "caller"
 *   - explicit v1 + named agent: reply_to defaults to "main" (legacy compat)
 *   - Explicit reply_to always wins regardless of protocol version
 */
export type ReplyTarget = "caller" | "main";
export interface RoutingParams {
    reply_to?: "caller" | "main";
    protocol_version?: number;
    name?: string;
}
/**
 * Resolve the reply_to target based on protocol version and naming.
 *
 * Priority:
 *   1. Explicit reply_to parameter (always wins)
 *   2. Missing protocol or protocol v2+ → "caller"
 *   3. Explicit protocol v1 + named → "main" (legacy compat)
 *   4. Explicit protocol v1 + unnamed → "caller"
 */
export declare function resolveReplyTo(params: RoutingParams): ReplyTarget;
