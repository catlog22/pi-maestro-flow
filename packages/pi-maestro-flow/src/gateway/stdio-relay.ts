/** SSH-friendly stdio relay into the one local Gateway daemon. */
import type { Readable, Writable } from "node:stream";
import { GatewayOwnerStore } from "./owner-store.ts";
import { connectGatewayIpc, gatewayIpcAddress } from "./ipc.ts";
import { gatewayOwnerPath } from "./state-paths.ts";

export const GATEWAY_OFFLINE_MESSAGE = "Pi Maestro Gateway is offline. Start it with `pi-maestro-gateway serve`.";

export class GatewayOfflineError extends Error {
  constructor(message = GATEWAY_OFFLINE_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayOfflineError";
  }
}

export interface GatewayStdioRelayOptions {
  input?: Readable;
  output?: Writable;
  ownerStore?: GatewayOwnerStore;
  ownerPath?: string;
  address?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function relayGatewayStdio(options: GatewayStdioRelayOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const ownerPath = options.ownerPath ?? gatewayOwnerPath();
  const store = options.ownerStore ?? new GatewayOwnerStore({ ownerPath });
  const owner = await store.read().catch((error) => {
    throw new GatewayOfflineError(GATEWAY_OFFLINE_MESSAGE, { cause: error });
  });
  if (!owner) throw new GatewayOfflineError();
  const address = options.address ?? owner.socket ?? gatewayIpcAddress(undefined, ownerPath);
  let socket;
  try {
    socket = await connectGatewayIpc({ address, ownerToken: owner.ownerToken, timeoutMs: options.timeoutMs });
  } catch (error) {
    throw new GatewayOfflineError(GATEWAY_OFFLINE_MESSAGE, { cause: error });
  }
  if (options.signal?.aborted) {
    socket.destroy();
    throw new GatewayOfflineError("Gateway stdio relay was cancelled");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      input.unpipe(socket);
      socket.unpipe(output);
      options.signal?.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error); else resolve();
    };
    const onAbort = (): void => {
      socket.destroy();
      finish(new GatewayOfflineError("Gateway stdio relay was cancelled"));
    };
    const onError = (error: Error): void => finish(new GatewayOfflineError(GATEWAY_OFFLINE_MESSAGE, { cause: error }));
    const onClose = (): void => finish();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.once("close", onClose);
    input.pipe(socket);
    socket.pipe(output, { end: false });
  });
}
