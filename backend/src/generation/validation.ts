import type { SourceSpan } from '@rag-eval/contracts';

export const SYNTHETIC_PROMPT_VERSION = 'synthetic-qa-v1';

/**
 * Documented verbatim-leakage thresholds for synthetic reference answers.
 * A proposed reference answer is flagged (and blocked from promotion against
 * an index containing that source text) when it is long enough to be a
 * sentence/clause (>= 5 words and >= 24 normalized chars) AND either:
 *   - >= 75% of its normalized words come from contiguous verbatim runs of
 *     >= 4 words (or >= 3 words spanning >= 24 chars) present in the corpus, OR
 *   - it contains a single contiguous verbatim run of >= 8 words or >= 60 chars.
 */
export const LEAKAGE_VERBATIM_RATIO_THRESHOLD = 0.75;
export const LEAKAGE_MAX_CONTIGUOUS_CHARS = 60;
export const LEAKAGE_MAX_CONTIGUOUS_WORDS = 8;
export const LEAKAGE_MIN_ANSWER_CHARS = 24;
export const LEAKAGE_MIN_ANSWER_WORDS = 5;
export const SPAN_OVERLAP_DEDUP_THRESHOLD = 0.5;

export interface FrozenDocumentText {
  documentId: string;
  documentVersionId: string;
  name: string;
  text: string;
}

export interface RawProposedSpan {
  documentVersionId: string;
  start: number;
  end: number;
  quote: string;
}

export interface RawProposedQrel {
  documentId: string;
  grade: number;
}

