import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matchCropDetections, matchDetections } from "../src/computer-use/vision/detect.ts";
import { resolveModelAsset, clearModelAssetCache } from "../src/computer-use/vision/model-assets.ts";
import { makeOcrResult, normalizeClassifierResult, normalizeConfidence, normalizeOcrLines, postprocessDetectorScores } from "../src/computer-use/vision/ocr.ts";
import { OnnxVisionService, VisionAbortError, VisionServiceClosedError } from "../src/computer-use/vision/worker.ts";
import { normalizeImage } from "../src/computer-use/vision/types.ts";

const image = (width = 20, height = 10) => normalizeImage({ data: Buffer.alloc(width * height * 3), metadata: { width, height, channels: 3, sourceFormat: "raw" } });

test("vision image bounds reject oversized and undersized raw buffers", () => {
  assert.throws(() => normalizeImage({ data: Buffer.alloc(3), metadata: { width: 2, height: 2, channels: 3, sourceFormat: "raw" } }), /smaller/);
  assert.throws(() => normalizeImage({ data: Buffer.alloc(100), metadata: { width: 20, height: 20, channels: 3 } }, { maxPixels: 100 }), /pixel count/);
  assert.throws(() => normalizeImage({ data: Buffer.alloc(100), metadata: { width: 2, height: 2, channels: 3 } }, { maxBytes: 3 }), /buffer/);
});

test("RapidOCR postprocessing normalizes confidence, CJK spaces, and empty outputs", () => {
  assert.equal(normalizeConfidence("75"), 0.75);
  assert.deepEqual(normalizeClassifierResult([0.1, 0.8]), { angle: 180, confidence: 0.8 });
  assert.deepEqual(normalizeOcrLines(null, 20, 20), []);
  const result = makeOcrResult(normalizeOcrLines([{ bbox: [[0, 0], [10, 0], [10, 5], [0, 5]], text: "你 好", confidence: "80" }], 20, 20), 20, 20);
  assert.equal(result.text, "你好");
  assert.equal(result.lines[0].confidence, 0.8);
  assert.deepEqual(makeOcrResult([], 20, 20).lines, []);
});

test("detector score fixture maps connected regions to image coordinates", () => {
  const boxes = postprocessDetectorScores([0, 0.9, 0, 0, 0, 0, 0, 0.8, 0], 3, 3, 30, 30, 0.5);
  assert.deepEqual(boxes, [[10, 0, 20, 10], [10, 20, 20, 30]]);
});

test("match and crop detection pipelines attach text without inventing icon labels", () => {
  const boxes = [{ bbox: [0, 0, 10, 10] as [number, number, number, number], confidence: 0.9 }];
  const lines = [{ bbox: [1, 1, 9, 9] as [number, number, number, number], text: "Save", confidence: 0.8 }];
  assert.deepEqual(matchDetections(boxes, lines), [{ bbox: [0, 0, 10, 10], type: "icon", label: "Save", confidence: 0.9 }]);
  assert.deepEqual(matchCropDetections(image(), boxes, () => lines), [{ bbox: [0, 0, 10, 10], type: "icon", label: "Save", confidence: 0.9 }]);
  assert.equal(matchDetections(boxes, []).at(0)?.label, null);
});

test("manifest model resolution verifies digest and fails closed on mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-model-"));
  const file = join(dir, "model.onnx"); writeFileSync(file, "fixture");
  const manifestPath = join(dir, "manifest.json");
  const digest = createHash("sha256").update("fixture").digest("hex");
  writeFileSync(manifestPath, JSON.stringify({ schema_version: "computer-use-manifest/0.1", model_artifacts: [{ id: "fixture", kind: "ocr_detector", status: "verified_local", path: file, package: null, package_version: null, provenance: "fixture", sha256: digest }], fail_closed: { unverified_model_status: "unavailable", diagnostic_code: "MODEL_PROVENANCE_UNVERIFIED", allow_startup_without_optional_dependencies: true }}));
  clearModelAssetCache();
  assert.equal(resolveModelAsset("fixture", { manifestPath }).available, true);
  writeFileSync(file, "changed"); clearModelAssetCache();
  assert.equal(resolveModelAsset("fixture", { manifestPath }).diagnostic, "MODEL_CHECKSUM_MISMATCH");
});

test("OCR adapter honors abort and shutdown lifecycle", async () => {
  const runtime = { infer: async () => new Promise(() => {}) };
  const service = new OnnxVisionService({ runtime });
  const controller = new AbortController();
  const pending = service.ocr(image(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, VisionAbortError);
  await service.shutdown();
  await assert.rejects(service.ocr(image()), VisionServiceClosedError);
});

test("OmniParser detection is explicitly unavailable when provenance is missing", async () => {
  const result = await new OnnxVisionService().detect(image(), { mode: "crop" });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.code, "MODEL_PROVENANCE_UNVERIFIED"); assert.deepEqual(result.items, []); assert.equal(result.mode, "crop"); }
});

test("vision modules remain browser and statically-native-import independent", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  for (const file of readdirSync(new URL("../src/computer-use/vision/", import.meta.url))) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(new URL(`../src/computer-use/vision/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:.*browser|onnxruntime-node)["']/);
    assert.doesNotMatch(source, /from\s+["'](?:puppeteer|electron|@nut-tree)/);
  }
});
