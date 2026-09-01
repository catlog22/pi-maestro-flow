import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatBytes } from "../session/session-export.ts";
import {
  createArtifactExportDataSource,
  createTeammateOutputDataSource,
  createToolSpillDataSource,
} from "./data-manager-artifact-sources.ts";
import {
  createSessionHistoryDataSource,
  createUsageHistoryDataSource,
} from "./data-manager-session-sources.ts";
export { createTeammateOutputDataSource } from "./data-manager-artifact-sources.ts";

export interface ManagedDataItem {
  id: string;
  title: string;
  detail: string;
  sizeBytes: number;
  updatedAt?: string;
  /** Stable content/metadata fingerprint used to reject stale cleanup previews. */
  revision?: string;
  /** Only explicitly eligible items may participate in time-based bulk cleanup. */
  cleanupEligible?: boolean;
  protectionReason?: string;
}

export interface ManagedDataSnapshot {
  sourceId: string;
  label: string;
  scope: string;
  totalBytes: number;
  items: ManagedDataItem[];
  capacity?: { used: number; limit: number };
}

export interface ManagedDataContext {
  cwd: string;
  now: Date;
  currentSessionId?: string;
  currentSessionFile?: string;
  currentSessionDir?: string;
}

export type ManagedDeleteStatus = "deleted" | "missing" | "protected" | "stale" | "partial" | "failed";

export interface ManagedDeleteRequest {
  cwd: string;
  itemId: string;
  revision: string;
  item: ManagedDataItem;
  context: ManagedDataContext;
}

export interface ManagedDeleteResult {
  status: ManagedDeleteStatus;
  reclaimedBytes?: number;
  message?: string;
}

export interface ManagedDataSource {
  id: string;
  label: string;
  load(cwd: string, context?: ManagedDataContext): Promise<ManagedDataSnapshot>;
  delete(cwd: string, itemId: string, context?: ManagedDataContext): Promise<boolean>;
  /** Required for time-based cleanup; legacy sources remain explicit-delete only. */
  guardedDelete?(request: ManagedDeleteRequest): Promise<ManagedDeleteResult>;
}

export class DataManagerRegistry {
  private readonly sources = new Map<string, ManagedDataSource>();

  register(source: ManagedDataSource): void {
    if (this.sources.has(source.id)) throw new Error(`Data source already registered: ${source.id}`);
    this.sources.set(source.id, source);
  }

  list(): ManagedDataSource[] {
    return [...this.sources.values()];
  }

  get(id: string): ManagedDataSource | undefined {
    return this.sources.get(id);
  }
}

export function createDefaultDataManagerRegistry(): DataManagerRegistry {
  const registry = new DataManagerRegistry();
  registry.register(createSessionHistoryDataSource());
  registry.register(createUsageHistoryDataSource());
  registry.register(createTeammateOutputDataSource());
  registry.register(createArtifactExportDataSource());
  registry.register(createToolSpillDataSource());
  return registry;
}

function occupancy(snapshot: ManagedDataSnapshot): string {
  const count = snapshot.capacity
    ? `${snapshot.capacity.used}/${snapshot.capacity.limit} items`
    : `${snapshot.items.length} items`;
  return `${count} · ${formatBytes(snapshot.totalBytes)}`;
}

function sourceLine(snapshot: ManagedDataSnapshot): string {
  return `${snapshot.label} · ${occupancy(snapshot)} · ${snapshot.scope}`;
}

function itemLine(item: ManagedDataItem): string {
  const captured = item.updatedAt ? ` · ${item.updatedAt.slice(0, 19).replace("T", " ")}` : "";
  return `${item.title} · ${formatBytes(item.sizeBytes)}${captured} · ${item.id}`;
}

function formatSnapshot(snapshot: ManagedDataSnapshot): string {
  const lines = [sourceLine(snapshot)];
  if (snapshot.items.length === 0) return `${lines[0]}\nNo stored items.`;
  lines.push(...snapshot.items.map((item) => `- ${itemLine(item)}${item.protectionReason ? ` · protected: ${item.protectionReason}` : ""}`));
  return lines.join("\n");
}

interface SnapshotFailure {
  sourceId: string;
  label: string;
  message: string;
}

interface LoadedSnapshots {
  snapshots: ManagedDataSnapshot[];
  failures: SnapshotFailure[];
}

