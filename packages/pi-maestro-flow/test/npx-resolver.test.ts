import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveNpxBinary, setNpxCachePopulatorForTesting } from "../src/mcp/npx-resolver.ts";

interface ResolverEnv {
  root: string;
  npmCache: string;
  agentDir: string;
  cacheFile: string;
}

function withResolverEnv(run: (env: ResolverEnv) => Promise<void>): Promise<void> {
  return (async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-npx-resolver-"));
    const npmCache = join(root, "npm-cache");
    const agentDir = join(root, "agent");
    const previousCacheEnv = process.env.NPM_CONFIG_CACHE;
    const previousAgentEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.NPM_CONFIG_CACHE = npmCache;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await run({ root, npmCache, agentDir, cacheFile: join(agentDir, "mcp-npx-cache.json") });
    } finally {
      if (previousCacheEnv === undefined) delete process.env.NPM_CONFIG_CACHE;
      else process.env.NPM_CONFIG_CACHE = previousCacheEnv;
      if (previousAgentEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentEnv;
      setNpxCachePopulatorForTesting(null);
      rmSync(root, { recursive: true, force: true });
    }
  })();
}

function createFakeNpxInstall(
  env: ResolverEnv,
  hashName: string,
  packageName: string,
  version: string,
  options: { binName?: string; binRel?: string; mtime?: Date } = {},
): { packageDir: string; binPath: string } {
  const packagePathParts = packageName.startsWith("@") ? packageName.split("/") : [packageName];
  const packageDir = join(env.npmCache, "_npx", hashName, "node_modules", ...packagePathParts);
  mkdirSync(packageDir, { recursive: true });
  const binName = options.binName ?? packageName.split("/").pop();
  const binRel = options.binRel ?? "./cli.js";
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version, bin: { [binName]: binRel } }),
    "utf-8",
  );
  const binPath = join(packageDir, binRel);
  mkdirSync(join(binPath, ".."), { recursive: true });
  writeFileSync(binPath, "#!/usr/bin/env node\nconsole.log(\"fake\");\n", "utf-8");
  if (options.mtime) {
    utimesSync(join(env.npmCache, "_npx", hashName), options.mtime, options.mtime);
  }
  return { packageDir, binPath };
}

test("resolves an exact version from the npm cache and persists a v2 entry", () =>
  withResolverEnv(async (env) => {
    const fake = createFakeNpxInstall(env, "hash1", "testpkg", "1.0.0");

    const resolved = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0"]);

    assert.ok(resolved, "expected a resolution");
    assert.equal(resolved.binPath, fake.binPath);
    assert.equal(resolved.isJs, true);
    assert.deepEqual(resolved.extraArgs, []);

    const cache = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
    assert.equal(cache.version, 2);
    const entries = Object.values(cache.entries) as Array<{
      resolvedBin: string;
      packageVersion: string;
      packageDir: string;
    }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].packageVersion, "1.0.0");
    assert.equal(entries[0].packageDir, fake.packageDir);
    assert.equal(entries[0].resolvedBin, fake.binPath);
  }));

test("equivalent npx and npm exec invocations share one canonical entry", () =>
  withResolverEnv(async (env) => {
    createFakeNpxInstall(env, "hash1", "testpkg", "1.0.0");

    const fromNpx = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0", "--", "--port", "1"]);
    assert.ok(fromNpx);
    assert.deepEqual(fromNpx.extraArgs, ["--", "--port", "1"]);

    const fromNpmExec = await resolveNpxBinary("npm", [
      "exec", "--yes", "--package", "testpkg@1.0.0", "--", "testpkg", "--port", "2",
    ]);
    assert.ok(fromNpmExec);
    assert.deepEqual(fromNpmExec.extraArgs, ["--port", "2"]);
    assert.equal(fromNpmExec.binPath, fromNpx.binPath);

    const cache = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
    assert.equal(Object.keys(cache.entries).length, 1, "runtime args must not fragment the cache key");
  }));

test("exact version selection ignores newer mismatching installs", () =>
  withResolverEnv(async (env) => {
    const v1 = createFakeNpxInstall(env, "oldhash", "testpkg", "1.0.0", {
      mtime: new Date("2024-01-01T00:00:00Z"),
    });
    const v2 = createFakeNpxInstall(env, "newhash", "testpkg", "2.0.0", {
      mtime: new Date("2025-01-01T00:00:00Z"),
    });

    const resolvedV1 = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0"]);
    assert.ok(resolvedV1);
    assert.equal(resolvedV1.binPath, v1.binPath, "must not pick the newest install blindly");

    const resolvedV2 = await resolveNpxBinary("npx", ["-y", "testpkg@2.0.0"]);
    assert.ok(resolvedV2);
    assert.equal(resolvedV2.binPath, v2.binPath);

    const cache = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
    assert.equal(Object.keys(cache.entries).length, 2, "distinct versions must not alias");
  }));

test("scoped packages resolve through the canonical bin candidates", () =>
  withResolverEnv(async (env) => {
    const fake = createFakeNpxInstall(env, "scoped", "@acme/widget", "2.1.0", {
      binName: "widget",
      binRel: "./bin/widget.js",
    });

    const resolved = await resolveNpxBinary("npx", ["-y", "@acme/widget@2.1.0"]);

    assert.ok(resolved);
    assert.equal(resolved.binPath, fake.binPath);
  }));

