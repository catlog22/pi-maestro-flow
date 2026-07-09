/**
 * Statusline constants — ANSI helpers, themes, icons.
 * Ported from maestro2/src/hooks/constants.ts for Pi Extension footer API.
 */

export type RGB = readonly [number, number, number];

export function ansiFg(rgb: RGB): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ICONS_NERD = {
	model: "", //  bolt
	runs: "\u{F044C}", // 󰑌 check circle
	dir: "", //  folder
	git: "", //  branch
	ctx: "", //  chart
	milestone: "", //  flag
	phase: "◆", // ◆ diamond
	tokens: "\u{F0868}", // 󰡨 counter
} as const;

const ICONS_UNICODE = {
	model: "✎", // ✎ pencil
	runs: "⚙", // ⚙ gear
	dir: "■", // ■ square
	git: "⎇", // ⎇ branch
	ctx: "◔", // ◔ circle
	milestone: "⚑", // ⚑ flag
	phase: "◆", // ◆ diamond
	tokens: "Σ", // Σ sigma
} as const;

const GIT_ICONS = {
	dirty: "△", // △
	conflict: "⚠", // ⚠
	ahead: "↑", // ↑
	behind: "↓", // ↓
} as const;

export { GIT_ICONS };

// Detect nerd font via env
const useNerd = process.env.MAESTRO_NERD_FONT === "1";
export const ICONS = useNerd ? ICONS_NERD : ICONS_UNICODE;

// ---------------------------------------------------------------------------
// Themes — text foreground colors on transparent background
// ---------------------------------------------------------------------------

interface ThemeColors {
	model: RGB;
	runs: RGB;
	dir: RGB;
	git: RGB;
	ctxOk: RGB;
	ctxWarn: RGB;
	ctxAlert: RGB;
	ctxCrit: RGB;
	milestone: RGB;
	phase: RGB;
	tokens: RGB;
	separator: RGB;
}

export const THEMES: Record<string, ThemeColors> = {
	notion: {
		model: [86, 182, 194],
		runs: [137, 180, 250],
		dir: [249, 226, 175],
		git: [166, 227, 161],
		ctxOk: [166, 227, 161],
		ctxWarn: [249, 226, 175],
		ctxAlert: [250, 179, 135],
		ctxCrit: [243, 139, 168],
		milestone: [224, 175, 104],
		phase: [166, 209, 137],
		tokens: [205, 214, 244],
		separator: [88, 91, 112],
	},
	cyberpunk: {
		model: [0, 255, 204],
		runs: [138, 43, 226],
		dir: [0, 200, 255],
		git: [57, 255, 20],
		ctxOk: [57, 255, 20],
		ctxWarn: [255, 204, 0],
		ctxAlert: [255, 140, 0],
		ctxCrit: [255, 50, 50],
		milestone: [255, 85, 85],
		phase: [255, 204, 0],
		tokens: [220, 220, 220],
		separator: [60, 60, 80],
	},
	nord: {
		model: [136, 192, 208],
		runs: [129, 161, 193],
		dir: [235, 203, 139],
		git: [163, 190, 140],
		ctxOk: [163, 190, 140],
		ctxWarn: [235, 203, 139],
		ctxAlert: [208, 135, 112],
		ctxCrit: [191, 97, 106],
		milestone: [208, 135, 112],
		phase: [163, 190, 140],
		tokens: [216, 222, 233],
		separator: [76, 86, 106],
	},
};

const themeName = process.env.MAESTRO_STATUSLINE_THEME ?? "notion";
export const COLORS: ThemeColors = THEMES[themeName] ?? THEMES.notion;

// ---------------------------------------------------------------------------
// Context level thresholds
// ---------------------------------------------------------------------------

export type CtxLevel = "ok" | "warn" | "alert" | "crit";

export function getCtxLevel(usedPct: number): CtxLevel {
	if (usedPct < 50) return "ok";
	if (usedPct < 65) return "warn";
	if (usedPct < 80) return "alert";
	return "crit";
}

export function getCtxColor(level: CtxLevel): RGB {
	switch (level) {
		case "ok":
			return COLORS.ctxOk;
		case "warn":
			return COLORS.ctxWarn;
		case "alert":
			return COLORS.ctxAlert;
		case "crit":
			return COLORS.ctxCrit;
	}
}
