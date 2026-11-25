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
export const jobKind = z.enum(['parse', 'index']);
export type JobKind = z.infer<typeof jobKind>;
export const jobState = z.enum([
  'queued',
  'running',
  'cancellation_requested',
  'cancelled',
  'succeeded',
  'failed',
]);
export const job = z.strictObject({
  id,
  kind: jobKind.default('parse'),
  versionId: id.nullable(),
  parser: parser.nullable(),
  generationId: id.nullable().default(null),
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
