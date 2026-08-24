import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";
import { ComputerUseError, type PhysicalPoint } from "./types.ts";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 8192;
const DEFAULT_MAX_PIXELS = 33_554_432;
const DEFAULT_ARTIFACT_ROOT = join(tmpdir(), "pi-computer-use");

export interface PngBounds {
  maxBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
}

export interface PngMetadata {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  bytes: number;
}

export interface OwnedPngArtifact {
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  /** Idempotent cleanup of this artifact and its private directory. */
  cleanup(): Promise<void>;
}

export interface OwnedPngArtifactOptions extends PngBounds {
  directory?: string;
}

export interface BlankFrameReport {
  blank: boolean;
  reason: "uniform" | "transparent" | "not_blank";
  width: number;
  height: number;
  sampledPixels: number;
  uniqueColors: number;
}

function artifactError(code: "INVALID_IMAGE" | "ARTIFACT_LIMIT_EXCEEDED" | "ARTIFACT_CLEANUP_FAILED", message: string, details?: Record<string, unknown>): ComputerUseError {
  return new ComputerUseError({ code, message, retryable: false, ...(details ? { details } : {}) });
}

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw artifactError("ARTIFACT_LIMIT_EXCEEDED", `${name} must be a positive safe integer`);
  return result;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Validate PNG signature/IHDR and enforce dimensions before decoding or writing. */
