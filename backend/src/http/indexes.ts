import { Router } from 'express';
import * as c from '@rag-eval/contracts';
import type { Config } from '../config/env.js';
import type { Indexes } from '../db/indexes.js';
import { ApiError } from '../errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RetrievalService } from '../retrieval/service.js';
import { parse } from './routes.js';
import { requestKey } from './uploads.js';

export function indexesRouter(
  indexes: Indexes,
  retrieval: RetrievalService,
  providers: ProviderRegistry,
  config: Config,
) {
  const router = Router();
  router.param('id', (_req, _res, next, value) => {
    parse(c.id, value);
    next();
  });

  router.get('/indexes', (req, res) => {
    const { limit, cursor, datasetId } = parse(
      c.listQuery.extend({ datasetId: c.id.optional() }),
      req.query,
    );
    res.json(indexes.list(limit, cursor, datasetId));
  });

  router.post('/indexes', (req, res) => {
    const input = parse(c.createIndexRequest, req.body);
    let embedding: {
      provider: 'openai' | 'openai-compatible';
      model: string;
      expectedDimensions?: number;
    } | null = null;

    if (input.mode === 'dense' || input.mode === 'hybrid') {
      if (!config.capabilities.denseStore) {
        throw new ApiError(
          422,
          'missing_capability',
          `Index mode "${input.mode}" requires Qdrant (QDRANT_URL).`,
        );
      }
      const profile = providers.findProfile('embedding', input.embeddingModel);
      if (
        !profile?.capabilities.embeddings ||
        (profile.provider !== 'openai' &&
          profile.provider !== 'openai-compatible')
      ) {
        throw new ApiError(
          422,
          'missing_capability',
          `Index mode "${input.mode}" requires a configured embedding profile.`,
        );
      }
      embedding = {
        provider: profile.provider,
        model: profile.model,
        expectedDimensions: profile.expectedDimensions,
      };
    }

    const result = indexes.planOrReuse(input, embedding, requestKey(req));
    if (result.reused) {
      res.status(200).json(c.createIndexResult.parse(result));
      return;
    }
    if (result.jobId) res.location(`/api/v1/jobs/${result.jobId}`);
    res.status(202).json(c.createIndexResult.parse(result));
  });

  router.get('/indexes/:id', (req, res) => {
    res.json(indexes.get(req.params.id));
  });

  router.get('/indexes/:id/chunks', (req, res) => {
    const { after, limit } = parse(
      c.z.strictObject({
        after: c.z.coerce.number().int().min(-1).default(-1),
        limit: c.z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    res.json(indexes.chunks(req.params.id, after, limit));
  });

  router.post('/indexes/:id/search', async (req, res) => {
    const input = parse(c.indexSearchRequest, req.body);
    const trace = await retrieval.search(req.params.id, input);
    res.json(trace);
  });

  router.post('/indexes/:id/answer', async (req, res) => {
    const input = parse(c.indexAnswerRequest, req.body);
    const result = await retrieval.answer(req.params.id, input);
    res.json(result);
  });

  return router;
}
