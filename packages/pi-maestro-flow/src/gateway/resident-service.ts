/** User-level resident Gateway registration with durable installation intent and owner fencing. */
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { DOMParser } from "linkedom";
import type { Readable } from "node:stream";
import { GATEWAY_STATE_VERSION, type GatewayOwnerRecord } from "./contracts.ts";
import { gatewayIpcAddress, requestGatewayIpcControl } from "./ipc.ts";
import { GatewayOwnerStore } from "./owner-store.ts";
import { acquirePrivateStateLock, type PrivateStateDurability, type PrivateStateLock } from "./private-state-transaction.ts";
import { gatewayOwnerPath, gatewayServiceManifestPath, readGatewayJson, writeGatewayJsonAtomic } from "./state-paths.ts";

const SERVICE_NAME = "pi-maestro-gateway";
const LEGACY_WINDOWS_URI = "\\PiMaestroGateway";
const MAX_MANIFEST_BYTES = 128 * 1024;
const RESIDENT_LOCK_NAME = "resident-service.lock";
const ABSENCE_OBSERVATIONS = 3;
const ABSENCE_MIN_INTERVAL_MS = 250;
const ABSENCE_MIN_SPAN_MS = 5_000;

export type GatewayResidentKind = "windows-task" | "systemd-user" | "detached-fallback";
export type GatewayServiceLifecycle = "installing" | "installed" | "uninstalling";
export interface GatewayServiceDefinition {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  installationToken: string;
  /** Additive Windows identity fields; absent on legacy v1 manifests. */
  taskName?: string;
  userSid?: string;
}
export interface GatewayServiceOperation {
  stage: string;
  startedAt: number;
  updatedAt: number;
  deadlineAt?: number;
  absentObservations?: number[];
}
export interface GatewayServiceCleanup {
  state: "pending" | "clean";
  xmlBasename: string;
  xmlDigest: string;
}
export interface GatewayServiceManifest {
  version: typeof GATEWAY_STATE_VERSION;
  installationId: string;
  installationToken: string;
  kind: GatewayResidentKind;
  definitionHash: string;
  definition: GatewayServiceDefinition;
  installedAt: number;
  /** Optional on disk for backwards compatibility; normalized to installed when absent. */
  lifecycle?: GatewayServiceLifecycle;
  taskName?: string;
  operation?: GatewayServiceOperation;
  cleanup?: GatewayServiceCleanup;
}
export type GatewayRegistrationState = "matching" | "absent" | "foreign" | "inconclusive";
export interface GatewayInstallationIdentity { taskName?: string; userSid?: string; }
export interface GatewayResidentAdapter {
  readonly kind: GatewayResidentKind;
  prepareInstallation?(installationId: string): Promise<GatewayInstallationIdentity>;
  prepareCleanup?(definition: GatewayServiceDefinition): GatewayServiceCleanup;
  install(definition: GatewayServiceDefinition, cleanup?: GatewayServiceCleanup): Promise<void>;
  cleanupInstallation?(definition: GatewayServiceDefinition, cleanup: GatewayServiceCleanup): Promise<void>;
  start(definition: GatewayServiceDefinition): Promise<void>;
  readDefinition(): Promise<GatewayServiceDefinition | undefined>;
  matchesDefinition?(definition: GatewayServiceDefinition): Promise<boolean>;
  queryDefinitionState?(definition: GatewayServiceDefinition): Promise<GatewayRegistrationState>;
  uninstall(definition: GatewayServiceDefinition): Promise<void>;
}

export class GatewayResidentOperationError extends Error {
  readonly disposition: "unchanged" | "rolled-back" | "recovery-required";
  readonly cleanupState: "clean" | "xml-cleanup-failed";
  readonly primaryDisposition?: GatewayResidentOperationError["disposition"];
  constructor(message: string, disposition: GatewayResidentOperationError["disposition"], cleanupState: GatewayResidentOperationError["cleanupState"] = "clean", primaryDisposition?: GatewayResidentOperationError["disposition"]) {
    super(message);
    this.name = "GatewayResidentOperationError";
    this.disposition = disposition;
    this.cleanupState = cleanupState;
    this.primaryDisposition = primaryDisposition;
  }
}
export interface GatewayResidentStatus {
  installed: boolean;
  running: boolean;
  ready: boolean;
  degraded: boolean;
  fallback: boolean;
  kind?: GatewayResidentKind;
  lifecycle?: GatewayServiceLifecycle;
  recoveryRequired?: boolean;
  owner?: Pick<GatewayOwnerRecord, "pid" | "startedAt">;
  error?: string;
}

function definitionHash(value: GatewayServiceDefinition): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function sameDefinition(left: GatewayServiceDefinition, right: GatewayServiceDefinition): boolean {
  return definitionHash(left) === definitionHash(right) && left.installationToken === right.installationToken;
}
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0 || result.error) throw new Error("Resident service manager operation failed");
}

