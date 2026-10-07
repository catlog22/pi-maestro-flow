import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncPiConfig, validatePiConfigShape } from "../src/ssh-manager/pi-config-sync.ts";
import { applyPiConfigPayload } from "../src/gateway/pi-config-apply.ts";
import registerCodexFast from "../src/providers/codex-fast.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const profile = { name: "Default", mappings: { analysis: "provider/model" }, thinkingLevels: { analysis: "high" } };
const v3 = { version: 3, defaultProfile: "default", profiles: { default: profile } };
const v4 = { version: 4, defaultProfile: "default", profiles: { default: { ...profile, fastModes: { analysis: false }, roleMappings: { reviewer: { fast: true } } } } };

test("config transfer validates both V3 and independent V4 Fast grammar", () => {
  assert.doesNotThrow(() => validatePiConfigShape("teammate", v3));
  assert.doesNotThrow(() => validatePiConfigShape("teammate", v4));
  assert.throws(() => validatePiConfigShape("teammate", { ...v4, version: 3 }), /invalid/);
  assert.throws(() => validatePiConfigShape("teammate", { ...v4, profiles: { default: { ...profile, fastModes: { analysis: "false" } } } }), /invalid/);
});

test("local config transfer merging V3/V4 never downgrades retained Fast profiles (no SSH or provider requests)", async (t) => {
  for (const [local, existing] of [[v3, v4], [v4, v3]]) {
    const root = await mkdtemp(join(tmpdir(), "fast-config-compat-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, ".pi", "agent");
    await mkdir(directory, { recursive: true });
    const location = join(directory, "teammate-models.json");
    await writeFile(location, JSON.stringify({ ...existing, profiles: { ...existing.profiles, retained: existing.version === 4 ? v4.profiles.default : profile } }));
    const result = await syncPiConfig({
      categories: ["teammate"],
      source: { async read() { return Buffer.from(JSON.stringify(local)); } },
      transport: { async apply(payload) { return applyPiConfigPayload(Buffer.from(payload), { homeDirectory: root, platform: "linux", enforcePrivate: async () => undefined }); } },
    });
    assert.equal(result.ok, true);
    const saved = JSON.parse(await readFile(location, "utf8"));
    assert.equal(saved.version, 4);
    const fastProfile = existing.version === 4 ? saved.profiles.retained : saved.profiles.default;
    assert.equal(fastProfile.fastModes.analysis, false);
    assert.equal(fastProfile.roleMappings.reviewer.fast, true);
    assert.deepEqual(saved.profiles.default.mappings, profile.mappings);
  }
});

test("an explicitly inherited standalone Fast extension respects child false even over project/CLI defaults", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fast-inherited-extension-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const oldChild = process.env.PI_TEAMMATE_CHILD;
  const oldFast = process.env.PI_TEAMMATE_CODEX_FAST;
  t.after(() => {
    if (oldChild === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = oldChild;
    if (oldFast === undefined) delete process.env.PI_TEAMMATE_CODEX_FAST; else process.env.PI_TEAMMATE_CODEX_FAST = oldFast;
  });
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "codex-fast.json"), '{"enabled":true}');
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const pi = { registerFlag() {}, registerCommand() {}, getFlag: () => true, on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  registerCodexFast(pi);
  const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-test" };
  const ctx = { cwd, model, ui: { setStatus() {}, notify() {} } } as unknown as ExtensionContext;
  const payload = { model: "gpt-test", input: [] };
  process.env.PI_TEAMMATE_CHILD = "1";
  process.env.PI_TEAMMATE_CODEX_FAST = "false";
  assert.equal(handlers.get("before_provider_request")!({ payload } as never, ctx), undefined);
  delete process.env.PI_TEAMMATE_CHILD;
  handlers.get("session_start")!({} as never, ctx);
  assert.deepEqual(handlers.get("before_provider_request")!({ payload } as never, ctx), { ...payload, service_tier: "priority" });
});
