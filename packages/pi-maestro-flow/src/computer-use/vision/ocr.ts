import type { BBox, ImageMetadata, VisionImage } from "./types.ts";
import { normalizeImage, mapBoundingBox } from "./types.ts";

export interface OcrLine { bbox: BBox; text: string; confidence: number; }
export interface OcrResult { text: string; lines: OcrLine[]; engine: "rapidocr"; width: number; height: number; }
export interface EnhanceOptions { scale?: number; contrast?: number; }
export interface RapidOcrLineLike { bbox: number[][] | BBox; text: string; confidence: number | string; }

export function normalizeConfidence(value: unknown, scale = 1): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  const normalized = scale === 100 || number > 1 ? number / 100 : number;
  return Math.max(0, Math.min(1, normalized));
}

export function normalizeOcrLines(lines: readonly RapidOcrLineLike[] | null | undefined, width: number, height: number): OcrLine[] {
  if (!lines) return [];
  return lines.flatMap((line) => {
    const points = Array.isArray(line.bbox[0]) ? line.bbox as number[][] : undefined;
    const raw = points
      ? [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1])), Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1]))] as BBox
      : line.bbox as BBox;
    const text = typeof line.text === "string" ? line.text.trim() : "";
    if (!text) return [];
    return [{ bbox: [Math.max(0, Math.min(width, raw[0])), Math.max(0, Math.min(height, raw[1])), Math.max(0, Math.min(width, raw[2])), Math.max(0, Math.min(height, raw[3]))], text, confidence: normalizeConfidence(line.confidence) }];
  });
}

export function stripCjkSpaces(value: string): string {
  return value.replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "");
}

export function mapOcrLines(lines: readonly OcrLine[], from: ImageMetadata, to: ImageMetadata): OcrLine[] {
  return lines.map((line) => ({ ...line, bbox: mapBoundingBox(line.bbox, from, to) }));
}

export function makeOcrResult(lines: readonly OcrLine[], width: number, height: number): OcrResult {
  const clean = lines.filter((line) => line.text.length > 0);
  return { text: stripCjkSpaces(clean.map((line) => line.text).join("\n")), lines: clean.map((line) => ({ ...line, text: stripCjkSpaces(line.text) })), engine: "rapidocr", width, height };
}


/** Convert a raw RGB/RGBA image to a normalized NCHW float tensor. */
export function imageToNchw(image: VisionImage, normalization: { mean?: readonly [number, number, number]; std?: readonly [number, number, number] } = {}): { data: Float32Array; dims: [1, 3, number, number] } {
  const { width, height, channels } = image.metadata;
  const mean = normalization.mean ?? [0.5, 0.5, 0.5];
  const std = normalization.std ?? [0.5, 0.5, 0.5];
  const data = new Float32Array(3 * width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * channels;
    for (let channel = 0; channel < 3; channel++) {
      const value = channels === 1 ? image.data[source]! : image.data[source + channel]!;
      data[channel * width * height + y * width + x] = (value / 255 - mean[channel]!) / std[channel]!;
    }
  }
  return { data, dims: [1, 3, height, width] };
}