class SystemdUserAdapter implements GatewayResidentAdapter {
  readonly kind = "systemd-user" as const;
  readonly unitPath = join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  private render(definition: GatewayServiceDefinition): string {
    const exec = [definition.command, ...definition.args].map(shellQuote).join(" ");
    const encoded = Buffer.from(JSON.stringify(definition), "utf8").toString("base64");
    return `# X-Pi-Maestro-Gateway-Definition=${encoded}\n[Unit]\nDescription=Pi Maestro Gateway\n\n[Service]\nType=simple\nWorkingDirectory=${definition.cwd}\nEnvironment=PI_MAESTRO_GATEWAY_INSTALLATION=${definition.installationToken}\nExecStart=${exec}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
  }
  async install(definition: GatewayServiceDefinition): Promise<void> {
    const state = await this.queryDefinitionState(definition);
    if (state === "matching") return;
    if (state !== "absent") throw new GatewayResidentOperationError("Refused to replace resident service registration", "recovery-required");
    await mkdir(dirname(this.unitPath), { recursive: true, mode: 0o700 });
    await writeFile(this.unitPath, this.render(definition), { encoding: "utf8", mode: 0o600 });
    await chmod(this.unitPath, 0o600).catch(() => undefined);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", SERVICE_NAME]);
  }
  async start(): Promise<void> { run("systemctl", ["--user", "start", SERVICE_NAME]); }
  async matchesDefinition(definition: GatewayServiceDefinition): Promise<boolean> { return (await this.queryDefinitionState(definition)) === "matching"; }
  async queryDefinitionState(definition: GatewayServiceDefinition): Promise<GatewayRegistrationState> {
    try { return (await readFile(this.unitPath, "utf8")) === this.render(definition) ? "matching" : "foreign"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "inconclusive"; }
  }
  async readDefinition(): Promise<GatewayServiceDefinition | undefined> {
    try {
      const text = await readFile(this.unitPath, "utf8");
      const encoded = /^# X-Pi-Maestro-Gateway-Definition=([^\r\n]+)$/m.exec(text)?.[1];
      return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as GatewayServiceDefinition : undefined;
    } catch { return undefined; }
  }
  async uninstall(definition: GatewayServiceDefinition): Promise<void> {
    const state = await this.queryDefinitionState(definition);
    if (state === "absent") return;
    if (state !== "matching") throw new GatewayResidentOperationError("Refused to delete resident service registration", "recovery-required");
    run("systemctl", ["--user", "disable", SERVICE_NAME]);
    await rm(this.unitPath, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  }
}

function xmlEscape(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;"); }
export function windowsTaskArguments(args: string[]): string { return args.map((value) => `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`).join(" "); }

const TASK_NAMESPACE = "http://schemas.microsoft.com/windows/2004/02/mit/task";
const SCHTASKS_TIMEOUT_MS = 30_000;
const SCHTASKS_MAX_OUTPUT_BYTES = 128 * 1024;

export interface SchtasksRequest {
  operation: "create" | "run" | "query" | "delete";
  args: readonly string[];
  signal?: AbortSignal;
}
export interface SchtasksResult { exitCode: number; stdout: Buffer; stderr: Buffer; }
export type SchtasksRunner = (request: SchtasksRequest) => Promise<SchtasksResult>;

type SchtasksChild = ChildProcessByStdio<null, Readable, Readable>;
type SpawnSchtasks = (command: string, args: readonly string[], options: { windowsHide: true; shell: false; stdio: ["ignore", "pipe", "pipe"] }) => SchtasksChild;

export function createSchtasksRunner(options: { spawn?: SpawnSchtasks; timeoutMs?: number; maximumOutputBytes?: number; terminationGraceMs?: number } = {}): SchtasksRunner {
  const spawnChild = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const timeoutMs = options.timeoutMs ?? SCHTASKS_TIMEOUT_MS;
  const maximumOutputBytes = options.maximumOutputBytes ?? SCHTASKS_MAX_OUTPUT_BYTES;
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  return async (request) => new Promise<SchtasksResult>((resolve, reject) => {
    if (request.signal?.aborted) { reject(schtasksError("aborted")); return; }
    let child: SchtasksChild;
    try { child = spawnChild("schtasks.exe", request.args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { reject(schtasksError("failed to start")); return; }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    const onStdout = (chunk: Buffer | string) => capture(stdout, chunk);
    const onStderr = (chunk: Buffer | string) => capture(stderr, chunk);
    const onError = () => fail(schtasksError("failed"));
    const onClose = (code: number | null) => { if (!terminating) finish(code ?? -1); };
    const onAbort = () => fail(schtasksError("aborted"));
    const deadline = setTimeout(() => fail(schtasksError("timed out")), timeoutMs);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    function capture(target: Buffer[], chunk: Buffer | string): void {
      if (settled || terminating) return;
      const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maximumOutputBytes) { bytes.fill(0); fail(schtasksError("exceeded output limit")); return; }
      target.push(bytes);
    }
    function cleanup(): void {
      clearTimeout(deadline);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      request.signal?.removeEventListener("abort", onAbort);
    }
    function finish(exitCode: number): void {
      if (settled || terminating) return;
      settled = true;
      cleanup();
      resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      zeroChunks(stdout); zeroChunks(stderr);
    }
    function fail(error: Error): void {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(deadline);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      request.signal?.removeEventListener("abort", onAbort);
      void terminateAndConfirm(child, terminationGraceMs).then((confirmed) => {
        settled = true;
        zeroChunks(stdout); zeroChunks(stderr);
        reject(confirmed ? error : schtasksError("termination could not be confirmed"));
      });
    }
  });
}

async function terminateAndConfirm(child: SchtasksChild, graceMs: number): Promise<boolean> {
  const waitForClose = (): { promise: Promise<boolean>; cancel: () => void } => {
    let timer: NodeJS.Timeout;
    let listener: () => void;
    const promise = new Promise<boolean>((resolve) => {
      listener = () => { clearTimeout(timer); child.removeListener("close", listener); resolve(true); };
      timer = setTimeout(() => { child.removeListener("close", listener); resolve(false); }, graceMs);
      child.once("close", listener);
    });
    return { promise, cancel: () => { clearTimeout(timer); child.removeListener("close", listener); } };
  };
  const graceful = waitForClose();
  try { child.kill(); } catch { /* sanitized */ }
  if (await graceful.promise) return true;
  graceful.cancel();
  const forced = waitForClose();
  try { child.kill("SIGKILL"); } catch { /* sanitized */ }
  const confirmed = await forced.promise;
  forced.cancel();
  return confirmed;
}

function zeroChunks(chunks: Buffer[]): void { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; }
function schtasksError(reason: string): Error {
  const error = new Error(`Scheduled Task operation ${reason}`);
  error.name = reason === "timed out" ? "TimeoutError" : reason === "aborted" ? "AbortError" : reason.includes("termination") ? "TerminationUnconfirmedError" : "GatewayResidentOperationError";
  return error;
}

interface WindowsTaskFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open: typeof open;
  lstat: typeof lstat;
  readFile: typeof readFile;
  rename: typeof rename;
  rm(path: string, options: { force: boolean }): Promise<void>;
}
const windowsTaskFs: WindowsTaskFs = { mkdir, open, lstat, readFile, rename, rm };
export interface WindowsTaskAdapterOptions {
  stateDirectory: string;
  runner?: SchtasksRunner;
  fs?: WindowsTaskFs;
  verifyPrivate?: (path: string, kind: "directory" | "file") => Promise<void>;
  resolveCurrentUserSid?: () => Promise<string>;
  signal?: AbortSignal;
  /** Accepted for compatibility with the former random temporary-name seam. */
  randomUUID?: () => string;
}

export class WindowsTaskAdapter implements GatewayResidentAdapter {
  readonly kind = "windows-task" as const;
  private readonly runner: SchtasksRunner;
  private readonly fs: WindowsTaskFs;
  private readonly verifyPrivate: (path: string, kind: "directory" | "file") => Promise<void>;
  private readonly resolveSid: () => Promise<string>;
  private readonly signal?: AbortSignal;
  constructor(private readonly options: WindowsTaskAdapterOptions) {
    this.runner = options.runner ?? createSchtasksRunner();
    this.fs = options.fs ?? windowsTaskFs;
    this.verifyPrivate = options.verifyPrivate ?? verifyWindowsPrivatePath;
    this.resolveSid = options.resolveCurrentUserSid ?? currentWindowsUserSid;
    this.signal = options.signal;
  }
  async prepareInstallation(installationId: string): Promise<GatewayInstallationIdentity> {
    const userSid = await this.resolveSid();
    if (!/^S-\d(?:-\d+)+$/u.test(userSid)) throw new GatewayResidentOperationError("Current Windows account identity could not be verified", "unchanged");
    return { taskName: `PiMaestroGateway-${sha256(installationId).slice(0, 20)}`, userSid };
  }
  prepareCleanup(definition: GatewayServiceDefinition): GatewayServiceCleanup {
    const payload = windowsTaskPayload(definition);
    try {
      const suffix = sha256(definition.taskName ?? SERVICE_NAME).slice(0, 20);
      return { state: "pending", xmlBasename: `.pi-maestro-gateway-task-${suffix}.xml`, xmlDigest: sha256(payload) };
    } finally { payload.fill(0); }
  }
  async install(definition: GatewayServiceDefinition, cleanup?: GatewayServiceCleanup): Promise<void> {
    const before = await this.queryDefinitionState(definition);
    if (before === "matching") return;
    if (before !== "absent") throw new GatewayResidentOperationError("Refused to create Scheduled Task because ownership is not proven absent", before === "inconclusive" ? "recovery-required" : "unchanged");
    cleanup ??= this.prepareCleanup(definition);
    if (cleanup.state !== "pending") throw new GatewayResidentOperationError("Scheduled Task cleanup identity is unavailable", "recovery-required");
    await this.fs.mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    await this.assertPrivatePath(this.options.stateDirectory, "directory");
    const temporary = this.cleanupPath(cleanup.xmlBasename);
    const payload = windowsTaskPayload(definition);
    try {
      if (sha256(payload) !== cleanup.xmlDigest) throw new GatewayResidentOperationError("Scheduled Task cleanup identity does not match definition", "recovery-required");
      await this.ensureXmlArtifact(temporary, payload, cleanup.xmlDigest);
      const result = await this.runner({ operation: "create", args: ["/Create", "/TN", taskNameFor(definition), "/XML", temporary], ...(this.signal ? { signal: this.signal } : {}) });
      try { if (result.exitCode !== 0) throw schtasksError("failed"); }
      finally { result.stdout.fill(0); result.stderr.fill(0); }
      if (await this.queryDefinitionState(definition) !== "matching") throw new GatewayResidentOperationError("Scheduled Task creation could not be verified", "recovery-required");
    } catch (error) { throw toResidentError(error, "recovery-required"); }
    finally { payload.fill(0); }
  }
  async cleanupInstallation(_definition: GatewayServiceDefinition, cleanup: GatewayServiceCleanup): Promise<void> {
    const source = this.cleanupPath(cleanup.xmlBasename);
    const quarantine = this.cleanupPath(`${cleanup.xmlBasename}.quarantine`);
    await this.assertPrivatePath(this.options.stateDirectory, "directory");
    const sourceState = await this.artifactState(source, cleanup.xmlDigest);
    const quarantineState = await this.artifactState(quarantine, cleanup.xmlDigest);
    if (sourceState === "invalid" || quarantineState === "invalid" || (sourceState === "matching" && quarantineState === "matching")) {
      throw new GatewayResidentOperationError("Scheduled Task private XML cleanup identity failed", "recovery-required", "xml-cleanup-failed");
    }
    if (sourceState === "matching") {
      try { await this.fs.rename(source, quarantine); }
      catch { throw new GatewayResidentOperationError("Scheduled Task private XML cleanup quarantine failed", "recovery-required", "xml-cleanup-failed"); }
    }
    if (sourceState === "absent" && quarantineState === "absent") return;
    if (await this.artifactState(quarantine, cleanup.xmlDigest) !== "matching") throw new GatewayResidentOperationError("Scheduled Task private XML cleanup identity failed", "recovery-required", "xml-cleanup-failed");
    try { await this.fs.rm(quarantine, { force: false }); }
    catch { throw new GatewayResidentOperationError("Scheduled Task private XML cleanup failed", "recovery-required", "xml-cleanup-failed"); }
    if (await this.artifactState(quarantine, cleanup.xmlDigest) !== "absent") throw new GatewayResidentOperationError("Scheduled Task private XML cleanup could not be confirmed", "recovery-required", "xml-cleanup-failed");
  }
  async start(definition: GatewayServiceDefinition): Promise<void> {
    if (await this.queryDefinitionState(definition) !== "matching") throw new GatewayResidentOperationError("Refused to run Scheduled Task because ownership is not proven", "recovery-required");
    await this.runChecked("run", ["/Run", "/TN", taskNameFor(definition)]);
  }
  async readDefinition(): Promise<GatewayServiceDefinition | undefined> { return undefined; }
  async matchesDefinition(definition: GatewayServiceDefinition): Promise<boolean> { return (await this.queryDefinitionState(definition)) === "matching"; }
  async queryDefinitionState(definition: GatewayServiceDefinition): Promise<GatewayRegistrationState> {
    let result: SchtasksResult;
    try { result = await this.runner({ operation: "query", args: ["/Query", "/TN", taskNameFor(definition), "/XML", "/HResult"], ...(this.signal ? { signal: this.signal } : {}) }); }
    catch { return "inconclusive"; }
    try {
      if (result.exitCode !== 0) return numericTaskAbsence(result.exitCode) ? "absent" : "inconclusive";
      let xml: string;
      try { xml = decodeTaskXml(result.stdout); } catch { return "inconclusive"; }
      return taskXmlState(xml, definition);
    } finally { result.stdout.fill(0); result.stderr.fill(0); }
  }
  async uninstall(definition: GatewayServiceDefinition): Promise<void> {
    const before = await this.queryDefinitionState(definition);
    if (before === "absent") return;
    if (before !== "matching") throw new GatewayResidentOperationError("Refused to delete Scheduled Task because ownership is not proven", "recovery-required");
    try { await this.runChecked("delete", ["/Delete", "/F", "/TN", taskNameFor(definition)]); } catch { /* numeric query below is authoritative */ }
    if (await this.queryDefinitionState(definition) !== "absent") throw new GatewayResidentOperationError("Scheduled Task deletion could not be verified", "recovery-required");
  }
  private cleanupPath(name: string): string {
    if (basename(name) !== name || !/^\.pi-maestro-gateway-task-[a-f0-9]{20}\.xml(?:\.quarantine)?$/u.test(name)) throw new GatewayResidentOperationError("Scheduled Task cleanup metadata is invalid", "recovery-required", "xml-cleanup-failed");
    return join(this.options.stateDirectory, name);
  }
  private async ensureXmlArtifact(path: string, payload: Buffer, digest: string): Promise<void> {
    const existing = await this.artifactState(path, digest);
    if (existing === "matching") return;
    if (existing !== "absent") throw new GatewayResidentOperationError("Scheduled Task private XML identity failed", "recovery-required", "xml-cleanup-failed");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await this.fs.open(path, "wx", 0o600);
      await handle.writeFile(payload);
      await this.verifyPrivate(path, "file");
      await handle.sync();
    } catch { throw new GatewayResidentOperationError("Scheduled Task private XML creation failed", "recovery-required", "xml-cleanup-failed"); }
    finally { await handle?.close().catch(() => undefined); }
    if (await this.artifactState(path, digest) !== "matching") throw new GatewayResidentOperationError("Scheduled Task private XML identity failed", "recovery-required", "xml-cleanup-failed");
  }
  private async artifactState(path: string, digest: string): Promise<"matching" | "absent" | "invalid"> {
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await this.fs.lstat(path); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid"; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return "invalid";
    try { await this.verifyPrivate(path, "file"); } catch { return "invalid"; }
    let bytes: Buffer;
    try { bytes = await this.fs.readFile(path); } catch { return "invalid"; }
    try { return sha256(bytes) === digest ? "matching" : "invalid"; }
    finally { bytes.fill(0); }
  }
  private async runChecked(operation: SchtasksRequest["operation"], args: readonly string[]): Promise<void> {
    const result = await this.runner({ operation, args, ...(this.signal ? { signal: this.signal } : {}) });
    try { if (result.exitCode !== 0) throw schtasksError("failed"); }
    finally { result.stdout.fill(0); result.stderr.fill(0); }
  }
  private async assertPrivatePath(path: string, kind: "directory" | "file"): Promise<void> {
    try {
      const before = await this.fs.lstat(path);
      const matches = kind === "file" ? before.isFile() : before.isDirectory();
      if (!matches || before.isSymbolicLink()) throw new Error("unsafe");
      await this.verifyPrivate(path, kind);
      const after = await this.fs.lstat(path);
      const stillMatches = kind === "file" ? after.isFile() : after.isDirectory();
      if (!stillMatches || after.isSymbolicLink()) throw new Error("unsafe");
    } catch { throw new GatewayResidentOperationError("Scheduled Task private state path is unsafe", "recovery-required"); }
  }
}

function taskNameFor(definition: GatewayServiceDefinition): string { return definition.taskName ?? SERVICE_NAME; }
function taskUriFor(definition: GatewayServiceDefinition): string { return definition.taskName ? `\\${definition.taskName.replace(/^\\+/u, "")}` : LEGACY_WINDOWS_URI; }
function windowsTaskPayload(definition: GatewayServiceDefinition): Buffer { return Buffer.from(`\uFEFF${renderWindowsTaskXml(definition)}`, "utf16le"); }
function renderWindowsTaskXml(definition: GatewayServiceDefinition): string {
  const identity = definitionHash(definition);
  const userId = definition.userSid ? `<UserId>${xmlEscape(definition.userSid)}</UserId>` : "";
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="${TASK_NAMESPACE}"><RegistrationInfo><Source>Pi Maestro Gateway</Source><Description>${identity}</Description><URI>${xmlEscape(taskUriFor(definition))}</URI></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author">${userId}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xmlEscape(definition.command)}</Command><Arguments>${xmlEscape(windowsTaskArguments(definition.args))}</Arguments><WorkingDirectory>${xmlEscape(definition.cwd)}</WorkingDirectory></Exec></Actions></Task>`;
}

function taskXmlState(xml: string, definition: GatewayServiceDefinition): GatewayRegistrationState {
  if (/<\s*!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml) || !/<\/(?:[A-Za-z_][\w.-]*:)?Task>\s*$/u.test(xml)) return "inconclusive";
  try {
    const document = new DOMParser().parseFromString(xml, "text/xml");
    if (document.querySelector("parsererror")) return "inconclusive";
    const root = document.documentElement as unknown as XmlElement;
    if (!isTaskElement(root, "Task") || root.getAttribute("version") !== "1.2" || !attributesAllowed(root, ["version"])) return "foreign";
    const sections = uniqueChildren(root, ["RegistrationInfo", "Triggers", "Principals", "Settings", "Actions"], [], ["version"]);
    if (!sections) return "foreign";
    const registration = uniqueTextMap(sections.RegistrationInfo, ["Source", "Description", "URI"], ["Date", "Author"]);
    if (!registration || registration.Source !== "Pi Maestro Gateway" || registration.Description !== definitionHash(definition) || registration.URI !== taskUriFor(definition)) return "foreign";

    const triggerSet = uniqueChildren(sections.Triggers, ["LogonTrigger"]);
    if (!triggerSet || !attributesAllowed(triggerSet.LogonTrigger, [])) return "foreign";
    const trigger = uniqueTextMap(triggerSet.LogonTrigger, [], ["Enabled"]);
    if (!trigger || normalizeBoolean(trigger.Enabled ?? "true") !== "true") return "foreign";

    const principalSet = uniqueChildren(sections.Principals, ["Principal"]);
    const principal = principalSet?.Principal;
    if (!principal || !attributesAllowed(principal, ["id"]) || principal.getAttribute("id") !== "Author") return "foreign";
    const principalText = uniqueTextMap(principal, ["LogonType"], ["UserId", "RunLevel"], ["id"]);
    if (!principalText || principalText.LogonType !== "InteractiveToken" || (principalText.RunLevel ?? "LeastPrivilege") !== "LeastPrivilege") return "foreign";
    if (definition.userSid ? principalText.UserId !== definition.userSid : principalText.UserId !== undefined && !/^S-\d(?:-\d+)+$/u.test(principalText.UserId)) return "foreign";

    if (!settingsMatch(sections.Settings)) return "foreign";
    if (!attributesAllowed(sections.Actions, ["Context"]) || sections.Actions.getAttribute("Context") !== "Author") return "foreign";
    const actionSet = uniqueChildren(sections.Actions, ["Exec"], [], ["Context"]);
    const exec = actionSet?.Exec;
    if (!exec || !attributesAllowed(exec, [])) return "foreign";
    const execText = uniqueTextMap(exec, ["Command", "Arguments", "WorkingDirectory"]);
    return execText && execText.Command === definition.command && execText.Arguments === windowsTaskArguments(definition.args) && execText.WorkingDirectory === definition.cwd ? "matching" : "foreign";
  } catch { return "inconclusive"; }
}

