import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { KnowledgeCliAdapter, type KnowledgeReviewView } from "../knowledge/cli-adapter.ts";
import { tryCopyToClipboard } from "../session/session-export.ts";
import {
  SessionArtifactOverlay,
  type SessionArtifactItem,
  type SessionArtifactOverlayAction,
} from "../tui/session-artifact-overlay.ts";
import { loadCurrentPlanArtifacts, type LoadedPlanArtifactDocument } from "./plan.ts";
import { recordArtifactExportOwnership } from "./session-artifact-export-store.ts";

export interface ArtifactCommandOptions {
  getKnowledgeSessionId?: (ctx: ExtensionCommandContext) => string | undefined;
  loadPlanArtifacts?: (ctx: ExtensionCommandContext) => Promise<LoadedPlanArtifactDocument[]>;
  loadKnowledgeReview?: (cwd: string, sessionId: string) => Promise<KnowledgeReviewView>;
  copy?: (text: string) => Promise<void>;
  writeMarkdown?: (markdown: string, outputPath: string) => Promise<void>;
  onKnowledgeLoaded?: (sessionId: string, candidateCount: number) => Promise<void> | void;
  now?: () => Date;
}

const ARTIFACT_USAGE = "/artifact — view this session's Plan versions, Review & Refine outputs, and staged Maestro Knowledge candidates";

export async function executeArtifactCommand(
  args: string,
  ctx: ExtensionCommandContext,
  options: ArtifactCommandOptions = {},
): Promise<void> {
  const command = args.trim().toLowerCase();
  if (command === "help" || command === "--help" || command === "-h") {
    ctx.ui.notify(ARTIFACT_USAGE, "info");
    return;
  }
  if (command) {
    ctx.ui.notify(`Unknown /artifact argument: ${args.trim()}. Use /artifact or /artifact help.`, "warning");
    return;
  }

  await ctx.waitForIdle?.();
  const piSessionId = ctx.sessionManager.getSessionId();
  const artifacts: SessionArtifactItem[] = [];
  try {
    const planArtifacts = await (options.loadPlanArtifacts ?? defaultPlanLoader)(ctx);
    artifacts.push(...planArtifacts.map(planArtifactItem));
  } catch (error) {
    ctx.ui.notify(`Plan Artifacts could not be loaded: ${errorMessage(error)}`, "warning");
  }

  const knowledgeSessionId = options.getKnowledgeSessionId?.(ctx);
  if (knowledgeSessionId) {
    try {
      const review = await (options.loadKnowledgeReview ?? defaultKnowledgeLoader)(ctx.cwd, knowledgeSessionId);
      artifacts.push(...review.candidates.map((candidate): SessionArtifactItem => ({
        id: `knowledge:${review.session_id}:${candidate.candidate_id}`,
        source: "knowledge",
        title: candidate.title,
        detail: `Knowledge ${candidate.target} · ${candidate.status} · ${candidate.candidate_id}`,
        markdown: candidate.content,
        createdAt: candidate.last_recorded_at,
      })));
      await options.onKnowledgeLoaded?.(review.session_id, review.candidates.length);
    } catch (error) {
      ctx.ui.notify(`Knowledge Artifacts for Maestro Session ${knowledgeSessionId} could not be loaded: ${errorMessage(error)}`, "warning");
    }
  }

  const ordered = orderArtifacts(artifacts);
  if (ordered.length === 0) {
    ctx.ui.notify("当前会话还没有 Artifact。Plan 内容或 Maestro knowledge stage 候选产生后可在此查看。", "info");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(ordered.map((artifact) => `- ${artifact.title} · ${artifact.detail}`).join("\n"), "info");
    return;
  }

  const sessionLabel = knowledgeSessionId
    ? `Pi ${shortId(piSessionId)} · Maestro ${shortId(knowledgeSessionId)}`
    : `Pi ${shortId(piSessionId)}`;
  let selectedId: string | undefined;
  for (;;) {
    const action = await openArtifactOverlay(ctx, ordered, sessionLabel, selectedId);
    selectedId = action.selectedId ?? selectedId;
    if (action.kind === "close") return;
    const selected = ordered.find((artifact) => artifact.id === action.selectedId);
    if (!selected) {
      ctx.ui.notify("Selected Artifact is no longer available.", "warning");
      return;
    }
    if (action.kind === "copy") {
      const copied = await tryCopyToClipboard(selected.markdown, options.copy ?? copyToClipboard);
      ctx.ui.notify(
        copied ? `已复制 Artifact：${selected.title}` : `复制 Artifact 失败：${selected.title}`,
        copied ? "info" : "warning",
      );
      continue;
    }
    const exportedAt = (options.now ?? (() => new Date()))();
    const outputPath = defaultArtifactExportPath(ctx.cwd, selected, exportedAt);
    try {
      const writtenPath = options.writeMarkdown
        ? (await options.writeMarkdown(selected.markdown, outputPath), outputPath)
        : await writeArtifactMarkdownExclusive(selected.markdown, outputPath);
      // Test/custom writers retain their existing injection contract. Every
      // production Markdown export publishes private ownership metadata and is
      // rolled back by the store if that publication fails.
      if (!options.writeMarkdown) {
        await recordArtifactExportOwnership({
          cwd: ctx.cwd,
          writtenPath,
          source: selected.source,
          artifactId: selected.id,
          markdown: selected.markdown,
          createdAt: exportedAt,
        });
      }
      ctx.ui.notify(`已导出 Artifact：${selected.title} → ${writtenPath}`, "info");
    } catch (error) {
      ctx.ui.notify(`导出 Artifact 失败：${errorMessage(error)}`, "warning");
    }
  }
}

