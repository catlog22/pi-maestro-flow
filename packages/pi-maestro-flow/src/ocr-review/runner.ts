import crossSpawn from "cross-spawn";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, normalize } from "node:path";
import { reclaimOwnedProcessTree } from "../process/owned-process-tree.ts";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DIAGNOSTIC_BYTES = 4096;
// cross-spawn only double-escapes npm shims in node_modules/.bin. Global/custom
// batch shims forwarding %* need the same escaping for the second cmd parse.
const cmdEscape: { command(arg: string): string; argument(arg: string, doubleEscape: boolean): string } =
  createRequire(import.meta.url)("cross-spawn/lib/util/escape.js");

export interface OcrCommand {
  command: string;
  args: string[];
}

export class OcrError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, opts: { exitCode?: number | null; stderr?: string } = {}) {
    super(message);
    this.name = "OcrError";
    this.exitCode = opts.exitCode ?? null;
    this.stderr = opts.stderr ?? "";
  }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Resolve only the installation selected by PATH, not an unrelated global OCR. */
export function resolveOcrCommand(pathEnv = process.env.PATH ?? ""): OcrCommand | undefined {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const entry of pathEnv.split(delimiter)) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `ocr${ext.toLowerCase()}`);
      if (!isFile(candidate)) continue;
      let launcher: string | undefined;
      const canonical = realpathSync(candidate);
      if (canonical.replace(/\\/g, "/").endsWith("/open-code-review/bin/ocr.js")) {
        launcher = canonical;
      } else if (/\.(cmd|bat)$/i.test(candidate)) {
        const shim = readFileSync(candidate, "utf8").replace(/\\/g, "/");
        if (shim.includes("node_modules/@alibaba-group/open-code-review/bin/ocr.js")) {
          const npmLauncher = join(dir, "node_modules", "@alibaba-group", "open-code-review", "bin", "ocr.js");
          if (isFile(npmLauncher)) launcher = npmLauncher;
        }
      }
      if (!launcher) return { command: candidate, args: [] };

      const filename = process.platform === "win32" ? "opencodereview.exe" : "opencodereview";
      const require = createRequire(launcher);
      let platformPackage: string | undefined;
      try {
        platformPackage = require.resolve(`@alibaba-group/ocr-${process.platform}-${process.arch}/package.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      }
      const native = platformPackage ? join(dirname(platformPackage), "bin", filename) : undefined;
      if (native && isFile(native)) return { command: native, args: [] };
      const legacy = join(dirname(launcher), filename);
      if (isFile(legacy)) return { command: legacy, args: [] };
      // Older/custom npm installs still use their own launcher and diagnostics.
      return { command: process.execPath, args: [launcher] };
    }
  }
  return undefined;
}

export function ocrInstalled(): boolean {
  return resolveOcrCommand() !== undefined;
}

export interface OcrRunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function createOcrRunner(resolveCommand: () => OcrCommand | undefined = resolveOcrCommand) {
  return async (args: string[], opts: OcrRunOptions): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    if (opts.signal?.aborted) throw new OcrError("ocr run aborted.");
    const timeoutMs = opts.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new OcrError("OCR timeout must be positive, finite, and at most 2147483647ms.");
    }
    const command = resolveCommand();
    if (!command) throw new OcrError("ocr CLI not found on PATH. Install with: npm i -g @alibaba-group/open-code-review");

    return new Promise((resolve, reject) => {
      const argv = [...command.args, ...args];
      const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(command.command);
      const shellCommand = batch
        ? [cmdEscape.command(normalize(command.command)), ...argv.map((arg) => cmdEscape.argument(arg, true))].join(" ")
        : undefined;
      const child = (batch ? spawn : crossSpawn)(
        batch ? (process.env.ComSpec ?? "cmd.exe") : command.command,
        shellCommand ? ["/d", "/s", "/c", `"${shellCommand}"`] : argv,
        {
          cwd: opts.cwd,
          windowsVerbatimArguments: batch,
          env: { ...process.env, ...opts.env, OCR_NO_UPDATE: "1" },
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let stopping = false;
      let failure: OcrError | undefined;
      let reclaiming = false;
      let reclaimed = false;
      let closed = false;
      let exitCode: number | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const stderrText = () => Buffer.concat(stderr).toString("utf8").trim();
      const stop = (message: string) => {
        if (settled || stopping) return;
        stopping = true;
        cleanup();
        const diagnostic = stderrText().slice(-DIAGNOSTIC_BYTES);
        const error = new OcrError(`${message}${diagnostic ? `\nocr stderr (tail):\n${diagnostic}` : ""}`, { stderr: diagnostic });
        failure = error;
        if (reclaiming) return;
        void reclaimOwnedProcessTree(child, { label: "OCR CLI" }).then(
          () => finish(() => reject(error)),
          (failure: unknown) => {
            error.message += ` Process-tree cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`;
            finish(() => reject(error));
          },
        );
      };
      const onAbort = () => stop("ocr run aborted.");
      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        if (stopping || settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          stop(`ocr output exceeded ${MAX_OUTPUT_BYTES}-byte limit.`);
          return;
        }
        chunks.push(chunk);
      };
      child.stdout!.on("data", collect(stdout));
      child.stderr!.on("data", collect(stderr));
      const finishClosed = () => {
        if (!closed || !reclaimed || stopping) return;
        const out = Buffer.concat(stdout).toString("utf8").trim();
        const err = stderrText();
        finish(() => exitCode === 0
          ? resolve({ stdout: out, stderr: err, exitCode: 0 })
          : reject(new OcrError(err || out || `ocr exited with code ${exitCode ?? 1}`, { exitCode, stderr: err })));
      };
      const onExit = (code: number | null) => {
        if (stopping || reclaiming || settled) return;
        reclaiming = true;
        exitCode = code;
        cleanup();
        void reclaimOwnedProcessTree(child, { label: "OCR CLI" }).then(
          () => {
            reclaimed = true;
            if (failure) finish(() => reject(failure));
            else finishClosed();
          },
          (error: unknown) => {
            const message = `OCR process-tree cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
            if (failure) failure.message += ` ${message}`;
            finish(() => reject(failure ?? new OcrError(message)));
          },
        );
      };
      child.on("error", (error) => {
        if (child.pid) stop(`Failed to run ocr: ${error.message}`);
        else finish(() => reject(new OcrError(`Failed to start ocr: ${error.message}`)));
      });
      child.stdout!.on("error", (error) => stop(`ocr stdout failed: ${error.message}`));
      child.stderr!.on("error", (error) => stop(`ocr stderr failed: ${error.message}`));
      child.on("exit", onExit);
      child.on("close", (code) => { closed = true; onExit(code); finishClosed(); });
      timer = setTimeout(() => stop(
        `ocr ${args.slice(0, 2).join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        "Set overallTimeoutMinutes for a larger repository; preview builds full diffs before filtering.",
      ), timeoutMs);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
    });
  };
}

export const runOcr = createOcrRunner();
