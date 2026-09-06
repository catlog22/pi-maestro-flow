import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSchtasksRunner,
  GatewayResidentOperationError,
  GatewayResidentService,
  SystemdUserAdapter,
  WindowsStartupAdapter,
  WindowsTaskAdapter,
  windowsTaskArguments,
  type GatewayInstallProgress,
  type GatewayRegistrationState,
  type GatewayResidentAdapter,
  type GatewayServiceCleanup,
  type GatewayServiceDefinition,
  type GatewayServiceManifest,
  type SchtasksResult,
  type SchtasksRunner,
  type SystemdCommandResult,
  type WindowsStartupRequest,
  type WindowsStartupRunner,
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

class FakeSpawnedProcess extends EventEmitter {
  unref(): void {}
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

async function createStartupHarness(root: string) {
  const startupPath = join(root, "Startup");
  const stateDirectory = join(root, "state");
  await mkdir(startupPath, { recursive: true });
  const calls: WindowsStartupRequest[] = [];
  const spawned: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const validation = { rejectPath: "", comFailure: false, collideAtPublish: false, createFailureAfterWrite: false, swapSourceOnDelete: false, spawnFailure: false };
  const runner: WindowsStartupRunner = async (request: WindowsStartupRequest) => {
    calls.push(structuredClone(request));
    if (request.operation === "resolve-startup") return { startupPath };
    if (request.operation === "create") {
      await writeFile(request.path, JSON.stringify({ targetPath: request.targetPath, arguments: request.arguments, workingDirectory: request.workingDirectory, description: "Pi Maestro Gateway", windowStyle: 7 }));
      if (validation.createFailureAfterWrite) throw new Error("crash after create");
      return {};
    }
    if (request.operation === "inspect") {
      if (validation.comFailure) throw new Error("private COM detail");
      return JSON.parse(await readFile(request.path, "utf8"));
    }
    if (request.operation === "delete-exact") {
      if (validation.swapSourceOnDelete) {
        await rm(request.path, { force: true });
        await writeFile(request.path, "foreign delete race winner");
      }
      const digest = createHash("sha256").update(await readFile(request.path)).digest("hex");
      if (digest !== request.digest) throw new Error("identity changed");
      await rm(request.path, { force: false });
      return {};
    }
    if (validation.collideAtPublish) await writeFile(request.destination, "foreign race winner");
    if (existsSync(request.destination)) throw new Error("exists");
    await rename(request.source, request.destination);
    return {};
  };
  const adapter = new WindowsStartupAdapter({
    stateDirectory,
    runner,
    resolveCurrentUserSid: async () => "S-1-5-21-1000",
    applyPrivate: async () => undefined,
    validatePath: async (path) => { if (path === validation.rejectPath) throw new Error("private ACL detail"); },
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args: [...args], cwd: options.cwd });
      const child = new FakeSpawnedProcess();
      queueMicrotask(() => validation.spawnFailure ? child.emit("error", new Error("private spawn detail")) : child.emit("spawn"));
      return child;
    },
  });
  return { adapter, startupPath, stateDirectory, calls, spawned, validation };
}

async function readManifest(path: string): Promise<GatewayServiceManifest> { return JSON.parse(await readFile(path, "utf8")) as GatewayServiceManifest; }

const systemdDefinition: GatewayServiceDefinition = {
  name: "pi-maestro-gateway",
  command: "/usr/bin/node",
  args: ["gateway.mjs", "service-run", "--installation-token", "systemd-test-token"],
  cwd: "/tmp/pi-maestro",
  installationToken: "systemd-test-token",
};

