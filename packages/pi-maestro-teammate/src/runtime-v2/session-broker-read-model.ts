import type {
  RuntimeBrokerReadModelSourceState,
  StoredRuntimeBrokerCursorEvent,
} from "../runtime-broker/contracts.ts";
import { parseRuntimeEventV2 } from "./validation.ts";
import {
  SessionDomainProjectionV2,
  type SessionDomainReadModelSnapshotV2,
} from "./session-domain.ts";

const PAGE_LIMIT = 128;
const MAX_PAGES = 4_096;

export interface SessionDomainBrokerReadPortV2 {
  readRuntimeReadModelSources(
    workspaceId: string,
    afterStreamId?: string,
    limit?: number,
    requestId?: string,
  ): Promise<RuntimeBrokerReadModelSourceState[]>;
  readRuntimeReadModelEvents(
    workspaceId: string,
    afterCursor?: number,
    limit?: number,
    requestId?: string,
  ): Promise<StoredRuntimeBrokerCursorEvent[]>;
}

export class SessionDomainBrokerReadModelV2 {
  readonly #port: SessionDomainBrokerReadPortV2;
  readonly #workspaceId: string;
  #snapshot: SessionDomainReadModelSnapshotV2 = { version: 1, cursor: 0, windows: [], messages: [] };

  constructor(options: { port: SessionDomainBrokerReadPortV2; workspaceId: string }) {
    this.#port = options.port;
    this.#workspaceId = options.workspaceId;
    if (!this.#workspaceId) throw new Error("Runtime V2 session read model requires workspaceId");
  }

  snapshot(): SessionDomainReadModelSnapshotV2 {
    return structuredClone(this.#snapshot);
  }

  /** Cold rebuild is intentional: active lease sources are authoritative and expired streams must disappear. */
  async refresh(): Promise<SessionDomainReadModelSnapshotV2> {
    const active = await this.#activeStreams();
    const projection = new SessionDomainProjectionV2();
    let brokerCursor = 0;
    let projectionCursor = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const events = await this.#port.readRuntimeReadModelEvents(
        this.#workspaceId,
        brokerCursor,
        PAGE_LIMIT,
        `session-read:${this.#workspaceId}:events:${page}`,
      );
      if (events.length === 0) break;
      for (const stored of events) {
        if (!Number.isSafeInteger(stored.cursor) || stored.cursor <= brokerCursor) {
          throw new Error("Runtime V2 session read-model cursor did not advance");
        }
        brokerCursor = stored.cursor;
        if (!active.has(stored.streamId)) continue;
        const event = parseRuntimeEventV2(stored.payload);
        if (event.kind !== "domain.event" || !event.eventType.startsWith("session.")) continue;
        projectionCursor += 1;
        if (!projection.apply(event, projectionCursor)) {
          throw new Error(`Runtime V2 session event failed projection: ${stored.eventId}`);
        }
      }
      if (events.length < PAGE_LIMIT) break;
      if (page === MAX_PAGES - 1) throw new Error("Runtime V2 session read-model exceeded page bound");
    }
    const projected = projection.snapshot();
    this.#snapshot = Object.freeze({ ...projected, cursor: brokerCursor });
    return this.snapshot();
  }

  async #activeStreams(): Promise<Set<string>> {
    const active = new Set<string>();
    let afterStreamId = "";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const sources = await this.#port.readRuntimeReadModelSources(
        this.#workspaceId,
        afterStreamId,
        PAGE_LIMIT,
        `session-read:${this.#workspaceId}:sources:${page}`,
      );
      if (sources.length === 0) return active;
      for (const source of sources) {
        if (!source.streamId || source.streamId <= afterStreamId) {
          throw new Error("Runtime V2 session source page did not advance");
        }
        afterStreamId = source.streamId;
        if (source.active) active.add(source.streamId);
      }
      if (sources.length < PAGE_LIMIT) return active;
    }
    throw new Error("Runtime V2 session source list exceeded page bound");
  }
}
