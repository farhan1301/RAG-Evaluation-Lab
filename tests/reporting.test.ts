import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { openDatabase } from '../backend/src/db/database';
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
import { pairedBootstrapInterval } from '../backend/src/reporting/bootstrap';
import { IndexBuilder } from '../backend/src/retrieval/indexer';
import { RetrievalService } from '../backend/src/retrieval/service';
import { send } from './inProcess';

function openaiChatJson(content: string, model: string) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-rep-fixture',
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
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-reporting-fixture',
      },
    },
  );
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('Phase 7: paired bootstrap, historical comparisons, exports, documentation, and legacy removal', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rag-eval-phase7-'));
    db = openDatabase(join(dir, 'workspace.db'));
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(
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
    const drain = async () => {
      while (
        await runOne(jobs, {
          directory: join(dir, 'blobs'),
          cloud: new CloudParser('', undefined),
          indexes,
          indexBuilder,
          runs,
          evaluationRunner,
        })
      ) {
        clock += 25;
      }
    };
    return { config, jobs, datasets, pipelines, runs, app, drain };
  }

  it('computes deterministic seeded paired bootstrap confidence intervals and enforces minPairs', () => {
    const tooFew = pairedBootstrapInterval([0.1, 0.2, 0.3], {
      samples: 500,
      seed: 42,
      minPairs: 5,
    });
    expect(tooFew.interval).toBeNull();
    expect(tooFew.note).toContain('at least 5 paired tasks');

    const disabled = pairedBootstrapInterval([0.1, 0.2, 0.3, 0.4, 0.5], {
      samples: 0,
      seed: 42,
    });
    expect(disabled.interval).toBeNull();

    const zeros = pairedBootstrapInterval([0, 0, 0, 0, 0], {
      samples: 500,
      seed: 42,
    });
    expect(zeros.interval).toMatchObject({ lower: 0, upper: 0 });

    const deltas = [0.0, 0.1, 0.2, 0.5, 0.2, 0.3, 0.1, 0.4, 0.0];
    const first = pairedBootstrapInterval(deltas, { samples: 1000, seed: 7 });
    const second = pairedBootstrapInterval(deltas, { samples: 1000, seed: 7 });
    expect(first).toEqual(second);
    expect(first.interval).not.toBeNull();
    if (!first.interval) throw new Error('Expected bootstrap interval.');
    expect(first.interval.lower).toBeGreaterThanOrEqual(0);
    expect(first.interval.upper).toBeLessThanOrEqual(0.5);
    expect(first.interval.lower).toBeLessThanOrEqual(first.interval.upper);
  });

  it('pairs runs on the same dataset revision with deltas, bootstrap CI, config diff, differing task evidence, and Markdown/JSON export', async () => {
    const { app, datasets, pipelines, runs, config, drain } = setup();
    const sample = datasets.sample().value;
    const basePl = pipelines.create({
      name: 'Baseline top-1',
      config: {
        chunking: { strategy: 'character-window', chunkSize: 300, overlap: 20 },
        retriever: { mode: 'keyword', topK: 1, deduplicate: false },
      },
    });
    const candPl = pipelines.create({
      name: 'Candidate top-5',
      config: {
        chunking: { strategy: 'character-window', chunkSize: 300, overlap: 20 },
        retriever: { mode: 'keyword', topK: 5, deduplicate: false },
      },
    });

    const exp = runs.createExperiment({
      name: 'Top-K ablation',
      datasetId: sample.id,
      baselinePipelineId: basePl.id,
      pipelineIds: [basePl.id, candPl.id],
      mode: 'retrieval_only',
    });
    const submitted = runs.createRun(
      exp.id,
      { name: 'Run A', cutoffs: [1, 3, 5] },
      {
        capabilities: config.capabilities,
        pricing: config.pricing,
        budgets: config.budgets,
      },
    );
    await drain();

    const compRes = await send(
      app,
      'GET',
      `/api/v1/comparisons?baselineRunId=${submitted.run.id}&baselinePipelineId=${basePl.id}&candidateRunId=${submitted.run.id}&candidatePipelineId=${candPl.id}&seed=42&bootstrapSamples=400`,
    );
    expect(compRes.status).toBe(200);
    const comp = c.comparisonResult.parse(compRes.body);
    expect(comp.compatible).toBe(true);
    expect(comp.datasetCompatible).toBe(true);
    expect(comp.incompatibilities).toEqual([]);
    expect(comp.configDiff).toContainEqual({
      path: 'config.retriever.topK',
      baseline: 1,
      candidate: 5,
    });

    const recall5 = comp.metrics.find(
      (m) => m.metricId === 'recall_at_k' && m.cutoff === 5,
    );
    expect(recall5).toBeDefined();
    expect(recall5?.comparable).toBe(true);
    expect(recall5?.pairedCount).toBe(9);
    expect(recall5?.missingPairs).toBe(1);
    expect(recall5?.absoluteDelta).toBeGreaterThan(0);
    expect(recall5?.direction).toBe('improved');
    expect(recall5?.bootstrapCi).not.toBeNull();
    expect(recall5?.bootstrapCi?.seed).toBe(42);
    expect(recall5?.bootstrapCi?.samples).toBe(400);

    // At least one task (including the two-document Task 7) must differ with side-by-side evidence
    const differing = comp.tasks.filter((t) => t.differs);
    expect(differing.length).toBeGreaterThan(0);
    const multiDocTask = comp.tasks.find(
      (t) => t.qrels.filter((q) => q.grade > 0).length >= 2,
    );
    expect(multiDocTask).toBeDefined();
    expect(multiDocTask?.differs).toBe(true);
    expect(multiDocTask?.baseline?.retrievedItems.length).toBe(1);
    expect(multiDocTask?.candidate?.retrievedItems.length).toBeGreaterThan(1);

    // JSON export
    const jsonRes = await send(
      app,
      'GET',
      `/api/v1/runs/${submitted.run.id}/export?format=json`,
    );
    expect(jsonRes.status).toBe(200);
    expect(String(jsonRes.headers['content-disposition'])).toContain('.json"');
    const exportedJson = c.runExportJson.parse(jsonRes.body);
    expect(exportedJson.run.id).toBe(submitted.run.id);
    expect(exportedJson.comparisons).toHaveLength(1);
    expect(exportedJson.tasks.length).toBe(20);

    // Markdown export
    const mdRes = await send(
      app,
      'GET',
      `/api/v1/runs/${submitted.run.id}/export?format=markdown`,
    );
    expect(mdRes.status).toBe(200);
    expect(String(mdRes.headers['content-type'])).toContain('text/markdown');
    expect(String(mdRes.headers['content-disposition'])).toContain('.md"');
    const md = String(mdRes.body);
    expect(md).toContain('# Run A');
    expect(md).toContain('Paired Metric Deltas');
    expect(md).toContain('config.retriever.topK');
    expect(md).toContain('95% Paired Bootstrap CI');
    expect(md).toContain('Per-Task Side-by-Side Evidence');
    expect(md).toContain('[Differs]');
  });

  it('refuses unpaired deltas when dataset revisions or judge configurations differ while keeping both sides inspectable', async () => {
    const fakeOpenAI: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format?: { json_schema?: { name?: string } };
      };
      const schemaName = body.response_format?.json_schema?.name ?? '';
      const userText = body.messages[1]?.content ?? '';
      const chunkIds = Array.from(
        userText.matchAll(/(?:id|chunkId)=([a-f0-9-]{36})/g),
      ).map((m) => m[1]);
      const firstId = chunkIds[0] ?? '';

      if (schemaName === 'grounded_answer') {
        if (userText.includes('numeric chunk size')) {
          return openaiChatJson(
            JSON.stringify({
              answer: 'The context does not specify a numeric chunk size.',
              citations: [],
              abstained: true,
            }),
            body.model,
          );
        }
        return openaiChatJson(
          JSON.stringify({
            answer: 'Grounded answer from retrieved passages.',
            citations: firstId ? [firstId] : [],
            abstained: false,
          }),
          body.model,
        );
      }
      if (schemaName === 'judge_faithfulness') {
        return openaiChatJson(
          JSON.stringify({
            refused: false,
            reason: '',
            claims: [
              {
                claim: 'Grounded answer',
                verdict: 'supported',
                evidenceChunkIds: firstId ? [firstId] : [],
                quote: '',
              },
            ],
          }),
          body.model,
        );
      }
      if (schemaName === 'judge_answer_relevance') {
        return openaiChatJson(
          JSON.stringify({
            refused: false,
            grade: 4,
            rationale: 'Directly answers the question.',
          }),
          body.model,
        );
      }
      if (schemaName === 'judge_context_precision') {
        return openaiChatJson(
          JSON.stringify({
            refused: false,
            reason: '',
            passages: chunkIds.map((id) => ({
              chunkId: id,
              useful: true,
              rationale: 'Relevant',
            })),
          }),
          body.model,
        );
      }
      if (schemaName === 'judge_context_recall') {
        const factCount = userText.match(/^\d+\.\s+"""/gm)?.length ?? 1;
        return openaiChatJson(
          JSON.stringify({
            refused: false,
            reason: '',
            facts: Array.from({ length: factCount }, (_, i) => ({
              factIndex: i + 1,
              supported: true,
              evidenceChunkIds: firstId ? [firstId] : [],
              rationale: 'Supported',
            })),
          }),
          body.model,
        );
      }
      const factCount = userText.match(/^\d+\.\s+"""/gm)?.length ?? 1;
      return openaiChatJson(
        JSON.stringify({
          refused: false,
          facts: Array.from({ length: factCount }, (_, i) => ({
            factIndex: i + 1,
            status: 'satisfied',
            rationale: 'Satisfied',
          })),
          criticalContradiction: false,
          acceptanceCriteriaMet: true,
          rationale: 'Correct answer.',
        }),
        body.model,
      );
    });

    const { app, datasets, pipelines, runs, config, drain } = setup(
      {
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_CHAT_MODEL: 'fixture-chat-a',
        OPENAI_JUDGE_MODEL: 'fixture-judge-a',
        LOCAL_CHAT_BASE_URL: 'http://127.0.0.1:9999/v1',
        LOCAL_CHAT_MODEL: 'fixture-chat-b',
        LOCAL_JUDGE_MODEL: 'fixture-judge-b',
        LOCAL_CHAT_SUPPORTS_STRUCTURED_OUTPUT: 'true',
      },
      { openai: fakeOpenAI },
    );

    const sample = datasets.sample().value;
    const p1 = pipelines.create({
      name: 'Judge A pipeline',
      config: {
        retriever: { mode: 'keyword', topK: 3, deduplicate: false },
        llm: { model: 'fixture-chat-a', temperature: 0.2, maxTokens: 200 },
        judge: { model: 'fixture-judge-a' },
      },
    });
    const p2 = pipelines.create({
      name: 'Judge B pipeline',
      config: {
        retriever: { mode: 'keyword', topK: 3, deduplicate: false },
        llm: { model: 'fixture-chat-a', temperature: 0.2, maxTokens: 200 },
        judge: { model: 'fixture-judge-b' },
      },
    });

    // Run 1 on dataset r1 with both judge-A and judge-B pipelines (retrieval compatible, judge incompatible)
    const exp1 = runs.createExperiment({
      name: 'Judge mismatch run',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id, p2.id],
      mode: 'full_rag',
      config: { judgeEnabled: true },
    });
    const run1 = runs.createRun(
      exp1.id,
      { name: 'Rev 1 full' },
      {
        capabilities: config.capabilities,
        pricing: config.pricing,
        budgets: config.budgets,
      },
    );
    await drain();

    const judgeMismatchRes = await send(
      app,
      'GET',
      `/api/v1/comparisons?baselineRunId=${run1.run.id}&baselinePipelineId=${p1.id}&candidateRunId=${run1.run.id}&candidatePipelineId=${p2.id}`,
    );
    expect(judgeMismatchRes.status).toBe(200);
    const judgeMismatch = c.comparisonResult.parse(judgeMismatchRes.body);
    expect(judgeMismatch.datasetCompatible).toBe(true);
    expect(judgeMismatch.judgeCompatible).toBe(false);
    expect(
      judgeMismatch.incompatibilities.some(
        (i) => i.field === 'resolvedModels.judge',
      ),
    ).toBe(true);
    // Retrieval metrics stay comparable, while judge metrics suppress deltas
    const hit3 = judgeMismatch.metrics.find(
      (m) => m.metricId === 'hit_at_k' && m.cutoff === 3,
    );
    const faith = judgeMismatch.metrics.find(
      (m) => m.metricId === 'faithfulness',
    );
    expect(hit3?.comparable).toBe(true);
    expect(faith?.comparable).toBe(false);
    expect(faith?.absoluteDelta).toBeNull();
    expect(faith?.direction).toBe('not_comparable');

    // Now create dataset revision 2 and run retrieval-only against revision 2 -> dataset incompatibility
    datasets.rename(sample.id, 1, 'RAG fundamentals v2');
    const exp2 = runs.createExperiment({
      name: 'Rev 2 run',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'retrieval_only',
    });
    const run2 = runs.createRun(
      exp2.id,
      { name: 'Rev 2' },
      {
        capabilities: config.capabilities,
        pricing: config.pricing,
        budgets: config.budgets,
      },
    );
    await drain();

    const revMismatchRes = await send(
      app,
      'GET',
      `/api/v1/comparisons?baselineRunId=${run1.run.id}&baselinePipelineId=${p1.id}&candidateRunId=${run2.run.id}&candidatePipelineId=${p1.id}`,
    );
    expect(revMismatchRes.status).toBe(200);
    const revMismatch = c.comparisonResult.parse(revMismatchRes.body);
    expect(revMismatch.compatible).toBe(false);
    expect(revMismatch.datasetCompatible).toBe(false);
    expect(
      revMismatch.incompatibilities.some((i) => i.field === 'datasetRevision'),
    ).toBe(true);
    expect(revMismatch.metrics.every((m) => !m.comparable)).toBe(true);
    expect(revMismatch.metrics.every((m) => m.absoluteDelta === null)).toBe(
      true,
    );
    expect(
      revMismatch.metrics.every((m) => m.direction === 'not_comparable'),
    ).toBe(true);
    // Side-by-side tasks are still present for manual inspection
    expect(revMismatch.tasks.length).toBeGreaterThan(0);
  });

  it('derives /api/v1/documentation from shipped config, metrics, and rubrics without leaking secrets or URLs', async () => {
    const secret = 'super-secret-token-xyz';
    const { app, jobs } = setup({
      OPENAI_API_KEY: secret,
      OPENAI_CHAT_MODEL: 'fixture-doc-chat',
      LOCAL_EMBED_BASE_URL: 'http://internal-embed.invalid/v1',
      LOCAL_EMBED_MODEL: 'fixture-doc-embed',
      RUN_MAX_TOKENS: '50000',
    });
    jobs.presence();

    const res = await send(app, 'GET', '/api/v1/documentation');
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('internal-embed.invalid');

    const doc = c.documentationPayload.parse(res.body);
    expect(doc.capabilities.workerOnline).toBe(true);
    expect(doc.limits.runMaxTokens).toBe(50000);
    expect(doc.evaluation.metrics.map((m) => m.metricId)).toContain(
      'ndcg_at_k',
    );
    const faithfulness = doc.evaluation.metrics.find(
      (m) => m.metricId === 'faithfulness',
    );
    expect(faithfulness?.rubricHash).toMatch(/^[a-f0-9]{64}$/);
    const correctness = doc.evaluation.metrics.find(
      (m) => m.metricId === 'answer_correctness',
    );
    expect(correctness?.passPolicy?.minScore).toBe(0.8);
  });

  it('removes all legacy routes, adapters, and browser callers so the UI uses /api/v1 exclusively', () => {
    for (const removed of [
      '../backend/src/http/legacy.ts',
      '../backend/src/routes/answer.ts',
      '../backend/src/routes/embeddings.ts',
      '../backend/src/routes/judge.ts',
      '../backend/src/routes/search.ts',
      '../frontend/src/data/legacyRunner.ts',
      '../frontend/src/lib/backend.ts',
      '../frontend/src/types/dataset.ts',
      '../frontend/src/types/experiment.ts',
      '../frontend/src/types/pipeline.ts',
    ]) {
      expect(existsSync(new URL(removed, import.meta.url))).toBe(false);
    }

    const frontendSrc = new URL('../frontend/src', import.meta.url).pathname;
    const files = collectFiles(frontendSrc);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(
        /\/api\/(parse|chunks|search|answer|judge)\b/,
      );
    }
  });
});
