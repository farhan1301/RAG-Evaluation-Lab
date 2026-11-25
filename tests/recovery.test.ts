import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import {
  acquireDestinationLock,
  backupWorkspace,
  destinationLockPath,
  releaseDestinationLock,
  restoreWorkspace,
} from '../backend/src/db/backup';
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
import {
  resolveRestoreTargets,
  parseRestoreArgs,
} from '../backend/src/ops/restore';
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

  it('validates SQLite blob references, opaque UUID keys, regular files inside root, and sizes/hashes on backup and restore', async () => {
    const liveDir = join(rootDir, 'val-live');
    const dbPath = join(liveDir, 'workspace.sqlite');
    const blobDir = join(liveDir, 'blobs');
    const uploadBytes = Buffer.from(
      'Authoritative uploaded document verified against SQLite.',
      'utf8',
    );

    const db = openDatabase(dbPath);
    let blobKey = '';
    try {
      const jobs = new Jobs(db);
      const datasets = new Datasets(db, jobs);
      const ds = datasets.create('Blob Validation Corpus');
      const blob = await storeUpload(
        blobDir,
        Readable.from([uploadBytes]),
        'text/plain',
        1024 * 1024,
      );
      blobKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'doc.txt', blob, 'local', null);
    } finally {
      db.close();
    }

    // 1. Missing or misconfigured blob directory MUST fail instead of producing a 0-blob backup.
    await expect(
      backupWorkspace({
        databasePath: dbPath,
        blobDirectory: join(rootDir, 'missing-blobs-dir'),
        outputDir: join(rootDir, 'backup-missing-blobs'),
      }),
    ).rejects.toThrow(/blob/i);

    // 2. Corrupted blob content / size / hash mismatch MUST fail backup.
    const blobFile = join(blobDir, blobKey);
    writeFileSync(blobFile, 'tampered-bytes', 'utf8');
    await expect(
      backupWorkspace({
        databasePath: dbPath,
        blobDirectory: blobDir,
        outputDir: join(rootDir, 'backup-hash-mismatch'),
      }),
    ).rejects.toThrow(/size|checksum|hash/i);
    writeFileSync(blobFile, uploadBytes);

    // 3. Symlink inside blob root MUST be rejected on backup.
    const outsideFile = join(rootDir, 'outside.txt');
    writeFileSync(outsideFile, uploadBytes);
    rmSync(blobFile);
    symlinkSync(outsideFile, blobFile);
    await expect(
      backupWorkspace({
        databasePath: dbPath,
        blobDirectory: blobDir,
        outputDir: join(rootDir, 'backup-symlink'),
      }),
    ).rejects.toThrow(/regular file|symlink|blob/i);
    rmSync(blobFile);
    writeFileSync(blobFile, uploadBytes);

    // Take a valid backup first, then tamper manifest to claim zero blobs -> restore MUST reject!
    const goodBackup = join(rootDir, 'backup-good');
    await backupWorkspace({
      databasePath: dbPath,
      blobDirectory: blobDir,
      outputDir: goodBackup,
    });
    const zeroManifestBackup = join(rootDir, 'backup-zero-manifest');
    mkdirSync(join(zeroManifestBackup, 'blobs'), { recursive: true });
    writeFileSync(
      join(zeroManifestBackup, 'workspace.sqlite'),
      readFileSync(join(goodBackup, 'workspace.sqlite')),
    );
    const parsedManifest = JSON.parse(
      readFileSync(join(goodBackup, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      join(zeroManifestBackup, 'manifest.json'),
      JSON.stringify({ ...parsedManifest, blobCount: 0, blobs: {} }),
      'utf8',
    );
    await expect(
      restoreWorkspace({
        backupDir: zeroManifestBackup,
        databasePath: join(rootDir, 'restored-zero', 'workspace.sqlite'),
        blobDirectory: join(rootDir, 'restored-zero', 'blobs'),
      }),
    ).rejects.toThrow(/blob|manifest/i);

    // 4. Unsafe non-UUID blob_key in SQLite MUST be rejected on backup AND by worker!
    const badDb = openDatabase(dbPath);
    try {
      badDb
        .prepare('UPDATE document_versions SET blob_key = ? WHERE blob_key = ?')
        .run('../outside.txt', blobKey);
    } finally {
      badDb.close();
    }
    await expect(
      backupWorkspace({
        databasePath: dbPath,
        blobDirectory: blobDir,
        outputDir: join(rootDir, 'backup-unsafe-key'),
      }),
    ).rejects.toThrow(/blob key|uuid/i);

    // Worker also rejects non-UUID blob_key instead of traversing outside blob root.
    const workerDb = openDatabase(dbPath);
    try {
      const wJobs = new Jobs(workerDb);
      await runOne(wJobs, {
        directory: blobDir,
        cloud: new CloudParser('', undefined),
      });
      const jobRow = workerDb
        .prepare('SELECT state, message FROM jobs LIMIT 1')
        .get();
      expect(jobRow?.state).toBe('failed');
      expect(String(jobRow?.message)).toMatch(/blob key/i);
    } finally {
      workerDb.close();
    }
  });

  it('rejects overlapping source/destination paths and preserves existing workspace when forced restore fails midway', async () => {
    const liveDir = join(rootDir, 'overlap-live');
    const liveDbPath = join(liveDir, 'workspace.sqlite');
    const liveBlobDir = join(liveDir, 'blobs');
    const liveBytes = Buffer.from(
      'Original live workspace blob bytes.',
      'utf8',
    );

    const db1 = openDatabase(liveDbPath);
    let liveDatasetId = '';
    let liveBlobKey = '';
    try {
      const jobs = new Jobs(db1);
      const datasets = new Datasets(db1, jobs);
      const ds = datasets.create('Original Live Dataset');
      liveDatasetId = ds.id;
      const blob = await storeUpload(
        liveBlobDir,
        Readable.from([liveBytes]),
        'text/plain',
        1024 * 1024,
      );
      liveBlobKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'live.txt', blob, 'local', null);
    } finally {
      db1.close();
    }

    // 1. backup --overwrite targeting parent directory containing live workspace MUST reject without deleting anything!
    await expect(
      backupWorkspace({
        databasePath: liveDbPath,
        blobDirectory: liveBlobDir,
        outputDir: liveDir,
        overwrite: true,
      }),
    ).rejects.toThrow(/overlap/i);
    expect(existsSync(liveDbPath)).toBe(true);
    expect(readFileSync(join(liveBlobDir, liveBlobKey))).toEqual(liveBytes);

    // Also reject output nested inside blobDirectory.
    await expect(
      backupWorkspace({
        databasePath: liveDbPath,
        blobDirectory: liveBlobDir,
        outputDir: join(liveBlobDir, 'nested-backup'),
        overwrite: true,
      }),
    ).rejects.toThrow(/overlap/i);
    expect(readFileSync(join(liveBlobDir, liveBlobKey))).toEqual(liveBytes);

    // Create a second distinct workspace and back it up cleanly.
    const src2Dir = join(rootDir, 'src2');
    const src2DbPath = join(src2Dir, 'workspace.sqlite');
    const src2BlobDir = join(src2Dir, 'blobs');
    const backup2Dir = join(rootDir, 'backup-2');
    const src2Bytes = Buffer.from('Replacement backup blob bytes.', 'utf8');
    const db2 = openDatabase(src2DbPath);
    try {
      const jobs2 = new Jobs(db2);
      const ds2 = new Datasets(db2, jobs2);
      const created = ds2.create('Replacement Dataset');
      const blob2 = await storeUpload(
        src2BlobDir,
        Readable.from([src2Bytes]),
        'text/plain',
        1024 * 1024,
      );
      ds2.addUpload(
        created.id,
        created.revision,
        'replacement.txt',
        blob2,
        'local',
        null,
      );
    } finally {
      db2.close();
    }
    await backupWorkspace({
      databasePath: src2DbPath,
      blobDirectory: src2BlobDir,
      outputDir: backup2Dir,
    });

    // 2. Restore with destination overlapping backupDir MUST be rejected.
    await expect(
      restoreWorkspace({
        backupDir: backup2Dir,
        databasePath: join(backup2Dir, 'nested', 'workspace.sqlite'),
        blobDirectory: join(backup2Dir, 'nested', 'blobs'),
        force: true,
      }),
    ).rejects.toThrow(/overlap/i);

    // 3. Forced restore where blob staging fails MUST NOT overwrite target DB or delete previous blobs!
    const roParent = join(rootDir, 'ro-blobs-parent');
    const targetBlobs = join(roParent, 'blobs');
    mkdirSync(targetBlobs, { recursive: true });
    writeFileSync(join(targetBlobs, liveBlobKey), liveBytes);
    chmodSync(roParent, 0o500);
    try {
      await expect(
        restoreWorkspace({
          backupDir: backup2Dir,
          databasePath: liveDbPath,
          blobDirectory: targetBlobs,
          force: true,
        }),
      ).rejects.toThrow();
    } finally {
      chmodSync(roParent, 0o700);
    }

    // Previous live DB and previous blobs MUST remain 100% intact!
    const verifyDb = openDatabase(liveDbPath);
    try {
      expect(new Datasets(verifyDb).get(liveDatasetId).name).toBe(
        'Original Live Dataset',
      );
    } finally {
      verifyDb.close();
    }
    expect(readFileSync(join(targetBlobs, liveBlobKey))).toEqual(liveBytes);
  });

  it('defaults restore CLI blobs beside --database without touching the configured workspace blobs', async () => {
    // 1. Existing configured live workspace with its own sentinel blob.
    const configuredDir = join(rootDir, 'configured-live');
    const configuredDbPath = join(configuredDir, 'workspace.sqlite');
    const configuredBlobDir = join(configuredDir, 'configured-blobs');
    mkdirSync(configuredBlobDir, { recursive: true });
    const sentinelPath = join(configuredBlobDir, 'live-sentinel-blob');
    writeFileSync(sentinelPath, 'DO-NOT-DELETE-CONFIGURED-BLOBS', 'utf8');

    // 2. Create a backup to restore into a separate --database path.
    const srcDir = join(rootDir, 'cli-src');
    const srcDbPath = join(srcDir, 'workspace.sqlite');
    const srcBlobDir = join(srcDir, 'blobs');
    const backupDir = join(rootDir, 'cli-backup');
    const uploadBytes = Buffer.from('CLI restore payload.', 'utf8');
    let uploadedKey = '';
    const srcDb = openDatabase(srcDbPath);
    try {
      const jobs = new Jobs(srcDb);
      const datasets = new Datasets(srcDb, jobs);
      const ds = datasets.create('CLI Restore Dataset');
      const blob = await storeUpload(
        srcBlobDir,
        Readable.from([uploadBytes]),
        'text/plain',
        1024 * 1024,
      );
      uploadedKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'cli.txt', blob, 'local', null);
    } finally {
      srcDb.close();
    }
    await backupWorkspace({
      databasePath: srcDbPath,
      blobDirectory: srcBlobDir,
      outputDir: backupDir,
    });

    // 3. Run the actual restore CLI with --database <newDb> --force and NO --blobs!
    const newDbPath = join(rootDir, 'separate-target', 'workspace.sqlite');
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('backend/src/ops/restore.ts'),
        '--from',
        backupDir,
        '--database',
        newDbPath,
        '--force',
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_PATH: configuredDbPath,
          BLOB_DIRECTORY: configuredBlobDir,
        },
        stdio: 'pipe',
      },
    );

    // Configured workspace's blob directory MUST be completely untouched!
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(sentinelPath, 'utf8')).toBe(
      'DO-NOT-DELETE-CONFIGURED-BLOBS',
    );
    expect(existsSync(join(configuredBlobDir, uploadedKey))).toBe(false);

    // Restored blobs MUST have been placed beside --database!
    const expectedSiblingBlobs = join(dirname(newDbPath), 'blobs');
    expect(existsSync(join(expectedSiblingBlobs, uploadedKey))).toBe(true);
    expect(readFileSync(join(expectedSiblingBlobs, uploadedKey))).toEqual(
      uploadBytes,
    );
  });

  it('rejects backup/restore overlap for directories starting with ".." like "..live"', async () => {
    const container = join(rootDir, 'dotdot-container');
    const liveDir = join(container, '..live');
    const liveDbPath = join(liveDir, 'workspace.sqlite');
    const liveBlobDir = join(liveDir, 'blobs');
    const liveBytes = Buffer.from('Protected ..live workspace bytes.', 'utf8');

    const db = openDatabase(liveDbPath);
    let blobKey = '';
    try {
      const jobs = new Jobs(db);
      const datasets = new Datasets(db, jobs);
      const ds = datasets.create('DotDot Live Dataset');
      const blob = await storeUpload(
        liveBlobDir,
        Readable.from([liveBytes]),
        'text/plain',
        1024 * 1024,
      );
      blobKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'dotdot.txt', blob, 'local', null);
    } finally {
      db.close();
    }

    // Output directory is parent of "..live" -> MUST reject overlap instead of deleting "..live"!
    await expect(
      backupWorkspace({
        databasePath: liveDbPath,
        blobDirectory: liveBlobDir,
        outputDir: container,
        overwrite: true,
      }),
    ).rejects.toThrow(/overlap/i);

    expect(existsSync(liveDbPath)).toBe(true);
    expect(readFileSync(join(liveBlobDir, blobKey))).toEqual(liveBytes);

    // Take a valid backup in a separate dir, then verify restore rejects "..target" inside backupDir.
    const validBackup = join(rootDir, 'dotdot-backup');
    await backupWorkspace({
      databasePath: liveDbPath,
      blobDirectory: liveBlobDir,
      outputDir: validBackup,
    });
    await expect(
      restoreWorkspace({
        backupDir: validBackup,
        databasePath: join(validBackup, '..target', 'workspace.sqlite'),
        blobDirectory: join(validBackup, '..target', 'blobs'),
        force: true,
      }),
    ).rejects.toThrow(/overlap/i);
  });

  it('rejects restore --database without --blobs when implicit sibling blobs overlaps configured workspace blobs', async () => {
    const workDir = join(rootDir, 'shared-dir');
    const configuredDbPath = join(workDir, 'live.sqlite');
    const configuredBlobDir = join(workDir, 'blobs');
    mkdirSync(configuredBlobDir, { recursive: true });
    const sentinelPath = join(configuredBlobDir, 'live-sentinel');
    writeFileSync(sentinelPath, 'LIVE-BLOBS-DO-NOT-CLOBBER', 'utf8');

    const config = readConfig({
      DATABASE_PATH: configuredDbPath,
    });

    // Implicit blobs beside /shared-dir/copy.sqlite resolves to /shared-dir/blobs, overlapping live.sqlite's blobs!
    const copyDbPath = join(workDir, 'copy.sqlite');
    expect(() =>
      resolveRestoreTargets(
        parseRestoreArgs([
          '--from',
          join(rootDir, 'any-backup'),
          '--database',
          copyDbPath,
          '--force',
        ]),
        config,
      ),
    ).toThrow(/--blobs/i);

    // Providing an explicit distinct --blobs succeeds cleanly.
    const distinctBlobs = join(workDir, 'copy-blobs');
    expect(
      resolveRestoreTargets(
        parseRestoreArgs([
          '--from',
          join(rootDir, 'any-backup'),
          '--database',
          copyDbPath,
          '--blobs',
          distinctBlobs,
          '--force',
        ]),
        config,
      ),
    ).toEqual({
      databasePath: copyDbPath,
      blobDirectory: distinctBlobs,
    });

    // Also verify the CLI rejects without modifying configured blobs.
    const srcDir = join(rootDir, 'src-cli-overlap');
    const srcDb = openDatabase(join(srcDir, 'workspace.sqlite'));
    try {
      new Datasets(srcDb).sample();
    } finally {
      srcDb.close();
    }
    const backupDir = join(rootDir, 'backup-cli-overlap');
    await backupWorkspace({
      databasePath: join(srcDir, 'workspace.sqlite'),
      blobDirectory: join(srcDir, 'blobs'),
      outputDir: backupDir,
    });

    expect(() =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('backend/src/ops/restore.ts'),
          '--from',
          backupDir,
          '--database',
          copyDbPath,
          '--force',
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DATABASE_PATH: configuredDbPath,
          },
          stdio: 'pipe',
        },
      ),
    ).toThrow();
    expect(readFileSync(sentinelPath, 'utf8')).toBe(
      'LIVE-BLOBS-DO-NOT-CLOBBER',
    );
  });

  it('restores a WAL-header backup from a read-only source directory (Docker :ro mount flow)', async () => {
    const liveDir = join(rootDir, 'ro-live');
    const liveDbPath = join(liveDir, 'workspace.sqlite');
    const liveBlobDir = join(liveDir, 'blobs');
    const roBackupDir = join(rootDir, 'ro-backup');
    const restoredDir = join(rootDir, 'ro-restored');
    const uploadBytes = Buffer.from(
      'Read-only Docker restore WAL-header test payload.',
      'utf8',
    );

    let blobKey = '';
    const db = openDatabase(liveDbPath);
    try {
      const jobs = new Jobs(db);
      const datasets = new Datasets(db, jobs);
      const ds = datasets.create('Read-Only Restore Corpus');
      const blob = await storeUpload(
        liveBlobDir,
        Readable.from([uploadBytes]),
        'text/plain',
        1024 * 1024,
      );
      blobKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'ro.txt', blob, 'local', null);

      // Perform online backup while WAL DB is open so backup retains WAL header (bytes 18-19 = 2, 2).
      await backupWorkspace({
        databasePath: liveDbPath,
        blobDirectory: liveBlobDir,
        outputDir: roBackupDir,
      });
    } finally {
      db.close();
    }

    const backupSqlite = join(roBackupDir, 'workspace.sqlite');
    const header = readFileSync(backupSqlite);
    expect(header[18]).toBe(2);
    expect(header[19]).toBe(2);
    expect(existsSync(`${backupSqlite}-wal`)).toBe(false);
    expect(existsSync(`${backupSqlite}-shm`)).toBe(false);

    // Lock down backup directory and files to read-only (simulating Docker `:ro` volume mount).
    const roBlobsDir = join(roBackupDir, 'blobs');
    const roBlobFile = join(roBlobsDir, blobKey);
    const roManifest = join(roBackupDir, 'manifest.json');
    chmodSync(backupSqlite, 0o400);
    chmodSync(roManifest, 0o400);
    chmodSync(roBlobFile, 0o400);
    chmodSync(roBlobsDir, 0o500);
    chmodSync(roBackupDir, 0o500);

    try {
      const result = await restoreWorkspace({
        backupDir: roBackupDir,
        databasePath: join(restoredDir, 'workspace.sqlite'),
        blobDirectory: join(restoredDir, 'blobs'),
      });
      expect(result.restoredBlobs).toBe(1);
      expect(readFileSync(join(restoredDir, 'blobs', blobKey))).toEqual(
        uploadBytes,
      );
      const restoredDb = openDatabase(join(restoredDir, 'workspace.sqlite'));
      try {
        expect(ready(restoredDb)).toBe(true);
        expect(new Datasets(restoredDb).list(10).items).toHaveLength(1);
      } finally {
        restoredDb.close();
      }
    } finally {
      chmodSync(roBackupDir, 0o700);
      chmodSync(roBlobsDir, 0o700);
      chmodSync(roBlobFile, 0o600);
      chmodSync(roManifest, 0o600);
      chmodSync(backupSqlite, 0o600);
    }
  });

  it('rejects concurrent backup and restore operations targeting the same destination and rechecks overwrite permission under lock', async () => {
    const src1Dir = join(rootDir, 'race-src1');
    const src2Dir = join(rootDir, 'race-src2');
    const db1 = openDatabase(join(src1Dir, 'workspace.sqlite'));
    try {
      new Datasets(db1).create('Race Source 1');
    } finally {
      db1.close();
    }
    const db2 = openDatabase(join(src2Dir, 'workspace.sqlite'));
    try {
      new Datasets(db2).create('Race Source 2');
    } finally {
      db2.close();
    }

    // Two concurrent backups to the SAME destination without --overwrite:
    // exactly one MUST succeed and the other MUST fail fast on the destination lock
    // (or fail with --overwrite if the first already released the lock).
    const sharedOut = join(rootDir, 'race-backup-out');
    const backupResults = await Promise.allSettled([
      backupWorkspace({
        databasePath: join(src1Dir, 'workspace.sqlite'),
        blobDirectory: join(src1Dir, 'blobs'),
        outputDir: sharedOut,
        overwrite: false,
      }),
      backupWorkspace({
        databasePath: join(src2Dir, 'workspace.sqlite'),
        blobDirectory: join(src2Dir, 'blobs'),
        outputDir: sharedOut,
        overwrite: false,
      }),
    ]);
    const backupFulfilled = backupResults.filter(
      (r) => r.status === 'fulfilled',
    );
    const backupRejected = backupResults.filter((r) => r.status === 'rejected');
    expect(backupFulfilled).toHaveLength(1);
    expect(backupRejected).toHaveLength(1);
    expect(String((backupRejected[0] as PromiseRejectedResult).reason)).toMatch(
      /Another backup\/restore holds|--overwrite/i,
    );

    // Subsequent backup to the now-existing destination without --overwrite MUST fail with --overwrite.
    await expect(
      backupWorkspace({
        databasePath: join(src2Dir, 'workspace.sqlite'),
        blobDirectory: join(src2Dir, 'blobs'),
        outputDir: sharedOut,
        overwrite: false,
      }),
    ).rejects.toThrow(/--overwrite/i);

    // Two concurrent restores to the SAME destination without --force:
    // exactly one MUST succeed and the other MUST fail fast on the destination lock
    // (or fail with --force if the first already released the lock).
    const b1 = join(rootDir, 'race-b1');
    const b2 = join(rootDir, 'race-b2');
    await backupWorkspace({
      databasePath: join(src1Dir, 'workspace.sqlite'),
      blobDirectory: join(src1Dir, 'blobs'),
      outputDir: b1,
    });
    await backupWorkspace({
      databasePath: join(src2Dir, 'workspace.sqlite'),
      blobDirectory: join(src2Dir, 'blobs'),
      outputDir: b2,
    });

    const sharedRestoreDir = join(rootDir, 'race-restore-target');
    const sharedRestoreDb = join(sharedRestoreDir, 'workspace.sqlite');
    const sharedRestoreBlobs = join(sharedRestoreDir, 'blobs');
    const restoreResults = await Promise.allSettled([
      restoreWorkspace({
        backupDir: b1,
        databasePath: sharedRestoreDb,
        blobDirectory: sharedRestoreBlobs,
        force: false,
      }),
      restoreWorkspace({
        backupDir: b2,
        databasePath: sharedRestoreDb,
        blobDirectory: sharedRestoreBlobs,
        force: false,
      }),
    ]);
    const restoreFulfilled = restoreResults.filter(
      (r) => r.status === 'fulfilled',
    );
    const restoreRejected = restoreResults.filter(
      (r) => r.status === 'rejected',
    );
    expect(restoreFulfilled).toHaveLength(1);
    expect(restoreRejected).toHaveLength(1);
    expect(
      String((restoreRejected[0] as PromiseRejectedResult).reason),
    ).toMatch(/Another backup\/restore holds|--force/i);

    // Subsequent restore without --force MUST fail with --force under the lock.
    await expect(
      restoreWorkspace({
        backupDir: b2,
        databasePath: sharedRestoreDb,
        blobDirectory: sharedRestoreBlobs,
        force: false,
      }),
    ).rejects.toThrow(/--force/i);

    const checkDb = openDatabase(sharedRestoreDb);
    try {
      expect(ready(checkDb)).toBe(true);
      expect(new Datasets(checkDb).list(10).items).toHaveLength(1);
    } finally {
      checkDb.close();
    }
  });

  it('checkpoints committed WAL data into .prev before renaming original DB so a post-rename crash preserves original data', async () => {
    const liveDir = join(rootDir, 'wal-crash-live');
    const liveDbPath = join(liveDir, 'workspace.sqlite');
    const liveBlobDir = join(liveDir, 'blobs');
    const liveBytes = Buffer.from('Original live workspace payload.', 'utf8');

    // 1. Seed base dataset + blob and close cleanly.
    const db1 = openDatabase(liveDbPath);
    try {
      const jobs = new Jobs(db1);
      const datasets = new Datasets(db1, jobs);
      const ds = datasets.create('Base Dataset');
      const blob = await storeUpload(
        liveBlobDir,
        Readable.from([liveBytes]),
        'text/plain',
        1024 * 1024,
      );
      datasets.addUpload(ds.id, ds.revision, 'orig.txt', blob, 'local', null);
    } finally {
      db1.close();
    }

    // 2. Commit a new dataset in WAL mode with autocheckpoint disabled and exit
    // without closing the DB so the committed transaction lives ONLY in -wal.
    const databaseModuleUrl = pathToFileURL(
      resolve('backend/src/db/database.ts'),
    ).href;
    const datasetsModuleUrl = pathToFileURL(
      resolve('backend/src/db/datasets.ts'),
    ).href;
    const seedWalScript = `
      import { openDatabase } from ${JSON.stringify(databaseModuleUrl)};
      import { Datasets } from ${JSON.stringify(datasetsModuleUrl)};
      const db = openDatabase(${JSON.stringify(liveDbPath)});
      db.exec('PRAGMA wal_autocheckpoint=0');
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      new Datasets(db).create('WAL-Only Committed Dataset');
      process.exit(0);
    `;
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', seedWalScript],
      { stdio: 'pipe' },
    );

    expect(existsSync(`${liveDbPath}-wal`)).toBe(true);
    expect(statSync(`${liveDbPath}-wal`).size).toBeGreaterThan(0);

    // Confirm BEFORE restore that copying only the main SQLite file (without -wal)
    // does NOT contain the WAL-only committed dataset yet.
    const preCopyPath = join(rootDir, 'pre-checkpoint-main-only.sqlite');
    copyFileSync(liveDbPath, preCopyPath);
    const preCopyDb = new DatabaseSync(preCopyPath, { readOnly: true });
    try {
      const names = new Datasets(preCopyDb)
        .list(10)
        .items.map((item) => item.name);
      expect(names).toContain('Base Dataset');
      expect(names).not.toContain('WAL-Only Committed Dataset');
    } finally {
      preCopyDb.close();
    }

    // 3. Create a valid replacement backup.
    const replSrcDir = join(rootDir, 'wal-crash-repl-src');
    const replDb = openDatabase(join(replSrcDir, 'workspace.sqlite'));
    try {
      new Datasets(replDb).create('Replacement Dataset');
    } finally {
      replDb.close();
    }
    const replBackup = join(rootDir, 'wal-crash-repl-backup');
    await backupWorkspace({
      databasePath: join(replSrcDir, 'workspace.sqlite'),
      blobDirectory: join(replSrcDir, 'blobs'),
      outputDir: replBackup,
    });

    // 4. Simulate a hard crash right after restoreWorkspace renames the original DB to .prev.
    const backupModuleUrl = pathToFileURL(
      resolve('backend/src/db/backup.ts'),
    ).href;
    const crashRestoreScript = `
      import { restoreWorkspace } from ${JSON.stringify(backupModuleUrl)};
      await restoreWorkspace(
        {
          backupDir: ${JSON.stringify(replBackup)},
          databasePath: ${JSON.stringify(liveDbPath)},
          blobDirectory: ${JSON.stringify(liveBlobDir)},
          force: true,
        },
        {
          afterPrevDbRename: () => {
            process.exit(42);
          },
        },
      );
    `;
    const crashResult = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', crashRestoreScript],
      { stdio: 'pipe' },
    );
    expect(crashResult.status).toBe(42);

    // 5. Original DB was moved to .prev and new DB was not yet installed.
    // Thanks to PRAGMA wal_checkpoint(TRUNCATE) before rename, ALL committed WAL
    // data is intact and readable directly from .prev with no -wal needed!
    const prevDbPath = `${liveDbPath}.prev`;
    expect(existsSync(liveDbPath)).toBe(false);
    expect(existsSync(prevDbPath)).toBe(true);
    expect(existsSync(`${prevDbPath}-wal`)).toBe(false);

    const prevInspectDb = new DatabaseSync(prevDbPath, { readOnly: true });
    try {
      const recoveredNames = new Datasets(prevInspectDb)
        .list(10)
        .items.map((item) => item.name);
      expect(recoveredNames).toContain('Base Dataset');
      expect(recoveredNames).toContain('WAL-Only Committed Dataset');
    } finally {
      prevInspectDb.close();
    }

    // Startup refuses while .prev exists; manual recovery restores full access.
    expect(() => openDatabase(liveDbPath)).toThrow(/\.prev/i);
    renameSync(prevDbPath, liveDbPath);
    rmSync(destinationLockPath(liveDbPath), { force: true });
    rmSync(destinationLockPath(liveBlobDir), { force: true });
    const manualDb = openDatabase(liveDbPath);
    try {
      const names = new Datasets(manualDb)
        .list(10)
        .items.map((item) => item.name);
      expect(names).toContain('Base Dataset');
      expect(names).toContain('WAL-Only Committed Dataset');
    } finally {
      manualDb.close();
    }
  });

  it('fails fast with clear error when a destination lock already exists and never takes over stale locks', async () => {
    const srcDir = join(rootDir, 'lock-src');
    const srcDbPath = join(srcDir, 'workspace.sqlite');
    const srcBlobDir = join(srcDir, 'blobs');
    const db = openDatabase(srcDbPath);
    try {
      new Datasets(db).create('Lock Test Dataset');
    } finally {
      db.close();
    }

    // 1. Pre-existing lock file with a dead PID on backup outputDir MUST fail fast and NEVER be taken over.
    const backupOut = join(rootDir, 'lock-backup-out');
    const backupLock = destinationLockPath(backupOut);
    const deadOwnerPayload = JSON.stringify({
      token: 'dead-owner-token',
      pid: 999_999_999,
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    writeFileSync(backupLock, deadOwnerPayload, 'utf8');

    await expect(
      backupWorkspace({
        databasePath: srcDbPath,
        blobDirectory: srcBlobDir,
        outputDir: backupOut,
      }),
    ).rejects.toThrow(
      `Another backup/restore holds ${backupLock}. If none is running, delete ${backupLock} and retry.`,
    );
    expect(readFileSync(backupLock, 'utf8')).toBe(deadOwnerPayload);
    rmSync(backupLock);

    // Take a valid backup for restore lock tests.
    await backupWorkspace({
      databasePath: srcDbPath,
      blobDirectory: srcBlobDir,
      outputDir: backupOut,
    });

    // 2. Pre-existing DB lock file fails fast and is never taken over.
    const restoreDir = join(rootDir, 'lock-restore-target');
    const restoreDb = join(restoreDir, 'workspace.sqlite');
    const restoreBlobs = join(restoreDir, 'blobs');
    mkdirSync(restoreDir, { recursive: true });
    const dbLock = destinationLockPath(restoreDb);
    const blobsLock = destinationLockPath(restoreBlobs);
    writeFileSync(dbLock, deadOwnerPayload, 'utf8');

    await expect(
      restoreWorkspace({
        backupDir: backupOut,
        databasePath: restoreDb,
        blobDirectory: restoreBlobs,
      }),
    ).rejects.toThrow(
      `Another backup/restore holds ${dbLock}. If none is running, delete ${dbLock} and retry.`,
    );
    expect(readFileSync(dbLock, 'utf8')).toBe(deadOwnerPayload);
    expect(existsSync(blobsLock)).toBe(false);
    rmSync(dbLock);

    // 3. Empty pre-existing blobs lock file fails fast immediately (never hangs) and releases DB lock.
    writeFileSync(blobsLock, '', 'utf8');
    await expect(
      restoreWorkspace({
        backupDir: backupOut,
        databasePath: restoreDb,
        blobDirectory: restoreBlobs,
      }),
    ).rejects.toThrow(
      `Another backup/restore holds ${blobsLock}. If none is running, delete ${blobsLock} and retry.`,
    );
    expect(readFileSync(blobsLock, 'utf8')).toBe('');
    expect(existsSync(dbLock)).toBe(false);
  });

  it('does not delete a destination lock file on release when the lock token differs', async () => {
    const lockPath = join(rootDir, 'token-check.rag-eval.lock');
    const lock = await acquireDestinationLock(lockPath);
    try {
      const initial = JSON.parse(readFileSync(lock.path, 'utf8')) as {
        token: string;
        pid: number;
      };
      expect(initial.token).toBe(lock.token);
      expect(initial.pid).toBe(process.pid);

      // Simulate another owner holding the lock path with a different token.
      const foreignPayload = JSON.stringify({
        token: 'different-owner-token',
        pid: 424242,
        createdAt: new Date().toISOString(),
      });
      writeFileSync(lock.path, foreignPayload, 'utf8');

      const released = await releaseDestinationLock(lock);
      expect(released).toBe(false);
      expect(existsSync(lock.path)).toBe(true);
      expect(readFileSync(lock.path, 'utf8')).toBe(foreignPayload);
    } finally {
      rmSync(lock.path, { force: true });
    }

    // Releasing when the token still matches removes the lock file cleanly.
    const owned = await acquireDestinationLock(lockPath);
    expect(await releaseDestinationLock(owned)).toBe(true);
    expect(existsSync(owned.path)).toBe(false);
  });

  it('refuses to open workspace on startup when interrupted restore .prev files exist', () => {
    const wsDir = join(rootDir, 'startup-prev');
    const dbPath = join(wsDir, 'workspace.sqlite');
    const db = openDatabase(dbPath);
    db.close();

    // 1. <db>.prev blocks startup with manual recovery instructions.
    const dbPrev = `${dbPath}.prev`;
    writeFileSync(dbPrev, 'prev-db-placeholder', 'utf8');
    expect(() => openDatabase(dbPath)).toThrow(/manual recovery/i);
    expect(() => openDatabase(dbPath)).toThrow(/\.prev/i);
    rmSync(dbPrev);

    // 2. Default sibling blobs.prev blocks startup.
    const siblingBlobsPrev = join(wsDir, 'blobs.prev');
    mkdirSync(siblingBlobsPrev, { recursive: true });
    expect(() => openDatabase(dbPath)).toThrow(/blobs\.prev/i);
    rmSync(siblingBlobsPrev, { recursive: true });

    // 3. Configured custom blobDirectory .prev blocks startup when passed to openDatabase.
    const customBlobs = join(rootDir, 'custom-blobs');
    const customBlobsPrev = `${customBlobs}.prev`;
    mkdirSync(customBlobsPrev, { recursive: true });
    expect(() =>
      openDatabase(dbPath, undefined, { blobDirectory: customBlobs }),
    ).toThrow(/custom-blobs\.prev/i);
    rmSync(customBlobsPrev, { recursive: true });

    // Once .prev files are removed, startup succeeds cleanly.
    const opened = openDatabase(dbPath, undefined, {
      blobDirectory: customBlobs,
    });
    try {
      expect(ready(opened)).toBe(true);
    } finally {
      opened.close();
    }
  });

  it('aborts restore without touching the original workspace when WAL checkpoint is busy', async () => {
    const liveDir = join(rootDir, 'busy-live');
    const liveDbPath = join(liveDir, 'workspace.sqlite');
    const liveBlobDir = join(liveDir, 'blobs');
    const liveBytes = Buffer.from('Original busy workspace blob.', 'utf8');

    let liveDatasetId = '';
    let liveBlobKey = '';
    const setupDb = openDatabase(liveDbPath);
    try {
      const jobs = new Jobs(setupDb);
      const datasets = new Datasets(setupDb, jobs);
      const ds = datasets.create('Original Busy Dataset');
      liveDatasetId = ds.id;
      const blob = await storeUpload(
        liveBlobDir,
        Readable.from([liveBytes]),
        'text/plain',
        1024 * 1024,
      );
      liveBlobKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'busy.txt', blob, 'local', null);
    } finally {
      setupDb.close();
    }

    // Build a valid replacement backup.
    const replSrcDir = join(rootDir, 'busy-repl-src');
    const replBytes = Buffer.from('Replacement busy backup blob.', 'utf8');
    let replBlobKey = '';
    const replDb = openDatabase(join(replSrcDir, 'workspace.sqlite'));
    try {
      const jobs = new Jobs(replDb);
      const datasets = new Datasets(replDb, jobs);
      const ds = datasets.create('Replacement Busy Dataset');
      const blob = await storeUpload(
        join(replSrcDir, 'blobs'),
        Readable.from([replBytes]),
        'text/plain',
        1024 * 1024,
      );
      replBlobKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'repl.txt', blob, 'local', null);
    } finally {
      replDb.close();
    }
    const replBackup = join(rootDir, 'busy-repl-backup');
    await backupWorkspace({
      databasePath: join(replSrcDir, 'workspace.sqlite'),
      blobDirectory: join(replSrcDir, 'blobs'),
      outputDir: replBackup,
    });

    // Hold an open writer connection with an active write transaction on the live DB.
    const writer = openDatabase(liveDbPath);
    try {
      writer.exec('BEGIN IMMEDIATE');
      writer
        .prepare(
          'INSERT OR REPLACE INTO worker_presence (id, seen) VALUES (1, ?)',
        )
        .run(12345);

      await expect(
        restoreWorkspace({
          backupDir: replBackup,
          databasePath: liveDbPath,
          blobDirectory: liveBlobDir,
          force: true,
        }),
      ).rejects.toThrow(/checkpoint.*busy|busy/i);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }

    // Original workspace MUST be 100% untouched, with no .prev or lock files left behind.
    expect(existsSync(`${liveDbPath}.prev`)).toBe(false);
    expect(existsSync(`${liveBlobDir}.prev`)).toBe(false);
    expect(existsSync(destinationLockPath(liveDbPath))).toBe(false);
    expect(existsSync(destinationLockPath(liveBlobDir))).toBe(false);
    expect(readFileSync(join(liveBlobDir, liveBlobKey))).toEqual(liveBytes);
    expect(existsSync(join(liveBlobDir, replBlobKey))).toBe(false);

    const verifyDb = openDatabase(liveDbPath);
    try {
      expect(new Datasets(verifyDb).get(liveDatasetId).name).toBe(
        'Original Busy Dataset',
      );
      expect(new Datasets(verifyDb).list(10).items).toHaveLength(1);
    } finally {
      verifyDb.close();
    }
  });

  it('rolls back .prev files in-process when an error occurs midway through swap', async () => {
    const liveDir = join(rootDir, 'rollback-live');
    const liveDbPath = join(liveDir, 'workspace.sqlite');
    const liveBlobDir = join(liveDir, 'blobs');
    const liveBytes = Buffer.from('Original rollback blob.', 'utf8');

    let liveDatasetId = '';
    let liveBlobKey = '';
    const db1 = openDatabase(liveDbPath);
    try {
      const jobs = new Jobs(db1);
      const datasets = new Datasets(db1, jobs);
      const ds = datasets.create('Original Rollback Dataset');
      liveDatasetId = ds.id;
      const blob = await storeUpload(
        liveBlobDir,
        Readable.from([liveBytes]),
        'text/plain',
        1024 * 1024,
      );
      liveBlobKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'orig.txt', blob, 'local', null);
    } finally {
      db1.close();
    }

    const replSrcDir = join(rootDir, 'rollback-repl-src');
    const replBytes = Buffer.from('Replacement rollback blob.', 'utf8');
    let replBlobKey = '';
    const db2 = openDatabase(join(replSrcDir, 'workspace.sqlite'));
    try {
      const jobs = new Jobs(db2);
      const datasets = new Datasets(db2, jobs);
      const ds = datasets.create('Replacement Rollback Dataset');
      const blob = await storeUpload(
        join(replSrcDir, 'blobs'),
        Readable.from([replBytes]),
        'text/plain',
        1024 * 1024,
      );
      replBlobKey = blob.key;
      datasets.addUpload(ds.id, ds.revision, 'repl.txt', blob, 'local', null);
    } finally {
      db2.close();
    }
    const replBackup = join(rootDir, 'rollback-repl-backup');
    await backupWorkspace({
      databasePath: join(replSrcDir, 'workspace.sqlite'),
      blobDirectory: join(replSrcDir, 'blobs'),
      outputDir: replBackup,
    });

    await expect(
      restoreWorkspace(
        {
          backupDir: replBackup,
          databasePath: liveDbPath,
          blobDirectory: liveBlobDir,
          force: true,
        },
        {
          afterInstallBlobs: () => {
            throw new Error('simulated swap failure');
          },
        },
      ),
    ).rejects.toThrow('simulated swap failure');

    expect(existsSync(`${liveDbPath}.prev`)).toBe(false);
    expect(existsSync(`${liveBlobDir}.prev`)).toBe(false);
    expect(existsSync(destinationLockPath(liveDbPath))).toBe(false);
    expect(existsSync(destinationLockPath(liveBlobDir))).toBe(false);
    expect(readFileSync(join(liveBlobDir, liveBlobKey))).toEqual(liveBytes);
    expect(existsSync(join(liveBlobDir, replBlobKey))).toBe(false);

    const verifyDb = openDatabase(liveDbPath);
    try {
      expect(new Datasets(verifyDb).get(liveDatasetId).name).toBe(
        'Original Rollback Dataset',
      );
    } finally {
      verifyDb.close();
    }
  });
});
