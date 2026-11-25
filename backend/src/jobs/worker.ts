import { setTimeout as wait } from 'node:timers/promises';
import { loadEnvironment, readConfig } from '../config/env.js';
import { openDatabase } from '../db/database.js';
import { Jobs } from '../db/jobs.js';
import { blobDirectory } from '../ingestion/blobs.js';
import { CloudParser } from '../ingestion/cloud.js';
import { createLogger } from '../lib/logger.js';
import { runOne } from './run.js';

if (process.env.NODE_ENV !== 'test') loadEnvironment();
const config = readConfig(),
  logger = createLogger();
const db = openDatabase(config.env.DATABASE_PATH),
  jobs = new Jobs(db, Date.now, config.env.WORKER_LEASE_MS);
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
    config.legacy.llamaParseBaseUrl,
    config.legacy.llamaParseApiKey,
  ),
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
