import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { SECRET_ENV_NAME } from "pi-maestro-backends/child-env";

export {
  IMMUTABLE_ENV_NAMES,
  SECRET_ENV_NAME,
  sanitizedChildEnvironment,
  targetChildEnvironment,
  type SanitizedChildEnvironmentOptions,
} from "pi-maestro-backends/child-env";

const REDACTION = "[REDACTED]";
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate at a UTF-8 boundary and append a deterministic marker. */
export function truncateUtf8(value: string, maximumBytes: number, marker = "...[truncated]"): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("UTF-8 byte limit must be a non-negative safe integer");
  }
  if (utf8ByteLength(value) <= maximumBytes) return value;
  if (maximumBytes === 0) return "";

  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maximumBytes) {
    return Buffer.from(marker, "utf8").subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  }

  const contentBytes = maximumBytes - markerBytes;
  const prefix = Buffer.from(value, "utf8")
    .subarray(0, contentBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
  return `${prefix}${marker}`;
}

export interface RedactRemoteErrorOptions {
  environment?: NodeJS.ProcessEnv;
  maximumBytes?: number;
}

/** Remove known environment secrets and common inline credential forms. */
export function redactRemoteError(error: unknown, options: RedactRemoteErrorOptions = {}): string {
  let message = error instanceof Error ? error.message : String(error);
  const environment = options.environment ?? process.env;

  const secretValues = Object.entries(environment)
    .flatMap(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length >= 4
      ? [value]
      : [])
    .sort((left, right) => right.length - left.length);

  for (const secret of secretValues) message = message.split(secret).join(REDACTION);
  message = message
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTION}`)
    .replace(/\b(api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*([^\s,;]+)/gi, `$1=${REDACTION}`)
    .replace(/\/\/[^\s/@:]+:[^\s/@]+@/g, `//${REDACTION}@`);

  return truncateUtf8(message, options.maximumBytes ?? 8 * 1024);
}

export interface ProcessTreeIdentity {
  readonly pid: number;
  readonly processGroupId: number;
}

export interface WindowsTaskkillCommand {
  executable: string;
  args: string[];
}

export interface ProcessTreeDependencies {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  runTaskkill?: (command: WindowsTaskkillCommand) => {
    status: number | null;
    error?: Error;
    signal?: NodeJS.Signals | null;
  };
}

export function captureProcessTree(pid: number | undefined): ProcessTreeIdentity | undefined {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return Object.freeze({ pid, processGroupId: pid });
}

export function buildWindowsTaskkillCommand(
  identity: ProcessTreeIdentity,
  force: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): WindowsTaskkillCommand {
  const executable = environment.SystemRoot
    ? path.win32.join(environment.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
  return {
    executable,
    args: ["/PID", String(identity.pid), "/T", ...(force ? ["/F"] : [])],
  };
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH";
}

function defaultTaskkill(command: WindowsTaskkillCommand): { status: number | null; error?: Error; signal?: NodeJS.Signals | null } {
  const result = spawnSync(command.executable, command.args, {
    windowsHide: true,
    stdio: "ignore",
    timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
  });
  return {
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
  };
}

function taskkillUnconfirmedError(
  result: { status: number | null; error?: Error; signal?: NodeJS.Signals | null },
): Error {
  const errorCode = result.error && "code" in result.error
    ? String((result.error as NodeJS.ErrnoException).code)
    : undefined;
  const details = [
    "status=null",
    `signal=${result.signal ?? "none"}`,
    ...(errorCode ? [`error=${errorCode}`] : []),
  ].join(", ");
  return new Error(
    `taskkill process-tree result was unconfirmed (${details})`,
    result.error ? { cause: result.error } : undefined,
  );
}

/** Signal a captured process tree without consulting the leader's current state. */
export function signalProcessTree(
  identity: ProcessTreeIdentity | undefined,
  signal: NodeJS.Signals,
  dependencies: ProcessTreeDependencies = {},
): void {
  if (!identity) return;
  if ((dependencies.platform ?? process.platform) === "win32") {
    const command = buildWindowsTaskkillCommand(
      identity,
      signal === "SIGKILL",
      dependencies.environment,
    );
    const result = (dependencies.runTaskkill ?? defaultTaskkill)(command);
    if (result.status === null) throw taskkillUnconfirmedError(result);
    if (result.error && !isMissingProcess(result.error)) throw result.error;
    // taskkill uses 128 when the leader/tree is already absent. This is an
    // absence signal, not proof that an earlier sweep reclaimed descendants.
    if (result.status !== 0 && result.status !== 128) {
      throw new Error(`taskkill failed with status ${result.status}`);
    }
    return;
  }

  try {
    (dependencies.kill ?? process.kill)(-identity.processGroupId, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

/** Gracefully terminate, then always escalate the captured tree after the grace period. */
export async function terminateProcessTree(
  identity: ProcessTreeIdentity | undefined,
  graceMs: number,
  dependencies: ProcessTreeDependencies = {},
): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error("Process-tree grace period must be a non-negative safe integer");
  }
  if (!identity) return;
  signalProcessTree(identity, "SIGTERM", dependencies);
  await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  signalProcessTree(identity, "SIGKILL", dependencies);
}
