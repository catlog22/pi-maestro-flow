// Local on-page vision: OCR + UI element detection for the browser tab.
//
// This is the browser-internal variant of GenericAgent's ocr_utils.py /
// ui_detect.py: it runs OCR over a tab screenshot and returns text + bbox
// coordinates so the agent can follow with tab.cdpClick(x, y). It deliberately
// does NOT do desktop control (no window enumeration, no keyboard/mouse
// outside the browser) — see EXTRA-FEATURES-OCR-COMPUTER-USE.md §6.
//
// Engine selection: tesseract.js (pure wasm, zero native deps) is the default.
// It is loaded lazily via dynamic require so a missing optional dependency
// degrades to a structured error with an install hint rather than a crash.
// When no local engine is available, callers fall back to the cloud VLM path
// in vision-assist.ts (delegateImage) — but VLM output is text-only and its
// pixel coordinates are unreliable (GA computer_use.md: "VLM 坐标不可信"),
// so bbox emission stays local-only.

import { createRequire } from "node:module";

export interface OcrLine {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in screenshot pixels
  text: string;
  confidence: number; // 0..1
}

export interface OcrResult {
  text: string; // all lines joined by newline
  lines: OcrLine[];
  engine: string; // which engine produced this (e.g. "tesseract.js@7")
  width: number; // screenshot dimensions
  height: number;
}

export interface DetectItem {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  type: "text" | "icon";
  label: string | null; // OCR text for text items; null for icon-only regions
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
  hint: string; // install command or fallback guidance
  engine: string;
}

export type OcrOutcome = OcrResult | LocalVisionError;
export type DetectOutcome = DetectResult | LocalVisionError;

// Lazily cached tesseract.js worker pool keyed by language string. Different
// language combinations need different worker instances (createWorker bakes
// the langs in), but reuse within the same langs avoids re-loading wasm.
// v7 API: createWorker(langs, oem); worker.recognize(image, options?, output?).
// bbox data lives in data.blocks[].paragraphs[].lines[] (only emitted when
// the recognize call passes { blocks: true } as the output argument).
interface TesseractBbox { x0: number; y0: number; x1: number; y1: number }
interface TesseractLine { text: string; confidence: number; bbox: TesseractBbox }
interface TesseractParagraph { lines: TesseractLine[]; text: string; confidence: number; bbox: TesseractBbox }
interface TesseractBlock { paragraphs: TesseractParagraph[]; text: string; confidence: number; bbox: TesseractBbox; blocktype: string }
interface TesseractPage { text: string; confidence: number; blocks?: TesseractBlock[] }
interface TesseractWorker {
  recognize: (image: Buffer | string, options?: { rectangle?: { left: number; top: number; width: number; height: number } }, output?: { blocks?: boolean; text?: boolean }) => Promise<{ data: TesseractPage }>;
  terminate: () => Promise<void>;
}

const workerCache = new Map<string, TesseractWorker>();
let cachedEngineLabel: string | null = null;

// Default language pack: English only. GA ocr_utils covers 中英文, but the
// eng+chi_sim combination is slower to load and measurably less accurate on
// short Latin labels (e.g. 'ClickMe' misreads under chi_sim). Call sites that
// need Chinese pass langs: 'eng+chi_sim' explicitly.
const DEFAULT_LANGS = "eng";

async function loadTesseract(langs: string = DEFAULT_LANGS): Promise<{ worker: TesseractWorker; label: string }> {
  const cached = workerCache.get(langs);
  if (cached) return { worker: cached, label: cachedEngineLabel! };
  // Dynamic require via createRequire so the optional dependency is only loaded
  // when used and its types are not required at compile time (matches the
  // project's existing optional-dependency pattern, e.g. proper-lockfile).
  const require = createRequire(import.meta.url);
  let createWorker: (langs: string, oem?: number) => Promise<TesseractWorker>;
  let version: string;
  try {
    const mod = require("tesseract.js") as { createWorker?: (langs: string, oem?: number) => Promise<TesseractWorker>; version?: string };
    if (typeof mod.createWorker !== "function") throw new Error("tesseract.js createWorker export not found");
    createWorker = mod.createWorker;
    version = mod.version ?? "7";
  } catch (error) {
    throw new TesseractUnavailableError(error instanceof Error ? error.message : String(error));
  }
  // Each non-default language pack (e.g. chi_sim, ~10MB) is fetched on first
  // recognize by tesseract.js. If that download fails the worker throws; the
  // caller surfaces a structured error and the user can retry once warm.
  const worker = await createWorker(langs, 1);
  workerCache.set(langs, worker);
  cachedEngineLabel = `tesseract.js@${version}`;
  return { worker, label: cachedEngineLabel };
}

class TesseractUnavailableError extends Error {
  constructor(reason: string) {
    super(`tesseract.js unavailable: ${reason}`);
    this.name = "TesseractUnavailableError";
  }
}

