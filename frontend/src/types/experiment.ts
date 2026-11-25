import type { Pipeline } from './pipeline';
import type { DatasetTask } from './dataset';

export interface ChunkingStatistics {
  totalChunks: number;
  averageChars: number;
  averageTokens: number;
  maxChunkSize: number;
  minChunkSize: number;
}

export type MetricKey =
  | 'judgePassRate'
  | 'judgedContextPrecision'
  | 'latencyP95'
  | 'groundedness'
  | 'costPerQuery'
  | 'tokensUsed';

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  better: 'higher' | 'lower';
  format: (value: number) => string;
}

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    key: 'judgePassRate',
    label: 'Judge pass rate',
    better: 'higher',
    format: (value) => `${(value * 100).toFixed(0)}%`,
  },
  {
    key: 'judgedContextPrecision',
    label: 'Judged context precision',
    better: 'higher',
    format: (value) => `${(value * 100).toFixed(0)}%`,
  },
  {
    key: 'latencyP95',
    label: 'Latency p95 (s)',
    better: 'lower',
    format: (value) => `${value.toFixed(1)}s`,
  },
  {
    key: 'groundedness',
    label: 'Groundedness',
    better: 'higher',
    format: (value) => value.toFixed(2),
  },
  {
    key: 'costPerQuery',
    label: 'Cost per Query',
    better: 'lower',
    format: (value) => `$${value.toFixed(4)}`,
  },
  {
    key: 'tokensUsed',
    label: 'Tokens Used',
    better: 'lower',
    format: (value) => Math.round(value).toLocaleString(),
  },
];

export type PipelineMetrics = Record<MetricKey, number | null>;

export interface EmbeddingSummary {
  model: string;
  vectorDim: number;
  totalChunks: number;
  totalTokens: number;
}

export interface RetrievalSummary {
  topK: number;
  deduplicate: boolean;
  candidatePool: number;
  uniqueResults: number;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentName?: string;
  documentSource?: string;
  content: string;
  charCount: number;
  tokenEstimate: number;
  score: number;
}

export interface AnswerDetail {
  taskId: string;
  question: string;
  expectedAnswer?: string;
  acceptanceRule?: string;
  response: string;
  retrievedChunkIds: string[];
  latencyMs?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AnsweringSummary {
  answer: string;
  sources: RetrievedChunk[];
  tokensUsed: number;
  latencyMs: number;
  costUsd: number;
  details: AnswerDetail[];
}

export interface JudgeScores {
  relevance: number;
  judgedContextPrecision: number;
  groundedness: number;
}

export interface JudgeDetail {
  taskId: string;
  verdict: 'pass' | 'review' | 'unavailable';
  scores: JudgeScores | null;
  rationale: string;
  missingCriteria: string[];
  latencyMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface JudgingSummary {
  verdict: 'pass' | 'review' | 'unavailable';
  judgePassRate: number | null;
  coverage: { completed: number; total: number };
  averageScores: Record<keyof JudgeScores, number | null>;
  tokensUsed: number;
  latencyMs: number;
  costUsd: number;
  details: JudgeDetail[];
}

export interface ExperimentPipelineResult {
  pipelineId: string;
  pipelineName: string;
  pipelineSnapshot: Pipeline;
  metrics: PipelineMetrics;
  chunkingSummary?: ChunkingStatistics;
  embeddingSummary?: EmbeddingSummary;
  retrievalSummary?: RetrievalSummary;
  retrievalResults?: RetrievedChunk[];
  answeringSummary?: AnsweringSummary;
  judgingSummary?: JudgingSummary;
}

export interface ExperimentRun {
  id: string;
  name: string;
  startedAt: string;
  completedAt?: string;
  statusLog: string[];
  pipelines: ExperimentPipelineResult[];
  bestByMetric: Partial<Record<MetricKey, string>>;
  baselinePipelineId?: string;
  tasksUsed: DatasetTask[];
}
