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

  private url(path: string) {
    return `${this.config.qdrantUrl}${path}`;
  }

  async ensureCollection(vectorSize: number, collectionName?: string, signal?: AbortSignal) {
    const collection = sanitizeCollection(collectionName ?? this.config.qdrantCollection);
    const response = await fetch(this.url(`/collections/${collection}`), {
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
  }

  async upsertPoints(points: QdrantPoint[], collectionName?: string, signal?: AbortSignal) {
    if (!points.length) {
      return;
    }

    const collection = sanitizeCollection(collectionName ?? this.config.qdrantCollection);
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

  async search(
    vector: number[],
    limit: number,
    filter: Record<string, unknown> | undefined,
    collectionName?: string,
    signal?: AbortSignal
  ): Promise<QdrantSearchResult[]> {
    const collection = sanitizeCollection(collectionName ?? this.config.qdrantCollection);
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
