import { z } from 'zod';

export const id = z.uuid();
export const revision = z.int().positive();
const name = z.string().trim().min(1).max(200);
const prose = z.string().max(16000);
const nonemptyPatch = (patch: object) => Object.keys(patch).length > 0;
export const empty = z.strictObject({});
export const named = z.strictObject({ name });
export const summary = named.extend({ id, revision, archived: z.boolean() });
export type Summary = z.infer<typeof summary>;
export function page<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
export const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: id.optional(),
});
export const revisionQuery = listQuery.extend({
  cursor: z.coerce.number().int().positive().optional(),
});
export const revisionSummary = z.strictObject({
  revision,
  name,
  createdAt: z.iso.datetime(),
});

export const errorCode = z.enum([
  'invalid_input',
  'unsupported_media',
  'size_limit',
  'missing_capability',
  'stale_revision',
  'precondition_required',
  'archived',
  'not_found',
  'conflict',
  'throttled',
  'origin_denied',
  'upstream_failure',
  'not_ready',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof errorCode>;
export const errorEnvelope = z.strictObject({
  error: z.strictObject({
    code: errorCode,
    message: z.string(),
    requestId: z.string(),
    fields: z
      .array(z.strictObject({ path: z.string(), message: z.string() }))
      .optional(),
  }),
});

export const qrel = z.strictObject({
  documentId: id,
  grade: z.int().min(0).max(3),
});
export const labels = z.strictObject({
  pool: z.enum(['complete', 'partial']).default('partial'),
  qrels: z
    .array(qrel)
    .max(1000)
    .refine(
      (rows) => new Set(rows.map((row) => row.documentId)).size === rows.length,
      'Each document can have only one grade.',
    )
    .default([]),
});
export const taskFields = z.strictObject({
  question: prose.trim().min(1),
  expectedAnswer: prose.default(''),
  acceptanceRule: prose.default(''),
  referenceFacts: z.array(prose.trim().min(1)).max(100).default([]),
  answerable: z.boolean().default(true),
  provenance: name.default('manual'),
});
export const taskInput = taskFields.extend(labels.shape);
export const taskPatch = z
  .strictObject({
    question: taskFields.shape.question.optional(),
    expectedAnswer: prose.optional(),
    acceptanceRule: prose.optional(),
    referenceFacts: taskFields.shape.referenceFacts.unwrap().optional(),
    answerable: z.boolean().optional(),
    provenance: name.optional(),
  })
  .refine(nonemptyPatch, 'Provide at least one change.');
export const task = taskInput.extend({ id, versionId: id });
export type TaskInput = z.infer<typeof taskInput>;
export type Task = z.infer<typeof task>;

export const parser = z.enum(['local', 'llama-parse']);
export type Parser = z.infer<typeof parser>;
export const jobKind = z.enum(['parse', 'index', 'run', 'generate']);
export type JobKind = z.infer<typeof jobKind>;
export const jobState = z.enum([
  'queued',
  'running',
  'cancellation_requested',
  'cancelled',
  'succeeded',
  'failed',
]);
export type JobState = z.infer<typeof jobState>;
export const job = z.strictObject({
  id,
  kind: jobKind.default('parse'),
  versionId: id.nullable(),
  parser: parser.nullable(),
  generationId: id.nullable().default(null),
  runId: id.nullable().default(null),
  batchId: id.nullable().default(null),
  state: jobState,
  stage: z.string(),
  attempt: z.int().nonnegative(),
  message: z.string().nullable(),
  parentId: id.nullable(),
  artifactId: z.string().nullable(),
  workerOnline: z.boolean(),
});
export type Job = z.infer<typeof job>;
export const jobEvent = job
  .pick({ state: true, stage: true, message: true })
  .extend({ seq: z.int().positive(), time: z.int() });
export const pageSpan = z.strictObject({
  page: z.int().positive(),
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
});
export const parseRequest = z.strictObject({ parser });
export const uploadQuery = parseRequest.extend({
  name: name.refine(
    (n) => !/[/\\]/.test(n) && !Array.from(n).some((c) => c.charCodeAt(0) < 32),
  ),
  parser: parser.default('local'),
});
export const document = z.strictObject({
  id,
  versionId: id,
  name,
  mimeType: z.string(),
  size: z.int().nonnegative(),
  hash: z.string().length(64),
  content: z.string().optional(),
  jobId: id.optional(),
  pages: z.array(pageSpan).optional(),
});
export type SavedDocument = z.infer<typeof document>;
export const dataset = summary.extend({
  documents: z.array(document),
  tasks: z.array(task),
});
export type Dataset = z.infer<typeof dataset>;
export const uploadResult = z.strictObject({
  dataset,
  documentId: id,
  jobId: id,
});
export const csvRequest = z.strictObject({
  mode: z.enum(['preview', 'commit']),
  csv: z.string().min(1),
});
export const csvPreview = z.strictObject({
  tasks: z
    .array(
      taskFields.pick({
        question: true,
        expectedAnswer: true,
        acceptanceRule: true,
      }),
    )
    .min(1)
    .max(1000),
  warnings: z.array(z.string()),
});
export const role = z.enum(['embedding', 'chat', 'judge', 'rerank']);
export type Role = z.infer<typeof role>;
export const providerKind = z.enum([
  'openai',
  'openai-compatible',
  'anthropic',
  'http',
]);
export type ProviderKind = z.infer<typeof providerKind>;
export const providerCapabilities = z.strictObject({
  chat: z.boolean(),
  embeddings: z.boolean(),
  rerank: z.boolean(),
  structuredOutput: z.boolean(),
  temperature: z.boolean(),
  maxTemperature: z.number().min(0).max(2).nullable(),
  maxTokens: z.boolean(),
  requiresMaxTokens: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilities>;
export const profile = z.strictObject({
  role,
  name,
  model: name,
  options: z.array(z.enum(['temperature', 'maxTokens', 'structuredOutput'])),
  provider: providerKind,
  capabilities: providerCapabilities,
});
export type Profile = z.infer<typeof profile>;
export const capabilities = z.strictObject({
  profiles: z.array(profile),
  cloudParser: z.boolean(),
  denseStore: z.boolean(),
  workerOnline: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilities>;
const profileRef = z.strictObject({
  model: name.or(z.literal('')).default(''),
});
export const legacyStrategies = {
  recursive: 'character-window',
  semantic: 'sentence-packed',
  layout: 'heading-aware',
  table: 'table-aware',
} as const;
export const strategy = z.enum([
  'character-window',
  'sentence-packed',
  'heading-aware',
  'table-aware',
]);
export const chunkOptions = z.strictObject({
  strategy: z.union([
    strategy,
    z
      .enum(['recursive', 'semantic', 'layout', 'table'])
      .transform((s) => legacyStrategies[s]),
  ]),
  chunkSize: z.int().min(100).max(1000),
  overlap: z.int().min(0).max(50),
});
export const chunkRow = z.strictObject({
  id,
  ordinal: z.int(),
  start: z.int(),
  end: z.int(),
  page: z.int(),
  content: z.string(),
});
export const retrievalMode = z.enum(['keyword', 'dense', 'hybrid']);
export type RetrievalMode = z.infer<typeof retrievalMode>;
export const rerankFailurePolicy = z.enum(['fail', 'fallback']);
export type RerankFailurePolicy = z.infer<typeof rerankFailurePolicy>;
export const fusionWeights = z.strictObject({
  keyword: z.number().positive().max(100),
  dense: z.number().positive().max(100),
});
export type FusionWeights = z.infer<typeof fusionWeights>;
export const pipelineConfig = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  parsing: z
    .strictObject({ strategy: z.literal('llama-parse') })
    .default({ strategy: 'llama-parse' }),
  chunking: chunkOptions.default({
    strategy: 'character-window',
    chunkSize: 300,
    overlap: 20,
  }),
  embedding: profileRef.default({ model: '' }),
  retriever: z
    .strictObject({
      mode: retrievalMode.default('keyword'),
      topK: z.int().min(1).max(20),
      candidateDepth: z.int().min(1).max(100).optional(),
      fusionWeights: fusionWeights.default({ keyword: 1, dense: 1 }),
      deduplicate: z.boolean().default(false),
    })
    .default({
      mode: 'keyword',
      topK: 5,
      fusionWeights: { keyword: 1, dense: 1 },
      deduplicate: false,
    }),
  reranker: z
    .strictObject({
      enabled: z.boolean().default(false),
      model: name.or(z.literal('')).default(''),
      failurePolicy: rerankFailurePolicy.default('fail'),
    })
    .default({ enabled: false, model: '', failurePolicy: 'fail' }),
  llm: profileRef
    .extend({
      temperature: z.number().min(0).max(2),
      maxTokens: z.int().min(1).max(32768),
    })
    .default({ model: '', temperature: 0.2, maxTokens: 500 }),
  judge: profileRef.default({ model: '' }),
});
export const pipelineInput = named.extend({
  description: z.string().max(2000).default(''),
  config: pipelineConfig.prefault({}),
});
export const pipelinePatch = z
  .strictObject({
    name: name.optional(),
    description: pipelineInput.shape.description.unwrap().optional(),
    config: pipelineConfig.optional(),
  })
  .refine(nonemptyPatch, 'Provide at least one change.');
export const pipeline = summary.extend({
  ...pipelineInput.shape,
  hash: z.string().length(64),
});
export type PipelineInput = z.infer<typeof pipelineInput>;
export type PipelineInputRaw = z.input<typeof pipelineInput>;
export type PipelinePatchRaw = z.input<typeof pipelinePatch>;
export type SavedPipeline = z.infer<typeof pipeline>;
export type PipelineConfig = z.infer<typeof pipelineConfig>;

export const metadataFilters = z
  .strictObject({
    documentIds: z.array(id).max(100).optional(),
    documentNames: z.array(name).max(100).optional(),
    mimeTypes: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    pageMin: z.int().positive().optional(),
    pageMax: z.int().positive().optional(),
  })
  .refine(
    (f) =>
      f.pageMin === undefined ||
      f.pageMax === undefined ||
      f.pageMin <= f.pageMax,
    'pageMin must be less than or equal to pageMax.',
  );
export type MetadataFilters = z.infer<typeof metadataFilters>;

export const indexState = z.enum(['building', 'ready', 'failed']);
export type IndexState = z.infer<typeof indexState>;
export const createIndexRequest = z.strictObject({
  datasetId: id,
  datasetRevision: revision.optional(),
  mode: retrievalMode.default('keyword'),
  chunking: chunkOptions.default({
    strategy: 'character-window',
    chunkSize: 300,
    overlap: 20,
  }),
  embeddingModel: name.or(z.literal('')).default(''),
  forceRebuild: z.boolean().default(false),
});
export type CreateIndexRequest = z.infer<typeof createIndexRequest>;
export const indexGeneration = z.strictObject({
  id,
  datasetId: id,
  datasetRevision: revision,
  fingerprint: z.string().length(64),
  state: indexState,
  mode: retrievalMode,
  chunking: chunkOptions,
  embeddingProvider: z.enum(['openai', 'openai-compatible']).nullable(),
  embeddingModel: z.string().nullable(),
  embeddingDimensions: z.int().positive().nullable(),
  chunkCount: z.int().nonnegative(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  readyAt: z.iso.datetime().nullable(),
  jobId: id.nullable(),
});
export type IndexGeneration = z.infer<typeof indexGeneration>;
export const createIndexResult = z.strictObject({
  index: indexGeneration,
  jobId: id.nullable(),
  reused: z.boolean(),
});
export type CreateIndexResult = z.infer<typeof createIndexResult>;
export const generationChunk = z.strictObject({
  chunkId: id,
  documentId: id,
  documentVersionId: id,
  documentName: name,
  mimeType: z.string(),
  ordinal: z.int().nonnegative(),
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
  page: z.int().positive(),
  contentHash: z.string().length(64),
  content: z.string(),
});
export type GenerationChunk = z.infer<typeof generationChunk>;

export const indexSearchRequest = z.strictObject({
  query: z.string().trim().min(1).max(4000),
  mode: retrievalMode.optional(),
  topK: z.int().min(1).max(50).default(5),
  candidateDepth: z.int().min(1).max(100).optional(),
  fusionWeights: fusionWeights.default({ keyword: 1, dense: 1 }),
  filters: metadataFilters.optional(),
  reranker: z
    .strictObject({
      enabled: z.boolean().default(false),
      model: name.or(z.literal('')).default(''),
      failurePolicy: rerankFailurePolicy.default('fail'),
    })
    .default({ enabled: false, model: '', failurePolicy: 'fail' }),
});
export type IndexSearchRequest = z.infer<typeof indexSearchRequest>;
export const providerUsage = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  totalTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative().optional(),
  cacheCreationTokens: z.int().nonnegative().optional(),
});
export type ProviderUsage = z.infer<typeof providerUsage>;
export const retrievedTraceItem = z.strictObject({
  chunkId: id,
  documentId: id,
  documentVersionId: id,
  documentName: name,
  mimeType: z.string(),
  ordinal: z.int().nonnegative(),
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
  page: z.int().positive(),
  content: z.string(),
  keywordRank: z.int().positive().nullable(),
  keywordScore: z.number().nullable(),
  denseRank: z.int().positive().nullable(),
  denseScore: z.number().nullable(),
  fusedRank: z.int().positive().nullable(),
  fusedScore: z.number().nullable(),
  rerankRank: z.int().positive().nullable(),
  rerankScore: z.number().nullable(),
  finalRank: z.int().positive(),
  finalScore: z.number(),
});
export type RetrievedTraceItem = z.infer<typeof retrievedTraceItem>;
export const indexSearchResult = z.strictObject({
  generationId: id,
  datasetId: id,
  datasetRevision: revision,
  mode: retrievalMode,
  query: z.string(),
  topK: z.int().positive(),
  candidateDepth: z.int().positive(),
  filters: metadataFilters.nullable(),
  items: z.array(retrievedTraceItem),
  stages: z.strictObject({
    keywordCount: z.int().nonnegative(),
    denseCount: z.int().nonnegative(),
    fusedCount: z.int().nonnegative(),
    reranked: z.boolean(),
    rerankStatus: z.enum(['skipped', 'applied', 'fallback']),
    rerankError: z.string().nullable(),
    timingsMs: z.strictObject({
      keyword: z.number().nonnegative().optional(),
      embed: z.number().nonnegative().optional(),
      dense: z.number().nonnegative().optional(),
      rerank: z.number().nonnegative().optional(),
      total: z.number().nonnegative(),
    }),
  }),
  usage: z
    .strictObject({
      embedding: providerUsage.optional(),
      rerank: providerUsage.optional(),
    })
    .optional(),
});
export type IndexSearchResult = z.infer<typeof indexSearchResult>;

export const recordedContextItem = z.strictObject({
  index: z.int().positive(),
  chunkId: id,
  documentId: id,
  documentName: name,
  page: z.int().positive(),
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
  content: z.string(),
  truncated: z.boolean(),
});
export type RecordedContextItem = z.infer<typeof recordedContextItem>;
export const indexAnswerRequest = indexSearchRequest.extend({
  model: name.or(z.literal('')).default(''),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.int().min(1).max(32768).default(500),
  contextBudgetChars: z.int().min(200).max(64000).default(12000),
});
export type IndexAnswerRequest = z.infer<typeof indexAnswerRequest>;
export const indexAnswerResult = z.strictObject({
  answer: z.string(),
  abstained: z.boolean(),
  citations: z.array(id),
  invalidCitations: z.array(z.string()),
  context: z.array(recordedContextItem),
  retrieval: indexSearchResult,
  model: z.string(),
  provider: providerKind,
  requestId: z.string().nullable(),
  usage: providerUsage.optional(),
  effectiveParams: z.strictObject({
    temperature: z.number().optional(),
    maxTokens: z.int().positive().optional(),
    structuredOutput: z.boolean(),
  }),
  latencyMs: z.number().nonnegative(),
});
export type IndexAnswerResult = z.infer<typeof indexAnswerResult>;

export const health = z.strictObject({ status: z.literal('ok') });
export { z };
export const replaceLabels = z.strictObject({
  pool: labels.shape.pool.unwrap(),
  qrels: labels.shape.qrels.unwrap(),
});

// Phase 6: Pricing, Experiments, Runs, Observations, and Evaluation Contracts
export const priceUnit = z.enum([
  'per_1m_tokens',
  'per_1k_tokens',
  'per_request',
]);
export type PriceUnit = z.infer<typeof priceUnit>;

export const priceScheduleEntry = z
  .strictObject({
    model: name,
    provider: providerKind.optional(),
    unit: priceUnit,
    inputUsd: z.number().nonnegative().finite().optional(),
    outputUsd: z.number().nonnegative().finite().optional(),
    cacheReadUsd: z.number().nonnegative().finite().optional(),
    cacheCreationUsd: z.number().nonnegative().finite().optional(),
    requestUsd: z.number().nonnegative().finite().optional(),
  })
  .refine(
    (entry) =>
      entry.unit === 'per_request'
        ? entry.requestUsd !== undefined
        : entry.inputUsd !== undefined || entry.outputUsd !== undefined,
    'Provide a valid rate for the configured price unit.',
  );
export type PriceScheduleEntry = z.infer<typeof priceScheduleEntry>;

export const priceSchedule = z.strictObject({
  version: name,
  currency: z.literal('USD').default('USD'),
  entries: z.array(priceScheduleEntry).default([]),
});
export type PriceSchedule = z.infer<typeof priceSchedule>;

export const runMode = z.enum(['retrieval_only', 'full_rag']);
export type RunMode = z.infer<typeof runMode>;

export const metricId = z.enum([
  'hit_at_k',
  'precision_at_k',
  'recall_at_k',
  'mrr_at_k',
  'mrr',
  'ndcg_at_k',
  'faithfulness',
  'answer_relevance',
  'context_precision',
  'context_recall',
  'answer_correctness',
  'abstention_answerable',
  'abstention_unanswerable',
]);
export type MetricId = z.infer<typeof metricId>;

export const judgeMetricId = z.enum([
  'faithfulness',
  'answer_relevance',
  'context_precision',
  'context_recall',
  'answer_correctness',
]);
export type JudgeMetricId = z.infer<typeof judgeMetricId>;

export const evaluationUnit = z.enum([
  'document',
  'chunk',
  'answer',
  'passage',
  'reference_fact',
  'task',
]);
export type EvaluationUnit = z.infer<typeof evaluationUnit>;

export const observationStatus = z.enum([
  'scored',
  'no_relevant_docs',
  'unanswerable',
  'missing_qrels',
  'missing_reference_facts',
  'retrieval_failed',
  'generation_failed',
  'judge_malformed',
  'judge_refused',
  'judge_timeout',
  'judge_failed',
  'unresolved_evidence',
  'not_applicable',
  'skipped',
]);
export type ObservationStatus = z.infer<typeof observationStatus>;

export const judgeAttemptStatus = z.enum([
  'succeeded',
  'malformed',
  'refused',
  'timeout',
  'upstream_failure',
  'unresolved_evidence',
  'missing_prerequisite',
]);
export type JudgeAttemptStatus = z.infer<typeof judgeAttemptStatus>;

export const providerOperation = z.enum([
  'corpus_embed',
  'query_embed',
  'rerank',
  'generate',
  'judge',
]);
export type ProviderOperation = z.infer<typeof providerOperation>;

export const cutoffList = z
  .array(z.int().min(1).max(50))
  .min(1)
  .max(10)
  .transform((vals) => Array.from(new Set(vals)).sort((a, b) => a - b));

export const experimentConfig = z.strictObject({
  judgeEnabled: z.boolean().default(true),
  cutoffs: cutoffList.default([1, 3, 5]),
  contextBudgetChars: z.int().min(200).max(64000).default(12000),
  filters: metadataFilters.optional(),
});
export type ExperimentConfig = z.infer<typeof experimentConfig>;

export const experimentInput = z
  .strictObject({
    name,
    description: z.string().max(2000).default(''),
    datasetId: id,
    baselinePipelineId: id,
    pipelineIds: z
      .array(id)
      .min(1)
      .max(20)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Pipeline IDs must be unique.',
      ),
    mode: runMode.default('retrieval_only'),
    config: experimentConfig.prefault({}),
  })
  .refine(
    (exp) => exp.pipelineIds.includes(exp.baselinePipelineId),
    'Baseline pipeline must be included in pipelineIds.',
  );
export type ExperimentInput = z.infer<typeof experimentInput>;
export type ExperimentInputRaw = z.input<typeof experimentInput>;

export const experimentPatch = z
  .strictObject({
    name: name.optional(),
    description: z.string().max(2000).optional(),
    datasetId: id.optional(),
    baselinePipelineId: id.optional(),
    pipelineIds: z
      .array(id)
      .min(1)
      .max(20)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Pipeline IDs must be unique.',
      )
      .optional(),
    mode: runMode.optional(),
    config: experimentConfig.optional(),
  })
  .refine(nonemptyPatch, 'Provide at least one change.');
export type ExperimentPatch = z.infer<typeof experimentPatch>;

export const experiment = summary.extend({
  description: z.string(),
  datasetId: id,
  baselinePipelineId: id,
  pipelineIds: z.array(id).min(1),
  mode: runMode,
  config: experimentConfig,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Experiment = z.infer<typeof experiment>;

export const createRunRequest = z.strictObject({
  name: name.optional(),
  datasetRevision: revision.optional(),
  mode: runMode.optional(),
  judgeEnabled: z.boolean().optional(),
  cutoffs: cutoffList.optional(),
  contextBudgetChars: z.int().min(200).max(64000).optional(),
  filters: metadataFilters.optional(),
});
export type CreateRunRequest = z.infer<typeof createRunRequest>;

export const costStatus = z.enum(['known', 'partial', 'unknown', 'zero']);
export type CostStatus = z.infer<typeof costStatus>;

export const costBucket = z.strictObject({
  status: costStatus,
  totalUsd: z.number().nonnegative().nullable(),
  knownUsd: z.number().nonnegative(),
  pricedCalls: z.int().nonnegative(),
  totalCalls: z.int().nonnegative(),
  unpricedModels: z.array(z.string()),
});
export type CostBucket = z.infer<typeof costBucket>;

export const perQueryCost = z.strictObject({
  status: costStatus,
  usdPerQuery: z.number().nonnegative().nullable(),
  knownUsdPerQuery: z.number().nonnegative().nullable(),
  queryCount: z.int().nonnegative(),
});
export type PerQueryCost = z.infer<typeof perQueryCost>;

export const costBreakdown = z.strictObject({
  priceVersion: z.string(),
  currency: z.literal('USD'),
  indexing: costBucket,
  serving: costBucket,
  perQueryServing: perQueryCost,
  judging: costBucket,
  retry: costBucket,
  total: costBucket,
});
export type CostBreakdown = z.infer<typeof costBreakdown>;

export const tokenBreakdown = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheCreationTokens: z.int().nonnegative(),
  totalTokens: z.int().nonnegative(),
  retryTokens: z.int().nonnegative(),
  callsWithUsage: z.int().nonnegative(),
  totalCalls: z.int().nonnegative(),
});
export type TokenBreakdown = z.infer<typeof tokenBreakdown>;

export const latencyStats = z.strictObject({
  sampleSize: z.int().nonnegative(),
  meanMs: z.number().nonnegative().nullable(),
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
});
export type LatencyStats = z.infer<typeof latencyStats>;

export const pipelineLatencySummary = z.strictObject({
  indexTimeMs: z.number().nonnegative().nullable(),
  retrieval: latencyStats,
  rerank: latencyStats,
  generation: latencyStats,
  serving: latencyStats,
  evaluation: latencyStats,
  timeoutCount: z.int().nonnegative(),
  cancellationCount: z.int().nonnegative(),
});
export type PipelineLatencySummary = z.infer<typeof pipelineLatencySummary>;

export const metricAggregate = z.strictObject({
  metricId,
  metricVersion: z.string(),
  cutoff: z.int().nonnegative(),
  evaluationUnit,
  displayLabel: z.string(),
  mean: z.number().nullable(),
  eligibleCount: z.int().nonnegative(),
  totalCount: z.int().nonnegative(),
  failedCount: z.int().nonnegative(),
  excludedCount: z.int().nonnegative(),
  exclusionBreakdown: z.record(z.string(), z.int().nonnegative()),
  completionRate: z.number().min(0).max(1).nullable(),
  hasPartialPool: z.boolean().default(false),
  meanJudgedCoverage: z.number().min(0).max(1).nullable().default(null),
  passRate: z.number().min(0).max(1).nullable().default(null),
  criticalContradictionCount: z.int().nonnegative().default(0),
});
export type MetricAggregate = z.infer<typeof metricAggregate>;

export const runPipelineState = z.enum([
  'queued',
  'indexing',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);
export type RunPipelineState = z.infer<typeof runPipelineState>;

export const runPipelineSummary = z.strictObject({
  pipelineId: id,
  pipelineRevision: revision,
  ordinal: z.int().nonnegative(),
  pipelineName: z.string(),
  isBaseline: z.boolean(),
  config: pipelineConfig,
  configHash: z.string().length(64),
  resolvedModels: z.strictObject({
    embedding: z
      .strictObject({ provider: providerKind, model: z.string() })
      .nullable(),
    rerank: z
      .strictObject({ provider: providerKind, model: z.string() })
      .nullable(),
    chat: z
      .strictObject({
        provider: providerKind,
        model: z.string(),
        effectiveTemperature: z.number().nullable(),
        effectiveMaxTokens: z.int().positive().nullable(),
        structuredOutput: z.boolean(),
      })
      .nullable(),
    judge: z
      .strictObject({
        provider: providerKind,
        model: z.string(),
        effectiveTemperature: z.number().nullable(),
        structuredOutput: z.boolean(),
      })
      .nullable(),
  }),
  indexGenerationId: id.nullable(),
  indexReused: z.boolean(),
  state: runPipelineState,
  errorMessage: z.string().nullable(),
  completedTasks: z.int().nonnegative(),
  failedTasks: z.int().nonnegative(),
  totalTasks: z.int().nonnegative(),
  retrievalMetrics: z.array(metricAggregate),
  judgeMetrics: z.array(metricAggregate),
  abstentionMetrics: z.array(metricAggregate),
  latency: pipelineLatencySummary,
  cost: costBreakdown,
  tokens: tokenBreakdown,
});
export type RunPipelineSummary = z.infer<typeof runPipelineSummary>;

export const runSnapshotSummary = z.strictObject({
  softwareVersion: z.string(),
  datasetId: id,
  datasetRevision: revision,
  datasetName: z.string(),
  mode: runMode,
  judgeEnabled: z.boolean(),
  cutoffs: z.array(z.int().positive()),
  contextBudgetChars: z.int().positive(),
  filters: metadataFilters.nullable(),
  promptVersion: z.string(),
  retrievalMetricVersion: z.string(),
  rubricVersions: z.record(z.string(), z.string()),
  priceScheduleVersion: z.string(),
  budgets: z.strictObject({
    maxTokens: z.int().positive().nullable(),
    maxCostUsd: z.number().positive().nullable(),
  }),
});
export type RunSnapshotSummary = z.infer<typeof runSnapshotSummary>;

export const runSummary = z.strictObject({
  id,
  experimentId: id,
  name: z.string(),
  mode: runMode,
  state: jobState,
  stage: z.string(),
  datasetId: id,
  datasetRevision: revision,
  datasetName: z.string(),
  baselinePipelineId: id,
  pipelineCount: z.int().nonnegative(),
  taskCount: z.int().nonnegative(),
  completedUnits: z.int().nonnegative(),
  failedUnits: z.int().nonnegative(),
  totalUnits: z.int().nonnegative(),
  jobId: id,
  workerOnline: z.boolean(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  queueWaitMs: z.number().nonnegative().nullable(),
  wallClockMs: z.number().nonnegative().nullable(),
  errorMessage: z.string().nullable(),
});
export type RunSummary = z.infer<typeof runSummary>;

export const runDetail = runSummary.extend({
  baselinePipelineRevision: revision,
  snapshot: runSnapshotSummary,
  pipelines: z.array(runPipelineSummary),
  cost: costBreakdown,
  tokens: tokenBreakdown,
  latency: z.strictObject({
    queueWaitMs: z.number().nonnegative().nullable(),
    wallClockMs: z.number().nonnegative().nullable(),
    serving: latencyStats,
    evaluation: latencyStats,
    timeoutCount: z.int().nonnegative(),
    cancellationCount: z.int().nonnegative(),
  }),
});
export type RunDetail = z.infer<typeof runDetail>;

export const createRunResult = z.strictObject({
  run: runDetail,
  job,
  reused: z.boolean(),
});
export type CreateRunResult = z.infer<typeof createRunResult>;

export const metricObservation = z.strictObject({
  id,
  metricId,
  metricVersion: z.string(),
  cutoff: z.int().nonnegative(),
  evaluationUnit,
  status: observationStatus,
  value: z.number().nullable(),
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  judgeAttemptId: id.nullable(),
});
export type MetricObservation = z.infer<typeof metricObservation>;

export const judgeAttemptRecord = z.strictObject({
  id,
  metricId,
  rubricVersion: z.string(),
  attemptNumber: z.int().positive(),
  isRepair: z.boolean(),
  provider: providerKind,
  model: z.string(),
  effectiveParams: z.record(z.string(), z.unknown()),
  status: judgeAttemptStatus,
  reason: z.string().nullable(),
  rawResponseHash: z.string().nullable(),
  parsedOutput: z.unknown().nullable(),
  score: z.number().nullable(),
  requestId: z.string().nullable(),
  latencyMs: z.number().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type JudgeAttemptRecord = z.infer<typeof judgeAttemptRecord>;

export const recordedAnswer = z.strictObject({
  answerText: z.string(),
  abstained: z.boolean(),
  citations: z.array(id),
  invalidCitations: z.array(z.string()),
  context: z.array(recordedContextItem),
  promptVersion: z.string(),
  provider: providerKind,
  model: z.string(),
  effectiveParams: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  latencyMs: z.number().nonnegative(),
  reusedFromRunTaskId: id.nullable(),
});
export type RecordedAnswer = z.infer<typeof recordedAnswer>;

export const providerCallRecord = z.strictObject({
  id,
  operation: providerOperation,
  provider: providerKind,
  model: z.string(),
  requestId: z.string().nullable(),
  attemptNumber: z.int().positive(),
  isRetry: z.boolean(),
  status: z.enum(['succeeded', 'failed', 'timeout', 'cancelled', 'ambiguous']),
  errorCode: z.string().nullable(),
  latencyMs: z.number().nonnegative(),
  inputTokens: z.int().nonnegative().nullable(),
  outputTokens: z.int().nonnegative().nullable(),
  cacheReadTokens: z.int().nonnegative().nullable(),
  cacheCreationTokens: z.int().nonnegative().nullable(),
  totalTokens: z.int().nonnegative().nullable(),
  usageStatus: z.enum(['known', 'missing']),
  priceVersion: z.string(),
  costStatus: z.enum(['known', 'unknown']),
  costUsd: z.number().nonnegative().nullable(),
  createdAt: z.iso.datetime(),
});
export type ProviderCallRecord = z.infer<typeof providerCallRecord>;

export const runTaskDetail = z.strictObject({
  id,
  runId: id,
  pipelineId: id,
  pipelineName: z.string(),
  taskId: id,
  taskVersionId: id,
  ordinal: z.int().nonnegative(),
  question: z.string(),
  expectedAnswer: z.string(),
  acceptanceRule: z.string(),
  referenceFacts: z.array(z.string()),
  answerable: z.boolean(),
  pool: z.enum(['complete', 'partial']),
  qrels: z.array(qrel),
  state: z.enum([
    'pending',
    'running',
    'succeeded',
    'partial',
    'failed',
    'cancelled',
  ]),
  retrievalState: z.enum(['pending', 'succeeded', 'failed', 'skipped']),
  answerState: z.enum(['pending', 'succeeded', 'failed', 'skipped']),
  judgeState: z.enum(['pending', 'succeeded', 'partial', 'failed', 'skipped']),
  retrievalLatencyMs: z.number().nonnegative().nullable(),
  rerankLatencyMs: z.number().nonnegative().nullable(),
  generationLatencyMs: z.number().nonnegative().nullable(),
  judgeLatencyMs: z.number().nonnegative().nullable(),
  servingLatencyMs: z.number().nonnegative().nullable(),
  retrievedDepth: z.int().nonnegative().nullable(),
  retrievedCount: z.int().nonnegative().nullable(),
  rerankStatus: z.enum(['skipped', 'applied', 'fallback']).nullable(),
  rerankError: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retrievedItems: z.array(retrievedTraceItem),
  answer: recordedAnswer.nullable(),
  observations: z.array(metricObservation),
  judgeAttempts: z.array(judgeAttemptRecord),
  providerCalls: z.array(providerCallRecord),
});
export type RunTaskDetail = z.infer<typeof runTaskDetail>;

export const runListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
  experimentId: id.optional(),
  datasetId: id.optional(),
  state: jobState.optional(),
});
export const runTasksQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().nonnegative().optional(),
  pipelineId: id.optional(),
});

// Phase 7: Historical Comparisons, Reporting, Exports, and Derived Documentation
export const comparisonQuery = z.strictObject({
  baselineRunId: id,
  baselinePipelineId: id,
  candidateRunId: id,
  candidatePipelineId: id,
  bootstrapSamples: z.coerce.number().int().min(0).max(5000).default(1000),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).default(42),
});
export type ComparisonQuery = z.infer<typeof comparisonQuery>;

