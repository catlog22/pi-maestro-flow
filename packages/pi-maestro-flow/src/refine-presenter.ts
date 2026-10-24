/**
 * Flow-side controller that presents a refine session on a remote transport.
 *
 * Flow remains the business authority: it runs the role subagent, records the
 * turn, and only reports a business terminal once the caller has committed the
 * Apply. This module deliberately holds no ordering or recovery state machine —
 * that belongs to the Host and Mobile SDK owners of the wire protocol.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  PlanRefineContext,
  RefinePanelResult,
  RefineRole,
  RefineSession,
  RefineTurn,
} from "./tools/plan-refine.ts";
import { REFINE_ROLES, runRefineSubagent } from "./tools/plan-refine.ts";
import type {
  RefineTransportAction,
  RefineTransportEventBody,
  RefineTransportHandle,
  RefineTransportResult,
  RefineTransportSnapshot,
  RefineTransportTarget,
  RefineTransportTurn,
} from "./refine-transport.ts";

export type { RefinePanelResult };

export type RefineRunContext = PlanRefineContext;

export interface RemoteRefinePanel {
  readonly promise: Promise<RefinePanelResult>;
  dispose(): void;
}

export interface RemoteRefineOptions {
  readonly sessionId: string;
  readonly markdown: string;
  readonly revision: number;
  readonly session: RefineSession;
  readonly signal: AbortSignal;
  readonly cwd: string;
  readonly mode: string;
  readonly onOutput?: (turn: RefineTurn) => Promise<void>;
}

interface RefinePresenterState {
  readonly refineSessionId: string;
  readonly operationId: number;
  readonly target: RefineTransportTarget;
  readonly latestTurn: () => RefineTransportTurn | undefined;
  start(handle: RefineTransportHandle): void;
  handleAction(pi: ExtensionAPI, ctx: RefineRunContext, action: RefineTransportAction): Promise<void>;
  finalize(result: RefineTransportResult): void;
}

function toTransportTurn(turn: RefineTurn, index: number): RefineTransportTurn {
  return {
    ...turn,
    turnId: turn.turnId ?? `turn-${index + 1}`,
    appliesAs: REFINE_ROLES[turn.role].appliesAs,
  };
}

/**
 * Bind one refine session to a presenter. `pi` is supplied per action so the
 * controller stays independent of the extension context lifetime.
 */
