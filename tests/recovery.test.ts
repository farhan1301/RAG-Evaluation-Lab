import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { backupWorkspace, restoreWorkspace } from '../backend/src/db/backup';
import {
  checkWorkerHealth,
  openDatabase,
  ready,
  SCHEMA_VERSION,
} from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Indexes } from '../backend/src/db/indexes';
import { Jobs } from '../backend/src/db/jobs';
import { Pipelines } from '../backend/src/db/pipelines';
import { Runs, SOFTWARE_VERSION } from '../backend/src/db/runs';
import { EvaluationRunner } from '../backend/src/evaluation/runner';
import { createApp } from '../backend/src/http/app';
import { storeUpload } from '../backend/src/ingestion/blobs';
import { CloudParser } from '../backend/src/ingestion/cloud';
import { runOne } from '../backend/src/jobs/run';
import { createLogger } from '../backend/src/lib/logger';
import { ProviderRegistry } from '../backend/src/providers/registry';
import { IndexBuilder } from '../backend/src/retrieval/indexer';
import {
  QdrantStore,
  type QdrantClientLike,
  type QdrantFilter,
} from '../backend/src/retrieval/qdrant';
import { rebuildQdrantFromSqlite } from '../backend/src/retrieval/rebuild';
import { RetrievalService } from '../backend/src/retrieval/service';
import { runComposeSmoke } from '../scripts/compose-smoke.mjs';
import { send } from './inProcess';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

function matchesFilter(
  payload: Record<string, unknown>,
  filter: QdrantFilter,
): boolean {
  for (const cond of filter.must) {
    const val = payload[cond.key];
    if ('match' in cond) {
      if ('value' in cond.match && val !== cond.match.value) return false;
      if ('any' in cond.match && !cond.match.any.includes(String(val ?? ''))) {
        return false;
      }
    } else if ('range' in cond) {
      const num = Number(val);
      if (cond.range.gte !== undefined && num < cond.range.gte) return false;
      if (cond.range.lte !== undefined && num > cond.range.lte) return false;
    }
  }
  return true;
}

class InMemoryQdrant implements QdrantClientLike {
  collections = new Map<
    string,
    {
      size: number;
      indexes: Set<string>;
      points: Map<
        string,
        { vector: number[]; payload: Record<string, unknown> }
      >;
    }
  >();

  wipe() {
    this.collections.clear();
  }

  async collectionExists(name: string) {
    return { exists: this.collections.has(name) };
  }

