// Usage-bars subsystem tests (ported from hknet/pi-usage-bars/tests/usage-bars-extension.test.ts).
//
// The upstream called the extension's default export and asserted on
// `ctx.ui.setStatus` writes. The Cockpit port refactors the default export
// into `createUsageSubsystem({ pi, getConfig, onStatusChange })`, which returns
// a controller exposing `start/stop/onModelSelect/openCommand/getStatus/refresh/
// rescheduleTimer/dispose`. The footer reads `getStatus(theme, barWidth)`
// instead of a setStatus write, so the tests assert on getStatus output and
// the `onStatusChange` callback firing. The inter-extension event name was
// namespaced to `pi-cockpit:usage-bars:update`.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createUsageSubsystem, type UsageSubsystem } from "../src/usage/extension.ts";
import { DEFAULT_CONFIG, type CockpitConfig } from "../src/types.ts";

interface Harness {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	emitted: Array<{ name: string; data: unknown }>;
	statusChanges: number;
	subsystem: UsageSubsystem;
	getConfig: () => CockpitConfig;
	setConfig: (patch: Partial<CockpitConfig["usage"]>) => void;
}

// expect() chain adapter mirroring the bun assertions the upstream extension
// test uses (objectContaining / toContainEqual / toBeTrue / toBeFalse /
// toHaveLength / toBe / toEqual / toContain / toMatchObject).
function expect(actual: unknown) {
	const api = {
		toBe(value: unknown): void { assert.strictEqual(actual, value); },
		toBeNull(): void { assert.equal(actual, null); },
		toBeUndefined(): void { assert.equal(actual, undefined); },
		toBeTrue(): void { assert.strictEqual(actual, true); },
		toBeFalse(): void { assert.strictEqual(actual, false); },
		toHaveLength(length: number): void {
			assert.ok(Array.isArray(actual) || typeof actual === "string", "toHaveLength expects an array or string");
			assert.equal((actual as unknown[]).length, length);
		},
		toEqual(value: unknown): void { assert.deepStrictEqual(actual, value); },
		toMatchObject(value: unknown): void { assert.ok(matchObject(actual, value)); },
		toBeGreaterThan(value: number): void { assert.ok((actual as number) > value); },
		toBeLessThan(value: number): void { assert.ok((actual as number) < value); },
		toContain(fragment: string): void {
			assert.equal(typeof actual, "string");
			assert.ok((actual as string).includes(fragment), `expected "${actual}" to contain "${fragment}"`);
		},
		not: {
			toContain(fragment: string): void {
				assert.equal(typeof actual, "string");
				assert.ok(!(actual as string).includes(fragment), `expected "${actual}" NOT to contain "${fragment}"`);
			},
			toBeUndefined(): void { assert.notEqual(actual, undefined); },
		},
	};
	return api;
}
expect.objectContaining = (shape: Record<string, unknown>) => ({ __objectContaining: shape });
expect.arrayContaining = (shape: unknown[]) => ({ __arrayContaining: shape });

function matchObject(actual: unknown, expected: unknown): boolean {
	if (expected === null || expected === undefined) return actual === expected;
	if (expected && typeof expected === "object" && "__objectContaining" in (expected as object)) {
		const shape = (expected as { __objectContaining: Record<string, unknown> }).__objectContaining;
		return typeof actual === "object" && actual !== null
			&& Object.keys(shape).every((key) =>
				Object.prototype.hasOwnProperty.call(actual, key) &&
				(matchObject((actual as Record<string, unknown>)[key], shape[key])
					|| (typeof shape[key] === "object" && shape[key] !== null && "__objectContaining" in shape[key]
						? matchObject((actual as Record<string, unknown>)[key], shape[key])
						: Object.is((actual as Record<string, unknown>)[key], shape[key]))));
	}
	if (typeof expected !== "object") return Object.is(actual, expected);
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length) return false;
		return expected.every((entry, index) => matchObject((actual as unknown[])[index], entry));
	}
	if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
	const expectedRecord = expected as Record<string, unknown>;
	const actualRecord = actual as Record<string, unknown>;
	return Object.keys(expectedRecord).every((key) =>
		Object.prototype.hasOwnProperty.call(actualRecord, key) && matchObject(actualRecord[key], expectedRecord[key]),
	);
}

