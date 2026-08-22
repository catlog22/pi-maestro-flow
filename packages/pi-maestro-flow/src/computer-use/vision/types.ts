import { createHash } from "node:crypto";

export type ImagePixelFormat = "gray" | "rgb" | "rgba";
export type ImageSourceFormat = "raw" | "png" | "jpeg" | "webp" | "gif" | "unknown";
export type BBox = [number, number, number, number];

export interface ImageMetadata {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  pixelFormat?: ImagePixelFormat;
  sourceFormat?: ImageSourceFormat;
  /** Scale from the input buffer's pixel coordinates to physical screenshot coordinates. */
  scaleX?: number;
  scaleY?: number;
}

export interface VisionImage {
  readonly data: Buffer;
  readonly metadata: Readonly<ImageMetadata>;
}

export type VisionImageInput = VisionImage | { data: Buffer | Uint8Array; metadata: ImageMetadata };

export interface ImageLimits {
  maxBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
}

export const DEFAULT_IMAGE_LIMITS: Required<ImageLimits> = {
  maxBytes: 16 * 1024 * 1024,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 16_777_216,
};

export function normalizeImage(input: VisionImageInput, limits: ImageLimits = {}): VisionImage {
  const image: VisionImage = {
    data: Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data),
    metadata: { ...input.metadata },
  };
  assertImageWithinBounds(image, limits);
  return image;
}

export function assertImageWithinBounds(image: VisionImage, limits: ImageLimits = {}): void {
  const merged = { ...DEFAULT_IMAGE_LIMITS, ...limits };
  const { width, height, channels } = image.metadata;
  if (!Number.isInteger(width) || width < 1 || width > merged.maxWidth) throw new RangeError("image width exceeds configured bounds");
  if (!Number.isInteger(height) || height < 1 || height > merged.maxHeight) throw new RangeError("image height exceeds configured bounds");
  if (!Number.isInteger(channels) || !([1, 3, 4] as number[]).includes(channels)) throw new RangeError("image channels must be 1, 3, or 4");
  if (width * height > merged.maxPixels) throw new RangeError("image pixel count exceeds configured bounds");
  if (image.data.byteLength > merged.maxBytes) throw new RangeError("image buffer exceeds configured bounds");
  if (image.metadata.sourceFormat === "raw" && image.data.byteLength < width * height * channels) {
    throw new RangeError("raw image buffer is smaller than its declared dimensions");
  }
}

export function imageFingerprint(image: VisionImage): string {
  return createHash("sha256").update(image.data).digest("hex");
}

export function clampBox(box: BBox, width: number, height: number): BBox {
  const x1 = Math.max(0, Math.min(width, box[0]));
  const y1 = Math.max(0, Math.min(height, box[1]));
  const x2 = Math.max(x1, Math.min(width, box[2]));
  const y2 = Math.max(y1, Math.min(height, box[3]));
  return [x1, y1, x2, y2];
}

export function mapBoundingBox(box: BBox, from: ImageMetadata, to: ImageMetadata): BBox {
  return clampBox([
    box[0] * to.width / from.width,
    box[1] * to.height / from.height,
    box[2] * to.width / from.width,
    box[3] * to.height / from.height,
  ], to.width, to.height);
}

export function cropImage(image: VisionImage, box: BBox): VisionImage {
  if (image.metadata.sourceFormat !== "raw") throw new Error("cropImage requires raw pixel input");
  const clipped = clampBox(box, image.metadata.width, image.metadata.height).map(Math.floor) as BBox;
  const [x1, y1, x2, y2] = clipped;
  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);
  const channels = image.metadata.channels;
  const rowBytes = width * channels;
  const data = Buffer.allocUnsafe(rowBytes * height);
  const sourceRowBytes = image.metadata.width * channels;
  for (let row = 0; row < height; row++) {
    image.data.copy(data, row * rowBytes, (y1 + row) * sourceRowBytes + x1 * channels, (y1 + row) * sourceRowBytes + x1 * channels + rowBytes);
  }
  return normalizeImage({ data, metadata: { ...image.metadata, width, height, sourceFormat: "raw" } });
}