export const comparisonSide = z.strictObject({
  runId: id,
  runName: z.string(),
  runState: jobState,
  mode: runMode,
  judgeEnabled: z.boolean(),
  datasetId: id,
  datasetRevision: revision,
  datasetName: z.string(),
  queuedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  pipelineId: id,
  pipelineRevision: revision,
  pipelineName: z.string(),
  isBaseline: z.boolean(),
  config: pipelineConfig,
  configHash: z.string().length(64),
  resolvedModels: runPipelineSummary.shape.resolvedModels,
  promptVersion: z.string(),
  retrievalMetricVersion: z.string(),
  rubricVersions: z.record(z.string(), z.string()),
  priceScheduleVersion: z.string(),
  state: runPipelineState,
  completedTasks: z.int().nonnegative(),
  failedTasks: z.int().nonnegative(),
  totalTasks: z.int().nonnegative(),
  latency: pipelineLatencySummary,
  cost: costBreakdown,
  tokens: tokenBreakdown,
});
export type ComparisonSide = z.infer<typeof comparisonSide>;

export const comparisonIncompatibility = z.strictObject({
  scope: z.enum(['dataset', 'judge', 'metric']),
  field: z.string(),
  baselineValue: z.string(),
  candidateValue: z.string(),
  reason: z.string(),
});
export type ComparisonIncompatibility = z.infer<
  typeof comparisonIncompatibility
