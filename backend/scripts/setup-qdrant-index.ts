import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../src/lib/config.js';
import { QdrantClient } from '../src/lib/qdrantClient.js';

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..', '..');

  const loadEnvFile = (filename: string, override = false) => {
    const result = loadEnv({ path: path.join(repoRoot, filename), override });
    if (result.error) {
      const error = result.error as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  };

  loadEnvFile('.env');
  loadEnvFile('.env.local', true);

  const pipelineId = process.argv[2]?.trim();
  const vectorSize = Number(process.argv[3]);
  if (!pipelineId || !Number.isSafeInteger(vectorSize) || vectorSize <= 0) {
    throw new Error('Supply a pipeline ID and a positive vector dimension.');
  }

  const qdrant = new QdrantClient(loadConfig());
  const collection = qdrant.collectionNameForPipeline(vectorSize, pipelineId);
  await qdrant.ensureCollection(vectorSize, collection);
  console.log(`Collection "${collection}" and its pipelineId index are ready.`);
}

main().catch((error) => {
  console.error('❌ Unable to create Qdrant payload index.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
