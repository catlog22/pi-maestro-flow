import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const DELEGATION_ROOT_RELATIVE_PATH = ".pi/delegations";
export const DELEGATION_RECORD_VERSION = 1;
export const MAX_DELEGATION_REQUEST_CHARS = 20_000;
export const MAX_DELEGATION_DOCUMENT_BYTES = 48 * 1024;

export type DelegationWorkerContext = "fresh" | "fork";

export type DelegationStatus =
  | "draft"
  | "confirmed"
  | "spawning"
  | "dispatching"
  | "delivery_unknown"
  | "sent"
  | "cancelled"
  | "closed";

export interface DelegationTaskDraft {
  title: string;
  objective: string;
  context: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  suggestedFiles: string[];
  verification: string[];
  executionNotes?: string;
}

export interface DelegationSourceContext {
  cwd: string;
  workspaceId: string;
  sessionId: string;
  sessionName?: string;
  sessionFile: string;
}

export interface DelegationPlannerReceipt {
  agent: "planner";
  correlationId: string;
  model?: string;
  durationMs?: number;
}

export interface DelegatedWindowLaunch {
  name: string;
  sessionName: string;
  presentation: "interactive";
  startedAt: number;
}

export interface DelegatedWindowReceipt {
  name: string;
  sessionName: string;
  ownerId: string;
  ownerNonce: string;
  pid: number;
  presentation: "interactive";
  registeredAt: number;
  sentAt?: number;
}

export interface DelegationRecord {
  version: typeof DELEGATION_RECORD_VERSION;
  revision: number;
  id: string;
  status: DelegationStatus;
  request: string;
  workerContext: DelegationWorkerContext;
  source: DelegationSourceContext;
  task: DelegationTaskDraft;
  planner: DelegationPlannerReceipt;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
  cancelledAt?: number;
  closedAt?: number;
  launch?: DelegatedWindowLaunch;
  window?: DelegatedWindowReceipt;
  dispatchMessageId?: string;
  lastError?: string;
}

export type DelegationCommand =
  | { action: "create"; request: string; workerContext?: DelegationWorkerContext }
  | { action: "list" }
  | { action: "show"; id: string }
  | { action: "send"; id: string }
  | { action: "stop"; id: string }
  | { action: "cancel"; id: string }
  | { action: "help" }
  | { action: "invalid"; error: string };

export const DELEGATION_TASK_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    objective: { type: "string", minLength: 1, maxLength: 4_000 },
    context: { type: "string", minLength: 1, maxLength: 8_000 },
    deliverables: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    acceptanceCriteria: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    constraints: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    suggestedFiles: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    verification: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    executionNotes: { type: "string", maxLength: 4_000 },
  },
  required: [
    "title",
    "objective",
    "context",
    "deliverables",
    "acceptanceCriteria",
    "constraints",
    "suggestedFiles",
    "verification",
  ],
  additionalProperties: false,
} as const;

const DELEGATION_ID_PATTERN = /^dlg-[a-z0-9][a-z0-9-]{0,39}-[a-f0-9]{8}$/;
const DELEGATION_TASK_KEYS = new Set([
  "title",
  "objective",
  "context",
  "deliverables",
  "acceptanceCriteria",
  "constraints",
  "suggestedFiles",
  "verification",
  "executionNotes",
]);
const DELEGATION_LIFECYCLE_COMMANDS = new Set(["show", "send", "stop", "cancel"]);

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value: unknown, field: string, maxLength: number, required = true): string | undefined {
  if (typeof value !== "string") {
    if (!required && value === undefined) return undefined;
    throw new Error(`${field} must be a string`);
  }
  const text = value.trim();
  if (!text) {
    if (!required) return undefined;
    throw new Error(`${field} is required`);
  }
  if (text.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return text;
}

function boundedStringList(
  value: unknown,
  field: string,
  options: { minItems?: number; maxItems: number; maxLength?: number },
): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const minItems = options.minItems ?? 0;
  if (value.length < minItems) throw new Error(`${field} requires at least ${minItems} item(s)`);
  if (value.length > options.maxItems) throw new Error(`${field} exceeds ${options.maxItems} items`);
  return value.map((item, index) => boundedText(
    item,
    `${field}[${index}]`,
    options.maxLength ?? 500,
  ) as string);
}

