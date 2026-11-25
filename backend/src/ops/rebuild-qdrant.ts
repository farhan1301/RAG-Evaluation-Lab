import { loadEnvironment, readConfig } from '../config/env.js';
import { openDatabase } from '../db/database.js';
import { Indexes } from '../db/indexes.js';
import { Jobs } from '../db/jobs.js';
import { ProviderRegistry } from '../providers/registry.js';
import { QdrantStore } from '../retrieval/qdrant.js';
import { rebuildQdrantFromSqlite } from '../retrieval/rebuild.js';

function parseArgs(argv: string[]) {
  let generationId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--generation' || arg === '-g') {
      const next = argv[++i];
      if (!next)
        throw new Error('Expected a generation UUID after --generation.');
      generationId = next;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: npm run rebuild:qdrant -- [--generation <generation-uuid>]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { generationId };
}

if (process.env.NODE_ENV !== 'test') loadEnvironment();
const args = parseArgs(process.argv.slice(2));
const config = readConfig();
if (!config.qdrant) {
  throw new Error(
    'QDRANT_URL must be configured before rebuilding Qdrant vectors from SQLite.',
  );
}
const db = openDatabase(config.env.DATABASE_PATH);
try {
  const jobs = new Jobs(db, Date.now, config.env.WORKER_LEASE_MS);
  const indexes = new Indexes(db, jobs);
  const providers = new ProviderRegistry(config);
  const qdrant = new QdrantStore({
    url: config.qdrant.url,
    apiKey: config.qdrant.apiKey,
    collectionPrefix: config.qdrant.collectionPrefix,
    timeoutMs: config.env.PROVIDER_TIMEOUT_MS,
  });
  const result = await rebuildQdrantFromSqlite({
    indexes,
    providers,
    qdrant,
    generationId: args.generationId,
    embedBatchSize: config.env.EMBED_BATCH_SIZE,
  });
  console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
} finally {
  db.close();
}