export interface LeakageAssessment {
  score: number;
  flagged: boolean;
  reason: string | null;
  longestMatchWords: number;
  longestMatchChars: number;
  matchedWords: number;
  totalWords: number;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeQuestionText(question: string): string {
  return question
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeNormalized(text: string): {
  normalized: string;
  words: string[];
} {
  const words = Array.from(
    text
      .toLowerCase()
      .normalize('NFKC')
      .matchAll(/[\p{L}\p{N}]+/gu),
    (match) => match[0],
  );
  return { normalized: words.join(' '), words };
}

export function spansOverlap(
  a: Pick<SourceSpan, 'documentVersionId' | 'start' | 'end'>,
  b: Pick<SourceSpan, 'documentVersionId' | 'start' | 'end'>,
  threshold = SPAN_OVERLAP_DEDUP_THRESHOLD,
): boolean {
  if (a.documentVersionId !== b.documentVersionId) return false;
  const overlapLen = Math.max(
    0,
    Math.min(a.end, b.end) - Math.max(a.start, b.start),
  );
  if (overlapLen <= 0) return false;
  const minLen = Math.min(a.end - a.start, b.end - b.start);
  if (minLen <= 0) return false;
  return overlapLen / minLen >= threshold;
}

export function proposalOverlapsAny(
  candidateSpans: Pick<SourceSpan, 'documentVersionId' | 'start' | 'end'>[],
  existingSpans: Pick<SourceSpan, 'documentVersionId' | 'start' | 'end'>[],
  threshold = SPAN_OVERLAP_DEDUP_THRESHOLD,
): boolean {
  for (const cand of candidateSpans) {
    for (const existing of existingSpans) {
      if (spansOverlap(cand, existing, threshold)) return true;
    }
  }
  return false;
}

/**
 * Validates that every proposed span addresses a document version in the frozen
 * revision, uses in-bounds offsets, and matches the exact frozen text slice.
 */
export function validateSourceSpans(
  rawSpans: RawProposedSpan[],
  frozenDocsByVersionId: Map<string, FrozenDocumentText>,
): { valid: true; spans: SourceSpan[] } | { valid: false; reason: string } {
  if (!rawSpans.length) {
    return { valid: false, reason: 'Proposal included no source spans.' };
  }
  const validated: SourceSpan[] = [];
  const seen = new Set<string>();
  for (const span of rawSpans) {
    const doc = frozenDocsByVersionId.get(span.documentVersionId);
    if (!doc) {
      return {
        valid: false,
        reason: `Document version "${span.documentVersionId}" is not in this frozen revision.`,
      };
    }
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > doc.text.length
    ) {
      return {
        valid: false,
        reason: `Offsets [${span.start}, ${span.end}) are outside frozen text length ${doc.text.length}.`,
      };
    }
    const actual = doc.text.slice(span.start, span.end);
    if (!actual.trim()) {
      return {
        valid: false,
        reason: 'Span slice contained only whitespace.',
      };
    }
    const expectedQuote = span.quote.trim();
    if (!expectedQuote) {
      return { valid: false, reason: 'Span quote was empty.' };
    }
    if (
      actual !== span.quote &&
      normalizeWhitespace(actual) !== normalizeWhitespace(expectedQuote)
    ) {
      return {
        valid: false,
        reason:
          'Span quote did not match the frozen document text at the given offsets.',
      };
    }
    const key = `${doc.documentVersionId}:${span.start}:${span.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    validated.push({
      documentId: doc.documentId,
      documentVersionId: doc.documentVersionId,
      documentName: doc.name,
      start: span.start,
      end: span.end,
      quote: actual,
    });
  }
  if (!validated.length) {
    return { valid: false, reason: 'No valid source spans remained.' };
  }
  return { valid: true, spans: validated };
}

export function validateProposalQrels(
  rawQrels: RawProposedQrel[],
  answerable: boolean,
  validatedSpans: SourceSpan[],
  validDocumentIds: Set<string>,
):
  | { valid: true; qrels: Array<{ documentId: string; grade: number }> }
  | { valid: false; reason: string } {
  const byDoc = new Map<string, number>();
  for (const row of rawQrels) {
    if (!validDocumentIds.has(row.documentId)) {
      return {
        valid: false,
        reason: `Qrel documentId "${row.documentId}" is outside the frozen revision.`,
      };
    }
    if (!Number.isInteger(row.grade) || row.grade < 0 || row.grade > 3) {
      return {
        valid: false,
        reason: `Qrel grade ${row.grade} is outside 0..3.`,
      };
    }
    const prev = byDoc.get(row.documentId) ?? -1;
    byDoc.set(row.documentId, Math.max(prev, row.grade));
  }

  if (!answerable) {
    // Unanswerable tasks have no positively relevant documents.
    for (const span of validatedSpans) {
      if (!byDoc.has(span.documentId)) byDoc.set(span.documentId, 0);
    }
    const zeroed = Array.from(byDoc.keys())
      .sort()
      .map((documentId) => ({ documentId, grade: 0 }));
    return { valid: true, qrels: zeroed };
  }

  // Ensure every validated supporting span's document has a positive relevance grade.
  for (const span of validatedSpans) {
    const existing = byDoc.get(span.documentId);
    if (existing === undefined || existing === 0) {
      byDoc.set(span.documentId, 3);
    }
  }
  const qrels = Array.from(byDoc.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([documentId, grade]) => ({ documentId, grade }));
  return { valid: true, qrels };
}

/**
 * Detects near-verbatim copying from corpus texts into a proposed reference answer.
 * Evaluates normalized word-boundary contiguous matches against every corpus document.
 */
export function computeVerbatimLeakage(
  expectedAnswer: string,
  corpusTexts: string[],
): LeakageAssessment {
  const { normalized: answerNorm, words: answerWords } =
    tokenizeNormalized(expectedAnswer);
  const totalWords = answerWords.length;
  if (totalWords === 0 || corpusTexts.length === 0) {
    return {
      score: 0,
      flagged: false,
      reason: null,
      longestMatchWords: 0,
      longestMatchChars: 0,
      matchedWords: 0,
      totalWords,
    };
  }

  const paddedCorpus = corpusTexts
    .map((text) => tokenizeNormalized(text).normalized)
    .filter((norm) => norm.length > 0)
    .map((norm) => ` ${norm} `);

  if (paddedCorpus.length === 0) {
    return {
      score: 0,
      flagged: false,
      reason: null,
      longestMatchWords: 0,
      longestMatchChars: 0,
      matchedWords: 0,
      totalWords,
    };
  }

  const containsPhrase = (phrase: string) => {
    const needle = ` ${phrase} `;
    for (const doc of paddedCorpus) {
      if (doc.includes(needle)) return true;
    }
    return false;
  };

  const covered = new Array<boolean>(totalWords).fill(false);
  let longestMatchWords = 0;
  let longestMatchChars = 0;

  for (let start = 0; start < totalWords; start++) {
    let phrase = answerWords[start];
    if (!containsPhrase(phrase)) continue;

    let end = start + 1;
    let bestEnd = end;
    let bestPhrase = phrase;
    while (end < totalWords) {
      const nextPhrase = `${phrase} ${answerWords[end]}`;
      if (!containsPhrase(nextPhrase)) break;
      phrase = nextPhrase;
      end += 1;
      bestEnd = end;
      bestPhrase = phrase;
    }

    const runWords = bestEnd - start;
    const runChars = bestPhrase.length;
    if (runWords > longestMatchWords) longestMatchWords = runWords;
    if (runChars > longestMatchChars) longestMatchChars = runChars;

    if (
      runWords >= 4 ||
      (runWords >= 3 && runChars >= LEAKAGE_MIN_ANSWER_CHARS)
    ) {
      for (let idx = start; idx < bestEnd; idx++) {
        covered[idx] = true;
      }
    }
  }

  const matchedWords = covered.filter(Boolean).length;
  const verbatimRatio = matchedWords / totalWords;
  const score = Number(
    Math.min(
      1,
      Math.max(
        verbatimRatio,
        longestMatchWords >= 4 ? longestMatchWords / totalWords : 0,
      ),
    ).toFixed(4),
  );

  const meetsMinLength =
    totalWords >= LEAKAGE_MIN_ANSWER_WORDS &&
    answerNorm.length >= LEAKAGE_MIN_ANSWER_CHARS;
  const exceedsThreshold =
    verbatimRatio >= LEAKAGE_VERBATIM_RATIO_THRESHOLD ||
    longestMatchWords >= LEAKAGE_MAX_CONTIGUOUS_WORDS ||
    longestMatchChars >= LEAKAGE_MAX_CONTIGUOUS_CHARS;
  const flagged = meetsMinLength && exceedsThreshold;

  const pct = Math.round(score * 100);
  const reason = flagged
    ? `Reference answer copies ${pct}% (${matchedWords}/${totalWords} words; longest verbatim run ${longestMatchWords} words / ${longestMatchChars} chars) from source text, exceeding the leakage threshold (${Math.round(LEAKAGE_VERBATIM_RATIO_THRESHOLD * 100)}% overlap or >= ${LEAKAGE_MAX_CONTIGUOUS_WORDS} consecutive words / ${LEAKAGE_MAX_CONTIGUOUS_CHARS} chars). Paraphrase before promoting.`
    : null;

  return {
    score,
    flagged,
    reason,
    longestMatchWords,
    longestMatchChars,
    matchedWords,
    totalWords,
  };
}
