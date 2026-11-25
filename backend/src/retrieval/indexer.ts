import { setImmediate } from 'node:timers/promises';
import type { GenerationChunk, ProviderUsage } from '@rag-eval/contracts';
import type { Indexes } from '../db/indexes.js';
import { LostLease } from '../db/jobs.js';
import { ApiError } from '../errors.js';
import { chunkArtifact, generationChunkId } from '../ingestion/chunks.js';
import { mediaType } from '../ingestion/blobs.js';
import { parseLocal } from '../ingestion/local.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { GenerationVectorPoint, QdrantStore } from './qdrant.js';

export interface IndexBuilderOptions {
  indexes: Indexes;
  providers: ProviderRegistry;
  qdrant?: QdrantStore;
  embedBatchSize?: number;
  qdrantBatchSize?: number;
  now?: () => number;
}

export interface EmbedCallAudit {
  callId?: string;
  batchIndex: number;
  provider: 'openai' | 'openai-compatible';
  model: string;
  requestIds: string[];
  usage?: ProviderUsage;
  latencyMs: number;
  status: 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'ambiguous';
  errorCode: string | null;
}

export interface BuildHooks {
  signal?: AbortSignal;
  guard?: () => void;
  checkpoint?: (stage: string) => void;
  beforeEmbedBatch?: (info: {
    batchIndex: number;
    totalBatches: number;
    provider: 'openai' | 'openai-compatible';
    model: string;
  }) => void;
  onEmbedBatchStart?: (info: {
    batchIndex: number;
    provider: 'openai' | 'openai-compatible';
    model: string;
  }) => string | undefined;
  onEmbedCall?: (audit: EmbedCallAudit) => void;
}

export class IndexBuilder {
  private readonly indexes: Indexes;
  private readonly providers: ProviderRegistry;
  private readonly qdrant?: QdrantStore;
  private readonly embedBatchSize: number;
  private readonly qdrantBatchSize: number;
  private readonly now: () => number;

  constructor(options: IndexBuilderOptions) {
    this.indexes = options.indexes;
    this.providers = options.providers;
    this.qdrant = options.qdrant;
    this.embedBatchSize = options.embedBatchSize ?? 64;
    this.qdrantBatchSize = options.qdrantBatchSize ?? 100;
    this.now = options.now ?? Date.now;
  }

