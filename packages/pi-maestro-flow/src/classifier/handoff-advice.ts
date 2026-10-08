import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classify, classifierConfig, classifierStatus, fileValueDomain,
  type ClassifierDomainMode, type ClassifyResult, type FileValueLabel,
} from "pi-maestro-teammate/v1/classify";
import {
  applyTodoHandoffAdviceCAS, assertTodoHandoffAdviceCurrent, captureTodoHandoffAdvice,
  listTodoHandoffAdviceTasks, type TodoHandoffAdviceSnapshot,
} from "../tools/todo.ts";
import type { TodoHandoffFile, TodoHandoffFileInput } from "../tools/todo-contract.ts";

export const HANDOFF_ADVICE_CONFIDENCE_THRESHOLD = 0.8;
export interface HandoffAdviceTaskChoice {
  taskId: string;
  subject: string;
  status: string;
  unknownFiles: number;
  nextAction?: string;
}
export interface HandoffAdviceRow {
  path: string;
  original: TodoHandoffFile;
  label: FileValueLabel;
  confidence: number;
  layer: ClassifyResult<FileValueLabel>["layer"];
  model?: string;
  reason: string;
  when?: string;
  /** Conditional advice becomes selectable only with an explicit human when. */
  eligible: boolean;
  needsWhen: boolean;
  error?: string;
}
export interface HandoffAdvicePreview {
  status: "ready" | "blocked";
  taskId?: string;
  subject?: string;
  nextAction?: string;
  mode: ClassifierDomainMode;
  enabled: boolean;
  threshold: number;
  rows: readonly HandoffAdviceRow[];
  error?: string;
}
export interface HandoffAdviceSelection { path: string; when?: string }
export interface HandoffAdviceApplyResult {
  status: "applied" | "cancelled" | "blocked" | "stale";
  taskId?: string;
  appliedPaths: string[];
  error?: string;
}
interface IssuedPreview {
  snapshot: TodoHandoffAdviceSnapshot;
  preview: HandoffAdvicePreview;
  configFingerprint: string;
}
// Only genuine process-local previews are accepted; machine/serialized arguments
// cannot mint approval or change the machine verdict before host confirmation.
const issued = new WeakMap<HandoffAdvicePreview, IssuedPreview>();
const configFingerprint = (): string => JSON.stringify(classifierConfig());
function assertNotAborted(ctx: ExtensionContext, signal?: AbortSignal): void {
  if (ctx.signal?.aborted || signal?.aborted) throw new Error("Handoff advice cancelled.");
}
function explicitNextAction(task: { handoff?: { nextSteps: string[] }; context?: string }): string | undefined {
  const steps = task.handoff?.nextSteps.filter((step) => step.trim());
  if (steps?.length) return steps.join("\n");
  // An arbitrary context paragraph, filename, or task subject is NOT a next action.
  return task.context?.match(/^\s*(?:nextAction|next action|下一步|下一行动)\s*[:：]\s*(\S[^\r\n]*)/im)?.[1]?.trim();
}

/** Root-only canonical choices. No file content or remote projection is read. */
export function listHandoffAdviceTasks(ctx: ExtensionContext): HandoffAdviceTaskChoice[] {
  return listTodoHandoffAdviceTasks(ctx).map((task) => ({
    taskId: task.id, subject: task.subject, status: task.status,
    unknownFiles: task.handoff?.files.filter((file) => file.value === "unknown").length ?? 0,
    nextAction: explicitNextAction(task),
  }));
}