export function parseDelegationTaskDraft(value: unknown): DelegationTaskDraft {
  if (!plainObject(value)) throw new Error("planner output must be an object");
  const unexpected = Object.keys(value).find((key) => !DELEGATION_TASK_KEYS.has(key));
  if (unexpected) throw new Error(`planner output contains unexpected field ${JSON.stringify(unexpected)}`);
  return {
    title: boundedText(value.title, "title", 120) as string,
    objective: boundedText(value.objective, "objective", 4_000) as string,
    context: boundedText(value.context, "context", 8_000) as string,
    deliverables: boundedStringList(value.deliverables, "deliverables", { minItems: 1, maxItems: 12 }),
    acceptanceCriteria: boundedStringList(value.acceptanceCriteria, "acceptanceCriteria", { minItems: 1, maxItems: 12 }),
    constraints: boundedStringList(value.constraints, "constraints", { maxItems: 12 }),
    suggestedFiles: boundedStringList(value.suggestedFiles, "suggestedFiles", { maxItems: 20 }),
    verification: boundedStringList(value.verification, "verification", { minItems: 1, maxItems: 12 }),
    ...(boundedText(value.executionNotes, "executionNotes", 4_000, false) ? {
      executionNotes: boundedText(value.executionNotes, "executionNotes", 4_000, false),
    } : {}),
  };
}

export function parseDelegationCommand(input: string): DelegationCommand {
  const trimmed = input.trim();
  if (!trimmed) return { action: "help" };
  const separator = trimmed.search(/\s/);
  const first = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const rest = separator < 0 ? "" : trimmed.slice(separator).trim();

  if (first === "create") return validateCreateRequest(rest);
  if (first === "help" && !rest) return { action: "help" };
  if (first === "list" && !rest) return { action: "list" };
  if (!DELEGATION_LIFECYCLE_COMMANDS.has(first)) return validateCreateRequest(trimmed);
  if (!rest) return { action: "invalid", error: `Usage: /delegate ${first} <delegation-id>` };
  if (!/\s/.test(rest) && validDelegationId(rest)) {
    return { action: first as "show" | "send" | "stop" | "cancel", id: rest };
  }
  return validateCreateRequest(trimmed);
}

function validateCreateRequest(request: string): DelegationCommand {
  let instruction = request.trim();
  let workerContext: DelegationWorkerContext | undefined;
  const contextFlag = /^(--new|--fresh|--fork)(?:\s+|$)/i.exec(instruction);
  if (contextFlag) {
    workerContext = contextFlag[1].toLowerCase() === "--fork" ? "fork" : "fresh";
    instruction = instruction.slice(contextFlag[0].length).trim();
    if (/^(--new|--fresh|--fork)(?:\s+|$)/i.test(instruction)) {
      return { action: "invalid", error: "Choose only one worker context: --new or --fork." };
    }
  }
  if (!instruction) {
    return { action: "invalid", error: "Usage: /delegate [--new|--fork] <task>" };
  }
  if (instruction.length > MAX_DELEGATION_REQUEST_CHARS) {
    return { action: "invalid", error: `Delegation request exceeds ${MAX_DELEGATION_REQUEST_CHARS} characters.` };
  }
  return {
    action: "create",
    request: instruction,
    ...(workerContext ? { workerContext } : {}),
  };
}

export function validDelegationId(id: string): boolean {
  return DELEGATION_ID_PATTERN.test(id);
}

function slugify(title: string): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function createDelegationId(title: string, token = randomUUID().replace(/-/g, "").slice(0, 8)): string {
  return `dlg-${slugify(title)}-${token.toLowerCase()}`;
}

export function buildDelegationPlannerPrompt(
  request: string,
  source: DelegationSourceContext,
  workerContext: DelegationWorkerContext = "fresh",
): string {
  return [
    "PURPOSE: Produce a decision-ready task document for an independent worker window. Do not implement the task.",
    "MODE: analysis",
    "TASK:",
    "1. Read the forked conversation and current project state relevant to the request.",
    "2. Separate confirmed facts from assumptions; include only context the worker needs.",
    "3. Preserve the user's delegation instruction without narrowing or replacing it.",
    "4. Define concrete deliverables, acceptance criteria, constraints, likely files, and focused verification.",
    "5. Submit the result through structured_output using the provided schema.",
    "",
    `Delegation request: ${request}`,
    `Source cwd: ${source.cwd}`,
    `Source workspace: ${source.workspaceId}`,
    `Source session: ${source.sessionName ?? source.sessionId}`,
    `Target worker context: ${workerContext}`,
    workerContext === "fresh"
      ? "The target starts fresh: make the task document self-contained."
      : "The target forks the source transcript: retain compatible inherited context but keep the delegated scope explicit.",
    "",
    "CONSTRAINTS:",
    "- The worker starts only after the user confirms this document.",
    "- Preserve unrelated worktree changes and existing architecture.",
    "- Do not invent test commands or files; identify unknowns explicitly in executionNotes.",
    "- Keep each list concise and executable.",
  ].join("\n");
}

