import { Router, type Request, type Response } from 'express';
import * as c from '@rag-eval/contracts';
import type { Datasets } from '../db/datasets.js';
import type { Indexes } from '../db/indexes.js';
import type { Pipelines } from '../db/pipelines.js';
import { parseTaskCsv } from '../ingestion/taskCsv.js';
import { mediaType } from '../ingestion/blobs.js';
import { validatePipelineCapabilities } from '../providers/registry.js';
import { requestKey, checkParser } from './uploads.js';
import { ApiError } from '../errors.js';

export class InputError extends ApiError {
  constructor(readonly fields: { path: string; message: string }[]) {
    super(400, 'invalid_input', 'Invalid request fields.');
  }
}
export function parse<T>(schema: c.z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new InputError(
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.code === 'unrecognized_keys' ? 'Unknown field.' : i.message,
      })),
    );
  return result.data;
}
export function expected(req: Request) {
  const header = req.get('If-Match');
  if (!header)
    throw new ApiError(
      428,
      'precondition_required',
      'Supply the current revision in If-Match.',
    );
  if (!/^"[1-9]\d*"$/.test(header))
    throw new ApiError(
      400,
      'invalid_input',
      'Expected a quoted numeric revision.',
    );
  return parse(c.revision, Number(header.slice(1, -1)));
}
function send(res: Response, resource: c.Summary, status = 200) {
  res.set('ETag', `"${resource.revision}"`).status(status).json(resource);
}
export function checkProfiles(
  config: c.PipelineConfig,
  capabilities: c.Capabilities,
) {
  validatePipelineCapabilities(config, capabilities);
}

