/**
 * Site extractors — 站点化结构化提取（T1-3）
 *
 * 对高价值站点返回结构化 markdown（问题页的标题/标签/答案、CVE 的评分/描述/引用），
 * 而不是裸 HTML 或摘要。全部走 SSRF 原语（fetchRemoteUrl 内置 DNS 固定 + 私有地址拒绝）。
 *
 * 接入点：extract.ts 的 extractContent 在 GitHub 提取后调用 extractSiteContent；
 * smart_search 的 native 路径（fetchAllContent → extractContent）自动受益。
 *
 * 测试 seam：setSiteApiBaseOverride(scheme, base) 可将 JSON API 重定向到本地服务器
 * （配合 PI_CODING_AGENT_DIR 下 web-search.json 的 ssrf.allowRanges）。
 */

import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import {
  fetchRemoteUrl,
  loadFetchContentDomainPolicy,
  loadSsrfConfig,
  readBoundedResponseText,
  type Lookup,
} from "./ssrf-protection.ts";
import { activityMonitor } from "./activity.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 60_000;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

/** Test seam: override the JSON API base per scheme; empty base removes the override. */
const apiBaseOverrides = new Map<string, string>();
export function setSiteApiBaseOverride(scheme: string, baseUrl: string): void {
  if (baseUrl === "") apiBaseOverrides.delete(scheme);
  else apiBaseOverrides.set(scheme, baseUrl);
}

function apiBase(scheme: string, fallback: string): string {
  return apiBaseOverrides.get(scheme) ?? fallback;
}

function ssrfOptions(lookup?: Lookup) {
  const ssrf = loadSsrfConfig();
  const domainPolicy = loadFetchContentDomainPolicy();
  return {
    allowRanges: ssrf.allowRanges,
    trustEnvProxy: ssrf.trustEnvProxy,
    domainPolicy,
    ...(lookup ? { lookup } : {}),
  };
}