function markdownList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None specified.";
}

export function formatDelegationDocument(record: DelegationRecord): string {
  const task = record.task;
  return [
    `# ${task.title}`,
    "",
    `Delegation ID: \`${record.id}\``,
    `Source session: \`${record.source.sessionName ?? record.source.sessionId}\``,
    `Working directory: \`${record.source.cwd}\``,
    `Worker context: \`${record.workerContext}\``,
    "",
    "## Delegation Instruction",
    "",
    record.request,
    "",
    "## Objective",
    "",
    task.objective,
    "",
    "## Context",
    "",
    task.context,
    "",
    "## Deliverables",
    "",
    markdownList(task.deliverables),
    "",
    "## Acceptance Criteria",
    "",
    markdownList(task.acceptanceCriteria),
    "",
    "## Constraints",
    "",
    markdownList(task.constraints),
    "",
    "## Suggested Starting Points",
    "",
    markdownList(task.suggestedFiles),
    "",
    "## Verification",
    "",
    markdownList(task.verification),
    ...(task.executionNotes ? ["", "## Execution Notes", "", task.executionNotes] : []),
    "",
  ].join("\n");
}

export function buildDelegatedWorkerBootstrap(record: DelegationRecord, replyTo: string): string {
  const contextLine = record.workerContext === "fork"
    ? "This window was forked from the source session for project context."
    : "This is a fresh worker session; the confirmed task document will supply its delegated context.";
  const executionLine = record.workerContext === "fork"
    ? "After it arrives, apply it as an additive assignment on top of compatible inherited state, execute it end to end, verify the requested behavior, and report the outcome through teammate-send."
    : "After it arrives, execute the self-contained task document end to end, verify the requested behavior, and report the outcome through teammate-send.";
  return [
    `You are the independently managed worker for delegation ${record.id}.`,
    contextLine,
    "Do not continue any inherited task or modify files until the confirmed delegation document arrives as a workspace message.",
    executionLine,
    `Reply target: ${replyTo}`,
  ].join("\n");
}

export function buildDelegationDelivery(record: DelegationRecord, document: string, replyTo: string): string {
  const assignmentLine = record.workerContext === "fork"
    ? "Own this task independently. Apply the confirmed document as an additive assignment on top of compatible inherited conversation and project state."
    : "Own this task independently. Execute the confirmed self-contained document in the fresh worker session and current project state.";
  const prefix = [
    `[delegation ${record.id}] Confirmed task document`,
    `Worker context: ${record.workerContext}`,
    "",
    assignmentLine,
    "Its explicit scope and acceptance criteria control if inherited instructions conflict.",
    "Preserve unrelated worktree changes. Complete implementation and focused verification before reporting.",
    `Send progress blockers and the final result to ${replyTo} with teammate-send.`,
  ].join("\n");
  return `${prefix}\n\n${document}`;
}

export function delegationRoot(root: string): string {
  return resolve(root, DELEGATION_ROOT_RELATIVE_PATH);
}

export function delegationDirectory(root: string, id: string): string {
  if (!validDelegationId(id)) throw new Error(`Invalid delegation id ${JSON.stringify(id)}.`);
  return join(delegationRoot(root), id);
}

export function delegationDocumentPath(root: string, id: string): string {
  return join(delegationDirectory(root, id), "task.md");
}

const MAX_DELEGATION_RECORD_BYTES = 256 * 1024;

function pathContained(parent: string, candidate: string): boolean {
  const nested = relative(parent, candidate);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

async function validateRuntimeDirectory(path: string, parent: string, label: string): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`${label} must be a non-symlink directory.`);
  const canonical = await realpath(path);
  const after = await lstat(path);
  const canonicalInfo = await lstat(canonical);
  if (after.isSymbolicLink() || !after.isDirectory()
    || before.dev !== after.dev || before.ino !== after.ino
    || after.dev !== canonicalInfo.dev || after.ino !== canonicalInfo.ino) {
    throw new Error(`${label} changed during validation.`);
  }
  if (!pathContained(parent, canonical)) throw new Error(`${label} escapes the workspace root.`);
  return canonical;
}

