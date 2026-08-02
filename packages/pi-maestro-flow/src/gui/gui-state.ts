import type { GuiRouteResult, GuiServerHandle } from "./types.ts";

/**
 * Aggregated state snapshot routes for the UCL.
 *
 * The UCL stays generic: the extension injects read-only providers for each
 * subsystem (workflow/todos/goal/plan/teammates/swarm). Every value is passed
 * through a JSON round-trip clone so the response is guaranteed serializable and
 * carries no live in-memory references.
 */
export type GuiStateProvider = () => unknown | Promise<unknown>;

export interface GuiStateProviders {
  workflow?: GuiStateProvider;
  todos?: GuiStateProvider;
  goal?: GuiStateProvider;
  plan?: GuiStateProvider;
  teammates?: GuiStateProvider;
  swarm?: GuiStateProvider;
  approvalMode?: () => string;
  sessionId?: () => string | undefined;
}

export const GUI_STATE_SUBSYSTEMS = ["workflow", "todos", "goal", "plan", "teammates", "swarm"] as const;
export type GuiStateSubsystem = (typeof GUI_STATE_SUBSYSTEMS)[number];

/** JSON round-trip clone: drops functions/symbols, guarantees serializable output. */
export function cloneSerializable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export interface GuiStateRouteOptions {
  /** Active generation context; stale routes are denied before and after reads. */
  getCtx?: () => object | undefined;
}

export function registerStateRoutes(
  server: GuiServerHandle,
  providers: GuiStateProviders,
  options: GuiStateRouteOptions = {},
): void {
  const noContext = (): GuiRouteResult => ({
    status: 503,
    error: "No active session context",
    code: "no_context",
  });

  const staleContext = (): GuiRouteResult => ({
    status: 409,
    error: "Session context changed during state read",
    code: "stale_context",
  });

  const readOne = async (sub: GuiStateSubsystem): Promise<unknown> => {
    const provider = providers[sub];
    if (!provider) return null;
    try {
      return cloneSerializable(await provider());
    } catch {
      return null;
    }
  };

  server.registerRoute("GET", "/state", async () => {
    const capturedCtx = options.getCtx?.();
    if (options.getCtx && !capturedCtx) return noContext();

    const [workflow, todos, goal, plan, teammates, swarm] = await Promise.all([
      readOne("workflow"),
      readOne("todos"),
      readOne("goal"),
      readOne("plan"),
      readOne("teammates"),
      readOne("swarm"),
    ]);
    if (capturedCtx && options.getCtx?.() !== capturedCtx) return staleContext();
    return {
      result: {
        workflow,
        todos,
        goal,
        plan,
        teammates,
        swarm,
        approvalMode: providers.approvalMode?.() ?? null,
        sessionId: providers.sessionId?.() ?? null,
      },
    };
  });

  server.registerRoute("GET", "/state/:sub", async (req) => {
    const sub = req.params.sub as GuiStateSubsystem;
    if (!(GUI_STATE_SUBSYSTEMS as readonly string[]).includes(sub)) {
      return { status: 404, error: `Unknown state subsystem: ${sub}`, code: "unknown_subsystem" };
    }

    const capturedCtx = options.getCtx?.();
    if (options.getCtx && !capturedCtx) return noContext();
    const value = await readOne(sub);
    if (capturedCtx && options.getCtx?.() !== capturedCtx) return staleContext();
    return { result: { [sub]: value } };
  });
}
