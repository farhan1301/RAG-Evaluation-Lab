import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { openDatabase } from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Indexes } from '../backend/src/db/indexes';
import { Pipelines } from '../backend/src/db/pipelines';
import { createApp } from '../backend/src/http/app';
import { CloudParser } from '../backend/src/ingestion/cloud';
import { LostLease } from '../backend/src/db/jobs';
import { runOne } from '../backend/src/jobs/run';
import { createLogger } from '../backend/src/lib/logger';
import {
  ProviderRegistry,
  type ProviderTransports,
} from '../backend/src/providers/registry';
import {
  reciprocalRankFuse,
  RRF_CONSTANT,
} from '../backend/src/retrieval/fusion';
import { IndexBuilder } from '../backend/src/retrieval/indexer';
import {
  QdrantStore,
  type QdrantClientLike,
  type QdrantFilter,
} from '../backend/src/retrieval/qdrant';
import { RetrievalService } from '../backend/src/retrieval/service';
import { send } from './inProcess';

interface StoredPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

function matchesFilter(payload: Record<string, unknown>, filter: QdrantFilter) {
  return filter.must.every((cond) => {
    const val = payload[cond.key];
    if ('match' in cond) {
      if ('value' in cond.match) return val === cond.match.value;
      return typeof val === 'string' && cond.match.any.includes(val);
    }
    if (typeof val !== 'number') return false;
    if (cond.range.gte !== undefined && val < cond.range.gte) return false;
    if (cond.range.lte !== undefined && val > cond.range.lte) return false;
    return true;
  });
}

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

class InMemoryQdrant implements QdrantClientLike {
  collections = new Map<
    string,
    { size: number; indexes: Set<string>; points: Map<string, StoredPoint> }
  >();
  failNextUpsertForGeneration: string | null = null;
  raceCreateOnce = false;

  async collectionExists(name: string) {
    return { exists: this.collections.has(name) };
  }

  async getCollection(name: string) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    return { config: { params: { vectors: { size: col.size } } } };
  }

  async createCollection(
    name: string,
    args: { vectors: { size: number; distance: 'Cosine' } },
  ) {
    if (this.raceCreateOnce && !this.collections.has(name)) {
      this.raceCreateOnce = false;
      this.collections.set(name, {
        size: args.vectors.size,
        indexes: new Set(),
        points: new Map(),
      });
      const conflict = new Error('Collection already exists') as Error & {
        status: number;
      };
      conflict.status = 409;
      throw conflict;
    }
    if (this.collections.has(name)) {
      const conflict = new Error('Collection already exists') as Error & {
        status: number;
      };
      conflict.status = 409;
      throw conflict;
    }
    this.collections.set(name, {
      size: args.vectors.size,
      indexes: new Set(),
      points: new Map(),
    });
    return true;
  }

  async createPayloadIndex(
    name: string,
    args: { field_name: string; field_schema: 'keyword' | 'integer' },
  ) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    col.indexes.add(args.field_name);
    return { status: 'completed' };
  }

  async upsert(name: string, args: { points: StoredPoint[] }) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    for (const point of args.points) {
      if (
        this.failNextUpsertForGeneration &&
        point.payload.generationId === this.failNextUpsertForGeneration
      ) {
        this.failNextUpsertForGeneration = null;
        // Write one partial point first to verify failed reindex cleanup deletes it.
        col.points.set(point.id, point);
        throw new Error('Simulated Qdrant upsert failure.');
      }
      col.points.set(point.id, point);
    }
    return { status: 'completed' };
  }

  async query(
    name: string,
    args: { query: number[]; limit: number; filter: QdrantFilter },
  ) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    const scored = Array.from(col.points.values())
      .filter((p) => matchesFilter(p.payload, args.filter))
      .map((p) => ({
        id: p.id,
        score: cosine(args.query, p.vector),
        payload: p.payload,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit);
    return { points: scored };
  }

  async count(name: string, args: { filter: QdrantFilter }) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    let n = 0;
    for (const p of col.points.values()) {
      if (matchesFilter(p.payload, args.filter)) n += 1;
    }
    return { count: n };
  }

  async delete(name: string, args: { filter: QdrantFilter }) {
    const col = this.collections.get(name);
    if (!col) return { status: 'completed' };
    for (const [id, p] of col.points.entries()) {
      if (matchesFilter(p.payload, args.filter)) col.points.delete(id);
    }
    return { status: 'completed' };
  }

  async deleteCollection(name: string) {
    this.collections.delete(name);
    return true;
  }
}

function deterministicVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [
    lower.includes('retrieval') || lower.includes('vector') ? 1 : 0.1,
    lower.includes('chunk') || lower.includes('overlap') ? 1 : 0.1,
    lower.includes('rerank') || lower.includes('fusion') ? 1 : 0.1,
    lower.includes('judge') || lower.includes('ground') ? 1 : 0.1,
  ];
}

function makeEmbedTransport(
  vectorFn: (text: string) => number[] = deterministicVector,
): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: string[];
    };
    return Response.json({
      object: 'list',
      model: body.model,
      data: body.input.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: vectorFn(text),
      })),
      usage: {
        prompt_tokens: body.input.length * 3,
        total_tokens: body.input.length * 3,
      },
    });
  };
}

let dir: string;
let blobs: string;
let db: ReturnType<typeof openDatabase>;
let datasets: Datasets;
let pipelines: Pipelines;
let indexes: Indexes;

