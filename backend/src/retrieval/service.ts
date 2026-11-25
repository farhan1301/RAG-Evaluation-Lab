import {
  indexAnswerResult,
  indexSearchResult,
  type GenerationChunk,
  type IndexAnswerRequest,
  type IndexAnswerResult,
  type IndexSearchRequest,
  type IndexSearchResult,
  type ProviderUsage,
  type RetrievedTraceItem,
} from '@rag-eval/contracts';
import type { Indexes } from '../db/indexes.js';
import { ApiError } from '../errors.js';
import { generateGroundedAnswer } from '../providers/answer.js';
import { ProviderError } from '../providers/errors.js';
import {
  validateGenerationParams,
  type ProviderRegistry,
} from '../providers/registry.js';
import {
  compareStableId,
  reciprocalRankFuse,
  type RankedCandidate,
} from './fusion.js';
import { buildFtsQuery } from './keyword.js';
import type { QdrantStore } from './qdrant.js';

export interface RetrievalServiceOptions {
  indexes: Indexes;
  providers: ProviderRegistry;
  qdrant?: QdrantStore;
  now?: () => number;
}

interface WorkingCandidate {
  chunk: GenerationChunk;
  keywordRank: number | null;
  keywordScore: number | null;
  denseRank: number | null;
  denseScore: number | null;
  fusedRank: number | null;
  fusedScore: number | null;
  rerankRank: number | null;
  rerankScore: number | null;
  preRerankScore: number;
  preRerankRank: number;
}

export class RetrievalService {
  private readonly indexes: Indexes;
  private readonly providers: ProviderRegistry;
  private readonly qdrant?: QdrantStore;
  private readonly now: () => number;

  constructor(options: RetrievalServiceOptions) {
    this.indexes = options.indexes;
    this.providers = options.providers;
    this.qdrant = options.qdrant;
    this.now = options.now ?? Date.now;
  }

