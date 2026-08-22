import { createRequire } from "node:module";
import type { ModelAssetOptions, ModelAssetResolution } from "./model-assets.ts";
import { resolveModelAsset } from "./model-assets.ts";
import { makeOcrResult, normalizeOcrLines, postprocessDetectorScores, enhanceImage, imageToNchw, mapOcrLines } from "./ocr.ts";
import type { EnhanceOptions, RapidOcrLineLike, OcrLine } from "./ocr.ts";
import type { DetectionResult, DetectionUnavailable, DetectorBox } from "./detect.ts";
import { matchCropDetections, matchDetections, unavailableDetection } from "./detect.ts";
import { DEFAULT_IMAGE_LIMITS, normalizeImage } from "./types.ts";
import type { ImageLimits, VisionImage, VisionImageInput } from "./types.ts";

export interface VisionUnavailable { ok: false; code: string; diagnostic: string; engine: string; }
export interface OcrOptions { enhance?: boolean | EnhanceOptions; signal?: AbortSignal; }
export interface DetectOptions { mode?: "match" | "crop"; confidence?: number; iouThreshold?: number; signal?: AbortSignal; }
export interface OrtTensorLike { data: ArrayLike<number>; dims?: readonly number[]; }
export interface VisionRuntimeAdapter { infer(kind: "det" | "cls" | "rec", image: VisionImage, signal?: AbortSignal): Promise<unknown>; shutdown?(): Promise<void> | void; }
export interface OnnxVisionServiceOptions {
  limits?: ImageLimits;
  model?: ModelAssetOptions;
  runtime?: VisionRuntimeAdapter;
  allowInjectedDetector?: boolean;
}

interface OrtSessionLike { inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>; release?(): Promise<void> | void; }

export class VisionServiceClosedError extends Error { constructor() { super("vision service is shut down"); this.name = "VisionServiceClosedError"; } }
export class VisionAbortError extends Error { constructor() { super("vision operation aborted"); this.name = "AbortError"; } }

export class OnnxVisionService {
  private readonly limits: ImageLimits;
  private readonly modelOptions: ModelAssetOptions;
  private readonly runtime?: VisionRuntimeAdapter;
  private readonly sessions = new Map<string, OrtSessionLike>();
  private readonly lifecycle = new AbortController();
  private closed = false;

  constructor(options: OnnxVisionServiceOptions = {}) {
    this.limits = { ...DEFAULT_IMAGE_LIMITS, ...options.limits };
    this.modelOptions = options.model ?? {};
    this.runtime = options.runtime;
  }

  async ocr(input: VisionImageInput, options: OcrOptions = {}): Promise<ReturnType<typeof makeOcrResult> | VisionUnavailable> {
    const image = normalizeImage(input, this.limits); const signal = this.operationSignal(options.signal); this.assertUsable(signal);
    const prepared = options.enhance ? enhanceImage(image, typeof options.enhance === "object" ? options.enhance : {}) : image;
    if (this.runtime) {
      const lines = await this.runInjectedOcr(prepared, signal);
      this.assertUsable(signal);
      return makeOcrResult(mapOcrLines(lines, prepared.metadata, image.metadata), image.metadata.width, image.metadata.height);
    }
    const det = this.resolve("rapidocr.det.ch_ppocr_v3");
    const cls = this.resolve("rapidocr.cls.ch_ppocr_mobile_v2");
    const rec = this.resolve("rapidocr.rec.ch_ppocr_v3");
    if (!det.available || !cls.available || !rec.available) return { ok: false, code: "MODEL_UNAVAILABLE", diagnostic: [det, cls, rec].find((entry) => !entry.available)?.diagnostic ?? "MODEL_FILE_MISSING", engine: "rapidocr" };
    try {
      const detector = await this.inferOnnx("rapidocr.det.ch_ppocr_v3", det, prepared, signal);
      const boxes = extractDetectorBoxes(detector, prepared.metadata.width, prepared.metadata.height);
      return makeOcrResult(boxes.map((box) => ({ bbox: box.bbox, text: "", confidence: 0 })), image.metadata.width, image.metadata.height);
    } catch (error) {
      return { ok: false, code: "MODEL_INFERENCE_FAILED", diagnostic: error instanceof Error ? error.message : String(error), engine: "rapidocr" };
    }
  }

