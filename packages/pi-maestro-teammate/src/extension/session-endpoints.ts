import type { RemoteWindowMonitorListing } from "./remote-window-monitor.ts";
import type { SettledAgentRecord, TeammateState } from "../shared/types.ts";
import { projectAgentActivity } from "../shared/agent-status.ts";
import {
  projectSessionEndpoints,
  type SessionAgentProjection,
  type SessionDiscoveryProvider,
  type SessionEndpoint,
  type SessionEndpointCapability,
  type SessionOwnerProjection,
  type SessionRouteAuthority,
} from "../sessions/session-core.ts";
import { getWorkspaceProjectionProvider } from "../public/v1/workspace-projections.ts";
import {
  discoverWorkspacePeers,
  type WorkspaceOwnerSnapshot,
  type WorkspacePeerIdentity,
  type WorkspaceSettledSnapshot,
} from "../sessions/workspace-peer-core.ts";

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split("\n", 1)[0]?.trim();
  return line || undefined;
}

function settledBelongsToCurrentProjection(
  state: TeammateState,
  settled: SettledAgentRecord,
): boolean {
  if (!state.currentWorkspaceId || !state.currentSessionId || !state.currentSourceId || !state.sessionGeneration) {
    return true;
  }
  return settled.workspaceId === state.currentWorkspaceId
    && settled.sessionId === state.currentSessionId
    && settled.sourceId === state.currentSourceId
    && settled.sessionGeneration === state.sessionGeneration;
}

function localAgentProjections(state: TeammateState): SessionAgentProjection[] {
  const agents = new Map<string, SessionAgentProjection>();
  for (const active of state.activeRuns.values()) {
    const activity = active.status === "completed" || active.status === "failed" || active.status === "terminated"
      ? "settled" as const
      : projectAgentActivity(active);
    const outputSummary = [...active.outputLog].reverse().find((line) => line.trim().length > 0);
    agents.set(active.correlationId, {
      workspaceId: "",
      ownerId: "",
      ownerNonce: "",
      correlationId: active.correlationId,
      status: activity,
      ...(active.name ? { name: active.name } : {}),
      ...(active.agent ? { agent: active.agent } : {}),
      ...(active.phase ? { phase: active.phase } : {}),
      ...(active.spawnedBy ? { parentCorrelationId: active.spawnedBy } : {}),
      ...(firstLine(active.lastResult) ?? firstLine(outputSummary)
        ? { summary: firstLine(active.lastResult) ?? firstLine(outputSummary) }
        : {}),
      wakeable: activity === "sleeping" || Boolean(active.restart && active.sessionFile),
    });
  }
  for (const settled of state.recentlySettled?.values() ?? []) {
    if (!settledBelongsToCurrentProjection(state, settled) || agents.has(settled.correlationId)) continue;
    agents.set(settled.correlationId, {
      workspaceId: "",
      ownerId: "",
      ownerNonce: "",
      correlationId: settled.correlationId,
      status: "settled",
      ...(settled.name ? { name: settled.name } : {}),
      agent: settled.agent,
      ...(firstLine(settled.lastResult) ? { summary: firstLine(settled.lastResult) } : {}),
    });
  }
  return [...agents.values()];
}

function remoteAgentProjection(
  owner: WorkspaceOwnerSnapshot,
  agent: WorkspaceOwnerSnapshot["agents"][number] | WorkspaceSettledSnapshot,
  settled: boolean,
): SessionAgentProjection {
  return {
    workspaceId: owner.workspaceId,
    ownerId: owner.ownerId,
    ownerNonce: owner.ownerNonce,
    correlationId: agent.correlationId,
    status: settled ? "settled" : agent.status === "sleeping" ? "sleeping" : "running",
    ...(agent.name ? { name: agent.name } : {}),
    agent: agent.agent,
    ...(!settled && "phase" in agent && agent.phase ? { phase: agent.phase } : {}),
    ...(!settled && "parentCorrelationId" in agent && agent.parentCorrelationId
      ? { parentCorrelationId: agent.parentCorrelationId }
      : {}),
    ...(agent.summary ? { summary: agent.summary } : {}),
    wakeable: !settled && "wakeable" in agent && agent.wakeable === true,
  };
}

