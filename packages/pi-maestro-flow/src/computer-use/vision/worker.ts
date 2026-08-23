import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { ModelAssetOptions, ModelAssetResolution } from "./model-assets.ts";
import { resolveModelAsset } from "./model-assets.ts";
import { decodePng } from "./image.ts";
import { makeOcrResult, normalizeOcrLines, postprocessDetectorScores, enhanceImage, imageToNchw, mapOcrLines, decodeCtcGreedy } from "./ocr.ts";
import type { EnhanceOptions, RapidOcrLineLike, OcrLine } from "./ocr.ts";
import type { DetectionResult, DetectionUnavailable, DetectorBox } from "./detect.ts";
import { matchCropDetections, matchDetections, unavailableDetection } from "./detect.ts";
import { DEFAULT_IMAGE_LIMITS, assertImageWithinBounds, clampBox, cropImage, normalizeImage } from "./types.ts";
import type { ImageLimits, VisionImage, VisionImageInput } from "./types.ts";

export interface VisionUnavailable { ok: false; code: string; diagnostic: string; engine: string; }
export interface OcrOptions { enhance?: boolean | EnhanceOptions; langs?: readonly string[]; signal?: AbortSignal; }
export interface DetectOptions { mode?: "match" | "crop"; confidence?: number; iouThreshold?: number; langs?: readonly string[]; signal?: AbortSignal; }
export interface OrtTensorLike { data: ArrayLike<number>; dims?: readonly number[]; }
export interface VisionRuntimeAdapter { infer(kind: "det" | "cls" | "rec", image: VisionImage, signal?: AbortSignal): Promise<unknown>; shutdown?(): Promise<void> | void; }
export interface OnnxVisionServiceOptions {
  limits?: ImageLimits;
  model?: ModelAssetOptions;
  runtime?: VisionRuntimeAdapter;
  allowInjectedDetector?: boolean;
}

interface OrtSessionLike {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  metadata?: { customMetadataMap?: Record<string, string> };
  release?(): Promise<void> | void;
}

