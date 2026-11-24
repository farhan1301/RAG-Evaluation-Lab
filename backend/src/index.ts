import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import express from 'express';
import { loadConfig } from './lib/config.js';
import { OpenAIClient } from './lib/openaiClient.js';
import { QdrantClient } from './lib/qdrantClient.js';
import { createEmbeddingsHandler } from './routes/embeddings.js';
import { createSearchHandler } from './routes/search.js';
import { createAnswerHandler } from './routes/answer.js';
import { LlamaParseClient } from './lib/llamaParseClient.js';
import { createParseHandler } from './routes/parse.js';
import { createJudgeHandler } from './routes/judge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');

const loadEnvFile = (filename: string, override = false) => {
  const result = loadEnv({ path: path.join(workspaceRoot, filename), override });
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
};

if (process.env.NODE_ENV !== 'test') {
  loadEnvFile('.env');
  loadEnvFile('.env.local', true);
}

const config = loadConfig();
const openai = new OpenAIClient(config);
const qdrant = new QdrantClient(config);
const llamaParse = new LlamaParseClient(config);

const app = express();

const parseAllowedOrigins = (value: string | undefined) =>
  value
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

const parsedOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS);
const allowAnyOrigin = parsedOrigins.includes('*');
const defaultLocalOrigins = [
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5173',
];
const configuredOrigins = parsedOrigins.filter((origin) => origin !== '*');
const allowedOrigins = allowAnyOrigin
  ? []
  : Array.from(
      new Set([
        ...(configuredOrigins.length > 0 ? configuredOrigins : defaultLocalOrigins),
        ...defaultLocalOrigins,
      ])
    );

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const requestHeaders = req.headers['access-control-request-headers'];

  if (allowAnyOrigin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (origin) {
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(403).end();
    } else {
      res.status(403).json({ error: 'Origin not allowed.' });
    }
    return;
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    typeof requestHeaders === 'string' && requestHeaders.trim()
      ? requestHeaders
      : 'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

app.use(express.json({ limit: '16mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/chunks', createEmbeddingsHandler(openai, qdrant));
app.post('/api/search', createSearchHandler(openai, qdrant));
app.post('/api/answer', createAnswerHandler(openai, qdrant));
app.post('/api/parse', createParseHandler(llamaParse));
app.post('/api/judge', createJudgeHandler(openai));

const PORT = process.env.PORT ? Number(process.env.PORT) : 7070;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[backend] listening on http://127.0.0.1:${PORT}`);
});