async function ensureDelegationRoot(root: string): Promise<string> {
  const workspace = await realpath(resolve(root));
  const piDirectory = join(workspace, ".pi");
  await mkdir(piDirectory, { recursive: true, mode: 0o700 });
  const canonicalPi = await validateRuntimeDirectory(piDirectory, workspace, ".pi");
  const storage = join(canonicalPi, "delegations");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  return validateRuntimeDirectory(storage, canonicalPi, "delegation root");
}

async function validatedDelegationDirectory(root: string, id: string): Promise<string> {
  if (!validDelegationId(id)) throw new Error(`Invalid delegation id ${JSON.stringify(id)}.`);
  const storage = await ensureDelegationRoot(root);
  const directory = join(storage, id);
  return validateRuntimeDirectory(directory, storage, `delegation ${id}`);
}

async function readRegularFileBounded(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular non-symlink file.`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed during validation.`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createDelegationDraft(
  root: string,
  input: {
    request: string;
    workerContext?: DelegationWorkerContext;
    source: DelegationSourceContext;
    task: DelegationTaskDraft;
    planner: DelegationPlannerReceipt;
    now?: number;
  },
): Promise<DelegationRecord> {
  const task = parseDelegationTaskDraft(input.task);
  const now = input.now ?? Date.now();
  const id = createDelegationId(task.title);
  const record = parseDelegationRecord({
    version: DELEGATION_RECORD_VERSION,
    revision: 0,
    id,
    status: "draft",
    request: input.request.trim(),
    workerContext: input.workerContext ?? "fresh",
    source: input.source,
    task,
    planner: input.planner,
    createdAt: now,
    updatedAt: now,
  });
  const storage = await ensureDelegationRoot(root);
  const directory = join(storage, id);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const canonicalDirectory = await validateRuntimeDirectory(directory, storage, `delegation ${id}`);
  try {
    await atomicWrite(join(canonicalDirectory, "task.md"), formatDelegationDocument(record));
    await atomicWrite(join(canonicalDirectory, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function parseDelegationRecord(value: unknown): DelegationRecord {
  if (!plainObject(value) || value.version !== DELEGATION_RECORD_VERSION) {
    throw new Error("Unsupported delegation record version.");
  }
  const id = boundedText(value.id, "id", 64) as string;
  if (!validDelegationId(id)) throw new Error("Invalid delegation record id.");
  const statuses: DelegationStatus[] = [
    "draft",
    "confirmed",
    "spawning",
    "dispatching",
    "delivery_unknown",
    "sent",
    "cancelled",
    "closed",
  ];
  if (typeof value.status !== "string" || !statuses.includes(value.status as DelegationStatus)) {
    throw new Error("Invalid delegation status.");
  }
  if (!plainObject(value.source) || !plainObject(value.planner)) throw new Error("Invalid delegation metadata.");
  if (value.planner.agent !== "planner") throw new Error("Invalid delegation planner agent.");
  const sourceSessionName = boundedText(value.source.sessionName, "source.sessionName", 256, false);
  const source: DelegationSourceContext = {
    cwd: boundedText(value.source.cwd, "source.cwd", 4_000) as string,
    workspaceId: boundedText(value.source.workspaceId, "source.workspaceId", 256) as string,
    sessionId: boundedText(value.source.sessionId, "source.sessionId", 256) as string,
    sessionFile: boundedText(value.source.sessionFile, "source.sessionFile", 8_000) as string,
    ...(sourceSessionName ? { sessionName: sourceSessionName } : {}),
  };
  const plannerModel = boundedText(value.planner.model, "planner.model", 256, false);
  const planner: DelegationPlannerReceipt = {
    agent: "planner",
    correlationId: boundedText(value.planner.correlationId, "planner.correlationId", 256) as string,
    ...(plannerModel ? { model: plannerModel } : {}),
    ...(typeof value.planner.durationMs === "number" && Number.isFinite(value.planner.durationMs)
      ? { durationMs: Math.max(0, value.planner.durationMs) }
      : {}),
  };
  const status = value.status as DelegationStatus;
  const workerContextValue = value.workerContext ?? "fresh";
  if (workerContextValue !== "fresh" && workerContextValue !== "fork") {
    throw new Error("Invalid delegation worker context.");
  }
  const workerContext: DelegationWorkerContext = workerContextValue;
  const confirmedAt = optionalTimestamp(value.confirmedAt, "confirmedAt");
  const cancelledAt = optionalTimestamp(value.cancelledAt, "cancelledAt");
  const closedAt = optionalTimestamp(value.closedAt, "closedAt");
  const launch = parseDelegatedWindowLaunch(value.launch);
  const window = parseDelegatedWindowReceipt(value.window);
  const dispatchMessageId = boundedText(value.dispatchMessageId, "dispatchMessageId", 128, false);
  const postConfirmation = new Set<DelegationStatus>([
    "confirmed",
    "spawning",
    "dispatching",
    "delivery_unknown",
    "sent",
    "closed",
  ]);
  if (postConfirmation.has(status) && confirmedAt === undefined) {
    throw new Error(`${status} delegation requires confirmedAt`);
  }
  if (["spawning", "dispatching", "delivery_unknown", "sent", "closed"].includes(status) && !launch) {
    throw new Error(`${status} delegation requires a launch receipt`);
  }
  if (["dispatching", "delivery_unknown", "sent"].includes(status) && !window) {
    throw new Error(`${status} delegation requires a window receipt`);
  }
  if (["dispatching", "delivery_unknown", "sent"].includes(status) && !dispatchMessageId) {
    throw new Error(`${status} delegation requires dispatchMessageId`);
  }
  if (status === "sent" && window?.sentAt === undefined) {
    throw new Error("sent delegation requires window.sentAt");
  }
  if (status === "cancelled" && cancelledAt === undefined) {
    throw new Error("cancelled delegation requires cancelledAt");
  }
  if (status === "closed" && closedAt === undefined) {
    throw new Error("closed delegation requires closedAt");
  }
  if (launch && window && (launch.name !== window.name || launch.sessionName !== window.sessionName)) {
    throw new Error("Delegation launch and window receipts do not match.");
  }
  const lastError = boundedText(value.lastError, "lastError", 4_000, false);
  return {
    version: DELEGATION_RECORD_VERSION,
    revision: nonNegativeInteger(value.revision, "revision"),
    id,
    status,
    request: boundedText(value.request, "request", MAX_DELEGATION_REQUEST_CHARS) as string,
    workerContext,
    source,
    task: parseDelegationTaskDraft(value.task),
    planner,
    createdAt: finiteTimestamp(value.createdAt, "createdAt"),
    updatedAt: finiteTimestamp(value.updatedAt, "updatedAt"),
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    ...(cancelledAt === undefined ? {} : { cancelledAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(launch ? { launch } : {}),
    ...(window ? { window } : {}),
    ...(dispatchMessageId ? { dispatchMessageId } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function parseDelegatedWindowLaunch(value: unknown): DelegatedWindowLaunch | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value) || value.presentation !== "interactive") {
    throw new Error("Invalid delegated window launch receipt.");
  }
  return {
    name: boundedText(value.name, "launch.name", 64) as string,
    sessionName: boundedText(value.sessionName, "launch.sessionName", 128) as string,
    presentation: "interactive",
    startedAt: finiteTimestamp(value.startedAt, "launch.startedAt"),
  };
}

function parseDelegatedWindowReceipt(value: unknown): DelegatedWindowReceipt | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value) || value.presentation !== "interactive") {
    throw new Error("Invalid delegated window receipt.");
  }
  const pid = Number(value.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("window.pid must be a positive integer");
  const sentAt = optionalTimestamp(value.sentAt, "window.sentAt");
  return {
    name: boundedText(value.name, "window.name", 64) as string,
    sessionName: boundedText(value.sessionName, "window.sessionName", 128) as string,
    ownerId: boundedText(value.ownerId, "window.ownerId", 128) as string,
    ownerNonce: boundedText(value.ownerNonce, "window.ownerNonce", 128) as string,
    pid,
    presentation: "interactive",
    registeredAt: finiteTimestamp(value.registeredAt, "window.registeredAt"),
    ...(sentAt === undefined ? {} : { sentAt }),
  };
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : finiteTimestamp(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function finiteTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative timestamp`);
  }
  return value;
}

export async function loadDelegationRecord(root: string, id: string): Promise<DelegationRecord> {
  const directory = await validatedDelegationDirectory(root, id);
  const content = await readRegularFileBounded(join(directory, "record.json"), MAX_DELEGATION_RECORD_BYTES, "delegation record");
  const record = parseDelegationRecord(JSON.parse(content.toString("utf8")) as unknown);
  if (record.id !== id) throw new Error(`Delegation record id ${record.id} does not match directory ${id}.`);
  return record;
}

export async function listDelegationRecords(root: string): Promise<DelegationRecord[]> {
  let entries;
  let storage: string;
  try {
    storage = await ensureDelegationRoot(root);
    entries = await readdir(storage, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && validDelegationId(entry.name))
    .map(async (entry) => {
      try {
        return await loadDelegationRecord(root, entry.name);
      } catch {
        return undefined;
      }
    }));
  return records
    .filter((record): record is DelegationRecord => Boolean(record))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function readDelegationDocument(root: string, id: string): Promise<string> {
  const directory = await validatedDelegationDirectory(root, id);
  const document = await readRegularFileBounded(
    join(directory, "task.md"),
    MAX_DELEGATION_DOCUMENT_BYTES,
    "delegation document",
  );
  const text = document.toString("utf8").trim();
  if (!text) throw new Error("Delegation document is empty.");
  return `${text}\n`;
}

export interface DelegationUpdateOptions {
  expectedRevision?: number;
  expectedStatuses?: readonly DelegationStatus[];
}

const DELEGATION_LOCK_TIMEOUT_MS = 5_000;
const LEGAL_DELEGATION_TRANSITIONS = new Map<DelegationStatus, ReadonlySet<DelegationStatus>>([
  ["draft", new Set(["confirmed", "cancelled"])],
  ["confirmed", new Set(["spawning", "cancelled"])],
  ["spawning", new Set(["confirmed", "dispatching", "closed"])],
  ["dispatching", new Set(["confirmed", "delivery_unknown", "sent", "closed"])],
  ["delivery_unknown", new Set(["sent", "closed"])],
  ["sent", new Set(["closed"])],
  ["cancelled", new Set()],
  ["closed", new Set()],
]);

function lockDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function acquireDelegationLock(root: string, id: string): Promise<() => Promise<void>> {
  const directory = await validatedDelegationDirectory(root, id);
  const path = join(directory, "record.lock");
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + DELEGATION_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        const currentToken = await readRegularFileBounded(path, 1_024, "delegation lock")
          .then((content) => content.toString("utf8"))
          .catch(() => undefined);
        if (currentToken === token) await rm(path, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await lockDelay(25);
    }
  }
  throw new Error(`Timed out waiting for delegation ${id} record lock.`);
}

export async function updateDelegationRecord(
  root: string,
  id: string,
  update: (record: DelegationRecord) => DelegationRecord,
  options: DelegationUpdateOptions = {},
): Promise<DelegationRecord> {
  const release = await acquireDelegationLock(root, id);
  try {
    const current = await loadDelegationRecord(root, id);
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw new Error(`Delegation ${id} changed concurrently (expected revision ${options.expectedRevision}, current ${current.revision}).`);
    }
    if (options.expectedStatuses && !options.expectedStatuses.includes(current.status)) {
      throw new Error(`Delegation ${id} is ${current.status}; expected ${options.expectedStatuses.join(" or ")}.`);
    }
    const candidate = update(current);
    const next = parseDelegationRecord({ ...candidate, revision: current.revision + 1 });
    if (next.id !== current.id || next.createdAt !== current.createdAt) {
      throw new Error("Delegation identity fields cannot change.");
    }
    if (next.updatedAt < current.updatedAt) throw new Error("Delegation updatedAt cannot move backwards.");
    if (next.status !== current.status && !LEGAL_DELEGATION_TRANSITIONS.get(current.status)?.has(next.status)) {
      throw new Error(`Illegal delegation transition ${current.status} -> ${next.status}.`);
    }
    const directory = await validatedDelegationDirectory(root, id);
    await atomicWrite(join(directory, "record.json"), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } finally {
    await release();
  }
}

export async function cancelDelegationDraft(root: string, id: string, now = Date.now()): Promise<DelegationRecord> {
  return updateDelegationRecord(root, id, (record) => {
    if (record.status === "cancelled") return { ...record, updatedAt: Math.max(record.updatedAt, now) };
    if (record.status !== "draft" && record.status !== "confirmed") {
      throw new Error("Active or terminal delegations must be stopped, not cancelled.");
    }
    return {
      ...record,
      status: "cancelled",
      cancelledAt: now,
      updatedAt: Math.max(record.updatedAt, now),
      lastError: undefined,
    };
  });
}
