import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ModelArtifactStatus = "verified_local" | "registry_contract_only" | "unverified_missing";
export interface ModelArtifact {
  id: string;
  kind: "ocr_detector" | "ocr_recognizer" | "ocr_classifier" | "ui_detector";
  status: ModelArtifactStatus;
  path: string;
  package: string | null;
  package_version: string | null;
  provenance: string | null;
  sha256?: string;
  diagnostic?: string;
}
export interface VisionManifest {
  schema_version: string;
  model_artifacts: ModelArtifact[];
  fail_closed: { unverified_model_status: "unavailable"; diagnostic_code: "MODEL_PROVENANCE_UNVERIFIED"; allow_startup_without_optional_dependencies: true };
}
export interface ModelAssetOptions { manifestPath?: string; rapidOcrRoot?: string; }
export interface ModelAssetResolution {
  artifact: ModelArtifact;
  available: boolean;
  path?: string;
  diagnostic?: string;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_MANIFEST_PATH = join(PACKAGE_ROOT, "optional", "computer-use-manifest.json");
const resolvedCache = new Map<string, ModelAssetResolution>();

export function loadVisionManifest(manifestPath = DEFAULT_MANIFEST_PATH): VisionManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as VisionManifest;
}

export function resolveModelAsset(id: string, options: ModelAssetOptions = {}): ModelAssetResolution {
  const manifestPath = resolve(options.manifestPath ?? DEFAULT_MANIFEST_PATH);
  const key = `${manifestPath}\0${id}\0${options.rapidOcrRoot ?? process.env.RAPIDOCR_ONNX_ROOT ?? ""}`;
  const cached = resolvedCache.get(key);
  if (cached) return cached;
  const manifest = loadVisionManifest(manifestPath);
  const artifact = manifest.model_artifacts.find((entry) => entry.id === id);
  if (!artifact) throw new Error(`Unknown model artifact: ${id}`);
  if (artifact.status !== "verified_local") {
    const result = { artifact, available: false, diagnostic: manifest.fail_closed.diagnostic_code };
    resolvedCache.set(key, result);
    return result;
  }
  const path = resolveVerifiedPath(artifact, options);
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    const result = { artifact, available: false, diagnostic: "MODEL_FILE_MISSING" };
    resolvedCache.set(key, result);
    return result;
  }
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== artifact.sha256) {
    const result = { artifact, available: false, diagnostic: "MODEL_CHECKSUM_MISMATCH" };
    resolvedCache.set(key, result);
    return result;
  }
  const result = { artifact, available: true, path };
  resolvedCache.set(key, result);
  return result;
}

function resolveVerifiedPath(artifact: ModelArtifact, options: ModelAssetOptions): string | undefined {
  if (artifact.path.startsWith("python://")) {
    const root = options.rapidOcrRoot ?? process.env.RAPIDOCR_ONNX_ROOT;
    return root ? join(resolve(root), "models", basename(artifact.path)) : undefined;
  }
  if (isAbsolute(artifact.path)) return artifact.path;
  return resolve(dirname(DEFAULT_MANIFEST_PATH), artifact.path);
}

export function clearModelAssetCache(): void { resolvedCache.clear(); }
