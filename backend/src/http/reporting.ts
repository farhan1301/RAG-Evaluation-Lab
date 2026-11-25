import { Router } from 'express';
import * as c from '@rag-eval/contracts';
import type { Config } from '../config/env.js';
import type { Datasets } from '../db/datasets.js';
import type { Runs } from '../db/runs.js';
import { compareRunPipelines } from '../reporting/compare.js';
import { buildDocumentationPayload } from '../reporting/documentation.js';
import {
  buildRunExportJson,
  formatRunExportMarkdown,
} from '../reporting/export.js';
import { parse } from './routes.js';

export function reportingRouter(
  runs: Runs,
  datasets: Datasets,
  config: Config,
  now = Date.now,
) {
  const router = Router();
  router.param('id', (_req, _res, next, value) => {
    parse(c.id, value);
    next();
  });

  router.get('/comparisons', (req, res) => {
    const query = parse(c.comparisonQuery, req.query);
    res.json(compareRunPipelines(runs, query));
  });

  router.get('/runs/:id/export', (req, res) => {
    const query = parse(c.runExportQuery, req.query);
    const payload = buildRunExportJson(runs, req.params.id, query, now);
    const shortId = req.params.id.slice(0, 8);
    if (query.format === 'json') {
      res.set(
        'Content-Disposition',
        `attachment; filename="run-${shortId}-report.json"`,
      );
      res.json(payload);
      return;
    }
    res.set({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="run-${shortId}-report.md"`,
    });
    res.send(formatRunExportMarkdown(payload));
  });

  router.get('/documentation', (_req, res) => {
    res.json(buildDocumentationPayload(config, datasets.jobs.online()));
  });

  return router;
}
