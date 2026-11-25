import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { openDatabase } from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Indexes } from '../backend/src/db/indexes';
import { ProviderRegistry } from '../backend/src/providers/registry';
import { IndexBuilder } from '../backend/src/retrieval/indexer';
import { QdrantStore } from '../backend/src/retrieval/qdrant';
import { RetrievalService } from '../backend/src/retrieval/service';

const qdrantUrl = process.env.QDRANT_URL?.trim();
const qdrantApiKey = process.env.QDRANT_API_KEY?.trim() || undefined;
if (!qdrantUrl) {
  console.info(
    'Skipping Qdrant real-server integration tests: QDRANT_URL is not set.',
  );
}

function fixtureVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [
    lower.includes('alpha') || lower.includes('retrieval') ? 1 : 0.05,
    lower.includes('beta') || lower.includes('chunk') ? 1 : 0.05,
    lower.includes('gamma') || lower.includes('rerank') ? 1 : 0.05,
    lower.includes('delta') || lower.includes('citation') ? 1 : 0.05,
  ];
}

describe.skipIf(!qdrantUrl)(
  'Qdrant real-server integration (skipped when QDRANT_URL is unset)',
  () => {
    const prefix = `it-${randomUUID().slice(0, 8)}`;
    const createdCollections = new Set<string>();
    let dir: string;
    let db: ReturnType<typeof openDatabase>;
    let datasets: Datasets;
    let indexes: Indexes;
    let store: QdrantStore;
    let providers: ProviderRegistry;
    let builder: IndexBuilder;
    let retrieval: RetrievalService;

    beforeAll(() => {
      if (!qdrantUrl) throw new Error('QDRANT_URL is required.');
      dir = mkdtempSync(join(tmpdir(), 'qdrant-it-'));
      db = openDatabase(join(dir, 'workspace.db'));
      datasets = new Datasets(db);
      indexes = new Indexes(db, datasets.jobs);
      store = new QdrantStore({
        url: qdrantUrl,
        apiKey: qdrantApiKey,
        collectionPrefix: prefix,
        timeoutMs: 15_000,
      });
      const config = readConfig({
        QDRANT_URL: qdrantUrl,
        ...(qdrantApiKey ? { QDRANT_API_KEY: qdrantApiKey } : {}),
        QDRANT_COLLECTION: prefix,
        LOCAL_EMBED_BASE_URL: 'http://local-fixture.invalid/v1',
        LOCAL_EMBED_MODEL: 'fixture-embed-4d',
        LOCAL_EMBED_DIMENSIONS: '4',
      });
      providers = new ProviderRegistry(config, {
        openaiCompatible: async (_url, init) => {
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
              embedding: fixtureVector(text),
            })),
            usage: {
              prompt_tokens: body.input.length * 2,
              total_tokens: body.input.length * 2,
            },
          });
        },
      });
      builder = new IndexBuilder({
        indexes,
        providers,
        qdrant: store,
        embedBatchSize: 2,
        qdrantBatchSize: 2,
      });
      retrieval = new RetrievalService({
        indexes,
        providers,
        qdrant: store,
      });
    });

    afterAll(async () => {
      for (const col of createdCollections) {
        await store.deleteCollection(col).catch(() => {});
      }
      db?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('indexes scoped fixture vectors, filters metadata, isolates generations, and preserves prior generation on failed reindex', async () => {
      const sample = datasets.sample().value;
      const col = store.collectionForDimension(4);
      createdCollections.add(col);

      // Build generation 1 on the sample dataset.
      const plan1 = indexes.planOrReuse(
        c.createIndexRequest.parse({
          datasetId: sample.id,
          mode: 'hybrid',
          chunking: {
            strategy: 'character-window',
            chunkSize: 300,
            overlap: 20,
          },
        }),
        {
          provider: 'openai-compatible',
          model: 'fixture-embed-4d',
          expectedDimensions: 4,
        },
      );
      const gen1 = await builder.build(plan1.index.id);
      expect(gen1.state).toBe('ready');
      expect(gen1.embeddingDimensions).toBe(4);
      expect(gen1.chunkCount).toBeGreaterThan(0);

      // Scoped dense + hybrid search returns only generation 1 chunks.
      const denseRes = await retrieval.search(
        gen1.id,
        c.indexSearchRequest.parse({
          query: 'chunk overlap',
          mode: 'dense',
          topK: 3,
        }),
      );
      expect(denseRes.items).toHaveLength(3);
      expect(denseRes.items[0].denseRank).toBe(1);

      const targetDoc = sample.documents[0];
      const targetFull = datasets.getDocument(sample.id, targetDoc.id);
      const targetTerms = (targetFull.content ?? '')
        .match(/[a-zA-Z]{5,}/g)
        ?.slice(0, 3)
        .join(' ');
      const filteredRes = await retrieval.search(
        gen1.id,
        c.indexSearchRequest.parse({
          query: targetTerms || 'retrieval chunking',
          mode: 'hybrid',
          topK: 5,
          filters: {
            documentIds: [targetDoc.id],
            documentNames: [targetDoc.name],
            mimeTypes: ['text/plain'],
            pageMin: 1,
            pageMax: 1,
          },
        }),
      );
      expect(filteredRes.items.length).toBeGreaterThan(0);
      expect(
        filteredRes.items.every(
          (i) =>
            i.documentId === targetDoc.id &&
            i.documentName === targetDoc.name &&
            i.page === 1,
        ),
      ).toBe(true);

      // Build an independent second generation concurrently with different chunking and verify isolation.
      const plan2 = indexes.planOrReuse(
        c.createIndexRequest.parse({
          datasetId: sample.id,
          mode: 'dense',
          chunking: { strategy: 'sentence-packed', chunkSize: 200, overlap: 0 },
        }),
        {
          provider: 'openai-compatible',
          model: 'fixture-embed-4d',
          expectedDimensions: 4,
        },
      );
      const gen2 = await builder.build(plan2.index.id);
      expect(gen2.state).toBe('ready');
      expect(gen2.id).not.toBe(gen1.id);

      const [r1, r2] = await Promise.all([
        retrieval.search(
          gen1.id,
          c.indexSearchRequest.parse({
            query: 'retrieval',
            mode: 'dense',
            topK: 5,
          }),
        ),
        retrieval.search(
          gen2.id,
          c.indexSearchRequest.parse({
            query: 'retrieval',
            mode: 'dense',
            topK: 5,
          }),
        ),
      ]);
      const gen1ChunkIds = new Set(
        indexes.allChunks(gen1.id).map((ch) => ch.chunkId),
      );
      const gen2ChunkIds = new Set(
        indexes.allChunks(gen2.id).map((ch) => ch.chunkId),
      );
      expect(r1.items.every((i) => gen1ChunkIds.has(i.chunkId))).toBe(true);
      expect(r2.items.every((i) => gen2ChunkIds.has(i.chunkId))).toBe(true);

      // Dimension mismatch against an existing real Qdrant collection is rejected.
      await expect(
        store.ensureGenerationCollection(col, 8),
      ).rejects.toMatchObject({
        code: 'dimension_mismatch',
      });

      // Failed reindex cleans up ONLY the failed generation and leaves gen1 readable.
      const failingConfig = readConfig({
        QDRANT_URL: qdrantUrl,
        ...(qdrantApiKey ? { QDRANT_API_KEY: qdrantApiKey } : {}),
        QDRANT_COLLECTION: prefix,
        LOCAL_EMBED_BASE_URL: 'http://local-fixture.invalid/v1',
        LOCAL_EMBED_MODEL: 'fixture-embed-4d',
        LOCAL_EMBED_DIMENSIONS: '4',
      });
      const failingBuilder = new IndexBuilder({
        indexes,
        providers: new ProviderRegistry(failingConfig, {
          openaiCompatible: async () =>
            // Return wrong dimensions to force failure during reindex.
            Response.json({
              object: 'list',
              model: 'fixture-embed-4d',
              data: [{ object: 'embedding', index: 0, embedding: [1, 2] }],
            }),
        }),
        qdrant: store,
      });
      const plan3 = indexes.planOrReuse(
        c.createIndexRequest.parse({
          datasetId: sample.id,
          mode: 'hybrid',
          chunking: {
            strategy: 'character-window',
            chunkSize: 300,
            overlap: 20,
          },
          forceRebuild: true,
        }),
        {
          provider: 'openai-compatible',
          model: 'fixture-embed-4d',
          expectedDimensions: 4,
        },
      );
      await expect(
        failingBuilder.buildAndFinalize(plan3.index.id),
      ).rejects.toThrow();
      expect(indexes.get(plan3.index.id).state).toBe('failed');

      // Generation 1 is still intact and searchable in real Qdrant!
      await store.verifyGenerationCount(
        col,
        { generationId: gen1.id, datasetId: sample.id, datasetRevision: 1 },
        gen1.chunkCount,
      );
      const stillReadable = await retrieval.search(
        gen1.id,
        c.indexSearchRequest.parse({
          query: 'chunk overlap',
          mode: 'dense',
          topK: 3,
        }),
      );
      expect(stillReadable.items.map((i) => i.chunkId)).toEqual(
        denseRes.items.map((i) => i.chunkId),
      );
    }, 30_000);
  },
);
