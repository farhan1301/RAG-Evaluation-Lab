import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import type {
  IndexSearchResult,
  ProviderKind,
  ProviderUsage,
  RecordedContextItem,
  RetrievedTraceItem,
} from '@rag-eval/contracts';
import type { Indexes } from '../db/indexes.js';
import { LostLease } from '../db/jobs.js';
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
  jobId?: string;
  isRetryJob?: boolean;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError)
    return err.retryable && err.code !== 'timeout';
  if (err instanceof ApiError) return err.status === 502;
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
      pipeline.config.reranker.enabled
        ? {
            ...pipeline.config.reranker,
            model:
              pipeline.resolvedModels.rerank?.model ||
              pipeline.config.reranker.model,
          }
        : pipeline.config.reranker,
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
      endpoint?: string | null;
      expectedDimensions?: number;
    } | null = null;
    if (mode === 'dense' || mode === 'hybrid') {
      const frozenEmbedding = pipeline.resolvedModels.embedding;
      const frozenEmbeddingEndpoint =
        pipeline.resolvedEndpoints.embedding ?? undefined;
      const resolved = this.providers.findProfile(
        'embedding',
        frozenEmbedding?.model ?? pipeline.config.embedding.model,
        frozenEmbedding?.provider,
        frozenEmbeddingEndpoint,
      );
      if (
        !resolved?.capabilities.embeddings ||
        (resolved.provider !== 'openai' &&
          resolved.provider !== 'openai-compatible')
      ) {
        const message = frozenEmbedding
          ? `Frozen embedding profile "${frozenEmbedding.provider}/${frozenEmbedding.model}" is unavailable or its endpoint has changed for pipeline "${pipeline.pipelineName}".`
          : `Embedding profile is unavailable for pipeline "${pipeline.pipelineName}".`;
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
        endpoint: resolved.endpointIdentity,
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
      plan.snapshot.documentArtifacts,
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

    for (let attempt = 1; attempt <= 1 + this.maxTransientRetries; attempt++) {
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      let sawAmbiguousTimeout = false;
      try {
        await this.indexBuilder.build(generationId, {
          signal: hooks.signal,
          guard: hooks.guard,
          beforeEmbedBatch: () => {
            const budgetError = this.checkBudget(plan);
            if (budgetError) {
              throw new ProviderError('invalid_input', budgetError, {
                retryable: false,
              });
            }
          },
          onEmbedBatchStart: (info) => {
            const isRetry = Boolean(hooks.isRetryJob) || attempt > 1;
            const started = this.runs.beginProviderCall(
              {
                stageKeyPrefix: `corpus_embed:${generationId}:batch:${info.batchIndex}`,
                runId: plan.runId,
                jobId: hooks.jobId ?? null,
                pipelineId: pipeline.pipelineId,
                indexGenerationId: generationId,
                operation: 'corpus_embed',
                provider: info.provider,
                model: info.model,
                isRetry,
                priceSchedule: plan.snapshot.priceSchedule,
              },
              hooks.guard,
            );
            return started.id;
          },
          onEmbedCall: (audit) => {
            if (audit.status === 'ambiguous' || audit.errorCode === 'timeout') {
              sawAmbiguousTimeout = true;
            }
            if (audit.callId) {
              if (audit.status === 'cancelled') return;
              this.runs.completeProviderCall(
                audit.callId,
                {
                  provider: audit.provider,
                  model: audit.model,
                  requestId: audit.requestIds[0] ?? null,
                  status: audit.status,
                  errorCode: audit.errorCode,
                  latencyMs: audit.latencyMs,
                  usage: audit.usage,
                  priceSchedule: plan.snapshot.priceSchedule,
                },
                hooks.guard,
              );
              return;
            }
            const isRetry = Boolean(hooks.isRetryJob) || attempt > 1;
            const started = this.runs.beginProviderCall(
              {
                stageKeyPrefix: `corpus_embed:${generationId}:batch:${audit.batchIndex}`,
                runId: plan.runId,
                jobId: hooks.jobId ?? null,
                pipelineId: pipeline.pipelineId,
                indexGenerationId: generationId,
                operation: 'corpus_embed',
                provider: audit.provider,
                model: audit.model,
                isRetry,
                priceSchedule: plan.snapshot.priceSchedule,
              },
              hooks.guard,
            );
            this.runs.completeProviderCall(
              started.id,
              {
                provider: audit.provider,
                model: audit.model,
                requestId: audit.requestIds[0] ?? null,
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
        if (hooks.signal?.aborted || err instanceof LostLease) throw err;
        if (
          !sawAmbiguousTimeout &&
          attempt <= this.maxTransientRetries &&
          isRetryableError(err)
        ) {
          const delay =
            err instanceof ProviderError && err.retryAfterMs
              ? Math.min(err.retryAfterMs, this.retryDelayMs * 4)
              : this.retryDelayMs;
          await wait(delay, undefined, { signal: hooks.signal });
          continue;
        }
        const message = safeMessageOf(err, 'Index build failed.');
        hooks.guard?.();
        if (this.indexes.markFailed(generationId, message)) {
          await this.indexBuilder.cleanupFailedGeneration(generationId);
        }
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
      let sawAmbiguousTimeout = false;
      let result: IndexSearchResult;
      try {
        const resolvedReranker = pipeline.config.reranker.enabled
          ? {
              ...pipeline.config.reranker,
              model:
                pipeline.resolvedModels.rerank?.model ||
                pipeline.config.reranker.model,
            }
          : pipeline.config.reranker;
        result = await this.retrieval.search(
          generationId,
          {
            query: task.question,
            mode: pipeline.config.retriever.mode,
            topK: pipeline.config.retriever.topK,
            candidateDepth: pipeline.config.retriever.candidateDepth,
            fusionWeights: pipeline.config.retriever.fusionWeights,
            filters: plan.snapshot.filters ?? undefined,
            reranker: resolvedReranker,
          },
          hooks.signal,
          {
            expectedEmbeddingProvider:
              pipeline.resolvedModels.embedding?.provider,
            expectedEmbeddingEndpoint:
              pipeline.resolvedEndpoints.embedding ?? undefined,
            expectedRerankerProvider: pipeline.resolvedModels.rerank?.provider,
            expectedRerankerModel: pipeline.resolvedModels.rerank?.model,
            expectedRerankerEndpoint:
              pipeline.resolvedEndpoints.rerank ?? undefined,
            onProviderCallStart: (info) => {
              const isRetry = Boolean(hooks.isRetryJob) || attempt > 1;
              return this.runs.beginProviderCall(
                {
                  stageKeyPrefix: `${info.operation}:${task.runTaskId}`,
                  runId: plan.runId,
                  jobId: hooks.jobId ?? null,
                  pipelineId: pipeline.pipelineId,
                  runTaskId: task.runTaskId,
                  indexGenerationId: generationId,
                  operation: info.operation,
                  provider: info.provider,
                  model: info.model,
                  isRetry,
                  priceSchedule: plan.snapshot.priceSchedule,
                },
                hooks.guard,
              ).id;
            },
            onProviderCall: (audit) => {
              if (
                audit.status === 'ambiguous' ||
                audit.errorCode === 'timeout'
              ) {
                sawAmbiguousTimeout = true;
              }
              if (audit.callId) {
                if (audit.status === 'cancelled') return;
                this.runs.completeProviderCall(
                  audit.callId,
                  {
                    provider: audit.provider,
                    model: audit.model,
                    requestId: audit.requestId,
                    status: audit.status,
                    errorCode: audit.errorCode,
                    latencyMs: audit.latencyMs,
                    usage: audit.usage,
                    priceSchedule: plan.snapshot.priceSchedule,
                  },
                  hooks.guard,
                );
                return;
              }
              const isRetry = Boolean(hooks.isRetryJob) || attempt > 1;
              const started = this.runs.beginProviderCall(
                {
                  stageKeyPrefix: `${audit.operation}:${task.runTaskId}`,
                  runId: plan.runId,
                  jobId: hooks.jobId ?? null,
                  pipelineId: pipeline.pipelineId,
                  runTaskId: task.runTaskId,
                  indexGenerationId: generationId,
                  operation: audit.operation,
                  provider: audit.provider,
                  model: audit.model,
                  isRetry,
                  priceSchedule: plan.snapshot.priceSchedule,
                },
                hooks.guard,
              );
              this.runs.completeProviderCall(
                started.id,
                {
                  provider: audit.provider,
                  model: audit.model,
                  requestId: audit.requestId,
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
      } catch (err) {
        if (hooks.signal?.aborted || err instanceof LostLease) throw err;
        if (
          !sawAmbiguousTimeout &&
          attempt <= this.maxTransientRetries &&
          isRetryableError(err)
        ) {
          await wait(this.retryDelayMs, undefined, { signal: hooks.signal });
          continue;
        }
        const message = sawAmbiguousTimeout
          ? `${safeMessageOf(err, 'Retrieval timed out.')} Outcome is ambiguous after dispatch; explicit retry is required and may incur another provider charge.`
          : safeMessageOf(err, 'Retrieval failed.');
        const observations = evaluateTaskRetrieval({
          retrievalFailed: true,
          retrievalError: message,
          answerable: task.answerable,
          pool: task.pool,
          qrels: task.qrels,
          retrievedChunks: [],
          evaluatedDepth: pipeline.config.retriever.topK,
          cutoffs: plan.snapshot.cutoffs,
        }).map((obs) =>
          sawAmbiguousTimeout
            ? { ...obs, metadata: { ...obs.metadata, ambiguousOutcome: true } }
            : obs,
        );
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
            errorCode: sawAmbiguousTimeout ? 'timeout' : errorCodeOf(err),
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

    // If this same job already dispatched a paid answer attempt (including on a
    // reclaimed retry child), automatic crash recovery MUST NOT re-dispatch silently
    // because providers cannot deduplicate chat calls. Require explicit retry.
    const hasPriorAnswerDispatch = hooks.jobId
      ? this.runs.hasPriorProviderCall(
          plan.runId,
          task.runTaskId,
          'generate',
          undefined,
          hooks.jobId,
        )
      : !hooks.isRetryJob &&
        this.runs.hasPriorProviderCall(plan.runId, task.runTaskId, 'generate');
    if (hasPriorAnswerDispatch) {
      const message =
        'Previous answer generation attempt has an ambiguous outcome after interruption. Explicit retry is required and may incur another provider charge.';
      const abstentionObs = evaluateTaskAbstention({
        answerable: task.answerable,
        generationFailed: true,
        generationError: message,
      });
      abstentionObs.metadata = {
        ...abstentionObs.metadata,
        ambiguousOutcome: true,
      };
      this.runs.saveTaskAnswer(
        {
          runId: plan.runId,
          pipelineId: pipeline.pipelineId,
          taskVersionId: task.taskVersionId,
          runTaskId: task.runTaskId,
          answerKey,
          succeeded: false,
          generationLatencyMs: null,
          errorCode: 'ambiguous_outcome',
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
        generationLatencyMs: null,
        errorMessage: message,
      };
    }

    for (let attempt = 1; attempt <= 1 + this.maxTransientRetries; attempt++) {
      hooks.signal?.throwIfAborted();
      hooks.guard?.();
      const startedAt = this.now();
      const isRetry = Boolean(hooks.isRetryJob) || attempt > 1;
      let callId: string | null = null;
      let result: Awaited<ReturnType<RetrievalService['answerFromSearch']>>;
      // Limit catch strictly to provider dispatch + response validation so a later
      // receipt or answer checkpoint DB error can NEVER overwrite a completed receipt.
      try {
        result = await this.retrieval.answerFromSearch(
          syntheticSearch,
          {
            question: task.question,
            model: chatModel,
            provider: resolvedChat?.provider,
            expectedEndpoint: pipeline.resolvedEndpoints.chat ?? undefined,
            expectedStructuredOutput: resolvedChat?.structuredOutput,
            temperature: resolvedChat?.effectiveTemperature ?? undefined,
            maxTokens:
              resolvedChat?.effectiveMaxTokens ?? pipeline.config.llm.maxTokens,
            contextBudgetChars: plan.snapshot.contextBudgetChars,
            onBeforeCall: (info) => {
              callId = this.runs.beginProviderCall(
                {
                  stageKeyPrefix: `generate:${task.runTaskId}`,
                  runId: plan.runId,
                  jobId: hooks.jobId ?? null,
                  pipelineId: pipeline.pipelineId,
                  runTaskId: task.runTaskId,
                  operation: 'generate',
                  provider: info.provider,
                  model: info.model,
                  isRetry,
                  priceSchedule: plan.snapshot.priceSchedule,
                },
                hooks.guard,
              ).id;
            },
          },
          hooks.signal,
        );
      } catch (err) {
        // Leave in-flight provider_calls row as 'ambiguous' on lease loss or abort.
        if (err instanceof LostLease || hooks.signal?.aborted) throw err;
        const latencyMs = Math.max(0, this.now() - startedAt);
        const isTimeout =
          err instanceof ProviderError && err.code === 'timeout';
        const isAmbiguousTimeout = Boolean(callId) && isTimeout;
        const callMeta =
          err instanceof ProviderError ? err.callMeta : undefined;
        if (callId) {
          this.runs.completeProviderCall(
            callId,
            {
              provider: callMeta?.provider ?? chatProviderKind,
              model: callMeta?.model ?? chatModel,
              requestId: callMeta?.requestId ?? null,
              status: isAmbiguousTimeout
                ? 'ambiguous'
                : isTimeout
                  ? 'timeout'
                  : 'failed',
              errorCode: errorCodeOf(err),
              latencyMs: callMeta?.latencyMs ?? latencyMs,
              usage: callMeta?.usage,
              priceSchedule: plan.snapshot.priceSchedule,
            },
            hooks.guard,
          );
        }
        if (
          !isAmbiguousTimeout &&
          attempt <= this.maxTransientRetries &&
          isRetryableError(err)
        ) {
          await wait(this.retryDelayMs, undefined, { signal: hooks.signal });
          continue;
        }
        const message = isAmbiguousTimeout
          ? `${safeMessageOf(err, 'Answer generation timed out.')} Outcome is ambiguous after dispatch; explicit retry is required and may incur another provider charge.`
          : safeMessageOf(err, 'Answer generation failed.');
        const abstentionObs = evaluateTaskAbstention({
          answerable: task.answerable,
          generationFailed: true,
          generationError: message,
        });
        if (isAmbiguousTimeout) {
          abstentionObs.metadata = {
            ...abstentionObs.metadata,
            ambiguousOutcome: true,
          };
        }
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

      if (callId) {
        this.runs.completeProviderCall(
          callId,
          {
            provider: result.provider,
            model: result.model,
            requestId: result.requestId,
            status: 'succeeded',
            errorCode: null,
            latencyMs: result.latencyMs,
            usage: result.usage,
            priceSchedule: plan.snapshot.priceSchedule,
          },
          hooks.guard,
        );
      }

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
    const frozenJudge = pipeline.resolvedModels.judge;
    const resolved = this.providers.resolveChat(
      'judge',
      frozenJudge?.model ?? pipeline.config.judge.model,
      frozenJudge?.provider,
      pipeline.resolvedEndpoints.judge ?? undefined,
    );
    if (
      frozenJudge &&
      resolved.profile.capabilities.structuredOutput !==
        frozenJudge.structuredOutput
    ) {
      throw new ProviderError(
        'missing_capability',
        `Frozen judge profile "${frozenJudge.provider}/${frozenJudge.model}" structured-output capability has changed.`,
      );
    }
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

      const hasPriorJudgeDispatch = hooks.jobId
        ? this.runs.hasPriorProviderCall(
            plan.runId,
            task.runTaskId,
            'judge',
            `judge:${metricId}:`,
            hooks.jobId,
          )
        : !hooks.isRetryJob &&
          this.runs.hasPriorProviderCall(
            plan.runId,
            task.runTaskId,
            'judge',
            `judge:${metricId}:`,
          );
      if (hasPriorJudgeDispatch) {
        const rubric = getRubric(metricId);
        const obs: ComputedObservation = {
          metricId,
          metricVersion: rubric.version,
          cutoff: 0,
          evaluationUnit: rubric.evaluationUnit,
          status: 'judge_failed',
          value: null,
          reason:
            'Previous judge attempt has an ambiguous outcome after interruption. Explicit retry is required and may incur another provider charge.',
          metadata: {
            judgeModel: resolved.profile.model,
            judgeProvider: resolved.profile.provider,
            rubricVersion: rubric.version,
            rubricHash: rubric.hash,
            rawResponseHash: null,
            ambiguousOutcome: true,
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
        onBeforeCall: (info) =>
          this.runs.beginProviderCall(
            {
              stageKeyPrefix: `judge:${info.metricId}:${info.rubricVersion}`,
              runId: plan.runId,
              jobId: hooks.jobId ?? null,
              pipelineId: pipeline.pipelineId,
              runTaskId: task.runTaskId,
              operation: 'judge',
              provider: info.provider,
              model: info.model,
              isRetry: Boolean(hooks.isRetryJob) || info.isRetry,
              priceSchedule: plan.snapshot.priceSchedule,
            },
            hooks.guard,
          ).id,
        onAfterCall: (callId, audit) => {
          if (!callId) return;
          this.runs.completeProviderCall(
            callId,
            {
              provider: audit.provider,
              model: audit.model,
              requestId: audit.requestId,
              status: audit.callStatus,
              errorCode: audit.errorCode,
              latencyMs: audit.latencyMs,
              usage: audit.usage as ProviderUsage | undefined,
              priceSchedule: plan.snapshot.priceSchedule,
            },
            hooks.guard,
          );
        },
      });

      for (const a of evaluation.attempts) {
        judgeLatencyMs += a.latencyMs;
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
        if (task.state === 'partial' && (!hooks.isRetryJob || hooks.jobId)) {
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

      const pipelineOutcome = this.runs.getPipelineTaskOutcomeSummary(
        runId,
        pipeline.pipelineId,
      );
      const pipelineState =
        pipelineOutcome.total > 0 &&
        pipelineOutcome.failed === pipelineOutcome.total
          ? 'failed'
          : pipelineOutcome.failed > 0 || pipelineOutcome.partial > 0
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
      void pipelineFailedTasks;
      void pipelinePartialTasks;
      void pipelineSucceededTasks;
    }

    this.runs.updateRunStage(runId, 'aggregating', hooks.guard);
    hooks.checkpoint?.('aggregating');
    const runOutcome = this.runs.getRunTaskOutcomeSummary(runId);
    if (runOutcome.total > 0 && runOutcome.failed === runOutcome.total) {
      this.runs.finalizeRun(
        runId,
        'failed',
        runOutcome.firstErrorMessage ?? 'All evaluation tasks failed.',
        hooks.guard,
      );
      return;
    }
    if (runOutcome.hasOutstandingAmbiguousStage) {
      this.runs.finalizeRun(
        runId,
        'failed',
        runOutcome.ambiguousErrorMessage ??
          'One or more stages have an ambiguous outcome after interruption or timeout. Explicit retry is required.',
        hooks.guard,
      );
      return;
    }
    this.runs.finalizeRun(runId, 'succeeded', null, hooks.guard);
  }
}
