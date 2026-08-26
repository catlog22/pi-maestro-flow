import type { RuntimeTransport, RuntimeTransportFactory } from "./transport.ts";

export const RUNTIME_BROKER_ENV_VAR = "PI_RUNTIME_BROKER" as const;
export type RuntimeBrokerMode = "off" | "file" | "sqlite";

/** Default off: the SQLite broker causes intermittent startup hangs (see debug-notes). Opt in explicitly via PI_RUNTIME_BROKER=sqlite|file. */
export function parseRuntimeBrokerMode(value: string | undefined): RuntimeBrokerMode {
  if (value === undefined) return "off";
  const normalized = value.trim().toLowerCase();
  if (normalized === "file" || normalized === "sqlite") return normalized;
  return "off";
}

export function runtimeBrokerModeFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeBrokerMode {
  return parseRuntimeBrokerMode(env[RUNTIME_BROKER_ENV_VAR]);
}

export interface RuntimeTransportRolloutOptions {
  env?: NodeJS.ProcessEnv;
  mode?: RuntimeBrokerMode;
  fileFactory?: RuntimeTransportFactory;
  sqliteFactory?: RuntimeTransportFactory;
}

export type RuntimeTransportSelection =
  | { mode: "off"; transport: undefined }
  | { mode: "file" | "sqlite"; transport: RuntimeTransport };

/** Selects and constructs a transport only; it does not install production authority. */
export function createRuntimeTransport(options: RuntimeTransportRolloutOptions = {}): RuntimeTransportSelection {
  const mode = options.mode === undefined
    ? runtimeBrokerModeFromEnv(options.env)
    : parseRuntimeBrokerMode(options.mode);
  if (mode === "off") return { mode, transport: undefined };

  const factory = mode === "file" ? options.fileFactory : options.sqliteFactory;
  if (!factory) throw new Error(`${mode} runtime transport factory is not configured`);

  const transport = factory();
  if (transport.driver !== mode) {
    throw new Error(`${mode} runtime transport factory returned ${transport.driver}`);
  }
  return { mode, transport };
}

export const selectRuntimeTransport = createRuntimeTransport;
