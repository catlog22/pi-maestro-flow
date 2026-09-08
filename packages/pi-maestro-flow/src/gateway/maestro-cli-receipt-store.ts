/** Durable payload-bound receipts for governed Maestro CLI stage operations. */
import { createHash } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseGatewayMaestroReceipt,
  type GatewayMaestroReceiptV1,
} from "./maestro-cli-contracts.ts";
import { readGatewayJson, writeGatewayJsonAtomic } from "./state-paths.ts";

const MAX_RECEIPT_BYTES = 64 * 1024;

export class GatewayMaestroReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayMaestroReceiptConflictError";
  }
}

export class GatewayMaestroReceiptStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  path(workspaceId: string, operationId: string): string {
    const token = createHash("sha256").update(`${workspaceId}\0${operationId}`, "utf8").digest("hex");
    return join(this.root, workspaceId, `${token}.json`);
  }

  async get(workspaceId: string, operationId: string): Promise<GatewayMaestroReceiptV1 | undefined> {
    const value = await readGatewayJson<unknown>(this.path(workspaceId, operationId), MAX_RECEIPT_BYTES);
    return value === undefined ? undefined : structuredClone(parseGatewayMaestroReceipt(value));
  }

  async serialized<T>(workspaceId: string, operationId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}:${operationId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => next);
    this.queues.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  async createPending(input: Pick<GatewayMaestroReceiptV1, "operationId" | "workspaceId" | "payloadHash">): Promise<{ receipt: GatewayMaestroReceiptV1; created: boolean }> {
    const existing = await this.get(input.workspaceId, input.operationId);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) throw new GatewayMaestroReceiptConflictError("operationId is already bound to a different stage payload");
      return { receipt: existing, created: false };
    }
    const timestamp = this.now();
    const receipt = parseGatewayMaestroReceipt({
      version: 1,
      action: "stage",
      state: "pending",
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const path = this.path(receipt.workspaceId, receipt.operationId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A hard link publishes the complete file atomically and fails with
      // EEXIST instead of overwriting a competing operation receipt.
      await link(temporary, path);
      return { receipt: structuredClone(receipt), created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await this.get(input.workspaceId, input.operationId);
      if (!raced) throw new GatewayMaestroReceiptConflictError("receipt creation raced with an unreadable operation");
      if (raced.payloadHash !== input.payloadHash) throw new GatewayMaestroReceiptConflictError("operationId is already bound to a different stage payload");
      return { receipt: raced, created: false };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async settle(
    receipt: GatewayMaestroReceiptV1,
    state: "committed" | "uncertain" | "failed",
    details: { recordId?: string; error?: string } = {},
  ): Promise<GatewayMaestroReceiptV1> {
    const next = parseGatewayMaestroReceipt({
      ...receipt,
      state,
      updatedAt: this.now(),
      ...(details.recordId === undefined ? {} : { recordId: details.recordId }),
      ...(details.error === undefined ? {} : { error: details.error }),
    });
    await this.write(next);
    return structuredClone(next);
  }

  private async write(receipt: GatewayMaestroReceiptV1): Promise<void> {
    await writeGatewayJsonAtomic(this.path(receipt.workspaceId, receipt.operationId), receipt, {
      mode: 0o600,
      maximumBytes: MAX_RECEIPT_BYTES,
    });
  }
}