export function definitionsRouter(
  datasets: Datasets,
  pipelines: Pipelines,
  capabilities: c.Capabilities,
  indexes?: Indexes,
) {
  const router = Router();
  for (const param of ['id', 'taskId', 'docId'])
    router.param(param, (_req, _res, next, value) => {
      parse(c.id, value);
      next();
    });
  for (const [kind, repo] of [
    ['datasets', datasets],
    ['pipelines', pipelines],
  ] as const) {
    const path = `/${kind}`;
    router.get(path, (req, res) => {
      const { limit, cursor } = parse(c.listQuery, req.query);
      res.json(repo.list(limit, cursor));
    });
    router.get(`${path}/:id`, (req, res) =>
      send(res, repo.get(parse(c.id, req.params.id))),
    );
    router.delete(`${path}/:id`, (req, res) => {
      repo.archive(parse(c.id, req.params.id), expected(req));
      res.status(204).end();
    });
    router.get(`${path}/:id/revisions`, (req, res) => {
      const { limit, cursor } = parse(c.revisionQuery, req.query);
      res.json(repo.revisions(parse(c.id, req.params.id), limit, cursor));
    });
    router.get(`${path}/:id/revisions/:revision`, (req, res) =>
      send(
        res,
        repo.get(
          parse(c.id, req.params.id),
          parse(c.revision, Number(req.params.revision)),
        ),
      ),
    );
  }
  router.post('/datasets', (req, res) =>
    send(res, datasets.create(parse(c.named, req.body).name), 201),
  );
  router.post('/datasets/sample', (req, res) => {
    parse(c.empty, req.body ?? {});
    const { created, value } = datasets.sample();
    send(res, value, created ? 201 : 200);
  });
  router.patch('/datasets/:id', (req, res) =>
    send(
      res,
      datasets.rename(
        req.params.id,
        expected(req),
        parse(c.named, req.body).name,
      ),
    ),
  );
  router.get('/datasets/:id/tasks', (req, res) => {
    const { limit, cursor } = parse(c.listQuery, req.query);
    res.json(datasets.listTasks(req.params.id, limit, cursor));
  });
  router.post('/datasets/:id/tasks', (req, res) =>
    send(
      res,
      datasets.addTask(
        req.params.id,
        expected(req),
        parse(c.taskInput, req.body),
      ),
      201,
    ),
  );
  router.patch('/datasets/:id/tasks/:taskId', (req, res) =>
    send(
      res,
      datasets.editTask(
        req.params.id,
        expected(req),
        req.params.taskId,
        parse(c.taskPatch, req.body),
      ),
    ),
  );
  router.delete('/datasets/:id/tasks/:taskId', (req, res) =>
    send(
      res,
      datasets.editTask(req.params.id, expected(req), req.params.taskId),
    ),
  );
  router.put('/tasks/:id/qrels', (req, res) =>
    send(
      res,
      datasets.editTask(
        datasets.datasetForTask(req.params.id),
        expected(req),
        req.params.id,
        parse(c.replaceLabels, req.body),
      ),
    ),
  );
  router.post('/datasets/:id/task-imports', (req, res) => {
    const revision = expected(req);
    const input = parse(c.csvRequest, req.body);
    const head = datasets.head(req.params.id);
    if (head.archived)
      throw new ApiError(409, 'archived', 'This resource has been archived.');
    if (head.revision !== revision)
      throw new ApiError(
        409,
        'stale_revision',
        'Dataset changed. Preview the CSV again.',
      );
    let rows: ReturnType<typeof parseTaskCsv>;
    try {
      rows = parseTaskCsv(input.csv);
    } catch (err) {
      throw new ApiError(
        400,
        'invalid_input',
        err instanceof Error ? err.message : 'Invalid CSV file.',
      );
    }
    const preview = parse(c.csvPreview, rows);
    if (input.mode === 'preview') {
      res.json(preview);
      return;
    }
    send(
      res,
      datasets.importTasks(
        req.params.id,
        revision,
        preview.tasks.map((t) =>
          c.taskInput.parse({ ...t, provenance: 'CSV import' }),
        ),
      ),
      201,
    );
  });
  router.post('/documents/:id/parses', (req, res) => {
    const { parser } = parse(c.parseRequest, req.body);
    const job = datasets.requestParse(
      req.params.id,
      expected(req),
      parser,
      requestKey(req),
      (name, mime) =>
        checkParser(
          parser,
          mediaType(name, mime || 'application/octet-stream'),
          capabilities.cloudParser,
        ),
    );
    res.location(`/api/v1/jobs/${job.id}`).status(202).json(job);
  });
  router.post('/document-versions/:id/chunks', (req, res) => {
    const job = datasets.jobs.requestChunks(
      req.params.id,
      parse(c.chunkOptions, req.body),
      requestKey(req),
    );
    res.location(`/api/v1/jobs/${job.id}`).status(202).json(job);
  });
  router.get('/jobs/:id/chunks', (req, res) => {
    const { after } = parse(
      c.z.strictObject({
        after: c.z.coerce.number().int().min(-1).default(-1),
      }),
      req.query,
    );
    res.json(datasets.jobs.chunks(req.params.id, after));
  });
  router.get('/jobs/:id', (req, res) =>
    res.json(datasets.jobs.get(req.params.id)),
  );
  router.get('/jobs/:id/events', (req, res) => {
    const { after } = parse(
      c.z.strictObject({
        after: c.z.coerce.number().int().nonnegative().default(0),
      }),
      req.query,
    );
    res.json(datasets.jobs.events(req.params.id, after));
  });
  router.post('/jobs/:id/cancel', (req, res) => {
    parse(c.empty, req.body ?? {});
    res.json(datasets.jobs.cancel(req.params.id));
  });
  router.post('/jobs/:id/retry', (req, res) => {
    parse(c.empty, req.body ?? {});
    const previous = datasets.jobs.get(req.params.id);
    if (previous.parser === 'llama-parse' && !capabilities.cloudParser)
      throw new ApiError(
        422,
        'missing_capability',
        'Configure LlamaParse to use the cloud parser.',
      );
    if (previous.kind === 'index' && previous.generationId && indexes) {
      const gen = indexes.get(previous.generationId);
      if (gen.mode === 'dense' || gen.mode === 'hybrid') {
        if (!capabilities.denseStore)
          throw new ApiError(
            422,
            'missing_capability',
            'Configure Qdrant before retrying a dense or hybrid index job.',
          );
        if (
          !capabilities.profiles.some(
            (p) =>
              p.role === 'embedding' &&
              (!gen.embeddingModel || p.model === gen.embeddingModel),
          )
        )
          throw new ApiError(
            422,
            'missing_capability',
            'The required embedding profile is unavailable.',
          );
      }
    }
    const job = datasets.jobs.retry(req.params.id);
    res.location(`/api/v1/jobs/${job.id}`).status(202).json(job);
  });
  router.delete('/datasets/:id/documents/:docId', (req, res) =>
    send(
      res,
      datasets.removeDocument(req.params.id, expected(req), req.params.docId),
    ),
  );
  router.get('/datasets/:id/documents/:docId', (req, res) => {
    const { revision, preview } = parse(
      c.z.strictObject({
        preview: c.z.literal('true').optional(),
        revision: c.z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const doc = datasets.getDocument(req.params.id, req.params.docId, revision);
    res.json(preview ? { ...doc, content: doc.content?.slice(0, 4000) } : doc);
  });
  router.post('/pipelines', (req, res) => {
    const input = parse(c.pipelineInput, req.body);
    const defaultChat = capabilities.profiles.find(
      (p) =>
        p.role === 'chat' &&
        (!input.config.llm.model || p.model === input.config.llm.model),
    );
    if (
      defaultChat &&
      !defaultChat.options.includes('temperature') &&
      req.body?.config?.llm?.temperature === undefined
    )
      input.config.llm.temperature = 1;
    checkProfiles(input.config, capabilities);
    send(res, pipelines.create(input), 201);
  });
  router.patch('/pipelines/:id', (req, res) => {
    const input = parse(c.pipelinePatch, req.body);
    if (input.config) checkProfiles(input.config, capabilities);
    send(res, pipelines.edit(req.params.id, expected(req), input));
  });
  router.post('/pipelines/:id/copies', (req, res) => {
    const source = pipelines.get(req.params.id);
    checkProfiles(source.config, capabilities);
    send(
      res,
      pipelines.copy(
        req.params.id,
        expected(req),
        parse(c.named.partial(), req.body ?? {}).name,
      ),
      201,
    );
  });
  return router;
}
