// Usage-bars core tests (ported from hknet/pi-usage-bars/tests/usage-bars-core.test.ts).
//
// The upstream uses bun:test's `expect(...).toBe/.toEqual/.toMatchObject/.toBeNull/
// .toContain/.toBeUndefined` chain. node:test has no `expect`; this port keeps the
// upstream test bodies intact and adapts only the assertion surface to
// `node:assert/strict`. `toMatchObject` becomes a partial-deep-equal helper
// (subset assertion) since `assert.deepStrictEqual` requires a full match.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clampPercent,
	colorForPercent,
	detectProvider,
	extractDeepSeekBalanceFromPayload,
	extractKimiUsageFromPayload,
	extractMiniMaxUsageFromPayload,
	extractMoonshotBalanceFromPayload,
	extractOpenRouterUsageFromPayloads,
	extractUsageFromPayload,
	extractZaiUsageFromPayload,
	fetchAllUsages,
	fetchClaudeUsage,
	fetchClaudeUsageWithFallback,
	fetchCodexUsage,
	fetchDeepSeekBalance,
	fetchKimiUsage,
	fetchMiniMaxUsage,
	fetchMoonshotBalance,
	fetchOpenRouterUsage,
	fetchZaiUsage,
	formatDuration,
	formatResetsAt,
	parseRetryAfterMs,
	providerToPiProviderId,
	readLimitPercent,
	readPercentCandidate,
	resolveUsageEndpoints,
	type FetchLike,
	type FetchResponseLike,
	type UsageEndpoints,
} from "../src/usage/core.ts";

// Subset match: every key in `expected` must equal the same path in `actual`,
// recursively for plain objects. Arrays require element-wise subset too.
function matchObject(actual: unknown, expected: unknown): boolean {
	if (expected === null || expected === undefined) return actual === expected;
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

// `expect(actual)` chain adapter mirroring the bun assertions the upstream uses.
function expect(actual: unknown) {
	return {
		toBe(value: unknown): void { assert.strictEqual(actual, value); },
		toBeNull(): void { assert.equal(actual, null); },
		toBeUndefined(): void { assert.equal(actual, undefined); },
		toEqual(value: unknown): void { assert.deepStrictEqual(actual, value); },
		toMatchObject(value: unknown): void {
			assert.ok(matchObject(actual, value), `expected ${JSON.stringify(value)} to match object ${JSON.stringify(actual)}`);
		},
		toContain(fragment: string): void {
			assert.equal(typeof actual, "string");
			assert.ok((actual as string).includes(fragment), `expected "${actual}" to contain "${fragment}"`);
		},
	};
}

function responseHeaders(values: Record<string, string> = {}) {
	const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
	return { get: (name: string) => normalized.get(name.toLowerCase()) ?? null };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: responseHeaders(headers),
		json: async () => body,
	};
}

function invalidJsonResponse(status = 200): FetchResponseLike {
	return {
		ok: true,
		status,
		headers: responseHeaders(),
		json: async () => { throw new Error("bad json"); },
	};
}

function tempFile(name: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-bars-test-"));
	return path.join(directory, name);
}

const endpoints: UsageEndpoints = {
	zai: "https://api.z.ai/usage",
	zaiCn: "https://open.bigmodel.cn/usage",
	kimi: "https://api.kimi.test/usages",
	minimax: "https://api.minimax.test/v1/token_plan/remains",
	minimaxLegacy: "https://api.minimax.test/v1/api/openplatform/coding_plan/remains",
	minimaxCn: "https://api.minimaxi.test/v1/token_plan/remains",
	minimaxCnLegacy: "https://api.minimaxi.test/v1/api/openplatform/coding_plan/remains",
	openRouterCredits: "https://openrouter.test/api/v1/credits",
	openRouterKey: "https://openrouter.test/api/v1/key",
	deepSeekBalance: "https://api.deepseek.test/user/balance",
	moonshotBalance: "https://api.moonshot.test/v1/users/me/balance",
	moonshotCnBalance: "https://api.moonshot-cn.test/v1/users/me/balance",
};

