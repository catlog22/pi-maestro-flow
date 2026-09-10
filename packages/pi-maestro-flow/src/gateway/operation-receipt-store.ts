/** Atomic capacity-reserving store for canonical Gateway operation receipts. */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GATEWAY_COLLABORATION_LIMITS, GATEWAY_STATE_VERSION } from "./contracts.ts";
import {
  buildGatewayOperationReceiptId,
  parseGatewayOperationReceipt,
  parseGatewayOperationResult,
  type GatewayOperationReceiptPrepareInput,
  type GatewayOperationReceiptV1,
  type GatewayOperationResultV1,
} from "./operation-contracts.ts";
import { readGatewayJson, writeGatewayJsonAtomic } from "./state-paths.ts";
import type { GatewayObservationSink } from "./observability.ts";

const MAX_RECEIPT_BYTES = 128 * 1024;
const RECEIPT_NAME = /^[a-f0-9]{64}\.json$/;
/** A Gateway daemon has one owner; process-global tails also cover injected Store instances in tests. */
const tails = new Map<string, Promise<void>>();

export interface GatewayOperationReceiptStoreOptions {
  root: string;
  maxReceipts?: number;
  now?: () => number;
  /** Test-only crash seam; invoked only after the named durable boundary. */
  fault?: (point: "prepared" | "dispatching" | "accepted" | "terminal" | "outcome-unknown", receipt: GatewayOperationReceiptV1) => void | Promise<void>;
  observer?: GatewayObservationSink;
}
export interface GatewayOperationReceiptPage {
  receipts: GatewayOperationReceiptV1[];
  items: GatewayOperationReceiptV1[];
  nextCursor: number;
  hasMore: boolean;
}

export class GatewayOperationReceiptStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "GatewayOperationReceiptStoreError"; }
}
export class GatewayOperationReceiptConflictError extends GatewayOperationReceiptStoreError {
  constructor() { super("operationId is already bound to a different canonical payload"); this.name = "GatewayOperationReceiptConflictError"; }
}
export class GatewayOperationReceiptCapacityError extends GatewayOperationReceiptStoreError {
  constructor(maximum: number) { super(`Operation receipt capacity reached (${maximum})`); this.name = "GatewayOperationReceiptCapacityError"; }
}
export class GatewayOperationOutcomeUnknownError extends GatewayOperationReceiptStoreError {
  constructor() { super("The operation may have reached its side effect; durable outcome evidence is unavailable"); this.name = "GatewayOperationOutcomeUnknownError"; }
}

function clone<T>(value: T): T { return structuredClone(value); }
function sameResult(left: GatewayOperationResultV1, right: GatewayOperationResultV1): boolean { return JSON.stringify(left) === JSON.stringify(right); }
async function serializedPath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(path, current); await previous;
  try { return await operation(); }
  finally { release(); if (tails.get(path) === current) tails.delete(path); }
}

export class GatewayOperationReceiptStore {
  readonly root: string;
  readonly maxReceipts: number;
  private readonly now: () => number;
  private readonly fault?: GatewayOperationReceiptStoreOptions["fault"];
  private readonly observer?: GatewayObservationSink;
  private readonly operationTails = new Map<string, Promise<void>>();

  constructor(options: GatewayOperationReceiptStoreOptions | string) {
    const normalized = typeof options === "string" ? { root: options } : options;
    if (!normalized.root) throw new GatewayOperationReceiptStoreError("Operation receipt root is required");
    this.root = normalized.root;
    this.maxReceipts = normalized.maxReceipts ?? GATEWAY_COLLABORATION_LIMITS.maxOperationsPerSession;
    if (!Number.isSafeInteger(this.maxReceipts) || this.maxReceipts < 1 || this.maxReceipts > 65_536) throw new GatewayOperationReceiptStoreError("maxReceipts must be in [1, 65536]");
    this.now = normalized.now ?? Date.now;
    this.fault = normalized.fault;
    this.observer = normalized.observer;
  }

  receiptPath(id: string): string { return join(this.root, `${id}.json`); }

  async get(input: Omit<GatewayOperationReceiptPrepareInput, "payloadHash"> | string): Promise<GatewayOperationReceiptV1 | undefined> {
    const id = typeof input === "string" ? input : buildGatewayOperationReceiptId(input);
    const raw = await readGatewayJson<unknown>(this.receiptPath(id), MAX_RECEIPT_BYTES);
    return raw === undefined ? undefined : parseGatewayOperationReceipt(raw);
  }

  async list(cursor = 0, limit = 64): Promise<GatewayOperationReceiptPage> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new GatewayOperationReceiptStoreError("cursor must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new GatewayOperationReceiptStoreError("limit must be in [1, 128]");
    const ids = await this.ids();
    const receipts: GatewayOperationReceiptV1[] = [];
    for (const id of ids.slice(cursor, cursor + limit)) {
      const receipt = await this.get(id);
      if (!receipt) throw new GatewayOperationReceiptStoreError(`Operation receipt disappeared during listing: ${id}`);
      receipts.push(receipt);
    }
    const nextCursor = cursor + receipts.length;
    return { receipts, items: receipts.map(clone), nextCursor, hasMore: nextCursor < ids.length };
  }