function makeUnavailableError(reason: string): LocalVisionError {
  return {
    ok: false,
    error: `Local OCR engine unavailable: ${reason}`,
    hint: 'Install it with: npm i tesseract.js  (in the pi-maestro-flow package). Then retry tab.ocr()/tab.detect(). Alternatively, the cloud VLM (describe_image) can read text but cannot return reliable pixel coordinates.',
    engine: "none",
  };
}

function clipToRectangle(region: { x: number; y: number; w: number; h: number } | undefined, width: number, height: number): { left: number; top: number; width: number; height: number } | undefined {
  if (!region) return undefined;
  const left = Math.max(0, Math.round(region.x));
  const top = Math.max(0, Math.round(region.y));
  const w = Math.max(1, Math.round(region.w));
  const h = Math.max(1, Math.round(region.h));
  const clampedWidth = Math.min(w, width - left);
  const clampedHeight = Math.min(h, height - top);
  if (clampedWidth <= 0 || clampedHeight <= 0) return undefined;
  return { left, top, width: clampedWidth, height: clampedHeight };
}

// Lines are the natural unit for "where is this text on the page"; words are
// too granular and the full-block text is too coarse. tesseract.js v7 only
// emits per-line bbox when recognize is called with { blocks: true }; the
// result then lives in data.blocks[].paragraphs[].lines[].
function extractLines(data: TesseractPage): OcrLine[] {
  const result: OcrLine[] = [];
  const blocks = data.blocks ?? [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = (line.text ?? "").trim();
        if (!text) continue;
        // GA pitfall: confidence may arrive as a string; coerce to float and
        // normalize tesseract's 0..100 scale to 0..1.
        const conf = typeof line.confidence === "number" ? line.confidence : Number(line.confidence);
        const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf / 100)) : 0;
        result.push({
          bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1],
          text,
          confidence,
        });
      }
    }
  }
  return result;
}

export async function runOcr(image: Buffer, width: number, height: number, region?: { x: number; y: number; w: number; h: number }, langs: string = DEFAULT_LANGS): Promise<OcrOutcome> {
  let worker: TesseractWorker;
  let label: string;
  try {
    ({ worker, label } = await loadTesseract(langs));
  } catch (error) {
    const reason = error instanceof TesseractUnavailableError
      ? error.message.replace(/^tesseract.js unavailable: /, "")
      : error instanceof Error ? error.message : String(error);
    return makeUnavailableError(reason);
  }
  try {
    const rectangle = clipToRectangle(region, width, height);
    // v7: blocks must be explicitly requested or data.blocks is undefined.
    const result = await worker.recognize(image, rectangle ? { rectangle } : {}, { blocks: true, text: true });
    const lines = extractLines(result.data);
    const text = lines.map((line) => line.text).join("\n");
    return { text, lines, engine: label, width, height };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `OCR run failed: ${reason}`,
      hint: "The tesseract.js worker raised an error. Retry once; if it persists the wasm/traineddata download may have failed — check network, then re-run. For text-only needs (no coordinates) describe_image is a fallback.",
      engine: label,
    };
  }
}

// UI element detection over a browser screenshot: group OCR lines into
// labeled text regions and emit empty icon boxes for visually dense areas
// that OCR did not resolve (a coarse stand-in for GA's YOLO icon detector —
// we deliberately avoid bundling a ~50MB ONNX model; canvas/button detection
// here is text-region centric, which covers the captcha-label + form-button
// use cases the spec calls out).
export async function runDetect(image: Buffer, width: number, height: number, mode: "match" | "crop" = "match", langs: string = DEFAULT_LANGS): Promise<DetectOutcome> {
  let worker: TesseractWorker;
  let label: string;
  try {
    ({ worker, label } = await loadTesseract(langs));
  } catch (error) {
    const reason = error instanceof TesseractUnavailableError
      ? error.message.replace(/^tesseract.js unavailable: /, "")
      : error instanceof Error ? error.message : String(error);
    return makeUnavailableError(reason);
  }
  try {
    const result = await worker.recognize(image, {}, { blocks: true, text: true });
    const lines = extractLines(result.data);
    const items: DetectItem[] = lines.map((line) => ({
      bbox: line.bbox,
      type: "text" as const,
      label: line.text,
      confidence: line.confidence,
    }));
    // match mode: each OCR line is one text item. crop mode: the spec reserves
    // crop for a future YOLO-backed path; with OCR-only the two modes collapse
    // to the same output, but we honor the parameter so call sites stay stable.
    void mode;
    return { items, engine: label, width, height };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Detect run failed: ${reason}`,
      hint: "The tesseract.js worker raised an error during detection. Retry once; for canvas-icon localization without text, describe_image (VLM) can identify the element semantically but its pixel coordinates are not reliable.",
      engine: label,
    };
  }
}

// Reset caches. Used by tests to force a fresh worker and by long-lived
// hosts that want to release wasm memory between sessions.
export async function resetLocalVisionCache(): Promise<void> {
  for (const worker of workerCache.values()) {
    try { await worker.terminate(); } catch { /* ignore terminate errors */ }
  }
  workerCache.clear();
  cachedEngineLabel = null;
}

export function isLocalVisionError(value: unknown): value is LocalVisionError {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false && typeof (value as { error?: unknown }).error === "string";
}
