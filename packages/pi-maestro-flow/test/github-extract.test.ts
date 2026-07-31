import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { invalidateWebConfigCaches } from "../src/tools/web-access/web-config-cache.ts";

type GitHubExtractModule = typeof import("../src/tools/web-access/github-extract.ts");

let root: string;
let clonesDir: string;
let previousAgentDir: string | undefined;
let gh: GitHubExtractModule;

function writeGitHubConfig(patch: Record<string, unknown>): void {
	writeFileSync(
		join(root, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath: clonesDir, ...patch } }),
		"utf-8",
	);
}

function makeFakeClone(name: string, readme: string): string {
	const dir = join(root, "fake-clones", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "README.md"), readme, "utf-8");
	writeFileSync(join(dir, "index.js"), "module.exports = 1;\n", "utf-8");
	return dir;
}

before(async () => {
	root = mkdtempSync(join(tmpdir(), "pi-github-extract-"));
	clonesDir = join(root, "clones");
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	writeGitHubConfig({ enabled: true });
	gh = await import("../src/tools/web-access/github-extract.ts");
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

test("parseGitHubUrl canonicalizes owner/repo case and preserves ref case", () => {
	const rootUrl = gh.parseGitHubUrl("https://github.com/Owner/RepoName");
	assert.ok(rootUrl);
	assert.equal(rootUrl.owner, "owner");
	assert.equal(rootUrl.repo, "reponame");
	assert.equal(rootUrl.type, "root");

	const gitSuffix = gh.parseGitHubUrl("https://github.com/OWNER/RepoName.git");
	assert.ok(gitSuffix);
	assert.equal(gitSuffix.owner, "owner");
	assert.equal(gitSuffix.repo, "reponame");

	const branchUrl = gh.parseGitHubUrl("https://github.com/Owner/RepoName/tree/MyBranch/src/lib");
	assert.ok(branchUrl);
	assert.equal(branchUrl.owner, "owner");
	assert.equal(branchUrl.repo, "reponame");
	assert.equal(branchUrl.ref, "MyBranch", "ref case must be preserved");
	assert.equal(branchUrl.path, "src/lib");
	assert.equal(branchUrl.refIsFullSha, false);

	const shaUrl = gh.parseGitHubUrl("https://github.com/Owner/RepoName/blob/0123456789abcdef0123456789abcdef01234567/file.ts");
	assert.ok(shaUrl);
	assert.equal(shaUrl.refIsFullSha, true);

	// Case-equivalent repository URLs must map to the same cache identity.
	assert.equal(
		gh.cacheKey(rootUrl.owner, rootUrl.repo, rootUrl.ref),
		gh.cacheKey(gitSuffix.owner, gitSuffix.repo, gitSuffix.ref),
	);
	assert.notEqual(
		gh.cacheKey(rootUrl.owner, rootUrl.repo, rootUrl.ref),
		gh.cacheKey(branchUrl.owner, branchUrl.repo, branchUrl.ref),
	);
});

test("mutable refs expire after the bounded TTL; immutable SHAs stay stable", () => {
	let now = 1_000_000;
	const restoreClock = gh.setCloneCacheClockForTesting(() => now);
	try {
		const mutableDir = makeFakeClone("mutable", "mutable readme");
		const mutableKey = "octocat/hello-world@main";
		gh.seedCloneCacheForTesting(mutableKey, {
			localPath: mutableDir,
			clonePromise: Promise.resolve(mutableDir),
			createdAt: now,
			immutable: false,
			settled: true,
		});

		assert.ok(gh.lookupCloneCache(mutableKey), "fresh mutable entry must hit");
		now += gh.MOVING_REF_TTL_MS - 1;
		assert.ok(gh.lookupCloneCache(mutableKey), "entry inside the TTL must hit");
		now += 2;
		assert.equal(gh.lookupCloneCache(mutableKey), null, "stale settled entry must expire");
		assert.ok(!gh.cloneCacheKeysForTesting().includes(mutableKey));
		assert.equal(existsSync(mutableDir), false, "expired clone directory must be reclaimed");

		const immutableDir = makeFakeClone("immutable", "sha readme");
		const immutableKey = "octocat/hello-world@0123456789abcdef0123456789abcdef01234567";
		gh.seedCloneCacheForTesting(immutableKey, {
			localPath: immutableDir,
			clonePromise: Promise.resolve(immutableDir),
			createdAt: 0,
			immutable: true,
			settled: true,
		});
		now = Number.MAX_SAFE_INTEGER - 1;
		assert.ok(gh.lookupCloneCache(immutableKey), "immutable SHA entries must never expire");
		gh.clearCloneCache();
	} finally {
		restoreClock();
	}
});

test("stale in-flight clones are never evicted", () => {
	let now = 5_000_000;
	const restoreClock = gh.setCloneCacheClockForTesting(() => now);
	try {
		const dir = makeFakeClone("inflight", "pending readme");
		const key = "octocat/pending@main";
		gh.seedCloneCacheForTesting(key, {
			localPath: dir,
			clonePromise: new Promise(() => {}),
			createdAt: 0,
			immutable: false,
			settled: false,
		});

		now += gh.MOVING_REF_TTL_MS * 10;
		const hit = gh.lookupCloneCache(key);
		assert.ok(hit, "an in-flight clone must stay cached past its TTL");
		assert.ok(gh.cloneCacheKeysForTesting().includes(key));
		assert.ok(existsSync(dir), "in-flight clone directory must not be removed");

		gh.clearCloneCache();
		assert.ok(gh.cloneCacheKeysForTesting().includes(key), "clearCloneCache must skip in-flight entries");
		assert.ok(existsSync(dir));

		// Once settled, the same entry becomes eligible for cleanup.
		const entry = gh.lookupCloneCache(key);
		assert.ok(entry);
		entry.settled = true;
		gh.clearCloneCache();
		assert.ok(!gh.cloneCacheKeysForTesting().includes(key));
		assert.equal(existsSync(dir), false);
	} finally {
		restoreClock();
	}
});

test("invalid GitHub config fails soft and keeps cached extraction available", async () => {
	const cloneDir = makeFakeClone("invalid-config", "# Still Available");
	gh.seedCloneCacheForTesting("owner/repo", {
		localPath: cloneDir,
		clonePromise: Promise.resolve(cloneDir),
		createdAt: Date.now(),
		immutable: false,
		settled: true,
	});
	writeFileSync(join(root, "web-search.json"), "{invalid-json", "utf8");
	invalidateWebConfigCaches();

	const result = await gh.extractGitHub("https://github.com/owner/repo");
	assert.ok(result, "a malformed optional config must fall back to defaults");
	assert.match(result.content, /Still Available/);

	writeGitHubConfig({ enabled: true });
	invalidateWebConfigCaches();
	gh.clearCloneCache();
});

test("extractGitHub serves cached clones and reloads config only after invalidation", async () => {
	writeGitHubConfig({ enabled: true });
	invalidateWebConfigCaches();

	const cloneDir = makeFakeClone("served", "# Served README");
	gh.seedCloneCacheForTesting("owner/repo", {
		localPath: cloneDir,
		clonePromise: Promise.resolve(cloneDir),
		createdAt: Date.now(),
		immutable: false,
		settled: true,
	});

	const first = await gh.extractGitHub("https://github.com/Owner/Repo");
	assert.ok(first, "case-equivalent URL must hit the seeded lowercase key");
	assert.match(first.content, /Served README/);
	assert.equal(first.title, "owner/repo");

	// Config edits stay invisible while the module memoizes the old config.
	writeGitHubConfig({ enabled: false });
	const stale = await gh.extractGitHub("https://github.com/Owner/Repo");
	assert.ok(stale, "memoized config must stay stable until invalidation");

	invalidateWebConfigCaches();
	assert.equal(await gh.extractGitHub("https://github.com/Owner/Repo"), null, "invalidation must apply enabled=false");

	// Re-enabling works without losing the cached clone: sync invalidation
	// refreshes config but never evicts clones.
	writeGitHubConfig({ enabled: true });
	invalidateWebConfigCaches();
	const revived = await gh.extractGitHub("https://github.com/Owner/Repo");
	assert.ok(revived, "config invalidation must not evict cached clones");
	assert.match(revived.content, /Served README/);

	gh.clearCloneCache();
});