function createSystemdHarness(root: string) {
  const unitPath = join(root, "pi-maestro-gateway.service");
  const calls: string[] = [];
  const manager = {
    enabled: "disabled",
    loadState: "not-found",
    fragmentPath: "",
    needDaemonReload: "no",
    failReloads: 0,
    failEnables: 0,
    failDisables: 0,
    unavailable: false,
    malformedShow: false,
  };
  const result = (status: number | null, stdout = "", stderr = ""): SystemdCommandResult => ({ status, stdout, stderr });
  const runner = (args: readonly string[]): SystemdCommandResult => {
    const operation = args[1] ?? "";
    calls.push(args.join(" "));
    if (manager.unavailable) return result(1, "", "権限がありません");
    if (operation === "daemon-reload") {
      if (manager.failReloads > 0) { manager.failReloads -= 1; return result(1, "", "localized reload failure"); }
      if (existsSync(unitPath)) {
        manager.loadState = "loaded";
        manager.fragmentPath = unitPath;
      } else {
        manager.loadState = "not-found";
        manager.fragmentPath = "";
        manager.enabled = "disabled";
      }
      manager.needDaemonReload = "no";
      return result(0);
    }
    if (operation === "enable") {
      if (manager.failEnables > 0) { manager.failEnables -= 1; return result(1, "", "localized enable failure"); }
      manager.enabled = "enabled";
      return result(0);
    }
    if (operation === "disable") {
      if (manager.failDisables > 0) { manager.failDisables -= 1; return result(1, "", "localized disable failure"); }
      manager.enabled = "disabled";
      return result(0);
    }
    if (operation === "start") return result(0);
    if (operation === "is-enabled") return result(manager.enabled === "enabled" || manager.enabled === "enabled-runtime" ? 0 : 1, `${manager.enabled}\n`, "ignored localized diagnostic");
    if (operation === "show") {
      if (manager.malformedShow) return result(0, "LoadState=loaded\nLoadState=loaded\nFragmentPath=opaque\n");
      return result(0, `LoadState=${manager.loadState}\nFragmentPath=${manager.fragmentPath}\nNeedDaemonReload=${manager.needDaemonReload}\n`, "ignored localized diagnostic");
    }
    return result(1);
  };
  return { adapter: new SystemdUserAdapter({ unitPath, runner }), unitPath, manager, calls };
}

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
    constructor() { super("windows-task"); }
    override prepareCleanup(): GatewayServiceCleanup { return { state: "pending", xmlBasename: ".pi-maestro-gateway-task-0123456789abcdefabcd.xml", xmlDigest: "0".repeat(64) }; }
    override async install(definition: GatewayServiceDefinition, _cleanup?: GatewayServiceCleanup, progress?: GatewayInstallProgress): Promise<void> {
      await progress?.({ outcome: "completion-unknown" });
      await progress?.({ outcome: "completed" });
      await super.install(definition);
    }
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
  assert.equal(await state(absentTask(0x80070003, "opaque")), "absent");
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
  await assert.rejects(() => createSchtasksRunner({ spawn: () => graceful as never, timeoutMs: 2, terminationGraceMs: 2 })({ operation: "query", args: [] }), (error: unknown) => error instanceof Error && error.name === "TimeoutError" && (error as Error & { termination?: string }).termination === "confirmed");
  assert.deepEqual(graceful.kills, [undefined]);
  assert.equal(graceful.listenerCount("close"), 0);

  const forced = new FakeChild(2);
  await assert.rejects(() => createSchtasksRunner({ spawn: () => forced as never, timeoutMs: 2, terminationGraceMs: 2 })({ operation: "query", args: [] }), (error: unknown) => error instanceof Error && error.name === "TimeoutError" && (error as Error & { termination?: string }).termination === "confirmed");
  assert.deepEqual(forced.kills, [undefined, "SIGKILL"]);

  const unconfirmed = new FakeChild(undefined);
  await assert.rejects(() => createSchtasksRunner({ spawn: () => unconfirmed as never, timeoutMs: 2, terminationGraceMs: 2 })({ operation: "create", args: ["secret-path"] }), (error: unknown) => error instanceof Error && error.name === "TerminationUnconfirmedError" && (error as Error & { termination?: string }).termination === "unconfirmed" && !error.message.includes("secret"));
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

test("Windows create progress is durable before spawn and completed before verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let taskXml: Buffer | undefined;
  const calls: string[] = [];
  const runner: SchtasksRunner = async (request) => {
    calls.push(request.operation);
    if (request.operation === "query") return taskXml ? schtasksResult(0, taskXml) : absentTask();
    if (request.operation === "create") {
      const persisted = await readManifest(join(root, "service.json"));
      assert.equal(persisted.operation?.stage, "create-dispatched");
      assert.deepEqual(persisted.operation?.windowsCreate, { outcome: "completion-unknown" });
      assert.deepEqual(persisted.operation?.absentObservations, []);
      taskXml = await readFile(request.args.at(-1)!);
      return schtasksResult(0);
    }
    return schtasksResult(0);
  };
  const adapter = new WindowsTaskAdapter({ stateDirectory: root, runner, verifyPrivate: noPrivate, resolveCurrentUserSid: async () => windowsDefinition.userSid! });
  const evidence: string[] = [];
  const service = new GatewayResidentService(serviceOptions(root, adapter, { fault: async (point: string) => {
    if (point === "install:windows-create-response") evidence.push(`response:${(await readManifest(join(root, "service.json"))).operation?.windowsCreate?.outcome}`);
    if (point === "install:windows-create-completed") evidence.push(`completed:${(await readManifest(join(root, "service.json"))).operation?.windowsCreate?.outcome}`);
  } }));
  const installed = await service.install();
  assert.equal(installed.operation?.windowsCreate?.outcome, "completed");
  assert.deepEqual(evidence, ["response:completion-unknown", "completed:completed"]);
  assert.equal(calls.filter((call) => call === "create").length, 1);
});

