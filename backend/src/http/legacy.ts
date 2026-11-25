import { Router, type RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import { ApiError } from '../errors.js';
import {
  validateGenerationParams,
  type ProviderRegistry,
} from '../providers/registry.js';
import type { QdrantStore } from '../retrieval/qdrant.js';
import { createAnswerHandler } from '../routes/answer.js';
import { createEmbeddingsHandler } from '../routes/embeddings.js';
import { createJudgeHandler } from '../routes/judge.js';
import { createSearchHandler } from '../routes/search.js';

// Temporary thin adapters for ExperimentsPage until Phase 6/7 removes browser orchestration.
export function legacyRouter(
  config: Config,
  providers: ProviderRegistry,
  qdrant?: QdrantStore,
) {
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

  const requireQdrant = () => {
    if (!qdrant) {
      throw new ApiError(
        422,
        'missing_capability',
        'Configure QDRANT_URL before running legacy vector routes.',
      );
    }
    return qdrant;
  };

  const embedAdapter = {
    embed: async (inputs: string[], model?: string) => {
      const { profile, provider } = providers.resolveEmbedding(model);
      const res = await provider.embed({
        model: profile.model,
        inputs,
        expectedDimensions: profile.expectedDimensions,
      });
      return { vectors: res.vectors };
    },
  };

  const chatAdapter = (role: 'chat' | 'judge') => ({
    chat: async (
      messages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
      }>,
      options: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        responseFormat?:
          | { type: 'json_object' }
          | {
              type: 'json_schema';
              name: string;
              schema: Record<string, unknown>;
            };
      } = {},
    ) => {
      const { profile, provider } = providers.resolveChat(role, options.model);
      const effectiveTemp =
        role === 'judge' && !profile.capabilities.temperature
          ? undefined
          : options.temperature;
      const res = await provider.chat({
        model: profile.model,
        messages,
        temperature: effectiveTemp,
        maxTokens: options.maxTokens,
        responseFormat: options.responseFormat,
      });
      return {
        content: res.content,
        usage: res.usage
          ? {
              promptTokens: res.usage.inputTokens,
              completionTokens: res.usage.outputTokens,
              totalTokens: res.usage.totalTokens,
            }
          : undefined,
      };
    },
  });

  const handlers: Record<
    'chunks' | 'search' | 'answer' | 'judge',
    RequestHandler
  > = {
    chunks: (req, res, next) =>
      createEmbeddingsHandler(embedAdapter, requireQdrant())(req, res).catch(
        next,
      ),
    search: (req, res, next) =>
      createSearchHandler(embedAdapter, requireQdrant())(req, res).catch(next),
    answer: (req, res, next) =>
      createAnswerHandler(
        {
          embed: embedAdapter.embed,
          resolveChat: (model) => providers.resolveChat('chat', model),
        },
        requireQdrant(),
      )(req, res).catch(next),
    judge: (req, res, next) =>
      createJudgeHandler({
        chatCompletion: chatAdapter('judge').chat,
      })(req, res).catch(next),
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
          return selected;
        };
        if (operation !== 'judge') {
          if (!config.capabilities.denseStore) throw unavailable();
          resolve('embedding', 'embeddingModel');
        }
        if (operation === 'answer') {
          const chatProfile = resolve('chat', 'model');
          validateGenerationParams(chatProfile, {
            temperature:
              typeof req.body.temperature === 'number'
                ? req.body.temperature
                : undefined,
            maxTokens:
              typeof req.body.maxTokens === 'number'
                ? req.body.maxTokens
                : undefined,
          });
        }
        if (operation === 'judge') resolve('judge', 'model');
        next();
      },
      handlers[operation],
    );
  }
  return router;
}
