import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import net, { type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { getWebSearchConfigPath } from "./utils.ts";

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_REPLAY_BODY_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// IANA special-purpose address registries, plus multicast and deprecated site-local IPv6.
// These are denied as non-general-purpose destinations unless allowRanges explicitly exempts them.
const SPECIAL_PURPOSE_IPV4_RANGES = parseStaticRanges([
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.31.196.0/24",
	"192.52.193.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"192.175.48.0/24",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
]);
const GLOBALLY_ROUTABLE_IPV6_RANGES = parseStaticRanges(["2000::/3"]);
const SPECIAL_PURPOSE_IPV6_RANGES = parseStaticRanges([
	"::/96",
	"::ffff:0:0/96",
	"64:ff9b::/96",
	"64:ff9b:1::/48",
	"100::/64",
	"2001::/23",
	"2001:db8::/32",
	"2002::/16",
	"2620:4f:8000::/48",
	"3fff::/20",
	"5f00::/16",
	"fc00::/7",
	"fe80::/10",
	"fec0::/10",
	"ff00::/8",
]);
const REQUEST_BODY_HEADERS = [
	"content-encoding",
	"content-language",
	"content-length",
	"content-location",
	"content-type",
	"transfer-encoding",
];
const CROSS_ORIGIN_SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-api-key"];

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;
type Fetch = typeof fetch;

const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

export interface SsrfConfig {
	allowRanges: string[];
	trustEnvProxy: boolean;
}

export interface DomainPolicy {
	allow: string[];
	deny: string[];
}

const DEFAULT_DOMAIN_POLICY: DomainPolicy = { allow: [], deny: [] };

export function loadFetchContentDomainPolicy(): DomainPolicy {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return { ...DEFAULT_DOMAIN_POLICY };
	let raw: string;
	try {
		raw = readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8");
	} catch {
		return { ...DEFAULT_DOMAIN_POLICY };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ...DEFAULT_DOMAIN_POLICY };
	}
	const fetchContent = (parsed as { fetchContent?: unknown }).fetchContent;
	if (fetchContent === undefined || fetchContent === null) return { ...DEFAULT_DOMAIN_POLICY };
	if (typeof fetchContent !== "object" || Array.isArray(fetchContent)) {
		throw new Error(`fetchContent in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const policy = (fetchContent as { domainPolicy?: unknown }).domainPolicy;
	if (policy === undefined || policy === null) return { ...DEFAULT_DOMAIN_POLICY };
	if (typeof policy !== "object" || Array.isArray(policy)) {
		throw new Error(`fetchContent.domainPolicy in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const config = policy as { allow?: unknown; deny?: unknown };
	return {
		allow: parseDomainEntries(config.allow, "allow"),
		deny: parseDomainEntries(config.deny, "deny"),
	};
}

function parseDomainEntries(value: unknown, field: "allow" | "deny"): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new Error(`fetchContent.domainPolicy.${field} in ${WEB_SEARCH_CONFIG_PATH} must be an array of hostnames`);
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string") {
			throw new Error(`fetchContent.domainPolicy.${field} in ${WEB_SEARCH_CONFIG_PATH} must contain only hostnames; entry ${index + 1} is ${typeof entry}`);
		}
		const hostname = normalizeDomainEntry(entry);
		if (!hostname) {
			throw new Error(`fetchContent.domainPolicy.${field} in ${WEB_SEARCH_CONFIG_PATH} contains an invalid hostname: ${JSON.stringify(entry)}`);
		}
		return hostname;
	});
}

function normalizeDomainEntry(entry: string): string | null {
	const hostname = normalizeHostname(entry.trim());
	if (!hostname || /\s|[\\/?:#@]/.test(hostname)) return null;
	if (net.isIP(hostname)) return hostname;
	if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname)) return null;
	return hostname;
}

