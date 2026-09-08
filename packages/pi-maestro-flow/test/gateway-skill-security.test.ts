import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewaySkillPolicy } from "../src/gateway/skill-policy.ts";
import { GatewaySkillService } from "../src/gateway/services/skill-service.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";

async function fixture(t: test.TestContext, overrides: Partial<{ maxFiles: number; maxFileBytes: number; maxResponseBytes: number }> = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-skill-workspace-"));
  const external = await mkdtemp(join(tmpdir(), "gateway-skill-external-"));
  const references = await mkdtemp(join(tmpdir(), "gateway-skill-references-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(external, { recursive: true, force: true }),
    rm(references, { recursive: true, force: true }),
  ]));
  const workspaceSkills = join(root, ".pi", "skills");
  await mkdir(join(workspaceSkills, "demo", "docs"), { recursive: true });
  await writeFile(join(workspaceSkills, "demo", "docs", "guide.md"), "workspace guide", "utf8");
  await writeFile(join(workspaceSkills, "demo", "SKILL.md"), `---\nname: demo\ndescription: Safe demo\n---\n<required_reading>\n- @docs/guide.md\n- @docs/missing.md\n</required_reading>\n`, "utf8");
  await mkdir(join(external, "external-demo"), { recursive: true });
  await writeFile(join(references, "manual.md"), "external manual", "utf8");
  await writeFile(join(external, "external-demo", "SKILL.md"), `---\nname: external-demo\n---\n<deferred_reading>\n- @${join(references, "manual.md")}\n</deferred_reading>\n`, "utf8");
  const workspaceId = workspaceIdForPath(root);
  const principal = createGatewayPrincipal("http", "skill-user", { authenticated: true, workspaceId });
  const policy = new GatewayPolicy({ workspaceRoot: root, workspaces: [{ path: root, mode: "permanent" }] });
  const skillPolicy = new GatewaySkillPolicy({
    policy,
    security: { enabled: true, workspaceRoots: [".pi/skills"], externalSkillRoots: [external], externalReferenceRoots: [references] },
    baseCwd: root,
    maxFiles: overrides.maxFiles ?? 32,
    maxFileBytes: overrides.maxFileBytes ?? 4096,
    maxResponseBytes: overrides.maxResponseBytes ?? 32_768,
  });
  return { root, external, references, workspaceId, principal, skillPolicy, service: new GatewaySkillService(skillPolicy) };
}

function dataOf<T>(result: { data?: unknown }): T { return result.data as T; }

test("Gateway skill list/load uses source-qualified IDs and explicit resource IDs", async (t) => {
  const { service, principal, workspaceId } = await fixture(t);
  const listed = await service.handle(principal, { action: "list", workspaceId, limit: 16 });
  assert.equal(listed.ok, true);
  const skills = dataOf<{ skills: Array<{ id: string; name: string; source: string; resources: Array<{ id: string; state: string }> }> }>(listed).skills;
  assert.deepEqual(skills.map((skill) => skill.name), ["demo", "external-demo"]);
  assert.match(skills[0]!.id, /^workspace:/);
  assert.deepEqual(skills[0]!.resources, [
    { id: "required-1", state: "allowed" },
    { id: "required-2", state: "missing" },
  ]);
  assert.deepEqual(skills[1]!.resources, [{ id: "deferred-1", state: "deferred" }]);

  const main = await service.handle(principal, { action: "load", workspaceId, skillId: skills[0]!.id });
  assert.match(dataOf<{ resource: { content: string } }>(main).resource.content, /Safe demo/);
  const required = await service.handle(principal, { action: "load", workspaceId, skillId: skills[0]!.id, resourceId: "required-1" });
  assert.equal(dataOf<{ resource: { content: string } }>(required).resource.content, "workspace guide");
  const deferred = await service.handle(principal, { action: "load", workspaceId, skillId: skills[1]!.id, resourceId: "deferred-1" });
  assert.equal(dataOf<{ resource: { content: string } }>(deferred).resource.content, "external manual");
  assert.equal((await service.handle(principal, { action: "load", workspaceId, skillId: skills[0]!.id, resourceId: "../../secret" })).error?.code, "not_found");
});

