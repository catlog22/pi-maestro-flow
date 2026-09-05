import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSchtasksRunner,
  GatewayResidentOperationError,
  GatewayResidentService,
  WindowsTaskAdapter,
  windowsTaskArguments,
  type GatewayRegistrationState,
  type GatewayResidentAdapter,
  type GatewayServiceCleanup,
  type GatewayServiceDefinition,
  type GatewayServiceManifest,
  type SchtasksResult,
  type SchtasksRunner,
} from "../src/gateway/resident-service.ts";

class FakeAdapter implements GatewayResidentAdapter {
  readonly kind: "systemd-user" | "windows-task";
  definition?: GatewayServiceDefinition;
  state: GatewayRegistrationState = "absent";
  starts = 0;
  uninstalls = 0;
  installs = 0;
  queries = 0;
  constructor(kind: "systemd-user" | "windows-task" = "systemd-user") { this.kind = kind; }
  async install(definition: GatewayServiceDefinition): Promise<void> { this.installs += 1; this.definition = structuredClone(definition); this.state = "matching"; }
  async start(): Promise<void> { this.starts += 1; }
  async readDefinition(): Promise<GatewayServiceDefinition | undefined> { return this.definition && structuredClone(this.definition); }
  async queryDefinitionState(): Promise<GatewayRegistrationState> { this.queries += 1; return this.state; }
  async uninstall(): Promise<void> { this.uninstalls += 1; if (this.state === "matching") this.state = "absent"; }
}

const noopLock = () => Promise.resolve({ instance: "test", token: "test", assertOwned: async () => undefined, release: async () => true });
const noopDurability = { syncFile: async () => undefined, syncDirectory: async () => undefined };
const noPrivate = async () => undefined;
function serviceOptions(root: string, adapter: GatewayResidentAdapter, extra: Record<string, unknown> = {}) {
  return {
    adapter,
    manifestPath: join(root, "service.json"),
    ownerPath: join(root, "owner.json"),
    command: process.execPath,
    argsPrefix: ["gateway.mjs"],
    cwd: root,
    acquireLock: noopLock,
    enforcePrivate: noPrivate,
    durability: noopDurability,
    ...extra,
  };
}
function hashDefinition(definition: GatewayServiceDefinition): string { return createHash("sha256").update(JSON.stringify(definition), "utf8").digest("hex"); }
function schtasksResult(exitCode: number, stdout: Buffer | string = Buffer.alloc(0), stderr: Buffer | string = Buffer.alloc(0)): SchtasksResult {
  return { exitCode, stdout: Buffer.isBuffer(stdout) ? Buffer.from(stdout) : Buffer.from(stdout), stderr: Buffer.isBuffer(stderr) ? Buffer.from(stderr) : Buffer.from(stderr) };
}
function absentTask(code = 2, diagnostic = "任務不存在"): SchtasksResult { return schtasksResult(code, "", diagnostic); }
function utf16Xml(text: string): Buffer { return Buffer.from(`\uFEFF${text}`, "utf16le"); }
function fixtureText(bytes: Buffer): string { return bytes.subarray(2).toString("utf16le"); }

const windowsDefinition: GatewayServiceDefinition = {
  name: "pi-maestro-gateway",
  command: "C:\\Program Files\\Pi Maestro\\gateway.exe",
  args: ["", "plain", "quoted\"value", "C:\\trailing\\\\", "--installation-token", "test-secret-token"],
  cwd: "C:\\Program Files\\Pi Maestro\\",
  installationToken: "test-secret-token",
  taskName: "PiMaestroGateway-0123456789abcdefabcd",
  userSid: "S-1-5-21-1000",
};

async function createWindowsHarness(root: string, queryTransform: (xml: Buffer) => Buffer = (xml) => Buffer.from(xml)) {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const task: { xml?: Buffer } = {};
  const runner: SchtasksRunner = async (request) => {
    calls.push({ operation: request.operation, args: [...request.args] });
    if (request.operation === "query") return task.xml ? schtasksResult(0, queryTransform(task.xml)) : absentTask();
    if (request.operation === "create") { task.xml = await readFile(request.args.at(-1)!); return schtasksResult(0); }
    if (request.operation === "delete") { task.xml = undefined; return schtasksResult(0); }
    return schtasksResult(0);
  };
  const adapter = new WindowsTaskAdapter({ stateDirectory: root, runner, verifyPrivate: noPrivate, resolveCurrentUserSid: async () => windowsDefinition.userSid! });
  const cleanup = adapter.prepareCleanup(windowsDefinition);
  return { adapter, cleanup, calls, task };
}