interface SessionManagerView {
  getSessionId?(): string | undefined;
  getSessionFile?(): string | undefined;
  getSessionDir?(): string | undefined;
}

export interface ExecuteDataManagerOptions {
  now?: () => Date;
}

function commandContext(ctx: ExtensionCommandContext, now: Date): ManagedDataContext {
  const manager = ctx.sessionManager as SessionManagerView | undefined;
  const currentSessionId = manager?.getSessionId?.();
  const currentSessionFile = manager?.getSessionFile?.();
  const currentSessionDir = manager?.getSessionDir?.();
  return {
    cwd: ctx.cwd,
    now,
    ...(currentSessionId ? { currentSessionId } : {}),
    ...(currentSessionFile ? { currentSessionFile } : {}),
    ...(currentSessionDir ? { currentSessionDir } : {}),
  };
}

async function loadSnapshots(
  registry: DataManagerRegistry,
  context: ManagedDataContext,
  sources = registry.list(),
): Promise<LoadedSnapshots> {
  const results = await Promise.all(sources.map(async (source) => {
    try {
      return { snapshot: await source.load(context.cwd, context) };
    } catch (error) {
      return {
        failure: {
          sourceId: source.id,
          label: source.label,
          message: error instanceof Error ? error.message : String(error),
        } satisfies SnapshotFailure,
      };
    }
  }));
  return {
    snapshots: results.flatMap((result) => result.snapshot ? [result.snapshot] : []),
    failures: results.flatMap((result) => result.failure ? [result.failure] : []),
  };
}

function failureLines(failures: readonly SnapshotFailure[]): string[] {
  return failures.map((failure) => `! ${failure.label} (${failure.sourceId}): ${failure.message}`);
}

function itemTime(item: ManagedDataItem): number | undefined {
  if (!item.updatedAt) return undefined;
  const value = Date.parse(item.updatedAt);
  return Number.isFinite(value) ? value : undefined;
}

function statisticsLine(label: string, snapshots: readonly ManagedDataSnapshot[]): string {
  const items = snapshots.flatMap((snapshot) => snapshot.items);
  const times = items.map(itemTime).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const cleanupEligible = items.filter((item) => item.cleanupEligible === true && !item.protectionReason).length;
  const protectedCount = items.filter((item) => Boolean(item.protectionReason)).length;
  const totalBytes = snapshots.reduce((total, snapshot) => total + snapshot.totalBytes, 0);
  const range = times.length > 0
    ? ` · oldest ${new Date(times[0]!).toISOString()} · newest ${new Date(times.at(-1)!).toISOString()}`
    : "";
  return `${label} · ${items.length} items · ${formatBytes(totalBytes)} · cleanup-eligible ${cleanupEligible} · protected ${protectedCount}${range}`;
}

function formatStatistics(snapshots: readonly ManagedDataSnapshot[]): string {
  if (snapshots.length === 0) return "No manageable data sources are registered.";
  return [
    statisticsLine("All sources", snapshots),
    ...snapshots.map((snapshot) => statisticsLine(snapshot.label, [snapshot])),
  ].join("\n");
}

export function parseCleanupAge(value: string): number | undefined {
  const match = /^([1-9]\d*)(h|d|w)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitMs = match[2]!.toLowerCase() === "h"
    ? 60 * 60 * 1_000
    : match[2]!.toLowerCase() === "d"
      ? 24 * 60 * 60 * 1_000
      : 7 * 24 * 60 * 60 * 1_000;
  const duration = amount * unitMs;
  return Number.isSafeInteger(duration) ? duration : undefined;
}

