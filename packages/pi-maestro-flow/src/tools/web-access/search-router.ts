import { search, type FullSearchOptions, type SearchProvider, type AttributedSearchResponse } from "./gemini-search.ts";
import type { SearchResult } from "./perplexity.ts";

export interface NativeSearchOptions {
  query: string;
  provider?: string;
  numResults?: number;
  recencyFilter?: string;
  domainFilter?: string[];
  includeContent?: boolean;
  signal?: AbortSignal;
}

export interface NativeSearchResult {
  answer: string | null;
  results: SearchResult[];
  provider: string;
}

const PROVIDER_MAP: Record<string, SearchProvider> = {
  auto: "auto",
  openai: "openai",
  brave: "brave",
  parallel: "parallel",
  tavily: "tavily",
  searxng: "searxng",
  perplexity: "perplexity",
  gemini: "gemini",
  exa: "exa",
  serpdive: "serpdive",
  anysearch: "anysearch",
};

export async function nativeSearch(options: NativeSearchOptions): Promise<NativeSearchResult> {
  const searchOptions: FullSearchOptions = {
    numResults: options.numResults,
    recencyFilter: options.recencyFilter as never,
    domainFilter: options.domainFilter,
    includeContent: options.includeContent,
    signal: options.signal,
  };
  if (options.provider && options.provider in PROVIDER_MAP) {
    searchOptions.provider = PROVIDER_MAP[options.provider];
  }
  const response: AttributedSearchResponse = await search(options.query, searchOptions);
  return {
    answer: response.answer ?? null,
    results: response.results ?? [],
    provider: response.provider,
  };
}
