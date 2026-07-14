export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange?: Range;
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<
    | { textDocument: { uri: string; version?: number | null }; edits: TextEdit[] }
    | { kind: "create"; uri: string }
    | { kind: "rename"; oldUri: string; newUri: string }
    | { kind: "delete"; uri: string; options?: { recursive?: boolean } }
  >;
}

export interface LspServerConfig {
  name: string;
  command: string;
  args: string[];
  fileTypes: string[];
  rootMarkers: string[];
  initializationOptions?: unknown;
  settings?: unknown;
  env?: Record<string, string>;
}

export interface ServerStatus {
  name: string;
  command: string;
  root: string;
  state: "configured" | "starting" | "ready" | "stopped" | "error";
  error?: string;
  capabilities?: Record<string, unknown>;
}

export interface LspClientLike {
  readonly config: LspServerConfig;
  readonly root: string;
  readonly capabilities: Record<string, unknown>;
  readonly closed: boolean;
  ensureFileOpen(file: string): Promise<string>;
  request(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  getDiagnostics(uri: string, waitMs?: number, signal?: AbortSignal): Promise<Diagnostic[]>;
  shutdown(): Promise<void>;
}

export interface LspManagerLike {
  clientForFile(file: string, cwd: string, serverName?: string, signal?: AbortSignal, timeoutMs?: number): Promise<LspClientLike>;
  clientsForWorkspace(cwd: string, signal?: AbortSignal, timeoutMs?: number): Promise<LspClientLike[]>;
  status(cwd: string): Promise<ServerStatus[]>;
  reload(): Promise<void>;
  shutdown(): Promise<void>;
}
