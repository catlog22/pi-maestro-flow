import { fetchAllContent, type ExtractedContent, type ExtractOptions } from "./extract.ts";

export interface NativeFetchOptions {
  urls: string[];
  timestamp?: string;
  frames?: number;
  prompt?: string;
  signal?: AbortSignal;
}

export interface NativeFetchResult {
  results: ExtractedContent[];
}

export async function nativeFetch(options: NativeFetchOptions): Promise<NativeFetchResult> {
  const extractOptions: ExtractOptions = {
    timestamp: options.timestamp,
    frames: options.frames,
    prompt: options.prompt,
  };
  const results = await fetchAllContent(options.urls, options.signal, extractOptions);
  return { results };
}