describe("formatting and parsing", () => {
	it("formats durations and reset dates", () => {
		expect(formatDuration(0)).toBe("now");
		expect(formatDuration(30)).toBe("<1m");
		expect(formatDuration(3660)).toBe("1h 1m");
		expect(formatDuration(90000)).toBe("1d 1h");

		const now = Date.parse("2026-02-18T12:00:00.000Z");
		expect(formatResetsAt("2026-02-18T13:30:00.000Z", now)).toBe("1h 30m");
		expect(formatResetsAt("invalid", now)).toBe("");
	});

	it("parses retry-after values", () => {
		const now = Date.parse("2026-02-18T12:00:00.000Z");
		expect(parseRetryAfterMs("120", now)).toBe(120000);
		expect(parseRetryAfterMs("2026-02-18T12:05:00.000Z", now)).toBe(300000);
		expect(parseRetryAfterMs("bad", now)).toBeNull();
	});

	it("parses percentages and clamps display values", () => {
		expect(readPercentCandidate(0.37)).toBe(37);
		expect(readPercentCandidate(1)).toBe(1);
		expect(readPercentCandidate(99)).toBe(99);
		expect(readPercentCandidate(101)).toBeNull();
		expect(readLimitPercent({ utilization: 44 })).toBe(44);
		expect(readLimitPercent({ currentValue: 30, remaining: 70 })).toBe(30);
		expect(clampPercent(1000)).toBe(100);
		expect(colorForPercent(69)).toBe("success");
		expect(colorForPercent(70)).toBe("warning");
		expect(colorForPercent(90)).toBe("error");
	});

	it("extracts generic usage payloads", () => {
		expect(extractUsageFromPayload({
			data: { limits: [
				{ type: "TIME_LIMIT", usage_percent: 25 },
				{ type: "TOKENS_LIMIT", currentValue: 20, remaining: 80 },
			] },
		})).toEqual({ session: 25, weekly: 20 });

		expect(extractUsageFromPayload({
			rate_limit: {
				primary_window: { used_percent: 35 },
				secondary_window: { used_percent: 45 },
			},
		})).toEqual({ session: 35, weekly: 45 });
		expect(extractUsageFromPayload({ nope: true })).toBeNull();
	});
});

