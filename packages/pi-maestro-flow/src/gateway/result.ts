/** Reply helpers for the Gateway result envelope. */
import { randomUUID } from "node:crypto";
import type {
  GatewayError,
  GatewayResult,
  GatewayResultMeta,
  GatewayResultStatus,
} from "./contracts.ts";
import { parseGatewayResult } from "./validation.ts";

export interface GatewayErrorInput {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface GatewayResultOptions {
  status?: GatewayResultStatus;
  requestId?: string;
  principalId?: string;
  startedAt?: string;
  durationMs?: number;
}

function resultMeta(options: GatewayResultOptions): GatewayResultMeta {
  return {
    requestId: options.requestId ?? randomUUID(),
    principalId: options.principalId ?? "gateway",
    startedAt: options.startedAt ?? new Date().toISOString(),
    durationMs: options.durationMs ?? 0,
  };
}

export function gatewayOk<T>(data?: T, options: GatewayResultOptions | string = {}): GatewayResult<T> {
  const normalized = typeof options === "string" ? { requestId: options } : options;
  return parseGatewayResult<T>({
    ok: true,
    status: normalized.status ?? "succeeded",
    ...(data === undefined ? {} : { data }),
    meta: resultMeta(normalized),
  });
}

export function gatewayError<T = never>(error: GatewayErrorInput | GatewayError, options: GatewayResultOptions | string = {}): GatewayResult<T> {
  const normalizedOptions = typeof options === "string" ? { requestId: options } : options;
  const normalizedError: GatewayError = {
    code: error.code,
    message: error.message,
    retryable: error.retryable ?? false,
  };
  return parseGatewayResult<T>({
    ok: false,
    status: normalizedOptions.status ?? "failed",
    error: normalizedError,
    meta: resultMeta(normalizedOptions),
  });
}

export const gatewayFail = gatewayError;
export const ok = gatewayOk;
export const fail = gatewayError;

export function isGatewayResult(value: unknown): value is GatewayResult {
  try { parseGatewayResult(value); return true; } catch { return false; }
}

export function assertGatewayResult<T = unknown>(value: unknown): GatewayResult<T> {
  return parseGatewayResult<T>(value);
}

export function encodeGatewayResult(value: GatewayResult): string {
  return `${JSON.stringify(parseGatewayResult(value))}\n`;
}

export function decodeGatewayResult<T = unknown>(value: string | Uint8Array): GatewayResult<T> {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value).toString("utf8")); }
  catch (error) { throw new Error("Invalid Gateway result JSON", { cause: error }); }
  return parseGatewayResult<T>(parsed);
}

export function mapGatewayError(error: unknown, fallbackCode = "internal_error"): GatewayError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable === true,
      };
    }
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
