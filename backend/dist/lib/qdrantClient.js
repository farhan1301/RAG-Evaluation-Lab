import fetch from 'node-fetch';
const sanitizeCollection = (value) => value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'default';
export class QdrantClient {
    constructor(config) {
        this.config = config;
        this.headers = {
            'Content-Type': 'application/json',
        };
        if (config.qdrantApiKey) {
            this.headers['api-key'] = config.qdrantApiKey;
            this.headers.Authorization = `Bearer ${config.qdrantApiKey}`;
        }
    }
    url(path) {
        return `${this.config.qdrantUrl}${path}`;
    }
    async ensureCollection(vectorSize, collectionName, signal) {
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
    async upsertPoints(points, collectionName, signal) {
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
    async search(vector, limit, filter, collectionName, signal) {
        const collection = sanitizeCollection(collectionName ?? this.config.qdrantCollection);
        const body = {
            vector,
            limit,
            with_payload: true,
        };
        const buildFilter = (value) => ({
            must: Object.entries(value).map(([key, entryValue]) => Array.isArray(entryValue)
                ? { key, match: { any: entryValue } }
                : { key, match: { value: entryValue } }),
        });
        const requestBody = { ...body };
        if (filter && Object.keys(filter).length) {
            requestBody.filter = buildFilter(filter);
        }
        const performSearch = async (payloadBody) => {
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
        const handleSearch = async () => {
            try {
                return await performSearch(requestBody);
            }
            catch (error) {
                if (error instanceof Error &&
                    /Index required but not found/i.test(error.message ?? '') &&
                    requestBody.filter) {
                    const fallbackBody = { ...requestBody };
                    delete fallbackBody.filter;
                    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
                        console.warn('[QdrantClient] Missing payload index for filter. Retrying search without filter.');
                    }
                    return performSearch(fallbackBody);
                }
                throw error;
            }
        };
        const payload = await handleSearch();
        const results = Array.isArray(payload?.result) ? payload.result : [];
        return results.map((item) => ({
            id: String(item?.id ?? ''),
            score: typeof item?.score === 'number' ? item.score : 0,
            payload: item?.payload ?? {},
        }));
    }
}
