import { ComputerUseError, type DisplayInfo, type PhysicalPoint, type PhysicalRect } from "./types.ts";

export interface DisplayTransform {
  id?: string;
  /** Origin in platform logical coordinates. */
  logicalOrigin: PhysicalPoint;
  /** Origin in the public physical screen coordinate space. */
  physicalOrigin: PhysicalPoint;
  /** logical pixels / physical pixels; Windows DPI and macOS Retina use this. */
  logicalToPhysicalScale?: number;
  /** Short alias for logicalToPhysicalScale. */
  scale?: number;
  bounds?: PhysicalRect;
}

export interface WindowClientTransform {
  /** Client origin in public physical screen coordinates. */
  screenOrigin: PhysicalPoint;
  /** Optional platform logical origin; when present it is converted using scale. */
  logicalOrigin?: PhysicalPoint;
  logicalToPhysicalScale?: number;
}

export interface CoordinateMapperOptions {
  displays?: readonly DisplayTransform[];
  defaultDisplay?: DisplayTransform;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new ComputerUseError({
    code: "INVALID_COORDINATE",
    message: `${label} must be finite`,
    retryable: false,
  });
  return value;
}

function scaleOf(transform: Pick<DisplayTransform, "logicalToPhysicalScale" | "scale">): number {
  const scale = finite(transform.logicalToPhysicalScale ?? transform.scale ?? Number.NaN, "logicalToPhysicalScale");
  if (scale <= 0) throw new ComputerUseError({
    code: "INVALID_COORDINATE",
    message: "logicalToPhysicalScale must be greater than zero",
    retryable: false,
  });
  return scale;
}

function point(point: PhysicalPoint, label: string): PhysicalPoint {
  return { x: finite(point.x, `${label}.x`), y: finite(point.y, `${label}.y`) };
}

/** Convert a platform logical screen point to physical pixels on one display. */
export function logicalToPhysicalPoint(value: PhysicalPoint, transform: DisplayTransform): PhysicalPoint {
  const source = point(value, "logicalPoint");
  const logicalOrigin = point(transform.logicalOrigin, "logicalOrigin");
  const physicalOrigin = point(transform.physicalOrigin, "physicalOrigin");
  const scale = scaleOf(transform);
  return {
    x: physicalOrigin.x + (source.x - logicalOrigin.x) / scale,
    y: physicalOrigin.y + (source.y - logicalOrigin.y) / scale,
  };
}

/** Convert a physical screen point to platform logical coordinates on one display. */
export function physicalToLogicalPoint(value: PhysicalPoint, transform: DisplayTransform): PhysicalPoint {
  const source = point(value, "physicalPoint");
  const logicalOrigin = point(transform.logicalOrigin, "logicalOrigin");
  const physicalOrigin = point(transform.physicalOrigin, "physicalOrigin");
  const scale = scaleOf(transform);
  return {
    x: logicalOrigin.x + (source.x - physicalOrigin.x) * scale,
    y: logicalOrigin.y + (source.y - physicalOrigin.y) * scale,
  };
}

/** Explicit aliases used by platform adapters and callers that name the direction. */
export const screenPhysicalFromLogical = logicalToPhysicalPoint;
export const logicalFromScreenPhysical = physicalToLogicalPoint;

/** Convert a client/image-relative point to an absolute physical screen point. */
export function clientToScreenPhysical(clientPoint: PhysicalPoint, clientOrigin: PhysicalPoint): PhysicalPoint {
  const value = point(clientPoint, "clientPoint");
  const origin = point(clientOrigin, "clientOrigin");
  return { x: origin.x + value.x, y: origin.y + value.y };
}

export function screenToClientPhysical(screenPoint: PhysicalPoint, clientOrigin: PhysicalPoint): PhysicalPoint {
  const value = point(screenPoint, "screenPoint");
  const origin = point(clientOrigin, "clientOrigin");
  return { x: value.x - origin.x, y: value.y - origin.y };
}

export const windowClientToScreenPhysical = clientToScreenPhysical;
export const screenToWindowClientPhysical = screenToClientPhysical;

/** Convert a point in a captured region to screen physical coordinates. */
export function regionToScreenPhysical(regionOrigin: PhysicalPoint, regionPoint: PhysicalPoint): PhysicalPoint {
  return clientToScreenPhysical(regionPoint, regionOrigin);
}

export const imageToScreenPhysical = regionToScreenPhysical;

export function translateRect(rect: PhysicalRect, offset: PhysicalPoint): PhysicalRect {
  const value = point({ x: rect.x, y: rect.y }, "rect");
  const size = { width: finite(rect.width, "rect.width"), height: finite(rect.height, "rect.height") };
  const moved = point(offset, "offset");
  if (size.width < 0 || size.height < 0) throw new ComputerUseError({
    code: "INVALID_COORDINATE",
    message: "rect width and height must not be negative",
    retryable: false,
  });
  return { x: value.x + moved.x, y: value.y + moved.y, ...size };
}

