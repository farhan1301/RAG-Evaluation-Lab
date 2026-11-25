import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment, readConfig } from './config/env.js';
import { openDatabase, ready } from './db/database.js';
import { Datasets } from './db/datasets.js';
import { Indexes } from './db/indexes.js';
import { Jobs } from './db/jobs.js';
import { Pipelines } from './db/pipelines.js';
import { createApp } from './http/app.js';
import { blobDirectory } from './ingestion/blobs.js';
import { createLogger } from './lib/logger.js';

if (process.env.NODE_ENV !== 'test') loadEnvironment();
const config = readConfig();
const defaultStaticDir = fileURLToPath(
  new URL('../../frontend/build', import.meta.url),
);
const staticDir =
  config.env.STATIC_DIR ??
  (process.env.NODE_ENV === 'production' &&
  existsSync(join(defaultStaticDir, 'index.html'))
    ? defaultStaticDir
    : undefined);
const db = openDatabase(config.env.DATABASE_PATH, undefined, {
  blobDirectory: blobDirectory(config),
});
const jobs = new Jobs(db, Date.now, config.env.WORKER_LEASE_MS);
const logger = createLogger();
let stopping = false;
const app = createApp({
  config,
  logger,
  staticDir,
  datasets: new Datasets(db, jobs),
  pipelines: new Pipelines(db),
  indexes: new Indexes(db, jobs),
  ready: async () => {
    if (stopping || !ready(db) || !jobs.online()) return false;
    if (config.env.QDRANT_REQUIRED !== 'true' || !config.qdrant) return true;
    try {
      const response = await fetch(`${config.qdrant.url}/readyz`, {
        headers: config.qdrant.apiKey
          ? { 'api-key': config.qdrant.apiKey }
          : {},
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  },
});
const server = app.listen(config.env.PORT, config.env.HOST, () =>
  logger.info({ host: config.env.HOST, port: config.env.PORT }, 'listening'),
);
function shutdown() {
  if (stopping) return;
  stopping = true;
  // A disconnected client may still have a pending provider call. Bound process drain as well as socket drain.
  let closed = false;
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    if (!closed) db.close();
    logger.warn('shutdown deadline reached');
    process.exit(1);
  }, config.env.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();
  server.close(() => {
    db.close();
    closed = true;
    logger.info('stopped');
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
