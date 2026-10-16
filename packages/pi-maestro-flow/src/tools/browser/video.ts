import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { ScreencastOptions } from "puppeteer-core";

export interface BrowserVideoOptions {
  filename?: string;
  size?: { width: number; height: number };
  fps?: number;
  scale?: number;
  ffmpegPath?: string;
  signal?: AbortSignal;
}

export interface BrowserVideoInfo {
  path: string;
  mimeType: "video/webm";
  recording: boolean;
  bytes?: number;
  size?: { width: number; height: number };
  videos?: BrowserVideoInfo[];
}

interface VideoRecorder extends Readable {
  size?: { width: number; height: number };
  stop(): Promise<void>;
}

export type BrowserScreencastOptions = ScreencastOptions & { size?: { width: number; height: number }; signal?: AbortSignal };

export interface BrowserVideoPage {
  screencast(options: Readonly<BrowserScreencastOptions>): Promise<VideoRecorder>;
}

/** A persistent artifact, not a temporary screenshot owned by the tab. */
export class BrowserVideoRecording {
  readonly info: BrowserVideoInfo;
  private completion: Promise<void>;
  private failure?: Error;
  private stopping?: Promise<BrowserVideoInfo>;

  private constructor(private readonly recorder: VideoRecorder, file: fs.FileHandle, filename: string) {
    this.info = { path: filename, mimeType: "video/webm", recording: true, ...(recorder.size ? { size: { ...recorder.size } } : {}) };
    this.completion = pipeline(recorder, file.createWriteStream()).catch((error: Error) => {
      this.failure = error;
      // A full/unwritable destination must not leave FFmpeg capturing forever.
      void this.stop().catch((failure) => console.warn(`[browser] Video recording failed: ${failure.message}`));
    });
  }

  static async start(page: BrowserVideoPage, cwd: string, options: BrowserVideoOptions = {}): Promise<BrowserVideoRecording> {
    if (options.filename !== undefined && (typeof options.filename !== "string" || !options.filename.trim())) {
      throw new Error("Browser video filename must be a non-empty .webm path.");
    }
    if (options.fps !== undefined && (!Number.isInteger(options.fps) || options.fps < 1 || options.fps > 60)) {
      throw new Error("Browser video fps must be an integer between 1 and 60.");
    }
    if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > 4)) {
      throw new Error("Browser video scale must be greater than 0 and at most 4.");
    }
    if (options.size && (![options.size.width, options.size.height].every((value) => Number.isInteger(value) && value >= 2))) {
      throw new Error("Browser video size must contain integer width and height of at least 2 pixels.");
    }
    if (options.size && options.scale !== undefined) throw new Error("Browser video size and scale cannot be combined.");
    const filename = path.resolve(cwd, options.filename ?? `video-${Date.now()}-${randomUUID()}.webm`);
    if (path.extname(filename).toLowerCase() !== ".webm") throw new Error("Browser video filename must end in .webm.");
    if (options.ffmpegPath !== undefined && !options.ffmpegPath.trim()) throw new Error("Browser video ffmpeg_path must not be empty.");
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const file = await fs.open(filename, "wx", 0o600);
    try {
      const recorder = await page.screencast({
        format: "webm", fps: options.fps, scale: options.scale,
        ...(options.size ? { size: options.size } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ffmpegPath: options.ffmpegPath?.includes("/") || options.ffmpegPath?.includes("\\")
          ? path.resolve(cwd, options.ffmpegPath) : options.ffmpegPath,
      });
      return new BrowserVideoRecording(recorder, file, filename);
    } catch (error) {
      await file.close();
      await fs.rm(filename, { force: true });
      if (error instanceof Error && error.name === "AbortError") throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Browser video could not start: ${reason}. Recording requires FFmpeg on PATH, or set ffmpeg_path to its executable.`, { cause: error });
    }
  }

  stop(): Promise<BrowserVideoInfo> {
    return this.stopping ??= this.finish();
  }

  private async finish(): Promise<BrowserVideoInfo> {
    // stop() ends the encoder; pipeline completion also waits for the file flush.
    const stoppedRecorder = this.recorder.stop().catch((error: unknown) => {
      this.recorder.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    const outcomes = await Promise.allSettled([stoppedRecorder, this.completion]);
    this.info.recording = false;
    const stopped = outcomes[0];
    if (stopped.status === "rejected") throw stopped.reason;
    if (this.failure) throw this.failure;
    const stat = await fs.stat(this.info.path);
    if (stat.size === 0) throw new Error(`Browser video is empty: ${this.info.path}. Check FFmpeg WebM/VP8 encoding support and ensure the page rendered during recording.`);
    this.info.bytes = stat.size;
    return { ...this.info };
  }
}
