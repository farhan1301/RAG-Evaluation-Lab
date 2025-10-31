import fetch from 'node-fetch';
import type { AppConfig } from './config.js';

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

const sanitizeCollection = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'default';

const sanitizeSuffix = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

export class QdrantClient {
  private readonly config: AppConfig;
  private readonly headers: Record<string, string>;

  constructor(config: AppConfig) {
    this.config = config;
    this.headers = {
      'Content-Type': 'application/json',
    };
    if (config.qdrantApiKey) {
      this.headers['api-key'] = config.qdrantApiKey;
      this.headers.Authorization = `Bearer ${config.qdrantApiKey}`;
    }
  }

  private resolveCollectionName(explicit?: string, vectorSize?: number) {
    if (explicit && explicit.trim()) {
      return sanitizeCollection(explicit);
    }

    if (
      typeof vectorSize === 'number' &&
      Number.isFinite(vectorSize) &&
      vectorSize > 0
    ) {
      const mapped = this.config.qdrantCollections?.[vectorSize];
      if (mapped && mapped.trim()) {
        return sanitizeCollection(mapped);
      }
    }

    const baseCollection = this.config.qdrantCollection || 'rag-eval-chunks';
    const base =
      typeof baseCollection === 'string'
        ? baseCollection.replace(/-\d+$/, '')
        : 'rag-eval-chunks';
    const fallback =
      typeof vectorSize === 'number' && Number.isFinite(vectorSize) && vectorSize > 0
        ? `${base}-${vectorSize}`
        : baseCollection;

    return sanitizeCollection(fallback);
  }

  collectionNameForVectorSize(vectorSize: number) {
    return this.resolveCollectionName(undefined, vectorSize);
  }

  sanitizeCollectionName(name: string) {
    return sanitizeCollection(name);
  }

  collectionNameForPipeline(vectorSize: number, pipelineId: string, explicit?: string) {
    const base = this.resolveCollectionName(explicit, vectorSize);
    const suffix = sanitizeSuffix(pipelineId);
    if (!suffix) {
      return base;
    }

    if (base.endsWith(`-${suffix}`)) {
      return base;
    }

    return sanitizeCollection(`${base}-${suffix}`);
  }

  private url(path: string) {
    return `${this.config.qdrantUrl}${path}`;
  }