  async search(
    generationId: string,
    request: IndexSearchRequest,
    signal?: AbortSignal,
  ): Promise<IndexSearchResult> {
    const startedAt = this.now();
    const generation = this.indexes.getStored(generationId);
    if (generation.state !== 'ready') {
      throw new ApiError(
        409,
        'conflict',
        `Index generation is "${generation.state}" and not ready for search.`,
      );
    }

    const mode = request.mode ?? generation.mode;
    if (
      (mode === 'dense' || mode === 'hybrid') &&
      generation.mode === 'keyword'
    ) {
      throw new ApiError(
        422,
        'missing_capability',
        `Index generation was built in keyword mode and cannot execute "${mode}" search.`,
      );
    }

    if (request.reranker.enabled) {
      // Validate reranker capability up front before doing retrieval work.
      try {
        this.providers.resolveReranker(request.reranker.model);
      } catch (err) {
        if (err instanceof ProviderError) throw err.toApiError();
        throw err;
      }
    }

    const candidateDepth = Math.min(
      100,
      Math.max(
        request.topK,
        request.candidateDepth ?? Math.min(50, request.topK * 4),
      ),
    );

    const timingsMs: IndexSearchResult['stages']['timingsMs'] = { total: 0 };
    let keywordCandidates: RankedCandidate[] = [];
    let denseCandidates: RankedCandidate[] = [];
    let embeddingUsage: ProviderUsage | undefined;
    let rerankUsage: ProviderUsage | undefined;

    if (mode === 'keyword' || mode === 'hybrid') {
      const kwStart = this.now();
      const ftsQuery = buildFtsQuery(request.query);
      if (ftsQuery) {
        const rows = this.indexes.keywordSearch(
          generation.id,
          ftsQuery,
          request.filters,
          candidateDepth,
        );
        keywordCandidates = rows.map((row, idx) => ({
          chunk: row.chunk,
          rank: idx + 1,
          score: row.score,
        }));
      }
      timingsMs.keyword = Math.max(0, this.now() - kwStart);
    }

    if (mode === 'dense' || mode === 'hybrid') {
      if (
        !this.qdrant ||
        !generation.qdrantCollection ||
        !generation.embeddingModel ||
        !generation.embeddingDimensions
      ) {
        throw new ApiError(
          422,
          'missing_capability',
          'Dense retrieval requires Qdrant and a dense-indexed generation.',
        );
      }

      const embedStart = this.now();
      let queryVector: number[];
      try {
        const { profile, provider } = this.providers.resolveEmbedding(
          generation.embeddingModel,
        );
        const embedded = await provider.embed({
          model: profile.model,
          inputs: [request.query],
          expectedDimensions: generation.embeddingDimensions,
          signal,
        });
        if (embedded.vectors.length !== 1) {
          throw new ProviderError(
            'partial_batch',
            'Query embedding did not return exactly one vector.',
          );
        }
        queryVector = embedded.vectors[0];
        embeddingUsage = embedded.usage;
      } catch (err) {
        if (err instanceof ProviderError) throw err.toApiError();
        throw err;
      }
      timingsMs.embed = Math.max(0, this.now() - embedStart);

      const denseStart = this.now();
      try {
        const hits = await this.qdrant.searchGeneration(
          generation.qdrantCollection,
          queryVector,
          candidateDepth,
          {
            generationId: generation.id,
            datasetId: generation.datasetId,
            datasetRevision: generation.datasetRevision,
          },
          request.filters,
        );
        const chunkMap = this.indexes.chunksByIds(
          generation.id,
          hits.map((h) => h.chunkId),
        );
        const resolved = hits
          .flatMap((hit) => {
            const chunk = chunkMap.get(hit.chunkId);
            return chunk ? [{ chunk, score: hit.score }] : [];
          })
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return compareStableId(a.chunk.chunkId, b.chunk.chunkId);
          });
        denseCandidates = resolved.map((entry, idx) => ({
          chunk: entry.chunk,
          rank: idx + 1,
          score: entry.score,
        }));
      } catch (err) {
        if (err instanceof ProviderError) throw err.toApiError();
        throw new ApiError(502, 'upstream_failure', 'Qdrant search failed.');
      }
      timingsMs.dense = Math.max(0, this.now() - denseStart);
    }

    let working: WorkingCandidate[];
    let fusedCount = 0;

    if (mode === 'hybrid') {
      const fused = reciprocalRankFuse(
        keywordCandidates,
        denseCandidates,
        request.fusionWeights,
      );
      fusedCount = fused.length;
      working = fused.map((entry) => ({
        chunk: entry.chunk,
        keywordRank: entry.keywordRank,
        keywordScore: entry.keywordScore,
        denseRank: entry.denseRank,
        denseScore: entry.denseScore,
        fusedRank: entry.fusedRank,
        fusedScore: entry.fusedScore,
        rerankRank: null,
        rerankScore: null,
        preRerankScore: entry.fusedScore,
        preRerankRank: entry.fusedRank,
      }));
    } else if (mode === 'keyword') {
      working = keywordCandidates.map((entry) => ({
        chunk: entry.chunk,
        keywordRank: entry.rank,
        keywordScore: entry.score,
        denseRank: null,
        denseScore: null,
        fusedRank: null,
        fusedScore: null,
        rerankRank: null,
        rerankScore: null,
        preRerankScore: entry.score,
        preRerankRank: entry.rank,
      }));
    } else {
      working = denseCandidates.map((entry) => ({
        chunk: entry.chunk,
        keywordRank: null,
        keywordScore: null,
        denseRank: entry.rank,
        denseScore: entry.score,
        fusedRank: null,
        fusedScore: null,
        rerankRank: null,
        rerankScore: null,
        preRerankScore: entry.score,
        preRerankRank: entry.rank,
      }));
    }

    let reranked = false;
    let rerankStatus: 'skipped' | 'applied' | 'fallback' = 'skipped';
    let rerankError: string | null = null;

    if (request.reranker.enabled && working.length > 0) {
      const rerankStart = this.now();
      const bounded = working.slice(0, candidateDepth);
      try {
        const { profile, provider } = this.providers.resolveReranker(
          request.reranker.model,
        );
        const result = await provider.rerank({
          model: profile.model,
          query: request.query,
          documents: bounded.map((c) => c.chunk.content),
          topN: request.topK,
          signal,
        });
        rerankUsage = result.usage;

        const scoreByIndex = new Map<number, number>();
        for (const entry of result.results) {
          scoreByIndex.set(entry.index, entry.score);
        }

        const reordered = bounded
          .flatMap((candidate, idx) => {
            const score = scoreByIndex.get(idx);
            return score !== undefined
              ? [{ ...candidate, rerankScore: score }]
              : [];
          })
          .sort((a, b) => {
            if (b.rerankScore !== a.rerankScore)
              return b.rerankScore - a.rerankScore;
            if (a.preRerankRank !== b.preRerankRank)
              return a.preRerankRank - b.preRerankRank;
            return compareStableId(a.chunk.chunkId, b.chunk.chunkId);
          });

        working = reordered.map((candidate, idx) => ({
          ...candidate,
          rerankRank: idx + 1,
        }));
        reranked = true;
        rerankStatus = 'applied';
      } catch (err) {
        const safeMessage =
          err instanceof ProviderError || err instanceof ApiError
            ? err.message
            : 'Reranker failed.';
        if (request.reranker.failurePolicy === 'fail') {
          if (err instanceof ProviderError) throw err.toApiError();
          if (err instanceof ApiError) throw err;
          throw new ApiError(502, 'upstream_failure', safeMessage);
        }
        rerankStatus = 'fallback';
        rerankError = safeMessage;
      }
      timingsMs.rerank = Math.max(0, this.now() - rerankStart);
    }

    const items: RetrievedTraceItem[] = working
      .slice(0, request.topK)
      .map((entry, idx) => ({
        chunkId: entry.chunk.chunkId,
        documentId: entry.chunk.documentId,
        documentVersionId: entry.chunk.documentVersionId,
        documentName: entry.chunk.documentName,
        mimeType: entry.chunk.mimeType,
        ordinal: entry.chunk.ordinal,
        start: entry.chunk.start,
        end: entry.chunk.end,
        page: entry.chunk.page,
        content: entry.chunk.content,
        keywordRank: entry.keywordRank,
        keywordScore: entry.keywordScore,
        denseRank: entry.denseRank,
        denseScore: entry.denseScore,
        fusedRank: entry.fusedRank,
        fusedScore: entry.fusedScore,
        rerankRank: entry.rerankRank,
        rerankScore: entry.rerankScore,
        finalRank: idx + 1,
        finalScore: entry.rerankScore ?? entry.preRerankScore,
      }));

    timingsMs.total = Math.max(0, this.now() - startedAt);
    const hasUsage = Boolean(embeddingUsage || rerankUsage);

    return indexSearchResult.parse({
      generationId: generation.id,
      datasetId: generation.datasetId,
      datasetRevision: generation.datasetRevision,
      mode,
      query: request.query,
      topK: request.topK,
      candidateDepth,
      filters: request.filters ?? null,
      items,
      stages: {
        keywordCount: keywordCandidates.length,
        denseCount: denseCandidates.length,
        fusedCount,
        reranked,
        rerankStatus,
        rerankError,
        timingsMs,
      },
      ...(hasUsage
        ? {
            usage: {
              ...(embeddingUsage ? { embedding: embeddingUsage } : {}),
              ...(rerankUsage ? { rerank: rerankUsage } : {}),
            },
          }
        : {}),
    });
  }

  async answer(
    generationId: string,
    request: IndexAnswerRequest,
    signal?: AbortSignal,
  ): Promise<IndexAnswerResult> {
    let resolvedChat: ReturnType<ProviderRegistry['resolveChat']>;
    try {
      resolvedChat = this.providers.resolveChat('chat', request.model);
    } catch (err) {
      if (err instanceof ProviderError) throw err.toApiError();
      throw err;
    }

    // Validate generation parameters against provider capabilities BEFORE running retrieval or inference.
    validateGenerationParams(resolvedChat.profile, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    });

    const retrieval = await this.search(
      generationId,
      {
        query: request.query,
        mode: request.mode,
        topK: request.topK,
        candidateDepth: request.candidateDepth,
        fusionWeights: request.fusionWeights,
        filters: request.filters,
        reranker: request.reranker,
      },
      signal,
    );

    try {
      const generated = await generateGroundedAnswer({
        question: request.query,
        items: retrieval.items,
        provider: resolvedChat.provider,
        model: resolvedChat.profile.model,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        contextBudgetChars: request.contextBudgetChars,
        signal,
        now: this.now,
      });

      return indexAnswerResult.parse({
        ...generated,
        retrieval,
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err.toApiError();
      throw err;
    }
  }
}
