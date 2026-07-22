import {
  deleteManagedServerEntry,
  getPiGlobalConfigPath,
  getProjectConfigPath,
  getServerProvenance,
  loadMcpConfig,
  writeManagedServerEntry,
} from "./config.ts";
import type { McpConfig, ServerEntry } from "./types.ts";

export type McpConfigScope = "user" | "project";

export interface McpManagedServer {
  name: string;
  entry: ServerEntry;
  scope: McpConfigScope | "import";
  path: string;
  readOnly: boolean;
  importKind?: string;
}

export interface McpManagerSnapshot {
  config: McpConfig;
  servers: McpManagedServer[];
  userPath: string;
  projectPath: string;
}

export interface SaveMcpServerRequest {
  previousName?: string;
  name: string;
  entry: ServerEntry;
  scope: McpConfigScope;
  allowImportedOverride?: boolean;
}

const mutationQueues = new Map<string, Promise<void>>();

export class McpManagerStore {
  constructor(
    private readonly cwd: string,
    private readonly overridePath?: string,
  ) {}

  async load(): Promise<McpManagerSnapshot> {
    const config = loadMcpConfig(this.overridePath, this.cwd);
    const provenance = getServerProvenance(this.overridePath, this.cwd);
    const userPath = getPiGlobalConfigPath(this.overridePath);
    const projectPath = getProjectConfigPath(this.cwd);
    const servers = Object.entries(config.mcpServers)
      .map(([name, entry]): McpManagedServer => {
        const source = provenance.get(name);
        const scope = source?.kind ?? "import";
        return {
          name,
          entry,
          scope,
          path: source?.path ?? userPath,
          readOnly: scope === "import",
          ...(source?.importKind ? { importKind: source.importKind } : {}),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return { config, servers, userPath, projectPath };
  }

  async save(request: SaveMcpServerRequest): Promise<McpManagerSnapshot> {
    const name = validateServerName(request.name);
    const path = request.scope === "project"
      ? getProjectConfigPath(this.cwd)
      : getPiGlobalConfigPath(this.overridePath);
    await serializeMutation(path, async () => {
      const snapshot = await this.load();
      const conflict = snapshot.servers.find((server) => server.name === name && server.name !== request.previousName);
      if (conflict && !(conflict.readOnly && request.allowImportedOverride)) {
        throw new Error(`Server "${name}" already exists in ${conflict.scope} configuration`);
      }
      writeManagedServerEntry(path, request.previousName?.trim(), name, request.entry);
    });
    return this.load();
  }

  async delete(server: McpManagedServer): Promise<McpManagerSnapshot> {
    if (server.readOnly) throw new Error(`Imported server "${server.name}" is read-only`);
    await serializeMutation(server.path, () => {
      deleteManagedServerEntry(server.path, server.name);
    });
    return this.load();
  }
}

export function validateServerName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Server name is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error("Server name may use letters, numbers, dot, underscore, and hyphen");
  }
  return name;
}

async function serializeMutation(path: string, mutation: () => Promise<void> | void): Promise<void> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  mutationQueues.set(path, current);
  try {
    await current;
  } finally {
    if (mutationQueues.get(path) === current) mutationQueues.delete(path);
  }
}
