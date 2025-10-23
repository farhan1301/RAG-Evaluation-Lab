import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import fetch from 'node-fetch';
import type { Server } from 'node:http';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../src/lib/config.js';
import { OpenAIClient } from '../src/lib/openaiClient.js';
import { QdrantClient } from '../src/lib/qdrantClient.js';
import { createEmbeddingsHandler } from '../src/routes/embeddings.js';
import { createAnswerHandler } from '../src/routes/answer.js';

interface AnswerResponseBody {
  answer: string;
  context: Array<{
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
  const documentId = `doc-${Date.now().toString(36)}`;
  const chunkId = randomUUID();
  const chunkText =
    'Codexland houses the Vector Vault, a repository where all embeddings are indexed for fast retrieval.';

  await qdrant.ensureCollection(1536, collectionName);

  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.post('/api/chunks', createEmbeddingsHandler(openai, qdrant));
  app.post('/api/answer', createAnswerHandler(openai, qdrant));

  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await waitForServerClose(server);
    throw new Error('Unable to determine ephemeral server port.');
  }

  const { port } = address;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const upsertResponse = await fetch(`${baseUrl}/api/chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pipelineId,
        documentId,
        collectionName,
        chunks: [
          {
            id: chunkId,
            text: chunkText,
            metadata: {
              source: 'verify-answer-script',
            },
          },
        ],
      }),
    });

    if (!upsertResponse.ok) {
      const detail = await upsertResponse.text();
      throw new Error(`Chunks API request failed (${upsertResponse.status}): ${detail}`);
    }

    const question = 'Where does Codexland store its embeddings?';
    const answerResponse = await fetch(`${baseUrl}/api/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pipelineId,
        collectionName,
        question,
        topK: 3,
      }),
    });

    if (!answerResponse.ok) {
      const detail = await answerResponse.text();
      throw new Error(`Answer API request failed (${answerResponse.status}): ${detail}`);
    }

    const payload = (await answerResponse.json()) as AnswerResponseBody;
    console.log('✅ Answer API verification succeeded.');
    console.log(`Question: ${question}`);
    console.log('--- Answer ---');
    console.log(payload.answer || '(empty)');
    console.log('--- Context Matches ---');
    payload.context?.forEach((match, index) => {
      console.log(
        `${index + 1}. score=${match.score.toFixed(4)} text=${String(match.payload?.text ?? '')}`
      );
    });
  } finally {
    await waitForServerClose(server);
  }
}

main().catch((error) => {
  console.error('❌ Answer API verification failed.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