function createHarness(
  env: NodeJS.ProcessEnv = {},
  transports: ProviderTransports = {},
  fakeQdrant?: InMemoryQdrant,
) {
  const config = readConfig({
    BLOB_DIRECTORY: blobs,
    CORS_ORIGINS: 'https://editor.test',
    ...env,
  });
  const providers = new ProviderRegistry(config, transports);
  const qdrant = fakeQdrant
    ? new QdrantStore({
        url: config.qdrant?.url ?? 'http://qdrant.invalid',
        collectionPrefix: config.qdrant?.collectionPrefix ?? 'fixture',
        client: fakeQdrant,
      })
    : undefined;
  const retrieval = new RetrievalService({ indexes, providers, qdrant });
  const indexBuilder = new IndexBuilder({
    indexes,
    providers,
    qdrant,
    embedBatchSize: 2,
    qdrantBatchSize: 2,
  });
  const api = createApp({
    config,
    datasets,
    pipelines,
    indexes,
    providers,
    qdrant,
    retrieval,
    logger: createLogger({ write: () => {} }),
    ready: () => true,
  });
  const runWorkerOnce = () =>
    runOne(datasets.jobs, {
      directory: blobs,
      cloud: new CloudParser('https://unused.invalid', undefined),
      indexes,
      indexBuilder,
    });
  return {
    api,
    config,
    providers,
    qdrant,
    retrieval,
    indexBuilder,
    runWorkerOnce,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phase5-retrieval-'));
  blobs = join(dir, 'blobs');
  db = openDatabase(join(dir, 'workspace.db'));
  datasets = new Datasets(db);
  pipelines = new Pipelines(db);
  indexes = new Indexes(db, datasets.jobs);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Reciprocal Rank Fusion (RRF)', () => {
  it('computes exact sum w/(60+rank) scores and breaks ties deterministically by chunkId', () => {
    const mk = (chunkId: string): c.GenerationChunk => ({
      chunkId,
      documentId: '11111111-1111-4111-8111-111111111111',
      documentVersionId: '22222222-2222-4222-8222-222222222222',
      documentName: 'doc.txt',
      mimeType: 'text/plain',
      ordinal: 0,
      start: 0,
      end: 10,
      page: 1,
      contentHash: 'a'.repeat(64),
      content: 'sample',
    });
    const idA = '00000000-0000-4000-8000-00000000000a';
    const idB = '00000000-0000-4000-8000-00000000000b';
    const idC = '00000000-0000-4000-8000-00000000000c';

    // idA appears at rank 2 in keyword and rank 2 in dense; idB rank 1 kw only; idC rank 1 dense only.
    const fused = reciprocalRankFuse(
      [
        { chunk: mk(idB), rank: 1, score: 5 },
        { chunk: mk(idA), rank: 2, score: 3 },
      ],
      [
        { chunk: mk(idC), rank: 1, score: 0.9 },
        { chunk: mk(idA), rank: 2, score: 0.8 },
      ],
      { keyword: 1, dense: 1 },
    );

    expect(fused.map((f) => f.chunk.chunkId)).toEqual([idA, idB, idC]);
    expect(fused[0].fusedScore).toBeCloseTo(
      1 / (RRF_CONSTANT + 2) + 1 / (RRF_CONSTANT + 2),
      12,
    );
    // idB and idC tie at 1/61 -> idB precedes idC by stable chunkId ordering.
    expect(fused[1].fusedScore).toBeCloseTo(1 / (RRF_CONSTANT + 1), 12);
    expect(fused[2].fusedScore).toBeCloseTo(1 / (RRF_CONSTANT + 1), 12);
    expect(fused.map((f) => f.fusedRank)).toEqual([1, 2, 3]);

    // Weighted fusion lifts dense rank 1 above keyword rank 1.
    const weighted = reciprocalRankFuse(
      [{ chunk: mk(idB), rank: 1, score: 5 }],
      [{ chunk: mk(idC), rank: 1, score: 0.9 }],
      { keyword: 1, dense: 2 },
    );
    expect(weighted.map((f) => f.chunk.chunkId)).toEqual([idC, idB]);
    expect(weighted[0].fusedScore).toBeCloseTo(2 / 61, 12);
  });
});

