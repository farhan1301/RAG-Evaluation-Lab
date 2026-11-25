import {
  z,
  type JudgeAttemptStatus,
  type JudgeMetricId,
  type ObservationStatus,
  type ProviderKind,
  type ProviderUsage,
  type RecordedContextItem,
} from '@rag-eval/contracts';
import { sha256 } from '../ingestion/chunks.js';
import { ProviderError } from '../providers/errors.js';
import type { ChatMessage, ChatProvider } from '../providers/types.js';
import type { ComputedObservation } from './metrics.js';
import { getRubric, type RubricDefinition } from './rubrics.js';

const faithfulnessOutputSchema = z.strictObject({
  refused: z.boolean(),
  reason: z.string(),
  claims: z.array(
    z.strictObject({
      claim: z.string().trim().min(1),
      verdict: z.enum(['supported', 'contradicted', 'unsupported']),
      evidenceChunkIds: z.array(z.string()),
      quote: z.string(),
    }),
  ),
});

const answerRelevanceOutputSchema = z.strictObject({
  refused: z.boolean(),
  grade: z.int().min(0).max(4),
  rationale: z.string().trim().min(1),
});

const contextPrecisionOutputSchema = z.strictObject({
  refused: z.boolean(),
  reason: z.string(),
  passages: z.array(
    z.strictObject({
      chunkId: z.string().trim().min(1),
      useful: z.boolean(),
      rationale: z.string(),
    }),
  ),
});

const contextRecallOutputSchema = z.strictObject({
  refused: z.boolean(),
  reason: z.string(),
  facts: z.array(
    z.strictObject({
      factIndex: z.int().min(1),
      supported: z.boolean(),
      evidenceChunkIds: z.array(z.string()),
      rationale: z.string(),
    }),
  ),
});

const answerCorrectnessOutputSchema = z.strictObject({
  refused: z.boolean(),
  facts: z.array(
    z.strictObject({
      factIndex: z.int().min(1),
      status: z.enum(['satisfied', 'omitted', 'contradicted']),
      rationale: z.string(),
    }),
  ),
  criticalContradiction: z.boolean(),
  acceptanceCriteriaMet: z.boolean(),
  rationale: z.string().trim().min(1),
});

export interface JudgeTaskInput {
  question: string;
  answerable: boolean;
  expectedAnswer: string;
  acceptanceRule: string;
  referenceFacts: string[];
  retrievalFailed: boolean;
  generationFailed: boolean;
  answerText: string;
  abstained: boolean;
  context: RecordedContextItem[];
}

export interface JudgeCallAudit {
  attemptNumber: number;
  isRepair: boolean;
  isRetry: boolean;
  provider: ProviderKind;
  model: string;
  effectiveParams: Record<string, unknown>;
  status: JudgeAttemptStatus;
  reason: string | null;
  rawResponseHash: string | null;
  parsedOutput: unknown | null;
  score: number | null;
  requestId: string | null;
  latencyMs: number;
  usage?: ProviderUsage;
  callStatus: 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  errorCode: string | null;
}

export interface JudgeMetricEvaluation {
  metricId: JudgeMetricId;
  rubricVersion: string;
  attempts: JudgeCallAudit[];
  observation: ComputedObservation;
}