test("runtime catalog dispatches configured skill list/load", async (t) => {
  const { root, workspaceId, principal } = await fixture(t);
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "secret" });
  config.security.skills = { enabled: true, workspaceRoots: [".pi/skills"], externalSkillRoots: [], externalReferenceRoots: [] };
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(() => runtime.close());
  const listed = await runtime.call("skill", { action: "list", workspaceId }, principal);
  assert.equal(listed.ok, true);
  const skillId = dataOf<{ skills: Array<{ id: string }> }>(listed).skills[0]!.id;
  const loaded = await runtime.call("skill", { action: "load", workspaceId, skillId }, principal);
  assert.match(dataOf<{ resource: { content: string } }>(loaded).resource.content, /Safe demo/);
});

test("Gateway skill reads reauthorize workspace and configured reference roots on every load", async (t) => {
  const { root, external, references, workspaceId, principal } = await fixture(t);
  const policy = new GatewayPolicy({ workspaceRoot: root, workspaces: [{ path: root, mode: "permanent" }] });
  const revoked = new GatewaySkillPolicy({
    policy,
    security: { enabled: true, workspaceRoots: [".pi/skills"], externalSkillRoots: [external], externalReferenceRoots: [] },
    baseCwd: root, maxFiles: 32, maxFileBytes: 4096, maxResponseBytes: 32_768,
  });
  const listed = await revoked.list(principal, workspaceId);
  const externalSkill = listed.find(({ descriptor }) => descriptor.name === "external-demo")!;
  assert.equal(externalSkill.descriptor.resources[0]?.state, "denied");
  await assert.rejects(() => revoked.load(principal, workspaceId, externalSkill.descriptor.id, "deferred-1"), /not authorized/);

  const foreign = createGatewayPrincipal("http", "foreign", { authenticated: true, workspaceId: workspaceIdForPath(references) });
  await assert.rejects(() => revoked.list(foreign, workspaceId), /Workspace was not found/);
});

test("Gateway skill policy rejects traversal roots, links, non-files, and byte bounds", async (t) => {
  const { root, workspaceId, principal, skillPolicy } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "gateway-skill-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.md"), "secret", "utf8");
  const linked = join(root, ".pi", "skills", "linked");
  try {
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const listed = await skillPolicy.list(principal, workspaceId);
    assert.equal(listed.some(({ descriptor }) => descriptor.name === "linked"), false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }

  const badRoot = new GatewaySkillPolicy({
    policy: new GatewayPolicy({ workspaceRoot: root, workspaces: [{ path: root, mode: "permanent" }] }),
    security: { enabled: true, workspaceRoots: ["../outside"], externalSkillRoots: [], externalReferenceRoots: [] },
    baseCwd: root, maxFiles: 8, maxFileBytes: 4096, maxResponseBytes: 8192,
  });
  await assert.rejects(() => badRoot.list(principal, workspaceId), /escapes the workspace/);

  await mkdir(join(root, ".pi", "skills", "directory-main", "SKILL.md"), { recursive: true });
  await assert.rejects(() => skillPolicy.list(principal, workspaceId), /regular file/);

  const bounded = await fixture(t, { maxFileBytes: 8 });
  await assert.rejects(() => bounded.skillPolicy.list(bounded.principal, bounded.workspaceId), /exceeds configured limit/);
});

test("Gateway skill service fails closed when disabled and bounds list responses", async (t) => {
  const { root, workspaceId, principal } = await fixture(t);
  const policy = new GatewayPolicy({ workspaceRoot: root, workspaces: [{ path: root, mode: "permanent" }] });
  const disabled = new GatewaySkillService(new GatewaySkillPolicy({
    policy,
    security: { enabled: false, workspaceRoots: [".pi/skills"], externalSkillRoots: [], externalReferenceRoots: [] },
    baseCwd: root, maxFiles: 32, maxFileBytes: 4096, maxResponseBytes: 32_768,
  }));
  assert.equal((await disabled.handle(principal, { action: "list", workspaceId })).error?.code, "skill_disabled");

  const bounded = new GatewaySkillService(new GatewaySkillPolicy({
    policy,
    security: { enabled: true, workspaceRoots: [".pi/skills"], externalSkillRoots: [], externalReferenceRoots: [] },
    baseCwd: root, maxFiles: 32, maxFileBytes: 4096, maxResponseBytes: 32,
  }));
  assert.equal((await bounded.handle(principal, { action: "list", workspaceId })).error?.code, "skill_bounds_exceeded");
});