async function confirmDelete(
  ctx: ExtensionCommandContext,
  source: ManagedDataSource,
  snapshot: ManagedDataSnapshot,
  item: ManagedDataItem,
  context: ManagedDataContext,
): Promise<void> {
  if (item.protectionReason) {
    ctx.ui.notify(`Protected item ${item.id}: ${item.protectionReason}`, "warning");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `Delete from ${snapshot.label}?`,
    `${item.title}\n${item.detail}\n\nThis removes the stored item for this workspace.`,
  );
  if (!confirmed) return;
  if (source.guardedDelete) {
    if (!item.revision) {
      ctx.ui.notify(`Protected item ${item.id}: missing deletion revision.`, "warning");
      return;
    }
    const result = await source.guardedDelete({
      cwd: context.cwd,
      itemId: item.id,
      revision: item.revision,
      item,
      context,
    });
    const deleted = result.status === "deleted";
    const deletionMessage = deleted
      ? `Deleted ${item.id} from ${snapshot.label}.${result.message ? ` Warning: ${result.message}` : ""}`
      : `${result.status === "missing" ? "Item no longer exists" : `Could not delete ${item.id} (${result.status})`}: ${result.message ?? item.id}`;
    ctx.ui.notify(deletionMessage, deleted && !result.message ? "info" : "warning");
    return;
  }
  const deleted = await source.delete(context.cwd, item.id, context);
  ctx.ui.notify(
    deleted ? `Deleted ${item.id} from ${snapshot.label}.` : `Item no longer exists: ${item.id}`,
    deleted ? "info" : "warning",
  );
}

interface CleanupCandidate {
  source: ManagedDataSource;
  snapshot: ManagedDataSnapshot;
  item: ManagedDataItem;
}

interface CleanupPreview {
  candidates: CleanupCandidate[];
  skippedOldItems: number;
  failures: SnapshotFailure[];
}

async function cleanupPreview(
  registry: DataManagerRegistry,
  context: ManagedDataContext,
  durationMs: number,
  sourceId: string | undefined,
): Promise<CleanupPreview> {
  const sources = sourceId ? [registry.get(sourceId)].filter((value): value is ManagedDataSource => value !== undefined) : registry.list();
  const loaded = await loadSnapshots(registry, context, sources);
  const cutoff = context.now.getTime() - durationMs;
  const candidates: CleanupCandidate[] = [];
  let skippedOldItems = 0;
  for (const snapshot of loaded.snapshots) {
    const source = registry.get(snapshot.sourceId);
    if (!source) continue;
    for (const item of snapshot.items) {
      const updatedAt = itemTime(item);
      if (updatedAt === undefined || updatedAt > cutoff) continue;
      if (item.cleanupEligible === true && !item.protectionReason && item.revision && source.guardedDelete) {
        candidates.push({ source, snapshot, item });
      } else {
        skippedOldItems += 1;
      }
    }
  }
  return { candidates, skippedOldItems, failures: loaded.failures };
}