  async detect(input: VisionImageInput, options: DetectOptions = {}): Promise<DetectionResult | DetectionUnavailable> {
    const image = normalizeImage(input, this.limits); const signal = this.operationSignal(options.signal); this.assertUsable(signal);
    const mode = options.mode ?? "match";
    const artifact = this.resolve("omniparser.v2.icon_detect");
    if (!artifact.available) return unavailableDetection(image.metadata.width, image.metadata.height, artifact.diagnostic, mode);
    if (!this.runtime) return { ...unavailableDetection(image.metadata.width, image.metadata.height, "MODEL_RUNTIME_UNAVAILABLE", mode), code: "MODEL_UNAVAILABLE" };
    try {
      const boxes = normalizeDetectorBoxes(await abortable(this.runtime.infer("det", image, signal), signal)).filter((box) => box.confidence >= (options.confidence ?? 0.25));
      const lines = await this.runInjectedOcr(image, signal);
      const items = mode === "crop"
        ? matchCropDetections(image, boxes, (_crop, _source, index) => [lines[index]].filter(Boolean), options.iouThreshold)
        : matchDetections(boxes, lines, options.iouThreshold);
      return { ok: true, items, mode, width: image.metadata.width, height: image.metadata.height, engine: "omniparser" };
    } catch (error) {
      return { ...unavailableDetection(image.metadata.width, image.metadata.height, error instanceof Error ? error.message : String(error), mode), code: "MODEL_UNAVAILABLE" };
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort();
    const sessions = [...this.sessions.values()]; this.sessions.clear();
    for (const session of sessions) { try { await session.release?.(); } catch { /* release is best effort */ } }
    await this.runtime?.shutdown?.();
  }

  private async runInjectedOcr(image: VisionImage, signal?: AbortSignal): Promise<OcrLine[]> {
    this.assertUsable(signal);
    const raw = await abortable(this.runtime!.infer("rec", image, signal), signal);
    this.assertUsable(signal);
    if (!Array.isArray(raw)) return [];
    return normalizeOcrLines(raw as RapidOcrLineLike[], image.metadata.width, image.metadata.height);
  }

  private resolve(id: string): ModelAssetResolution { return resolveModelAsset(id, this.modelOptions); }
  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
  }
  private assertUsable(signal?: AbortSignal): void { if (this.closed) throw new VisionServiceClosedError(); if (signal?.aborted) throw new VisionAbortError(); }

  private async inferOnnx(id: string, asset: ModelAssetResolution, image: VisionImage, signal?: AbortSignal): Promise<OrtTensorLike> {
    this.assertUsable(signal);
    const session = await this.getSession(id, asset, signal);
    const input = imageToNchw(image);
    const ort = loadOrt();
    const tensor = new ort.Tensor("float32", input.data, input.dims);
    const outputs = await abortable(session.run({ [session.inputNames[0] ?? "x"]: tensor }), signal);
    const first = outputs[session.outputNames[0] ?? Object.keys(outputs)[0]];
    if (!first) throw new Error("ONNX model returned no outputs");
    return first;
  }

  private async getSession(id: string, asset: ModelAssetResolution, signal?: AbortSignal): Promise<OrtSessionLike> {
    const existing = this.sessions.get(id); if (existing) return existing;
    this.assertUsable(signal);
    const ort = loadOrt();
    const session = await abortable(ort.InferenceSession.create(asset.path!), signal) as OrtSessionLike;
    this.assertUsable(signal); this.sessions.set(id, session); return session;
  }
}

function loadOrt(): { InferenceSession: { create(path: string): Promise<OrtSessionLike> }; Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown } {
  const require = createRequire(import.meta.url);
  let module: unknown;
  try { module = require("onnxruntime-node"); } catch (error) { throw new Error(`onnxruntime-node unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  return module as ReturnType<typeof loadOrt>;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new VisionAbortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new VisionAbortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

function extractDetectorBoxes(output: OrtTensorLike, width: number, height: number): DetectorBox[] {
  const dims = output.dims ?? [];
  const scoreWidth = Number(dims.at(-1) ?? 0); const scoreHeight = Number(dims.at(-2) ?? 0);
  return scoreWidth && scoreHeight ? postprocessDetectorScores(output.data, scoreWidth, scoreHeight, width, height).map((bbox) => ({ bbox, confidence: 1 })) : [];
}

function normalizeDetectorBoxes(value: unknown): DetectorBox[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { bbox?: unknown; confidence?: unknown };
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4) return [];
    return [{ bbox: item.bbox.map(Number) as [number, number, number, number], confidence: Number(item.confidence) || 0 }];
  });
}

export const VisionWorker = OnnxVisionService;

export function createVisionService(options: OnnxVisionServiceOptions = {}): OnnxVisionService { return new OnnxVisionService(options); }
