import { loadEnvironment, readConfig } from '../src/config/env.js';
import { QdrantClient } from '../src/lib/qdrantClient.js';

async function main() {
  loadEnvironment();
  const pipelineId = process.argv[2]?.trim();
  const vectorSize = Number(process.argv[3]);
  if (!pipelineId || !Number.isSafeInteger(vectorSize) || vectorSize <= 0) {
    throw new Error('Supply a pipeline ID and a positive vector dimension.');
  }

  const config = readConfig();
  if (!config.legacy.qdrantUrl)
    throw new Error('Configure QDRANT_URL before setting up an index.');
  const qdrant = new QdrantClient(config.legacy);
  const collection = qdrant.collectionNameForPipeline(vectorSize, pipelineId);
  try {
    await qdrant.ensureCollection(vectorSize, collection);
  } catch {
    throw new Error(
      'Qdrant did not confirm index creation. Check the endpoint and collection permissions.',
    );
  }
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
