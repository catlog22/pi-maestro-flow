/**
 * Terminal capability detection for the fullscreen (alternate-screen) mode.
 *
 * This is deliberately conservative: fullscreen and copy-on-select require an
 * alternate screen and SGR mouse reporting. We can only reliably detect the
 * environments that are KNOWN to lack them (TERM=dumb or unset). Everything
 * else is best-effort — the feature arms and degrades gracefully if the
 * terminal does not behave, per the opt-in design.
 */

export interface TerminalCompatibility {
	compatible: boolean;
	reason?: string;
}

export function detectTerminalCompatibility(env: NodeJS.ProcessEnv = process.env): TerminalCompatibility {
	const term = env.TERM ?? "";
	if (term === "dumb" || term === "" || term === "unknown") {
		return {
			compatible: false,
			reason: `TERM is ${term || "unset"}; this terminal has no alternate-screen support`,
		};
	}
	return { compatible: true };
}
