import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SopLoader, SopLoadError } from "../src/tools/sop/sop-loader.ts";

const SOP_DOC = `---
title: Browser SOP — Mode choice, attach, Turnstile recipe
type: recipe
tools: [browser]
sop_topic: core
sop_order: 0
category: browser-sop
created: 2026-08-24T00:00:00Z
tags: [browser, sop]
---

# Mode choice

Body line 1.
`;

async function withKnowhowDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-sop-loader-"));
  const dir = join(root, ".workflow", "knowhow");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return root;
}

test("SopLoader loadAll returns SOP docs with frontmatter fields parsed", async () => {
  const root = await withKnowhowDir({ "RCP-20260824-browser-core.md": SOP_DOC });
  try {
    const loader = new SopLoader({ cwd: root });
    const docs = await loader.loadAll();
    assert.equal(docs.length, 1);
    const doc = docs[0];
    assert.equal(doc.tool, "browser");
    assert.equal(doc.topic, "core");
    assert.equal(doc.title, "Browser SOP — Mode choice, attach, Turnstile recipe");
    assert.equal(doc.order, 0);
    assert.equal(doc.source, "knowhow");
    assert.match(doc.filePath ?? "", /RCP-20260824-browser-core\.md$/);
    assert.equal(doc.body.startsWith("# Mode choice"), true);
    assert.equal(doc.contentHash.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopLoader skips knowhow files without sop_topic or tools", async () => {
  const root = await withKnowhowDir({
    "TIP-with-sop.md": `---
title: Has SOP
type: recipe
tools: [browser]
sop_topic: with-sop
---

Body
`,
    "TIP-without-sop.md": `---
title: No SOP fields
type: tip
---

Body
`,
    "TIP-sop-no-tools.md": `---
title: SOP topic but no tools
type: recipe
sop_topic: orphan
---

Body
`,
    "TIP-tools-no-topic.md": `---
title: Tools but no topic
type: recipe
tools: [browser]
---

Body
`,
  });
  try {
    const loader = new SopLoader({ cwd: root });
    const docs = await loader.loadAll();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].topic, "with-sop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopLoader supports multiple tools and topics", async () => {
  const root = await withKnowhowDir({
    "RCP-browser.md": `---
title: B
type: recipe
tools: [browser]
sop_topic: core
---
B body
`,
    "RCP-computer.md": `---
title: C
type: recipe
tools: [computer_use]
sop_topic: coordinates
---
C body
`,
    "RCP-multi-tool.md": `---
title: M
type: recipe
tools: [browser, computer_use]
sop_topic: shared
---
M body
`,
  });
  try {
    const loader = new SopLoader({ cwd: root });
    const docs = await loader.loadAll();
    // multi-tool doc attaches to the first tool (browser) per the loader contract.
    assert.equal(docs.length, 3);
    const tools = docs.map((d) => d.tool).sort();
    assert.deepEqual(tools, ["browser", "browser", "computer_use"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopLoader caches reads by stat version key (second call is a hit)", async () => {
  const root = await withKnowhowDir({ "RCP-20260824-x.md": SOP_DOC });
  try {
    const loader = new SopLoader({ cwd: root });
    await loader.loadAll();
    const afterFirst = { ...loader.cacheStats };
    await loader.loadAll();
    const afterSecond = { ...loader.cacheStats };
    assert.ok(afterSecond.hits >= afterFirst.hits + 1, "second loadAll should hit the raw cache");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopLoader tolerate single-string tools field (YAML scalar)", async () => {
  const root = await withKnowhowDir({
    "RCP-scalar.md": `---
title: Scalar tools
type: recipe
tools: browser
sop_topic: scalar
---
Body
`,
  });
  try {
    const loader = new SopLoader({ cwd: root });
    const docs = await loader.loadAll();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].tool, "browser");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopLoader falls back to filename stem when title is missing", async () => {
  const root = await withKnowhowDir({
    "RCP-20260824-no-title.md": `---
type: recipe
tools: [browser]
sop_topic: no-title
---
Body
`,
  });
  try {
    const loader = new SopLoader({ cwd: root });
    const docs = await loader.loadAll();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].title, "RCP-20260824-no-title");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopLoader loadFile rejects oversized files with E_SOP_FILE_TOO_LARGE (loadAll swallows per-file errors)", async () => {
  const root = await withKnowhowDir({
    "RCP-big.md": `---
title: Big
type: recipe
tools: [browser]
sop_topic: big
---
${"x".repeat(200)}
`,
  });
  try {
    const loader = new SopLoader({ cwd: root, maxFileBytes: 120 });
    // loadAll is resilient: a per-file error is swallowed so one bad file does not break the registry.
    const docs = await loader.loadAll();
    assert.equal(docs.length, 0);
    // loadFile surfaces the error directly for callers that want strict behavior.
    await assert.rejects(
      () => loader.loadFile(join(root, ".workflow", "knowhow", "RCP-big.md")),
      (error: unknown) => {
        assert.ok(error instanceof SopLoadError);
        assert.equal(error.code, "E_SOP_FILE_TOO_LARGE");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopLoader returns empty array when knowhow dir does not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sop-empty-"));
  try {
    const loader = new SopLoader({ cwd: root });
    const docs = await loader.loadAll();
    assert.deepEqual(docs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopLoader swallows single corrupt file but reads the rest", async () => {
  const root = await withKnowhowDir({
    "RCP-good.md": SOP_DOC,
    "RCP-bad.md": "this has no frontmatter at all and should be skipped",
  });
  try {
    const loader = new SopLoader({ cwd: root });
    const docs = await loader.loadAll();
    // The bad file has no frontmatter; parseFrontmatter treats the whole content
    // as body, so frontmatter.tools is undefined -> skipped. Good doc survives.
    assert.equal(docs.length, 1);
    assert.equal(docs[0].topic, "core");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
