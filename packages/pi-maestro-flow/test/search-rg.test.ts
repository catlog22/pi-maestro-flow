import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFff } from "../src/tools/fff.ts";
import { runRgSearch, type RgSearchResult } from "../src/tools/search-rg.ts";
import { SEARCH_OUTPUT_MAX_BYTES } from "../src/tools/search-output.ts";

const engineNote = "\n\n[engine: rg (workspace-root search)]";

function harness() {
  let observed: RgSearchResult | undefined;
  const handle = registerFff({ registerTool() {}, on() {} } as unknown as ExtensionAPI, {
    createFinder() { throw new Error("root-wide search must use RG"); },
    async runRg(request) {
      observed = await runRgSearch(request);
      return observed;
    },
  });
  return { handle, observed: () => observed! };
}

test("RG bounds huge first matches, context, moderate aggregates, and Unicode at the final tool boundary", async (t) => {
  const cases = [
    { name: "huge first matching line", lines: ["needle" + "x".repeat(100_000)], limit: 1 },
    { name: "huge before context", lines: ["x".repeat(100_000), "needle"], context: 1 },
    { name: "huge after context", lines: ["needle", "x".repeat(100_000)], context: 1 },
    { name: "many moderate lines", lines: Array.from({ length: 100 }, () => "needle" + "x".repeat(800)) },
    { name: "Unicode", lines: ["needle" + "中🙂é".repeat(20_000)] },
  ];
  for (const fixture of cases) await t.test(fixture.name, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rg-byte-"));
    try {
      await writeFile(join(root, "a.txt"), fixture.lines.join("\n") + "\n");
      const { handle, observed } = harness();
      const result = await handle.search({ pattern: "needle", limit: fixture.limit ?? 1000, context: fixture.context ?? 0 }, root);
      const raw = observed();
      const body = fixture.lines.map((line, index) => line.includes("needle")
        ? `a.txt:${index + 1}: ${line}` : `a.txt-${index + 1}- ${line}`).join("\n");
      assert.equal(raw.originalBytes, Buffer.byteLength(body, "utf8"));
      assert.ok(Buffer.byteLength(raw.text, "utf8") <= SEARCH_OUTPUT_MAX_BYTES, "RG row retention is bounded before final formatting");
      assert.equal(raw.limitReached, fixture.limit === 1, "byte clipping must not stop matching/counting early");
      assert.equal(raw.timedOut, false);
      const note = fixture.limit === 1
        ? "\n\n[engine: rg (workspace-root search); 1 matches limit reached — refine the pattern or raise limit]"
        : engineNote;
      const details = result.details as Record<string, unknown>;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      assert.ok(Buffer.byteLength(text, "utf8") <= SEARCH_OUTPUT_MAX_BYTES);
      assert.equal(details.originalBytes, Buffer.byteLength(body + note, "utf8"));
      assert.equal(details.returnedBytes, Buffer.byteLength(text, "utf8"));
      assert.equal(details.maxBytes, SEARCH_OUTPUT_MAX_BYTES);
      assert.equal(details.byteTruncated, true);
      assert.equal(details.truncated, true);
      assert.equal(details.engine, "rg");
      assert.match(text, /engine: rg/);
      assert.match(text, /Output byte truncation/);
      assert.match(text, /read on an existing matched file with bounded offset\/limit/);
      assert.ok(!text.includes("\ufffd"));
      if (fixture.limit === 1) assert.match(text, /1 matches limit reached/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("RG byte clipping leaves count and files aggregation intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rg-byte-files-"));
  try {
    const names = Array.from({ length: 530 }, (_, index) => `${index}-${"a".repeat(100)}.txt`);
    await Promise.all(names.map((name) => writeFile(join(root, name), "needle\nneedle\n")));
    for (const output of ["count", "files"] as const) {
      const { handle, observed } = harness();
      const result = await handle.search({ pattern: "needle", output, limit: 1000 }, root);
      const raw = observed();
      const body = names.map((name) => output === "count" ? `${name}:2` : name).join("\n");
      assert.equal(raw.originalBytes, Buffer.byteLength(body, "utf8"));
      assert.equal(raw.limitReached, false);
      assert.equal(raw.timedOut, false);
      assert.ok(Buffer.byteLength(raw.text, "utf8") <= SEARCH_OUTPUT_MAX_BYTES);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as Record<string, unknown>;
      assert.ok(Buffer.byteLength(text, "utf8") <= SEARCH_OUTPUT_MAX_BYTES);
      assert.equal(details.originalBytes, Buffer.byteLength(body + engineNote, "utf8"));
      assert.equal(details.returnedBytes, Buffer.byteLength(text, "utf8"));
      assert.equal(details.byteTruncated, true);
      assert.match(text, /Output byte truncation/);
      assert.doesNotMatch(text, /limit reached|timed out/);
      if (output === "count") assert.match(text, /^\d+-a+\.txt:2\n/);
      else assert.match(text, /^\d+-a+\.txt\n/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("small RG results retain exact text and byte metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rg-small-"));
  try {
    await writeFile(join(root, "a.txt"), "needle\nneedle\n");
    for (const output of ["lines", "count", "files"] as const) {
      const { handle } = harness();
      const result = await handle.search({ pattern: "needle", output, limit: 1000 }, root);
      const body = output === "lines" ? "a.txt:1: needle\na.txt:2: needle" : output === "count" ? "a.txt:2" : "a.txt";
      const text = body + engineNote;
      assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", text);
      const details = result.details as Record<string, unknown>;
      assert.equal(details.byteTruncated, false);
      assert.equal(details.truncated, false);
      assert.equal(details.originalBytes, Buffer.byteLength(text, "utf8"));
      assert.equal(details.returnedBytes, details.originalBytes);
      assert.equal(details.maxBytes, SEARCH_OUTPUT_MAX_BYTES);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
