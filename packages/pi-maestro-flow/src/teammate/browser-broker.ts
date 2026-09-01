import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  proxyTeammateChildTool,
  type TeammateChildToolBrokerRequest,
  type TeammateChildToolResult,
} from "pi-maestro-teammate/v1/child-extensions";
import { createBrowserTool, type BrowserToolDetails } from "../tools/browser-tool.ts";
import {
  BrowserManager,
  type BrowserManagerLike,
  type BrowserManagerStatus,
  type BrowserOpenOptions,
  type BrowserRunOutput,
  type BrowserTabInfo,
} from "../tools/browser/manager.ts";
import type { PairingApproval } from "../tools/browser/bridge-server.ts";

class ScopedTeammateBrowserManager implements BrowserManagerLike {
  readonly #names = new Set<string>();

  constructor(
    readonly actorId: string,
    readonly manager: BrowserManagerLike,
  ) {}

  async open(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    const physicalName = this.#physicalName(options.name);
    this.#names.add(physicalName);
    try {
      const info = await this.manager.open({ ...options, name: physicalName });
      return { ...info, name: options.name };
    } catch (error) {
      this.#names.delete(physicalName);
      throw error;
    }
  }

  run(
    name: string,
    code: string,
    cwd: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<BrowserRunOutput> {
    return this.manager.run(this.#physicalName(name), code, cwd, signal, timeoutMs);
  }

  async status(signal?: AbortSignal): Promise<BrowserManagerStatus> {
    const prefix = `teammate:${this.actorId}:`;
    const status = await this.manager.status(signal);
    return {
      ...status,
      namedTabs: status.namedTabs
        .filter((tab) => this.#names.has(tab.name))
        .map((tab) => ({ ...tab, name: tab.name.slice(prefix.length) })),
    };
  }

  pair(requestId: string, code: string, signal?: AbortSignal): Promise<PairingApproval> {
    return this.manager.pair(requestId, code, signal);
  }

  async close(name: string): Promise<boolean> {
    const physicalName = this.#physicalName(name);
    if (!this.#names.delete(physicalName)) return false;
    return this.manager.close(physicalName);
  }

  async closeAll(): Promise<number> {
    const names = [...this.#names];
    this.#names.clear();
    const closed = await Promise.all(names.map((name) => this.manager.close(name)));
    return closed.filter(Boolean).length;
  }

  #physicalName(name: string): string {
    return `teammate:${this.actorId}:${name}`;
  }
}

export class TeammateBrowserBroker {
  readonly #scopes = new Map<string, ScopedTeammateBrowserManager>();

  constructor(readonly manager: BrowserManagerLike = new BrowserManager()) {}

  async execute(
    request: TeammateChildToolBrokerRequest,
    ctx: ExtensionContext,
  ): Promise<TeammateChildToolResult> {
    const actorId = request.actor.correlationId;
    if (!actorId || actorId === "unknown") {
      return {
        content: [{ type: "text", text: "Teammate browser request has no trusted correlation id." }],
        isError: true,
      };
    }
    const scope = this.#scopes.get(actorId)
      ?? new ScopedTeammateBrowserManager(actorId, this.manager);
    this.#scopes.set(actorId, scope);
    const tool = createBrowserTool(scope);
    return await tool.execute(
      `teammate-browser:${actorId}`,
      request.input as never,
      request.signal ?? new AbortController().signal,
      undefined,
      ctx,
    ) as TeammateChildToolResult;
  }

  async closeActor(actorId: string): Promise<number> {
    const scope = this.#scopes.get(actorId);
    if (!scope) return 0;
    this.#scopes.delete(actorId);
    return scope.closeAll();
  }

  async closeAll(): Promise<number> {
    const scopes = [...this.#scopes.values()];
    this.#scopes.clear();
    const counts = await Promise.all(scopes.map((scope) => scope.closeAll()));
    return counts.reduce((sum, count) => sum + count, 0);
  }
}

export function createTeammateChildBrowserTool(): ToolDefinition {
  const tool = createBrowserTool();
  return {
    ...tool,
    async execute(_id, params, signal): Promise<AgentToolResult<BrowserToolDetails>> {
      return proxyTeammateChildTool<BrowserToolDetails>(
        "browser",
        params as unknown as Record<string, unknown>,
        signal,
      );
    },
  } as ToolDefinition;
}
