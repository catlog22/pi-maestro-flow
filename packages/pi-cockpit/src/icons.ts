export type IconMode = "auto" | "nerd" | "ascii";

export interface IconGlyphs {
	spinFrames: string;
	dotRunning: string;
	dotIdle: string;
	check: string;
	cross: string;
	pending: string;
	blocked: string;
	barDone: string;
	barActive: string;
	barPending: string;
	arrow: string;
	/** Points at a dependency/upstream ("blocked by", "waits on"). */
	depArrow: string;
	/** Tree connectors. Routed through the glyph set so ascii mode stays ascii. */
	treeBranch: string;
	treeLast: string;
	treeVertical: string;
	treeSpace: string;
	ellipsis: string;
	separator: string;
	/** Overlay chrome. Kept in the glyph table so ascii mode draws a real ascii box. */
	box: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};
	/** Marks the focused row. Must survive without the selected background colour. */
	selectMarker: string;
	/** Marks an empty collection. */
	emptyMark: string;
	/** Vertical navigation affordance shown in help lines. */
	upDown: string;
	workspace: string;
	git: string;
	tokensIn: string;
	tokensOut: string;
	cost: string;
	cacheHit: string;
}

const NERD_GLYPHS: IconGlyphs = {
	spinFrames: "⠋⠙⠹⠴⠦⠇",
	dotRunning: "●",
	dotIdle: "·",
	check: "✓",
	cross: "✕",
	// A hollow ring, not the idle dot: "waiting to start" and "running but quiet"
	// are different states and must not share a glyph.
	pending: "○",
	blocked: "!",
	barDone: "█",
	barActive: "▓",
	barPending: "░",
	arrow: "»",
	depArrow: "←",
	treeBranch: "├─",
	treeLast: "└─",
	treeVertical: "│ ",
	treeSpace: "  ",
	ellipsis: "…",
	separator: " · ",
	box: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	selectMarker: "›",
	emptyMark: "○",
	upDown: "↑↓",
	workspace: "",
	git: "⎇",
	tokensIn: "↑",
	tokensOut: "↓",
	cost: "$",
	cacheHit: "⚡",
};

const ASCII_GLYPHS: IconGlyphs = {
	spinFrames: "|/-\\",
	dotRunning: "*",
	dotIdle: ".",
	check: "+",
	cross: "x",
	pending: "o",
	blocked: "!",
	barDone: "#",
	barActive: "+",
	barPending: "-",
	arrow: ">",
	depArrow: "<-",
	treeBranch: "|-",
	treeLast: "`-",
	treeVertical: "| ",
	treeSpace: "  ",
	ellipsis: "...",
	separator: " | ",
	box: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" },
	selectMarker: ">",
	emptyMark: "o",
	upDown: "up/dn",
	workspace: "dir",
	git: "*",
	tokensIn: "^",
	tokensOut: "v",
	cost: "$",
	cacheHit: "c",
};

const NERD_FONT_TERMINALS = new Set([
	"iTerm.app",
	"Ghostty",
	"WezTerm",
	"kitty",
	"rio",
	"tabby",
	"WindowsTerminal",
	"vscode",
]);

export function detectNerdFont(): boolean {
	const termProgram = process.env.TERM_PROGRAM;
	if (termProgram && NERD_FONT_TERMINALS.has(termProgram)) return true;
	const lcTerminal = process.env.LC_TERMINAL;
	if (lcTerminal && NERD_FONT_TERMINALS.has(lcTerminal)) return true;
	if (process.env.TERM === "xterm-kitty") return true;
	if (process.env.WT_SESSION) return true;
	return false;
}

export function resolveIconMode(mode: IconMode): "nerd" | "ascii" {
	if (mode === "nerd") return "nerd";
	if (mode === "ascii") return "ascii";
	return detectNerdFont() ? "nerd" : "ascii";
}

export function resolveGlyphs(mode: IconMode): IconGlyphs {
	return resolveIconMode(mode) === "nerd" ? NERD_GLYPHS : ASCII_GLYPHS;
}

/**
 * One source of truth for animation cadence.
 *
 * The frame clock and the redraw tick must be the same number. When frames
 * advanced every 120ms but the UI only repainted every 250ms, each repaint
 * skipped ~2 frames: the 6-frame braille spinner ran at half speed and the
 * 4-frame ASCII spinner degenerated into a two-glyph flip (| ↔ -), which reads
 * as blinking rather than rotation.
 */
export const ANIMATION_PERIOD_MS = 250;

/**
 * The frame to draw at `now`, or a stable glyph when nothing is driving redraws.
 *
 * A frozen mid-cycle spinner claims "busy" while the UI has actually stopped
 * repainting, so an idle surface gets a static marker instead.
 */
export function spinFrame(glyphs: IconGlyphs, now: number, animating = true): string {
	if (!animating) return glyphs.dotRunning;
	const frames = glyphs.spinFrames;
	return frames[Math.floor(now / ANIMATION_PERIOD_MS) % frames.length];
}
