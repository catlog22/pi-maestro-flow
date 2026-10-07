/** Host-memory-only Plan preauthorization. No session entry is ever replayed. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export const PLAN_AUTO_KEY = "alt+shift+a";
export const PLAN_AUTO_AUDIT_ENTRY = "maestro-plan-auto-audit";
export type PlanAutoContext = Pick<ExtensionContext, "cwd" | "sessionManager">;
export interface PlanAutoTaskContext {
  readonly markdown: string;
  readonly revision: number;
  readonly handoffKey?: string;
}
export interface PlanAutoGrantSnapshot {
  readonly sessionId: string;
  readonly cwd: string;
  readonly planCycle: number;
  readonly generation: number;
  /** Only plan-confirm may use this; ask remains allowed after consumption. */
  readonly confirmPending: boolean;
  readonly taskContext: Readonly<PlanAutoTaskContext>;
}

let generation = 0;
let planCycle = 0;
let cycleScope: { sessionId: string; cwd: string } | undefined;
let taskContext: Readonly<PlanAutoTaskContext> = Object.freeze({ markdown: "", revision: 0 });
let grant: PlanAutoGrantSnapshot | undefined;
let lastReason = "default-off";

function scope(ctx: PlanAutoContext) {
  return { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
}
function sameScope(a: { sessionId: string; cwd: string }, b: { sessionId: string; cwd: string }): boolean {
  return !!a.sessionId && !!a.cwd && a.sessionId === b.sessionId && a.cwd === b.cwd;
}

/** Explicit revocation fences every outstanding snapshot. Does not stop already-started execution. */
export function revokePlanAuto(reason: string): void {
  if (grant) generation++;
  grant = undefined;
  lastReason = reason;
}

/** Called on an actual Act -> Plan transition, never on edits or compaction. */
export function beginPlanAutoCycle(ctx: PlanAutoContext, task: PlanAutoTaskContext): void {
  revokePlanAuto("new-plan-cycle");
  planCycle++;
  cycleScope = scope(ctx);
  taskContext = Object.freeze({ ...task });
}

export function resetPlanAuto(reason: string): void {
  revokePlanAuto(reason);
  cycleScope = undefined;
  taskContext = Object.freeze({ markdown: "", revision: 0 });
}

/** Revision changes preserve authorization but update its bounded task context. */
export function updatePlanAutoTaskContext(ctx: PlanAutoContext, task: PlanAutoTaskContext): void {
  if (!cycleScope || !sameScope(cycleScope, scope(ctx))) {
    revokePlanAuto("scope-changed");
    return;
  }
  taskContext = Object.freeze({ ...task });
  if (grant) grant = Object.freeze({ ...grant, taskContext });
}

/** Call at each async boundary; reading from another session/cwd permanently revokes. */
export function getPlanAutoSnapshot(ctx: PlanAutoContext): PlanAutoGrantSnapshot | undefined {
  if (grant) {
    let observed: ReturnType<typeof scope>;
    try { observed = scope(ctx); } catch {
      // Real Pi invalidates old context getters on replacement/reload. A stale
      // async reader is denied, but must not revoke a newer session's grant.
      return undefined;
    }
    if (!sameScope(grant, observed)) revokePlanAuto("scope-changed");
  }
  return grant;
}

/** Identity fence for confirm/approval/handoff; consumption does not invalidate this fence. */
export function isCurrentPlanAutoGrant(snapshot: PlanAutoGrantSnapshot, ctx: PlanAutoContext): boolean {
  if (!grant || grant.generation !== snapshot.generation || grant.planCycle !== snapshot.planCycle) return false;
  const current = getPlanAutoSnapshot(ctx);
  return !!current && current.generation === snapshot.generation && current.planCycle === snapshot.planCycle
    && sameScope(current, snapshot);
}

/** Ask additionally fences changes to the task material used for classification/advice. */
export function isCurrentPlanAutoTask(snapshot: PlanAutoGrantSnapshot, ctx: PlanAutoContext): boolean {
  return isCurrentPlanAutoGrant(snapshot, ctx) && grant!.taskContext.markdown === snapshot.taskContext.markdown
    && grant!.taskContext.revision === snapshot.taskContext.revision
    && grant!.taskContext.handoffKey === snapshot.taskContext.handoffKey;
}

/** T2 calls only after a successful manifest commit, before switching to Act. */
export function markPlanAutoConfirmed(ctx: PlanAutoContext, snapshot: PlanAutoGrantSnapshot, task: PlanAutoTaskContext): boolean {
  if (!isCurrentPlanAutoGrant(snapshot, ctx) || !grant!.confirmPending) return false;
  updatePlanAutoTaskContext(ctx, task);
  grant = Object.freeze({ ...grant!, confirmPending: false });
  return true;
}

export function getPlanAutoState(ctx: PlanAutoContext) {
  const snapshot = getPlanAutoSnapshot(ctx);
  return Object.freeze({ enabled: !!snapshot, generation, planCycle, reason: lastReason, snapshot });
}

export function planAutoStatusLabel(ctx: PlanAutoContext): string {
  const snapshot = getPlanAutoSnapshot(ctx);
  return snapshot ? `PLAN-AUTO ${snapshot.confirmPending ? "confirm+ask" : "ask"} g${snapshot.generation}` : "PLAN-AUTO off";
}

/**
 * Pi 0.99 dispatches registered commands BEFORE source-aware input hooks and
 * creates an identical CommandContext for interactive/rpc/extension input.
 * hasUI (even mode=tui) therefore cannot attest a command's human origin.
 * Register discovery/completion, but deny grant creation in that callback.
 * The TUI raw terminal callback consumes a physical Enter submission itself;
 * it never leaves a reusable provenance token for a machine command to steal.
 * Source-aware input hooks reject sendUserMessage (source=extension) and RPC.
 */
export function registerPlanAuto(pi: ExtensionAPI, options: {
  isPlanMode(): boolean;
  onStateChange(ctx: ExtensionContext): void;
}): void {
  resetPlanAuto("reload");
  let terminalDispose: (() => void) | undefined;
  let activeCtx: ExtensionContext | undefined;
  let promptDepth = 0;

  function handle(args: string, ctx: ExtensionContext, origin: "terminal" | "shortcut" | "unattested"): void {
    const action = args.trim().toLowerCase();
    if (action && !["on", "off", "status"].includes(action)) {
      ctx.ui.notify("用法：/plan-auto [on|off|status]（无参数切换）", "warning");
      return;
    }
    const current = getPlanAutoSnapshot(ctx);
    if (action === "status") {
      ctx.ui.notify(`Plan-auto: ${planAutoStatusLabel(ctx)} · ${lastReason}`, "info");
      options.onStateChange(ctx);
      return;
    }
    const enabling = action === "on" || (!action && !current);
    if (enabling) {
      if (origin === "unattested" || ctx.mode !== "tui" || !ctx.hasUI
        || process.env.PI_TEAMMATE_CHILD === "1" || activeCtx === undefined
        || !sameScope(scope(activeCtx), scope(ctx))) {
        ctx.ui.notify("Plan-auto 未开启：无法认证真人交互来源。请在父会话 TUI 输入 /plan-auto on 或按 Alt+Shift+A。", "warning");
        options.onStateChange(ctx);
        return;
      }
      if (!options.isPlanMode() || !cycleScope || !sameScope(cycleScope, scope(ctx))) {
        ctx.ui.notify("Plan-auto 只能在当前 Plan 周期开启；Act 中可 off/status。", "warning");
        options.onStateChange(ctx);
        return;
      }
      if (!current) {
        generation++;
        grant = Object.freeze({ ...scope(ctx), planCycle, generation, confirmPending: true, taskContext });
        lastReason = "human-preauthorization";
        try {
          pi.appendEntry(PLAN_AUTO_AUDIT_ENTRY, { action: "on", origin,
            sessionId: grant.sessionId, cwd: grant.cwd, planCycle, generation, replayable: false });
        } catch {
          revokePlanAuto("audit-failed");
          options.onStateChange(ctx);
          ctx.ui.notify("Plan-auto 未开启：宿主审计写入失败。", "warning");
          return;
        }
      }
      ctx.ui.notify("Plan-auto 已开启：下一次 plan-confirm 自动批准并执行，固定 standalone/current；内部问答可能使用 classifier 和现有 LLM fallback。敏感操作、权限、配置、发布、支付、凭证、知识晋升仍须人工；不启用 classifier、不修改项目 policy。/plan-auto off 或 Alt+Shift+A 关闭（不会终止已开始执行）。", "info");
    } else {
      revokePlanAuto("off");
      if (current) pi.appendEntry(PLAN_AUTO_AUDIT_ENTRY, { action: "off", origin, generation, replayable: false });
      ctx.ui.notify("Plan-auto 已关闭；后续自动决策停止，已开始的执行不受影响。", "info");
    }
    options.onStateChange(ctx);
  }

  pi.registerCommand("plan-auto", {
    description: "真人会话预授权：/plan-auto [on|off|status]，默认关闭；Alt+Shift+A 切换",
    getArgumentCompletions(prefix) {
      return ["on", "off", "status"].filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) { handle(args, ctx, "unattested"); },
  });
  pi.registerShortcut(PLAN_AUTO_KEY, {
    description: "Toggle human Plan-auto preauthorization (Alt+Shift+A)",
    async handler(ctx) { if (!promptDepth) handle("", ctx, "shortcut"); },
  });
  pi.on("input", (event, ctx) => {
    const match = /^\/plan-auto(?:\s+(.*))?$/i.exec(event.text.trim());
    if (!match) return;
    // Registered-command dispatch is not source-aware. Only terminal submission
    // and the native shortcut can enable; this hook can safely revoke/report.
    handle(match[1] ?? "", ctx, "unattested");
    return { action: "handled" };
  });
  pi.on("ui_prompt_start", () => { promptDepth++; });
  pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });
  pi.on("session_start", (_event, ctx) => {
    terminalDispose?.();
    terminalDispose = undefined;
    activeCtx = ctx;
    promptDepth = 0;
    resetPlanAuto("session-start");
    if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.onTerminalInput === "function") {
      terminalDispose = ctx.ui.onTerminalInput((data) => {
        if (promptDepth || !matchesKey(data, "enter")) return;
        const match = /^\/plan-auto(?:\s+(.*))?$/i.exec(ctx.ui.getEditorText().trim());
        if (!match) return;
        ctx.ui.setEditorText("");
        handle(match[1] ?? "", ctx, "terminal");
        return { consume: true };
      });
    }
    options.onStateChange(ctx);
  });
  const revokeForSession = (reason: string, ctx: ExtensionContext) => {
    revokePlanAuto(reason);
    options.onStateChange(ctx);
  };
  pi.on("session_before_switch", (_event, ctx) => { revokeForSession("session-switch", ctx); });
  pi.on("session_before_fork", (_event, ctx) => { revokeForSession("session-fork", ctx); });
  // History navigation is not an authority to recover an earlier audit entry.
  pi.on("session_before_tree", (_event, ctx) => { revokeForSession("history-navigation", ctx); });
  pi.on("session_shutdown", () => {
    terminalDispose?.();
    terminalDispose = undefined;
    activeCtx = undefined;
    resetPlanAuto("shutdown");
  });
}
