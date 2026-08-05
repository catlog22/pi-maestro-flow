// Thinking-fold control through pi's native app.thinking.toggle action.
//
// pi's extension API can rename the hidden-thinking label but cannot hide
// thinking blocks: the visibility flag (hideThinkingBlock) is private to
// interactive mode. The sanctioned reach point is the editor's actionHandlers
// map — pi's own setCustomEditorComponent copies it across the jiti module
// boundary with this same duck typing ("instanceof fails across jiti module
// boundaries"), and pasteToEditor injects synthetic editor input the same way.
//
// State ownership stays with pi: the toggle handler persists through pi's
// settingsManager, and Ctrl+T / /settings remain authoritative. cockpit reads
// pi's settings files only to decide whether a dispatch is needed, and never
// writes them.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const THINKING_TOGGLE_ACTION = "app.thinking.toggle";

function asChildren(value: unknown): Component[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const children = (value as { children?: unknown }).children;
	return Array.isArray(children) ? (children as Component[]) : undefined;
}

interface ThinkingToggleCacheEntry {
	toggle: () => void;
	path: Component[];
}

const thinkingToggleCache = new WeakMap<TUI, ThinkingToggleCacheEntry>();

function cachedThinkingToggle(tui: TUI): (() => void) | undefined {
	const cached = thinkingToggleCache.get(tui);
	if (!cached) return undefined;
	let children = asChildren(tui);
	for (const node of cached.path) {
		if (!children?.includes(node)) {
			thinkingToggleCache.delete(tui);
			return undefined;
		}
		children = asChildren(node);
	}
	const owner = cached.path.at(-1) as { actionHandlers?: unknown } | undefined;
	if (owner?.actionHandlers instanceof Map
		&& owner.actionHandlers.get(THINKING_TOGGLE_ACTION) === cached.toggle) {
		return cached.toggle;
	}
	thinkingToggleCache.delete(tui);
	return undefined;
}

/**
 * Find the handler pi wired for app.thinking.toggle on the editor. Cached
 * component paths are validated lazily; a detached editor or replaced handler
 * falls back to a fresh tree walk.
 */
export function findThinkingToggle(tui: TUI): (() => void) | undefined {
	const cached = cachedThinkingToggle(tui);
	if (cached) return cached;
	const stack = (asChildren(tui) ?? []).map((node) => ({ node, path: [node] }));
	const seen = new Set<Component>();
	while (stack.length > 0) {
		const { node, path } = stack.pop() as { node: Component; path: Component[] };
		if (seen.has(node)) continue;
		seen.add(node);
		const handlers = (node as { actionHandlers?: unknown }).actionHandlers;
		if (handlers instanceof Map) {
			const toggle = handlers.get(THINKING_TOGGLE_ACTION);
			if (typeof toggle === "function") {
				const entry = { toggle: toggle as () => void, path };
				thinkingToggleCache.set(tui, entry);
				return entry.toggle;
			}
		}
		const children = asChildren(node);
		if (children) {
			stack.push(...children.map((child) => ({ node: child, path: [...path, child] })));
		}
	}
	return undefined;
}

interface HideFlagCacheEntry {
	signature: string;
	value: boolean | undefined;
}

const hideFlagCache = new Map<string, HideFlagCacheEntry>();

function readHideFlag(path: string): boolean | undefined {
	try {
		const stat = statSync(path, { throwIfNoEntry: false });
		const signature = stat
			? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
			: "missing";
		const cached = hideFlagCache.get(path);
		if (cached?.signature === signature) return cached.value;
		let value: boolean | undefined;
		if (stat) {
			try {
				const parsed = JSON.parse(readFileSync(path, "utf-8")) as { hideThinkingBlock?: unknown };
				value = typeof parsed.hideThinkingBlock === "boolean" ? parsed.hideThinkingBlock : undefined;
			} catch {
				value = undefined;
			}
		}
		hideFlagCache.set(path, { signature, value });
		return value;
	} catch {
		return undefined;
	}
}

/**
 * Effective hideThinkingBlock the way pi merges it: project settings override
 * global, and a missing or unparseable flag defaults to false — the same
 * `?? false` settingsManager applies. (An untrusted project's override is not
 * visible here; pi ignores it at runtime. Such a project-level flag for this
 * key is a pathological case cockpit does not try to second-guess.)
 */
export function readHideThinkingBlock(cwd: string): boolean {
	const global = readHideFlag(join(getAgentDir(), "settings.json"));
	const project = readHideFlag(join(cwd, CONFIG_DIR_NAME, "settings.json"));
	return project ?? global ?? false;
}

/**
 * Bring pi's thinking visibility to the wanted state via the native toggle.
 * Reads first so the dispatch never flips the setting the wrong way; returns
 * true when the wanted state holds afterwards, false when the editor or its
 * action handler is unreachable (non-TUI mode, startup race, pi refactor).
 */
export function ensureThinkingFolded(tui: TUI | undefined, cwd: string, hidden: boolean): boolean {
	if (!tui) return false;
	const toggle = findThinkingToggle(tui);
	if (!toggle) return false;
	if (readHideThinkingBlock(cwd) !== hidden) toggle();
	return true;
}