export function clientRectToScreenPhysical(rect: PhysicalRect, clientOrigin: PhysicalPoint): PhysicalRect {
  return translateRect(rect, clientOrigin);
}

export function regionRectToScreenPhysical(rect: PhysicalRect, regionOrigin: PhysicalPoint): PhysicalRect {
  return translateRect(rect, regionOrigin);
}

export function logicalToPhysicalRect(rect: PhysicalRect, transform: DisplayTransform): PhysicalRect {
  const topLeft = logicalToPhysicalPoint({ x: rect.x, y: rect.y }, transform);
  const scale = scaleOf(transform);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}

export function physicalToLogicalRect(rect: PhysicalRect, transform: DisplayTransform): PhysicalRect {
  const topLeft = physicalToLogicalPoint({ x: rect.x, y: rect.y }, transform);
  const scale = scaleOf(transform);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

export function roundPhysicalPoint(value: PhysicalPoint): PhysicalPoint {
  return { x: Math.round(finite(value.x, "point.x")), y: Math.round(finite(value.y, "point.y")) };
}

export function roundPhysicalRect(value: PhysicalRect): PhysicalRect {
  return {
    x: Math.round(finite(value.x, "rect.x")),
    y: Math.round(finite(value.y, "rect.y")),
    width: Math.max(0, Math.round(finite(value.width, "rect.width"))),
    height: Math.max(0, Math.round(finite(value.height, "rect.height"))),
  };
}

/** A pure mapper that keeps mixed-display transforms explicit. */
export class CoordinateMapper {
  readonly displays: readonly DisplayTransform[];
  readonly defaultDisplay?: DisplayTransform;

  constructor(options: CoordinateMapperOptions | readonly DisplayTransform[] = {}) {
    const resolved: CoordinateMapperOptions = Array.isArray(options)
      ? { displays: options as readonly DisplayTransform[] }
      : options as CoordinateMapperOptions;
    this.displays = resolved.displays ?? [];
    this.defaultDisplay = resolved.defaultDisplay ?? this.displays[0];
  }

  logicalToPhysical(value: PhysicalPoint, displayId?: string): PhysicalPoint {
    return logicalToPhysicalPoint(value, this.display(displayId));
  }

  physicalToLogical(value: PhysicalPoint, displayId?: string): PhysicalPoint {
    return physicalToLogicalPoint(value, this.display(displayId));
  }

  clientToScreen(value: PhysicalPoint, clientOrigin: PhysicalPoint): PhysicalPoint {
    return clientToScreenPhysical(value, clientOrigin);
  }

  screenToClient(value: PhysicalPoint, clientOrigin: PhysicalPoint): PhysicalPoint {
    return screenToClientPhysical(value, clientOrigin);
  }

  logicalToScreenPhysical(value: PhysicalPoint, displayId?: string): PhysicalPoint {
    return this.logicalToPhysical(value, displayId);
  }

  screenPhysicalToLogical(value: PhysicalPoint, displayId?: string): PhysicalPoint {
    return this.physicalToLogical(value, displayId);
  }

  regionToScreen(value: PhysicalPoint, regionOrigin: PhysicalPoint): PhysicalPoint {
    return regionToScreenPhysical(regionOrigin, value);
  }

  private display(displayId?: string): DisplayTransform {
    const display = displayId === undefined
      ? this.defaultDisplay
      : this.displays.find((candidate) => candidate.id === displayId);
    if (!display) throw new ComputerUseError({
      code: "INVALID_COORDINATE",
      message: displayId ? `Unknown display: ${displayId}` : "No display transform is configured",
      retryable: false,
    });
    return display;
  }
}

export function displayTransformFromInfo(display: DisplayInfo): DisplayTransform {
  return {
    id: display.id,
    logicalOrigin: display.logicalOrigin ?? { x: 0, y: 0 },
    physicalOrigin: { x: display.bounds.x, y: display.bounds.y },
    logicalToPhysicalScale: display.logicalToPhysicalScale,
    scale: display.scale,
    bounds: display.bounds,
  };
}

/** Convert a logical client origin while retaining negative monitor coordinates. */
export function logicalClientOriginToPhysical(origin: PhysicalPoint, scale: number): PhysicalPoint {
  return logicalToPhysicalPoint(origin, {
    logicalOrigin: { x: 0, y: 0 },
    physicalOrigin: { x: 0, y: 0 },
    logicalToPhysicalScale: scale,
  });
}
