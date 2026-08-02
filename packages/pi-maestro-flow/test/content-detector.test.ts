import assert from "node:assert/strict";
import test from "node:test";
import { detectContentType } from "../src/compaction/content-detector.ts";

test("detects JSON arrays and objects", () => {
  assert.equal(detectContentType('[{"id": 1}, {"id": 2}]').contentType, "json_array");
  assert.equal(detectContentType('{"name": "x", "items": [1, 2]}').contentType, "json_array");
});

test("detects concatenated web-search JSON objects", () => {
  const result = detectContentType('{"title": "a"} {"title": "b"} {"title": "c"}');
  assert.equal(result.contentType, "json_array");
  assert.equal(result.metadata.concatenated, true);
});

test("detects unified diffs including merge-commit headers", () => {
  assert.equal(detectContentType("diff --git a/x.ts b/x.ts\n@@ -1,3 +1,4 @@\n+line\n").contentType, "diff");
  assert.equal(detectContentType("diff --cc a/x.ts\n@@@ -1,1 -1,1 +1,2 @@@\n").contentType, "diff");
});

test("detects HTML from structural signals", () => {
  const html = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>t</title></head>",
    "<body><div>a</div><div>b</div><div>c</div></body></html>",
  ].join("\n");
  assert.equal(detectContentType(html).contentType, "html");
});

test("detects grep-style search output", () => {
  const content = [
    "src/a.ts:42:const x = 1",
    "src/b.ts:7:const y = 2",
    "src/c.ts:9:const z = 3",
    "src/d.ts:11:const w = 4",
  ].join("\n");
  assert.equal(detectContentType(content).contentType, "search");
});

test("detects build/log output with error signals", () => {
  const content = [
    "ERROR: something failed",
    "WARN: deprecation",
    "INFO: started",
    "Traceback (most recent call last):",
    "  File \"x.py\", line 1",
    "ValueError: bad",
    "npm ERR! code ENOENT",
  ].join("\n");
  assert.equal(detectContentType(content).contentType, "build");
});

test("detects markdown tables and delimited tabular data", () => {
  const md = "| name | value |\n| --- | --- |\n| a | 1 |\n| b | 2 |";
  assert.equal(detectContentType(md).contentType, "tabular");
  const csv = "name,value\nalpha,1\nbeta,2\ngamma,3";
  assert.equal(detectContentType(csv).contentType, "tabular");
});

test("detects YAML and section config", () => {
  const yaml = "name: app\nversion: 1.0\nreplicas: 3\nenv:\n  - prod";
  assert.equal(detectContentType(yaml).contentType, "structured_config");
  const toml = "[server]\nhost = \"0.0.0.0\"\nport = 8080\n[tls]\nenabled = true";
  assert.equal(detectContentType(toml).contentType, "structured_config");
});

test("detects source code with language metadata", () => {
  const code = [
    "def handler(request):",
    "    import json",
    "    @app.route('/x')",
    "    return json.dumps({})",
    '    """docstring"""',
  ].join("\n");
  const result = detectContentType(code);
  assert.equal(result.contentType, "source_code");
  assert.equal(result.metadata.language, "python");
});

test("falls back to plain text", () => {
  assert.equal(detectContentType("just some ordinary words here").contentType, "text");
  assert.equal(detectContentType("").contentType, "text");
});