export function loadSsrfConfig(): SsrfConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return { allowRanges: [], trustEnvProxy: false };
	let raw: string;
	try {
		raw = readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8");
	} catch {
		return { allowRanges: [], trustEnvProxy: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { allowRanges: [], trustEnvProxy: false };
	}
	const ssrf = (parsed as { ssrf?: unknown }).ssrf;
	if (ssrf === undefined || ssrf === null) return { allowRanges: [], trustEnvProxy: false };
	if (typeof ssrf !== "object" || Array.isArray(ssrf)) {
		throw new Error(`ssrf in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const config = ssrf as { allowRanges?: unknown; trustEnvProxy?: unknown };
	if (config.allowRanges !== undefined && config.allowRanges !== null && !Array.isArray(config.allowRanges)) {
		throw new Error(`ssrf.allowRanges in ${WEB_SEARCH_CONFIG_PATH} must be an array of CIDR strings`);
	}
	if (config.trustEnvProxy !== undefined && typeof config.trustEnvProxy !== "boolean") {
		throw new Error(`ssrf.trustEnvProxy in ${WEB_SEARCH_CONFIG_PATH} must be a boolean`);
	}
	const allowRangesValue: unknown[] = Array.isArray(config.allowRanges) ? config.allowRanges : [];
	const allowRanges = allowRangesValue.map((entry, index) => {
		if (typeof entry !== "string") {
			throw new Error(`ssrf.allowRanges in ${WEB_SEARCH_CONFIG_PATH} must contain only CIDR strings; entry ${index + 1} is ${typeof entry}`);
		}
		return entry.trim();
	}).filter(Boolean);
	parseAllowRanges(allowRanges);
	return { allowRanges, trustEnvProxy: config.trustEnvProxy === true };
}

interface ValidationOptions {
	lookup?: Lookup;
	/** Optional hostname policy for fetch_content target URLs. */
	domainPolicy?: DomainPolicy;
	/**
	 * CIDR ranges (e.g. "198.18.0.0/15") to exempt from the SSRF guard.
	 * Useful when a host runs a TUN/fake-IP proxy (Surge, Clash, Mihomo, ...)
	 * that resolves public domains into a reserved range. Entries are validated
	 * strictly; an invalid entry throws so misconfiguration is not silent.
	 */
	allowRanges?: string[];
	/**
	 * Retained for configuration compatibility. Environment proxy variables do
	 * not bypass DNS validation because this transport does not configure or
	 * validate a proxy itself.
	 */
	trustEnvProxy?: boolean;
}

/** Parsed entry from `allowRanges`: a network address (4 or 16 bytes) + prefix length. */
interface ParsedCidr {
	bytes: Uint8Array;
	prefix: number;
}

interface FetchRemoteOptions extends ValidationOptions {
	/** Test seam; production requests use the pinned built-in HTTP(S) transport. */
	fetch?: Fetch;
	maxRedirects?: number;
	maxReplayBodyBytes?: number;
}

interface ValidatedRemoteTarget {
	url: URL;
	addresses: LookupAddress[];
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
	return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function validateRemoteUrl(rawUrl: string | URL, options: ValidationOptions = {}): Promise<URL> {
	return (await resolveRemoteTarget(rawUrl, options)).url;
}

async function resolveRemoteTarget(rawUrl: string | URL, options: ValidationOptions): Promise<ValidatedRemoteTarget> {
	const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
	}

	const hostname = normalizeHostname(url.hostname);
	if (!hostname) throw new Error("URL must include a hostname");
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error(`Blocked internal hostname: ${hostname}`);
	}

	const allowRanges = parseAllowRanges(options.allowRanges);
	assertDomainPolicy(hostname, options.domainPolicy);

	const literalFamily = net.isIP(hostname);
	if (literalFamily) {
		assertPublicAddress(hostname, hostname, allowRanges);
		return { url, addresses: [{ address: hostname, family: literalFamily }] };
	}

	let resolved: LookupAddress[];
	try {
		resolved = await (options.lookup ?? defaultLookup)(hostname);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to resolve ${hostname}: ${message}`);
	}

	if (resolved.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	const addresses = resolved.map(({ address }) => {
		assertPublicAddress(address, hostname, allowRanges);
		return { address: normalizeHostname(address), family: net.isIP(normalizeHostname(address)) };
	});
	return { url, addresses };
}

export async function fetchRemoteUrl(
	url: string | URL,
	init: RequestInit = {},
	options: FetchRemoteOptions = {},
): Promise<Response> {
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const maxReplayBodyBytes = options.maxReplayBodyBytes ?? DEFAULT_MAX_REPLAY_BODY_BYTES;
	if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new Error("maxRedirects must be a non-negative integer");
	if (!Number.isInteger(maxReplayBodyBytes) || maxReplayBodyBytes < 0) {
		throw new Error("maxReplayBodyBytes must be a non-negative integer");
	}

	let target = await resolveRemoteTarget(url, options);
	let request = await prepareReplayableRequest(target.url, init, maxReplayBodyBytes);

	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		const requestInit = replayRequestInit(request);
		const response = options.fetch
			? await options.fetch(target.url, { ...requestInit, redirect: "manual" })
			: await fetchPinned(target.url, requestInit, target.addresses[0]);
		if (!REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		await cancelResponseBody(response);
		if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${target.url.toString()}`);

		const nextUrl = new URL(location, target.url);
		applyRedirectMethod(response.status, request);
		if (nextUrl.origin !== target.url.origin) {
			for (const name of CROSS_ORIGIN_SENSITIVE_HEADERS) request.headers.delete(name);
		}
		target = await resolveRemoteTarget(nextUrl, options);
	}

	throw new Error(`Too many redirects fetching ${target.url.toString()}`);
}

interface ReplayableRequest {
	init: Omit<RequestInit, "body" | "headers" | "method">;
	method: string;
	headers: Headers;
	body: Uint8Array | null;
}

async function prepareReplayableRequest(url: URL, init: RequestInit, maxBodyBytes: number): Promise<ReplayableRequest> {
	if (isStreamingBody(init.body)) {
		throw new Error("Streaming request bodies cannot be safely replayed across redirects");
	}
	const normalized = new Request(url, { ...init, redirect: "manual" });
	const body = await readBoundedBody(normalized.body, maxBodyBytes);
	const { body: _body, headers: _headers, method: _method, ...rest } = init;
	return { init: rest, method: normalized.method, headers: new Headers(normalized.headers), body };
}

function isStreamingBody(body: RequestInit["body"]): boolean {
	if (!body || typeof body !== "object") return false;
	return body instanceof ReadableStream || Symbol.asyncIterator in body;
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
	if (!body) return null;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error(`Request body exceeds replay limit of ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function replayRequestInit(request: ReplayableRequest): RequestInit {
	return {
		...request.init,
		method: request.method,
		headers: new Headers(request.headers),
		...(request.body ? { body: request.body.slice() } : {}),
	};
}

function applyRedirectMethod(status: number, request: ReplayableRequest): void {
	const method = request.method.toUpperCase();
	const switchesToGet = ((status === 301 || status === 302) && method === "POST") ||
		(status === 303 && method !== "GET" && method !== "HEAD");
	if (!switchesToGet) return;
	request.method = "GET";
	request.body = null;
	for (const name of REQUEST_BODY_HEADERS) request.headers.delete(name);
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The redirect is no longer consumed; cleanup failure must not follow it.
	}
}

export class ResponseSizeLimitError extends Error {
	constructor(
		readonly maxBytes: number,
		readonly observedBytes: number,
	) {
		super(`Response body exceeds limit of ${maxBytes} bytes`);
		this.name = "ResponseSizeLimitError";
	}
}

export async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a non-negative integer");

	const declaredLength = response.headers.get("content-length");
	if (declaredLength && /^\d+$/.test(declaredLength)) {
		const declaredBytes = Number(declaredLength);
		if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
			await cancelResponseBody(response);
			throw new ResponseSizeLimitError(maxBytes, declaredBytes);
		}
	}

	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					// Preserve the size-limit failure even if transport cleanup fails.
				}
				throw new ResponseSizeLimitError(maxBytes, total);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
	return new TextDecoder().decode(await readBoundedResponseBytes(response, maxBytes));
}

