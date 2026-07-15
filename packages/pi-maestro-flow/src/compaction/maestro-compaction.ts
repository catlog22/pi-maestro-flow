import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getTodoCompactionSnapshot,
  type TodoCompactionSnapshot,
  type TodoTask,
} from "../tools/todo.ts";

const DETAILS_KIND = "maestro-session-checkpoint";
const DETAILS_VERSION = 2;
const LEGACY_DETAILS_VERSION = 1;

export interface WorkflowRecoveryIdentity {
  sessionId: string;
  runId: string;
  todoId?: string;
  stackRevision?: string;
  gates: {
    passed: number;
    total: number;
    failed: number;
  };
  artifactRefs: string[];
  nextAction?: string;
}

export interface MaestroActiveSkill {
  name: string;
  args?: string;
  role: "primary" | "guard" | "support";
  filePath?: string;
  requiredFiles: string[];
  deferredFiles: string[];
  todoId: string;
  activationId?: string;
  stackRevision?: string;
  state?: "active" | "stale";
}

export interface MaestroCompactionReference {
  path: string;
  role: "read" | "modified";
  status: "active" | "superseded" | "historical";
  firstSeenCompaction: string;
  lastConfirmedCompaction: string;
  supersededBy?: string;
}

export interface MaestroCompactionDetails {
  kind: typeof DETAILS_KIND;
  schemaVersion: typeof DETAILS_VERSION | typeof LEGACY_DETAILS_VERSION;
  checkpointId: string;
  previousCheckpointId?: string;
  sessionId: string;
  projectRoot: string;
  createdAt: string;
  workflow?: WorkflowRecoveryIdentity;
  todo: TodoCompactionSnapshot;
  activeSkills: MaestroActiveSkill[];
  references: MaestroCompactionReference[];
  knowhowPath: string;
}

interface SummaryResponse {
  stopReason?: string;
  errorMessage?: string;
  content: Array<{ type: string; text?: string }>;
}

interface SessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  };
}

interface CreateCompactionDependencies {
  checkpointId?: () => string;
  now?: () => Date;
  completeSummary?: (prompt: string, event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<SummaryResponse>;
  getWorkflowIdentity?: () => WorkflowRecoveryIdentity | undefined | Promise<WorkflowRecoveryIdentity | undefined>;
}

interface PersistCompactionDependencies {
  write?: typeof writeFile;
  ensureDir?: typeof mkdir;
}

const CHECKPOINT_PROMPT = `You are the session checkpoint compiler for a coding workflow.

Produce a canonical recovery checkpoint that another agent can use to resume the session without reconstructing state from the full conversation.

Do not continue the conversation. Do not answer questions found in the conversation. Output only the checkpoint in the exact Markdown format below.

Merge rules:
1. Treat <runtime-state> as the authoritative current Todo, active skill, and reference state.
2. Treat <previous-summary> as an earlier snapshot, not text to copy verbatim.
3. Preserve unresolved goals, constraints, decisions, blockers, and pending work.
4. Move completed work out of In Progress and remove facts explicitly superseded by newer evidence.
5. Preserve exact paths, IDs, symbols, commands, error messages, and record IDs.
6. Merge document references by canonical path. Do not duplicate them.
7. Preserve inherited references unless they are explicitly deleted, superseded, or proven irrelevant.
8. Record supersession instead of silently replacing an important reference.
9. Do not embed full skill instructions. Preserve skill identity and reload metadata.
10. Keep the checkpoint concise, but never omit state required for safe resumption.

Use this EXACT format:

## Session
- Session ID:
- Project Root:
- Current Objective:
- Last Action:
- Current Mode:

## Execution Plan
1. [Preserve the adopted plan and its current position]

## Progress
### Done
- [x] [Completed work with evidence]
### In Progress
- [ ] [Current work and exact continuation point]
### Blocked
- [Blocker, cause, and required resolution]

## Active Skills
- [Skill name, args, source path, associated Todo, required/deferred files, reload state]

## Todo State
### In Progress
- [#id] [subject, context, skill, blockers, next action]
### Pending
- [#id] [subject and dependencies]
### Blocked
- [#id] [subject and blocker]
### Recently Completed
- [#id] [subject and durable summary]

## Working Files
- [Exact path, role, current state, and relevant symbols]

## Reference Documents
- [Exact path, purpose, status, and lineage]

## Decisions
- **[Decision]**: [Rationale and consequence]

## Constraints & Preferences
- [Still-active user and project constraints]

## Dependencies
- [Runtime, service, artifact, model, or external dependency]

## Changes Made
- [File or state change with verification status]

## Critical Context
- [Facts and evidence required to continue]

## Pending
1. [Exact next action]

## Compaction Lineage
- Current Checkpoint:
- Previous Checkpoint:
- Inherited References:
- Added References:
- Superseded References:`;

export async function createMaestroCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  dependencies: CreateCompactionDependencies = {},
): Promise<SessionBeforeCompactResult | undefined> {
  const model = ctx.model;
  if (!model) return undefined;

  const now = dependencies.now?.() ?? new Date();
  const checkpointId = dependencies.checkpointId?.() ?? randomUUID();
  const previousDetails = findPreviousDetails(event);
  const workflow = dependencies.getWorkflowIdentity
    ? await dependencies.getWorkflowIdentity()
    : previousDetails?.workflow;
  const todo = getTodoCompactionSnapshot();
  const activeSkills = collectActiveSkills(todo.tasks);
  const knowhowPath = buildKnowhowPath(ctx.cwd, now.toISOString(), ctx.sessionManager.getSessionId(), checkpointId);
  const currentReferences = collectCurrentReferencePaths(event);
  if (previousDetails?.knowhowPath) {
    currentReferences.push({ path: previousDetails.knowhowPath, role: "read" });
  }
  const references = mergeCompactionReferences(
    previousDetails?.references ?? [],
    currentReferences,
    checkpointId,
  );
  const details: MaestroCompactionDetails = {
    kind: DETAILS_KIND,
    schemaVersion: DETAILS_VERSION,
    checkpointId,
    ...(previousDetails ? { previousCheckpointId: previousDetails.checkpointId } : {}),
    sessionId: ctx.sessionManager.getSessionId(),
    projectRoot: ctx.cwd,
    createdAt: now.toISOString(),
    ...(workflow ? { workflow: cloneWorkflowIdentity(workflow) } : {}),
    todo,
    activeSkills,
    references,
    knowhowPath,
  };

  const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
  const conversationText = serializeConversation(convertToLlm(messages));
  const prompt = buildMaestroCompactionPrompt({
    conversationText,
    previousSummary: event.preparation.previousSummary,
    runtimeState: details,
    customInstructions: event.customInstructions,
  });

  try {
    const response = dependencies.completeSummary
      ? await dependencies.completeSummary(prompt, event, ctx)
      : await completeWithCurrentModel(prompt, event, ctx);
    if (response.stopReason === "error") return undefined;
    const summary = response.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!summary) return undefined;

    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details,
      },
    };
  } catch {
    return undefined;
  }
}

