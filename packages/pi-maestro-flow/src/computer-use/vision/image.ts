import { inflateSync } from "node:zlib";
import { ComputerUseError } from "../../tools/computer-use/types.ts";
import {
  DEFAULT_IMAGE_LIMITS,
  assertImageWithinBounds,
  clampBox,
  cropImage,
  imageFingerprint,
  mapBoundingBox,
  normalizeImage,
} from "./types.ts";
import type {
  BBox,
  ImageLimits,
  ImageMetadata,
  ImagePixelFormat,
  ImageSourceFormat,
  VisionImage,
  VisionImageInput,
} from "./types.ts";

export {
  DEFAULT_IMAGE_LIMITS,
  assertImageWithinBounds,
  clampBox,
  cropImage,
  imageFingerprint,
  mapBoundingBox,
  normalizeImage,
} from "./types.ts";
export type {
  BBox,
  ImageLimits,
  ImageMetadata,
  ImagePixelFormat,
  ImageSourceFormat,
  VisionImage,
  VisionImageInput,
} from "./types.ts";

/** Decode the PNG formats emitted by screenshot-desktop/Chromium without a native image dependency. */
export function decodePng(input: Buffer | Uint8Array, metadata?: Partial<ImageMetadata>): VisionImage {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new ComputerUseError({ code: "INVALID_IMAGE", message: "Only PNG image input is supported by the built-in decoder", retryable: false });
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); offset += 4;
    const type = bytes.subarray(offset, offset + 4).toString("ascii"); offset += 4;
    if (offset + length + 4 > bytes.length) throw new ComputerUseError({ code: "INVALID_IMAGE", message: "PNG chunk exceeds input bounds", retryable: false });
    const data = bytes.subarray(offset, offset + length); offset += length;
    offset += 4; // CRC is checked by the bounded container, not needed for decoding.
    if (type === "IHDR") {
      if (length !== 13) throw new ComputerUseError({ code: "INVALID_IMAGE", message: "PNG IHDR is malformed", retryable: false });
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]!; colorType = data[9]!; interlace = data[12]!;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) {
    throw new ComputerUseError({ code: "INVALID_IMAGE", message: "PNG must be non-interlaced 8-bit grayscale/RGB/RGBA", retryable: false });
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const rowBytes = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const expected = height * (rowBytes + 1);
  if (inflated.length < expected) throw new ComputerUseError({ code: "INVALID_IMAGE", message: "PNG pixel data is truncated", retryable: false });
  const raw = Buffer.allocUnsafe(width * height * (colorType === 2 || colorType === 6 ? 3 : 4));
  const outputChannels = colorType === 2 || colorType === 6 ? 3 : 4;
  const previous = Buffer.alloc(rowBytes);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++]!;
    const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + rowBytes)); sourceOffset += rowBytes;
    unfilterPngRow(row, previous, filter, channels);
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const target = (y * width + x) * outputChannels;
      if (colorType === 0) { const value = row[source]!; raw[target] = value; raw[target + 1] = value; raw[target + 2] = value; }
      else if (colorType === 2) row.copy(raw, target, source, source + 3);
      else if (colorType === 4) { const value = row[source]!; raw[target] = value; raw[target + 1] = value; raw[target + 2] = value; raw[target + 3] = row[source + 1]!; }
      else row.copy(raw, target, source, source + 4);
    }
    row.copy(previous);
  }
  return normalizeImage({ data: raw, metadata: { width, height, channels: outputChannels as 3 | 4, pixelFormat: outputChannels === 3 ? "rgb" : "rgba", sourceFormat: "raw", origin: metadata?.origin ?? { x: 0, y: 0 }, scaleX: metadata?.scaleX, scaleY: metadata?.scaleY } });
}

function unfilterPngRow(row: Buffer, previous: Buffer, filter: number, bpp: number): void {
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp]! : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? previous[i - bpp]! : 0;
    if (filter === 1) row[i] = (row[i]! + left) & 255;
    else if (filter === 2) row[i] = (row[i]! + up) & 255;
    else if (filter === 3) row[i] = (row[i]! + Math.floor((left + up) / 2)) & 255;
    else if (filter === 4) row[i] = (row[i]! + paeth(left, up, upLeft)) & 255;
    else if (filter !== 0) throw new ComputerUseError({ code: "INVALID_IMAGE", message: `Unsupported PNG filter: ${filter}`, retryable: false });
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

