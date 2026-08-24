/**
 * Extension-side wiring for the centralized diagnostic logger.
 *
 * Binds the logger's UI bridge to the live `ctx.ui` on every session_start so
 * the status-bar badge (`pi-teammate-diagnostic`) and one-shot error toasts
 * fire without each of the 67 call sites holding a UI reference. Also registers
 * the `/teammate-logs` slash command for acknowledging unread errors and
 * surfacing the log file path.
 *
 * Kept separate from `shared/diagnostic-log.ts` so the shared module stays a
 * pure, testable sink with no Pi-extension import surface.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DIAGNOSTIC_STATUS_KEY,
	getDiagnosticLogger,
	type DiagnosticUiBridge,
} from "../shared/diagnostic-log.ts";

/**
 * Bridge the live `ctx.ui` to the diagnostic logger. Call on `session_start`
 * (and any ctx refresh boundary). Safe to call repeatedly; the latest ctx
 * wins. When `ctx` is undefined the bridge is cleared (e.g. on shutdown).
 */
export function bindDiagnosticUi(ctx: ExtensionContext | undefined): void {
	const logger = getDiagnosticLogger();
	if (!ctx?.ui) {
		logger.setUiBridge(undefined);
		return;
	}
	const ui = ctx.ui;
	const bridge: DiagnosticUiBridge = {
		setStatus(text: string | undefined): void {
			try { ui.setStatus(DIAGNOSTIC_STATUS_KEY, text); } catch { /* cosmetic */ }
		},
		notify(message: string, type: "info" | "warning" | "error"): void {
			try { ui.notify(message, type); } catch { /* cosmetic */ }
		},
	};
	logger.setUiBridge(bridge);
}

/**
 * Register the `/teammate-logs` slash command.
 *
 * - `/teammate-logs`           — show summary + log file path
 * - `/teammate-logs ack`       — acknowledge unread errors (clears the badge)
 * - `/teammate-logs status`    — show current summary
 */
export function registerDiagnosticCommand(pi: ExtensionAPI): void {
	pi.registerCommand("teammate-logs", {
		description: "查看 pi-maestro-teammate 错误日志摘要、确认已读（清状态栏徽标），或定位日志文件路径",
		async handler(args, ctx) {
			const logger = getDiagnosticLogger();
			const action = args.trim().toLowerCase();
			const summary = logger.getSummary();

			if (action === "ack" || action === "acknowledge") {
				logger.acknowledge();
				ctx.ui.notify("已确认 pi-maestro-teammate 错误（状态栏徽标已清除）。", "info");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(describeSummary(summary), "info");
				return;
			}

			if (action !== "") {
				ctx.ui.notify("用法：/teammate-logs [ack|status]", "warning");
				return;
			}

			ctx.ui.notify(describeSummary(summary), "info");
		},
	});
}

function describeSummary(summary: {
	errorCount: number;
	warnCount: number;
	unreadErrors: number;
	lastErrorMessage: string | undefined;
}): string {
	const lines: string[] = [
		`pi-maestro-teammate 诊断：错误 ${summary.errorCount}（未读 ${summary.unreadErrors}）/ 警告 ${summary.warnCount}`,
	];
	if (summary.lastErrorMessage) {
		lines.push(`最近错误：${summary.lastErrorMessage}`);
	}
	lines.push("日志位置：~/.pi/teammate/logs/error-<date>.log");
	lines.push("确认已读：/teammate-logs ack");
	return lines.join("\n");
}
