import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import type {
  IndexSearchResult,
  ProviderKind,
  ProviderUsage,
  RecordedContextItem,
  RetrievedTraceItem,
} from '@rag-eval/contracts';
import type { Indexes } from '../db/indexes.js';
import {
  PROMPT_VERSION,
  type ExecutionPlan,
  type ExecutionPlanPipeline,
  type ExecutionPlanTask,
  type Runs,
} from '../db/runs.js';
import { ApiError } from '../errors.js';
import { sha256 } from '../ingestion/chunks.js';
import { buildBoundedContext } from '../providers/answer.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { IndexBuilder } from '../retrieval/indexer.js';
import type { RetrievalService } from '../retrieval/service.js';
import { ALL_JUDGE_METRICS, evaluateJudgeMetric } from './judge.js';
import {
  evaluateTaskAbstention,
  evaluateTaskRetrieval,
  type ComputedObservation,
} from './metrics.js';
import { getRubric } from './rubrics.js';

export interface EvaluationRunnerOptions {
  runs: Runs;
  indexes: Indexes;
  indexBuilder: IndexBuilder;
  retrieval: RetrievalService;
  providers: ProviderRegistry;
  now?: () => number;
  maxTransientRetries?: number;
  retryDelayMs?: number;
}

export interface RunExecutionHooks {
  signal?: AbortSignal;
  guard?: () => void;
  checkpoint?: (stage: string) => void;
  isRetryJob?: boolean;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof ApiError) return err.status === 502 || err.status === 504;
  return false;
}

function errorCodeOf(err: unknown): string {
  if (err instanceof ProviderError) return err.code;
  if (err instanceof ApiError) return err.code;
  return 'upstream_failure';
}

function safeMessageOf(err: unknown, fallback: string): string {
  if (err instanceof ProviderError || err instanceof ApiError)
    return err.message;
  return fallback;
}

function computeRetrievalKey(
  generationId: string,
  pipeline: ExecutionPlanPipeline,
  question: string,
  filters: ExecutionPlan['snapshot']['filters'],
) {
  return sha256(
    JSON.stringify([
      'retrieval-v1',
      generationId,
      pipeline.config.retriever.mode,
      question,
      pipeline.config.retriever.topK,
      pipeline.config.retriever.candidateDepth ?? null,
      pipeline.config.retriever.fusionWeights,
      filters ?? null,
      pipeline.config.reranker,
    ]),
  );
}

function computeAnswerKey(
  retrievalKey: string,
  context: RecordedContextItem[],
  pipeline: ExecutionPlanPipeline,
  contextBudgetChars: number,
  promptVersion: string,
) {
  return sha256(
    JSON.stringify([
      'answer-v1',
      retrievalKey,
      context.map((c) => [c.chunkId, sha256(c.content), c.truncated]),
      pipeline.resolvedModels.chat,
      contextBudgetChars,
      promptVersion,
    ]),
  );
}

