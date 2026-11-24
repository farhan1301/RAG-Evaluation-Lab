import { beforeEach, expect, it, vi } from 'vitest';
import { QdrantClient } from '../backend/src/lib/qdrantClient';
import { createAnswerHandler } from '../backend/src/routes/answer';
import { createEmbeddingsHandler } from '../backend/src/routes/embeddings';
import { createSearchHandler } from '../backend/src/routes/search';
import { invoke } from './handler';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('node-fetch', () => ({ default: transport }));

const qdrant = new QdrantClient({
  qdrantUrl: 'http://qdrant.invalid',
  qdrantCollection: 'fixture',
  qdrantCollections: {},
  openaiApiKey: 'unused',
  openaiEmbeddingModel: 'fixture',
  openaiChatModel: 'fixture',
  llamaParseBaseUrl: 'http://parser.invalid',
});
const vector = [1, 0];
const createEmbeddings = vi.fn();
const chatCompletion = vi.fn();
const openai = { createEmbeddings, chatCompletion };
const chunksHandler = createEmbeddingsHandler(openai, qdrant);
const searchHandler = createSearchHandler(openai, qdrant);
const answerHandler = createAnswerHandler(openai, qdrant);
const pipelineId = 'Pipeline A';
const collection = qdrant.collectionNameForPipeline(vector.length, pipelineId);
const body = {
  pipelineId,
  question: 'Where?',
  topK: 1,
  chunks: [{ id: 'chunk', text: 'Here.' }],
};
const filter = { must: [{ key: 'pipelineId', match: { value: pipelineId } }] };
beforeEach(() => {
  vi.resetAllMocks();
  createEmbeddings.mockResolvedValue({ vectors: [vector] });
});

it.each([searchHandler, answerHandler])(
  'stops on missing index without retrying unfiltered or generating an answer',
  async (handler) => {
    transport.mockResolvedValue(
      new Response('Index required but not found', { status: 400 }),
    );
    const result = await invoke(handler, body);
    expect(result.status).toBe(500);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe(
      `http://qdrant.invalid/collections/${collection}/points/search`,
    );
    expect(JSON.parse(options.body)).toMatchObject({
      filter,
      vector,
      limit: 1,
    });
    expect(chatCompletion).not.toHaveBeenCalled();
  },
);

it('rejects an empty scope before any transport call', async () => {
  await expect(
    qdrant.search(vector, 1, { pipelineId: '' }, collection),
  ).rejects.toThrow('filter is required');
  expect(transport).not.toHaveBeenCalled();
});

it('isolates colliding sanitized names, long IDs, and dimensions', () => {
  const longId = 'x'.repeat(150);
  const scopes = [
    [2, pipelineId],
    [2, 'pipeline-a'],
    [2, longId],
    [2, longId + 'x'],
    [3, pipelineId],
  ] as const;
  const names = scopes.map(([dimension, id]) =>
    qdrant.collectionNameForPipeline(dimension, id),
  );
  expect(new Set(names).size).toBe(scopes.length);
  expect(names.every((name) => name.length <= 64)).toBe(true);
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
    expect(createEmbeddings).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each(['pipelineId', 'documentId', 'text', 'chunkId'])(
  'rejects reserved metadata %s',
  async (key) => {
    const chunks = [{ ...body.chunks[0], metadata: { [key]: 'override' } }];
    expect((await invoke(chunksHandler, { ...body, chunks })).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
    expect(createEmbeddings).not.toHaveBeenCalled();
  },
);

it('writes each document ID explicitly and replaces only the scoped points', async () => {
  createEmbeddings.mockResolvedValue({ vectors: [vector, vector] });
  transport.mockResolvedValue(new Response());
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
  const calls = transport.mock.calls.map(([url, options]) => ({
    url,
    method: options.method,
    body: JSON.parse(options.body),
  }));
  expect(
    calls.every((call) =>
      call.url.startsWith(`http://qdrant.invalid/collections/${collection}`),
    ),
  ).toBe(true);
  expect(calls.map((call) => call.method)).not.toContain('DELETE');
  expect(
    calls.find((call) => call.url.includes('/points/delete'))?.body,
  ).toEqual({ filter });
  expect(
    calls
      .at(-1)
      ?.body.points.map((point: { payload: unknown }) => point.payload),
  ).toEqual([
    { pipelineId, documentId: 'one', chunkId: 'a', text: 'First', ordinal: 0 },
    { pipelineId, documentId: 'two', chunkId: 'b', text: 'Second' },
  ]);
});

it('uses retrieved text for generation and returns the retrieved matches', async () => {
  const match = { id: 'chunk', score: 0.9, payload: { text: 'Here.' } };
  transport.mockResolvedValue(Response.json({ result: [match] }));
  chatCompletion.mockResolvedValue({ content: 'Here.' });
  const result = await invoke(answerHandler, body);
  expect(result.body).toMatchObject({
    answer: 'Here.',
    matches: [match],
    collection,
  });
  expect(chatCompletion.mock.calls[0][0][1].content).toContain(
    'Context 1:\nHere.',
  );
});

it('validates all vector dimensions before replacing scoped points', async () => {
  createEmbeddings.mockResolvedValue({ vectors: [[1, 0], [1]] });
  const chunks = [body.chunks[0], { id: 'second', text: 'Second.' }];
  const result = await invoke(chunksHandler, { ...body, chunks });
  expect(result.status).toBe(500);
  expect(transport).not.toHaveBeenCalled();
});