async function fetchPinned(url: URL, init: RequestInit, address: LookupAddress): Promise<Response> {
	const request = new Request(url, { ...init, redirect: "manual" });
	const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
	const headers = Object.fromEntries(request.headers.entries());
	headers.host = url.host;

	const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
		if (lookupOptions.all) callback(null, [address]);
		else callback(null, address.address, address.family);
	};

	return new Promise<Response>((resolve, reject) => {
		const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
		const nodeRequest = transport({
			protocol: url.protocol,
			hostname: normalizeHostname(url.hostname),
			port: url.port ? Number(url.port) : undefined,
			method: request.method,
			path: `${url.pathname}${url.search}`,
			headers,
			signal: request.signal,
			agent: false,
			lookup: pinnedLookup,
			...(url.protocol === "https:" ? { servername: normalizeHostname(url.hostname) } : {}),
		}, (incoming) => resolve(toFetchResponse(incoming, request.method)));
		nodeRequest.once("error", reject);
		if (body) nodeRequest.end(body);
		else nodeRequest.end();
	});
}

function toFetchResponse(incoming: IncomingMessage, requestMethod: string): Response {
	const headers = new Headers();
	for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
		headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
	}
	const status = incoming.statusCode ?? 0;
	const hasBody = requestMethod !== "HEAD" && status !== 101 && status !== 204 && status !== 205 && status !== 304;
	const body = hasBody ? Readable.toWeb(incoming) as ReadableStream<Uint8Array> : null;
	return new Response(body, { status, statusText: incoming.statusMessage, headers });
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function assertDomainPolicy(hostname: string, policy?: DomainPolicy): void {
	if (!policy) return;
	if (policy.deny.some((entry) => domainMatches(hostname, entry))) {
		throw new Error(`Blocked hostname by fetch_content domain policy: ${hostname}`);
	}
	if (policy.allow.length > 0 && !policy.allow.some((entry) => domainMatches(hostname, entry))) {
		throw new Error(`Hostname not allowed by fetch_content domain policy: ${hostname}`);
	}
}

