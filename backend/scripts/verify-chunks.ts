import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/lib/config.js';
import { OpenAIClient } from '../src/lib/openaiClient.js';
import { QdrantClient } from '../src/lib/qdrantClient.js';
import { createEmbeddingsHandler } from '../src/routes/embeddings.js';

interface VerifyResponse {
  upserted: number;
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

async function deleteCollection(
  collection: string,
  qdrantUrl: string,
  headers: Record<string, string>
) {
  const response = await fetch(`${qdrantUrl}/collections/${collection}`, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok && response.status !== 404) {
    const detail = await response.text();
    throw new Error(`Failed to delete temporary Qdrant collection (${response.status}): ${detail}`);
  }
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

  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.post('/api/chunks', createEmbeddingsHandler(openai, qdrant));

  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await waitForServerClose(server);
    throw new Error('Unable to determine ephemeral server port.');
  }

  const { port } = address;
  const collectionName = `verify-chunks-${Date.now().toString(36)}`;
  const payload = {
    pipelineId: 'verify-pipeline',
    documentId: 'verify-doc',
    collectionName,
    chunks: [
      {
    id: randomUUID(),
        text: 'Codexland is a fictional place where embeddings are thoroughly tested.',
        metadata: {
          source: 'verification-script',
        },
      },
    ],
  };

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chunks API responded with ${response.status}: ${errorText}`);
    }

    const body = (await response.json()) as VerifyResponse;
    console.log('✅ Chunks API verification succeeded.');
    console.log(`Upserted chunks: ${body.upserted}`);
  } finally {
    await waitForServerClose(server);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.qdrantApiKey) {
        headers['api-key'] = config.qdrantApiKey;
        headers.Authorization = `Bearer ${config.qdrantApiKey}`;
      }
      await deleteCollection(collectionName, config.qdrantUrl, headers);
    } catch (cleanupError) {
      console.warn(
        `⚠️ Failed to remove temporary collection "${collectionName}":`,
        cleanupError instanceof Error ? cleanupError.message : cleanupError
      );
    }
  }
}

main().catch((error) => {
  console.error('❌ Chunks API verification failed.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
