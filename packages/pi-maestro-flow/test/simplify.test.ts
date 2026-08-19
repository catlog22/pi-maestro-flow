import assert from "node:assert/strict";
import test from "node:test";
import {
  validateProbeScripts,
  optimizeHtmlForTokens,
  smartTruncate,
  diffHtml,
  PROBE_JS,
  FIND_LISTS_JS,
  foldListsJs,
} from "../src/tools/browser/simplify.ts";

test("probe scripts parse as valid JavaScript (porting integrity guard)", () => {
  const result = validateProbeScripts();
  assert.equal(result.probe, true, `PROBE_JS failed to parse`);
  assert.equal(result.lists, true, `FIND_LISTS_JS failed to parse`);
  assert.equal(result.monitorStart, true, `MONITOR_START_JS failed to parse`);
  assert.equal(result.monitorStop, true, `MONITOR_STOP_JS failed to parse`);
  assert.equal(result.fold, true, `FOLD_JS failed to parse`);
});

test("probe scripts contain the ported detection markers", () => {
  // Guards against accidental deletion of core logic during edits.
  assert.match(PROBE_JS, /function optHTML\(\)/);
  assert.match(PROBE_JS, /cloneNode/);
  assert.match(PROBE_JS, /handleOverlayContainer/);
  assert.match(PROBE_JS, /handlePartitionContainer/);
  assert.match(PROBE_JS, /data-iframe-content/);
  assert.match(FIND_LISTS_JS, /function findMainList/);
  assert.match(FIND_LISTS_JS, /scoreContainer/);
  assert.match(foldListsJs({ html: "<ul></ul>", lists: [{ selector: "li" }], instruction: "" }), /FAKE ELEMENT/);
  assert.match(foldListsJs({ html: "<ul></ul>", lists: [{ selector: "li" }], instruction: "" }), /DOMParser/);
});

test("optimizeHtmlForTokens strips script/style/svg and prunes attributes", () => {
  const html = [
    `<div class="card" data-v-abc123 style="color:red" id="x">`,
    `<script>var x=1;</script>`,
    `<style>.a{color:red}</style>`,
    `<svg viewBox="0 0 1"><circle/></svg>`,
    `<a href="https://example.com/very/long/path/here">link</a>`,
    `<img src="data:image/png;base64,iVBORw0KG">`,
    `<input value="` + "x".repeat(120) + `">`,
    `</div>`,
  ].join("");
  const out = optimizeHtmlForTokens(html);
  assert.equal(out.includes("<script>"), false, "script tag must be stripped");
  assert.equal(out.includes("<style>"), false, "style tag must be stripped");
  assert.equal(out.includes("var x=1"), false, "script content must be gone");
  assert.equal(out.includes("<svg></svg>"), true, "svg collapsed to empty");
  assert.equal(out.includes('style="color:red"'), false, "style attr must be pruned");
  assert.equal(out.includes("data-v-abc123"), false, "data-v attr must be pruned");
  assert.equal(out.includes('href="__link__"'), true, "long href shortened to __link__");
  assert.equal(out.includes('src="__img__"'), true, "data: src shortened to __img__");
  // value longer than 100 chars truncated to 50 + " ..."
  assert.equal(out.includes("..."), true, "long value truncated");
  // kept attributes survive
  assert.equal(out.includes('class="card"'), true);
  assert.equal(out.includes('id="x"'), true);
});

test("optimizeHtmlForTokens preserves data-* attrs under 20 chars", () => {
  const html = `<div data-tag="iframe" data-long-id="` + "x".repeat(25) + `">x</div>`;
  const out = optimizeHtmlForTokens(html);
  assert.equal(out.includes('data-tag="iframe"'), true, "short data- kept");
  assert.equal(out.includes("data-long-id"), false, "long data- pruned");
});

test("smartTruncate returns input unchanged when within budget", () => {
  const html = "<div>short</div>";
  assert.equal(smartTruncate(html, 100), html);
});

test("smartTruncate pierces a single-child wrapper chain", () => {
  const child = `<p>` + "a".repeat(1000) + `</p>`;
  const html = `<div><section><article>${child}</article></section></div>`;
  const out = smartTruncate(html, 500);
  assert.ok(out.length <= 600, `output ~ within budget+marker, got ${out.length}`);
  assert.match(out, /TRUNCATED/);
  assert.equal(out.includes("section"), true, "wrapper tags preserved");
});

test("smartTruncate tail-cuts when top children cannot cover the overage", () => {
  const item = `<li>` + "x".repeat(50) + `</li>`;
  const html = `<ul>${item.repeat(20)}</ul>`;
  const out = smartTruncate(html, 200);
  assert.ok(out.length < html.length, "must shrink");
  assert.match(out, /<\/ul>$/);
});