describe('Keyword retrieval without any provider configured', () => {
  it('indexes and searches the sample dataset with zero API keys or Qdrant, handles FTS punctuation, filters, and reuses ready generations', async () => {
    const { api, runWorkerOnce } = createHarness();
    const sample = datasets.sample().value;

    const createRes = await send(
      api,
      'POST',
      '/api/v1/indexes',
      {
        datasetId: sample.id,
        mode: 'keyword',
        chunking: { strategy: 'sentence-packed', chunkSize: 300, overlap: 20 },
      },
      { 'idempotency-key': 'kw-key-1' },
    );
    expect(createRes.status).toBe(202);
    const created = c.createIndexResult.parse(createRes.body);
    expect(created.reused).toBe(false);
    expect(created.index.state).toBe('building');
    expect(createRes.headers.location).toBe(`/api/v1/jobs/${created.jobId}`);

    // Idempotency replay returns the same job; different payload with same key returns 409.
    const replay = await send(
      api,
      'POST',
      '/api/v1/indexes',
      {
        datasetId: sample.id,
        mode: 'keyword',
        chunking: { strategy: 'sentence-packed', chunkSize: 300, overlap: 20 },
      },
      { 'idempotency-key': 'kw-key-1' },
    );
    expect(replay.status).toBe(202);
    expect(c.createIndexResult.parse(replay.body).jobId).toBe(created.jobId);
    const conflict = await send(
      api,
      'POST',
      '/api/v1/indexes',
      {
        datasetId: sample.id,
        mode: 'keyword',
        chunking: { strategy: 'character-window', chunkSize: 200, overlap: 0 },
      },
      { 'idempotency-key': 'kw-key-1' },
    );
    expect(conflict.status).toBe(409);

    // Search before ready fails with 409 conflict.
    expect(
      (
        await send(api, 'POST', `/api/v1/indexes/${created.index.id}/search`, {
          query: 'chunking',
        })
      ).status,
    ).toBe(409);

    // Build via worker.
    expect(await runWorkerOnce()).toBe(true);
    const readyGen = c.indexGeneration.parse(
      (await send(api, 'GET', `/api/v1/indexes/${created.index.id}`)).body,
    );
    expect(readyGen.state).toBe('ready');
    expect(readyGen.chunkCount).toBeGreaterThan(0);

    // Re-requesting identical index without forceRebuild reuses the ready generation.
    const reused = await send(api, 'POST', '/api/v1/indexes', {
      datasetId: sample.id,
      mode: 'keyword',
      chunking: { strategy: 'sentence-packed', chunkSize: 300, overlap: 20 },
    });
    expect(reused.status).toBe(200);
    expect(c.createIndexResult.parse(reused.body)).toMatchObject({
      reused: true,
      index: { id: readyGen.id, state: 'ready' },
    });

    // Keyword search with FTS-unsafe punctuation works safely.
    const searchRes = await send(
      api,
      'POST',
      `/api/v1/indexes/${readyGen.id}/search`,
      { query: 'chunking AND NOT (overlap)*: "sentence"?' },
    );
    expect(searchRes.status).toBe(200);
    const trace = c.indexSearchResult.parse(searchRes.body);
    expect(trace.mode).toBe('keyword');
    expect(trace.items.length).toBeGreaterThan(0);
    expect(trace.items[0].keywordRank).toBe(1);
    expect(trace.items[0].denseRank).toBeNull();
    expect(trace.stages.keywordCount).toBeGreaterThan(0);

    // Metadata filter scopes results to a single document.
    const targetDoc = sample.documents[0];
    const targetFull = datasets.getDocument(sample.id, targetDoc.id);
    const targetTerms = (targetFull.content ?? '')
      .match(/[a-zA-Z]{5,}/g)
      ?.slice(0, 3)
      .join(' ');
    const filtered = c.indexSearchResult.parse(
      (
        await send(api, 'POST', `/api/v1/indexes/${readyGen.id}/search`, {
          query: targetTerms || 'retrieval',
          filters: {
            documentIds: [targetDoc.id],
            documentNames: [targetDoc.name],
            mimeTypes: ['text/plain'],
            pageMin: 1,
            pageMax: 1,
          },
        })
      ).body,
    );
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(
      filtered.items.every(
        (item) =>
          item.documentId === targetDoc.id &&
          item.documentName === targetDoc.name &&
          item.page === 1,
      ),
    ).toBe(true);

    // Dense search on a keyword-only generation fails cleanly with 422.
    expect(
      (
        await send(api, 'POST', `/api/v1/indexes/${readyGen.id}/search`, {
          query: 'chunking',
          mode: 'dense',
        })
      ).status,
    ).toBe(422);

    // Chunks endpoint paginates stored generation chunks.
    const chunkPage = c
      .page(c.generationChunk)
      .parse(
        (
          await send(
            api,
            'GET',
            `/api/v1/indexes/${readyGen.id}/chunks?limit=2`,
          )
        ).body,
      );
    expect(chunkPage.items).toHaveLength(2);
  });
});

