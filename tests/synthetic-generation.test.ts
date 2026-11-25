import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { openDatabase, ready } from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Generations } from '../backend/src/db/generations';
import { Indexes } from '../backend/src/db/indexes';
import { Jobs } from '../backend/src/db/jobs';
import { Pipelines } from '../backend/src/db/pipelines';
import { Runs } from '../backend/src/db/runs';
import { EvaluationRunner } from '../backend/src/evaluation/runner';
import { SyntheticGenerator } from '../backend/src/generation/generator';
import {
  computeVerbatimLeakage,
  LEAKAGE_VERBATIM_RATIO_THRESHOLD,
  normalizeQuestionText,
  SYNTHETIC_PROMPT_VERSION,
  validateSourceSpans,
} from '../backend/src/generation/validation';
import { createApp } from '../backend/src/http/app';
import { CloudParser } from '../backend/src/ingestion/cloud';
import { sha256 } from '../backend/src/ingestion/chunks';
import { runOne } from '../backend/src/jobs/run';
import { createLogger } from '../backend/src/lib/logger';
import { ProviderRegistry } from '../backend/src/providers/registry';
import { IndexBuilder } from '../backend/src/retrieval/indexer';
import { RetrievalService } from '../backend/src/retrieval/service';
import { send } from './inProcess';

function openaiChatResponse(
  content: string,
  model = 'fixture-gen-chat',
  requestId = 'req-gen-fixture',
) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-gen-fixture',
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
      usage: { prompt_tokens: 150, completion_tokens: 80, total_tokens: 230 },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
    },
  );
}

function parsePromptMeta(userContent: string) {
  const documentId =
    userContent.match(/^documentId=([a-f0-9-]{36})$/m)?.[1] ?? '';
  const documentVersionId =
    userContent.match(/^documentVersionId=([a-f0-9-]{36})$/m)?.[1] ?? '';
  const documentName =
    userContent.match(/^documentName=(.+)$/m)?.[1]?.trim() ?? '';
  const text =
    userContent.match(/Frozen Document Text:\n"""\n([\s\S]*?)\n"""/)?.[1] ?? '';
  return { documentId, documentVersionId, documentName, text };
}