export function createRefinePresenterState(options: RemoteRefineOptions): RefinePresenterState {
  const refineSessionId = `refine:${options.cwd}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const operationId = Date.now();
  const target: RefineTransportTarget = { sessionId: options.sessionId, normalizedCwd: options.cwd };
  const session = options.session;
  const signal = options.signal;

  let sequence = 0;
  let handle: RefineTransportHandle | undefined;
  let terminal = false;
  let applying = false;
  let running: AbortController | undefined;
  let latestTurn: RefineTransportTurn | undefined;
  let pendingApplyActionId: string | undefined;
  const seenActions = new Set<string>();

  const snapshot = (): RefineTransportSnapshot => ({
    refineSessionId,
    operationId,
    target,
    revision: options.revision,
    status: running ? "running" : "ready",
    highWaterSequence: sequence,
    session: { ...session, turns: [...session.turns] },
    turns: session.turns.map(toTransportTurn),
  });

  const send = (body: RefineTransportEventBody): void => {
    if (terminal && body.type !== "terminal" && body.type !== "action_result") return;
    sequence += 1;
    handle?.emit({ ...body, sequence });
  };

  /** Mark the session terminal locally; callers still emit their own event. */
  const settle = (): void => {
    if (terminal) return;
    terminal = true;
    running?.abort();
    running = undefined;
  };

  return {
    refineSessionId,
    operationId,
    target,
    latestTurn: () => latestTurn,

    start(opened: RefineTransportHandle) {
      handle = opened;
      send({ type: "status", status: "opening" });
      send({ type: "status", status: "ready" });
      // Emitted last so a reconnecting client recovers state from one frame.
      send({ type: "snapshot", snapshot: snapshot() });
    },

    async handleAction(pi: ExtensionAPI, ctx: RefineRunContext, action: RefineTransportAction) {
      if (seenActions.has(action.actionId)) return;
      seenActions.add(action.actionId);

      if (terminal || applying) {
        send({ type: "action_result", actionId: action.actionId, status: "rejected", errorCode: "session_terminal" });
        return;
      }
      if (action.type === "snapshot_request") {
        send({ type: "snapshot", snapshot: snapshot() });
        return;
      }
      if (action.type === "cancel") {
        send({ type: "action_result", actionId: action.actionId, status: "accepted" });
        settle();
        send({ type: "terminal", status: "cancelled" });
        handle?.finish({ action: "cancel" });
        return;
      }
      if (action.type === "discard") {
        if (running) {
          send({ type: "action_result", actionId: action.actionId, status: "rejected", errorCode: "invalid_state" });
          return;
        }
        send({ type: "action_result", actionId: action.actionId, status: "accepted" });
        settle();
        send({ type: "terminal", status: "discarded" });
        return;
      }
      if (action.type === "apply") {
        if (running || !latestTurn || latestTurn.turnId !== action.turnId) {
          send({ type: "action_result", actionId: action.actionId, status: "rejected", errorCode: "invalid_state" });
          return;
        }
        // Ask for the Apply; the business terminal waits for finalize().
        send({ type: "action_result", actionId: action.actionId, status: "accepted", turnId: action.turnId });
        applying = true;
        pendingApplyActionId = action.actionId;
        handle?.finish({ action: "apply", turnId: action.turnId });
        return;
      }
      if (running) {
        send({ type: "action_result", actionId: action.actionId, status: "rejected", errorCode: "invalid_state" });
        return;
      }
      const spec = REFINE_ROLES[action.role as RefineRole];
      if (!spec || !action.model.trim()) {
        send({ type: "action_result", actionId: action.actionId, status: "rejected", errorCode: "invalid_state" });
        return;
      }

      session.currentRole = action.role;
      session.currentModel = { model: action.model, label: action.modelLabel };
      const controller = new AbortController();
      const runSignal = signal.aborted ? controller.signal : AbortSignal.any([signal, controller.signal]);
      running = controller;
      send({ type: "action_result", actionId: action.actionId, status: "accepted" });
      send({ type: "status", status: "running" });

      const run = await runRefineSubagent(pi, ctx, {
        prompt: spec.buildPrompt(options.markdown, session.turns, action.userInput),
        model: action.model,
        taskType: spec.taskType,
        signal: runSignal,
      });
      if (running !== controller || terminal) return;
      running = undefined;

      if (!run.ok || !run.output) {
        send({ type: "action_result", actionId: action.actionId, status: "failed", errorCode: "run_failed" });
        send({ type: "status", status: "ready" });
        return;
      }

      const turn: RefineTurn = {
        turnId: `turn-${sequence + 1}-${Math.random().toString(36).slice(2, 8)}`,
        role: action.role,
        modelLabel: action.modelLabel,
        userInput: action.userInput,
        output: run.output,
        createdAt: run.createdAt ?? new Date().toISOString(),
      };
      session.turns.push(turn);
      latestTurn = toTransportTurn(turn, session.turns.length - 1);
      try {
        await options.onOutput?.(turn);
      } catch {
        // The turn is already visible to the user; artifact persistence is
        // best-effort and must not turn into a false refine failure.
      }
      send({ type: "turn", turn: latestTurn });
      send({ type: "action_result", actionId: action.actionId, status: "succeeded", turnId: latestTurn.turnId });
      send({ type: "status", status: "ready" });
    },

    finalize(result: RefineTransportResult) {
      if (terminal) return;
      terminal = true;
      send({
        type: "action_result",
        actionId: pendingApplyActionId ?? "apply",
        status: "succeeded",
        turnId: result.turnId,
      });
      send({ type: "terminal", status: result.terminal ?? "applied" });
    },
  };
}
