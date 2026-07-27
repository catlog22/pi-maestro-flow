/**
 * Adapter layer bridging pi-web-access native modules into the Smart Search system.
 *
 * The vendored modules continue reading their config from ~/.pi/web-search.json
 * (their native path). The TUI WebAccessConfigSync keeps both config files aligned.
 */

export { activityMonitor, type ActivityEntry, type RateLimitInfo } from "./activity.ts";
export {
  type SearchResult,
  type SearchResponse,
  type SearchOptions,
  isPerplexityAvailable,
  searchWithPerplexity,
} from "./perplexity.ts";
export { isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts";
export { isBraveAvailable, searchWithBrave } from "./brave.ts";
export { isParallelAvailable, searchWithParallel, extractWithParallel } from "./parallel.ts";
export { isTavilyAvailable, searchWithTavily } from "./tavily.ts";
export { isSerpdiveAvailable, searchWithSerpdive } from "./serpdive.ts";
export { isAnySearchAvailable, searchWithAnySearch } from "./anysearch.ts";
export { isSearXNGAvailable, searchWithSearXNG } from "./searxng.ts";
export { isExaAvailable, searchWithExa } from "./exa.ts";
export {
  type SearchProvider,
  type ResolvedSearchProvider,
  type FullSearchOptions,
  type AttributedSearchResponse,
  search,
  getConfiguredSearchRouting,
} from "./gemini-search.ts";
export { isGeminiApiAvailable } from "./gemini-api.ts";
export { isGeminiWebAvailable, getActiveGoogleEmail } from "./gemini-web.ts";
export {
  type ExtractedContent,
  type ExtractOptions,
  extractContent,
  fetchAllContent,
} from "./extract.ts";
export {
  type ResearchArtifact,
  type ClaimAssessment,
  buildResearchArtifact,
  withClaimAssessment,
  storeResearchArtifact,
  getResearchArtifact,
} from "./source-check.ts";
export {
  type StoredSearchData,
  type QueryResultData,
  storeResult,
  getResult,
  getAllResults,
  deleteResult,
  clearResults,
  generateId,
} from "./storage.ts";
export {
  type SummaryMeta,
  type SummaryGenerationContext,
  buildSummaryPrompt,
  buildDeterministicSummary,
  generateSummaryDraft,
} from "./summary-review.ts";
export { startCuratorServer, type CuratorServerHandle } from "./curator-server.ts";
export {
  type SsrfConfig,
  type DomainPolicy,
  loadSsrfConfig,
  loadFetchContentDomainPolicy,
  validateRemoteUrl,
  fetchRemoteUrl,
} from "./ssrf-protection.ts";
export {
  type CredentialOptions,
  resolveCredential,
  hasCredentialSource,
  redactCredential,
} from "./credential-source.ts";
export { buildSearchErrorPlan, type SearchErrorPlan } from "./render-search-error.ts";
export { normalizeFetchContentParams, type NormalizedFetchContentParams } from "./fetch-params.ts";

import { isPerplexityAvailable as _perplexity } from "./perplexity.ts";
import { isOpenAISearchAvailable as _openai } from "./openai-search.ts";
import { isBraveAvailable as _brave } from "./brave.ts";
import { isParallelAvailable as _parallel } from "./parallel.ts";
import { isTavilyAvailable as _tavily } from "./tavily.ts";
import { isSerpdiveAvailable as _serpdive } from "./serpdive.ts";
import { isSearXNGAvailable as _searxng } from "./searxng.ts";
import { isExaAvailable as _exa } from "./exa.ts";
import { isGeminiApiAvailable as _geminiApi } from "./gemini-api.ts";
import { isGeminiWebAvailable as _geminiWeb } from "./gemini-web.ts";
import { isAnySearchAvailable as _anysearch } from "./anysearch.ts";

export interface ProviderAvailability {
  perplexity: boolean;
  openai: boolean;
  brave: boolean;
  parallel: boolean;
  tavily: boolean;
  serpdive: boolean;
  searxng: boolean;
  exa: boolean;
  geminiApi: boolean;
  geminiWeb: boolean;
  anysearch: boolean;
}

export function checkProviderAvailability(): ProviderAvailability {
  return {
    perplexity: _perplexity(),
    openai: _openai(),
    brave: _brave(),
    parallel: _parallel(),
    tavily: _tavily(),
    serpdive: _serpdive(),
    searxng: _searxng(),
    exa: _exa(),
    geminiApi: _geminiApi(),
    geminiWeb: _geminiWeb(),
    anysearch: _anysearch(),
  };
}
