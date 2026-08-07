import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  agentCatalogCacheStats,
  appendAgentCatalog,
  createAgentCatalogSnapshot,
  invalidateAgentCatalogCache,
} from "../src/agents/agents.ts";

let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-catalog-cache-"));
  fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
  invalidateAgentCatalogCache();
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  invalidateAgentCatalogCache();
});

function writeRole(name: string, description: string): string {
  const filePath = path.join(project, ".pi", "agents", `${name}.md`);
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body\n`,
  );
  return filePath;
}

test("unchanged turns reuse the cached catalog object without rebuilding", () => {
  writeRole("auditor", "Audits things");

  const first = createAgentCatalogSnapshot(project);
  assert.equal(agentCatalogCacheStats.misses, 1);
  assert.equal(agentCatalogCacheStats.hits, 0);

  const second = createAgentCatalogSnapshot(project);
  assert.equal(second, first, "cache must return the identical immutable snapshot");
  assert.equal(agentCatalogCacheStats.hits, 1);
  assert.equal(agentCatalogCacheStats.misses, 1);
});

test("cached and freshly rebuilt catalogs are byte-identical", () => {
  writeRole("auditor", "Audits things");

  const first = createAgentCatalogSnapshot(project);
  const cached = createAgentCatalogSnapshot(project);
  invalidateAgentCatalogCache();
  const rebuilt = createAgentCatalogSnapshot(project);

  assert.equal(cached.systemPrompt, first.systemPrompt);
  assert.equal(rebuilt.systemPrompt, first.systemPrompt);
  assert.equal(rebuilt.signature, first.signature);
});

test("adding a role invalidates through the directory manifest", () => {
  writeRole("auditor", "Audits things");
  const first = appendAgentCatalog("Base prompt", project);
  // Exact role-line assertion: packaged roles legitimately contain the
  // substring "reviewer" (workflow-reviewer, cross-role-reviewer).
  assert.doesNotMatch(first, /- reviewer:/);
  const missesBefore = agentCatalogCacheStats.misses;

  writeRole("reviewer", "Reviews things");
  const refreshed = appendAgentCatalog(first, project);

  assert.match(refreshed, /- reviewer: Reviews things/);
  assert.match(refreshed, /- auditor: Audits things/);
  assert.equal(agentCatalogCacheStats.misses, missesBefore + 1);
});

test("editing a role description invalidates through size or mtime", () => {
  const filePath = writeRole("auditor", "Audits things");
  const first = createAgentCatalogSnapshot(project);
  assert.match(first.systemPrompt, /- auditor: Audits things\n/);

  fs.writeFileSync(
    filePath,
    `---\nname: auditor\ndescription: Audits things thoroughly\n---\n\nauditor body\n`,
  );
  const refreshed = createAgentCatalogSnapshot(project);

  assert.match(refreshed.systemPrompt, /- auditor: Audits things thoroughly/);
  assert.notEqual(refreshed, first);
});

test("an mtime-only rewrite invalidates while keeping output bytes stable", () => {
  const filePath = writeRole("auditor", "Audits things");
  const first = createAgentCatalogSnapshot(project);

  const stats = fs.statSync(filePath);
  fs.utimesSync(filePath, stats.atime, new Date(stats.mtimeMs + 5_000));
  const refreshed = createAgentCatalogSnapshot(project);

  assert.notEqual(refreshed, first, "mtime change must force a rebuild");
  assert.equal(refreshed.systemPrompt, first.systemPrompt, "rebuilt bytes stay identical");
});

test("cwd switches use distinct cache entries for the same resolved catalog", () => {
  writeRole("auditor", "Audits things");
  const nested = path.join(project, "work", "deep");
  fs.mkdirSync(nested, { recursive: true });

  const fromRoot = createAgentCatalogSnapshot(project);
  const missesAfterRoot = agentCatalogCacheStats.misses;

  // The nested cwd resolves the same project role directory through ancestor
  // discovery, but caches under its own key.
  const fromNested = createAgentCatalogSnapshot(nested);
  assert.equal(fromNested.systemPrompt, fromRoot.systemPrompt);
  assert.equal(agentCatalogCacheStats.misses, missesAfterRoot + 1);

  createAgentCatalogSnapshot(nested);
  assert.equal(agentCatalogCacheStats.hits, 1);
});

test("invalidateAgentCatalogCache forces a rebuild and resets counters", () => {
  writeRole("auditor", "Audits things");
  const first = createAgentCatalogSnapshot(project);
  createAgentCatalogSnapshot(project);
  assert.equal(agentCatalogCacheStats.hits, 1);

  invalidateAgentCatalogCache();
  assert.equal(agentCatalogCacheStats.hits, 0);
  assert.equal(agentCatalogCacheStats.misses, 0);

  const rebuilt = createAgentCatalogSnapshot(project);
  assert.notEqual(rebuilt, first);
  assert.equal(rebuilt.systemPrompt, first.systemPrompt);
  assert.equal(agentCatalogCacheStats.misses, 1);
});
