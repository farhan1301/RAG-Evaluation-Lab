import { QdrantClient } from '@qdrant/js-client-rest';
import type { MetadataFilters } from '@rag-eval/contracts';
import { sha256 } from '../ingestion/chunks.js';
import { ProviderError } from '../providers/errors.js';

export interface GenerationScope {
  generationId: string;
  datasetId: string;
  datasetRevision: number;
}

export interface GenerationVectorPoint {
  generationId: string;
  datasetId: string;
  datasetRevision: number;
  documentId: string;
  documentVersionId: string;
  documentName: string;
  mimeType: string;
  chunkId: string;
  page: number;
  ordinal: number;
  vector: number[];
}

export interface DenseSearchHit {
  chunkId: string;
  pointId: string;
  score: number;
  payload: Record<string, unknown>;
}

export type QdrantFilterCondition =
  | { key: string; match: { value: string | number } | { any: string[] } }
  | { key: string; range: { gte?: number; lte?: number } };

export interface QdrantFilter {
  must: QdrantFilterCondition[];
}

export interface QdrantClientLike {
  collectionExists(collectionName: string): Promise<{ exists: boolean }>;
  getCollection(collectionName: string): Promise<{
    config?: {
      params?: {
        vectors?: { size?: number } | Record<string, { size?: number }>;
      };
    };
  }>;
  createCollection(
    collectionName: string,
    args: { vectors: { size: number; distance: 'Cosine' } },
  ): Promise<unknown>;
  createPayloadIndex(
    collectionName: string,
    args: {
      field_name: string;
      field_schema: 'keyword' | 'integer';
      wait?: boolean;
    },
  ): Promise<unknown>;
  upsert(
    collectionName: string,
    args: {
      wait?: boolean;
      points: Array<{
        id: string;
        vector: number[];
        payload: Record<string, unknown>;
      }>;
    },
  ): Promise<unknown>;
  query(
    collectionName: string,
    args: {
      query: number[];
      limit: number;
      filter: QdrantFilter;
      with_payload: boolean;
      with_vector: boolean;
    },
  ): Promise<{
    points: Array<{
      id: string | number;
      score: number;
      payload?: Record<string, unknown> | null;
    }>;
  }>;
  count(
    collectionName: string,
    args: { filter: QdrantFilter; exact?: boolean },
  ): Promise<{ count: number }>;
  delete(
    collectionName: string,
    args: { wait?: boolean; filter: QdrantFilter },
  ): Promise<unknown>;
  deleteCollection(collectionName: string): Promise<unknown>;
}

const RESERVED_PAYLOAD_FIELDS = new Set([
  'generationId',
  'datasetId',
  'datasetRevision',
  'documentId',
  'documentVersionId',
  'documentName',
  'mimeType',
  'chunkId',
  'page',
  'pipelineId',
  'text',
]);

export function hasReservedPayloadField(metadata: Record<string, unknown>) {
  return Object.keys(metadata).some((key) => RESERVED_PAYLOAD_FIELDS.has(key));
}

function sanitizeCollection(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'default'
  );
}