function cleanupPreviewText(age: string, preview: CleanupPreview): string {
  const bytes = preview.candidates.reduce((total, candidate) => total + candidate.item.sizeBytes, 0);
  const bySource = new Map<string, { label: string; count: number; bytes: number }>();
  for (const candidate of preview.candidates) {
    const entry = bySource.get(candidate.source.id) ?? { label: candidate.snapshot.label, count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += candidate.item.sizeBytes;
    bySource.set(candidate.source.id, entry);
  }
  return [
    `Cleanup items older than ${age}: ${preview.candidates.length} items · ${formatBytes(bytes)}`,
    ...[...bySource.values()].map((entry) => `- ${entry.label}: ${entry.count} items · ${formatBytes(entry.bytes)}`),
    `Protected/skipped old items: ${preview.skippedOldItems}`,
    ...failureLines(preview.failures),
  ].join("\n");
}

async function deleteCleanupCandidate(
  candidate: CleanupCandidate,
  context: ManagedDataContext,
  cutoff: number,
): Promise<ManagedDeleteResult> {
  try {
    const latest = await candidate.source.load(context.cwd, context);
    const item = latest.items.find((value) => value.id === candidate.item.id);
    if (!item) return { status: "missing" };
    if (item.revision !== candidate.item.revision) return { status: "stale", message: "item changed after preview" };
    const updatedAt = itemTime(item);
    if (item.protectionReason || item.cleanupEligible !== true || updatedAt === undefined || updatedAt > cutoff) {
      return { status: "protected", message: item.protectionReason ?? "item is no longer cleanup-eligible" };
    }
    if (!candidate.source.guardedDelete || !item.revision) {
      return { status: "protected", message: "source does not support guarded cleanup" };
    }
    return await candidate.source.guardedDelete({
      cwd: context.cwd,
      itemId: item.id,
      revision: item.revision,
      item,
      context,
    });
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

async function executeCleanup(
  age: string,
  durationMs: number,
  sourceId: string | undefined,
  ctx: ExtensionCommandContext,
  registry: DataManagerRegistry,
  context: ManagedDataContext,
): Promise<void> {
  const preview = await cleanupPreview(registry, context, durationMs, sourceId);
  const summary = cleanupPreviewText(age, preview);
  if (preview.candidates.length === 0) {
    ctx.ui.notify(summary, preview.failures.length > 0 ? "warning" : "info");
    return;
  }
  const confirmed = await ctx.ui.confirm("Clean local storage?", `${summary}\n\nEvery item will be revalidated before deletion.`);
  if (!confirmed) return;

  const counts: Record<ManagedDeleteStatus, number> = { deleted: 0, missing: 0, protected: 0, stale: 0, partial: 0, failed: 0 };
  const itemResults: Array<{ candidate: CleanupCandidate; result: ManagedDeleteResult }> = [];
  let reclaimedBytes = 0;
  const cutoff = context.now.getTime() - durationMs;
  for (const candidate of preview.candidates) {
    const result = await deleteCleanupCandidate(candidate, context, cutoff);
    itemResults.push({ candidate, result });
    counts[result.status] += 1;
    if (result.status === "deleted") reclaimedBytes += result.reclaimedBytes ?? candidate.item.sizeBytes;
  }
  const protectedOrStale = counts.protected + counts.stale;
  const summaryLine = `Cleanup complete · deleted ${counts.deleted} · partial ${counts.partial} · missing ${counts.missing} · protected/stale ${protectedOrStale} · failed ${counts.failed} · reclaimed ${formatBytes(reclaimedBytes)}`;
  const itemLines = itemResults.map(({ candidate, result }) =>
    `- ${candidate.snapshot.label} · ${candidate.item.id}: ${result.status}${result.message ? ` · ${result.message}` : ""}`
  );
  const hasItemWarning = itemResults.some(({ result }) => result.status !== "deleted" || Boolean(result.message));
  ctx.ui.notify([summaryLine, ...itemLines].join("\n"), hasItemWarning ? "warning" : "info");
}

async function runBrowseInteractive(
  ctx: ExtensionCommandContext,
  registry: DataManagerRegistry,
  context: ManagedDataContext,
  snapshots: ManagedDataSnapshot[],
): Promise<void> {
  const labels = snapshots.map(sourceLine);
  const selectedLabel = await ctx.ui.select("Browse stored data", labels);
  if (selectedLabel === undefined) return;
  const snapshot = snapshots[labels.indexOf(selectedLabel)];
  if (!snapshot) return;
  if (snapshot.items.length === 0) {
    ctx.ui.notify(formatSnapshot(snapshot), "info");
    return;
  }
  const actions = ["View stored items", "Delete an item"];
  const action = await ctx.ui.select(sourceLine(snapshot), actions);
  if (action === undefined) return;
  if (action === actions[0]) {
    ctx.ui.notify(formatSnapshot(snapshot), "info");
    return;
  }
  const itemLabels = snapshot.items.map(itemLine);
  const selectedItemLabel = await ctx.ui.select(`Delete from ${snapshot.label}`, itemLabels);
  if (selectedItemLabel === undefined) return;
  const item = snapshot.items[itemLabels.indexOf(selectedItemLabel)];
  const source = registry.get(snapshot.sourceId);
  if (item && source) await confirmDelete(ctx, source, snapshot, item, context);
}

async function runInteractive(
  ctx: ExtensionCommandContext,
  registry: DataManagerRegistry,
  context: ManagedDataContext,
): Promise<void> {
  const loaded = await loadSnapshots(registry, context);
  if (loaded.snapshots.length === 0) {
    const message = loaded.failures.length > 0 ? failureLines(loaded.failures).join("\n") : "No manageable data sources are registered.";
    ctx.ui.notify(message, loaded.failures.length > 0 ? "warning" : "info");
    return;
  }
  const actions = ["Storage statistics", "Browse stored data", "Quick cleanup"];
  const action = await ctx.ui.select("Local data manager", actions);
  if (action === undefined) return;
  if (action === actions[0]) {
    ctx.ui.notify([formatStatistics(loaded.snapshots), ...failureLines(loaded.failures)].join("\n"), loaded.failures.length > 0 ? "warning" : "info");
    return;
  }
  if (action === actions[1]) {
    await runBrowseInteractive(ctx, registry, context, loaded.snapshots);
    return;
  }
  const targetLabels = ["All eligible sources", ...loaded.snapshots.map((snapshot) => `${snapshot.label} · ${snapshot.sourceId}`)];
  const target = await ctx.ui.select("Quick cleanup source", targetLabels);
  if (target === undefined) return;
  const ages = ["24h", "7d", "30d", "90d"];
  const age = await ctx.ui.select("Delete items older than", ages);
  if (age === undefined) return;
  const duration = parseCleanupAge(age);
  if (duration === undefined) return;
  const snapshot = loaded.snapshots[targetLabels.indexOf(target) - 1];
  await executeCleanup(age, duration, snapshot?.sourceId, ctx, registry, context);
}

const USAGE = "Usage: /data-manager [list | show <source> | delete <source> <item-id> | stats [<source>] | cleanup <Nh|Nd|Nw> [<source>|all]]";

function availableSources(registry: DataManagerRegistry): string {
  return registry.list().map((item) => item.id).join(", ") || "(none)";
}

export async function executeDataManagerCommand(
  args: string,
  ctx: ExtensionCommandContext,
  registry = createDefaultDataManagerRegistry(),
  options: ExecuteDataManagerOptions = {},
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const context = commandContext(ctx, (options.now ?? (() => new Date()))());
  if (tokens.length === 0) {
    await runInteractive(ctx, registry, context);
    return;
  }

  const action = tokens[0]?.toLowerCase();
  if (action === "help" || action === "--help" || action === "-h") {
    ctx.ui.notify(USAGE, "info");
    return;
  }
  if (action === "list" && tokens.length === 1) {
    const loaded = await loadSnapshots(registry, context);
    const lines = [...loaded.snapshots.map(sourceLine), ...failureLines(loaded.failures)];
    ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No manageable data sources are registered.", loaded.failures.length > 0 ? "warning" : "info");
    return;
  }
  if (action === "stats" && tokens.length <= 2) {
    const sourceId = tokens[1];
    const source = sourceId ? registry.get(sourceId) : undefined;
    if (sourceId && !source) {
      ctx.ui.notify(`${USAGE}\nAvailable sources: ${availableSources(registry)}`, "warning");
      return;
    }
    const loaded = await loadSnapshots(registry, context, source ? [source] : undefined);
    ctx.ui.notify([formatStatistics(loaded.snapshots), ...failureLines(loaded.failures)].join("\n"), loaded.failures.length > 0 ? "warning" : "info");
    return;
  }
  if (action === "cleanup" && tokens.length >= 2 && tokens.length <= 3) {
    const age = tokens[1]!;
    const duration = parseCleanupAge(age);
    const requestedSource = tokens[2]?.toLowerCase();
    const sourceId = requestedSource && requestedSource !== "all" ? requestedSource : undefined;
    if (duration === undefined || (sourceId && !registry.get(sourceId))) {
      ctx.ui.notify(`${USAGE}\nAvailable sources: ${availableSources(registry)}`, "warning");
      return;
    }
    await executeCleanup(age, duration, sourceId, ctx, registry, context);
    return;
  }

  const sourceId = tokens[1];
  const source = sourceId ? registry.get(sourceId) : undefined;
  if (!source || ((action === "show" && tokens.length !== 2) || (action === "delete" && tokens.length !== 3))) {
    ctx.ui.notify(`${USAGE}\nAvailable sources: ${availableSources(registry)}`, "warning");
    return;
  }
  const snapshot = await source.load(context.cwd, context);
  if (action === "show") {
    ctx.ui.notify(formatSnapshot(snapshot), "info");
    return;
  }
  if (action === "delete") {
    const itemId = tokens[2];
    const item = itemId ? snapshot.items.find((candidate) => candidate.id === itemId) : undefined;
    if (!item) {
      ctx.ui.notify(itemId ? `Unknown item in ${source.id}: ${itemId}` : USAGE, "warning");
      return;
    }
    await confirmDelete(ctx, source, snapshot, item, context);
    return;
  }
  ctx.ui.notify(USAGE, "warning");
}

export function registerDataManagerCommand(
  pi: ExtensionAPI,
  registry = createDefaultDataManagerRegistry(),
): void {
  pi.registerCommand("data-manager", {
    description: "View local data occupancy and explicitly delete stored items",
    async handler(args, ctx) {
      try {
        await executeDataManagerCommand(args, ctx, registry);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