  /** The prepared receipt file itself is the durable capacity reservation. */
  async prepare(input: GatewayOperationReceiptPrepareInput): Promise<{ receipt: GatewayOperationReceiptV1; created: boolean }> {
    const id = buildGatewayOperationReceiptId(input);
    let created = false;
    const receipt = await serializedPath(this.root, async () => {
      const existing = await this.get(id);
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) {
          this.observer?.observe({ category: "receipt", event: "conflict" });
          throw new GatewayOperationReceiptConflictError();
        }
        this.observer?.observe({ category: "receipt", event: "replay" });
        return existing;
      }
      if ((await this.ids()).length >= this.maxReceipts) throw new GatewayOperationReceiptCapacityError(this.maxReceipts);
      const now = this.now();
      const next = parseGatewayOperationReceipt({
        version: GATEWAY_STATE_VERSION,
        id,
        principalId: input.principalId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        memberId: input.memberId,
        memberGeneration: input.memberGeneration,
        tool: input.tool,
        action: input.action,
        operationId: input.operationId,
        payloadHash: input.payloadHash,
        state: "prepared",
        createdAt: now,
        updatedAt: now,
        preparedAt: now,
      });
      await this.writeReceipt(next); created = true; return next;
    });
    if (created) await this.fault?.("prepared", receipt);
    return { receipt: clone(receipt), created };
  }

  async markDispatching(receiptOrId: GatewayOperationReceiptV1 | string): Promise<GatewayOperationReceiptV1> {
    const next = await this.transition(receiptOrId, (receipt, now) => {
      if (receipt.state === "dispatching") return receipt;
      if (receipt.state !== "prepared") throw new GatewayOperationReceiptStoreError(`Cannot dispatch receipt in state ${receipt.state}`);
      return { ...receipt, state: "dispatching", updatedAt: now, dispatchingAt: now };
    });
    await this.fault?.("dispatching", next); return next;
  }

  async markAccepted(receiptOrId: GatewayOperationReceiptV1 | string, result: GatewayOperationResultV1): Promise<GatewayOperationReceiptV1> {
    const durableResult = parseGatewayOperationResult(result);
    const next = await this.transition(receiptOrId, (receipt, now) => {
      if (receipt.state === "accepted") {
        if (!receipt.result || !sameResult(receipt.result, durableResult)) {
          this.observer?.observe({ category: "receipt", event: "conflict" });
          throw new GatewayOperationReceiptConflictError();
        }
        return receipt;
      }
      if (receipt.state !== "dispatching") throw new GatewayOperationReceiptStoreError(`Cannot accept receipt in state ${receipt.state}`);
      return { ...receipt, state: "accepted", updatedAt: now, acceptedAt: now, result: durableResult };
    });
    await this.fault?.("accepted", next); return next;
  }

  async markTerminal(receiptOrId: GatewayOperationReceiptV1 | string): Promise<GatewayOperationReceiptV1> {
    const next = await this.transition(receiptOrId, (receipt, now) => {
      if (receipt.state === "terminal") return receipt;
      if (receipt.state !== "accepted") throw new GatewayOperationReceiptStoreError(`Cannot complete receipt in state ${receipt.state}`);
      return { ...receipt, state: "terminal", updatedAt: now, terminalAt: now };
    });
    await this.fault?.("terminal", next); return next;
  }

  async markOutcomeUnknown(receiptOrId: GatewayOperationReceiptV1 | string): Promise<GatewayOperationReceiptV1> {
    const next = await this.transition(receiptOrId, (receipt, now) => {
      if (receipt.state === "outcome-unknown") return receipt;
      if (receipt.state !== "dispatching") throw new GatewayOperationReceiptStoreError(`Cannot mark receipt outcome unknown in state ${receipt.state}`);
      return { ...receipt, state: "outcome-unknown", updatedAt: now, outcomeUnknownAt: now };
    });
    this.observer?.observe({ category: "receipt", event: "outcome-unknown" });
    await this.fault?.("outcome-unknown", next); return next;
  }

  /** Startup fence: a dispatching record cannot be safely replayed after process loss. */
  async recoverInterrupted(): Promise<GatewayOperationReceiptV1[]> {
    const values: GatewayOperationReceiptV1[] = [];
    for (const id of await this.ids()) {
      const receipt = await this.get(id);
      if (!receipt) continue;
      values.push(receipt.state === "dispatching" ? await this.markOutcomeUnknown(receipt) : receipt);
    }
    return values;
  }

  /** Single-flight one logical operation within a daemon process. */
  async serialized<T>(receiptId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(receiptId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.operationTails.set(receiptId, tail); await previous;
    try { return await operation(); }
    finally { release(); if (this.operationTails.get(receiptId) === tail) this.operationTails.delete(receiptId); }
  }

  private async transition(receiptOrId: GatewayOperationReceiptV1 | string, operation: (receipt: GatewayOperationReceiptV1, now: number) => GatewayOperationReceiptV1): Promise<GatewayOperationReceiptV1> {
    const id = typeof receiptOrId === "string" ? receiptOrId : receiptOrId.id;
    return serializedPath(this.receiptPath(id), async () => {
      const receipt = await this.get(id);
      if (!receipt) throw new GatewayOperationReceiptStoreError(`Operation receipt not found: ${id}`);
      const next = parseGatewayOperationReceipt(operation(receipt, this.now()));
      await this.writeReceipt(next); return next;
    });
  }

  private async ids(): Promise<string[]> {
    try { return (await readdir(this.root)).filter((name) => RECEIPT_NAME.test(name)).map((name) => name.slice(0, -5)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async writeReceipt(receipt: GatewayOperationReceiptV1): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeGatewayJsonAtomic(this.receiptPath(receipt.id), receipt, { mode: 0o600, maximumBytes: MAX_RECEIPT_BYTES });
  }
}
