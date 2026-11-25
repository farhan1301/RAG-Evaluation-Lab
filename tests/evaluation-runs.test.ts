import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { openDatabase, ready } from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Indexes } from '../backend/src/db/indexes';
import { Jobs } from '../backend/src/db/jobs';
import { Pipelines } from '../backend/src/db/pipelines';
import { Runs } from '../backend/src/db/runs';
import { EvaluationRunner } from '../backend/src/evaluation/runner';
import { createApp } from '../backend/src/http/app';
import { CloudParser } from '../backend/src/ingestion/cloud';
import { runOne } from '../backend/src/jobs/run';
import { createLogger } from '../backend/src/lib/logger';
import { ProviderRegistry } from '../backend/src/providers/registry';
import { ApiError } from '../backend/src/errors';
import { IndexBuilder } from '../backend/src/retrieval/indexer';
import {
  QdrantStore,
  type QdrantClientLike,
} from '../backend/src/retrieval/qdrant';
import { RetrievalService } from '../backend/src/retrieval/service';
import { send } from './inProcess';

function openaiChatResponse(
  content: string,
  model = 'fixture-chat',
  usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-chat-fixture',
      },
    },
  );
}

describe('server-side experiments, durable runs, checkpointing, and HTTP endpoints', () => {
  let dir: string;
  let dbPath: string;
  let db: ReturnType<typeof openDatabase>;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rag-eval-phase6-'));
    dbPath = join(dir, 'workspace.db');
    db = openDatabase(dbPath);
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setupStack(
    env: NodeJS.ProcessEnv = {},
    transports: { openai?: typeof fetch } = {},
  ) {
    const config = readConfig({
      BLOB_DIRECTORY: join(dir, 'blobs'),
      ...env,
    });
    const jobs = new Jobs(db, () => clock, 5000);
    const datasets = new Datasets(db, jobs);
    const pipelines = new Pipelines(db);
    const indexes = new Indexes(db, jobs, () => clock);
    const runs = new Runs(db, datasets, pipelines, indexes, jobs, () => clock);
    const providers = new ProviderRegistry(config, transports);
    const indexBuilder = new IndexBuilder({
      indexes,
      providers,
      now: () => clock,
    });
    const retrieval = new RetrievalService({
      indexes,
      providers,
      now: () => clock,
    });
    const evaluationRunner = new EvaluationRunner({
      runs,
      indexes,
      indexBuilder,
      retrieval,
      providers,
      now: () => clock,
      retryDelayMs: 1,
    });
    const app = createApp({
      config,
      datasets,
      pipelines,
      indexes,
      runs,
      providers,
      retrieval,
      logger: createLogger({ write: () => {} }),
      ready: () => true,
      now: () => clock,
    });
    return {
      config,
      jobs,
      datasets,
      pipelines,
      indexes,
      runs,
      providers,
      indexBuilder,
      retrieval,
      evaluationRunner,
      app,
    };
  }

  it('upgrades a Phase 5 (version 3) database cleanly and enforces null-observation and unknown-cost DB invariants', () => {
    const oldPath = join(dir, 'v3.db');
    const v3 = openDatabase(oldPath, 3);
    try {
      const ds = new Datasets(v3).sample().value;
      expect(ds.tasks.length).toBe(10);
    } finally {
      v3.close();
    }
    const upgraded = openDatabase(oldPath);
    try {
      expect(ready(upgraded)).toBe(true);
      const ds = new Datasets(upgraded).list(10).items;
      expect(ds).toHaveLength(1);

      // Verify CHECK constraint: non-scored metric observation CANNOT store a numeric value.
      expect(() =>
        upgraded
          .prepare(
            `INSERT INTO metric_observations(
              id, run_id, pipeline_id, task_version_id, run_task_id,
              metric_id, metric_version, cutoff, evaluation_unit, status, value
            ) VALUES ('o1','r','p','tv','rt','faithfulness','v1',0,'answer','judge_malformed',0)`,
          )
          .run(),
      ).toThrow();

      // Verify CHECK constraint: unknown cost_status CANNOT store a numeric cost_usd.
      expect(() =>
        upgraded
          .prepare(
            `INSERT INTO provider_calls(
              id, stage_key, operation, provider, model, attempt_number, is_retry,
              status, latency_ms, usage_status, price_version, cost_status, cost_usd, created_at
            ) VALUES ('c1','sk1','generate','openai','m',1,0,'succeeded',10,'known','v1','unknown',0.01,'2026-01-01T00:00:00Z')`,
          )
          .run(),
      ).toThrow();
    } finally {
      upgraded.close();
    }
  });

  it('runs retrieval-only mode offline with zero credentials, freezes snapshots against subsequent edits, and yields identical deterministic metrics and evidence order across repeated runs', async () => {
    const {
      app,
      jobs,
      datasets,
      pipelines,
      indexes,
      indexBuilder,
      runs,
      evaluationRunner,
    } = setupStack();

    const sample = datasets.sample().value;
    const p1 = pipelines.create({
      name: 'Keyword top-3',
      config: {
        chunking: { strategy: 'character-window', chunkSize: 300, overlap: 20 },
        retriever: { mode: 'keyword', topK: 3, deduplicate: false },
      },
    });
    const p2 = pipelines.create({
      name: 'Keyword top-5',
      config: {
        chunking: { strategy: 'sentence-packed', chunkSize: 300, overlap: 20 },
        retriever: { mode: 'keyword', topK: 5, deduplicate: false },
      },
    });

    const expRes = await send(app, 'POST', '/api/v1/experiments', {
      name: 'Offline retrieval comparison',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id, p2.id],
      mode: 'retrieval_only',
    });
    expect(expRes.status).toBe(201);
    const exp = c.experiment.parse(expRes.body);

    // Enqueue Run 1 with idempotency key
    const run1Res = await send(
      app,
      'POST',
      `/api/v1/experiments/${exp.id}/runs`,
      { cutoffs: [1, 3, 5] },
      { 'idempotency-key': 'run-key-1' },
    );
    expect(run1Res.status).toBe(202);
    const run1Created = c.createRunResult.parse(run1Res.body);
    expect(run1Res.headers.location).toBe(`/api/v1/jobs/${run1Created.job.id}`);

    // Idempotent replay returns same run & job (200)
    const replayRes = await send(
      app,
      'POST',
      `/api/v1/experiments/${exp.id}/runs`,
      { cutoffs: [1, 3, 5] },
      { 'idempotency-key': 'run-key-1' },
    );
    expect(replayRes.status).toBe(200);
    expect(c.createRunResult.parse(replayRes.body)).toMatchObject({
      reused: true,
      run: { id: run1Created.run.id },
      job: { id: run1Created.job.id },
    });

    // Reusing key with different body -> 409 conflict
    const conflictRes = await send(
      app,
      'POST',
      `/api/v1/experiments/${exp.id}/runs`,
      { cutoffs: [1, 5] },
      { 'idempotency-key': 'run-key-1' },
    );
    expect(conflictRes.status).toBe(409);

    // Mutate dataset and pipeline AFTER enqueueing Run 1 to prove snapshot freezing!
    datasets.rename(sample.id, 1, 'Mutated after freeze');
    pipelines.edit(p1.id, 1, {
      name: 'Mutated pipeline',
      config: { ...p1.config, retriever: { ...p1.config.retriever, topK: 1 } },
    });

    // Enqueue Run 2 pinned to dataset revision 1 using frozen pipeline 2 + a copy of original p1
    const p1OrigCopy = pipelines.create({
      name: 'Keyword top-3',
      config: p1.config,
    });
    const exp2 = runs.createExperiment({
      name: 'Repeat fixture',
      datasetId: sample.id,
      baselinePipelineId: p1OrigCopy.id,
      pipelineIds: [p1OrigCopy.id, p2.id],
      mode: 'retrieval_only',
    });
    const run2Created = runs.createRun(
      exp2.id,
      { datasetRevision: 1, cutoffs: [1, 3, 5] },
      {
        capabilities: readConfig({}).capabilities,
        pricing: readConfig({}).pricing,
        budgets: { maxTokens: null, maxCostUsd: null },
      },
    );

    const workerOpts = {
      directory: join(dir, 'blobs'),
      cloud: new CloudParser('', undefined),
      indexes,
      indexBuilder,
      runs,
      evaluationRunner,
    };
    while (await runOne(jobs, workerOpts)) {
      clock += 10;
    }

    const r1 = c.runDetail.parse(
      (await send(app, 'GET', `/api/v1/runs/${run1Created.run.id}`)).body,
    );
    const r2 = c.runDetail.parse(
      (await send(app, 'GET', `/api/v1/runs/${run2Created.run.id}`)).body,
    );

    expect(r1.state).toBe('succeeded');
    expect(r2.state).toBe('succeeded');
    // Snapshot preserved frozen revision 1 and original pipeline name/topK!
    expect(r1.datasetRevision).toBe(1);
    expect(r1.datasetName).toBe('RAG fundamentals');
    expect(r1.pipelines[0]?.pipelineName).toBe('Keyword top-3');
    expect(r1.pipelines[0]?.config.retriever.topK).toBe(3);

    // Run 2 reused already-built index generations!
    expect(r2.pipelines[0]?.indexReused).toBe(true);
    expect(r2.pipelines[1]?.indexReused).toBe(true);

    // Sample has 9 answerable tasks and 1 unanswerable task -> 9 eligible, 1 excluded (unanswerable).
    const r1Hit3 = r1.pipelines[0]?.retrievalMetrics.find(
      (m) => m.metricId === 'hit_at_k' && m.cutoff === 3,
    );
    expect(r1Hit3).toMatchObject({
      eligibleCount: 9,
      totalCount: 10,
      excludedCount: 1,
      exclusionBreakdown: { unanswerable: 1 },
    });
    expect(r1Hit3?.mean).toBeGreaterThan(0.5);

    // Running the same fixture twice yields BIT-FOR-BIT identical metrics and evidence order!
    expect(r2.pipelines[0]?.retrievalMetrics).toEqual(
      r1.pipelines[0]?.retrievalMetrics,
    );
    expect(r2.pipelines[1]?.retrievalMetrics).toEqual(
      r1.pipelines[1]?.retrievalMetrics,
    );

    const tasks1 = c
      .page(c.runTaskDetail)
      .parse(
        (
          await send(
            app,
            'GET',
            `/api/v1/runs/${r1.id}/tasks?pipelineId=${p1.id}`,
          )
        ).body,
      ).items;
    const tasks2 = c
      .page(c.runTaskDetail)
      .parse(
        (
          await send(
            app,
            'GET',
            `/api/v1/runs/${r2.id}/tasks?pipelineId=${p1OrigCopy.id}`,
          )
        ).body,
      ).items;

    expect(tasks1.map((t) => t.retrievedItems.map((i) => i.chunkId))).toEqual(
      tasks2.map((t) => t.retrievedItems.map((i) => i.chunkId)),
    );
  });

  it('reuses identical retrieval and answer stages across pipelines, records retry spend separately, leaves missing prices unknown, and keeps failed/refused judge observations null', async () => {
    let chatCalls = 0;
    let firstAnswerFailedOnce = false;
    let faithfulnessMalformedOnce = false;
    let refusedRelevanceOnce = false;

    const fakeOpenAI: typeof fetch = vi.fn(async (_url, init) => {
      chatCalls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format?: { json_schema?: { name?: string } };
      };
      const schemaName = body.response_format?.json_schema?.name ?? '';

      if (schemaName === 'grounded_answer') {
        if (!firstAnswerFailedOnce) {
          firstAnswerFailedOnce = true;
          return new Response('Transient overload', { status: 503 });
        }
        const userText = body.messages[1]?.content ?? '';
        const chunkMatch = userText.match(/\(id=([a-f0-9-]{36})/);
        const chunkId = chunkMatch?.[1];
        if (userText.includes('numeric chunk size')) {
          return openaiChatResponse(
            JSON.stringify({
              answer: 'The context does not specify a numeric chunk size.',
              citations: [],
              abstained: true,
            }),
            body.model,
            { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
          );
        }
        return openaiChatResponse(
          JSON.stringify({
            answer: 'text-embedding-3-small balances cost and performance.',
            citations: chunkId ? [chunkId] : [],
            abstained: false,
          }),
          body.model,
          { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
        );
      }

      if (schemaName === 'judge_faithfulness') {
        if (!faithfulnessMalformedOnce) {
          faithfulnessMalformedOnce = true;
          return openaiChatResponse('not valid json', body.model, {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          });
        }
        const chunkMatch = (body.messages[1]?.content ?? '').match(
          /chunkId=([a-f0-9-]{36})/,
        );
        return openaiChatResponse(
          JSON.stringify({
            refused: false,
            reason: '',
            claims: [
              {
                claim: 'text-embedding-3-small balances cost and performance',
                verdict: 'supported',
                evidenceChunkIds: chunkMatch ? [chunkMatch[1]] : [],
                quote: '',
              },
            ],
          }),
          body.model,
          { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        );
      }

      if (schemaName === 'judge_answer_relevance') {
        if (!refusedRelevanceOnce) {
          refusedRelevanceOnce = true;
          return openaiChatResponse(
            JSON.stringify({
              refused: true,
              grade: 0,
              rationale: 'Refused in fixture.',
            }),
            body.model,
            { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
          );
        }
        return openaiChatResponse(
          JSON.stringify({
            refused: false,
            grade: 4,
            rationale: 'Fully responsive.',
          }),
          body.model,
        );
      }

      if (schemaName === 'judge_context_precision') {
        const ids = Array.from(
          (body.messages[1]?.content ?? '').matchAll(
            /chunkId=([a-f0-9-]{36})/g,
          ),
        ).map((m) => m[1]);
        return openaiChatResponse(
          JSON.stringify({
            refused: false,
            reason: '',
            passages: ids.map((chunkId) => ({
              chunkId,
              useful: true,
              rationale: 'Relevant.',
            })),
          }),
          body.model,
        );
      }

      if (schemaName === 'judge_context_recall') {
        const chunkMatch = (body.messages[1]?.content ?? '').match(
          /chunkId=([a-f0-9-]{36})/,
        );
        return openaiChatResponse(
          JSON.stringify({
            refused: false,
            reason: '',
            facts: [
              {
                factIndex: 1,
                supported: true,
                evidenceChunkIds: chunkMatch ? [chunkMatch[1]] : [],
                rationale: 'Supported.',
              },
            ],
          }),
          body.model,
        );
      }

      // judge_answer_correctness
      return openaiChatResponse(
        JSON.stringify({
          refused: false,
          facts: [{ factIndex: 1, status: 'satisfied', rationale: 'Matched.' }],
          criticalContradiction: false,
          acceptanceCriteriaMet: true,
          rationale: 'Correct.',
        }),
        body.model,
      );
    });

    // Price ONLY the chat model; leave the judge model UNPRICED!
    const priceSchedule = JSON.stringify({
      version: 'partial-price-v1',
      currency: 'USD',
      entries: [
        {
          model: 'priced-chat',
          provider: 'openai',
          unit: 'per_1m_tokens',
          inputUsd: 2.0,
          outputUsd: 8.0,
        },
      ],
    });

    const stack = setupStack(
      {
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_CHAT_MODEL: 'priced-chat',
        OPENAI_JUDGE_MODEL: 'unpriced-judge',
        PRICE_SCHEDULE_JSON: priceSchedule,
      },
      { openai: fakeOpenAI },
    );

    // Deterministically keep the 1 unanswerable task and 1 single-fact answerable task
    const sample = stack.datasets.sample().value;
    const keepUnanswerable = sample.tasks.find((t) => !t.answerable);
    const keepAnswerable = sample.tasks.find(
      (t) =>
        t.answerable &&
        t.referenceFacts.length === 1 &&
        t.question.includes('balances cost and performance'),
    );
    if (!keepUnanswerable || !keepAnswerable) {
      throw new Error('Missing expected sample fixture tasks.');
    }
    const keepIds = new Set([keepUnanswerable.id, keepAnswerable.id]);
    let rev = sample.revision;
    for (const extra of sample.tasks) {
      if (!keepIds.has(extra.id)) {
        rev = stack.datasets.editTask(
          sample.id,
          rev,
          extra.id,
          undefined,
        ).revision;
      }
    }

    // Two pipelines with IDENTICAL chunking/retrieval/chat config -> pipeline 2 must reuse index, retrieval, AND answer!
    const pA = stack.pipelines.create({
      name: 'Pipeline A',
      config: {
        retriever: { mode: 'keyword', topK: 3, deduplicate: false },
        llm: { model: 'priced-chat', temperature: 0.2, maxTokens: 300 },
        judge: { model: 'unpriced-judge' },
      },
    });
    const pB = stack.pipelines.copy(pA.id, 1, 'Pipeline B');

    const searchSpy = vi.spyOn(stack.retrieval, 'search');

    const exp = stack.runs.createExperiment({
      name: 'Full RAG test',
      datasetId: sample.id,
      baselinePipelineId: pA.id,
      pipelineIds: [pA.id, pB.id],
      mode: 'full_rag',
    });

    const created = stack.runs.createRun(
      exp.id,
      { datasetRevision: rev, mode: 'full_rag', judgeEnabled: true },
      {
        capabilities: stack.config.capabilities,
        pricing: stack.config.pricing,
        budgets: stack.config.budgets,
      },
    );

    const workerOpts = {
      directory: join(dir, 'blobs'),
      cloud: new CloudParser('', undefined),
      indexes: stack.indexes,
      indexBuilder: stack.indexBuilder,
      runs: stack.runs,
      evaluationRunner: stack.evaluationRunner,
    };
    while (await runOne(stack.jobs, workerOpts)) {
      clock += 25;
    }

    const detail = stack.runs.getRun(created.run.id);
    expect(detail.state).toBe('succeeded');

    // Stage reuse: 2 tasks across 2 identical pipelines -> search executed ONCE per task (2 calls, not 4!)
    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(detail.pipelines[1]?.indexReused).toBe(true);
    const pBTasks = stack.runs.listRunTasks(detail.id, 10, 0, pB.id).items;
    expect(pBTasks.every((t) => t.answer?.reusedFromRunTaskId !== null)).toBe(
      true,
    );

    // Retry spend is recorded and visible separately!
    expect(detail.cost.retry.totalCalls).toBeGreaterThanOrEqual(2); // 1 chat 503 retry + 1 judge repair
    expect(detail.cost.retry.knownUsd).toBeGreaterThan(0);
    expect(detail.tokens.retryTokens).toBeGreaterThan(0);

    // Unpriced judge model remains UNKNOWN (never estimated!), making total run spend PARTIAL.
    expect(detail.cost.judging.status).toBe('unknown');
    expect(detail.cost.judging.totalUsd).toBeNull();
    expect(detail.cost.judging.unpricedModels).toContain('unpriced-judge');
    expect(detail.cost.total.status).toBe('partial');
    expect(detail.cost.total.totalUsd).toBeNull();
    expect(detail.cost.total.knownUsd).toBeGreaterThan(0);

    // Refused answer_relevance yielded a NULL observation with recorded reason, never 0!
    const pATasks = stack.runs.listRunTasks(detail.id, 10, 0, pA.id).items;
    const answerableTask = pATasks.find((t) => t.answerable);
    const unanswerableTask = pATasks.find((t) => !t.answerable);
    const relObs = answerableTask?.observations.find(
      (o) => o.metricId === 'answer_relevance',
    );
    expect(relObs).toMatchObject({
      status: 'judge_refused',
      value: null,
      reason: 'Refused in fixture.',
    });
    expect(relObs?.metadata?.rawResponseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(relObs?.metadata?.rubricVersion).toBe('answer-relevance-v1');
    expect(relObs?.metadata?.judgeModel).toBe('unpriced-judge');

    // Faithfulness repair kept BOTH attempts in judge_attempts!
    const faithAttempts = answerableTask?.judgeAttempts.filter(
      (a) => a.metricId === 'faithfulness',
    );
    expect(faithAttempts).toHaveLength(2);
    expect(faithAttempts?.[0]?.status).toBe('malformed');
    expect(faithAttempts?.[1]?.status).toBe('succeeded');
    expect(faithAttempts?.[1]?.isRepair).toBe(true);

    // Abstention metrics reported separately for answerable vs unanswerable!
    expect(
      unanswerableTask?.observations.find(
        (o) => o.metricId === 'abstention_unanswerable',
      ),
    ).toMatchObject({ status: 'scored', value: 1 });
    expect(
      answerableTask?.observations.find(
        (o) => o.metricId === 'abstention_answerable',
      ),
    ).toMatchObject({ status: 'scored', value: 1 });

    // Task cross-pipeline endpoint returns both pipelines for a given taskId
    const crossRes = await send(
      stack.app,
      'GET',
      `/api/v1/runs/${detail.id}/tasks/${answerableTask?.taskId}`,
    );
    expect(crossRes.status).toBe(200);
    expect((crossRes.body as { items: unknown[] }).items).toHaveLength(2);
    expect(chatCalls).toBeGreaterThan(0);
  });

  it('checkpoints per pipeline/task so a worker restart resumes without redoing completed work', async () => {
    const stack = setupStack();
    const sample = stack.datasets.sample().value;
    // Keep 3 tasks for a crisp checkpoint test
    let rev = sample.revision;
    for (const extra of sample.tasks.slice(3)) {
      rev = stack.datasets.editTask(
        sample.id,
        rev,
        extra.id,
        undefined,
      ).revision;
    }
    const p1 = stack.pipelines.create({
      name: 'Keyword resume',
      config: { retriever: { mode: 'keyword', topK: 3, deduplicate: false } },
    });
    const exp = stack.runs.createExperiment({
      name: 'Resume fixture',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'retrieval_only',
    });
    const created = stack.runs.createRun(
      exp.id,
      { datasetRevision: rev },
      {
        capabilities: stack.config.capabilities,
        pricing: stack.config.pricing,
        budgets: stack.config.budgets,
      },
    );

    // Abort the first worker right after task 1's retrieval completes & checkpoints!
    const crashController = new AbortController();
    const queriedQuestions: string[] = [];
    const origSearch = stack.retrieval.search.bind(stack.retrieval);
    vi.spyOn(stack.retrieval, 'search').mockImplementation(
      async (genId, req, sig, audit) => {
        queriedQuestions.push(req.query);
        const res = await origSearch(genId, req, sig, audit);
        if (queriedQuestions.length === 1) {
          // Allow task 1 to save & checkpoint, then crash before task 2 starts
          queueMicrotask(() => crashController.abort());
        }
        return res;
      },
    );

    const workerOpts = {
      directory: join(dir, 'blobs'),
      cloud: new CloudParser('', undefined),
      indexes: stack.indexes,
      indexBuilder: stack.indexBuilder,
      runs: stack.runs,
      evaluationRunner: stack.evaluationRunner,
    };

    await runOne(stack.jobs, { ...workerOpts, signal: crashController.signal });

    // Worker 1 completed task 1 and stopped without releasing lease (simulated crash).
    const midRun = stack.runs.getRun(created.run.id);
    expect(midRun.completedUnits).toBe(1);
    expect(midRun.totalUnits).toBe(3);
    expect(queriedQuestions).toHaveLength(1);

    // Advance clock past lease expiry so Worker 2 reclaims the run and resumes from task 2!
    clock += 10_000;
    await runOne(stack.jobs, workerOpts);

    const finished = stack.runs.getRun(created.run.id);
    expect(finished.state).toBe('succeeded');
    expect(finished.completedUnits).toBe(3);
    // Total search calls across BOTH workers is 3 (task 1 was NEVER redone!).
    expect(queriedQuestions).toHaveLength(3);
    expect(new Set(queriedQuestions).size).toBe(3);
  });

  it('validates capabilities before enqueue and enforces same-origin and cross-origin rules on new endpoints', async () => {
    const stack = setupStack({ CORS_ORIGINS: 'https://allowed.example' });
    const sample = stack.datasets.sample().value;
    const p1 = stack.pipelines.create({
      name: 'Keyword',
      config: { retriever: { mode: 'keyword', topK: 3, deduplicate: false } },
    });

    // Missing chat capability rejects full_rag BEFORE enqueueing
    const exp = stack.runs.createExperiment({
      name: 'CORS test',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'full_rag',
    });
    const missingCap = await send(
      stack.app,
      'POST',
      `/api/v1/experiments/${exp.id}/runs`,
      { mode: 'full_rag' },
    );
    expect(missingCap.status).toBe(422);
    expect(c.errorEnvelope.parse(missingCap.body).error.code).toBe(
      'missing_capability',
    );
    expect(stack.runs.listRuns(10).items).toHaveLength(0);

    // Same-origin allowed for experiment creation, run submission, and run reads
    const sameOriginCreate = await send(
      stack.app,
      'POST',
      '/api/v1/experiments',
      {
        name: 'Same origin exp',
        datasetId: sample.id,
        baselinePipelineId: p1.id,
        pipelineIds: [p1.id],
        mode: 'retrieval_only',
      },
      { origin: 'http://localhost' },
    );
    expect(sameOriginCreate.status).toBe(201);
    expect(sameOriginCreate.headers['access-control-allow-origin']).toBe(
      'http://localhost',
    );
    const createdExp = c.experiment.parse(sameOriginCreate.body);

    // Explicit allowed cross-origin (preflight OPTIONS + POST run + GET runs)
    const allowedPreflight = await send(
      stack.app,
      'OPTIONS',
      `/api/v1/experiments/${createdExp.id}/runs`,
      undefined,
      { origin: 'https://allowed.example' },
    );
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers['access-control-allow-origin']).toBe(
      'https://allowed.example',
    );

    const allowedRun = await send(
      stack.app,
      'POST',
      `/api/v1/experiments/${createdExp.id}/runs`,
      {},
      { origin: 'https://allowed.example' },
    );
    expect(allowedRun.status).toBe(202);
    expect(allowedRun.headers['access-control-allow-origin']).toBe(
      'https://allowed.example',
    );
    const submitted = c.createRunResult.parse(allowedRun.body);

    const allowedGet = await send(
      stack.app,
      'GET',
      `/api/v1/runs/${submitted.run.id}`,
      undefined,
      { origin: 'https://allowed.example' },
    );
    expect(allowedGet.status).toBe(200);
    expect(allowedGet.headers['access-control-allow-origin']).toBe(
      'https://allowed.example',
    );

    // Disallowed foreign cross-origin rejected across all new endpoints!
    for (const [method, path, body] of [
      [
        'POST',
        '/api/v1/experiments',
        {
          name: 'Blocked',
          datasetId: sample.id,
          baselinePipelineId: p1.id,
          pipelineIds: [p1.id],
          mode: 'retrieval_only',
        },
      ],
      ['OPTIONS', `/api/v1/experiments/${createdExp.id}/runs`, undefined],
      ['POST', `/api/v1/experiments/${createdExp.id}/runs`, {}],
      ['GET', '/api/v1/runs', undefined],
      ['GET', `/api/v1/runs/${submitted.run.id}`, undefined],
      ['GET', `/api/v1/runs/${submitted.run.id}/tasks`, undefined],
    ] as const) {
      const blocked = await send(stack.app, method, path, body, {
        origin: 'https://evil.example',
      });
      expect(blocked.status).toBe(403);
      expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
      expect(c.errorEnvelope.parse(blocked.body).error.code).toBe(
        'origin_denied',
      );
    }

    // Cancel queued run and verify explicit retry works
    const cancelled = await send(
      stack.app,
      'POST',
      `/api/v1/jobs/${submitted.job.id}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(200);
    expect(c.job.parse(cancelled.body).state).toBe('cancelled');
    expect(stack.runs.getRun(submitted.run.id).state).toBe('cancelled');

    const retried = await send(
      stack.app,
      'POST',
      `/api/v1/jobs/${submitted.job.id}/retry`,
      {},
    );
    expect(retried.status).toBe(202);
    const retryJob = c.job.parse(retried.body);
    expect(retryJob.parentId).toBe(submitted.job.id);
    expect(retryJob.runId).toBe(submitted.run.id);
  });

  it('freezes document-version parse artifacts at run submission so reparsing before execution does not alter evaluated text', async () => {
    const stack = setupStack({ LLAMA_CLOUD_API_KEY: 'fixture-llama-key' });
    const ds = stack.datasets.create('Run Artifact Freeze');
    const up = c.uploadResult.parse(
      (
        await send(
          stack.app,
          'POST',
          `/api/v1/datasets/${ds.id}/documents?name=spec.txt`,
          undefined,
          { 'if-match': '"1"', 'content-type': 'text/plain' },
          'Frozen local text mentioning albatross calibration.',
        )
      ).body,
    );
    expect(
      await runOne(stack.jobs, {
        directory: join(dir, 'blobs'),
        cloud: new CloudParser('', undefined),
      }),
    ).toBe(true);

    const dsWithTask = stack.datasets.addTask(
      ds.id,
      up.dataset.revision,
      c.taskInput.parse({
        question: 'What mentions albatross calibration?',
        expectedAnswer: 'The frozen local text.',
        answerable: true,
        qrels: [{ documentId: up.documentId, grade: 3 }],
      }),
    );

    const p1 = stack.pipelines.create({
      name: 'Keyword',
      config: { retriever: { mode: 'keyword', topK: 3, deduplicate: false } },
    });
    const exp = stack.runs.createExperiment({
      name: 'Artifact Freeze Exp',
      datasetId: ds.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'retrieval_only',
    });
    const submitted = stack.runs.createRun(
      exp.id,
      { datasetRevision: dsWithTask.revision, cutoffs: [1] },
      {
        capabilities: stack.config.capabilities,
        pricing: stack.config.pricing,
        budgets: stack.config.budgets,
      },
    );

    // Reparse the SAME document version with LlamaParse AFTER run enqueue, BEFORE run execution!
    const reparseRes = await send(
      stack.app,
      'POST',
      `/api/v1/documents/${up.documentId}/parses`,
      { parser: 'llama-parse' },
      { 'if-match': `"${dsWithTask.revision}"` },
    );
    expect(reparseRes.status).toBe(202);
    const fakeCloud = {
      upload: async () => 'remote-run-reparse',
      poll: async () => true,
      download: async () => ({
        text: 'Reparsed cloud text mentioning pelican only.',
        pages: [{ page: 1, start: 0, end: 44 }],
      }),
    } as unknown as CloudParser;
    expect(
      await runOne(stack.jobs, {
        directory: join(dir, 'blobs'),
        cloud: fakeCloud,
      }),
    ).toBe(true);

    // Execute the queued run; it must evaluate the artifact frozen at submission ("albatross").
    const workerOpts = {
      directory: join(dir, 'blobs'),
      cloud: fakeCloud,
      indexes: stack.indexes,
      indexBuilder: stack.indexBuilder,
      runs: stack.runs,
      evaluationRunner: stack.evaluationRunner,
    };
    while (await runOne(stack.jobs, workerOpts)) {
      clock += 10;
    }

    const detail = stack.runs.getRun(submitted.run.id);
    expect(detail.state).toBe('succeeded');
    const hit1 = detail.pipelines[0]?.retrievalMetrics.find(
      (m) => m.metricId === 'hit_at_k' && m.cutoff === 1,
    );
    expect(hit1?.mean).toBe(1);
    const taskDetail = stack.runs.listRunTasks(detail.id, 10, 0, p1.id)
      .items[0];
    expect(taskDetail?.retrievedItems[0]?.content).toContain('albatross');
    expect(taskDetail?.retrievedItems[0]?.content).not.toContain('pelican');
  });

  it('fails before sending data when frozen chat, judge, or embedding provider identity changes after worker restart', async () => {
    // 1. Freeze a full_rag run against local OpenAI-compatible chat & judge profiles.
    const submitStack = setupStack({
      LOCAL_CHAT_BASE_URL: 'http://127.0.0.1:11434/v1',
      LOCAL_CHAT_MODEL: 'shared-chat-model',
      LOCAL_JUDGE_MODEL: 'shared-judge-model',
      LOCAL_CHAT_SUPPORTS_STRUCTURED_OUTPUT: 'true',
    });
    const sample = submitStack.datasets.sample().value;
    let rev = sample.revision;
    for (const extra of sample.tasks.slice(1)) {
      rev = submitStack.datasets.editTask(
        sample.id,
        rev,
        extra.id,
        undefined,
      ).revision;
    }
    const p1 = submitStack.pipelines.create({
      name: 'Local Full RAG',
      config: {
        retriever: { mode: 'keyword', topK: 3, deduplicate: false },
        llm: { model: 'shared-chat-model', temperature: 0.2, maxTokens: 200 },
        judge: { model: 'shared-judge-model' },
      },
    });
    const exp = submitStack.runs.createExperiment({
      name: 'Provider Pin Exp',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'full_rag',
    });
    const created = submitStack.runs.createRun(
      exp.id,
      { datasetRevision: rev, mode: 'full_rag', judgeEnabled: true },
      {
        capabilities: submitStack.config.capabilities,
        pricing: submitStack.config.pricing,
        budgets: submitStack.config.budgets,
      },
    );

    // Worker restarts with the SAME model names mapped to cloud OpenAI instead of local!
    const cloudOpenAIFetch = vi.fn<typeof fetch>(async () =>
      openaiChatResponse(
        JSON.stringify({ answer: 'LEAKED', citations: [], abstained: false }),
        'shared-chat-model',
      ),
    );
    const restartedStack = setupStack(
      {
        OPENAI_API_KEY: 'cloud-secret-key',
        OPENAI_CHAT_MODEL: 'shared-chat-model',
        OPENAI_JUDGE_MODEL: 'shared-judge-model',
      },
      { openai: cloudOpenAIFetch },
    );

    await runOne(restartedStack.jobs, {
      directory: join(dir, 'blobs'),
      cloud: new CloudParser('', undefined),
      indexes: restartedStack.indexes,
      indexBuilder: restartedStack.indexBuilder,
      runs: restartedStack.runs,
      evaluationRunner: restartedStack.evaluationRunner,
    });

    // ZERO requests may be sent to cloud OpenAI!
    expect(cloudOpenAIFetch).not.toHaveBeenCalled();
    const runAfter = restartedStack.runs.getRun(created.run.id);
    expect(runAfter.state).toBe('failed');
    expect(restartedStack.jobs.get(created.job.id).state).toBe('failed');

    // 2. Also verify frozen embedding provider identity cannot silently switch local -> cloud OpenAI.
    const embedSubmitStack = setupStack({
      QDRANT_URL: 'http://qdrant.invalid',
      LOCAL_EMBED_BASE_URL: 'http://127.0.0.1:11434/v1',
      LOCAL_EMBED_MODEL: 'shared-embed-model',
    });
    const pDense = embedSubmitStack.pipelines.create({
      name: 'Local Dense',
      config: {
        embedding: { model: 'shared-embed-model' },
        retriever: { mode: 'dense', topK: 3, deduplicate: false },
      },
    });
    const expDense = embedSubmitStack.runs.createExperiment({
      name: 'Embed Provider Pin Exp',
      datasetId: sample.id,
      baselinePipelineId: pDense.id,
      pipelineIds: [pDense.id],
      mode: 'retrieval_only',
    });
    const createdDense = embedSubmitStack.runs.createRun(
      expDense.id,
      { datasetRevision: rev },
      {
        capabilities: embedSubmitStack.config.capabilities,
        pricing: embedSubmitStack.config.pricing,
        budgets: embedSubmitStack.config.budgets,
      },
    );

    const cloudEmbedFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        object: 'list',
        model: 'shared-embed-model',
        data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }],
      }),
    );
    const restartedEmbedConfig = readConfig({
      BLOB_DIRECTORY: join(dir, 'blobs'),
      QDRANT_URL: 'http://qdrant.invalid',
      OPENAI_API_KEY: 'cloud-secret-key',
      OPENAI_EMBED_MODEL: 'shared-embed-model',
    });
    const restartedEmbedProviders = new ProviderRegistry(restartedEmbedConfig, {
      openai: cloudEmbedFetch,
    });
    const fakeQdrant: QdrantClientLike = {
      collectionExists: async () => ({ exists: false }),
      getCollection: async () => ({}),
      createCollection: async () => ({}),
      createPayloadIndex: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      count: async () => ({ count: 0 }),
      delete: async () => ({}),
      deleteCollection: async () => ({}),
    };
    const qdrantStore = new QdrantStore({
      url: 'http://qdrant.invalid',
      client: fakeQdrant,
    });
    const jobs2 = new Jobs(db, () => clock, 5000);
    const datasets2 = new Datasets(db, jobs2);
    const pipelines2 = new Pipelines(db);
    const indexes2 = new Indexes(db, jobs2, () => clock);
    const runs2 = new Runs(
      db,
      datasets2,
      pipelines2,
      indexes2,
      jobs2,
      () => clock,
    );
    const indexBuilder2 = new IndexBuilder({
      indexes: indexes2,
      providers: restartedEmbedProviders,
      qdrant: qdrantStore,
      now: () => clock,
    });
    const retrieval2 = new RetrievalService({
      indexes: indexes2,
      providers: restartedEmbedProviders,
      qdrant: qdrantStore,
      now: () => clock,
    });
    const runner2 = new EvaluationRunner({
      runs: runs2,
      indexes: indexes2,
      indexBuilder: indexBuilder2,
      retrieval: retrieval2,
      providers: restartedEmbedProviders,
      now: () => clock,
      retryDelayMs: 1,
    });
    await runOne(jobs2, {
      directory: join(dir, 'blobs'),
      cloud: new CloudParser('', undefined),
      indexes: indexes2,
      indexBuilder: indexBuilder2,
      runs: runs2,
      evaluationRunner: runner2,
    });
    expect(cloudEmbedFetch).not.toHaveBeenCalled();
    expect(runs2.getRun(createdDense.run.id).state).toBe('failed');
    expect(jobs2.get(createdDense.job.id).state).toBe('failed');
  });

  it('marks both run and job failed when every task fails retrieval so the retry endpoint accepts it', async () => {
    const stack = setupStack();
    const sample = stack.datasets.sample().value;
    const p1 = stack.pipelines.create({
      name: 'Failing Retrieval Pipeline',
      config: { retriever: { mode: 'keyword', topK: 3, deduplicate: false } },
    });
    const exp = stack.runs.createExperiment({
      name: 'All Tasks Fail',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'retrieval_only',
    });
    const created = stack.runs.createRun(
      exp.id,
      {},
      {
        capabilities: stack.config.capabilities,
        pricing: stack.config.pricing,
        budgets: stack.config.budgets,
      },
    );

    // Index builds and becomes ready, then every single retrieval fails.
    vi.spyOn(stack.retrieval, 'search').mockRejectedValue(
      new ApiError(
        500,
        'internal_error',
        'Simulated permanent search failure.',
      ),
    );

    await runOne(stack.jobs, {
      directory: join(dir, 'blobs'),
      cloud: new CloudParser('', undefined),
      indexes: stack.indexes,
      indexBuilder: stack.indexBuilder,
      runs: stack.runs,
      evaluationRunner: stack.evaluationRunner,
    });

    const finished = stack.runs.getRun(created.run.id);
    expect(finished.pipelines[0]?.state).toBe('failed');
    expect(finished.failedUnits).toBe(finished.totalUnits);
    expect(finished.completedUnits).toBe(0);
    expect(finished.state).toBe('failed');
    expect(stack.jobs.get(created.job.id).state).toBe('failed');

    // Retry endpoint MUST accept the failed job!
    const retryRes = await send(
      stack.app,
      'POST',
      `/api/v1/jobs/${created.job.id}/retry`,
      {},
    );
    expect(retryRes.status).toBe(202);
    expect(c.job.parse(retryRes.body).parentId).toBe(created.job.id);
  });

  it('persists unique physical provider-call attempts before dispatch, requires explicit retry after interruption, and preserves both billing records', async () => {
    let chatCallCount = 0;
    const fakeOpenAI = vi.fn<typeof fetch>(async (_url, init) => {
      chatCallCount += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      return openaiChatResponse(
        JSON.stringify({
          answer: `Paid answer attempt ${chatCallCount}.`,
          citations: [],
          abstained: false,
        }),
        body.model,
        { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      );
    });

    const pricingJson = JSON.stringify({
      version: 'attempt-price-v1',
      currency: 'USD',
      entries: [
        {
          model: 'priced-chat',
          provider: 'openai',
          unit: 'per_request',
          requestUsd: 0.25,
        },
      ],
    });
    const stack = setupStack(
      {
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_CHAT_MODEL: 'priced-chat',
        PRICE_SCHEDULE_JSON: pricingJson,
      },
      { openai: fakeOpenAI },
    );

    const sample = stack.datasets.sample().value;
    let rev = sample.revision;
    for (const extra of sample.tasks.slice(1)) {
      rev = stack.datasets.editTask(
        sample.id,
        rev,
        extra.id,
        undefined,
      ).revision;
    }
    const p1 = stack.pipelines.create({
      name: 'Priced Chat',
      config: {
        retriever: { mode: 'keyword', topK: 3, deduplicate: false },
        llm: { model: 'priced-chat', temperature: 0.2, maxTokens: 200 },
      },
    });
    const exp = stack.runs.createExperiment({
      name: 'Attempt Durability',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'full_rag',
    });
    const created = stack.runs.createRun(
      exp.id,
      { datasetRevision: rev, mode: 'full_rag', judgeEnabled: false },
      {
        capabilities: stack.config.capabilities,
        pricing: stack.config.pricing,
        budgets: stack.config.budgets,
      },
    );

    // Worker 1 dies right AFTER the paid chat provider call completes and is recorded,
    // BEFORE saveTaskAnswer commits!
    const worker1Crash = new AbortController();
    const origSaveAnswer = stack.runs.saveTaskAnswer.bind(stack.runs);
    const saveAnswerSpy = vi
      .spyOn(stack.runs, 'saveTaskAnswer')
      .mockImplementationOnce(() => {
        worker1Crash.abort();
        throw new Error('Simulated worker crash before saving answer.');
      })
      .mockImplementation((input, guard) => origSaveAnswer(input, guard));

    const workerOpts = {
      directory: join(dir, 'blobs'),
      cloud: new CloudParser('', undefined),
      indexes: stack.indexes,
      indexBuilder: stack.indexBuilder,
      runs: stack.runs,
      evaluationRunner: stack.evaluationRunner,
    };

    await runOne(stack.jobs, { ...workerOpts, signal: worker1Crash.signal });
    expect(chatCallCount).toBe(1);
    expect(saveAnswerSpy).toHaveBeenCalledTimes(1);

    // Worker 2 reclaims the expired lease on the SAME job (automatic recovery, NOT explicit retry).
    // It MUST NOT silently call the paid provider again; it must preserve the prior call and fail requiring explicit retry.
    clock += 10_000;
    await runOne(stack.jobs, workerOpts);
    expect(chatCallCount).toBe(1);

    const afterRecovery = stack.runs.getRun(created.run.id);
    expect(afterRecovery.state).toBe('failed');
    expect(stack.jobs.get(created.job.id).state).toBe('failed');

    // Now operator explicitly retries the failed job -> linked retry job IS allowed to issue a 2nd paid call.
    const retryRes = await send(
      stack.app,
      'POST',
      `/api/v1/jobs/${created.job.id}/retry`,
      {},
    );
    expect(retryRes.status).toBe(202);
    await runOne(stack.jobs, workerOpts);

    expect(chatCallCount).toBe(2);
    const finished = stack.runs.getRun(created.run.id);
    expect(finished.state).toBe('succeeded');

    // BOTH physical billing records MUST be preserved in provider_calls (never dropped by INSERT OR IGNORE)!
    const taskDetail = stack.runs.listRunTasks(finished.id, 10, 0, p1.id)
      .items[0];
    const generateCalls = taskDetail?.providerCalls.filter(
      (call) => call.operation === 'generate',
    );
    expect(generateCalls).toHaveLength(2);
    expect(generateCalls?.[0]?.isRetry).toBe(false);
    expect(generateCalls?.[1]?.isRetry).toBe(true);
    expect(finished.cost.total.totalCalls).toBe(2);
    expect(finished.cost.total.knownUsd).toBeCloseTo(0.5, 6);
  });

  it('audits and prices each corpus embedding HTTP batch, preserves partial-failure usage and unknown usage, and enforces run budgets between batches', async () => {
    const createBatchStack = (
      env: NodeJS.ProcessEnv,
      embedFetch: typeof fetch,
    ) => {
      const config = readConfig({
        BLOB_DIRECTORY: join(dir, 'blobs'),
        QDRANT_URL: 'http://qdrant.invalid',
        LOCAL_EMBED_BASE_URL: 'http://local-embed.invalid/v1',
        LOCAL_EMBED_MODEL: 'batched-embed',
        EMBED_BATCH_SIZE: '2',
        ...env,
      });
      const jobs = new Jobs(db, () => clock, 5000);
      const datasets = new Datasets(db, jobs);
      const pipelines = new Pipelines(db);
      const indexes = new Indexes(db, jobs, () => clock);
      const runs = new Runs(
        db,
        datasets,
        pipelines,
        indexes,
        jobs,
        () => clock,
      );
      const providers = new ProviderRegistry(config, {
        openaiCompatible: embedFetch,
      });
      const points = new Map<
        string,
        { vector: number[]; payload: Record<string, unknown> }
      >();
      const fakeQdrant: QdrantClientLike = {
        collectionExists: async () => ({ exists: true }),
        getCollection: async () => ({
          config: { params: { vectors: { size: 3 } } },
        }),
        createCollection: async () => ({}),
        createPayloadIndex: async () => ({}),
        upsert: async (_col, args) => {
          for (const p of args.points) {
            points.set(p.id, { vector: p.vector, payload: p.payload });
          }
        },
        query: async (_col, args) => {
          const genFilter = args.filter.must.find(
            (m) => m.key === 'generationId',
          );
          const targetGen =
            genFilter && 'match' in genFilter && 'value' in genFilter.match
              ? genFilter.match.value
              : undefined;
          return {
            points: Array.from(points.entries())
              .filter(([, p]) => p.payload.generationId === targetGen)
              .slice(0, args.limit)
              .map(([id, p]) => ({ id, score: 0.9, payload: p.payload })),
          };
        },
        count: async (_col, args) => {
          const genFilter = args.filter.must.find(
            (m) => m.key === 'generationId',
          );
          const targetGen =
            genFilter && 'match' in genFilter && 'value' in genFilter.match
              ? genFilter.match.value
              : undefined;
          let count = 0;
          for (const p of points.values()) {
            if (p.payload.generationId === targetGen) count += 1;
          }
          return { count };
        },
        delete: async () => ({}),
        deleteCollection: async () => ({}),
      };
      const qdrant = new QdrantStore({
        url: 'http://qdrant.invalid',
        client: fakeQdrant,
      });
      const indexBuilder = new IndexBuilder({
        indexes,
        providers,
        qdrant,
        embedBatchSize: 2,
        now: () => clock,
      });
      const retrieval = new RetrievalService({
        indexes,
        providers,
        qdrant,
        now: () => clock,
      });
      const evaluationRunner = new EvaluationRunner({
        runs,
        indexes,
        indexBuilder,
        retrieval,
        providers,
        now: () => clock,
        maxTransientRetries: 0,
        retryDelayMs: 1,
      });
      return {
        config,
        jobs,
        datasets,
        pipelines,
        indexes,
        runs,
        indexBuilder,
        evaluationRunner,
      };
    };

    const perRequestPrice = JSON.stringify({
      version: 'batch-price-v1',
      currency: 'USD',
      entries: [
        {
          model: 'batched-embed',
          provider: 'openai-compatible',
          unit: 'per_request',
          requestUsd: 0.1,
        },
      ],
    });

    // Build a dataset with 5 distinct 1-chunk documents -> 3 HTTP embedding batches (2 + 2 + 1).
    let batchCalls = 0;
    const threeBatchFetch = vi.fn<typeof fetch>(async (_url, init) => {
      batchCalls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        input: string[];
      };
      // Omit usage on batch 2 to prove missing usage is preserved as missing/unknown.
      return Response.json({
        object: 'list',
        model: 'batched-embed',
        data: body.input.map((_t, idx) => ({
          object: 'embedding',
          index: idx,
          embedding: [0.5, 0.5, 0.5],
        })),
        ...(batchCalls === 2
          ? {}
          : {
              usage: {
                prompt_tokens: body.input.length * 5,
                total_tokens: body.input.length * 5,
              },
            }),
      });
    });

    const s1 = createBatchStack(
      { PRICE_SCHEDULE_JSON: perRequestPrice },
      threeBatchFetch,
    );
    const ds = s1.datasets.create('Five Doc Corpus');
    const app1 = createApp({
      config: s1.config,
      datasets: s1.datasets,
      pipelines: s1.pipelines,
      indexes: s1.indexes,
      runs: s1.runs,
      logger: createLogger({ write: () => {} }),
      ready: () => true,
    });
    let rev = ds.revision;
    let firstDocId = '';
    for (let i = 0; i < 5; i++) {
      const res = c.uploadResult.parse(
        (
          await send(
            app1,
            'POST',
            `/api/v1/datasets/${ds.id}/documents?name=d${i}.txt`,
            undefined,
            { 'if-match': `"${rev}"`, 'content-type': 'text/plain' },
            `Unique corpus document number ${i} about embedding batches.`,
          )
        ).body,
      );
      if (!firstDocId) firstDocId = res.documentId;
      rev = res.dataset.revision;
      expect(
        await runOne(s1.jobs, {
          directory: join(dir, 'blobs'),
          cloud: new CloudParser('', undefined),
        }),
      ).toBe(true);
    }
    rev = s1.datasets.addTask(
      ds.id,
      rev,
      c.taskInput.parse({
        question: 'embedding batches',
        answerable: true,
        qrels: [{ documentId: firstDocId, grade: 3 }],
      }),
    ).revision;

    const pDense = s1.pipelines.create({
      name: 'Batched Dense',
      config: {
        embedding: { model: 'batched-embed' },
        retriever: { mode: 'dense', topK: 3, deduplicate: false },
      },
    });
    const exp1 = s1.runs.createExperiment({
      name: 'Per-Batch Audit',
      datasetId: ds.id,
      baselinePipelineId: pDense.id,
      pipelineIds: [pDense.id],
      mode: 'retrieval_only',
    });
    const r1 = s1.runs.createRun(
      exp1.id,
      { datasetRevision: rev },
      {
        capabilities: s1.config.capabilities,
        pricing: s1.config.pricing,
        budgets: s1.config.budgets,
      },
    );
    await s1.evaluationRunner.execute(r1.run.id);

    const detail1 = s1.runs.getRun(r1.run.id);
    expect(detail1.state).toBe('succeeded');
    // 3 HTTP corpus_embed batches -> 3 separate charges ($0.30, NOT $0.10)!
    expect(detail1.cost.indexing.totalCalls).toBe(3);
    expect(detail1.cost.indexing.knownUsd).toBeCloseTo(0.3, 6);
    // Batch 2 omitted usage -> 2 of 3 corpus batches + 1 query embed had known usage (not all 4).
    const corpusRows1 = db
      .prepare(
        "SELECT usage_status AS usageStatus FROM provider_calls WHERE run_id = ? AND operation = 'corpus_embed' ORDER BY rowid ASC",
      )
      .all(r1.run.id);
    expect(corpusRows1.map((row) => row.usageStatus)).toEqual([
      'known',
      'missing',
      'known',
    ]);

    // Sub-case B: Batch 2 fails -> Batch 1's usage & cost MUST still be preserved in SQLite!
    let failCall = 0;
    const failOnSecondBatch = vi.fn<typeof fetch>(async (_url, init) => {
      failCall += 1;
      if (failCall === 2) {
        return new Response('Hard failure', { status: 400 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        input: string[];
      };
      return Response.json({
        object: 'list',
        model: 'batched-embed',
        data: body.input.map((_t, idx) => ({
          object: 'embedding',
          index: idx,
          embedding: [0.5, 0.5, 0.5],
        })),
        usage: { prompt_tokens: 10, total_tokens: 10 },
      });
    });
    const s2 = createBatchStack(
      { PRICE_SCHEDULE_JSON: perRequestPrice },
      failOnSecondBatch,
    );
    // Distinct chunking config forces a brand new index generation (no reuse of r1's generation).
    const pDense2 = s2.pipelines.create({
      name: 'Batched Dense Fail',
      config: {
        chunking: { strategy: 'character-window', chunkSize: 250, overlap: 10 },
        embedding: { model: 'batched-embed' },
        retriever: { mode: 'dense', topK: 3, deduplicate: false },
      },
    });
    const exp2 = s2.runs.createExperiment({
      name: 'Mid-Batch Failure',
      datasetId: ds.id,
      baselinePipelineId: pDense2.id,
      pipelineIds: [pDense2.id],
      mode: 'retrieval_only',
    });
    const r2 = s2.runs.createRun(
      exp2.id,
      { datasetRevision: rev },
      {
        capabilities: s2.config.capabilities,
        pricing: s2.config.pricing,
        budgets: s2.config.budgets,
      },
    );
    await s2.evaluationRunner.execute(r2.run.id);
    const detail2 = s2.runs.getRun(r2.run.id);
    expect(detail2.state).toBe('failed');
    expect(detail2.tokens.totalTokens).toBe(10);
    expect(detail2.cost.indexing.totalCalls).toBe(2);

    // Sub-case C: Run budget checked between batches -> stops before dispatching batch 2!
    let budgetCalls = 0;
    const budgetFetch = vi.fn<typeof fetch>(async (_url, init) => {
      budgetCalls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        input: string[];
      };
      return Response.json({
        object: 'list',
        model: 'batched-embed',
        data: body.input.map((_t, idx) => ({
          object: 'embedding',
          index: idx,
          embedding: [0.5, 0.5, 0.5],
        })),
        usage: { prompt_tokens: 12, total_tokens: 12 },
      });
    });
    const s3 = createBatchStack(
      {
        PRICE_SCHEDULE_JSON: perRequestPrice,
        RUN_MAX_COST_USD: '0.1',
      },
      budgetFetch,
    );
    const pDense3 = s3.pipelines.create({
      name: 'Batched Dense Budget',
      config: {
        chunking: { strategy: 'character-window', chunkSize: 220, overlap: 10 },
        embedding: { model: 'batched-embed' },
        retriever: { mode: 'dense', topK: 3, deduplicate: false },
      },
    });
    const exp3 = s3.runs.createExperiment({
      name: 'Budget Between Batches',
      datasetId: ds.id,
      baselinePipelineId: pDense3.id,
      pipelineIds: [pDense3.id],
      mode: 'retrieval_only',
    });
    const r3 = s3.runs.createRun(
      exp3.id,
      { datasetRevision: rev },
      {
        capabilities: s3.config.capabilities,
        pricing: s3.config.pricing,
        budgets: s3.config.budgets,
      },
    );
    await s3.evaluationRunner.execute(r3.run.id);
    // Batch 1 hit $0.10 budget -> batch 2 and batch 3 MUST NOT be dispatched!
    expect(budgetCalls).toBe(1);
    const detail3 = s3.runs.getRun(r3.run.id);
    expect(detail3.state).toBe('failed');
    expect(detail3.pipelines[0]?.errorMessage).toMatch(/budget/i);
  });

  it('records failed generation and null abstention score when structured answer output is malformed on empty retrieval', async () => {
    const fakeOpenAI = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      // Returns raw non-JSON "Mars." despite structured output schema!
      return openaiChatResponse('Mars.', body.model, {
        prompt_tokens: 50,
        completion_tokens: 2,
        total_tokens: 52,
      });
    });

    const stack = setupStack(
      {
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_CHAT_MODEL: 'strict-chat',
      },
      { openai: fakeOpenAI },
    );
    const ds = stack.datasets.create('Empty Retrieval Abstention');
    const up = c.uploadResult.parse(
      (
        await send(
          stack.app,
          'POST',
          `/api/v1/datasets/${ds.id}/documents?name=notes.txt`,
          undefined,
          { 'if-match': '"1"', 'content-type': 'text/plain' },
          'Database indexing and query optimization notes.',
        )
      ).body,
    );
    expect(
      await runOne(stack.jobs, {
        directory: join(dir, 'blobs'),
        cloud: new CloudParser('', undefined),
      }),
    ).toBe(true);
    const dsWithTask = stack.datasets.addTask(
      ds.id,
      up.dataset.revision,
      c.taskInput.parse({
        question: 'Which celestial planet orbits fourth from Sol?',
        answerable: false,
        qrels: [{ documentId: up.documentId, grade: 0 }],
      }),
    );

    const p1 = stack.pipelines.create({
      name: 'Strict Chat',
      config: {
        retriever: { mode: 'keyword', topK: 3, deduplicate: false },
        llm: { model: 'strict-chat', temperature: 0.2, maxTokens: 100 },
      },
    });
    const exp = stack.runs.createExperiment({
      name: 'Malformed Structured Answer',
      datasetId: ds.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'full_rag',
    });
    const created = stack.runs.createRun(
      exp.id,
      {
        datasetRevision: dsWithTask.revision,
        mode: 'full_rag',
        judgeEnabled: false,
      },
      {
        capabilities: stack.config.capabilities,
        pricing: stack.config.pricing,
        budgets: stack.config.budgets,
      },
    );
    await stack.evaluationRunner.execute(created.run.id);

    const taskDetail = stack.runs.listRunTasks(created.run.id, 10, 0, p1.id)
      .items[0];
    expect(taskDetail?.retrievedItems).toHaveLength(0);
    expect(taskDetail?.answerState).toBe('failed');
    expect(taskDetail?.answer).toBeNull();
    const absObs = taskDetail?.observations.find(
      (o) => o.metricId === 'abstention_unanswerable',
    );
    expect(absObs).toMatchObject({
      status: 'generation_failed',
      value: null,
    });
    // Provider usage from the malformed response is still billed/recorded!
    expect(taskDetail?.providerCalls[0]?.totalTokens).toBe(52);
  });
});