describe("current Pi provider compatibility", () => {
	it("detects supported current providers", () => {
		expect(detectProvider({ provider: "openai-codex" })).toBe("codex");
		expect(detectProvider({ provider: "anthropic" })).toBe("claude");
		expect(detectProvider({ provider: "zai" })).toBe("zai");
		expect(detectProvider({ provider: "zai-coding-cn" })).toBe("zai-cn");
		expect(detectProvider({ provider: "kimi-coding" })).toBe("kimi");
		expect(detectProvider({ provider: "minimax" })).toBe("minimax");
		expect(detectProvider({ provider: "minimax-cn" })).toBe("minimax-cn");
		expect(detectProvider({ provider: "openrouter" })).toBe("openrouter");
		expect(detectProvider({ provider: "deepseek" })).toBe("deepseek");
		expect(detectProvider({ provider: "moonshotai" })).toBe("moonshot");
		expect(detectProvider({ provider: "moonshotai-cn" })).toBe("moonshot-cn");
		expect(detectProvider({ provider: "google-gemini-cli" })).toBeNull();
		expect(detectProvider({ provider: "google-antigravity" })).toBeNull();
	});

	it("maps usage keys to Pi provider IDs", () => {
		expect(providerToPiProviderId("codex")).toBe("openai-codex");
		expect(providerToPiProviderId("claude")).toBe("anthropic");
		expect(providerToPiProviderId("zai-cn")).toBe("zai-coding-cn");
		expect(providerToPiProviderId("kimi")).toBe("kimi-coding");
		expect(providerToPiProviderId("minimax")).toBe("minimax");
		expect(providerToPiProviderId("minimax-cn")).toBe("minimax-cn");
		expect(providerToPiProviderId("openrouter")).toBe("openrouter");
		expect(providerToPiProviderId("deepseek")).toBe("deepseek");
		expect(providerToPiProviderId("moonshot")).toBe("moonshotai");
		expect(providerToPiProviderId("moonshot-cn")).toBe("moonshotai-cn");
	});

	it("resolves global and China endpoint overrides", () => {
		expect(resolveUsageEndpoints({
			PI_ZAI_USAGE_ENDPOINT: "https://global.example/usage",
			PI_ZAI_CODING_CN_USAGE_ENDPOINT: "https://cn.example/usage",
			PI_KIMI_USAGE_ENDPOINT: "https://kimi.example/usage",
			PI_MINIMAX_USAGE_ENDPOINT: "https://minimax.example/usage",
			PI_MINIMAX_LEGACY_USAGE_ENDPOINT: "https://minimax.example/legacy",
			PI_MINIMAX_CN_USAGE_ENDPOINT: "https://minimax-cn.example/usage",
			PI_MINIMAX_CN_LEGACY_USAGE_ENDPOINT: "https://minimax-cn.example/legacy",
			PI_OPENROUTER_CREDITS_ENDPOINT: "https://openrouter.example/credits",
			PI_OPENROUTER_KEY_ENDPOINT: "https://openrouter.example/key",
			PI_DEEPSEEK_BALANCE_ENDPOINT: "https://deepseek.example/balance",
			PI_MOONSHOT_BALANCE_ENDPOINT: "https://moonshot.example/balance",
			PI_MOONSHOT_CN_BALANCE_ENDPOINT: "https://moonshot-cn.example/balance",
		} as NodeJS.ProcessEnv)).toEqual({
			zai: "https://global.example/usage",
			zaiCn: "https://cn.example/usage",
			kimi: "https://kimi.example/usage",
			minimax: "https://minimax.example/usage",
			minimaxLegacy: "https://minimax.example/legacy",
			minimaxCn: "https://minimax-cn.example/usage",
			minimaxCnLegacy: "https://minimax-cn.example/legacy",
			openRouterCredits: "https://openrouter.example/credits",
			openRouterKey: "https://openrouter.example/key",
			deepSeekBalance: "https://deepseek.example/balance",
			moonshotBalance: "https://moonshot.example/balance",
			moonshotCnBalance: "https://moonshot-cn.example/balance",
		});
	});
});