  async build(generationId: string, hooks: BuildHooks = {}) {
    const generation = this.indexes.getStored(generationId);
    if (generation.state === 'ready') return this.indexes.get(generationId);
    if (generation.state !== 'building') {
      throw new ApiError(
        409,
        'conflict',
        `Index generation is in "${generation.state}" state.`,
      );
    }

    const docs = this.indexes.generationSourceDocuments(generationId);

    hooks.signal?.throwIfAborted();
    hooks.guard?.();
    hooks.checkpoint?.('chunking');

    let allChunks: GenerationChunk[] = [];
    let batch: GenerationChunk[] = [];

    for (const doc of docs) {
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      let extraction = doc.extraction;
      let artifactId = doc.artifactId;
      if (!extraction || !artifactId) {
        const mime = mediaType(doc.name, doc.mimeType || 'text/plain');
        extraction = await parseLocal(
          Buffer.from(doc.inline),
          mime,
          hooks.signal,
        );
        artifactId = this.indexes.ensureInlineArtifact(
          doc.hash,
          mime,
          extraction,
        );
      }

      const artifactChunks = Array.from(
        chunkArtifact(artifactId, extraction, generation.chunking),
      );
      this.indexes.saveArtifactChunks(artifactId, artifactChunks);

      for (const chunk of artifactChunks) {
        hooks.signal?.throwIfAborted();
        const row: GenerationChunk = {
          chunkId: generationChunkId(doc.documentVersionId, chunk.id),
          documentId: doc.documentId,
          documentVersionId: doc.documentVersionId,
          documentName: doc.name,
          mimeType: doc.mimeType,
          ordinal: chunk.ordinal,
          start: chunk.start,
          end: chunk.end,
          page: chunk.page,
          contentHash: chunk.hash,
          content: chunk.content,
        };
        allChunks.push(row);
        batch.push(row);
        if (batch.length === 250) {
          hooks.guard?.();
          this.indexes.writeGenerationChunks(generationId, batch);
          batch = [];
          await setImmediate();
        }
      }
    }

    if (batch.length) {
      hooks.guard?.();
      this.indexes.writeGenerationChunks(generationId, batch);
      batch = [];
    }

    // Re-read authoritative sorted chunks from SQLite (ensuring idempotent resume if retried).
    allChunks = this.indexes.allChunks(generationId);
    if (!allChunks.length) {
      throw new ProviderError(
        'invalid_input',
        'No indexable chunks were produced for this dataset revision.',
      );
    }

    const counts = this.indexes.verifySqliteCounts(generationId);
    if (
      counts.chunkCount !== allChunks.length ||
      counts.ftsCount !== allChunks.length
    ) {
      throw new ProviderError(
        'upstream_failure',
        'SQLite FTS verification failed before index publication.',
      );
    }

    let embeddingDimensions: number | undefined;
    let qdrantCollection: string | undefined;

    if (generation.mode === 'dense' || generation.mode === 'hybrid') {
      if (!this.qdrant) {
        throw new ProviderError(
          'missing_capability',
          'Configure QDRANT_URL before building a dense or hybrid index.',
        );
      }
      if (!generation.embeddingModel) {
        throw new ProviderError(
          'missing_capability',
          'An embedding model is required for dense or hybrid indexing.',
        );
      }

      const { profile, provider } = this.providers.resolveEmbedding(
        generation.embeddingModel,
        generation.embeddingProvider ?? undefined,
        generation.embeddingEndpoint ?? undefined,
      );
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      hooks.checkpoint?.('embedding');

      const batchSize = Math.max(1, Math.min(2048, this.embedBatchSize));
      const totalBatches = Math.ceil(allChunks.length / batchSize);
      const vectors: number[][] = [];
      let expectedDimensions = profile.expectedDimensions;

      for (
        let offset = 0, batchIndex = 0;
        offset < allChunks.length;
        offset += batchSize, batchIndex += 1
      ) {
        hooks.signal?.throwIfAborted();
        hooks.guard?.();
        hooks.beforeEmbedBatch?.({
          batchIndex,
          totalBatches,
          provider: provider.kind,
          model: profile.model,
        });

        const batchInputs = allChunks
          .slice(offset, offset + batchSize)
          .map((c) => c.content);
        const batchStart = this.now();
        const callId =
          hooks.onEmbedBatchStart?.({
            batchIndex,
            provider: provider.kind,
            model: profile.model,
          }) ?? undefined;

        let batchAudited = false;
        try {
          const embedded = await provider.embed({
            model: profile.model,
            inputs: batchInputs,
            expectedDimensions,
            batchSize: batchInputs.length,
            signal: hooks.signal,
          });
          const latencyMs = Math.max(0, this.now() - batchStart);

          if (
            embedded.vectors.length !== batchInputs.length ||
            embedded.dimensions <= 0
          ) {
            batchAudited = true;
            hooks.onEmbedCall?.({
              callId,
              batchIndex,
              provider: embedded.provider,
              model: embedded.model,
              requestIds: embedded.requestIds,
              usage: embedded.usage,
              latencyMs,
              status: 'failed',
              errorCode: 'partial_batch',
            });
            throw new ProviderError(
              'partial_batch',
              'Embedding provider returned an incomplete set of vectors.',
            );
          }

          if (expectedDimensions === undefined) {
            expectedDimensions = embedded.dimensions;
          } else if (embedded.dimensions !== expectedDimensions) {
            batchAudited = true;
            hooks.onEmbedCall?.({
              callId,
              batchIndex,
              provider: embedded.provider,
              model: embedded.model,
              requestIds: embedded.requestIds,
              usage: embedded.usage,
              latencyMs,
              status: 'failed',
              errorCode: 'dimension_mismatch',
            });
            throw new ProviderError(
              'dimension_mismatch',
              `Embedding dimension mismatch: expected ${expectedDimensions}, received ${embedded.dimensions}.`,
            );
          }

          batchAudited = true;
          hooks.onEmbedCall?.({
            callId,
            batchIndex,
            provider: embedded.provider,
            model: embedded.model,
            requestIds: embedded.requestIds,
            usage: embedded.usage,
            latencyMs,
            status: 'succeeded',
            errorCode: null,
          });
          vectors.push(...embedded.vectors);
        } catch (err) {
          if (!batchAudited && !(err instanceof LostLease)) {
            const isTimeout =
              err instanceof ProviderError && err.code === 'timeout';
            const isAborted = Boolean(hooks.signal?.aborted);
            const callMeta =
              err instanceof ProviderError ? err.callMeta : undefined;
            hooks.onEmbedCall?.({
              callId,
              batchIndex,
              provider:
                callMeta?.provider === 'openai' ||
                callMeta?.provider === 'openai-compatible'
                  ? callMeta.provider
                  : provider.kind,
              model: callMeta?.model ?? profile.model,
              requestIds: callMeta?.requestId ? [callMeta.requestId] : [],
              usage: callMeta?.usage,
              latencyMs: Math.max(0, this.now() - batchStart),
              status: isAborted
                ? 'cancelled'
                : isTimeout
                  ? 'ambiguous'
                  : 'failed',
              errorCode:
                err instanceof ProviderError ? err.code : 'upstream_failure',
            });
          }
          throw err;
        }
      }

      if (vectors.length !== allChunks.length || !expectedDimensions) {
        throw new ProviderError(
          'partial_batch',
          'Embedding provider returned an incomplete set of vectors.',
        );
      }
      embeddingDimensions = expectedDimensions;
      qdrantCollection =
        this.qdrant.collectionForDimension(embeddingDimensions);

      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      this.indexes.recordQdrantCollection(generationId, qdrantCollection);
      hooks.checkpoint?.('indexing-vectors');

      await this.qdrant.ensureGenerationCollection(
        qdrantCollection,
        embeddingDimensions,
      );

      const points: GenerationVectorPoint[] = allChunks.map((chunk, i) => ({
        generationId,
        datasetId: generation.datasetId,
        datasetRevision: generation.datasetRevision,
        documentId: chunk.documentId,
        documentVersionId: chunk.documentVersionId,
        documentName: chunk.documentName,
        mimeType: chunk.mimeType,
        chunkId: chunk.chunkId,
        page: chunk.page,
        ordinal: chunk.ordinal,
        vector: vectors[i],
      }));

      await this.qdrant.upsertGenerationPoints(
        qdrantCollection,
        points,
        this.qdrantBatchSize,
        () => {
          hooks.signal?.throwIfAborted();
          hooks.guard?.();
        },
      );

      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      hooks.checkpoint?.('verifying');

      await this.qdrant.verifyGenerationCount(
        qdrantCollection,
        {
          generationId,
          datasetId: generation.datasetId,
          datasetRevision: generation.datasetRevision,
        },
        allChunks.length,
      );
    }

    hooks.signal?.throwIfAborted();
    hooks.guard?.();
    this.indexes.markReady(generationId, {
      chunkCount: allChunks.length,
      embeddingDimensions,
      qdrantCollection,
    });
    return this.indexes.get(generationId);
  }

  /**
   * Cleans up Qdrant points ONLY after the generation has entered an irreversible
   * `failed` state in SQLite, preventing a stale worker from deleting vectors of a
   * generation reclaimed and published by another worker.
   */
  async cleanupFailedGeneration(generationId: string): Promise<void> {
    if (!this.qdrant) return;
    let gen: ReturnType<Indexes['getStored']>;
    try {
      gen = this.indexes.getStored(generationId);
    } catch {
      return;
    }
    if (gen.state !== 'failed' || !gen.qdrantCollection) return;
    await this.qdrant
      .deleteGenerationPoints(gen.qdrantCollection, generationId)
      .catch(() => {});
  }

  async buildAndFinalize(generationId: string, signal?: AbortSignal) {
    try {
      return await this.build(generationId, { signal });
    } catch (err) {
      const message =
        err instanceof ProviderError || err instanceof ApiError
          ? err.message
          : 'Index build failed.';
      if (this.indexes.markFailed(generationId, message)) {
        await this.cleanupFailedGeneration(generationId);
      }
      throw err;
    }
  }
}