function domainMatches(hostname: string, entry: string): boolean {
	return hostname === entry || hostname.endsWith(`.${entry}`);
}

function assertPublicAddress(address: string, hostname: string, allowRanges: ParsedCidr[] = []): void {
	const normalized = normalizeHostname(address);
	const ipVersion = net.isIP(normalized);
	if (ipVersion === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);

	const mappedIPv4 = ipVersion === 6 ? mappedIPv4Address(normalized) : null;
	if (isInAllowedRange(normalized, ipVersion, allowRanges) ||
		(mappedIPv4 !== null && isInAllowedRange(mappedIPv4, 4, allowRanges))) return;

	const specialRanges = ipVersion === 4 ? SPECIAL_PURPOSE_IPV4_RANGES : SPECIAL_PURPOSE_IPV6_RANGES;
	const isGloballyRoutableUnicast = ipVersion === 4 ||
		isAddressInRanges(normalized, ipVersion, GLOBALLY_ROUTABLE_IPV6_RANGES);
	if (!isGloballyRoutableUnicast || isAddressInRanges(normalized, ipVersion, specialRanges)) {
		const hint = ipVersion === 4 && isFakeIpProxyAddress(normalized)
			? '. This address is in 198.18.0.0/15, commonly used by TUN/fake-IP proxies. If that matches your setup, configure ssrf.allowRanges with ["198.18.0.0/15"] in web-search.json.'
			: "";
		throw new Error(`Blocked internal address or special-purpose destination for ${hostname}: ${normalized}${hint}`);
	}
}

function isFakeIpProxyAddress(address: string): boolean {
	const [a, b] = address.split(".").map(part => Number(part));
	return a === 198 && (b === 18 || b === 19);
}

function mappedIPv4Address(address: string): string | null {
	const groups = parseIPv6(address);
	if (!groups || !groups.slice(0, 5).every(group => group === 0) || groups[5] !== 0xffff) return null;
	return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
}

function isAddressInRanges(address: string, version: number, ranges: ParsedCidr[]): boolean {
	const bytes = ipToBytes(address, version);
	if (!bytes) return true;
	return ranges.some(range => range.bytes.length === bytes.length && bytesMatchPrefix(bytes, range.bytes, range.prefix));
}

function parseStaticRanges(ranges: string[]): ParsedCidr[] {
	return ranges.map(range => {
		const parsed = parseCidr(range);
		if (!parsed) throw new Error(`Invalid built-in special-purpose range: ${range}`);
		return parsed;
	});
}

