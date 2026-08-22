import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clientToScreenPhysical,
  CoordinateMapper,
  logicalToPhysicalPoint,
  physicalToLogicalPoint,
  regionToScreenPhysical,
  screenToClientPhysical,
} from "../src/tools/computer-use/coordinates.ts";
import {
  createOwnedPngArtifact,
  detectBlankFrame,
  inspectPng,
} from "../src/tools/computer-use/artifacts.ts";
import { ComputerUseError, isComputerUseError } from "../src/tools/computer-use/types.ts";
import { WAYLAND_RESTRICTED, assertCapability, waylandCapabilities, waylandRestrictedError } from "../src/tools/computer-use/platform/index.ts";

const ONE_BY_ONE_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

test("coordinate transforms preserve Windows DPI, negative origins, and round trips", () => {
  const transform = {
    logicalOrigin: { x: -1920, y: 20 },
    physicalOrigin: { x: -2560, y: 25 },
    logicalToPhysicalScale: 0.75,
  };
  const physical = logicalToPhysicalPoint({ x: -1800, y: 170 }, transform);
  assert.deepEqual(physical, { x: -2400, y: 225 });
  assert.deepEqual(physicalToLogicalPoint(physical, transform), { x: -1800, y: 170 });

  const retina = { logicalOrigin: { x: 0, y: 0 }, physicalOrigin: { x: -2560, y: 0 }, logicalToPhysicalScale: 0.5 };
  assert.deepEqual(logicalToPhysicalPoint({ x: 100, y: 40 }, retina), { x: -2360, y: 80 });
  assert.deepEqual(physicalToLogicalPoint({ x: -2360, y: 80 }, retina), { x: 100, y: 40 });
});

test("client and region coordinates use physical origins rather than frame bounds", () => {
  assert.deepEqual(clientToScreenPhysical({ x: 12, y: 8 }, { x: -100, y: 40 }), { x: -88, y: 48 });
  assert.deepEqual(screenToClientPhysical({ x: -88, y: 48 }, { x: -100, y: 40 }), { x: 12, y: 8 });
  assert.deepEqual(regionToScreenPhysical({ x: -1920, y: 300 }, { x: 5, y: 7 }), { x: -1915, y: 307 });
  const mapper = new CoordinateMapper({ displays: [{ id: "retina", ...retinaDisplay() }] });
  assert.deepEqual(mapper.logicalToPhysical({ x: 20, y: 10 }, "retina"), { x: -2520, y: 20 });
});

function retinaDisplay() {
  return { logicalOrigin: { x: 0, y: 0 }, physicalOrigin: { x: -2560, y: 0 }, logicalToPhysicalScale: 0.5 };
}

test("Wayland capability reporting is structured and fail-closed", () => {
  const capabilities = waylandCapabilities();
  assert.equal(capabilities.features.input?.errorCode, "WAYLAND_RESTRICTED");
  assert.equal(WAYLAND_RESTRICTED.state, "restricted");
  assert.throws(() => assertCapability(capabilities, "input"), (error: unknown) => {
    assert.ok(error instanceof ComputerUseError);
    assert.equal((error as ComputerUseError).code, "WAYLAND_RESTRICTED");
    return true;
  });
  assert.equal(waylandRestrictedError("window_list").toJSON().code, "WAYLAND_RESTRICTED");
});

test("typed computer-use errors carry a serializable diagnostic envelope", () => {
  const error = new ComputerUseError({ code: "CAPTURE_RESTRICTED", message: "protected frame", retryable: false, remediation: "use an unprotected window" });
  assert.equal(isComputerUseError(error), true);
  assert.deepEqual(error.toJSON(), {
    code: "CAPTURE_RESTRICTED",
    message: "protected frame",
    retryable: false,
    remediation: "use an unprotected window",
  });
});

test("owned PNG artifacts are bounded, owner-only, and cleaned up", async () => {
  const root = await mkdtemp(join(tmpdir(), "computer-use-contract-test-"));
  const artifact = await createOwnedPngArtifact(ONE_BY_ONE_PNG, { directory: root, maxWidth: 2, maxHeight: 2 });
  const info = await stat(artifact.path);
  assert.ok(process.platform === "win32" || (info.mode & 0o777) === 0o600);
  assert.equal(artifact.width, 1);
  assert.equal(artifact.height, 1);
  assert.equal(detectBlankFrame(ONE_BY_ONE_PNG).blank, true);
  await artifact.cleanup();
  await assert.rejects(stat(artifact.path), { code: "ENOENT" });
});

test("PNG validation rejects malformed and oversized frames before decoding", () => {
  assert.throws(() => inspectPng(Uint8Array.of(1, 2, 3)), (error: unknown) => {
    assert.ok(error instanceof ComputerUseError);
    assert.equal((error as ComputerUseError).code, "INVALID_IMAGE");
    return true;
  });
  assert.throws(() => inspectPng(ONE_BY_ONE_PNG, { maxBytes: 4 }), /exceeds/);
});
