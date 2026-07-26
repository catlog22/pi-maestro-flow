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
	ellipsis: string;
	separator: string;
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
	pending: "·",
	blocked: "!",
	barDone: "█",
	barActive: "▓",
	barPending: "░",
	arrow: "»",
	ellipsis: "…",
	separator: " · ",
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
	pending: ".",
	blocked: "!",
	barDone: "#",
	barActive: "+",
	barPending: "-",
	arrow: ">",
	ellipsis: "...",
	separator: " | ",
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
