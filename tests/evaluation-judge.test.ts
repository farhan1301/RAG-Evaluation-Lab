import { describe, expect, it, vi } from 'vitest';
import type { RecordedContextItem } from '@rag-eval/contracts';
import {
  evaluateJudgeMetric,
  type JudgeTaskInput,
} from '../backend/src/evaluation/judge';
import { loadRubrics } from '../backend/src/evaluation/rubrics';
import { sha256 } from '../backend/src/ingestion/chunks';
import { ProviderError } from '../backend/src/providers/errors';
import type { ChatProvider, ChatRequest } from '../backend/src/providers/types';

const context: RecordedContextItem[] = [
  {
    index: 1,
    chunkId: '11111111-1111-4111-8111-111111111111',
    documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    documentName: 'Embedding_Models_Comparison.txt',
    page: 1,
    start: 0,
    end: 100,
    content:
      'text-embedding-3-small balances cost and performance for many workloads.',
    truncated: false,
  },
  {
    index: 2,
    chunkId: '22222222-2222-4222-8222-222222222222',
    documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    documentName: 'Vector_Database_Guide.txt',
    page: 1,
    start: 0,
    end: 90,
    content:
      'Vector databases support similarity search, filtering, and ecosystem tooling.',
    truncated: false,
  },
];

const sampleTask: JudgeTaskInput = {
  question: 'Which embedding model balances cost and performance?',
  answerable: true,
  expectedAnswer: 'text-embedding-3-small',
  acceptanceRule: 'Name the embedding model explicitly.',
  referenceFacts: [
    'text-embedding-3-small balances cost and performance',
    'works for many workloads',
  ],
  retrievalFailed: false,
  generationFailed: false,
  answerText:
    'text-embedding-3-small balances cost and performance and uses 9999 dimensions.',
  abstained: false,
  context,
};

