import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  TodoMirrorTaskSpec,
  WorkflowArtifact,
  WorkflowChainStep,
  WorkflowGate,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowSession,
  WorkflowSessionStatus,
  WorkflowSnapshot,
} from "./types.ts";

export interface WorkflowBridgeOptions {
  workflowDir?: string;
  now?: () => Date;
}

interface ReadJsonResult {
  value?: Record<string, unknown>;
  raw?: string;
  error?: string;
}

export async function loadCanonicalSnapshot(
  projectRoot: string,
  options: WorkflowBridgeOptions = {},
): Promise<WorkflowSnapshot> {
  const workflowDir = resolve(projectRoot, options.workflowDir ?? ".workflow");
  const diagnostics: string[] = [];
  const fingerprintParts: string[] = [];
  const state = await readJson(join(workflowDir, "state.json"));
  if (state.raw) fingerprintParts.push(state.raw);
  if (state.error) diagnostics.push(state.error);

  const activeSessionId = stringValue(state.value?.active_session_id);
  if (activeSessionId && safeId(activeSessionId)) {
    const sessionDir = join(workflowDir, "sessions", activeSessionId);
    const sessionResult = await readJson(join(sessionDir, "session.json"));
    if (sessionResult.raw) fingerprintParts.push(sessionResult.raw);
    if (sessionResult.error) diagnostics.push(sessionResult.error);
    if (sessionResult.value) {
      const artifactResult = await readJson(join(sessionDir, "artifacts.json"), true);
      if (artifactResult.raw) fingerprintParts.push(artifactResult.raw);
      if (artifactResult.error) diagnostics.push(artifactResult.error);
      const runResults = await readRuns(join(sessionDir, "runs"), diagnostics);
      fingerprintParts.push(...runResults.raw);
      const session = normalizeSession(activeSessionId, sessionResult.value, runResults.runs, artifactResult.value);
      return snapshot("canonical", projectRoot, session, fingerprintParts, diagnostics, options.now);
    }
  } else if (activeSessionId) {
    diagnostics.push(`Rejected unsafe active_session_id: ${activeSessionId}`);
  }

  const legacy = await loadLegacySnapshot(projectRoot, workflowDir, diagnostics, fingerprintParts, options.now);
  if (legacy) return legacy;
  return snapshot("none", projectRoot, undefined, fingerprintParts, diagnostics, options.now);
}

export class WorkflowBridge {
  private current?: WorkflowSnapshot;

  constructor(
    private readonly projectRoot: string,
    private readonly options: WorkflowBridgeOptions = {},
  ) {}

  async refresh(): Promise<WorkflowSnapshot> {
    const next = await loadCanonicalSnapshot(this.projectRoot, this.options);
    if (this.current?.revision.fingerprint === next.revision.fingerprint) return this.current;
    this.current = next;
    return next;
  }

  getSnapshot(): WorkflowSnapshot | undefined {
    return this.current;
  }
}

export function buildTodoMirrorSpecs(snapshot: WorkflowSnapshot): TodoMirrorTaskSpec[] {
  const session = snapshot.session;
  if (!session) return [];
  return session.chain.map((step, index) => {
    const run = step.runId ? session.runs.find((candidate) => candidate.runId === step.runId) : undefined;
    const previous = index > 0 ? session.chain[index - 1] : undefined;
    const status = todoStatus(run?.status, step.status, index, previous);
    const summary = stringValue(run?.handoff?.summary);
    const skill = step.skill?.trim();
    return {
      origin: {
        sessionId: session.sessionId,
        step: step.step,
        ...(run ? { runId: run.runId, runSeq: runSequence(run.runId) } : {}),
      },
      subject: `Step ${index + 1}: ${step.command}`,
      description: run?.goal ?? `Workflow step ${step.step}`,
      status,
      blockedByOriginKeys: previous && previous.status !== "completed" && status !== "completed"
        ? [originKeyForChainStep(session.sessionId, previous, session.runs)]
        : [],
      context: run
        ? `Active canonical Run: ${run.runId}\nUse maestro run brief ${run.runId} before continuing.`
        : `Create the canonical Run for command: ${step.command}`,
      skills: skill ? [{ name: skill, role: "primary" }] : [],
      ...(summary ? { summary } : {}),
    };
  });
}