/** Projects live root state and validated workspace-peer v1 snapshots into canonical endpoints. */
export function localRootSessionCapabilities(monitorAggregation = false): readonly SessionEndpointCapability[] {
  const capabilities: SessionEndpointCapability[] = ["inspect", "message", "steer", "follow_up"];
  if (monitorAggregation) capabilities.push("monitor-workspace-aggregation");
  if (getWorkspaceProjectionProvider("todo") !== undefined) {
    capabilities.push("flow-schedule-todo-binding", "flow-schedule-todo-projection");
    if (getWorkspaceProjectionProvider("flow-schedule-todo-mutation-capability")) capabilities.push("flow-schedule-todo-mutation");
    if (getWorkspaceProjectionProvider("flow-schedule-report-capability")) capabilities.push("flow-schedule-report");
  }
  return Object.freeze(capabilities);
}

/** Exact root claim fence used before reducing evidence captured across awaits. */
export function sameMonitorRootSessionClaim(left: SessionEndpoint, right: SessionEndpoint): boolean {
  return left.kind === "root"
    && right.kind === "root"
    && left.id === right.id
    && left.scope === right.scope
    && left.workspaceId === right.workspaceId
    && left.ownerId === right.ownerId
    && left.ownerNonce === right.ownerNonce
    && left.sessionId === right.sessionId
    && left.sourceId === right.sourceId
    && left.generation === right.generation;
}

/** Selects observable roots without granting capabilities or route authority. */
export function selectMonitorVisibleRootEndpoints(
  endpoints: readonly SessionEndpoint[],
  localIdentity: Pick<WorkspacePeerIdentity, "workspaceId" | "ownerId" | "ownerNonce">,
  validatedOwners: readonly WorkspaceOwnerSnapshot[],
): readonly SessionEndpoint[] {
  return endpoints.filter((endpoint) => {
    if (endpoint.kind !== "root") return false;
    if (endpoint.scope === "ssh-window") return true;
    if (endpoint.workspaceId !== localIdentity.workspaceId) return false;
    const owner = validatedOwners.find((candidate) =>
      candidate.workspaceId === endpoint.workspaceId
      && candidate.ownerId === endpoint.ownerId
      && candidate.ownerNonce === endpoint.ownerNonce
    );
    if (!owner) return false;
    if (endpoint.scope === "workspace-peer") {
      return endpoint.sessionId === owner.sessionId
        && endpoint.sourceId === owner.sessionId
        && endpoint.generation === owner.ownerGeneration;
    }
    return endpoint.scope === "local"
      && endpoint.ownerId === localIdentity.ownerId
      && endpoint.ownerNonce === localIdentity.ownerNonce
      && endpoint.sessionId === owner.sessionId;
  });
}

export function projectTeammateSessionEndpoints(
  state: TeammateState,
  localIdentity: Pick<WorkspacePeerIdentity, "workspaceId" | "ownerId" | "ownerNonce">,
  remoteOwners: readonly WorkspaceOwnerSnapshot[],
  localSessionName?: string,
  monitorAggregation = false,
  sshWindows: readonly RemoteWindowMonitorListing[] = [],
): readonly SessionEndpoint[] {
  const localAgents = localAgentProjections(state).map((agent) => ({
    ...agent,
    workspaceId: localIdentity.workspaceId,
    ownerId: localIdentity.ownerId,
    ownerNonce: localIdentity.ownerNonce,
  }));
  const owners: SessionOwnerProjection[] = [{
    workspaceId: localIdentity.workspaceId,
    ownerId: localIdentity.ownerId,
    ownerNonce: localIdentity.ownerNonce,
    scope: "local",
    status: "running",
    ...(state.currentSessionId ? { sessionId: state.currentSessionId } : {}),
    ...(state.currentSourceId ? { sourceId: state.currentSourceId } : {}),
    ...(state.sessionGeneration === undefined ? {} : { generation: state.sessionGeneration }),
    ...(localSessionName ? { sessionName: localSessionName } : {}),
    capabilities: localRootSessionCapabilities(monitorAggregation),
    agents: localAgents,
  }];
  for (const owner of remoteOwners) {
    owners.push({
      workspaceId: owner.workspaceId,
      ownerId: owner.ownerId,
      ownerNonce: owner.ownerNonce,
      scope: "workspace-peer",
      status: owner.agents.some((agent) => agent.status === "running") ? "running" : "sleeping",
      ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
      ...(owner.sessionId ? { sourceId: owner.sessionId } : {}),
      ...(owner.ownerGeneration === undefined ? {} : { generation: owner.ownerGeneration }),
      ...(owner.sessionName ? { sessionName: owner.sessionName } : {}),
      ...(owner.capabilities ? { extraCapabilities: [...owner.capabilities] as SessionEndpointCapability[] } : {}),
      ...(owner.contextPressure === undefined ? {} : { contextPressure: owner.contextPressure }),
      agents: [
        ...owner.agents.map((agent) => remoteAgentProjection(owner, agent, false)),
        ...owner.settled.map((agent) => remoteAgentProjection(owner, agent, true)),
      ],
    });
  }
  for (const window of sshWindows) {
    const capabilities: SessionEndpointCapability[] = ["inspect"];
    if (window.capture.capabilities.includes("steer") || window.capture.capabilities.includes("follow_up")) {
      capabilities.push("message");
    }
    for (const capability of ["steer", "follow_up", "receipt", "reply"] as const) {
      if (window.capture.capabilities.includes(capability)) capabilities.push(capability);
    }
    owners.push({
      workspaceId: window.capture.workspaceId,
      ownerId: window.capture.ownerId,
      ownerNonce: window.capture.ownerNonce,
      scope: "ssh-window",
      transport: "remote-workspace-rpc-v1",
      status: window.status,
      workspaceRef: window.workspaceRef,
      target: window.target,
      routeAuthority: {
        kind: "ssh",
        authorityId: window.authorityId,
        instanceNonce: window.capture.gatewayInstanceNonce,
      },
      sourceId: window.capture.gatewayWorkerId,
      generation: window.capture.generation,
      capabilities,
      ...(window.sessionId ? { sessionId: window.sessionId } : {}),
      ...(window.sessionName ? { sessionName: window.sessionName } : {}),
      agentCount: window.agentCount,
      agents: [],
    });
  }
  return projectSessionEndpoints(owners);
}