export function deterministicPointId(generationId: string, chunkId: string) {
  const hex = sha256(
    JSON.stringify(['qdrant-point-v1', generationId, chunkId]),
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function extractVectorSize(
  info: Awaited<ReturnType<QdrantClientLike['getCollection']>>,
) {
  const vectors = info.config?.params?.vectors;
  if (
    vectors &&
    typeof vectors === 'object' &&
    'size' in vectors &&
    typeof vectors.size === 'number'
  ) {
    return vectors.size;
  }
  return undefined;
}

export function buildGenerationFilter(
  scope: GenerationScope,
  filters?: MetadataFilters,
): QdrantFilter {
  if (
    !scope.generationId.trim() ||
    !scope.datasetId.trim() ||
    !Number.isInteger(scope.datasetRevision) ||
    scope.datasetRevision < 1
  ) {
    throw new ProviderError(
      'invalid_input',
      'A generationId, datasetId, and datasetRevision scope are required for Qdrant search.',
    );
  }
  const must: QdrantFilterCondition[] = [
    { key: 'generationId', match: { value: scope.generationId } },
    { key: 'datasetId', match: { value: scope.datasetId } },
    { key: 'datasetRevision', match: { value: scope.datasetRevision } },
  ];
  if (filters?.documentIds?.length) {
    must.push({ key: 'documentId', match: { any: filters.documentIds } });
  }
  if (filters?.documentNames?.length) {
    must.push({ key: 'documentName', match: { any: filters.documentNames } });
  }
  if (filters?.mimeTypes?.length) {
    must.push({ key: 'mimeType', match: { any: filters.mimeTypes } });
  }
  if (filters?.pageMin !== undefined || filters?.pageMax !== undefined) {
    must.push({
      key: 'page',
      range: {
        ...(filters.pageMin !== undefined ? { gte: filters.pageMin } : {}),
        ...(filters.pageMax !== undefined ? { lte: filters.pageMax } : {}),
      },
    });
  }
  return { must };
}

export interface QdrantStoreOptions {
  url: string;
  apiKey?: string;
  collectionPrefix?: string;
  timeoutMs?: number;
  client?: QdrantClientLike;
}

const GENERATION_INDEXES: ReadonlyArray<{
  field_name: string;
  field_schema: 'keyword' | 'integer';
}> = [
  { field_name: 'generationId', field_schema: 'keyword' },
  { field_name: 'datasetId', field_schema: 'keyword' },
  { field_name: 'datasetRevision', field_schema: 'integer' },
  { field_name: 'documentId', field_schema: 'keyword' },
  { field_name: 'documentVersionId', field_schema: 'keyword' },
  { field_name: 'documentName', field_schema: 'keyword' },
  { field_name: 'mimeType', field_schema: 'keyword' },
  { field_name: 'chunkId', field_schema: 'keyword' },
  { field_name: 'page', field_schema: 'integer' },
];

export class QdrantStore {
  private readonly client: QdrantClientLike;
  private readonly collectionPrefix: string;

  constructor(options: QdrantStoreOptions) {
    this.collectionPrefix =
      options.collectionPrefix?.trim() || 'rag-eval-chunks';
    if (options.client) {
      this.client = options.client;
    } else {
      const parsed = new URL(options.url);
      const prefix =
        parsed.pathname && parsed.pathname !== '/'
          ? parsed.pathname.replace(/\/$/, '')
          : undefined;
      this.client = new QdrantClient({
        url: parsed.origin,
        port: parsed.port ? Number(parsed.port) : null,
        ...(prefix ? { prefix } : {}),
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? 30_000,
        checkCompatibility: false,
      }) as unknown as QdrantClientLike;
    }
  }

  collectionForDimension(dimensions: number) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new ProviderError(
        'invalid_input',
        'Vector dimensions must be a positive integer.',
      );
    }
    const suffix = `-d${dimensions}`;
    const base = sanitizeCollection(this.collectionPrefix).slice(
      0,
      64 - suffix.length,
    );
    return `${base}${suffix}`;
  }

  private async verifyCollectionDimensions(
    collection: string,
    dimensions: number,
  ) {
    const info = await this.client.getCollection(collection);
    const existingSize = extractVectorSize(info);
    if (existingSize !== undefined && existingSize !== dimensions) {
      throw new ProviderError(
        'dimension_mismatch',
        `Qdrant collection expects ${existingSize} dimensions, received ${dimensions}.`,
      );
    }
  }

  async ensureGenerationCollection(collectionName: string, dimensions: number) {
    const collection = sanitizeCollection(collectionName);
    const { exists } = await this.client.collectionExists(collection);
    if (exists) {
      await this.verifyCollectionDimensions(collection, dimensions);
    } else {
      try {
        await this.client.createCollection(collection, {
          vectors: { size: dimensions, distance: 'Cosine' },
        });
      } catch (err) {
        // Concurrent builds may race to create the same dimension collection; verify if it now exists.
        const status =
          err && typeof err === 'object' && 'status' in err
            ? Number(err.status)
            : undefined;
        const alreadyExists =
          status === 409 ||
          (err instanceof Error && /already exists/i.test(err.message));
        if (!alreadyExists) throw err;
        await this.verifyCollectionDimensions(collection, dimensions);
      }
    }
    for (const index of GENERATION_INDEXES) {
      await this.client.createPayloadIndex(collection, {
        ...index,
        wait: true,
      });
    }
    return collection;
  }

  async upsertGenerationPoints(
    collectionName: string,
    points: GenerationVectorPoint[],
    batchSize = 100,
    onBatch?: () => void,
  ) {
    if (!points.length) return;
    const expectedSize = points[0].vector.length;
    if (
      expectedSize <= 0 ||
      points.some(
        (p) =>
          p.vector.length !== expectedSize ||
          !p.vector.every((n) => typeof n === 'number' && Number.isFinite(n)),
      )
    ) {
      throw new ProviderError(
        'dimension_mismatch',
        'Invalid or inconsistent vector dimensions before Qdrant upsert.',
      );
    }

    const collection = sanitizeCollection(collectionName);
    const step = Math.max(1, Math.min(500, batchSize));
    for (let i = 0; i < points.length; i += step) {
      onBatch?.();
      const batch = points.slice(i, i + step).map((p) => ({
        id: deterministicPointId(p.generationId, p.chunkId),
        vector: p.vector,
        payload: {
          generationId: p.generationId,
          datasetId: p.datasetId,
          datasetRevision: p.datasetRevision,
          documentId: p.documentId,
          documentVersionId: p.documentVersionId,
          documentName: p.documentName,
          mimeType: p.mimeType,
          chunkId: p.chunkId,
          page: p.page,
          ordinal: p.ordinal,
        },
      }));
      await this.client.upsert(collection, { wait: true, points: batch });
    }
  }

  async verifyGenerationCount(
    collectionName: string,
    scope: GenerationScope,
    expectedCount: number,
  ) {
    const collection = sanitizeCollection(collectionName);
    const result = await this.client.count(collection, {
      exact: true,
      filter: buildGenerationFilter(scope),
    });
    if (result.count !== expectedCount) {
      throw new ProviderError(
        'upstream_failure',
        `Qdrant verification count mismatch: expected ${expectedCount}, found ${result.count}.`,
      );
    }
  }

  async searchGeneration(
    collectionName: string,
    vector: number[],
    limit: number,
    scope: GenerationScope,
    filters?: MetadataFilters,
  ): Promise<DenseSearchHit[]> {
    if (
      !vector.length ||
      !vector.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new ProviderError(
        'invalid_input',
        'Query vector must be finite and non-empty.',
      );
    }
    const filter = buildGenerationFilter(scope, filters);
    const collection = sanitizeCollection(collectionName);
    const clampedLimit = Math.max(1, Math.min(100, limit));
    // Never retry unfiltered if Qdrant rejects a missing filter index.
    const response = await this.client.query(collection, {
      query: vector,
      limit: clampedLimit,
      filter,
      with_payload: true,
      with_vector: false,
    });
    const hits: DenseSearchHit[] = [];
    for (const point of response.points ?? []) {
      const payload = (point.payload ?? {}) as Record<string, unknown>;
      // Defense in depth: verify point belongs to the requested generation.
      if (
        payload.generationId !== scope.generationId ||
        payload.datasetId !== scope.datasetId ||
        payload.datasetRevision !== scope.datasetRevision ||
        typeof payload.chunkId !== 'string'
      ) {
        continue;
      }
      hits.push({
        chunkId: payload.chunkId,
        pointId: String(point.id),
        score: point.score,
        payload,
      });
    }
    return hits;
  }

  async deleteGenerationPoints(collectionName: string, generationId: string) {
    if (!generationId.trim()) return;
    const collection = sanitizeCollection(collectionName);
    await this.client.delete(collection, {
      wait: true,
      filter: {
        must: [{ key: 'generationId', match: { value: generationId } }],
      },
    });
  }

  async deleteCollection(collectionName: string) {
    await this.client.deleteCollection(sanitizeCollection(collectionName));
  }
}
