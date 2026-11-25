import { setTimeout as wait } from 'node:timers/promises';
import { loadEnvironment, readConfig } from '../config/env.js';
import { openDatabase } from '../db/database.js';
import { Datasets } from '../db/datasets.js';
import { Generations } from '../db/generations.js';
import { Indexes } from '../db/indexes.js';
import { Jobs } from '../db/jobs.js';
import { Pipelines } from '../db/pipelines.js';
import { Runs } from '../db/runs.js';
import { EvaluationRunner } from '../evaluation/runner.js';
import { SyntheticGenerator } from '../generation/generator.js';
import { blobDirectory } from '../ingestion/blobs.js';
import { CloudParser } from '../ingestion/cloud.js';
import { createLogger } from '../lib/logger.js';
import { ProviderRegistry } from '../providers/registry.js';
import { IndexBuilder } from '../retrieval/indexer.js';
import { QdrantStore } from '../retrieval/qdrant.js';
import { RetrievalService } from '../retrieval/service.js';
import { runOne } from './run.js';

if (process.env.NODE_ENV !== 'test') loadEnvironment();
const config = readConfig(),
  logger = createLogger();
const db = openDatabase(config.env.DATABASE_PATH, undefined, {
    blobDirectory: blobDirectory(config),
  }),
  jobs = new Jobs(db, Date.now, config.env.WORKER_LEASE_MS);
const datasets = new Datasets(db, jobs);
const pipelines = new Pipelines(db);
const indexes = new Indexes(db, jobs);
const runs = new Runs(db, datasets, pipelines, indexes, jobs);
const generations = new Generations(db, datasets, indexes, jobs);
const providers = new ProviderRegistry(config);
const qdrant = config.qdrant
  ? new QdrantStore({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
      collectionPrefix: config.qdrant.collectionPrefix,
      timeoutMs: config.env.PROVIDER_TIMEOUT_MS,
    })
  : undefined;
const indexBuilder = new IndexBuilder({
  indexes,
  providers,
  qdrant,
  embedBatchSize: config.env.EMBED_BATCH_SIZE,
});
const retrieval = new RetrievalService({
  indexes,
  providers,
  qdrant,
});
const evaluationRunner = new EvaluationRunner({
  runs,
  indexes,
  indexBuilder,
  retrieval,
  providers,
});
const syntheticGenerator = new SyntheticGenerator({
  generations,
  indexes,
  providers,
});
const controller = new AbortController();
function stop() {
  controller.abort();
  setTimeout(() => process.exit(1), config.env.SHUTDOWN_TIMEOUT_MS).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
const options = {
  directory: blobDirectory(config),
  cloud: new CloudParser(
    config.parser.llamaParseBaseUrl,
    config.parser.llamaParseApiKey,
  ),
  indexes,
  indexBuilder,
  runs,
  evaluationRunner,
  generations,
  syntheticGenerator,
  signal: controller.signal,
  logger,
};
jobs.presence();
const heartbeat = setInterval(
  () => {
    if (!controller.signal.aborted) jobs.presence();
  },
  Math.floor(jobs.leaseMs / 3),
);
logger.info('worker ready');
try {
  while (!controller.signal.aborted) {
    if (!(await runOne(jobs, options))) {
      await wait(250, undefined, { signal: controller.signal }).catch(() => {});
    }
  }
} finally {
  clearInterval(heartbeat);
  db.close();
  logger.info('worker stopped');
}
