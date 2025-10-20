import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import type { Server } from 'node:http';
import { loadConfig } from '../src/lib/config.js';
import { OpenAIClient } from '../src/lib/openaiClient.js';
import { QdrantClient } from '../src/lib/qdrantClient.js';
import { createSearchHandler } from '../src/routes/search.js';

interface SearchResponseBody {
  matches: Array<{
    id: string;
    score: number;
    payload: Record<string, unknown>;
  }>;
}

const waitForServerClose = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

const sanitizeCollection = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'default';

const requestWithTimeout = async (
  url: string,
  options: Parameters<typeof fetch>[1],
  timeoutMs = 15000
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

async function ensurePayloadIndex(
  collection: string,
  fieldName: string,
  qdrantUrl: string,
  headers: Record<string, string>
) {
  const url = `${qdrantUrl}/collections/${collection}/index?wait=true`;
  const response = await requestWithTimeout(
    url,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        field_name: fieldName,
        field_schema: 'keyword',
      }),
    },
    15000
  );

  if (response.ok) {
    return true;
  }

  if (response.status === 409) {
    return true;
  }

  const detail = await response.text();
  throw new Error(
    `Failed to create payload index for "${fieldName}" (${response.status}): ${detail}`
  );
}

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

  const config = loadConfig();
  const openai = new OpenAIClient(config);
  const qdrant = new QdrantClient(config);

  const collectionName = sanitizeCollection(config.qdrantCollection);
  const pipelineId = 'verify-pipeline';
  const chunkText =
    'Codexland has a research archive called the Vector Vault where every embedding is catalogued.';

  const { vectors } = await openai.createEmbeddings([chunkText]);
  if (!vectors.length) {
    throw new Error('Embedding API returned no vectors for the seed chunk.');
  }

  const seedVector = vectors[0];
  await qdrant.ensureCollection(seedVector.length, collectionName);

  const qdrantHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.qdrantApiKey) {
    qdrantHeaders['api-key'] = config.qdrantApiKey;
    qdrantHeaders.Authorization = `Bearer ${config.qdrantApiKey}`;
  }

  try {
    await ensurePayloadIndex(collectionName, 'pipelineId', config.qdrantUrl, qdrantHeaders);
  } catch (error) {
    console.warn(
      `⚠️ Unable to ensure payload index for pipelineId: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    console.warn('   Continuing without the index (search fallback will drop the filter).');
  }

  await qdrant.upsertPoints(
    [
      {
        id: randomUUID(),
        vector: seedVector,
        payload: {
          pipelineId,
          text: chunkText,
          chunkId: `seed-${Date.now().toString(36)}`,
        },
      },
    ],
    collectionName
  );

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.post('/api/search', createSearchHandler(openai, qdrant));

  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await waitForServerClose(server);
    throw new Error('Unable to determine ephemeral server port.');
  }

  const { port } = address;

  try {
    const query = 'Where are Codexland embeddings indexed?';
    const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pipelineId,
        question: query,
        topK: 3,
        collectionName,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Search API responded with ${response.status}: ${errorText}`);
    }

    const body = (await response.json()) as SearchResponseBody;
    if (!Array.isArray(body.matches) || body.matches.length === 0) {
      throw new Error('Search API returned no matches.');
    }

    const topMatch = body.matches[0];
    const matchText = String(topMatch.payload?.text ?? '');

    console.log('✅ Search API verification succeeded.');
    console.log(`Matches returned: ${body.matches.length}`);
    console.log(`Top match score: ${topMatch.score.toFixed(4)}`);
    console.log('--- Top Match Text ---');
    console.log(matchText || '(no text payload)');
  } finally {
    await waitForServerClose(server);
  }
}

main().catch((error) => {
  console.error('❌ Search API verification failed.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
