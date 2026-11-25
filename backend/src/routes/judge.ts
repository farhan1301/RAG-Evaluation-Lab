import type { Request, Response } from 'express';

export interface LegacyChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LegacyChatResponse {
  content: string;
  usage?: LegacyChatUsage;
}

export interface LegacyChatClient {
  chatCompletion(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      responseFormat?:
        | { type: 'json_object' }
        | {
            type: 'json_schema';
            name: string;
            schema: Record<string, unknown>;
          };
    },
  ): Promise<LegacyChatResponse>;
}

interface JudgeEvaluationInput {
  taskId: string;
  question: string;
  answer: string;
  expectedAnswer?: string;
  acceptanceRule?: string;
  context?: string[];
}

interface JudgeRequestBody {
  pipelineId: string;
  model?: string;
  evaluations: JudgeEvaluationInput[];
}

interface JudgeScores {
  relevance: number;
  judgedContextPrecision: number;
  groundedness: number;
}

interface JudgeDetailResponse extends JudgeScores {
  verdict: 'pass' | 'review';
  rationale: string;
  missingCriteria: string[];
}

interface JudgeDetail {
  taskId: string;
  verdict: 'pass' | 'review' | 'unavailable';
  scores: JudgeScores | null;
  rationale: string;
  missingCriteria: string[];
  latencyMs: number;
  usage?: LegacyChatUsage;
}

const score = (value: unknown) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error('Invalid judge score.');
  }
  return value;
};

const buildJudgePrompt = (input: JudgeEvaluationInput) => {
  const context = (input.context ?? [])
    .map(
      (snippet, index) =>
        `Context ${index + 1}:\n${snippet.trim().replace(/\s+/g, ' ')}`,
    )
    .join('\n\n');

  const expectedAnswer = input.expectedAnswer?.trim()
    ? input.expectedAnswer.trim()
    : 'Not provided.';

  const acceptanceRule = input.acceptanceRule?.trim()
    ? input.acceptanceRule.trim()
    : 'Use best judgment based on correctness, completeness, and factual alignment with the provided context.';

  const contextSection = context
    ? context
    : 'No retrieval context was supplied.';

  const instructions = [
    'You are an impartial evaluator assessing answers produced by a retrieval-augmented generation (RAG) system.',
    'Use the question, expected answer, acceptance criteria, and retrieved context to decide whether the answer should be accepted.',
    'Return a JSON object with the following keys:',
    '- verdict: "pass" if the answer satisfies the acceptance criteria, otherwise "review".',
    '- relevance: score between 0 and 1 measuring how directly the answer addresses the question.',
    '- context_precision: score between 0 and 1 measuring how well the answer is supported by the provided context snippets.',
    '- groundedness: score between 0 and 1 measuring factual agreement with the context.',
    '- missing_criteria: array of unmet acceptance criteria or factual gaps (may be empty).',
    '- rationale: short explanation (2 sentences max).',
    'Respond with JSON only.',
  ].join(' ');

  return [
    {
      role: 'system' as const,
      content: instructions,
    },
    {
      role: 'user' as const,
      content: [
        `Question: ${input.question.trim()}`,
        `Expected Answer: ${expectedAnswer}`,
        `Acceptance Criteria: ${acceptanceRule}`,
        `Model Answer: ${input.answer.trim() || '(empty answer supplied)'}`,
        'Retrieved Context:',
        contextSection,
      ].join('\n\n'),
    },
  ];
};

const parseJudgeResponse = (payload: unknown): JudgeDetailResponse => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Judge response was not an object.');
  }

  const result = payload as Record<string, unknown>;
  const { verdict, rationale, missing_criteria } = result;
  if (
    (verdict !== 'pass' && verdict !== 'review') ||
    typeof rationale !== 'string' ||
    !rationale.trim() ||
    !Array.isArray(missing_criteria) ||
    !missing_criteria.every((item) => typeof item === 'string')
  ) {
    throw new Error('Invalid judge decision.');
  }
  return {
    verdict,
    rationale: rationale.trim(),
    missingCriteria: missing_criteria,
    relevance: score(result.relevance),
    judgedContextPrecision: score(result.context_precision),
    groundedness: score(result.groundedness),
  };
};

const average = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

export const createJudgeHandler =
  (client: LegacyChatClient) =>
  async (req: Request<unknown, unknown, JudgeRequestBody>, res: Response) => {
    const { pipelineId, evaluations, model } = req.body ?? {};

    if (typeof pipelineId !== 'string' || !pipelineId.trim()) {
      return res.status(400).json({ error: 'pipelineId is required.' });
    }

    if (!Array.isArray(evaluations) || !evaluations.length) {
      return res
        .status(400)
        .json({ error: 'Provide at least one evaluation item.' });
    }

    try {
      const judgeDetails: JudgeDetail[] = [];

      for (const evaluation of evaluations) {
        const evalStarted = Date.now();
        let usage: LegacyChatUsage | undefined;
        try {
          const messages = buildJudgePrompt(evaluation);
          const completion = await client.chatCompletion(messages, {
            model: model?.trim() || undefined,
            temperature: 0,
            responseFormat: { type: 'json_object' },
          });
          const latencyMs = Date.now() - evalStarted;
          usage = completion.usage;
          const parsed = parseJudgeResponse(JSON.parse(completion.content));

          judgeDetails.push({
            taskId: evaluation.taskId,
            verdict: parsed.verdict,
            scores: {
              relevance: parsed.relevance,
              judgedContextPrecision: parsed.judgedContextPrecision,
              groundedness: parsed.groundedness,
            },
            rationale: parsed.rationale,
            missingCriteria: parsed.missingCriteria,
            latencyMs,
            usage,
          });
        } catch {
          judgeDetails.push({
            taskId: evaluation.taskId,
            verdict: 'unavailable',
            scores: null,
            rationale: 'The judge did not return a valid evaluation.',
            missingCriteria: [],
            latencyMs: Date.now() - evalStarted,
            usage,
          });
        }
      }

      const scores = judgeDetails.flatMap((detail) =>
        detail.scores ? [detail.scores] : [],
      );
      const coverage = { completed: scores.length, total: judgeDetails.length };
      const passes = judgeDetails.filter(
        (detail) => detail.verdict === 'pass',
      ).length;
      const judgePassRate = scores.length ? passes / scores.length : null;
      const averageScores = {
        relevance: average(scores.map((item) => item.relevance)),
        judgedContextPrecision: average(
          scores.map((item) => item.judgedContextPrecision),
        ),
        groundedness: average(scores.map((item) => item.groundedness)),
      };

      const tokensUsed = judgeDetails.reduce(
        (sum, detail) => sum + (detail.usage?.totalTokens ?? 0),
        0,
      );

      const latencyMsTotal = judgeDetails.reduce(
        (sum, detail) => sum + detail.latencyMs,
        0,
      );

      const overallVerdict =
        judgePassRate === null || averageScores.groundedness === null
          ? 'unavailable'
          : judgePassRate >= 0.8 && averageScores.groundedness >= 0.7
            ? 'pass'
            : 'review';

      res.json({
        pipelineId,
        verdict: overallVerdict,
        judgePassRate,
        coverage,
        averageScores,
        tokensUsed,
        latencyMs: latencyMsTotal,
        details: judgeDetails,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  };