async function readManifest(path: string): Promise<GatewayServiceManifest> { return JSON.parse(await readFile(path, "utf8")) as GatewayServiceManifest; }

test("resident lifecycle persists installing before OS mutation and installed after cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FakeAdapter();
  const observed: string[] = [];
  const service = new GatewayResidentService(serviceOptions(root, adapter, {
    fault: async (point: string) => {
      observed.push(`${point}:${(await readManifest(join(root, "service.json"))).lifecycle}`);
    },
  }));
  const manifest = await service.install();
  assert.equal(manifest.lifecycle, "installed");
  assert.equal(adapter.installs, 1);
  assert.deepEqual(observed, ["install:intent-durable:installing", "install:registration-matching:installing", "install:manifest-installed:installed"]);
  assert.equal(manifest.installationToken.length >= 43, true);
  assert.doesNotMatch(await readFile(join(root, "service.json"), "utf8"), /ownerToken/u);
  await service.validateServiceRun(manifest.installationToken, manifest.definition.command, manifest.definition.args, manifest.definition.cwd);
  await assert.rejects(() => service.validateServiceRun(manifest.installationToken, manifest.definition.command, [...manifest.definition.args, "forged"], manifest.definition.cwd), /does not match/u);
});

test("explicit detached fallback preserves service-run compatibility", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-detached-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new GatewayResidentService({
    manifestPath: join(root, "service.json"), ownerPath: join(root, "owner.json"), command: process.execPath,
    argsPrefix: ["gateway.mjs"], cwd: root, allowDetachedFallback: true,
    acquireLock: noopLock, enforcePrivate: noPrivate, durability: noopDurability,
  });
  const manifest = await service.install();
  assert.equal(manifest.kind, "detached-fallback");
  assert.equal(manifest.definition.args.includes("--detached-fallback"), true);
  await service.validateServiceRun(manifest.installationToken, manifest.definition.command, manifest.definition.args, manifest.definition.cwd);
  assert.equal(await service.uninstall(), true);
});

test("legacy v1 manifest defaults to installed and legacy Windows task identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition: GatewayServiceDefinition = { name: "pi-maestro-gateway", command: "gateway.exe", args: ["service-run"], cwd: "C:\\legacy", installationToken: "legacy-token-123456" };
  const manifest: GatewayServiceManifest = { version: 1, installationId: "legacy-install", installationToken: definition.installationToken, kind: "windows-task", definitionHash: hashDefinition(definition), definition, installedAt: 1 };
  await writeFile(join(root, "service.json"), JSON.stringify(manifest));
  const adapter = new FakeAdapter("windows-task"); adapter.definition = definition; adapter.state = "matching";
  const service = new GatewayResidentService(serviceOptions(root, adapter));
  const validated = await service.validateInstallationToken(definition.installationToken);
  assert.equal(validated.lifecycle, "installed");
  assert.equal(validated.taskName, "pi-maestro-gateway");
  assert.equal((await service.status()).lifecycle, "installed");
});

test("pending install fails closed for validation and matching registration converges on mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-recover-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FakeAdapter();
  let crash = true;
  const first = new GatewayResidentService(serviceOptions(root, adapter, { fault: async (point: string) => { if (crash && point === "install:registration-matching") throw new Error("simulated crash"); } }));
  await assert.rejects(() => first.install(), (error: unknown) => error instanceof GatewayResidentOperationError && error.disposition === "recovery-required");
  const pending = await readManifest(join(root, "service.json"));
  assert.equal(pending.lifecycle, "installing");
  await assert.rejects(() => first.validateInstallationToken(pending.installationToken), /pending recovery/u);
  const beforeStatus = await readFile(join(root, "service.json"), "utf8");
  const pendingStatus = await first.status();
  assert.equal(pendingStatus.recoveryRequired, true);
  assert.equal(await readFile(join(root, "service.json"), "utf8"), beforeStatus);
  crash = false;
  const second = new GatewayResidentService(serviceOptions(root, adapter));
  await second.start();
  assert.equal(adapter.starts, 1);
  assert.equal((await readManifest(join(root, "service.json"))).lifecycle, "installed");
});