test("Windows create persistence crash boundaries never spawn early or erase uncertainty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-progress-faults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const expected of [
    { point: "install:intent-durable", outcome: "not-dispatched", creates: 0 },
    { point: "install:windows-create-dispatched", outcome: "completion-unknown", creates: 0 },
    { point: "install:windows-create-response", outcome: "completion-unknown", creates: 1 },
    { point: "install:windows-create-completed", outcome: "completed", creates: 1 },
  ] as const) {
    const caseRoot = join(root, expected.point.replace(/:/gu, "-"));
    let taskXml: Buffer | undefined;
    let creates = 0;
    const runner: SchtasksRunner = async (request) => {
      if (request.operation === "query") return taskXml ? schtasksResult(0, taskXml) : absentTask();
      if (request.operation === "create") { creates += 1; taskXml = await readFile(request.args.at(-1)!); return schtasksResult(0); }
      return schtasksResult(0);
    };
    const adapter = new WindowsTaskAdapter({ stateDirectory: caseRoot, runner, verifyPrivate: noPrivate, resolveCurrentUserSid: async () => windowsDefinition.userSid! });
    const service = new GatewayResidentService(serviceOptions(caseRoot, adapter, { fault: async (point: string) => { if (point === expected.point) throw new Error("simulated crash"); } }));
    await assert.rejects(() => service.install());
    const manifest = await readManifest(join(caseRoot, "service.json"));
    assert.equal(manifest.operation?.windowsCreate?.outcome, expected.outcome);
    assert.equal(creates, expected.creates);
    if (expected.outcome === "completion-unknown") assert.notEqual(manifest.operation?.stage, "cleanup-complete");
  }
});

test("Windows create persistence failure forbids spawn and cleanup failure preserves uncertainty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-persistence-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  {
    const caseRoot = join(root, "persist");
    let creates = 0;
    const adapter = new WindowsTaskAdapter({ stateDirectory: caseRoot, verifyPrivate: noPrivate, resolveCurrentUserSid: async () => windowsDefinition.userSid!, runner: async (request) => {
      if (request.operation === "query") return absentTask();
      if (request.operation === "create") creates += 1;
      return schtasksResult(0);
    } });
    let fileSyncs = 0;
    const service = new GatewayResidentService(serviceOptions(caseRoot, adapter, { durability: {
      syncFile: async () => { fileSyncs += 1; if (fileSyncs === 2) throw new Error("simulated durability failure"); },
      syncDirectory: async () => undefined,
    } }));
    await assert.rejects(() => service.install(), /state could not be persisted/u);
    assert.equal(creates, 0);
    assert.equal((await readManifest(join(caseRoot, "service.json"))).operation?.windowsCreate?.outcome, "completion-unknown");
  }
  {
    const caseRoot = join(root, "cleanup");
    class CleanupFailureAdapter extends WindowsTaskAdapter {
      override async cleanupInstallation(): Promise<void> { throw new GatewayResidentOperationError("Scheduled Task private XML cleanup failed", "recovery-required", "xml-cleanup-failed"); }
    }
    const adapter = new CleanupFailureAdapter({ stateDirectory: caseRoot, verifyPrivate: noPrivate, resolveCurrentUserSid: async () => windowsDefinition.userSid!, runner: async (request) => {
      if (request.operation === "query") return absentTask();
      const error = new Error("opaque") as Error & { termination: "unconfirmed" };
      error.termination = "unconfirmed";
      throw error;
    } });
    await assert.rejects(() => new GatewayResidentService(serviceOptions(caseRoot, adapter)).install());
    const manifest = await readManifest(join(caseRoot, "service.json"));
    assert.equal(manifest.cleanup?.state, "pending");
    assert.deepEqual(manifest.operation?.windowsCreate, { outcome: "completion-unknown", termination: "unconfirmed" });
    assert.equal(manifest.operation?.stage, "termination-unconfirmed");
  }
});

test("confirmed and unconfirmed Windows termination remain blocked across absence and late completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-termination-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const termination of ["confirmed", "unconfirmed"] as const) {
    const caseRoot = join(root, termination);
    let taskVisible = false;
    let submittedXml: Buffer | undefined;
    let creates = 0;
    let deletes = 0;
    const runner: SchtasksRunner = async (request) => {
      if (request.operation === "query") return taskVisible && submittedXml ? schtasksResult(0, submittedXml) : absentTask();
      if (request.operation === "create") {
        creates += 1;
        submittedXml = await readFile(request.args.at(-1)!);
        const error = new Error("opaque") as Error & { termination: typeof termination };
        error.termination = termination;
        throw error;
      }
      if (request.operation === "delete") deletes += 1;
      return schtasksResult(0);
    };
    const adapter = new WindowsTaskAdapter({ stateDirectory: caseRoot, runner, verifyPrivate: noPrivate, resolveCurrentUserSid: async () => windowsDefinition.userSid! });
    await assert.rejects(() => new GatewayResidentService(serviceOptions(caseRoot, adapter)).install(), (error: unknown) => error instanceof GatewayResidentOperationError && error.disposition === "recovery-required");
    const pending = await readManifest(join(caseRoot, "service.json"));
    assert.equal(pending.cleanup?.state, "clean");
    assert.equal(pending.operation?.windowsCreate?.outcome, "completion-unknown");
    assert.equal(pending.operation?.windowsCreate?.termination, termination);
    assert.equal(pending.operation?.stage, `termination-${termination}`);
    for (let restart = 0; restart < 5; restart += 1) {
      let now = 20_000 + restart * 10_000;
      const resumed = new GatewayResidentService(serviceOptions(caseRoot, adapter, { now: () => now, delay: async (ms: number) => { now += ms; } }));
      await assert.rejects(() => resumed.start(), /completion is unknown/u);
      assert.equal((await readManifest(join(caseRoot, "service.json"))).installationId, pending.installationId);
    }
    taskVisible = true;
    await assert.rejects(() => new GatewayResidentService(serviceOptions(caseRoot, adapter)).start(), /completion is unknown/u);
    assert.equal((await readManifest(join(caseRoot, "service.json"))).installationId, pending.installationId);
    assert.equal(creates, 1);
    assert.equal(deletes, 0);
  }
});

