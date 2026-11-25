import { Router, type Request, type Response } from 'express';
import * as c from '@rag-eval/contracts';
import type { Datasets } from '../db/datasets.js';
import type { Pipelines } from '../db/pipelines.js';
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
function expected(req: Request) {
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
  const chat = capabilities.profiles.find(
    (p) =>
      p.role === 'chat' && (!config.llm.model || p.model === config.llm.model),
  );
  if (
    chat &&
    !chat.options.includes('temperature') &&
    config.llm.temperature !== 1
  )
    throw new ApiError(
      422,
      'missing_capability',
      'The selected answer profile requires the default temperature of 1.',
    );
  for (const [role, model] of [
    ['embedding', config.embedding.model],
    ['chat', config.llm.model],
    ['judge', config.judge.model],
  ]) {
    if (
      model &&
      !capabilities.profiles.some((p) => p.role === role && p.model === model)
    )
      throw new ApiError(
        422,
        'missing_capability',
        `The selected ${role} profile is unavailable.`,
      );
  }
}

export function definitionsRouter(
  datasets: Datasets,
  pipelines: Pipelines,
  capabilities: c.Capabilities,
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
    const { tasks } = parse(c.taskImport, req.body);
    send(
      res,
      datasets.importTasks(
        req.params.id,
        revision,
        tasks.map((t) => c.taskInput.parse(t)),
      ),
      201,
    );
  });
  router.post('/datasets/:id/documents', (req, res) =>
    send(
      res,
      datasets.addDocument(
        req.params.id,
        expected(req),
        parse(c.documentInput, req.body),
      ),
      201,
    ),
  );
  router.delete('/datasets/:id/documents/:docId', (req, res) =>
    send(
      res,
      datasets.removeDocument(req.params.id, expected(req), req.params.docId),
    ),
  );
  router.get('/datasets/:id/documents/:docId', (req, res) => {
    const { revision } = parse(
      c.z.strictObject({
        revision: c.z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    res.json(datasets.getDocument(req.params.id, req.params.docId, revision));
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
