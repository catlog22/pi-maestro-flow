/** Canonical event construction for durable collaboration mutations. */
import { randomUUID } from "node:crypto";
import { GATEWAY_STATE_VERSION } from "./contracts.ts";
import { parseSessionEvent, type SessionEventV1 } from "./session-contracts.ts";

export function createSessionEvent(input: Omit<SessionEventV1, "version" | "id"> & { id?: string }): SessionEventV1 {
  return parseSessionEvent({ version: GATEWAY_STATE_VERSION, id: input.id ?? randomUUID(), ...input });
}

export function eventsAfter(events: readonly SessionEventV1[], revision = 0): SessionEventV1[] {
  return structuredClone(events.filter((event) => event.revision > revision));
}