interface XmlAttribute { name: string; }
interface XmlElement {
  localName: string;
  namespaceURI?: string | null;
  parentElement?: XmlElement | null;
  attributes: Iterable<XmlAttribute> & { length: number };
  children: Iterable<XmlElement>;
  textContent: string | null;
  getAttribute(name: string): string | null;
}
function elements(parent: XmlElement): XmlElement[] { return Array.from(parent.children); }
function qualifiedParts(node: XmlElement): { prefix: string; local: string } {
  const separator = node.localName.indexOf(":");
  return separator < 0 ? { prefix: "", local: node.localName } : { prefix: node.localName.slice(0, separator), local: node.localName.slice(separator + 1) };
}
function resolvedNamespace(node: XmlElement): string | null {
  const { prefix } = qualifiedParts(node);
  const attribute = prefix ? `xmlns:${prefix}` : "xmlns";
  for (let current: XmlElement | null | undefined = node; current; current = current.parentElement) {
    const value = current.getAttribute(attribute);
    if (value !== null) return value;
  }
  return null;
}
function isTaskElement(node: XmlElement | undefined, name: string): node is XmlElement { return !!node && qualifiedParts(node).local === name && resolvedNamespace(node) === TASK_NAMESPACE; }
function attributesAllowed(node: XmlElement, allowed: string[]): boolean {
  const actual = Array.from(node.attributes).map((attribute) => attribute.name).filter((name) => name !== "xmlns" && !name.startsWith("xmlns:"));
  return actual.length === allowed.length && allowed.every((name) => actual.includes(name));
}
function uniqueChildren<T extends string>(parent: XmlElement, required: readonly T[], optional: readonly string[] = [], parentAttributes: readonly string[] = []): Record<T, XmlElement> | undefined {
  if (!attributesAllowed(parent, [...parentAttributes])) return undefined;
  const result: Partial<Record<T, XmlElement>> = {};
  const allowed = new Set<string>([...required, ...optional]);
  for (const child of elements(parent)) {
    const local = qualifiedParts(child).local;
    if (!isTaskElement(child, local) || !allowed.has(local) || (result as Record<string, XmlElement>)[local]) return undefined;
    (result as Record<string, XmlElement>)[local] = child;
  }
  return required.every((name) => result[name]) ? result as Record<T, XmlElement> : undefined;
}
function uniqueTextMap<T extends string>(parent: XmlElement, required: readonly T[], optional: readonly string[] = [], parentAttributes: readonly string[] = []): (Record<T, string> & Record<string, string | undefined>) | undefined {
  const children = uniqueChildren(parent, required, optional, parentAttributes);
  if (!children) return undefined;
  const result: Record<string, string> = {};
  for (const child of elements(parent)) {
    if (!attributesAllowed(child, []) || elements(child).length !== 0) return undefined;
    result[qualifiedParts(child).local] = (child.textContent ?? "").trim();
  }
  return result as Record<T, string> & Record<string, string | undefined>;
}
function normalizeBoolean(value: string | undefined): string | undefined { return value?.toLowerCase(); }
function settingsMatch(settings: XmlElement): boolean {
  const simpleDefaults: Record<string, string> = {
    MultipleInstancesPolicy: "IgnoreNew", ExecutionTimeLimit: "PT0S", DisallowStartIfOnBatteries: "true", StopIfGoingOnBatteries: "true",
    AllowHardTerminate: "true", StartWhenAvailable: "false", RunOnlyIfNetworkAvailable: "false", AllowStartOnDemand: "true", Enabled: "true",
    Hidden: "false", RunOnlyIfIdle: "false", WakeToRun: "false", Priority: "7",
  };
  if (!attributesAllowed(settings, [])) return false;
  const seen = new Set<string>();
  for (const child of elements(settings)) {
    const local = qualifiedParts(child).local;
    if (!isTaskElement(child, local) || seen.has(local)) return false;
    seen.add(local);
    if (local === "IdleSettings") {
      const idle = uniqueTextMap(child, ["StopOnIdleEnd", "RestartOnIdle"], ["Duration", "WaitTimeout"]);
      if (!idle || (idle.Duration !== undefined && idle.Duration !== "PT10M") || (idle.WaitTimeout !== undefined && idle.WaitTimeout !== "PT1H") || normalizeBoolean(idle.StopOnIdleEnd) !== "true" || normalizeBoolean(idle.RestartOnIdle) !== "false") return false;
      continue;
    }
    if (!(local in simpleDefaults) || !attributesAllowed(child, []) || elements(child).length !== 0) return false;
    const actual = (child.textContent ?? "").trim();
    const expected = simpleDefaults[local]!;
    if ((expected === "true" || expected === "false") ? normalizeBoolean(actual) !== expected : actual !== expected) return false;
  }
  return seen.has("MultipleInstancesPolicy") && seen.has("ExecutionTimeLimit");
}
function decodeTaskXml(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.length - 2) % 2 !== 0) throw new Error("invalid XML encoding");
    return bytes.subarray(2).toString("utf16le");
  }
  const offset = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset));
}
function numericTaskAbsence(exitCode: number): boolean { const code = exitCode >>> 0; return code === 2 || code === 0x80070002; }
function toResidentError(error: unknown, disposition: GatewayResidentOperationError["disposition"]): GatewayResidentOperationError {
  if (error instanceof GatewayResidentOperationError) return error;
  if (error instanceof Error && error.name === "TerminationUnconfirmedError") return new GatewayResidentOperationError("Scheduled Task termination could not be confirmed", "recovery-required");
  return new GatewayResidentOperationError(error instanceof Error && error.name === "AbortError" ? "Scheduled Task operation aborted" : error instanceof Error && error.name === "TimeoutError" ? "Scheduled Task operation timed out" : "Scheduled Task operation failed", disposition);
}

