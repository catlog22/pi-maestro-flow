/** Transport retry policy for versioned Gateway tool operations. */

export const GATEWAY_RETRY_CLASSES = ["read", "receipt-backed", "outcome-unknown"] as const;
export type GatewayRetryClass = typeof GATEWAY_RETRY_CLASSES[number];

export interface GatewayOperationPolicy {
  readonly retryClass: GatewayRetryClass;
  readonly tool: string;
  readonly action?: string;
  readonly operationId?: string;
}

export function gatewayOperationMayReplay(policy: GatewayOperationPolicy): boolean {
  return policy.retryClass !== "outcome-unknown";
}

const READ_ACTIONS = new Map<string, ReadonlySet<string>>([
  ["workspace", new Set(["list", "get"])],
  ["board", new Set(["list", "get", "search", "observe"])],
  ["host", new Set(["describe", "status", "test"])],
  ["job", new Set(["list", "status", "logs"])],
  ["file", new Set(["list", "stat", "read", "find", "grep", "realpath"])],
  ["teammate", new Set(["list", "observe", "wait", "result"])],
  ["session", new Set(["get", "list"])],
  ["todo", new Set(["list", "get"])],
  ["monitor", new Set(["list", "observe", "wait", "result"])],
  ["handoff", new Set(["list", "get", "search"])],
  ["skill", new Set(["list", "load"])],
  ["maestro_cli", new Set(["search", "load"])],
]);

const RECEIPT_BACKED_ACTIONS = new Map<string, ReadonlySet<string>>([
  ["board", new Set(["create", "update", "claim", "renew", "release", "takeover", "attach-endpoint", "detach-endpoint", "bind-session", "link-plan", "handoff", "transition"])],
  ["session", new Set(["create", "join", "renew", "leave", "handoff", "close", "start-pi"])],
  ["todo", new Set(["create", "update", "delete", "claim", "release", "advance"])],
  ["monitor", new Set(["message", "cancel"])],
  ["maestro_cli", new Set(["stage"])],
]);

/**
 * Classify one concrete tool action before transport invocation. Merely having
 * an operationId is insufficient: only mutations whose canonical service owns
 * a durable operation/receipt boundary may be replayed.
 */
export function classifyGatewayOperation(tool: string, args: Readonly<Record<string, unknown>> = {}): GatewayOperationPolicy {
  const action = typeof args.action === "string" && args.action.trim() ? args.action.trim() : undefined;
  if (action !== undefined && READ_ACTIONS.get(tool)?.has(action)) return { retryClass: "read", tool, action };
  const operationId = typeof args.operationId === "string" && args.operationId.trim() ? args.operationId.trim() : undefined;
  if (action !== undefined && operationId !== undefined && RECEIPT_BACKED_ACTIONS.get(tool)?.has(action)) return { retryClass: "receipt-backed", tool, action, operationId };
  return { retryClass: "outcome-unknown", tool, ...(action === undefined ? {} : { action }) };
}