function containsEqual(list: Array<{ name: string; data: unknown }>, expected: { name: string; data: unknown }): boolean {
	return list.some((entry) => entry.name === expected.name && matchObject(entry.data, expected.data));
}

function createHarness(options: { usageFlag?: boolean; setPollIntervalMs?: (ms: number) => boolean } = {}): Harness {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const emitted: Array<{ name: string; data: unknown }> = [];
	let statusChanges = 0;
	let config: CockpitConfig = structuredClone(DEFAULT_CONFIG);
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			commands.set(name, command);
		},
		registerFlag() {},
		getFlag(name: string) {
			return name === "usage" && options.usageFlag === true;
		},
		events: {
			emit(name: string, data: unknown) {
				emitted.push({ name, data });
			},
		},
	} as unknown as ExtensionAPI;
	const subsystem = createUsageSubsystem({
		pi,
		getConfig: () => config,
		onStatusChange: () => { statusChanges += 1; },
		...(options.setPollIntervalMs ? { setPollIntervalMs: options.setPollIntervalMs } : {}),
	});
	// The cockpit registers the command itself; expose it here as "usage" so the
	// upstream command tests keep working against the default commandKey.
	commands.set(config.usage.commandKey, {
		handler: async (_args, ctx) => { await subsystem.openCommand(ctx); },
	});
	return {
		pi,
		handlers,
		commands,
		emitted,
		get statusChanges() { return statusChanges; },
		subsystem,
		getConfig: () => config,
		setConfig(patch) { config = { ...config, usage: { ...config.usage, ...patch } }; },
	};
}

