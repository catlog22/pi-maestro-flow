import { Type } from "typebox";
import {
  publicWorkflowErrorMessage,
  type WorkflowCoordinator,
  type WorkflowLeaseOwnership,
} from "../session/coordinator.ts";

/**
 * Read-only action/command names. Doubles as:
 * - SessionOverlay UI action names (brief/check are read; pause/resume/decision/next/done write)
 * - bash `maestro run <action>` classification for workflow opt-in (isWorkflowOptInCommand)
 */
export const RUN_CONTROL_READ_ACTIONS: ReadonlySet<string> = new Set([
  "status",
  "brief",
  "prepare",
  "check",
  "recall",
  "skill",
  "mutations",
  "list",
  "show",
]);

/** Maestro CLI subcommands classified as read-only by the passthrough shell. */
const RUN_CONTROL_READ_COMMANDS: ReadonlySet<string> = new Set([
  ...RUN_CONTROL_READ_ACTIONS,
  // session family read-only
  "evidence",
  "graph",
  // top-level read-only surfaces
  "skills",
  "search",
  "load",
  "review",
  "help",
]);

/** Entry commands that mint a Session; allowed without a held mutation lease. */
const SESSIONLESS_WRITE_COMMANDS: ReadonlySet<string> = new Set(["create", "start"]);

export interface RunControlClassification {
  write: boolean;
  /** Write that mints a new Session; allowed without an attached lease (entry commands). */
  sessionless: boolean;
}

export function classifyRunControlArgv(argv: readonly string[]): RunControlClassification {
  if (argv.length === 0 || argv.some((argument) => argument === "-h" || argument === "--help")) {
    return { write: false, sessionless: false };
  }
  const command = argv[1] ?? argv[0] ?? "";
  if (RUN_CONTROL_READ_COMMANDS.has(command)) return { write: false, sessionless: false };
  if (SESSIONLESS_WRITE_COMMANDS.has(command)) return { write: true, sessionless: true };
  // Unknown commands default to write-conservative: mutation lease + Plan-mode block apply.
  return { write: true, sessionless: false };
}

export function isRunControlReadAction(action: string): boolean {
  return RUN_CONTROL_READ_ACTIONS.has(action);
}

export function isRunControlReadArgv(argv: readonly string[]): boolean {
  return !classifyRunControlArgv(argv).write;
}

export const RunControlParams = Type.Object({
  argv: Type.Array(Type.String(), {
    description:
      "Maestro CLI arguments without the leading executable, e.g. [\"session\",\"next\",\"--json\"] "
      + "or [\"run\",\"check\",\"run-123\"]. Read commands (status/brief/prepare/check/recall/"
      + "evidence/list/show/graph/skills/search/load/review) need no mutation lease; write commands "
      + "(next/done/decide/seal/edit/...) require the current Pi session to own the Workflow "
      + "mutation lease. Entry commands (session/run create|start) may run without a lease.",
  }),
}, { additionalProperties: false });

export interface RunControlInput {
  argv: string[];
}

export interface RunControlResult {
  ok: boolean;
  action: "exec";
  message: string;
  details?: unknown;
}

export interface RunControlExecutionContext {
  hostSessionId: string;
}

export async function executeRunControl(
  input: RunControlInput,
  coordinator: WorkflowCoordinator,
  context?: RunControlExecutionContext,
): Promise<RunControlResult> {
  try {
    const argv = sanitizeArgv(input.argv);
    if (argv.length === 0) {
      return failure('argv is required, e.g. ["session","status"]');
    }
    const classification = classifyRunControlArgv(argv);
    const hostSessionId = context?.hostSessionId?.trim();
    if (classification.write && !classification.sessionless) {
      required(hostSessionId, "hostSessionId");
    }
    const result = await coordinator.exec(argv, classification, hostSessionId);
    const ownership = hostSessionId && !classification.write
      ? await coordinator.ownership(hostSessionId)
      : undefined;
    return success(readMessage(result.command.stdout, ownership), {
      argv,
      classification,
      command: result.command,
      snapshot: result.snapshot,
      ...(ownership ? { ownership } : {}),
    });
  } catch (error) {
    return failure(publicWorkflowErrorMessage(error));
  }
}

function sanitizeArgv(argv: readonly string[] | undefined): string[] {
  const cleaned = (argv ?? []).map((argument) => String(argument).trim()).filter(Boolean);
  if (cleaned[0] === "maestro" || cleaned[0] === "maestro.cmd") cleaned.shift();
  return cleaned;
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required for this action`);
  return normalized;
}

function readMessage(message: string, ownership: WorkflowLeaseOwnership | undefined): string {
  const notice = ownership ? readOwnershipNotice(ownership) : undefined;
  const base = notice ? `${notice}\n${message}` : message;
  return ownership ? `${base}\n[lease: ${ownershipSummary(ownership)}]` : base;
}

function ownershipSummary(ownership: WorkflowLeaseOwnership): string {
  if (ownership.state === "unowned") return "workflow mutation lease is unowned";
  const owner = ownership.ownerHostSessionId ?? "unknown";
  const freshness = ownership.state === "stale" ? "stale" : "active";
  const relation = ownership.isOwner
    ? ownership.isAttached ? "this Pi session owns" : "this Pi session is recorded as owner of"
    : `Pi session ${owner} owns`;
  return `${relation} the ${freshness} mutation lease `
    + `(epoch ${ownership.epoch}, heartbeat ${ownership.heartbeatAt})`;
}

function readOwnershipNotice(ownership: WorkflowLeaseOwnership): string | undefined {
  if (ownership.state === "owned" && ownership.isOwner && ownership.isAttached) return undefined;
  if (ownership.state === "unowned") {
    return `Read-only view: Workflow Session ${ownership.sessionId} has no mutation lease owner.`;
  }
  if (ownership.isOwner) {
    return `Read-only view: Pi session ${ownership.currentHostSessionId} is recorded as the `
      + `${ownership.state} lease owner, but this coordinator is not attached.`;
  }
  const freshness = ownership.state === "stale" ? "stale" : "active";
  const article = freshness === "active" ? "an" : "a";
  return `Read-only view: Workflow Session ${ownership.sessionId} has ${article} ${freshness} mutation lease `
    + `owned by Pi session ${ownership.ownerHostSessionId}.`;
}

function success(message: string, details?: unknown): RunControlResult {
  return { ok: true, action: "exec", message, ...(details === undefined ? {} : { details }) };
}

function failure(message: string): RunControlResult {
  return { ok: false, action: "exec", message };
}