  async ensureCollection(vectorSize: number, collectionName?: string, signal?: AbortSignal) {
    const collection = this.resolveCollectionName(collectionName, vectorSize);
    const response = await fetch(this.url(`/collections/${collection}?wait=true`), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      }),
      signal,
    });

    if (!response.ok && response.status !== 409) {
      const detail = await response.text();
      throw new Error(`Failed to ensure Qdrant collection (${response.status}): ${detail}`);
    }

    await this.ensurePipelineIndex(collection, signal);
  }

  async upsertPoints(points: QdrantPoint[], collectionName?: string, signal?: AbortSignal) {
    if (!points.length) {
      return;
    }

    const collection = this.resolveCollectionName(collectionName);
    const response = await fetch(this.url(`/collections/${collection}/points`), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({
        points,
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Failed to upsert Qdrant points (${response.status}): ${detail}`);
    }
  }

  async deleteCollection(collectionName?: string, signal?: AbortSignal) {
    const collection = this.resolveCollectionName(collectionName);
    const response = await fetch(this.url(`/collections/${collection}`), {
      method: 'DELETE',
      headers: this.headers,
      signal,
    });

    if (!response.ok && response.status !== 404) {
      const detail = await response.text();
      throw new Error(`Failed to delete Qdrant collection (${response.status}): ${detail}`);
    }
  }

  private async ensurePipelineIndex(collection: string, signal?: AbortSignal) {
    const endpoints: Array<{ method: 'PUT' | 'POST'; path: string; body: Record<string, unknown> }> = [
      {
        method: 'PUT',
        path: `/collections/${collection}/index?wait=true`,
        body: {
          field_name: 'pipelineId',
          field_type: 'keyword',
        },
      },
      {
        method: 'PUT',
        path: `/collections/${collection}/index?wait=true`,
        body: {
          field_name: 'pipelineId',
          field_schema: 'keyword',
        },
      },
      {
        method: 'POST',
        path: `/collections/${collection}/indexes?wait=true`,
        body: {
          field_name: 'pipelineId',
          field_type: 'keyword',
        },
      },
      {
        method: 'POST',
        path: `/collections/${collection}/indexes?wait=true`,
        body: {
          field_name: 'pipelineId',
          field_schema: 'keyword',
        },
      },
      {
        method: 'PUT',
        path: `/collections/${collection}/index/pipelineId?wait=true`,
        body: {
          field_schema: 'keyword',
        },
      },
    ];

    const attempts = 3;
    let lastError: { status: number; detail: string; method: string; path: string } | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      for (const { method, path, body } of endpoints) {
        const response = await fetch(this.url(path), {
          method,
          headers: this.headers,
          body: JSON.stringify(body),
          signal,
        });

        if (response.ok || response.status === 409) {
          return;
        }

        const detail = await response.text();
        lastError = { status: response.status, detail, method, path };

        if (response.status === 404) {
          if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn(
              `[QdrantClient] Index endpoint ${method} ${path} returned 404 for collection "${collection}" (attempt ${
                attempt + 1
              } of ${attempts}).`
            );
          }
          continue;
        }

        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(
            `[QdrantClient] Attempt to create pipelineId index failed (${response.status}) via ${method} ${path}: ${detail}`
          );
        }
      }

      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }

    if (typeof console !== 'undefined' && typeof console.error === 'function' && lastError) {
      console.error('[QdrantClient] Failed to create pipelineId index', {
        collection,
        ...lastError,
      });
    }

    const detail =
      lastError?.detail ?? 'Qdrant did not accept index creation via supported endpoints.';
    const status = lastError?.status ?? 0;
    throw new Error(`Failed to create Qdrant pipelineId index (${status}): ${detail}`);
  }

  async deletePipelinePoints(pipelineId: string, collectionName?: string, signal?: AbortSignal) {
    const trimmedId = pipelineId?.trim();
    if (!trimmedId) {
      return;
    }

    const collection = this.resolveCollectionName(collectionName);
    let attemptedIndexCreation = false;

    while (true) {
      const response = await fetch(this.url(`/collections/${collection}/points/delete?wait=true`), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          filter: {
            must: [
              {
                key: 'pipelineId',
                match: { value: trimmedId },
              },
            ],
          },
        }),
        signal,
      });

      if (response.ok || response.status === 404) {
        return;
      }

      const detail = await response.text();
      const requiresIndex =
        response.status === 400 && /Index required but not found/i.test(detail);

      if (requiresIndex && !attemptedIndexCreation) {
        attemptedIndexCreation = true;
        await this.ensurePipelineIndex(collection, signal);
        continue;
      }

      throw new Error(`Failed to delete Qdrant points (${response.status}): ${detail}`);
    }
  }

  async search(
    vector: number[],
    limit: number,
    filter: Record<string, unknown> | undefined,
    collectionName?: string,
    signal?: AbortSignal
  ): Promise<QdrantSearchResult[]> {
    const collection = this.resolveCollectionName(collectionName, Array.isArray(vector) ? vector.length : undefined);
    const body: any = {
      vector,
      limit,
      with_payload: true,
    };

    const buildFilter = (value: Record<string, unknown>) => ({
      must: Object.entries(value).map(([key, entryValue]) =>
        Array.isArray(entryValue)
          ? { key, match: { any: entryValue } }
          : { key, match: { value: entryValue } }
      ),
    });

    const requestBody = { ...body };
    if (filter && Object.keys(filter).length) {
      requestBody.filter = buildFilter(filter);
    }

    const performSearch = async (payloadBody: any): Promise<any> => {
      const response = await fetch(this.url(`/collections/${collection}/points/search`), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payloadBody),
        signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Qdrant search failed (${response.status}): ${detail}`);
      }

      return response.json();
    };

    const handleSearch = async (): Promise<any> => {
      try {
        return await performSearch(requestBody);
      } catch (error) {
        if (
          error instanceof Error &&
          /Index required but not found/i.test(error.message ?? '') &&
          requestBody.filter
        ) {
          const fallbackBody = { ...requestBody };
          delete fallbackBody.filter;
          if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn(
              '[QdrantClient] Missing payload index for filter. Retrying search without filter.'
            );
          }
          return performSearch(fallbackBody);
        }
        throw error;
      }
    };

    const payload: any = await handleSearch();
    const results = Array.isArray(payload?.result) ? payload.result : [];

    return results.map((item: any) => ({
      id: String(item?.id ?? ''),
      score: typeof item?.score === 'number' ? item.score : 0,
      payload: (item?.payload as Record<string, unknown>) ?? {},
    }));
  }
}
