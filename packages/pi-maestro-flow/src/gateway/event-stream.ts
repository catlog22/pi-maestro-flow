/** MCP-notification delivery over a bounded, single-writer subscription queue. */
import { randomUUID } from "node:crypto";
import {
  GATEWAY_EVENT_NOTIFICATION_METHOD,
  type GatewayEventGap,
  type GatewayEventNotification,
  type GatewayJournalEvent,
  type GatewayMonitorSubscription,
  type GatewayMonitorUnsubscribeResult,
} from "./event-contracts.ts";
import { GatewayEventJournal } from "./event-journal.ts";
import type { GatewayObservationSink } from "./observability.ts";

export interface GatewayEventStreamOptions {
  maxSubscribers?: number;
  maxSubscribersPerConnection?: number;
  maxQueuedEventsPerSubscriber?: number;
  maxQueuedBytesPerSubscriber?: number;
  maxQueuedEventsPerConnection?: number;
  maxQueuedBytesPerConnection?: number;
  observer?: GatewayObservationSink;
}
export interface GatewayEventSubscribeInput {
  connectionId: string;
  workspaceId: string;
  sessionId: string;
  memberId: string;
  memberGeneration: number;
  handle: string;
  cursor?: number;
  write(notification: GatewayEventNotification): Promise<void>;
  validate?(): boolean | Promise<boolean>;
}
interface Queued { notification: GatewayEventNotification; bytes: number; eventCursor: number; }
interface Subscriber {
  id: string;
  input: GatewayEventSubscribeInput;
  cursor: number;
  watermark: number;
  queue: Queued[];
  queuedBytes: number;
  writing: boolean;
  writesSinceValidation: number;
  closed: boolean;
  removeListener: () => void;
  gap?: GatewayEventGap;
}
interface ConnectionUsage { subscribers: number; events: number; bytes: number; }
interface ClosedSubscription { connectionId: string; result: GatewayMonitorUnsubscribeResult; }

