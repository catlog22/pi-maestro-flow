import type { ToolInfo } from "@earendil-works/pi-coding-agent";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_DELTA = 0.5;

const FIELD_WEIGHTS = {
  name: 6,
  label: 5,
  summary: 3,
  description: 1,
  schemaKey: 3,
} as const;

export interface DiscoverableTool {
  name: string;
  label: string;
  summary: string;
  description: string;
  schemaKeys: string[];
}

interface SearchDocument {
  tool: DiscoverableTool;
  termFrequencies: Map<string, number>;
  length: number;
}

export interface ToolSearchIndex {
  documents: SearchDocument[];
  averageLength: number;
  documentFrequencies: Map<string, number>;
}

export interface ToolSearchResult {
  tool: DiscoverableTool;
  score: number;
}

export function toDiscoverableTool(tool: ToolInfo): DiscoverableTool {
  const parameters = tool.parameters as { properties?: unknown } | undefined;
  const properties = parameters?.properties;
  const schemaKeys = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties as Record<string, unknown>).sort()
    : [];
  return {
    name: tool.name,
    label: titleFromName(tool.name),
    summary: summarize(tool.description),
    description: tool.description,
    schemaKeys,
  };
}

export function buildToolSearchIndex(tools: Iterable<DiscoverableTool>): ToolSearchIndex {
  const documents = Array.from(tools, buildSearchDocument);
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
  const documentFrequencies = new Map<string, number>();
  for (const document of documents) {
    for (const token of new Set(document.termFrequencies.keys())) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }
  return { documents, averageLength, documentFrequencies };
}

export function searchTools(index: ToolSearchIndex, query: string, limit: number): ToolSearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    throw new Error("Query must contain at least one letter or number.");
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Limit must be a positive integer.");
  }
  if (index.documents.length === 0) return [];

  const queryTermCounts = new Map<string, number>();
  for (const token of queryTokens) {
    queryTermCounts.set(token, (queryTermCounts.get(token) ?? 0) + 1);
  }

  return index.documents
    .map((document) => {
      let score = 0;
      for (const [token, queryTermCount] of queryTermCounts) {
        const termFrequency = document.termFrequencies.get(token) ?? 0;
        if (termFrequency === 0) continue;
        const documentFrequency = index.documentFrequencies.get(token) ?? 0;
        const idf = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
        const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
        score += queryTermCount * idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization) + BM25_DELTA);
      }
      return { tool: document.tool, score };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit);
}

function buildSearchDocument(tool: DiscoverableTool): SearchDocument {
  const termFrequencies = new Map<string, number>();
  addWeightedTokens(termFrequencies, tool.name, FIELD_WEIGHTS.name);
  addWeightedTokens(termFrequencies, tool.label, FIELD_WEIGHTS.label);
  addWeightedTokens(termFrequencies, tool.summary, FIELD_WEIGHTS.summary);
  addWeightedTokens(termFrequencies, tool.description, FIELD_WEIGHTS.description);
  for (const schemaKey of tool.schemaKeys) {
    addWeightedTokens(termFrequencies, schemaKey, FIELD_WEIGHTS.schemaKey);
  }
  const length = Array.from(termFrequencies.values()).reduce((sum, value) => sum + value, 0);
  return { tool, termFrequencies, length };
}

function titleFromName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/(^|\s)(\p{L})/gu, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
}

function summarize(description: string): string {
  const firstLine = description.trim().split(/\r?\n/, 1)[0] ?? "";
  const sentence = /^(.+?[.!?。！？])(?:\s|$)/u.exec(firstLine)?.[1] ?? firstLine;
  return sentence.slice(0, 200);
}

function addWeightedTokens(termFrequencies: Map<string, number>, value: string, weight: number): void {
  for (const token of tokenize(value)) {
    termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
  }
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