describe("provider fetchers", () => {
	it("fetches Codex usage and handles HTTP/JSON failures", async () => {
		const usage = await fetchCodexUsage("token", {
			fetchFn: async () => jsonResponse(200, {
				rate_limit: {
					primary_window: { used_percent: 42, reset_after_seconds: 120 },
					secondary_window: { used_percent: 73, reset_after_seconds: 240 },
				},
			}),
		});
		expect(usage).toMatchObject({ session: 42, weekly: 73, sessionResetsIn: "2m", weeklyResetsIn: "4m" });

		const teamUsage = await fetchCodexUsage("token", {
			fetchFn: async () => jsonResponse(200, {
				plan_type: "team",
				rate_limit: {
					primary_window: {
						used_percent: 72,
						limit_window_seconds: 604800,
						reset_after_seconds: 573719,
					},
					secondary_window: null,
				},
			}),
		});
		expect(teamUsage).toMatchObject({
			session: 0,
			weekly: 72,
			sessionHidden: true,
			weeklyResetsIn: "6d 15h",
		});
		expect(teamUsage.weeklyHidden).toBeUndefined();
		expect(teamUsage.sessionResetsIn).toBeUndefined();

		expect((await fetchCodexUsage("token", { fetchFn: async () => jsonResponse(401, {}) })).error).toBe("HTTP 401");
		expect((await fetchCodexUsage("token", { fetchFn: async () => invalidJsonResponse() })).error).toBe("invalid JSON response");
	});

	it("fetches Claude OAuth usage with extra spend", async () => {
		const usage = await fetchClaudeUsage("token", {
			fetchFn: async () => jsonResponse(200, {
				five_hour: { utilization: 55, resets_at: "2026-02-18T13:00:00.000Z" },
				seven_day: { utilization: 22, resets_at: "2026-02-19T13:00:00.000Z" },
				extra_usage: { is_enabled: true, used_credits: 7.5, monthly_limit: 20 },
			}),
		});
		expect(usage).toMatchObject({ session: 55, weekly: 22, extraSpend: 7.5, extraLimit: 20 });
	});

	it("returns stale cached Claude usage during a 429 cooldown", async () => {
		const cacheFile = tempFile("claude-cache.json");
		const first = await fetchClaudeUsageWithFallback("token", {
			cacheFile,
			nowMs: Date.parse("2026-02-18T12:00:00.000Z"),
			fetchFn: async () => jsonResponse(200, {
				five_hour: { utilization: 45, resets_at: "2026-02-18T13:00:00.000Z" },
				seven_day: { utilization: 12, resets_at: "2026-02-20T12:00:00.000Z" },
			}),
		});
		expect(first).toMatchObject({ session: 45, weekly: 12 });

		const second = await fetchClaudeUsageWithFallback("token", {
			cacheFile,
			nowMs: Date.parse("2026-02-18T12:10:00.000Z"),
			fetchFn: async () => jsonResponse(429, {}, { "retry-after": "0" }),
		});
		expect(second).toMatchObject({ session: 45, weekly: 12, stale: true });
		expect(second.warning ?? "").toContain("retry in");
	});

	it("shares a fresh Claude cache across concurrent callers", async () => {
		const cacheFile = tempFile("shared-cache.json");
		let calls = 0;
		const fetchFn: FetchLike = async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 50));
			return jsonResponse(200, { five_hour: { utilization: 52 }, seven_day: { utilization: 28 } });
		};
		const config = {
			cacheFile,
			nowMs: Date.parse("2026-02-18T12:00:00.000Z"),
			fetchFn,
		};
		const [one, two] = await Promise.all([
			fetchClaudeUsageWithFallback("token", config),
			fetchClaudeUsageWithFallback("token", config),
		]);
		expect(calls).toBe(1);
		expect(one).toMatchObject({ session: 52, weekly: 28 });
		expect(two).toMatchObject({ session: 52, weekly: 28 });
	});

	it("parses and fetches Kimi For Coding quota windows", async () => {
		const payload = {
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
		};
		expect(extractKimiUsageFromPayload(payload)).toMatchObject({
			session: 25,
			weekly: 25,
			sessionLabel: "5-hour",
			weeklyLabel: "Weekly",
		});

		let requestHeaders: HeadersInit | undefined;
		const usage = await fetchKimiUsage("sk-kimi-test", {
			endpoints,
			fetchFn: async (url, init) => {
				expect(url).toBe(endpoints.kimi);
				requestHeaders = init?.headers;
				return jsonResponse(200, payload);
			},
		});
		expect(usage).toMatchObject({ session: 25, weekly: 25 });
		assert.ok(matchObject(requestHeaders, { Authorization: "Bearer sk-kimi-test", "User-Agent": "KimiCLI/1.5" }));
	});

	it("parses MiniMax model-remains and multi-service responses", () => {
		const now = Date.parse("2026-02-18T12:00:00.000Z");
		const modelRemains = extractMiniMaxUsageFromPayload({ data: { model_remains: [{
			model_name: "MiniMax-M2",
			current_interval_total_count: "100",
			current_interval_usage_count: "60",
			end_time: (now + 3600000) / 1000,
			current_weekly_total_count: 1000,
			current_weekly_usage_count: 750,
			weekly_end_time: (now + 86400000) / 1000,
		}] } }, now);
		expect(modelRemains).toMatchObject({
			session: 40,
			weekly: 25,
			sessionLabel: "Interval",
			weeklyHidden: false,
			sessionResetsIn: "1h",
			weeklyResetsIn: "1d",
		});

		expect(extractMiniMaxUsageFromPayload({ data: { services: [
			{ service_type: "standard", window_type: "rolling", usage: 30, limit: 100 },
			{ service_type: "standard", window_type: "weekly", percent: "45" },
			{ service_type: "highspeed", window_type: "rolling", percent: 55 },
		] } })).toMatchObject({ session: 55, weekly: 45, weeklyHidden: false });
	});

	it("uses separate MiniMax Global and China endpoints with legacy fallback", async () => {
		const urls: string[] = [];
		const fetchFn: FetchLike = async (url) => {
			urls.push(url);
			if (url.endsWith("token_plan/remains")) return jsonResponse(404, {});
			return jsonResponse(200, { data: { model_remains: [{
				current_interval_remaining_percent: 80,
				current_weekly_remaining_percent: 70,
			}] } });
		};
		expect(await fetchMiniMaxUsage("global", "minimax", { endpoints, fetchFn })).toMatchObject({
			session: 20,
			weekly: 30,
		});
		expect(await fetchMiniMaxUsage("china", "minimax-cn", { endpoints, fetchFn })).toMatchObject({
			session: 20,
			weekly: 30,
		});
		expect(urls).toEqual([
			endpoints.minimax,
			endpoints.minimaxLegacy,
			endpoints.minimaxCn,
			endpoints.minimaxCnLegacy,
		]);
	});

	it("renders a MiniMax Credits-only key as a balance without manufacturing quota", async () => {
		const usage = await fetchMiniMaxUsage("credits-only", "minimax", {
			endpoints: { ...endpoints, minimaxLegacy: endpoints.minimax },
			fetchFn: async () => jsonResponse(200, {
				base_resp: { status_code: 2062, status_msg: "no active token plan subscription" },
				data: { points_balance: "5000" },
			}),
		});
		expect(usage).toMatchObject({
			session: 0,
			weekly: 0,
			quotaHidden: true,
			accountBalance: { amount: 5000, unit: "credits", label: "Credit balance" },
		});
		expect(usage.error).toBeUndefined();
	});

	it("treats MiniMax status 2062 as an account state rather than an API error", async () => {
		const usage = await fetchMiniMaxUsage("empty", "minimax", {
			endpoints: { ...endpoints, minimaxLegacy: endpoints.minimax },
			fetchFn: async () => jsonResponse(200, {
				base_resp: { status_code: 2062, status_msg: "no active token plan subscription" },
			}),
		});
		expect(usage).toMatchObject({
			session: 0,
			weekly: 0,
			quotaHidden: true,
			notice: "No active Token Plan · check Credit balance in the MiniMax console",
		});
		expect(usage.error).toBeUndefined();
	});

	it("hides MiniMax weekly quota when the API does not supply it", () => {
		expect(extractMiniMaxUsageFromPayload({ data: { model_remains: [{
			current_interval_total_count: 100,
			current_interval_usage_count: 25,
			current_weekly_total_count: 0,
			current_weekly_usage_count: 0,
			current_weekly_remaining_percent: 100,
			current_weekly_status: 3,
		}] } })).toMatchObject({ session: 75, weekly: 0, weeklyHidden: true });
	});

	it("parses OpenRouter balance and spend without manufacturing a percentage", () => {
		const usage = extractOpenRouterUsageFromPayloads(
			{ data: { total_credits: 50, total_usage: 12.345678 } },
			{ data: {
				limit: null,
				limit_remaining: null,
				usage: 9,
				usage_daily: 0.25,
				usage_weekly: 1.5,
				usage_monthly: 4.75,
			} },
		);
		expect(usage).toMatchObject({
			session: 0,
			weekly: 0,
			quotaHidden: true,
			accountBalance: { amount: 37.654322, unit: "USD", label: "Balance" },
			accountSpend: { unit: "USD", daily: 0.25, weekly: 1.5, monthly: 4.75, lifetime: 9 },
		});
	});

	it("renders an OpenRouter per-key credit limit as a real usage bar", () => {
		expect(extractOpenRouterUsageFromPayloads(undefined, { data: {
			limit: 20,
			limit_remaining: 5,
			usage: 15,
			usage_daily: 1,
			usage_weekly: 3,
			usage_monthly: 7,
		} })).toMatchObject({
			session: 75,
			quotaHidden: false,
			weeklyHidden: true,
			sessionLabel: "Key limit",
		});
	});

	it("fetches both OpenRouter APIs and tolerates one unavailable endpoint", async () => {
		const urls: string[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			urls.push(url);
			assert.ok(matchObject(init?.headers, { Authorization: "Bearer sk-or-test" }));
			if (url === endpoints.openRouterCredits) {
				return jsonResponse(200, { data: { total_credits: 25, total_usage: 5 } });
			}
			return jsonResponse(503, {});
		};
		const usage = await fetchOpenRouterUsage("sk-or-test", { endpoints, fetchFn });
		expect(usage).toMatchObject({
			quotaHidden: true,
			accountBalance: { amount: 20, unit: "USD" },
		});
		expect([...urls].sort()).toEqual([endpoints.openRouterCredits, endpoints.openRouterKey].sort());
	});

	it("parses and fetches DeepSeek balance components", async () => {
		const payload = {
			is_available: true,
			balance_infos: [{
				currency: "CNY",
				total_balance: "110.00",
				granted_balance: "10.00",
				topped_up_balance: "100.00",
			}],
		};
		expect(extractDeepSeekBalanceFromPayload(payload)).toMatchObject({
			quotaHidden: true,
			accountBalance: { amount: 110, unit: "CNY", label: "Total balance" },
			accountBalanceDetails: [
				{ amount: 100, unit: "CNY", label: "Topped up" },
				{ amount: 10, unit: "CNY", label: "Granted" },
			],
		});

		const usage = await fetchDeepSeekBalance("deepseek-key", {
			endpoints,
			fetchFn: async (url, init) => {
				expect(url).toBe(endpoints.deepSeekBalance);
				assert.ok(matchObject(init?.headers, { Authorization: "Bearer deepseek-key" }));
				return jsonResponse(200, payload);
			},
		});
		expect(usage.accountBalance?.amount).toBe(110);
	});

	it("parses and routes Moonshot Global and China balances", async () => {
		const payload = { code: 0, data: {
			available_balance: 49.58894,
			voucher_balance: 46.58893,
			cash_balance: 3.00001,
		} };
		expect(extractMoonshotBalanceFromPayload(payload, "moonshot")).toMatchObject({
			quotaHidden: true,
			accountBalance: { amount: 49.58894, unit: "USD", label: "Available balance" },
			accountBalanceDetails: [
				{ amount: 3.00001, unit: "USD", label: "Cash" },
				{ amount: 46.58893, unit: "USD", label: "Voucher" },
			],
		});
		expect(extractMoonshotBalanceFromPayload(payload, "moonshot-cn")?.accountBalance?.unit).toBe("CNY");

		const urls: string[] = [];
		const fetchFn: FetchLike = async (url) => {
			urls.push(url);
			return jsonResponse(200, payload);
		};
		await fetchMoonshotBalance("global", "moonshot", { endpoints, fetchFn });
		await fetchMoonshotBalance("china", "moonshot-cn", { endpoints, fetchFn });
		expect(urls).toEqual([endpoints.moonshotBalance, endpoints.moonshotCnBalance]);
	});

	it("warns when a financial balance is unavailable or exhausted", () => {
		expect(extractDeepSeekBalanceFromPayload({
			is_available: false,
			balance_infos: [{ currency: "USD", total_balance: "0" }],
		})?.warning ?? "").toContain("not currently available");
		expect(extractMoonshotBalanceFromPayload({
			data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 },
		})?.warning ?? "").toContain("exhausted");
	});

	it("parses ZAI unit-based limits", () => {
		const now = Date.now();
		const usage = extractZaiUsageFromPayload({ data: { limits: [
			{ type: "TOKENS_LIMIT", unit: 3, percentage: 29, nextResetTime: now + 3600000 },
			{ type: "TOKENS_LIMIT", unit: 6, percentage: 5, nextResetTime: now + 86400000 },
		] } }, now);
		expect(usage).toMatchObject({ session: 29, weekly: 5 });
	});

	it("parses credit-based ZAI plan limits", () => {
		const now = Date.now();
		const usage = extractZaiUsageFromPayload({ data: { limits: [
			{ type: "CREDIT_LIMIT", unit: 3, percentage: 42, nextResetTime: now + 3600000 },
			{ type: "CREDIT_LIMIT", unit: 6, percentage: 17, nextResetTime: now + 86400000 },
		] } }, now);
		expect(usage).toMatchObject({
			session: 42,
			weekly: 17,
			sessionResetsIn: "1h",
			weeklyResetsIn: "1d",
		});
	});

	it("uses separate ZAI Global and China endpoints", async () => {
		const urls: string[] = [];
		const fetchFn: FetchLike = async (url) => {
			urls.push(url);
			return jsonResponse(200, { data: { limits: [
				{ type: "TOKENS_LIMIT", unit: 3, percentage: 20 },
				{ type: "TOKENS_LIMIT", unit: 6, percentage: 40 },
			] } });
		};
		await fetchZaiUsage("global", "zai", { endpoints, fetchFn });
		await fetchZaiUsage("china", "zai-cn", { endpoints, fetchFn });
		expect(urls).toEqual([endpoints.zai, endpoints.zaiCn]);
	});

	it("cancels requests through an external signal", async () => {
		const controller = new AbortController();
		const fetchFn: FetchLike = async (_url, init) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
		});
		const pending = fetchCodexUsage("token", { fetchFn, signal: controller.signal, timeoutMs: 0 });
		controller.abort();
		expect((await pending).error).toBe("request cancelled");
	});
});

