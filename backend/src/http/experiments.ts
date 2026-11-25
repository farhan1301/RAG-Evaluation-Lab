import { Router } from 'express';
import * as c from '@rag-eval/contracts';
import type { Config } from '../config/env.js';
import type { Runs } from '../db/runs.js';
import { expected, parse } from './routes.js';
import { requestKey } from './uploads.js';

export function experimentsRouter(runs: Runs, config: Config) {
  const router = Router();
  for (const param of ['id', 'taskId']) {
    router.param(param, (_req, _res, next, value) => {
      parse(c.id, value);
      next();
    });
  }

  router.get('/experiments', (req, res) => {
    const { limit, cursor } = parse(c.listQuery, req.query);
    res.json(runs.listExperiments(limit, cursor));
  });

  router.post('/experiments', (req, res) => {
    const input = parse(c.experimentInput, req.body);
    const created = runs.createExperiment(input);
    res.set('ETag', `"${created.revision}"`).status(201).json(created);
  });

  router.get('/experiments/:id', (req, res) => {
    const found = runs.getExperiment(req.params.id);
    res.set('ETag', `"${found.revision}"`).json(found);
  });

  router.patch('/experiments/:id', (req, res) => {
    const patch = parse(c.experimentPatch, req.body);
    const updated = runs.editExperiment(req.params.id, expected(req), patch);
    res.set('ETag', `"${updated.revision}"`).json(updated);
  });

  router.delete('/experiments/:id', (req, res) => {
    runs.archiveExperiment(req.params.id, expected(req));
    res.status(204).end();
  });

  router.post('/experiments/:id/runs', (req, res) => {
    const body = parse(c.createRunRequest, req.body ?? {});
    const result = runs.createRun(req.params.id, body, {
      capabilities: config.capabilities,
      pricing: config.pricing,
      budgets: config.budgets,
      idempotencyKey: requestKey(req),
    });
    res.location(`/api/v1/jobs/${result.job.id}`);
    res.status(result.reused ? 200 : 202).json(c.createRunResult.parse(result));
  });

  router.get('/runs', (req, res) => {
    const { limit, cursor, experimentId } = parse(c.runListQuery, req.query);
    res.json(runs.listRuns(limit, cursor, experimentId));
  });

  router.get('/runs/:id', (req, res) => {
    res.json(runs.getRun(req.params.id));
  });

  router.get('/runs/:id/tasks', (req, res) => {
    const { limit, cursor, pipelineId } = parse(c.runTasksQuery, req.query);
    res.json(runs.listRunTasks(req.params.id, limit, cursor ?? 0, pipelineId));
  });

  router.get('/runs/:id/tasks/:taskId', (req, res) => {
    res.json({ items: runs.getRunTask(req.params.id, req.params.taskId) });
  });

  return router;
}