test("legacy pending Windows intent normalizes to unknown while installed legacy remains compatible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-legacy-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition: GatewayServiceDefinition = { ...windowsDefinition };
  const pending: GatewayServiceManifest = {
    version: 1, installationId: "legacy-pending", installationToken: definition.installationToken, kind: "windows-task",
    definitionHash: hashDefinition(definition), definition, installedAt: 1, lifecycle: "installing",
    taskName: definition.taskName, operation: { stage: "registration-unknown", startedAt: 1, updatedAt: 1, absentObservations: [1, 251, 5_001] },
  };
  await writeFile(join(root, "service.json"), JSON.stringify(pending));
  const adapter = new FakeAdapter("windows-task");
  adapter.state = "absent";
  let now = 20_000;
  const service = new GatewayResidentService(serviceOptions(root, adapter, { now: () => now, delay: async (ms: number) => { now += ms; } }));
  await assert.rejects(() => service.install(), /completion is unknown/u);
  assert.equal((await readManifest(join(root, "service.json"))).installationId, pending.installationId);
  assert.equal(adapter.installs, 0);
});

test("Windows query failures cannot masquerade as create termination evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-windows-query-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const progress: unknown[] = [];
  const adapter = new WindowsTaskAdapter({ stateDirectory: root, verifyPrivate: noPrivate, runner: async () => {
    const error = new Error("opaque") as Error & { termination: "unconfirmed" };
    error.termination = "unconfirmed";
    throw error;
  } });
  await assert.rejects(() => adapter.install(windowsDefinition, adapter.prepareCleanup(windowsDefinition), async (value) => { progress.push(value); }), /ownership is not proven absent/u);
  assert.deepEqual(progress, []);
});

test("stable absence always takes a fresh final sample and clears stored evidence on contradiction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-fresh-absence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FakeAdapter();
  const installed = await new GatewayResidentService(serviceOptions(root, adapter)).install();
  await writeFile(join(root, "service.json"), JSON.stringify({ ...installed, lifecycle: "installing", operation: { stage: "observing-absence", startedAt: 0, updatedAt: 5_000, absentObservations: [0, 250, 5_000] } }));
  const states: GatewayRegistrationState[] = ["absent", "matching"];
  adapter.queryDefinitionState = async () => { adapter.queries += 1; return states.shift() ?? "matching"; };
  let now = 10_000;
  const service = new GatewayResidentService(serviceOptions(root, adapter, { now: () => now, delay: async (ms: number) => { now += ms; } }));
  await assert.rejects(() => service.install(), /absence is not stable/u);
  assert.equal(adapter.queries, 2);
  assert.deepEqual((await readManifest(join(root, "service.json"))).operation?.absentObservations, []);
});

test("an initial contradictory registration clears absence evidence across reconciliation attempts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-cross-attempt-absence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FakeAdapter();
  const installed = await new GatewayResidentService(serviceOptions(root, adapter)).install();
  await writeFile(join(root, "service.json"), JSON.stringify({ ...installed, lifecycle: "installing", operation: { stage: "observing-absence", startedAt: 0, updatedAt: 5_000, absentObservations: [0, 250, 5_000] } }));

  adapter.state = "foreign";
  let now = 10_000;
  await assert.rejects(
    () => new GatewayResidentService(serviceOptions(root, adapter, { now: () => now, delay: async (ms: number) => { now += ms; } })).install(),
    /could not be reconciled/u,
  );
  const cleared = await readManifest(join(root, "service.json"));
  assert.equal(cleared.installationId, installed.installationId);
  assert.deepEqual(cleared.operation?.absentObservations, []);

  const states: GatewayRegistrationState[] = ["absent", "absent", "matching"];
  adapter.queryDefinitionState = async () => { adapter.queries += 1; return states.shift() ?? "matching"; };
  const queriesBefore = adapter.queries;
  await assert.rejects(
    () => new GatewayResidentService(serviceOptions(root, adapter, { now: () => now, delay: async (ms: number) => { now += ms; } })).install(),
    /absence is not stable/u,
  );
  assert.equal(adapter.queries - queriesBefore, 3);
  const retained = await readManifest(join(root, "service.json"));
  assert.equal(retained.installationId, installed.installationId);
  assert.deepEqual(retained.operation?.absentObservations, []);
});