export class EvaluationRunner {
  private readonly runs: Runs;
  private readonly indexes: Indexes;
  private readonly indexBuilder: IndexBuilder;
  private readonly retrieval: RetrievalService;
  private readonly providers: ProviderRegistry;
  private readonly now: () => number;
  private readonly maxTransientRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: EvaluationRunnerOptions) {
    this.runs = options.runs;
    this.indexes = options.indexes;
    this.indexBuilder = options.indexBuilder;
    this.retrieval = options.retrieval;
    this.providers = options.providers;
    this.now = options.now ?? Date.now;
    this.maxTransientRetries = options.maxTransientRetries ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 50;
  }

  private checkBudget(plan: ExecutionPlan): string | null {
    const { maxTokens, maxCostUsd } = plan.snapshot.budgets;
    if (maxTokens === null && maxCostUsd === null) return null;
    const spend = this.runs.getRunSpendTotals(plan.runId);
    if (maxTokens !== null && spend.totalTokens >= maxTokens) {
      return `Run token budget (${maxTokens}) reached.`;
    }
    if (maxCostUsd !== null && spend.knownCostUsd >= maxCostUsd) {
      return `Run cost budget ($${maxCostUsd}) reached.`;
    }
    return null;
  }

  private async ensurePipelineIndex(
    plan: ExecutionPlan,
    pipeline: ExecutionPlanPipeline,
    builtInThisRun: Map<string, string>,
    hooks: RunExecutionHooks,
  ): Promise<{ generationId: string } | { error: string }> {
    if (pipeline.indexGenerationId) {
      const existing = this.indexes.getStored(pipeline.indexGenerationId);
      if (existing.state === 'ready') {
        return { generationId: existing.id };
      }
    }

    hooks.signal?.throwIfAborted();
    hooks.guard?.();
    this.runs.markPipelineState(
      plan.runId,
      pipeline.pipelineId,
      'indexing',
      null,
      hooks.guard,
    );

    const mode = pipeline.config.retriever.mode;
    let embedding: {
      provider: 'openai' | 'openai-compatible';
      model: string;
      expectedDimensions?: number;
    } | null = null;
    if (mode === 'dense' || mode === 'hybrid') {
      const resolved = this.providers.findProfile(
        'embedding',
        pipeline.resolvedModels.embedding?.model ??
          pipeline.config.embedding.model,
      );
      if (
        !resolved?.capabilities.embeddings ||
        (resolved.provider !== 'openai' &&
          resolved.provider !== 'openai-compatible')
      ) {
        const message = `Embedding profile is unavailable for pipeline "${pipeline.pipelineName}".`;
        this.runs.markPipelineState(
          plan.runId,
          pipeline.pipelineId,
          'failed',
          message,
          hooks.guard,
        );
        return { error: message };
      }
      embedding = {
        provider: resolved.provider,
        model: resolved.model,
        expectedDimensions: resolved.expectedDimensions,
      };
    }

    const indexStart = this.now();
    const planned = this.indexes.planOrReuse(
      {
        datasetId: plan.snapshot.datasetId,
        datasetRevision: plan.snapshot.datasetRevision,
        mode,
        chunking: pipeline.config.chunking,
        embeddingModel: embedding?.model ?? '',
        forceRebuild: false,
      },
      embedding,
      null,
      false,
    );

    if (planned.reused) {
      this.runs.pinPipelineIndex(
        plan.runId,
        pipeline.pipelineId,
        {
          generationId: planned.index.id,
          reused: true,
          indexTimeMs: Math.max(0, this.now() - indexStart),
        },
        hooks.guard,
      );
      return { generationId: planned.index.id };
    }

    const alreadyBuilt = builtInThisRun.get(planned.index.fingerprint);
    if (alreadyBuilt) {
      this.runs.pinPipelineIndex(
        plan.runId,
        pipeline.pipelineId,
        {
          generationId: alreadyBuilt,
          reused: true,
          indexTimeMs: Math.max(0, this.now() - indexStart),
        },
        hooks.guard,
      );
      return { generationId: alreadyBuilt };
    }

    const generationId = planned.index.id;
    let embedAttempt = 0;

    for (let attempt = 1; attempt <= 1 + this.maxTransientRetries; attempt++) {
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      try {
        await this.indexBuilder.build(generationId, {
          signal: hooks.signal,
          guard: hooks.guard,
          onEmbedCall: (audit) => {
            embedAttempt += 1;
            const isRetry = Boolean(hooks.isRetryJob) || attempt > 1;
            this.runs.recordProviderCall(
              {
                stageKey: sha256(
                  JSON.stringify([
                    'corpus_embed',
                    plan.runId,
                    generationId,
                    attempt,
                    embedAttempt,
                  ]),
                ),
                runId: plan.runId,
                pipelineId: pipeline.pipelineId,
                indexGenerationId: generationId,
                operation: 'corpus_embed',
                provider: audit.provider,
                model: audit.model,
                requestId: audit.requestIds[0] ?? null,
                attemptNumber: attempt,
                isRetry,
                status: audit.status,
                errorCode: audit.errorCode,
                latencyMs: audit.latencyMs,
                usage: audit.usage,
                priceSchedule: plan.snapshot.priceSchedule,
              },
              hooks.guard,
            );
          },
        });
        builtInThisRun.set(planned.index.fingerprint, generationId);
        this.runs.pinPipelineIndex(
          plan.runId,
          pipeline.pipelineId,
          {
            generationId,
            reused: false,
            indexTimeMs: Math.max(0, this.now() - indexStart),
          },
          hooks.guard,
        );
        return { generationId };
      } catch (err) {
        if (hooks.signal?.aborted) throw err;
        if (attempt <= this.maxTransientRetries && isRetryableError(err)) {
          const delay =
            err instanceof ProviderError && err.retryAfterMs
              ? Math.min(err.retryAfterMs, this.retryDelayMs * 4)
              : this.retryDelayMs;
          await wait(delay, undefined, { signal: hooks.signal });
          continue;
        }
        const message = safeMessageOf(err, 'Index build failed.');
        this.indexes.markFailed(generationId, message);
        this.runs.markPipelineState(
          plan.runId,
          pipeline.pipelineId,
          'failed',
          message,
          hooks.guard,
        );
        return { error: message };
      }
    }

    return { error: 'Index build failed.' };
  }

  private async executeRetrievalStage(
    plan: ExecutionPlan,
    pipeline: ExecutionPlanPipeline,
    task: ExecutionPlanTask,
    generationId: string,
    hooks: RunExecutionHooks,
  ): Promise<{
    succeeded: boolean;
    retrievalKey: string;
    items: RetrievedTraceItem[];
    retrievalLatencyMs: number;
    rerankLatencyMs: number | null;
    searchResult?: IndexSearchResult;
    errorMessage?: string;
  }> {
    const retrievalKey = computeRetrievalKey(
      generationId,
      pipeline,
      task.question,
      plan.snapshot.filters,
    );

    if (task.retrievalState === 'succeeded') {
      const items = this.runs.loadTaskRetrievedItems(task.runTaskId);
      return {
        succeeded: true,
        retrievalKey: task.retrievalKey ?? retrievalKey,
        items,
        retrievalLatencyMs: task.retrievalLatencyMs ?? 0,
        rerankLatencyMs: task.rerankLatencyMs,
      };
    }

    const reusable = this.runs.findReusableRetrieval(
      plan.runId,
      retrievalKey,
      task.runTaskId,
    );
    if (reusable) {
      const observations = evaluateTaskRetrieval({
        retrievalFailed: false,
        answerable: task.answerable,
        pool: task.pool,
        qrels: task.qrels,
        retrievedChunks: reusable.items,
        evaluatedDepth: reusable.retrievedDepth,
        cutoffs: plan.snapshot.cutoffs,
      });
      this.runs.saveTaskRetrieval(
        {
          runId: plan.runId,
          pipelineId: pipeline.pipelineId,
          taskVersionId: task.taskVersionId,
          runTaskId: task.runTaskId,
          retrievalKey,
          succeeded: true,
          items: reusable.items,
          retrievedDepth: reusable.retrievedDepth,
          rerankStatus: reusable.rerankStatus,
          rerankError: reusable.rerankError,
          retrievalLatencyMs: reusable.retrievalLatencyMs,
          rerankLatencyMs: reusable.rerankLatencyMs,
          observations,
        },
        hooks.guard,
      );
      return {
        succeeded: true,
        retrievalKey,
        items: reusable.items,
        retrievalLatencyMs: reusable.retrievalLatencyMs,
        rerankLatencyMs: reusable.rerankLatencyMs,
      };
    }

    const budgetError =
      pipeline.config.retriever.mode !== 'keyword' ||
      pipeline.config.reranker.enabled
        ? this.checkBudget(plan)
        : null;
    if (budgetError) {
      const observations = evaluateTaskRetrieval({
        retrievalFailed: true,
        retrievalError: budgetError,
        answerable: task.answerable,
        pool: task.pool,
        qrels: task.qrels,
        retrievedChunks: [],
        evaluatedDepth: pipeline.config.retriever.topK,
        cutoffs: plan.snapshot.cutoffs,
      });
      this.runs.saveTaskRetrieval(
        {
          runId: plan.runId,
          pipelineId: pipeline.pipelineId,
          taskVersionId: task.taskVersionId,
          runTaskId: task.runTaskId,
          retrievalKey,
          succeeded: false,
          items: [],
          retrievedDepth: pipeline.config.retriever.topK,
          rerankStatus: null,
          rerankError: null,
          retrievalLatencyMs: 0,
          rerankLatencyMs: null,
          errorCode: 'budget_exceeded',
          errorMessage: budgetError,
          observations,
        },
        hooks.guard,
      );
      return {
        succeeded: false,
        retrievalKey,
        items: [],
        retrievalLatencyMs: 0,
        rerankLatencyMs: null,
        errorMessage: budgetError,
      };
    }

    for (let attempt = 1; attempt <= 1 + this.maxTransientRetries; attempt++) {
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      let callSeq = 0;
      try {
        const result = await this.retrieval.search(
          generationId,
          {
            query: task.question,
            mode: pipeline.config.retriever.mode,
            topK: pipeline.config.retriever.topK,
            candidateDepth: pipeline.config.retriever.candidateDepth,
            fusionWeights: pipeline.config.retriever.fusionWeights,
            filters: plan.snapshot.filters ?? undefined,
            reranker: pipeline.config.reranker,
          },
          hooks.signal,
          {
            onProviderCall: (audit) => {
              callSeq += 1;
              const isRetry = Boolean(hooks.isRetryJob) || attempt > 1;
              this.runs.recordProviderCall(
                {
                  stageKey: sha256(
                    JSON.stringify([
                      audit.operation,
                      plan.runId,
                      task.runTaskId,
                      attempt,
                      callSeq,
                    ]),
                  ),
                  runId: plan.runId,
                  pipelineId: pipeline.pipelineId,
                  runTaskId: task.runTaskId,
                  indexGenerationId: generationId,
                  operation: audit.operation,
                  provider: audit.provider,
                  model: audit.model,
                  requestId: audit.requestId,
                  attemptNumber: attempt,
                  isRetry,
                  status: audit.status,
                  errorCode: audit.errorCode,
                  latencyMs: audit.latencyMs,
                  usage: audit.usage,
                  priceSchedule: plan.snapshot.priceSchedule,
                },
                hooks.guard,
              );
            },
          },
        );

        const observations = evaluateTaskRetrieval({
          retrievalFailed: false,
          answerable: task.answerable,
          pool: task.pool,
          qrels: task.qrels,
          retrievedChunks: result.items,
          evaluatedDepth: result.topK,
          cutoffs: plan.snapshot.cutoffs,
        });
        this.runs.saveTaskRetrieval(
          {
            runId: plan.runId,
            pipelineId: pipeline.pipelineId,
            taskVersionId: task.taskVersionId,
            runTaskId: task.runTaskId,
            retrievalKey,
            succeeded: true,
            items: result.items,
            retrievedDepth: result.topK,
            rerankStatus: result.stages.rerankStatus,
            rerankError: result.stages.rerankError,
            retrievalLatencyMs: result.stages.timingsMs.total,
            rerankLatencyMs: result.stages.timingsMs.rerank ?? null,
            observations,
          },
          hooks.guard,
        );
        return {
          succeeded: true,
          retrievalKey,
          items: result.items,
          retrievalLatencyMs: result.stages.timingsMs.total,
          rerankLatencyMs: result.stages.timingsMs.rerank ?? null,
          searchResult: result,
        };
      } catch (err) {
        if (hooks.signal?.aborted) throw err;
        if (attempt <= this.maxTransientRetries && isRetryableError(err)) {
          await wait(this.retryDelayMs, undefined, { signal: hooks.signal });
          continue;
        }
        const message = safeMessageOf(err, 'Retrieval failed.');
        const observations = evaluateTaskRetrieval({
          retrievalFailed: true,
          retrievalError: message,
          answerable: task.answerable,
          pool: task.pool,
          qrels: task.qrels,
          retrievedChunks: [],
          evaluatedDepth: pipeline.config.retriever.topK,
          cutoffs: plan.snapshot.cutoffs,
        });
        this.runs.saveTaskRetrieval(
          {
            runId: plan.runId,
            pipelineId: pipeline.pipelineId,
            taskVersionId: task.taskVersionId,
            runTaskId: task.runTaskId,
            retrievalKey,
            succeeded: false,
            items: [],
            retrievedDepth: pipeline.config.retriever.topK,
            rerankStatus: null,
            rerankError: null,
            retrievalLatencyMs: 0,
            rerankLatencyMs: null,
            errorCode: errorCodeOf(err),
            errorMessage: message,
            observations,
          },
          hooks.guard,
        );
        return {
          succeeded: false,
          retrievalKey,
          items: [],
          retrievalLatencyMs: 0,
          rerankLatencyMs: null,
          errorMessage: message,
        };
      }
    }

    return {
      succeeded: false,
      retrievalKey,
      items: [],
      retrievalLatencyMs: 0,
      rerankLatencyMs: null,
      errorMessage: 'Retrieval failed.',
    };
  }

  private async executeAnswerStage(
    plan: ExecutionPlan,
    pipeline: ExecutionPlanPipeline,
    task: ExecutionPlanTask,
    generationId: string,
    retrievalKey: string,
    retrievedItems: RetrievedTraceItem[],
    searchResult: IndexSearchResult | undefined,
    hooks: RunExecutionHooks,
  ): Promise<{
    succeeded: boolean;
    answerText: string;
    abstained: boolean;
    context: RecordedContextItem[];
    generationLatencyMs: number | null;
    errorMessage?: string;
  }> {
    if (task.answerState === 'succeeded') {
      const saved = this.runs.loadTaskAnswer(task.runTaskId);
      if (saved) {
        return {
          succeeded: true,
          answerText: saved.answerText,
          abstained: saved.abstained,
          context: saved.context,
          generationLatencyMs: saved.latencyMs,
        };
      }
    }

    const boundedContext = buildBoundedContext(retrievedItems, {
      contextBudgetChars: plan.snapshot.contextBudgetChars,
    });
    const answerKey = computeAnswerKey(
      retrievalKey,
      boundedContext,
      pipeline,
      plan.snapshot.contextBudgetChars,
      plan.snapshot.promptVersion,
    );

    const reusable = this.runs.findReusableAnswer(
      plan.runId,
      answerKey,
      task.runTaskId,
    );
    if (reusable) {
      const abstentionObs = evaluateTaskAbstention({
        answerable: task.answerable,
        generationFailed: false,
        abstained: reusable.abstained,
      });
      this.runs.saveTaskAnswer(
        {
          runId: plan.runId,
          pipelineId: pipeline.pipelineId,
          taskVersionId: task.taskVersionId,
          runTaskId: task.runTaskId,
          answerKey,
          succeeded: true,
          answer: {
            ...reusable,
            reusedFromRunTaskId: reusable.sourceRunTaskId,
          },
          generationLatencyMs: reusable.latencyMs,
          abstentionObservation: abstentionObs,
        },
        hooks.guard,
      );
      return {
        succeeded: true,
        answerText: reusable.answerText,
        abstained: reusable.abstained,
        context: reusable.context,
        generationLatencyMs: reusable.latencyMs,
      };
    }

    const budgetError = this.checkBudget(plan);
    if (budgetError) {
      const abstentionObs = evaluateTaskAbstention({
        answerable: task.answerable,
        generationFailed: true,
        generationError: budgetError,
      });
      this.runs.saveTaskAnswer(
        {
          runId: plan.runId,
          pipelineId: pipeline.pipelineId,
          taskVersionId: task.taskVersionId,
          runTaskId: task.runTaskId,
          answerKey,
          succeeded: false,
          generationLatencyMs: null,
          errorCode: 'budget_exceeded',
          errorMessage: budgetError,
          abstentionObservation: abstentionObs,
        },
        hooks.guard,
      );
      return {
        succeeded: false,
        answerText: '',
        abstained: false,
        context: boundedContext,
        generationLatencyMs: null,
        errorMessage: budgetError,
      };
    }

    const syntheticSearch: IndexSearchResult = searchResult ?? {
      generationId,
      datasetId: plan.snapshot.datasetId,
      datasetRevision: plan.snapshot.datasetRevision,
      mode: pipeline.config.retriever.mode,
      query: task.question,
      topK: pipeline.config.retriever.topK,
      candidateDepth:
        pipeline.config.retriever.candidateDepth ??
        Math.min(50, pipeline.config.retriever.topK * 4),
      filters: plan.snapshot.filters,
      items: retrievedItems,
      stages: {
        keywordCount: 0,
        denseCount: 0,
        fusedCount: 0,
        reranked: false,
        rerankStatus: 'skipped',
        rerankError: null,
        timingsMs: { total: 0 },
      },
    };

    const resolvedChat = pipeline.resolvedModels.chat;
    const chatModel = resolvedChat?.model ?? pipeline.config.llm.model;
    const chatProviderKind: ProviderKind = resolvedChat?.provider ?? 'openai';

    for (let attempt = 1; attempt <= 1 + this.maxTransientRetries; attempt++) {
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      const startedAt = this.now();
      const isRetry = Boolean(hooks.isRetryJob) || attempt > 1;
      try {
        const result = await this.retrieval.answerFromSearch(
          syntheticSearch,
          {
            question: task.question,
            model: chatModel,
            temperature: resolvedChat?.effectiveTemperature ?? undefined,
            maxTokens:
              resolvedChat?.effectiveMaxTokens ?? pipeline.config.llm.maxTokens,
            contextBudgetChars: plan.snapshot.contextBudgetChars,
          },
          hooks.signal,
        );

        this.runs.recordProviderCall(
          {
            stageKey: sha256(
              JSON.stringify(['generate', plan.runId, task.runTaskId, attempt]),
            ),
            runId: plan.runId,
            pipelineId: pipeline.pipelineId,
            runTaskId: task.runTaskId,
            operation: 'generate',
            provider: result.provider,
            model: result.model,
            requestId: result.requestId,
            attemptNumber: attempt,
            isRetry,
            status: 'succeeded',
            errorCode: null,
            latencyMs: result.latencyMs,
            usage: result.usage,
            priceSchedule: plan.snapshot.priceSchedule,
          },
          hooks.guard,
        );

        const abstentionObs = evaluateTaskAbstention({
          answerable: task.answerable,
          generationFailed: false,
          abstained: result.abstained,
        });
        this.runs.saveTaskAnswer(
          {
            runId: plan.runId,
            pipelineId: pipeline.pipelineId,
            taskVersionId: task.taskVersionId,
            runTaskId: task.runTaskId,
            answerKey,
            succeeded: true,
            answer: {
              answerText: result.answer,
              abstained: result.abstained,
              citations: result.citations,
              invalidCitations: result.invalidCitations,
              context: result.context,
              promptVersion: PROMPT_VERSION,
              provider: result.provider,
              model: result.model,
              effectiveParams: result.effectiveParams,
              requestId: result.requestId,
              latencyMs: result.latencyMs,
            },
            generationLatencyMs: result.latencyMs,
            abstentionObservation: abstentionObs,
          },
          hooks.guard,
        );
        return {
          succeeded: true,
          answerText: result.answer,
          abstained: result.abstained,
          context: result.context,
          generationLatencyMs: result.latencyMs,
        };
      } catch (err) {
        const latencyMs = Math.max(0, this.now() - startedAt);
        const isTimeout =
          err instanceof ProviderError && err.code === 'timeout';
        this.runs.recordProviderCall(
          {
            stageKey: sha256(
              JSON.stringify(['generate', plan.runId, task.runTaskId, attempt]),
            ),
            runId: plan.runId,
            pipelineId: pipeline.pipelineId,
            runTaskId: task.runTaskId,
            operation: 'generate',
            provider: chatProviderKind,
            model: chatModel,
            requestId: null,
            attemptNumber: attempt,
            isRetry,
            status: hooks.signal?.aborted
              ? 'cancelled'
              : isTimeout
                ? 'timeout'
                : 'failed',
            errorCode: errorCodeOf(err),
            latencyMs,
            priceSchedule: plan.snapshot.priceSchedule,
          },
          hooks.guard,
        );
        if (hooks.signal?.aborted) throw err;
        if (attempt <= this.maxTransientRetries && isRetryableError(err)) {
          await wait(this.retryDelayMs, undefined, { signal: hooks.signal });
          continue;
        }
        const message = safeMessageOf(err, 'Answer generation failed.');
        const abstentionObs = evaluateTaskAbstention({
          answerable: task.answerable,
          generationFailed: true,
          generationError: message,
        });
        this.runs.saveTaskAnswer(
          {
            runId: plan.runId,
            pipelineId: pipeline.pipelineId,
            taskVersionId: task.taskVersionId,
            runTaskId: task.runTaskId,
            answerKey,
            succeeded: false,
            generationLatencyMs: latencyMs,
            errorCode: errorCodeOf(err),
            errorMessage: message,
            abstentionObservation: abstentionObs,
          },
          hooks.guard,
        );
        return {
          succeeded: false,
          answerText: '',
          abstained: false,
          context: boundedContext,
          generationLatencyMs: latencyMs,
          errorMessage: message,
        };
      }
    }

    return {
      succeeded: false,
      answerText: '',
      abstained: false,
      context: boundedContext,
      generationLatencyMs: null,
      errorMessage: 'Answer generation failed.',
    };
  }

  private async executeJudgeStage(
    plan: ExecutionPlan,
    pipeline: ExecutionPlanPipeline,
    task: ExecutionPlanTask,
    retrievalFailed: boolean,
    answer: {
      succeeded: boolean;
      answerText: string;
      abstained: boolean;
      context: RecordedContextItem[];
    },
    hooks: RunExecutionHooks,
  ): Promise<{
    judgeState: 'succeeded' | 'partial' | 'failed';
    judgeLatencyMs: number;
  }> {
    const resolved = this.providers.resolveChat(
      'judge',
      pipeline.resolvedModels.judge?.model ?? pipeline.config.judge.model,
    );
    const existing = this.runs.existingObservationMetrics(
      task.runTaskId,
      Boolean(hooks.isRetryJob),
    );
    let judgeLatencyMs = task.judgeLatencyMs ?? 0;
    let failedMetrics = 0;
    let completedMetrics = 0;

    for (const metricId of ALL_JUDGE_METRICS) {
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      if (existing.has(`${metricId}:0`)) {
        completedMetrics += 1;
        continue;
      }

      const budgetError = this.checkBudget(plan);
      if (budgetError) {
        const rubric = getRubric(metricId);
        const obs: ComputedObservation = {
          metricId,
          metricVersion: rubric.version,
          cutoff: 0,
          evaluationUnit: rubric.evaluationUnit,
          status: 'judge_failed',
          value: null,
          reason: budgetError,
          metadata: {
            judgeModel: resolved.profile.model,
            rubricVersion: rubric.version,
            rubricHash: rubric.hash,
            rawResponseHash: null,
          },
        };
        this.runs.saveTaskJudgeMetric(
          {
            runId: plan.runId,
            pipelineId: pipeline.pipelineId,
            taskVersionId: task.taskVersionId,
            runTaskId: task.runTaskId,
            attempts: [],
            observation: obs,
          },
          hooks.guard,
        );
        failedMetrics += 1;
        continue;
      }

      const attemptOffset = this.runs.maxJudgeAttemptNumber(
        task.runTaskId,
        metricId,
      );
      const evaluation = await evaluateJudgeMetric({
        metricId,
        task: {
          question: task.question,
          answerable: task.answerable,
          expectedAnswer: task.expectedAnswer,
          acceptanceRule: task.acceptanceRule,
          referenceFacts: task.referenceFacts,
          retrievalFailed,
          generationFailed: !answer.succeeded,
          answerText: answer.answerText,
          abstained: answer.abstained,
          context: answer.context,
        },
        provider: resolved.provider,
        model: resolved.profile.model,
        signal: hooks.signal,
        now: this.now,
        maxTransientRetries: this.maxTransientRetries,
        attemptOffset,
      });

      for (const a of evaluation.attempts) {
        judgeLatencyMs += a.latencyMs;
        const isRetry = Boolean(hooks.isRetryJob) || a.isRetry;
        this.runs.recordProviderCall(
          {
            stageKey: sha256(
              JSON.stringify([
                'judge',
                plan.runId,
                task.runTaskId,
                metricId,
                evaluation.rubricVersion,
                a.attemptNumber,
              ]),
            ),
            runId: plan.runId,
            pipelineId: pipeline.pipelineId,
            runTaskId: task.runTaskId,
            operation: 'judge',
            provider: a.provider,
            model: a.model,
            requestId: a.requestId,
            attemptNumber: a.attemptNumber,
            isRetry,
            status: a.callStatus,
            errorCode: a.errorCode,
            latencyMs: a.latencyMs,
            usage: a.usage as ProviderUsage | undefined,
            priceSchedule: plan.snapshot.priceSchedule,
          },
          hooks.guard,
        );
      }

      this.runs.saveTaskJudgeMetric(
        {
          runId: plan.runId,
          pipelineId: pipeline.pipelineId,
          taskVersionId: task.taskVersionId,
          runTaskId: task.runTaskId,
          attempts: evaluation.attempts.map((a) => ({
            metricId,
            rubricVersion: evaluation.rubricVersion,
            attemptNumber: a.attemptNumber,
            isRepair: a.isRepair,
            provider: a.provider,
            model: a.model,
            effectiveParams: a.effectiveParams,
            status: a.status,
            reason: a.reason,
            rawResponseHash: a.rawResponseHash,
            parsedOutput: a.parsedOutput,
            score: a.score,
            requestId: a.requestId,
            latencyMs: a.latencyMs,
          })),
          observation: evaluation.observation,
        },
        hooks.guard,
      );

      if (
        [
          'judge_malformed',
          'judge_refused',
          'judge_timeout',
          'judge_failed',
          'unresolved_evidence',
        ].includes(evaluation.observation.status)
      ) {
        failedMetrics += 1;
      } else {
        completedMetrics += 1;
      }
    }

    const judgeState =
      failedMetrics === 0
        ? 'succeeded'
        : completedMetrics > 0
          ? 'partial'
          : 'failed';
    return { judgeState, judgeLatencyMs };
  }

  async execute(runId: string, hooks: RunExecutionHooks = {}) {
    const plan = this.runs.loadExecutionPlan(runId);
    this.runs.markRunStarted(runId, hooks.guard);
    hooks.checkpoint?.('indexing');

    const builtInThisRun = new Map<string, string>();
    const generationByPipeline = new Map<string, string>();
    let readyPipelineCount = 0;

    for (const pipeline of plan.pipelines) {
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      const indexResult = await this.ensurePipelineIndex(
        plan,
        pipeline,
        builtInThisRun,
        hooks,
      );
      if ('generationId' in indexResult) {
        generationByPipeline.set(pipeline.pipelineId, indexResult.generationId);
        readyPipelineCount += 1;
      } else {
        const tasksForPipeline = plan.tasks.filter(
          (t) => t.pipelineId === pipeline.pipelineId,
        );
        for (const task of tasksForPipeline) {
          if (task.state === 'succeeded') continue;
          const observations = evaluateTaskRetrieval({
            retrievalFailed: true,
            retrievalError: indexResult.error,
            answerable: task.answerable,
            pool: task.pool,
            qrels: task.qrels,
            retrievedChunks: [],
            evaluatedDepth: pipeline.config.retriever.topK,
            cutoffs: plan.snapshot.cutoffs,
          });
          this.runs.saveTaskRetrieval(
            {
              runId,
              pipelineId: pipeline.pipelineId,
              taskVersionId: task.taskVersionId,
              runTaskId: task.runTaskId,
              retrievalKey: `index-failed:${pipeline.pipelineId}`,
              succeeded: false,
              items: [],
              retrievedDepth: pipeline.config.retriever.topK,
              rerankStatus: null,
              rerankError: null,
              retrievalLatencyMs: 0,
              rerankLatencyMs: null,
              errorCode: 'index_failed',
              errorMessage: indexResult.error,
              observations,
            },
            hooks.guard,
          );
          this.runs.finalizeRunTask(
            {
              runId,
              runTaskId: task.runTaskId,
              state: 'failed',
              judgeState:
                plan.mode === 'full_rag' && plan.snapshot.judgeEnabled
                  ? 'failed'
                  : 'skipped',
              servingLatencyMs: null,
              judgeLatencyMs: null,
              errorCode: 'index_failed',
              errorMessage: indexResult.error,
            },
            hooks.guard,
          );
        }
      }
    }

    if (readyPipelineCount === 0) {
      this.runs.finalizeRun(
        runId,
        'failed',
        'All pipeline index builds failed.',
        hooks.guard,
      );
      return;
    }

    this.runs.updateRunStage(runId, 'executing', hooks.guard);
    hooks.checkpoint?.('executing');

    for (const pipeline of plan.pipelines) {
      const generationId = generationByPipeline.get(pipeline.pipelineId);
      if (!generationId) continue;

      const tasks = plan.tasks.filter(
        (t) => t.pipelineId === pipeline.pipelineId,
      );
      let pipelineFailedTasks = 0;
      let pipelinePartialTasks = 0;
      let pipelineSucceededTasks = 0;

      for (const task of tasks) {
        hooks.signal?.throwIfAborted();
        hooks.guard?.();

        if (task.state === 'succeeded') {
          pipelineSucceededTasks += 1;
          continue;
        }
        if (task.state === 'partial' && !hooks.isRetryJob) {
          pipelinePartialTasks += 1;
          continue;
        }

        const retrievalOutcome = await this.executeRetrievalStage(
          plan,
          pipeline,
          task,
          generationId,
          hooks,
        );

        if (plan.mode === 'retrieval_only') {
          const finalState = retrievalOutcome.succeeded
            ? 'succeeded'
            : 'failed';
          this.runs.finalizeRunTask(
            {
              runId,
              runTaskId: task.runTaskId,
              state: finalState,
              judgeState: 'skipped',
              servingLatencyMs: retrievalOutcome.succeeded
                ? retrievalOutcome.retrievalLatencyMs
                : null,
              judgeLatencyMs: null,
              errorMessage: retrievalOutcome.errorMessage ?? null,
            },
            hooks.guard,
          );
          if (finalState === 'succeeded') pipelineSucceededTasks += 1;
          else pipelineFailedTasks += 1;
          await setImmediate();
          continue;
        }

        // Full RAG mode
        let answerOutcome: {
          succeeded: boolean;
          answerText: string;
          abstained: boolean;
          context: RecordedContextItem[];
          generationLatencyMs: number | null;
          errorMessage?: string;
        };

        if (!retrievalOutcome.succeeded) {
          const abstentionObs = evaluateTaskAbstention({
            answerable: task.answerable,
            generationFailed: true,
            generationError:
              retrievalOutcome.errorMessage ??
              'Retrieval failed before answer generation.',
          });
          this.runs.saveTaskAnswer(
            {
              runId,
              pipelineId: pipeline.pipelineId,
              taskVersionId: task.taskVersionId,
              runTaskId: task.runTaskId,
              answerKey: null,
              succeeded: false,
              generationLatencyMs: null,
              errorCode: 'retrieval_failed',
              errorMessage:
                retrievalOutcome.errorMessage ?? 'Retrieval failed.',
              abstentionObservation: abstentionObs,
            },
            hooks.guard,
          );
          answerOutcome = {
            succeeded: false,
            answerText: '',
            abstained: false,
            context: [],
            generationLatencyMs: null,
            errorMessage: retrievalOutcome.errorMessage,
          };
        } else {
          answerOutcome = await this.executeAnswerStage(
            plan,
            pipeline,
            task,
            generationId,
            retrievalOutcome.retrievalKey,
            retrievalOutcome.items,
            retrievalOutcome.searchResult,
            hooks,
          );
        }

        let judgeState: 'succeeded' | 'partial' | 'failed' | 'skipped' =
          'skipped';
        let judgeLatencyMs: number | null = null;
        if (plan.snapshot.judgeEnabled) {
          const judged = await this.executeJudgeStage(
            plan,
            pipeline,
            task,
            !retrievalOutcome.succeeded,
            answerOutcome,
            hooks,
          );
          judgeState = judged.judgeState;
          judgeLatencyMs = judged.judgeLatencyMs;
        }

        const servingLatencyMs =
          retrievalOutcome.succeeded && answerOutcome.succeeded
            ? retrievalOutcome.retrievalLatencyMs +
              (answerOutcome.generationLatencyMs ?? 0)
            : retrievalOutcome.succeeded
              ? retrievalOutcome.retrievalLatencyMs
              : null;

        let taskFinalState: 'succeeded' | 'partial' | 'failed';
        if (!retrievalOutcome.succeeded || !answerOutcome.succeeded) {
          taskFinalState = 'failed';
          pipelineFailedTasks += 1;
        } else if (judgeState === 'partial' || judgeState === 'failed') {
          taskFinalState = 'partial';
          pipelinePartialTasks += 1;
        } else {
          taskFinalState = 'succeeded';
          pipelineSucceededTasks += 1;
        }

        this.runs.finalizeRunTask(
          {
            runId,
            runTaskId: task.runTaskId,
            state: taskFinalState,
            judgeState,
            servingLatencyMs,
            judgeLatencyMs,
            errorMessage:
              answerOutcome.errorMessage ??
              retrievalOutcome.errorMessage ??
              null,
          },
          hooks.guard,
        );
        await setImmediate();
      }

      const pipelineState =
        pipelineFailedTasks === tasks.length
          ? 'failed'
          : pipelineFailedTasks > 0 || pipelinePartialTasks > 0
            ? 'partial'
            : 'succeeded';
      this.runs.markPipelineState(
        runId,
        pipeline.pipelineId,
        pipelineState,
        pipelineState === 'failed'
          ? 'All tasks failed for this pipeline.'
          : null,
        hooks.guard,
      );
      void pipelineSucceededTasks;
    }

    this.runs.updateRunStage(runId, 'aggregating', hooks.guard);
    hooks.checkpoint?.('aggregating');
    this.runs.finalizeRun(runId, 'succeeded', null, hooks.guard);
  }
}