function parseIPv6(address: string): number[] | null {
	if (address.includes(".")) {
		const lastColon = address.lastIndexOf(":");
		const ipv4 = address.slice(lastColon + 1);
		if (net.isIP(ipv4) !== 4) return null;
		const octets = ipv4.split(".").map(part => Number(part));
		address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}

	const pieces = address.split("::");
	if (pieces.length > 2) return null;

	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (pieces.length === 1 && missing !== 0) return null;
	if (pieces.length === 2 && missing < 0) return null;

	const groups = [...left, ...Array(missing).fill("0"), ...right].map(part => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
		return parseInt(part, 16);
	});
	return groups.length === 8 && groups.every(group => group >= 0 && group <= 0xffff) ? groups : null;
}

/** Parse `allowRanges` config value into validated CIDR rules. Throws on malformed entries. */
function parseAllowRanges(input: unknown): ParsedCidr[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) {
		throw new Error("ssrf.allowRanges must be an array of CIDR strings");
	}
	const rules: ParsedCidr[] = [];
	for (const entry of input) {
		if (typeof entry !== "string") {
			throw new Error(`ssrf.allowRanges entries must be strings, got ${typeof entry}`);
		}
		const rule = parseCidr(entry.trim());
		if (!rule) {
			throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${entry}"`);
		}
		rules.push(rule);
	}
	return rules;
}

/** Parse a single CIDR (e.g. "198.18.0.0/15", "fd00::/8") or bare host ("1.2.3.4"). Returns null if invalid. */
function parseCidr(raw: string): ParsedCidr | null {
	if (!raw) return null;
	const slash = raw.lastIndexOf("/");
	const addrPart = slash >= 0 ? raw.slice(0, slash) : raw;
	const prefixPart = slash >= 0 ? raw.slice(slash + 1) : null;
	// A slash must be followed by digits. Number("")/Number(" ") are 0, which
	// would silently turn "198.18.0.0/" into /0 and exempt every address.
	if (prefixPart !== null && !/^\d+$/.test(prefixPart)) return null;
	const version = net.isIP(addrPart);

	if (version === 4) {
		const bytes = ipv4ToBytes(addrPart);
		if (!bytes) return null;
		const prefix = prefixPart === null ? 32 : Number(prefixPart);
		if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
		return { bytes, prefix };
	}
	if (version === 6) {
		const groups = parseIPv6(addrPart);
		if (!groups) return null;
		const prefix = prefixPart === null ? 128 : Number(prefixPart);
		if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
		return { bytes: ipv6GroupsToBytes(groups), prefix };
	}
	return null;
}

function ipv4ToBytes(address: string): Uint8Array | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const bytes = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		const octet = Number(parts[i]);
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
		bytes[i] = octet;
	}
	return bytes;
}

function ipv6GroupsToBytes(groups: number[]): Uint8Array {
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		bytes[i * 2] = groups[i] >> 8;
		bytes[i * 2 + 1] = groups[i] & 0xff;
	}
	return bytes;
}

function ipToBytes(address: string, version: number): Uint8Array | null {
	if (version === 4) return ipv4ToBytes(address);
	if (version === 6) {
		const groups = parseIPv6(address);
		return groups ? ipv6GroupsToBytes(groups) : null;
	}
	return null;
}

/** True if `address` (already validated as `ipVersion`) falls within any allowed CIDR. */
function isInAllowedRange(address: string, ipVersion: number, allowRanges: ParsedCidr[]): boolean {
	if (allowRanges.length === 0) return false;
	const addrBytes = ipToBytes(address, ipVersion);
	if (!addrBytes) return false;
	for (const rule of allowRanges) {
		// Only compare same-family rules (4-byte IPv4 vs 16-byte IPv6).
		if (rule.bytes.length !== addrBytes.length) continue;
		if (bytesMatchPrefix(addrBytes, rule.bytes, rule.prefix)) return true;
	}
	return false;
}

/** Compare the leading `prefix` bits of two equal-length byte arrays. */
function bytesMatchPrefix(addr: Uint8Array, network: Uint8Array, prefix: number): boolean {
	const fullBytes = prefix >> 3;
	const remBits = prefix & 7;
	for (let i = 0; i < fullBytes; i++) {
		if (addr[i] !== network[i]) return false;
	}
	if (remBits > 0 && fullBytes < addr.length) {
		const mask = (0xff << (8 - remBits)) & 0xff;
		if ((addr[fullBytes] & mask) !== (network[fullBytes] & mask)) return false;
	}
	return true;
}