export function inspectPng(bytes: Uint8Array, bounds: PngBounds = {}): PngMetadata {
  const maxBytes = positiveBound(bounds.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  if (bytes.byteLength > maxBytes) throw artifactError("ARTIFACT_LIMIT_EXCEEDED", `PNG exceeds ${maxBytes} bytes`, { bytes: bytes.byteLength, maxBytes });
  if (!hasPngSignature(bytes)) throw artifactError("INVALID_IMAGE", "Expected a PNG image");

  const maxWidth = positiveBound(bounds.maxWidth, DEFAULT_MAX_DIMENSION, "maxWidth");
  const maxHeight = positiveBound(bounds.maxHeight, DEFAULT_MAX_DIMENSION, "maxHeight");
  const maxPixels = positiveBound(bounds.maxPixels, DEFAULT_MAX_PIXELS, "maxPixels");
  let offset = 8;
  let metadata: PngMetadata | undefined;
  while (offset + 12 <= bytes.length) {
    const length = bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) throw artifactError("INVALID_IMAGE", "PNG chunk exceeds the input length");
    const type = chunkType(bytes, offset + 4);
    if (type === "IHDR") {
      if (length !== 13 || metadata) throw artifactError("INVALID_IMAGE", "PNG has an invalid IHDR chunk");
      const width = readUint32(bytes, offset + 8);
      const height = readUint32(bytes, offset + 12);
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      const interlace = bytes[offset + 20];
      if (width < 1 || height < 1 || width > maxWidth || height > maxHeight || width * height > maxPixels) {
        throw artifactError("ARTIFACT_LIMIT_EXCEEDED", "PNG dimensions exceed configured bounds", { width, height, maxWidth, maxHeight, maxPixels });
      }
      if (bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType) || interlace !== 0) {
        throw artifactError("INVALID_IMAGE", "Only non-interlaced 8-bit PNG color types are supported", { bitDepth, colorType, interlace });
      }
      metadata = { width, height, bitDepth, colorType, interlace, bytes: bytes.byteLength };
      break;
    }
    offset = chunkEnd;
  }
  if (!metadata) throw artifactError("INVALID_IMAGE", "PNG is missing its IHDR chunk");
  return metadata;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  try {
    const existing = await lstat(absolute);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw artifactError("ARTIFACT_CLEANUP_FAILED", `Artifact directory is not a private directory: ${absolute}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  }
  await chmod(absolute, 0o700);
}

function ownsPath(path: string, directory: string): boolean {
  const rel = relative(resolve(directory), resolve(path));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Write a bounded PNG in a private owner-only directory using exclusive creation. */
export async function createOwnedPngArtifact(bytes: Uint8Array, options: OwnedPngArtifactOptions = {}): Promise<OwnedPngArtifact> {
  const metadata = inspectPng(bytes, options);
  const root = resolve(options.directory ?? DEFAULT_ARTIFACT_ROOT);
  await ensurePrivateDirectory(root);
  const directory = await mkdtemp(join(root, "frame-"));
  await chmod(directory, 0o700);
  const path = join(directory, `capture-${randomUUID()}.png`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let cleaned = false;
  return {
    path,
    width: metadata.width,
    height: metadata.height,
    sizeBytes: bytes.byteLength,
    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      if (!ownsPath(path, directory)) throw artifactError("ARTIFACT_CLEANUP_FAILED", "Refusing to clean a path outside the artifact directory");
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) throw artifactError("ARTIFACT_CLEANUP_FAILED", "Refusing to clean a non-regular artifact");
        await unlink(path);
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    },
  };
}

export async function withTemporaryPngArtifact<T>(
  bytes: Uint8Array,
  fn: (artifact: OwnedPngArtifact) => Promise<T> | T,
  options: OwnedPngArtifactOptions = {},
): Promise<T> {
  const artifact = await createOwnedPngArtifact(bytes, options);
  try {
    return await fn(artifact);
  } finally {
    await artifact.cleanup();
  }
}

interface DecodedPng {
  metadata: PngMetadata;
  pixels: Uint8Array;
  channels: number;
  palette?: Uint8Array;
  transparency?: Uint8Array;
}

function decodePng(bytes: Uint8Array, bounds: PngBounds = {}): DecodedPng {
  const metadata = inspectPng(bytes, bounds);
  let offset = 8;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = chunkType(bytes, offset + 4);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idat.push(data);
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (idat.length === 0) throw artifactError("INVALID_IMAGE", "PNG has no image data");
  if (metadata.colorType === 3 && (!palette || palette.length % 3 !== 0)) throw artifactError("INVALID_IMAGE", "Indexed PNG has no valid palette");
  const channels = metadata.colorType === 0 ? 1 : metadata.colorType === 2 ? 3 : metadata.colorType === 3 ? 1 : metadata.colorType === 4 ? 2 : 4;
  const stride = metadata.width * channels;
  const inflated = new Uint8Array(inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk)))));
  const expected = metadata.height * (stride + 1);
  if (inflated.length < expected) throw artifactError("INVALID_IMAGE", "PNG image data is truncated");
  const pixels = new Uint8Array(metadata.height * stride);
  let inOffset = 0;
  for (let y = 0; y < metadata.height; y++) {
    const filter = inflated[inOffset++];
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[inOffset++];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[previousStart + x - channels] : 0;
      pixels[rowStart + x] = filter === 0 ? raw
        : filter === 1 ? (raw + left) & 0xff
          : filter === 2 ? (raw + above) & 0xff
            : filter === 3 ? (raw + Math.floor((left + above) / 2)) & 0xff
              : filter === 4 ? (raw + paeth(left, above, upperLeft)) & 0xff
                : (() => { throw artifactError("INVALID_IMAGE", `Unsupported PNG filter: ${filter}`); })();
    }
  }
  return { metadata, pixels, channels, palette, transparency };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Crop a bounded, non-interlaced PNG to a physical screen rectangle. */
export function cropPng(bytes: Uint8Array, region: { x: number; y: number; width: number; height: number }): Uint8Array {
  const decoded = decodePng(bytes);
  const x = Math.floor(region.x);
  const y = Math.floor(region.y);
  const right = Math.ceil(region.x + region.width);
  const bottom = Math.ceil(region.y + region.height);
  const width = right - x;
  const height = bottom - y;
  if (![x, y, width, height].every(Number.isSafeInteger) || width < 1 || height < 1 || x < 0 || y < 0 || right > decoded.metadata.width || bottom > decoded.metadata.height) {
    throw artifactError("INVALID_IMAGE", "PNG crop rectangle is outside the captured frame", { region, width: decoded.metadata.width, height: decoded.metadata.height });
  }

  const rgba = new Uint8Array(width * height * 4);
  const colorAt = (sourceIndex: number): [number, number, number, number] => {
    const offset = sourceIndex * decoded.channels;
    if (decoded.metadata.colorType === 3) {
      const entry = decoded.pixels[offset];
      const palette = decoded.palette;
      if (!palette || entry * 3 + 2 >= palette.length) throw artifactError("INVALID_IMAGE", "PNG palette entry is out of range");
      return [palette[entry * 3], palette[entry * 3 + 1], palette[entry * 3 + 2], decoded.transparency?.[entry] ?? 255];
    }
    if (decoded.metadata.colorType === 0) return [decoded.pixels[offset], decoded.pixels[offset], decoded.pixels[offset], 255];
    if (decoded.metadata.colorType === 2) return [decoded.pixels[offset], decoded.pixels[offset + 1], decoded.pixels[offset + 2], 255];
    if (decoded.metadata.colorType === 4) return [decoded.pixels[offset], decoded.pixels[offset], decoded.pixels[offset], decoded.pixels[offset + 1]];
    return [decoded.pixels[offset], decoded.pixels[offset + 1], decoded.pixels[offset + 2], decoded.pixels[offset + 3]];
  };
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const color = colorAt((y + row) * decoded.metadata.width + x + column);
      const output = (row * width + column) * 4;
      rgba[output] = color[0];
      rgba[output + 1] = color[1];
      rgba[output + 2] = color[2];
      rgba[output + 3] = color[3];
    }
  }
  return encodeRgbaPng(width, height, rgba);
}

function encodeRgbaPng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) {
    const scanline = row * (width * 4 + 1);
    scanlines[scanline] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + row * width * 4, width * 4).copy(scanlines, scanline + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const encoded = Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return new Uint8Array(encoded);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.byteLength);
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Detect all-transparent or uniform (black/white/flat) frames before vision/input. */
export function detectBlankFrame(bytes: Uint8Array, bounds: PngBounds = {}): BlankFrameReport {
  const decoded = decodePng(bytes, bounds);
  const { metadata, pixels, channels, palette, transparency } = decoded;
  const colors = new Set<string>();
  let transparent = 0;
  const total = metadata.width * metadata.height;
  const sampleStride = Math.max(1, Math.floor(total / 4096));
  const colorAt = (index: number): [number, number, number, number] => {
    const offset = index * channels;
    if (metadata.colorType === 3) {
      const entry = pixels[offset];
      const p = (palette as Uint8Array).subarray(entry * 3, entry * 3 + 3);
      return [p[0], p[1], p[2], transparency?.[entry] ?? 255];
    }
    if (metadata.colorType === 0) return [pixels[offset], pixels[offset], pixels[offset], 255];
    if (metadata.colorType === 2) return [pixels[offset], pixels[offset + 1], pixels[offset + 2], 255];
    if (metadata.colorType === 4) return [pixels[offset], pixels[offset], pixels[offset], pixels[offset + 1]];
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
  };
  let first: [number, number, number, number] | undefined;
  for (let index = 0; index < total; index++) {
    const color = colorAt(index);
    if (!first) first = color;
    if (color[3] === 0) transparent++;
    if (index % sampleStride === 0 && colors.size < 64) colors.add(color.join(","));
  }
  if (transparent === total) return { blank: true, reason: "transparent", width: metadata.width, height: metadata.height, sampledPixels: total, uniqueColors: colors.size };
  const uniform = colors.size === 1 || (first !== undefined && [...colors].every((value) => {
    const parts = value.split(",").map(Number);
    return parts.every((channel, index) => Math.abs(channel - first![index]) <= 1);
  }));
  return { blank: uniform, reason: uniform ? "uniform" : "not_blank", width: metadata.width, height: metadata.height, sampledPixels: total, uniqueColors: colors.size };
}

export function isBlankPngFrame(bytes: Uint8Array, bounds: PngBounds = {}): boolean {
  return detectBlankFrame(bytes, bounds).blank;
}

export const isBlankFrame = isBlankPngFrame;

/** Read a PNG artifact without exposing an unbounded file to a decoder. */
export async function readBoundedPng(path: string, bounds: PngBounds = {}): Promise<Uint8Array> {
  const maxBytes = positiveBound(bounds.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw artifactError("INVALID_IMAGE", "PNG path must be a regular file");
  if (info.size > maxBytes) throw artifactError("ARTIFACT_LIMIT_EXCEEDED", `PNG exceeds ${maxBytes} bytes`);
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) throw artifactError("ARTIFACT_LIMIT_EXCEEDED", `PNG exceeds ${maxBytes} bytes`);
  inspectPng(bytes, bounds);
  return bytes;
}

export type { PhysicalPoint };