test("three numeric absence observations spanning five seconds retire abandoned install intent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-stable-absence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FakeAdapter();
  const installed = await new GatewayResidentService(serviceOptions(root, adapter)).install();
  adapter.state = "absent";
  await writeFile(join(root, "service.json"), JSON.stringify({ ...installed, lifecycle: "installing", operation: { stage: "registration-unknown", startedAt: 0, updatedAt: 0, absentObservations: [] } }));
  let now = 10_000;
  const service = new GatewayResidentService(serviceOptions(root, adapter, { now: () => now, delay: async (ms: number) => { now += ms; } }));
  const replacement = await service.install();
  assert.notEqual(replacement.installationId, installed.installationId);
  assert.equal(adapter.queries >= 4, true);
  assert.equal(replacement.lifecycle, "installed");
});

test("crashes at cleanup and final installed-manifest boundaries converge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-recover-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  class CleanupAdapter extends FakeAdapter {
    cleanups = 0;
    override prepareCleanup(): GatewayServiceCleanup { return { state: "pending", xmlBasename: ".pi-maestro-gateway-task-0123456789abcdefabcd.xml", xmlDigest: "0".repeat(64) }; }
    override async cleanupInstallation(): Promise<void> { this.cleanups += 1; }
  }
  for (const boundary of ["install:cleanup-complete", "install:manifest-installed"] as const) {
    const caseRoot = join(root, boundary.replace(/:/gu, "-"));
    const adapter = new CleanupAdapter();
    let fault = true;
    const first = new GatewayResidentService(serviceOptions(caseRoot, adapter, { fault: async (point: string) => { if (fault && point === boundary) throw new Error("simulated crash"); } }));
    await assert.rejects(() => first.install(), (error: unknown) => error instanceof GatewayResidentOperationError && error.disposition === "recovery-required");
    fault = false;
    const second = new GatewayResidentService(serviceOptions(caseRoot, adapter));
    await second.start();
    assert.equal((await readManifest(join(caseRoot, "service.json"))).lifecycle, "installed");
    assert.equal(adapter.starts, 1);
  }
});

test("durable uninstall intent and already-absent boundary both resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-recover-uninstall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const boundary of ["uninstall:intent-durable", "uninstall:registration-absent"] as const) {
    const caseRoot = join(root, boundary.replace(/:/gu, "-"));
    const adapter = new FakeAdapter();
    let fault = true;
    const service = new GatewayResidentService(serviceOptions(caseRoot, adapter, { fault: async (point: string) => { if (fault && point === boundary) throw new Error("simulated crash"); } }));
    await service.install();
    await assert.rejects(() => service.uninstall());
    assert.equal((await readManifest(join(caseRoot, "service.json"))).lifecycle, "uninstalling");
    fault = false;
    const resumed = new GatewayResidentService(serviceOptions(caseRoot, adapter));
    assert.equal(await resumed.uninstall(), true);
    await assert.rejects(() => lstat(join(caseRoot, "service.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  }
});

test("mutations acquire once, restart is non-reentrant, and foreign registration is not deleted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FakeAdapter();
  let acquisitions = 0;
  const service = new GatewayResidentService(serviceOptions(root, adapter, { acquireLock: async () => { acquisitions += 1; return noopLock(); } }));
  await service.install();
  acquisitions = 0;
  await service.restart();
  assert.equal(acquisitions, 1);
  adapter.state = "foreign";
  await assert.rejects(() => service.uninstall(), /ownership is not proven/u);
  assert.equal(adapter.uninstalls, 0);
  assert.equal((await readManifest(join(root, "service.json"))).lifecycle, "installed");
});

test("Windows task uses installation identity, SID, HRESULT query, semantic normalization, and deterministic cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-semantic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const captured = JSON.parse(await readFile(new URL("fixtures/windows-task-schtasks-normalization.json", import.meta.url), "utf8")) as { redacted: boolean; redactions: string[] };
  assert.equal(captured.redacted, true);
  assert.equal(captured.redactions.length, 6);
  const normalize = (bytes: Buffer): Buffer => {
    let xml = fixtureText(bytes);
    xml = xml.replace("<Source>Pi Maestro Gateway</Source><Description>", "<Author>Windows</Author><Source>Pi Maestro Gateway</Source><Date>2026-01-01T00:00:00</Date><Description>");
    xml = xml.replace("<Enabled>true</Enabled>", "").replace("<RunLevel>LeastPrivilege</RunLevel>", "");
    xml = xml.replace("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>true</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><IdleSettings><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>");
    const sections = Object.fromEntries(["RegistrationInfo", "Triggers", "Principals", "Settings", "Actions"].map((name) => [name, xml.match(new RegExp(`<${name}[^>]*>[\\s\\S]*?</${name}>`))?.[0] ?? ""]));
    xml = xml.replace(/<RegistrationInfo>[\s\S]*<\/Actions>/u, `${sections.RegistrationInfo}${sections.Principals}${sections.Settings}${sections.Triggers}${sections.Actions}`);
    return utf16Xml(xml);
  };
  const { adapter, cleanup, calls, task } = await createWindowsHarness(root, normalize);
  const identity = await adapter.prepareInstallation("install-fixed");
  assert.match(identity.taskName!, /^PiMaestroGateway-[a-f0-9]{20}$/u);
  assert.equal(identity.userSid, windowsDefinition.userSid);
  await adapter.install(windowsDefinition, cleanup);
  assert.equal(await adapter.queryDefinitionState(windowsDefinition), "matching");
  const create = calls.find((call) => call.operation === "create")!;
  assert.equal(create.args.includes("/F"), false);
  assert.equal(create.args[2], windowsDefinition.taskName);
  assert.equal(calls.filter((call) => call.operation === "query").every((call) => call.args.includes("/HResult")), true);
  assert.match(fixtureText(task.xml!), new RegExp(`<UserId>${windowsDefinition.userSid}</UserId>`));
  assert.match(fixtureText(task.xml!), new RegExp(`\\\\${windowsDefinition.taskName}`));
  assert.equal(windowsTaskArguments([""]), '""');
  assert.equal(windowsTaskArguments(['a"b']), '"a\\"b"');
  assert.equal(windowsTaskArguments(["tail\\\\"]), '"tail\\\\\\\\"');
  assert.equal((await readdir(root)).some((name) => name.endsWith(".xml")), true);
  await adapter.cleanupInstallation(windowsDefinition, cleanup);
  assert.equal((await readdir(root)).some((name) => name.includes(".xml")), false);
  await adapter.install(windowsDefinition, cleanup);
  assert.equal(calls.filter((call) => call.operation === "create").length, 1);
  await adapter.uninstall(windowsDefinition);
  await adapter.uninstall(windowsDefinition);
  assert.equal(calls.filter((call) => call.operation === "delete").length, 1);
});

