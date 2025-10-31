import type { Pipeline } from './pipeline';
import type { ChunkingStatistics } from '../lib/chunking';
import type { DatasetTask } from './dataset';

export type MetricKey =
  | 'precisionAt5'
  | 'recallAt5'
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
  { key: 'precisionAt5', label: 'Pass Rate', better: 'higher', format: (value) => `${(value * 100).toFixed(0)}%` },
  { key: 'recallAt5', label: 'Context Precision', better: 'higher', format: (value) => `${(value * 100).toFixed(0)}%` },
  { key: 'latencyP95', label: 'Latency p95 (s)', better: 'lower', format: (value) => `${value.toFixed(1)}s` },
  { key: 'groundedness', label: 'Groundedness', better: 'higher', format: (value) => value.toFixed(2) },
  { key: 'costPerQuery', label: 'Cost per Query', better: 'lower', format: (value) => `$${value.toFixed(4)}` },
  { key: 'tokensUsed', label: 'Tokens Used', better: 'lower', format: (value) => Math.round(value).toLocaleString() },
];

export type PipelineMetrics = Record<MetricKey, number>;

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
  citedChunkIds: string[];
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
  contextPrecision: number;
  groundedness: number;
}

export interface JudgeDetail {
  taskId: string;
  verdict: 'pass' | 'review';
  scores: JudgeScores;
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
  verdict: 'pass' | 'review';
  passRate: number;
  averageScores: JudgeScores;
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