function positive(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive safe integer`);
  return result;
}
function validCursor(value: number | undefined): number {
  const result = value ?? 0;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("cursor must be a non-negative safe integer");
  return result;
}

export class GatewayEventStream {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly closed = new Map<string, ClosedSubscription>();
  private readonly connections = new Map<string, ConnectionUsage>();
  private readonly maxSubscribers: number;
  private readonly maxSubscribersPerConnection: number;
  private readonly maxQueuedEventsPerSubscriber: number;
  private readonly maxQueuedBytesPerSubscriber: number;
  private readonly maxQueuedEventsPerConnection: number;
  private readonly maxQueuedBytesPerConnection: number;
  private readonly observer?: GatewayObservationSink;

  constructor(readonly journal: GatewayEventJournal, options: GatewayEventStreamOptions = {}) {
    this.maxSubscribers = positive(options.maxSubscribers, 256, "maxSubscribers");
    this.maxSubscribersPerConnection = positive(options.maxSubscribersPerConnection, 32, "maxSubscribersPerConnection");
    this.maxQueuedEventsPerSubscriber = positive(options.maxQueuedEventsPerSubscriber, 10_000, "maxQueuedEventsPerSubscriber");
    this.maxQueuedBytesPerSubscriber = positive(options.maxQueuedBytesPerSubscriber, 4 * 1024 * 1024, "maxQueuedBytesPerSubscriber");
    this.maxQueuedEventsPerConnection = positive(options.maxQueuedEventsPerConnection, 20_000, "maxQueuedEventsPerConnection");
    this.maxQueuedBytesPerConnection = positive(options.maxQueuedBytesPerConnection, 8 * 1024 * 1024, "maxQueuedBytesPerConnection");
    this.observer = options.observer;
  }

  subscribe(input: GatewayEventSubscribeInput): GatewayMonitorSubscription {
    if (this.subscribers.size >= this.maxSubscribers) throw new Error("Monitor subscriber capacity reached");
    const usage = this.connections.get(input.connectionId) ?? { subscribers: 0, events: 0, bytes: 0 };
    if (usage.subscribers >= this.maxSubscribersPerConnection) throw new Error("Monitor connection subscriber capacity reached");
    const cursor = validCursor(input.cursor);
    // Watermark and listener installation are synchronous. Live events above the
    // watermark queue behind replay, so there is no duplicate or missing window.
    const watermark = this.journal.watermark(input.handle);
    const id = randomUUID();
    const subscriber: Subscriber = {
      id, input, cursor, watermark, queue: [], queuedBytes: 0, writing: true, writesSinceValidation: 256, closed: false,
      removeListener: () => undefined,
    };
    subscriber.removeListener = this.journal.subscribe(input.handle, (event) => {
      if (event.cursor > watermark) this.enqueue(subscriber, event);
    });
    usage.subscribers += 1; this.connections.set(input.connectionId, usage); this.subscribers.set(id, subscriber);
    const page = this.journal.page(input.handle, cursor, this.journal.maxEventsPerExecution, watermark);
    this.observer?.observe({ category: "stream", event: "subscribe" });
    if (page.gap) this.observer?.observe({ category: "stream", event: "gap" });
    subscriber.cursor = page.gap?.resumeCursor ?? cursor;
    for (const event of page.events) this.enqueue(subscriber, event);
    subscriber.writing = false;
    setImmediate(() => { void this.drain(subscriber); });
    return {
      subscriptionId: id,
      handle: input.handle,
      cursor: subscriber.cursor,
      watermark,
      oldestCursor: page.oldestCursor,
      replayed: page.events.length,
      ...(page.gap ? { gap: page.gap } : {}),
    };
  }

  unsubscribe(subscriptionId: string, connectionId?: string): GatewayMonitorUnsubscribeResult {
    const subscriber = this.subscribers.get(subscriptionId);
    if (!subscriber || (connectionId !== undefined && subscriber.input.connectionId !== connectionId)) {
      const closed = this.closed.get(subscriptionId);
      return closed && (connectionId === undefined || closed.connectionId === connectionId)
        ? closed.result
        : { subscriptionId, unsubscribed: false, cursor: 0 };
    }
    const result = { subscriptionId, unsubscribed: true, cursor: subscriber.cursor, ...(subscriber.gap ? { gap: subscriber.gap } : {}) };
    this.closeSubscriber(subscriber);
    return result;
  }

  closeConnection(connectionId: string): void {
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.input.connectionId === connectionId) {
        subscriber.gap = deliveryGap("connection-closed", subscriber.cursor, subscriber.watermark);
        this.observer?.observe({ category: "stream", event: "gap" });
        this.closeSubscriber(subscriber);
      }
    }
  }

  closeMatching(predicate: (binding: Pick<GatewayEventSubscribeInput, "workspaceId" | "sessionId" | "memberId" | "memberGeneration" | "handle">) => boolean): void {
    for (const subscriber of [...this.subscribers.values()]) {
      if (predicate(subscriber.input)) {
        subscriber.gap = deliveryGap("revoked", subscriber.cursor, this.journal.watermark(subscriber.input.handle));
        this.observer?.observe({ category: "stream", event: "gap" });
        this.closeSubscriber(subscriber);
      }
    }
  }

  state(subscriptionId: string): { closed: boolean; cursor: number; queuedEvents: number; queuedBytes: number; writing: boolean; gap?: GatewayEventGap } | undefined {
    const subscriber = this.subscribers.get(subscriptionId);
    if (!subscriber) {
      const closed = this.closed.get(subscriptionId)?.result;
      return closed ? { closed: true, cursor: closed.cursor, queuedEvents: 0, queuedBytes: 0, writing: false, ...(closed.gap ? { gap: closed.gap } : {}) } : undefined;
    }
    return { closed: subscriber.closed, cursor: subscriber.cursor, queuedEvents: subscriber.queue.length, queuedBytes: subscriber.queuedBytes, writing: subscriber.writing, ...(subscriber.gap ? { gap: subscriber.gap } : {}) };
  }

  stats(): { subscribers: number; connections: number; queuedEvents: number; queuedBytes: number } {
    let queuedEvents = 0; let queuedBytes = 0;
    for (const usage of this.connections.values()) { queuedEvents += usage.events; queuedBytes += usage.bytes; }
    return { subscribers: this.subscribers.size, connections: this.connections.size, queuedEvents, queuedBytes };
  }

  private enqueue(subscriber: Subscriber, event: GatewayJournalEvent): void {
    if (subscriber.closed) return;
    const notification: GatewayEventNotification = {
      method: GATEWAY_EVENT_NOTIFICATION_METHOD,
      params: { subscriptionId: subscriber.id, handle: event.handle, eventId: event.eventId, cursor: event.cursor, kind: event.kind, payload: event.payload },
    };
    const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
    const usage = this.connections.get(subscriber.input.connectionId)!;
    if (subscriber.queue.length + 1 > this.maxQueuedEventsPerSubscriber
      || subscriber.queuedBytes + bytes > this.maxQueuedBytesPerSubscriber
      || usage.events + 1 > this.maxQueuedEventsPerConnection
      || usage.bytes + bytes > this.maxQueuedBytesPerConnection) {
      subscriber.gap = deliveryGap("slow-consumer", subscriber.cursor, event.cursor);
      this.observer?.observe({ category: "stream", event: "slow-consumer" });
      this.observer?.observe({ category: "stream", event: "gap" });
      this.closeSubscriber(subscriber);
      return;
    }
    subscriber.queue.push({ notification, bytes, eventCursor: event.cursor });
    subscriber.queuedBytes += bytes; usage.events += 1; usage.bytes += bytes;
    if (!subscriber.writing) void this.drain(subscriber);
  }

  private async drain(subscriber: Subscriber): Promise<void> {
    if (subscriber.closed || subscriber.writing) return;
    subscriber.writing = true;
    let validateNow = true;
    try {
      while (!subscriber.closed && subscriber.queue.length > 0) {
        if (subscriber.input.validate && (validateNow || subscriber.writesSinceValidation >= 256)) {
          if (!await subscriber.input.validate()) {
            subscriber.gap = deliveryGap("revoked", subscriber.cursor, this.journal.watermark(subscriber.input.handle));
            this.observer?.observe({ category: "stream", event: "gap" });
            this.closeSubscriber(subscriber); break;
          }
          subscriber.writesSinceValidation = 0;
          validateNow = false;
        }
        const item = subscriber.queue[0]!;
        try { await subscriber.input.write(item.notification); }
        catch {
          subscriber.gap = deliveryGap("connection-closed", subscriber.cursor, this.journal.watermark(subscriber.input.handle));
          this.observer?.observe({ category: "stream", event: "gap" });
          this.closeSubscriber(subscriber); break;
        }
        if (subscriber.closed) break;
        subscriber.queue.shift(); subscriber.queuedBytes -= item.bytes;
        const usage = this.connections.get(subscriber.input.connectionId);
        if (usage) { usage.events -= 1; usage.bytes -= item.bytes; }
        subscriber.cursor = item.eventCursor;
        subscriber.writesSinceValidation += 1;
      }
    } finally { subscriber.writing = false; }
  }

  private closeSubscriber(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true; subscriber.removeListener(); this.subscribers.delete(subscriber.id);
    this.closed.set(subscriber.id, { connectionId: subscriber.input.connectionId, result: { subscriptionId: subscriber.id, unsubscribed: true, cursor: subscriber.cursor, ...(subscriber.gap ? { gap: subscriber.gap } : {}) } });
    while (this.closed.size > this.maxSubscribers) this.closed.delete(this.closed.keys().next().value!);
    const usage = this.connections.get(subscriber.input.connectionId);
    if (usage) {
      usage.subscribers -= 1; usage.events -= subscriber.queue.length; usage.bytes -= subscriber.queuedBytes;
      if (usage.subscribers <= 0) this.connections.delete(subscriber.input.connectionId);
    }
    subscriber.queue = []; subscriber.queuedBytes = 0;
  }
}

function deliveryGap(reason: GatewayEventGap["reason"], cursor: number, observed: number): GatewayEventGap {
  return { reason, fromCursor: cursor + 1, toCursor: Math.max(cursor, observed), resumeCursor: cursor };
}
