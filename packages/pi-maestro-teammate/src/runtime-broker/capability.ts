import { spawnSync } from "node:child_process";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
} from "./contracts.ts";
import {
  getRuntimeBrokerEndpoint,
  getRuntimeBrokerStateDirectory,
} from "./private-state.ts";

export interface RuntimeBrokerCapability {
  ok: boolean;
  protocol: typeof RUNTIME_BROKER_PROTOCOL;
  version: typeof RUNTIME_BROKER_PROTOCOL_VERSION;
  nodeVersion: string;
  sqlite: boolean;
  transport: "named-pipe" | "unix-socket";
  stateDirectory: string;
  endpoint: string;
  reason?: string;
}

export function probeRuntimeBrokerCapability(
  stateDirectory = getRuntimeBrokerStateDirectory(),
): RuntimeBrokerCapability {
  let endpoint = "";
  let endpointError: string | undefined;
  try {
    endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  } catch (error) {
    endpointError = error instanceof Error ? error.message : String(error);
  }

  const sqliteProbe = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      "import('node:sqlite').then(({ DatabaseSync }) => { const db = new DatabaseSync(':memory:'); db.close(); })",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 },
  );
  const sqlite = sqliteProbe.status === 0 && !sqliteProbe.error;
  const reason = endpointError
    ?? (sqlite ? undefined : (sqliteProbe.error?.message || sqliteProbe.stderr.trim() || "node:sqlite is unavailable"));
  return {
    ok: sqlite && !endpointError,
    protocol: RUNTIME_BROKER_PROTOCOL,
    version: RUNTIME_BROKER_PROTOCOL_VERSION,
    nodeVersion: process.versions.node,
    sqlite,
    transport: process.platform === "win32" ? "named-pipe" : "unix-socket",
    stateDirectory,
    endpoint,
    ...(reason ? { reason } : {}),
  };
}