export interface RunJudgeMetricOptions {
  metricId: JudgeMetricId;
  task: JudgeTaskInput;
  provider: ChatProvider;
  model: string;
  signal?: AbortSignal;
  now?: () => number;
  maxTransientRetries?: number;
  attemptOffset?: number;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function formatQuotedPassages(context: RecordedContextItem[]): string {
  return context
    .map(
      (item) =>
        `Passage ${item.index} (chunkId=${item.chunkId}, page=${item.page}):\n"""\n${item.content}\n"""`,
    )
    .join('\n\n');
}

function formatNumberedFacts(facts: string[]): string {
  return facts.map((fact, idx) => `${idx + 1}. """${fact}"""`).join('\n');
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function looksLikeRefusal(text: string): boolean {
  return /\b(i cannot|i can't|i am unable to|i'm sorry,?\s+i cannot|cannot evaluate|refuse to evaluate|as an ai)\b/i.test(
    text,
  );
}

/**
 * Checks prerequisites before calling the judge so missing inputs never trigger
 * wasted LLM calls or fabricated zero scores.
 */
function checkPrerequisite(
  metricId: JudgeMetricId,
  rubric: RubricDefinition,
  task: JudgeTaskInput,
): ComputedObservation | null {
  const make = (
    status: ObservationStatus,
    value: number | null,
    reason: string | null,
  ): ComputedObservation => ({
    metricId,
    metricVersion: rubric.version,
    cutoff: 0,
    evaluationUnit: rubric.evaluationUnit,
    status,
    value,
    reason,
    metadata: { rubricVersion: rubric.version, rubricHash: rubric.hash },
  });

  if (metricId === 'context_precision') {
    if (task.retrievalFailed)
      return make('retrieval_failed', null, 'Retrieval failed for this task.');
    if (!task.answerable)
      return make(
        'unanswerable',
        null,
        'Task is labeled unanswerable; judged context precision is excluded.',
      );
    if (task.context.length === 0)
      return make(
        'scored',
        0,
        'Answerable task had successful empty retrieval (0 useful passages).',
      );
    return null;
  }

  if (metricId === 'context_recall') {
    if (task.retrievalFailed)
      return make('retrieval_failed', null, 'Retrieval failed for this task.');
    if (!task.answerable)
      return make(
        'unanswerable',
        null,
        'Task is labeled unanswerable; judged context recall is excluded.',
      );
    if (task.referenceFacts.length === 0)
      return make(
        'missing_reference_facts',
        null,
        'Task has no reviewed reference facts for context recall.',
      );
    if (task.context.length === 0)
      return make(
        'scored',
        0,
        'Answerable task had successful empty retrieval (0 supported facts).',
      );
    return null;
  }

  if (task.generationFailed) {
    return make(
      'generation_failed',
      null,
      'Answer generation failed for this task.',
    );
  }

  if (metricId === 'faithfulness') {
    if (task.abstained)
      return make(
        'not_applicable',
        null,
        'Abstention is scored separately under abstention handling.',
      );
    return null;
  }

  if (metricId === 'answer_relevance') {
    if (task.abstained)
      return make(
        'not_applicable',
        null,
        'Abstention is scored separately under abstention handling.',
      );
    return null;
  }

  // answer_correctness
  if (!task.answerable) {
    return make(
      'unanswerable',
      null,
      'Task is labeled unanswerable; evaluated under abstention handling.',
    );
  }
  if (task.referenceFacts.length === 0) {
    return make(
      'missing_reference_facts',
      null,
      'Task has no reviewed reference facts for answer correctness.',
    );
  }
  if (task.abstained) {
    return make(
      'not_applicable',
      null,
      'Abstention is scored separately under abstention handling.',
    );
  }
  return null;
}

/**
 * Builds metric-specific messages blinded to pipeline identity.
 * Supplies ONLY the evidence required by that metric and frames all text as quoted data.
 */
function buildMessages(
  metricId: JudgeMetricId,
  rubric: RubricDefinition,
  task: JudgeTaskInput,
): ChatMessage[] {
  const sections: string[] = [];
  if (metricId === 'faithfulness') {
    sections.push(`Answer:\n"""\n${task.answerText}\n"""`);
    sections.push(
      `Supplied Context Passages:\n${
        task.context.length
          ? formatQuotedPassages(task.context)
          : '(no passages were supplied)'
      }`,
    );
  } else if (metricId === 'answer_relevance') {
    sections.push(`Question:\n"""\n${task.question}\n"""`);
    sections.push(`Answer:\n"""\n${task.answerText}\n"""`);
  } else if (metricId === 'context_precision') {
    sections.push(`Question:\n"""\n${task.question}\n"""`);
    sections.push(
      `Delivered Context Passages:\n${formatQuotedPassages(task.context)}`,
    );
  } else if (metricId === 'context_recall') {
    sections.push(`Question:\n"""\n${task.question}\n"""`);
    sections.push(
      `Reviewed Reference Facts:\n${formatNumberedFacts(task.referenceFacts)}`,
    );
    sections.push(
      `Supplied Context Passages:\n${formatQuotedPassages(task.context)}`,
    );
  } else {
    sections.push(`Question:\n"""\n${task.question}\n"""`);
    sections.push(`Answer:\n"""\n${task.answerText}\n"""`);
    sections.push(
      `Reviewed Reference Facts:\n${formatNumberedFacts(task.referenceFacts)}`,
    );
    if (task.expectedAnswer.trim()) {
      sections.push(
        `Reference Answer:\n"""\n${task.expectedAnswer.trim()}\n"""`,
      );
    }
    if (task.acceptanceRule.trim()) {
      sections.push(
        `Acceptance Criteria:\n"""\n${task.acceptanceRule.trim()}\n"""`,
      );
    }
  }

  return [
    { role: 'system', content: rubric.systemPrompt },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

type ValidationOutcome =
  | {
      ok: true;
      score: number;
      parsedOutput: unknown;
      extraMetadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      attemptStatus: 'malformed' | 'refused' | 'unresolved_evidence';
      observationStatus:
        | 'judge_malformed'
        | 'judge_refused'
        | 'unresolved_evidence';
      reason: string;
      parsedOutput: unknown | null;
    };

function validateMetricOutput(
  metricId: JudgeMetricId,
  rubric: RubricDefinition,
  rawContent: string,
  task: JudgeTaskInput,
): ValidationOutcome {
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(stripJsonFence(rawContent));
  } catch {
    if (looksLikeRefusal(rawContent)) {
      return {
        ok: false,
        attemptStatus: 'refused',
        observationStatus: 'judge_refused',
        reason: 'Judge refused to evaluate this item.',
        parsedOutput: null,
      };
    }
    return {
      ok: false,
      attemptStatus: 'malformed',
      observationStatus: 'judge_malformed',
      reason: 'Judge response was not valid JSON.',
      parsedOutput: null,
    };
  }

  const contextById = new Map(task.context.map((item) => [item.chunkId, item]));

  if (metricId === 'faithfulness') {
    const parsed = faithfulnessOutputSchema.safeParse(rawJson);
    if (!parsed.success) {
      return {
        ok: false,
        attemptStatus: 'malformed',
        observationStatus: 'judge_malformed',
        reason: `Faithfulness output did not match schema: ${parsed.error.issues[0]?.message ?? 'invalid structure'}`,
        parsedOutput: null,
      };
    }
    const data = parsed.data;
    if (data.refused) {
      return {
        ok: false,
        attemptStatus: 'refused',
        observationStatus: 'judge_refused',
        reason: data.reason.trim() || 'Judge refused to evaluate faithfulness.',
        parsedOutput: data,
      };
    }
    if (data.claims.length === 0) {
      return {
        ok: false,
        attemptStatus: 'malformed',
        observationStatus: 'judge_malformed',
        reason:
          'Faithfulness output contained zero factual claims for a non-abstained answer.',
        parsedOutput: data,
      };
    }
    for (const claim of data.claims) {
      if (claim.verdict === 'supported' || claim.verdict === 'contradicted') {
        if (claim.evidenceChunkIds.length === 0) {
          return {
            ok: false,
            attemptStatus: 'unresolved_evidence',
            observationStatus: 'unresolved_evidence',
            reason: `Claim labeled "${claim.verdict}" did not cite any evidenceChunkIds.`,
            parsedOutput: data,
          };
        }
      }
      for (const cid of claim.evidenceChunkIds) {
        if (!contextById.has(cid)) {
          return {
            ok: false,
            attemptStatus: 'unresolved_evidence',
            observationStatus: 'unresolved_evidence',
            reason: `Evidence chunkId "${cid}" was not in the context supplied to the answer model.`,
            parsedOutput: data,
          };
        }
      }
      if (claim.quote.trim() && claim.evidenceChunkIds.length > 0) {
        const needle = normalizeWhitespace(claim.quote);
        const matched = claim.evidenceChunkIds.some((cid) => {
          const item = contextById.get(cid);
          return item && normalizeWhitespace(item.content).includes(needle);
        });
        if (!matched) {
          return {
            ok: false,
            attemptStatus: 'unresolved_evidence',
            observationStatus: 'unresolved_evidence',
            reason: 'Cited quote could not be matched to the cited passage.',
            parsedOutput: data,
          };
        }
      }
    }
    const supportedCount = data.claims.filter(
      (c) => c.verdict === 'supported',
    ).length;
    const contradictedCount = data.claims.filter(
      (c) => c.verdict === 'contradicted',
    ).length;
    return {
      ok: true,
      score: supportedCount / data.claims.length,
      parsedOutput: data,
      extraMetadata: {
        claimCount: data.claims.length,
        supportedCount,
        contradictedCount,
      },
    };
  }

  if (metricId === 'answer_relevance') {
    const parsed = answerRelevanceOutputSchema.safeParse(rawJson);
    if (!parsed.success) {
      return {
        ok: false,
        attemptStatus: 'malformed',
        observationStatus: 'judge_malformed',
        reason: `Answer relevance output did not match schema: ${parsed.error.issues[0]?.message ?? 'invalid structure'}`,
        parsedOutput: null,
      };
    }
    const data = parsed.data;
    if (data.refused) {
      return {
        ok: false,
        attemptStatus: 'refused',
        observationStatus: 'judge_refused',
        reason: data.rationale || 'Judge refused to evaluate answer relevance.',
        parsedOutput: data,
      };
    }
    return {
      ok: true,
      score: data.grade / 4,
      parsedOutput: data,
      extraMetadata: { grade: data.grade, rationale: data.rationale },
    };
  }

  if (metricId === 'context_precision') {
    const parsed = contextPrecisionOutputSchema.safeParse(rawJson);
    if (!parsed.success) {
      return {
        ok: false,
        attemptStatus: 'malformed',
        observationStatus: 'judge_malformed',
        reason: `Context precision output did not match schema: ${parsed.error.issues[0]?.message ?? 'invalid structure'}`,
        parsedOutput: null,
      };
    }
    const data = parsed.data;
    if (data.refused) {
      return {
        ok: false,
        attemptStatus: 'refused',
        observationStatus: 'judge_refused',
        reason:
          data.reason.trim() || 'Judge refused to evaluate context precision.',
        parsedOutput: data,
      };
    }
    const seen = new Set<string>();
    for (const passage of data.passages) {
      if (!contextById.has(passage.chunkId)) {
        return {
          ok: false,
          attemptStatus: 'unresolved_evidence',
          observationStatus: 'unresolved_evidence',
          reason: `Passage chunkId "${passage.chunkId}" was not in the delivered context.`,
          parsedOutput: data,
        };
      }
      if (seen.has(passage.chunkId)) {
        return {
          ok: false,
          attemptStatus: 'malformed',
          observationStatus: 'judge_malformed',
          reason: `Duplicate passage chunkId "${passage.chunkId}" in context precision response.`,
          parsedOutput: data,
        };
      }
      seen.add(passage.chunkId);
    }
    if (seen.size !== task.context.length) {
      return {
        ok: false,
        attemptStatus: 'unresolved_evidence',
        observationStatus: 'unresolved_evidence',
        reason: `Expected judgments for all ${task.context.length} delivered passages, received ${seen.size}.`,
        parsedOutput: data,
      };
    }
    const usefulCount = data.passages.filter((p) => p.useful).length;
    return {
      ok: true,
      score: usefulCount / task.context.length,
      parsedOutput: data,
      extraMetadata: { usefulCount, deliveredCount: task.context.length },
    };
  }

  if (metricId === 'context_recall') {
    const parsed = contextRecallOutputSchema.safeParse(rawJson);
    if (!parsed.success) {
      return {
        ok: false,
        attemptStatus: 'malformed',
        observationStatus: 'judge_malformed',
        reason: `Context recall output did not match schema: ${parsed.error.issues[0]?.message ?? 'invalid structure'}`,
        parsedOutput: null,
      };
    }
    const data = parsed.data;
    if (data.refused) {
      return {
        ok: false,
        attemptStatus: 'refused',
        observationStatus: 'judge_refused',
        reason:
          data.reason.trim() || 'Judge refused to evaluate context recall.',
        parsedOutput: data,
      };
    }
    const seen = new Set<number>();
    for (const fact of data.facts) {
      if (fact.factIndex < 1 || fact.factIndex > task.referenceFacts.length) {
        return {
          ok: false,
          attemptStatus: 'malformed',
          observationStatus: 'judge_malformed',
          reason: `factIndex ${fact.factIndex} is outside 1..${task.referenceFacts.length}.`,
          parsedOutput: data,
        };
      }
      if (seen.has(fact.factIndex)) {
        return {
          ok: false,
          attemptStatus: 'malformed',
          observationStatus: 'judge_malformed',
          reason: `Duplicate factIndex ${fact.factIndex} in context recall response.`,
          parsedOutput: data,
        };
      }
      seen.add(fact.factIndex);
      if (fact.supported && fact.evidenceChunkIds.length === 0) {
        return {
          ok: false,
          attemptStatus: 'unresolved_evidence',
          observationStatus: 'unresolved_evidence',
          reason: `Supported fact ${fact.factIndex} did not cite any evidenceChunkIds.`,
          parsedOutput: data,
        };
      }
      for (const cid of fact.evidenceChunkIds) {
        if (!contextById.has(cid)) {
          return {
            ok: false,
            attemptStatus: 'unresolved_evidence',
            observationStatus: 'unresolved_evidence',
            reason: `Fact ${fact.factIndex} cited unknown chunkId "${cid}".`,
            parsedOutput: data,
          };
        }
      }
    }
    if (seen.size !== task.referenceFacts.length) {
      return {
        ok: false,
        attemptStatus: 'malformed',
        observationStatus: 'judge_malformed',
        reason: `Expected judgments for all ${task.referenceFacts.length} reference facts, received ${seen.size}.`,
        parsedOutput: data,
      };
    }
    const supportedCount = data.facts.filter((f) => f.supported).length;
    return {
      ok: true,
      score: supportedCount / task.referenceFacts.length,
      parsedOutput: data,
      extraMetadata: {
        supportedFacts: supportedCount,
        totalFacts: task.referenceFacts.length,
      },
    };
  }

  // answer_correctness
  const parsed = answerCorrectnessOutputSchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      ok: false,
      attemptStatus: 'malformed',
      observationStatus: 'judge_malformed',
      reason: `Answer correctness output did not match schema: ${parsed.error.issues[0]?.message ?? 'invalid structure'}`,
      parsedOutput: null,
    };
  }
  const data = parsed.data;
  if (data.refused) {
    return {
      ok: false,
      attemptStatus: 'refused',
      observationStatus: 'judge_refused',
      reason: data.rationale || 'Judge refused to evaluate answer correctness.',
      parsedOutput: data,
    };
  }
  const seen = new Set<number>();
  for (const fact of data.facts) {
    if (fact.factIndex < 1 || fact.factIndex > task.referenceFacts.length) {
      return {
        ok: false,
        attemptStatus: 'malformed',
        observationStatus: 'judge_malformed',
        reason: `factIndex ${fact.factIndex} is outside 1..${task.referenceFacts.length}.`,
        parsedOutput: data,
      };
    }
    if (seen.has(fact.factIndex)) {
      return {
        ok: false,
        attemptStatus: 'malformed',
        observationStatus: 'judge_malformed',
        reason: `Duplicate factIndex ${fact.factIndex} in answer correctness response.`,
        parsedOutput: data,
      };
    }
    seen.add(fact.factIndex);
  }
  if (seen.size !== task.referenceFacts.length) {
    return {
      ok: false,
      attemptStatus: 'malformed',
      observationStatus: 'judge_malformed',
      reason: `Expected judgments for all ${task.referenceFacts.length} reference facts, received ${seen.size}.`,
      parsedOutput: data,
    };
  }
  const satisfiedCount = data.facts.filter(
    (f) => f.status === 'satisfied',
  ).length;
  const omittedCount = data.facts.filter((f) => f.status === 'omitted').length;
  const contradictedCount = data.facts.filter(
    (f) => f.status === 'contradicted',
  ).length;
  const score = satisfiedCount / task.referenceFacts.length;
  const policy = rubric.passPolicy;
  const passed = policy
    ? score >= policy.minScore &&
      (!policy.forbidCriticalContradiction || !data.criticalContradiction) &&
      (!policy.requireAcceptanceCriteria || data.acceptanceCriteriaMet)
    : score >= 0.8 && !data.criticalContradiction;

  return {
    ok: true,
    score,
    parsedOutput: data,
    extraMetadata: {
      satisfiedCount,
      omittedCount,
      contradictedCount,
      totalFacts: task.referenceFacts.length,
      criticalContradiction: data.criticalContradiction,
      acceptanceCriteriaMet: data.acceptanceCriteriaMet,
      passPolicyVersion: policy?.version ?? 'correctness-pass-v1',
      passed,
    },
  };
}

/**
 * Runs a single structured LLM-judge metric against its versioned rubric.
 * Allows at most ONE bounded repair attempt on malformed or unresolved-evidence output,
 * preserving both attempts and raw-response hashes. Never produces a zero or guess on failure.
 */
export async function evaluateJudgeMetric(
  options: RunJudgeMetricOptions,
): Promise<JudgeMetricEvaluation> {
  const now = options.now ?? Date.now;
  const rubric = getRubric(options.metricId);

  const prereq = checkPrerequisite(options.metricId, rubric, options.task);
  if (prereq) {
    return {
      metricId: options.metricId,
      rubricVersion: rubric.version,
      attempts: [],
      observation: prereq,
    };
  }

  const baseMessages = buildMessages(options.metricId, rubric, options.task);
  const attempts: JudgeCallAudit[] = [];
  const temperature = options.provider.capabilities.temperature ? 0 : undefined;
  const maxTransientRetries = options.maxTransientRetries ?? 1;
  let nextAttemptNumber = (options.attemptOffset ?? 0) + 1;

  let repairHint: string | null = null;
  let repairUsed = false;
  let transientRetriesUsed = 0;
  let lastRawContent = '';
  let lastObservationStatus: ObservationStatus = 'judge_failed';
  let lastReason = 'Judge failed to evaluate this item.';
  let lastRawHash: string | null = null;
  let lastModel = options.model;

  while (true) {
    const attemptNumber = nextAttemptNumber++;
    const isRepair = repairUsed;
    const isRetry =
      isRepair || transientRetriesUsed > 0 || (options.attemptOffset ?? 0) > 0;
    const messages: ChatMessage[] = isRepair
      ? [
          ...baseMessages,
          { role: 'assistant', content: lastRawContent.slice(0, 4000) },
          {
            role: 'user',
            content: [
              `Your previous response could not be validated: ${repairHint}`,
              'Return ONLY a valid JSON object strictly conforming to the required schema and using ONLY chunkId values and factIndex values from the original prompt.',
            ].join(' '),
          },
        ]
      : baseMessages;

    const startedAt = now();
    try {
      const response = await options.provider.chat({
        model: options.model,
        messages,
        temperature,
        maxTokens: 1500,
        responseFormat: {
          type: 'json_schema',
          name: `judge_${options.metricId}`,
          schema: rubric.outputSchema,
        },
        signal: options.signal,
      });
      const latencyMs = Math.max(0, now() - startedAt);
      const rawHash = sha256(response.content);
      lastRawContent = response.content;
      lastRawHash = rawHash;
      lastModel = response.model;

      const validated = validateMetricOutput(
        options.metricId,
        rubric,
        response.content,
        options.task,
      );

      if (validated.ok) {
        attempts.push({
          attemptNumber,
          isRepair,
          isRetry,
          provider: response.provider,
          model: response.model,
          effectiveParams: response.effectiveParams,
          status: 'succeeded',
          reason: null,
          rawResponseHash: rawHash,
          parsedOutput: validated.parsedOutput,
          score: validated.score,
          requestId: response.requestId,
          latencyMs,
          usage: response.usage,
          callStatus: 'succeeded',
          errorCode: null,
        });
        return {
          metricId: options.metricId,
          rubricVersion: rubric.version,
          attempts,
          observation: {
            metricId: options.metricId,
            metricVersion: rubric.version,
            cutoff: 0,
            evaluationUnit: rubric.evaluationUnit,
            status: 'scored',
            value: validated.score,
            reason: null,
            metadata: {
              judgeModel: response.model,
              judgeProvider: response.provider,
              rubricVersion: rubric.version,
              rubricHash: rubric.hash,
              rawResponseHash: rawHash,
              attemptCount: attempts.length,
              repaired: isRepair,
              ...(validated.extraMetadata ?? {}),
            },
          },
        };
      }

      attempts.push({
        attemptNumber,
        isRepair,
        isRetry,
        provider: response.provider,
        model: response.model,
        effectiveParams: response.effectiveParams,
        status: validated.attemptStatus,
        reason: validated.reason,
        rawResponseHash: rawHash,
        parsedOutput: validated.parsedOutput,
        score: null,
        requestId: response.requestId,
        latencyMs,
        usage: response.usage,
        callStatus: 'succeeded',
        errorCode: validated.attemptStatus,
      });

      lastObservationStatus = validated.observationStatus;
      lastReason = validated.reason;
      repairHint = validated.reason;

      // Explicit refusals are final; allow at most one bounded schema/evidence repair attempt.
      if (validated.attemptStatus === 'refused' || repairUsed) break;
      repairUsed = true;
    } catch (err) {
      const latencyMs = Math.max(0, now() - startedAt);
      const isTimeout = err instanceof ProviderError && err.code === 'timeout';
      const isMalformed =
        err instanceof ProviderError && err.code === 'malformed_response';
      const isAborted = Boolean(options.signal?.aborted);
      const attemptStatus: JudgeAttemptStatus = isTimeout
        ? 'timeout'
        : isMalformed
          ? 'malformed'
          : 'upstream_failure';
      const obsStatus: ObservationStatus = isTimeout
        ? 'judge_timeout'
        : isMalformed
          ? 'judge_malformed'
          : 'judge_failed';
      const reason =
        err instanceof ProviderError
          ? err.message
          : 'Judge provider request failed.';

      attempts.push({
        attemptNumber,
        isRepair,
        isRetry,
        provider: options.provider.kind,
        model: options.model,
        effectiveParams: {
          ...(temperature !== undefined ? { temperature } : {}),
          maxTokens: 1500,
          structuredOutput: options.provider.capabilities.structuredOutput,
        },
        status: attemptStatus,
        reason,
        rawResponseHash: null,
        parsedOutput: null,
        score: null,
        requestId: null,
        latencyMs,
        callStatus: isAborted ? 'cancelled' : isTimeout ? 'timeout' : 'failed',
        errorCode: err instanceof ProviderError ? err.code : 'upstream_failure',
      });

      lastObservationStatus = obsStatus;
      lastReason = reason;
      lastRawHash = null;
      if (isAborted) throw err;
      if (
        err instanceof ProviderError &&
        err.retryable &&
        transientRetriesUsed < maxTransientRetries
      ) {
        transientRetriesUsed += 1;
        continue;
      }
      break;
    }
  }

  return {
    metricId: options.metricId,
    rubricVersion: rubric.version,
    attempts,
    observation: {
      metricId: options.metricId,
      metricVersion: rubric.version,
      cutoff: 0,
      evaluationUnit: rubric.evaluationUnit,
      status: lastObservationStatus,
      value: null,
      reason: lastReason,
      metadata: {
        judgeModel: lastModel,
        judgeProvider: options.provider.kind,
        rubricVersion: rubric.version,
        rubricHash: rubric.hash,
        rawResponseHash: lastRawHash,
        attemptCount: attempts.length,
      },
    },
  };
}

export const ALL_JUDGE_METRICS: JudgeMetricId[] = [
  'faithfulness',
  'answer_relevance',
  'context_precision',
  'context_recall',
  'answer_correctness',
];