/** Machine advice only: never changes Todo state or reads referenced file bytes. */
export async function previewHandoffAdvice(
  ctx: ExtensionContext, taskId?: string, signal?: AbortSignal,
): Promise<HandoffAdvicePreview> {
  const status = classifierStatus();
  const mode = status.domains["file-value"]?.mode ?? "off";
  const base: HandoffAdvicePreview = { status: "blocked", enabled: status.enabled, mode,
    threshold: HANDOFF_ADVICE_CONFIDENCE_THRESHOLD, rows: [] };
  try {
    assertNotAborted(ctx, signal);
    const choices = listHandoffAdviceTasks(ctx);
    const id = taskId ?? choices.find((task) => task.status === "in_progress")?.taskId
      ?? (choices.length === 1 ? choices[0]!.taskId : undefined);
    if (!id) return { ...base, error: "Choose a canonical root-owned Todo." };
    const snapshot = captureTodoHandoffAdvice(ctx, id);
    const task = snapshot.task;
    const nextAction = explicitNextAction(task);
    const details = { ...base, taskId: id, subject: task.subject, nextAction };
    if (!nextAction) return { ...details, error: "No explicit next action; no classifier request sent." };
    const files = task.handoff?.files.filter((file) => file.value === "unknown") ?? [];
    if (!files.length) return { ...details, error: "No existing unknown file annotations." };
    if (!status.enabled || mode === "off") return { ...details, error: "File-value classification is disabled." };
    const fingerprint = configFingerprint();
    const rows: HandoffAdviceRow[] = [];
    for (const file of files) {
      assertNotAborted(ctx, signal);
      assertTodoHandoffAdviceCurrent(ctx, snapshot);
      if (fingerprint !== configFingerprint()) throw new Error("Classifier settings changed; preview again.");
      const result = await classify(fileValueDomain, {
        path: file.path, nextAction, reason: file.reason,
      });
      assertNotAborted(ctx, signal);
      assertTodoHandoffAdviceCurrent(ctx, snapshot);
      const confident = status.enabled && mode === "jev" && result.layer === "jev"
        && Number.isFinite(result.confidence) && result.confidence >= HANDOFF_ADVICE_CONFIDENCE_THRESHOLD
        && result.confidence <= 1 && result.label !== "unknown";
      const needsWhen = confident && result.label === "conditional" && !file.when?.trim();
      rows.push({ path: file.path, original: { ...file }, label: result.label,
        confidence: result.confidence, layer: result.layer, model: result.model,
        reason: file.reason, when: file.when, eligible: confident && !needsWhen, needsWhen,
        error: result.degradedReason ?? (!confident ? "Shadow/degraded/low-confidence/unknown advice cannot be applied."
          : needsWhen ? "Supply a concrete human trigger before confirmation." : undefined) });
    }
    if (fingerprint !== configFingerprint()) throw new Error("Classifier settings changed; preview again.");
    const preview: HandoffAdvicePreview = { ...details, status: "ready", rows };
    issued.set(preview, { snapshot, preview: structuredClone(preview), configFingerprint: fingerprint });
    return preview;
  } catch (error) {
    return { ...base, taskId, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Call AFTER closing any custom overlay: only real ctx.ui.confirm authorizes. */
export async function applyHandoffAdvice(
  ctx: ExtensionContext, preview: HandoffAdvicePreview,
  selections: readonly HandoffAdviceSelection[], signal?: AbortSignal,
): Promise<HandoffAdviceApplyResult> {
  const fail = (status: HandoffAdviceApplyResult["status"], error?: string): HandoffAdviceApplyResult =>
    ({ status, taskId: preview.taskId, appliedPaths: [], error });
  const record = issued.get(preview);
  issued.delete(preview); // One-shot, including cancellation/errors. Never retry old approval.
  if (!record) return fail("blocked", "Preview missing/consumed; preview again.");
  const assertFresh = (): void => {
    assertNotAborted(ctx, signal);
    assertTodoHandoffAdviceCurrent(ctx, record.snapshot);
    const status = classifierStatus();
    if (!status.enabled || status.domains["file-value"]?.mode !== "jev"
      || record.configFingerprint !== configFingerprint()) throw new Error("Classifier settings changed; preview again.");
  };
  let files: TodoHandoffFileInput[];
  try {
    assertFresh();
    if (!selections.length || new Set(selections.map((row) => row.path)).size !== selections.length) {
      return fail("blocked", "Select distinct eligible unknown annotations.");
    }
    files = selections.map((selection) => {
      const row = record.preview.rows.find((candidate) => candidate.path === selection.path);
      if (!row || (!row.eligible && !row.needsWhen) || row.original.value !== "unknown") {
        throw new Error("Selection is not eligible machine advice.");
      }
      const when = selection.when?.trim() || row.when?.trim();
      if (row.label === "conditional" && !when) throw new Error("Conditional advice requires a concrete human trigger.");
      return { path: row.path, value: row.label, reason: row.reason,
        ...(when ? { when } : {}) };
    });
  } catch (error) { return fail("blocked", error instanceof Error ? error.message : String(error)); }
  const message = JSON.stringify({ taskId: record.preview.taskId, subject: record.preview.subject,
    nextAction: record.preview.nextAction,
    changes: files.map((file) => ({ original: record.preview.rows.find((row) => row.path === file.path)!.original,
      proposed: file })),
  }, null, 2).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  try {
    assertFresh();
    if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") return fail("blocked", "Interactive host confirmation is required.");
    if (!await ctx.ui.confirm("Apply handoff file-value advice? (machine advice is not authorization)", message)) {
      return fail("cancelled");
    }
    // CAS repeats all fences in the real Todo mutation queue, not before enqueue.
    const result = await applyTodoHandoffAdviceCAS(ctx, record.snapshot, files, assertFresh);
    if (result.isError) {
      const content = result.content[0];
      return fail("stale", content && "text" in content ? content.text : "Todo changed; preview again.");
    }
    return { status: "applied", taskId: record.preview.taskId, appliedPaths: files.map((file) => file.path) };
  } catch (error) { return fail("stale", error instanceof Error ? error.message : String(error)); }
}
