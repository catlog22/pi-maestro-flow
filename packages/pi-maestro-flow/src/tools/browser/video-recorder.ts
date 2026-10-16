import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Page } from "puppeteer-core";
import { CDPSessionEvent } from "puppeteer-core/internal/api/CDPSession.js";
import type { BrowserScreencastOptions, BrowserVideoPage } from "./video.ts";

interface RecorderDependencies {
  spawn?: typeof spawn;
  now?: () => number;
}

async function startupStep<T>(work: Promise<T>, signal?: AbortSignal, releaseLate?: (resource: T) => Promise<void>): Promise<T> {
  if (!signal) return work;
  let abort!: () => void;
  let interrupted = false;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { interrupted = true; reject(signal.reason ?? new DOMException("Browser video startup aborted.", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  if (releaseLate) void work.then((resource) => {
    if (interrupted) void releaseLate(resource).catch((error) => console.warn(`[browser] Late video session cleanup failed: ${String(error)}`));
  }, () => {}); // The original rejection belongs to the caller below.
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createCdpVideoPage(
  page: Pick<Page, "createCDPSession" | "viewport" | "evaluate">,
  dependencies: RecorderDependencies = {},
): BrowserVideoPage {
  return {
    async screencast(options: Readonly<BrowserScreencastOptions> = {}) {
      if (options.format !== undefined && options.format !== "webm") throw new Error("Browser video supports only WebM.");
      const signal = options.signal;
      signal?.throwIfAborted();
      const fps = options.fps ?? 30;
      const scale = options.scale ?? 1;
      if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("Browser video fps must be an integer between 1 and 60.");
      if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("Browser video scale must be greater than 0 and at most 4.");
      if (options.size && (![options.size.width, options.size.height].every((value) => Number.isInteger(value) && value >= 2))) {
        throw new Error("Browser video size must contain integer width and height of at least 2 pixels.");
      }
      if (options.size && options.scale !== undefined) throw new Error("Browser video size and scale cannot be combined.");
      if (options.ffmpegPath !== undefined && !options.ffmpegPath.trim()) throw new Error("Browser video ffmpeg_path must not be empty.");
      const viewport = page.viewport() ?? await startupStep(page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })), signal);
      const bounds = options.size ?? { width: 800, height: 800 };
      const ratio = options.scale === undefined ? Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height) : scale;
      // VP8 4:2:0 needs chroma-aligned dimensions. Size is a bound, not a padded canvas.
      const width = Math.max(2, Math.floor(viewport.width * ratio / 2) * 2);
      const height = Math.max(2, Math.floor(viewport.height * ratio / 2) * 2);
      const session = await startupStep(page.createCDPSession(), signal, (late) => late.detach());
      const now = dependencies.now ?? (() => performance.now());
      const recorder = Object.assign(new PassThrough(), { stop, size: { width, height } });
      let child: ReturnType<typeof spawn> | undefined;
      let failure: Error | undefined;
      let stopping: Promise<void> | undefined;
      let stopped = false;
      let disconnected = false;
      let capturing = false;
      let startupComplete = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let latest: Buffer;
      let startedAt = 0;
      let sent = 0;
      let finalFrames: number | undefined;
      let pumping: Promise<void> | undefined;
      let stderr = "";
      let exited = false;
      let pendingWrite: ((error?: Error | null) => void) | undefined;
      let resolveExit!: () => void;
      const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
      let cleaning: Promise<void> | undefined;

      function fail(error: Error) {
        if (failure) return;
        failure = error;
        pendingWrite?.(error);
        recorder.destroy(error);
        void stop().catch((reason: Error) => { recorder.destroy(reason); });
      }
      // A process can fail between returning the recorder and attaching its file pipeline.
      recorder.on("error", fail);
      recorder.once("close", () => {
        if (!stopped) fail(new Error("Browser video output closed before the encoder stopped."));
      });
      function onDisconnect() {
        disconnected = true;
        fail(new Error("Browser video CDP session disconnected."));
      }
      function onFrame(event: { data: string; sessionId: number }) {
        void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch((error: Error) => {
          if (!stopped) fail(error);
        });
        if (!stopped) latest = Buffer.from(event.data, "base64");
      }
      session.on(CDPSessionEvent.Disconnected, onDisconnect);
      session.on("Page.screencastFrame", onFrame);

      const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new DOMException("Browser video startup aborted.", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      function cleanup(): Promise<void> {
        return cleaning ??= (async () => {
          signal?.removeEventListener("abort", onAbort);
          session.off("Page.screencastFrame", onFrame);
          session.off(CDPSessionEvent.Disconnected, onDisconnect);
          if (disconnected) return;
          try {
            if (capturing && (!signal?.aborted || startupComplete)) await session.send("Page.stopScreencast");
          } catch (error) {
            failure ??= error instanceof Error ? error : new Error(String(error));
          } finally {
            try { await session.detach(); }
            catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
          }
        })();
      }

      function pump(): Promise<void> {
        return pumping ??= (async () => {
          // Only one stdin write is outstanding; CDP events replace `latest`, never queue frames.
          while (!failure && sent < (finalFrames ?? Math.max(1, Math.ceil((now() - startedAt) * fps / 1000)))) {
            await new Promise<void>((resolve, reject) => {
              const done = (error?: Error | null) => {
                if (pendingWrite !== done) return;
                pendingWrite = undefined;
                if (error) reject(error); else resolve();
              };
              pendingWrite = done;
              child!.stdin!.write(latest, done);
            });
            sent++;
          }
        })().finally(() => { pumping = undefined; });
      }

      function stop(): Promise<void> {
        if (stopping) return stopping;
        stopped = true;
        clearInterval(timer);
        finalFrames = Math.max(1, Math.ceil((now() - startedAt) * fps / 1000));
        return stopping = (async () => {
          try {
            if (child && !failure) await pump();
          } catch (error) {
            failure ??= error instanceof Error ? error : new Error(String(error));
          }
          await cleanup();
          if (child) {
            if (failure) {
              if (!exited) child.kill();
              recorder.destroy(failure);
            } else {
              child.stdin!.end();
            }
            await exit;
          }
          if (failure) throw failure;
        })();
      }

      try {
        await startupStep(session.send("Page.enable"), signal);
        // Screencast events alone are not guaranteed on a static page or an immediate stop.
        const initial = await startupStep(session.send("Page.captureScreenshot", { format: "jpeg", quality: 90, captureBeyondViewport: false }), signal);
        latest = Buffer.from(initial.data, "base64");
        capturing = true;
        await startupStep(session.send("Page.startScreencast", { format: "jpeg", quality: 90 }), signal);
        if (failure) throw failure;
        const encoder = (dependencies.spawn ?? spawn)(options.ffmpegPath ?? "ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-vcodec", "mjpeg",
          "-framerate", String(fps), "-i", "pipe:0", "-an", "-c:v", "libvpx",
          "-deadline", "realtime", "-cpu-used", "8", "-threads", "1", "-b:v", "1M",
          "-vf", `scale=${width}:${height}`,
          "-aspect", `${width}:${height}`, "-pix_fmt", "yuv420p", "-f", "webm", "pipe:1",
        ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        child = encoder;
        const onStderr = (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); };
        const onError = (error: Error) => { exited = true; resolveExit(); fail(error); pendingWrite?.(error); };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          exited = true;
          if (code !== 0 || !stopped) fail(new Error(`FFmpeg exited ${signal ? `with signal ${signal}` : `with code ${code}`}${stderr ? `: ${stderr.trim()}` : "."}`));
          pendingWrite?.(failure ?? new Error("FFmpeg exited while writing a frame."));
          resolveExit();
        };
        encoder.stderr!.on("data", onStderr);
        encoder.on("error", onError);
        encoder.once("exit", onExit);
        encoder.stdin!.on("error", fail);
        encoder.stdout!.on("error", fail);
        encoder.stdout!.pipe(recorder);
        encoder.once("close", () => {
          encoder.stderr!.off("data", onStderr);
          encoder.off("error", onError);
          encoder.off("exit", onExit);
          encoder.stdin!.off("error", fail);
          encoder.stdout!.off("error", fail);
        });
        await startupStep(new Promise<void>((resolve, reject) => {
          const spawned = () => { encoder.off("error", rejected); resolve(); };
          const rejected = (error: Error) => { encoder.off("spawn", spawned); reject(error); };
          encoder.once("spawn", spawned);
          encoder.once("error", rejected);
        }), signal);
        if (failure) throw failure;
        startedAt = now();
        await pump();
        if (failure) throw failure;
        timer = setInterval(() => { void pump().catch(fail); }, 1000 / fps);
        signal?.removeEventListener("abort", onAbort);
        startupComplete = true;
        return recorder;
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        recorder.destroy(failure);
        await stop().catch((reason: Error) => { failure ??= reason; });
        throw failure;
      }
    },
  };
}
