import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsStore, type CompletePayload, type MessagePayload, type StartedPayload } from "./agents-store.ts";
import { statusText, titleFor, workingMessage, type AmbientState } from "./ambient.ts";
import { generateTitleWithModel } from "./title-llm.ts";
import { suggestTitle } from "./title-gen.ts";
import { BashBgStore } from "./bash-bg-store.ts";
import { SupervisionStore } from "./supervision-store.ts";
import { MaestroStore } from "./maestro-store.ts";
import { createSidebarController, type SidebarController } from "./sidebar-controller.ts";
import { COCKPIT_SPLIT_PANE_MARKER } from "./split-pane.ts";
import { attachViewportStability } from "./viewport-stability.ts";
import {
	COCKPIT_EDITOR_BOTTOM_MARKER,
	EDITOR_BOTTOM_WIDGET_KEY,
	createEditorBottomController,
	createEditorBottomSentinel,
	type EditorBottomController,
} from "./editor-bottom.ts";
import { BashBgOverlay } from "./bash-bg-overlay.ts";
import { renderBashBgSummary } from "./bash-bg-widget.ts";
import { registerQuietTools } from "./quiet-tools.ts";
import { registerGuardedEditTool } from "./edit-guard.ts";
import { ensureThinkingFolded, readHideThinkingBlock } from "./thinking-fold.ts";
import { ThinkingFoldTimer } from "./thinking-timer.ts";
import { shouldAnimateFrames, shouldAnimateSidebar, shouldRunTick, type TickPolicyState } from "./tick-policy.ts";
import { TodoStore } from "./todo-store.ts";
import { makeTodoWidget, makeAgentWidget, terminalRows, visibleAgentRows } from "./stack-widget.ts";
import { agentListWindowRows, scrollBy, type AgentScrollState } from "./agent-scroll.ts";
import { agentSessionColor, makeSessionBarWidget, SESSION_BAR_WIDGET_KEY, MAIN_SESSION_LABEL } from "./session-bar.ts";
import { makeSessionDetailWidget, SESSION_DETAIL_WIDGET_KEY, DEFAULT_SESSION_DETAIL_ROWS, sessionDetailBodyLength, sessionDetailWindowRows, type SessionDetailScrollState } from "./session-detail.ts";
import { panelRows } from "./viewport.ts";
import { routeAgentInput } from "./input-routing.ts";
import { activeThemeName, ThemePicker } from "./theme-picker.ts";
import { ModelPicker, type ModelPickerEntry } from "./model-picker.ts";
import { getUsageTotals, invalidateUsageCache, renderFooter, setUsageThrottle, type PaintTheme, type WidthUtils } from "./footer.ts";
import { collectExtensionStatuses } from "./extension-status.ts";
import { ANIMATION_PERIOD_MS, resolveGlyphs, spinFrame } from "./icons.ts";
import { ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { applyRow, buildRows, rowKeyForAccel, type SaveState } from "./settings-view.ts";
import { createCockpitSettingsProvider, registerCockpitSettingsProvider } from "./settings/cockpit-provider.ts";
import { SettingsLocaleState, getMaestroUiPreferencesPath } from "./settings/locale-state.ts";
import { SettingsProviderRegistry } from "./settings/registry.ts";
import { showMaestroSettingsShell } from "./settings/settings-shell.ts";
import {
	COCKPIT_INPUT_TARGET_EVENT,
	COCKPIT_MAESTRO_QUERY_EVENT,
	COCKPIT_PREEMPT_RESIZE_EVENT,
	COCKPIT_TODO_TOGGLE_EVENT,
	MAESTRO_UI_SNAPSHOT_EVENT,
	MAESTRO_UI_SNAPSHOT_VERSION,
	SUPERVISION_EVENT,
	type CockpitInputTargetV1,
	type CockpitUiOwnershipV1,
} from "./public/v1/events.ts";
import {
	AGENT_WIDGET_KEY,
	BASH_BG_QUERY_EVENT,
	BASH_BG_UPDATE_EVENT,
	COCKPIT_UI_OWNERSHIP_EVENT,
	DEFAULT_CONFIG,
	STACK_WIDGET_KEY,
	TEAMMATE_COMPLETE_EVENT,
	TEAMMATE_MESSAGE_EVENT,
	TEAMMATE_STARTED_EVENT,
	TODO_TOOL_NAME,
	WORKFLOW_STATUS_KEY,
	type AgentRow,
	type CockpitConfig,
} from "./types.ts";
import { MAILBOX_REGISTRY_KEY, type MailboxHostRegistry } from "pi-maestro-teammate/v1/mailbox";

const FOOTER_UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };
const BASH_BG_OVERLAY_KEY = "alt+j";
const SIDEBAR_RESIZE_KEY = "ctrl+shift+r";
const SIDEBAR_FOCUS_KEY = "alt+shift+l";
const SESSION_DETAIL_TOGGLE_KEY = "alt+shift+r";
const COCKPIT_STATUS_KEY = "cockpit";
// Claude Code title chrome: a static marker when idle, two braille frames while
// a turn runs (screens/REPL.tsx TITLE_STATIC_PREFIX / TITLE_ANIMATION_FRAMES).
const TITLE_STATIC = "✳";
const TITLE_FRAMES = ["⠂", "⠐"];
const WIDTH_POLL_INTERVAL_MS = 250;
// Static mode keeps token totals fresh enough without recomputing on every message.
const USAGE_REFRESH_THROTTLE_MS = 10_000;
// Quiet mode's rename of pi's hidden-thinking label. The live thinking timer
// derives its final "thoughts · 8.4s" labels from the same word.
const QUIET_THINKING_LABEL = "thoughts";

export type CockpitSurfaceState = "dock" | "widgets" | "disabled";

