import {
  indexAnswerResult,
  indexSearchResult,
  type GenerationChunk,
  type IndexAnswerRequest,
  type IndexAnswerResult,
  type IndexSearchRequest,
  type IndexSearchResult,
  type ProviderKind,
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

export interface RetrievalProviderCallAudit {
  callId?: string;
  operation: 'query_embed' | 'rerank';
  provider: ProviderKind;
  model: string;
  requestId: string | null;
  latencyMs: number;
  usage?: ProviderUsage;
  status: 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'ambiguous';
  errorCode: string | null;
}

export interface SearchAuditHooks {
  expectedEmbeddingProvider?: ProviderKind;
  expectedEmbeddingEndpoint?: string;
  expectedRerankerProvider?: ProviderKind;
  expectedRerankerModel?: string;
  expectedRerankerEndpoint?: string;
  onProviderCallStart?: (call: {
    operation: 'query_embed' | 'rerank';
    provider: ProviderKind;
    model: string;
  }) => string | undefined;
  onProviderCall?: (call: RetrievalProviderCallAudit) => void;
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
    audit?: SearchAuditHooks,
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
      // Validate reranker capability (including frozen default model & endpoint) up front before doing retrieval work.
      try {
        this.providers.resolveReranker(
          audit?.expectedRerankerModel || request.reranker.model,
          audit?.expectedRerankerProvider,
          audit?.expectedRerankerEndpoint,
        );
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
      const expectedEmbedProvider =
        audit?.expectedEmbeddingProvider ??
        generation.embeddingProvider ??
        undefined;
      const expectedEmbedEndpoint =
        audit?.expectedEmbeddingEndpoint ??
        generation.embeddingEndpoint ??
        undefined;
      if (
        audit?.expectedEmbeddingProvider &&
        generation.embeddingProvider &&
        audit.expectedEmbeddingProvider !== generation.embeddingProvider
      ) {
        throw new ApiError(
          422,
          'missing_capability',
          `Frozen embedding provider "${audit.expectedEmbeddingProvider}" does not match index generation provider "${generation.embeddingProvider}".`,
        );
      }
      if (
        audit?.expectedEmbeddingEndpoint &&
        generation.embeddingEndpoint &&
        audit.expectedEmbeddingEndpoint !== generation.embeddingEndpoint
      ) {
        throw new ApiError(
          422,
          'missing_capability',
          'Frozen embedding endpoint does not match index generation endpoint.',
        );
      }
      const { profile, provider } = (() => {
        try {
          return this.providers.resolveEmbedding(
            generation.embeddingModel,
            expectedEmbedProvider,
            expectedEmbedEndpoint,
          );
        } catch (err) {
          if (err instanceof ProviderError) throw err.toApiError();
          throw err;
        }
      })();
      const embedCallId =
        audit?.onProviderCallStart?.({
          operation: 'query_embed',
          provider: provider.kind,
          model: profile.model,
        }) ?? undefined;
      let embedAudited = false;
      try {
        const embedded = await provider.embed({
          model: profile.model,
          inputs: [request.query],
          expectedDimensions: generation.embeddingDimensions,
          signal,
        });
        const embedLatency = Math.max(0, this.now() - embedStart);
        if (embedded.vectors.length !== 1) {
          embedAudited = true;
          audit?.onProviderCall?.({
            callId: embedCallId,
            operation: 'query_embed',
            provider: embedded.provider,
            model: embedded.model,
            requestId: embedded.requestIds[0] ?? null,
            latencyMs: embedLatency,
            usage: embedded.usage,
            status: 'failed',
            errorCode: 'partial_batch',
          });
          throw new ProviderError(
            'partial_batch',
            'Query embedding did not return exactly one vector.',
            {
              callMeta: {
                provider: embedded.provider,
                model: embedded.model,
                requestId: embedded.requestIds[0] ?? null,
                usage: embedded.usage,
                latencyMs: embedLatency,
              },
            },
          );
        }
        embedAudited = true;
        audit?.onProviderCall?.({
          callId: embedCallId,
          operation: 'query_embed',
          provider: embedded.provider,
          model: embedded.model,
          requestId: embedded.requestIds[0] ?? null,
          latencyMs: embedLatency,
          usage: embedded.usage,
          status: 'succeeded',
          errorCode: null,
        });
        queryVector = embedded.vectors[0];
        embeddingUsage = embedded.usage;
      } catch (err) {
        const embedLatency = Math.max(0, this.now() - embedStart);
        if (!embedAudited) {
          const isTimeout =
            err instanceof ProviderError && err.code === 'timeout';
          const callMeta =
            err instanceof ProviderError ? err.callMeta : undefined;
          embedAudited = true;
          audit?.onProviderCall?.({
            callId: embedCallId,
            operation: 'query_embed',
            provider: callMeta?.provider ?? provider.kind,
            model: callMeta?.model ?? profile.model,
            requestId: callMeta?.requestId ?? null,
            latencyMs: callMeta?.latencyMs ?? embedLatency,
            usage: callMeta?.usage,
            status: signal?.aborted
              ? 'cancelled'
              : isTimeout
                ? 'ambiguous'
                : 'failed',
            errorCode:
              err instanceof ProviderError ? err.code : 'upstream_failure',
          });
        }
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
      const { profile, provider } = (() => {
        try {
          return this.providers.resolveReranker(
            audit?.expectedRerankerModel || request.reranker.model,
            audit?.expectedRerankerProvider,
            audit?.expectedRerankerEndpoint,
          );
        } catch (err) {
          if (err instanceof ProviderError) throw err.toApiError();
          throw err;
        }
      })();
      const rerankCallId =
        audit?.onProviderCallStart?.({
          operation: 'rerank',
          provider: provider.kind,
          model: profile.model,
        }) ?? undefined;
      let rerankAudited = false;
      try {
        const result = await provider.rerank({
          model: profile.model,
          query: request.query,
          documents: bounded.map((c) => c.chunk.content),
          topN: Math.min(request.topK, bounded.length),
          signal,
        });
        rerankUsage = result.usage;
        rerankAudited = true;
        audit?.onProviderCall?.({
          callId: rerankCallId,
          operation: 'rerank',
          provider: provider.kind,
          model: result.model,
          requestId: result.requestId,
          latencyMs: Math.max(0, this.now() - rerankStart),
          usage: result.usage,
          status: 'succeeded',
          errorCode: null,
        });

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
        if (!rerankAudited) {
          const isTimeout =
            err instanceof ProviderError && err.code === 'timeout';
          rerankAudited = true;
          audit?.onProviderCall?.({
            callId: rerankCallId,
            operation: 'rerank',
            provider: provider.kind,
            model: profile.model,
            requestId: null,
            latencyMs: Math.max(0, this.now() - rerankStart),
            status: signal?.aborted
              ? 'cancelled'
              : isTimeout
                ? 'ambiguous'
                : 'failed',
            errorCode:
              err instanceof ProviderError ? err.code : 'upstream_failure',
          });
        }
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

  async answerFromSearch(
    retrieval: IndexSearchResult,
    options: {
      question?: string;
      model?: string;
      provider?: ProviderKind;
      expectedEndpoint?: string;
      expectedStructuredOutput?: boolean;
      temperature?: number;
      maxTokens?: number;
      contextBudgetChars?: number;
      onBeforeCall?: (info: { provider: ProviderKind; model: string }) => void;
    },
    signal?: AbortSignal,
  ): Promise<IndexAnswerResult> {
    let resolvedChat: ReturnType<ProviderRegistry['resolveChat']>;
    try {
      resolvedChat = this.providers.resolveChat(
        'chat',
        options.model,
        options.provider,
        options.expectedEndpoint,
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err.toApiError();
      throw err;
    }

    validateGenerationParams(resolvedChat.profile, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    if (
      options.expectedStructuredOutput !== undefined &&
      resolvedChat.profile.capabilities.structuredOutput !==
        options.expectedStructuredOutput
    ) {
      throw new ApiError(
        422,
        'missing_capability',
        `Frozen chat profile "${resolvedChat.profile.provider}/${resolvedChat.profile.model}" structured-output capability has changed.`,
      );
    }

    options.onBeforeCall?.({
      provider: resolvedChat.profile.provider,
      model: resolvedChat.profile.model,
    });

    try {
      const generated = await generateGroundedAnswer({
        question: options.question ?? retrieval.query,
        items: retrieval.items,
        provider: resolvedChat.provider,
        model: resolvedChat.profile.model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        contextBudgetChars: options.contextBudgetChars,
        signal,
        now: this.now,
      });

      return indexAnswerResult.parse({
        ...generated,
        retrieval,
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw err;
    }
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
      return await this.answerFromSearch(
        retrieval,
        {
          question: request.query,
          model: request.model,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          contextBudgetChars: request.contextBudgetChars,
        },
        signal,
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err.toApiError();
      throw err;
    }
  }
}