>;

export const configDiffEntry = z.strictObject({
  path: z.string(),
  baseline: z.unknown(),
  candidate: z.unknown(),
});
export type ConfigDiffEntry = z.infer<typeof configDiffEntry>;

export const bootstrapInterval = z.strictObject({
  lower: z.number(),
  upper: z.number(),
  confidenceLevel: z.number().min(0.5).max(0.999),
  samples: z.int().positive(),
  seed: z.int().nonnegative(),
});
export type BootstrapInterval = z.infer<typeof bootstrapInterval>;

export const resamplingRule = z.strictObject({
  method: z.literal('seeded_task_paired_bootstrap'),
  seed: z.int().nonnegative(),
  samples: z.int().nonnegative(),
  confidenceLevel: z.number().min(0.5).max(0.999),
  minPairs: z.int().positive(),
  description: z.string(),
});
export type ResamplingRule = z.infer<typeof resamplingRule>;

export const metricDirection = z.enum([
  'improved',
  'regressed',
  'unchanged',
  'not_comparable',
]);
export type MetricDirection = z.infer<typeof metricDirection>;

export const pairedMetricComparison = z.strictObject({
  metricId,
  metricVersion: z.string(),
  candidateMetricVersion: z.string().nullable(),
  cutoff: z.int().nonnegative(),
  evaluationUnit,
  displayLabel: z.string(),
  category: z.enum(['retrieval', 'judge', 'abstention']),
  comparable: z.boolean(),
  incompatibilityReason: z.string().nullable(),
  baselineMean: z.number().nullable(),
  candidateMean: z.number().nullable(),
  baselineOverallMean: z.number().nullable(),
  candidateOverallMean: z.number().nullable(),
  absoluteDelta: z.number().nullable(),
  direction: metricDirection,
  pairedCount: z.int().nonnegative(),
  missingPairs: z.int().nonnegative(),
  baselineEligibleCount: z.int().nonnegative(),
  candidateEligibleCount: z.int().nonnegative(),
  totalTasks: z.int().nonnegative(),
  bootstrapCi: bootstrapInterval.nullable(),
  bootstrapNote: z.string().nullable(),
});
export type PairedMetricComparison = z.infer<typeof pairedMetricComparison>;

