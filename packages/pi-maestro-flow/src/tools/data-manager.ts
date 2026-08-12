import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatBytes } from "../session/session-export.ts";
import {
  deleteAgentOutput,
  getAgentOutputStoreUsage,
  type AgentOutputStoreEntry,
} from "../teammate/agent-output-store.ts";

export interface ManagedDataItem {
  id: string;
  title: string;
  detail: string;
  sizeBytes: number;
  updatedAt?: string;
}

export interface ManagedDataSnapshot {
  sourceId: string;
  label: string;
  scope: string;
  totalBytes: number;
  items: ManagedDataItem[];
  capacity?: { used: number; limit: number };
}

export interface ManagedDataSource {
  id: string;
  label: string;
  load(cwd: string): Promise<ManagedDataSnapshot>;
  delete(cwd: string, itemId: string): Promise<boolean>;
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

function outputItem(entry: AgentOutputStoreEntry): ManagedDataItem {
  const task = entry.name ?? entry.agent ?? entry.correlationId;
  return {
    id: entry.id,
    title: task,
    detail: [
      `Resource: agent://${entry.id}`,
      `Captured: ${entry.capturedAt}`,
      `Size: ${formatBytes(entry.sizeBytes)}`,
      `Preview: ${entry.preview || "(empty)"}`,
    ].join("\n"),
    sizeBytes: entry.sizeBytes,
    updatedAt: entry.capturedAt,
  };
}

export function createTeammateOutputDataSource(): ManagedDataSource {
  return {
    id: "teammate-output",
    label: "Teammate outputs",
    async load(cwd) {
      const usage = await getAgentOutputStoreUsage(cwd);
      return {
        sourceId: "teammate-output",
        label: "Teammate outputs",
        scope: "Current workspace",
        totalBytes: usage.totalBytes,
        capacity: { used: usage.records, limit: usage.maxRecords },
        items: usage.entries.map(outputItem),
      };
    },
    delete(cwd, itemId) {
      return deleteAgentOutput(itemId, cwd);
    },
  };
}

export function createDefaultDataManagerRegistry(): DataManagerRegistry {
  const registry = new DataManagerRegistry();
  registry.register(createTeammateOutputDataSource());
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
  lines.push(...snapshot.items.map((item) => `- ${itemLine(item)}`));
  return lines.join("\n");
}

async function loadSnapshots(registry: DataManagerRegistry, cwd: string): Promise<ManagedDataSnapshot[]> {
  return Promise.all(registry.list().map((source) => source.load(cwd)));
}

async function confirmDelete(
  ctx: ExtensionCommandContext,
  source: ManagedDataSource,
  snapshot: ManagedDataSnapshot,
  item: ManagedDataItem,
): Promise<void> {
  const confirmed = await ctx.ui.confirm(
    `Delete from ${snapshot.label}?`,
    `${item.title}\n${item.detail}\n\nThis removes the stored item for this workspace.`,
  );
  if (!confirmed) return;
  const deleted = await source.delete(ctx.cwd, item.id);
  ctx.ui.notify(
    deleted ? `Deleted ${item.id} from ${snapshot.label}.` : `Item no longer exists: ${item.id}`,
    deleted ? "info" : "warning",
  );
}

async function runInteractive(
  ctx: ExtensionCommandContext,
  registry: DataManagerRegistry,
): Promise<void> {
  const snapshots = await loadSnapshots(registry, ctx.cwd);
  if (snapshots.length === 0) {
    ctx.ui.notify("No manageable data sources are registered.", "info");
    return;
  }
  const labels = snapshots.map(sourceLine);
  const selectedLabel = await ctx.ui.select("Local data manager", labels);
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
  if (item && source) await confirmDelete(ctx, source, snapshot, item);
}

const USAGE = "Usage: /data-manager [list | show <source> | delete <source> <item-id>]";

export async function executeDataManagerCommand(
  args: string,
  ctx: ExtensionCommandContext,
  registry = createDefaultDataManagerRegistry(),
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    await runInteractive(ctx, registry);
    return;
  }

  const action = tokens[0]?.toLowerCase();
  if (action === "help" || action === "--help" || action === "-h") {
    ctx.ui.notify(USAGE, "info");
    return;
  }
  if (action === "list") {
    const snapshots = await loadSnapshots(registry, ctx.cwd);
    ctx.ui.notify(snapshots.length ? snapshots.map(sourceLine).join("\n") : "No manageable data sources are registered.", "info");
    return;
  }

  const sourceId = tokens[1];
  const source = sourceId ? registry.get(sourceId) : undefined;
  if (!source) {
    ctx.ui.notify(`${USAGE}\nAvailable sources: ${registry.list().map((item) => item.id).join(", ") || "(none)"}`, "warning");
    return;
  }
  const snapshot = await source.load(ctx.cwd);
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
    await confirmDelete(ctx, source, snapshot, item);
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