const DET_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406];
const DET_STD: readonly [number, number, number] = [0.229, 0.224, 0.225];
const DET_LIMIT_SIDE = 736;
const ICON_INPUT_SIZE = 640;
const ICON_CONF_THRESHOLD = 0.25;
const ICON_IOU_THRESHOLD = 0.45;
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 320;
const CLS_WIDTH = 192;
const CLS_THRESHOLD = 0.9;

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
    const image = this.toRawImage(input);
    const signal = this.operationSignal(options.signal);
    this.assertUsable(signal);
    const prepared = options.enhance ? enhanceImage(image, typeof options.enhance === "object" ? options.enhance : {}) : image;
    if (this.runtime) {
      const lines = await this.runInjectedOcr(prepared, signal);
      this.assertUsable(signal);
      return makeOcrResult(mapOcrLines(lines, prepared.metadata, image.metadata), image.metadata.width, image.metadata.height);
    }
    const det = this.resolve("rapidocr.det.ch_ppocr_v3");
    const cls = this.resolve("rapidocr.cls.ch_ppocr_mobile_v2");
    const rec = this.resolve("rapidocr.rec.ch_ppocr_v3");
    if (!det.available || !cls.available || !rec.available) {
      return { ok: false, code: "MODEL_UNAVAILABLE", diagnostic: [det, cls, rec].find((entry) => !entry.available)?.diagnostic ?? "MODEL_FILE_MISSING", engine: "rapidocr" };
    }
    try {
      const detectorImage = resizeForDetector(prepared, DET_LIMIT_SIDE);
      const detector = await this.inferOnnx("rapidocr.det.ch_ppocr_v3", det, detectorImage, signal, { mean: DET_MEAN, std: DET_STD });
      const boxes = extractDetectorBoxes(detector, detectorImage.metadata.width, detectorImage.metadata.height);
      const lines = await this.recognizeBoxes(detectorImage, boxes, cls, rec, signal);
      return makeOcrResult(mapOcrLines(lines, detectorImage.metadata, image.metadata), image.metadata.width, image.metadata.height);
    } catch (error) {
      return { ok: false, code: error instanceof VisionAbortError ? "ABORTED" : "MODEL_INFERENCE_FAILED", diagnostic: error instanceof Error ? error.message : String(error), engine: "rapidocr" };
    }
  }

  async detect(input: VisionImageInput, options: DetectOptions = {}): Promise<DetectionResult | DetectionUnavailable> {
    const image = this.toRawImage(input);
    const signal = this.operationSignal(options.signal);
    this.assertUsable(signal);
    const mode = options.mode ?? "match";
    const artifact = this.resolve("omniparser.v2.icon_detect");
    if (!artifact.available) return unavailableDetection(image.metadata.width, image.metadata.height, artifact.diagnostic, mode);
    try {
      const boxes = this.runtime
        ? normalizeDetectorBoxes(await abortable(this.runtime.infer("det", image, signal), signal))
        : await this.inferIconDetect(image, artifact, signal, options.confidence ?? ICON_CONF_THRESHOLD, options.iouThreshold ?? ICON_IOU_THRESHOLD);
      const filtered = boxes.filter((box) => box.confidence >= (options.confidence ?? ICON_CONF_THRESHOLD));
      // OCR lines for label matching: injected runtime when present, else the
      // built-in RapidOCR path (same as ocr()).
      const lines = this.runtime
        ? await this.runInjectedOcr(image, signal)
        : await this.builtinOcrLines(image, signal);
      const items = mode === "crop"
        ? matchCropDetections(image, filtered, (_crop, _source, index) => [lines[index]].filter(Boolean), options.iouThreshold)
        : matchDetections(filtered, lines, options.iouThreshold);
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
    for (const session of sessions) { try { await session.release?.(); } catch { /* best effort */ } }
    await this.runtime?.shutdown?.();
  }

  private toRawImage(input: VisionImageInput): VisionImage {
    const normalized = normalizeImage(input, this.limits);
    if (normalized.metadata.sourceFormat === "png") {
      const decoded = decodePng(normalized.data, normalized.metadata);
      assertImageWithinBounds(decoded, this.limits);
      return decoded;
    }
    if (normalized.metadata.sourceFormat === "raw") return normalized;
    throw new Error("Unsupported image format; provide raw pixels or a PNG buffer");
  }

  private async runInjectedOcr(image: VisionImage, signal?: AbortSignal): Promise<OcrLine[]> {
    this.assertUsable(signal);
    const raw = await abortable(this.runtime!.infer("rec", image, signal), signal);
    this.assertUsable(signal);
    if (!Array.isArray(raw)) return [];
    return normalizeOcrLines(raw as RapidOcrLineLike[], image.metadata.width, image.metadata.height);
  }

  private async recognizeBoxes(image: VisionImage, boxes: readonly DetectorBox[], clsAsset: ModelAssetResolution, recAsset: ModelAssetResolution, signal: AbortSignal): Promise<OcrLine[]> {
    const recSession = await this.getSession("rapidocr.rec.ch_ppocr_v3", recAsset, signal);
    const clsSession = await this.getSession("rapidocr.cls.ch_ppocr_mobile_v2", clsAsset, signal);
    const dictionary = characterDictionary(recSession, recAsset.path);
    if (dictionary.length === 0) throw new Error("RapidOCR recognizer metadata does not contain a character dictionary");
    const lines: OcrLine[] = [];
    for (const box of boxes) {
      this.assertUsable(signal);
      let crop = cropImage(image, clampBox(box.bbox, image.metadata.width, image.metadata.height));
      const clsImage = resizeRaw(crop, CLS_WIDTH, REC_HEIGHT);
      const cls = await this.runSession(clsSession, clsImage, signal);
      if (isUpsideDown(cls)) crop = rotate180(crop);
      const ratio = crop.metadata.width / Math.max(1, crop.metadata.height);
      const recWidth = Math.max(16, Math.min(REC_MAX_WIDTH, Math.ceil(REC_HEIGHT * ratio)));
      const recImage = resizeRaw(crop, recWidth, REC_HEIGHT);
      const output = await this.runSession(recSession, recImage, signal);
      const dims = output.dims ?? [];
      const timesteps = Number(dims.at(-2) ?? 0);
      const classes = Number(dims.at(-1) ?? 0);
      const decoded = decodeCtcGreedy(output.data, timesteps, classes, dictionary);
      if (decoded.text.trim()) lines.push({ bbox: box.bbox, text: decoded.text.trim(), confidence: decoded.confidence });
    }
    return lines;
  }

  private resolve(id: string): ModelAssetResolution { return resolveModelAsset(id, this.modelOptions); }
  private operationSignal(signal?: AbortSignal): AbortSignal { return signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal; }
  private assertUsable(signal?: AbortSignal): void { if (this.closed) throw new VisionServiceClosedError(); if (signal?.aborted) throw new VisionAbortError(); }

  private async inferOnnx(id: string, asset: ModelAssetResolution, image: VisionImage, signal?: AbortSignal, normalization?: { mean?: readonly [number, number, number]; std?: readonly [number, number, number] }): Promise<OrtTensorLike> {
    const session = await this.getSession(id, asset, signal);
    return this.runSession(session, image, signal, normalization);
  }

  // OmniParser-v2 icon_detect ONNX fallback (runtime not injected). Returns
  // DetectorBox[] in original image coordinates after letterbox + greedy NMS.
  private async inferIconDetect(image: VisionImage, asset: ModelAssetResolution, signal: AbortSignal, confThreshold: number, iouThreshold: number): Promise<DetectorBox[]> {
    const session = await this.getSession("omniparser.v2.icon_detect", asset, signal);
    this.assertUsable(signal);
    const { data: blob, scale, padX, padY } = letterbox(image, ICON_INPUT_SIZE);
    const ort = loadOrt();
    const tensor = new ort.Tensor("float32", blob, [1, 3, ICON_INPUT_SIZE, ICON_INPUT_SIZE]);
    const outputs = await abortable(session.run({ [session.inputNames[0] ?? "images"]: tensor }), signal);
    const first = outputs[session.outputNames[0] ?? Object.keys(outputs)[0]];
    if (!first) throw new Error("icon_detect ONNX returned no outputs");
    return decodeIconDetect(first, image.metadata.width, image.metadata.height, scale, padX, padY, confThreshold, iouThreshold);
  }

  // Built-in RapidOCR lines in original image coordinates (no injected runtime).
  // Reuses the same detector+recognizer path as ocr(), returning OcrLine[] for
  // match/crop label resolution in detect().
  private async builtinOcrLines(image: VisionImage, signal: AbortSignal): Promise<OcrLine[]> {
    const det = this.resolve("rapidocr.det.ch_ppocr_v3");
    const cls = this.resolve("rapidocr.cls.ch_ppocr_mobile_v2");
    const rec = this.resolve("rapidocr.rec.ch_ppocr_v3");
    if (!det.available || !cls.available || !rec.available) return [];
    const detectorImage = resizeForDetector(image, DET_LIMIT_SIDE);
    const detector = await this.inferOnnx("rapidocr.det.ch_ppocr_v3", det, detectorImage, signal, { mean: DET_MEAN, std: DET_STD });
    const boxes = extractDetectorBoxes(detector, detectorImage.metadata.width, detectorImage.metadata.height);
    const lines = await this.recognizeBoxes(detectorImage, boxes, cls, rec, signal);
    return mapOcrLines(lines, detectorImage.metadata, image.metadata);
  }

  private async runSession(session: OrtSessionLike, image: VisionImage, signal?: AbortSignal, normalization?: { mean?: readonly [number, number, number]; std?: readonly [number, number, number] }): Promise<OrtTensorLike> {
    this.assertUsable(signal);
    const input = imageToNchw(image, normalization);
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
  try { return require("onnxruntime-node") as ReturnType<typeof loadOrt>; }
  catch (error) { throw new Error(`onnxruntime-node unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}

function resizeForDetector(image: VisionImage, limit: number): VisionImage {
  const minSide = Math.min(image.metadata.width, image.metadata.height);
  const ratio = minSide < limit ? limit / minSide : 1;
  const width = Math.max(32, Math.round((image.metadata.width * ratio) / 32) * 32);
  const height = Math.max(32, Math.round((image.metadata.height * ratio) / 32) * 32);
  return resizeRaw(image, width, height);
}

function resizeRaw(image: VisionImage, width: number, height: number): VisionImage {
  if (image.metadata.sourceFormat !== "raw") throw new Error("resizeRaw requires decoded raw pixels");
  const channels = image.metadata.channels;
  const output = Buffer.allocUnsafe(width * height * channels);
  const sourceWidth = image.metadata.width; const sourceHeight = image.metadata.height;
  for (let y = 0; y < height; y++) {
    const sourceY = (y + 0.5) * sourceHeight / height - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY)); const y1 = Math.min(sourceHeight - 1, y0 + 1); const fy = Math.max(0, Math.min(1, sourceY - y0));
    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5) * sourceWidth / width - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX)); const x1 = Math.min(sourceWidth - 1, x0 + 1); const fx = Math.max(0, Math.min(1, sourceX - x0));
      const target = (y * width + x) * channels;
      const a = (y0 * sourceWidth + x0) * channels; const b = (y0 * sourceWidth + x1) * channels; const c = (y1 * sourceWidth + x0) * channels; const d = (y1 * sourceWidth + x1) * channels;
      for (let channel = 0; channel < channels; channel++) {
        const top = image.data[a + channel]! * (1 - fx) + image.data[b + channel]! * fx;
        const bottom = image.data[c + channel]! * (1 - fx) + image.data[d + channel]! * fx;
        output[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return normalizeImage({ data: output, metadata: { ...image.metadata, width, height, sourceFormat: "raw" } });
}

function rotate180(image: VisionImage): VisionImage {
  const channels = image.metadata.channels;
  const output = Buffer.allocUnsafe(image.data.length);
  for (let y = 0; y < image.metadata.height; y++) for (let x = 0; x < image.metadata.width; x++) {
    const source = (y * image.metadata.width + x) * channels;
    const target = ((image.metadata.height - y - 1) * image.metadata.width + image.metadata.width - x - 1) * channels;
    image.data.copy(output, target, source, source + channels);
  }
  return normalizeImage({ data: output, metadata: { ...image.metadata, sourceFormat: "raw" } });
}

function characterDictionary(session: OrtSessionLike, modelPath?: string): string[] {
  const metadataValue = session.metadata?.customMetadataMap?.character ?? (modelPath ? readOnnxMetadataString(modelPath, "character") : undefined);
  return typeof metadataValue === "string" ? [...metadataValue.split(/\r?\n/).filter(Boolean), " "] : [];
}

// onnxruntime-node does not expose ModelProto metadata on all versions. Read
// only the protobuf metadata_props field (field 14) as a small fallback; this
// avoids shipping a second protobuf dependency and never interprets tensors.
function readOnnxMetadataString(modelPath: string, wantedKey: string): string | undefined {
  try {
    const bytes = readFileSync(modelPath);
    let offset = 0;
    while (offset < bytes.length) {
      const tag = readProtoVarint(bytes, offset); offset = tag.offset;
      const field = Math.floor(tag.value / 8); const wire = tag.value & 7;
      if (field === 14 && wire === 2) {
        const length = readProtoVarint(bytes, offset); offset = length.offset;
        const end = offset + length.value;
        if (end > bytes.length) return undefined;
        const entry = readStringEntry(bytes.subarray(offset, end));
        if (entry?.key === wantedKey) return entry.value;
        offset = end;
      } else offset = skipProtoField(bytes, offset, wire);
    }
  } catch { return undefined; }
  return undefined;
}

function readStringEntry(bytes: Uint8Array): { key: string; value: string } | undefined {
  let offset = 0; let key = ""; let value = "";
  while (offset < bytes.length) {
    const tag = readProtoVarint(bytes, offset); offset = tag.offset;
    const field = Math.floor(tag.value / 8); const wire = tag.value & 7;
    if (wire !== 2) { offset = skipProtoField(bytes, offset, wire); continue; }
    const length = readProtoVarint(bytes, offset); offset = length.offset;
    const end = offset + length.value; if (end > bytes.length) return undefined;
    if (field === 1) key = Buffer.from(bytes.subarray(offset, end)).toString("utf8");
    if (field === 2) value = Buffer.from(bytes.subarray(offset, end)).toString("utf8");
    offset = end;
  }
  return key ? { key, value } : undefined;
}

function readProtoVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0; let shift = 0;
  while (offset < bytes.length && shift < 53) {
    const byte = bytes[offset++]!; value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  return { value: Number.NaN, offset };
}

function skipProtoField(bytes: Uint8Array, offset: number, wire: number): number {
  if (wire === 0) return readProtoVarint(bytes, offset).offset;
  if (wire === 1) return offset + 8;
  if (wire === 2) { const length = readProtoVarint(bytes, offset); return length.offset + length.value; }
  if (wire === 5) return offset + 4;
  return bytes.length;
}

function isUpsideDown(output: OrtTensorLike): boolean {
  const values = [...Array.from(output.data as ArrayLike<number>)];
  if (values.length < 2) return false;
  const first = Number(values[0]); const second = Number(values[1]);
  const sum = first + second;
  return sum > 0 && second / sum > CLS_THRESHOLD;
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
  return scoreWidth && scoreHeight
    ? postprocessDetectorScores(output.data, scoreWidth, scoreHeight, width, height).map((bbox) => ({ bbox: expandDetectionBox(bbox, width, height), confidence: 1 }))
    : [];
}

// RapidOCR's DBPostProcess performs polygon unclip before returning boxes. The
// compact JS postprocessor is rectangle-based, so apply the equivalent bounded
// padding here to keep ascenders/edge characters from being cropped.
function expandDetectionBox(box: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const padX = (box[2] - box[0]) * 0.12;
  const padY = (box[3] - box[1]) * 0.12;
  return [Math.max(0, box[0] - padX), Math.max(0, box[1] - padY), Math.min(width, box[2] + padX), Math.min(height, box[3] + padY)];
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

// OmniParser-v2 icon_detect: YOLO11m exported to ONNX without NMS.
// Output shape [1, 5, 8400] transposed to [8400, 5] = [cx, cy, w, h, conf]
// in the letterboxed 640x640 space. We letterbox-prescale, run greedy NMS, then
// map back to original image coordinates.
function letterbox(image: VisionImage, target: number): { data: Float32Array; scale: number; padX: number; padY: number } {
  const { width, height, channels } = image.metadata;
  const scale = Math.min(target / width, target / height);
  const newW = Math.round(width * scale); const newH = Math.round(height * scale);
  const padX = Math.floor((target - newW) / 2); const padY = Math.floor((target - newH) / 2);
  const data = new Float32Array(3 * target * target); // zero-padded (114/255 gray)
  const pad = 114 / 255;
  for (let c = 0; c < 3; c++) for (let i = 0; i < target * target; i++) data[c * target * target + i] = pad;
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(newH - 1, Math.floor(y / scale));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(newW - 1, Math.floor(x / scale));
      const src = (sy * width + sx) * channels;
      const fx = (x + padX) * scale; const fy = (y + padY) * scale;
      // nearest-neighbor from original; bilinear adds cost without accuracy gain for detect
      const ox = Math.min(width - 1, Math.floor(x / scale)); const oy = Math.min(height - 1, Math.floor(y / scale));
      const s = (oy * width + ox) * channels;
      for (let c = 0; c < 3; c++) data[c * target * target + (y + padY) * target + (x + padX)] = image.data[s + c]! / 255;
    }
  }
  return { data, scale, padX, padY };
}

function nonMaxSuppression(boxes: Array<{ xyxy: [number, number, number, number]; conf: number; area: number }>, iouThreshold: number): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].conf - boxes[a].conf);
  const suppressed = new Set<number>();
  for (const idx of order) {
    if (suppressed.has(idx)) continue;
    for (const jdx of order) {
      if (jdx === idx || suppressed.has(jdx)) continue;
      const iou = iouOf(boxes[idx].xyxy, boxes[jdx].xyxy);
      if (iou > iouThreshold) suppressed.add(jdx);
    }
  }
  return order.filter((i) => !suppressed.has(i));
}

function iouOf(a: readonly [number, number, number, number], b: readonly [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]); const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]); const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

// YOLO11 ONNX detect output [1, 5, 8400] (single class, no NMS): each column
// is [cx, cy, w, h, conf] in the letterboxed ICON_INPUT_SIZE space. We filter by
// confidence, convert to xyxy, run greedy NMS, then un-letterbox to the original
// image coordinates.
function decodeIconDetect(output: OrtTensorLike, imageWidth: number, imageHeight: number, scale: number, padX: number, padY: number, confThreshold: number, iouThreshold: number): DetectorBox[] {
  const dims = output.dims ?? [];
  const classes = Number(dims.at(-2) ?? 0); const count = Number(dims.at(-1) ?? 0);
  if (classes !== 5 || !count) return [];
  const values = output.data as ArrayLike<number>;
  const candidates: Array<{ xyxy: [number, number, number, number]; conf: number }> = [];
  for (let i = 0; i < count; i++) {
    const cx = values[i]!; const cy = values[count + i]!; const w = values[2 * count + i]!; const h = values[3 * count + i]!; const conf = values[4 * count + i]!;
    if (conf < confThreshold) continue;
    const x1 = (cx - w / 2 - padX) / scale; const y1 = (cy - h / 2 - padY) / scale;
    const x2 = (cx + w / 2 - padX) / scale; const y2 = (cy + h / 2 - padY) / scale;
    candidates.push({ xyxy: [x1, y1, x2, y2], conf });
  }
  const withArea = candidates.map((c) => ({ ...c, area: Math.max(0, c.xyxy[2] - c.xyxy[0]) * Math.max(0, c.xyxy[3] - c.xyxy[1]) }));
  return nonMaxSuppression(withArea, iouThreshold).map((i) => {
    const [x1, y1, x2, y2] = candidates[i].xyxy;
    return { bbox: [Math.max(0, x1), Math.max(0, y1), Math.min(imageWidth, x2), Math.min(imageHeight, y2)] as [number, number, number, number], confidence: candidates[i].conf };
  });
}

export const VisionWorker = OnnxVisionService;
export function createVisionService(options: OnnxVisionServiceOptions = {}): OnnxVisionService { return new OnnxVisionService(options); }