const WINDOWS_PRIVATE_PATH_SCRIPT = `$ErrorActionPreference='Stop'
$path=$env:PI_MAESTRO_PRIVATE_PATH; $kind=$env:PI_MAESTRO_PRIVATE_KIND; if([string]::IsNullOrWhiteSpace($path)){throw 'invalid'}
$item=Get-Item -LiteralPath $path -Force; if(($kind -eq 'directory') -ne [bool]$item.PSIsContainer){throw 'kind'}
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=if($kind -eq 'directory'){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity}; $acl.SetAccessRuleProtection($true,$false); $inheritance=if($kind -eq 'directory'){[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[System.Security.AccessControl.InheritanceFlags]::None}; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow); $acl.SetOwner($sid); $acl.SetAccessRule($rule); if($kind -eq 'directory'){[System.IO.Directory]::SetAccessControl($path,$acl)}else{[System.IO.File]::SetAccessControl($path,$acl)}`;
const WINDOWS_PRIVATE_PATH_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_PRIVATE_PATH_SCRIPT, "utf16le").toString("base64")];
async function verifyWindowsPrivatePath(path: string, kind: "directory" | "file"): Promise<void> {
  await new Promise<void>((resolve, reject) => execFile("powershell.exe", WINDOWS_PRIVATE_PATH_ARGS, { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, PI_MAESTRO_PRIVATE_PATH: path, PI_MAESTRO_PRIVATE_KIND: kind } }, (error) => error ? reject(new GatewayResidentOperationError("Resident private state permissions could not be verified", "unchanged")) : resolve()));
}
async function currentWindowsUserSid(): Promise<string> {
  return new Promise((resolve, reject) => execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"], { windowsHide: true, timeout: 10_000, maxBuffer: 4096 }, (error, stdout) => error ? reject(new GatewayResidentOperationError("Current Windows account identity could not be obtained", "unchanged")) : resolve(stdout.trim())));
}

class DetachedFallbackAdapter implements GatewayResidentAdapter {
  readonly kind = "detached-fallback" as const;
  constructor(private readonly definitionPath: string) {}
  async install(definition: GatewayServiceDefinition): Promise<void> {
    const state = await this.queryDefinitionState(definition);
    if (state === "matching") return;
    if (state !== "absent") throw new GatewayResidentOperationError("Refused to replace detached resident definition", "recovery-required");
    await writeGatewayJsonAtomic(this.definitionPath, definition, { mode: 0o600, maximumBytes: MAX_MANIFEST_BYTES });
  }
  async start(definition: GatewayServiceDefinition): Promise<void> {
    const child = spawn(definition.command, definition.args, { cwd: definition.cwd, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }
  async readDefinition(): Promise<GatewayServiceDefinition | undefined> { return readGatewayJson<GatewayServiceDefinition>(this.definitionPath, MAX_MANIFEST_BYTES); }
  async queryDefinitionState(definition: GatewayServiceDefinition): Promise<GatewayRegistrationState> {
    try { const observed = await this.readDefinition(); return observed === undefined ? "absent" : sameDefinition(observed, definition) ? "matching" : "foreign"; }
    catch { return "inconclusive"; }
  }
  async uninstall(definition: GatewayServiceDefinition): Promise<void> {
    const state = await this.queryDefinitionState(definition);
    if (state === "absent") return;
    if (state !== "matching") throw new GatewayResidentOperationError("Refused to delete detached resident definition", "recovery-required");
    await rm(this.definitionPath, { force: true });
  }
}

export interface GatewayResidentServiceOptions {
  manifestPath?: string;
  ownerPath?: string;
  adapter?: GatewayResidentAdapter;
  command?: string;
  argsPrefix?: string[];
  cwd?: string;
  configPath?: string;
  allowDetachedFallback?: boolean;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  acquireLock?: () => Promise<PrivateStateLock>;
  enforcePrivate?: (path: string, kind: "directory" | "file") => Promise<void>;
  durability?: PrivateStateDurability;
  fault?: (point: string) => Promise<void>;
}

export class GatewayResidentService {
  readonly manifestPath: string;
  readonly ownerPath: string;
  private readonly adapter: GatewayResidentAdapter;
  private readonly command: string;
  private readonly argsPrefix: string[];
  private readonly cwd: string;
  private readonly configPath?: string;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly acquireLock: () => Promise<PrivateStateLock>;
  private readonly enforcePrivate: (path: string, kind: "directory" | "file") => Promise<void>;
  private readonly durability: PrivateStateDurability;
  private readonly fault?: (point: string) => Promise<void>;
  private mutationLock?: PrivateStateLock;

  constructor(options: GatewayResidentServiceOptions = {}) {
    this.manifestPath = options.manifestPath ?? gatewayServiceManifestPath();
    this.ownerPath = options.ownerPath ?? gatewayOwnerPath();
    this.adapter = options.adapter ?? defaultAdapter(options.allowDetachedFallback === true, this.manifestPath);
    this.command = options.command ?? process.execPath;
    this.argsPrefix = [...(options.argsPrefix ?? [])];
    this.cwd = options.cwd ?? process.cwd();
    this.configPath = options.configPath;
    this.now = options.now ?? (() => Date.now());
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.enforcePrivate = options.enforcePrivate ?? enforceResidentPrivatePath;
    this.durability = options.durability ?? residentDurability();
    this.fault = options.fault;
    this.acquireLock = options.acquireLock ?? (async () => {
      const directory = dirname(this.manifestPath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.enforcePrivate(directory, "directory");
      return acquirePrivateStateLock({ directory, name: RESIDENT_LOCK_NAME, enforcePrivate: this.enforcePrivate, durability: this.durability });
    });
  }

  async install(): Promise<GatewayServiceManifest> { return this.withMutation(() => this.installUnlocked()); }
  async validateInstallationToken(token: string): Promise<GatewayServiceManifest> {
    const manifest = await this.requireInstalledSnapshot();
    if (token !== manifest.installationToken) throw new Error("Gateway service installation token is invalid");
    return manifest;
  }
  async validateServiceRun(token: string, command: string, args: string[], cwd: string): Promise<GatewayServiceManifest> {
    const manifest = await this.requireInstalledSnapshot();
    if (token !== manifest.installationToken) throw new Error("Gateway service installation token is invalid");
    if (command !== manifest.definition.command || JSON.stringify(args) !== JSON.stringify(manifest.definition.args) || cwd !== manifest.definition.cwd) throw new Error("Gateway service-run invocation does not match the installed definition");
    return manifest;
  }
  async start(): Promise<GatewayResidentStatus> { return this.withMutation(async () => { await this.reconcileUnlocked(); return this.startUnlocked(); }); }
  async stop(): Promise<GatewayResidentStatus> { return this.withMutation(async () => { await this.reconcileUnlocked(); return this.stopUnlocked(); }); }
  async restart(): Promise<GatewayResidentStatus> {
    return this.withMutation(async () => {
      await this.reconcileUnlocked();
      const current = await this.status();
      if (current.running) await this.stopUnlocked();
      return this.startUnlocked();
    });
  }
  async uninstall(): Promise<boolean> { return this.withMutation(() => this.uninstallUnlocked()); }

  async status(): Promise<GatewayResidentStatus> {
    let manifest: GatewayServiceManifest | undefined;
    try { manifest = await this.readManifest(); }
    catch { return { installed: true, running: false, ready: false, degraded: true, fallback: false, recoveryRequired: true, error: "Resident service state is unreadable" }; }
    if (!manifest) return { installed: false, running: false, ready: false, degraded: false, fallback: false };
    const lifecycle = manifest.lifecycle ?? "installed";
    let registrationValid = false;
    try { registrationValid = lifecycle === "installed" && await this.registrationMatches(manifest); } catch { /* read-only degraded status */ }
    const ownerStore = new GatewayOwnerStore({ ownerPath: this.ownerPath });
    const owner = await ownerStore.read().catch(() => undefined);
    const ownerActive = owner ? await ownerStore.isOwned(owner.ownerToken) : false;
    let ready = false;
    if (owner?.socket && lifecycle === "installed") {
      try {
        const response = await requestGatewayIpcControl({ address: owner.socket, ownerToken: owner.ownerToken, action: "status", timeoutMs: 750 }) as { readiness?: { ready?: boolean } };
        ready = response.readiness?.ready ?? true;
      } catch { /* degraded */ }
    }
    const running = owner !== undefined && ownerActive;
    return {
      installed: true, running, ready: registrationValid && running && ready,
      degraded: lifecycle !== "installed" || !registrationValid || (owner !== undefined && (!running || !ready)),
      fallback: manifest.kind === "detached-fallback", kind: manifest.kind, lifecycle,
      ...(lifecycle === "installed" ? {} : { recoveryRequired: true }),
      ...(owner ? { owner: { pid: owner.pid, startedAt: owner.startedAt } } : {}),
    };
  }

  private async installUnlocked(): Promise<GatewayServiceManifest> {
    const existing = await this.reconcileUnlocked();
    if (existing) throw new Error("Gateway service is already installed");
    const installationToken = randomBytes(32).toString("base64url");
    const installationId = `install-${randomBytes(16).toString("hex")}`;
    let identity: GatewayInstallationIdentity = {};
    try { identity = await this.adapter.prepareInstallation?.(installationId) ?? {}; }
    catch { throw new GatewayResidentOperationError("Resident installation identity could not be prepared", "unchanged"); }
    const definition: GatewayServiceDefinition = {
      name: SERVICE_NAME, command: this.command,
      args: [...this.argsPrefix, "service-run", "--installation-token", installationToken, ...(this.adapter.kind === "detached-fallback" ? ["--detached-fallback"] : []), ...(this.configPath ? ["--config", this.configPath] : [])],
      cwd: this.cwd, installationToken, ...(identity.taskName ? { taskName: identity.taskName } : {}), ...(identity.userSid ? { userSid: identity.userSid } : {}),
    };
    const at = this.now();
    const cleanup = this.adapter.prepareCleanup?.(definition);
    const manifest: GatewayServiceManifest = {
      version: GATEWAY_STATE_VERSION, installationId, installationToken, kind: this.adapter.kind,
      definitionHash: definitionHash(definition), definition, installedAt: at, lifecycle: "installing",
      ...(identity.taskName ? { taskName: identity.taskName } : {}),
      operation: { stage: "intent-durable", startedAt: at, updatedAt: at, deadlineAt: at + SCHTASKS_TIMEOUT_MS, absentObservations: [] },
      ...(cleanup ? { cleanup } : {}),
    };
    await this.writeManifest(manifest);
    await this.fault?.("install:intent-durable");
    try {
      await this.assertMutationOwned();
      await this.adapter.install(definition, cleanup);
      manifest.operation = { ...manifest.operation!, stage: "registration-matching", updatedAt: this.now() };
      await this.writeManifest(manifest);
      await this.fault?.("install:registration-matching");
      await this.cleanupUnlocked(manifest);
      manifest.lifecycle = "installed";
      manifest.operation = { ...manifest.operation!, stage: "installed", updatedAt: this.now(), absentObservations: [] };
      await this.writeManifest(manifest);
      await this.fault?.("install:manifest-installed");
      return manifest;
    } catch (error) {
      await this.tryCleanupAndPersist(manifest);
      if (error instanceof GatewayResidentOperationError) throw error;
      throw new GatewayResidentOperationError("Gateway service installation requires recovery", "recovery-required", manifest.cleanup?.state === "pending" ? "xml-cleanup-failed" : "clean");
    }
  }

  private async uninstallUnlocked(): Promise<boolean> {
    const initial = await this.readManifest();
    if (!initial) throw new Error("Gateway service is not installed");
    const wasUninstalling = (initial.lifecycle ?? "installed") === "uninstalling";
    let manifest = await this.reconcileUnlocked();
    if (!manifest) {
      if (wasUninstalling) return true;
      throw new Error("Gateway service is not installed");
    }
    this.assertManifestIntegrity(manifest);
    if ((manifest.lifecycle ?? "installed") !== "uninstalling") {
      if (manifest.kind !== this.adapter.kind || await this.registrationState(manifest.definition) !== "matching") throw new GatewayResidentOperationError("Refused to uninstall Gateway because ownership is not proven", "recovery-required");
      const at = this.now();
      manifest = { ...manifest, lifecycle: "uninstalling", operation: { stage: "uninstall-intent-durable", startedAt: at, updatedAt: at, deadlineAt: at + SCHTASKS_TIMEOUT_MS, absentObservations: [] } };
      await this.writeManifest(manifest);
      await this.fault?.("uninstall:intent-durable");
    }
    try {
      const current = await this.status();
      if (current.running) await this.stopUnlocked(manifest);
      await this.assertMutationOwned();
      await this.adapter.uninstall(manifest.definition);
      if (await this.registrationState(manifest.definition) !== "absent") throw new GatewayResidentOperationError("Gateway service registration absence could not be proven after uninstall", "recovery-required");
      await this.fault?.("uninstall:registration-absent");
      await this.cleanupUnlocked(manifest);
      await this.removeManifest();
      await this.fault?.("uninstall:manifest-removed");
      return true;
    } catch (error) {
      if (error instanceof GatewayResidentOperationError) throw error;
      throw new GatewayResidentOperationError("Gateway service uninstall requires recovery", "recovery-required");
    }
  }

  private async reconcileUnlocked(): Promise<GatewayServiceManifest | undefined> {
    const manifest = await this.readManifest();
    if (!manifest) return undefined;
    this.assertManifestIntegrity(manifest);
    const lifecycle = manifest.lifecycle ?? "installed";
    if (lifecycle === "installed") return manifest;
    if (manifest.kind !== this.adapter.kind) throw new GatewayResidentOperationError("Resident adapter does not match pending installation", "recovery-required");
    if (lifecycle === "installing") {
      const state = await this.registrationState(manifest.definition);
      if (state === "matching") {
        await this.cleanupUnlocked(manifest);
        manifest.lifecycle = "installed";
        manifest.operation = { ...(manifest.operation ?? operationAt("installed", this.now())), stage: "installed", updatedAt: this.now(), absentObservations: [] };
        await this.writeManifest(manifest);
        return manifest;
      }
      if (state === "foreign" || state === "inconclusive") throw new GatewayResidentOperationError("Pending Gateway installation could not be reconciled", "recovery-required");
      if (await this.observeStableAbsence(manifest)) {
        await this.cleanupUnlocked(manifest);
        await this.removeManifest();
        return undefined;
      }
      throw new GatewayResidentOperationError("Pending Gateway installation absence is not stable", "recovery-required");
    }
    const state = await this.registrationState(manifest.definition);
    if (state === "matching") {
      await this.assertMutationOwned();
      await this.adapter.uninstall(manifest.definition);
      if (await this.registrationState(manifest.definition) !== "absent") throw new GatewayResidentOperationError("Pending Gateway uninstall could not prove absence", "recovery-required");
    } else if (state !== "absent") throw new GatewayResidentOperationError("Pending Gateway uninstall could not be reconciled", "recovery-required");
    await this.cleanupUnlocked(manifest);
    await this.removeManifest();
    return undefined;
  }

  private async observeStableAbsence(manifest: GatewayServiceManifest): Promise<boolean> {
    const observations = [...(manifest.operation?.absentObservations ?? [])].filter(Number.isSafeInteger).sort((a, b) => a - b).slice(-ABSENCE_OBSERVATIONS);
    while (observations.length < ABSENCE_OBSERVATIONS) {
      if (observations.length > 0) {
        const neededSpan = observations.length === ABSENCE_OBSERVATIONS - 1 ? ABSENCE_MIN_SPAN_MS - (this.now() - observations[0]!) : ABSENCE_MIN_INTERVAL_MS;
        await this.delay(Math.max(ABSENCE_MIN_INTERVAL_MS, neededSpan));
      }
      if (await this.registrationState(manifest.definition) !== "absent") return false;
      const observedAt = this.now();
      if (observations.length > 0 && observedAt - observations.at(-1)! < ABSENCE_MIN_INTERVAL_MS) return false;
      observations.push(observedAt);
      manifest.operation = { ...(manifest.operation ?? operationAt("observing-absence", observedAt)), stage: "observing-absence", updatedAt: observedAt, absentObservations: [...observations] };
      await this.writeManifest(manifest);
    }
    return observations.at(-1)! - observations[0]! >= ABSENCE_MIN_SPAN_MS;
  }

  private async startUnlocked(): Promise<GatewayResidentStatus> {
    const manifest = await this.requireVerifiedInstalledManifest(false);
    await this.assertMutationOwned();
    await this.adapter.start(manifest.definition);
    return this.status();
  }
  private async stopUnlocked(provided?: GatewayServiceManifest): Promise<GatewayResidentStatus> {
    const manifest = provided ?? await this.requireVerifiedInstalledManifest(true);
    const ownerStore = new GatewayOwnerStore({ ownerPath: this.ownerPath });
    const owner = await ownerStore.read();
    if (!owner?.socket) throw new Error("Refused to stop Gateway: runtime owner token/IPC is unavailable");
    const expectedIdentity = [manifest.definition.command, ...manifest.definition.args].join(" ");
    await ownerStore.assertExactOwned(owner.ownerToken, expectedIdentity, gatewayIpcAddress(undefined, this.ownerPath));
    await this.assertMutationOwned();
    await requestGatewayIpcControl({ address: owner.socket, ownerToken: owner.ownerToken, action: "stop", timeoutMs: 5_000 });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await new GatewayOwnerStore({ ownerPath: this.ownerPath }).read()) === undefined) return this.status();
      await this.delay(50);
    }
    throw new Error("Gateway acknowledged stop but owner release could not be verified");
  }
  private async registrationMatches(manifest: GatewayServiceManifest): Promise<boolean> { return (await this.registrationState(manifest.definition)) === "matching"; }
  private async registrationState(definition: GatewayServiceDefinition): Promise<GatewayRegistrationState> {
    if (this.adapter.queryDefinitionState) return this.adapter.queryDefinitionState(definition);
    if (this.adapter.matchesDefinition && await this.adapter.matchesDefinition(definition)) return "matching";
    const observed = await this.adapter.readDefinition();
    return observed === undefined ? "absent" : sameDefinition(observed, definition) ? "matching" : "foreign";
  }
  private async requireVerifiedInstalledManifest(destructive: boolean): Promise<GatewayServiceManifest> {
    const manifest = await this.requireInstalledSnapshot();
    if (manifest.kind !== this.adapter.kind) throw new Error("Gateway service adapter does not match the installed manifest");
    if (await this.registrationState(manifest.definition) !== "matching") throw new Error(`Refused to ${destructive ? "modify" : "start"} Gateway: OS registration definition does not match manifest`);
    return manifest;
  }
  private async requireInstalledSnapshot(): Promise<GatewayServiceManifest> {
    const manifest = await this.readManifest();
    if (!manifest) throw new Error("Gateway service is not installed");
    this.assertManifestIntegrity(manifest);
    if ((manifest.lifecycle ?? "installed") !== "installed") throw new Error("Gateway service installation is pending recovery");
    return manifest;
  }
  private assertManifestIntegrity(manifest: GatewayServiceManifest): void {
    if (definitionHash(manifest.definition) !== manifest.definitionHash || manifest.definition.installationToken !== manifest.installationToken || (manifest.definition.taskName && manifest.taskName !== manifest.definition.taskName)) throw new Error("Gateway service manifest integrity check failed");
  }
  private async cleanupUnlocked(manifest: GatewayServiceManifest): Promise<void> {
    if (!manifest.cleanup || manifest.cleanup.state === "clean") return;
    if (!this.adapter.cleanupInstallation) throw new GatewayResidentOperationError("Resident cleanup operation is unavailable", "recovery-required", "xml-cleanup-failed");
    await this.assertMutationOwned();
    await this.adapter.cleanupInstallation(manifest.definition, manifest.cleanup);
    manifest.cleanup = { ...manifest.cleanup, state: "clean" };
    if (manifest.operation) manifest.operation = { ...manifest.operation, stage: "cleanup-complete", updatedAt: this.now() };
    await this.writeManifest(manifest);
    await this.fault?.("install:cleanup-complete");
  }
  private async tryCleanupAndPersist(manifest: GatewayServiceManifest): Promise<void> { try { await this.cleanupUnlocked(manifest); } catch { /* pending metadata remains durable */ } }
  private async writeManifest(manifest: GatewayServiceManifest): Promise<void> {
    try {
      await this.assertMutationOwned();
      await writeGatewayJsonAtomic(this.manifestPath, manifest, { mode: 0o600, maximumBytes: MAX_MANIFEST_BYTES });
      await this.enforcePrivate(this.manifestPath, "file");
      await this.durability.syncFile(this.manifestPath);
      await this.durability.syncDirectory(dirname(this.manifestPath));
    } catch { throw new GatewayResidentOperationError("Gateway service state could not be persisted", "recovery-required"); }
  }
  private async removeManifest(): Promise<void> {
    try { await this.assertMutationOwned(); await rm(this.manifestPath, { force: true }); await this.durability.syncDirectory(dirname(this.manifestPath)); }
    catch { throw new GatewayResidentOperationError("Gateway service state could not be removed", "recovery-required"); }
  }
  private async readManifest(): Promise<GatewayServiceManifest | undefined> {
    let value: unknown;
    try { value = await readGatewayJson<unknown>(this.manifestPath, MAX_MANIFEST_BYTES); }
    catch { throw new Error("Gateway service state could not be read"); }
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Gateway service manifest");
    const manifest = value as GatewayServiceManifest;
    const validKind = manifest.kind === "windows-task" || manifest.kind === "systemd-user" || manifest.kind === "detached-fallback";
    const lifecycle = manifest.lifecycle ?? "installed";
    if (manifest.version !== GATEWAY_STATE_VERSION || !safeString(manifest.installationId, 256) || !safeString(manifest.installationToken, 256) || !/^[a-f0-9]{64}$/u.test(manifest.definitionHash) || !validKind || !Number.isSafeInteger(manifest.installedAt) || manifest.installedAt < 0 || !validDefinition(manifest.definition) || !["installing", "installed", "uninstalling"].includes(lifecycle)) throw new Error("Invalid Gateway service manifest");
    if (manifest.taskName !== undefined && !validTaskName(manifest.taskName)) throw new Error("Invalid Gateway service manifest");
    if (manifest.cleanup && (!validCleanup(manifest.cleanup))) throw new Error("Invalid Gateway service manifest");
    if (manifest.operation && !validOperation(manifest.operation)) throw new Error("Invalid Gateway service manifest");
    return { ...manifest, lifecycle, ...(manifest.kind === "windows-task" && !manifest.taskName ? { taskName: SERVICE_NAME } : {}) };
  }
  private async assertMutationOwned(): Promise<void> {
    if (!this.mutationLock) throw new GatewayResidentOperationError("Gateway resident mutation lock is unavailable", "recovery-required");
    try { await this.mutationLock.assertOwned(); }
    catch { throw new GatewayResidentOperationError("Gateway resident mutation lock ownership was lost", "recovery-required"); }
  }
  private async withMutation<T>(action: () => Promise<T>): Promise<T> {
    if (this.mutationLock) throw new GatewayResidentOperationError("Gateway resident operation is already active", "unchanged");
    let lock: PrivateStateLock;
    try { lock = await this.acquireLock(); }
    catch { throw new GatewayResidentOperationError("Gateway resident operation is already active", "unchanged"); }
    this.mutationLock = lock;
    try { await lock.assertOwned(); return await action(); }
    finally { try { await lock.release(); } finally { this.mutationLock = undefined; } }
  }
}

function safeString(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function validTaskName(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value); }
function validDefinition(value: unknown): value is GatewayServiceDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const definition = value as GatewayServiceDefinition;
  return definition.name === SERVICE_NAME && safeString(definition.command, 4096) && Array.isArray(definition.args) && definition.args.length <= 128 && definition.args.every((arg) => typeof arg === "string" && arg.length <= 16_384) && safeString(definition.cwd, 4096) && safeString(definition.installationToken, 256)
    && (definition.taskName === undefined || validTaskName(definition.taskName)) && (definition.userSid === undefined || /^S-\d(?:-\d+)+$/u.test(definition.userSid));
}
function validCleanup(value: GatewayServiceCleanup): boolean { return (value.state === "pending" || value.state === "clean") && /^\.pi-maestro-gateway-task-[a-f0-9]{20}\.xml$/u.test(value.xmlBasename) && /^[a-f0-9]{64}$/u.test(value.xmlDigest); }
function validOperation(value: GatewayServiceOperation): boolean {
  const observations = value.absentObservations ?? [];
  return safeString(value.stage, 128) && !/[\r\n]/u.test(value.stage) && Number.isSafeInteger(value.startedAt) && value.startedAt >= 0 && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0
    && (value.deadlineAt === undefined || Number.isSafeInteger(value.deadlineAt) && value.deadlineAt >= 0) && observations.length <= ABSENCE_OBSERVATIONS
    && observations.every((at, index) => Number.isSafeInteger(at) && at >= 0 && (index === 0 || at > observations[index - 1]!));
}
function operationAt(stage: string, at: number): GatewayServiceOperation { return { stage, startedAt: at, updatedAt: at, absentObservations: [] }; }