test("one absent observation after Create retains recovery intent and never compensates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-late-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const adapter = new WindowsTaskAdapter({ stateDirectory: root, verifyPrivate: noPrivate, runner: async (request) => {
    calls.push(request.operation);
    if (request.operation === "query") return absentTask();
    return schtasksResult(0);
  } });
  const cleanup = adapter.prepareCleanup(windowsDefinition);
  await assert.rejects(() => adapter.install(windowsDefinition, cleanup), (error: unknown) => error instanceof GatewayResidentOperationError && error.disposition === "recovery-required");
  assert.equal(calls.includes("delete"), false);
  assert.equal((await readdir(root)).includes(cleanup.xmlBasename), true);
});

test("numeric HRESULT absence ignores localized diagnostics and access denied text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-hresult-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = async (result: SchtasksResult) => new WindowsTaskAdapter({ stateDirectory: root, verifyPrivate: noPrivate, runner: async () => result }).queryDefinitionState(windowsDefinition);
  assert.equal(await state(absentTask(2, "任務不存在")), "absent");
  assert.equal(await state(absentTask(0x80070002, "opaque")), "absent");
  assert.equal(await state(absentTask(5, "ERROR: cannot find the task")), "inconclusive");
  assert.equal(await state(absentTask(0x80070005, "not found")), "inconclusive");
  assert.equal(await state(absentTask(1, "ERROR: The system cannot find the file specified.")), "inconclusive");
});

