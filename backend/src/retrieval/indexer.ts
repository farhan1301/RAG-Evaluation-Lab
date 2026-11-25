import { setImmediate } from 'node:timers/promises';
import type { GenerationChunk } from '@rag-eval/contracts';
import type { Indexes } from '../db/indexes.js';
import { ApiError } from '../errors.js';
import { chunkArtifact } from '../ingestion/chunks.js';
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
}

export interface BuildHooks {
  signal?: AbortSignal;
  guard?: () => void;
  checkpoint?: (stage: string) => void;
}

export class IndexBuilder {
  private readonly indexes: Indexes;
  private readonly providers: ProviderRegistry;
  private readonly qdrant?: QdrantStore;
  private readonly embedBatchSize: number;
  private readonly qdrantBatchSize: number;

  constructor(options: IndexBuilderOptions) {
    this.indexes = options.indexes;
    this.providers = options.providers;
    this.qdrant = options.qdrant;
    this.embedBatchSize = options.embedBatchSize ?? 64;
    this.qdrantBatchSize = options.qdrantBatchSize ?? 100;
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

    const docs = this.indexes.revisionDocuments(
      generation.datasetId,
      generation.datasetRevision,
    );

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
          chunkId: chunk.id,
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
      );
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      hooks.checkpoint?.('embedding');

      const embedded = await provider.embed({
        model: profile.model,
        inputs: allChunks.map((c) => c.content),
        expectedDimensions: profile.expectedDimensions,
        batchSize: this.embedBatchSize,
        signal: hooks.signal,
      });

      if (
        embedded.vectors.length !== allChunks.length ||
        embedded.dimensions <= 0
      ) {
        throw new ProviderError(
          'partial_batch',
          'Embedding provider returned an incomplete set of vectors.',
        );
      }
      embeddingDimensions = embedded.dimensions;
      qdrantCollection =
        this.qdrant.collectionForDimension(embeddingDimensions);

      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      hooks.checkpoint?.('indexing-vectors');

      try {
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
          vector: embedded.vectors[i],
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
      } catch (err) {
        // Best-effort cleanup of ONLY this failed generation's vectors; prior ready generations remain untouched.
        await this.qdrant
          .deleteGenerationPoints(qdrantCollection, generationId)
          .catch(() => {});
        throw err;
      }
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

  async buildAndFinalize(generationId: string, signal?: AbortSignal) {
    try {
      return await this.build(generationId, { signal });
    } catch (err) {
      const message =
        err instanceof ProviderError || err instanceof ApiError
          ? err.message
          : 'Index build failed.';
      this.indexes.markFailed(generationId, message);
      throw err;
    }
  }
}
