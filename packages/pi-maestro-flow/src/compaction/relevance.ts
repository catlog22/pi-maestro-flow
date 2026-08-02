// Ported from headroom's zero-dependency BM25 scorer (Apache-2.0).
// Extended with CJK bigrams so Chinese prompts can participate in lexical ranking.

export type RelevanceMode = "bm25" | "keyword";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_TOKEN_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b\d{4,}\b|[a-z0-9_]+|\p{Script=Han}+/giu;
const HAN_RUN_PATTERN = /^\p{Script=Han}+$/u;

export function tokenizeRelevance(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().match(RAW_TOKEN_PATTERN) ?? []) {
    if (!HAN_RUN_PATTERN.test(raw)) {
      tokens.push(raw);
      continue;
    }
    const chars = [...raw];
    if (chars.length === 1) {
      tokens.push(chars[0]);
      continue;
    }
    for (let index = 0; index < chars.length - 1; index++) {
      tokens.push(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return tokens;
}

export function scoreRelevanceBatch(
  documents: string[],
  query: string,
  mode: RelevanceMode = "bm25",
): number[] {
  const queryTokens = tokenizeRelevance(query);
  if (documents.length === 0) return [];
  if (queryTokens.length === 0) return documents.map(() => 0);
  const documentTokens = documents.map(tokenizeRelevance);
  return mode === "keyword"
    ? keywordScores(documentTokens, queryTokens)
    : bm25Scores(documentTokens, queryTokens);
}

function keywordScores(documents: string[][], queryTokens: string[]): number[] {
  const queryTerms = [...new Set(queryTokens)];
  return documents.map((tokens) => {
    const terms = new Set(tokens);
    let matched = 0;
    for (const term of queryTerms) if (terms.has(term)) matched++;
    return queryTerms.length > 0 ? matched / queryTerms.length : 0;
  });
}

function bm25Scores(documents: string[][], queryTokens: string[]): number[] {
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0)
    / Math.max(documents.length, 1);
  const queryFrequency = frequencies(queryTokens);
  const documentFrequency = new Map<string, number>();
  for (const tokens of documents) {
    for (const term of new Set(tokens)) {
      if (queryFrequency.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const k1 = 1.5;
  const b = 0.75;
  return documents.map((tokens) => {
    if (tokens.length === 0) return 0;
    const termFrequency = frequencies(tokens);
    let score = 0;
    for (const [term, queryCount] of queryFrequency) {
      const frequency = termFrequency.get(term);
      const docsWithTerm = documentFrequency.get(term);
      if (!frequency || !docsWithTerm) continue;
      const idf = Math.log((documents.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1);
      const lengthNormalization = averageLength > 0 ? tokens.length / averageLength : 1;
      const numerator = frequency * (k1 + 1);
      const denominator = frequency + k1 * (1 - b + b * lengthNormalization);
      score += idf * numerator / denominator * queryCount;
      if (UUID_PATTERN.test(term) || term.length >= 8) score += 0.3;
    }
    return score;
  });
}

function frequencies(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}
