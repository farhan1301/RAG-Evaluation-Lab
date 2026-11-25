import { Router, type RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import { OpenAIClient } from '../lib/openaiClient.js';
import { QdrantClient } from '../lib/qdrantClient.js';
import { createAnswerHandler } from '../routes/answer.js';
import { createEmbeddingsHandler } from '../routes/embeddings.js';
import { createSearchHandler } from '../routes/search.js';
import { createJudgeHandler } from '../routes/judge.js';
import { ApiError } from '../errors.js';

// Temporary internal endpoints for ExperimentsPage. Remove with browser orchestration.
export function legacyRouter(config: Config) {
  const router = Router();
  router.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (
        res.statusCode < 400 ||
        (body &&
          typeof body === 'object' &&
          'error' in body &&
          typeof body.error === 'object')
      )
        return json(body);
      const upstream = res.statusCode >= 500;
      res.locals.code = upstream ? 'upstream_failure' : 'invalid_input';
      return json({
        error: {
          code: res.locals.code,
          requestId: res.locals.requestId,
          message: upstream
            ? 'The provider request failed.'
            : 'Invalid runner request.',
        },
      });
    };
    next();
  });
  const openai = new OpenAIClient(config.legacy),
    qdrant = new QdrantClient(config.legacy);
  const handlers: Record<
    'chunks' | 'search' | 'answer' | 'judge',
    RequestHandler
  > = {
    chunks: createEmbeddingsHandler(openai, qdrant),
    search: createSearchHandler(openai, qdrant),
    answer: createAnswerHandler(openai, qdrant),
    judge: createJudgeHandler(openai),
  };
  for (const operation of Object.keys(handlers) as (keyof typeof handlers)[]) {
    router.post(
      `/${operation}`,
      (req, _res, next) => {
        if (!req.body || typeof req.body !== 'object')
          throw new ApiError(400, 'invalid_input', 'Expected a JSON object.');
        const unavailable = () =>
          new ApiError(
            422,
            'missing_capability',
            `Configure the required server profile for ${operation}.`,
          );
        const resolve = (role: 'embedding' | 'judge' | 'chat', key: string) => {
          const selected = config.capabilities.profiles.find(
            (p) =>
              p.role === role && (!req.body[key] || p.model === req.body[key]),
          );
          if (!selected) throw unavailable();
          req.body[key] = selected.model;
        };
        if (operation !== 'judge') {
          if (!config.capabilities.denseStore) throw unavailable();
          resolve('embedding', 'embeddingModel');
        }
        if (operation === 'answer') resolve('chat', 'model');
        if (operation === 'judge') resolve('judge', 'model');
        next();
      },
      handlers[operation],
    );
  }
  return router;
}