describe('Phase 9: synthetic test-set generation, validation, dedup, leakage prevention, review, promotion, and HTTP/CORS', () => {
  let dir: string;
  let dbPath: string;
  let db: ReturnType<typeof openDatabase>;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rag-eval-phase9-'));
    dbPath = join(dir, 'workspace.db');
    db = openDatabase(dbPath);
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setupStack(
    env: NodeJS.ProcessEnv = {},
    transports: { openai?: typeof fetch; openaiCompatible?: typeof fetch } = {},
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
    const generations = new Generations(
      db,
      datasets,
      indexes,
      jobs,
      () => clock,
    );
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
    const syntheticGenerator = new SyntheticGenerator({
      generations,
      indexes,
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
      generations,
      providers,
      retrieval,
      logger: createLogger({ write: () => {} }),
      ready: () => true,
      now: () => clock,
    });
    const drain = async (signal?: AbortSignal) => {
      while (
        await runOne(jobs, {
          directory: join(dir, 'blobs'),
          cloud: new CloudParser('', undefined),
          indexes,
          indexBuilder,
          runs,
          evaluationRunner,
          generations,
          syntheticGenerator,
          signal,
        })
      ) {
        clock += 25;
      }
    };
    return {
      config,
      jobs,
      datasets,
      pipelines,
      indexes,
      runs,
      generations,
      providers,
      syntheticGenerator,
      app,
      drain,
    };
  }

  it('upgrades a schema v4 database cleanly to v5 without disturbing existing datasets', () => {
    const oldPath = join(dir, 'v4.db');
    const v4 = openDatabase(oldPath, 4);
    try {
      const sample = new Datasets(v4).sample().value;
      expect(sample.tasks).toHaveLength(10);
    } finally {
      v4.close();
    }
    const upgraded = openDatabase(oldPath);
    try {
      expect(ready(upgraded)).toBe(true);
      const list = new Datasets(upgraded).list(10).items;
      expect(list).toHaveLength(1);
      expect(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='synthetic_proposals'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      upgraded.close();
    }
  });

  it('validates pure span checks, normalization, and verbatim leakage thresholds deterministically', () => {
    const docVersionId = '11111111-1111-4111-8111-111111111111';
    const docId = '22222222-2222-4222-8222-222222222222';
    const sourceText =
      'Vector databases are specialized systems designed for similarity search. Selection factors include latency, scalability, filtering, and ecosystem tooling.';
    const docs = new Map([
      [
        docVersionId,
        {
          documentId: docId,
          documentVersionId: docVersionId,
          name: 'Vector_Database_Guide.txt',
          text: sourceText,
        },
      ],
    ]);

    expect(normalizeQuestionText('  What?! Is — THIS?  ')).toBe('what is this');

    const ok = validateSourceSpans(
      [
        {
          documentVersionId: docVersionId,
          start: 0,
          end: 16,
          quote: 'Vector databases',
        },
      ],
      docs,
    );
    expect(ok.valid).toBe(true);

    // Out-of-bounds offset rejected
    expect(
      validateSourceSpans(
        [
          {
            documentVersionId: docVersionId,
            start: 0,
            end: 999,
            quote: 'Vector',
          },
        ],
        docs,
      ).valid,
    ).toBe(false);

    // Mismatched quote rejected
    expect(
      validateSourceSpans(
        [
          {
            documentVersionId: docVersionId,
            start: 0,
            end: 16,
            quote: 'Different text!!',
          },
        ],
        docs,
      ).valid,
    ).toBe(false);

    // Unknown document version rejected
    expect(
      validateSourceSpans(
        [
          {
            documentVersionId: '99999999-9999-4999-8999-999999999999',
            start: 0,
            end: 6,
            quote: 'Vector',
          },
        ],
        docs,
      ).valid,
    ).toBe(false);

    // Leakage: verbatim copy flagged; short entity answer and paraphrase clear
    const verbatim = computeVerbatimLeakage(
      'Selection factors include latency, scalability, filtering, and ecosystem tooling.',
      [sourceText],
    );
    expect(verbatim.flagged).toBe(true);
    expect(verbatim.score).toBe(1);

    const shortEntity = computeVerbatimLeakage('Similarity search.', [
      sourceText,
    ]);
    expect(shortEntity.flagged).toBe(false);

    const paraphrase = computeVerbatimLeakage(
      'Engineers pick vector stores based on query speed, growth headroom, metadata filters, and tooling.',
      [sourceText],
    );
    expect(paraphrase.flagged).toBe(false);
    expect(paraphrase.score).toBeLessThan(LEAKAGE_VERBATIM_RATIO_THRESHOLD);
  });

  it('stores validated proposals with full provenance, deduplicates normalized questions and overlapping spans, rejects invalid spans, and keeps drafts outside scored datasets', async () => {
    let rawPayloadSent = '';
    let repairAttempted = false;
    const fakeOpenAI: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format?: { json_schema?: { name?: string } };
      };
      expect(body.response_format?.json_schema?.name).toBe(
        'synthetic_test_proposals',
      );
      // Force one malformed JSON response to verify bounded repair
      if (!repairAttempted) {
        repairAttempted = true;
        return openaiChatResponse(
          'not valid json',
          body.model,
          'req-malformed',
        );
      }

      const meta = parsePromptMeta(body.messages[1]?.content ?? '');
      const span1Text = 'proper chunking thresholds, overlap configuration';
      const span1Start = meta.text.indexOf(span1Text);
      const span2Text = 'maintaining up-to-date embeddings.';
      const span2Start = meta.text.indexOf(span2Text);

      rawPayloadSent = JSON.stringify({
        proposals: [
          // 1. Valid clean proposal
          {
            question: 'Which chunking settings improve RAG quality?',
            expectedAnswer:
              'Teams should tune boundary thresholds and chunk overlap settings.',
            acceptanceRule: 'Cover chunking thresholds and overlap.',
            referenceFacts: ['chunking thresholds', 'overlap configuration'],
            answerable: true,
            sourceSpans: [
              {
                documentVersionId: meta.documentVersionId,
                start: span1Start,
                end: span1Start + span1Text.length,
                quote: span1Text,
              },
            ],
            qrels: [{ documentId: meta.documentId, grade: 3 }],
          },
          // 2. Duplicate normalized question (case/punctuation variation) -> deduplicated
          {
            question: '  which chunking settings improve rag quality?! ',
            expectedAnswer: 'Duplicate question variant.',
            acceptanceRule: '',
            referenceFacts: ['chunking thresholds'],
            answerable: true,
            sourceSpans: [
              {
                documentVersionId: meta.documentVersionId,
                start: span2Start,
                end: span2Start + span2Text.length,
                quote: span2Text,
              },
            ],
            qrels: [{ documentId: meta.documentId, grade: 3 }],
          },
          // 3. Different question, but heavily overlapping span with proposal 1 -> deduplicated
          {
            question: 'How should overlap and thresholds be configured?',
            expectedAnswer: 'Configure thresholds and overlap carefully.',
            acceptanceRule: '',
            referenceFacts: ['overlap configuration'],
            answerable: true,
            sourceSpans: [
              {
                documentVersionId: meta.documentVersionId,
                start: span1Start + 7,
                end: span1Start + span1Text.length,
                quote: span1Text.slice(7),
              },
            ],
            qrels: [{ documentId: meta.documentId, grade: 2 }],
          },
          // 4. Invalid span (fabricated quote / wrong offset) -> dropped & counted in invalidSpanCount
          {
            question: 'What fabricated topic appears here?',
            expectedAnswer: 'Fabricated.',
            acceptanceRule: '',
            referenceFacts: ['fabricated'],
            answerable: true,
            sourceSpans: [
              {
                documentVersionId: meta.documentVersionId,
                start: 0,
                end: 10,
                quote: 'WRONGTEXT!',
              },
            ],
            qrels: [{ documentId: meta.documentId, grade: 3 }],
          },
          // 5. Invalid span (out-of-bounds offset) -> dropped & counted in invalidSpanCount
          {
            question: 'What out-of-bounds passage is cited?',
            expectedAnswer: 'Out of bounds.',
            acceptanceRule: '',
            referenceFacts: ['oob'],
            answerable: true,
            sourceSpans: [
              {
                documentVersionId: meta.documentVersionId,
                start: 0,
                end: 9999,
                quote: 'too long',
              },
            ],
            qrels: [{ documentId: meta.documentId, grade: 3 }],
          },
          // 6. Valid non-overlapping span, but verbatim reference answer -> kept AND leakageFlagged!
          {
            question: 'What embedding upkeep is advised for RAG?',
            expectedAnswer: meta.text,
            acceptanceRule: 'Note that embeddings must stay current.',
            referenceFacts: ['maintaining up-to-date embeddings'],
            answerable: true,
            sourceSpans: [
              {
                documentVersionId: meta.documentVersionId,
                start: span2Start,
                end: span2Start + span2Text.length,
                quote: span2Text,
              },
            ],
            qrels: [{ documentId: meta.documentId, grade: 2 }],
          },
          // 7. Existing dataset task duplicate (exact match to sample question) -> deduplicated!
          {
            question:
              'What maintenance practice does the RAG guide recommend for embeddings?',
            expectedAnswer: 'Refresh embeddings regularly.',
            acceptanceRule: '',
            referenceFacts: ['maintaining up-to-date embeddings'],
            answerable: true,
            sourceSpans: [
              {
                documentVersionId: meta.documentVersionId,
                start: 0,
                end: 14,
                quote: 'Best practices',
              },
            ],
            qrels: [{ documentId: meta.documentId, grade: 3 }],
          },
        ],
      });
      return openaiChatResponse(rawPayloadSent, body.model, 'req-gen-valid-1');
    });

    const stack = setupStack(
      {
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_CHAT_MODEL: 'fixture-gen-chat',
      },
      { openai: fakeOpenAI },
    );

    const sample = stack.datasets.sample().value;
    const chunkingDoc = sample.documents.find(
      (d) => d.name === 'RAG_Best_Practices.txt',
    );
    if (!chunkingDoc) throw new Error('Expected RAG_Best_Practices.txt');

    // Start generation against frozen revision 1 for one document with idempotency key
    const startRes = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/generations`,
      {
        datasetRevision: 1,
        documentIds: [chunkingDoc.id],
        count: 5,
        seed: 77,
        temperature: 0.3,
        maxTokens: 1200,
      },
      { 'idempotency-key': 'gen-idem-1' },
    );
    expect(startRes.status).toBe(202);
    const created = c.createGenerationResult.parse(startRes.body);
    expect(startRes.headers.location).toBe(`/api/v1/jobs/${created.job.id}`);
    expect(created.job.kind).toBe('generate');
    expect(created.job.batchId).toBe(created.batch.id);

    // Idempotent replay returns 200 with reused=true; conflicting body returns 409
    const replayRes = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/generations`,
      {
        datasetRevision: 1,
        documentIds: [chunkingDoc.id],
        count: 5,
        seed: 77,
        temperature: 0.3,
        maxTokens: 1200,
      },
      { 'idempotency-key': 'gen-idem-1' },
    );
    expect(replayRes.status).toBe(200);
    expect(c.createGenerationResult.parse(replayRes.body)).toMatchObject({
      reused: true,
      batch: { id: created.batch.id },
      job: { id: created.job.id },
    });
    const conflictRes = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/generations`,
      { datasetRevision: 1, documentIds: [chunkingDoc.id], count: 6, seed: 77 },
      { 'idempotency-key': 'gen-idem-1' },
    );
    expect(conflictRes.status).toBe(409);

    // Rename dataset to revision 2 BEFORE worker executes -> generation stays pinned to frozen revision 1!
    stack.datasets.rename(sample.id, 1, 'RAG fundamentals renamed');

    await stack.drain();

    const batchRes = await send(
      stack.app,
      'GET',
      `/api/v1/generations/${created.batch.id}`,
    );
    expect(batchRes.status).toBe(200);
    const batch = c.generationBatch.parse(batchRes.body);
    expect(batch).toMatchObject({
      state: 'succeeded',
      stage: 'complete',
      datasetRevision: 1,
      provider: 'openai',
      model: 'fixture-gen-chat',
      promptVersion: SYNTHETIC_PROMPT_VERSION,
      totalDocuments: 1,
      processedDocuments: 1,
      proposedCount: 2,
      deduplicatedCount: 3, // duplicate question + overlapping span + existing dataset task
      invalidSpanCount: 2, // wrong quote + out-of-bounds offset
      leakageFlaggedCount: 1,
    });
    expect(repairAttempted).toBe(true);

    // Job status & events reflect completion
    const jobRes = await send(
      stack.app,
      'GET',
      `/api/v1/jobs/${created.job.id}`,
    );
    expect(c.job.parse(jobRes.body).state).toBe('succeeded');

    // Proposals are stored with full provenance
    const propsRes = await send(
      stack.app,
      'GET',
      `/api/v1/datasets/${sample.id}/proposals?batchId=${created.batch.id}`,
    );
    expect(propsRes.status).toBe(200);
    const proposals = c.page(c.syntheticProposal).parse(propsRes.body).items;
    expect(proposals).toHaveLength(2);

    const expectedHash = sha256(rawPayloadSent);
    for (const prop of proposals) {
      expect(prop.reviewStatus).toBe('pending');
      expect(prop.datasetRevision).toBe(1);
      expect(prop.provenance).toMatchObject({
        batchId: created.batch.id,
        provider: 'openai',
        model: 'fixture-gen-chat',
        promptVersion: SYNTHETIC_PROMPT_VERSION,
        documentVersionIds: [chunkingDoc.versionId],
        seed: 77,
        params: {
          temperature: 0.3,
          maxTokens: 1200,
          structuredOutput: true,
          targetCount: 5,
          includeUnanswerable: true,
          leakageThreshold: LEAKAGE_VERBATIM_RATIO_THRESHOLD,
        },
        rawResponseHash: expectedHash,
        requestId: 'req-gen-valid-1',
      });
    }

    // Draft proposals are NEVER auto-scored or visible in dataset tasks or evaluation runs!
    const dsAfter = stack.datasets.get(sample.id);
    expect(dsAfter.tasks).toHaveLength(10);

    const p1 = stack.pipelines.create({
      name: 'Offline check',
      config: { retriever: { mode: 'keyword', topK: 3, deduplicate: false } },
    });
    const exp = stack.runs.createExperiment({
      name: 'Verify drafts excluded',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'retrieval_only',
    });
    const run = stack.runs.createRun(
      exp.id,
      {},
      {
        capabilities: stack.config.capabilities,
        pricing: stack.config.pricing,
        budgets: stack.config.budgets,
      },
    );
    expect(run.run.taskCount).toBe(10);
  });

  it('enforces human review, blocks promotion of leakage-flagged items until edited, and promotes accepted items into a new dataset revision leaving the old revision untouched', async () => {
    const fakeOpenAI: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const meta = parsePromptMeta(body.messages[1]?.content ?? '');
      const s1 = 'proper chunking thresholds, overlap configuration';
      const i1 = meta.text.indexOf(s1);
      const s2 = 'maintaining up-to-date embeddings.';
      const i2 = meta.text.indexOf(s2);
      const s3 = 'Best practices for implementing RAG systems';
      const i3 = meta.text.indexOf(s3);
      return openaiChatResponse(
        JSON.stringify({
          proposals: [
            {
              question: 'Which parameters govern chunk layout in RAG?',
              expectedAnswer:
                'Configure boundary limits and chunk overlap ratios.',
              acceptanceRule: 'Mention thresholds and overlap.',
              referenceFacts: ['chunking thresholds', 'overlap configuration'],
              answerable: true,
              sourceSpans: [
                {
                  documentVersionId: meta.documentVersionId,
                  start: i1,
                  end: i1 + s1.length,
                  quote: s1,
                },
              ],
              qrels: [{ documentId: meta.documentId, grade: 3 }],
            },
            {
              question: 'How should embeddings be maintained in RAG?',
              expectedAnswer: meta.text, // verbatim copy -> leakage flagged!
              acceptanceRule: 'Explain refreshing embeddings.',
              referenceFacts: ['maintaining up-to-date embeddings'],
              answerable: true,
              sourceSpans: [
                {
                  documentVersionId: meta.documentVersionId,
                  start: i2,
                  end: i2 + s2.length,
                  quote: s2,
                },
              ],
              qrels: [{ documentId: meta.documentId, grade: 2 }],
            },
            {
              question: 'Which GPU cluster size is required for RAG?',
              expectedAnswer: 'Not mentioned in the source text.',
              acceptanceRule: 'Abstain.',
              referenceFacts: [],
              answerable: false,
              sourceSpans: [
                {
                  documentVersionId: meta.documentVersionId,
                  start: i3,
                  end: i3 + s3.length,
                  quote: s3,
                },
              ],
              qrels: [{ documentId: meta.documentId, grade: 0 }],
            },
          ],
        }),
        body.model,
      );
    });

    const stack = setupStack(
      {
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_CHAT_MODEL: 'fixture-review-chat',
      },
      { openai: fakeOpenAI },
    );

    const sample = stack.datasets.sample().value;
    const chunkingDoc = sample.documents.find(
      (d) => d.name === 'RAG_Best_Practices.txt',
    );
    if (!chunkingDoc) throw new Error('Missing sample doc');

    const startRes = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/generations`,
      { documentIds: [chunkingDoc.id], count: 3 },
    );
    expect(startRes.status).toBe(202);
    await stack.drain();

    const listed = c
      .page(c.syntheticProposal)
      .parse(
        (
          await send(
            stack.app,
            'GET',
            `/api/v1/datasets/${sample.id}/proposals`,
          )
        ).body,
      ).items;
    expect(listed).toHaveLength(3);

    const clean = listed.find((p) =>
      p.question.includes('govern chunk layout'),
    );
    const leaked = listed.find((p) =>
      p.question.includes('embeddings be maintained'),
    );
    const rejected = listed.find((p) => p.question.includes('GPU cluster'));
    if (!clean || !leaked || !rejected) throw new Error('Missing proposals');

    expect(clean.leakageFlagged).toBe(false);
    expect(leaked.leakageFlagged).toBe(true);
    expect(leaked.leakageScore).toBeGreaterThanOrEqual(
      LEAKAGE_VERBATIM_RATIO_THRESHOLD,
    );
    expect(leaked.leakageReason).toContain('threshold');

    // Cannot promote pending proposal without explicit accept (409)
    const pendingPromote = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/proposals/promote`,
      { proposalIds: [clean.id] },
      { 'if-match': '"1"' },
    );
    expect(pendingPromote.status).toBe(409);

    // Missing If-Match returns 428
    expect(
      (
        await send(
          stack.app,
          'POST',
          `/api/v1/datasets/${sample.id}/proposals/promote`,
          { proposalIds: [clean.id] },
        )
      ).status,
    ).toBe(428);

    // Review: accept clean, accept leaked (without paraphrasing yet), reject GPU question
    const accClean = await send(
      stack.app,
      'PATCH',
      `/api/v1/datasets/${sample.id}/proposals/${clean.id}`,
      { reviewStatus: 'accepted' },
    );
    expect(accClean.status).toBe(200);
    expect(c.syntheticProposal.parse(accClean.body).reviewStatus).toBe(
      'accepted',
    );

    await send(
      stack.app,
      'PATCH',
      `/api/v1/datasets/${sample.id}/proposals/${leaked.id}`,
      { reviewStatus: 'accepted' },
    );
    const rejRes = await send(
      stack.app,
      'PATCH',
      `/api/v1/datasets/${sample.id}/proposals/${rejected.id}`,
      { reviewStatus: 'rejected' },
    );
    expect(c.syntheticProposal.parse(rejRes.body).reviewStatus).toBe(
      'rejected',
    );

    // Promotion of leakage-flagged item MUST be rejected (409) while source text is in target revision!
    const blockedLeak = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/proposals/promote`,
      { proposalIds: [clean.id, leaked.id] },
      { 'if-match': '"1"' },
    );
    expect(blockedLeak.status).toBe(409);
    expect(c.errorEnvelope.parse(blockedLeak.body).error.message).toContain(
      'verbatim answer leakage',
    );
    // Dataset is still at revision 1 (transactional rollback!)
    expect(stack.datasets.get(sample.id).revision).toBe(1);

    // Paraphrase the leaked proposal's expected answer -> leakage flag clears!
    const editedLeakRes = await send(
      stack.app,
      'PATCH',
      `/api/v1/datasets/${sample.id}/proposals/${leaked.id}`,
      {
        expectedAnswer:
          'Teams should refresh vector indexes whenever underlying content changes.',
      },
    );
    expect(editedLeakRes.status).toBe(200);
    const editedLeak = c.syntheticProposal.parse(editedLeakRes.body);
    expect(editedLeak.leakageFlagged).toBe(false);
    expect(editedLeak.edited).toBe(true);

    // Stale revision precondition returns 409 stale_revision
    expect(
      (
        await send(
          stack.app,
          'POST',
          `/api/v1/datasets/${sample.id}/proposals/promote`,
          { proposalIds: [clean.id] },
          { 'if-match': '"99"' },
        )
      ).status,
    ).toBe(409);

    // Promote BOTH accepted proposals into NEW revision 2!
    const promotedRes = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/proposals/promote`,
      { proposalIds: [clean.id, leaked.id] },
      { 'if-match': '"1"' },
    );
    expect(promotedRes.status).toBe(201);
    expect(promotedRes.headers.etag).toBe('"2"');
    const promoted = c.promoteProposalsResult.parse(promotedRes.body);
    expect(promoted.promotedCount).toBe(2);
    expect(promoted.promotedTaskIds).toHaveLength(2);
    expect(promoted.dataset.revision).toBe(2);
    expect(promoted.dataset.tasks).toHaveLength(12);

    // Promoted tasks retain synthetic provenance and graded qrels
    const addedTask = promoted.dataset.tasks.find(
      (t) => t.id === promoted.promotedTaskIds[0],
    );
    expect(addedTask?.provenance).toContain(
      'synthetic:openai/fixture-review-chat',
    );
    expect(addedTask?.qrels).toContainEqual({
      documentId: chunkingDoc.id,
      grade: 3,
    });

    // Old revision 1 is COMPLETELY UNTOUCHED!
    const rev1Res = await send(
      stack.app,
      'GET',
      `/api/v1/datasets/${sample.id}/revisions/1`,
    );
    const rev1 = c.dataset.parse(rev1Res.body);
    expect(rev1.revision).toBe(1);
    expect(rev1.tasks).toHaveLength(10);

    // Already-promoted proposal cannot be modified or promoted twice
    expect(
      (
        await send(
          stack.app,
          'PATCH',
          `/api/v1/datasets/${sample.id}/proposals/${clean.id}`,
          { reviewStatus: 'rejected' },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await send(
          stack.app,
          'POST',
          `/api/v1/datasets/${sample.id}/proposals/promote`,
          { proposalIds: [clean.id] },
          { 'if-match': '"2"' },
        )
      ).status,
    ).toBe(409);
  });

  it('supports cooperative cancellation of queued and running generation jobs and resumes cleanly on retry', async () => {
    let calls = 0;

    const fakeOpenAI: typeof fetch = vi.fn(async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const meta = parsePromptMeta(body.messages[1]?.content ?? '');
      const quote = meta.text.slice(0, 32);
      return openaiChatResponse(
        JSON.stringify({
          proposals: [
            {
              question: `Synthetic question ${calls} about ${meta.documentName}?`,
              expectedAnswer: `Paraphrased summary for document ${calls}.`,
              acceptanceRule: 'Summarize key point.',
              referenceFacts: [`fact ${calls}`],
              answerable: true,
              sourceSpans: [
                {
                  documentVersionId: meta.documentVersionId,
                  start: 0,
                  end: quote.length,
                  quote,
                },
              ],
              qrels: [{ documentId: meta.documentId, grade: 3 }],
            },
          ],
        }),
        body.model,
      );
    });

    const stack = setupStack(
      {
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_CHAT_MODEL: 'fixture-cancel-chat',
      },
      { openai: fakeOpenAI },
    );
    const sample = stack.datasets.sample().value;

    // 1. Queued cancellation
    const queuedStart = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/generations`,
      { count: 3 },
    );
    const queuedCreated = c.createGenerationResult.parse(queuedStart.body);
    const cancelledQueued = await send(
      stack.app,
      'POST',
      `/api/v1/jobs/${queuedCreated.job.id}/cancel`,
      {},
    );
    expect(c.job.parse(cancelledQueued.body).state).toBe('cancelled');
    expect(stack.generations.getBatch(queuedCreated.batch.id).state).toBe(
      'cancelled',
    );
    await stack.drain();
    expect(calls).toBe(0);

    // 2. Running cooperative cancellation right after doc 1 checkpoints
    const runStart = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/generations`,
      { count: 3 },
    );
    const runCreated = c.createGenerationResult.parse(runStart.body);
    const origSave = stack.generations.saveDocumentProposals.bind(
      stack.generations,
    );
    let cancelTriggered = false;
    vi.spyOn(stack.generations, 'saveDocumentProposals').mockImplementation(
      (input, guard) => {
        origSave(input, guard);
        if (!cancelTriggered) {
          cancelTriggered = true;
          stack.jobs.cancel(runCreated.job.id);
        }
      },
    );

    await stack.drain();

    // Stopped after document 1 checkpoint without processing documents 2 and 3!
    expect(calls).toBe(1);
    const cancelledBatch = stack.generations.getBatch(runCreated.batch.id);
    expect(cancelledBatch.state).toBe('cancelled');
    expect(cancelledBatch.processedDocuments).toBe(1);
    expect(stack.jobs.get(runCreated.job.id).state).toBe('cancelled');
    expect(stack.datasets.get(sample.id).revision).toBe(1);

    // 3. Retry resumes only the remaining 2 documents (never re-calling doc 1!)
    const retryRes = await send(
      stack.app,
      'POST',
      `/api/v1/jobs/${runCreated.job.id}/retry`,
      {},
    );
    expect(retryRes.status).toBe(202);
    const retryJob = c.job.parse(retryRes.body);
    expect(retryJob.kind).toBe('generate');
    expect(retryJob.batchId).toBe(runCreated.batch.id);

    await stack.drain();
    expect(calls).toBe(3); // 1 from first run + 2 remaining docs!
    const finishedBatch = stack.generations.getBatch(runCreated.batch.id);
    expect(finishedBatch.state).toBe('succeeded');
    expect(finishedBatch.processedDocuments).toBe(3);
    expect(finishedBatch.proposedCount).toBe(3);
  });

  it('requires a configured chat profile before enqueue and enforces same-origin and cross-origin rules across all generation endpoints', async () => {
    const noChatStack = setupStack({ CORS_ORIGINS: 'https://allowed.example' });
    const sample = noChatStack.datasets.sample().value;

    // Missing chat profile -> 422 missing_capability before enqueue
    const missingCap = await send(
      noChatStack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/generations`,
      { count: 3 },
    );
    expect(missingCap.status).toBe(422);
    expect(c.errorEnvelope.parse(missingCap.body).error.code).toBe(
      'missing_capability',
    );
    expect(noChatStack.generations.listBatches(sample.id, 10).items).toEqual(
      [],
    );

    // Stack with local OpenAI-compatible chat profile & explicit CORS origin
    const fakeLocal: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const meta = parsePromptMeta(body.messages[1]?.content ?? '');
      const quote = meta.text.slice(0, 28);
      return openaiChatResponse(
        JSON.stringify({
          proposals: [
            {
              question: `Origin test question for ${meta.documentName}?`,
              expectedAnswer: 'Paraphrased origin-safe reference answer.',
              acceptanceRule: 'Match summary.',
              referenceFacts: ['origin fact'],
              answerable: true,
              sourceSpans: [
                {
                  documentVersionId: meta.documentVersionId,
                  start: 0,
                  end: quote.length,
                  quote,
                },
              ],
              qrels: [{ documentId: meta.documentId, grade: 3 }],
            },
          ],
        }),
        body.model,
      );
    });

    const stack = setupStack(
      {
        CORS_ORIGINS: 'https://allowed.example',
        LOCAL_CHAT_BASE_URL: 'http://127.0.0.1:11434/v1',
        LOCAL_CHAT_MODEL: 'fixture-local-gen',
        LOCAL_CHAT_SUPPORTS_STRUCTURED_OUTPUT: 'true',
      },
      { openaiCompatible: fakeLocal },
    );
    const doc = sample.documents[0];

    // Foreign origin rejected (403 origin_denied) on start, list, review, promote, and preflight
    for (const [method, path, body] of [
      [
        'POST',
        `/api/v1/datasets/${sample.id}/generations`,
        { documentIds: [doc.id], count: 1 },
      ],
      ['OPTIONS', `/api/v1/datasets/${sample.id}/generations`, undefined],
      ['GET', `/api/v1/datasets/${sample.id}/proposals`, undefined],
      [
        'POST',
        `/api/v1/datasets/${sample.id}/proposals/promote`,
        { proposalIds: ['11111111-1111-4111-8111-111111111111'] },
      ],
    ] as const) {
      const res = await send(stack.app, method, path, body, {
        origin: 'https://evil.example',
      });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(stack.generations.listBatches(sample.id, 10).items).toEqual([]);

    // Same-origin succeeds
    const sameOriginStart = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/generations`,
      { documentIds: [doc.id], count: 1 },
      { origin: 'http://localhost' },
    );
    expect(sameOriginStart.status).toBe(202);
    expect(sameOriginStart.headers['access-control-allow-origin']).toBe(
      'http://localhost',
    );
    await stack.drain();

    // Allowed cross-origin succeeds on list, review PATCH, and promote POST
    const allowedList = await send(
      stack.app,
      'GET',
      `/api/v1/datasets/${sample.id}/proposals`,
      undefined,
      { origin: 'https://allowed.example' },
    );
    expect(allowedList.status).toBe(200);
    expect(allowedList.headers['access-control-allow-origin']).toBe(
      'https://allowed.example',
    );
    const prop = c.page(c.syntheticProposal).parse(allowedList.body).items[0];

    const foreignReview = await send(
      stack.app,
      'PATCH',
      `/api/v1/datasets/${sample.id}/proposals/${prop.id}`,
      { reviewStatus: 'accepted' },
      { origin: 'https://evil.example' },
    );
    expect(foreignReview.status).toBe(403);
    expect(stack.generations.getProposal(sample.id, prop.id).reviewStatus).toBe(
      'pending',
    );

    const allowedReview = await send(
      stack.app,
      'PATCH',
      `/api/v1/datasets/${sample.id}/proposals/${prop.id}`,
      { reviewStatus: 'accepted' },
      { origin: 'https://allowed.example' },
    );
    expect(allowedReview.status).toBe(200);

    const allowedPromote = await send(
      stack.app,
      'POST',
      `/api/v1/datasets/${sample.id}/proposals/promote`,
      { proposalIds: [prop.id] },
      { origin: 'https://allowed.example', 'if-match': '"1"' },
    );
    expect(allowedPromote.status).toBe(201);
    expect(allowedPromote.headers['access-control-allow-origin']).toBe(
      'https://allowed.example',
    );
  });
});
