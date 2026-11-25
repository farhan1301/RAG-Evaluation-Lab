import { Router } from 'express';
import * as c from '@rag-eval/contracts';
import type { Config } from '../config/env.js';
import type { Generations } from '../db/generations.js';
import { expected, parse } from './routes.js';
import { requestKey } from './uploads.js';

export function generationsRouter(generations: Generations, config: Config) {
  const router = Router();
  for (const param of ['id', 'proposalId']) {
    router.param(param, (_req, _res, next, value) => {
      parse(c.id, value);
      next();
    });
  }

  router.post('/datasets/:id/generations', (req, res) => {
    const body = parse(c.createGenerationRequest, req.body ?? {});
    const result = generations.createBatch(req.params.id, body, {
      capabilities: config.capabilities,
      providerProfiles: config.providerProfiles,
      idempotencyKey: requestKey(req),
    });
    res.location(`/api/v1/jobs/${result.job.id}`);
    res
      .status(result.reused ? 200 : 202)
      .json(c.createGenerationResult.parse(result));
  });

  router.get('/datasets/:id/generations', (req, res) => {
    const { limit, cursor } = parse(c.generationListQuery, req.query);
    res.json(generations.listBatches(req.params.id, limit, cursor));
  });

  router.get('/generations/:id', (req, res) => {
    res.json(generations.getBatch(req.params.id));
  });

  router.get('/datasets/:id/proposals', (req, res) => {
    const { limit, cursor, batchId, status } = parse(
      c.proposalListQuery,
      req.query,
    );
    res.json(
      generations.listProposals(req.params.id, limit, cursor, {
        batchId,
        status,
      }),
    );
  });

  router.patch('/datasets/:id/proposals/:proposalId', (req, res) => {
    const patch = parse(c.reviewProposalPatch, req.body);
    res.json(
      generations.reviewProposal(req.params.id, req.params.proposalId, patch),
    );
  });

  router.post('/datasets/:id/proposals/promote', (req, res) => {
    const body = parse(c.promoteProposalsRequest, req.body);
    const promoted = generations.promoteProposals(
      req.params.id,
      expected(req),
      body,
    );
    res
      .set('ETag', `"${promoted.dataset.revision}"`)
      .status(201)
      .json(promoted);
  });

  return router;
}