test("systemd retries reload and enable without rewriting exact owned units", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-systemd-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const failure of ["reload", "enable"] as const) {
    const caseRoot = join(root, failure);
    const harness = createSystemdHarness(caseRoot);
    if (failure === "reload") harness.manager.failReloads = 1;
    else harness.manager.failEnables = 1;
    const first = new GatewayResidentService(serviceOptions(caseRoot, harness.adapter));
    await assert.rejects(() => first.install(), (error: unknown) => error instanceof GatewayResidentOperationError && error.disposition === "recovery-required");
    const before = await readFile(harness.unitPath, "utf8");
    const pending = await readManifest(join(caseRoot, "service.json"));
    assert.equal(pending.lifecycle, "installing");
    const resumed = new GatewayResidentService(serviceOptions(caseRoot, harness.adapter));
    await resumed.start();
    assert.equal(await readFile(harness.unitPath, "utf8"), before);
    assert.equal((await readManifest(join(caseRoot, "service.json"))).lifecycle, "installed");
    assert.equal(harness.manager.enabled, "enabled");
    assert.equal(harness.calls.filter((call) => call.includes("daemon-reload")).length >= 2, true);
  }
});

test("systemd distinguishes exact ownership from enablement and fails closed on ambiguous states", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-systemd-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = createSystemdHarness(root);
  await harness.adapter.install(systemdDefinition);
  assert.equal(await harness.adapter.queryDefinitionOwnership(systemdDefinition), "exact-owned");
  assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "matching");
  for (const enabled of ["disabled", "enabled-runtime", "masked"] as const) {
    harness.manager.enabled = enabled;
    assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "inconclusive");
  }
  harness.manager.enabled = "enabled";
  harness.manager.needDaemonReload = "yes";
  assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "inconclusive");
  harness.manager.needDaemonReload = "no";
  harness.manager.malformedShow = true;
  assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "inconclusive");
  harness.manager.malformedShow = false;
  harness.manager.unavailable = true;
  assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "inconclusive");
  harness.manager.unavailable = false;
  await writeFile(harness.unitPath, "foreign unit");
  const beforeCalls = harness.calls.length;
  await assert.rejects(() => harness.adapter.install(systemdDefinition), /Refused to replace/u);
  await assert.rejects(() => harness.adapter.uninstall(systemdDefinition), /Refused to delete/u);
  assert.equal(await readFile(harness.unitPath, "utf8"), "foreign unit");
  assert.equal(harness.calls.slice(beforeCalls).some((call) => /daemon-reload| enable | disable /u.test(` ${call} `)), false);
});

test("systemd absence requires manager not-found and ignores localized diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-systemd-absence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = createSystemdHarness(root);
  assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "absent");
  harness.manager.unavailable = true;
  assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "inconclusive");
  harness.manager.unavailable = false;
  harness.manager.loadState = "loaded";
  harness.manager.fragmentPath = "/runtime/foreign.service";
  assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "foreign");
  harness.manager.loadState = "not-found";
  harness.manager.fragmentPath = "";
  harness.manager.needDaemonReload = "yes";
  assert.equal(await harness.adapter.queryDefinitionState(systemdDefinition), "inconclusive");
});

test("owned disabled systemd uninstall succeeds and post-remove reload resumes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-systemd-uninstall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = createSystemdHarness(root);
  const service = new GatewayResidentService(serviceOptions(root, harness.adapter));
  await service.install();
  harness.manager.enabled = "disabled";
  harness.manager.failDisables = 1;
  assert.equal((await service.status()).degraded, true);
  harness.manager.failReloads = 1;
  await assert.rejects(() => service.uninstall(), /manager operation failed/u);
  assert.equal(existsSync(harness.unitPath), false);
  assert.equal((await readManifest(join(root, "service.json"))).lifecycle, "uninstalling");
  assert.equal(harness.calls.some((call) => call.includes(" disable ")), false);
  const resumed = new GatewayResidentService(serviceOptions(root, harness.adapter));
  assert.equal(await resumed.uninstall(), true);
  assert.equal(existsSync(join(root, "service.json")), false);
  assert.equal(harness.manager.loadState, "not-found");
});

test("legacy systemd manifests report enabled truthfully and disabled read-only degradation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-systemd-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = createSystemdHarness(root);
  await harness.adapter.install(systemdDefinition);
  const legacy: GatewayServiceManifest = {
    version: 1, installationId: "legacy-systemd", installationToken: systemdDefinition.installationToken, kind: "systemd-user",
    definitionHash: hashDefinition(systemdDefinition), definition: systemdDefinition, installedAt: 1,
  };
  await writeFile(join(root, "service.json"), JSON.stringify(legacy));
  const service = new GatewayResidentService(serviceOptions(root, harness.adapter));
  const enableCalls = harness.calls.filter((call) => call.includes(" enable ")).length;
  assert.equal((await service.status()).degraded, false);
  harness.manager.enabled = "disabled";
  assert.equal((await service.status()).degraded, true);
  assert.equal(harness.calls.filter((call) => call.includes(" enable ")).length, enableCalls);
  assert.equal((await readManifest(join(root, "service.json"))).lifecycle, undefined);
});