  async getCollection(name: string) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    return { config: { params: { vectors: { size: col.size } } } };
  }

  async createCollection(name: string, args: { vectors: { size: number } }) {
    this.collections.set(name, {
      size: args.vectors.size,
      indexes: new Set(),
      points: new Map(),
    });
  }

  async createPayloadIndex(name: string, args: { field_name: string }) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    col.indexes.add(args.field_name);
  }

  async upsert(
    name: string,
    args: {
      points: Array<{
        id: string;
        vector: number[];
        payload: Record<string, unknown>;
      }>;
    },
  ) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    for (const p of args.points) {
      col.points.set(p.id, { vector: p.vector, payload: p.payload });
    }
  }

  async query(
    name: string,
    args: { query: number[]; limit: number; filter: QdrantFilter },
  ) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found.`);
    const scored = Array.from(col.points.entries())
      .filter(([, p]) => matchesFilter(p.payload, args.filter))
      .map(([id, p]) => ({
        id,
        score: cosine(args.query, p.vector),
        payload: p.payload,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit);
    return { points: scored };
  }

  async count(name: string, args: { filter: QdrantFilter }) {
    const col = this.collections.get(name);
    if (!col) return { count: 0 };
    let count = 0;
    for (const p of col.points.values()) {
      if (matchesFilter(p.payload, args.filter)) count += 1;
    }
    return { count };
  }

  async delete(name: string, args: { filter: QdrantFilter }) {
    const col = this.collections.get(name);
    if (!col) return;
    for (const [id, p] of col.points.entries()) {
      if (matchesFilter(p.payload, args.filter)) col.points.delete(id);
    }
  }

  async deleteCollection(name: string) {
    this.collections.delete(name);
  }
}

function deterministicEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  return [
    lower.includes('chunk') || lower.includes('overlap') ? 1 : 0.1,
    lower.includes('embedding') || lower.includes('cost') ? 1 : 0.1,
    lower.includes('vector') || lower.includes('similarity') ? 1 : 0.1,
    lower.includes('latency') || lower.includes('filtering') ? 1 : 0.1,
  ];
}

function createFakeEmbedRegistry(qdrantUrl: string) {
  const config = readConfig({
    QDRANT_URL: qdrantUrl,
    LOCAL_EMBED_BASE_URL: 'http://local-embed.invalid/v1',
    LOCAL_EMBED_MODEL: 'fixture-embed-4d',
    LOCAL_EMBED_DIMENSIONS: '4',
  });
  return new ProviderRegistry(config, {
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
          embedding: deterministicEmbedding(text),
        })),
        usage: {
          prompt_tokens: body.input.length * 4,
          total_tokens: body.input.length * 4,
        },
      });
    },
  });
}

describe('Phase 8 recovery: backup, restore, Qdrant rebuild, worker health, and smoke flow', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'rag-recovery-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('backs up SQLite online plus private blobs and restores into a fresh directory with full fidelity', async () => {
    const liveDir = join(rootDir, 'live');
    const dbPath = join(liveDir, 'workspace.sqlite');
    const blobDir = join(liveDir, 'blobs');
    const backupDir = join(rootDir, 'backup-1');
    const restoredDir = join(rootDir, 'restored');
    const restoredDbPath = join(restoredDir, 'workspace.sqlite');
    const restoredBlobDir = join(restoredDir, 'blobs');

    const db = openDatabase(dbPath);
    try {
      const jobs = new Jobs(db);
      const datasets = new Datasets(db, jobs);
      const pipelines = new Pipelines(db);
      const indexes = new Indexes(db, jobs);
      const runs = new Runs(db, datasets, pipelines, indexes, jobs);

      // Seed sample dataset + upload a custom text file stored in private blobs.
      const sample = datasets.sample().value;
      const custom = datasets.create('Custom Corpus');
      const uploadBytes = Buffer.from(
        'Quarterly architecture review covering SQLite WAL online backups and vector rebuilds.',
        'utf8',
      );
      const blob = await storeUpload(
        blobDir,
        Readable.from([uploadBytes]),
        'text/plain',
        1024 * 1024,
      );
      const uploaded = datasets.addUpload(
        custom.id,
        custom.revision,
        'architecture.txt',
        blob,
        'local',
        null,
      );

      // Build keyword index and execute a retrieval-only experiment on sample.
      const p1 = pipelines.create(
        c.pipelineInput.parse({
          name: 'Keyword Baseline',
          config: { retriever: { mode: 'keyword', topK: 5 } },
        }),
      );
      const exp = runs.createExperiment(
        c.experimentInput.parse({
          name: 'Recovery Check',
          datasetId: sample.id,
          baselinePipelineId: p1.id,
          pipelineIds: [p1.id],
          mode: 'retrieval_only',
        }),
      );
      const config = readConfig({
        DATABASE_PATH: dbPath,
        BLOB_DIRECTORY: blobDir,
      });
      const created = runs.createRun(exp.id, c.createRunRequest.parse({}), {
        capabilities: config.capabilities,
        pricing: config.pricing,
        budgets: config.budgets,
      });
      const providers = new ProviderRegistry(config);
      const indexBuilder = new IndexBuilder({ indexes, providers });
      const retrieval = new RetrievalService({ indexes, providers });
      const runner = new EvaluationRunner({
        runs,
        indexes,
        indexBuilder,
        retrieval,
        providers,
      });
      await runner.execute(created.run.id);
      const completedRun = runs.getRun(created.run.id);
      expect(completedRun.state).toBe('succeeded');

      // Perform online backup while the live WAL-mode database connection is STILL OPEN.
      const manifest = await backupWorkspace({
        databasePath: dbPath,
        blobDirectory: blobDir,
        outputDir: backupDir,
      });
      expect(manifest.formatVersion).toBe(1);
      expect(manifest.softwareVersion).toBe(SOFTWARE_VERSION);
      expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
      expect(manifest.blobCount).toBe(1);
      expect(Object.keys(manifest.blobs)).toEqual([blob.key]);

      // Restore into a completely fresh directory.
      const restored = await restoreWorkspace({
        backupDir,
        databasePath: restoredDbPath,
        blobDirectory: restoredBlobDir,
      });
      expect(restored.restoredBlobs).toBe(1);
      expect(existsSync(join(restoredBlobDir, blob.key))).toBe(true);
      expect(readFileSync(join(restoredBlobDir, blob.key))).toEqual(
        uploadBytes,
      );

      // Verify restored SQLite contents, FTS5 search, and saved run observations.
      const rdb = openDatabase(restoredDbPath);
      try {
        expect(ready(rdb)).toBe(true);
        const rJobs = new Jobs(rdb);
        const rDatasets = new Datasets(rdb, rJobs);
        const rPipelines = new Pipelines(rdb);
        const rIndexes = new Indexes(rdb, rJobs);
        const rRuns = new Runs(rdb, rDatasets, rPipelines, rIndexes, rJobs);

        expect(rDatasets.get(sample.id)).toEqual(sample);
        expect(rDatasets.get(custom.id).documents).toHaveLength(1);
        expect(rDatasets.get(custom.id).documents[0].id).toBe(
          uploaded.documentId,
        );

        const restoredRun = rRuns.getRun(created.run.id);
        expect(restoredRun.state).toBe('succeeded');
        expect(restoredRun.snapshot.softwareVersion).toBe('1.0.0');
        expect(restoredRun.pipelines[0].retrievalMetrics).toEqual(
          completedRun.pipelines[0].retrievalMetrics,
        );

        const genId = restoredRun.pipelines[0].indexGenerationId;
        expect(genId).toBeTruthy();
        const rRetrieval = new RetrievalService({
          indexes: rIndexes,
          providers,
        });
        const hits = await rRetrieval.search(
          genId as string,
          c.indexSearchRequest.parse({ query: 'chunking overlap', topK: 3 }),
        );
        expect(hits.items.length).toBeGreaterThan(0);
      } finally {
        rdb.close();
      }
    } finally {
      db.close();
    }
  });

  it('enforces overwrite protection, stale WAL cleanup, and checksum verification on restore', async () => {
    const dbPath = join(rootDir, 'src', 'workspace.sqlite');
    const blobDir = join(rootDir, 'src', 'blobs');
    const backupDir = join(rootDir, 'backup');
    const db = openDatabase(dbPath);
    try {
      new Datasets(db).sample();
    } finally {
      db.close();
    }
    await backupWorkspace({
      databasePath: dbPath,
      blobDirectory: blobDir,
      outputDir: backupDir,
    });

    // Refuses overwrite without --force.
    const targetDb = join(rootDir, 'target', 'workspace.sqlite');
    const targetBlobs = join(rootDir, 'target', 'blobs');
    await restoreWorkspace({
      backupDir,
      databasePath: targetDb,
      blobDirectory: targetBlobs,
    });
    await expect(
      restoreWorkspace({
        backupDir,
        databasePath: targetDb,
        blobDirectory: targetBlobs,
      }),
    ).rejects.toThrow(/--force/);

    // Cleans stale -wal / -shm sidecars when replacing with force: true.
    writeFileSync(`${targetDb}-wal`, 'stale-wal-garbage', 'utf8');
    writeFileSync(`${targetDb}-shm`, 'stale-shm-garbage', 'utf8');
    await restoreWorkspace({
      backupDir,
      databasePath: targetDb,
      blobDirectory: targetBlobs,
      force: true,
    });
    expect(existsSync(`${targetDb}-wal`)).toBe(false);
    expect(existsSync(`${targetDb}-shm`)).toBe(false);

    // Rejects tampered SQLite backup before overwriting target.
    const tamperedDir = join(rootDir, 'tampered');
    mkdirSync(join(tamperedDir, 'blobs'), { recursive: true });
    writeFileSync(
      join(tamperedDir, 'manifest.json'),
      readFileSync(join(backupDir, 'manifest.json')),
    );
    writeFileSync(join(tamperedDir, 'workspace.sqlite'), 'corrupted-bytes');
    await expect(
      restoreWorkspace({
        backupDir: tamperedDir,
        databasePath: join(rootDir, 'never-created', 'workspace.sqlite'),
        blobDirectory: join(rootDir, 'never-created', 'blobs'),
      }),
    ).rejects.toThrow(/checksum mismatch/i);
  });

  it('rebuilds Qdrant vectors directly from restored SQLite and restores dense and hybrid retrieval', async () => {
    const dbPath = join(rootDir, 'dense-src', 'workspace.sqlite');
    const blobDir = join(rootDir, 'dense-src', 'blobs');
    const backupDir = join(rootDir, 'dense-backup');
    const restoredDbPath = join(rootDir, 'dense-restored', 'workspace.sqlite');
    const restoredBlobDir = join(rootDir, 'dense-restored', 'blobs');

    const fakeQdrant = new InMemoryQdrant();
    const qdrantStore = new QdrantStore({
      url: 'http://qdrant.invalid:6333',
      collectionPrefix: 'rag-eval-chunks',
      client: fakeQdrant,
    });
    const providers = createFakeEmbedRegistry('http://qdrant.invalid:6333');

    let generationId: string;
    let expectedDenseIds: string[];
    let expectedHybridIds: string[];

    const db = openDatabase(dbPath);
    try {
      const jobs = new Jobs(db);
      const datasets = new Datasets(db, jobs);
      const indexes = new Indexes(db, jobs);
      const sample = datasets.sample().value;
      const plan = indexes.planOrReuse(
        c.createIndexRequest.parse({
          datasetId: sample.id,
          mode: 'hybrid',
          embeddingModel: 'fixture-embed-4d',
        }),
        {
          provider: 'openai-compatible',
          model: 'fixture-embed-4d',
          expectedDimensions: 4,
        },
        null,
        false,
      );
      const builder = new IndexBuilder({
        indexes,
        providers,
        qdrant: qdrantStore,
      });
      const built = await builder.build(plan.index.id);
      generationId = built.id;

      const retrieval = new RetrievalService({
        indexes,
        providers,
        qdrant: qdrantStore,
      });
      const denseBefore = await retrieval.search(
        generationId,
        c.indexSearchRequest.parse({
          query: 'vector similarity filtering',
          mode: 'dense',
          topK: 3,
        }),
      );
      const hybridBefore = await retrieval.search(
        generationId,
        c.indexSearchRequest.parse({
          query: 'chunking overlap',
          mode: 'hybrid',
          topK: 3,
        }),
      );
      expect(denseBefore.items.length).toBeGreaterThan(0);
      expect(hybridBefore.items.length).toBeGreaterThan(0);
      expectedDenseIds = denseBefore.items.map((i) => i.chunkId);
      expectedHybridIds = hybridBefore.items.map((i) => i.chunkId);

      await backupWorkspace({
        databasePath: dbPath,
        blobDirectory: blobDir,
        outputDir: backupDir,
      });
    } finally {
      db.close();
    }

    // Restore SQLite into a fresh directory and wipe Qdrant completely.
    await restoreWorkspace({
      backupDir,
      databasePath: restoredDbPath,
      blobDirectory: restoredBlobDir,
    });
    fakeQdrant.wipe();

    const restoredDb = openDatabase(restoredDbPath);
    try {
      const rJobs = new Jobs(restoredDb);
      const rIndexes = new Indexes(restoredDb, rJobs);
      const rRetrieval = new RetrievalService({
        indexes: rIndexes,
        providers,
        qdrant: qdrantStore,
      });

      // Before rebuild, Qdrant collection is missing so dense retrieval fails.
      await expect(
        rRetrieval.search(
          generationId,
          c.indexSearchRequest.parse({
            query: 'vector similarity filtering',
            mode: 'dense',
            topK: 3,
          }),
        ),
      ).rejects.toThrow();

      // Rebuild Qdrant vectors directly from restored SQLite.
      const rebuilt = await rebuildQdrantFromSqlite({
        indexes: rIndexes,
        providers,
        qdrant: qdrantStore,
      });
      expect(rebuilt.rebuiltCount).toBe(1);
      expect(rebuilt.generations[0]).toMatchObject({
        generationId,
        mode: 'hybrid',
        dimensions: 4,
      });

      // Dense and hybrid retrieval match the original pre-wipe rankings!
      const denseAfter = await rRetrieval.search(
        generationId,
        c.indexSearchRequest.parse({
          query: 'vector similarity filtering',
          mode: 'dense',
          topK: 3,
        }),
      );
      const hybridAfter = await rRetrieval.search(
        generationId,
        c.indexSearchRequest.parse({
          query: 'chunking overlap',
          mode: 'hybrid',
          topK: 3,
        }),
      );
      expect(denseAfter.items.map((i) => i.chunkId)).toEqual(expectedDenseIds);
      expect(hybridAfter.items.map((i) => i.chunkId)).toEqual(
        expectedHybridIds,
      );
    } finally {
      restoredDb.close();
    }
  });

  it('verifies worker healthcheck probe and exercises the Compose smoke script end-to-end', async () => {
    const dbPath = join(rootDir, 'smoke', 'workspace.sqlite');
    const blobDir = join(rootDir, 'smoke', 'blobs');
    const staticDir = join(rootDir, 'smoke-ui');
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(
      join(staticDir, 'index.html'),
      '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      'utf8',
    );

    const clock = 10_000;
    const db = openDatabase(dbPath);
    try {
      const jobs = new Jobs(db, () => clock, 5000);
      expect(checkWorkerHealth(dbPath, 5000, () => clock)).toBe(false);
      jobs.presence();
      expect(checkWorkerHealth(dbPath, 5000, () => clock)).toBe(true);
      expect(checkWorkerHealth(dbPath, 5000, () => clock + 6000)).toBe(false);

      const config = readConfig({
        DATABASE_PATH: dbPath,
        BLOB_DIRECTORY: blobDir,
        STATIC_DIR: staticDir,
      });
      const datasets = new Datasets(db, jobs);
      const pipelines = new Pipelines(db);
      const indexes = new Indexes(db, jobs, () => clock);
      const runs = new Runs(
        db,
        datasets,
        pipelines,
        indexes,
        jobs,
        () => clock,
      );
      const providers = new ProviderRegistry(config);
      const indexBuilder = new IndexBuilder({ indexes, providers });
      const retrieval = new RetrievalService({ indexes, providers });
      const evaluationRunner = new EvaluationRunner({
        runs,
        indexes,
        indexBuilder,
        retrieval,
        providers,
      });

      const app = createApp({
        config,
        datasets,
        pipelines,
        indexes,
        runs,
        providers,
        retrieval,
        staticDir,
        logger: createLogger({ write: () => {} }),
        now: () => clock,
        ready: () => ready(db) && jobs.online(),
      });

      const workerOptions = {
        directory: blobDir,
        cloud: new CloudParser(config.parser.llamaParseBaseUrl, undefined),
        indexes,
        indexBuilder,
        runs,
        evaluationRunner,
      };

      // Route smoke-script fetch calls through the in-process Express app and advance worker jobs on poll.
      const fetchImpl: typeof fetch = async (input, init) => {
        await runOne(jobs, workerOptions);
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const rawBody = typeof init?.body === 'string' ? init.body : undefined;
        const headers: Record<string, string> = {};
        if (init?.headers) {
          for (const [k, v] of new Headers(init.headers).entries()) {
            headers[k] = v;
          }
        }
        const res = await send(
          app,
          method,
          `${url.pathname}${url.search}`,
          undefined,
          headers,
          rawBody,
        );
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          outHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        }
        const serialized =
          res.body === undefined
            ? ''
            : typeof res.body === 'string'
              ? res.body
              : JSON.stringify(res.body);
        return new Response(serialized, {
          status: res.status,
          headers: outHeaders,
        });
      };

      const smoke = await runComposeSmoke('http://127.0.0.1:7070', {
        fetchImpl,
        readyTimeoutMs: 5000,
        runTimeoutMs: 10_000,
        pollIntervalMs: 10,
      });
      expect(smoke.state).toBe('succeeded');
      expect(smoke.completedUnits).toBe(20);
    } finally {
      db.close();
    }
  });
});