export interface LocalWorkspacePeerDiscoveryProviderOptions {
  state: TeammateState;
  identity: WorkspacePeerIdentity;
  localSessionName?: () => string | undefined;
  monitorAggregation?: () => boolean;
  cleanupStale?: boolean;
  /** @internal deterministic discovery hook for focused tests. */
  discover?: typeof discoverWorkspacePeers;
}

/** Local filesystem discovery provider backed by validated workspace-peer v1 snapshots. */
export class LocalWorkspacePeerDiscoveryProvider implements SessionDiscoveryProvider {
  readonly authority: SessionRouteAuthority;
  readonly #state: TeammateState;
  readonly #identity: WorkspacePeerIdentity;
  readonly #localSessionName: () => string | undefined;
  readonly #monitorAggregation: () => boolean;
  readonly #cleanupStale: boolean;
  readonly #discover: typeof discoverWorkspacePeers;
  #closed = false;

  constructor(options: LocalWorkspacePeerDiscoveryProviderOptions) {
    this.#state = options.state;
    this.#identity = options.identity;
    this.#localSessionName = options.localSessionName ?? (() => undefined);
    this.#monitorAggregation = options.monitorAggregation ?? (() => false);
    this.#cleanupStale = options.cleanupStale ?? true;
    this.#discover = options.discover ?? discoverWorkspacePeers;
    this.authority = Object.freeze({
      kind: "local",
      authorityId: options.identity.workspaceId,
      instanceNonce: options.identity.ownerNonce,
    });
  }

  async refresh(signal?: AbortSignal): Promise<readonly SessionEndpoint[]> {
    if (this.#closed) return Object.freeze([]);
    if (signal?.aborted) throw signal.reason ?? new Error("workspace-peer discovery aborted");
    const capture = {
      workspaceId: this.#identity.workspaceId,
      ownerId: this.#identity.ownerId,
      ownerNonce: this.#identity.ownerNonce,
      ownerGeneration: this.#identity.ownerGeneration,
    };
    const discovery = await this.#discover(this.#identity, { cleanupStale: this.#cleanupStale });
    if (signal?.aborted) throw signal.reason ?? new Error("workspace-peer discovery aborted");
    if (this.#closed) return Object.freeze([]);
    if (capture.workspaceId !== this.#identity.workspaceId
      || capture.ownerId !== this.#identity.ownerId
      || capture.ownerNonce !== this.#identity.ownerNonce
      || capture.ownerGeneration !== this.#identity.ownerGeneration) {
      throw new Error("workspace-peer owner changed while discovery was in flight");
    }
    return projectTeammateSessionEndpoints(
      this.#state,
      this.#identity,
      discovery.peers,
      this.#localSessionName(),
      this.#monitorAggregation(),
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

export function createLocalWorkspacePeerDiscoveryProvider(
  options: LocalWorkspacePeerDiscoveryProviderOptions,
): LocalWorkspacePeerDiscoveryProvider {
  return new LocalWorkspacePeerDiscoveryProvider(options);
}