test("Windows Startup installs through staged digest-bound publication and starts exact argv", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  const service = new GatewayResidentService(serviceOptions(join(root, "state"), harness.adapter));
  const manifest = await service.install();
  assert.equal(manifest.kind, "windows-startup");
  assert.equal(manifest.definition.startupName, "Pi Maestro Gateway.lnk");
  assert.match(manifest.definition.shortcutDigest!, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.cleanup?.kind, "windows-startup");
  assert.equal(manifest.cleanup?.state, "clean");
  assert.equal((manifest.cleanup as { shortcutDigest?: string }).shortcutDigest, manifest.definition.shortcutDigest);
  assert.deepEqual((await readdir(harness.startupPath)).sort(), ["Pi Maestro Gateway.lnk"]);
  assert.equal((await readdir(harness.stateDirectory)).some((name) => name.endsWith(".lnk")), false);
  await harness.adapter.install(manifest.definition, manifest.cleanup);
  assert.equal(harness.calls.filter((call) => call.operation === "create").length, 1);
  await service.start();
  assert.deepEqual(harness.spawned, [{ command: manifest.definition.command, args: manifest.definition.args, cwd: manifest.definition.cwd }]);
  assert.equal(harness.calls.some((call) => "args" in call && call.args.some((arg) => arg.toLowerCase().includes("schtasks"))), false);
});

test("manifest kind routes later operations to Windows Startup without a selector", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  const stateRoot = join(root, "state");
  await new GatewayResidentService(serviceOptions(stateRoot, harness.adapter)).install();
  const wrong = new FakeAdapter("windows-task");
  const conflicting = new GatewayResidentService({ ...serviceOptions(stateRoot, wrong), preferredKind: "windows-task", adapterResolver: (kind) => kind === "windows-startup" ? harness.adapter : wrong });
  await assert.rejects(() => conflicting.status(), /conflicts with the installed manifest/u);
  await assert.rejects(() => conflicting.uninstall(), /conflicts with the installed manifest/u);
  assert.equal(existsSync(join(harness.startupPath, "Pi Maestro Gateway.lnk")), true);
  const routed = new GatewayResidentService({ ...serviceOptions(stateRoot, wrong), adapterResolver: (kind) => {
    if (kind === "windows-startup") return harness.adapter;
    return wrong;
  } });
  assert.equal((await routed.status()).kind, "windows-startup");
  assert.equal(await routed.uninstall(), true);
  assert.equal(wrong.uninstalls, 0);
  assert.equal(existsSync(join(harness.startupPath, "Pi Maestro Gateway.lnk")), false);
});

test("Windows Startup refuses foreign, tampered, ACL-invalid, and COM-inconclusive shortcuts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-foreign-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  const final = join(harness.startupPath, "Pi Maestro Gateway.lnk");
  await writeFile(final, "foreign shortcut");
  await assert.rejects(() => new GatewayResidentService(serviceOptions(join(root, "state"), harness.adapter)).install(), /Refused to replace/u);
  assert.equal(await readFile(final, "utf8"), "foreign shortcut");
  await rm(final);
  await rm(join(root, "state", "service.json"), { force: true });
  const service = new GatewayResidentService(serviceOptions(join(root, "state"), harness.adapter));
  const manifest = await service.install();
  await writeFile(final, "tampered shortcut");
  await assert.rejects(() => service.uninstall(), /ownership is not proven/u);
  assert.equal(await readFile(final, "utf8"), "tampered shortcut");
  await writeFile(final, JSON.stringify({ targetPath: manifest.definition.command, arguments: windowsTaskArguments(manifest.definition.args), workingDirectory: manifest.definition.cwd, description: "Pi Maestro Gateway", windowStyle: 7 }));
  harness.validation.rejectPath = final;
  assert.equal(await harness.adapter.queryDefinitionState(manifest.definition), "foreign");
  harness.validation.rejectPath = "";
  harness.validation.comFailure = true;
  assert.equal(await harness.adapter.queryDefinitionState(manifest.definition), "foreign");

  const raceRoot = join(root, "race");
  const raced = await createStartupHarness(raceRoot);
  raced.validation.collideAtPublish = true;
  await assert.rejects(() => new GatewayResidentService(serviceOptions(join(raceRoot, "state"), raced.adapter)).install(), /publication failed/u);
  assert.equal(await readFile(join(raced.startupPath, "Pi Maestro Gateway.lnk"), "utf8"), "foreign race winner");
});