async function enforceResidentPrivatePath(path: string, kind: "directory" | "file"): Promise<void> {
  if (process.platform === "win32") return verifyWindowsPrivatePath(path, kind);
  await chmod(path, kind === "directory" ? 0o700 : 0o600);
  const info = await lstat(path);
  if ((kind === "directory" ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("resident private state verification failed");
}
const WINDOWS_DURABILITY_SCRIPT = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\nusing System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public static class PiResidentSync { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string n,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FlushFileBuffers(SafeFileHandle h); }\n'@\n$p=$env:PI_MAESTRO_SYNC_PATH; $k=$env:PI_MAESTRO_SYNC_KIND; if([string]::IsNullOrWhiteSpace($p)){throw 'invalid'}; $flags=if($k -eq 'directory'){0x02000000}else{0}; $h=[PiResidentSync]::CreateFile($p,0x40000000,7,[IntPtr]::Zero,3,$flags,[IntPtr]::Zero); if($h.IsInvalid){throw 'open'}; try { if(-not [PiResidentSync]::FlushFileBuffers($h)){throw 'flush'} } finally {$h.Dispose()}`;
const WINDOWS_DURABILITY_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_DURABILITY_SCRIPT, "utf16le").toString("base64")];
function residentDurability(): PrivateStateDurability {
  if (process.platform === "win32") return {
    syncFile: (path) => runResidentDurability(path, "file"),
    syncDirectory: (path) => runResidentDurability(path, "directory"),
  };
  return {
    async syncFile(path: string): Promise<void> { const handle = await open(path, constants.O_RDWR); try { await handle.sync(); } finally { await handle.close(); } },
    async syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } },
  };
}
async function runResidentDurability(path: string, kind: "file" | "directory"): Promise<void> {
  await new Promise<void>((resolve, reject) => execFile("powershell.exe", WINDOWS_DURABILITY_ARGS, { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, PI_MAESTRO_SYNC_PATH: path, PI_MAESTRO_SYNC_KIND: kind } }, (error) => error ? reject(new Error("Resident state durability synchronization failed")) : resolve()));
}
function defaultAdapter(allowDetachedFallback: boolean, manifestPath: string): GatewayResidentAdapter {
  if (allowDetachedFallback) return new DetachedFallbackAdapter(`${manifestPath}.fallback-definition.json`);
  if (process.platform === "win32") return new WindowsTaskAdapter({ stateDirectory: dirname(manifestPath) });
  if (process.platform === "linux") return new SystemdUserAdapter();
  throw new Error("Resident Gateway service is unsupported on this platform; pass the explicit detached fallback option to opt in");
}
