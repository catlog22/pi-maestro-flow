import { spawn, type ChildProcess } from "node:child_process";
import { ComputerUseError } from "../types.ts";

export interface BridgeCommand {
  /** A fixed executable selected by the adapter, never a shell command. */
  executable: string;
  /** Fixed argv vector; values are passed directly with shell:false. */
  argv: readonly string[];
}

export interface BridgeProcessResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface BridgeProcessOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /** Test seam; production callers should leave this unset. */
  spawnProcess?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function validateCommand(command: BridgeCommand): void {
  if (!command.executable || command.executable.includes("\0")) {
    throw new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: "Bridge executable is missing or invalid", retryable: false });
  }
  for (const arg of command.argv) {
    if (arg.includes("\0")) throw new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: "Bridge argv contains a NUL byte", retryable: false });
  }
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ComputerUseError({ code: "INTERNAL", message: `${label} must be a positive safe integer`, retryable: false });
  return limit;
}

function abortError(code: "ABORTED" | "TIMEOUT", message: string): ComputerUseError {
  return new ComputerUseError({ code, message, retryable: code === "TIMEOUT" });
}

/** Execute a checked-in native bridge using a direct argv vector and bounded pipes. */
export function runBridgeProcess(command: BridgeCommand, options: BridgeProcessOptions = {}): Promise<BridgeProcessResult> {
  validateCommand(command);
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxStdoutBytes = positiveLimit(options.maxStdoutBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxStdoutBytes");
  const maxStderrBytes = positiveLimit(options.maxStderrBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxStderrBytes");
  if (options.signal?.aborted) return Promise.reject(abortError("ABORTED", "Bridge execution was aborted before spawn"));

  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise<BridgeProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command.executable, [...command.argv], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: error instanceof Error ? error.message : String(error), retryable: false }));
      return;
    }

    if (!child.stdout || !child.stderr) {
      child.kill();
      reject(new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: "Bridge process did not expose bounded output pipes", retryable: false }));
      return;
    }

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      stdoutStream.removeListener("data", onStdout);
      stderrStream.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const fail = (error: ComputerUseError) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      reject(error);
    };
    const onStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        fail(new ComputerUseError({ code: "ARTIFACT_LIMIT_EXCEEDED", message: `Bridge stdout exceeds ${maxStdoutBytes} bytes`, retryable: false }));
        return;
      }
      stdout.push(chunk);
    };
    const onStderr = (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderrBytes) {
        fail(new ComputerUseError({ code: "ARTIFACT_LIMIT_EXCEEDED", message: `Bridge stderr exceeds ${maxStderrBytes} bytes`, retryable: false }));
        return;
      }
      stderr.push(chunk);
    };
    const onError = (error: Error) => fail(new ComputerUseError({ code: "DEPENDENCY_UNAVAILABLE", message: error.message, retryable: false }));
    const onAbort = () => fail(abortError("ABORTED", "Bridge execution was aborted"));
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (exitCode !== 0) {
        reject(new ComputerUseError({
          code: "DEPENDENCY_UNAVAILABLE",
          message: `Bridge exited with ${signal ? `signal ${signal}` : `code ${String(exitCode)}`}`,
          retryable: false,
          details: { exitCode, signal, stderr: Buffer.concat(stderr).toString("utf8") },
        }));
        return;
      }
      resolve({ stdout: new Uint8Array(Buffer.concat(stdout)), stderr: new Uint8Array(Buffer.concat(stderr)), exitCode, signal });
    };

    stdoutStream.on("data", onStdout);
    stderrStream.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail(abortError("TIMEOUT", `Bridge exceeded ${timeoutMs}ms`)), timeoutMs);
  });
}
