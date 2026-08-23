import assert from "node:assert/strict";
import test from "node:test";
import {
  isLocalVisionError,
  resetLocalVisionCache,
  runDetect,
  runOcr,
  setLocalVisionService,
  type BrowserVisionService,
} from "../src/providers/local-vision.ts";

test("local vision facade adapts PNG bytes with browser origin and preserves OCR compatibility", async () => {
  let seen: { input: any; options: any } | undefined;
  const fake: BrowserVisionService = {
    async ocr(input, options) {
      seen = { input, options };
      return {
        text: "outside\ninside",
        lines: [
          { bbox: [0, 0, 20, 10], text: "outside", confidence: 0.4 },
          { bbox: [30, 20, 80, 45], text: "inside", confidence: 0.9 },
        ],
        engine: "rapidocr",
        width: 100,
        height: 60,
      };
    },
    async detect() {
      return { ok: false, code: "MODEL_PROVENANCE_UNVERIFIED", diagnostic: "verified OmniParser artifact is unavailable", engine: "omniparser" };
    },
  };
  setLocalVisionService(fake);
  try {
    const outcome = await runOcr(Buffer.from("png"), 100, 60, { x: 25, y: 15, w: 60, h: 40 }, "eng+chi_sim");
    assert.equal(isLocalVisionError(outcome), false);
    if (!isLocalVisionError(outcome)) {
      assert.deepEqual(outcome.lines.map((line) => line.text), ["inside"]);
      assert.equal(outcome.text, "inside");
      assert.equal(outcome.engine, "rapidocr");
    }
    assert.deepEqual(seen?.input.metadata.origin, { x: 0, y: 0 });
    assert.equal(seen?.input.metadata.sourceFormat, "png");
    assert.equal(seen?.input.data.toString(), "png");
    assert.deepEqual(seen?.options.langs, ["eng", "chi_sim"]);
  } finally {
    setLocalVisionService(undefined);
    await resetLocalVisionCache();
  }
});

test("local vision facade preserves mode and translates fail-closed detection diagnostics", async () => {
  let seenMode: unknown;
  const fake: BrowserVisionService = {
    async ocr() { return { text: "", lines: [], engine: "rapidocr", width: 1, height: 1 }; },
    async detect(_input, options) {
      seenMode = options?.mode;
      return { ok: false, code: "MODEL_PROVENANCE_UNVERIFIED", diagnostic: "MODEL_PROVENANCE_UNVERIFIED", engine: "omniparser" };
    },
  };
  setLocalVisionService(fake);
  try {
    const outcome = await runDetect(Buffer.from("png"), 1, 1, "crop");
    assert.equal(seenMode, "crop");
    assert.equal(isLocalVisionError(outcome), true);
    if (isLocalVisionError(outcome)) {
      assert.equal(outcome.engine, "omniparser");
      assert.match(outcome.error, /MODEL_PROVENANCE_UNVERIFIED/);
      assert.match(outcome.hint, /fail-closed|verified model/i);
    }
  } finally {
    setLocalVisionService(undefined);
    await resetLocalVisionCache();
  }
});

test("browser vision import boundary excludes desktop adapters", async () => {
  const { readFile } = await import("node:fs/promises");
  const sources = await Promise.all([
    readFile(new URL("../src/providers/local-vision.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/tools/browser/manager.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(sources[0]!, /(?:puppeteer|electron|@nut-tree)[^\n]*from/);
  assert.doesNotMatch(sources[0]!, /computer-use[\\/](?:platform|manager)/);
  assert.doesNotMatch(sources[1]!, /computer-use[\\/](?:platform|manager)/);
});
test("local vision facade reset does not retain an injected service", async () => {
  let calls = 0;
  setLocalVisionService({
    async ocr() { calls++; return { text: "", lines: [], engine: "rapidocr", width: 1, height: 1 }; },
    async detect() { return { ok: false, code: "MODEL_PROVENANCE_UNVERIFIED", diagnostic: "missing", engine: "omniparser" }; },
  });
  await runOcr(Buffer.from("png"), 1, 1);
  await resetLocalVisionCache();
  // The second call uses the production lazy service rather than the fake.
  const outcome = await runOcr(Buffer.from("png"), 1, 1);
  assert.equal(calls, 1);
  assert.equal(isLocalVisionError(outcome), true);
  await resetLocalVisionCache();
});
