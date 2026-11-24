import { afterEach, expect, it, vi } from 'vitest';
import { createJudgeHandler } from '../backend/src/routes/judge';
import { invoke } from './handler';

const evaluation = { taskId: 'task-1', question: 'Where?', answer: 'Here.' };
const valid = {
  verdict: 'pass',
  relevance: 1,
  context_precision: 0.75,
  groundedness: 1,
  rationale: 'Matches the reference.',
  missing_criteria: [],
};
const usage = { promptTokens: 8, completionTokens: 2, totalTokens: 10 };

afterEach(() => {
  vi.useRealTimers();
});

it('keeps valid zeros and uses only completed judgments in the denominator', async () => {
  vi.useFakeTimers({ now: 0 });
  const chatCompletion = vi
    .fn()
    .mockImplementationOnce(async () => {
      vi.advanceTimersByTime(40);
      return { content: JSON.stringify(valid), usage };
    })
    .mockRejectedValueOnce(new Error('fixture timeout'))
    .mockResolvedValueOnce({ content: 'invalid JSON', usage })
    .mockResolvedValueOnce({
      content: JSON.stringify({
        ...valid,
        verdict: 'review',
        relevance: 0,
        context_precision: 0,
      }),
      usage,
    });
  const evaluations = Array.from({ length: 4 }, (_, i) => ({
    ...evaluation,
    taskId: String(i),
  }));
  const { body } = await invoke(createJudgeHandler({ chatCompletion }), {
    pipelineId: 'p',
    evaluations,
  });
  expect(body).toMatchObject({
    coverage: { completed: 2, total: 4 },
    judgePassRate: 0.5,
    averageScores: {
      relevance: 0.5,
      judgedContextPrecision: 0.375,
      groundedness: 1,
    },
    tokensUsed: 30,
    latencyMs: 40,
  });
  expect(body.details[1]).toMatchObject({
    taskId: '1',
    scores: null,
    verdict: 'unavailable',
  });
  expect(body.details[2]).toMatchObject({
    taskId: '2',
    scores: null,
    verdict: 'unavailable',
    usage,
  });
});

it.each([
  { relevance: null },
  { context_precision: '1' },
  { groundedness: -0.1 },
  { groundedness: 1.01 },
  { verdict: 'maybe' },
  { relevance: undefined },
  { rationale: '' },
  { missing_criteria: [1] },
])(
  'returns unavailable with no score for an invalid decision %j',
  async (invalid) => {
    const chatCompletion = vi
      .fn()
      .mockResolvedValue({ content: JSON.stringify({ ...valid, ...invalid }) });
    const { body } = await invoke(createJudgeHandler({ chatCompletion }), {
      pipelineId: 'p',
      evaluations: [evaluation],
    });
    expect(body).toMatchObject({
      verdict: 'unavailable',
      coverage: { completed: 0, total: 1 },
      judgePassRate: null,
      averageScores: {
        relevance: null,
        judgedContextPrecision: null,
        groundedness: null,
      },
    });
    expect(body.details[0].scores).toBeNull();
  },
);
