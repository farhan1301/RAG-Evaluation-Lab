import type { Indexes } from '../db/indexes.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { GenerationVectorPoint, QdrantStore } from './qdrant.js';

export interface RebuildQdrantOptions {
  indexes: Indexes;
  providers: ProviderRegistry;
  qdrant: QdrantStore;
  generationId?: string;
  embedBatchSize?: number;
  qdrantBatchSize?: number;
  signal?: AbortSignal;
}

export interface RebuiltGenerationSummary {
  generationId: string;
  datasetId: string;
  datasetRevision: number;
  mode: 'dense' | 'hybrid';
  embeddingModel: string;
  collection: string;
  dimensions: number;
  pointCount: number;
}

export interface RebuildQdrantResult {
  rebuiltCount: number;
  generations: RebuiltGenerationSummary[];
}

/**
 * Rebuilds Qdrant vector points directly from SQLite's authoritative ready
 * dense/hybrid index generations (generation_chunks), preserving generation IDs,
 * deterministic point IDs, and all required payload filter indexes.
 */
export async function rebuildQdrantFromSqlite(
  options: RebuildQdrantOptions,
): Promise<RebuildQdrantResult> {
  const { indexes, providers, qdrant, generationId, signal } = options;
  const embedBatchSize = options.embedBatchSize ?? 64;
  const qdrantBatchSize = options.qdrantBatchSize ?? 100;

  const targets = indexes.listReadyDenseGenerations(generationId);
  const rebuilt: RebuiltGenerationSummary[] = [];

  for (const gen of targets) {
    signal?.throwIfAborted();
    if (gen.mode !== 'dense' && gen.mode !== 'hybrid') continue;
    if (!gen.embeddingModel) {
      throw new ProviderError(
        'missing_capability',
        `Index generation "${gen.id}" has no recorded embedding model.`,
      );
    }

    const chunks = indexes.allChunks(gen.id);
    if (chunks.length === 0) {
      throw new ProviderError(
        'invalid_input',
        `Index generation "${gen.id}" has no stored chunks in SQLite.`,
      );
    }

    const { profile, provider } = providers.resolveEmbedding(
      gen.embeddingModel,
    );
    const embedded = await provider.embed({
      model: profile.model,
      inputs: chunks.map((chunk) => chunk.content),
      expectedDimensions: gen.embeddingDimensions ?? profile.expectedDimensions,
      batchSize: embedBatchSize,
      signal,
    });

    if (embedded.vectors.length !== chunks.length || embedded.dimensions <= 0) {
      throw new ProviderError(
        'partial_batch',
        `Embedding provider returned an incomplete set of vectors for generation "${gen.id}".`,
      );
    }
    if (
      gen.embeddingDimensions !== null &&
      embedded.dimensions !== gen.embeddingDimensions
    ) {
      throw new ProviderError(
        'dimension_mismatch',
        `Generation "${gen.id}" expects ${gen.embeddingDimensions} dimensions, received ${embedded.dimensions}.`,
      );
    }

    const collection =
      gen.qdrantCollection ??
      qdrant.collectionForDimension(embedded.dimensions);
    await qdrant.ensureGenerationCollection(collection, embedded.dimensions);

    const points: GenerationVectorPoint[] = chunks.map((chunk, i) => ({
      generationId: gen.id,
      datasetId: gen.datasetId,
      datasetRevision: gen.datasetRevision,
      documentId: chunk.documentId,
      documentVersionId: chunk.documentVersionId,
      documentName: chunk.documentName,
      mimeType: chunk.mimeType,
      chunkId: chunk.chunkId,
      page: chunk.page,
      ordinal: chunk.ordinal,
      vector: embedded.vectors[i],
    }));

    await qdrant.upsertGenerationPoints(
      collection,
      points,
      qdrantBatchSize,
      () => signal?.throwIfAborted(),
    );

    await qdrant.verifyGenerationCount(
      collection,
      {
        generationId: gen.id,
        datasetId: gen.datasetId,
        datasetRevision: gen.datasetRevision,
      },
      chunks.length,
    );

    rebuilt.push({
      generationId: gen.id,
      datasetId: gen.datasetId,
      datasetRevision: gen.datasetRevision,
      mode: gen.mode,
      embeddingModel: profile.model,
      collection,
      dimensions: embedded.dimensions,
      pointCount: chunks.length,
    });
  }

  return { rebuiltCount: rebuilt.length, generations: rebuilt };
}