describe('Hybrid retrieval, reranking, shared service, failed reindex, and concurrency isolation', () => {
  it('runs hybrid search with RRF, optional reranker apply/fallback/fail, and shares one retrieval service with grounded answers', async () => {
    const fakeQdrant = new InMemoryQdrant();
    let rerankMode: 'ok' | 'malformed' = 'ok';
    const chatCalls: unknown[] = [];

    const { api, runWorkerOnce } = createHarness(
      {
        QDRANT_URL: 'http://qdrant.invalid',
        LOCAL_EMBED_BASE_URL: 'http://local.invalid/v1',
        LOCAL_EMBED_MODEL: 'local-embed',
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_CHAT_MODEL: 'gpt-5-mini',
        RERANK_BASE_URL: 'http://rerank.invalid/rerank',
        RERANK_MODEL: 'fixture-reranker',
      },
      {
        openaiCompatible: makeEmbedTransport(),
        openai: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ content: string }>;
          };
          chatCalls.push(body);
          // Extract first chunkId mentioned in prompt to return a valid grounded citation.
          const match = body.messages[1].content.match(/id=([0-9a-f-]{36})/i);
          return Response.json({
            id: 'chat-1',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-5-mini',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    answer: 'Grounded hybrid answer.',
                    citations: match ? [match[1]] : [],
                    abstained: false,
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 10,
              total_tokens: 30,
            },
          });
        },
        rerank: async (_url, init) => {
          if (rerankMode === 'malformed') {
            return Response.json({ results: [{ index: 999, score: 1 }] });
          }
          const req = JSON.parse(String(init?.body)) as { documents: string[] };
          // Reverse candidate order to verify reranking changes final ranking.
          return Response.json({
            id: 'rr-hybrid',
            results: req.documents.map((_d, index) => ({
              index,
              relevance_score: (index + 1) / (req.documents.length + 1),
            })),
          });
        },
      },
      fakeQdrant,
    );

    const sample = datasets.sample().value;
    const createRes = await send(api, 'POST', '/api/v1/indexes', {
      datasetId: sample.id,
      mode: 'hybrid',
      chunking: { strategy: 'character-window', chunkSize: 300, overlap: 20 },
    });
    expect(createRes.status).toBe(202);
    const { index: gen } = c.createIndexResult.parse(createRes.body);
    expect(await runWorkerOnce()).toBe(true);

    // Hybrid search without reranker.
    const hybrid = c.indexSearchResult.parse(
      (
        await send(api, 'POST', `/api/v1/indexes/${gen.id}/search`, {
          query: 'chunking retrieval overlap',
          mode: 'hybrid',
          topK: 3,
        })
      ).body,
    );
    expect(hybrid.items).toHaveLength(3);
    expect(hybrid.stages.keywordCount).toBeGreaterThan(0);
    expect(hybrid.stages.denseCount).toBeGreaterThan(0);
    expect(hybrid.stages.fusedCount).toBeGreaterThan(0);
    expect(hybrid.stages.rerankStatus).toBe('skipped');
    expect(hybrid.items[0].fusedRank).toBe(1);
    expect(hybrid.items[0].fusedScore).toBeGreaterThan(0);
    expect(hybrid.usage?.embedding?.inputTokens).toBeGreaterThan(0);

    // Hybrid search with reranker applied.
    const reranked = c.indexSearchResult.parse(
      (
        await send(api, 'POST', `/api/v1/indexes/${gen.id}/search`, {
          query: 'chunking retrieval overlap',
          mode: 'hybrid',
          topK: 3,
          candidateDepth: 4,
          reranker: { enabled: true, failurePolicy: 'fail' },
        })
      ).body,
    );
    expect(reranked.stages.reranked).toBe(true);
    expect(reranked.stages.rerankStatus).toBe('applied');
    expect(reranked.items[0].rerankRank).toBe(1);
    expect(reranked.items[0].rerankScore).not.toBeNull();
    expect(reranked.items[0].chunkId).not.toBe(hybrid.items[0].chunkId);

    // Malformed reranker with failurePolicy='fail' rejects with 502; 'fallback' preserves fused order.
    rerankMode = 'malformed';
    const failRes = await send(
      api,
      'POST',
      `/api/v1/indexes/${gen.id}/search`,
      {
        query: 'chunking retrieval overlap',
        mode: 'hybrid',
        topK: 3,
        reranker: { enabled: true, failurePolicy: 'fail' },
      },
    );
    expect(failRes.status).toBe(502);
    expect(c.errorEnvelope.parse(failRes.body).error.code).toBe(
      'upstream_failure',
    );

    const fallback = c.indexSearchResult.parse(
      (
        await send(api, 'POST', `/api/v1/indexes/${gen.id}/search`, {
          query: 'chunking retrieval overlap',
          mode: 'hybrid',
          topK: 3,
          reranker: { enabled: true, failurePolicy: 'fallback' },
        })
      ).body,
    );
    expect(fallback.stages.reranked).toBe(false);
    expect(fallback.stages.rerankStatus).toBe('fallback');
    expect(fallback.stages.rerankError).toBeTruthy();
    expect(fallback.items.map((i) => i.chunkId)).toEqual(
      hybrid.items.map((i) => i.chunkId),
    );

    // Shared retrieval service for /answer validates generation params BEFORE inference.
    const badTemp = await send(
      api,
      'POST',
      `/api/v1/indexes/${gen.id}/answer`,
      {
        query: 'chunking retrieval overlap',
        mode: 'hybrid',
        topK: 3,
        temperature: 0.2,
      },
    );
    expect(badTemp.status).toBe(422);
    expect(c.errorEnvelope.parse(badTemp.body).error.code).toBe(
      'missing_capability',
    );
    expect(chatCalls).toHaveLength(0);

    // Valid answer uses identical retrieval trace and records validated citations & context.
    const answerRes = await send(
      api,
      'POST',
      `/api/v1/indexes/${gen.id}/answer`,
      {
        query: 'chunking retrieval overlap',
        mode: 'hybrid',
        topK: 3,
        temperature: 1,
        maxTokens: 200,
        contextBudgetChars: 1000,
      },
    );
    expect(answerRes.status).toBe(200);
    const answered = c.indexAnswerResult.parse(answerRes.body);
    expect(answered.retrieval.items.map((i) => i.chunkId)).toEqual(
      hybrid.items.map((i) => i.chunkId),
    );
    expect(answered.citations).toEqual([hybrid.items[0].chunkId]);
    expect(answered.abstained).toBe(false);
    expect(answered.context.length).toBeGreaterThan(0);
    expect(answered.effectiveParams).toMatchObject({
      maxTokens: 200,
      structuredOutput: true,
    });
  });

  it('leaves the prior generation readable when a reindex fails and cleans up failed generation artifacts', async () => {
    const fakeQdrant = new InMemoryQdrant();
    const { api, qdrant, runWorkerOnce } = createHarness(
      {
        QDRANT_URL: 'http://qdrant.invalid',
        LOCAL_EMBED_BASE_URL: 'http://local.invalid/v1',
        LOCAL_EMBED_MODEL: 'local-embed',
      },
      { openaiCompatible: makeEmbedTransport() },
      fakeQdrant,
    );

    const sample = datasets.sample().value;
    const firstRes = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: sample.id,
          mode: 'hybrid',
        })
      ).body,
    );
    expect(await runWorkerOnce()).toBe(true);
    const firstReady = indexes.get(firstRes.index.id);
    expect(firstReady.state).toBe('ready');

    const beforeSearch = c.indexSearchResult.parse(
      (
        await send(api, 'POST', `/api/v1/indexes/${firstReady.id}/search`, {
          query: 'chunking overlap',
          topK: 3,
        })
      ).body,
    );
    expect(beforeSearch.items.length).toBeGreaterThan(0);

    // Trigger a forced reindex and inject a Qdrant failure mid-upsert.
    const secondRes = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: sample.id,
          mode: 'hybrid',
          forceRebuild: true,
        })
      ).body,
    );
    expect(secondRes.index.id).not.toBe(firstReady.id);
    fakeQdrant.failNextUpsertForGeneration = secondRes.index.id;
    expect(await runWorkerOnce()).toBe(true);

    const secondAfter = indexes.get(secondRes.index.id);
    expect(secondAfter.state).toBe('failed');
    expect(secondAfter.errorMessage).toBeTruthy();

    // Failed generation has zero FTS rows and zero Qdrant points remaining.
    const ftsRows = db
      .prepare('SELECT count(*) AS n FROM chunk_fts WHERE generation_id = ?')
      .get(secondAfter.id)?.n;
    expect(ftsRows).toBe(0);
    const colName = qdrant?.collectionForDimension(4) ?? 'rag-eval-chunks-d4';
    expect(
      await fakeQdrant.count(colName, {
        filter: {
          must: [{ key: 'generationId', match: { value: secondAfter.id } }],
        },
      }),
    ).toEqual({ count: 0 });

    // Prior generation remains ready and returns identical search results!
    expect(indexes.get(firstReady.id).state).toBe('ready');
    const afterSearch = c.indexSearchResult.parse(
      (
        await send(api, 'POST', `/api/v1/indexes/${firstReady.id}/search`, {
          query: 'chunking overlap',
          topK: 3,
        })
      ).body,
    );
    expect(afterSearch.items.map((i) => i.chunkId)).toEqual(
      beforeSearch.items.map((i) => i.chunkId),
    );

    // Retrying the failed index job creates a new generation and succeeds.
    if (!secondRes.jobId) throw new Error('Expected second index jobId.');
    const retryRes = await send(
      api,
      'POST',
      `/api/v1/jobs/${secondRes.jobId}/retry`,
      {},
    );
    expect(retryRes.status).toBe(202);
    const retriedJob = c.job.parse(retryRes.body);
    expect(retriedJob.kind).toBe('index');
    expect(retriedJob.parentId).toBe(secondRes.jobId);
    expect(retriedJob.generationId).not.toBe(secondRes.index.id);
    if (!retriedJob.generationId) {
      throw new Error('Expected retried index job to reference a generation.');
    }
    expect(await runWorkerOnce()).toBe(true);
    expect(indexes.get(retriedJob.generationId).state).toBe('ready');
  });

  it('prevents concurrent index builds and concurrent searches from mixing generations', async () => {
    const fakeQdrant = new InMemoryQdrant();
    fakeQdrant.raceCreateOnce = true;

    const { api, indexBuilder, retrieval } = createHarness(
      {
        QDRANT_URL: 'http://qdrant.invalid',
        LOCAL_EMBED_BASE_URL: 'http://local.invalid/v1',
        LOCAL_EMBED_MODEL: 'local-embed',
      },
      { openaiCompatible: makeEmbedTransport() },
      fakeQdrant,
    );

    const dsA = datasets.create('Corpus Alpha');
    const dsB = datasets.create('Corpus Beta');
    // Upload and parse one unique document into each dataset.
    const upA = c.uploadResult.parse(
      (
        await send(
          api,
          'POST',
          `/api/v1/datasets/${dsA.id}/documents?name=alpha.txt`,
          undefined,
          { 'if-match': '"1"', 'content-type': 'text/plain' },
          'Alpha zephyr quantum retrieval document.',
        )
      ).body,
    );
    const upB = c.uploadResult.parse(
      (
        await send(
          api,
          'POST',
          `/api/v1/datasets/${dsB.id}/documents?name=beta.txt`,
          undefined,
          { 'if-match': '"1"', 'content-type': 'text/plain' },
          'Beta nebula photon retrieval document.',
        )
      ).body,
    );
    const workerOpts = {
      directory: blobs,
      cloud: new CloudParser('https://unused.invalid', undefined),
    };
    expect(await runOne(datasets.jobs, workerOpts)).toBe(true);
    expect(await runOne(datasets.jobs, workerOpts)).toBe(true);
    expect(datasets.jobs.get(upA.jobId).state).toBe('succeeded');
    expect(datasets.jobs.get(upB.jobId).state).toBe('succeeded');

    const genA = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: dsA.id,
          mode: 'hybrid',
        })
      ).body,
    ).index;
    const genB = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: dsB.id,
          mode: 'hybrid',
        })
      ).body,
    ).index;

    // Build both generations concurrently against the same dimension collection (including 409 create race).
    const [readyA, readyB] = await Promise.all([
      indexBuilder.build(genA.id),
      indexBuilder.build(genB.id),
    ]);
    expect(readyA.state).toBe('ready');
    expect(readyB.state).toBe('ready');

    // Run concurrent searches across both generations and confirm strict isolation.
    const [resA, resB, kwCrossA, kwCrossB] = await Promise.all([
      retrieval.search(
        readyA.id,
        c.indexSearchRequest.parse({ query: 'retrieval', mode: 'hybrid' }),
      ),
      retrieval.search(
        readyB.id,
        c.indexSearchRequest.parse({ query: 'retrieval', mode: 'hybrid' }),
      ),
      retrieval.search(
        readyA.id,
        c.indexSearchRequest.parse({ query: 'nebula photon', mode: 'keyword' }),
      ),
      retrieval.search(
        readyB.id,
        c.indexSearchRequest.parse({
          query: 'zephyr quantum',
          mode: 'keyword',
        }),
      ),
    ]);

    expect(resA.items.every((i) => i.documentName === 'alpha.txt')).toBe(true);
    expect(resB.items.every((i) => i.documentName === 'beta.txt')).toBe(true);
    expect(resA.items).toHaveLength(1);
    expect(resB.items).toHaveLength(1);
    expect(kwCrossA.items).toEqual([]);
    expect(kwCrossB.items).toEqual([]);
  });

  it('validates pipeline retrieval and reranker capabilities against server configuration', async () => {
    const { api } = createHarness();
    // Dense mode fails without Qdrant/embedding.
    expect(
      (
        await send(api, 'POST', '/api/v1/pipelines', {
          name: 'Dense without Qdrant',
          config: { retriever: { mode: 'dense', topK: 5 } },
        })
      ).status,
    ).toBe(422);
    // Reranker fails without configured HTTP reranker.
    expect(
      (
        await send(api, 'POST', '/api/v1/pipelines', {
          name: 'Rerank without profile',
          config: { reranker: { enabled: true } },
        })
      ).status,
    ).toBe(422);
    // Keyword mode succeeds with zero providers configured.
    expect(
      (
        await send(api, 'POST', '/api/v1/pipelines', {
          name: 'Keyword offline',
          config: { retriever: { mode: 'keyword', topK: 5 } },
        })
      ).status,
    ).toBe(201);
  });

  it('does not let a stale worker with a lost lease delete Qdrant points of a generation published by a replacement worker', async () => {
    const fakeQdrant = new InMemoryQdrant();
    const { api, qdrant, indexBuilder, retrieval } = createHarness(
      {
        QDRANT_URL: 'http://qdrant.invalid',
        LOCAL_EMBED_BASE_URL: 'http://local.invalid/v1',
        LOCAL_EMBED_MODEL: 'local-embed',
      },
      { openaiCompatible: makeEmbedTransport() },
      fakeQdrant,
    );

    const sample = datasets.sample().value;
    const created = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: sample.id,
          mode: 'hybrid',
        })
      ).body,
    );
    const generationId = created.index.id;

    // Simulate Worker 1 losing its lease right AFTER upserting vectors while Worker 2
    // has already reclaimed and published the generation as ready.
    let checkpointStage = '';
    let vectorGuards = 0;
    let replacementPublished = false;
    await expect(
      indexBuilder.build(generationId, {
        checkpoint: (stage) => {
          checkpointStage = stage;
        },
        guard: () => {
          if (checkpointStage === 'indexing-vectors' && !replacementPublished) {
            vectorGuards += 1;
            const chunks = indexes.allChunks(generationId);
            const col = qdrant?.collectionForDimension(4) ?? 'fixture-d4';
            const upsertedSoFar =
              fakeQdrant.collections.get(col)?.points.size ?? 0;
            if (
              upsertedSoFar >= chunks.length ||
              vectorGuards > chunks.length
            ) {
              replacementPublished = true;
              // Replacement worker publishes SQLite ready state for the same generation.
              indexes.markReady(generationId, {
                chunkCount: chunks.length,
                embeddingDimensions: 4,
                qdrantCollection: col,
              });
              throw new LostLease();
            }
          }
        },
      }),
    ).rejects.toBeInstanceOf(LostLease);
    expect(replacementPublished).toBe(true);

    // SQLite remains ready AND Qdrant vectors MUST NOT have been wiped by stale Worker 1!
    const readyGen = indexes.get(generationId);
    expect(readyGen.state).toBe('ready');
    const colName = qdrant?.collectionForDimension(4) ?? 'fixture-d4';
    const pointCount = await fakeQdrant.count(colName, {
      filter: {
        must: [{ key: 'generationId', match: { value: generationId } }],
      },
    });
    expect(pointCount.count).toBe(readyGen.chunkCount);
    expect(pointCount.count).toBeGreaterThan(0);

    const denseHits = await retrieval.search(
      generationId,
      c.indexSearchRequest.parse({
        query: 'chunking overlap',
        mode: 'dense',
        topK: 3,
      }),
    );
    expect(denseHits.items.length).toBeGreaterThan(0);
  });

  it('isolates BM25 scores and rankings per generation so adding another generation never alters existing rankings', async () => {
    const { api, indexBuilder, retrieval } = createHarness();

    const dsA = datasets.create('BM25 Gen A');
    let revA = dsA.revision;
    const uploadDoc = async (
      datasetId: string,
      rev: number,
      name: string,
      content: string,
    ) => {
      const res = c.uploadResult.parse(
        (
          await send(
            api,
            'POST',
            `/api/v1/datasets/${datasetId}/documents?name=${encodeURIComponent(name)}`,
            undefined,
            { 'if-match': `"${rev}"`, 'content-type': 'text/plain' },
            content,
          )
        ).body,
      );
      expect(
        await runOne(datasets.jobs, {
          directory: blobs,
          cloud: new CloudParser('https://unused.invalid', undefined),
        }),
      ).toBe(true);
      return res.dataset.revision;
    };

    // In Generation A alone, zephyr and quasar both appear in 1 of 2 docs (equal IDF),
    // while doc1 is shorter, so doc1 ranks #1 for "zephyr quasar".
    revA = await uploadDoc(dsA.id, revA, 'doc1.txt', 'zephyr baseline');
    revA = await uploadDoc(
      dsA.id,
      revA,
      'doc2.txt',
      'quasar baseline padding words to make this second document noticeably longer than the first',
    );

    const genA = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: dsA.id,
          mode: 'keyword',
        })
      ).body,
    ).index;
    await indexBuilder.build(genA.id);

    const before = await retrieval.search(
      genA.id,
      c.indexSearchRequest.parse({
        query: 'zephyr quasar',
        mode: 'keyword',
        topK: 5,
      }),
    );
    expect(before.items).toHaveLength(2);
    expect(before.items[0].documentName).toBe('doc1.txt');
    const beforeSnapshot = before.items.map((item) => ({
      chunkId: item.chunkId,
      documentName: item.documentName,
      keywordScore: item.keywordScore,
    }));

    // Add a second generation B packed with "zephyr" documents. With shared global FTS5
    // statistics, df(zephyr) explodes and reverses doc1/doc2 in unchanged Generation A.
    const dsB = datasets.create('BM25 Gen B');
    let revB = dsB.revision;
    for (let i = 0; i < 15; i++) {
      revB = await uploadDoc(
        dsB.id,
        revB,
        `skew-${i}.txt`,
        `zephyr skew document number ${i} with zephyr repeated`,
      );
    }
    const genB = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: dsB.id,
          mode: 'keyword',
        })
      ).body,
    ).index;
    await indexBuilder.build(genB.id);

    const after = await retrieval.search(
      genA.id,
      c.indexSearchRequest.parse({
        query: 'zephyr quasar',
        mode: 'keyword',
        topK: 5,
      }),
    );
    expect(
      after.items.map((item) => ({
        chunkId: item.chunkId,
        documentName: item.documentName,
        keywordScore: item.keywordScore,
      })),
    ).toEqual(beforeSnapshot);
  });

  it('indexes distinct document versions with identical bytes using distinct chunk IDs while sharing the parse artifact', async () => {
    const { api, indexBuilder, retrieval } = createHarness();
    const ds = datasets.create('Duplicate Bytes Corpus');
    const identicalText =
      'Shared compliance bulletin covering immutable generation chunking.';

    const up1 = c.uploadResult.parse(
      (
        await send(
          api,
          'POST',
          `/api/v1/datasets/${ds.id}/documents?name=copy-one.txt`,
          undefined,
          { 'if-match': '"1"', 'content-type': 'text/plain' },
          identicalText,
        )
      ).body,
    );
    const up2 = c.uploadResult.parse(
      (
        await send(
          api,
          'POST',
          `/api/v1/datasets/${ds.id}/documents?name=copy-two.txt`,
          undefined,
          {
            'if-match': `"${up1.dataset.revision}"`,
            'content-type': 'text/plain',
          },
          identicalText,
        )
      ).body,
    );

    const parseOpts = {
      directory: blobs,
      cloud: new CloudParser('https://unused.invalid', undefined),
    };
    expect(await runOne(datasets.jobs, parseOpts)).toBe(true);
    expect(await runOne(datasets.jobs, parseOpts)).toBe(true);

    // Both document versions share a single parse_artifacts record.
    const artifactCount = Number(
      db.prepare('SELECT count(*) AS n FROM parse_artifacts').get()?.n ?? 0,
    );
    expect(artifactCount).toBe(1);

    const gen = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: ds.id,
          mode: 'keyword',
        })
      ).body,
    ).index;
    const readyGen = await indexBuilder.build(gen.id);

    const storedChunks = indexes.allChunks(readyGen.id);
    expect(storedChunks).toHaveLength(2);
    expect(new Set(storedChunks.map((ch) => ch.chunkId)).size).toBe(2);
    expect(new Set(storedChunks.map((ch) => ch.documentId))).toEqual(
      new Set([up1.documentId, up2.documentId]),
    );

    // Both documents are searchable, including filtering specifically to the second duplicate document.
    const searchAll = await retrieval.search(
      readyGen.id,
      c.indexSearchRequest.parse({ query: 'compliance bulletin', topK: 5 }),
    );
    expect(new Set(searchAll.items.map((item) => item.documentId))).toEqual(
      new Set([up1.documentId, up2.documentId]),
    );
    const searchSecond = await retrieval.search(
      readyGen.id,
      c.indexSearchRequest.parse({
        query: 'compliance bulletin',
        filters: { documentIds: [up2.documentId] },
        topK: 5,
      }),
    );
    expect(searchSecond.items).toHaveLength(1);
    expect(searchSecond.items[0].documentId).toBe(up2.documentId);
  });

  it('pins document-version parse artifacts at index plan time so reparsing before build does not drift from the fingerprint', async () => {
    const { api, indexBuilder, retrieval } = createHarness({
      LLAMA_CLOUD_API_KEY: 'fixture-llama-key',
    });
    const ds = datasets.create('Pinned Parse Corpus');
    const up = c.uploadResult.parse(
      (
        await send(
          api,
          'POST',
          `/api/v1/datasets/${ds.id}/documents?name=guide.txt`,
          undefined,
          { 'if-match': '"1"', 'content-type': 'text/plain' },
          'Original local parse content with keyword albatross.',
        )
      ).body,
    );
    expect(
      await runOne(datasets.jobs, {
        directory: blobs,
        cloud: new CloudParser('https://unused.invalid', undefined),
      }),
    ).toBe(true);

    // Plan the index generation BEFORE reparsing (do not execute the index job yet).
    const planned = c.createIndexResult.parse(
      (
        await send(api, 'POST', '/api/v1/indexes', {
          datasetId: ds.id,
          mode: 'keyword',
        })
      ).body,
    );

    // Reparse the SAME document version with LlamaParse before the index builds!
    const reparseRes = await send(
      api,
      'POST',
      `/api/v1/documents/${up.documentId}/parses`,
      { parser: 'llama-parse' },
      { 'if-match': `"${up.dataset.revision}"` },
    );
    expect(reparseRes.status).toBe(202);
    const fakeCloud = {
      upload: async () => 'remote-job-1',
      poll: async () => true,
      download: async () => ({
        text: 'Reparsed cloud content with keyword pelican.',
        pages: [{ page: 1, start: 0, end: 44 }],
      }),
    } as unknown as CloudParser;
    expect(
      await runOne(datasets.jobs, { directory: blobs, cloud: fakeCloud }),
    ).toBe(true);

    // Build the previously planned index generation: it MUST build from the artifact
    // pinned when the generation was planned ("albatross"), NOT the later reparse ("pelican")!
    await indexBuilder.build(planned.index.id);

    const alphaHits = await retrieval.search(
      planned.index.id,
      c.indexSearchRequest.parse({ query: 'albatross', mode: 'keyword' }),
    );
    const pelicanHits = await retrieval.search(
      planned.index.id,
      c.indexSearchRequest.parse({ query: 'pelican', mode: 'keyword' }),
    );
    expect(alphaHits.items).toHaveLength(1);
    expect(pelicanHits.items).toHaveLength(0);
  });
});

