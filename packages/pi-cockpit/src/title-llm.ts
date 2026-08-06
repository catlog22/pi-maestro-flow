// LLM session-title generation through an OpenAI-compatible endpoint.
//
// The model is resolved via pi's ModelRegistry — the same providers the
// `/api-manager` command manages (baseUrl + apiKey + model list in
// ~/.pi/agent/models.json). Pi's extension API has no direct LLM query
// surface, so we build the request ourselves; the rule-based suggestTitle()
// remains the offline fallback when no generationModel is configured or the
// call fails. Titles must be short — a tab has no room for prose.

import { cleanTitle } from "./title-gen.ts";

export interface TitleLlmDeps {
	/** Provider base URL, e.g. "https://hub.linux.do/v1". */
	baseUrl: string;
	/** Model id sent in the request body (the API-side id, not the display name). */
	modelId: string;
	apiKey?: string;
	/**
	 * Extra auth headers resolved by the ModelRegistry. Values may be null
	 * (Pi 0.84 ProviderHeaders deletion markers); null entries are filtered
	 * before the request is built so fetch never stringifies them.
	 */
	headers?: Record<string, string | null>;
}

export const TITLE_PROMPT = `Generate a very short, concrete title (2-4 words, at most 20 characters) capturing the main topic of this coding session. Output an objective noun phrase, not a sentence. Never use first or second person (no "I", "we", "my", "you", "我们", "我", "你"); the title must not read like a spoken instruction. Sentence case: capitalize only the first word and proper nouns. Titles must be short enough to fit a terminal tab.

Return JSON with a single "title" field. Output only the JSON object — no reasoning, no extra text.

Good examples:
{"title": "Fix login button"}
{"title": "Add OAuth"}
{"title": "Debug CI tests"}
{"title": "Refactor API client"}
{"title": "终端标题实现分析"}

Bad (first person / sentence): {"title": "We analyze the login flow"}
Bad (spoken instruction): {"title": "帮我分析终端标题"}
Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the login button issue on mobile devices"}`;

/** Build the LLM request body — exposed for tests. */
export function buildTitleRequestBody(modelId: string, text: string): string {
	return JSON.stringify({
		model: modelId,
		messages: [
			{ role: "system", content: TITLE_PROMPT },
			{ role: "user", content: text.slice(0, 2_000) },
		],
		temperature: 0.7,
		// deepseek-style reasoning models burn the whole budget on thinking before
		// emitting content (first try: finish_reason "length", empty content at
		// 40 and 256 tokens). Turning reasoning off makes them answer directly
		// with a fraction of the cost; OpenAI-compatible endpoints ignore the
		// unknown `thinking` field, and a strict backend failing just falls back.
		thinking: { type: "disabled" },
		max_tokens: 512,
	});
}

/**
 * Parse a chat-completions response into a title. Tolerates strict JSON,
 * code-fenced JSON, and bare `{"title": "..."}` substrings so every
 * OpenAI-compatible backend works without response_format.
 */
export function parseTitleResponse(body: unknown): string | null {
	let content: string | undefined;
	if (typeof body === "object" && body !== null) {
		const obj = body as Record<string, unknown>;
		const choices = Array.isArray(obj.choices) ? obj.choices : [];
		const first = choices[0] as Record<string, unknown> | undefined;
		const message = first && typeof first === "object" ? (first.message as Record<string, unknown>) : undefined;
		if (message && typeof message.content === "string") content = message.content;
	}
	if (!content) return null;
	const trimmed = content.trim();
	// Strip optional markdown fences.
	const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		const parsed = JSON.parse(unfenced) as unknown;
		if (typeof parsed === "object" && parsed !== null) {
			const title = (parsed as Record<string, unknown>).title;
			if (typeof title === "string" && title.trim()) return title.trim();
		}
	} catch {
		// fall through to the substring scan
	}
	const match = /"title"\s*:\s*"([^"]+)"/.exec(unfenced);
	return match && match[1].trim() ? match[1].trim() : null;
}

/**
 * Generate a title by calling `POST {baseUrl}/chat/completions`. Returns null
 * on any failure (network, auth, parse) so the caller can fall back.
 */
/**
 * Drop null header values (Pi 0.84 ProviderHeaders deletion markers). Mirrors
 * the pi SDK's own null filtering before a request is built; exposed for tests.
 */
export function filterNullHeaders(
	headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers).filter(
		(entry): entry is [string, string] => entry[1] !== null,
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Generate a title by calling `POST {baseUrl}/chat/completions`. Returns null
 * on any failure (network, auth, parse) so the caller can fall back.
 */
export async function generateTitleWithModel(
	deps: TitleLlmDeps,
	text: string,
	signal: AbortSignal,
): Promise<string | null> {
	try {
		const base = deps.baseUrl.replace(/\/+$/, "");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}),
				...filterNullHeaders(deps.headers),
			},
			body: buildTitleRequestBody(deps.modelId, text),
			signal,
		});
		if (!res.ok) return null;
		const title = parseTitleResponse(await res.json());
		return title ? cleanTitle(title) : null;
	} catch {
		return null;
	}
}