test("smartTruncate proportional share marks truncation", () => {
  const a = `<div class="a">` + "a".repeat(2000) + `</div>`;
  const b = `<div class="b">` + "b".repeat(2000) + `</div>`;
  const html = `<main>${a}${b}</main>`;
  const out = smartTruncate(html, 2000);
  assert.ok(out.length < html.length);
  assert.match(out, /TRUNCATED/);
});

test("diffHtml reports zero changes for identical HTML", () => {
  const html = "<div><p>hello</p><span>world</span></div>";
  const diff = diffHtml(html, html);
  assert.equal(diff.changed, 0);
  assert.equal(diff.topChange, undefined);
});

test("diffHtml counts newly added elements (and their changed ancestors)", () => {
  const before = "<ul><li>a</li><li>b</li></ul>";
  const after = "<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>";
  const diff = diffHtml(before, after);
  // The <ul>'s direct text changes (ab → abcd), so its signature differs; plus
  // two new <li> elements. At least the two new items are detected.
  assert.ok(diff.changed >= 2, `expected >=2 changes, got ${diff.changed}`);
  assert.ok(diff.topChange, "topChange should be present for additions");
});

test("diffHtml surfaces the largest changed subtree", () => {
  const before = "<div><p>old short</p></div>";
  const after = "<div><section class=\"card\">" + "x".repeat(100) + "</section></div>";
  const diff = diffHtml(before, after);
  assert.ok(diff.changed >= 1);
  assert.match(diff.topChange ?? "", /section/);
});

test("diffHtml detects a text change in a kept element", () => {
  const before = "<div><p>a</p><p>b</p></div>";
  const after = "<div><p>x</p><p>b</p></div>";
  const diff = diffHtml(before, after);
  assert.ok(diff.changed >= 1, "should detect the changed <p>x</p>");
  assert.match(diff.topChange ?? "", /<p>x<\/p>/);
});

test("diffHtml counts the changed ancestor on a pure deletion", () => {
  // When an item is removed, its ancestor's direct text changes (ab → a), so the
  // ancestor's signature differs and is counted. The removed element itself is
  // not directly reported (afterSigs has no entry for it). This documents the
  // sig-diff semantics: deletions surface via changed ancestors, not as removed items.
  const before = "<ul><li>a</li><li>b</li></ul>";
  const after = "<ul><li>a</li></ul>";
  const diff = diffHtml(before, after);
  assert.ok(diff.changed >= 1, `deletion should surface via the changed <ul>, got ${diff.changed}`);
});

test("diffHtml truncates topChange beyond 2000 chars", () => {
  const before = "<div></div>";
  const after = `<div><section>${"x".repeat(2100)}</section></div>`;
  const diff = diffHtml(before, after);
  assert.ok(diff.topChange, "topChange present for a large addition");
  assert.ok(diff.topChange!.length <= 2100, `topChange should be truncated, got ${diff.topChange!.length}`);
  assert.match(diff.topChange!, /\.\.\.\[TRUNCATED\]$/);
});

test("optimizeHtmlForTokens handles empty input and long non-data attributes", () => {
  assert.equal(optimizeHtmlForTokens(""), "");
  const longUrl = '<img src="https://cdn.example.com/a/b/c.png">';
  assert.match(optimizeHtmlForTokens(longUrl), /__url__/);
  const longAction = '<form action="https://example.com/submit/very/long/path">';
  assert.match(optimizeHtmlForTokens(longAction), /__url__/);
  const longTitle = `<input title="${"t".repeat(120)}">`;
  assert.match(optimizeHtmlForTokens(longTitle), /\.\.\./);
});

test("smartTruncate hard-cuts leaf text with a marker", () => {
  const out = smartTruncate("x".repeat(5000), 100);
  assert.ok(out.length <= 120, `output near budget+marker, got ${out.length}`);
  assert.match(out, /TRUNCATED/);
});

test("smartTruncate returns input when budget is zero on empty input", () => {
  assert.equal(smartTruncate("", 0), "");
});

test("flattenElements does not overflow on deeply nested HTML", () => {
  // 5000 levels of nesting must not throw RangeError (iterative + depth cap).
  const deep = `<div>${"<div>".repeat(5000)}x${"</div>".repeat(5000)}</div>`;
  // Exercise the diff path that uses flattenElements; it must not throw.
  const diff = diffHtml("<div></div>", deep);
  assert.ok(typeof diff.changed === "number");
});
