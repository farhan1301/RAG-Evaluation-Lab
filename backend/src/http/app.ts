import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Logger } from 'pino';
import type { Config } from '../config/env.js';
import type { Datasets } from '../db/datasets.js';
import { Indexes } from '../db/indexes.js';
import type { Pipelines } from '../db/pipelines.js';
import { Runs } from '../db/runs.js';
import { ApiError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import { QdrantStore } from '../retrieval/qdrant.js';
import { RetrievalService } from '../retrieval/service.js';
import { experimentsRouter } from './experiments.js';
import { indexesRouter } from './indexes.js';
import { legacyRouter } from './legacy.js';
import { definitionsRouter, InputError } from './routes.js';
import { uploadsRouter } from './uploads.js';

interface Dependencies {
  config: Config;
  datasets: Datasets;
  pipelines: Pipelines;
  indexes?: Indexes;
  runs?: Runs;
  providers?: ProviderRegistry;
  qdrant?: QdrantStore;
  retrieval?: RetrievalService;
  logger: Logger;
  ready: () => boolean | Promise<boolean>;
  now?: () => number;
}
export function createApp({
  config,
  datasets,
  pipelines,
  indexes: providedIndexes,
  runs: providedRuns,
  providers: providedProviders,
  qdrant: providedQdrant,
  retrieval: providedRetrieval,
  logger,
  ready,
  now = Date.now,
}: Dependencies) {
  const indexes =
    providedIndexes ?? new Indexes(datasets.database, datasets.jobs, now);
  const runs =
    providedRuns ??
    new Runs(
      datasets.database,
      datasets,
      pipelines,
      indexes,
      datasets.jobs,
      now,
    );
  const providers = providedProviders ?? new ProviderRegistry(config);
  const qdrant =
    providedQdrant ??
    (config.qdrant
      ? new QdrantStore({
          url: config.qdrant.url,
          apiKey: config.qdrant.apiKey,
          collectionPrefix: config.qdrant.collectionPrefix,
          timeoutMs: config.env.PROVIDER_TIMEOUT_MS,
        })
      : undefined);
  const retrieval =
    providedRetrieval ??
    new RetrievalService({ indexes, providers, qdrant, now });
  const app = express();
  const { env } = config;
  const clients = new Map<string, number>();
  let windowEnd = 0;
  app.disable('x-powered-by');
  app.disable('etag');
  if (env.TRUSTED_PROXIES.length) app.set('trust proxy', env.TRUSTED_PROXIES);
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.set({ 'X-Request-ID': requestId, 'Cache-Control': 'no-store' });
    const start = now();
    const span = trace
      .getTracer('rag-eval.http')
      .startSpan(`HTTP ${req.method}`);
    res.once('close', () => {
      const status = res.statusCode;
      logger.info(
        {
          requestId,
          method: req.method,
          status,
          code: res.locals.code,
          durationMs: now() - start,
        },
        'request',
      );
      span.setAttribute('http.response.status_code', status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
    const host = req.host;
    if (!env.TRUSTED_HOSTS.includes(req.hostname?.toLowerCase() ?? ''))
      throw new ApiError(403, 'origin_denied', 'Host is not allowed.');
    const origin = req.get('origin');
    res.vary('Origin');
    if (origin) {
      if (
        origin !== `${req.protocol}://${host}` &&
        !env.CORS_ORIGINS.includes(origin)
      )
        throw new ApiError(403, 'origin_denied', 'Origin is not allowed.');
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, If-Match, Idempotency-Key',
        'Access-Control-Expose-Headers':
          'ETag, Location, X-Request-ID, Retry-After',
      });
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.path.toLowerCase().startsWith('/api/')) {
      if (start >= windowEnd) {
        clients.clear();
        windowEnd = start + env.RATE_WINDOW_MS;
      }
      const client = req.ip ?? 'local',
        count = clients.get(client) ?? 0;
      if (count >= env.RATE_LIMIT) {
        res.set('Retry-After', String(Math.ceil((windowEnd - start) / 1000)));
        throw new ApiError(
          429,
          'throttled',
          'Request limit reached. Try again later.',
        );
      }
      clients.set(client, count + 1);
    }
    next();
  });
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    const available = await Promise.resolve()
      .then(ready)
      .catch(() => false);
    if (!available)
      throw new ApiError(503, 'not_ready', 'Service is not ready.');
    res.json({ status: 'ok' });
  });
  app.get('/api/v1/capabilities', (_req, res) =>
    res.json({ ...config.capabilities, workerOnline: datasets.jobs.online() }),
  );
  app.use('/api/v1', uploadsRouter(datasets, config));
  const regular = express.json({ limit: env.JSON_LIMIT_BYTES });
  const documents = express.json({ limit: env.DOCUMENT_LIMIT_BYTES });
  app.use((req, res, next) => {
    if (
      ['POST', 'PUT', 'PATCH'].includes(req.method) &&
      (req.get('transfer-encoding') || Number(req.get('content-length')) > 0) &&
      !req.is('application/json')
    )
      throw new ApiError(
        415,
        'unsupported_media',
        'Expected application/json.',
      );
    const large =
      req.method === 'POST' && ['/api/chunks', '/api/judge'].includes(req.path);
    (large ? documents : regular)(req, res, next);
  });
  app.use(
    '/api/v1',
    definitionsRouter(datasets, pipelines, config.capabilities, indexes, runs),
  );
  app.use('/api/v1', indexesRouter(indexes, retrieval, providers, config));
  app.use('/api/v1', experimentsRouter(runs, config));
  app.use('/api', legacyRouter(config, providers, qdrant));
  app.use(() => {
    throw new ApiError(404, 'not_found', 'Route not found.');
  });
  const handleError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    let problem = new ApiError(
      500,
      'internal_error',
      'Request could not be completed.',
    );
    if (err instanceof ApiError) problem = err;
    else if (err instanceof ProviderError) problem = err.toApiError();
    else if (err.type === 'entity.too.large')
      problem = new ApiError(413, 'size_limit', 'Request body is too large.');
    else if (err.status === 415)
      problem = new ApiError(
        415,
        'unsupported_media',
        'Unsupported request encoding.',
      );
    else if (err.status === 400)
      problem = new ApiError(400, 'invalid_input', 'Malformed request.');
    res.locals.code = problem.code;
    res.status(problem.status).json({
      error: {
        code: problem.code,
        message: problem.message,
        requestId: res.locals.requestId,
        ...(problem instanceof InputError && { fields: problem.fields }),
      },
    });
  };
  app.use(handleError);
  return app;
}