export const pairedTaskMetricDelta = z.strictObject({
  metricId,
  metricVersion: z.string(),
  cutoff: z.int().nonnegative(),
  evaluationUnit,
  displayLabel: z.string(),
  comparable: z.boolean(),
  baselineStatus: observationStatus.nullable(),
  candidateStatus: observationStatus.nullable(),
  baselineValue: z.number().nullable(),
  candidateValue: z.number().nullable(),
  delta: z.number().nullable(),
});
export type PairedTaskMetricDelta = z.infer<typeof pairedTaskMetricDelta>;

export const pairedTaskComparison = z.strictObject({
  taskId: id,
  taskVersionId: id,
  ordinal: z.int().nonnegative(),
  question: z.string(),
  expectedAnswer: z.string(),
  acceptanceRule: z.string(),
  referenceFacts: z.array(z.string()),
  answerable: z.boolean(),
  pool: z.enum(['complete', 'partial']),
  qrels: z.array(qrel),
  differs: z.boolean(),
  differenceSummary: z.array(z.string()),
  baseline: runTaskDetail.nullable(),
  candidate: runTaskDetail.nullable(),
  metricDeltas: z.array(pairedTaskMetricDelta),
});
export type PairedTaskComparison = z.infer<typeof pairedTaskComparison>;