test("Windows Startup crash recovery resumes exact staged publication and quarantines substitutions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  const stateRoot = join(root, "state");
  let crash = true;
  const first = new GatewayResidentService(serviceOptions(stateRoot, harness.adapter, { fault: async (point: string) => { if (crash && point === "install:startup-staged") throw new Error("crash"); } }));
  await assert.rejects(() => first.install(), /requires recovery/u);
  const pending = await readManifest(join(stateRoot, "service.json"));
  assert.equal(pending.lifecycle, "installing");
  assert.match(pending.definition.shortcutDigest!, /^[a-f0-9]{64}$/u);
  crash = false;
  await new GatewayResidentService(serviceOptions(stateRoot, harness.adapter)).start();
  assert.equal((await readManifest(join(stateRoot, "service.json"))).lifecycle, "installed");
  assert.deepEqual(await readdir(harness.startupPath), ["Pi Maestro Gateway.lnk"]);

  const secondRoot = join(root, "substitution");
  const substituted = await createStartupHarness(secondRoot);
  const secondState = join(secondRoot, "state");
  await assert.rejects(() => new GatewayResidentService(serviceOptions(secondState, substituted.adapter, { fault: async (point: string) => { if (point === "install:startup-staged") throw new Error("crash"); } })).install());
  const secondManifest = await readManifest(join(secondState, "service.json"));
  const cleanup = secondManifest.cleanup as { stagingBasename: string };
  const staging = join(secondState, cleanup.stagingBasename);
  await writeFile(staging, "foreign replacement");
  await assert.rejects(() => new GatewayResidentService(serviceOptions(secondState, substituted.adapter)).start(), /staging identity could not be verified/u);
  assert.equal(await readFile(staging, "utf8"), "foreign replacement");
});

test("Windows Startup resumes a pre-digest crash and accepts proven-empty cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-pre-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  const stateRoot = join(root, "state");
  harness.validation.createFailureAfterWrite = true;
  await assert.rejects(() => new GatewayResidentService(serviceOptions(stateRoot, harness.adapter)).install(), /shortcut creation failed/u);
  const pending = await readManifest(join(stateRoot, "service.json"));
  assert.equal(pending.definition.shortcutDigest, undefined);
  assert.equal((pending.cleanup as { shortcutDigest?: string }).shortcutDigest, undefined);
  harness.validation.createFailureAfterWrite = false;
  await new GatewayResidentService(serviceOptions(stateRoot, harness.adapter)).start();
  const installed = await readManifest(join(stateRoot, "service.json"));
  assert.equal(installed.lifecycle, "installed");
  assert.match(installed.definition.shortcutDigest!, /^[a-f0-9]{64}$/u);
  assert.equal(harness.calls.filter((call) => call.operation === "create").length, 1, "recovery must reuse the exact staged shortcut");

  const emptyRoot = join(root, "empty");
  const empty = await createStartupHarness(emptyRoot);
  const definition = { ...windowsDefinition, taskName: undefined, startupName: "Pi Maestro Gateway.lnk" as const };
  await empty.adapter.cleanupInstallation!(definition, empty.adapter.prepareCleanup!(definition));
});

test("Windows Startup uses identity-bound deletion and preserves a raced foreign shortcut", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-delete-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  const service = new GatewayResidentService(serviceOptions(join(root, "state"), harness.adapter));
  await service.install();
  harness.validation.swapSourceOnDelete = true;
  await assert.rejects(() => service.uninstall(), /Refused to delete Windows Startup registration/u);
  assert.equal(await readFile(join(harness.startupPath, "Pi Maestro Gateway.lnk"), "utf8"), "foreign delete race winner");
  assert.equal(harness.calls.some((call) => call.operation === "delete-exact"), true);
});

test("Windows Startup converts asynchronous spawn errors to a fixed service failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-spawn-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  const stateRoot = join(root, "state");
  const service = new GatewayResidentService(serviceOptions(stateRoot, harness.adapter));
  const manifest = await service.install();
  harness.validation.spawnFailure = true;
  await assert.rejects(() => service.start(), (error: unknown) => error instanceof GatewayResidentOperationError
    && error.message === "Windows Startup process could not be started"
    && !error.message.includes(manifest.installationToken)
    && !error.message.includes(root));
});

test("Scheduled Task completion-unknown never switches to explicitly preferred Startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-no-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const taskAdapter = new WindowsTaskAdapter({ stateDirectory: stateRoot, verifyPrivate: noPrivate, resolveCurrentUserSid: async () => windowsDefinition.userSid!, runner: async (request) => {
    if (request.operation === "query") return absentTask();
    if (request.operation === "create") { const error = new Error("opaque") as Error & { termination: "confirmed" }; error.termination = "confirmed"; throw error; }
    return schtasksResult(0);
  } });
  await assert.rejects(() => new GatewayResidentService(serviceOptions(stateRoot, taskAdapter)).install());
  const startup = await createStartupHarness(join(root, "startup-backend"));
  const service = new GatewayResidentService({ ...serviceOptions(stateRoot, startup.adapter), preferredKind: "windows-startup", adapterResolver: (kind) => kind === "windows-task" ? taskAdapter : startup.adapter });
  await assert.rejects(() => service.start(), /completion is unknown/u);
  assert.equal(startup.calls.length, 0);
  assert.equal((await readManifest(join(stateRoot, "service.json"))).kind, "windows-task");
});

