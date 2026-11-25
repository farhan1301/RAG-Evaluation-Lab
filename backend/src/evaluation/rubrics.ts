import { readFileSync } from 'node:fs';
import {
  evaluationUnit,
  judgeMetricId,
  z,
  type JudgeMetricId,
} from '@rag-eval/contracts';
import { sha256 } from '../ingestion/chunks.js';

const rubricFileSchema = z.strictObject({
  metricId: judgeMetricId,
  version: z.string().trim().min(1),
  displayLabel: z.string().trim().min(1),
  evaluationUnit,
  aggregationRule: z.string().trim().min(1),
  anchors: z.record(z.string(), z.string()).optional(),
  passPolicy: z
    .strictObject({
      version: z.string().trim().min(1),
      minScore: z.number().min(0).max(1),
      forbidCriticalContradiction: z.boolean(),
      requireAcceptanceCriteria: z.boolean(),
    })
    .optional(),
  systemPrompt: z.string().trim().min(1),
  outputSchema: z.record(z.string(), z.unknown()),
});

export type RubricDefinition = z.infer<typeof rubricFileSchema> & {
  hash: string;
};

const RUBRIC_FILES: Record<JudgeMetricId, string> = {
  faithfulness: './rubrics/faithfulness.v1.json',
  answer_relevance: './rubrics/answer_relevance.v1.json',
  context_precision: './rubrics/context_precision.v1.json',
  context_recall: './rubrics/context_recall.v1.json',
  answer_correctness: './rubrics/answer_correctness.v1.json',
};

let cached: Record<JudgeMetricId, RubricDefinition> | null = null;

export function loadRubrics(): Record<JudgeMetricId, RubricDefinition> {
  if (cached) return cached;
  const loaded = {} as Record<JudgeMetricId, RubricDefinition>;
  for (const [metricId, relPath] of Object.entries(RUBRIC_FILES) as Array<
    [JudgeMetricId, string]
  >) {
    const raw = readFileSync(new URL(relPath, import.meta.url), 'utf8');
    const parsed = rubricFileSchema.parse(JSON.parse(raw));
    if (parsed.metricId !== metricId) {
      throw new Error(
        `Rubric file ${relPath} declared metricId ${parsed.metricId} instead of ${metricId}.`,
      );
    }
    loaded[metricId] = {
      ...parsed,
      hash: sha256(raw),
    };
  }
  cached = loaded;
  return loaded;
}

export function getRubric(metricId: JudgeMetricId): RubricDefinition {
  return loadRubrics()[metricId];
}

export function rubricVersionMap(): Record<JudgeMetricId, string> {
  const all = loadRubrics();
  return {
    faithfulness: all.faithfulness.version,
    answer_relevance: all.answer_relevance.version,
    context_precision: all.context_precision.version,
    context_recall: all.context_recall.version,
    answer_correctness: all.answer_correctness.version,
  };
}
