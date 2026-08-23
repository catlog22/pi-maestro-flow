// Browser-local vision compatibility facade.
//
// The browser API predates the shared computer-use vision service, so this
// module intentionally keeps its small result envelopes and string language
// parameter while adapting screenshots to the platform-neutral ONNX service.
// It has no desktop capture/control imports: browser screenshots are the only
// input and all coordinates remain relative to the screenshot origin (0, 0).

import { createVisionService } from "../computer-use/vision/worker.ts";
import type { DetectOptions, OcrOptions, VisionUnavailable } from "../computer-use/vision/worker.ts";
import type { DetectionResult, DetectionUnavailable } from "../computer-use/vision/detect.ts";
import type { OcrResult as SharedOcrResult } from "../computer-use/vision/ocr.ts";
import type { ImageMetadata, VisionImageInput } from "../computer-use/vision/types.ts";

export interface OcrLine {
  bbox: [number, number, number, number];
  text: string;
  confidence: number;
}

export interface OcrResult {
  text: string;
  lines: OcrLine[];
  engine: string;
  width: number;
  height: number;
}

export interface DetectItem {
  bbox: [number, number, number, number];
  type: "text" | "icon";
  label: string | null;
  confidence: number;
}

export interface DetectResult {
  items: DetectItem[];
  engine: string;
  width: number;
  height: number;
}

export interface LocalVisionError {
  ok: false;
  error: string;
  hint: string;
  engine: string;
}

export type OcrOutcome = OcrResult | LocalVisionError;
export type DetectOutcome = DetectResult | LocalVisionError;

export interface BrowserVisionService {
  ocr(input: VisionImageInput, options?: OcrOptions): Promise<SharedOcrResult | VisionUnavailable>;
  detect(input: VisionImageInput, options?: DetectOptions): Promise<DetectionResult | DetectionUnavailable | VisionUnavailable>;
  shutdown?(): Promise<void>;
}

const DEFAULT_LANGS = "eng";
let service: BrowserVisionService | undefined;

/** Test/embedding seam; production callers should use the lazy shared service. */
export function setLocalVisionService(next: BrowserVisionService | undefined): void {
  service = next;
}

function getService(): BrowserVisionService {
  if (!service) {
    service = createVisionService();
  }
  return service;
}

function browserImage(image: Buffer, width: number, height: number): VisionImageInput {
  const metadata: ImageMetadata & { origin: { x: number; y: number } } = {
    width,
    height,
    // Browser screenshots are PNG byte buffers. The shared decoder/runtime
    // owns interpretation of the encoded pixels; channels is only a contract
    // hint and is deliberately not used for browser/desktop conversion.
    channels: 4,
    pixelFormat: "rgba",
    sourceFormat: "png",
    origin: { x: 0, y: 0 },
  };
  return { data: image, metadata };
}

function normalizeLangs(langs: string): readonly string[] {
  return langs.split("+").map((lang) => lang.trim()).filter(Boolean);
}

function clipRegion(region: { x: number; y: number; w: number; h: number } | undefined, width: number, height: number): { x: number; y: number; w: number; h: number } | undefined {
  if (!region) return undefined;
  const x = Math.max(0, Math.round(region.x));
  const y = Math.max(0, Math.round(region.y));
  const w = Math.max(1, Math.round(region.w));
  const h = Math.max(1, Math.round(region.h));
  const clipped = { x, y, w: Math.min(w, width - x), h: Math.min(h, height - y) };
  return clipped.w > 0 && clipped.h > 0 ? clipped : undefined;
}

function lineInRegion(line: OcrLine, region: { x: number; y: number; w: number; h: number }): boolean {
  const [x1, y1, x2, y2] = line.bbox;
  return x2 > region.x && y2 > region.y && x1 < region.x + region.w && y1 < region.y + region.h;
}

function isVisionUnavailable(value: unknown): value is VisionUnavailable | DetectionUnavailable {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false
    && typeof (value as { diagnostic?: unknown }).diagnostic === "string"
    && typeof (value as { engine?: unknown }).engine === "string";
}
function toError(operation: "OCR" | "detect", failure: VisionUnavailable | DetectionUnavailable): LocalVisionError {
  const engine = failure.engine;
  const diagnostic = failure.diagnostic || "UNKNOWN";
  const modelHint = engine === "omniparser"
    ? "OmniParser is fail-closed until a verified model artifact is recorded in optional/computer-use-manifest.json; no icon coordinates were fabricated."
    : "Install the verified rapidocr-onnxruntime model assets and set RAPIDOCR_ONNX_ROOT to the package root, then retry. Do not download unverified weights.";
  const hint = diagnostic === "MODEL_RUNTIME_UNAVAILABLE"
    ? "Install the optional onnxruntime-node dependency in the pi-maestro-flow package, then retry."
    : diagnostic === "MODEL_PROVENANCE_UNVERIFIED"
      ? modelHint
      : diagnostic === "MODEL_FILE_MISSING"
        ? `${modelHint} The manifest points at a missing local model file.`
        : diagnostic === "MODEL_CHECKSUM_MISMATCH"
          ? `${modelHint} The local model checksum does not match the manifest; restore the verified artifact.`
          : `${modelHint} Shared ${operation.toLowerCase()} failed with ${diagnostic}; inspect the diagnostic and retry after remediation.`;
  return {
    ok: false,
    error: `Local ${operation} unavailable: ${diagnostic}${failure.diagnostic ? ` (${failure.diagnostic})` : ""}`,
    hint,
    engine,
  };
}

export async function runOcr(
  image: Buffer,
  width: number,
  height: number,
  region?: { x: number; y: number; w: number; h: number },
  langs: string = DEFAULT_LANGS,
): Promise<OcrOutcome> {
  const clipped = clipRegion(region, width, height);
  try {
    const result = await getService().ocr(browserImage(image, width, height), { langs: normalizeLangs(langs) });
    if (isVisionUnavailable(result)) return toError("OCR", result);
    const lines = clipped ? result.lines.filter((line: OcrLine) => lineInRegion(line, clipped)) : result.lines;
    return { ...result, lines, text: lines.map((line) => line.text).join("\n") };
  } catch (error) {
    return {
      ok: false,
      error: `OCR run failed: ${error instanceof Error ? error.message : String(error)}`,
      hint: "The shared RapidOCR/ONNX service raised an error. Verify onnxruntime-node and the manifest-listed model assets, then retry.",
      engine: "rapidocr",
    };
  }
}

export async function runDetect(
  image: Buffer,
  width: number,
  height: number,
  mode: "match" | "crop" = "match",
  langs: string = DEFAULT_LANGS,
): Promise<DetectOutcome> {
  try {
    const result = await getService().detect(browserImage(image, width, height), { mode, langs: normalizeLangs(langs) });
    if (isVisionUnavailable(result)) return toError("detect", result);
    return result;
  } catch (error) {
    return {
      ok: false,
      error: `Detect run failed: ${error instanceof Error ? error.message : String(error)}`,
      hint: "The shared OmniParser/ONNX service raised an error. Detection remains fail-closed; verify the manifest-listed model assets and retry.",
      engine: "omniparser",
    };
  }
}

export async function resetLocalVisionCache(): Promise<void> {
  const current = service;
  service = undefined;
  if (current) await current.shutdown?.().catch(() => {});
}

export function isLocalVisionError(value: unknown): value is LocalVisionError {
  return typeof value === "object" && value !== null
    && (value as { ok?: unknown }).ok === false
    && typeof (value as { error?: unknown }).error === "string";
}
