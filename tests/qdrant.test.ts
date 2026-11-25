import { beforeEach, expect, it, vi } from 'vitest';
import {
  hasReservedPayloadField,
  QdrantStore,
  type QdrantClientLike,
} from '../backend/src/retrieval/qdrant';

const client: { [K in keyof QdrantClientLike]: ReturnType<typeof vi.fn> } = {
  collectionExists: vi.fn(),
  getCollection: vi.fn(),
  createCollection: vi.fn(),
  createPayloadIndex: vi.fn(),
  upsert: vi.fn(),
  query: vi.fn(),
  count: vi.fn(),
  delete: vi.fn(),
  deleteCollection: vi.fn(),
};

const qdrant = new QdrantStore({
  url: 'http://qdrant.invalid',
  collectionPrefix: 'fixture',
  client: client as unknown as QdrantClientLike,
});

const vector = [1, 0];

beforeEach(() => {
  vi.resetAllMocks();
  client.collectionExists.mockResolvedValue({ exists: false });
  client.createCollection.mockResolvedValue(true);
  client.createPayloadIndex.mockResolvedValue({ status: 'completed' });
  client.delete.mockResolvedValue({ status: 'completed' });
  client.upsert.mockResolvedValue({ status: 'completed' });
});

it('stops on missing index in generation search without retrying unfiltered', async () => {
  client.query.mockRejectedValue(new Error('Index required but not found'));
  await expect(
    qdrant.searchGeneration('fixture-d2', vector, 5, {
      generationId: 'gen-1',
      datasetId: 'ds-1',
      datasetRevision: 1,
    }),
  ).rejects.toThrow('Index required but not found');
  expect(client.query).toHaveBeenCalledTimes(1);
  expect(client.query.mock.calls[0][1].filter).toEqual({
    must: [
      { key: 'generationId', match: { value: 'gen-1' } },
      { key: 'datasetId', match: { value: 'ds-1' } },
      { key: 'datasetRevision', match: { value: 1 } },
    ],
  });
});

it('rejects an empty or invalid generation scope before any client call', async () => {
  await expect(
    qdrant.searchGeneration('fixture-d2', vector, 1, {
      generationId: '',
      datasetId: 'ds-1',
      datasetRevision: 1,
    }),
  ).rejects.toThrow('scope are required');
  await expect(
    qdrant.searchGeneration('fixture-d2', vector, 1, {
      generationId: 'gen-1',
      datasetId: 'ds-1',
      datasetRevision: 0,
    }),
  ).rejects.toThrow('scope are required');
  expect(client.query).not.toHaveBeenCalled();
});

it('isolates dimension-scoped collection names within Qdrant length limits', () => {
  const dimNames = [2, 384, 1536, 3072].map((d) =>
    qdrant.collectionForDimension(d),
  );
  expect(new Set(dimNames).size).toBe(4);
  expect(dimNames.every((name) => name.length <= 64)).toBe(true);
});

it.each([
  'pipelineId',
  'documentId',
  'text',
  'chunkId',
  'generationId',
  'datasetId',
  'datasetRevision',
  'documentVersionId',
  'documentName',
  'mimeType',
  'page',
])('flags reserved payload field %s', (key) => {
  expect(hasReservedPayloadField({ [key]: 'override' })).toBe(true);
  expect(hasReservedPayloadField({ customTag: 'ok' })).toBe(false);
});

it('validates all vector dimensions before upserting generation points', async () => {
  await expect(
    qdrant.upsertGenerationPoints('fixture-d2', [
      {
        generationId: 'gen-1',
        datasetId: 'ds-1',
        datasetRevision: 1,
        documentId: 'doc-1',
        documentVersionId: 'dv-1',
        documentName: 'a.txt',
        mimeType: 'text/plain',
        chunkId: 'c1',
        page: 1,
        ordinal: 0,
        vector: [1, 0],
      },
      {
        generationId: 'gen-1',
        datasetId: 'ds-1',
        datasetRevision: 1,
        documentId: 'doc-1',
        documentVersionId: 'dv-1',
        documentName: 'a.txt',
        mimeType: 'text/plain',
        chunkId: 'c2',
        page: 1,
        ordinal: 1,
        vector: [1],
      },
    ]),
  ).rejects.toThrow('dimension');
  expect(client.upsert).not.toHaveBeenCalled();
});

it('drops points whose payload scope mismatches the requested generation', async () => {
  client.query.mockResolvedValue({
    points: [
      {
        id: 'p1',
        score: 0.9,
        payload: {
          generationId: 'gen-1',
          datasetId: 'ds-1',
          datasetRevision: 1,
          chunkId: 'chunk-a',
        },
      },
      {
        id: 'p2',
        score: 0.95,
        payload: {
          generationId: 'gen-other',
          datasetId: 'ds-1',
          datasetRevision: 1,
          chunkId: 'chunk-b',
        },
      },
    ],
  });
  const hits = await qdrant.searchGeneration('fixture-d2', vector, 5, {
    generationId: 'gen-1',
    datasetId: 'ds-1',
    datasetRevision: 1,
  });
  expect(hits.map((h) => h.chunkId)).toEqual(['chunk-a']);
});