/** Pure postprocessing for detector score maps. It intentionally emits no boxes for empty/invalid maps. */
export function postprocessDetectorScores(scores: ArrayLike<number>, scoreWidth: number, scoreHeight: number, imageWidth: number, imageHeight: number, threshold = 0.3): BBox[] {
  if (scoreWidth < 1 || scoreHeight < 1 || scores.length < scoreWidth * scoreHeight) return [];
  const seen = new Uint8Array(scoreWidth * scoreHeight);
  const boxes: BBox[] = [];
  for (let sy = 0; sy < scoreHeight; sy++) for (let sx = 0; sx < scoreWidth; sx++) {
    const index = sy * scoreWidth + sx;
    if (seen[index] || Number(scores[index]) < threshold) continue;
    const queue = [index]; seen[index] = 1; let minX = sx, maxX = sx, minY = sy, maxY = sy;
    while (queue.length) {
      const current = queue.pop()!; const x = current % scoreWidth; const y = Math.floor(current / scoreWidth);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || nx >= scoreWidth || ny < 0 || ny >= scoreHeight) continue;
        const ni = ny * scoreWidth + nx;
        if (!seen[ni] && Number(scores[ni]) >= threshold) { seen[ni] = 1; queue.push(ni); }
      }
    }
    const box: BBox = [minX * imageWidth / scoreWidth, minY * imageHeight / scoreHeight, (maxX + 1) * imageWidth / scoreWidth, (maxY + 1) * imageHeight / scoreHeight];
    if (box[2] - box[0] >= 2 && box[3] - box[1] >= 2) boxes.push(box);
  }
  return boxes;
}

export function normalizeClassifierResult(scores: ArrayLike<number>): { angle: 0 | 180; confidence: number } {
  if (!scores.length) return { angle: 0, confidence: 0 };
  let best = 0; let value = -Infinity;
  for (let index = 0; index < scores.length; index++) { const candidate = Number(scores[index]); if (candidate > value) { value = candidate; best = index; } }
  return { angle: best === 1 ? 180 : 0, confidence: normalizeConfidence(value) };
}
export function decodeCtcGreedy(logits: ArrayLike<number>, timesteps: number, classes: number, dictionary: readonly string[], blank = 0): { text: string; confidence: number } {
  if (timesteps < 1 || classes < 1 || logits.length < timesteps * classes) return { text: "", confidence: 0 };
  let previous = blank; let confidenceSum = 0; let count = 0; const chars: string[] = [];
  let bounded = true;
  for (let index = 0; index < Math.min(logits.length, timesteps * classes); index++) { const value = Number(logits[index]); if (value < 0 || value > 1) { bounded = false; break; } }
  for (let step = 0; step < timesteps; step++) {
    let best = 0; let value = -Infinity;
    for (let klass = 0; klass < classes; klass++) { const candidate = Number(logits[step * classes + klass]); if (candidate > value) { value = candidate; best = klass; } }
    const probability = bounded ? Math.max(0, Math.min(1, value)) : 1 / (1 + Math.exp(-Math.max(-60, Math.min(60, value))));
    if (best !== blank && best !== previous) { chars.push(dictionary[best - 1] ?? ""); confidenceSum += probability; count++; }
    previous = best;
  }
  return { text: chars.join(""), confidence: count ? confidenceSum / count : 0 };
}

/** Deterministic equivalent of GenericAgent's optional contrast/scale preprocessing for raw RGB data. */
export function enhanceImage(image: VisionImage, options: EnhanceOptions = {}): VisionImage {
  if (image.metadata.sourceFormat !== "raw") throw new Error("enhance requires raw pixel input");
  const scale = Math.max(1, Math.min(4, Math.round(options.scale ?? 3)));
  const contrast = Math.max(0.1, Math.min(5, options.contrast ?? 3));
  const { width, height, channels } = image.metadata;
  const outWidth = width * scale; const outHeight = height * scale;
  const output = Buffer.allocUnsafe(outWidth * outHeight * channels);
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
    const source = (Math.floor(y / scale) * width + Math.floor(x / scale)) * channels;
    const target = (y * outWidth + x) * channels;
    for (let channel = 0; channel < channels; channel++) {
      const value = image.data[source + channel];
      output[target + channel] = Math.max(0, Math.min(255, Math.round(128 + (value - 128) * contrast)));
    }
  }
  return normalizeImage({ data: output, metadata: { ...image.metadata, width: outWidth, height: outHeight, sourceFormat: "raw" } });
}

export function rapidOcrInputMetadata(image: VisionImage): ImageMetadata { return { ...image.metadata, channels: 3, pixelFormat: "rgb" }; }
