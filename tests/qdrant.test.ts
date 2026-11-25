import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatProvider, ChatResult } from '../backend/src/providers/types';
import {
  QdrantStore,
  type QdrantClientLike,
} from '../backend/src/retrieval/qdrant';
import { createAnswerHandler } from '../backend/src/routes/answer';
import { createEmbeddingsHandler } from '../backend/src/routes/embeddings';
import { createSearchHandler } from '../backend/src/routes/search';
import { invoke } from './handler';

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
const embed = vi.fn();
const chat = vi.fn();
const chatProvider: ChatProvider = {
  kind: 'openai',
  capabilities: {
    chat: true,
    embeddings: false,
    rerank: false,
    structuredOutput: true,
    temperature: true,
    maxTemperature: 2,
    maxTokens: true,
    requiresMaxTokens: false,
  },
  chat,
};

const chunksHandler = createEmbeddingsHandler({ embed }, qdrant);
const searchHandler = createSearchHandler({ embed }, qdrant);
const answerHandler = createAnswerHandler(
  {
    embed,
    resolveChat: () => ({
      profile: { model: 'fixture-chat' },
      provider: chatProvider,
    }),
  },
  qdrant,
);

const pipelineId = 'Pipeline A';
const collection = qdrant.collectionForLegacyPipeline(
  vector.length,
  pipelineId,
);
const body = {
  pipelineId,
  question: 'Where?',
  topK: 1,
  chunks: [{ id: 'chunk', text: 'Here.' }],
};
const filter = { must: [{ key: 'pipelineId', match: { value: pipelineId } }] };

beforeEach(() => {
  vi.resetAllMocks();
  embed.mockResolvedValue({ vectors: [vector] });
  client.collectionExists.mockResolvedValue({ exists: false });
  client.createCollection.mockResolvedValue(true);
  client.createPayloadIndex.mockResolvedValue({ status: 'completed' });
  client.delete.mockResolvedValue({ status: 'completed' });
  client.upsert.mockResolvedValue({ status: 'completed' });
});

it.each([searchHandler, answerHandler])(
  'stops on missing index without retrying unfiltered or generating an answer',
  async (handler) => {
    client.query.mockRejectedValue(new Error('Index required but not found'));
    const result = await invoke(handler, body);
    expect(result.status).toBe(500);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(collection, {
      query: vector,
      limit: 1,
      filter,
      with_payload: true,
      with_vector: false,
    });
    expect(chat).not.toHaveBeenCalled();
  },
);

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

it('rejects an empty scope before any client call', async () => {
  await expect(
    qdrant.searchLegacyPipeline(collection, vector, 1, ''),
  ).rejects.toThrow('filter is required');
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

it('isolates colliding sanitized names, long IDs, and dimensions', () => {
  const longId = 'x'.repeat(150);
  const scopes = [
    [2, pipelineId],
    [2, 'pipeline-a'],
    [2, longId],
    [2, `${longId}x`],
    [3, pipelineId],
  ] as const;
  const names = scopes.map(([dimension, id]) =>
    qdrant.collectionForLegacyPipeline(dimension, id),
  );
  expect(new Set(names).size).toBe(scopes.length);
  expect(names.every((name) => name.length <= 64)).toBe(true);

  const dimNames = [2, 384, 1536, 3072].map((d) =>
    qdrant.collectionForDimension(d),
  );
  expect(new Set(dimNames).size).toBe(4);
  expect(dimNames.every((name) => name.length <= 64)).toBe(true);
});

it.each([chunksHandler, searchHandler, answerHandler])(
  'rejects collection controls before embedding',
  async (handler) => {
    for (const override of [
      { collectionName: 'another' },
      { resetCollection: true },
    ]) {
      expect((await invoke(handler, { ...body, ...override })).status).toBe(
        400,
      );
    }
    expect(embed).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.upsert).not.toHaveBeenCalled();
  },
);

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
])('rejects reserved metadata %s', async (key) => {
  const chunks = [{ ...body.chunks[0], metadata: { [key]: 'override' } }];
  expect((await invoke(chunksHandler, { ...body, chunks })).status).toBe(400);
  expect(client.upsert).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
});

it('writes each document ID explicitly and replaces only the scoped points', async () => {
  embed.mockResolvedValue({ vectors: [vector, vector] });
  const chunks = [
    { id: 'a', text: 'First', metadata: { ordinal: 0 } },
    { id: 'b', text: 'Second', documentId: 'two' },
  ];
  const result = await invoke(chunksHandler, {
    ...body,
    documentId: 'one',
    chunks,
  });
  expect(result.body).toMatchObject({ collection, upserted: 2 });
  expect(client.deleteCollection).not.toHaveBeenCalled();
  expect(client.delete).toHaveBeenCalledWith(collection, {
    wait: true,
    filter,
  });
  expect(client.upsert).toHaveBeenCalledTimes(1);
  expect(
    client.upsert.mock.calls[0][1].points.map(
      (point: { payload: unknown }) => point.payload,
    ),
  ).toEqual([
    { pipelineId, documentId: 'one', chunkId: 'a', text: 'First', ordinal: 0 },
    { pipelineId, documentId: 'two', chunkId: 'b', text: 'Second' },
  ]);
});

it('uses retrieved text for generation and returns the retrieved matches and citations', async () => {
  const match = {
    id: 'chunk',
    score: 0.9,
    payload: { chunkId: 'chunk', text: 'Here.' },
  };
  client.query.mockResolvedValue({ points: [match] });
  const chatResponse: ChatResult = {
    content: JSON.stringify({
      answer: 'Here.',
      citations: ['chunk'],
      abstained: false,
    }),
    model: 'fixture-chat',
    provider: 'openai',
    requestId: 'req-1',
    effectiveParams: { structuredOutput: true },
  };
  chat.mockResolvedValue(chatResponse);
  const result = await invoke(answerHandler, body);
  expect(result.body).toMatchObject({
    answer: 'Here.',
    abstained: false,
    citations: ['chunk'],
    matches: [match],
    collection,
  });
  expect(chat.mock.calls[0][0].messages[1].content).toContain('Here.');
});

it('validates all vector dimensions before replacing scoped points', async () => {
  embed.mockResolvedValue({ vectors: [[1, 0], [1]] });
  const chunks = [body.chunks[0], { id: 'second', text: 'Second.' }];
  const result = await invoke(chunksHandler, { ...body, chunks });
  expect(result.status).toBe(500);
  expect(client.delete).not.toHaveBeenCalled();
  expect(client.upsert).not.toHaveBeenCalled();
});
