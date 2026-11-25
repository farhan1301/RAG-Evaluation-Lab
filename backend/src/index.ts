import { loadEnvironment, readConfig } from './config/env.js';
import { openDatabase, ready } from './db/database.js';
import { Jobs } from './db/jobs.js';
import { Datasets } from './db/datasets.js';
import { Pipelines } from './db/pipelines.js';
import { createApp } from './http/app.js';
import { createLogger } from './lib/logger.js';

if (process.env.NODE_ENV !== 'test') loadEnvironment();
const config = readConfig();
const db = openDatabase(config.env.DATABASE_PATH);
const jobs=new Jobs(db, Date.now, config.env.WORKER_LEASE_MS);
const logger = createLogger();
let stopping = false;
const app = createApp({
  config,
  logger,
  datasets: new Datasets(db),
  pipelines: new Pipelines(db),
  ready: async () => {
    if (stopping || !ready(db) || !jobs.online()) return false;
    if (config.env.QDRANT_REQUIRED !== 'true') return true;
    try {
      const response = await fetch(`${config.legacy.qdrantUrl}/readyz`, {
        headers: config.legacy.qdrantApiKey
          ? { 'api-key': config.legacy.qdrantApiKey }
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
const server = app.listen(config.env.PORT, '127.0.0.1', () =>
  logger.info({ port: config.env.PORT }, 'listening'),
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
