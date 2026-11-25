import { existsSync } from 'node:fs';
import { readConfig } from '../config/env.js';
import { checkWorkerHealth } from '../db/database.js';

const config = readConfig();
const dbPath = config.env.DATABASE_PATH;
if (dbPath === ':memory:' || !existsSync(dbPath)) {
  process.exit(1);
}
process.exit(checkWorkerHealth(dbPath, config.env.WORKER_LEASE_MS) ? 0 : 1);