export const comparisonResult = z.strictObject({
  baseline: comparisonSide,
  candidate: comparisonSide,
  compatible: z.boolean(),
  datasetCompatible: z.boolean(),
  judgeCompatible: z.boolean(),
  incompatibilities: z.array(comparisonIncompatibility),
  configDiff: z.array(configDiffEntry),
  resamplingRule,
  metrics: z.array(pairedMetricComparison),
  tasks: z.array(pairedTaskComparison),
});
export type ComparisonResult = z.infer<typeof comparisonResult>;

export const runExportQuery = z.strictObject({
  format: z.enum(['markdown', 'json']).default('markdown'),
  baselinePipelineId: id.optional(),
  candidatePipelineId: id.optional(),
  compareRunId: id.optional(),
  comparePipelineId: id.optional(),
  bootstrapSamples: z.coerce.number().int().min(0).max(5000).default(1000),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).default(42),
});
export type RunExportQuery = z.infer<typeof runExportQuery>;

export const runExportJson = z.strictObject({
  schemaVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  run: runDetail,
  comparisons: z.array(comparisonResult),
  tasks: z.array(runTaskDetail),
});
export type RunExportJson = z.infer<typeof runExportJson>;

export const metricDefinitionDoc = z.strictObject({
  metricId,
  version: z.string(),
  category: z.enum(['retrieval', 'judge', 'abstention']),
  displayLabel: z.string(),
  evaluationUnit,
  formula: z.string(),
  description: z.string(),
  edgeCases: z.array(z.string()),
  anchors: z.record(z.string(), z.string()).optional(),
  passPolicy: z
    .strictObject({
      version: z.string(),
      minScore: z.number(),
      forbidCriticalContradiction: z.boolean(),
      requireAcceptanceCriteria: z.boolean(),
    })
    .optional(),
  rubricHash: z.string().optional(),
});
export type MetricDefinitionDoc = z.infer<typeof metricDefinitionDoc>;

