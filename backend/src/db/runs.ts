import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  experiment,
  experimentInput,
  judgeAttemptRecord,
  metricObservation,
  pipelineConfig,
  priceSchedule,
  providerCallRecord,
  recordedAnswer,
  recordedContextItem,
  retrievedTraceItem,
  runDetail,
  runSummary,
  runTaskDetail,
  taskInput,
  z,
  type Capabilities,
  type CreateRunRequest,
  type CreateRunResult,
  type Experiment,
  type ExperimentInputRaw,
  type ExperimentPatch,
  type JudgeAttemptRecord,
  type MetricId,
  type MetadataFilters,
  type ObservationStatus,
  type PipelineConfig,
  type PriceSchedule,
  type ProviderKind,
  type ProviderOperation,
  type ProviderUsage,
  type RecordedContextItem,
  type RetrievedTraceItem,
  type RunDetail,
  type RunMode,
  type RunPipelineState,
  type RunPipelineSummary,
  type RunSummary,
  type RunTaskDetail,
} from '@rag-eval/contracts';
import { ApiError, missing } from '../errors.js';
import {
  aggregateMetricObservations,
  computeLatencyStats,
  RETRIEVAL_METRIC_VERSION,
  type ComputedObservation,
  type ObservationRowForAggregation,
} from '../evaluation/metrics.js';
import {
  aggregateCostAndTokens,
  priceProviderCall,
  type ProviderCallCostRow,
} from '../evaluation/pricing.js';
import { rubricVersionMap } from '../evaluation/rubrics.js';
import { sha256 } from '../ingestion/chunks.js';
import {
  validateGenerationParams,
  validatePipelineCapabilities,
} from '../providers/registry.js';
import { transaction } from './database.js';
import type { Datasets } from './datasets.js';
import { paginate } from './definitions.js';
import type { Indexes } from './indexes.js';
import type { Jobs } from './jobs.js';
import type { Pipelines } from './pipelines.js';

export const PROMPT_VERSION = 'grounded-answer-v1';
export const SOFTWARE_VERSION = '0.1.0';

const frozenSnapshotSchema = z.strictObject({
  softwareVersion: z.string(),
  datasetId: z.uuid(),
  datasetRevision: z.int().positive(),
  datasetName: z.string(),
  mode: z.enum(['retrieval_only', 'full_rag']),
  judgeEnabled: z.boolean(),
  cutoffs: z.array(z.int().positive()),
  contextBudgetChars: z.int().positive(),
  filters: z.any().nullable(),
  promptVersion: z.string(),
  retrievalMetricVersion: z.string(),
  rubricVersions: z.record(z.string(), z.string()),
  priceSchedule,
  budgets: z.strictObject({
    maxTokens: z.int().positive().nullable(),
    maxCostUsd: z.number().positive().nullable(),
  }),
});
export type FrozenRunSnapshot = z.infer<typeof frozenSnapshotSchema>;

export type ResolvedPipelineModels = RunPipelineSummary['resolvedModels'];

export interface ExecutionPlanPipeline {
  pipelineId: string;
  pipelineRevision: number;
  ordinal: number;
  pipelineName: string;
  isBaseline: boolean;
  config: PipelineConfig;
  configHash: string;
  resolvedModels: ResolvedPipelineModels;
  indexGenerationId: string | null;
  indexReused: boolean;
  indexTimeMs: number | null;
  state: RunPipelineState;
}

export interface ExecutionPlanTask {
  runTaskId: string;
  pipelineId: string;
  taskId: string;
  taskVersionId: string;
  ordinal: number;
  question: string;
  expectedAnswer: string;
  acceptanceRule: string;
  referenceFacts: string[];
  answerable: boolean;
  pool: 'complete' | 'partial';
  qrels: Array<{ documentId: string; grade: number }>;
  retrievalKey: string | null;
  answerKey: string | null;
  retrievalState: 'pending' | 'succeeded' | 'failed' | 'skipped';
  answerState: 'pending' | 'succeeded' | 'failed' | 'skipped';
  judgeState: 'pending' | 'succeeded' | 'partial' | 'failed' | 'skipped';
  state:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'cancelled';
  retrievalLatencyMs: number | null;
  rerankLatencyMs: number | null;
  generationLatencyMs: number | null;
  judgeLatencyMs: number | null;
}

export interface ExecutionPlan {
  runId: string;
  mode: RunMode;
  state: string;
  queuedAt: string;
  startedAt: string | null;
  snapshot: FrozenRunSnapshot;
  pipelines: ExecutionPlanPipeline[];
  tasks: ExecutionPlanTask[];
}

export interface CreateRunOptions {
  capabilities: Capabilities;
  pricing: PriceSchedule;
  budgets: { maxTokens: number | null; maxCostUsd: number | null };
  idempotencyKey?: string | null;
}

const RETRIEVAL_METRIC_IDS = new Set<MetricId>([
  'hit_at_k',
  'precision_at_k',
  'recall_at_k',
  'mrr_at_k',
  'mrr',
  'ndcg_at_k',
]);
const JUDGE_METRIC_IDS = new Set<MetricId>([
  'faithfulness',
  'answer_relevance',
  'context_precision',
  'context_recall',
  'answer_correctness',
]);
const ABSTENTION_METRIC_IDS = new Set<MetricId>([
  'abstention_answerable',
  'abstention_unanswerable',
]);