test("Windows Startup manifest validation is discriminated and errors are redacted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-startup-validation-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  const stateRoot = join(root, "state");
  const manifest = await new GatewayResidentService(serviceOptions(stateRoot, harness.adapter)).install();
  await writeFile(join(stateRoot, "service.json"), JSON.stringify({ ...manifest, kind: "systemd-user" }));
  const status = await new GatewayResidentService(serviceOptions(stateRoot, harness.adapter)).status();
  assert.equal(status.recoveryRequired, true);
  assert.equal(status.error, "Resident service state is unreadable");
  await writeFile(join(stateRoot, "service.json"), JSON.stringify(manifest));
  harness.validation.comFailure = true;
  const secret = manifest.installationToken;
  await assert.rejects(() => harness.adapter.start(manifest.definition), (error: unknown) => error instanceof Error && !error.message.includes(secret) && !error.message.includes(root) && !error.message.includes("private COM detail"));
});

test("ensure installs and starts once, waits for authenticated readiness, and remains idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-resident-ensure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createStartupHarness(root);
  let now = 0;
  let lockHeld = false;
  let lockAcquisitions = 0;
  const waits: number[] = [];
  const statuses = [
    { installed: true, running: false, ready: false, degraded: false, fallback: false },
    { installed: true, running: true, ready: false, degraded: true, fallback: false },
    { installed: true, running: true, ready: true, degraded: false, fallback: false },
  ];
  const service = new GatewayResidentService(serviceOptions(root, harness.adapter, {
    now: () => now,
    acquireLock: async () => {
      lockAcquisitions += 1;
      lockHeld = true;
      return { instance: "test", token: "test", assertOwned: async () => assert.equal(lockHeld, true), release: async () => { lockHeld = false; return true; } };
    },
    delay: async (ms: number) => { assert.equal(lockHeld, true); waits.push(ms); now += ms; },
    statusProbe: async () => { assert.equal(lockHeld, true); return statuses.shift() ?? { installed: true, running: true, ready: true, degraded: false, fallback: false }; },
  }));

  const first = await service.ensure();
  assert.equal(first.ensured, true);
  assert.equal(first.installedNow, true);
  assert.equal(first.kind, "windows-startup");
  assert.equal(first.persistence, "next-interactive-sign-in");
  assert.deepEqual(first.status, { installed: true, running: true, ready: true, degraded: false });
  assert.equal(harness.spawned.length, 1);
  assert.deepEqual(waits, [100, 100]);
  assert.equal(lockAcquisitions, 1, "the complete ensure flow must use one mutation lock");
  assert.equal(lockHeld, false);

  const second = await service.ensure();
  assert.equal(second.installedNow, false);
  assert.equal(second.installationId, first.installationId);
  assert.equal(harness.spawned.length, 1, "ready ensure must not restart");
});

test("ensure observes an already-running instance without starting and times out without removing registration", async (t) => {
  const runningRoot = await mkdtemp(join(tmpdir(), "gateway-resident-ensure-running-"));
  const timeoutRoot = await mkdtemp(join(tmpdir(), "gateway-resident-ensure-timeout-"));
  t.after(() => Promise.all([rm(runningRoot, { recursive: true, force: true }), rm(timeoutRoot, { recursive: true, force: true })]));

  const runningAdapter = new FakeAdapter();
  let runningNow = 0;
  let runningPolls = 0;
  const running = new GatewayResidentService(serviceOptions(runningRoot, runningAdapter, {
    now: () => runningNow,
    delay: async (ms: number) => { runningNow += ms; },
    statusProbe: async () => (++runningPolls < 3
      ? { installed: true, running: true, ready: false, degraded: true, fallback: false }
      : { installed: true, running: true, ready: true, degraded: false, fallback: false }),
  }));
  await running.install();
  const runningResult = await running.ensure();
  assert.equal(runningResult.installedNow, false);
  assert.equal(runningAdapter.starts, 0, "running but unready must only be observed");

  const timeoutAdapter = new FakeAdapter();
  let timeoutNow = 0;
  const timed = new GatewayResidentService(serviceOptions(timeoutRoot, timeoutAdapter, {
    now: () => timeoutNow,
    delay: async (ms: number) => { timeoutNow += ms; },
    statusProbe: async () => ({ installed: true, running: false, ready: false, degraded: false, fallback: false }),
  }));
  await assert.rejects(() => timed.ensure(), /did not become ready within 15 seconds/u);
  assert.equal(timeoutAdapter.installs, 1);
  assert.equal(timeoutAdapter.starts, 1);
  assert.equal(timeoutAdapter.uninstalls, 0);
  assert.ok(await readFile(join(timeoutRoot, "service.json"), "utf8"), "verified registration must remain installed after timeout");
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