function snapshot(
  source: WorkflowSnapshot["source"],
  projectRoot: string,
  session: WorkflowSession | undefined,
  fingerprintParts: string[],
  diagnostics: string[],
  now: WorkflowBridgeOptions["now"],
): WorkflowSnapshot {
  return {
    source,
    projectRoot: resolve(projectRoot),
    loadedAt: (now?.() ?? new Date()).toISOString(),
    revision: {
      sessionRevision: session?.revision ?? 0,
      fingerprint: createHash("sha256").update(fingerprintParts.join("\u0000")).digest("hex"),
    },
    ...(session ? { session } : {}),
    diagnostics,
  };
}

async function readJson(path: string, optional = false): Promise<ReadJsonResult> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return { raw, error: `${path} must contain a JSON object` };
    return { raw, value: parsed };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (optional && code === "ENOENT") return {};
    return { error: `${path}: ${errorMessage(error)}` };
  }
}

async function readRuns(runsDir: string, diagnostics: string[]): Promise<{ runs: WorkflowRun[]; raw: string[] }> {
  let directories: string[];
  try {
    directories = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], raw: [] };
    diagnostics.push(`${runsDir}: ${errorMessage(error)}`);
    return { runs: [], raw: [] };
  }
  const runs: WorkflowRun[] = [];
  const raw: string[] = [];
  for (const directory of directories) {
    const result = await readJson(join(runsDir, directory, "run.json"));
    if (result.raw) raw.push(result.raw);
    if (result.error) diagnostics.push(result.error);
    if (result.value) runs.push(normalizeRun(directory, result.value));
  }
  return { runs, raw };
}

function normalizeSession(
  activeSessionId: string,
  raw: Record<string, unknown>,
  runs: WorkflowRun[],
  artifactRegistry?: Record<string, unknown>,
): WorkflowSession {
  const orchestration = recordValue(raw.orchestration);
  const boundary = recordValue(raw.boundary_contract);
  const artifactsRecord = recordValue(artifactRegistry?.artifacts) ?? {};
  const aliasesRecord = recordValue(artifactRegistry?.aliases) ?? {};
  return {
    sessionId: stringValue(raw.session_id) ?? activeSessionId,
    intent: stringValue(raw.intent) ?? "",
    status: sessionStatus(raw.status),
    revision: numberValue(raw.revision),
    activeRunId: nullableString(raw.active_run_id),
    definitionOfDone: stringValue(boundary?.definition_of_done) ?? "",
    gates: gateArray(raw.gates, "session"),
    chain: chainArray(orchestration?.chain),
    runs,
    artifacts: Object.entries(artifactsRecord).map(([artifactId, value]) => normalizeArtifact(artifactId, value)),
    aliases: Object.fromEntries(Object.entries(aliasesRecord).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

function normalizeRun(fallbackId: string, raw: Record<string, unknown>): WorkflowRun {
  const input = recordValue(raw.input);
  return {
    runId: stringValue(raw.run_id) ?? fallbackId,
    parentRunId: nullableString(raw.parent_run_id),
    command: stringValue(raw.command) ?? "unknown",
    status: runStatus(raw.status),
    goal: nullableString(raw.goal),
    args: stringArray(input?.args),
    gates: gateArray(raw.gates),
    primaryArtifactId: nullableString(raw.primary),
    handoff: recordValue(raw.handoff) ?? null,
    startedAt: stringValue(raw.started_at) ?? "",
    endedAt: nullableString(raw.ended_at),
  };
}

function normalizeArtifact(artifactId: string, value: unknown): WorkflowArtifact {
  const raw = recordValue(value) ?? {};
  return {
    artifactId,
    kind: stringValue(raw.kind) ?? "unknown",
    role: stringValue(raw.role) ?? "attachment",
    runId: stringValue(raw.run_id) ?? "",
    path: stringValue(raw.path) ?? "",
    hash: stringValue(raw.hash) ?? "",
    status: stringValue(raw.status) ?? "draft",
    replaces: nullableString(raw.replaces),
  };
}

async function loadLegacySnapshot(
  projectRoot: string,
  workflowDir: string,
  diagnostics: string[],
  fingerprintParts: string[],
  now: WorkflowBridgeOptions["now"],
): Promise<WorkflowSnapshot | undefined> {
  const legacyRoot = join(workflowDir, ".maestro");
  let names: string[];
  try {
    names = (await readdir(legacyRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    const result = await readJson(join(legacyRoot, name, "status.json"), true);
    if (!result.value) continue;
    if (result.raw) fingerprintParts.push(result.raw);
    const rawChain = Array.isArray(result.value.chain)
      ? result.value.chain
      : Array.isArray(result.value.steps)
        ? result.value.steps
        : [];
    const session: WorkflowSession = {
      sessionId: `legacy-${name}`,
      intent: stringValue(result.value.intent) ?? stringValue(result.value.objective) ?? name,
      status: sessionStatus(result.value.status),
      revision: numberValue(result.value.revision),
      activeRunId: null,
      definitionOfDone: "",
      gates: [],
      chain: rawChain.map((entry, index) => normalizeLegacyStep(entry, index)),
      runs: [],
      artifacts: [],
      aliases: {},
    };
    diagnostics.push(`Using legacy workflow projection from .workflow/.maestro/${name}/status.json`);
    return snapshot("legacy", projectRoot, session, fingerprintParts, diagnostics, now);
  }
  return undefined;
}

function chainArray(value: unknown): WorkflowChainStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const raw = recordValue(entry) ?? {};
    return {
      step: stringValue(raw.step) ?? String(index + 1),
      command: stringValue(raw.command) ?? stringValue(raw.step) ?? "unknown",
      status: stringValue(raw.status) ?? "pending",
      runId: nullableString(raw.run_id),
      ...(stringValue(raw.skill) ? { skill: stringValue(raw.skill) } : {}),
    };
  });
}

function normalizeLegacyStep(value: unknown, index: number): WorkflowChainStep {
  const raw = recordValue(value) ?? {};
  return {
    step: stringValue(raw.step) ?? stringValue(raw.id) ?? String(index + 1),
    command: stringValue(raw.command) ?? stringValue(raw.name) ?? `step-${index + 1}`,
    status: stringValue(raw.status) ?? "pending",
    runId: nullableString(raw.run_id),
  };
}

function gateArray(value: unknown, defaultPhase?: WorkflowGate["phase"]): WorkflowGate[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const raw = recordValue(entry) ?? {};
    return {
      id: stringValue(raw.id) ?? `gate-${index + 1}`,
      ...(phaseValue(raw.phase) ?? defaultPhase ? { phase: phaseValue(raw.phase) ?? defaultPhase } : {}),
      blocking: raw.blocking !== false,
      status: gateStatus(raw.status),
      ...(sourceValue(raw.source) ? { source: sourceValue(raw.source) } : {}),
    };
  });
}

