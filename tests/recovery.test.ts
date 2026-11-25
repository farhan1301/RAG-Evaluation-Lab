import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

  it('serializes concurrent backup and restore operations per destination and rechecks overwrite permission under lock', async () => {
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
    // exactly one MUST succeed and the other MUST fail with an overwrite error.
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
      /--overwrite/i,
    );

    // Two concurrent restores to the SAME destination without --force:
    // exactly one MUST succeed and the other MUST fail with a --force error.
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
    ).toMatch(/--force/i);

    const checkDb = openDatabase(sharedRestoreDb);
    try {
      expect(ready(checkDb)).toBe(true);
      expect(new Datasets(checkDb).list(10).items).toHaveLength(1);
    } finally {
      checkDb.close();
    }
  });

  it('recovers an interrupted restore swap journal on workspace open and on next restore', async () => {
    // 1. Set up original live workspace with a dataset and blob.
    const liveDir = join(rootDir, 'journal-live');
    const liveDbPath = join(liveDir, 'workspace.sqlite');
    const liveBlobDir = join(liveDir, 'blobs');
    const liveBytes = Buffer.from('Original live workspace payload.', 'utf8');
    let liveDatasetId = '';
    let liveBlobKey = '';
    const db1 = openDatabase(liveDbPath);
    try {
      const jobs = new Jobs(db1);
      const datasets = new Datasets(db1, jobs);
      const ds = datasets.create('Original Journal Dataset');
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

    // 2. Build a replacement backup.
    const replSrcDir = join(rootDir, 'journal-repl-src');
    const replBytes = Buffer.from('Replacement workspace payload.', 'utf8');
    let replDatasetId = '';
    let replBlobKey = '';
    const db2 = openDatabase(join(replSrcDir, 'workspace.sqlite'));
    try {
      const jobs = new Jobs(db2);
      const datasets = new Datasets(db2, jobs);
      const ds = datasets.create('Replacement Journal Dataset');
      replDatasetId = ds.id;
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
    const replBackup = join(rootDir, 'journal-repl-backup');
    await backupWorkspace({
      databasePath: join(replSrcDir, 'workspace.sqlite'),
      blobDirectory: join(replSrcDir, 'blobs'),
      outputDir: replBackup,
    });

    // 3. Simulate a hard crash during swap right AFTER installing replacement blobs
    // and BEFORE installing replacement SQLite DB (phase: 'swapping').
    const stageId = 'crash-stage-1';
    const stagedDbPath = `${liveDbPath}.restore-stage-${stageId}`;
    const stagedBlobsDir = join(liveDir, `.blobs-restore-stage-${stageId}`);
    const prevDbPath = `${liveDbPath}.restore-prev-${stageId}`;
    const prevWalPath = `${liveDbPath}-wal.restore-prev-${stageId}`;
    const prevShmPath = `${liveDbPath}-shm.restore-prev-${stageId}`;
    const prevBlobsDir = join(liveDir, `.blobs-restore-prev-${stageId}`);
    const journalPath = `${liveDbPath}.restore-journal.json`;

    // Move original live files aside, install replacement blobs, leave replacement DB in staging.
    const { renameSync, copyFileSync } = await import('node:fs');
    renameSync(liveDbPath, prevDbPath);
    const hadPrevWal = existsSync(`${liveDbPath}-wal`);
    if (hadPrevWal) renameSync(`${liveDbPath}-wal`, prevWalPath);
    const hadPrevShm = existsSync(`${liveDbPath}-shm`);
    if (hadPrevShm) renameSync(`${liveDbPath}-shm`, prevShmPath);
    renameSync(liveBlobDir, prevBlobsDir);
    mkdirSync(liveBlobDir, { recursive: true });
    copyFileSync(
      join(replBackup, 'blobs', replBlobKey),
      join(liveBlobDir, replBlobKey),
    );
    copyFileSync(join(replBackup, 'workspace.sqlite'), stagedDbPath);

    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        stageId,
        phase: 'swapping',
        targetDbPath: liveDbPath,
        targetBlobsDir: liveBlobDir,
        stagedDbPath,
        stagedBlobsDir,
        prevDbPath,
        prevWalPath,
        prevShmPath,
        prevBlobsDir,
        hadPrevDb: true,
        hadPrevWal,
        hadPrevShm,
        hadPrevBlobs: true,
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    // Target DB is currently absent! Opening the workspace MUST roll back from the journal first.
    expect(existsSync(liveDbPath)).toBe(false);
    const recoveredDb = openDatabase(liveDbPath);
    try {
      expect(ready(recoveredDb)).toBe(true);
      expect(new Datasets(recoveredDb).get(liveDatasetId).name).toBe(
        'Original Journal Dataset',
      );
    } finally {
      recoveredDb.close();
    }
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(prevDbPath)).toBe(false);
    expect(existsSync(stagedDbPath)).toBe(false);
    expect(existsSync(prevBlobsDir)).toBe(false);
    expect(readFileSync(join(liveBlobDir, liveBlobKey))).toEqual(liveBytes);
    expect(existsSync(join(liveBlobDir, replBlobKey))).toBe(false);

    // 4. Simulate a crash after 'committed' (replacement is live & verified, old prev files left behind).
    await restoreWorkspace({
      backupDir: replBackup,
      databasePath: liveDbPath,
      blobDirectory: liveBlobDir,
      force: true,
    });
    const stalePrevDb = `${liveDbPath}.restore-prev-committed-1`;
    const stalePrevBlobs = join(liveDir, '.blobs-restore-prev-committed-1');
    writeFileSync(stalePrevDb, 'old-db-leftover', 'utf8');
    mkdirSync(stalePrevBlobs, { recursive: true });
    writeFileSync(join(stalePrevBlobs, 'old'), 'old-blob', 'utf8');
    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        stageId: 'committed-1',
        phase: 'committed',
        targetDbPath: liveDbPath,
        targetBlobsDir: liveBlobDir,
        stagedDbPath: `${liveDbPath}.restore-stage-committed-1`,
        stagedBlobsDir: join(liveDir, '.blobs-restore-stage-committed-1'),
        prevDbPath: stalePrevDb,
        prevWalPath: `${liveDbPath}-wal.restore-prev-committed-1`,
        prevShmPath: `${liveDbPath}-shm.restore-prev-committed-1`,
        prevBlobsDir: stalePrevBlobs,
        hadPrevDb: true,
        hadPrevWal: false,
        hadPrevShm: false,
        hadPrevBlobs: true,
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const committedDb = openDatabase(liveDbPath);
    try {
      expect(new Datasets(committedDb).get(replDatasetId).name).toBe(
        'Replacement Journal Dataset',
      );
    } finally {
      committedDb.close();
    }
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(stalePrevDb)).toBe(false);
    expect(existsSync(stalePrevBlobs)).toBe(false);
    expect(readFileSync(join(liveBlobDir, replBlobKey))).toEqual(replBytes);

    // 5. Simulate an interrupted 'swapping' journal encountered by the NEXT restoreWorkspace() call:
    // restoreWorkspace MUST roll back the interrupted swap first and then enforce --force!
    const nextStageId = 'crash-before-next-restore';
    const nextPrevDb = `${liveDbPath}.restore-prev-${nextStageId}`;
    const nextPrevBlobs = join(liveDir, `.blobs-restore-prev-${nextStageId}`);
    const nextStagedDb = `${liveDbPath}.restore-stage-${nextStageId}`;
    renameSync(liveDbPath, nextPrevDb);
    rmSync(`${liveDbPath}-wal`, { force: true });
    rmSync(`${liveDbPath}-shm`, { force: true });
    renameSync(liveBlobDir, nextPrevBlobs);
    mkdirSync(liveBlobDir, { recursive: true });
    writeFileSync(join(liveBlobDir, 'partial-uncommitted'), 'junk', 'utf8');
    writeFileSync(nextStagedDb, 'uncommitted-db', 'utf8');
    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        stageId: nextStageId,
        phase: 'swapping',
        targetDbPath: liveDbPath,
        targetBlobsDir: liveBlobDir,
        stagedDbPath: nextStagedDb,
        stagedBlobsDir: join(liveDir, `.blobs-restore-stage-${nextStageId}`),
        prevDbPath: nextPrevDb,
        prevWalPath: `${liveDbPath}-wal.restore-prev-${nextStageId}`,
        prevShmPath: `${liveDbPath}-shm.restore-prev-${nextStageId}`,
        prevBlobsDir: nextPrevBlobs,
        hadPrevDb: true,
        hadPrevWal: false,
        hadPrevShm: false,
        hadPrevBlobs: true,
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );
    await expect(
      restoreWorkspace({
        backupDir: replBackup,
        databasePath: liveDbPath,
        blobDirectory: liveBlobDir,
        force: false,
      }),
    ).rejects.toThrow(/--force/i);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(liveDbPath)).toBe(true);
    expect(readFileSync(join(liveBlobDir, replBlobKey))).toEqual(replBytes);
    expect(existsSync(join(liveBlobDir, 'partial-uncommitted'))).toBe(false);
  });
});