test("range and tag specs fail safe without populating or persisting", () =>
  withResolverEnv(async (env) => {
    createFakeNpxInstall(env, "hash1", "testpkg", "1.0.0");
    let populatorCalls = 0;
    setNpxCachePopulatorForTesting(async () => {
      populatorCalls++;
    });

    for (const args of [["testpkg@^1.0.0"], ["testpkg@~1.0.0"], ["testpkg@latest"], ["testpkg"], ["testpkg@1.x"]]) {
      assert.equal(await resolveNpxBinary("npx", ["-y", ...args]), null, `expected fail-safe null for ${args[0]}`);
    }
    assert.equal(
      await resolveNpxBinary("npm", ["exec", "--yes", "--package", "testpkg@^1.0.0", "--", "testpkg"]),
      null,
    );

    assert.equal(populatorCalls, 0, "unknown compatibility must not trigger npm installs");
    assert.equal(existsSync(env.cacheFile), false, "unknown compatibility must not persist entries");
  }));

test("persistent reuse revalidates the on-disk version before returning", () =>
  withResolverEnv(async (env) => {
    const v1 = createFakeNpxInstall(env, "hash1", "testpkg", "1.0.0", {
      mtime: new Date("2024-01-01T00:00:00Z"),
    });
    const first = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0"]);
    assert.ok(first);
    assert.equal(first.binPath, v1.binPath);

    // Simulate npm replacing the install under the same _npx directory.
    writeFileSync(
      join(v1.packageDir, "package.json"),
      JSON.stringify({ name: "testpkg", version: "1.5.0", bin: { testpkg: "./cli.js" } }),
      "utf-8",
    );

    let populatorCalls = 0;
    setNpxCachePopulatorForTesting(async () => {
      populatorCalls++;
    });
    const second = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0"]);
    assert.equal(second, null, "stale persistent entry must be rejected when the disk disagrees");
    assert.equal(populatorCalls, 1, "rejected entry must fall through to population");
  }));

test("expired persistent entries re-resolve from disk instead of failing", () =>
  withResolverEnv(async (env) => {
    const fake = createFakeNpxInstall(env, "hash1", "testpkg", "1.0.0");
    const first = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0"]);
    assert.ok(first);

    const cache = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
    for (const entry of Object.values(cache.entries) as Array<{ resolvedAt: number }>) {
      entry.resolvedAt = Date.now() - 25 * 60 * 60 * 1000;
    }
    writeFileSync(env.cacheFile, JSON.stringify(cache), "utf-8");

    const second = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0"]);
    assert.ok(second);
    assert.equal(second.binPath, fake.binPath);
    const refreshed = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
    const entries = Object.values(refreshed.entries) as Array<{ resolvedAt: number }>;
    assert.equal(entries.length, 1);
    assert.ok(Date.now() - entries[0].resolvedAt < 60_000, "entry must be refreshed after TTL expiry");
  }));

test("v1 cache files are discarded and rewritten as v2", () =>
  withResolverEnv(async (env) => {
    createFakeNpxInstall(env, "hash1", "testpkg", "1.0.0");
    mkdirSync(env.agentDir, { recursive: true });
    writeFileSync(
      env.cacheFile,
      JSON.stringify({ version: 1, entries: { "[\"npx\",\"-y\",\"testpkg@1.0.0\"]": { resolvedBin: "/gone", resolvedAt: Date.now(), isJs: true } } }),
      "utf-8",
    );

    const resolved = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0"]);
    assert.ok(resolved);

    const cache = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
    assert.equal(cache.version, 2);
    assert.ok(!("[\"npx\",\"-y\",\"testpkg@1.0.0\"]" in cache.entries), "v1 keys must not survive");
    assert.equal(Object.keys(cache.entries).length, 1);
  }));

test("corrupt persistent cache does not break resolution", () =>
  withResolverEnv(async (env) => {
    createFakeNpxInstall(env, "hash1", "testpkg", "1.0.0");
    mkdirSync(env.agentDir, { recursive: true });
    writeFileSync(env.cacheFile, "not json at all", "utf-8");

    const resolved = await resolveNpxBinary("npx", ["-y", "testpkg@1.0.0"]);
    assert.ok(resolved);
    const cache = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
    assert.equal(cache.version, 2);
  }));

test("concurrent misses for the same spec share a single population", () =>
  withResolverEnv(async (env) => {
    let populatorCalls = 0;
    let releasePopulation: () => void = () => {};
    const populationGate = new Promise<void>((resolve) => {
      releasePopulation = resolve;
    });
    setNpxCachePopulatorForTesting(async () => {
      populatorCalls++;
      await populationGate;
      createFakeNpxInstall(env, "populated", "solopkg", "3.0.0");
    });

    const pending = Promise.all([
      resolveNpxBinary("npx", ["-y", "solopkg@3.0.0", "--", "--flag-a"]),
      resolveNpxBinary("npm", ["exec", "--yes", "--package", "solopkg@3.0.0", "--", "solopkg", "--flag-b"]),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(populatorCalls, 1, "both misses must attach to one in-flight population");
    releasePopulation();

    const [a, b] = await pending;
    assert.ok(a);
    assert.ok(b);
    assert.equal(populatorCalls, 1);
    assert.equal(a.binPath, b.binPath);
    assert.deepEqual(a.extraArgs, ["--", "--flag-a"]);
    assert.deepEqual(b.extraArgs, ["--flag-b"]);

    const cache = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
    assert.equal(Object.keys(cache.entries).length, 1);
  }));