function decodeExperiment(row: Record<string, unknown>): Experiment {
  return experiment.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    datasetId: row.dataset_id,
    baselinePipelineId: row.baseline_pipeline_id,
    pipelineIds: JSON.parse(String(row.pipeline_ids)),
    mode: row.mode,
    config: JSON.parse(String(row.config)),
    revision: row.revision,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function resolvePipelineModels(
  config: PipelineConfig,
  mode: RunMode,
  judgeEnabled: boolean,
  capabilities: Capabilities,
): ResolvedPipelineModels {
  validatePipelineCapabilities(config, capabilities);

  const findRole = (
    role: 'embedding' | 'chat' | 'judge' | 'rerank',
    model: string,
  ) =>
    capabilities.profiles.find(
      (p) => p.role === role && (!model || p.model === model),
    );

  let embedding: ResolvedPipelineModels['embedding'] = null;
  if (config.retriever.mode === 'dense' || config.retriever.mode === 'hybrid') {
    const profile = findRole('embedding', config.embedding.model);
    if (!profile) {
      throw new ApiError(
        422,
        'missing_capability',
        `Retrieval mode "${config.retriever.mode}" requires a configured embedding profile.`,
      );
    }
    embedding = { provider: profile.provider, model: profile.model };
  }

  let rerank: ResolvedPipelineModels['rerank'] = null;
  if (config.reranker.enabled) {
    const profile = findRole('rerank', config.reranker.model);
    if (!profile) {
      throw new ApiError(
        422,
        'missing_capability',
        'Reranking requires a configured HTTP reranker profile.',
      );
    }
    rerank = { provider: profile.provider, model: profile.model };
  }

  let chat: ResolvedPipelineModels['chat'] = null;
  let judge: ResolvedPipelineModels['judge'] = null;

  if (mode === 'full_rag') {
    const chatProfile = findRole('chat', config.llm.model);
    if (!chatProfile?.capabilities.chat) {
      throw new ApiError(
        422,
        'missing_capability',
        'Full RAG mode requires a configured chat profile.',
      );
    }
    validateGenerationParams(chatProfile, {
      temperature: config.llm.temperature,
      maxTokens: config.llm.maxTokens,
    });
    chat = {
      provider: chatProfile.provider,
      model: chatProfile.model,
      effectiveTemperature: chatProfile.capabilities.temperature
        ? config.llm.temperature
        : null,
      effectiveMaxTokens: chatProfile.capabilities.maxTokens
        ? config.llm.maxTokens
        : null,
      structuredOutput: chatProfile.capabilities.structuredOutput,
    };

    if (judgeEnabled) {
      const judgeProfile = findRole('judge', config.judge.model);
      if (!judgeProfile?.capabilities.chat) {
        throw new ApiError(
          422,
          'missing_capability',
          'Full RAG mode with judging enabled requires a configured judge profile.',
        );
      }
      judge = {
        provider: judgeProfile.provider,
        model: judgeProfile.model,
        effectiveTemperature: judgeProfile.capabilities.temperature ? 0 : null,
        structuredOutput: judgeProfile.capabilities.structuredOutput,
      };
    }
  }

  return { embedding, rerank, chat, judge };
}

export class Runs {
  constructor(
    private readonly db: DatabaseSync,
    private readonly datasets: Datasets,
    private readonly pipelines: Pipelines,
    private readonly indexes: Indexes,
    private readonly jobs: Jobs,
    private readonly now = Date.now,
  ) {}

  private validateExperimentRefs(datasetId: string, pipelineIds: string[]) {
    const ds = this.datasets.head(datasetId);
    if (ds.archived) {
      throw new ApiError(
        409,
        'archived',
        'Cannot reference an archived dataset.',
      );
    }
    for (const pid of pipelineIds) {
      const pl = this.pipelines.head(pid);
      if (pl.archived) {
        throw new ApiError(
          409,
          'archived',
          'Cannot reference an archived pipeline.',
        );
      }
    }
  }

  listExperiments(limit: number, cursor = '') {
    const rows = this.db
      .prepare(
        `SELECT * FROM experiments WHERE archived = 0 AND id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(cursor, limit + 1)
      .map((row) => decodeExperiment(row));
    return paginate(rows, limit, (item) => item.id);
  }

  getExperiment(id: string): Experiment {
    const row = this.db
      .prepare('SELECT * FROM experiments WHERE id = ?')
      .get(id);
    if (!row) return missing();
    return decodeExperiment(row);
  }

  createExperiment(raw: ExperimentInputRaw): Experiment {
    const input = experimentInput.parse(raw);
    return transaction(this.db, () => {
      this.validateExperimentRefs(input.datasetId, input.pipelineIds);
      const id = randomUUID();
      const timestamp = new Date(this.now()).toISOString();
      this.db
        .prepare(
          `INSERT INTO experiments(
            id, name, description, dataset_id, baseline_pipeline_id,
            pipeline_ids, mode, config, revision, archived, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.description,
          input.datasetId,
          input.baselinePipelineId,
          JSON.stringify(input.pipelineIds),
          input.mode,
          JSON.stringify(input.config),
          timestamp,
          timestamp,
        );
      return this.getExperiment(id);
    });
  }

  editExperiment(
    id: string,
    expectedRevision: number,
    patch: ExperimentPatch,
  ): Experiment {
    return transaction(this.db, () => {
      const current = this.getExperiment(id);
      if (current.archived) {
        throw new ApiError(
          409,
          'archived',
          'This experiment has been archived.',
        );
      }
      if (current.revision !== expectedRevision) {
        throw new ApiError(
          409,
          'stale_revision',
          'Another editor saved changes. Load the latest revision before retrying.',
        );
      }
      const merged = experimentInput.parse({
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        datasetId: patch.datasetId ?? current.datasetId,
        baselinePipelineId:
          patch.baselinePipelineId ?? current.baselinePipelineId,
        pipelineIds: patch.pipelineIds ?? current.pipelineIds,
        mode: patch.mode ?? current.mode,
        config: patch.config ?? current.config,
      });
      this.validateExperimentRefs(merged.datasetId, merged.pipelineIds);
      const nextRev = expectedRevision + 1;
      this.db
        .prepare(
          `UPDATE experiments
           SET name = ?, description = ?, dataset_id = ?, baseline_pipeline_id = ?,
               pipeline_ids = ?, mode = ?, config = ?, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND archived = 0`,
        )
        .run(
          merged.name,
          merged.description,
          merged.datasetId,
          merged.baselinePipelineId,
          JSON.stringify(merged.pipelineIds),
          merged.mode,
          JSON.stringify(merged.config),
          nextRev,
          new Date(this.now()).toISOString(),
          id,
          expectedRevision,
        );
      return this.getExperiment(id);
    });
  }

  archiveExperiment(id: string, expectedRevision: number) {
    transaction(this.db, () => {
      const current = this.getExperiment(id);
      if (current.archived) {
        throw new ApiError(
          409,
          'archived',
          'This experiment has been archived.',
        );
      }
      if (current.revision !== expectedRevision) {
        throw new ApiError(
          409,
          'stale_revision',
          'Another editor saved changes. Load the latest revision before retrying.',
        );
      }
      this.db
        .prepare(
          'UPDATE experiments SET archived = 1, updated_at = ? WHERE id = ? AND revision = ?',
        )
        .run(new Date(this.now()).toISOString(), id, expectedRevision);
    });
  }

  /**
   * Freezes the immutable run snapshot (dataset revision, task versions, qrels,
   * pipeline revisions, resolved models, rubrics, prompts, price schedule) and enqueues
   * the run job in a single SQLite write transaction.
   */
  createRun(
    experimentId: string,
    request: CreateRunRequest,
    options: CreateRunOptions,
  ): CreateRunResult {
    const idempotencyKey = options.idempotencyKey ?? null;
    const requestHash = sha256(
      JSON.stringify(['create-run-v1', experimentId, request]),
    );

    return transaction(this.db, () => {
      const replayed = this.jobs.replayRun(idempotencyKey, requestHash);
      if (replayed) {
        return {
          run: this.getRun(replayed.runId),
          job: this.jobs.get(replayed.jobId),
          reused: true,
        };
      }

      const exp = this.getExperiment(experimentId);
      if (exp.archived) {
        throw new ApiError(
          409,
          'archived',
          'Cannot start a run for an archived experiment.',
        );
      }

      const mode: RunMode = request.mode ?? exp.mode;
      const judgeEnabled = request.judgeEnabled ?? exp.config.judgeEnabled;
      const contextBudgetChars =
        request.contextBudgetChars ?? exp.config.contextBudgetChars;
      const filters: MetadataFilters | null =
        request.filters ?? exp.config.filters ?? null;

      const frozenDataset = this.datasets.get(
        exp.datasetId,
        request.datasetRevision,
      );
      if (request.datasetRevision === undefined && frozenDataset.archived) {
        throw new ApiError(
          409,
          'archived',
          'Cannot run an experiment against an archived dataset.',
        );
      }
      // Verify >=1 document and all non-text documents have succeeded parse artifacts.
      this.indexes.revisionDocuments(frozenDataset.id, frozenDataset.revision);

      if (!frozenDataset.tasks.length) {
        throw new ApiError(
          409,
          'conflict',
          'Add at least one evaluation task before running an experiment.',
        );
      }

      const frozenPipelines = exp.pipelineIds.map((pid) => {
        const pl = this.pipelines.get(pid);
        if (pl.archived) {
          throw new ApiError(
            409,
            'archived',
            `Pipeline "${pl.name}" has been archived.`,
          );
        }
        const resolvedModels = resolvePipelineModels(
          pl.config,
          mode,
          judgeEnabled,
          options.capabilities,
        );
        return { pipeline: pl, resolvedModels };
      });

      const baselineEntry = frozenPipelines.find(
        (entry) => entry.pipeline.id === exp.baselinePipelineId,
      );
      if (!baselineEntry) {
        throw new ApiError(
          400,
          'invalid_input',
          'Baseline pipeline is missing from this experiment.',
        );
      }

      const baseCutoffs = request.cutoffs ?? exp.config.cutoffs;
      const cutoffs = Array.from(
        new Set([
          ...baseCutoffs,
          ...frozenPipelines.map((p) => p.pipeline.config.retriever.topK),
        ]),
      ).sort((a, b) => a - b);

      const rubrics = rubricVersionMap();
      const snapshot: FrozenRunSnapshot = {
        softwareVersion: SOFTWARE_VERSION,
        datasetId: frozenDataset.id,
        datasetRevision: frozenDataset.revision,
        datasetName: frozenDataset.name,
        mode,
        judgeEnabled: mode === 'full_rag' ? judgeEnabled : false,
        cutoffs,
        contextBudgetChars,
        filters,
        promptVersion: PROMPT_VERSION,
        retrievalMetricVersion: RETRIEVAL_METRIC_VERSION,
        rubricVersions: rubrics,
        priceSchedule: options.pricing,
        budgets: options.budgets,
      };

      const runId = randomUUID();
      const queuedAt = new Date(this.now()).toISOString();
      const runName =
        request.name ?? `${exp.name} · r${frozenDataset.revision}`;
      const totalUnits = frozenPipelines.length * frozenDataset.tasks.length;

      this.db
        .prepare(
          `INSERT INTO runs(
            id, experiment_id, name, mode, state, stage,
            dataset_id, dataset_revision, baseline_pipeline_id, baseline_pipeline_revision,
            snapshot, queued_at, total_units, completed_units, failed_units,
            request_key, request_hash
          ) VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        )
        .run(
          runId,
          exp.id,
          runName,
          mode,
          frozenDataset.id,
          frozenDataset.revision,
          baselineEntry.pipeline.id,
          baselineEntry.pipeline.revision,
          JSON.stringify(snapshot),
          queuedAt,
          totalUnits,
          idempotencyKey,
          requestHash,
        );

      const insertPipeline = this.db.prepare(
        `INSERT INTO run_pipelines(
          run_id, pipeline_id, pipeline_revision, ordinal, pipeline_name,
          is_baseline, config, config_hash, resolved_models, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      );
      const insertTask = this.db.prepare(
        `INSERT INTO run_tasks(
          id, run_id, pipeline_id, task_id, task_version_id, ordinal,
          retrieval_state, answer_state, judge_state, state
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'pending')`,
      );

      const answerInitial = mode === 'full_rag' ? 'pending' : 'skipped';
      const judgeInitial =
        mode === 'full_rag' && judgeEnabled ? 'pending' : 'skipped';

      frozenPipelines.forEach(({ pipeline: pl, resolvedModels }, pIdx) => {
        insertPipeline.run(
          runId,
          pl.id,
          pl.revision,
          pIdx,
          pl.name,
          Number(pl.id === exp.baselinePipelineId),
          JSON.stringify(pl.config),
          pl.hash,
          JSON.stringify(resolvedModels),
        );
        frozenDataset.tasks.forEach((taskRow, tIdx) => {
          insertTask.run(
            randomUUID(),
            runId,
            pl.id,
            taskRow.id,
            taskRow.versionId,
            tIdx,
            answerInitial,
            judgeInitial,
          );
        });
      });

      const jobId = this.jobs.enqueueRun(runId, idempotencyKey, requestHash);
      return {
        run: this.getRun(runId),
        job: this.jobs.get(jobId),
        reused: false,
      };
    });
  }

  private runSummaryFromRow(row: Record<string, unknown>): RunSummary {
    const runId = String(row.id);
    const snap = frozenSnapshotSchema.parse(JSON.parse(String(row.snapshot)));
    const pipelineCount = Number(
      this.db
        .prepare('SELECT count(*) AS n FROM run_pipelines WHERE run_id = ?')
        .get(runId)?.n ?? 0,
    );
    const taskCount =
      pipelineCount > 0
        ? Math.round(Number(row.total_units) / pipelineCount)
        : 0;
    const jobRow = this.db
      .prepare(
        'SELECT id FROM run_jobs WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(runId);

    return runSummary.parse({
      id: row.id,
      experimentId: row.experiment_id,
      name: row.name,
      mode: row.mode,
      state: row.state,
      stage: row.stage,
      datasetId: row.dataset_id,
      datasetRevision: row.dataset_revision,
      datasetName: snap.datasetName,
      baselinePipelineId: row.baseline_pipeline_id,
      pipelineCount,
      taskCount,
      completedUnits: row.completed_units,
      failedUnits: row.failed_units,
      totalUnits: row.total_units,
      jobId: String(jobRow?.id ?? ''),
      workerOnline: this.jobs.online(),
      queuedAt: row.queued_at,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
      queueWaitMs: row.queue_wait_ms ?? null,
      wallClockMs: row.wall_clock_ms ?? null,
      errorMessage: row.error_message ?? null,
    });
  }

  listRuns(limit: number, cursor?: string, experimentId?: string) {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (experimentId) {
      clauses.push('experiment_id = ?');
      params.push(experimentId);
    }
    if (cursor) {
      const sep = cursor.lastIndexOf('|');
      if (sep <= 0) {
        throw new ApiError(400, 'invalid_input', 'Invalid runs cursor.');
      }
      const cursorTime = cursor.slice(0, sep);
      const cursorId = cursor.slice(sep + 1);
      clauses.push('(queued_at < ? OR (queued_at = ? AND id < ?))');
      params.push(cursorTime, cursorTime, cursorId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit + 1);
    const rows = this.db
      .prepare(
        `SELECT * FROM runs ${where} ORDER BY queued_at DESC, id DESC LIMIT ?`,
      )
      .all(...params)
      .map((row) => this.runSummaryFromRow(row));
    return paginate(rows, limit, (item) => `${item.queuedAt}|${item.id}`);
  }

  private loadProviderCalls(runId: string): Array<
    ProviderCallCostRow & {
      pipelineId: string | null;
      indexGenerationId: string | null;
      status: string;
    }
  > {
    return this.db
      .prepare(
        `SELECT pipeline_id AS pipelineId, index_generation_id AS indexGenerationId,
                operation, model, is_retry AS isRetry, status,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
                total_tokens AS totalTokens, usage_status AS usageStatus,
                cost_status AS costStatus, cost_usd AS costUsd
         FROM provider_calls
         WHERE run_id = ?
         ORDER BY rowid ASC`,
      )
      .all(runId)
      .map((row) => ({
        pipelineId: typeof row.pipelineId === 'string' ? row.pipelineId : null,
        indexGenerationId:
          typeof row.indexGenerationId === 'string'
            ? row.indexGenerationId
            : null,
        operation: row.operation as ProviderOperation,
        model: String(row.model),
        isRetry: Number(row.isRetry) === 1,
        status: String(row.status),
        inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
        outputTokens:
          row.outputTokens === null ? null : Number(row.outputTokens),
        cacheReadTokens:
          row.cacheReadTokens === null ? null : Number(row.cacheReadTokens),
        cacheCreationTokens:
          row.cacheCreationTokens === null
            ? null
            : Number(row.cacheCreationTokens),
        totalTokens: row.totalTokens === null ? null : Number(row.totalTokens),
        usageStatus: row.usageStatus as 'known' | 'missing',
        costStatus: row.costStatus as 'known' | 'unknown',
        costUsd: row.costUsd === null ? null : Number(row.costUsd),
      }));
  }

  getRun(runId: string): RunDetail {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!row) return missing();
    const base = this.runSummaryFromRow(row);
    const snap = frozenSnapshotSchema.parse(JSON.parse(String(row.snapshot)));

    const pipelineRows = this.db
      .prepare(
        'SELECT * FROM run_pipelines WHERE run_id = ? ORDER BY ordinal ASC',
      )
      .all(runId);
    const allCalls = this.loadProviderCalls(runId);

    const obsStmt = this.db.prepare(
      `SELECT metric_id AS metricId, metric_version AS metricVersion,
              cutoff, evaluation_unit AS evaluationUnit, status, value, metadata
       FROM metric_observations
       WHERE run_id = ? AND pipeline_id = ?`,
    );
    const taskStatsStmt = this.db.prepare(
      `SELECT state, retrieval_latency_ms AS retrievalLatencyMs,
              rerank_latency_ms AS rerankLatencyMs,
              generation_latency_ms AS generationLatencyMs,
              judge_latency_ms AS judgeLatencyMs,
              serving_latency_ms AS servingLatencyMs,
              error_code AS errorCode
       FROM run_tasks
       WHERE run_id = ? AND pipeline_id = ?`,
    );

    const allServingLatencies: number[] = [];
    const allEvalLatencies: number[] = [];
    let totalTimeouts = 0;
    let totalCancellations = 0;
    let totalQueries = 0;

    const pipelines: RunPipelineSummary[] = pipelineRows.map((pRow) => {
      const pipelineId = String(pRow.pipeline_id);
      const taskRows = taskStatsStmt.all(runId, pipelineId);
      const retrievalLat: number[] = [];
      const rerankLat: number[] = [];
      const generationLat: number[] = [];
      const servingLat: number[] = [];
      const evalLat: number[] = [];
      let completedTasks = 0;
      let failedTasks = 0;
      let timeoutCount = 0;
      let cancellationCount = 0;

      for (const t of taskRows) {
        const st = String(t.state);
        if (st === 'succeeded' || st === 'partial') completedTasks += 1;
        else if (st === 'failed') failedTasks += 1;
        if (t.errorCode === 'timeout') timeoutCount += 1;
        if (st === 'cancelled' || t.errorCode === 'cancelled')
          cancellationCount += 1;
        if (typeof t.retrievalLatencyMs === 'number')
          retrievalLat.push(t.retrievalLatencyMs);
        if (typeof t.rerankLatencyMs === 'number')
          rerankLat.push(t.rerankLatencyMs);
        if (typeof t.generationLatencyMs === 'number')
          generationLat.push(t.generationLatencyMs);
        if (typeof t.servingLatencyMs === 'number') {
          servingLat.push(t.servingLatencyMs);
          allServingLatencies.push(t.servingLatencyMs);
        }
        if (typeof t.judgeLatencyMs === 'number') {
          evalLat.push(t.judgeLatencyMs);
          allEvalLatencies.push(t.judgeLatencyMs);
        }
      }

      const obsRows: ObservationRowForAggregation[] = obsStmt
        .all(runId, pipelineId)
        .map((o) => ({
          metricId: o.metricId as MetricId,
          metricVersion: String(o.metricVersion),
          cutoff: Number(o.cutoff),
          evaluationUnit:
            o.evaluationUnit as ObservationRowForAggregation['evaluationUnit'],
          status: o.status as ObservationStatus,
          value: o.value === null ? null : Number(o.value),
          metadata: o.metadata ? JSON.parse(String(o.metadata)) : null,
        }));

      const allAgg = aggregateMetricObservations(obsRows);
      const retrievalMetrics = allAgg.filter((m) =>
        RETRIEVAL_METRIC_IDS.has(m.metricId),
      );
      const judgeMetrics = allAgg.filter((m) =>
        JUDGE_METRIC_IDS.has(m.metricId),
      );
      const abstentionMetrics = allAgg.filter((m) =>
        ABSTENTION_METRIC_IDS.has(m.metricId),
      );

      const pipelineCalls = allCalls.filter((c) => c.pipelineId === pipelineId);
      for (const c of pipelineCalls) {
        if (c.status === 'timeout') timeoutCount += 1;
        if (c.status === 'cancelled') cancellationCount += 1;
      }

      totalTimeouts += timeoutCount;
      totalCancellations += cancellationCount;
      const queryCount = servingLat.length || taskRows.length;
      totalQueries += queryCount;

      const { cost, tokens } = aggregateCostAndTokens(
        pipelineCalls,
        snap.priceSchedule.version,
        queryCount,
      );

      return {
        pipelineId,
        pipelineRevision: Number(pRow.pipeline_revision),
        ordinal: Number(pRow.ordinal),
        pipelineName: String(pRow.pipeline_name),
        isBaseline: Number(pRow.is_baseline) === 1,
        config: pipelineConfig.parse(JSON.parse(String(pRow.config))),
        configHash: String(pRow.config_hash),
        resolvedModels: JSON.parse(String(pRow.resolved_models)),
        indexGenerationId:
          typeof pRow.index_generation_id === 'string'
            ? pRow.index_generation_id
            : null,
        indexReused: Number(pRow.index_reused) === 1,
        state: pRow.state as RunPipelineState,
        errorMessage:
          typeof pRow.error_message === 'string' ? pRow.error_message : null,
        completedTasks,
        failedTasks,
        totalTasks: taskRows.length,
        retrievalMetrics,
        judgeMetrics,
        abstentionMetrics,
        latency: {
          indexTimeMs:
            pRow.index_time_ms === null ? null : Number(pRow.index_time_ms),
          retrieval: computeLatencyStats(retrievalLat),
          rerank: computeLatencyStats(rerankLat),
          generation: computeLatencyStats(generationLat),
          serving: computeLatencyStats(servingLat),
          evaluation: computeLatencyStats(evalLat),
          timeoutCount,
          cancellationCount,
        },
        cost,
        tokens,
      };
    });

    const runAgg = aggregateCostAndTokens(
      allCalls,
      snap.priceSchedule.version,
      totalQueries,
    );

    return runDetail.parse({
      ...base,
      baselinePipelineRevision: Number(row.baseline_pipeline_revision),
      snapshot: {
        softwareVersion: snap.softwareVersion,
        datasetId: snap.datasetId,
        datasetRevision: snap.datasetRevision,
        datasetName: snap.datasetName,
        mode: snap.mode,
        judgeEnabled: snap.judgeEnabled,
        cutoffs: snap.cutoffs,
        contextBudgetChars: snap.contextBudgetChars,
        filters: snap.filters,
        promptVersion: snap.promptVersion,
        retrievalMetricVersion: snap.retrievalMetricVersion,
        rubricVersions: snap.rubricVersions,
        priceScheduleVersion: snap.priceSchedule.version,
        budgets: snap.budgets,
      },
      pipelines,
      cost: runAgg.cost,
      tokens: runAgg.tokens,
      latency: {
        queueWaitMs: base.queueWaitMs,
        wallClockMs: base.wallClockMs,
        serving: computeLatencyStats(allServingLatencies),
        evaluation: computeLatencyStats(allEvalLatencies),
        timeoutCount: totalTimeouts,
        cancellationCount: totalCancellations,
      },
    });
  }

  private hydrateRunTask(row: Record<string, unknown>): RunTaskDetail {
    const runTaskId = String(row.id);
    const fields = taskInput.parse({
      ...JSON.parse(String(row.taskFields)),
      pool: row.taskPool,
      qrels: [],
    });
    const qrels = this.db
      .prepare(
        `SELECT d.document_id AS documentId, q.grade
         FROM qrels q JOIN document_versions d ON d.id = q.document_version
         WHERE q.task_version = ? ORDER BY d.document_id ASC`,
      )
      .all(String(row.task_version_id))
      .map((q) => ({
        documentId: String(q.documentId),
        grade: Number(q.grade),
      }));

    const retrievedItems = this.db
      .prepare(
        `SELECT chunk_id AS chunkId, document_id AS documentId,
                document_version_id AS documentVersionId, document_name AS documentName,
                mime_type AS mimeType, ordinal, start, end, page, content,
                keyword_rank AS keywordRank, keyword_score AS keywordScore,
                dense_rank AS denseRank, dense_score AS denseScore,
                fused_rank AS fusedRank, fused_score AS fusedScore,
                rerank_rank AS rerankRank, rerank_score AS rerankScore,
                final_rank AS finalRank, final_score AS finalScore
         FROM retrieved_items WHERE run_task_id = ? ORDER BY final_rank ASC`,
      )
      .all(runTaskId)
      .map((item) => retrievedTraceItem.parse(item));

    const ansRow = this.db
      .prepare('SELECT * FROM answers WHERE run_task_id = ?')
      .get(runTaskId);
    const answer = ansRow
      ? recordedAnswer.parse({
          answerText: ansRow.answer_text,
          abstained: Number(ansRow.abstained) === 1,
          citations: JSON.parse(String(ansRow.citations)),
          invalidCitations: JSON.parse(String(ansRow.invalid_citations)),
          context: JSON.parse(String(ansRow.context)),
          promptVersion: ansRow.prompt_version,
          provider: ansRow.provider,
          model: ansRow.model,
          effectiveParams: JSON.parse(String(ansRow.effective_params)),
          requestId: ansRow.request_id ?? null,
          latencyMs: ansRow.latency_ms,
          reusedFromRunTaskId: ansRow.reused_from_run_task_id ?? null,
        })
      : null;

    const observations = this.db
      .prepare(
        `SELECT id, metric_id AS metricId, metric_version AS metricVersion,
                cutoff, evaluation_unit AS evaluationUnit, status, value,
                reason, metadata, judge_attempt_id AS judgeAttemptId
         FROM metric_observations
         WHERE run_task_id = ?
         ORDER BY metric_id ASC, cutoff ASC`,
      )
      .all(runTaskId)
      .map((o) =>
        metricObservation.parse({
          ...o,
          metadata: o.metadata ? JSON.parse(String(o.metadata)) : null,
          judgeAttemptId: o.judgeAttemptId ?? null,
        }),
      );

    const judgeAttempts: JudgeAttemptRecord[] = this.db
      .prepare(
        `SELECT id, metric_id AS metricId, rubric_version AS rubricVersion,
                attempt_number AS attemptNumber, is_repair AS isRepair,
                provider, model, effective_params AS effectiveParams,
                status, reason, raw_response_hash AS rawResponseHash,
                parsed_output AS parsedOutput, score, request_id AS requestId,
                latency_ms AS latencyMs, created_at AS createdAt
         FROM judge_attempts
         WHERE run_task_id = ?
         ORDER BY metric_id ASC, attempt_number ASC`,
      )
      .all(runTaskId)
      .map((a) =>
        judgeAttemptRecord.parse({
          ...a,
          isRepair: Number(a.isRepair) === 1,
          effectiveParams: JSON.parse(String(a.effectiveParams)),
          parsedOutput: a.parsedOutput
            ? JSON.parse(String(a.parsedOutput))
            : null,
          requestId: a.requestId ?? null,
        }),
      );

    const providerCalls = this.db
      .prepare(
        `SELECT id, operation, provider, model, request_id AS requestId,
                attempt_number AS attemptNumber, is_retry AS isRetry,
                status, error_code AS errorCode, latency_ms AS latencyMs,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
                total_tokens AS totalTokens, usage_status AS usageStatus,
                price_version AS priceVersion, cost_status AS costStatus,
                cost_usd AS costUsd, created_at AS createdAt
         FROM provider_calls
         WHERE run_task_id = ?
         ORDER BY rowid ASC`,
      )
      .all(runTaskId)
      .map((c) =>
        providerCallRecord.parse({
          ...c,
          isRetry: Number(c.isRetry) === 1,
          requestId: c.requestId ?? null,
          errorCode: c.errorCode ?? null,
        }),
      );

    return runTaskDetail.parse({
      id: runTaskId,
      runId: row.run_id,
      pipelineId: row.pipeline_id,
      pipelineName: row.pipelineName,
      taskId: row.task_id,
      taskVersionId: row.task_version_id,
      ordinal: row.ordinal,
      question: fields.question,
      expectedAnswer: fields.expectedAnswer,
      acceptanceRule: fields.acceptanceRule,
      referenceFacts: fields.referenceFacts,
      answerable: fields.answerable,
      pool: fields.pool,
      qrels,
      state: row.state,
      retrievalState: row.retrieval_state,
      answerState: row.answer_state,
      judgeState: row.judge_state,
      retrievalLatencyMs: row.retrieval_latency_ms ?? null,
      rerankLatencyMs: row.rerank_latency_ms ?? null,
      generationLatencyMs: row.generation_latency_ms ?? null,
      judgeLatencyMs: row.judge_latency_ms ?? null,
      servingLatencyMs: row.serving_latency_ms ?? null,
      retrievedDepth: row.retrieved_depth ?? null,
      retrievedCount: row.retrieved_count ?? null,
      rerankStatus: row.rerank_status ?? null,
      rerankError: row.rerank_error ?? null,
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
      retrievedItems,
      answer,
      observations,
      judgeAttempts,
      providerCalls,
    });
  }

  listRunTasks(runId: string, limit: number, cursor = 0, pipelineId?: string) {
    const exists = this.db
      .prepare('SELECT 1 FROM runs WHERE id = ?')
      .get(runId);
    if (!exists) return missing();
    const params: SQLInputValue[] = [runId];
    const clauses = ['rt.run_id = ?'];
    if (pipelineId) {
      clauses.push('rt.pipeline_id = ?');
      params.push(pipelineId);
    }
    params.push(limit + 1, cursor);

    const rows = this.db
      .prepare(
        `SELECT rt.*, rp.pipeline_name AS pipelineName,
                tv.fields AS taskFields, tv.pool AS taskPool
         FROM run_tasks rt
         JOIN run_pipelines rp ON rp.run_id = rt.run_id AND rp.pipeline_id = rt.pipeline_id
         JOIN task_versions tv ON tv.id = rt.task_version_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY rp.ordinal ASC, rt.ordinal ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params);

    const items = rows.slice(0, limit).map((r) => this.hydrateRunTask(r));
    return {
      items,
      nextCursor: rows.length > limit ? String(cursor + limit) : null,
    };
  }

  getRunTask(runId: string, taskOrRunTaskId: string): RunTaskDetail[] {
    const exists = this.db
      .prepare('SELECT 1 FROM runs WHERE id = ?')
      .get(runId);
    if (!exists) return missing();
    const rows = this.db
      .prepare(
        `SELECT rt.*, rp.pipeline_name AS pipelineName,
                tv.fields AS taskFields, tv.pool AS taskPool
         FROM run_tasks rt
         JOIN run_pipelines rp ON rp.run_id = rt.run_id AND rp.pipeline_id = rt.pipeline_id
         JOIN task_versions tv ON tv.id = rt.task_version_id
         WHERE rt.run_id = ? AND (rt.task_id = ? OR rt.id = ?)
         ORDER BY rp.ordinal ASC`,
      )
      .all(runId, taskOrRunTaskId, taskOrRunTaskId);
    if (!rows.length) return missing();
    return rows.map((r) => this.hydrateRunTask(r));
  }

  // --- Worker execution & durable checkpointing helpers ---

  loadExecutionPlan(runId: string): ExecutionPlan {
    const runRow = this.db
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(runId);
    if (!runRow) return missing();
    const snapshot = frozenSnapshotSchema.parse(
      JSON.parse(String(runRow.snapshot)),
    );

    const pipelines: ExecutionPlanPipeline[] = this.db
      .prepare(
        'SELECT * FROM run_pipelines WHERE run_id = ? ORDER BY ordinal ASC',
      )
      .all(runId)
      .map((pRow) => ({
        pipelineId: String(pRow.pipeline_id),
        pipelineRevision: Number(pRow.pipeline_revision),
        ordinal: Number(pRow.ordinal),
        pipelineName: String(pRow.pipeline_name),
        isBaseline: Number(pRow.is_baseline) === 1,
        config: pipelineConfig.parse(JSON.parse(String(pRow.config))),
        configHash: String(pRow.config_hash),
        resolvedModels: JSON.parse(String(pRow.resolved_models)),
        indexGenerationId:
          typeof pRow.index_generation_id === 'string'
            ? pRow.index_generation_id
            : null,
        indexReused: Number(pRow.index_reused) === 1,
        indexTimeMs:
          pRow.index_time_ms === null ? null : Number(pRow.index_time_ms),
        state: pRow.state as RunPipelineState,
      }));

    const qrelStmt = this.db.prepare(
      `SELECT d.document_id AS documentId, q.grade
       FROM qrels q JOIN document_versions d ON d.id = q.document_version
       WHERE q.task_version = ? ORDER BY d.document_id ASC`,
    );

    const tasks: ExecutionPlanTask[] = this.db
      .prepare(
        `SELECT rt.*, tv.fields AS taskFields, tv.pool AS taskPool
         FROM run_tasks rt
         JOIN run_pipelines rp ON rp.run_id = rt.run_id AND rp.pipeline_id = rt.pipeline_id
         JOIN task_versions tv ON tv.id = rt.task_version_id
         WHERE rt.run_id = ?
         ORDER BY rp.ordinal ASC, rt.ordinal ASC`,
      )
      .all(runId)
      .map((row) => {
        const fields = taskInput.parse({
          ...JSON.parse(String(row.taskFields)),
          pool: row.taskPool,
          qrels: [],
        });
        return {
          runTaskId: String(row.id),
          pipelineId: String(row.pipeline_id),
          taskId: String(row.task_id),
          taskVersionId: String(row.task_version_id),
          ordinal: Number(row.ordinal),
          question: fields.question,
          expectedAnswer: fields.expectedAnswer,
          acceptanceRule: fields.acceptanceRule,
          referenceFacts: fields.referenceFacts,
          answerable: fields.answerable,
          pool: fields.pool,
          qrels: qrelStmt.all(row.task_version_id).map((q) => ({
            documentId: String(q.documentId),
            grade: Number(q.grade),
          })),
          retrievalKey:
            typeof row.retrieval_key === 'string' ? row.retrieval_key : null,
          answerKey: typeof row.answer_key === 'string' ? row.answer_key : null,
          retrievalState:
            row.retrieval_state as ExecutionPlanTask['retrievalState'],
          answerState: row.answer_state as ExecutionPlanTask['answerState'],
          judgeState: row.judge_state as ExecutionPlanTask['judgeState'],
          state: row.state as ExecutionPlanTask['state'],
          retrievalLatencyMs:
            row.retrieval_latency_ms === null
              ? null
              : Number(row.retrieval_latency_ms),
          rerankLatencyMs:
            row.rerank_latency_ms === null
              ? null
              : Number(row.rerank_latency_ms),
          generationLatencyMs:
            row.generation_latency_ms === null
              ? null
              : Number(row.generation_latency_ms),
          judgeLatencyMs:
            row.judge_latency_ms === null ? null : Number(row.judge_latency_ms),
        };
      });

    return {
      runId,
      mode: runRow.mode as RunMode,
      state: String(runRow.state),
      queuedAt: String(runRow.queued_at),
      startedAt:
        typeof runRow.started_at === 'string' ? runRow.started_at : null,
      snapshot,
      pipelines,
      tasks,
    };
  }

  markRunStarted(runId: string, guard?: () => void) {
    transaction(this.db, () => {
      guard?.();
      const row = this.db
        .prepare('SELECT queued_at, started_at FROM runs WHERE id = ?')
        .get(runId);
      if (!row) return;
      const nowMs = this.now();
      const startedAt =
        typeof row.started_at === 'string'
          ? row.started_at
          : new Date(nowMs).toISOString();
      const queuedMs = Date.parse(String(row.queued_at));
      const queueWaitMs = Number.isFinite(queuedMs)
        ? Math.max(0, Math.round(Date.parse(startedAt) - queuedMs))
        : 0;
      this.db
        .prepare(
          `UPDATE runs
           SET state = 'running', stage = 'indexing',
               started_at = coalesce(started_at, ?),
               queue_wait_ms = coalesce(queue_wait_ms, ?)
           WHERE id = ? AND state IN ('queued', 'running')`,
        )
        .run(startedAt, queueWaitMs, runId);
    });
  }

  updateRunStage(runId: string, stage: string, guard?: () => void) {
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare("UPDATE runs SET stage = ? WHERE id = ? AND state = 'running'")
        .run(stage, runId);
    });
  }

  pinPipelineIndex(
    runId: string,
    pipelineId: string,
    info: {
      generationId: string;
      reused: boolean;
      indexTimeMs: number;
    },
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare(
          `UPDATE run_pipelines
           SET index_generation_id = ?, index_reused = ?, index_time_ms = ?,
               state = 'running', error_message = NULL
           WHERE run_id = ? AND pipeline_id = ?`,
        )
        .run(
          info.generationId,
          Number(info.reused),
          Math.max(0, Math.round(info.indexTimeMs)),
          runId,
          pipelineId,
        );
    });
  }

  markPipelineState(
    runId: string,
    pipelineId: string,
    state: RunPipelineState,
    errorMessage: string | null,
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare(
          'UPDATE run_pipelines SET state = ?, error_message = ? WHERE run_id = ? AND pipeline_id = ?',
        )
        .run(state, errorMessage, runId, pipelineId);
    });
  }

  findReusableRetrieval(
    runId: string,
    retrievalKey: string,
    excludeRunTaskId: string,
  ): {
    sourceRunTaskId: string;
    items: RetrievedTraceItem[];
    retrievedDepth: number;
    rerankStatus: 'skipped' | 'applied' | 'fallback';
    rerankError: string | null;
    retrievalLatencyMs: number;
    rerankLatencyMs: number | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, retrieved_depth, rerank_status, rerank_error,
                retrieval_latency_ms, rerank_latency_ms
         FROM run_tasks
         WHERE run_id = ? AND retrieval_key = ? AND retrieval_state = 'succeeded' AND id != ?
         ORDER BY rowid ASC LIMIT 1`,
      )
      .get(runId, retrievalKey, excludeRunTaskId);
    if (!row) return null;
    const sourceRunTaskId = String(row.id);
    const items = this.db
      .prepare(
        `SELECT chunk_id AS chunkId, document_id AS documentId,
                document_version_id AS documentVersionId, document_name AS documentName,
                mime_type AS mimeType, ordinal, start, end, page, content,
                keyword_rank AS keywordRank, keyword_score AS keywordScore,
                dense_rank AS denseRank, dense_score AS denseScore,
                fused_rank AS fusedRank, fused_score AS fusedScore,
                rerank_rank AS rerankRank, rerank_score AS rerankScore,
                final_rank AS finalRank, final_score AS finalScore
         FROM retrieved_items WHERE run_task_id = ? ORDER BY final_rank ASC`,
      )
      .all(sourceRunTaskId)
      .map((item) => retrievedTraceItem.parse(item));
    return {
      sourceRunTaskId,
      items,
      retrievedDepth: Number(row.retrieved_depth ?? items.length),
      rerankStatus:
        (row.rerank_status as 'skipped' | 'applied' | 'fallback') ?? 'skipped',
      rerankError:
        typeof row.rerank_error === 'string' ? row.rerank_error : null,
      retrievalLatencyMs: Number(row.retrieval_latency_ms ?? 0),
      rerankLatencyMs:
        row.rerank_latency_ms === null ? null : Number(row.rerank_latency_ms),
    };
  }

  loadTaskRetrievedItems(runTaskId: string): RetrievedTraceItem[] {
    return this.db
      .prepare(
        `SELECT chunk_id AS chunkId, document_id AS documentId,
                document_version_id AS documentVersionId, document_name AS documentName,
                mime_type AS mimeType, ordinal, start, end, page, content,
                keyword_rank AS keywordRank, keyword_score AS keywordScore,
                dense_rank AS denseRank, dense_score AS denseScore,
                fused_rank AS fusedRank, fused_score AS fusedScore,
                rerank_rank AS rerankRank, rerank_score AS rerankScore,
                final_rank AS finalRank, final_score AS finalScore
         FROM retrieved_items WHERE run_task_id = ? ORDER BY final_rank ASC`,
      )
      .all(runTaskId)
      .map((item) => retrievedTraceItem.parse(item));
  }

  findReusableAnswer(
    runId: string,
    answerKey: string,
    excludeRunTaskId: string,
  ): {
    sourceRunTaskId: string;
    answerText: string;
    abstained: boolean;
    citations: string[];
    invalidCitations: string[];
    context: RecordedContextItem[];
    promptVersion: string;
    provider: ProviderKind;
    model: string;
    effectiveParams: Record<string, unknown>;
    requestId: string | null;
    latencyMs: number;
  } | null {
    const row = this.db
      .prepare(
        `SELECT a.* FROM answers a
         JOIN run_tasks rt ON rt.id = a.run_task_id
         WHERE rt.run_id = ? AND rt.answer_key = ? AND rt.answer_state = 'succeeded' AND rt.id != ?
         ORDER BY rt.rowid ASC LIMIT 1`,
      )
      .get(runId, answerKey, excludeRunTaskId);
    if (!row) return null;
    return {
      sourceRunTaskId: String(row.run_task_id),
      answerText: String(row.answer_text),
      abstained: Number(row.abstained) === 1,
      citations: JSON.parse(String(row.citations)),
      invalidCitations: JSON.parse(String(row.invalid_citations)),
      context: z
        .array(recordedContextItem)
        .parse(JSON.parse(String(row.context))),
      promptVersion: String(row.prompt_version),
      provider: row.provider as ProviderKind,
      model: String(row.model),
      effectiveParams: JSON.parse(String(row.effective_params)),
      requestId: typeof row.request_id === 'string' ? row.request_id : null,
      latencyMs: Number(row.latency_ms),
    };
  }

  loadTaskAnswer(runTaskId: string) {
    const row = this.db
      .prepare('SELECT * FROM answers WHERE run_task_id = ?')
      .get(runTaskId);
    if (!row) return null;
    return {
      answerText: String(row.answer_text),
      abstained: Number(row.abstained) === 1,
      citations: JSON.parse(String(row.citations)) as string[],
      invalidCitations: JSON.parse(String(row.invalid_citations)) as string[],
      context: z
        .array(recordedContextItem)
        .parse(JSON.parse(String(row.context))),
      latencyMs: Number(row.latency_ms),
    };
  }

  existingObservationMetrics(
    runTaskId: string,
    retryFailed = false,
  ): Set<string> {
    const rows = this.db
      .prepare(
        'SELECT metric_id, cutoff, status FROM metric_observations WHERE run_task_id = ?',
      )
      .all(runTaskId);
    const failedStatuses = new Set([
      'judge_malformed',
      'judge_refused',
      'judge_timeout',
      'judge_failed',
      'unresolved_evidence',
    ]);
    return new Set(
      rows
        .filter((r) => !retryFailed || !failedStatuses.has(String(r.status)))
        .map((r) => `${r.metric_id}:${r.cutoff}`),
    );
  }

  maxJudgeAttemptNumber(runTaskId: string, metricId: string): number {
    const row = this.db
      .prepare(
        'SELECT coalesce(max(attempt_number), 0) AS n FROM judge_attempts WHERE run_task_id = ? AND metric_id = ?',
      )
      .get(runTaskId, metricId);
    return Number(row?.n ?? 0);
  }

  recordProviderCall(
    input: {
      stageKey: string;
      runId: string;
      pipelineId?: string | null;
      runTaskId?: string | null;
      indexGenerationId?: string | null;
      operation: ProviderOperation;
      provider: ProviderKind;
      model: string;
      requestId?: string | null;
      attemptNumber: number;
      isRetry: boolean;
      status: 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'ambiguous';
      errorCode?: string | null;
      latencyMs: number;
      usage?: ProviderUsage;
      priceSchedule: PriceSchedule;
    },
    guard?: () => void,
  ) {
    const priced = priceProviderCall(input.priceSchedule, {
      provider: input.provider,
      model: input.model,
      usage: input.usage,
      succeeded: input.status === 'succeeded',
    });
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO provider_calls(
            id, stage_key, run_id, pipeline_id, run_task_id, index_generation_id,
            operation, provider, model, request_id, attempt_number, is_retry,
            status, error_code, latency_ms,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
            usage_status, price_version, cost_status, cost_usd, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          input.stageKey,
          input.runId,
          input.pipelineId ?? null,
          input.runTaskId ?? null,
          input.indexGenerationId ?? null,
          input.operation,
          input.provider,
          input.model,
          input.requestId ?? null,
          input.attemptNumber,
          Number(input.isRetry),
          input.status,
          input.errorCode ?? null,
          Math.max(0, Math.round(input.latencyMs)),
          input.usage ? input.usage.inputTokens : null,
          input.usage ? input.usage.outputTokens : null,
          input.usage?.cacheReadTokens ?? null,
          input.usage?.cacheCreationTokens ?? null,
          input.usage ? input.usage.totalTokens : null,
          priced.usageStatus,
          priced.priceVersion,
          priced.costStatus,
          priced.costUsd,
          new Date(this.now()).toISOString(),
        );
    });
  }

  getRunSpendTotals(runId: string) {
    const row = this.db
      .prepare(
        `SELECT coalesce(sum(total_tokens), 0) AS tokens,
                coalesce(sum(cost_usd), 0) AS costUsd
         FROM provider_calls WHERE run_id = ?`,
      )
      .get(runId);
    return {
      totalTokens: Number(row?.tokens ?? 0),
      knownCostUsd: Number(row?.costUsd ?? 0),
    };
  }

  private upsertObservations(
    runId: string,
    pipelineId: string,
    taskVersionId: string,
    runTaskId: string,
    observations: ComputedObservation[],
    judgeAttemptId: string | null = null,
  ) {
    const stmt = this.db.prepare(
      `INSERT INTO metric_observations(
        id, run_id, pipeline_id, task_version_id, run_task_id,
        metric_id, metric_version, cutoff, evaluation_unit,
        status, value, reason, metadata, judge_attempt_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, pipeline_id, task_version_id, metric_id, metric_version, cutoff, evaluation_unit)
      DO UPDATE SET
        status = excluded.status,
        value = excluded.value,
        reason = excluded.reason,
        metadata = excluded.metadata,
        judge_attempt_id = excluded.judge_attempt_id`,
    );
    for (const obs of observations) {
      stmt.run(
        randomUUID(),
        runId,
        pipelineId,
        taskVersionId,
        runTaskId,
        obs.metricId,
        obs.metricVersion,
        obs.cutoff,
        obs.evaluationUnit,
        obs.status,
        obs.status === 'scored' ? obs.value : null,
        obs.reason,
        JSON.stringify(obs.metadata),
        judgeAttemptId,
      );
    }
  }

  saveTaskRetrieval(
    input: {
      runId: string;
      pipelineId: string;
      taskVersionId: string;
      runTaskId: string;
      retrievalKey: string;
      succeeded: boolean;
      items: RetrievedTraceItem[];
      retrievedDepth: number;
      rerankStatus: 'skipped' | 'applied' | 'fallback' | null;
      rerankError: string | null;
      retrievalLatencyMs: number;
      rerankLatencyMs: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      observations: ComputedObservation[];
    },
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare('DELETE FROM retrieved_items WHERE run_task_id = ?')
        .run(input.runTaskId);
      const insertItem = this.db.prepare(
        `INSERT INTO retrieved_items(
          run_task_id, chunk_id, document_id, document_version_id,
          document_name, mime_type, ordinal, start, end, page, content,
          keyword_rank, keyword_score, dense_rank, dense_score,
          fused_rank, fused_score, rerank_rank, rerank_score,
          final_rank, final_score
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const item of input.items) {
        insertItem.run(
          input.runTaskId,
          item.chunkId,
          item.documentId,
          item.documentVersionId,
          item.documentName,
          item.mimeType,
          item.ordinal,
          item.start,
          item.end,
          item.page,
          item.content,
          item.keywordRank,
          item.keywordScore,
          item.denseRank,
          item.denseScore,
          item.fusedRank,
          item.fusedScore,
          item.rerankRank,
          item.rerankScore,
          item.finalRank,
          item.finalScore,
        );
      }
      this.db
        .prepare(
          `UPDATE run_tasks
           SET retrieval_key = ?, retrieval_state = ?, state = CASE WHEN state = 'pending' THEN 'running' ELSE state END,
               retrieval_latency_ms = ?, rerank_latency_ms = ?,
               retrieved_depth = ?, retrieved_count = ?,
               rerank_status = ?, rerank_error = ?,
               error_code = coalesce(?, error_code),
               error_message = coalesce(?, error_message),
               started_at = coalesce(started_at, ?)
           WHERE id = ?`,
        )
        .run(
          input.retrievalKey,
          input.succeeded ? 'succeeded' : 'failed',
          Math.max(0, Math.round(input.retrievalLatencyMs)),
          input.rerankLatencyMs === null
            ? null
            : Math.max(0, Math.round(input.rerankLatencyMs)),
          input.retrievedDepth,
          input.items.length,
          input.rerankStatus,
          input.rerankError,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          new Date(this.now()).toISOString(),
          input.runTaskId,
        );
      this.upsertObservations(
        input.runId,
        input.pipelineId,
        input.taskVersionId,
        input.runTaskId,
        input.observations,
      );
    });
  }

  saveTaskAnswer(
    input: {
      runId: string;
      pipelineId: string;
      taskVersionId: string;
      runTaskId: string;
      answerKey: string | null;
      succeeded: boolean;
      answer?: {
        answerText: string;
        abstained: boolean;
        citations: string[];
        invalidCitations: string[];
        context: RecordedContextItem[];
        promptVersion: string;
        provider: ProviderKind;
        model: string;
        effectiveParams: Record<string, unknown>;
        requestId: string | null;
        latencyMs: number;
        reusedFromRunTaskId?: string | null;
      };
      generationLatencyMs: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      abstentionObservation: ComputedObservation;
    },
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      if (input.succeeded && input.answer) {
        this.db
          .prepare(
            `INSERT INTO answers(
              run_task_id, answer_text, abstained, citations, invalid_citations,
              context, prompt_version, provider, model, effective_params,
              request_id, latency_ms, reused_from_run_task_id
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(run_task_id) DO UPDATE SET
              answer_text = excluded.answer_text,
              abstained = excluded.abstained,
              citations = excluded.citations,
              invalid_citations = excluded.invalid_citations,
              context = excluded.context,
              prompt_version = excluded.prompt_version,
              provider = excluded.provider,
              model = excluded.model,
              effective_params = excluded.effective_params,
              request_id = excluded.request_id,
              latency_ms = excluded.latency_ms,
              reused_from_run_task_id = excluded.reused_from_run_task_id`,
          )
          .run(
            input.runTaskId,
            input.answer.answerText,
            Number(input.answer.abstained),
            JSON.stringify(input.answer.citations),
            JSON.stringify(input.answer.invalidCitations),
            JSON.stringify(input.answer.context),
            input.answer.promptVersion,
            input.answer.provider,
            input.answer.model,
            JSON.stringify(input.answer.effectiveParams),
            input.answer.requestId,
            Math.max(0, Math.round(input.answer.latencyMs)),
            input.answer.reusedFromRunTaskId ?? null,
          );
      }
      this.db
        .prepare(
          `UPDATE run_tasks
           SET answer_key = ?, answer_state = ?,
               generation_latency_ms = ?,
               error_code = coalesce(?, error_code),
               error_message = coalesce(?, error_message)
           WHERE id = ?`,
        )
        .run(
          input.answerKey,
          input.succeeded ? 'succeeded' : 'failed',
          input.generationLatencyMs === null
            ? null
            : Math.max(0, Math.round(input.generationLatencyMs)),
          input.errorCode ?? null,
          input.errorMessage ?? null,
          input.runTaskId,
        );
      this.upsertObservations(
        input.runId,
        input.pipelineId,
        input.taskVersionId,
        input.runTaskId,
        [input.abstentionObservation],
      );
    });
  }

  saveTaskJudgeMetric(
    input: {
      runId: string;
      pipelineId: string;
      taskVersionId: string;
      runTaskId: string;
      attempts: Array<{
        metricId: MetricId;
        rubricVersion: string;
        attemptNumber: number;
        isRepair: boolean;
        provider: ProviderKind;
        model: string;
        effectiveParams: Record<string, unknown>;
        status: JudgeAttemptRecord['status'];
        reason: string | null;
        rawResponseHash: string | null;
        parsedOutput: unknown | null;
        score: number | null;
        requestId: string | null;
        latencyMs: number;
      }>;
      observation: ComputedObservation;
    },
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      let finalAttemptId: string | null = null;
      const insertAttempt = this.db.prepare(
        `INSERT INTO judge_attempts(
          id, run_task_id, metric_id, rubric_version, attempt_number, is_repair,
          provider, model, effective_params, status, reason, raw_response_hash,
          parsed_output, score, request_id, latency_ms, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_task_id, metric_id, rubric_version, attempt_number) DO UPDATE SET
          status = excluded.status,
          reason = excluded.reason,
          raw_response_hash = excluded.raw_response_hash,
          parsed_output = excluded.parsed_output,
          score = excluded.score,
          request_id = excluded.request_id,
          latency_ms = excluded.latency_ms`,
      );
      for (const a of input.attempts) {
        const id = randomUUID();
        insertAttempt.run(
          id,
          input.runTaskId,
          a.metricId,
          a.rubricVersion,
          a.attemptNumber,
          Number(a.isRepair),
          a.provider,
          a.model,
          JSON.stringify(a.effectiveParams),
          a.status,
          a.reason,
          a.rawResponseHash,
          a.parsedOutput === null ? null : JSON.stringify(a.parsedOutput),
          a.score,
          a.requestId,
          Math.max(0, Math.round(a.latencyMs)),
          new Date(this.now()).toISOString(),
        );
        const stored = this.db
          .prepare(
            'SELECT id FROM judge_attempts WHERE run_task_id = ? AND metric_id = ? AND rubric_version = ? AND attempt_number = ?',
          )
          .get(input.runTaskId, a.metricId, a.rubricVersion, a.attemptNumber);
        finalAttemptId = typeof stored?.id === 'string' ? stored.id : id;
      }

      this.upsertObservations(
        input.runId,
        input.pipelineId,
        input.taskVersionId,
        input.runTaskId,
        [input.observation],
        finalAttemptId,
      );
    });
  }

  finalizeRunTask(
    input: {
      runId: string;
      runTaskId: string;
      state: 'succeeded' | 'partial' | 'failed' | 'cancelled';
      judgeState: 'pending' | 'succeeded' | 'partial' | 'failed' | 'skipped';
      servingLatencyMs: number | null;
      judgeLatencyMs: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare(
          `UPDATE run_tasks
           SET state = ?, judge_state = ?,
               serving_latency_ms = ?, judge_latency_ms = ?,
               error_code = coalesce(?, error_code),
               error_message = coalesce(?, error_message),
               completed_at = ?
           WHERE id = ?`,
        )
        .run(
          input.state,
          input.judgeState,
          input.servingLatencyMs === null
            ? null
            : Math.max(0, Math.round(input.servingLatencyMs)),
          input.judgeLatencyMs === null
            ? null
            : Math.max(0, Math.round(input.judgeLatencyMs)),
          input.errorCode ?? null,
          input.errorMessage ?? null,
          new Date(this.now()).toISOString(),
          input.runTaskId,
        );
      this.syncRunCounters(input.runId);
    });
  }

  private syncRunCounters(runId: string) {
    const counts = this.db
      .prepare(
        `SELECT
           sum(CASE WHEN state IN ('succeeded', 'partial') THEN 1 ELSE 0 END) AS completed,
           sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM run_tasks WHERE run_id = ?`,
      )
      .get(runId);
    this.db
      .prepare(
        'UPDATE runs SET completed_units = ?, failed_units = ? WHERE id = ?',
      )
      .run(Number(counts?.completed ?? 0), Number(counts?.failed ?? 0), runId);
  }

  finalizeRun(
    runId: string,
    state: 'succeeded' | 'failed' | 'cancelled',
    errorMessage: string | null = null,
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      this.syncRunCounters(runId);
      const row = this.db
        .prepare('SELECT queued_at, started_at FROM runs WHERE id = ?')
        .get(runId);
      const nowMs = this.now();
      const completedAt = new Date(nowMs).toISOString();
      const originMs = Date.parse(
        String(row?.started_at ?? row?.queued_at ?? completedAt),
      );
      const wallClockMs = Number.isFinite(originMs)
        ? Math.max(0, Math.round(nowMs - originMs))
        : 0;
      const stage =
        state === 'succeeded'
          ? 'complete'
          : state === 'cancelled'
            ? 'cancelled'
            : 'failed';
      this.db
        .prepare(
          `UPDATE runs
           SET state = ?, stage = ?, completed_at = ?, wall_clock_ms = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(state, stage, completedAt, wallClockMs, errorMessage, runId);
    });
  }

  markRunFailed(runId: string, message: string) {
    this.finalizeRun(runId, 'failed', message);
  }
}
