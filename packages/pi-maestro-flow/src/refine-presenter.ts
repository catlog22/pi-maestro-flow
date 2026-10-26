/**
 * Flow-side adapter that mirrors a local refine overlay onto a remote transport.
 *
 * The local TUI overlay is the single authority for the refine session: it owns
 * the turn list, the running subagent, and the terminal decision. This module
 * only projects that authoritative state onto the wire and replays remote user
 * intents back into the overlay. It never runs a subagent and never invents a
 * terminal, so a detached or failing transport can never change the local flow.
 */

import type { RefineSession, RefineTurn } from "./tools/plan-refine.ts";
import { REFINE_ROLES } from "./tools/plan-refine.ts";
import type {
  RefineTransportAction,
  RefineTransportEventBody,
  RefineTransportHandle,
  RefineTransportResult,
  RefineTransportSnapshot,
  RefineTransportTarget,
  RefineTransportTurn,
} from "./refine-transport.ts";
import type {
  RefineOverlayIntent,
  RefineOverlayMirror,
  RefineOverlayMirrorState,
} from "./tui/plan-refine-overlay.ts";

export interface RemoteRefineOptions {
  readonly sessionId: string;
  readonly markdown: string;
  readonly revision: number;
  readonly session: RefineSession;
  readonly cwd: string;
  readonly mode: string;
}

/** Transport-side identity plus the overlay mirror bridge. */
export interface RefinePresenterState {
  readonly refineSessionId: string;
  readonly operationId: number;
  readonly target: RefineTransportTarget;
  /** Attach the transport handle and emit the opening handshake. */
  start(handle: RefineTransportHandle): void;
  /** Mirror object handed to the local overlay. */
  readonly mirror: RefineOverlayMirror;
  /** Relay one remote action back into the local overlay authority. */
  handleAction(action: RefineTransportAction): void;
  /** Emit the business terminal after the caller committed the Apply. */
  finalize(result: RefineTransportResult): void;
  /** Last turn observed by the mirror, for result projection. */
  latestTurn(): RefineTransportTurn | undefined;
}

/** Convert an internal Refine turn into a transport-serializable turn. */
function toTransportTurn(turn: RefineTurn, index: number): RefineTransportTurn {
  return {
    ...turn,
    turnId: turn.turnId ?? `turn-${index + 1}`,
    appliesAs: REFINE_ROLES[turn.role].appliesAs,
  };
}

/**
 * Create the wire adapter for one refine session. Call `start(handle)` once the
 * transport accepted the request, then hand `mirror` to the local overlay.
 */
export function createRefinePresenterState(options: RemoteRefineOptions): RefinePresenterState {
  const refineSessionId = `refine:${options.cwd}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const operationId = Date.now();
  const target: RefineTransportTarget = { sessionId: options.sessionId, normalizedCwd: options.cwd };

  let sequence = 0;
  let handle: RefineTransportHandle | undefined;
  let terminal = false;
  let latestState: RefineOverlayMirrorState | undefined;
  let latestTurn: RefineTransportTurn | undefined;
  const seenActions = new Set<string>();
  let intentHandler: ((intent: RefineOverlayIntent) => void) | undefined;

  const send = (body: RefineTransportEventBody): void => {
    if (terminal && body.type !== "terminal" && body.type !== "action_result") return;
    sequence += 1;
    try {
      handle?.emit({ ...body, sequence });
    } catch {
      // A detached transport must never break the local authority.
    }
  };

  const snapshot = (): RefineTransportSnapshot => {
    const session = latestState?.session ?? options.session;
    return {
      refineSessionId,
      operationId,
      target,
      revision: options.revision,
      status: latestState?.phase === "running" ? "running" : "ready",
      highWaterSequence: sequence,
      session: { ...session, turns: [...session.turns] },
      turns: session.turns.map(toTransportTurn),
    };
  };

  /** Map one authoritative overlay state onto wire events. */
  function publish(state: RefineOverlayMirrorState): void {
    const previous = latestState;
    latestState = state;
    const turns = state.session.turns.map(toTransportTurn);
    latestTurn = turns.at(-1) ?? latestTurn;

    if (!previous) {
      send({ type: "snapshot", snapshot: snapshot() });
      return;
    }
    if (previous.phase !== state.phase) {
      send({ type: "status", status: state.phase === "running" ? "running" : "ready" });
    }
    const appended = turns.slice(previous.session.turns.length);
    for (const turn of appended) send({ type: "turn", turn });
    if (appended.length === 0 && previous.status !== state.status) {
      // Status text changes are not part of the wire contract; the status frame
      // above already conveys the machine-readable phase transition.
    }
  }

  /** Replay one remote action against the local overlay authority. */
  function replay(action: RefineTransportAction): void {
    if (seenActions.has(action.actionId)) return;
    seenActions.add(action.actionId);
    if (!intentHandler) {
      send({ type: "action_result", actionId: action.actionId, status: "rejected", errorCode: "invalid_state" });
      return;
    }
    if (terminal) {
      send({ type: "action_result", actionId: action.actionId, status: "rejected", errorCode: "session_terminal" });
      return;
    }
    switch (action.type) {
      case "snapshot_request":
        send({ type: "action_result", actionId: action.actionId, status: "accepted" });
        send({ type: "snapshot", snapshot: snapshot() });
        return;
      case "run":
        send({ type: "action_result", actionId: action.actionId, status: "accepted" });
        intentHandler({
          type: "run",
          role: action.role,
          model: action.model,
          label: action.modelLabel,
          userInput: action.userInput,
        });
        return;
      case "apply":
        send({ type: "action_result", actionId: action.actionId, status: "accepted", turnId: action.turnId });
        intentHandler({ type: "apply", turnId: action.turnId });
        return;
      case "discard":
        send({ type: "action_result", actionId: action.actionId, status: "accepted" });
        intentHandler({ type: "discard" });
        return;
      case "cancel":
        send({ type: "action_result", actionId: action.actionId, status: "accepted" });
        intentHandler({ type: "cancel" });
        return;
    }
  }

  return {
    refineSessionId,
    operationId,
    target,
    latestTurn: () => latestTurn,

    start(opened: RefineTransportHandle) {
      handle = opened;
      // The local overlay is the authority, so the transport's own promise is
      // only an advisory signal. Consume it so a failing or detached mirror can
      // never surface as an unhandled rejection.
      void opened.promise.catch((error) => {
        console.error(`[maestro] Refine mirror detached: ${error instanceof Error ? error.message : String(error)}`);
      });
      send({ type: "status", status: "opening" });
      send({ type: "status", status: "ready" });
      // Emitted last so a reconnecting client recovers state from one frame.
      send({ type: "snapshot", snapshot: snapshot() });
    },

    mirror: {
      publish,
      onIntent(handler) {
        intentHandler = handler;
        return () => {
          if (intentHandler === handler) intentHandler = undefined;
        };
      },
    },

    handleAction(action) {
      replay(action);
    },

    finalize(result: RefineTransportResult) {
      if (terminal) return;
      terminal = true;
      send({ type: "terminal", status: result.terminal ?? "applied" });
    },
  };
}

/**
 * Wire one transport handle to a presenter. Exposed separately so the caller can
 * decide whether the transport is worth attaching at all.
 */
export function attachRefineTransport(state: RefinePresenterState, handle: RefineTransportHandle): void {
  state.start(handle);
}
