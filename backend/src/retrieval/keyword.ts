const MAX_QUERY_TOKENS = 32;

/**
 * Convert an arbitrary natural-language query into a safe SQLite FTS5 MATCH expression.
 * Quotes every alphanumeric token so punctuation and FTS operators cannot break syntax.
 */
export function buildFtsQuery(rawQuery: string): string | null {
  const matches = rawQuery.match(/[\p{L}\p{N}]+/gu);
  if (!matches?.length) return null;
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of matches) {
    const normalized = token.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tokens.push(`"${normalized}"`);
    if (tokens.length >= MAX_QUERY_TOKENS) break;
  }
  return tokens.length ? tokens.join(' OR ') : null;
}
