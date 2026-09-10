/** Canonical contracts for the additive recoverable Monitor event stream. */
export const GATEWAY_MONITOR_STREAM_FEATURE = "monitor-stream-v1" as const;
export const GATEWAY_EVENT_NOTIFICATION_METHOD = "notifications/gateway/event" as const;

export type GatewayEventKind = "state" | "progress" | "child" | "published" | "complete" | "send" | "cancel" | "error" | "gap";

export interface GatewayJournalEvent {
  eventId: string;
  cursor: number;
  workspaceId: string;
  sessionId: string;
  handle: string;
  kind: Exclude<GatewayEventKind, "gap">;
  payload: unknown;
  at: number;
}

/** A cursor names the last event completely consumed by the caller. */
export interface GatewayEventGap {
  reason: "retention" | "slow-consumer" | "revoked" | "connection-closed";
  fromCursor: number;
  toCursor: number;
  /** Pass this value as cursor to resume from the durable journal. */
  resumeCursor: number;
}

export interface GatewayEventPage {
  events: GatewayJournalEvent[];
  oldestCursor: number;
  latestCursor: number;
  nextCursor: number;
  gap?: GatewayEventGap;
}

export interface GatewayEventNotification {
  method: typeof GATEWAY_EVENT_NOTIFICATION_METHOD;
  params: {
    subscriptionId: string;
    handle: string;
    eventId: string;
    cursor: number;
    kind: GatewayEventKind;
    payload: unknown;
  };
}

export interface GatewayMonitorSubscription {
  subscriptionId: string;
  handle: string;
  cursor: number;
  watermark: number;
  oldestCursor: number;
  replayed: number;
  gap?: GatewayEventGap;
}

export interface GatewayMonitorUnsubscribeResult {
  subscriptionId: string;
  unsubscribed: boolean;
  cursor: number;
  gap?: GatewayEventGap;
}