function makeFakeProvider(
  responses: Array<string | Error>,
  opts: { temperature?: boolean; structuredOutput?: boolean } = {},
) {
  const requests: ChatRequest[] = [];
  let idx = 0;
  const provider: ChatProvider = {
    kind: 'openai',
    capabilities: {
      chat: true,
      embeddings: false,
      rerank: false,
      structuredOutput: opts.structuredOutput ?? true,
      temperature: opts.temperature ?? true,
      maxTemperature: opts.temperature === false ? null : 2,
      maxTokens: true,
      requiresMaxTokens: false,
    },
    chat: vi.fn(async (req: ChatRequest) => {
      requests.push(req);
      const next = responses[Math.min(idx++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return {
        content: next,
        model: req.model,
        provider: 'openai' as const,
        requestId: `req-${idx}`,
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        effectiveParams: {
          ...(req.temperature !== undefined
            ? { temperature: req.temperature }
            : {}),
          maxTokens: req.maxTokens,
          structuredOutput: opts.structuredOutput ?? true,
        },
      };
    }),
  };
  return { provider, requests };
}

describe('structured LLM-judge metrics and versioned rubrics', () => {
  it('loads all five versioned rubric files with deterministic hashes', () => {
    const rubrics = loadRubrics();
    expect(Object.keys(rubrics).sort()).toEqual([
      'answer_correctness',
      'answer_relevance',
      'context_precision',
      'context_recall',
      'faithfulness',
    ]);
    for (const rubric of Object.values(rubrics)) {
      expect(rubric.version).toMatch(/-v1$/);
      expect(rubric.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('scores all five metrics from validated structured item decisions and records model, rubric version, and raw-response hash', async () => {
    // 1. Faithfulness: 1 supported, 1 unsupported -> 0.5
    const faithRaw = JSON.stringify({
      refused: false,
      reason: '',
      claims: [
        {
          claim: 'text-embedding-3-small balances cost and performance',
          verdict: 'supported',
          evidenceChunkIds: [context[0].chunkId],
          quote: 'text-embedding-3-small balances cost and performance',
        },
        {
          claim: 'uses 9999 dimensions',
          verdict: 'unsupported',
          evidenceChunkIds: [],
          quote: '',
        },
      ],
    });
    const faithFake = makeFakeProvider([faithRaw]);
    const faith = await evaluateJudgeMetric({
      metricId: 'faithfulness',
      task: sampleTask,
      provider: faithFake.provider,
      model: 'judge-model-a',
    });
    expect(faith.observation.status).toBe('scored');
    expect(faith.observation.value).toBe(0.5);
    expect(faith.observation.metadata).toMatchObject({
      judgeModel: 'judge-model-a',
      rubricVersion: 'faithfulness-v1',
      rawResponseHash: sha256(faithRaw),
    });
    // Low temperature preserved when supported
    expect(faithFake.requests[0]?.temperature).toBe(0);

    // 2. Answer relevance: grade 3 -> 3/4 = 0.75, blinded to context and reference answer
    const relRaw = JSON.stringify({
      refused: false,
      grade: 3,
      rationale: 'Directly names the model with an extraneous claim.',
    });
    const relFake = makeFakeProvider([relRaw], { temperature: false });
    const rel = await evaluateJudgeMetric({
      metricId: 'answer_relevance',
      task: sampleTask,
      provider: relFake.provider,
      model: 'judge-no-temp',
    });
    expect(rel.observation.status).toBe('scored');
    expect(rel.observation.value).toBe(0.75);
    // Temperature omitted when profile does not support temperature
    expect(relFake.requests[0]?.temperature).toBeUndefined();
    // Answer relevance prompt should NOT contain retrieved context passages
    expect(relFake.requests[0]?.messages[1]?.content).not.toContain(
      context[1].chunkId,
    );

    // 3. Context precision: 1 of 2 passages useful -> 0.5
    const cpRaw = JSON.stringify({
      refused: false,
      reason: '',
      passages: [
        {
          chunkId: context[0].chunkId,
          useful: true,
          rationale: 'Directly answers.',
        },
        {
          chunkId: context[1].chunkId,
          useful: false,
          rationale: 'About vector DBs.',
        },
      ],
    });
    const cp = await evaluateJudgeMetric({
      metricId: 'context_precision',
      task: sampleTask,
      provider: makeFakeProvider([cpRaw]).provider,
      model: 'judge-model-a',
    });
    expect(cp.observation.status).toBe('scored');
    expect(cp.observation.value).toBe(0.5);

    // 4. Context recall: 2 of 2 facts supported -> 1.0
    const crRaw = JSON.stringify({
      refused: false,
      reason: '',
      facts: [
        {
          factIndex: 1,
          supported: true,
          evidenceChunkIds: [context[0].chunkId],
          rationale: 'Supported by passage 1.',
        },
        {
          factIndex: 2,
          supported: true,
          evidenceChunkIds: [context[0].chunkId],
          rationale: 'Supported by passage 1.',
        },
      ],
    });
    const cr = await evaluateJudgeMetric({
      metricId: 'context_recall',
      task: sampleTask,
      provider: makeFakeProvider([crRaw]).provider,
      model: 'judge-model-a',
    });
    expect(cr.observation.status).toBe('scored');
    expect(cr.observation.value).toBe(1);

    // 5. Answer correctness: 1 satisfied, 1 omitted, criticalContradiction=true -> score 0.5, passed=false
    const acRaw = JSON.stringify({
      refused: false,
      facts: [
        { factIndex: 1, status: 'satisfied', rationale: 'Stated.' },
        { factIndex: 2, status: 'omitted', rationale: 'Not mentioned.' },
      ],
      criticalContradiction: true,
      acceptanceCriteriaMet: false,
      rationale: 'Contradicts known dimensions.',
    });
    const ac = await evaluateJudgeMetric({
      metricId: 'answer_correctness',
      task: sampleTask,
      provider: makeFakeProvider([acRaw]).provider,
      model: 'judge-model-a',
    });
    expect(ac.observation.status).toBe('scored');
    expect(ac.observation.value).toBe(0.5);
    expect(ac.observation.metadata).toMatchObject({
      criticalContradiction: true,
      passed: false,
    });
  });

  it('permits one bounded repair attempt on malformed/unresolved output and retains both attempts', async () => {
    const badRaw = JSON.stringify({
      refused: false,
      reason: '',
      passages: [
        {
          chunkId: '99999999-9999-4999-8999-999999999999',
          useful: true,
          rationale: 'Hallucinated ID.',
        },
      ],
    });
    const repairedRaw = JSON.stringify({
      refused: false,
      reason: '',
      passages: [
        { chunkId: context[0].chunkId, useful: true, rationale: 'Relevant.' },
        {
          chunkId: context[1].chunkId,
          useful: false,
          rationale: 'Irrelevant.',
        },
      ],
    });
    const { provider } = makeFakeProvider([badRaw, repairedRaw]);
    const result = await evaluateJudgeMetric({
      metricId: 'context_precision',
      task: sampleTask,
      provider,
      model: 'judge-model-a',
    });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      attemptNumber: 1,
      isRepair: false,
      isRetry: false,
      status: 'unresolved_evidence',
      rawResponseHash: sha256(badRaw),
      score: null,
    });
    expect(result.attempts[1]).toMatchObject({
      attemptNumber: 2,
      isRepair: true,
      isRetry: true,
      status: 'succeeded',
      rawResponseHash: sha256(repairedRaw),
      score: 0.5,
    });
    expect(result.observation).toMatchObject({
      status: 'scored',
      value: 0.5,
    });
  });

  it('yields null observation with recorded reason (never zero) on persistent malformed, refused, or failed judgments', async () => {
    // Persistent malformed JSON
    const malformed = await evaluateJudgeMetric({
      metricId: 'answer_relevance',
      task: sampleTask,
      provider: makeFakeProvider(['not json', '{"bad": true}']).provider,
      model: 'judge-model-a',
    });
    expect(malformed.attempts).toHaveLength(2);
    expect(malformed.observation).toMatchObject({
      status: 'judge_malformed',
      value: null,
    });
    expect(malformed.observation.reason).toBeTruthy();
    expect(malformed.observation.metadata.rawResponseHash).toBe(
      sha256('{"bad": true}'),
    );

    // Explicit refusal stops without repair
    const refusedRaw = JSON.stringify({
      refused: true,
      grade: 0,
      rationale: 'Policy refusal fixture.',
    });
    const refused = await evaluateJudgeMetric({
      metricId: 'answer_relevance',
      task: sampleTask,
      provider: makeFakeProvider([refusedRaw]).provider,
      model: 'judge-model-a',
    });
    expect(refused.attempts).toHaveLength(1);
    expect(refused.observation).toMatchObject({
      status: 'judge_refused',
      value: null,
      reason: 'Policy refusal fixture.',
    });

    // Post-dispatch timeout MUST NOT auto-retry (provider cannot deduplicate); recorded as ambiguous timeout with null value
    const timedOut = await evaluateJudgeMetric({
      metricId: 'answer_relevance',
      task: sampleTask,
      provider: makeFakeProvider([
        new ProviderError('timeout', 'Timed out.', { retryable: true }),
        new ProviderError('timeout', 'Should not be dispatched.', {
          retryable: true,
        }),
      ]).provider,
      model: 'judge-model-a',
      maxTransientRetries: 1,
    });
    expect(timedOut.attempts).toHaveLength(1);
    expect(timedOut.attempts[0]).toMatchObject({
      status: 'timeout',
      callStatus: 'ambiguous',
      errorCode: 'timeout',
      isRetry: false,
    });
    expect(timedOut.observation).toMatchObject({
      status: 'judge_timeout',
      value: null,
    });

    // Retryable non-timeout upstream rejection (e.g. HTTP 429) STILL retries transiently
    const throttled = await evaluateJudgeMetric({
      metricId: 'answer_relevance',
      task: sampleTask,
      provider: makeFakeProvider([
        new ProviderError('upstream_failure', 'Rate limited.', {
          status: 429,
          retryable: true,
        }),
        JSON.stringify({ refused: false, grade: 4, rationale: 'Good.' }),
      ]).provider,
      model: 'judge-model-a',
      maxTransientRetries: 1,
    });
    expect(throttled.attempts).toHaveLength(2);
    expect(throttled.attempts[1]?.isRetry).toBe(true);
    expect(throttled.observation).toMatchObject({
      status: 'scored',
      value: 1,
    });

    // Missing prerequisites never invent zeros (except empty retrieval on context precision/recall)
    const missingFacts = await evaluateJudgeMetric({
      metricId: 'context_recall',
      task: { ...sampleTask, referenceFacts: [] },
      provider: makeFakeProvider([]).provider,
      model: 'judge-model-a',
    });
    expect(missingFacts.attempts).toHaveLength(0);
    expect(missingFacts.observation).toMatchObject({
      status: 'missing_reference_facts',
      value: null,
    });

    const emptyRetrievalPrecision = await evaluateJudgeMetric({
      metricId: 'context_precision',
      task: { ...sampleTask, context: [] },
      provider: makeFakeProvider([]).provider,
      model: 'judge-model-a',
    });
    expect(emptyRetrievalPrecision.attempts).toHaveLength(0);
    expect(emptyRetrievalPrecision.observation).toMatchObject({
      status: 'scored',
      value: 0,
    });
  });
});
