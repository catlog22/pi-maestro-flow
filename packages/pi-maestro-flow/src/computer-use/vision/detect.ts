import { cropImage } from "./types.ts";
import type { BBox, VisionImage } from "./types.ts";
import type { OcrLine } from "./ocr.ts";

export interface DetectorBox { bbox: BBox; confidence: number; }
export interface DetectionItem { bbox: BBox; type: "icon" | "text"; label: string | null; confidence: number; }
export interface DetectionResult { ok: true; items: DetectionItem[]; mode: "match" | "crop"; width: number; height: number; engine: "omniparser"; }
export interface DetectionUnavailable { ok: false; items: []; mode: "match" | "crop"; width: number; height: number; code: "MODEL_PROVENANCE_UNVERIFIED" | "MODEL_UNAVAILABLE"; diagnostic: string; engine: "omniparser"; }

export function intersectionOverContainedArea(a: BBox, b: BBox): number {
  const x1 = Math.max(a[0], b[0]); const y1 = Math.max(a[1], b[1]); const x2 = Math.min(a[2], b[2]); const y2 = Math.min(a[3], b[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  return area ? intersection / area : 0;
}

export function matchDetections(boxes: readonly DetectorBox[], lines: readonly OcrLine[], iouThreshold = 0.5): DetectionItem[] {
  const matched = new Set<number>();
  const items: DetectionItem[] = boxes.map((box) => {
    let label: string | null = null;
    let best = -1; let bestOverlap = iouThreshold;
    for (let index = 0; index < lines.length; index++) {
      if (matched.has(index)) continue;
      const overlap = intersectionOverContainedArea(box.bbox, lines[index].bbox);
      if (overlap > bestOverlap) { best = index; bestOverlap = overlap; label = lines[index].text; }
    }
    if (best >= 0) matched.add(best);
    return { bbox: box.bbox, type: "icon", label, confidence: Math.max(0, Math.min(1, box.confidence)) };
  });
  for (let index = 0; index < lines.length; index++) if (!matched.has(index)) {
    const line = lines[index]; items.push({ bbox: line.bbox, type: "text", label: line.text, confidence: line.confidence });
  }
  return items;
}

export function matchCropDetections(image: VisionImage, boxes: readonly DetectorBox[], cropOcr: (crop: VisionImage, sourceBox: BBox, index: number) => readonly OcrLine[], _iouThreshold = 0.5): DetectionItem[] {
  return boxes.map((box, index) => {
    const cropLines = cropOcr(cropImage(image, box.bbox), box.bbox, index);
    const text = cropLines.map((line) => line.text.trim()).filter(Boolean).join(" ");
    return { bbox: box.bbox, type: "icon", label: text || null, confidence: Math.max(0, Math.min(1, box.confidence)) };
  });
}

export function unavailableDetection(width: number, height: number, diagnostic = "MODEL_PROVENANCE_UNVERIFIED", mode: "match" | "crop" = "match"): DetectionUnavailable {
  return { ok: false, items: [], mode, width, height, code: diagnostic === "MODEL_PROVENANCE_UNVERIFIED" ? "MODEL_PROVENANCE_UNVERIFIED" : "MODEL_UNAVAILABLE", diagnostic, engine: "omniparser" };
}
