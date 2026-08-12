import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ZenBrowseState } from "./zen-render.ts";

/**
 * Keyboard-focus (browse) mode for the Zen stack, entered via Alt+L when the
 * stack projection is active. Mirrors the sidebar focus hook: an explicit
 * terminal-input subscription that yields to capturing overlays and never
 * steals keys by default.
 *
 * Interaction axis (design: L2 in-place expansion):
 * - ↑↓ / j k   move the selection across browsable rows
 * - Enter      toggle the selected row's in-place detail expansion
 * - Esc        collapse the expansion first, then leave browse mode
 */
export interface ZenBrowseController {
	/** Enter browse mode; false when there is nothing to navigate. */
	begin(): boolean;
	end(): void;
	isActive(): boolean;
	/** Present only while browsing; feeds renderZenStack's `browse` input. */
	state(): ZenBrowseState | undefined;
	dispose(): void;
}

export interface ZenBrowseOptions {
	/** Browsable row ids in render order (enumerateZenNavRows). */
	getNavRows(): string[];
	subscribeInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
	requestRender(): void;
	/** Called after a second Enter drills from L2 into the selected entity. */
	onActivate?(id: string): void;
	/** True while a capturing overlay owns the keyboard; browse must yield. */
	shouldYield?(): boolean;
	onWarning?(message: string): void;
	/** Nothing-to-browse notice, resolved by the caller's i18n. */
	emptyNotice?(): string;
}

export function createZenBrowseController(options: ZenBrowseOptions): ZenBrowseController {
	let active = false;
	let selectedId: string | undefined;
	let expandedId: string | undefined;
	let unsubscribe: (() => void) | undefined;

	const navRows = (): string[] => {
		try {
			return options.getNavRows();
		} catch {
			return [];
		}
	};

	// Stable-id anchor: when the selected entity survives a store reorder the
	// selection follows it; when it disappears, snap to the nearest position.
	const move = (delta: number): void => {
		const rows = navRows();
		if (rows.length === 0) {
			selectedId = undefined;
			expandedId = undefined;
			return;
		}
		const current = selectedId ? rows.indexOf(selectedId) : -1;
		const next = current < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, current + delta));
		selectedId = rows[next];
		if (expandedId !== undefined && expandedId !== selectedId) expandedId = undefined;
		options.requestRender();
	};

	const end = (): void => {
		if (!active && !unsubscribe) return;
		active = false;
		selectedId = undefined;
		expandedId = undefined;
		const dispose = unsubscribe;
		unsubscribe = undefined;
		try {
			dispose?.();
		} catch {
			// unsubscribe failures must not break teardown
		}
		options.requestRender();
	};

	const handleInput = (data: string): { consume?: boolean } | undefined => {
		if (!active) return undefined;
		if (options.shouldYield?.()) return undefined;
		if (matchesKey(data, Key.escape)) {
			// First Esc closes the L2 expansion, second leaves browse mode: the
			// same "one level up" semantics as the unified overlay shell.
			if (expandedId !== undefined) {
				expandedId = undefined;
				options.requestRender();
			} else {
				end();
			}
			return { consume: true };
		}
		if (matchesKey(data, Key.up) || data === "k") {
			move(-1);
			return { consume: true };
		}
		if (matchesKey(data, Key.down) || data === "j") {
			move(1);
			return { consume: true };
		}
		if (matchesKey(data, Key.home)) {
			selectedId = navRows()[0];
			if (expandedId !== selectedId) expandedId = undefined;
			options.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, Key.end)) {
			selectedId = navRows().at(-1);
			if (expandedId !== selectedId) expandedId = undefined;
			options.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			if (selectedId !== undefined) {
				if (expandedId === selectedId && options.onActivate) {
					const activatedId = selectedId;
					end();
					options.onActivate(activatedId);
				} else {
					expandedId = selectedId;
					options.requestRender();
				}
			}
			return { consume: true };
		}
		return undefined;
	};

	return {
		begin(): boolean {
			if (active) return true;
			const rows = navRows();
			if (rows.length === 0) {
				const notice = options.emptyNotice?.();
				if (notice) options.onWarning?.(notice);
				return false;
			}
			active = true;
			selectedId = rows[0];
			expandedId = undefined;
			try {
				unsubscribe = options.subscribeInput(handleInput);
			} catch {
				active = false;
				selectedId = undefined;
				return false;
			}
			options.requestRender();
			return true;
		},
		end,
		isActive: () => active,
		state(): ZenBrowseState | undefined {
			if (!active) return undefined;
			// Reconcile against the live nav list so a vanished row cannot leave a
			// stale marker. An empty stack ends browse and releases its input hook.
			const rows = navRows();
			if (rows.length === 0) {
				end();
				return undefined;
			}
			if (selectedId !== undefined && !rows.includes(selectedId)) {
				selectedId = rows[0];
				expandedId = undefined;
			}
			return {
				...(selectedId !== undefined ? { selectedId } : {}),
				...(expandedId !== undefined ? { expandedId } : {}),
			};
		},
		dispose: end,
	};
}