export function registerArtifactCommand(pi: ExtensionAPI, options: ArtifactCommandOptions = {}): void {
  pi.registerCommand("artifact", {
    description: "Session Artifacts：预览 Plan 版本、Review 结果和 staged Knowledge，并支持复制/Markdown 导出",
    handler: (args, ctx) => executeArtifactCommand(args, ctx, options),
  });
}

export function defaultArtifactExportPath(cwd: string, artifact: SessionArtifactItem, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const source = artifact.source === "knowledge" ? "knowledge" : artifact.source === "review" ? "review" : "plan";
  const slug = artifact.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "document";
  const suffix = createHash("sha256").update(artifact.id).digest("hex").slice(0, 8);
  return join(cwd, `artifact-${stamp}-${source}-${slug}-${suffix}.md`);
}

export async function writeArtifactMarkdownExclusive(markdown: string, preferredPath: string): Promise<string> {
  await mkdir(dirname(preferredPath), { recursive: true });
  const extension = extname(preferredPath);
  const stem = extension ? preferredPath.slice(0, -extension.length) : preferredPath;
  for (let collision = 0; collision < 1_000; collision += 1) {
    const candidate = collision === 0 ? preferredPath : `${stem}-${collision + 1}${extension}`;
    try {
      const handle = await open(candidate, "wx", 0o600);
      try {
        await handle.writeFile(markdown, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate a collision-free Artifact export path for ${preferredPath}`);
}

export function planArtifactItem(document: LoadedPlanArtifactDocument): SessionArtifactItem {
  const { entry, markdown } = document;
  if (entry.kind === "review") {
    const role = entry.role ?? "reviewer";
    return {
      id: entry.id,
      source: "review",
      title: `Plan Review · r${entry.revision} · ${role}`,
      detail: `Review & Refine · revision ${entry.revision} · ${displayTimestamp(entry.createdAt)}`,
      markdown,
      createdAt: entry.createdAt,
    };
  }
  const kind = entry.kind === "approved" ? "Approved Plan" : entry.kind === "draft" ? "Plan draft" : "Current Plan";
  return {
    id: entry.id,
    source: "plan",
    title: `${kind} · r${entry.revision}`,
    detail: `${entry.kind} · revision ${entry.revision} · ${displayTimestamp(entry.createdAt)}`,
    markdown,
    createdAt: entry.createdAt,
  };
}

export function orderArtifacts(artifacts: readonly SessionArtifactItem[]): SessionArtifactItem[] {
  return [...artifacts].sort((left, right) => {
    if (left.id === "plan-current") return -1;
    if (right.id === "plan-current") return 1;
    return (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.title.localeCompare(right.title);
  });
}

async function openArtifactOverlay(
  ctx: ExtensionCommandContext,
  artifacts: readonly SessionArtifactItem[],
  sessionLabel: string,
  initialSelectedId?: string,
): Promise<SessionArtifactOverlayAction> {
  const result = await ctx.ui.custom<SessionArtifactOverlayAction | undefined>(
    (tui, theme, _keybindings, done) => new SessionArtifactOverlay({
      sessionLabel,
      artifacts,
      initialSelectedId,
      theme: theme as unknown as {
        fg(name: string, text: string): string;
        bold(text: string): string;
      },
      requestRender: () => tui.requestRender(),
      done,
    }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
    },
  );
  return result ?? { kind: "close", selectedId: initialSelectedId };
}

async function defaultPlanLoader(ctx: ExtensionCommandContext): Promise<LoadedPlanArtifactDocument[]> {
  return loadCurrentPlanArtifacts(ctx);
}

async function defaultKnowledgeLoader(cwd: string, sessionId: string): Promise<KnowledgeReviewView> {
  return new KnowledgeCliAdapter(cwd).review(sessionId);
}

function displayTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function shortId(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 17)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