export function resolveCockpitSurfaceState(
	enabled: boolean,
	sidebarMode: CockpitConfig["sidebar"]["mode"],
	dockEffectiveVisible: boolean,
): CockpitSurfaceState {
	if (!enabled) return "disabled";
	return sidebarMode !== "off" && dockEffectiveVisible ? "dock" : "widgets";
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const insideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * Cheap synchronous git branch read straight from .git/HEAD — no process spawn,
 * so it is safe on every title refresh. Returns the branch name, "detached" for
 * a raw HEAD hash, or null outside a repo (including linked worktrees).
 */
function readGitBranch(cwd: string): string | null {
	let headPath: string | undefined;
	try {
		const gitDir = join(cwd, ".git");
		const st = statSync(gitDir);
		if (st.isDirectory()) {
			headPath = join(gitDir, "HEAD");
		} else if (st.isFile()) {
			const link = readFileSync(gitDir, "utf8").trim();
			if (link.startsWith("gitdir:")) {
				headPath = join(resolve(cwd, link.slice("gitdir:".length).trim()), "HEAD");
			}
		}
		if (!headPath) return null;
		const head = readFileSync(headPath, "utf8").trim();
		const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return branch ? branch[1] : "detached";
	} catch {
		return null;
	}
}

/** Session summary for the title: the session_info name, else the generated
 * title, else the short id — the Claude Code chain of sessionTitle ?? haikuTitle. */
function sessionTag(sm: { getSessionName(): string | undefined; getSessionId(): string }, generated: string | undefined): string | undefined {
	const name = sm.getSessionName();
	if (name) return name;
	if (generated) return generated;
	const id = sm.getSessionId();
	return id ? id.slice(0, 8) : undefined;
}

/** Active model short id (drops any "provider/" prefix). */
function modelTag(model: { id: string } | undefined): string | undefined {
	if (!model) return undefined;
	const last = model.id.split("/").at(-1);
	return last || undefined;
}

/** Thinking level tag; "off" and unknown values add no noise. */
function thinkingTag(level: string | undefined): string | undefined {
	return level === undefined || level === "off" ? undefined : level;
}

/** Maestro workflow tag: run status when a run is active, else session status. */
function maestroWorkflowTag(
	workflow: { run: { status: string } | null; session: { status: string } } | null | undefined,
): string | undefined {
	if (!workflow) return undefined;
	return workflow.run ? workflow.run.status : workflow.session.status;
}

/** Extract plain text from an agent message (string content or text blocks). */
function messageText(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (
			block && typeof block === "object"
			&& (block as { type?: unknown }).type === "text"
			&& typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStartedPayload(value: unknown): value is StartedPayload {
	return isRecord(value)
		&& typeof value.correlationId === "string"
		&& value.correlationId.length > 0
		&& typeof value.agent === "string";
}

function isProgressPayload(value: unknown): value is MessagePayload {
	return isRecord(value)
		&& value.isSend !== true
		&& value.isInteraction !== true
		&& typeof value.correlationId === "string"
		&& value.correlationId.length > 0;
}

function isCompletePayload(value: unknown): value is CompletePayload {
	return isRecord(value)
		&& typeof value.correlationId === "string"
		&& value.correlationId.length > 0
		&& typeof value.exitCode === "number"
		&& Number.isFinite(value.exitCode);
}

export default function (pi: ExtensionAPI): void {
	const agents = new AgentsStore();
	const bashBg = new BashBgStore();
	const todos = new TodoStore();
	const maestro = new MaestroStore();
	const supervision = new SupervisionStore();
	const settingsRegistry = new SettingsProviderRegistry({
		on: (event, handler) => pi.events.on(event, handler),
		emit: (event, payload) => pi.events.emit(event, payload),
	});
	// Registry and provider announcements are re-established at session_start and
	// torn down at session_shutdown (start/dispose are idempotent), so a host
	// reload cannot accumulate stale shared-bus listeners from old instances.
	let settingsProviderDisposer: (() => void) | undefined;
	const registerSettingsProvider = (): void => {
		if (settingsProviderDisposer) return;
		settingsProviderDisposer = registerCockpitSettingsProvider({
			on: (event, handler) => pi.events.on(event, handler),
			emit: (event, payload) => pi.events.emit(event, payload),
		}, cockpitSettingsProvider);
	};
	const settingsLocale = new SettingsLocaleState(getMaestroUiPreferencesPath(getAgentDir()), settingsRegistry);
	let config: CockpitConfig = structuredClone(DEFAULT_CONFIG);
	let lastCtx: ExtensionContext | undefined;
	let settingsCommandCtx: ExtensionCommandContext | undefined;
	let capturedTui: TUI | undefined;
	// TUI the unconditional viewport-stability hook is currently installed on.
	// Independent of the split-pane attach: the sidebar can be off while the
	// thinking label / teammate tree still stream above the visible viewport.
	let stabilityTui: TUI | undefined;
	// True while Cockpit owns a capturing overlay (bash jobs, theme picker,
	// settings panel). Split-pane resize must yield to the overlay's focus and
	// refuse to start while one is open; otherwise the resize listener — a
	// global terminal-input hook — swallows the overlay's first arrow/Enter/Esc.
	let capturingOverlayActive = false;
	// Finalizer for the currently open legacy settings overlay, so a session
	// boundary can tear it down even when the host hides it without calling
	// component.dispose() (MW-2).
	let activeSettingsOverlay: { finalize(): void } | undefined;
	let sidebarController: SidebarController | undefined;
	let editorBottomController: EditorBottomController | undefined;
	/** Disposer for the session-bar ←/→ navigation hook (per applyUi). */
	let sessionBarNavDisposer: (() => void) | undefined;
	/** Disposer for the selected-session Alt+Shift+↑/↓ scroll hook. */
	let sessionDetailScrollDisposer: (() => void) | undefined;
	/** Disposer for the agent-list Shift+↑/↓ scroll hook (per applyUi). */
	let agentScrollDisposer: (() => void) | undefined;
	/** Scroll window over the below-input agent roster (tail-following default). */
	let agentListScroll: AgentScrollState = { offset: 0, following: true };
	/** Explicit progressive-disclosure state for the selected agent session. */
	let sessionDetailVisible = true;
	let sessionDetailScroll: SessionDetailScrollState = { offset: 0, following: true };
	let lastPublishedInputTarget: string | undefined;
	let dockEffectiveVisible = false;
	let surfaceState: CockpitSurfaceState = "disabled";
	let running = false;
	let runningStartedAt: number | undefined;
	// Auto-generated session title from the first turn (the rule-based / LLM
	// stand-in for Claude Code's Haiku title). Cleared per session.
	let aiTitle: string | undefined;
	let firstUserText: string | undefined;
	let titleRequested = false;
	let titleFrameIndex = 0;
	// Session fence for async title generation: bumped on session start/shutdown
	// so a stale request can never write into a newer session (MW-3).
	let titleGeneration = 0;
	let titleAbort: AbortController | undefined;
	const activeTools = new Map<string, { name: string; startedAt: number }>();
	let tick: ReturnType<typeof setInterval> | undefined;
	// Persisted rather than toasted: a config that failed to load silently downgrades
	// the whole session to defaults, so it belongs in a slot that does not scroll away.
	let configProblem: string | undefined;
	let quietToolsRegistered = false;

	// Register quiet tools at extension load time, not just in session_start.
	// During /resume, pi renders history BEFORE emitting session_start
	// (rebindCurrentSession({ renderBeforeBind: true })), so tools registered
	// only in session_start miss the initial render pass and every historical
	// tool call gets the verbose default renderer.  registerTool() is valid
	// during extension load (loader.ts: "refresh is only needed post-bind"),
	// and the Extension.tools map is read by _refreshToolRegistry during
	// AgentSession construction — before renderInitialMessages runs.
	ensureConfigExists();
	config = loadConfig();
	// Guarded edit replaces the built-in edit (same name, same execution, plus a
	// UTF-8 gate): editing a non-UTF-8 file would otherwise corrupt its bytes.
	registerGuardedEditTool(pi);
	// Reads config live, so toggling static mode re-throttles without re-registering.
	setUsageThrottle(() => (config.staticMode ? USAGE_REFRESH_THROTTLE_MS : 0));
	if (config.quietMode) {
		registerQuietTools(pi, () => config);
		quietToolsRegistered = true;
	}

	// Live elapsed for folded thinking rows — no spinner, just a running timer
	// while the model thinks, then the settled duration. Pi owns the fold.
	const thinkingTimer = new ThinkingFoldTimer({
		getTui: () => capturedTui,
		requestRender: () => {
			try {
				capturedTui?.requestRender();
			} catch {
				// tui may be gone between sessions
			}
		},
		getBaseLabel: () => (config.quietMode ? QUIET_THINKING_LABEL : undefined),
		getGlyphs: () => resolveGlyphs(config.icons.mode),
		isThinkingHidden: () => (lastCtx ? readHideThinkingBlock(lastCtx.cwd) : false),
		isEnabled: () => config.enabled,
		isStatic: () => config.staticMode,
		setGlobalLabel: (label) => {
			const ctx = lastCtx;
			if (!ctx || !isTuiContext(ctx)) return;
			try {
				ctx.ui.setHiddenThinkingLabel(label);
			} catch {
				// non-TUI or mid-teardown
			}
		},
	});

	// The streaming line, the tab title and the footer status slot are all fed from
	// the same snapshots the widgets read, so they can never disagree with them.
	// Leading title glyph: spinner frames while a turn runs (advanced by the
	// tick), a static marker when idle; static mode freezes it. Failure keeps
	// its own ✗ and ignores the frame entirely.
	const titleFrame = (isRunning: boolean): string | undefined => {
		if (isRunning && !config.staticMode) {
			return TITLE_FRAMES[titleFrameIndex % TITLE_FRAMES.length];
		}
		return TITLE_STATIC;
	};
	const refreshAmbient = (): void => {
		const ctx = lastCtx;
		if (!ctx || !isTuiContext(ctx)) return;
		const g = resolveGlyphs(config.icons.mode);
		try {
			if (!config.enabled) {
				ctx.ui.setWorkingMessage(undefined);
				ctx.ui.setStatus(COCKPIT_STATUS_KEY, undefined);
				return;
			}
			const activeTool = [...activeTools.values()].at(-1);
			const title = config.title;
			const state: AmbientState = {
				todos: todos.snapshot(),
				agents: agents.snapshot(),
				jobs: bashBg.snapshot(),
				running,
				cwd: title.showCwd ? formatCwd(ctx.sessionManager.getCwd()) : undefined,
				activeTool: activeTool?.name,
				workingStartedAt: activeTool?.startedAt ?? runningStartedAt,
				hideLiveDuration: config.staticMode,
				separator: ` ${g.separator} `,
			};
			ctx.ui.setWorkingMessage(workingMessage(state));
			if (title.enabled) {
				state.session = title.showSession ? sessionTag(ctx.sessionManager, aiTitle) : undefined;
				state.model = title.showModel ? modelTag(ctx.model) : undefined;
				state.thinking = title.showThinking ? thinkingTag(ctx.thinkingLevel) : undefined;
				state.gitBranch = title.showGit ? (readGitBranch(ctx.cwd) ?? undefined) : undefined;
				state.maestro = title.showMaestro ? maestroWorkflowTag(maestro.snapshot()?.workflow) : undefined;
				state.frame = titleFrame(running);
				ctx.ui.setTitle(titleFor(state, { ok: g.check, fail: g.cross }, g.separator, { maxLength: title.maxLength }));
			}
			ctx.ui.setStatus(COCKPIT_STATUS_KEY, statusText(configProblem, g.blocked));
		} catch {
			// ambient surfaces are best-effort; never let them break a render
		}
	};

	// One microtask dirty latch: a burst of store events in the same tick (a
	// message with many progress rows, a snapshot, a todo hydrate) coalesces into
	// a single ambient refresh and a single render request per host surface (SB-6).
	let renderScheduled = false;
	const req = (): void => {
		if (renderScheduled) return;
		renderScheduled = true;
		queueMicrotask(() => {
			renderScheduled = false;
			publishInputTarget();
			refreshAmbient();
			try {
				capturedTui?.requestRender();
				sidebarController?.requestRender();
			} catch {
				// tui may be gone between sessions
			}
		});
	};
	const policy = (): TickPolicyState => ({
		staticMode: config.staticMode,
		running,
		agentActive: agents.hasActive(),
		bashActive: bashBg.hasActive(),
		lingering: agents.hasLingering(),
		ticking: tick !== undefined,
	});
	// True only while a redraw loop is actually running; widgets use it to avoid
	// painting a frozen spinner frame that reads as a hung UI.
	const isAnimating = (): boolean => shouldAnimateFrames(policy());
	// A failed agent lingers for a while after it completes, and the loop has to
	// outlive the session that produced it — otherwise the row would sit there
	// until some unrelated event happened to expire it. Static mode still keeps
	// that loop alive: failure retention is correctness, not animation. What it
	// drops is the running/job churn that used to repaint every quarter second.
	const needsTick = (): boolean => shouldRunTick(policy());
	const startTick = (): void => {
		if (tick) return;
		tick = setInterval(() => {
			if (needsTick()) {
				// Static mode keeps the loop alive only so lingering rows can expire
				// (prune is read-driven). The rows themselves are static, so skip the
				// full repaint and repaint just once when a prune removed something.
				if (config.staticMode) {
					const before = agents.size;
					agents.snapshot();
					if (agents.size !== before) req();
				} else {
					titleFrameIndex += 1;
					req();
				}
			} else {
				syncTick();
			}
		}, ANIMATION_PERIOD_MS);
		tick.unref?.();
	};
	const syncTick = (): void => {
		if (needsTick()) startTick();
		else stopTick();
	};
	const stopTick = (): void => {
		if (tick) {
			clearInterval(tick);
			tick = undefined;
		}
	};
	const emitMaestroQuery = (): void => {
		pi.events.emit(COCKPIT_MAESTRO_QUERY_EVENT, { version: MAESTRO_UI_SNAPSHOT_VERSION });
	};
	const publishUiOwnership = (): void => {
		const ownsDock = surfaceState === "dock";
		const ownership: CockpitUiOwnershipV1 = {
			todo: config.enabled,
			agents: config.enabled && config.hideNativeAgents,
			footer: config.enabled,
			sidebar: ownsDock,
			goal: ownsDock,
			todoExpanded: config.todoExpanded,
			quiet: config.enabled && config.quietMode,
			quietSymbols: config.quietSymbols,
			static: config.staticMode,
		};
		pi.events.emit(COCKPIT_UI_OWNERSHIP_EVENT, ownership);
	};
	const setTodoExpanded = (expanded: boolean): void => {
		if (config.todoExpanded === expanded) return;
		config = { ...config, todoExpanded: expanded };
		saveConfig(config);
		publishUiOwnership();
		req();
	};

	// Quiet mode live toggle: widgets and footer read config on every render so
	// they switch immediately. Tool rendering is a one-way latch (registerTool
	// cannot be undone), so turning ON registers immediately but turning OFF
	// requires /reload to restore the default tool shells.
	const applyQuietMode = (ctx: ExtensionContext, was: boolean, now: boolean): void => {
		// Broadcast so cross-extension surfaces (e.g. pi-maestro-flow's todo tool
		// rendering) can follow quiet mode regardless of which path toggled it.
		publishUiOwnership();
		if (now && !was) {
			if (!quietToolsRegistered) {
				registerQuietTools(pi, () => config);
				quietToolsRegistered = true;
			}
			try {
				ctx.ui.setHiddenThinkingLabel(QUIET_THINKING_LABEL);
			} catch { /* non-TUI */ }
			// The label only renames an already-hidden block; the fold itself
			// rides pi's native toggle, which also persists it. Report what
			// actually happened instead of promising a fold we could not reach.
			const folded = ensureThinkingFolded(capturedTui, ctx.cwd, true);
			ctx.ui.notify(
				folded
					? "quiet mode on — tools compressed, thinking folded"
					: "quiet mode on — tools compressed",
				"info",
			);
		} else if (!now && was) {
			try {
				ctx.ui.setHiddenThinkingLabel(undefined);
			} catch { /* non-TUI */ }
			ctx.ui.notify(
				quietToolsRegistered
					? "quiet mode off — /reload to restore default tool rendering"
					: "quiet mode off",
				"info",
			);
		}
	};


	const ensureViewportStability = (tui: TUI): void => {
		if (stabilityTui === tui) return;
		stabilityTui = tui;
		attachViewportStability(tui);
	};

	const clearWidgets = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget(STACK_WIDGET_KEY, undefined);
		ctx.ui.setWidget(AGENT_WIDGET_KEY, undefined);
	};

	const selectedAgentTarget = (): { row: AgentRow; label: string; color: ThemeColor } | undefined => {
		const viewingId = agents.getViewingAgent();
		if (!viewingId) return undefined;
		const row = visibleAgentRows(agents.snapshot()).find((candidate) => candidate.correlationId === viewingId);
		if (!row) return undefined;
		return {
			row,
			label: row.name || row.role || row.agent || "agent",
			color: agentSessionColor(row),
		};
	};

	const publishInputTarget = (force = false): void => {
		const target = selectedAgentTarget();
		const fingerprint = target ? `${target.row.correlationId}:${target.label}:${target.color}` : "@main";
		if (!force && fingerprint === lastPublishedInputTarget) return;
		lastPublishedInputTarget = fingerprint;
		const payload: CockpitInputTargetV1 = target
			? { version: 1, label: target.label, color: target.color }
			: { version: 1 };
		pi.events.emit(COCKPIT_INPUT_TARGET_EVENT, payload);
	};

	/** Live state for the session bar's right-edge session indicator. */
	const inputStatusState = (): { label: string; color: ThemeColor } => {
		const target = selectedAgentTarget();
		if (target) return { label: target.label, color: target.color };
		return { label: MAIN_SESSION_LABEL, color: running ? "warning" : "muted" };
	};

	const ensureEditorBottomController = (ctx: ExtensionContext): EditorBottomController => {
		if (editorBottomController) return editorBottomController;
		editorBottomController = createEditorBottomController({
			onError: (error) => ctx.ui.notify(
				`Bottom-pinned input disabled: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			),
		});
		return editorBottomController;
	};

	const installEditorBottom = (ctx: ExtensionContext): void => {
		const controller = ensureEditorBottomController(ctx);
		ctx.ui.setWidget(
			EDITOR_BOTTOM_WIDGET_KEY,
			(tui) => {
				capturedTui = tui;
				ensureViewportStability(tui);
				controller.attach(tui);
				controller.show();
				return createEditorBottomSentinel();
			},
			{ placement: "aboveEditor" },
		);
	};

	const clearEditorBottom = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget(EDITOR_BOTTOM_WIDGET_KEY, undefined);
		editorBottomController?.hide();
	};

	const installSessionBar = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget(
			SESSION_BAR_WIDGET_KEY,
			(tui, theme) => {
				capturedTui = tui;
				ensureViewportStability(tui);
				return makeSessionBarWidget({
					getAgents: () => agents.snapshot(),
					isMainRunning: () => running,
					getCurrentSession: inputStatusState,
				})(tui, theme);
			},
			{ placement: "aboveEditor" },
		);
	};

	const installWidgets = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget(
			STACK_WIDGET_KEY,
			(tui, theme) => {
				capturedTui = tui;
				ensureViewportStability(tui);
				return makeTodoWidget({
					getTodos: () => todos.snapshot(),
					getConfig: () => config,
					isAnimating,
				})(tui, theme);
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setWidget(
			AGENT_WIDGET_KEY,
			(tui, theme) => {
				capturedTui = tui;
				ensureViewportStability(tui);
				return makeAgentWidget({
					getAgents: () => agents.snapshot(),
					getConfig: () => config,
					isRunning: () => running,
					isAnimating,
					getScroll: () => agentListScroll,
					setScroll: (next) => {
						agentListScroll = next;
						req();
					},
				})(tui, theme);
			},
			{ placement: "belowEditor" },
		);
	};

	const reconcileSurface = (ctx: ExtensionContext): void => {
		const next = resolveCockpitSurfaceState(config.enabled, config.sidebar.mode, dockEffectiveVisible);
		if (next === surfaceState) return;
		if (next === "dock" || next === "disabled") clearWidgets(ctx);
		else {
			installWidgets(ctx);
			// Host widget maps preserve insertion order when an existing key is set.
			// Todo was just re-added after a dock period, so remove/re-add the bar to
			// keep the invariant: detail → Todo → session bar → editor.
			ctx.ui.setWidget(SESSION_BAR_WIDGET_KEY, undefined);
			installSessionBar(ctx);
		}
		surfaceState = next;
		publishUiOwnership();
		req();
	};

	const ensureSidebarController = (ctx: ExtensionContext): SidebarController => {
		if (sidebarController) return sidebarController;
		sidebarController = createSidebarController({
			ctx,
			getMaestroSnapshot: () => maestro.snapshot(),
			getTodos: () => todos.snapshot(),
			getAgents: () => agents.snapshot(),
			getJobs: () => bashBg.snapshot(),
			getConfig: () => config,
			getHeight: () => capturedTui?.terminal.rows ?? 12,
			shouldAnimate: () => shouldAnimateSidebar(policy()),
			onVisibilityChange: (visible) => {
				dockEffectiveVisible = visible;
				const activeCtx = lastCtx;
				if (visible) emitMaestroQuery();
				if (activeCtx && isTuiContext(activeCtx)) reconcileSurface(activeCtx);
			},
			onResizeCommit: (width) => {
				config = { ...config, sidebar: { ...config.sidebar, width } };
				const result = saveConfig(config);
				if (!result.ok) {
					configProblem = `sidebar width save failed: ${result.error ?? "unknown error"}`;
					ctx.ui.notify(`Cockpit sidebar width kept for this session; save failed: ${result.error ?? "unknown error"}`, "warning");
				} else if (configProblem?.startsWith("sidebar width save failed:")) {
					configProblem = undefined;
				}
				req();
			},
			onWarning: (message) => ctx.ui.notify(message, "warning"),
			onError: (error) => {
				ctx.ui.notify(`Cockpit sidebar unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			},
			onActivateRow: (id) => {
				// Enter on an agent row selects it as the shown session (toggle).
				// The cockpit session bar mirrors the highlight; nothing is written
				// into the main conversation, so the main agent keeps working.
				if (!id.startsWith("agent:")) return;
				const cid = id.slice("agent:".length);
				agents.setViewingAgent(agents.getViewingAgent() === cid ? undefined : cid);
				sessionDetailScroll = { offset: 0, following: true };
				req();
			},
			getNavWidth: () => capturedTui?.terminal.columns ?? 80,
		});
		return sidebarController;
	};

	const syncSidebarMode = (ctx: ExtensionContext): void => {
		const controller = ensureSidebarController(ctx);
		controller.setWidth(config.sidebar.width);
		if (config.sidebar.mode === "off") {
			dockEffectiveVisible = false;
			controller.hide();
		} else {
			controller.show();
		}
		reconcileSurface(ctx);
	};

	const disposeLayoutControllers = (): void => {
		const render = capturedTui?.render as (TUI["render"] & Record<symbol, unknown>) | undefined;
		const editorBottomIsTop = Boolean(render?.[COCKPIT_EDITOR_BOTTOM_MARKER]);
		const splitPaneIsTop = Boolean(render?.[COCKPIT_SPLIT_PANE_MARKER]);
		if (editorBottomIsTop && !splitPaneIsTop) {
			editorBottomController?.dispose();
			sidebarController?.dispose();
		} else {
			sidebarController?.dispose();
			editorBottomController?.dispose();
		}
		sidebarController = undefined;
		editorBottomController = undefined;
	};

	const uninstallUi = (ctx: ExtensionContext): void => {
		dockEffectiveVisible = false;
		clearEditorBottom(ctx);
		disposeLayoutControllers();
		clearWidgets(ctx);
		ctx.ui.setWidget(SESSION_BAR_WIDGET_KEY, undefined);
		ctx.ui.setWidget(SESSION_DETAIL_WIDGET_KEY, undefined);
		sessionBarNavDisposer?.();
		sessionBarNavDisposer = undefined;
		sessionDetailScrollDisposer?.();
		sessionDetailScrollDisposer = undefined;
		agentScrollDisposer?.();
		agentScrollDisposer = undefined;
		ctx.ui.setFooter(undefined);
		surfaceState = "disabled";
		try {
			// Leaving these set would strand a title and a status line owned by an
			// extension that is no longer painting anything.
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setWorkingIndicator();
			ctx.ui.setStatus(COCKPIT_STATUS_KEY, undefined);
		} catch {
			// ambient surfaces are best-effort
		}
		stopTick();
		lastPublishedInputTarget = "@main";
		pi.events.emit(COCKPIT_INPUT_TARGET_EVENT, { version: 1 } satisfies CockpitInputTargetV1);
		capturedTui = undefined;
	};

	const applyUi = (ctx: ExtensionContext): void => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		ctx.ui.setWorkingIndicator({ frames: [] });
		if (config.pinEditorBottom) installEditorBottom(ctx);
		else clearEditorBottom(ctx);
		ctx.ui.setFooter((tui, theme, footerData) => {
			capturedTui = tui;
			ensureViewportStability(tui);
			let observedWidth = tui.terminal.columns;
			const widthTimer = setInterval(() => {
				try {
					const nextWidth = tui.terminal.columns;
					if (!Number.isFinite(nextWidth) || nextWidth <= 0 || nextWidth === observedWidth) return;
					observedWidth = nextWidth;
					// Deliberately skip tui.invalidate(): upstream pi 0.83.0 has a bug
					// where ToolExecutionComponent.updateDisplay() can push undefined
					// into Container.children (renderer returns undefined for a
					// "working" tool).  Container.invalidate() then does
					// `child.invalidate?.()` on that undefined child → TypeError →
					// uncaughtException in this timer callback → pi process exit.
					// requestRender(true) already clears previousLines and forces a
					// full re-render with the new width, which is all we need here.
					tui.requestRender(true);
				} catch {
					// Last-resort guard: a synchronous exception in this timer
					// callback would become an uncaughtException and kill the pi
					// process.  Swallow it so the session survives; the next tick
					// will retry.
				}
			}, WIDTH_POLL_INTERVAL_MS);
			widthTimer.unref?.();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			const component = {
				render(width: number): string[] {
					if (Number.isFinite(width) && width > 0) observedWidth = width;
					const cu = ctx.getContextUsage();
					const branch = footerData.getGitBranch();
					const extensionStatuses = collectExtensionStatuses(footerData.getExtensionStatuses());
					const glyphs = resolveGlyphs(config.icons.mode);
					const now = Date.now();
					const bashBgStatus = renderBashBgSummary(
						bashBg.snapshot(),
						width,
						theme,
						FOOTER_UTILS,
						{
							glyphs,
							spin: spinFrame(glyphs, now, isAnimating()),
							now,
							hideLiveDuration: config.staticMode,
						},
					)[0];
					return renderFooter({
						width,
						model: ctx.model?.id ?? "no-model",
						provider: ctx.model?.provider,
						thinking: pi.getThinkingLevel(),
						cwd: formatCwd(ctx.sessionManager.getCwd()),
						ctxPct: cu?.percent ?? 0,
						ctxTokens: cu?.tokens ?? 0,
						ctxWindow: cu?.contextWindow ?? ctx.model?.contextWindow ?? 0,
						totals: getUsageTotals(ctx.sessionManager.getEntries()),
						git: branch ?? undefined,
						bashBgStatus,
						workflowStatus: extensionStatuses.find((status) => status.key === WORKFLOW_STATUS_KEY)?.text,
						extensionStatuses: extensionStatuses.filter((status) => status.key !== WORKFLOW_STATUS_KEY),
						glyphs,
						theme,
						utils: FOOTER_UTILS,
					});
				},
				invalidate(): void {},
				dispose(): void {
					clearInterval(widthTimer);
					unsubscribeBranch();
				},
			};
			return component;
		});
		// Install first in aboveEditor order so this fixed session region sits
		// above Todo; Todo and the session bar are mounted closer to the editor.
		ctx.ui.setWidget(
			SESSION_DETAIL_WIDGET_KEY,
			(tui, theme) => {
				capturedTui = tui;
				ensureViewportStability(tui);
				return makeSessionDetailWidget({
					getAgents: () => agents.snapshot(),
					getViewingId: () => agents.getViewingAgent(),
					getVisible: () => sessionDetailVisible,
					getQuietMode: () => config.quietMode,
					getScroll: () => sessionDetailScroll,
				})(tui, theme);
			},
			{ placement: "aboveEditor" },
		);
		syncSidebarMode(ctx);
		// Re-enabling mid-run must restart live spinner and elapsed updates.
		syncTick();

		// Session bar: the session switcher pinned directly above the input box.
		// One line — color-coded chips (@main + every agent) on the left, the
		// currently shown session's status (● @session, the input box's top-right
		// corner) at the right edge. Installed on every surface (dock and
		// widgets), inserted last so it sits closest to the editor.
		installSessionBar(ctx);
		// ←/→ (empty composer) cycles the session bar through [main, ...agents]
		// and selects the highlighted session. While composing, the arrows keep
		// moving the text cursor.
		sessionBarNavDisposer?.();
		sessionBarNavDisposer = ctx.ui.onTerminalInput((data) => {
			if (data !== "\x1b[D" && data !== "\x1b[C") return undefined;
			const text = ctx.ui.getEditorText();
			if (text.trim() !== "") return undefined;
			const roster = visibleAgentRows(agents.snapshot());
			const viewingId = agents.getViewingAgent();
			const delta = data === "\x1b[C" ? 1 : -1;
			const total = roster.length + 1; // [main, ...agents]
			const current = viewingId
				? Math.max(0, roster.findIndex((row) => row.correlationId === viewingId)) + 1
				: 0;
			const next = (current + delta + total) % total;
			agents.setViewingAgent(next === 0 ? undefined : roster[next - 1].correlationId);
			sessionDetailScroll = { offset: 0, following: true };
			req();
			return { consume: true };
		});
		// Alt+Shift+↑/↓ scroll the selected agent's fixed session content.
		// Scrolling down to the bottom resumes automatic following as output grows.
		const detailUp = "\x1b[1;4A";
		const detailDown = "\x1b[1;4B";
		const legacyDetailUp = "\x1b\x1b[1;2A";
		const legacyDetailDown = "\x1b\x1b[1;2B";
		sessionDetailScrollDisposer?.();
		sessionDetailScrollDisposer = ctx.ui.onTerminalInput((data) => {
			const up = data === detailUp || data === legacyDetailUp;
			const down = data === detailDown || data === legacyDetailDown;
			if (!up && !down) return undefined;
			const viewingId = agents.getViewingAgent();
			if (!sessionDetailVisible || !viewingId) return undefined;
			const width = capturedTui?.terminal?.columns ?? 80;
			const rows = capturedTui?.terminal?.rows;
			const total = sessionDetailBodyLength(agents.snapshot(), viewingId, width, config.quietMode);
			const maxRows = panelRows(rows) ?? DEFAULT_SESSION_DETAIL_ROWS;
			const budget = sessionDetailWindowRows(total, maxRows);
			const next = scrollBy(sessionDetailScroll, up ? -1 : 1, total, Math.max(1, budget));
			if (next.offset !== sessionDetailScroll.offset || next.following !== sessionDetailScroll.following) {
				sessionDetailScroll = next;
				req();
			}
			return { consume: true };
		});
		// Shift+↑/↓ scroll the below-input agent roster (plain ↑/↓ stay with the
		// composer's input-history navigation). Scrolling up pauses the tail
		// follow; reaching the bottom resumes it.
		agentScrollDisposer?.();
		agentScrollDisposer = ctx.ui.onTerminalInput((data) => {
			if (data !== "\x1b[1;2A" && data !== "\x1b[1;2B") return undefined;
			const roster = visibleAgentRows(agents.snapshot());
			const budget = agentListWindowRows(capturedTui?.terminal?.columns, capturedTui?.terminal?.rows, roster.length);
			const next = scrollBy(agentListScroll, data === "\x1b[1;2A" ? -1 : 1, roster.length, budget);
			if (next.offset !== agentListScroll.offset || next.following !== agentListScroll.following) {
				agentListScroll = next;
				req();
			}
			return { consume: true };
		});
	};

	// --- teammate lifecycle (custom event bus; subscribed once for the extension lifetime) ---
	// Session-title generation: after the first turn settles, ask the configured
	// model (api-manager provider) with the user message + assistant reply, else
	// fall back to the offline rule-based suggestTitle. A model ref that cannot
	// be resolved or fails is never fatal — the title just stays rule-based.
	const generateTitleWithConfiguredModel = async (
		ctx: ExtensionContext,
		modelRef: string,
		text: string,
		signal: AbortSignal,
	): Promise<string | null> => {
		const slash = modelRef.indexOf("/");
		if (slash <= 0 || slash === modelRef.length - 1) return null;
		const model = ctx.modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
		if (!model) return null;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return null;
		return generateTitleWithModel(
			{ baseUrl: model.baseUrl, modelId: model.id, apiKey: auth.apiKey, headers: auth.headers },
			text,
			signal,
		);
	};
	const generateSessionTitle = async (
		ctx: ExtensionContext,
		userText: string,
		assistantMessage: unknown,
		refresh: () => void,
	): Promise<void> => {
		const generation = titleGeneration;
		const fallback = suggestTitle(userText);
		const assistantText = messageText(assistantMessage);
		const llmInput = assistantText
			? `${userText}\n\nAssistant:\n${assistantText.slice(0, 500)}`
			: userText;
		const modelRef = config.title.generationModel;
		const controller = new AbortController();
		titleAbort = controller;
		const timer = setTimeout(() => controller.abort(), 10_000);
		let title: string | null = null;
		try {
			title = modelRef
				? await generateTitleWithConfiguredModel(ctx, modelRef, llmInput, controller.signal)
				: null;
		} catch {
			// Model failures degrade to the rule fallback; never reject the
			// fire-and-forget caller.
			title = null;
		} finally {
			clearTimeout(timer);
			if (titleAbort === controller) titleAbort = undefined;
		}
		// A session boundary while the request was in flight must discard the
		// result: the title slot now belongs to the newer session (MW-3).
		if (generation !== titleGeneration || lastCtx !== ctx) return;
		if (title) {
			aiTitle = title;
		} else if (fallback) {
			aiTitle = fallback;
		} else {
			titleRequested = false; // nothing usable; a later turn may retry
			return;
		}
		refresh();
	};

	// Shared-bus subscriptions are session-scoped so a host /reload does not
	// accumulate a second generation of listeners on the same bus: the old
	// extension instance's disposers run at session_shutdown and session_start
	// re-registers them. pi.on(...) handlers are extension-owned by the loader
	// and need no manual cleanup.
	const busDisposers: Array<() => void> = [];
	const subscribeBusEvents = (): void => {
		if (busDisposers.length > 0) return;
		busDisposers.push(
			pi.events.on(TEAMMATE_STARTED_EVENT, (payload) => {
				if (!isStartedPayload(payload)) return;
				agents.applyStarted(payload);
				// A background agent needs the loop to keep its elapsed/stall repaints
				// alive even after the foreground turn ended (SB-4).
				syncTick();
				req();
			}),
			pi.events.on(TEAMMATE_MESSAGE_EVENT, (payload) => {
				if (!isProgressPayload(payload)) return;
				agents.applyMessage(payload);
				syncTick();
				req();
			}),
			pi.events.on(TEAMMATE_COMPLETE_EVENT, (payload) => {
				if (!isCompletePayload(payload)) return;
				agents.applyComplete(payload);
				// A failure that arrives after the session went idle still needs a loop to
				// expire it, so the tick is re-evaluated rather than assumed to be running.
				syncTick();
				req();
			}),
			pi.events.on(BASH_BG_UPDATE_EVENT, (payload) => {
				if (!bashBg.applySnapshot(payload)) return;
				syncTick();
				req();
			}),
			pi.events.on(MAESTRO_UI_SNAPSHOT_EVENT, (payload) => {
				if (!maestro.applySnapshot(payload)) return;
				req();
			}),
			pi.events.on(SUPERVISION_EVENT, (payload) => {
				if (!supervision.applyEvent(payload)) return;
				req();
			}),
			pi.events.on(COCKPIT_TODO_TOGGLE_EVENT, (payload) => {
				if (!config.enabled) return;
				const requested = payload && typeof payload === "object"
					? (payload as { expanded?: unknown }).expanded
					: undefined;
				setTodoExpanded(typeof requested === "boolean" ? requested : !config.todoExpanded);
			}),
			pi.events.on(COCKPIT_PREEMPT_RESIZE_EVENT, () => {
				// A capturing overlay opened by another extension (teammate attach,
				// control center, model mapping) must preempt an active sidebar resize
				// or browse mode: both are global terminal-input hooks that would
				// otherwise swallow the overlay's first arrow/Enter/Esc.
				try {
					sidebarController?.cancelResize();
					sidebarController?.endFocus();
			} catch {
				// best effort
			}
			}),
		);
	};
	const unsubscribeBusEvents = (): void => {
		for (const off of busDisposers) {
			try {
				off();
			} catch {
				// best effort
			}
		}
		busDisposers.length = 0;
	};

	// --- foreground tool label + todo changes ---
	pi.on("tool_execution_start", (e) => {
		activeTools.set(e.toolCallId, { name: e.toolName, startedAt: Date.now() });
		req();
	});
	pi.on("tool_execution_end", (e, ctx) => {
		activeTools.delete(e.toolCallId);
		if (e.toolName === TODO_TOOL_NAME) {
			todos.hydrateFromEntries(ctx.sessionManager.getEntries());
		}
		req();
	});

	// --- session + agent lifecycle ---
	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx;
		lastPublishedInputTarget = undefined;
		subscribeBusEvents();
		settingsRegistry.start();
		registerSettingsProvider();
		configProblem = undefined;
		activeTools.clear();
		thinkingTimer.reset();
		maestro.clear();
		aiTitle = undefined;
		firstUserText = undefined;
		titleRequested = false;
		titleFrameIndex = 0;
		titleGeneration += 1;
		ensureConfigExists();
		config = loadConfig((m, l) => {
			try {
				ctx.ui.notify(m, l);
			} catch {
				// notify unavailable
			}
		});
		settingsLocale.reload();
		settingsRegistry.emitLocale(settingsLocale.locale);
		invalidateUsageCache();
		// Quiet mode: register compact tool renderers and fold thinking blocks.
		// Tools are normally registered at extension load time (above) so they
		// are available before pi renders resumed history.  This session_start
		// path is a fallback for the rare case where the early config load
		// returned defaults but the persisted config enables quiet mode.
		if (config.quietMode && !quietToolsRegistered) {
			registerQuietTools(pi, () => config);
			quietToolsRegistered = true;
		}
		if (config.quietMode) {
			try {
				ctx.ui.setHiddenThinkingLabel(QUIET_THINKING_LABEL);
			} catch {
				// non-TUI mode
			}
		}
		// The theme is deliberately NOT re-applied here. ctx.ui.setTheme writes
		// through to pi's own settings, so pi already restores the user's choice on
		// its own. Replaying cockpit's copy would overwrite whatever the user set
		// through /settings since — including an automatic "light/dark" pair, which
		// cockpit cannot represent and would silently flatten to a single theme.
		todos.hydrateFromEntries(ctx.sessionManager.getEntries());
		if (config.enabled) {
			publishUiOwnership();
			applyUi(ctx);
		} else {
			applyUi(ctx);
			publishUiOwnership();
		}
		// applyUi captured the TUI synchronously, so the native toggle is
		// reachable already; a no-op when cockpit is disabled or non-TUI.
		if (config.quietMode) ensureThinkingFolded(capturedTui, ctx.cwd, true);
		pi.events.emit(BASH_BG_QUERY_EVENT, undefined);
		emitMaestroQuery();
		req();
	});

	pi.on("session_shutdown", (e, ctx) => {
		// Claude Code clears the terminal title on exit (CLEAR_TERMINAL_TITLE) so
		// the tab does not keep a stale title after the process dies. Only on
		// quit: reload/new/resume/fork are immediately followed by a new session
		// that sets its own title, and clearing would flash the tab.
		if (e.reason === "quit" && lastCtx && isTuiContext(lastCtx) && config.title.enabled) {
			try {
				lastCtx.ui.setTitle("");
			} catch {
				// mid-teardown: best-effort
			}
		}
		if (lastCtx) uninstallUi(lastCtx);
		// A session boundary must tear down an overlay the host hid without
		// dispose (theme revert, deferred enable, promise settle) (MW-2).
		try {
			activeSettingsOverlay?.finalize();
		} catch {
			// best effort
		}
		activeSettingsOverlay = undefined;
		const released: CockpitUiOwnershipV1 = {
			todo: false,
			agents: false,
			footer: false,
			sidebar: false,
			goal: false,
			todoExpanded: config.todoExpanded,
			quiet: false,
			quietSymbols: config.quietSymbols,
			static: config.staticMode,
		};
		// A session boundary must invalidate any in-flight title request: abort it
		// and bump the generation so its result is discarded (MW-3).
		titleAbort?.abort();
		titleAbort = undefined;
		titleGeneration += 1;
		pi.events.emit(COCKPIT_UI_OWNERSHIP_EVENT, released);
		// Tear down shared-bus subscriptions so a host reload does not leave this
		// extension instance's listeners accumulating on the same bus. session_start
		// re-registers them (subscribeBusEvents / registry.start / provider).
		unsubscribeBusEvents();
		settingsRegistry.dispose();
		try {
			settingsProviderDisposer?.();
		} catch {
			// best effort
		}
		settingsProviderDisposer = undefined;
		lastCtx = undefined;
		running = false;
		runningStartedAt = undefined;
		activeTools.clear();
		thinkingTimer.reset();
		invalidateUsageCache();
		agents.clear();
		bashBg.clear();
		maestro.clear();
	});

	pi.on("agent_start", () => {
		running = true;
		runningStartedAt = Date.now();
		startTick();
		req();
	});
	pi.on("agent_end", () => {
		running = false;
		runningStartedAt = undefined;
		activeTools.clear();
		thinkingTimer.stop();
		syncTick();
		req();
	});

	// --- live elapsed for folded thinking rows ---
	pi.on("message_update", (e) => {
		thinkingTimer.onAssistantMessageEvent(e.assistantMessageEvent);
	});

	// --- redraw triggers for the footer's live data ---
	pi.on("message_end", (e, ctx) => {
		// Settle an interrupted thinking run: message_end fires for aborted and
		// failed messages too, while the row is still mounted.
		if (e.message.role === "assistant") thinkingTimer.onAssistantMessageEnd();
		invalidateUsageCache();
		if (isTuiContext(ctx)) req();
	});
	pi.on("model_select", (_e, ctx) => {
		if (isTuiContext(ctx)) req();
	});
	pi.on("session_compact", (_e, ctx) => {
		invalidateUsageCache();
		if (isTuiContext(ctx)) req();
	});
	pi.on("session_info_changed", (_e, ctx) => {
		// A session rename (or the /session name set at startup) changes the
		// session summary the tab title leads with.
		if (isTuiContext(ctx)) req();
	});
	pi.on("thinking_level_select", (_e, ctx) => {
		if (isTuiContext(ctx)) req();
	});
	pi.on("input", async (e, ctx) => {
		const target = selectedAgentTarget();
		const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
		const registry = globals[MAILBOX_REGISTRY_KEY] as MailboxHostRegistry | undefined;
		const action = await routeAgentInput(
			e,
			target ? { correlationId: target.row.correlationId, label: target.label } : undefined,
			registry,
			ctx.ui,
		);
		if (action === "handled") return { action: "handled" as const };

		const interactiveText = e.source === "interactive" && e.text.trim().length > 0;
		const isSynthetic = e.text.startsWith("/") || e.text.startsWith("!");
		// Remember the first real main-session user message; child-directed input
		// is handled above and must not influence the main session title.
		if (!firstUserText && interactiveText && !isSynthetic) firstUserText = e.text;
		return { action: "continue" as const };
	});
	pi.on("turn_end", (e, ctx) => {
		// Claude Code generates its title from the first user message; we wait
		// for the first turn to settle so the title can reflect what the model
		// actually did, then ask the configured model (or the rule fallback).
		if (titleRequested || !firstUserText || !isTuiContext(ctx)) return;
		titleRequested = true;
		void generateSessionTitle(ctx, firstUserText, e.message, () => req());
	});

	const enterCapturingOverlay = (): void => {
		capturingOverlayActive = true;
		try {
			sidebarController?.cancelResize();
		} catch {
			// Resize cancellation is best effort; the overlay must still open.
		}
	};
	const exitCapturingOverlay = (): void => {
		capturingOverlayActive = false;
	};

	const openBashBgOverlay = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		enterCapturingOverlay();
		try {
			await ctx.ui.custom<void>((tui, theme, _kb, done) =>
				new BashBgOverlay({
					getJobs: () => bashBg.snapshot(),
					requestRender: () => tui.requestRender(),
					requestRefresh: () => pi.events.emit(BASH_BG_QUERY_EVENT, undefined),
					close: () => done(undefined),
					theme,
					glyphs: resolveGlyphs(config.icons.mode),
					hideLiveDuration: config.staticMode,
					getTerminalRows: () => terminalRows(tui),
				}), {
				overlay: true,
				overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
			});
		} finally {
			exitCapturingOverlay();
		}
	};

	// --- /theme: pi ships no command for this; themes live under /settings ---
	const makeThemePicker = (
		ctx: ExtensionContext,
		tui: TUI,
		theme: Theme,
		close: () => void,
	): ThemePicker => {
		const active = activeThemeName(theme);
		return new ThemePicker({
			themes: ctx.ui.getAllThemes().map((t) => t.name),
			// Cockpit's own record is only a fallback: pi's live theme is the truth,
			// and /settings can have changed it since cockpit last wrote anything.
			initial: active ?? config.theme,
			// Resolve a real instance by name. Passing `theme` straight through would
			// store the Proxy into the very slot the Proxy reads from, and the next
			// colour lookup would recurse until the stack blew.
			original: active ? ctx.ui.getTheme(active) : undefined,
			loadTheme: (name) => ctx.ui.getTheme(name),
			// Instance form: applies in memory without writing through to pi's
			// settings, so scrolling the whole list costs the user nothing.
			previewTheme: (instance) => { ctx.ui.setTheme(instance); },
			// Name form: the one call that persists.
			commitTheme: (name) => {
				const applied = ctx.ui.setTheme(name);
				if (applied.success) {
					config = { ...config, theme: name };
					saveConfig(config);
				}
				return applied;
			},
			close,
			requestRender: () => tui.requestRender(),
			getTerminalRows: () => terminalRows(tui),
			theme,
			glyphs: resolveGlyphs(config.icons.mode),
		});
	};

	const openThemePicker = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		enterCapturingOverlay();
		try {
			await ctx.ui.custom<void>((tui, theme, _kb, done) =>
				makeThemePicker(ctx, tui, theme, () => done(undefined)), {
				overlay: true,
				overlayOptions: { anchor: "center", width: "60%", maxHeight: "90%" },
			});
		} finally {
			exitCapturingOverlay();
		}
	};

	// pi has no /theme command — the built-in picker is a submenu of /settings.
	// This is the shortcut, not a replacement: /settings still owns the automatic
	// light/dark pairing, which a flat list of names cannot express.
	pi.registerCommand("theme", {
		description: "Switch theme — /theme picks with live preview, /theme <name> applies directly",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const ctx = lastCtx;
			if (!ctx || !ctx.hasUI) return null;
			const matches = ctx.ui.getAllThemes()
				.map((t) => t.name)
				.filter((name) => name.toLowerCase().includes(query));
			return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const name = args.trim();
			if (name === "") {
				await openThemePicker(ctx);
				return;
			}
			const applied = ctx.ui.setTheme(name);
			if (!applied.success) {
				ctx.ui.notify(`theme "${name}" unavailable — ${applied.error ?? "not found"}`, "warning");
				return;
			}
			config = { ...config, theme: name };
			saveConfig(config);
			ctx.ui.notify(`theme: ${name}`, "info");
		},
	});

	const setSidebarMode = (
		ctx: ExtensionContext,
		mode: CockpitConfig["sidebar"]["mode"],
	): void => {
		if (config.sidebar.mode === mode) {
			ctx.ui.notify(`Cockpit sidebar: ${mode}`, "info");
			return;
		}
		config = { ...config, sidebar: { ...config.sidebar, mode } };
		const result = saveConfig(config);
		if (!result.ok) {
			ctx.ui.notify(`Cockpit sidebar mode kept for this session; save failed: ${result.error ?? "unknown error"}`, "warning");
		} else if (configProblem?.startsWith("sidebar width save failed:")) {
			configProblem = undefined;
		}
		if (config.enabled && isTuiContext(ctx)) syncSidebarMode(ctx);
		publishUiOwnership();
		req();
	};

	const setStaticMode = (target: boolean): boolean => {
		if (config.staticMode === target) return true;
		config = { ...config, staticMode: target };
		const result = saveConfig(config);
		if (!result.ok) {
			configProblem = `static mode save failed: ${result.error ?? "unknown error"}`;
		} else if (configProblem?.startsWith("static mode save failed:")) {
			configProblem = undefined;
		}
		// Restart or stop the animation loop for the new mode: turning static on
		// must kill a running tick, turning it off must revive one mid-run.
		syncTick();
		thinkingTimer.syncMode();
		// Broadcast so cross-extension surfaces (e.g. pi-maestro-flow's Goal
		// panel) freeze their per-second elapsed ticks along with the cockpit.
		publishUiOwnership();
		req();
		return result.ok;
	};

	const cockpitSettingsProvider = createCockpitSettingsProvider({
		getRuntimeConfig: () => config,
		applyRuntimeConfig: async (nextConfig, changedKeys) => {
			const previous = config;
			config = nextConfig;
			const ctx = lastCtx;
			if (!ctx || !isTuiContext(ctx)) return;
			if (previous.enabled !== nextConfig.enabled) {
				if (nextConfig.enabled) {
					publishUiOwnership();
					applyUi(ctx);
				} else {
					uninstallUi(ctx);
					publishUiOwnership();
				}
				return;
			}
			if (!nextConfig.enabled) return;
			if (previous.staticMode !== nextConfig.staticMode) {
				syncTick();
				thinkingTimer.syncMode();
			}
			if (previous.quietMode !== nextConfig.quietMode) {
				applyQuietMode(ctx, previous.quietMode, nextConfig.quietMode);
			}
			if (previous.pinEditorBottom !== nextConfig.pinEditorBottom) {
				if (nextConfig.pinEditorBottom) installEditorBottom(ctx);
				else clearEditorBottom(ctx);
			}
			if (changedKeys.some((key) => key.startsWith("sidebar."))) syncSidebarMode(ctx);
			publishUiOwnership();
			req();
		},
		getThemeName: () => config.theme || undefined,
		getThinkingFolded: () => lastCtx ? readHideThinkingBlock(lastCtx.cwd) : undefined,
		openLegacySettings: async () => { if (settingsCommandCtx) await openSettings(settingsCommandCtx); },
		openThemeSettings: async () => { if (settingsCommandCtx) await openThemePicker(settingsCommandCtx); },
		toggleThinkingFold: () => {
			if (!lastCtx) return;
			ensureThinkingFolded(capturedTui, lastCtx.cwd, !readHideThinkingBlock(lastCtx.cwd));
		},
	});
	// The settings provider registers on the first session (registerSettingsProvider
	// in session_start); its disposer is stored for teardown at session_shutdown.

	pi.registerShortcut(BASH_BG_OVERLAY_KEY, {
		description: "Open background Bash jobs — live status, command, cwd, duration and output tail",
		async handler(ctx) {
			await openBashBgOverlay(ctx);
		},
	});

	pi.registerShortcut(SIDEBAR_RESIZE_KEY, {
		description: "Resize the Cockpit sidebar",
		handler(ctx) {
			if (!config.enabled) {
				ctx.ui.notify("Cockpit is disabled", "warning");
				return;
			}
			if (capturingOverlayActive) {
				ctx.ui.notify("Close the open Cockpit overlay before resizing the sidebar", "warning");
				return;
			}
			sidebarController?.beginResize();
		},
	});

	pi.registerShortcut(SESSION_DETAIL_TOGGLE_KEY, {
		description: "Show or hide the selected teammate session above Todo",
		handler(ctx) {
			if (!config.enabled) {
				ctx.ui.notify("Cockpit is disabled", "warning");
				return;
			}
			sessionDetailVisible = !sessionDetailVisible;
			if (sessionDetailVisible) sessionDetailScroll = { offset: 0, following: true };
			ctx.ui.notify(`Agent session detail ${sessionDetailVisible ? "shown" : "hidden"}`, "info");
			req();
		},
	});

	pi.registerShortcut(SIDEBAR_FOCUS_KEY, {
		description: "Browse the Cockpit sidebar with the keyboard (↑↓/j/k/PageUp/PageDown/Home/End, Esc to leave)",
		handler(ctx) {
			if (!config.enabled) {
				ctx.ui.notify("Cockpit is disabled", "warning");
				return;
			}
			if (capturingOverlayActive) {
				ctx.ui.notify("Close the open Cockpit overlay before browsing the sidebar", "warning");
				return;
			}
			sidebarController?.beginFocus();
		},
	});

	pi.registerCommand("maestro-settings", {
		description: "Open unified Maestro settings for Cockpit, Flow, Teammate and integrations",
		async handler(_args, ctx) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Maestro settings require interactive TUI mode", "warning");
				return;
			}
			settingsCommandCtx = ctx;
			try {
				await showMaestroSettingsShell(ctx, settingsRegistry, settingsLocale);
			} finally {
				settingsCommandCtx = undefined;
			}
		},
	});

	// --- /cockpit: legacy settings plus direct surface controls ---
	pi.registerCommand("cockpit", {
		description: "Open pi-cockpit settings; /cockpit sidebar controls the dock, /cockpit bg shows jobs",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const candidates = [
				"quiet", "quiet on", "quiet off", "bg", "jobs", "todo", "todo expand", "todo collapse",
				"sidebar", "sidebar auto", "sidebar on", "sidebar off", "sidebar resize",
				"static", "static on", "static off",
			];
			const matches = candidates.filter((c) => c.startsWith(query));
			return matches.length > 0 ? matches.map((c) => ({ value: c, label: c })) : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const action = args.trim().toLowerCase();
			if (action === "bg" || action === "jobs") {
				await openBashBgOverlay(ctx);
				return;
			}
			if (action === "sidebar") {
				ctx.ui.notify(
					`Cockpit sidebar: ${config.sidebar.mode} · ${config.sidebar.width} columns · ${config.sidebar.density}`,
					"info",
				);
				return;
			}
			if (action === "sidebar resize") {
				if (!config.enabled) ctx.ui.notify("Cockpit is disabled", "warning");
				else sidebarController?.beginResize();
				return;
			}
			if (action === "sidebar auto" || action === "sidebar on" || action === "sidebar off") {
				setSidebarMode(ctx, action.slice("sidebar ".length) as CockpitConfig["sidebar"]["mode"]);
				return;
			}
			if (action === "todo" || action === "todo toggle") {
				setTodoExpanded(!config.todoExpanded);
				ctx.ui.notify(`TODO ${config.todoExpanded ? "expanded" : "collapsed"}`, "info");
				return;
			}
			if (action === "todo expand" || action === "todo collapse") {
				setTodoExpanded(action.endsWith("expand"));
				return;
			}
			if (action === "quiet" || action === "quiet toggle") {
				const was = config.quietMode;
				config = { ...config, quietMode: !was };
				saveConfig(config);
				applyQuietMode(ctx, was, config.quietMode);
				req();
				return;
			}
			if (action === "quiet on" || action === "quiet off") {
				const target = action === "quiet on";
				if (config.quietMode === target) return;
				const was = config.quietMode;
				config = { ...config, quietMode: target };
				saveConfig(config);
				applyQuietMode(ctx, was, target);
				req();
				return;
			}
			if (action === "static" || action === "static toggle") {
				const ok = setStaticMode(!config.staticMode);
				ctx.ui.notify(
					ok
						? `Cockpit static mode ${config.staticMode ? "on — live updates reduced" : "off"}`
						: "Cockpit static mode kept for this session; save failed",
					ok ? "info" : "warning",
				);
				return;
			}
			if (action === "static on" || action === "static off") {
				const target = action === "static on";
				if (config.staticMode === target) return;
				const ok = setStaticMode(target);
				ctx.ui.notify(
					ok
						? `Cockpit static mode ${target ? "on — live updates reduced" : "off"}`
						: "Cockpit static mode kept for this session; save failed",
					ok ? "info" : "warning",
				);
				return;
			}
			await openSettings(ctx);
		},
	});

	pi.registerCommand("supervision", {
		description: "Supervision: /supervision [events] — unified goal/monitor/advisor telemetry",
		handler: async (args, ctx) => {
			const totals = supervision.getTotals();
			const wantEvents = args.trim().toLowerCase() === "events";
			if (!wantEvents) {
				const status = supervision.footerStatus();
				ctx.ui.notify(
					[
						`SUPERVISION ${status ?? "idle (no events)"}`,
						`  interventions: ${totals.interventions} · notifications: ${totals.notifications} · verdicts: ${totals.verdicts}`,
						"  /supervision events — list recent events",
					].join("\n"),
					"info",
				);
				return;
			}
			const recent = supervision.recentEvents(10);
			if (recent.length === 0) {
				ctx.ui.notify("No supervision events observed yet.", "info");
				return;
			}
			const lines = recent.map((event) => {
				const time = new Date(event.timestamp).toLocaleTimeString();
				const marker = event.severity === "blocker" ? "▲" : event.severity === "concern" ? "△" : "·";
				const message = (event.message ?? event.kind).slice(0, 100);
				return `${marker} [${event.source}] ${event.kind} ${time} — ${message}`;
			});
			ctx.ui.notify([`SUPERVISION recent ${recent.length}`, ...lines].join("\n"), "info");
		},
	});

	const openSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
		enterCapturingOverlay();
		try {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let settingsCursor = 0;
			let saveState: SaveState = { kind: "idle" };
			let enableAfterClose = false;
			let settled = false;
			// Non-null while a text row is being edited: keystrokes build the draft,
			// Enter commits it through apply(), Esc reverts — the same cancel
			// contract the theme picker offers, scoped to the single row.
			let editingText: string | null = null;
			let textDraft = "";
			// Mirror of pi's hideThinkingBlock, read when the panel opens. The
			// overlay captures input, so Ctrl+T cannot flip it while this is open
			// and the mirror stays exact until the panel closes.
			let thinkingHidden = readHideThinkingBlock(ctx.cwd);
			// The theme row expands in place rather than closing the panel and opening
			// a second overlay: pi's `theme` is a live Proxy, so both surfaces repaint
			// in the previewed colours, and Esc lands back on the row it was invoked
			// from instead of on a panel that looks freshly opened.
			let sub: ThemePicker | ModelPicker | undefined;
			const closeSub = (): void => {
				sub?.dispose();
				sub = undefined;
				tui.requestRender();
			};
			// Persisting apply shared by cycle rows and the model picker: commits the
			// row to config, saves it, and runs the live side effects (quiet mode,
			// sidebar, enable-after-close). apply() routes row-specific hand-offs
			// first and only falls through here for rows the panel itself owns.
			const persist = (key: string, textValue?: string): void => {
				const wasEnabled = config.enabled;
				const wasQuiet = config.quietMode;
				const wasStatic = config.staticMode;
				const wasPinEditorBottom = config.pinEditorBottom;
				const wasSidebarMode = config.sidebar.mode;
				config = applyRow(config, key, textValue);
				saveState = { kind: "saving" };
				const result = saveConfig(config);
				// The panel now reports what actually happened instead of showing
				// an optimistic value for a write that may never have landed.
				saveState = result.ok
					? { kind: "saved" }
					: { kind: "failed", message: result.error ?? "unknown error" };
				if (result.ok && configProblem?.startsWith("sidebar width save failed:")) {
					configProblem = undefined;
				}
				if (wasEnabled !== config.enabled) {
					if (config.enabled) {
						// Creating a non-capturing sidebar while this capturing settings
						// overlay is still open would put it on top; settings done() would
						// then close the sidebar. Acquire/install only after settings disposes.
						enableAfterClose = true;
					} else {
						enableAfterClose = false;
						uninstallUi(ctx);
						publishUiOwnership();
					}
				} else {
					if (config.enabled && wasPinEditorBottom !== config.pinEditorBottom) {
						if (config.pinEditorBottom) installEditorBottom(ctx);
						else clearEditorBottom(ctx);
					} else if (config.enabled && wasSidebarMode !== config.sidebar.mode) {
						syncSidebarMode(ctx);
					}
					publishUiOwnership();
				}
				if (wasQuiet !== config.quietMode) {
					applyQuietMode(ctx, wasQuiet, config.quietMode);
				}
				if (wasStatic !== config.staticMode) {
					syncTick();
					thinkingTimer.syncMode();
				}
				req();
			};
			// The model row expands like the theme row: the picker owns the whole
			// card, Enter saves through persist(), Esc lands back on the panel. The
			// entries are the /api-manager providers, so what is offered here is
			// exactly what title-llm can resolve at generation time.
			const makeModelPicker = (): ModelPicker => {
				const entries: ModelPickerEntry[] = [
					{ kind: "model", ref: "", label: "(rule-based)" },
					...ctx.modelRegistry.getAvailable().map((m) => ({
						kind: "model" as const,
						ref: `${m.provider}/${m.id}`,
						label: `${m.provider}/${m.id}`,
					})),
					{ kind: "custom", label: "custom ref…" },
				];
				return new ModelPicker({
					entries,
					initial: config.title.generationModel ?? "",
					commit: (ref) => {
						persist("titleGenerationModel", ref);
					},
					requestCustom: () => {
						// Hand off to the existing free-text editor so a ref that is not
						// on the list (yet) can still be typed; resolution against the
						// registry still happens at generation time. The picker closes
						// itself after this callback, so the panel repaints into
						// text-edit mode.
						editingText = "titleGenerationModel";
						textDraft = config.title.generationModel ?? "";
					},
					close: closeSub,
					requestRender: () => tui.requestRender(),
					getTerminalRows: () => terminalRows(tui),
					theme,
					glyphs: resolveGlyphs(config.icons.mode),
				});
			};
			const apply = (key: string, textValue?: string): void => {
				if (key === "theme") {
					// Delegate: the picker previews live and reverts on Esc, neither of
					// which a blind one-key cycle through the name list can do.
					sub = makeThemePicker(ctx, tui, theme, closeSub);
					tui.requestRender();
					return;
				}
				if (key === "thinkingFold") {
					// Pass-through row: pi owns hideThinkingBlock, so bring it to the
					// wanted state through the native toggle instead of saving config.
					// pi persists the flip synchronously through its settingsManager.
					const target = !thinkingHidden;
					const ok = ensureThinkingFolded(tui, ctx.cwd, target);
					if (ok) thinkingHidden = target;
					saveState = ok
						? { kind: "saved" }
						: { kind: "failed", message: "editor unreachable" };
					return;
				}
				if (key === "titleGenerationModel") {
					sub = makeModelPicker();
					tui.requestRender();
					return;
				}
				persist(key, textValue);
			};
			// Idempotent teardown shared by component.dispose() and session shutdown:
			// the host hides a stale overlay via hideOverlay() without calling
			// component.dispose(), which would strand a previewed theme, skip the
			// deferred UI re-install, and leave the custom() promise unsettled (MW-2).
			const finalize = (): void => {
				if (settled) return;
				settled = true;
				try {
					sub?.handleInput("\x1b");
				} catch {
					// best effort
				}
				sub?.dispose();
				if (enableAfterClose && config.enabled) {
					queueMicrotask(() => {
						if (lastCtx !== ctx || !config.enabled) return;
						publishUiOwnership();
						applyUi(ctx);
						req();
					});
				}
				done(undefined);
			};
			activeSettingsOverlay = { finalize };
			const ui = {
				render(width: number): string[] {
					// The sub-view takes the whole card. It carries its own title and
					// key hints, so stacking the panel's chrome above it would spend two
					// rows saying nothing the picker does not already say.
					if (sub) return sub.render(width);
					const paint: PaintTheme = theme;
					const rows = buildRows(config, { thinkingHidden });
					settingsCursor = Math.max(0, Math.min(settingsCursor, rows.length - 1));
					const w = Math.min(width, 52);
					const labelWidth = Math.max(...rows.map((r) => visibleWidth(r.label)));
					const lines = [
						paint.fg("text", "pi-cockpit"),
						paint.fg("borderMuted", "─".repeat(w)),
					];
					rows.forEach((row, index) => {
						const selected = index === settingsCursor;
						const editing = editingText === row.key;
						const marker = editing ? paint.fg("accent", "›") : selected ? paint.fg("accent", "›") : " ";
						const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)));
						const label = paint.fg(selected ? "text" : "muted", row.label) + pad;
						// Text rows show the live draft plus a block cursor while editing;
						// the stored value is only committed on Enter, so Esc reverts cleanly.
						const shownValue = editing ? textDraft : row.value;
						const value = paint.fg("accent", shownValue + (editing ? "▏" : ""));
						// Cycle rows advertise their next value; the text row shows its edit
						// affordance, and while editing the commit keys replace the hints.
						const hint = editing
							? paint.fg("dim", " → Enter save · Esc cancel")
							: selected
								? paint.fg("dim", ` → ${row.next}`)
								: "";
						lines.push(`${marker} ${paint.fg("dim", row.accel)} ${label}  ${value}${hint}`);
					});
					lines.push("");
					if (saveState.kind === "saved") lines.push(paint.fg("success", "✓ saved"));
					else if (saveState.kind === "saving") lines.push(paint.fg("dim", "· saving…"));
					else if (saveState.kind === "failed") {
						lines.push(paint.fg("error", `✗ save failed — ${saveState.message}`));
						// Scoped to cockpit's own rows: the theme is applied through pi,
						// which persists it regardless of whether this file was written.
						lines.push(paint.fg("dim", "cockpit rows apply for this session only"));
					}
					// The theme row opens /theme; /settings additionally pairs a light
					// and a dark theme, which neither of cockpit's surfaces can express.
					// Thinking fold is pi's setting too (Ctrl+T), mirrored live here.
					lines.push(paint.fg("dim", "theme & thinking are stored by pi"));
					lines.push(paint.fg("dim", "/settings pairs light+dark"));
					lines.push(
						editingText
							? paint.fg("dim", "type · Enter save · Esc cancel")
							: paint.fg("dim", "↑↓ move · Enter change · letter jumps · Esc close"),
					);
					return lines.map((line) => truncateToWidth(line, width, "…"));
				},
				invalidate(): void {},
				handleInput(data: string): void {
					// While expanded the sub-view owns every key, Esc included — that is
					// what makes Esc step back to the panel instead of dismissing both.
					if (sub) {
						sub.handleInput(data);
						tui.requestRender();
						return;
					}
					const rows = buildRows(config, { thinkingHidden });
					// Text edit mode: every key types into the draft except the
					// commit/cancel trio. Multi-byte sequences (arrows, alt chords)
					// are dropped so escape bytes cannot enter a model ref.
					if (editingText !== null) {
						if (matchesKey(data, Key.escape)) {
							editingText = null;
						} else if (data === "\r" || data === "\n") {
							const key = editingText;
							editingText = null;
							apply(key, textDraft);
						} else if (data === "\x7f" || data === "\x08") {
							textDraft = textDraft.slice(0, -1);
						} else if (data.length === 1 && data >= " ") {
							textDraft += data;
						}
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.escape)) {
						done(undefined);
						return;
					}
					if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
						const delta = matchesKey(data, Key.up) ? -1 : 1;
						settingsCursor = (settingsCursor + delta + rows.length) % rows.length;
					} else if (matchesKey(data, Key.enter) || data === " " || decodeKittyPrintable(data) === " ") {
						const row = rows[settingsCursor];
						if (row.kind === "text") {
							// Enter on a text row opens the editor with the stored value
							// (not the "(rule-based)" display string) as the draft.
							editingText = row.key;
							textDraft = config.title.generationModel ?? "";
						} else {
							apply(row.key);
						}
					} else {
						const key = rowKeyForAccel(rows, data);
						if (!key) return;
						settingsCursor = rows.findIndex((row) => row.key === key);
						const row = rows[settingsCursor];
						if (row.kind === "text") {
							editingText = row.key;
							textDraft = config.title.generationModel ?? "";
						} else {
							apply(key);
						}
					}
					tui.requestRender();
				},
				dispose(): void {
					// Closing the panel while expanded must not strand a previewed theme
					// with no way back, so route through the picker's own cancel path.
					finalize();
				},
			};
				return ui;
			}, { overlay: true });
		} finally {
			exitCapturingOverlay();
			activeSettingsOverlay = undefined;
		}
	};
}