test("semantic XML matcher rejects duplicate, extra behavior, SID, action, and entity changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-strict-xml-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, cleanup, task } = await createWindowsHarness(root);
  await adapter.install(windowsDefinition, cleanup);
  const base = fixtureText(task.xml!);
  const stateFor = (xml: string) => new WindowsTaskAdapter({ stateDirectory: root, verifyPrivate: noPrivate, runner: async () => schtasksResult(0, utf16Xml(xml)) }).queryDefinitionState(windowsDefinition);
  const foreign = [
    base.replace("</Triggers>", "<BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>"),
    base.replace("</Actions>", "<Exec><Command>x</Command><Arguments></Arguments><WorkingDirectory>x</WorkingDirectory></Exec></Actions>"),
    base.replace(windowsDefinition.userSid!, "S-1-5-21-9999"),
    base.replace("PT0S", "PT1H"),
    base.replace("<Command>", "<Unexpected>x</Unexpected><Command>"),
    base.replace("</Settings>", "<Enabled>true</Enabled><Enabled>true</Enabled></Settings>"),
  ];
  for (const changed of foreign) assert.equal(await stateFor(changed), "foreign");
  assert.equal(await stateFor(`<!DOCTYPE Task [<!ENTITY xxe SYSTEM "file:///secret">]>${base}`), "inconclusive");
  assert.equal(await stateFor(base.slice(0, -20)), "inconclusive");
  const prefixed = base.replace(/<(\/?)([A-Z][A-Za-z]+)(?=[ >])/gu, "<$1t:$2").replace(`xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"`, `xmlns:t=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"`);
  assert.equal(await stateFor(prefixed), "matching");
});

test("bounded runner waits for graceful or forced close and reports unconfirmed termination", async () => {
  class FakeChild extends EventEmitter {
    stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough();
    exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; kills: Array<NodeJS.Signals | undefined> = [];
    constructor(private readonly closeOnKill: number | undefined) { super(); }
    kill(signal?: NodeJS.Signals): boolean { this.kills.push(signal); if (this.kills.length === this.closeOnKill) queueMicrotask(() => this.emit("close", null)); return true; }
  }
  const graceful = new FakeChild(1);
  await assert.rejects(() => createSchtasksRunner({ spawn: () => graceful as never, timeoutMs: 2, terminationGraceMs: 2 })({ operation: "query", args: [] }), (error: unknown) => error instanceof Error && error.name === "TimeoutError");
  assert.deepEqual(graceful.kills, [undefined]);
  assert.equal(graceful.listenerCount("close"), 0);

  const forced = new FakeChild(2);
  await assert.rejects(() => createSchtasksRunner({ spawn: () => forced as never, timeoutMs: 2, terminationGraceMs: 2 })({ operation: "query", args: [] }), (error: unknown) => error instanceof Error && error.name === "TimeoutError");
  assert.deepEqual(forced.kills, [undefined, "SIGKILL"]);

  const unconfirmed = new FakeChild(undefined);
  await assert.rejects(() => createSchtasksRunner({ spawn: () => unconfirmed as never, timeoutMs: 2, terminationGraceMs: 2 })({ operation: "create", args: ["secret-path"] }), (error: unknown) => error instanceof Error && error.name === "TerminationUnconfirmedError" && !error.message.includes("secret"));
  assert.deepEqual(unconfirmed.kills, [undefined, "SIGKILL"]);
  assert.equal(unconfirmed.listenerCount("close"), 0);

  const output = new FakeChild(1);
  const outputRunner = createSchtasksRunner({ spawn: () => { queueMicrotask(() => output.stdout.write(Buffer.alloc(9))); return output as never; }, maximumOutputBytes: 8, timeoutMs: 100, terminationGraceMs: 2 });
  await assert.rejects(() => outputRunner({ operation: "query", args: [] }), /output limit/u);
  assert.equal(output.stdout.listenerCount("data"), 0);
});

test("cleanup quarantines only the exact digest and retains substituted capture for recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, cleanup } = await createWindowsHarness(root);
  await adapter.install(windowsDefinition, cleanup);
  const xmlPath = join(root, cleanup.xmlBasename);
  await writeFile(xmlPath, "foreign replacement");
  await assert.rejects(() => adapter.cleanupInstallation(windowsDefinition, cleanup), (error: unknown) => error instanceof GatewayResidentOperationError && error.cleanupState === "xml-cleanup-failed");
  assert.equal(await readFile(xmlPath, "utf8"), "foreign replacement");
});

test("fixed resident errors do not disclose manifest paths, tokens, XML, argv, or child output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-sentinel-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FakeAdapter();
  const service = new GatewayResidentService({ ...serviceOptions(root, adapter), manifestPath: root });
  await assert.rejects(() => service.install(), (error: unknown) => error instanceof Error && !error.message.includes(root) && !error.message.includes("token"));
  const runner = createSchtasksRunner({ spawn: () => { throw new Error("secret argv and output"); } });
  await assert.rejects(() => runner({ operation: "create", args: ["secret-path", "secret-token"] }), (error: unknown) => error instanceof Error && !/secret|path|token/u.test(error.message));
});