function todoStatus(
  runStatusValue: WorkflowRunStatus | undefined,
  chainStatus: string,
  index: number,
  previous?: WorkflowChainStep,
): TodoMirrorTaskSpec["status"] {
  if (runStatusValue === "completed" || runStatusValue === "sealed" || chainStatus === "completed") return "completed";
  if (runStatusValue === "running") return "in_progress";
  if (runStatusValue === "blocked" || runStatusValue === "failed" || ["blocked", "failed"].includes(chainStatus)) return "blocked";
  if (index > 0 && previous && previous.status !== "completed") return "blocked";
  return "pending";
}

function originKeyForChainStep(sessionId: string, step: WorkflowChainStep, runs: WorkflowRun[]): string {
  const run = step.runId ? runs.find((candidate) => candidate.runId === step.runId) : undefined;
  return [sessionId, step.step, run?.runId ?? "", run ? runSequence(run.runId) : ""].join("\u0000");
}

function runSequence(runId: string): string | undefined {
  return /^\d{8}-(\d{3})-/.exec(runId)?.[1];
}

function sessionStatus(value: unknown): WorkflowSessionStatus {
  return ["planned", "running", "paused", "sealed", "archived", "failed"].includes(String(value))
    ? value as WorkflowSessionStatus
    : "planned";
}

function runStatus(value: unknown): WorkflowRunStatus {
  return ["created", "running", "blocked", "failed", "completed", "sealed"].includes(String(value))
    ? value as WorkflowRunStatus
    : "created";
}

function gateStatus(value: unknown): WorkflowGate["status"] {
  return ["pending", "passed", "failed", "waived", "skipped"].includes(String(value))
    ? value as WorkflowGate["status"]
    : "pending";
}

function phaseValue(value: unknown): WorkflowGate["phase"] | undefined {
  return ["entry", "exit", "session"].includes(String(value)) ? value as WorkflowGate["phase"] : undefined;
}

function sourceValue(value: unknown): WorkflowGate["source"] | undefined {
  return ["contract", "prepared", "handoff"].includes(String(value)) ? value as WorkflowGate["source"] : undefined;
}

function safeId(value: string): boolean {
  return value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\u0000");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
