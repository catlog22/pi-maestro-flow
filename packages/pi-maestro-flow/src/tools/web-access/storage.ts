import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtractedContent } from "./extract.ts";
import type { SearchResult } from "./perplexity.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
export const MAX_STORED_RESULTS = 50;

export interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
}

export interface StoredSearchData {
	id: string;
	type: "search" | "fetch" | "research";
	timestamp: number;
	queries?: QueryResultData[];
	urls?: ExtractedContent[];
	artifact?: unknown;
}

const storedResults = new Map<string, StoredSearchData>();

function isFresh(data: StoredSearchData, now: number): boolean {
	return now - data.timestamp < CACHE_TTL_MS;
}

function pruneResults(now = Date.now()): void {
	for (const [id, data] of storedResults) {
		if (!isFresh(data, now)) storedResults.delete(id);
	}
	while (storedResults.size > MAX_STORED_RESULTS) {
		const oldest = storedResults.keys().next();
		if (oldest.done) break;
		storedResults.delete(oldest.value);
	}
}

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
	const now = Date.now();
	pruneResults(now);
	if (!isFresh(data, now)) return;
	storedResults.delete(id);
	storedResults.set(id, data);
	pruneResults(now);
}

export function getResult(id: string): StoredSearchData | null {
	const data = storedResults.get(id);
	if (!data) return null;
	if (!isFresh(data, Date.now())) {
		storedResults.delete(id);
		return null;
	}
	storedResults.delete(id);
	storedResults.set(id, data);
	return data;
}

export function getAllResults(): StoredSearchData[] {
	pruneResults();
	return Array.from(storedResults.values());
}

export function deleteResult(id: string): boolean {
	return storedResults.delete(id);
}

export function clearResults(): void {
	storedResults.clear();
}

function isValidStoredData(data: unknown): data is StoredSearchData {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id) return false;
	if (d.type !== "search" && d.type !== "fetch" && d.type !== "research") return false;
	if (typeof d.timestamp !== "number") return false;
	if (d.type === "search" && !Array.isArray(d.queries)) return false;
	if (d.type === "fetch" && !Array.isArray(d.urls)) return false;
	if (d.type === "research" && (!d.artifact || typeof d.artifact !== "object")) return false;
	return true;
}

export function restoreFromSession(ctx: ExtensionContext): void {
	storedResults.clear();
	const now = Date.now();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "web-search-results") {
			const data = entry.data;
			if (isValidStoredData(data) && isFresh(data, now)) {
				storeResult(data.id, data);
			}
		}
	}
}
