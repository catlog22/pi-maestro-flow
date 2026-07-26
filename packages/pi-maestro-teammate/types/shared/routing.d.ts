/**
 * P0 reply_to routing resolution.
 *
 * Protocol version semantics:
 *   - v2 (default): reply_to defaults to "caller"
 *   - v1 or missing + named agent: reply_to defaults to "main" (legacy compat)
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
 *   2. Protocol v2+ → "caller"
 *   3. Protocol v1 or missing + named → "main" (legacy compat)
 *   4. Protocol v1 or missing + unnamed → "caller"
 */
export declare function resolveReplyTo(params: RoutingParams): ReplyTarget;
