/** Immutable, derived operational handoff record store. Board and Session remain authoritative. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { GatewayHandoffRecordV1 } from "./handoff-record-contracts.ts";
import { parseGatewayHandoffRecord } from "./handoff-record-contracts.ts";
import { containedPath, writeGatewayFileAtomic } from "./state-paths.ts";

const MAX_RECORD_BYTES = 256 * 1024;
const tails = new Map<string, Promise<void>>();

export class GatewayHandoffRecordStoreError extends Error {
  constructor(message: string) { super(message); this.name = "GatewayHandoffRecordStoreError"; }
}

export interface GatewayHandoffRecordPage {
  records: GatewayHandoffRecordV1[];
  nextCursor: number;
  hasMore: boolean;
}

export interface GatewayHandoffRecordFilter {
  authority?: GatewayHandoffRecordV1["source"]["authority"];
  projection?: GatewayHandoffRecordV1["projection"];
  sourceId?: string;
  query?: string;
  cursor?: number;
  limit?: number;
}

function recordBody(record: GatewayHandoffRecordV1): string {
  const lines = ["", `# Handoff ${record.id}`, ""];
  if (record.content.summary) lines.push("## Summary", "", record.content.summary, "");
  if (record.content.nextSteps?.length) lines.push("## Next steps", "", ...record.content.nextSteps.map((step) => `- ${step}`), "");
  if (record.content.files?.length) lines.push("## Files", "", ...record.content.files.map((file) => `- \`${file.path}\` — ${file.value}: ${file.reason}${file.when ? ` (when: ${file.when})` : ""}`), "");
  if (record.content.resourceUris?.length) lines.push("## Resources", "", ...record.content.resourceUris.map((uri) => `- ${uri}`), "");
  return lines.join("\n");
}

export function serializeGatewayHandoffRecord(record: GatewayHandoffRecordV1): string {
  const validated = parseGatewayHandoffRecord(record);
  return `---\n${stringifyYaml(validated).trimEnd()}\n---\n${recordBody(validated)}`;
}

export function parseGatewayHandoffDocument(document: string): GatewayHandoffRecordV1 {
  if (!document.startsWith("---\n")) throw new GatewayHandoffRecordStoreError("handoff document is missing YAML front matter");
  const end = document.indexOf("\n---\n", 4);
  if (end < 0) throw new GatewayHandoffRecordStoreError("handoff document has unterminated YAML front matter");
  try {
    return parseGatewayHandoffRecord(parseYaml(document.slice(4, end)));
  } catch (error) {
    if (error instanceof GatewayHandoffRecordStoreError) throw error;
    throw new GatewayHandoffRecordStoreError(error instanceof Error ? error.message : String(error));
  }
}

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = tails.get(key) ?? Promise.resolve();
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (tails.get(key) === current) tails.delete(key); }
}

export class GatewayHandoffRecordStore {
  private readonly root: string;
  private readonly maxRecords: number;

  constructor(options: { root: string; maxRecords?: number }) {
    this.root = options.root;
    this.maxRecords = options.maxRecords ?? 4096;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 32768) throw new GatewayHandoffRecordStoreError("maxRecords must be in [1, 32768]");
  }

  private workspaceRoot(workspaceId: string): string { return containedPath(this.root, workspaceId); }
  private path(record: Pick<GatewayHandoffRecordV1, "workspaceId" | "id">): string { return containedPath(this.workspaceRoot(record.workspaceId), `${record.id}.md`); }

  async put(input: GatewayHandoffRecordV1): Promise<GatewayHandoffRecordV1> {
    const record = parseGatewayHandoffRecord(input);
    const path = this.path(record);
    return serialized(path, async () => {
      const existing = await this.readPath(path);
      if (existing) {
        if (existing.contentSha256 !== record.contentSha256 || JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new GatewayHandoffRecordStoreError("source revision already has a different handoff projection");
        }
        return existing;
      }
      const names = await this.names(record.workspaceId);
      if (names.length >= this.maxRecords) throw new GatewayHandoffRecordStoreError("handoff record capacity reached");
      await writeGatewayFileAtomic(path, serializeGatewayHandoffRecord(record), { mode: 0o600, maximumBytes: MAX_RECORD_BYTES });
      return record;
    });
  }

  async get(workspaceId: string, id: string): Promise<GatewayHandoffRecordV1 | undefined> {
    return this.readPath(this.path({ workspaceId, id }));
  }

  async list(workspaceId: string, filter: GatewayHandoffRecordFilter = {}): Promise<GatewayHandoffRecordPage> {
    const cursor = filter.cursor ?? 0;
    const limit = filter.limit ?? 64;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new GatewayHandoffRecordStoreError("cursor must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new GatewayHandoffRecordStoreError("limit must be in [1, 256]");
    const query = filter.query?.trim().toLocaleLowerCase();
    if (filter.query !== undefined && !query) throw new GatewayHandoffRecordStoreError("query must be non-empty");
    const terms = query?.split(/\s+/u) ?? [];
    const loaded = (await Promise.all((await this.names(workspaceId)).map((name) => this.readPath(join(this.workspaceRoot(workspaceId), name)))))
      .filter((record): record is GatewayHandoffRecordV1 => record !== undefined)
      .filter((record) => filter.authority === undefined || record.source.authority === filter.authority)
      .filter((record) => filter.projection === undefined || record.projection === filter.projection)
      .filter((record) => filter.sourceId === undefined || record.source.entityId === filter.sourceId)
      .filter((record) => terms.length === 0 || terms.every((term) => JSON.stringify(record).toLocaleLowerCase().includes(term)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    const records = loaded.slice(cursor, cursor + limit);
    return { records, nextCursor: cursor + records.length, hasMore: cursor + records.length < loaded.length };
  }

  private async names(workspaceId: string): Promise<string[]> {
    try { return (await readdir(this.workspaceRoot(workspaceId))).filter((name) => name.endsWith(".md")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private async readPath(path: string): Promise<GatewayHandoffRecordV1 | undefined> {
    try {
      const data = await readFile(path);
      if (data.byteLength > MAX_RECORD_BYTES) throw new GatewayHandoffRecordStoreError("handoff document exceeds the read limit");
      return parseGatewayHandoffDocument(data.toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
