const DEFAULT_QDRANT_URL = 'https://YOUR-QDRANT-ENDPOINT';
const DEFAULT_COLLECTION = 'rag-eval-chunks';

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collectionName: string;
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

interface QdrantSearchResultPayload extends Record<string, any> {}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: QdrantSearchResultPayload;
}

const sanitizeCollectionSegment = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'default';

const getEnv = (key: string): string | undefined => {
  try {
    return typeof import.meta !== 'undefined'
      ? (import.meta as any).env?.[key]
      : undefined;
  } catch {
    return undefined;
  }
};

export const resolveQdrantConfig = (): QdrantConfig | null => {
  const url = getEnv('VITE_QDRANT_URL');
  const apiKey = getEnv('VITE_QDRANT_API_KEY');
  const collection = getEnv('VITE_QDRANT_COLLECTION') ?? DEFAULT_COLLECTION;

  if (!url || !url.trim()) {
    return null;
  }

  return {
    url: url.replace(/\/$/, ''),
    apiKey: apiKey?.trim() || undefined,
    collectionName: sanitizeCollectionSegment(collection),
  };
};

const buildHeaders = (config: QdrantConfig) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers['api-key'] = config.apiKey;
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  return headers;
};

export const ensureCollection = async (
  config: QdrantConfig,
  collectionName: string,
  vectorSize: number,
  signal?: AbortSignal
) => {
  const targetCollection = sanitizeCollectionSegment(collectionName);
  const response = await fetch(`${config.url}/collections/${targetCollection}`, {
    method: 'PUT',
    headers: buildHeaders(config),
    body: JSON.stringify({
      vectors: {
        size: vectorSize,
        distance: 'Cosine',
      },
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Failed to ensure Qdrant collection "${targetCollection}". ${detail || response.statusText}`
    );
  }
};

export const upsertVectors = async (
  config: QdrantConfig,
  collectionName: string,
  points: QdrantPoint[],
  signal?: AbortSignal
) => {
  if (!points.length) {
    return;
  }

  const targetCollection = sanitizeCollectionSegment(collectionName);
  const response = await fetch(`${config.url}/collections/${targetCollection}/points`, {
    method: 'PUT',
    headers: buildHeaders(config),
    body: JSON.stringify({
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: point.payload,
      })),
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Failed to upsert vectors into Qdrant. ${detail || response.statusText}`
    );
  }
};

export const searchVectors = async (
  config: QdrantConfig,
  collectionName: string,
  vector: number[],
  limit: number,
  filterPayload?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<QdrantSearchResult[]> => {
  const targetCollection = sanitizeCollectionSegment(collectionName);
  const response = await fetch(`${config.url}/collections/${targetCollection}/points/search`, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      ...(filterPayload
        ? {
            filter: {
              must: Object.entries(filterPayload).map(([key, value]) => ({
                key,
                match: Array.isArray(value)
                  ? { any: value }
                  : { value },
              })),
            },
          }
        : {}),
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Qdrant search failed. ${detail || response.statusText}`);
  }

  const data = await response.json();
  const results = Array.isArray(data?.result) ? data.result : [];

  return results.map((item: any) => ({
    id: String(item?.id ?? ''),
    score: typeof item?.score === 'number' ? item.score : 0,
    payload: (item?.payload as QdrantSearchResultPayload) ?? {},
  }));
};
