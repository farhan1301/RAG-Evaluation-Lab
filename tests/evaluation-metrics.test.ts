import { describe, expect, it } from 'vitest';
import type { PriceSchedule } from '@rag-eval/contracts';
import {
  aggregateMetricObservations,
  collapseDocuments,
  computeLatencyStats,
  dcgDiscount,
  dcgGain,
  evaluateTaskAbstention,
  evaluateTaskRetrieval,
} from '../backend/src/evaluation/metrics';
import {
  aggregateCostAndTokens,
  priceProviderCall,
} from '../backend/src/evaluation/pricing';

describe('deterministic retrieval metrics', () => {
  it('matches the PLAN.md hand-calculated regression fixture (gold={A,B}, k=3, results=[X,A])', () => {
    const obs = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: true,
      pool: 'complete',
      qrels: [
        { documentId: 'A', grade: 1 },
        { documentId: 'B', grade: 1 },
        { documentId: 'X', grade: 0 },
      ],
      retrievedChunks: [
        { chunkId: 'c1', documentId: 'X' },
        { chunkId: 'c2', documentId: 'A' },
      ],
      evaluatedDepth: 3,
      cutoffs: [3],
    });

    const byMetric = Object.fromEntries(
      obs.map((o) => [`${o.metricId}@${o.cutoff}`, o]),
    );
    const expectedNdcg = 1 / Math.log2(3) / (1 + 1 / Math.log2(3));

    expect(byMetric['hit_at_k@3']).toMatchObject({
      status: 'scored',
      value: 1,
    });
    expect(byMetric['precision_at_k@3']?.value).toBeCloseTo(1 / 3, 12);
    expect(byMetric['recall_at_k@3']?.value).toBeCloseTo(1 / 2, 12);
    expect(byMetric['mrr_at_k@3']?.value).toBeCloseTo(1 / 2, 12);
    expect(byMetric['mrr@0']?.value).toBeCloseTo(1 / 2, 12);
    expect(byMetric['ndcg_at_k@3']?.value).toBeCloseTo(expectedNdcg, 12);
    expect(byMetric['ndcg_at_k@3']?.value).toBeCloseTo(0.387, 3);
  });

  it('computes graded nDCG@k with gain (2^g - 1) and discount log2(i + 1)', () => {
    // Gold: A=3 (gain 7), B=2 (gain 3), C=1 (gain 1), D=0 (gain 0)
    // Returned: [C, A, X] at k=3
    // DCG@3  = 1/log2(2) + 7/log2(3) + 0/log2(4)
    // IDCG@3 = 7/log2(2) + 3/log2(3) + 1/log2(4)
    const expectedDcg =
      dcgGain(1) / dcgDiscount(1) + dcgGain(3) / dcgDiscount(2);
    const expectedIdcg =
      dcgGain(3) / dcgDiscount(1) +
      dcgGain(2) / dcgDiscount(2) +
      dcgGain(1) / dcgDiscount(3);

    const obs = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: true,
      pool: 'complete',
      qrels: [
        { documentId: 'A', grade: 3 },
        { documentId: 'B', grade: 2 },
        { documentId: 'C', grade: 1 },
        { documentId: 'D', grade: 0 },
      ],
      retrievedChunks: [
        { chunkId: 'c1', documentId: 'C' },
        { chunkId: 'c2', documentId: 'A' },
        { chunkId: 'c3', documentId: 'X' },
      ],
      evaluatedDepth: 3,
      cutoffs: [3],
    });
    const byMetric = Object.fromEntries(
      obs.map((o) => [`${o.metricId}@${o.cutoff}`, o]),
    );
    expect(byMetric['hit_at_k@3']?.value).toBe(1);
    expect(byMetric['precision_at_k@3']?.value).toBeCloseTo(2 / 3, 12);
    expect(byMetric['recall_at_k@3']?.value).toBeCloseTo(2 / 3, 12);
    expect(byMetric['mrr_at_k@3']?.value).toBe(1);
    expect(byMetric['ndcg_at_k@3']?.value).toBeCloseTo(
      expectedDcg / expectedIdcg,
      12,
    );
  });

  it('collapses repeated document chunks at first occurrence without double-counting', () => {
    expect(
      collapseDocuments([
        { documentId: 'A' },
        { documentId: 'A' },
        { documentId: 'B' },
        { documentId: 'A' },
      ]),
    ).toEqual(['A', 'B']);

    const obs = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: true,
      pool: 'complete',
      qrels: [
        { documentId: 'A', grade: 0 },
        { documentId: 'B', grade: 3 },
      ],
      retrievedChunks: [
        { chunkId: 'a1', documentId: 'A' },
        { chunkId: 'a2', documentId: 'A' },
        { chunkId: 'b1', documentId: 'B' },
      ],
      evaluatedDepth: 3,
      cutoffs: [2],
    });
    const byMetric = Object.fromEntries(
      obs.map((o) => [`${o.metricId}@${o.cutoff}`, o]),
    );
    // Collapsed list is [A, B], so B is at document rank 2 (inside k=2!).
    expect(byMetric['hit_at_k@2']?.value).toBe(1);
    expect(byMetric['precision_at_k@2']?.value).toBeCloseTo(1 / 2, 12);
    expect(byMetric['recall_at_k@2']?.value).toBe(1);
    expect(byMetric['mrr_at_k@2']?.value).toBeCloseTo(1 / 2, 12);
    expect(byMetric['ndcg_at_k@2']?.value).toBeCloseTo(
      7 / Math.log2(3) / 7,
      12,
    );
  });

  it('handles edge cases: k > results, empty retrieval, no relevant docs, missing qrels, unanswerable, failed, partial pool', () => {
    // 1. k larger than returned results
    const largeK = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: true,
      pool: 'complete',
      qrels: [
        { documentId: 'A', grade: 3 },
        { documentId: 'B', grade: 2 },
      ],
      retrievedChunks: [{ chunkId: 'c1', documentId: 'A' }],
      evaluatedDepth: 5,
      cutoffs: [5],
    });
    const largeKMap = Object.fromEntries(
      largeK.map((o) => [`${o.metricId}@${o.cutoff}`, o]),
    );
    expect(largeKMap['precision_at_k@5']?.value).toBeCloseTo(1 / 5, 12);
    expect(largeKMap['recall_at_k@5']?.value).toBeCloseTo(1 / 2, 12);
    expect(largeKMap['ndcg_at_k@5']?.value).toBeCloseTo(
      7 / (7 + 3 / Math.log2(3)),
      12,
    );

    // 2. Empty successful retrieval on an eligible task gets 0 (not null!)
    const emptyRes = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: true,
      pool: 'complete',
      qrels: [{ documentId: 'A', grade: 2 }],
      retrievedChunks: [],
      evaluatedDepth: 5,
      cutoffs: [3],
    });
    for (const o of emptyRes) {
      expect(o.status).toBe('scored');
      expect(o.value).toBe(0);
    }

    // 3. No relevant docs (all grade 0) -> no_relevant_docs, value null
    const noRel = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: true,
      pool: 'complete',
      qrels: [{ documentId: 'A', grade: 0 }],
      retrievedChunks: [{ chunkId: 'c1', documentId: 'A' }],
      evaluatedDepth: 3,
      cutoffs: [3],
    });
    for (const o of noRel) {
      expect(o.status).toBe('no_relevant_docs');
      expect(o.value).toBeNull();
    }

    // 4. Missing qrels -> missing_qrels, value null
    const noQrels = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: true,
      pool: 'partial',
      qrels: [],
      retrievedChunks: [{ chunkId: 'c1', documentId: 'A' }],
      evaluatedDepth: 3,
      cutoffs: [3],
    });
    for (const o of noQrels) {
      expect(o.status).toBe('missing_qrels');
      expect(o.value).toBeNull();
    }

    // 5. Unanswerable task -> unanswerable, value null
    const unans = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: false,
      pool: 'complete',
      qrels: [{ documentId: 'A', grade: 0 }],
      retrievedChunks: [{ chunkId: 'c1', documentId: 'A' }],
      evaluatedDepth: 3,
      cutoffs: [3],
    });
    for (const o of unans) {
      expect(o.status).toBe('unanswerable');
      expect(o.value).toBeNull();
    }

    // 6. Failed retrieval -> retrieval_failed, value null
    const failed = evaluateTaskRetrieval({
      retrievalFailed: true,
      retrievalError: 'Qdrant timed out.',
      answerable: true,
      pool: 'complete',
      qrels: [{ documentId: 'A', grade: 3 }],
      retrievedChunks: [],
      evaluatedDepth: 3,
      cutoffs: [3],
    });
    for (const o of failed) {
      expect(o.status).toBe('retrieval_failed');
      expect(o.value).toBeNull();
      expect(o.reason).toContain('Qdrant timed out');
    }

    // 7. Partial pool reports judgedCoverage and pooledEstimate=true
    const partial = evaluateTaskRetrieval({
      retrievalFailed: false,
      answerable: true,
      pool: 'partial',
      qrels: [{ documentId: 'A', grade: 2 }],
      retrievedChunks: [
        { chunkId: 'c1', documentId: 'A' },
        { chunkId: 'c2', documentId: 'UNJUDGED' },
      ],
      evaluatedDepth: 3,
      cutoffs: [2],
    });
    const hit2 = partial.find((o) => o.metricId === 'hit_at_k');
    expect(hit2?.metadata).toMatchObject({
      pool: 'partial',
      pooledEstimate: true,
      judgedCoverage: 0.5,
      evaluatedDepth: 3,
    });
  });

  it('evaluates abstention separately for answerable vs unanswerable tasks and aggregates cleanly', () => {
    const a1 = evaluateTaskAbstention({
      answerable: true,
      generationFailed: false,
      abstained: false,
    });
    const a2 = evaluateTaskAbstention({
      answerable: true,
      generationFailed: false,
      abstained: true,
    });
    const u1 = evaluateTaskAbstention({
      answerable: false,
      generationFailed: false,
      abstained: true,
    });
    const u2 = evaluateTaskAbstention({
      answerable: false,
      generationFailed: true,
      generationError: 'timeout',
    });

    expect(a1).toMatchObject({
      metricId: 'abstention_answerable',
      status: 'scored',
      value: 1,
    });
    expect(a2).toMatchObject({
      metricId: 'abstention_answerable',
      status: 'scored',
      value: 0,
    });
    expect(u1).toMatchObject({
      metricId: 'abstention_unanswerable',
      status: 'scored',
      value: 1,
    });
    expect(u2).toMatchObject({
      metricId: 'abstention_unanswerable',
      status: 'generation_failed',
      value: null,
    });

    const agg = aggregateMetricObservations([a1, a2, u1, u2]);
    const ansGroup = agg.find((m) => m.metricId === 'abstention_answerable');
    const unansGroup = agg.find(
      (m) => m.metricId === 'abstention_unanswerable',
    );
    expect(ansGroup).toMatchObject({
      mean: 0.5,
      eligibleCount: 2,
      totalCount: 2,
    });
    expect(unansGroup).toMatchObject({
      mean: 1,
      eligibleCount: 1,
      totalCount: 2,
      failedCount: 1,
    });
  });

  it('computes nearest-rank p50 and p95 latency stats', () => {
    expect(computeLatencyStats([])).toEqual({
      sampleSize: 0,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
    });
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(computeLatencyStats(samples)).toEqual({
      sampleSize: 10,
      meanMs: 55,
      p50Ms: 50,
      p95Ms: 100,
    });
  });
});

