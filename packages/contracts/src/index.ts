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

// Bounded interim transport for the existing runner. Phase 4 owns streamed blobs.
export const documentInput = z.strictObject({
  name,
  mimeType: z.string().max(150),
  fileBase64: z
    .base64()
    .min(4)
    .max(12 * 1024 * 1024),
});
export const document = z.strictObject({
  id,
  versionId: id,
  name,
  mimeType: z.string(),
  size: z.int().nonnegative(),
  hash: z.string().length(64),
  content: z.string().optional(),
  fileBase64: z.string().optional(),
});
export type SavedDocument = z.infer<typeof document>;
export const dataset = summary.extend({
  documents: z.array(document),
  tasks: z.array(task),
});
export type Dataset = z.infer<typeof dataset>;
export const taskImport = z.strictObject({
  tasks: z.array(taskFields).min(1).max(1000),
});

export const role = z.enum(['embedding', 'chat', 'judge', 'rerank']);
export type Role = z.infer<typeof role>;
export const profile = z.strictObject({
  role,
  name,
  model: name,
  options: z.array(z.enum(['temperature', 'maxTokens'])),
  provider: z.enum(['openai', 'openai-compatible', 'anthropic', 'http']),
});
export const capabilities = z.strictObject({
  profiles: z.array(profile),
  cloudParser: z.boolean(),
  denseStore: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilities>;
const profileRef = z.strictObject({
  model: name.or(z.literal('')).default(''),
});
export const pipelineConfig = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  parsing: z
    .strictObject({ strategy: z.literal('llama-parse') })
    .default({ strategy: 'llama-parse' }),
  chunking: z
    .strictObject({
      strategy: z.enum(['recursive', 'semantic', 'layout', 'table']),
      chunkSize: z.int().min(100).max(1000),
      overlap: z.int().min(0).max(50),
    })
    .default({ strategy: 'recursive', chunkSize: 300, overlap: 20 }),
  embedding: profileRef.default({ model: '' }),
  retriever: z
    .strictObject({
      topK: z.int().min(1).max(20),
      deduplicate: z.literal(false),
    })
    .default({ topK: 5, deduplicate: false }),
  reranker: z
    .strictObject({ enabled: z.literal(false), model: z.literal('') })
    .default({ enabled: false, model: '' }),
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
export type SavedPipeline = z.infer<typeof pipeline>;
export type PipelineConfig = z.infer<typeof pipelineConfig>;
export const health = z.strictObject({ status: z.literal('ok') });
export { z };
export const replaceLabels = z.strictObject({
  pool: labels.shape.pool.unwrap(),
  qrels: labels.shape.qrels.unwrap(),
});