describe("all-provider orchestration", () => {
	it("hides the expected Moonshot regional failure for Pi's shared environment key", async () => {
		const fetchFn: FetchLike = async (url) => url === endpoints.moonshotBalance
			? jsonResponse(200, { data: { available_balance: 12, voucher_balance: 2, cash_balance: 10 } })
			: jsonResponse(401, {});
		const usage = await fetchAllUsages(
			{ moonshot: "shared", "moonshot-cn": "shared" },
			{ endpoints, fetchFn },
		);
		expect(usage.moonshot?.accountBalance?.amount).toBe(12);
		expect(usage["moonshot-cn"]).toBeNull();
	});

	it("fetches configured providers and leaves missing providers hidden", async () => {
		const fetchFn: FetchLike = async (url) => {
			if (url.includes("chatgpt.com")) {
				return jsonResponse(200, { rate_limit: {
					primary_window: { used_percent: 11 },
					secondary_window: { used_percent: 22 },
				} });
			}
			if (url.includes("anthropic")) {
				return jsonResponse(200, { five_hour: { utilization: 33 }, seven_day: { utilization: 44 } });
			}
			return jsonResponse(200, { data: { limits: [
				{ type: "TOKENS_LIMIT", unit: 3, percentage: 55 },
				{ type: "TOKENS_LIMIT", unit: 6, percentage: 66 },
			] } });
		};

		const usage = await fetchAllUsages(
			{ codex: "a", claude: "b", "zai-cn": "c" },
			{ endpoints, fetchFn, cacheFile: tempFile("all-cache.json") },
		);
		expect(usage.codex).toMatchObject({ session: 11, weekly: 22 });
		expect(usage.claude).toMatchObject({ session: 33, weekly: 44 });
		expect(usage.zai).toBeNull();
		expect(usage["zai-cn"]).toMatchObject({ session: 55, weekly: 66 });
	});
});