describe('pricing and cost aggregation', () => {
  const schedule: PriceSchedule = {
    version: 'test-v1',
    currency: 'USD',
    entries: [
      {
        model: 'fixture-chat',
        provider: 'openai',
        unit: 'per_1m_tokens',
        inputUsd: 2.0,
        outputUsd: 8.0,
        cacheReadUsd: 0.5,
      },
      {
        model: 'fixture-claude',
        provider: 'anthropic',
        unit: 'per_1m_tokens',
        inputUsd: 3.0,
        outputUsd: 15.0,
        cacheReadUsd: 0.3,
        cacheCreationUsd: 3.75,
      },
      {
        model: 'fixture-embed',
        unit: 'per_1k_tokens',
        inputUsd: 0.0001,
      },
      {
        model: 'fixture-rerank',
        provider: 'http',
        unit: 'per_request',
        requestUsd: 0.002,
      },
    ],
  };

  it('prices configured models accurately and marks unconfigured models or missing usage as unknown', () => {
    // OpenAI: 1000 prompt tokens of which 200 are cached -> 800 * $2/1M + 200 * $0.5/1M + 500 * $8/1M
    const openaiCall = priceProviderCall(schedule, {
      provider: 'openai',
      model: 'fixture-chat',
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadTokens: 200,
      },
    });
    expect(openaiCall.costStatus).toBe('known');
    expect(openaiCall.costUsd).toBeCloseTo(
      (800 * 2 + 200 * 0.5 + 500 * 8) / 1_000_000,
      12,
    );

    // Anthropic: input_tokens is non-cached; cacheRead and cacheCreation billed additively.
    const anthropicCall = priceProviderCall(schedule, {
      provider: 'anthropic',
      model: 'fixture-claude',
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        cacheReadTokens: 500,
        cacheCreationTokens: 400,
      },
    });
    expect(anthropicCall.costStatus).toBe('known');
    expect(anthropicCall.costUsd).toBeCloseTo(
      (1000 * 3 + 500 * 0.3 + 400 * 3.75 + 200 * 15) / 1_000_000,
      12,
    );

    // Unconfigured model MUST be unknown, never estimated.
    expect(
      priceProviderCall(schedule, {
        provider: 'openai',
        model: 'unconfigured-model',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    ).toEqual({
      usageStatus: 'known',
      priceVersion: 'test-v1',
      costStatus: 'unknown',
      costUsd: null,
    });

    // Missing usage MUST be unknown for token-based pricing.
    expect(
      priceProviderCall(schedule, {
        provider: 'openai',
        model: 'fixture-chat',
      }),
    ).toEqual({
      usageStatus: 'missing',
      priceVersion: 'test-v1',
      costStatus: 'unknown',
      costUsd: null,
    });

    // Per-request reranker pricing works even without token usage.
    expect(
      priceProviderCall(schedule, {
        provider: 'http',
        model: 'fixture-rerank',
      }),
    ).toEqual({
      usageStatus: 'missing',
      priceVersion: 'test-v1',
      costStatus: 'known',
      costUsd: 0.002,
    });
  });

  it('separates indexing, serving, judging, and retry spend and reports partial coverage honestly', () => {
    const { cost, tokens } = aggregateCostAndTokens(
      [
        {
          operation: 'corpus_embed',
          model: 'fixture-embed',
          isRetry: false,
          inputTokens: 2000,
          outputTokens: 0,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: 2000,
          usageStatus: 'known',
          costStatus: 'known',
          costUsd: 0.0002,
        },
        {
          operation: 'generate',
          model: 'fixture-chat',
          isRetry: false,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: 1500,
          usageStatus: 'known',
          costStatus: 'known',
          costUsd: 0.006,
        },
        {
          operation: 'generate',
          model: 'fixture-chat',
          isRetry: true,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: 1500,
          usageStatus: 'known',
          costStatus: 'known',
          costUsd: 0.006,
        },
        {
          operation: 'judge',
          model: 'unpriced-judge',
          isRetry: false,
          inputTokens: 400,
          outputTokens: 100,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: 500,
          usageStatus: 'known',
          costStatus: 'unknown',
          costUsd: null,
        },
      ],
      'test-v1',
      2,
    );

    expect(cost.indexing).toMatchObject({ status: 'known', totalUsd: 0.0002 });
    expect(cost.serving).toMatchObject({ status: 'known', totalUsd: 0.006 });
    expect(cost.perQueryServing).toMatchObject({
      status: 'known',
      usdPerQuery: 0.003,
      queryCount: 2,
    });
    expect(cost.retry).toMatchObject({ status: 'known', totalUsd: 0.006 });
    expect(cost.judging).toMatchObject({
      status: 'unknown',
      totalUsd: null,
      pricedCalls: 0,
      totalCalls: 1,
      unpricedModels: ['unpriced-judge'],
    });
    expect(cost.total).toMatchObject({
      status: 'partial',
      totalUsd: null,
      pricedCalls: 3,
      totalCalls: 4,
      unpricedModels: ['unpriced-judge'],
    });
    expect(cost.total.knownUsd).toBeCloseTo(0.0122, 12);
    expect(tokens.totalTokens).toBe(5500);
    expect(tokens.retryTokens).toBe(1500);
  });
});