function createContext(
	mode: "tui" | "rpc" | "json" | "print",
	provider = "openai",
	options: { configured?: boolean; source?: string; token?: string; authHeaders?: Record<string, string> } = {},
) {
	const statuses: Array<string | undefined> = [];
	const statusKeys: string[] = [];
	const notifications: string[] = [];
	let authCalls = 0;
	let customCalls = 0;
	let shutdownCalls = 0;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const context = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		model: { provider, id: "test-model" },
		ui: {
			theme,
			setStatus: (key: string, value: string | undefined) => {
				statusKeys.push(key);
				statuses.push(value);
			},
			notify: (message: string) => notifications.push(message),
			custom: async () => { customCalls += 1; },
		},
		shutdown: () => { shutdownCalls += 1; },
		modelRegistry: {
			getProvider: () => ({}),
			getProviderAuthStatus: () => ({ configured: options.configured ?? false }),
			getProviderAuth: async () => {
				authCalls += 1;
				if (options.token) {
					return { auth: { apiKey: options.token }, source: options.source };
				}
				if (options.authHeaders) {
					return { auth: { headers: options.authHeaders }, source: options.source };
				}
				return undefined;
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		context,
		statuses,
		statusKeys,
		notifications,
		authCalls: () => authCalls,
		customCalls: () => customCalls,
		shutdownCalls: () => shutdownCalls,
	};
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("usage-bars subsystem lifecycle", () => {
	it("prints one-line JSON and shuts down for --usage", async () => {
		const harness = createHarness({ usageFlag: true });
		const mock = createContext("print", "google");
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (line?: unknown) => { lines.push(String(line)); };
		try {
			await harness.subsystem.start(mock.context);
		} finally {
			console.log = originalLog;
		}

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({
			extension: "pi-cockpit:usage-bars",
			status: "unsupported",
			provider: "google",
		});
		expect(mock.shutdownCalls()).toBe(1);
	});

	it("does not poll or create timers in non-TUI modes", async () => {
		const harness = createHarness();
		const mock = createContext("print", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "token",
		});

		await harness.subsystem.start(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mock.authCalls()).toBe(0);
		// No usage update event was emitted because the poll never ran in non-TUI mode.
		expect(harness.emitted.filter((entry) => entry.name === "pi-cockpit:usage-bars:update")).toHaveLength(0);
	});

	it("uses Pi provider auth and emits usage updates in TUI mode", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({
			rate_limit: {
				primary_window: { used_percent: 12 },
				secondary_window: { used_percent: 34 },
			},
		}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "resolved-by-pi",
		});
		await harness.subsystem.start(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(mock.authCalls()).toBe(1);
		assert.ok(containsEqual(harness.emitted, {
			name: "pi-cockpit:usage-bars:update",
			data: { provider: "codex", session: 12, weekly: 34 },
		}), "expected a codex usage update event");
		const status = harness.subsystem.getStatus(mock.context.ui.theme, 8);
		expect(status ?? "").toContain("Codex");
	});

	it("resolves kimi-coding tokens exposed only via the Authorization header", async () => {
		let requestHeaders: HeadersInit | undefined;
		globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			requestHeaders = init?.headers;
			return new Response(JSON.stringify({
				usage: {
					limit: "2048",
					used: "512",
					remaining: "1536",
					resetTime: "2026-01-09T15:23:13.716839300Z",
				},
				limits: [{
					window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
					detail: {
						limit: "200",
						used: "50",
						remaining: "150",
						resetTime: "2026-01-06T13:33:02.717479433Z",
					},
				}],
			}), { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "kimi-coding", {
			configured: true,
			source: "OAuth",
			authHeaders: { Authorization: "Bearer kimi-token-from-header" },
		});
		await harness.subsystem.start(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(mock.authCalls()).toBe(1);
		assert.ok(containsEqual(harness.emitted, {
			name: "pi-cockpit:usage-bars:update",
			data: { provider: "kimi", session: 25, weekly: 25 },
		}), "expected a kimi usage update event");
		expect(harness.subsystem.getStatus(mock.context.ui.theme, 8) ?? "").toContain("Kimi");
		assert.ok(matchObject(requestHeaders, { Authorization: "Bearer kimi-token-from-header" }));

		harness.subsystem.stop(mock.context);
	});

	it("renders a weekly-only Codex window without a fabricated session lane", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({
			plan_type: "team",
			rate_limit: {
				primary_window: {
					used_percent: 72,
					limit_window_seconds: 604800,
					reset_after_seconds: 573719,
				},
				secondary_window: null,
			},
		}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "resolved-by-pi",
		});
		await harness.subsystem.start(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 25));

		assert.ok(containsEqual(harness.emitted, {
			name: "pi-cockpit:usage-bars:update",
			data: { provider: "codex", weekly: 72, sessionHidden: true },
		}), "expected a weekly-only codex update event");
		const status = harness.subsystem.getStatus(mock.context.ui.theme, 8) ?? "";
		expect(status).toContain("Codex W ");
		expect(status).toContain("72%");
		expect(status).not.toContain(" S ");

		harness.subsystem.stop(mock.context);
	});

	it("polls OpenRouter through Pi auth and emits financial usage", async () => {
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			const body = url.endsWith("/credits")
				? { data: { total_credits: 30, total_usage: 10 } }
				: { data: { limit: null, limit_remaining: null, usage_daily: 1, usage_weekly: 2, usage_monthly: 3 } };
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "openrouter", {
			configured: true,
			source: "Environment variable",
			token: "resolved-by-pi",
		});
		await harness.subsystem.start(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(mock.authCalls()).toBe(1);
		assert.ok(containsEqual(harness.emitted, {
			name: "pi-cockpit:usage-bars:update",
			data: {
				provider: "openrouter",
				accountBalance: { amount: 20, unit: "USD", label: "Balance" },
				accountSpend: { monthly: 3 },
			},
		}), "expected an openrouter financial update event");
		const status = harness.subsystem.getStatus(mock.context.ui.theme, 8) ?? "";
		expect(status).toContain("OpenRouter");
		expect(status).toContain("$20.00");

		harness.subsystem.stop(mock.context);
	});

	it("aborts an active provider request during session shutdown", async () => {
		let requestAborted = false;
		globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					requestAborted = true;
					reject(new DOMException("Aborted", "AbortError"));
				}, { once: true });
			})) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "resolved-by-pi",
		});
		await harness.subsystem.start(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		harness.subsystem.stop(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(requestAborted).toBeTrue();
		// After shutdown, getStatus returns undefined (active provider cleared on next lifecycle).
		expect(harness.subsystem.getStatus(mock.context.ui.theme, 8)).toBeUndefined();
	});

	it("replaces an active poll cleanly when a session runtime starts again", async () => {
		let calls = 0;
		let firstRequestAborted = false;
		globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			calls += 1;
			if (calls === 1) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						firstRequestAborted = true;
						reject(new DOMException("Aborted", "AbortError"));
					}, { once: true });
				});
			}
			return new Response(JSON.stringify({
				rate_limit: {
					primary_window: { used_percent: 21 },
					secondary_window: { used_percent: 43 },
				},
			}), { status: 200 });
		}) as unknown as typeof fetch;

		const harness = createHarness();
		const first = createContext("tui", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "first-session-token",
		});
		const replacement = createContext("tui", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "replacement-session-token",
		});
		await harness.subsystem.start(first.context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await harness.subsystem.start(replacement.context);
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(firstRequestAborted).toBeTrue();
		assert.ok(containsEqual(harness.emitted, {
			name: "pi-cockpit:usage-bars:update",
			data: { provider: "codex", session: 21, weekly: 43 },
		}), "expected the replacement-session codex update event");
		harness.subsystem.stop(replacement.context);
	});

	it("keeps only one polling interval across repeated session starts", () => {
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		const activeIntervals = new Set<number>();
		let nextInterval = 1;
		globalThis.setInterval = ((_handler: TimerHandler, _timeout?: number) => {
			const id = nextInterval++;
			activeIntervals.add(id);
			return id;
		}) as unknown as typeof setInterval;
		globalThis.clearInterval = ((id: number) => {
			activeIntervals.delete(id);
		}) as unknown as typeof clearInterval;

		try {
			const harness = createHarness();
			const first = createContext("tui");
			const second = createContext("tui");
			void harness.subsystem.start(first.context);
			void harness.subsystem.start(second.context);
			expect(activeIntervals.size).toBe(1);

			harness.subsystem.stop(second.context);
			expect(activeIntervals.size).toBe(0);
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		}
	});

	it("cancels an old provider poll and refreshes the newly selected model provider", async () => {
		let codexRequestAborted = false;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("chatgpt.com")) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						codexRequestAborted = true;
						reject(new DOMException("Aborted", "AbortError"));
					}, { once: true });
				});
			}
			const body = url.endsWith("/credits")
				? { data: { total_credits: 20, total_usage: 5 } }
				: { data: { usage_monthly: 2 } };
			return new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "resolved-by-pi",
		});
		await harness.subsystem.start(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		harness.subsystem.onModelSelect(mock.context, { provider: "openrouter", id: "test-model" } as unknown as ExtensionContext["model"]);
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(codexRequestAborted).toBeTrue();
		assert.ok(containsEqual(harness.emitted, {
			name: "pi-cockpit:usage-bars:update",
			data: { provider: "openrouter" },
		}), "expected an openrouter update event after model_select");
		harness.subsystem.stop(mock.context);
	});

	it("aborts /usage requests when the custom component closes", async () => {
		let selectorRequestAborted = false;
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					selectorRequestAborted = true;
					reject(new DOMException("Aborted", "AbortError"));
				}, { once: true });
			})) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "resolved-by-pi",
		});
		const context = mock.context as unknown as {
			modelRegistry: {
				getProvider: (provider: string) => unknown;
				getProviderAuthStatus: (provider: string) => { configured: boolean };
			};
			ui: { theme: unknown; custom: (factory: (...args: unknown[]) => unknown) => Promise<void> };
		};
		context.modelRegistry.getProvider = (provider: string) => provider === "openai-codex" ? {} : undefined;
		context.modelRegistry.getProviderAuthStatus = (provider: string) => ({
			configured: provider === "openai-codex",
		});
		context.ui.custom = async (factory: (...args: unknown[]) => unknown) => {
			let component: { handleInput?(data: string): void; dispose?(): void } | undefined;
			await new Promise<void>((resolve) => {
				void Promise.resolve(factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					context.ui.theme,
					{ matches: (data: string, binding: string) => data === "escape" && binding === "tui.select.cancel" },
					resolve,
				)).then((created) => {
					component = created as { handleInput?(data: string): void; dispose?(): void };
					setTimeout(() => component?.handleInput?.("escape"), 10);
				});
			});
			component?.dispose?.();
		};

		await harness.subsystem.openCommand(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(selectorRequestAborted).toBeTrue();
	});

	it("relies on onModelSelect rather than checking the model every turn", () => {
		const harness = createHarness();
		// The subsystem exposes onModelSelect; the cockpit wires model_select,
		// not turn_start. onModelSelect is a function (the lifecycle entry point).
		assert.equal(typeof harness.subsystem.onModelSelect, "function");
		// No turn_start handler is registered on the bus by the subsystem factory.
		expect(harness.handlers.has("turn_start")).toBeFalse();
	});

	it("guards the custom command outside interactive TUI mode", async () => {
		const harness = createHarness();
		const mock = createContext("rpc");
		await harness.commands.get("usage")?.handler("", mock.context);
		expect(mock.customCalls()).toBe(0);
		expect(mock.notifications).toEqual(["/usage is available in interactive mode"]);
	});

	it("getStatus barWidth scales the rendered bar", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({
			rate_limit: {
				primary_window: { used_percent: 50 },
				secondary_window: { used_percent: 50 },
			},
		}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "openai-codex", {
			configured: true,
			source: "OAuth",
			token: "resolved-by-pi",
		});
		await harness.subsystem.start(mock.context);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const narrow = harness.subsystem.getStatus(mock.context.ui.theme, 4) ?? "";
		const wide = harness.subsystem.getStatus(mock.context.ui.theme, 16) ?? "";
		// The wider bar has more filled block glyphs than the narrow one.
		const narrowFilled = (narrow.match(/█/g) ?? []).length;
		const wideFilled = (wide.match(/█/g) ?? []).length;
		expect(wideFilled).toBeGreaterThan(narrowFilled);
		harness.subsystem.stop(mock.context);
	});

	it("manual refresh mode (pollIntervalMs 0) skips polling, timers, and the footer bar", async () => {
		const realSetInterval = globalThis.setInterval;
		const activeIntervals = new Set<number>();
		let nextInterval = 1;
		globalThis.setInterval = ((_handler: TimerHandler, _timeout?: number) => {
			const id = nextInterval++;
			activeIntervals.add(id);
			return id;
		}) as unknown as typeof setInterval;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify({
				rate_limit: {
					primary_window: { used_percent: 10 },
					secondary_window: { used_percent: 20 },
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;

		try {
			const harness = createHarness();
			harness.setConfig({ pollIntervalMs: 0 });
			const mock = createContext("tui", "openai-codex", { configured: true, source: "OAuth", token: "t" });
			await harness.subsystem.start(mock.context);
			await new Promise((resolve) => setTimeout(resolve, 25));

			expect(activeIntervals.size).toBe(0);
			expect(fetchCalls).toBe(0);
			expect(harness.subsystem.getStatus(mock.context.ui.theme, 8)).toBeUndefined();

			// rescheduleTimer / refresh stay inert in manual mode.
			harness.subsystem.rescheduleTimer();
			harness.subsystem.refresh();
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(activeIntervals.size).toBe(0);
			expect(fetchCalls).toBe(0);

			// model_select still does not fetch in manual mode.
			harness.subsystem.onModelSelect(mock.context, { provider: "openai-codex", id: "test-model" } as unknown as ExtensionContext["model"]);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(fetchCalls).toBe(0);
			harness.subsystem.stop(mock.context);
		} finally {
			globalThis.setInterval = realSetInterval;
		}
	});

	it("/usage overlay re-fetches all providers on `r` with an empty search box", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify({
				rate_limit: {
					primary_window: { used_percent: 10 },
					secondary_window: { used_percent: 20 },
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;

		const harness = createHarness();
		const mock = createContext("tui", "openai-codex", { configured: true, source: "OAuth", token: "t" });
		const context = mock.context as unknown as {
			ui: { theme: unknown; custom: (factory: (...args: unknown[]) => unknown) => Promise<void> };
		};
		let component: { handleInput?(data: string): void; dispose?(): void; isLoading?(): boolean } | undefined;
		context.ui.custom = async (factory: (...args: unknown[]) => unknown) => {
			await new Promise<void>((resolve) => {
				void Promise.resolve(factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					mock.context.ui.theme,
					{ matches: (data: string, binding: string) => data === "escape" && binding === "tui.select.cancel" },
					resolve,
				)).then(async (created) => {
					component = created as { handleInput?(data: string): void; dispose?(): void; isLoading?(): boolean };
					// Wait for the initial load() to settle (it also scans the real
					// usage-history dir, which can be slow), then press `r`.
					while (component?.isLoading?.()) {
						await new Promise((r) => setTimeout(r, 50));
					}
					const afterOpen = fetchCalls;
					expect(afterOpen).toBeGreaterThan(0);
					// `r` only refetches once loading is false; keep poking until it takes.
					let attempts = 0;
					while (fetchCalls <= afterOpen && attempts < 80) {
						component?.handleInput?.("r");
						await new Promise((r) => setTimeout(r, 50));
						attempts++;
					}
					expect(fetchCalls).toBeGreaterThan(afterOpen);
					component?.handleInput?.("escape");
				});
			});
		};

		await harness.subsystem.openCommand(mock.context);
		component?.dispose?.();
	});

	it("rescheduleTimer reaps the old interval and applies the new pollIntervalMs", () => {
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		const intervals: number[] = [];
		const cleared: number[] = [];
		let nextId = 1;
		globalThis.setInterval = ((_handler: TimerHandler, timeout?: number) => {
			const id = nextId++;
			intervals.push(id);
			// Sanity: the interval uses the live pollIntervalMs.
			assert.equal(timeout, 120_000);
			return id;
		}) as unknown as typeof setInterval;
		globalThis.clearInterval = ((id: number) => { cleared.push(id); }) as unknown as typeof clearInterval;

		try {
			const harness = createHarness();
			const mock = createContext("tui", "openai-codex", { configured: true, source: "OAuth", token: "t" });
			void harness.subsystem.start(mock.context);
			harness.setConfig({ pollIntervalMs: 60_000 });
			// Replace the setInterval mock to record the new timeout.
			globalThis.setInterval = ((_handler: TimerHandler, timeout?: number) => {
				const id = nextId++;
				intervals.push(id);
				assert.equal(timeout, 60_000);
				return id;
			}) as unknown as typeof setInterval;
			harness.subsystem.rescheduleTimer();
			assert.ok(cleared.includes(intervals[0]!), "the previous interval must be cleared");
			harness.subsystem.stop(mock.context);
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		}
	});

	it("togglePolling flips pollIntervalMs between 0 and the default, persisting via setPollIntervalMs", () => {
		const persisted: number[] = [];
		const harness = createHarness({
			setPollIntervalMs: (ms) => {
				persisted.push(ms);
				harness.setConfig({ pollIntervalMs: ms });
				return true;
			},
		});
		const mock = createContext("tui", "openai-codex", { configured: true, source: "OAuth", token: "t" });
		void harness.subsystem.start(mock.context);

		// Default config has polling on (120s); first toggle turns it off.
		expect(harness.subsystem.togglePolling()).toBe(false);
		expect(harness.getConfig().usage.pollIntervalMs).toBe(0);
		expect(persisted).toEqual([0]);

		// Second toggle restores the default interval and re-enables polling.
		expect(harness.subsystem.togglePolling()).toBe(true);
		expect(harness.getConfig().usage.pollIntervalMs).toBe(120_000);
		expect(persisted).toEqual([0, 120_000]);

		harness.subsystem.stop(mock.context);
	});

	it("/usage overlay `p` toggles polling and re-renders its hint", async () => {
		let pollToggles = 0;
		const harness = createHarness({
			setPollIntervalMs: (ms) => {
				pollToggles += 1;
				harness.setConfig({ pollIntervalMs: ms });
				return true;
			},
		});
		const mock = createContext("tui", "openai-codex", { configured: true, source: "OAuth", token: "t" });
		const context = mock.context as unknown as {
			ui: { theme: unknown; custom: (factory: (...args: unknown[]) => unknown) => Promise<void> };
		};
		let component: { handleInput?(data: string): void; dispose?(): void; isLoading?(): boolean } | undefined;
		context.ui.custom = async (factory: (...args: unknown[]) => unknown) => {
			await new Promise<void>((resolve) => {
				void Promise.resolve(factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					mock.context.ui.theme,
					{ matches: (data: string, binding: string) => data === "escape" && binding === "tui.select.cancel" },
					resolve,
				)).then(async (created) => {
					component = created as { handleInput?(data: string): void; dispose?(): void; isLoading?(): boolean };
					while (component?.isLoading?.()) {
						await new Promise((r) => setTimeout(r, 50));
					}
					// Start from the default (polling on); `p` turns it off.
					expect(harness.getConfig().usage.pollIntervalMs).toBe(120_000);
					component?.handleInput?.("p");
					await new Promise((r) => setTimeout(r, 20));
					expect(harness.getConfig().usage.pollIntervalMs).toBe(0);
					// `p` again restores polling.
					component?.handleInput?.("p");
					await new Promise((r) => setTimeout(r, 20));
					expect(harness.getConfig().usage.pollIntervalMs).toBe(120_000);
					component?.handleInput?.("escape");
				});
			});
		};

		await harness.subsystem.openCommand(mock.context);
		component?.dispose?.();
		expect(pollToggles).toBe(2);
	});
});