export const documentationPayload = z.strictObject({
  softwareVersion: z.string(),
  capabilities,
  limits: z.strictObject({
    jsonLimitBytes: z.int().positive(),
    documentLimitBytes: z.int().positive(),
    rateLimit: z.int().positive(),
    rateWindowMs: z.int().positive(),
    providerTimeoutMs: z.int().positive(),
    embedBatchSize: z.int().positive(),
    workerLeaseMs: z.int().positive(),
    runMaxTokens: z.int().positive().nullable(),
    runMaxCostUsd: z.number().positive().nullable(),
  }),
  pricing: z.strictObject({
    version: z.string(),
    currency: z.literal('USD'),
    configuredModels: z.array(z.string()),
  }),
  ingestion: z.strictObject({
    localFormats: z.array(z.string()),
    cloudFormats: z.array(z.string()),
    chunkingStrategies: z.array(
      z.strictObject({
        id: strategy,
        name: z.string(),
        description: z.string(),
      }),
    ),
    chunkSizeRange: z.strictObject({
      min: z.int().positive(),
      max: z.int().positive(),
    }),
    overlapRange: z.strictObject({
      min: z.int().nonnegative(),
      max: z.int().positive(),
    }),
  }),
  retrieval: z.strictObject({
    modes: z.array(
      z.strictObject({
        id: retrievalMode,
        name: z.string(),
        description: z.string(),
        requiresDenseStore: z.boolean(),
        requiresEmbeddingProfile: z.boolean(),
      }),
    ),
    rrfFormula: z.string(),
    rerankFailurePolicies: z.array(
      z.strictObject({
        id: rerankFailurePolicy,
        description: z.string(),
      }),
    ),
  }),
  evaluation: z.strictObject({
    promptVersion: z.string(),
    retrievalMetricVersion: z.string(),
    abstentionMetricVersion: z.string(),
    comparisonRule: z.string(),
    resamplingRule,
    metrics: z.array(metricDefinitionDoc),
  }),
  generation: z
    .strictObject({
      promptVersion: z.string(),
      leakageVerbatimRatioThreshold: z.number().min(0).max(1),
      leakageMaxContiguousChars: z.int().positive(),
      leakageMaxContiguousWords: z.int().positive(),
      leakageMinAnswerChars: z.int().positive(),
    })
    .optional(),
});
export type DocumentationPayload = z.infer<typeof documentationPayload>;