async function fetchRemoteText(url: string, signal?: AbortSignal, lookup?: Lookup, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  if (signal?.aborted) throw new Error("Aborted");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetchRemoteUrl(
      url,
      {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      ssrfOptions(lookup),
    );
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the HTTP error as the primary signal.
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function fetchJson(url: string, signal?: AbortSignal, lookup?: Lookup, timeoutMs?: number): Promise<unknown> {
  const text = await fetchRemoteText(url, signal, lookup, timeoutMs);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function trimOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_OUTPUT_CHARS} chars]`;
}

function elementMarkdown(el: { outerHTML?: string; textContent?: string | null } | null | undefined): string {
  if (!el) return "";
  if (typeof el.outerHTML === "string" && el.outerHTML.length > 0) {
    const md = turndown.turndown(el.outerHTML).trim();
    if (md) return md;
  }
  return (el.textContent ?? "").trim();
}

function cleanText(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- arXiv

const ARXIV_ABS_RE = /^\/abs\/([\w.-]+)\/?$/;

export async function extractArxivAbs(url: URL, signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent | null> {
  const match = ARXIV_ABS_RE.exec(url.pathname);
  if (!match) return null;
  const id = match[1]!;
  const activityId = activityMonitor.logStart({ type: "fetch", url: url.toString() });
  try {
    const html = await fetchRemoteText(url.toString(), signal, options?.lookup, options?.timeoutMs);
    const { document } = parseHTML(html);

    const meta = (name: string): string => {
      const byName = document.querySelector(`meta[name="${name}"]`);
      if (byName?.getAttribute("content")) return byName.getAttribute("content")!;
      const byProperty = document.querySelector(`meta[property="${name}"]`);
      return cleanText(byProperty?.getAttribute("content"));
    };

    const title = cleanText(document.querySelector("h1.title")?.textContent?.replace(/^Title:\s*/i, ""))
      || meta("citation_title");
    const authors = [...document.querySelectorAll("div.authors a")]
      .map((a) => cleanText(a.textContent))
      .filter(Boolean);
    const abstract = cleanText(
      document.querySelector("blockquote.abstract")?.textContent?.replace(/^Abstract:\s*/i, ""),
    ) || meta("citation_abstract");
    const primarySubject = meta("arxiv:primary_category") || meta("citation_doi");
    const subjects = [...document.querySelectorAll("td.subjects span")]
      .map((s) => cleanText(s.textContent))
      .filter(Boolean);
    const date = meta("citation_date") || meta("citation_online_date");
    const pdfUrl = meta("citation_pdf_url");
    const doi = meta("citation_doi");

    if (!title && !abstract) return null;

    const lines: string[] = [
      `# ${title || id}`,
      "",
      `arXiv: ${id}${date ? ` · Submitted: ${date}` : ""}`,
    ];
    if (authors.length > 0) lines.push(`Authors: ${authors.join(", ")}`);
    if (primarySubject) lines.push(`Primary subject: ${primarySubject}`);
    if (subjects.length > 0) lines.push(`Subjects: ${subjects.join(", ")}`);
    if (doi) lines.push(`DOI: ${doi}`);
    if (pdfUrl) lines.push(`PDF: ${pdfUrl}`);
    lines.push("", "## Abstract", "", abstract || "(no abstract)");

    const content = trimOutput(lines.join("\n"));
    activityMonitor.logComplete(activityId, 200);
    return { url: url.toString(), title: title || id, content, error: null };
  } catch (err) {
    activityMonitor.logError(activityId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// -------------------------------------------------------- Stack Overflow

const STACKOVERFLOW_Q_RE = /^\/questions\/(\d+)(\/[^/?]*)?/;

export async function extractStackOverflowQuestion(url: URL, signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent | null> {
  const match = STACKOVERFLOW_Q_RE.exec(url.pathname);
  if (!match) return null;
  const questionId = match[1]!;
  const activityId = activityMonitor.logStart({ type: "fetch", url: url.toString() });
  try {
    const html = await fetchRemoteText(url.toString(), signal, options?.lookup, options?.timeoutMs);
    const { document } = parseHTML(html);

    const title = cleanText(
      document.querySelector("#question-header h1")?.textContent
      || document.querySelector("h1")?.textContent,
    );
    const questionBlock = document.querySelector("#question") ?? document.querySelector(".question");
    const questionBody = elementMarkdown(
      questionBlock?.querySelector(".js-post-body") ?? questionBlock?.querySelector(".post-text") ?? null,
    );
    const voteCount = cleanText(
      questionBlock?.querySelector(".js-vote-count")?.textContent
      || questionBlock?.querySelector(".vote-count-post")?.textContent,
    );
    const tags = [...document.querySelectorAll(".post-tag")]
      .map((tag) => cleanText(tag.textContent))
      .filter(Boolean);
    const askedMeta = cleanText(document.querySelector(".user-action-time")?.textContent);

    const answers = [...document.querySelectorAll("#answers .answer")];
    const answerLines: string[] = [];
    for (const answer of answers) {
      const answerVotes = cleanText(
        answer.querySelector(".js-vote-count")?.textContent
        || answer.querySelector(".vote-count-post")?.textContent,
      );
      const body = elementMarkdown(answer.querySelector(".js-post-body") ?? answer.querySelector(".post-text"));
      const accepted = answer.querySelector(".js-accepted-answer-indicator") !== null;
      answerLines.push(`### Answer${accepted ? " (accepted)" : ""}${answerVotes ? ` · votes: ${answerVotes}` : ""}`);
      answerLines.push(body);
      answerLines.push("");
    }

    if (!title && !questionBody) return null;

    const lines: string[] = [
      `# ${title || `Stack Overflow Question ${questionId}`}`,
      "",
      `Question ID: ${questionId}${askedMeta ? ` · ${askedMeta}` : ""}`,
    ];
    if (voteCount) lines.push(`Votes: ${voteCount}`);
    if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
    lines.push("", "## Question", "", questionBody || "(no body)");
    if (answerLines.length > 0) {
      lines.push("", `## Answers (${answers.length})`, "", ...answerLines);
    } else {
      lines.push("", "(no answers yet)");
    }

    const content = trimOutput(lines.join("\n"));
    activityMonitor.logComplete(activityId, 200);
    return { url: url.toString(), title: title || `Stack Overflow Question ${questionId}`, content, error: null };
  } catch (err) {
    activityMonitor.logError(activityId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// -------------------------------------------------------------------- NVD

const NVD_CVE_RE = /^\/vuln\/detail\/(CVE-\d{4}-\d{4,})\/?/i;

export async function extractNvdCve(url: URL, signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent | null> {
  const match = NVD_CVE_RE.exec(url.pathname);
  if (!match) return null;
  const cveId = match[1]!.toUpperCase();
  const apiUrl = `${apiBase("nvd", "https://services.nvd.nist.gov/rest/json/cves/2.0")}?cveId=${encodeURIComponent(cveId)}`;
  const activityId = activityMonitor.logStart({ type: "api", query: `nvd: ${cveId}` });
  try {
    const json = (await fetchJson(apiUrl, signal, options?.lookup, options?.timeoutMs)) as {
      vulnerabilities?: Array<{ cve?: Record<string, unknown> }>;
    };
    const cve = json.vulnerabilities?.[0]?.cve;
    if (!cve) {
      return {
        url: url.toString(),
        title: cveId,
        content: trimOutput(`# ${cveId}\n\n(Not found in the NVD database.)`),
        error: null,
      };
    }

    const descriptions = (cve.descriptions as Array<{ lang?: string; value?: string }> | undefined) ?? [];
    const description = cleanText(
      descriptions.find((d) => d.lang === "en")?.value
      ?? descriptions[0]?.value,
    );
    const published = cleanText(String(cve.published ?? ""));
    const lastModified = cleanText(String(cve.lastModified ?? ""));

    const cvssLines: string[] = [];
    const addCvss = (metrics: unknown, label: string): void => {
      if (!Array.isArray(metrics) || metrics.length === 0) return;
      const data = (metrics[0] as { cvssData?: Record<string, unknown> })?.cvssData;
      if (!data) return;
      const score = data.baseScore ?? "";
      const severity = data.baseSeverity ?? "";
      const vector = data.vectorString ?? "";
      cvssLines.push(`${label}: ${score} ${severity}${vector ? ` · ${vector}` : ""}`);
    };
    addCvss(cve.cvssMetricV31, "CVSS v3.1");
    addCvss(cve.cvssMetricV30, "CVSS v3.0");
    addCvss(cve.cvssMetricV2, "CVSS v2.0");

    const weaknesses = (cve.weaknesses as Array<{ description?: Array<{ value?: string }> }> | undefined) ?? [];
    const cwe = [...new Set(
      weaknesses.flatMap((w) => (w.description ?? []).map((d) => cleanText(d.value))).filter(Boolean),
    )];

    const references = (cve.references as Array<{ url?: string; source?: string }> | undefined) ?? [];

    const lines: string[] = [
      `# ${cveId}`,
      "",
      `Published: ${published || "?"} · Modified: ${lastModified || "?"}`,
    ];
    if (cvssLines.length > 0) lines.push("", "## Severity", "", ...cvssLines);
    if (cwe.length > 0) lines.push("", `## Weaknesses (CWE): ${cwe.join(", ")}`);
    lines.push("", "## Description", "", description || "(no description)");
    if (references.length > 0) {
      lines.push("", `## References (${references.length})`, "");
      for (const ref of references.slice(0, 50)) {
        if (ref.url) lines.push(`- ${ref.url}${ref.source ? ` (${ref.source})` : ""}`);
      }
    }

    const content = trimOutput(lines.join("\n"));
    activityMonitor.logComplete(activityId, 200);
    return { url: url.toString(), title: cveId, content, error: null };
  } catch (err) {
    activityMonitor.logError(activityId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// -------------------------------------------------------------------- OSV

const OSV_VULN_RE = /^\/vulnerability\/([A-Za-z0-9._-]+)\/?$/;

export async function extractOsvVuln(url: URL, signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent | null> {
  const match = OSV_VULN_RE.exec(url.pathname);
  if (!match) return null;
  const vulnId = match[1]!;
  const apiUrl = `${apiBase("osv", "https://api.osv.dev/v1/vulns")}/${encodeURIComponent(vulnId)}`;
  const activityId = activityMonitor.logStart({ type: "api", query: `osv: ${vulnId}` });
  try {
    const json = (await fetchJson(apiUrl, signal, options?.lookup, options?.timeoutMs)) as {
      id?: string;
      summary?: string;
      details?: string;
      aliases?: string[];
      published?: string;
      modified?: string;
      severity?: Array<{ type?: string; score?: string }>;
      affected?: Array<{
        package?: { name?: string; ecosystem?: string };
        ranges?: Array<{ type?: string; events?: Array<Record<string, unknown>> }>;
        versions?: string[];
        severity?: Array<{ type?: string; score?: string }>;
      }>;
      references?: Array<{ type?: string; url?: string }>;
    };
    const id = json.id ?? vulnId;

    const lines: string[] = [`# ${id}`, ""];
    if (json.summary) lines.push(`**Summary**: ${json.summary}`);
    if (json.aliases && json.aliases.length > 0) lines.push(`Aliases: ${json.aliases.join(", ")}`);
    lines.push(`Published: ${json.published ?? "?"} · Modified: ${json.modified ?? "?"}`);

    const severities = [
      ...(json.severity ?? []),
      ...(json.affected ?? []).flatMap((a) => a.severity ?? []),
    ];
    if (severities.length > 0) {
      lines.push("", "## Severity");
      for (const s of severities) lines.push(`- ${s.type ?? "?"}: ${s.score ?? "?"}`);
    }

    if ((json.affected ?? []).length > 0) {
      lines.push("", "## Affected");
      for (const affected of json.affected ?? []) {
        const pkg = affected.package;
        lines.push(`- ${pkg?.ecosystem ?? "?"}/${pkg?.name ?? "?"}`);
        for (const range of affected.ranges ?? []) {
          const events = (range.events ?? []).map((e) => {
            const introduced = e.introduced !== undefined ? `introduced ${e.introduced}` : "";
            const fixed = e.fixed !== undefined ? `fixed ${e.fixed}` : "";
            return `${introduced}${introduced && fixed ? " → " : ""}${fixed}`;
          }).filter(Boolean);
          if (events.length > 0) lines.push(`  - range (${range.type ?? "?"}): ${events.join(" → ")}`);
        }
        if (affected.versions && affected.versions.length > 0) {
          lines.push(`  - versions: ${affected.versions.slice(0, 10).join(", ")}${affected.versions.length > 10 ? ` +${affected.versions.length - 10} more` : ""}`);
        }
      }
    }

    if (json.details) lines.push("", "## Details", "", json.details.trim());

    if ((json.references ?? []).length > 0) {
      lines.push("", "## References");
      for (const ref of json.references ?? []) {
        if (ref.url) lines.push(`- ${ref.url}${ref.type ? ` (${ref.type})` : ""}`);
      }
    }

    const content = trimOutput(lines.join("\n"));
    activityMonitor.logComplete(activityId, 200);
    return { url: url.toString(), title: id, content, error: null };
  } catch (err) {
    activityMonitor.logError(activityId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// --------------------------------------------------------------- CISA KEV

const CISA_KEV_PAGE_RE = /known-exploited-vulnerabilities-catalog/i;
const CISA_KEV_MAX_ENTRIES = 25;

export async function extractCisaKev(url: URL, signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent | null> {
  if (!CISA_KEV_PAGE_RE.test(url.pathname)) return null;
  const feedUrl = apiBase("cisa", "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json");
  const activityId = activityMonitor.logStart({ type: "api", query: "cisa-kev" });
  try {
    const json = (await fetchJson(feedUrl, signal, options?.lookup, options?.timeoutMs)) as {
      title?: string;
      catalogVersion?: string;
      dateReleased?: string;
      count?: number;
      vulnerabilities?: Array<{
        cveID?: string;
        vendorProject?: string;
        product?: string;
        vulnerabilityName?: string;
        dateAdded?: string;
        shortDescription?: string;
        requiredAction?: string;
        knownRansomwareCampaignUse?: string;
        dueDate?: string;
      }>;
    };
    const vulnerabilities = json.vulnerabilities ?? [];
    const cveFilter = url.searchParams.get("cve");
    const filtered = cveFilter
      ? vulnerabilities.filter((v) => (v.cveID ?? "").toUpperCase() === cveFilter.toUpperCase())
      : [...vulnerabilities].sort((a, b) => (b.dateAdded ?? "").localeCompare(a.dateAdded ?? "")).slice(0, CISA_KEV_MAX_ENTRIES);

    const lines: string[] = [
      `# ${json.title ?? "CISA Known Exploited Vulnerabilities Catalog"}`,
      "",
      `Catalog version: ${json.catalogVersion ?? "?"} · Released: ${json.dateReleased ?? "?"}`,
      `Total entries: ${json.count ?? vulnerabilities.length}${cveFilter ? ` · Filter: ${cveFilter}` : ""}`,
    ];

    if (filtered.length === 0) {
      lines.push("", cveFilter ? `(No known-exploited entry for ${cveFilter}.)` : "(No entries.)");
    } else {
      lines.push("", `## ${cveFilter ? "Match" : `Most recently added (${filtered.length})`}`, "");
      for (const vuln of filtered) {
        lines.push(`### ${vuln.cveID ?? "?"} — ${vuln.vulnerabilityName ?? ""}`);
        lines.push(`Vendor/Product: ${vuln.vendorProject ?? "?"}/${vuln.product ?? "?"} · Added: ${vuln.dateAdded ?? "?"}`);
        if (vuln.shortDescription) lines.push(`Description: ${cleanText(vuln.shortDescription)}`);
        lines.push(`Required action: ${cleanText(vuln.requiredAction ?? "")}`);
        if (vuln.dueDate) lines.push(`Due date: ${vuln.dueDate}`);
        lines.push(`Ransomware campaign use: ${vuln.knownRansomwareCampaignUse ?? "unknown"}`);
        lines.push("");
      }
    }

    const content = trimOutput(lines.join("\n"));
    activityMonitor.logComplete(activityId, 200);
    return {
      url: url.toString(),
      title: json.title ?? "CISA Known Exploited Vulnerabilities",
      content,
      error: null,
    };
  } catch (err) {
    activityMonitor.logError(activityId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ---------------------------------------------------------------- registry

interface SiteExtractor {
  matches(url: URL): boolean;
  extract(url: URL, signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent | null>;
}

const SITE_EXTRACTORS: SiteExtractor[] = [
  { matches: (url) => url.hostname === "arxiv.org" && ARXIV_ABS_RE.test(url.pathname), extract: extractArxivAbs },
  {
    matches: (url) => url.hostname === "stackoverflow.com" && STACKOVERFLOW_Q_RE.test(url.pathname),
    extract: extractStackOverflowQuestion,
  },
  { matches: (url) => url.hostname === "nvd.nist.gov" && NVD_CVE_RE.test(url.pathname), extract: extractNvdCve },
  { matches: (url) => url.hostname === "osv.dev" && OSV_VULN_RE.test(url.pathname), extract: extractOsvVuln },
  { matches: (url) => (url.hostname === "cisa.gov" || url.hostname === "www.cisa.gov") && CISA_KEV_PAGE_RE.test(url.pathname), extract: extractCisaKev },
];

/**
 * 尝试站点化提取；未命中或失败返回 null（由调用方回退到通用管线）。
 */
export async function extractSiteContent(
  url: string,
  signal?: AbortSignal,
  options?: ExtractOptions,
): Promise<ExtractedContent | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  for (const extractor of SITE_EXTRACTORS) {
    if (!extractor.matches(parsed)) continue;
    try {
      const result = await extractor.extract(parsed, signal, options);
      if (result) return result;
    } catch {
      // 站点化失败 → 回退到通用 HTTP 提取管线
    }
  }
  return null;
}