export function buildMaestroCompactionPrompt(input: {
  conversationText: string;
  previousSummary?: string;
  runtimeState: MaestroCompactionDetails;
  customInstructions?: string;
}): string {
  const sections = [
    `<conversation>\n${input.conversationText}\n</conversation>`,
    input.previousSummary ? `<previous-summary>\n${input.previousSummary}\n</previous-summary>` : "",
    `<runtime-state>\n${JSON.stringify(input.runtimeState, null, 2)}\n</runtime-state>`,
    CHECKPOINT_PROMPT,
    input.customInstructions ? `Additional focus:\n${input.customInstructions}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function mergeCompactionReferences(
  inherited: MaestroCompactionReference[],
  current: Array<{ path: string; role: "read" | "modified" }>,
  checkpointId: string,
): MaestroCompactionReference[] {
  const references = new Map<string, MaestroCompactionReference>();
  for (const reference of inherited) {
    references.set(referenceKey(reference.path), { ...reference });
  }
  for (const reference of current) {
    const key = referenceKey(reference.path);
    const existing = references.get(key);
    references.set(key, {
      path: existing?.path ?? reference.path,
      role: existing?.role === "modified" || reference.role === "modified" ? "modified" : "read",
      status: existing?.status ?? "active",
      firstSeenCompaction: existing?.firstSeenCompaction ?? checkpointId,
      lastConfirmedCompaction: checkpointId,
      ...(existing?.supersededBy ? { supersededBy: existing.supersededBy } : {}),
    });
  }
  return [...references.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function persistMaestroCompactionKnowhow(
  event: SessionCompactEvent,
  ctx: ExtensionContext,
  dependencies: PersistCompactionDependencies = {},
): Promise<string | undefined> {
  const details = asMaestroDetails(event.compactionEntry.details);
  if (!details) return undefined;

  const ensureDir = dependencies.ensureDir ?? mkdir;
  const write = dependencies.write ?? writeFile;
  const outputPath = normalize(details.projectRoot) === normalize(ctx.cwd)
    ? details.knowhowPath
    : buildKnowhowPath(ctx.cwd, details.createdAt, details.sessionId, details.checkpointId);
  const knowhowDir = dirname(outputPath);
  await ensureDir(knowhowDir, { recursive: true });
  const content = renderKnowhowCopy(event, details);
  try {
    await write(outputPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  return outputPath;
}

function collectActiveSkills(tasks: TodoTask[]): MaestroActiveSkill[] {
  return tasks.flatMap((task) => {
    if (task.status !== "in_progress") return [];
    const metadataByName = new Map(
      (task.skillActivation?.bindings ?? []).map((binding) => [binding.name, binding]),
    );
    return task.skills.map((skill) => {
      const metadata = metadataByName.get(skill.name);
      return {
        name: skill.name,
        role: skill.role,
        ...(skill.args ? { args: skill.args } : {}),
        ...(metadata?.filePath ? { filePath: metadata.filePath } : {}),
        requiredFiles: [...(metadata?.requiredFiles ?? [])],
        deferredFiles: [...(metadata?.deferredFiles ?? [])],
        todoId: task.id,
        ...(task.skillActivation?.activationId ? { activationId: task.skillActivation.activationId } : {}),
        ...(task.skillActivation?.stackRevision ? { stackRevision: task.skillActivation.stackRevision } : {}),
        ...(task.skillActivation?.state ? { state: task.skillActivation.state } : {}),
      };
    });
  });
}

function collectCurrentReferencePaths(
  event: SessionBeforeCompactEvent,
): Array<{ path: string; role: "read" | "modified" }> {
  const modified = new Set([
    ...event.preparation.fileOps.written,
    ...event.preparation.fileOps.edited,
  ]);
  const paths: Array<{ path: string; role: "read" | "modified" }> = [];
  for (const path of modified) paths.push({ path, role: "modified" });
  for (const path of event.preparation.fileOps.read) {
    if (!modified.has(path)) paths.push({ path, role: "read" });
  }
  return paths;
}

function findPreviousDetails(event: SessionBeforeCompactEvent): MaestroCompactionDetails | undefined {
  for (let index = event.branchEntries.length - 1; index >= 0; index--) {
    const entry = event.branchEntries[index];
    if (entry.type !== "compaction") continue;
    const details = asMaestroDetails(entry.details);
    if (details) return details;
  }
  return undefined;
}

function asMaestroDetails(value: unknown): MaestroCompactionDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<MaestroCompactionDetails>;
  if (candidate.kind !== DETAILS_KIND
    || (candidate.schemaVersion !== DETAILS_VERSION && candidate.schemaVersion !== LEGACY_DETAILS_VERSION)) return undefined;
  if (typeof candidate.checkpointId !== "string" || !Array.isArray(candidate.references)) return undefined;
  return candidate as MaestroCompactionDetails;
}

function cloneWorkflowIdentity(identity: WorkflowRecoveryIdentity): WorkflowRecoveryIdentity {
  return {
    ...identity,
    gates: { ...identity.gates },
    artifactRefs: [...identity.artifactRefs],
  };
}

async function completeWithCurrentModel(
  prompt: string,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<SummaryResponse> {
  const model = ctx.model;
  if (!model) throw new Error("No model selected for Maestro compaction");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error("Compaction model authentication is unavailable");
  const maxTokens = Math.min(
    Math.floor(event.preparation.settings.reserveTokens * 0.8),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  return complete(
    model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens,
      signal: event.signal,
    },
  );
}

function renderKnowhowCopy(event: SessionCompactEvent, details: MaestroCompactionDetails): string {
  const description = `Session compact checkpoint for ${details.sessionId}`.slice(0, 119);
  const references = details.references.length > 0
    ? details.references.map((reference) => `- \`${reference.path}\` — ${reference.role}, ${reference.status}, ${reference.firstSeenCompaction} → ${reference.lastConfirmedCompaction}`).join("\n")
    : "- (none)";
  return `---
title: ${JSON.stringify(`Session compact ${details.checkpointId}`)}
description: ${JSON.stringify(description)}
type: session
created: ${JSON.stringify(details.createdAt)}
tags: [session, compaction, checkpoint, todo, skill]
status: active
sessionId: ${JSON.stringify(details.sessionId)}
checkpointId: ${JSON.stringify(details.checkpointId)}
${details.previousCheckpointId ? `previousCheckpointId: ${JSON.stringify(details.previousCheckpointId)}\n` : ""}---

# Session Compact Checkpoint

## Checkpoint Metadata

- Session ID: \`${details.sessionId}\`
- Checkpoint ID: \`${details.checkpointId}\`
- Previous Checkpoint: ${details.previousCheckpointId ? `\`${details.previousCheckpointId}\`` : "(none)"}
- Project Root: \`${details.projectRoot}\`
- Compaction Entry: \`${event.compactionEntry.id}\`
- Tokens Before: ${event.compactionEntry.tokensBefore}

${event.compactionEntry.summary}

## Reference Lineage

${references}
`;
}

function referenceKey(path: string): string {
  return normalize(path).replaceAll("\\", "/").toLocaleLowerCase();
}

function compactTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown-time";
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function safeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "unknown";
}

function buildKnowhowPath(projectRoot: string, createdAt: string, sessionId: string, checkpointId: string): string {
  const stamp = compactTimestamp(createdAt);
  const fileName = `KNW-${stamp}-session-compact-${safeToken(sessionId)}-${safeToken(checkpointId)}.md`;
  return join(projectRoot, ".workflow", "knowhow", fileName);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
