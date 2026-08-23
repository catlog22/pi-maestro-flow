import { Type } from "typebox";
import {
  projectPublicRunCliResult,
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
  "capabilities",
]);

/** Maestro CLI subcommands classified as read-only by the passthrough shell. */
const RUN_CONTROL_READ_COMMANDS: ReadonlySet<string> = new Set([
  ...RUN_CONTROL_READ_ACTIONS,
  "evidence",
  "graph",
  "skills",
  "search",
  "load",
  "review",
  "help",
]);

export type RunControlMutationScope =
  | "read"
  | "session"
  | "run"
  | "execution"
  | "execution-acquire"
  | "execution-lease"
  | "compatibility-start"
  | "plan-publish"
  | "artifact-republish";

export type RunControlLeaseIntent = "none" | "required" | "acquire" | "command-aware";

export interface RunControlClassification {
  write: boolean;
  /** Compatibility field: legacy entry command that may run without a held host lease. */
  sessionless: boolean;
  mutation: RunControlMutationScope;
  lease: RunControlLeaseIntent;
}

const READ_CLASSIFICATION: RunControlClassification = {
  write: false,
  sessionless: false,
  mutation: "read",
  lease: "none",
};

export function classifyRunControlArgv(argv: readonly string[]): RunControlClassification {
  if (argv.length === 0 || argv.some((argument) => argument === "-h" || argument === "--help")) {
    return { ...READ_CLASSIFICATION };
  }

  const family = argv[0] ?? "";
  const command = argv[1] ?? "";
  if (family === "capabilities") return { ...READ_CLASSIFICATION };

  if (family === "artifact") {
    if (["inspect", "list", "show"].includes(command)) return { ...READ_CLASSIFICATION };
    if (command === "republish") return writeClassification("artifact-republish", "none");
    return writeClassification("artifact-republish", "none");
  }

  if (family === "execution") {
    if (["status", "show", "list"].includes(command)) return { ...READ_CLASSIFICATION };
    if (command === "lease") {
      const leaseCommand = argv[2] ?? "";
      if (leaseCommand === "status") return { ...READ_CLASSIFICATION };
      if (leaseCommand === "recover") return writeClassification("execution-lease", "acquire");
      return writeClassification("execution-lease", "required");
    }
    if (command === "handoff") {
      const handoffCommand = argv[2] ?? "";
      if (handoffCommand === "accept") return writeClassification("execution-acquire", "acquire");
      return writeClassification("execution", "required");
    }
    if (["start", "attach", "resume"].includes(command)) {
      return writeClassification("execution-acquire", "acquire");
    }
    if (command === "resolve") return writeClassification("execution", "none");
    return writeClassification("execution", "required");
  }

  if (family === "session") {
    if (["status", "show", "list", "evidence", "graph"].includes(command)) {
      return { ...READ_CLASSIFICATION };
    }
    // session/3.0 Session mutations use Session/orchestration CAS and no
    // legacy lease. The coordinator restores the shared commands' historical
    // lease classification after selecting a non-v3 authority mode.
    // v3 has no pause/chain-audit/participant surface (core batch A/B removed them), so those
    // argv fall through to the shared/default classifications below and fail closed at the core.
    if (command === "open") return writeClassification("session", "none", true);
    if (["complete", "archive", "unarchive", "migrate"].includes(command)) {
      return writeClassification("session", "none");
    }
    if (command === "chain" && ["insert", "skip", "replace", "update"].includes(argv[2] ?? "")) {
      return writeClassification("session", "none");
    }
    if (command === "resume-view") return { ...READ_CLASSIFICATION };
    if (command === "create") return writeClassification("session", "none", true);
    if (["start", "attach", "resume"].includes(command)) {
      return command === "start"
        ? writeClassification("compatibility-start", "command-aware", true)
        : writeClassification("execution-acquire", "acquire");
    }
    if (command === "resolve") return writeClassification("execution", "none");
    return writeClassification("execution", "required");
  }

  if (family === "run") {
    if (RUN_CONTROL_READ_COMMANDS.has(command)) return { ...READ_CLASSIFICATION };
    if (command === "start") {
      return writeClassification("compatibility-start", "command-aware", true);
    }
    if (["next", "create", "decide"].includes(command)) {
      return writeClassification("session", "none");
    }
    // Run-entity mutations use Run CAS. run complete also advances the
    // Session chain, which the coordinator adds as a second v3 fence.
    if (["complete", "transition", "cancel", "seal"].includes(command)) {
      return writeClassification("run", "none");
    }
    return writeClassification("execution", "required");
  }

  if (family === "plan" && command === "publish") {
    return writeClassification("plan-publish", "required");
  }
  if (RUN_CONTROL_READ_COMMANDS.has(family)) return { ...READ_CLASSIFICATION };
  if (family === "start") return writeClassification("compatibility-start", "command-aware", true);
  if (family === "create") return writeClassification("execution", "required", true);
  return writeClassification("execution", "required");
}

function writeClassification(
  mutation: Exclude<RunControlMutationScope, "read">,
  lease: RunControlLeaseIntent,
  sessionless = false,
): RunControlClassification {
  return { write: true, sessionless, mutation, lease };
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
      "Maestro CLI arguments without the leading executable. v3 examples: "
      + "[\"session\",\"status\",\"--session\",\"session-123\",\"--json\"], "
      + "[\"run\",\"brief\",\"run-123\",\"--session\",\"session-123\",\"--json\"], "
      + "[\"run\",\"check\",\"run-123\",\"--session\",\"session-123\",\"--json\"], "
      + "[\"run\",\"next\",\"--session\",\"session-123\",\"--json\"], "
      + "[\"run\",\"complete\",\"run-123\",\"--session\",\"session-123\",\"--verdict\",\"done\",\"--advance\",\"--json\"], "
      + "[\"session\",\"chain\",\"insert\",\"--session\",\"session-123\",\"--step-id\",\"review-1\",\"--command\",\"review\",\"--arg\",\"src\",\"--json\"], "
      + "or [\"session\",\"chain\",\"update\",\"--session\",\"session-123\",\"--step-id\",\"review-1\",\"--stage\",\"verification\",\"--json\"].",
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
    const command = projectPublicRunCliResult(result.command);
    const publicArgv = projectPublicRunCliResult({
      argv,
      stdout: "",
      stderr: "",
      exitCode: 0,
    }).argv;
    const ownership = hostSessionId && !classification.write
      ? await coordinator.ownership(hostSessionId)
      : undefined;
    const commandMessage = command.stderr.trim()
      ? [command.stdout.trimEnd(), command.stderr.trimEnd()].filter(Boolean).join("\n")
      : command.stdout;
    const details = {
      argv: publicArgv,
      classification,
      command,
      snapshot: result.snapshot,
      ...(ownership ? { ownership } : {}),
    };
    const message = readMessage(commandMessage, ownership);
    return command.exitCode === 0 ? success(message, details) : failure(message, details);
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

function failure(message: string, details?: unknown): RunControlResult {
  return { ok: false, action: "exec", message, ...(details === undefined ? {} : { details }) };
}
