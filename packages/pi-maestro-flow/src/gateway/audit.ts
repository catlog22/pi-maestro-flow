/** Single redacted JSONL audit sink for all Gateway RPC outcomes. */
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayPrincipal } from "./contracts.ts";
import { projectGatewayObservation, type GatewayObservation } from "./observability.ts";

export type GatewayAuditOutcome = "allowed" | "denied" | "error";

export interface GatewayAuditEvent {
  requestId: string;
  principal: GatewayPrincipal;
  tool: string;
  action?: string;
  outcome: GatewayAuditOutcome;
  code?: string;
  durationMs: number;
}

/**
 * Deliberately accepts only an allow-listed event shape. Request arguments,
 * credentials, command lines, file contents, and error messages never reach
 * the serializer.
 */
export class GatewayAuditSink {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly path?: string) {}

  write(event: GatewayAuditEvent): Promise<void> {
    return this.append({
      version: 1,
      recordType: "rpc",
      at: new Date().toISOString(),
      requestId: event.requestId,
      principalId: event.principal.id,
      transport: event.principal.transport,
      tool: event.tool,
      ...(event.action === undefined ? {} : { action: event.action }),
      outcome: event.outcome,
      ...(event.code === undefined ? {} : { code: event.code }),
      durationMs: Math.max(0, Math.floor(event.durationMs)),
    });
  }

  writeObservation(observation: GatewayObservation): Promise<void> {
    const projected = projectGatewayObservation(observation);
    return this.append({ version: 1, recordType: "observation", at: new Date().toISOString(), ...projected });
  }

  flush(): Promise<void> { return this.tail; }

  private append(record: Record<string, unknown>): Promise<void> {
    if (!this.path) return Promise.resolve();
    const operation = this.tail.then(async () => {
      await mkdir(dirname(this.path!), { recursive: true, mode: 0o700 });
      const handle = await open(this.path!, "a", 0o600);
      try {
        await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
