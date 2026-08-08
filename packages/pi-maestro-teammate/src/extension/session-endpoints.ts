import type { TeammateState } from "../shared/types.ts";
import { projectAgentActivity } from "../shared/agent-status.ts";
import {
  projectSessionEndpoints,
  type SessionAgentProjection,
  type SessionEndpoint,
  type SessionOwnerProjection,
} from "../sessions/session-core.ts";
import type {
  WorkspaceOwnerSnapshot,
  WorkspacePeerIdentity,
  WorkspaceSettledSnapshot,
} from "./workspace-peers.ts";

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split("\n", 1)[0]?.trim();
  return line || undefined;
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
    if (agents.has(settled.correlationId)) continue;
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
export function projectTeammateSessionEndpoints(
  state: TeammateState,
  localIdentity: Pick<WorkspacePeerIdentity, "workspaceId" | "ownerId" | "ownerNonce">,
  remoteOwners: readonly WorkspaceOwnerSnapshot[],
  localSessionName?: string,
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
    ...(localSessionName ? { sessionName: localSessionName } : {}),
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
      ...(owner.sessionName ? { sessionName: owner.sessionName } : {}),
      ...(owner.contextPressure === undefined ? {} : { contextPressure: owner.contextPressure }),
      agents: [
        ...owner.agents.map((agent) => remoteAgentProjection(owner, agent, false)),
        ...owner.settled.map((agent) => remoteAgentProjection(owner, agent, true)),
      ],
    });
  }
  return projectSessionEndpoints(owners);
}
