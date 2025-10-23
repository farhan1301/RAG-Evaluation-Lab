import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import fetch from 'node-fetch';
import type { Server } from 'node:http';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../src/lib/config.js';
import { OpenAIClient } from '../src/lib/openaiClient.js';
import { createJudgeHandler } from '../src/routes/judge.js';

interface JudgeVerifyResponse {
  pipelineId: string;
  verdict: 'pass' | 'review';
  passRate: number;
  averageScores: {
    relevance: number;
    contextPrecision: number;
    groundedness: number;
  };
  tokensUsed: number;
  latencyMs: number;
  details: Array<{
    taskId: string;
    verdict: 'pass' | 'review';
    rationale: string;
    scores: {
      relevance: number;
      contextPrecision: number;
      groundedness: number;
    };
    missingCriteria: string[];
    latencyMs: number;
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

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post('/api/judge', createJudgeHandler(openai));

  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await waitForServerClose(server);
    throw new Error('Unable to determine ephemeral server port.');
  }

  const { port } = address;
  const endpoint = `http://127.0.0.1:${port}/api/judge`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pipelineId: 'verify-pipeline',
        evaluations: [
          {
            taskId: 'judge-demo-1',
            question: 'Where does Codexland store its embeddings?',
            answer: 'The embeddings live in the Vector Vault.',
            expectedAnswer:
              'Embeddings are indexed inside the Vector Vault repository located in Codexland.',
            acceptanceRule:
              'Answer must mention the Vector Vault as the storage location.',
            context: [
              'Codexland houses the Vector Vault, a repository where all embeddings are indexed for fast retrieval.',
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Judge API responded with ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as JudgeVerifyResponse;

    console.log('✅ Judge API verification succeeded.');
    console.log(`Pipeline verdict: ${payload.verdict}`);
    console.log(`Pass rate: ${(payload.passRate * 100).toFixed(1)}%`);
    console.log(
      `Average scores -> relevance: ${payload.averageScores.relevance.toFixed(2)}, contextPrecision: ${payload.averageScores.contextPrecision.toFixed(2)}, groundedness: ${payload.averageScores.groundedness.toFixed(2)}`
    );
    console.log(`Total latency: ${payload.latencyMs}ms`);
    console.log(`Tokens used: ${payload.tokensUsed}`);
    payload.details.forEach((detail) => {
      console.log(`- Task ${detail.taskId}: verdict=${detail.verdict}, rationale="${detail.rationale}"`);
    });
  } finally {
    await waitForServerClose(server);
  }
}

main().catch((error) => {
  console.error('❌ Judge API verification failed.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