describe('Origin enforcement on all new index endpoints', () => {
  const same = 'http://localhost';
  const allowed = 'https://editor.test';
  const foreign = 'https://evil.test';

  it.each([same, allowed])(
    'allows %s and rejects foreign origins and preflight on every /api/v1/indexes endpoint',
    async (origin) => {
      const { api, runWorkerOnce } = createHarness(
        {
          OPENAI_API_KEY: 'fixture',
          OPENAI_CHAT_MODEL: 'gpt-5-mini',
        },
        {
          openai: async () =>
            Response.json({
              id: 'chat-cors',
              object: 'chat.completion',
              created: 1,
              model: 'gpt-5-mini',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      answer: 'ok',
                      citations: [],
                      abstained: false,
                    }),
                  },
                },
              ],
            }),
        },
      );
      const sample = datasets.sample().value;

      async function check(method: string, path: string, body?: unknown) {
        const preForeign = await send(api, 'OPTIONS', path, undefined, {
          origin: foreign,
        });
        expect(preForeign.status).toBe(403);
        expect(
          preForeign.headers['access-control-allow-origin'],
        ).toBeUndefined();

        const preAllowed = await send(api, 'OPTIONS', path, undefined, {
          origin,
        });
        expect(preAllowed.status).toBe(204);
        expect(preAllowed.headers['access-control-allow-origin']).toBe(origin);

        const reqForeign = await send(api, method, path, body, {
          origin: foreign,
        });
        expect(reqForeign.status).toBe(403);
        expect(
          reqForeign.headers['access-control-allow-origin'],
        ).toBeUndefined();

        const reqAllowed = await send(api, method, path, body, { origin });
        expect(reqAllowed.headers['access-control-allow-origin']).toBe(origin);
        expect(reqAllowed.status).toBeGreaterThanOrEqual(200);
        expect(reqAllowed.status).toBeLessThan(300);
        return reqAllowed.body;
      }

      const created = c.createIndexResult.parse(
        await check('POST', '/api/v1/indexes', {
          datasetId: sample.id,
          mode: 'keyword',
        }),
      );
      await check('GET', `/api/v1/indexes?datasetId=${sample.id}`);
      await check('GET', `/api/v1/indexes/${created.index.id}`);
      expect(await runWorkerOnce()).toBe(true);
      await check('GET', `/api/v1/indexes/${created.index.id}/chunks`);
      await check('POST', `/api/v1/indexes/${created.index.id}/search`, {
        query: 'retrieval',
      });
      await check('POST', `/api/v1/indexes/${created.index.id}/answer`, {
        query: 'retrieval',
        temperature: 1,
      });

      // Mismatched dev port origin must be rejected.
      const mismatched = await send(
        api,
        'POST',
        `/api/v1/indexes/${created.index.id}/search`,
        { query: 'retrieval' },
        { host: '127.0.0.1:7070', origin: 'http://127.0.0.1:3000' },
      );
      expect(mismatched.status).toBe(403);
    },
  );
});
