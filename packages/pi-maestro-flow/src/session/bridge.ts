import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  TodoMirrorTaskSpec,
  WorkflowArtifact,
  WorkflowChainStep,
  WorkflowGate,
  WorkflowRun,
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
      const gateResult = await readJson(join(sessionDir, "gates.json"), true);
      if (gateResult.raw) fingerprintParts.push(gateResult.raw);
      if (gateResult.error) diagnostics.push(gateResult.error);
      const gateRecords = gateRegistry(gateResult.value);
      const artifactResult = await readJson(join(sessionDir, "artifacts.json"), true);
      if (artifactResult.raw) fingerprintParts.push(artifactResult.raw);
      if (artifactResult.error) diagnostics.push(artifactResult.error);
      const runResults = await readRuns(join(sessionDir, "runs"), diagnostics, gateRecords);
      fingerprintParts.push(...runResults.raw);
      const session = normalizeSession(
        activeSessionId,
        sessionResult.value,
        runResults.runs,
        artifactResult.value,
        gateRecords,
      );
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
  const chain = [...session.chain];
  const activeRun = session.activeRunId
    ? session.runs.find((run) => run.runId === session.activeRunId)
    : undefined;
  if (activeRun && !chain.some((step) => step.runId === activeRun.runId)) {
    chain.push({
      step: activeRun.runId,
      command: activeRun.command,
      status: activeRun.status,
      runId: activeRun.runId,
    });
  }
  return chain.map((step, index) => {
    const run = step.runId ? session.runs.find((candidate) => candidate.runId === step.runId) : undefined;
    const previous = index > 0 ? chain[index - 1] : undefined;
    const status = todoStatus(
      run,
      session.gates,
      step.status,
      index,
      previous,
      run?.runId === session.activeRunId,
    );
    const summary = stringValue(run?.handoff?.summary);
    const skill = step.skill?.trim();
    return {
      origin: {
        sessionId: session.sessionId,
        step: stableOriginStep(step, run),
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

async function readRuns(
  runsDir: string,
  diagnostics: string[],
  gateRecords: WorkflowGate[] = [],
): Promise<{ runs: WorkflowRun[]; raw: string[] }> {
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
    if (result.value) runs.push(normalizeRun(directory, result.value, gateRecords));
  }
  return { runs, raw };
}

function normalizeSession(
  activeSessionId: string,
  raw: Record<string, unknown>,
  runs: WorkflowRun[],
  artifactRegistry?: Record<string, unknown>,
  gateRecords: WorkflowGate[] = [],
): WorkflowSession {
  const orchestration = recordValue(raw.orchestration);
  const boundary = recordValue(raw.boundary_contract);
  const artifactsRecord = recordValue(artifactRegistry?.artifacts)
    ?? recordValue(artifactRegistry?.records)
    ?? {};
  const aliasesRecord = recordValue(artifactRegistry?.aliases) ?? {};
  const identityRevision = optionalNumber(raw.identity_revision);
  const activityRevision = optionalNumber(raw.activity_revision);
  const revision = Math.max(numberValue(raw.revision), identityRevision ?? 0, activityRevision ?? 0);
  const sessionGateIds = stringArray(raw.gate_ids);
  const externalSessionGates = gateRecords.filter((gate) =>
    sessionGateIds.includes(gate.id) || !gate.runId
  );
  return {
    ...(stringValue(raw.schema_version) ? { schemaVersion: stringValue(raw.schema_version) } : {}),
    sessionId: stringValue(raw.session_id) ?? activeSessionId,
    intent: stringValue(raw.intent) ?? "",
    status: sessionStatus(raw.status),
    revision,
    ...(identityRevision !== undefined ? { identityRevision } : {}),
    ...(activityRevision !== undefined ? { activityRevision } : {}),
    activeRunId: nullableString(raw.active_run_id),
    definitionOfDone: stringValue(boundary?.definition_of_done) ?? "",
    gates: mergeGates(gateArray(raw.gates, "session"), externalSessionGates),
    chain: chainArray(orchestration?.chain),
    runs,
    artifacts: Object.entries(artifactsRecord).map(([artifactId, value]) => normalizeArtifact(artifactId, value)),
    aliases: Object.fromEntries(Object.entries(aliasesRecord).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

function normalizeRun(
  fallbackId: string,
  raw: Record<string, unknown>,
  gateRecords: WorkflowGate[] = [],
): WorkflowRun {
  const input = recordValue(raw.input);
  const command = recordValue(raw.command);
  const output = recordValue(raw.output);
  const runId = stringValue(raw.run_id) ?? fallbackId;
  const gateIds = stringArray(raw.gate_ids);
  const externalGates = gateRecords.filter((gate) =>
    gate.runId === runId || gateIds.includes(gate.id)
  );
  return {
    ...(stringValue(raw.schema_version) ? { schemaVersion: stringValue(raw.schema_version) } : {}),
    runId,
    parentRunId: nullableString(raw.parent_run_id),
    command: stringValue(raw.command) ?? stringValue(command?.name) ?? "unknown",
    status: runStatus(raw.status),
    goal: nullableString(raw.goal),
    args: stringArray(input?.args).length > 0 ? stringArray(input?.args) : stringArray(command?.args),
    gates: mergeGates(gateArray(raw.gates), externalGates),
    primaryArtifactId: nullableString(raw.primary) ?? nullableString(output?.primary_artifact_id),
    handoff: recordValue(raw.handoff) ?? null,
    startedAt: stringValue(raw.started_at) ?? "",
    endedAt: nullableString(raw.ended_at)
      ?? nullableString(raw.sealed_at)
      ?? nullableString(raw.completed_at),
  };
}

function normalizeArtifact(artifactId: string, value: unknown): WorkflowArtifact {
  const raw = recordValue(value) ?? {};
  return {
    artifactId,
    kind: stringValue(raw.kind) ?? "unknown",
    role: stringValue(raw.role) ?? "attachment",
    runId: stringValue(raw.run_id) ?? stringValue(raw.producer_run_id) ?? "",
    path: stringValue(raw.path) ?? stringValue(raw.relative_path) ?? "",
    hash: stringValue(raw.hash) ?? stringValue(raw.content_hash) ?? "",
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
  return value.map((entry, index) => normalizeGate(`gate-${index + 1}`, entry, defaultPhase));
}

function gateRegistry(value: Record<string, unknown> | undefined): WorkflowGate[] {
  if (!value) return [];
  const records = recordValue(value.records) ?? recordValue(value.gates) ?? value;
  return Object.entries(records)
    .filter(([key, entry]) => !["schema_version", "revision"].includes(key) && recordValue(entry))
    .map(([key, entry]) => normalizeGate(key, entry));
}

function normalizeGate(
  fallbackId: string,
  value: unknown,
  defaultPhase?: WorkflowGate["phase"],
): WorkflowGate {
  const raw = recordValue(value) ?? {};
  const runId = stringValue(raw.run_id);
  const phase = phaseValue(raw.phase) ?? defaultPhase;
  return {
    id: stringValue(raw.id) ?? fallbackId,
    ...(runId ? { runId } : {}),
    ...(phase ? { phase } : {}),
    blocking: raw.blocking !== false,
    status: gateStatus(raw.status),
    ...(sourceValue(raw.source) ? { source: sourceValue(raw.source) } : {}),
  };
}

function mergeGates(left: WorkflowGate[], right: WorkflowGate[]): WorkflowGate[] {
  const merged = new Map<string, WorkflowGate>();
  for (const gate of [...left, ...right]) merged.set(gate.id, gate);
  return [...merged.values()];
}

function todoStatus(
  run: WorkflowRun | undefined,
  sessionGates: WorkflowGate[],
  chainStatus: string,
  index: number,
  previous?: WorkflowChainStep,
  isActiveRun = false,
): TodoMirrorTaskSpec["status"] {
  const runFailures = (run?.gates ?? []).filter((gate) =>
    gate.blocking && ["failed", "blocked"].includes(gate.status)
  );
  const completed = run?.status === "completed" || run?.status === "sealed" || chainStatus === "completed";
  const sessionFailures = completed && !isActiveRun
    ? []
    : sessionGates.filter((gate) => gate.blocking && ["failed", "blocked"].includes(gate.status));
  const blockingFailures = [...sessionFailures, ...runFailures];
  if (blockingFailures.some((gate) => gate.phase !== "entry")) return "blocked";
  if (blockingFailures.some((gate) => gate.phase === "entry")) return "pending";
  const runStatusValue = run?.status;
  if (completed) return "completed";
  if (runStatusValue === "running") return "in_progress";
  if (runStatusValue === "blocked" || runStatusValue === "failed" || ["blocked", "failed"].includes(chainStatus)) return "blocked";
  if (index > 0 && previous && previous.status !== "completed") return "blocked";
  return "pending";
}

function originKeyForChainStep(sessionId: string, step: WorkflowChainStep, runs: WorkflowRun[]): string {
  const run = step.runId ? runs.find((candidate) => candidate.runId === step.runId) : undefined;
  return [sessionId, stableOriginStep(step, run), run?.runId ?? "", run ? runSequence(run.runId) : ""].join("\u0000");
}

function stableOriginStep(step: WorkflowChainStep, run: WorkflowRun | undefined): string {
  return run ? `run:${run.runId}` : step.step;
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
  return ["pending", "running", "passed", "failed", "blocked", "waived", "skipped"].includes(String(value))
    ? value as WorkflowGate["status"]
    : "pending";
}

function phaseValue(value: unknown): WorkflowGate["phase"] | undefined {
  return ["entry", "phase", "exit", "transition", "knowledge", "session"].includes(String(value))
    ? value as WorkflowGate["phase"]
    : undefined;
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
