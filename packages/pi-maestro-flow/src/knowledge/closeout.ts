import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface KnowledgeCloseoutTarget {
  sessionId: string;
  candidateIds: string[];
}

export function completedKnowledgeSessions(
  receipts: readonly { operation: string; sessionId?: string }[],
  sealedSessionId?: string,
  currentSessionId?: string,
): string[] {
  return [...new Set([
    ...receipts.filter(receipt => receipt.operation === "session-complete")
      .map(receipt => receipt.sessionId ?? currentSessionId),
    sealedSessionId,
  ].filter((id): id is string => Boolean(id)))];
}

export function stagedKnowledgeCloseoutTarget(output: string): KnowledgeCloseoutTarget | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    const receipt = /\bStaged (KDC-[A-Za-z0-9-]+) on ([A-Za-z0-9-]+) \(session source\)/.exec(output);
    return receipt ? { sessionId: receipt[2], candidateIds: [receipt[1]] } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as { session_id?: unknown; candidate_id?: unknown; run_id?: unknown };
  if (typeof receipt.run_id === "string" && receipt.run_id) return undefined;
  if (typeof receipt.session_id !== "string" || !receipt.session_id
    || typeof receipt.candidate_id !== "string" || !receipt.candidate_id) return undefined;
  return { sessionId: receipt.session_id, candidateIds: [receipt.candidate_id] };
}

const requestsByHost = new WeakMap<ExtensionContext["sessionManager"], {
  hostSessionId: string;
  requested: Map<string, Set<string>>;
}>();

/** Wake the completion owner, not a worker or an exiting session. No writes are authorized here. */
export function createKnowledgeCloseoutRequester(pi: Pick<ExtensionAPI, "sendMessage">) {
  return (ctx: Pick<ExtensionContext, "hasUI" | "sessionManager">, targets: readonly KnowledgeCloseoutTarget[]): boolean => {
    if (!ctx.hasUI || process.env.PI_TEAMMATE_CHILD === "1") return false;
    const hostSessionId = ctx.sessionManager.getSessionId();
    let state = requestsByHost.get(ctx.sessionManager);
    if (!state || state.hostSessionId !== hostSessionId) {
      state = { hostSessionId, requested: new Map() };
      requestsByHost.set(ctx.sessionManager, state);
    }
    const { requested } = state;
    const bySession = new Map<string, Set<string>>();
    for (const target of targets) {
      const ids = bySession.get(target.sessionId) ?? new Set<string>();
      for (const id of target.candidateIds) ids.add(id);
      bySession.set(target.sessionId, ids);
    }
    const pending = [...bySession].map(([sessionId, ids]) => ({
      sessionId,
      candidateIds: [...ids].filter(id => !requested.get(sessionId)?.has(id)).sort(),
    })).filter(target => target.candidateIds.length > 0);
    if (pending.length === 0) return false;
    pi.sendMessage({
      customType: "knowledge-closeout-request",
      content: [
        "Knowledge candidates need owner-side human review now, while this session is interactive.",
        `Fixed scope: ${JSON.stringify(pending)}.`,
        "Read @~/.maestro/ref/knowledge-closeout.md and follow its owner protocol for these exact Sessions/IDs.",
        "Read candidates/evidence/matches with the internal knowledge review API; do not ask the human to run CLI review commands.",
        "Present the fixed IDs, content, evidence, eligibility and recommended actions, then call ask-user-question. Ask itself is the human review.",
        "Collect relationship/target decisions and any publication authorization explicitly together in that Ask; generic review consent is not publication approval. Do not ask twice for unchanged actions already explicitly authorized.",
        "Offer rejection and deferral. Machine advice/timeouts are not authorization. Without a human answer or matching prior explicit approval, retain backlog.",
        "Execute only approved fixed IDs within caller authority, retain all identity/evidence/fresh-receipt gates, then verify outcomes. Never auto-promote or use --all. Backlog does not block task/Session completion.",
      ].join("\n"),
      display: true,
    }, { deliverAs: "followUp", triggerTurn: true });
    for (const target of pending) {
      const ids = requested.get(target.sessionId) ?? new Set<string>();
      for (const id of target.candidateIds) ids.add(id);
      requested.set(target.sessionId, ids);
    }
    return true;
  };
}