// Phase 9: Synthetic Test-Set Generation, Review, Leakage Prevention, and Promotion
export const proposalReviewStatus = z.enum([
  'pending',
  'accepted',
  'rejected',
  'promoted',
]);
export type ProposalReviewStatus = z.infer<typeof proposalReviewStatus>;

export const proposalReviewDecision = z.enum([
  'pending',
  'accepted',
  'rejected',
]);
export type ProposalReviewDecision = z.infer<typeof proposalReviewDecision>;

export const sourceSpan = z
  .strictObject({
    documentId: id,
    documentVersionId: id,
    documentName: name,
    start: z.int().nonnegative(),
    end: z.int().positive(),
    quote: z.string().min(1).max(16000),
  })
  .refine((span) => span.end > span.start, 'Span end must exceed span start.');
export type SourceSpan = z.infer<typeof sourceSpan>;

export const generatorProvenance = z.strictObject({
  batchId: id,
  provider: providerKind,
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  documentVersionIds: z.array(id).min(1),
  seed: z.int().nonnegative(),
  params: z.strictObject({
    temperature: z.number().nullable(),
    maxTokens: z.int().positive().nullable(),
    structuredOutput: z.boolean(),
    targetCount: z.int().positive(),
    includeUnanswerable: z.boolean(),
    leakageThreshold: z.number().min(0).max(1),
  }),
  rawResponseHash: z.string().length(64),
  requestId: z.string().nullable(),
});
export type GeneratorProvenance = z.infer<typeof generatorProvenance>;

export const syntheticProposal = z.strictObject({
  id,
  batchId: id,
  datasetId: id,
  datasetRevision: revision,
  question: taskFields.shape.question,
  expectedAnswer: prose,
  acceptanceRule: prose,
  referenceFacts: z.array(prose.trim().min(1)).max(100),
  answerable: z.boolean(),
  sourceSpans: z.array(sourceSpan).min(1),
  qrels: z.array(qrel),
  provenance: generatorProvenance,
  leakageScore: z.number().min(0).max(1),
  leakageFlagged: z.boolean(),
  leakageReason: z.string().nullable(),
  reviewStatus: proposalReviewStatus,
  edited: z.boolean(),
  promotedTaskId: id.nullable(),
  promotedRevision: revision.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SyntheticProposal = z.infer<typeof syntheticProposal>;

export const createGenerationRequest = z.strictObject({
  datasetRevision: revision.optional(),
  documentIds: z
    .array(id)
    .min(1)
    .max(100)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Document IDs must be unique.',
    )
    .optional(),
  model: name.or(z.literal('')).default(''),
  count: z.int().min(1).max(50).default(5),
  seed: z.int().min(0).max(2_147_483_647).default(42),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.int().min(256).max(16384).optional(),
  includeUnanswerable: z.boolean().default(true),
});
export type CreateGenerationRequest = z.infer<typeof createGenerationRequest>;
export type CreateGenerationRequestRaw = z.input<
  typeof createGenerationRequest
>;

export const generationBatch = z.strictObject({
  id,
  datasetId: id,
  datasetRevision: revision,
  state: jobState,
  stage: z.string(),
  provider: providerKind,
  model: z.string(),
  promptVersion: z.string(),
  params: z.strictObject({
    seed: z.int().nonnegative(),
    temperature: z.number().nullable(),
    maxTokens: z.int().positive().nullable(),
    structuredOutput: z.boolean(),
    targetCount: z.int().positive(),
    includeUnanswerable: z.boolean(),
    leakageThreshold: z.number().min(0).max(1),
    documentIds: z.array(id),
  }),
  totalDocuments: z.int().nonnegative(),
  processedDocuments: z.int().nonnegative(),
  proposedCount: z.int().nonnegative(),
  deduplicatedCount: z.int().nonnegative(),
  invalidSpanCount: z.int().nonnegative(),
  leakageFlaggedCount: z.int().nonnegative(),
  jobId: id,
  workerOnline: z.boolean(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type GenerationBatch = z.infer<typeof generationBatch>;

export const createGenerationResult = z.strictObject({
  batch: generationBatch,
  job,
  reused: z.boolean(),
});
export type CreateGenerationResult = z.infer<typeof createGenerationResult>;

export const generationListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).optional(),
});

export const proposalListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
  batchId: id.optional(),
  status: proposalReviewStatus.optional(),
});

export const reviewProposalPatch = z
  .strictObject({
    reviewStatus: proposalReviewDecision.optional(),
    question: taskFields.shape.question.optional(),
    expectedAnswer: prose.optional(),
    acceptanceRule: prose.optional(),
    referenceFacts: taskFields.shape.referenceFacts.unwrap().optional(),
    answerable: z.boolean().optional(),
    qrels: labels.shape.qrels.unwrap().optional(),
  })
  .refine(nonemptyPatch, 'Provide at least one change.');
export type ReviewProposalPatch = z.infer<typeof reviewProposalPatch>;

export const promoteProposalsRequest = z.strictObject({
  proposalIds: z
    .array(id)
    .min(1)
    .max(200)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Proposal IDs must be unique.',
    ),
});
export type PromoteProposalsRequest = z.infer<typeof promoteProposalsRequest>;

export const promoteProposalsResult = z.strictObject({
  dataset,
  promotedCount: z.int().positive(),
  promotedTaskIds: z.array(id),
});
export type PromoteProposalsResult = z.infer<typeof promoteProposalsResult>;
